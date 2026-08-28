const {
  getFunnelPolicy,
  saveFunnelPolicy,
  listFunnelEntries,
  freezeReadyFunnelCohort,
  listFunnelCohorts,
  getFunnelCohort,
  listFunnelProgressEvents
} = require("../../storage/funnel_store");
const { buildFunnelSnapshot } = require("../../core/funnel_maturity");

function createFunnelAnalysisService({ db, now = () => new Date().toISOString() } = {}) {
  if (!db) throw new Error("funnel analysis database is required");
  const clock = typeof now === "function" ? now : () => now;

  return Object.freeze({
    refresh({ profileId } = {}) {
      freezeReadyFunnelCohort(db, { profileId, now: clock() });
      return dashboard(db, { profileId, now: clock() });
    },
    getDashboard({ profileId } = {}) {
      return dashboard(db, { profileId, now: clock() });
    },
    savePolicy(input = {}) {
      return saveFunnelPolicy(db, { ...input, updatedAt: clock() });
    }
  });
}

function dashboard(db, { profileId, now }) {
  const policy = getFunnelPolicy(db, { profileId });
  const currentEntries = listFunnelEntries(db, { profileId, unassignedOnly: true });
  const currentSnapshot = snapshotFor(db, currentEntries, { profileId, now, policy });
  const latestRow = listFunnelCohorts(db, { profileId, limit: 1 })[0] || null;
  const latest = latestRow ? getFunnelCohort(db, { profileId, cohortId: latestRow.id }) : null;
  const latestPolicy = latest ? {
    preliminarySampleTarget: latest.preliminarySampleTarget,
    comparableSampleTarget: latest.comparableSampleTarget,
    formalSampleTarget: latest.formalSampleTarget
  } : policy;
  const latestSnapshot = latest
    ? snapshotFor(db, latest.entries, { profileId, now, policy: latestPolicy })
    : null;
  const currentAnalysis = analyze(db, currentEntries, currentSnapshot, policy, profileId);
  const latestAnalysis = latest
    ? analyze(db, latest.entries, latestSnapshot, latestPolicy, profileId)
    : null;
  const useCurrent = !latestAnalysis || currentSnapshot.strength !== "facts";
  const selected = useCurrent ? currentAnalysis : latestAnalysis;

  return {
    policy,
    analysisSource: useCurrent ? "current_pool" : "latest_cohort",
    currentPool: {
      ...poolSummary(currentSnapshot, policy),
      ...currentAnalysis
    },
    latestCohort: latest ? {
      ...latest,
      strength: latestSnapshot.strength,
      funnel: latestSnapshot.stages,
      unknown: latestSnapshot.unknown,
      comparisons: latestAnalysis.comparisons,
      headline: latestAnalysis.headline,
      priorityCheck: latestAnalysis.priorityCheck,
      immediatePositive: latestSnapshot.immediatePositive,
      earlyPositive: latestSnapshot.earlyPositive
    } : null,
    funnel: selected.funnel,
    comparisons: selected.comparisons,
    headline: selected.headline,
    priorityCheck: selected.priorityCheck,
    evidenceNotes: [
      "仅统计用户确认已投、已验证发起沟通或确认已发送回复的岗位。",
      "每个岗位至少经过 48 小时；跨周末顺延到周一。",
      "岗位已成熟后若出现新的已读，未回复结论从这次已读重新等待 48 小时。",
      "等待和未知状态不进入失败分母，观察关系不代表因果。"
    ]
  };
}

function analyze(db, entries, snapshot, policy, profileId) {
  const diagnosis = diagnose(snapshot, policy);
  return {
    funnel: snapshot.stages,
    comparisons: buildComparisons(db, entries, snapshot, policy, profileId),
    headline: diagnosis.headline,
    priorityCheck: diagnosis.priorityCheck,
    immediatePositive: snapshot.immediatePositive,
    earlyPositive: snapshot.earlyPositive
  };
}

function snapshotFor(db, entries, { profileId, now, policy }) {
  const events = listFunnelProgressEvents(db, {
    profileId,
    entryIds: entries.map((entry) => entry.id)
  });
  const byEntry = new Map(entries.map((entry) => [entry.id, []]));
  for (const event of events) byEntry.get(event.entryId)?.push(event);
  return buildFunnelSnapshot(entries, byEntry, { now, samplePolicy: policy });
}

