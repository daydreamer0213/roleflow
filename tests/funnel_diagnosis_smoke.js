const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const storage = require("../src/core/storage");
const { createFunnelAnalysisService } = require("../src/application/funnel_analysis");

const NOW = "2026-09-05T02:00:00.000Z";
const db = storage.openDb(":memory:");
try {
  const service = createFunnelAnalysisService({ db, now: () => NOW });

  const facts = createOwner(db, "facts");
  seedEntries(db, facts, 29, (index) => [readEvent(index)]);
  const factsDashboard = service.getDashboard({ profileId: facts.profileId, planId: facts.planId });
  assert.equal(factsDashboard.currentRound.mature, 29);
  assert.equal(factsDashboard.currentRound.strength, "facts");
  assert.match(factsDashboard.headline, /少于 30/);
  assert.match(factsDashboard.priorityCheck, /继续积累到 30/);
  assert.deepEqual(factsDashboard.comparisons, {
    direction: [],
    decisionBucket: [],
    resumeVersion: []
  });

  const preliminary = createOwner(db, "preliminary");
  seedEntries(db, preliminary, 35, (index) => [
    readEvent(index),
    ...(index < 5 ? [replyEvent(index)] : [])
  ]);
  const preliminaryDashboard = service.getDashboard({ profileId: preliminary.profileId, planId: preliminary.planId });
  assert.equal(preliminaryDashboard.currentRound.strength, "preliminary");
  assert.match(preliminaryDashboard.headline, /初步观察/);
  assert.match(preliminaryDashboard.headline, /已读到回复/);
  assert.match(preliminaryDashboard.priorityCheck, /岗位匹配|开场表达/);

  const replyWindow = createOwner(db, "reply-window");
  seedEntries(db, replyWindow, 30, (index) => [
    index < 10 ? readEvent(index) : freshReadEvent(index)
  ]);
  const replyWindowDashboard = service.getDashboard({ profileId: replyWindow.profileId, planId: replyWindow.planId });
  assert.equal(replyWindowDashboard.currentRound.mature, 30);
  assert.equal(replyWindowDashboard.currentRound.waiting, 20);
  assert.equal(replyWindowDashboard.currentRound.unknown, 20);
  assert.deepEqual(replyWindowDashboard.funnel.replied, {
    numerator: 0,
    denominator: 10,
    unknown: 0,
    waiting: 20
  });
  assert.match(replyWindowDashboard.headline, /证据不足|等待/);
  assert.doesNotMatch(replyWindowDashboard.headline, /主要卡在/);

  const comparable = createOwner(db, "comparable");
  const resumeA = insertResume(db, comparable.profileId, "resume-a");
  const resumeB = insertResume(db, comparable.profileId, "resume-b");
  seedEntries(db, comparable, 55, (index) => [
    readEvent(index),
    ...(index < 15 || (index >= 30 && index < 32) ? [replyEvent(index)] : [])
  ], (index) => ({
    directionKey: index < 30 ? "AI 应用" : "Java 后端",
    decisionBucket: index < 30 ? "primary" : "apply",
    resumeVersionId: index < 30 ? resumeA : resumeB,
    greetingKey: digest(index < 30 ? "greeting-a" : "greeting-b")
  }));
  const comparableDashboard = service.getDashboard({ profileId: comparable.profileId, planId: comparable.planId });
  assert.equal(comparableDashboard.currentRound.strength, "comparable");
  assert.match(comparableDashboard.headline, /阶段诊断/);
  assert.equal(comparableDashboard.comparisons.direction.length, 2);
  assert.equal(comparableDashboard.comparisons.resumeVersion.length, 2);
  assert.equal(Object.hasOwn(comparableDashboard.comparisons, "greeting"), false,
    "personalized greeting digests must not appear as a strategy comparison");
  assert.deepEqual(comparableDashboard.comparisons.resumeVersion.map((item) => item.label), [
    "resume-a",
    "resume-b"
  ]);
  const directionRates = Object.fromEntries(comparableDashboard.comparisons.direction
    .map((item) => [item.key, item.replied.rate]));
  assert.equal(directionRates["AI 应用"], 0.5);
  assert.equal(directionRates["Java 后端"], 0.08);

  const metricEvidence = createOwner(db, "metric-evidence");
  seedEntries(db, metricEvidence, 50, (index) => [
    index < 20 ? freshReadEvent(index) : readEvent(index)
  ], (index) => ({ directionKey: index < 25 ? "少量已读" : "充分已读" }));
  const metricEvidenceDashboard = service.getDashboard({ profileId: metricEvidence.profileId, planId: metricEvidence.planId });
  assert.equal(metricEvidenceDashboard.comparisons.direction.length, 2);
  assert(metricEvidenceDashboard.comparisons.direction.every((item) => item.replied === null),
    "a comparison metric stays hidden unless at least two groups meet its conditional denominator");

  const noMetricEvidence = createOwner(db, "no-metric-evidence");
  seedEntries(db, noMetricEvidence, 50, () => [], (index) => ({
    directionKey: index < 25 ? "未知 A" : "未知 B"
  }));
  const noMetricDashboard = service.getDashboard({ profileId: noMetricEvidence.profileId, planId: noMetricEvidence.planId });
  assert.deepEqual(noMetricDashboard.comparisons.direction, [],
    "a dimension with no supported metric must not return empty comparison cards");

  const unknown = createOwner(db, "unknown");
  seedEntries(db, unknown, 35, () => []);
  const unknownDashboard = service.getDashboard({ profileId: unknown.profileId, planId: unknown.planId });
  assert.equal(unknownDashboard.currentRound.unknown, 35);
  assert.match(unknownDashboard.headline, /状态未知|证据不足/);
  assert.match(unknownDashboard.priorityCheck, /补充/);

  const formal = createOwner(db, "formal");
  seedEntries(db, formal, 83, (index) => [
    readEvent(index),
    replyEvent(index),
    ...(index < 25 ? [progressEvent("interview_invited", index)] : []),
    ...(index < 5 ? [progressEvent("interview_scheduled", index)] : [])
  ]);
  const formalDashboard = service.refresh({ profileId: formal.profileId, planId: formal.planId });
  assert.equal(formalDashboard.currentRound.started, 83, "a strategy round continues beyond the formal threshold");
  assert.equal(formalDashboard.currentRound.mature, 83);
  assert.equal(formalDashboard.currentRound.strength, "formal");
  assert.equal(formalDashboard.currentRound.nextTarget, null);
  assert.equal(formalDashboard.currentRound.id, formal.roundId);
  assert.match(formalDashboard.headline, /正式诊断/);
  assert.match(formalDashboard.priorityCheck, /模拟面试/);
  assert(!/证明|导致|准确率/.test(formalDashboard.headline));
  assert(!/证明|导致|准确率/.test(formalDashboard.priorityCheck));

  service.savePolicy({
    profileId: formal.profileId,
    preliminarySampleTarget: 40,
    comparableSampleTarget: 60,
    formalSampleTarget: 80
  });
  const historicalPolicyDashboard = service.getDashboard({ profileId: formal.profileId, planId: formal.planId });
  assert.equal(historicalPolicyDashboard.policy.preliminarySampleTarget, 40);
  assert.equal(historicalPolicyDashboard.currentRound.strength, "formal",
    "an active round keeps the thresholds that were active when it began");
  assert.match(historicalPolicyDashboard.headline, /正式诊断/);

  const rounds = createOwner(db, "rounds");
  const roundAEntries = seedEntries(db, rounds, 50, (index) => [
    readEvent(index),
    ...(index < 49 ? [replyEvent(index)] : [])
  ]);
  const roundAId = rounds.roundId;
  const roundB = service.startStrategyRound({
    profileId: rounds.profileId,
    planId: rounds.planId,
    fromRoundId: roundAId,
    sourceKey: `test:greeting:${roundAId}`,
    changeKinds: ["greeting"],
    changeNote: "修改招呼语"
  });
  rounds.roundId = roundB.id;

  seedEntries(db, rounds, 29, (index) => [readEvent(index)], () => ({}), 100);
  const at29 = service.getDashboard({ profileId: rounds.profileId, planId: rounds.planId });
  assert.equal(at29.currentRound.strength, "facts");
  assert.equal(at29.currentRound.id, roundB.id);

  seedEntries(db, rounds, 1, (index) => [readEvent(index)], () => ({}), 129);
  const at30 = service.getDashboard({ profileId: rounds.profileId, planId: rounds.planId });
  assert.equal(at30.currentRound.strength, "preliminary");

  seedEntries(db, rounds, 19, (index) => [readEvent(index)], () => ({}), 130);
  const at49 = service.getDashboard({ profileId: rounds.profileId, planId: rounds.planId });
  assert.equal(at49.currentRound.mature, 49);
  assert.equal(at49.roundComparison.status, "insufficient");

  seedEntries(db, rounds, 1, (index) => [readEvent(index)], () => ({}), 149);
  const at50 = service.getDashboard({ profileId: rounds.profileId, planId: rounds.planId });
  assert.equal(at50.currentRound.strength, "comparable");
  assert.equal(at50.roundComparison.status, "ready");
  const currentRepliesBeforeLateEvent = at50.funnel.replied.numerator;
  assert.equal(at50.previousRound.funnel.replied.numerator, 49);

  appendEvent(db, roundAEntries[49].cardId, replyEvent(999));
  const afterLateReply = service.getDashboard({ profileId: rounds.profileId, planId: rounds.planId });
  assert.equal(afterLateReply.previousRound.funnel.replied.numerator, 50,
    "a late result updates its original round");
  assert.equal(afterLateReply.funnel.replied.numerator, currentRepliesBeforeLateEvent,
    "a late result from A must not change B's numerator");
  assert.equal(afterLateReply.currentRound.mature, 50,
    "a late result from A must not change B's denominator");

  seedEntries(db, rounds, 19, (index) => [readEvent(index)], () => ({}), 150);
  const at69 = service.getDashboard({ profileId: rounds.profileId, planId: rounds.planId });
  assert.equal(at69.currentRound.mature, 69);
  assert.equal(at69.currentRound.strength, "comparable");
  seedEntries(db, rounds, 1, (index) => [readEvent(index)], () => ({}), 169);
  const at70 = service.getDashboard({ profileId: rounds.profileId, planId: rounds.planId });
  assert.equal(at70.currentRound.strength, "formal");
  seedEntries(db, rounds, 13, (index) => [readEvent(index)], () => ({}), 170);
  const at83 = service.refresh({ profileId: rounds.profileId, planId: rounds.planId });
  assert.equal(at83.currentRound.mature, 83);
  assert.equal(at83.currentRound.id, roundB.id, "83 jobs stay in the same strategy round");
  assert(!/证明|导致|准确率/.test(JSON.stringify(at83)));

  const incompatible = createOwner(db, "incompatible", ["AI 应用"]);
  seedEntries(db, incompatible, 50, (index) => [readEvent(index)]);
  db.prepare("UPDATE search_plans SET plan_json = ? WHERE id = ?")
    .run(JSON.stringify({ directions: ["Java 后端"] }), incompatible.planId);
  const incompatibleNext = service.startStrategyRound({
    profileId: incompatible.profileId,
    planId: incompatible.planId,
    fromRoundId: incompatible.roundId,
    sourceKey: `test:direction:${incompatible.roundId}`,
    changeKinds: ["strategy"],
    changeNote: "切换投递方向"
  });
  incompatible.roundId = incompatibleNext.id;
  seedEntries(db, incompatible, 50, (index) => [readEvent(index)], () => ({}), 100);
  assert.equal(service.getDashboard({
    profileId: incompatible.profileId,
    planId: incompatible.planId
  }).roundComparison.status, "incompatible");

  const confounded = createOwner(db, "confounded");
  seedEntries(db, confounded, 50, (index) => [readEvent(index)]);
  const confoundedNext = service.startStrategyRound({
    profileId: confounded.profileId,
    planId: confounded.planId,
    fromRoundId: confounded.roundId,
    sourceKey: `test:confounded:${confounded.roundId}`,
    changeKinds: ["greeting", "resume"],
    changeNote: "同时修改招呼语和简历"
  });
  confounded.roundId = confoundedNext.id;
  seedEntries(db, confounded, 50, (index) => [readEvent(index)], () => ({}), 100);
  const confoundedDashboard = service.getDashboard({ profileId: confounded.profileId, planId: confounded.planId });
  assert.equal(confoundedDashboard.roundComparison.status, "confounded");
  assert.equal(confoundedDashboard.roundComparison.note, "多项调整共同发生，无法区分单项影响");

  const saved = service.savePolicy({
    profileId: facts.profileId,
    preliminarySampleTarget: 40,
    comparableSampleTarget: 60,
    formalSampleTarget: 80
  });
  assert.deepEqual(saved, {
    profileId: facts.profileId,
    preliminarySampleTarget: 40,
    comparableSampleTarget: 60,
    formalSampleTarget: 80,
    updatedAt: NOW
  });

  console.log("funnel_diagnosis_smoke: ok");
} finally {
  db.close();
}

