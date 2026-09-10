const {
  getFunnelPolicy,
  saveFunnelPolicy,
  ensureActiveFunnelStrategyRound,
  listFunnelStrategyRounds,
  startFunnelStrategyRound,
  listFunnelEntries,
  listFunnelProgressEvents,
  syncVerifiedCommunicationFunnelEntries,
  listUntrackedMessageFeedback
} = require("../../storage/funnel_store");
const { buildFunnelSnapshot, projectFunnelEntry } = require("../../core/funnel_maturity");
const { listUnresolvedMessageDiscoveryItems } = require("../../core/message_preview_state");

function createFunnelAnalysisService({ db, now = () => new Date().toISOString() } = {}) {
  if (!db) throw new Error("funnel analysis database is required");
  const clock = typeof now === "function" ? now : () => now;

  return Object.freeze({
    refresh({ profileId, planId } = {}) {
      return dashboard(db, { profileId, planId, now: clock() });
    },
    getDashboard({ profileId, planId } = {}) {
      return dashboard(db, { profileId, planId, now: clock() });
    },
    savePolicy(input = {}) {
      return saveFunnelPolicy(db, { ...input, updatedAt: clock() });
    },
    startStrategyRound(input = {}) {
      return startFunnelStrategyRound(db, {
        ...input,
        startedAt: input.startedAt || clock()
      });
    }
  });
}

function dashboard(db, { profileId, planId, now }) {
  const policy = getFunnelPolicy(db, { profileId });
  const current = ensureActiveFunnelStrategyRound(db, { profileId, planId, startedAt: now });
  syncVerifiedCommunicationFunnelEntries(db, { profileId });
  const entries = listFunnelEntries(db, { profileId });
  const rounds = listFunnelStrategyRounds(db, { profileId, planId, limit: null }).reverse();
  const platforms = ['boss', 'zhaopin'].map(site => {
    const history = platformRounds(rounds, site);
    const latest = history.at(-1);
    const previous = history.at(-2) || null;
    const siteEntries = entries.filter(entry => entry.site === site);
    const build = group => {
      const selected = siteEntries.filter(entry => entry.planId === Number(planId) && group.revisionIds.has(entry.strategyRoundId));
      const samplePolicy = roundPolicy(group.round);
      const snapshot = snapshotFor(db, selected, { profileId, now, policy: samplePolicy });
      const analysis = analyze(db, selected, snapshot, samplePolicy, profileId, site);
      return { snapshot, summary: roundSummary(group.round, snapshot, analysis, samplePolicy) };
    };
    const currentResult = build(latest);
    const previousResult = previous ? build(previous) : null;
    const lifetime = snapshotFor(db, siteEntries, { profileId, now, policy });
    return {
      site,
      currentRound: currentResult.summary,
      previousRound: previousResult?.summary || null,
      roundComparison: compareRounds({ current: latest.round, currentSnapshot: currentResult.snapshot,
        previous: previous?.round, previousSnapshot: previousResult?.snapshot }),
      lifetime: { started: lifetime.started, ...lifetime.immediatePositive }
    };
  });
  // Compatibility consumers may use a single platform, but never a pooled diagnosis.
  const populated = platforms.filter(item => item.currentRound.started || item.previousRound?.started);
  const single = populated.length === 1 ? populated[0] : populated.length === 0 ? platforms[0] : null;
  const currentRound = single?.currentRound || {
    ...current, started: platforms.reduce((sum, item) => sum + item.currentRound.started, 0),
    mature: platforms.reduce((sum, item) => sum + item.currentRound.mature, 0),
    waiting: platforms.reduce((sum, item) => sum + item.currentRound.waiting, 0),
    unknown: platforms.reduce((sum, item) => sum + item.currentRound.unknown, 0), strength: 'facts', nextTarget: null
  };
  return {
    policy, platforms, activeRevisionId: current.id,
    advice: platforms.map(item => item.currentRound.advice && { site: item.site, ...item.currentRound.advice })
      .find(Boolean) || null,
    analysisSource: "current_pool",
    currentRound,
    previousRound: single?.previousRound || null,
    roundComparison: single?.roundComparison || { status: 'none' },
    untrackedFeedback: untrackedFeedbackSummary(db, { profileId, planId, now }),
    lifetimeUntrackedFeedback: untrackedFeedbackSummary(db, { profileId, now }),
    currentPool: currentRound,
    latestCohort: null,
    funnel: single?.currentRound.funnel || {},
    comparisons: single?.currentRound.comparisons || { direction: [], decisionBucket: [], resumeVersion: [] },
    headline: single?.currentRound.headline || '各平台分别判断，不合并样本形成诊断。',
    priorityCheck: single?.currentRound.priorityCheck || '根据各平台反馈检查当前方案。',
    evidenceNotes: [
      "仅统计用户确认已投、已验证发起沟通或确认已发送回复的岗位。",
      "每个岗位至少经过 48 小时；跨周末顺延到周一。",
      "当前诊断只读取当前策略轮次；较晚出现的结果仍回到原轮次。",
      "岗位已成熟后若出现新的已读，未回复结论从这次已读重新等待 48 小时。",
      "未读到状态不代表失败；智联暂不提供已读和送达状态。",
      "反馈计数包含刚联系的岗位；诊断按平台、当前有效策略与成熟规则独立计算。"
    ]
  };
}

