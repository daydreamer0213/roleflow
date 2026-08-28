const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { openDb } = require("../src/core/storage");
const { createFunnelAnalysisService } = require("../src/application/funnel_analysis");

const NOW = "2026-09-01T02:00:00.000Z";
const db = openDb(":memory:");
try {
  const service = createFunnelAnalysisService({ db, now: () => NOW });

  const facts = createOwner(db, "facts");
  seedEntries(db, facts, 29, (index) => [readEvent(index)]);
  const factsDashboard = service.getDashboard({ profileId: facts.profileId });
  assert.equal(factsDashboard.currentPool.mature, 29);
  assert.equal(factsDashboard.currentPool.strength, "facts");
  assert.match(factsDashboard.headline, /少于 30/);
  assert.match(factsDashboard.priorityCheck, /继续积累到 30/);
  assert.deepEqual(factsDashboard.comparisons, {
    direction: [],
    decisionBucket: [],
    resumeVersion: [],
    greeting: []
  });

  const preliminary = createOwner(db, "preliminary");
  seedEntries(db, preliminary, 35, (index) => [
    readEvent(index),
    ...(index < 5 ? [replyEvent(index)] : [])
  ]);
  const preliminaryDashboard = service.getDashboard({ profileId: preliminary.profileId });
  assert.equal(preliminaryDashboard.currentPool.strength, "preliminary");
  assert.match(preliminaryDashboard.headline, /初步观察/);
  assert.match(preliminaryDashboard.headline, /已读到回复/);
  assert.match(preliminaryDashboard.priorityCheck, /岗位匹配|开场表达/);

  const replyWindow = createOwner(db, "reply-window");
  seedEntries(db, replyWindow, 30, (index) => [
    index < 10 ? readEvent(index) : freshReadEvent(index)
  ]);
  const replyWindowDashboard = service.getDashboard({ profileId: replyWindow.profileId });
  assert.equal(replyWindowDashboard.currentPool.mature, 30);
  assert.equal(replyWindowDashboard.currentPool.waiting, 20);
  assert.equal(replyWindowDashboard.currentPool.unknown, 20);
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
  const comparableDashboard = service.getDashboard({ profileId: comparable.profileId });
  assert.equal(comparableDashboard.currentPool.strength, "comparable");
  assert.match(comparableDashboard.headline, /阶段诊断/);
  assert.equal(comparableDashboard.comparisons.direction.length, 2);
  assert.equal(comparableDashboard.comparisons.resumeVersion.length, 2);
  assert.equal(comparableDashboard.comparisons.greeting.length, 2);
  assert.deepEqual(comparableDashboard.comparisons.resumeVersion.map((item) => item.label), [
    "resume-a",
    "resume-b"
  ]);
  assert(comparableDashboard.comparisons.greeting.every((item) => /^招呼语版本 /.test(item.label)));
  const directionRates = Object.fromEntries(comparableDashboard.comparisons.direction
    .map((item) => [item.key, item.replied.rate]));
  assert.equal(directionRates["AI 应用"], 0.5);
  assert.equal(directionRates["Java 后端"], 0.08);

  const metricEvidence = createOwner(db, "metric-evidence");
  seedEntries(db, metricEvidence, 50, (index) => [
    index < 20 ? freshReadEvent(index) : readEvent(index)
  ], (index) => ({ directionKey: index < 25 ? "少量已读" : "充分已读" }));
  const metricEvidenceDashboard = service.getDashboard({ profileId: metricEvidence.profileId });
  assert.equal(metricEvidenceDashboard.comparisons.direction.length, 2);
  assert(metricEvidenceDashboard.comparisons.direction.every((item) => item.replied === null),
    "a comparison metric stays hidden unless at least two groups meet its conditional denominator");

  const noMetricEvidence = createOwner(db, "no-metric-evidence");
  seedEntries(db, noMetricEvidence, 50, () => [], (index) => ({
    directionKey: index < 25 ? "未知 A" : "未知 B"
  }));
  const noMetricDashboard = service.getDashboard({ profileId: noMetricEvidence.profileId });
  assert.deepEqual(noMetricDashboard.comparisons.direction, [],
    "a dimension with no supported metric must not return empty comparison cards");

  const unknown = createOwner(db, "unknown");
  seedEntries(db, unknown, 35, () => []);
  const unknownDashboard = service.getDashboard({ profileId: unknown.profileId });
  assert.equal(unknownDashboard.currentPool.unknown, 35);
  assert.match(unknownDashboard.headline, /状态未知|证据不足/);
  assert.match(unknownDashboard.priorityCheck, /补充/);

  const formal = createOwner(db, "formal");
  seedEntries(db, formal, 83, (index) => [
    readEvent(index),
    replyEvent(index),
    ...(index < 25 ? [progressEvent("interview_invited", index)] : []),
    ...(index < 5 ? [progressEvent("interview_scheduled", index)] : [])
  ]);
  const formalDashboard = service.refresh({ profileId: formal.profileId });
  assert.equal(formalDashboard.currentPool.started, 0, "frozen entries leave the next rolling pool");
  assert.equal(formalDashboard.latestCohort.sampleCount, 83, "formal freezing keeps every mature entry");
  assert.equal(formalDashboard.latestCohort.strength, "formal");
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
  const historicalPolicyDashboard = service.getDashboard({ profileId: formal.profileId });
  assert.equal(historicalPolicyDashboard.policy.preliminarySampleTarget, 40);
  assert.equal(historicalPolicyDashboard.latestCohort.strength, "formal",
    "a frozen cohort keeps the thresholds that were active when it froze");
  assert.match(historicalPolicyDashboard.latestCohort.headline, /正式诊断/);
  assert.match(historicalPolicyDashboard.headline, /正式诊断/);

  const rolling = createOwner(db, "rolling");
  seedEntries(db, rolling, 83, (index) => [readEvent(index), replyEvent(index)]);
  service.refresh({ profileId: rolling.profileId });
  seedEntries(db, rolling, 35, (index) => [readEvent(index)], () => ({}), 100);
  const nextPreliminary = service.getDashboard({ profileId: rolling.profileId });
  assert.equal(nextPreliminary.currentPool.mature, 35);
  assert.equal(nextPreliminary.latestCohort.sampleCount, 83);
  assert.equal(nextPreliminary.analysisSource, "current_pool",
    "a new rolling pool must not be permanently hidden by the previous frozen cohort");
  assert.equal(nextPreliminary.currentPool.strength, "preliminary");
  assert.match(nextPreliminary.headline, /初步观察/);
  assert.equal(nextPreliminary.funnel.read.numerator, 35);

  seedEntries(db, rolling, 20, (index) => [readEvent(index)], () => ({}), 135);
  const nextComparable = service.getDashboard({ profileId: rolling.profileId });
  assert.equal(nextComparable.currentPool.mature, 55);
  assert.equal(nextComparable.analysisSource, "current_pool");
  assert.equal(nextComparable.currentPool.strength, "comparable");
  assert.match(nextComparable.headline, /阶段诊断/);

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

function createOwner(database, suffix) {
  const profileId = Number(database.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES (?, '{}', NULL, ?, ?)`).run(`Diagnosis ${suffix}`, NOW, NOW).lastInsertRowid);
  const planId = Number(database.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, ?, '{}', NULL, 1, ?, ?)`).run(profileId, `Diagnosis ${suffix}`, NOW, NOW).lastInsertRowid);
  return { profileId, planId, suffix };
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
    profile_id, job_id, card_id, cohort_id, plan_id, source_kind,
    started_at, mature_at, direction_key, decision_bucket,
    resume_version_id, greeting_key, created_at, updated_at
  ) VALUES (?, ?, ?, NULL, ?, 'applied', ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertEvent = database.prepare(`INSERT INTO candidate_progress_events(
    card_id, idempotency_key, type, actor, summary, metadata_json, occurred_at, created_at
  ) VALUES (?, ?, ?, ?, '', ?, ?, ?)`);
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
  }
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