function createOwner(database, suffix, directions = ["AI 应用"]) {
  const profileId = Number(database.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES (?, '{}', NULL, ?, ?)`).run(`Diagnosis ${suffix}`, NOW, NOW).lastInsertRowid);
  const planId = Number(database.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, ?, ?, NULL, 1, ?, ?)`)
    .run(profileId, `Diagnosis ${suffix}`, JSON.stringify({ directions }), NOW, NOW).lastInsertRowid);
  const round = storage.ensureActiveFunnelStrategyRound(database, {
    profileId,
    planId,
    startedAt: "2026-08-20T01:00:00.000Z"
  });
  return { profileId, planId, roundId: round.id, suffix };
}

function seedEntries(database, owner, count, eventsForIndex, dimensionsForIndex = () => ({}), offset = 0) {
  const insertJob = database.prepare(`INSERT INTO jobs(
    source, source_id, title, first_seen_at, last_seen_at
  ) VALUES ('boss', ?, ?, '2026-08-20T02:00:00.000Z', '2026-08-20T02:00:00.000Z')`);
  const insertCard = database.prepare(`INSERT INTO candidate_progress_cards(
    profile_id, plan_id, job_id, source, recruiter_name, thread_key, stage,
    next_action, scheduled_at, last_event_at, created_at, updated_at
  ) VALUES (?, ?, ?, 'boss', '', '', 'waiting_reply', '', NULL, ?, ?, ?)`);
  const insertEntry = database.prepare(`INSERT INTO candidate_funnel_entries(
    profile_id, job_id, card_id, cohort_id, plan_id, strategy_round_id, source_kind,
    started_at, mature_at, direction_key, decision_bucket,
    resume_version_id, greeting_key, created_at, updated_at
  ) VALUES (?, ?, ?, NULL, ?, ?, 'applied', ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertEvent = database.prepare(`INSERT INTO candidate_progress_events(
    card_id, idempotency_key, type, actor, summary, metadata_json, occurred_at, created_at
  ) VALUES (?, ?, ?, ?, '', ?, ?, ?)`);
  const inserted = [];
  for (let localIndex = 0; localIndex < count; localIndex += 1) {
    const index = localIndex + offset;
    const startedAt = new Date(Date.parse("2026-08-20T02:00:00.000Z") + index * 1000).toISOString();
    const jobId = Number(insertJob.run(`${owner.suffix}-${index}`, `${owner.suffix} ${index}`).lastInsertRowid);
    const cardId = Number(insertCard.run(owner.profileId, owner.planId, jobId, startedAt, startedAt, startedAt).lastInsertRowid);
    const dimensions = dimensionsForIndex(index) || {};
    insertEntry.run(
      owner.profileId,
      jobId,
      cardId,
      owner.planId,
      owner.roundId,
      startedAt,
      "2026-08-22T02:00:00.000Z",
      dimensions.directionKey || "AI 应用",
      dimensions.decisionBucket || "apply",
      dimensions.resumeVersionId || null,
      dimensions.greetingKey || "",
      startedAt,
      startedAt
    );
    for (const event of eventsForIndex(index)) {
      appendEvent(database, cardId, event, insertEvent);
    }
    inserted.push({ jobId, cardId });
  }
  return inserted;
}

function appendEvent(database, cardId, event, prepared = null) {
  const insertEvent = prepared || database.prepare(`INSERT INTO candidate_progress_events(
    card_id, idempotency_key, type, actor, summary, metadata_json, occurred_at, created_at
  ) VALUES (?, ?, ?, ?, '', ?, ?, ?)`);
  insertEvent.run(
    cardId,
    `progress:${crypto.randomUUID()}`,
    event.type,
    event.actor || "system",
    JSON.stringify(event.metadata || { source: "platform_observation" }),
    event.occurredAt || "2026-08-20T03:00:00.000Z",
    event.occurredAt || "2026-08-20T03:00:00.000Z"
  );
}

function readEvent(index) {
  return progressEvent("outbound_read_observed", index);
}

function freshReadEvent(index) {
  return {
    ...progressEvent("outbound_read_observed", index),
    occurredAt: new Date(Date.parse(NOW) - 60 * 60 * 1000 + index).toISOString()
  };
}

function replyEvent(index) {
  return progressEvent("message_group_classified", index, {
    source: "platform_observation",
    messageIntent: "information_request"
  });
}

function progressEvent(type, index, metadata = { source: "platform_observation" }) {
  return {
    type,
    metadata,
    occurredAt: new Date(Date.parse("2026-08-20T03:00:00.000Z") + index * 1000).toISOString()
  };
}

function insertResume(database, profileId, versionKey) {
  return Number(database.prepare(`INSERT INTO candidate_resume_versions(
    profile_id, resume_document_id, version_key, name, target_roles_json, keywords_json,
    primary_projects_json, summary, analysis_json, is_active, created_at, updated_at
  ) VALUES (?, NULL, ?, ?, '[]', '[]', '[]', '', '{}', 1, ?, ?)`)
    .run(profileId, versionKey, versionKey, NOW, NOW).lastInsertRowid);
}

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}