function platformRounds(rounds, site) {
  const groups = [];
  for (const round of rounds) {
    const scope = round.strategySnapshot?.platformScope || 'all';
    if (!groups.length || scope === 'all' || scope === site) {
      if (groups.length) Object.assign(groups.at(-1).round, { status: 'closed', closedAt: round.startedAt });
      groups.push({ round: { ...round, status: 'active', closedAt: null }, revisionIds: new Set() });
    }
    groups.at(-1).revisionIds.add(round.id);
  }
  return groups;
}

function untrackedFeedbackSummary(db, { profileId, planId, now }) {
  const grouped = new Map();
  for (const event of listUntrackedMessageFeedback(db, { profileId, planId })) {
    if (!grouped.has(event.jobId)) grouped.set(event.jobId, []);
    grouped.get(event.jobId).push(event);
  }
  const counts = { replied: 0, resumeRequested: 0, interviewInvited: 0 };
  for (const [cardId, events] of grouped) {
    const projection = projectFunnelEntry({ id: cardId, startedAt: events[0].occurredAt }, events, { now });
    for (const key of Object.keys(counts)) if (projection[key].value === true) counts[key] += 1;
  }
  const pending = listUnresolvedMessageDiscoveryItems(db, { profileId, platform: null });
  return { ...counts, pendingConversations: pending.length,
    pendingResumeRequests: pending.filter(item => (item.inboundMessages || [])
      .some(message => message.kind === 'resume_request')).length };
}

function roundPolicy(round) {
  return {
    preliminarySampleTarget: round.thresholds.preliminary,
    comparableSampleTarget: round.thresholds.comparable,
    formalSampleTarget: round.thresholds.formal
  };
}

function roundSummary(round, snapshot, analysis, policy) {
  return {
    ...round,
    ...poolSummary(snapshot, policy),
    funnel: snapshot.stages,
    comparisons: analysis.comparisons,
    headline: analysis.headline,
    priorityCheck: analysis.priorityCheck,
    advice: analysis.advice || null,
    immediatePositive: snapshot.immediatePositive,
    earlyPositive: snapshot.earlyPositive
  };
}

function compareRounds({ current, currentSnapshot, previous, previousSnapshot }) {
  const empty = { before: null, after: null };
  if (!previous || !previousSnapshot) {
    return { status: "none", note: "暂无可比较的上一策略轮次", ...empty };
  }
  const feedback = snapshot => ({ numerator: snapshot.immediatePositive.replied - snapshot.earlyPositive.replied, denominator: snapshot.mature });
  const before = { roundId: previous.id, mature: previousSnapshot.mature, stages: previousSnapshot.stages, replied: feedback(previousSnapshot) };
  const after = { roundId: current.id, mature: currentSnapshot.mature, stages: currentSnapshot.stages, replied: feedback(currentSnapshot) };
  if (current.legacyUncertain || previous.legacyUncertain
    || !sameDirections(current.strategySnapshot?.directions, previous.strategySnapshot?.directions)) {
    return {
      status: "incompatible",
      note: current.legacyUncertain || previous.legacyUncertain
        ? "历史策略边界无法确认，本轮不与该轮直接比较"
        : "前后轮次的投递方向不同，不直接比较",
      before,
      after
    };
  }
  if (previousSnapshot.mature < previous.thresholds.comparable
    || currentSnapshot.mature < current.thresholds.comparable) {
    return { status: "insufficient", note: "前后轮次都达到可比较样本量后再展示变化", before, after };
  }
  if (current.changeKinds.length > 1) {
    return { status: "confounded", note: "多项调整共同发生，无法区分单项影响", before, after };
  }
  return { status: "ready", note: "前后轮次均达到可比较样本量，仅展示观察到的变化", before, after };
}

