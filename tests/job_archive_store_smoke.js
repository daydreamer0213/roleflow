"use strict";

const assert = require("node:assert/strict");
const {
  openDb,
  createBatch,
  upsertJob,
  listDecisionQueue,
  listReportJobs,
  archiveCandidateJob,
  restoreCandidateJob,
  isCandidateJobArchived
} = require("../src/core/storage");

const NOW = "2026-09-03T08:00:00.000Z";

const db = openDb(":memory:");
try {
  const own = seedScope(db, "own");
  const foreign = seedScope(db, "foreign");
  const actionable = seedScope(db, "actionable");
  assert.equal(listDecisionQueue(db, { planId: actionable.planId }).some((item) => item.id === actionable.jobId), true);
  archiveCandidateJob(db, { ...actionable, archivedAt: NOW });
  assert.equal(listDecisionQueue(db, { planId: actionable.planId }).some((item) => item.id === actionable.jobId), false,
    "archived jobs must leave action-producing queues");
  db.prepare(`INSERT INTO candidate_job_states(
    profile_id, job_id, plan_id, status, note, updated_at
  ) VALUES (?, ?, ?, 'applied', '保持原状态', ?)`)
    .run(own.profileId, own.jobId, own.planId, NOW);

  const archived = archiveCandidateJob(db, { ...own, archivedAt: NOW });
  assert.deepEqual(archived, { jobId: own.jobId, archived: true, archivedAt: NOW });
  assert.equal(isCandidateJobArchived(db, own), true);
  assert.deepEqual(archiveCandidateJob(db, { ...own, archivedAt: NOW }), archived);
  let job = listReportJobs(db, { profileId: own.profileId, planId: own.planId, batch: "all" })
    .find((item) => item.id === own.jobId);
  assert.equal(job.archived, true);
  assert.equal(job.archivedAt, NOW);
  assert.equal(job.applicationStatus, "applied", "archive must not alter the application state");

  assert.throws(() => archiveCandidateJob(db, {
    profileId: own.profileId,
    planId: own.planId,
    jobId: foreign.jobId,
    archivedAt: NOW
  }), (error) => error.code === "JOB_ARCHIVE_NOT_OWNED");

  const restored = restoreCandidateJob(db, own);
  assert.deepEqual(restored, { jobId: own.jobId, archived: false, archivedAt: "" });
  assert.deepEqual(restoreCandidateJob(db, own), restored);
  assert.equal(isCandidateJobArchived(db, own), false);
  job = listReportJobs(db, { profileId: own.profileId, planId: own.planId, batch: "all" })
    .find((item) => item.id === own.jobId);
  assert.equal(job.archived, false);
  assert.equal(job.applicationStatus, "applied");

  const communicationBatchId = Number(db.prepare(`INSERT INTO communication_batches(
    site, profile_id, plan_id, browser_mode, status, policy_json,
    confirmed_at, created_at, updated_at
  ) VALUES ('boss', ?, ?, 'portable', 'confirmed', '{}', ?, ?, ?)`)
    .run(own.profileId, own.planId, NOW, NOW, NOW).lastInsertRowid);
  db.prepare(`INSERT INTO communication_batch_items(
    batch_id, job_id, position, job_url, title_snapshot, company_snapshot, status, updated_at
  ) VALUES (?, ?, 1, 'https://example.test/job', '内容运营', '示例公司', 'pending', ?)`)
    .run(communicationBatchId, own.jobId, NOW);
  assert.throws(() => archiveCandidateJob(db, { ...own, archivedAt: NOW }),
    (error) => error.code === "JOB_ARCHIVE_ACTIVE_BATCH");
  assert.equal(isCandidateJobArchived(db, own), false);

  console.log("job_archive_store_smoke ok");
} finally {
  db.close();
}

function seedScope(db, suffix) {
  const profileId = Number(db.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, created_at, updated_at
  ) VALUES (?, '{}', ?, ?)`)
    .run(`Archive ${suffix}`, NOW, NOW).lastInsertRowid);
  const planId = Number(db.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, is_active, created_at, updated_at
  ) VALUES (?, ?, '{}', 1, ?, ?)`)
    .run(profileId, `Plan ${suffix}`, NOW, NOW).lastInsertRowid);
  const batchId = createBatch(db, "boss", suffix, "archive fixture", {
    profileId,
    searchPlanId: planId,
    startedAt: NOW,
    filterSnapshot: { execution: {} }
  });
  const jobId = upsertJob(db, {
    source: "boss",
    sourceId: `boss:archive-${suffix}`,
    keyword: suffix,
    title: `内容运营 ${suffix}`,
    company: `示例公司 ${suffix}`,
    location: "广州",
    description: "负责内容策划、复盘和增长实验。".repeat(10),
    analysis: { semanticStatus: "complete", recommendation: "primary", recommendationSchemaVersion: 2 }
  }, batchId);
  return { profileId, planId, jobId };
}
