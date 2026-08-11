"use strict";

const {
  openDb,
  saveProfileAnalysis,
  createBatch,
  upsertJob,
  createWorkflowRun,
  createScanRun,
  attachWorkflowScan,
  transitionWorkflowRun,
  insertWorkflowJobTaskRow,
  getWorkflowRun,
  recordSiteAccessEvent
} = require("../src/core/storage");
const { getWorkflowStatus } = require("../src/application/workflow");
const { recoverWorkflowRuns } = require("../src/core/workflow_run");
const { getWorkflowProgressSnapshot } = require("../src/core/workflow_progress");
const { communicationBatchSummary } = require("../src/core/communication_batches");

const FIXTURE_NOW = "2099-02-01T00:10:00.000Z";
const BUDGET = Object.freeze({ statements: 15, rows: 120 });

function measureWorkflowStatusRead({ communication = false, stale = false } = {}) {
  const db = openDb(":memory:");
  try {
    const fixture = seedFixture(db, { communication, stale });
    const measured = observeDb(db, () => getWorkflowStatus({
      db,
      workflowRunId: fixture.workflowRunId,
      deps: {
        recover(db, input) {
          return recoverWorkflowRuns(db, { ...input, now: stale ? "2099-02-01T00:10:00.000Z" : FIXTURE_NOW });
        },
        orphanTimeoutMs: 60_000,
        progressSnapshot: getWorkflowProgressSnapshot,
        getWorkflowRun,
        communicationBatchSummary,
        publicWorkflow,
        publicCommunicationStatus,
        logger: { warn() {} }
      }
    }));
    return { ...measured, fixture };
  } finally {
    db.close();
  }
}

function seedFixture(db, { communication, stale }) {
  const saved = saveProfileAnalysis(db, {
    profile: {
      candidate: { name: "Read model fixture", city: "广州", targetTitles: ["AI engineer"], expectedSalary: "10-20K" },
      education: [], experiences: [], skills: [], projects: [], credentials: [], strengths: []
    },
    document: { originalFileName: "fixture.txt", format: "text", contentHash: "read-model-fixture", text: "Python RAG experience", diagnostics: {} },
    searchPlan: {
      name: "Read model fixture", cities: ["广州"], directions: ["AI"],
      keywords: [{ word: "AI", priority: "A", reason: "fixture" }], salary: { minK: 10, maxK: 20 },
      experience: [], jobTypes: ["full-time"], degrees: [], bossActiveDays: 3, platform: { site: "boss" }
    }
  });
  const batchId = createBatch(db, "boss", "AI", "read model fixture", { profileId: saved.profileId, searchPlanId: saved.planId });
  const workflow = createWorkflowRun(db, {
    profileId: saved.profileId, planId: saved.planId, localDay: "2099-02-01", sequence: 1,
    targetSuccessCount: 40, inventoryCount: 0, candidateGap: 40, scanNeeded: true,
    keywords: [{ word: "AI", priority: "A" }], modelConfigRevision: "fixture-r1",
    planner: { modelProfiles: { batch_screening: { provider: "mock", model: "fixture", revision: "fixture-r1", concurrency: 2 } } }
  });
  const scan = createScanRun(db, { runId: "read-model-scan", site: "boss", planId: saved.planId, batchId });
  db.prepare("UPDATE scan_runs SET status = 'running', heartbeat_at = ? WHERE id = ?").run(FIXTURE_NOW, scan.id);
  transitionWorkflowRun(db, { id: workflow.id, status: "scanning" });
  attachWorkflowScan(db, { id: workflow.id, scanRunId: scan.id, scanBatchId: batchId });
  transitionWorkflowRun(db, { id: workflow.id, status: "analyzing", modelConfigRevision: "fixture-r1" });

  const observations = [];
  for (let index = 1; index <= 40; index += 1) {
    const jobId = upsertJob(db, {
      source: "boss", sourceId: `read-model-${index}`, keyword: "AI", title: `Fixture ${index}`,
      company: "Fixture", location: "广州", salary: "10-20K", experience: "1-3 years", education: "本科",
      bossActiveText: "active", bossActiveDays: 0, url: `https://fixture.invalid/${index}`,
      tags: [], description: index % 2 ? "Complete JD content" : "", score: 20, level: "high",
      matches: [], risks: [], qualityTags: index % 2 ? [] : ["detail_unverified"], analysis: {}
    }, batchId);
    observations.push({ jobId, observationId: Number(db.prepare("SELECT id FROM job_observations WHERE batch_id = ? AND job_id = ?").get(batchId, jobId).id) });
  }
  const taskIds = observations.map((entry, index) => {
    insertWorkflowJobTaskRow(db, {
      workflowRunId: workflow.id, batchId, jobId: entry.jobId, observationId: entry.observationId,
      position: index + 1, status: index < 6 ? "succeeded" : "pending", recoveryGeneration: 0,
      modelConfigRevision: "fixture-r1", now: `2099-02-01T00:0${Math.min(index, 9)}:00.000Z`
    });
    return Number(db.prepare("SELECT id FROM workflow_job_tasks WHERE workflow_run_id = ? AND position = ?").get(workflow.id, index + 1).id);
  });
  for (let index = 0; index < 6; index += 1) {
    db.prepare(`INSERT INTO job_analysis_attempts(
      workflow_run_id, task_id, job_id, recovery_generation, attempt_in_generation, total_attempt_number,
      profile_kind, model_config_revision, provider, model, thinking_mode, reasoning_effort, backup_used,
      status, retryable, model_call_count, prompt_tokens, completion_tokens, total_tokens, started_at,
      finished_at, latency_ms, created_at, updated_at
    ) VALUES (?, ?, ?, 0, 1, 1, 'batch_screening', 'fixture-r1', 'mock', 'fixture', 'disabled', 'low', 0,
      'succeeded', 0, 1, 1, 1, 2, ?, ?, 100, ?, ?)`)
      .run(workflow.id, taskIds[index], observations[index].jobId, `2099-02-01T00:0${index}:00.000Z`, `2099-02-01T00:0${index + 1}:00.000Z`, FIXTURE_NOW, FIXTURE_NOW);
  }
  for (let index = 0; index < 300; index += 1) {
    recordSiteAccessEvent(db, { site: "boss", action: "search", runId: workflow.id, details: { index }, createdAt: `2099-02-01T00:${String(index % 60).padStart(2, "0")}:00.000Z` });
  }
  if (communication) {
    const now = FIXTURE_NOW;
    const communicationBatchId = Number(db.prepare(`INSERT INTO communication_batches(
      site, profile_id, plan_id, browser_mode, status, policy_json, confirmed_at, created_at, updated_at
    ) VALUES ('boss', ?, ?, 'portable', 'running', '{}', ?, ?, ?)`)
      .run(saved.profileId, saved.planId, now, now, now).lastInsertRowid);
    observations.forEach((entry, index) => db.prepare(`INSERT INTO communication_batch_items(
      batch_id, job_id, position, job_url, title_snapshot, company_snapshot, status, evidence_json, updated_at
    ) VALUES (?, ?, ?, ?, 'fixture', 'fixture', ?, '{}', ?)`)
      .run(communicationBatchId, entry.jobId, index + 1, `https://fixture.invalid/${index + 1}`, index < 6 ? "succeeded" : "pending", now));
    db.prepare("UPDATE workflow_runs SET communication_batch_id = ? WHERE id = ?").run(communicationBatchId, workflow.id);
  }
  if (stale) {
    db.prepare("UPDATE scan_runs SET status = 'interrupted', stop_code = 'FIXTURE_STALE', finished_at = ? WHERE id = ?").run("2099-02-01T00:01:00.000Z", scan.id);
    db.prepare("UPDATE workflow_runs SET progress_revision = 7 WHERE id = ?").run(workflow.id);
  }
  return { workflowRunId: workflow.id };
}

