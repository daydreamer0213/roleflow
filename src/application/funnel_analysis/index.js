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
  const selectedEntries = latest ? latest.entries : currentEntries;
  const selectedSnapshot = latestSnapshot || currentSnapshot;
  const diagnosis = diagnose(selectedSnapshot, policy);

  return {
    policy,
    currentPool: poolSummary(currentSnapshot, policy),
    latestCohort: latest ? {
      ...latest,
      strength: latestSnapshot.strength,
      funnel: latestSnapshot.stages,
      unknown: latestSnapshot.unknown
    } : null,
    funnel: selectedSnapshot.stages,
    comparisons: buildComparisons(selectedEntries, selectedSnapshot, policy),
    headline: diagnosis.headline,
    priorityCheck: diagnosis.priorityCheck,
    evidenceNotes: [
      "仅统计用户确认已投、已验证发起沟通或确认已发送回复的岗位。",
      "每个岗位至少经过 48 小时；跨周末顺延到周一。",
      "等待和未知状态不进入失败分母，观察关系不代表因果。"
    ]
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
    if (rate !== null && snapshot.stages[stage].denominator >= 10 && rate < threshold) {
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

function buildComparisons(entries, snapshot, policy) {
  const empty = { direction: [], decisionBucket: [], resumeVersion: [], greeting: [] };
  if (!['comparable', 'formal'].includes(snapshot.strength)) return empty;
  const projectionById = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
  const minimum = Math.max(10, Math.floor(policy.preliminarySampleTarget / 2));
  return {
    direction: compareDimension(entries, projectionById, (entry) => entry.directionKey, minimum),
    decisionBucket: compareDimension(entries, projectionById, (entry) => entry.decisionBucket, minimum),
    resumeVersion: compareDimension(entries, projectionById, (entry) => entry.resumeVersionId ? `resume:${entry.resumeVersionId}` : "", minimum),
    greeting: compareDimension(entries, projectionById, (entry) => entry.greetingKey, minimum)
  };
}

function compareDimension(entries, projectionById, keyForEntry, minimum) {
  const groups = new Map();
  for (const entry of entries) {
    const projection = projectionById.get(entry.id);
    const key = String(keyForEntry(entry) || "").trim();
    if (!projection?.mature || !key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(projection);
  }
  return [...groups.entries()]
    .filter(([, rows]) => rows.length >= minimum)
    .map(([key, rows]) => ({
      key,
      sampleCount: rows.length,
      read: metric(rows, "read"),
      replied: metric(rows, "replied"),
      effectiveConversation: metric(rows, "effectiveConversation"),
      interviewInvited: metric(rows, "interviewInvited")
    }))
    .sort((left, right) => right.sampleCount - left.sampleCount || left.key.localeCompare(right.key));
}

function metric(rows, key) {
  const known = rows.filter((row) => row[key].value !== null);
  const numerator = known.filter((row) => row[key].value === true).length;
  return {
    numerator,
    denominator: known.length,
    unknown: rows.length - known.length,
    rate: known.length ? Number((numerator / known.length).toFixed(4)) : null
  };
}

function stageRate(stage) {
  return stage.denominator ? stage.numerator / stage.denominator : null;
}

module.exports = { createFunnelAnalysisService };