function sameDirections(left, right) {
  return normalizedDirections(left).join("\n") === normalizedDirections(right).join("\n");
}

function normalizedDirections(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || "").trim().toLocaleLowerCase("zh-CN"))
    .filter(Boolean))].sort();
}

function analyze(db, entries, snapshot, policy, profileId, site) {
  const diagnosis = diagnose(snapshot, policy, site);
  return {
    funnel: snapshot.stages,
    comparisons: buildComparisons(db, entries, snapshot, policy, profileId),
    headline: diagnosis.headline,
    priorityCheck: diagnosis.priorityCheck,
    advice: diagnosis.advice || null,
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
  if (strength === "comparable") return policy.formalSampleTarget;
  return null;
}

function diagnose(snapshot, policy, site) {
  const mature = snapshot.mature;
  if (snapshot.strength === "facts") {
    return {
      headline: `当前有 ${mature} 个成熟样本，少于 ${policy.preliminarySampleTarget}，先展示事实，不判断瓶颈。`,
      priorityCheck: `继续积累到 ${policy.preliminarySampleTarget} 个成熟样本；已收到的反馈可在下方查看。`
    };
  }
  if (snapshot.unknown >= Math.ceil(mature / 2)) {
    return {
      headline: `当前有 ${mature} 个成熟样本，其中 ${snapshot.unknown} 个尚未获取完整反馈，暂时无法判断主要瓶颈。`,
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
      priorityCheck: "优先核对面试时间、确认状态和后续安排，再记录真实进展。",
      advice: { stage: 'interviewConfirmed', title: '先核对面试安排和后续进展',
        numerator: snapshot.stages.interviewConfirmed.numerator, denominator: snapshot.stages.interviewConfirmed.denominator }
    };
  }
  const checks = [
    ["read", 0.4, "发起沟通到已读", "优先检查招聘活跃度、岗位选择、发送时机和招呼语。"],
    ["replied", 0.35, "已读到回复", "优先检查岗位匹配和开场表达，不必立即重写简历。"],
    ["effectiveConversation", 0.5, "回复到有效沟通", "优先检查消息回答质量和候选人事实是否完整。"],
    ["interviewInvited", 0.25, "有效沟通到简历或约面", "优先检查定向简历、项目证据和岗位资格表达。"]
  ];
  for (const [stage, threshold, label, priorityCheck] of checks) {
    if (site === 'zhaopin' && ['read', 'replied'].includes(stage)) continue;
    const rate = stageRate(snapshot.stages[stage]);
    if (rate !== null && stageEvidenceSufficient(snapshot, stage) && rate < threshold) {
      return {
        headline: `${prefix}：当前主要卡在“${label}”。`,
        priorityCheck,
        advice: { stage, title: {
          read: '先检查投递岗位和招聘活跃度', replied: '先检查招呼语和岗位匹配',
          effectiveConversation: '先检查回复内容是否回答了HR的问题', interviewInvited: '先检查简历中的相关经历表达'
        }[stage], numerator: snapshot.stages[stage].numerator, denominator: snapshot.stages[stage].denominator }
      };
    }
  }
  return {
    headline: `${prefix}：当前没有出现单一、证据充分的主要瓶颈。`,
    priorityCheck: "继续记录后续结果，优先检查样本量足够且差异最大的方向或材料版本。"
  };
}

function buildComparisons(db, entries, snapshot, policy, profileId) {
  const empty = { direction: [], decisionBucket: [], resumeVersion: [] };
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