function observeDb(db, action) {
  const originalPrepare = db.prepare.bind(db);
  const metrics = { statements: 0, prepared: 0, executed: { get: 0, all: 0, run: 0 }, rows: 0, tables: new Set() };
  db.prepare = (sql) => {
    const text = String(sql);
    metrics.prepared += 1;
    const statement = originalPrepare(sql);
    return new Proxy(statement, {
      get(target, property) {
        if (!["get", "all", "run"].includes(property)) {
          const value = target[property];
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (...params) => {
          metrics.statements += 1;
          metrics.executed[property] += 1;
          for (const table of normalizedTableTouches(text)) metrics.tables.add(table);
          const result = target[property](...params);
          if (property === "all") metrics.rows += result.length;
          return result;
        };
      }
    });
  };
  try {
    const result = action();
    return { result, metrics: { ...metrics, tables: [...metrics.tables].sort() } };
  } finally {
    db.prepare = originalPrepare;
  }
}

function normalizedTableTouches(sql) {
  return [...String(sql).toLowerCase().matchAll(/\b(?:from|join|update|into)\s+([a-z_][a-z0-9_]*)/g)]
    .map((match) => match[1])
    .filter((table) => !["select", "where"].includes(table));
}

function publicWorkflow(workflow) {
  return { id: String(workflow.id || ""), status: String(workflow.status || ""), controlState: String(workflow.controlState || "none"), lastActivityAt: workflow.lastActivityAt || null, progressRevision: Number(workflow.progressRevision || 0), errorCode: workflow.errorCode ? String(workflow.errorCode) : null };
}

function publicCommunicationStatus(communication) {
  if (!communication) return null;
  return { batch: { id: Number(communication.batch?.id || 0), status: String(communication.batch?.status || "") }, summary: communication.summary };
}

if (require.main === module) {
  for (const [label, options] of [["active", {}], ["communication", { communication: true }], ["stale", { stale: true }]]) {
    const { metrics, result } = measureWorkflowStatusRead(options);
    console.log(JSON.stringify({ label, statusCode: result.statusCode, workflowStatus: result.body.workflow?.status, ...metrics }));
  }
}

module.exports = { BUDGET, measureWorkflowStatusRead };