function poolSummary(snapshot, policy) {
  return {
    started: snapshot.started,
    mature: snapshot.mature,
    waiting: snapshot.waiting,
    unknown: snapshot.unknown,
    strength: snapshot.strength,
    nextTarget: nextTarget(snapshot.strength, policy)
  };
}

function nextTarget(strength, policy) {
  if (strength === "facts") return policy.preliminarySampleTarget;
  if (strength === "preliminary") return policy.comparableSampleTarget;
  return policy.formalSampleTarget;
}

function diagnose(snapshot, policy) {
  const mature = snapshot.mature;
  if (snapshot.strength === "facts") {
    return {
      headline: `当前有 ${mature} 个成熟样本，少于 ${policy.preliminarySampleTarget}，先展示事实，不判断瓶颈。`,
      priorityCheck: `继续积累到 ${policy.preliminarySampleTarget} 个成熟样本；等待和未知状态先不算失败。`
    };
  }
  if (snapshot.unknown >= Math.ceil(mature / 2)) {
    return {
      headline: `当前有 ${mature} 个成熟样本，但 ${snapshot.unknown} 个状态未知，现有证据不足以判断主要瓶颈。`,
      priorityCheck: "先补充消息读取或后续结果，再比较岗位方向和材料版本。"
    };
  }

  const prefix = {
    preliminary: "初步观察",
    comparable: "阶段诊断",
    formal: "正式诊断"
  }[snapshot.strength];
  const interviewConfirmed = stageRate(snapshot.stages.interviewConfirmed);
  if (snapshot.stages.interviewInvited.numerator >= 10
    && stageEvidenceSufficient(snapshot, "interviewConfirmed")
    && interviewConfirmed !== null && interviewConfirmed < 0.5) {
    return {
      headline: `${prefix}：当前主要卡在“面试邀请到面试确认或后续结果”。`,
      priorityCheck: "优先进入上下文模拟面试，检查回答结构、项目证据和追问表现。"
    };
  }
  const checks = [
    ["read", 0.4, "发起沟通到已读", "优先检查招聘活跃度、岗位选择、发送时机和招呼语。"],
    ["replied", 0.35, "已读到回复", "优先检查岗位匹配和开场表达，不必立即重写简历。"],
    ["effectiveConversation", 0.5, "回复到有效沟通", "优先检查消息回答质量和候选人事实是否完整。"],
    ["interviewInvited", 0.25, "有效沟通到简历或约面", "优先检查定向简历、项目证据和岗位资格表达。"]
  ];
  for (const [stage, threshold, label, priorityCheck] of checks) {
    const rate = stageRate(snapshot.stages[stage]);
    if (rate !== null && stageEvidenceSufficient(snapshot, stage) && rate < threshold) {
      return {
        headline: `${prefix}：当前主要卡在“${label}”。`,
        priorityCheck
      };
    }
  }
  return {
    headline: `${prefix}：当前没有出现单一、证据充分的主要瓶颈。`,
    priorityCheck: "继续记录后续结果，优先检查样本量足够且差异最大的方向或材料版本。"
  };
}

function buildComparisons(db, entries, snapshot, policy, profileId) {
  const empty = { direction: [], decisionBucket: [], resumeVersion: [], greeting: [] };
  if (!['comparable', 'formal'].includes(snapshot.strength)) return empty;
  const projectionById = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
  const minimum = Math.max(10, Math.floor(policy.preliminarySampleTarget / 2));
  const resumeLabels = resumeLabelMap(db, profileId, entries);
  return {
    direction: compareDimension(entries, projectionById, (entry) => entry.directionKey, minimum),
    decisionBucket: compareDimension(entries, projectionById, (entry) => entry.decisionBucket, minimum, decisionLabel),
    resumeVersion: compareDimension(
      entries,
      projectionById,
      (entry) => entry.resumeVersionId ? `resume:${entry.resumeVersionId}` : "",
      minimum,
      (key) => resumeLabels.get(Number(key.slice("resume:".length))) || "已记录简历版本"
    ),
    greeting: compareDimension(
      entries,
      projectionById,
      (entry) => entry.greetingKey,
      minimum,
      (key) => `招呼语版本 ${key.replace(/^sha256:/, "").slice(0, 8)}`
    )
  };
}

function compareDimension(entries, projectionById, keyForEntry, minimum, labelForKey = (key) => key) {
  const groups = new Map();
  for (const entry of entries) {
    const projection = projectionById.get(entry.id);
    const key = String(keyForEntry(entry) || "").trim();
    if (!projection?.mature || !key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(projection);
  }
  const eligibleGroups = [...groups.entries()].filter(([, rows]) => rows.length >= minimum);
  if (eligibleGroups.length < 2) return [];
  const metrics = {
    read: supportedMetrics(
      eligibleGroups,
      "read",
      (row) => !row.terminalWithoutReply || row.read.value === true,
      minimum
    ),
    replied: supportedMetrics(eligibleGroups, "replied", (row) => row.read.value === true && !row.terminalWithoutReply, minimum),
    effectiveConversation: supportedMetrics(eligibleGroups, "effectiveConversation", (row) => row.replied.value === true, minimum),
    interviewInvited: supportedMetrics(eligibleGroups, "interviewInvited", (row) => row.effectiveConversation.value === true, minimum)
  };
  if (Object.values(metrics).every((items) => items.size === 0)) return [];
  return eligibleGroups
    .map(([key, rows]) => ({
      key,
      label: labelForKey(key),
      sampleCount: rows.length,
      read: metrics.read.get(key) || null,
      replied: metrics.replied.get(key) || null,
      effectiveConversation: metrics.effectiveConversation.get(key) || null,
      interviewInvited: metrics.interviewInvited.get(key) || null
    }))
    .sort((left, right) => right.sampleCount - left.sampleCount || left.key.localeCompare(right.key));
}

function supportedMetrics(groups, key, eligible, minimum) {
  const candidates = groups.map(([groupKey, rows]) => [groupKey, metric(rows, key, eligible)]);
  if (candidates.filter(([, value]) => value.denominator >= minimum).length < 2) return new Map();
  return new Map(candidates.filter(([, value]) => value.denominator >= minimum));
}

function metric(rows, key, eligible = () => true) {
  const eligibleRows = rows.filter(eligible);
  const known = eligibleRows.filter((row) => row[key].value !== null);
  const numerator = known.filter((row) => row[key].value === true).length;
  return {
    numerator,
    denominator: known.length,
    unknown: eligibleRows.length - known.length,
    rate: known.length ? Number((numerator / known.length).toFixed(4)) : null
  };
}

function resumeLabelMap(db, profileId, entries) {
  const ids = [...new Set(entries.map((entry) => Number(entry.resumeVersionId || 0)).filter(Boolean))];
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => "?").join(",");
  return new Map(db.prepare(`SELECT id, name, version_key FROM candidate_resume_versions
    WHERE profile_id = ? AND id IN (${placeholders})`).all(profileId, ...ids)
    .map((row) => [Number(row.id), String(row.name || row.version_key || "已记录简历版本")]));
}

function decisionLabel(value) {
  return {
    primary: "主投",
    apply: "可投",
    caution: "慎投",
    not_recommended: "不推荐"
  }[String(value || "")] || "其他已记录档位";
}

function stageRate(stage) {
  return stage.denominator ? stage.numerator / stage.denominator : null;
}

function stageEvidenceSufficient(snapshot, stage) {
  const eligible = snapshot.entries.filter((entry) => entry.mature && stageEligible(entry, stage)).length;
  const known = Number(snapshot.stages[stage]?.denominator || 0);
  return known >= 10 && known * 2 >= eligible;
}

function stageEligible(entry, stage) {
  if (stage === "read") return !entry.terminalWithoutReply || entry.read.value === true;
  if (stage === "replied") return entry.read.value === true && !entry.terminalWithoutReply;
  if (stage === "effectiveConversation") return entry.replied.value === true;
  if (["resumeRequested", "interviewInvited"].includes(stage)) {
    return entry.effectiveConversation.value === true;
  }
  if (stage === "interviewConfirmed") return entry.interviewInvited.value === true;
  return false;
}

module.exports = { createFunnelAnalysisService };
