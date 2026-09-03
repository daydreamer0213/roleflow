const crypto = require("crypto");
const jobStore = require("./job_store");
const { nowIso, parseJson, storageError, optionalInteger, optionalPositiveInteger, nullableText, validDate } = require("./storage_shared");
const { PRODUCT_POLICY } = require("../core/product_policy");

const SCAN_RUN_STATUSES = ["running", "completed", "partial", "failed", "interrupted"];
const TERMINAL_SCAN_RUN_STATUSES = new Set(SCAN_RUN_STATUSES.slice(1));
const SCAN_PROGRESS_ACTIVITIES = new Set(["searching", "reading_detail", "target_complete"]);
const BOSS_PACING_FIELDS = Object.freeze([
  "pacedActions",
  "nextPacingCooldownAt",
  "detailActions",
  "nextDetailMicroCooldownAt",
  "nextDetailMacroCooldownAt"
]);
const scanRunError = storageError;

function getSitePacingState(db, site = "boss") {
  const normalizedSite = normalizedPacingSite(site);
  const row = db.prepare(`SELECT pacing_json, updated_at
    FROM message_discovery_runtime_states
    WHERE platform = ?`).get(normalizedSite);
  return {
    site: normalizedSite,
    pacing: row ? parseBossPacing(row.pacing_json) : null,
    updatedAt: row?.updated_at || ""
  };
}

function setSitePacingState(db, { site = "boss", pacing, updatedAt = nowIso() } = {}) {
  const normalizedSite = normalizedPacingSite(site);
  const normalizedPacing = normalizeBossPacing(pacing);
  const timestamp = String(updatedAt || "").trim();
  if (!Number.isFinite(Date.parse(timestamp))) throw new TypeError("site pacing updatedAt must be ISO time");
  db.prepare(`INSERT INTO message_discovery_runtime_states(platform, pacing_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(platform) DO UPDATE SET
      pacing_json = excluded.pacing_json,
      updated_at = excluded.updated_at`)
    .run(normalizedSite, JSON.stringify(normalizedPacing || {}), timestamp);
  return getSitePacingState(db, normalizedSite);
}

function mergeBossPacingStates(...states) {
  const valid = states.map(normalizeBossPacing).filter(Boolean);
  if (valid.length === 0) return null;
  const pacedActions = Math.max(...valid.map((state) => state.pacedActions));
  const detailActions = Math.max(...valid.map((state) => state.detailActions));
  return {
    pacedActions,
    nextPacingCooldownAt: mergedThreshold(valid, "pacedActions", "nextPacingCooldownAt", pacedActions),
    detailActions,
    nextDetailMicroCooldownAt: mergedThreshold(valid, "detailActions", "nextDetailMicroCooldownAt", detailActions),
    nextDetailMacroCooldownAt: mergedThreshold(valid, "detailActions", "nextDetailMacroCooldownAt", detailActions)
  };
}

function normalizeBossPacing(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const pacing = {};
  for (const field of BOSS_PACING_FIELDS) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) return null;
    pacing[field] = value[field];
  }
  const policy = PRODUCT_POLICY.operations.bossPacing;
  if (pacing.nextPacingCooldownAt > pacing.pacedActions + Math.max(...policy.periodicEvery)
    || pacing.nextDetailMicroCooldownAt > pacing.detailActions + Math.max(...policy.detail.microEvery)
    || pacing.nextDetailMacroCooldownAt > pacing.detailActions + Math.max(...policy.detail.macroEvery)) {
    return null;
  }
  return pacing;
}

function parseBossPacing(value) {
  try {
    return normalizeBossPacing(JSON.parse(String(value || "{}")));
  } catch {
    return null;
  }
}

function mergedThreshold(states, countField, thresholdField, mergedCount) {
  const remaining = Math.min(...states.map((state) => state[thresholdField] - state[countField]));
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, mergedCount + remaining));
}

function normalizedPacingSite(value) {
  const site = String(value || "").trim().toLowerCase();
  if (!site) throw new TypeError("site pacing state requires a site");
  return site;
}

function recordSiteAccessEvent(db, {
  site,
  action,
  runId = "",
  details = {},
  createdAt = new Date().toISOString()
}) {
  const normalizedSite = String(site || "").trim().toLowerCase();
  const normalizedAction = String(action || "").trim().toLowerCase();
  if (!normalizedSite || !normalizedAction) throw new Error("站点访问事件必须包含 site 和 action。");
  const payload = { ...details, site: normalizedSite, action: normalizedAction, runId: String(runId || "") };
  const result = db.prepare("INSERT INTO events(job_id, event_type, payload_json, created_at) VALUES (NULL, 'site_access', ?, ?)")
    .run(JSON.stringify(payload), String(createdAt));
  return { id: Number(result.lastInsertRowid), site: normalizedSite, action: normalizedAction, createdAt: String(createdAt), details: payload };
}

function listSiteAccessEvents(db, { site, action = "", since = "1970-01-01T00:00:00.000Z", limit = 10000 } = {}) {
  const normalizedSite = String(site || "").trim().toLowerCase();
  const normalizedAction = String(action || "").trim().toLowerCase();
  const actionClause = normalizedAction ? " AND json_extract(payload_json, '$.action') = ?" : "";
  const params = [String(since), normalizedSite];
  if (normalizedAction) params.push(normalizedAction);
  params.push(Math.max(1, Math.min(10000, Number(limit) || 10000)));
  return db.prepare(`SELECT id, payload_json, created_at FROM events
    WHERE event_type = 'site_access' AND created_at >= ?
      AND json_extract(payload_json, '$.site') = ?${actionClause}
    ORDER BY created_at ASC, id ASC LIMIT ?`)
    .all(...params)
    .map((row) => ({ id: Number(row.id), createdAt: row.created_at, details: parseJson(row.payload_json, {}) }))
    .filter((event) => event.details.site === normalizedSite && (!normalizedAction || event.details.action === normalizedAction))
    .map((event) => ({ ...event, site: event.details.site, action: event.details.action }));
}


function createBatch(db, site, keyword, note = "", context = {}) {
  return insertBatch(db, site, keyword, note, context);
}

function createAndBindScanBatch(db, input = {}) {
  const runId = requiredRunId(input);
  const owner = normalizedLeaseOwner(input);
  const site = String(input.site || "").trim().toLowerCase();
  const planId = optionalPositiveInteger(input.searchPlanId, "searchPlanId");
  const processId = optionalPositiveInteger(input.processId ?? input.pid, "processId");
  if (!site) throw scanRunError("SCAN_RUN_SITE_REQUIRED", "scan run site is required");
  const startedAt = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    const run = requireRunningScanRun(db, runId);
    if (run.site !== site) throw scanRunError("SCAN_RUN_BATCH_MISMATCH", "scan run belongs to another site");
    if (run.batch_id) throw scanRunError("SCAN_RUN_BATCH_MISMATCH", "scan run is already bound to a batch");
    if (Number(run.plan_id || 0) !== Number(planId || 0)) {
      throw scanRunError("SCAN_RUN_PLAN_MISMATCH", "scan batch belongs to another search plan");
    }
    if (owner) {
      if (run.lease_owner && run.lease_owner !== owner) {
        throw scanRunError("SCAN_RUN_LEASE_MISMATCH", "scan run lease owner does not match");
      }
      const lease = db.prepare("SELECT owner, plan_id, expires_at FROM site_scan_leases WHERE site = ?").get(site);
      const expiresAt = Date.parse(lease?.expires_at || "");
      if (!lease || lease.owner !== owner || !Number.isFinite(expiresAt) || expiresAt <= Date.parse(startedAt)) {
        throw scanRunError("SCAN_RUN_LEASE_MISMATCH", "active site lease does not belong to the scan run owner");
      }
      if (Number(lease.plan_id || 0) !== Number(planId || 0)) {
        throw scanRunError("SCAN_RUN_PLAN_MISMATCH", "site lease belongs to another search plan");
      }
    } else if (run.lease_owner) {
      throw scanRunError("SCAN_RUN_LEASE_MISMATCH", "scan run is already claimed by a lease owner");
    }
    const batchId = insertBatch(db, site, input.keyword, input.note || "", {
      status: input.status || "running",
      profileId: input.profileId,
      searchPlanId: planId,
      filterSnapshot: input.filterSnapshot,
      startedAt
    });
    db.prepare(`UPDATE scan_runs
      SET batch_id = ?, lease_owner = COALESCE(?, lease_owner), process_id = COALESCE(?, process_id),
        started_at = COALESCE(started_at, ?), heartbeat_at = ?
      WHERE id = ?`)
      .run(batchId, owner || null, processId, startedAt, startedAt, runId);
    db.exec("COMMIT");
    return batchId;
  } catch (error) {
    rollback(db);
    throw error;
  }
}

function insertBatch(db, site, keyword, note, context = {}) {
  const startedAt = String(context.startedAt || nowIso());
  const status = normalizeBatchStatus(context.status);
  const finishedAt = status === "running" ? null : String(context.finishedAt || startedAt);
  const result = db.prepare(`INSERT INTO batches(
    site, keyword, started_at, note, profile_id, search_plan_id, filter_snapshot_json,
    status, finished_at, stop_code, stop_message
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    site,
    keyword || null,
    startedAt,
    note,
    context.profileId || null,
    context.searchPlanId || null,
    JSON.stringify(context.filterSnapshot || {}),
    status,
    finishedAt,
    nullableText(context.stopCode),
    nullableText(context.stopMessage, 1000)
  );
  return Number(result.lastInsertRowid);
}

function normalizeBatchStatus(status) {
  const normalized = String(status || "completed").trim().toLowerCase();
  if (!SCAN_RUN_STATUSES.includes(normalized)) {
    throw scanRunError("SCAN_BATCH_STATUS_INVALID", "scan batch status is invalid");
  }
  return normalized;
}

function getBatch(db, batchId) {
  const id = optionalPositiveInteger(batchId, "batchId");
  if (!id) return null;
  const row = db.prepare(`SELECT id, site, keyword, started_at, note, profile_id, search_plan_id,
    filter_snapshot_json, status, finished_at, stop_code, stop_message
    FROM batches WHERE id = ?`).get(id);
  if (!row) return null;
  return {
    id: Number(row.id),
    site: row.site,
    keyword: row.keyword || "",
    startedAt: row.started_at,
    note: row.note || "",
    profileId: Number(row.profile_id || 0) || null,
    searchPlanId: Number(row.search_plan_id || 0) || null,
    filterSnapshot: parseJson(row.filter_snapshot_json, {}),
    status: row.status,
    finishedAt: row.finished_at || null,
    stopCode: row.stop_code || "",
    stopMessage: row.stop_message || ""
  };
}

function getLatestResumableBatch(db, { planId, site = "boss" } = {}) {
  const normalizedPlanId = optionalPositiveInteger(planId, "planId");
  if (!normalizedPlanId) return null;
  const normalizedSite = String(site || "boss").trim().toLowerCase();
  const rows = db.prepare(`SELECT id FROM batches
    WHERE search_plan_id = ? AND site = ? AND status IN ('partial', 'failed', 'interrupted')
    ORDER BY started_at DESC, id DESC`).all(normalizedPlanId, normalizedSite);
  for (const row of rows) {
    const batch = getBatch(db, row.id);
    if (batch?.filterSnapshot?.execution) return batch;
  }
  return null;
}

function createScanRun(db, input = {}) {
  const runId = String(input.runId || input.id || crypto.randomUUID()).trim();
  const site = String(input.site || "boss").trim().toLowerCase();
  if (!runId) throw scanRunError("SCAN_RUN_ID_REQUIRED", "scan run id is required");
  if (!site) throw scanRunError("SCAN_RUN_SITE_REQUIRED", "scan run site is required");
  const createdAt = String(input.createdAt || nowIso());
  const startedAt = input.startedAt ? String(input.startedAt) : null;
  db.prepare(`INSERT INTO scan_runs(
    id, site, command, plan_id, batch_id, status, lease_owner, process_id,
    created_at, started_at, heartbeat_at
  ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`)
    .run(
      runId,
      site,
      String(input.command || "scan"),
      optionalPositiveInteger(input.planId, "planId"),
      optionalPositiveInteger(input.batchId, "batchId"),
      normalizedLeaseOwner(input) || null,
      optionalPositiveInteger(input.processId ?? input.pid, "processId"),
      createdAt,
      startedAt,
      input.heartbeatAt ? String(input.heartbeatAt) : startedAt
    );
  return getScanRun(db, runId);
}

function getScanRun(db, runId) {
  const id = String(runId || "").trim();
  if (!id) return null;
  const row = db.prepare("SELECT * FROM scan_runs WHERE id = ?").get(id);
  return row ? scanRunRow(row) : null;
}

function getLatestScanRun(db, { planId, site = "" } = {}) {
  const normalizedPlanId = optionalPositiveInteger(planId, "planId");
  if (!normalizedPlanId) return null;
  const normalizedSite = String(site || "").trim().toLowerCase();
  const row = db.prepare(`SELECT * FROM scan_runs
    WHERE plan_id = ? AND (? = '' OR site = ?)
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1`)
    .get(normalizedPlanId, normalizedSite, normalizedSite);
  return row ? scanRunRow(row) : null;
}

function beginScanRun(db, input = {}) {
  const requestedId = String(input.runId || input.id || "").trim();
  let run = requestedId ? getScanRun(db, requestedId) : null;
  if (!run) {
    run = createScanRun(db, {
      ...input,
      runId: requestedId || undefined,
      startedAt: input.startedAt || nowIso()
    });
  }
  const owner = normalizedLeaseOwner(input);
  if (owner) return claimScanRun(db, { ...input, runId: run.id, leaseOwner: owner });

  const batchId = optionalPositiveInteger(input.batchId, "batchId") || run.batchId;
  const processId = optionalPositiveInteger(input.processId ?? input.pid, "processId");
  const startedAt = String(input.startedAt || nowIso());
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = requireRunningScanRun(db, run.id);
    if (current.batch_id && batchId && Number(current.batch_id) !== batchId) {
      throw scanRunError("SCAN_RUN_BATCH_MISMATCH", "scan run is bound to another batch");
    }
    if (batchId) validateScanRunBatch(db, current, batchId);
    db.prepare(`UPDATE scan_runs
      SET batch_id = COALESCE(?, batch_id), process_id = COALESCE(?, process_id),
        started_at = COALESCE(started_at, ?), heartbeat_at = ?
      WHERE id = ?`)
      .run(batchId, processId, startedAt, startedAt, run.id);
    if (batchId) markBatchRunning(db, batchId);
    db.exec("COMMIT");
    return getScanRun(db, run.id);
  } catch (error) {

    rollback(db);
    throw error;
  }
}

function claimScanRun(db, input = {}) {
  const runId = requiredRunId(input);
  const owner = normalizedLeaseOwner(input);
  if (!owner) throw scanRunError("SCAN_RUN_LEASE_OWNER_REQUIRED", "scan run lease owner is required");
  const heartbeatAt = String(input.heartbeatAt || nowIso());
  db.exec("BEGIN IMMEDIATE");
  try {
    const run = requireRunningScanRun(db, runId);
    if (run.lease_owner && run.lease_owner !== owner) {
      throw scanRunError("SCAN_RUN_CLAIMED", "scan run is claimed by another lease owner");
    }
    const lease = db.prepare("SELECT * FROM site_scan_leases WHERE site = ?").get(run.site);
    if (!lease || lease.owner !== owner || Date.parse(lease.expires_at) <= Date.now()) {
      throw scanRunError("SCAN_RUN_LEASE_MISMATCH", "active site lease does not belong to the scan run owner");
    }
    if (run.plan_id && lease.plan_id && Number(run.plan_id) !== Number(lease.plan_id)) {
      throw scanRunError("SCAN_RUN_PLAN_MISMATCH", "site lease belongs to another search plan");
    }
    const batchId = optionalPositiveInteger(input.batchId, "batchId") || Number(run.batch_id || 0) || null;
    if (run.batch_id && batchId && Number(run.batch_id) !== batchId) {
      throw scanRunError("SCAN_RUN_BATCH_MISMATCH", "scan run is bound to another batch");
    }
    if (batchId) validateScanRunBatch(db, run, batchId);
    db.prepare(`UPDATE scan_runs
      SET batch_id = COALESCE(?, batch_id), lease_owner = ?, process_id = COALESCE(?, process_id),
        started_at = COALESCE(started_at, ?), heartbeat_at = ?
      WHERE id = ?`)
      .run(
        batchId,
        owner,
        optionalPositiveInteger(input.processId ?? input.pid, "processId"),
        String(input.startedAt || heartbeatAt),
        heartbeatAt,
        runId
      );
    if (batchId) markBatchRunning(db, batchId);
    db.exec("COMMIT");
    return getScanRun(db, runId);
  } catch (error) {
    rollback(db);
    throw error;
  }
}

function heartbeatScanRun(db, input = {}) {
  const runId = requiredRunId(input);
  const owner = normalizedLeaseOwner(input);
  const allowUnleased = input.allowUnleased === true;
  if (!owner && !allowUnleased) throw scanRunError("SCAN_RUN_LEASE_OWNER_REQUIRED", "scan run lease owner is required");
  const heartbeatAt = String(input.heartbeatAt || nowIso());
  const processId = optionalPositiveInteger(input.processId ?? input.pid, "processId");
  const result = owner
    ? db.prepare(`UPDATE scan_runs
        SET heartbeat_at = ?, process_id = COALESCE(?, process_id)
        WHERE id = ? AND status = 'running' AND lease_owner = ?`).run(heartbeatAt, processId, runId, owner)
    : db.prepare(`UPDATE scan_runs
        SET heartbeat_at = ?, process_id = COALESCE(?, process_id)
        WHERE id = ? AND status = 'running' AND COALESCE(lease_owner, '') = ''`).run(heartbeatAt, processId, runId);
  if (!Number(result.changes || 0)) {
    const run = getScanRun(db, runId);
    if (!run) throw scanRunError("SCAN_RUN_NOT_FOUND", "scan run not found");
    if (run.status !== "running") throw scanRunError("SCAN_RUN_NOT_RUNNING", "scan run is not running");
    throw scanRunError("SCAN_RUN_LEASE_MISMATCH", "scan run lease owner does not match");
  }
  return getScanRun(db, runId);
}

function finishScanRun(db, input = {}) {
  const runId = requiredRunId(input);
  const status = requireTerminalScanStatus(input.status);
  const owner = normalizedLeaseOwner(input);
  const finishedAt = String(input.finishedAt || nowIso());
  const stopCode = nullableText(input.stopCode);
  const stopMessage = nullableText(input.stopMessage, 1000);
  db.exec("BEGIN IMMEDIATE");
  try {
    const run = db.prepare("SELECT * FROM scan_runs WHERE id = ?").get(runId);
    if (!run) throw scanRunError("SCAN_RUN_NOT_FOUND", "scan run not found");
    if (owner && run.lease_owner && run.lease_owner !== owner) {
      throw scanRunError("SCAN_RUN_LEASE_MISMATCH", "scan run lease owner does not match");
    }
    if (run.status !== "running") {
      if (run.status !== status) {
        throw scanRunError("SCAN_RUN_ALREADY_FINISHED", `scan run already finished as ${run.status}`);
      }
      db.exec("COMMIT");
      return getScanRun(db, runId);
    }
    db.prepare(`UPDATE scan_runs
      SET status = ?, heartbeat_at = ?, finished_at = ?, stop_code = ?, stop_message = ?
      WHERE id = ?`)
      .run(status, finishedAt, finishedAt, stopCode, stopMessage, runId);
    if (run.batch_id) syncBatchTerminalState(db, Number(run.batch_id), status, finishedAt, stopCode, stopMessage);
    db.exec("COMMIT");
    return getScanRun(db, runId);
  } catch (error) {
    rollback(db);
    throw error;
  }
}

function recordScanRunProcessExit(db, input = {}) {
  const runId = requiredRunId(input);
  const exitedAt = String(input.exitedAt || input.finishedAt || nowIso());
  const exitCode = optionalInteger(input.exitCode, "exitCode");
  const signal = nullableText(input.signal);
  db.exec("BEGIN IMMEDIATE");
  try {
    const run = db.prepare("SELECT * FROM scan_runs WHERE id = ?").get(runId);
    if (!run) throw scanRunError("SCAN_RUN_NOT_FOUND", "scan run not found");
    if (run.status !== "running") {
      db.prepare("UPDATE scan_runs SET process_exit_code = ?, process_signal = ? WHERE id = ?")
        .run(exitCode, signal, runId);
      db.exec("COMMIT");
      return getScanRun(db, runId);
    }
    const status = input.status ? requireTerminalScanStatus(input.status) : processExitStatus(db, run, exitCode, signal);
    let stopCode = nullableText(input.stopCode) || run.stop_code || null;
    let stopMessage = nullableText(input.stopMessage, 1000) || run.stop_message || null;
    if (!stopCode && status !== "completed") stopCode = signal ? "SCAN_PROCESS_SIGNAL" : "SCAN_PROCESS_EXIT";
    if (!stopMessage && status !== "completed") {
      stopMessage = signal
        ? `scan process exited with signal ${signal}`
        : `scan process exited with code ${exitCode ?? "unknown"}`;
    }
    db.prepare(`UPDATE scan_runs
      SET status = ?, heartbeat_at = ?, finished_at = COALESCE(finished_at, ?),
        stop_code = ?, stop_message = ?, process_exit_code = ?, process_signal = ?
      WHERE id = ?`)
      .run(status, exitedAt, exitedAt, stopCode, stopMessage, exitCode, signal, runId);
    if (run.batch_id) {
      const batch = db.prepare("SELECT status FROM batches WHERE id = ?").get(run.batch_id);
      const rebound = db.prepare("SELECT 1 FROM scan_runs WHERE batch_id = ? AND id <> ? AND status = 'running' LIMIT 1")
        .get(run.batch_id, runId);
      if (batch?.status === "running" && !rebound) {
        syncBatchTerminalState(db, Number(run.batch_id), status, exitedAt, stopCode, stopMessage);
      }
    }
    db.exec("COMMIT");
    return getScanRun(db, runId);
  } catch (error) {
    rollback(db);
    throw error;
  }
}

function interruptOrphanedScanRuns(db, input = {}) {
  const now = validDate(input.now || Date.now(), "now");
  const staleBefore = input.staleBefore
    ? validDate(input.staleBefore, "staleBefore")
    : new Date(now.getTime() - Math.max(0, Number(input.heartbeatTimeoutMs ?? PRODUCT_POLICY.operations.scanOrphanTimeoutMs)));
  const site = String(input.site || "").trim().toLowerCase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const staleRuns = db.prepare(`SELECT * FROM scan_runs
      WHERE status = 'running'
        AND COALESCE(heartbeat_at, started_at, created_at) <= ?
        AND (? = '' OR site = ?)
      ORDER BY created_at, id`)
      .all(staleBefore.toISOString(), site, site);
    const interruptedRuns = [];
    for (const run of staleRuns) {
      if (run.lease_owner) {
        const lease = db.prepare("SELECT owner, expires_at FROM site_scan_leases WHERE site = ?").get(run.site);
        if (lease?.owner === run.lease_owner) {
          const expiresAt = Date.parse(lease.expires_at);
          if (Number.isFinite(expiresAt) && expiresAt > now.getTime()) continue;
          db.prepare("DELETE FROM site_scan_leases WHERE site = ? AND owner = ?").run(run.site, run.lease_owner);
        }
      }
      const result = db.prepare(`UPDATE scan_runs
        SET status = 'interrupted', heartbeat_at = ?, finished_at = ?,
          stop_code = 'SCAN_RUN_ORPHANED', stop_message = 'scan run heartbeat expired'
        WHERE id = ? AND status = 'running'`)
        .run(now.toISOString(), now.toISOString(), run.id);
      if (!Number(result.changes || 0)) continue;
      interruptedRuns.push(run);
      if (run.batch_id) {
        const batch = db.prepare("SELECT status FROM batches WHERE id = ?").get(run.batch_id);
        const rebound = db.prepare("SELECT 1 FROM scan_runs WHERE batch_id = ? AND id <> ? AND status = 'running' LIMIT 1")
          .get(run.batch_id, run.id);
        if (batch?.status === "running" && !rebound) {
          syncBatchTerminalState(db, Number(run.batch_id), "interrupted", now.toISOString(), "SCAN_RUN_ORPHANED", "scan run heartbeat expired");
        }
      }
    }
    db.exec("COMMIT");
    return { interrupted: interruptedRuns.length, runIds: interruptedRuns.map((run) => run.id) };
  } catch (error) {
    rollback(db);
    throw error;
  }
}

function checkpointScanTarget(db, input = {}) {

  const runId = requiredRunId(input);
  const batchId = optionalPositiveInteger(input.batchId, "batchId");
  const owner = normalizedLeaseOwner(input);
  if (!batchId) throw scanRunError("SCAN_RUN_BATCH_REQUIRED", "scan target batchId is required");
  if (!owner) throw scanRunError("SCAN_RUN_LEASE_OWNER_REQUIRED", "scan target lease owner is required");
  if (!Array.isArray(input.jobs)) throw new TypeError("scan target jobs must be an array");
  const checkpointedAt = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    const run = requireRunningScanRun(db, runId);
    if (Number(run.batch_id || 0) !== batchId) {
      throw scanRunError("SCAN_RUN_BATCH_MISMATCH", "scan run is not bound to the target batch");
    }
    if (run.lease_owner !== owner) {
      throw scanRunError("SCAN_RUN_LEASE_MISMATCH", "scan run lease owner does not match");
    }
    const batch = validateScanRunBatch(db, run, batchId);
    if (batch.status !== "running") {
      throw scanRunError("SCAN_BATCH_NOT_RUNNING", "scan batch is not running");
    }
    const lease = db.prepare("SELECT owner, expires_at FROM site_scan_leases WHERE site = ?").get(run.site);
    const leaseExpiresAt = Date.parse(lease?.expires_at || "");
    if (!lease || lease.owner !== owner || !Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= Date.parse(checkpointedAt)) {
      throw scanRunError("SCAN_LEASE_LOST", "scan lease was lost before the checkpoint could be saved");
    }
    const jobIds = input.jobs.map((job) => jobStore.upsertJob(db, job, batchId));
    updateBatchRuntimeSnapshot(db, batch, input.runtime);
    checkpointSharedPacing(db, run.site, input.runtime, checkpointedAt);
    const target = input.target && typeof input.target === "object" ? { ...input.target, ...input } : input;
    db.prepare("UPDATE scan_runs SET heartbeat_at = ? WHERE id = ?").run(checkpointedAt, runId);
    const attemptNumber = recordScanTargetResult(db, {
      ...target,
      batchId,
      jobCount: target.jobCount === undefined ? input.jobs.length : target.jobCount
    });
    db.exec("COMMIT");
    return {
      runId,
      batchId,
      targetKey: String(target.targetKey || ""),
      attemptNumber,
      jobCount: input.jobs.length,
      jobIds
    };
  } catch (error) {
    rollback(db);
    throw error;
  }
}

function checkpointScanProgress(db, input = {}) {
  const runId = requiredRunId(input);
  const batchId = optionalPositiveInteger(input.batchId, "batchId");
  const owner = normalizedLeaseOwner(input);
  if (!batchId) throw scanRunError("SCAN_RUN_BATCH_REQUIRED", "scan progress batchId is required");
  if (!owner) throw scanRunError("SCAN_RUN_LEASE_OWNER_REQUIRED", "scan progress lease owner is required");
  if (!Array.isArray(input.jobs)) throw new TypeError("scan progress jobs must be an array");
  const checkpointedAt = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    const run = requireRunningScanRun(db, runId);
    if (Number(run.batch_id || 0) !== batchId) {
      throw scanRunError("SCAN_RUN_BATCH_MISMATCH", "scan run is not bound to the progress batch");
    }
    if (run.lease_owner !== owner) {
      throw scanRunError("SCAN_RUN_LEASE_MISMATCH", "scan run lease owner does not match");
    }
    const batch = validateScanRunBatch(db, run, batchId);
    if (batch.status !== "running") {
      throw scanRunError("SCAN_BATCH_NOT_RUNNING", "scan batch is not running");
    }
    const lease = db.prepare("SELECT owner, expires_at FROM site_scan_leases WHERE site = ?").get(run.site);
    const leaseExpiresAt = Date.parse(lease?.expires_at || "");
    if (!lease || lease.owner !== owner || !Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= Date.parse(checkpointedAt)) {
      throw scanRunError("SCAN_LEASE_LOST", "scan lease was lost before the checkpoint could be saved");
    }
    const jobIds = input.jobs.map((job) => jobStore.upsertJob(db, job, batchId));
    updateBatchRuntimeSnapshot(db, batch, input.runtime);
    checkpointSharedPacing(db, run.site, input.runtime, checkpointedAt);
    db.prepare("UPDATE scan_runs SET heartbeat_at = ? WHERE id = ?").run(checkpointedAt, runId);
    db.exec("COMMIT");
    return { runId, batchId, jobCount: input.jobs.length, jobIds };
  } catch (error) {
    rollback(db);
    throw error;
  }
}

function updateBatchRuntimeSnapshot(db, batch, runtime) {
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) return;
  const current = parseJson(batch?.filter_snapshot_json, {});
  const previousRuntime = current.runtime && typeof current.runtime === "object" && !Array.isArray(current.runtime)
    ? current.runtime
    : {};
  const nextRuntime = { ...previousRuntime, ...runtime };
  if (Object.hasOwn(runtime, "scanProgress")) {
    nextRuntime.scanProgress = normalizeScanProgress(runtime.scanProgress, current.execution);
  }
  db.prepare("UPDATE batches SET filter_snapshot_json = ? WHERE id = ?")
    .run(JSON.stringify({ ...current, runtime: nextRuntime }), batch.id);
}

function checkpointSharedPacing(db, site, runtime, updatedAt) {
  if (String(site || "").toLowerCase() !== "boss"
    || !runtime
    || typeof runtime !== "object"
    || Array.isArray(runtime)
    || !Object.hasOwn(runtime, "bossPacing")) return;
  setSitePacingState(db, { site: "boss", pacing: runtime.bossPacing, updatedAt });
}

function normalizeScanProgress(value, execution) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw scanRunError("SCAN_PROGRESS_INVALID", "scan progress must be an object");
  }
  const targetKey = String(value.targetKey || "").trim();
  const targets = Array.isArray(execution?.targets) ? execution.targets : [];
  const target = targets.find((entry) => String(entry?.targetKey || "") === targetKey);
  const activity = String(value.activity || "");
  if (!target || Number(value.version) !== 1 || !SCAN_PROGRESS_ACTIVITIES.has(activity)) {
    throw scanRunError("SCAN_PROGRESS_INVALID", "scan progress does not match the frozen execution target");
  }
  const integer = (input) => Math.max(0, Math.floor(Number(input) || 0));
  const updatedAt = String(value.updatedAt || "");
  if (!Number.isFinite(Date.parse(updatedAt))) {
    throw scanRunError("SCAN_PROGRESS_INVALID", "scan progress updatedAt must be ISO time");
  }
  const targetPosition = integer(value.targetPosition);
  const targetTotal = integer(value.targetTotal);
  const targetDiscovered = integer(value.targetDiscovered);
  const detailPosition = integer(value.detailPosition);
  const detailTotal = integer(value.detailTotal);
  const frozenPosition = targets.findIndex((entry) => String(entry?.targetKey || "") === targetKey) + 1;
  const cardLimit = Number(target.cardLimit || 0);
  const violations = [
    targetPosition !== frozenPosition
      ? { name: "target_position_mismatch", actual: targetPosition, limit: frozenPosition }
      : null,
    targetTotal !== targets.length
      ? { name: "target_total_mismatch", actual: targetTotal, limit: targets.length }
      : null,
    targetDiscovered > cardLimit
      ? { name: "target_discovered_exceeds_card_limit", actual: targetDiscovered, limit: cardLimit }
      : null,
    detailPosition > detailTotal
      ? { name: "detail_position_exceeds_detail_total", actual: detailPosition, limit: detailTotal }
      : null,
    detailTotal > targetDiscovered
      ? { name: "detail_total_exceeds_target_discovered", actual: detailTotal, limit: targetDiscovered }
      : null
  ].filter(Boolean);
  if (violations.length) {
    const error = scanRunError("SCAN_PROGRESS_INVALID", "scan progress counters exceed the frozen target bounds");
    error.details = {
      category: "scan_progress_bounds",
      violations,
      counters: { targetPosition, targetTotal, targetDiscovered, detailPosition, detailTotal },
      bounds: { frozenPosition, frozenTargetTotal: targets.length, cardLimit }
    };
    throw error;
  }
  return {
    version: 1,
    activity,
    targetKey,
    targetPosition,
    targetTotal,
    targetDiscovered,
    detailPosition,
    detailTotal,
    updatedAt
  };
}

function recordScanTargetResult(db, input = {}) {
  const batchId = Number(input.batchId || 0);
  const targetKey = String(input.targetKey || "").trim();
  if (!Number.isInteger(batchId) || batchId <= 0) throw new Error("scan target batchId is required");
  if (!targetKey) throw new Error("scan target key is required");
  const attemptNumber = Number(db.prepare("SELECT COALESCE(MAX(attempt_number), 0) + 1 AS n FROM scan_target_results WHERE batch_id = ? AND target_key = ?").get(batchId, targetKey)?.n || 1);
  const finishedAt = String(input.finishedAt || nowIso());
  const startedAt = String(input.startedAt || finishedAt);
  db.prepare(`INSERT INTO scan_target_results(
    batch_id, target_key, city, keyword, lane_id, status, job_count, error_code, error_message,
    details_json, attempt_number, started_at, finished_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      batchId,
      targetKey,
      String(input.city || "") || null,
      String(input.keyword || "") || null,
      String(input.laneId || "") || null,
      String(input.status || "failed"),
      Math.max(0, Number(input.jobCount || 0)),
      String(input.errorCode || "") || null,
      String(input.errorMessage || "").slice(0, 1000) || null,
      JSON.stringify(input.details || {}),
      attemptNumber,
      startedAt,
      finishedAt
    );
  return attemptNumber;
}

function listScanTargetResults(db, batchId) {
  return db.prepare("SELECT * FROM scan_target_results WHERE batch_id = ? ORDER BY id").all(Number(batchId)).map(scanTargetResultRow);
}

function listLatestScanTargetResults(db, batchId) {
  return db.prepare(`
    SELECT result.*
    FROM scan_target_results result
    JOIN (
      SELECT target_key, MAX(id) AS id
      FROM scan_target_results
      WHERE batch_id = ?
      GROUP BY target_key
    ) latest ON latest.id = result.id
    ORDER BY result.id
  `).all(Number(batchId)).map(scanTargetResultRow);
}

function summarizeScanTargets(db, batchId) {
  const results = listLatestScanTargetResults(db, batchId);
  const counts = { completed: 0, partial: 0, failed: 0 };
  let jobCount = 0;
  for (const result of results) {
    if (Object.hasOwn(counts, result.status)) counts[result.status] += 1;
    jobCount += result.jobCount;
  }
  const status = !results.length
    ? "running"
    : counts.completed === results.length
      ? "completed"
      : counts.failed === results.length
        ? "failed"
        : "partial";
  return {
    batchId: Number(batchId),
    status,
    total: results.length,
    completed: counts.completed,
    partial: counts.partial,
    failed: counts.failed,
    jobCount
  };
}

function scanTargetResultRow(row) {
  return {
    id: Number(row.id),
    batchId: Number(row.batch_id),
    targetKey: row.target_key,
    city: row.city || "",
    keyword: row.keyword || "",
    laneId: row.lane_id || "",
    status: row.status,
    jobCount: Number(row.job_count || 0),
    errorCode: row.error_code || "",
    errorMessage: row.error_message || "",
    details: parseJson(row.details_json, {}),
    attemptNumber: Number(row.attempt_number || 1),
    startedAt: row.started_at,
    finishedAt: row.finished_at
  };
}

function requiredRunId(input) {
  const runId = String(input.runId || input.id || "").trim();
  if (!runId) throw scanRunError("SCAN_RUN_ID_REQUIRED", "scan run id is required");
  return runId;
}

function normalizedLeaseOwner(input) {
  return String(input.leaseOwner || input.owner || "").trim();
}

function requireTerminalScanStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (!TERMINAL_SCAN_RUN_STATUSES.has(normalized)) {
    throw scanRunError("SCAN_RUN_STATUS_INVALID", "scan run terminal status is invalid");
  }
  return normalized;
}


function requireRunningScanRun(db, runId) {
  const run = db.prepare("SELECT * FROM scan_runs WHERE id = ?").get(runId);
  if (!run) throw scanRunError("SCAN_RUN_NOT_FOUND", "scan run not found");
  if (run.status !== "running") throw scanRunError("SCAN_RUN_NOT_RUNNING", "scan run is not running");
  return run;
}

function validateScanRunBatch(db, run, batchId) {
  const batch = db.prepare("SELECT id, site, search_plan_id, status, filter_snapshot_json FROM batches WHERE id = ?").get(batchId);
  if (!batch) throw scanRunError("SCAN_BATCH_NOT_FOUND", "scan batch not found");
  if (String(batch.site || "").toLowerCase() !== run.site) {
    throw scanRunError("SCAN_RUN_BATCH_MISMATCH", "scan batch belongs to another site");
  }
  if (run.plan_id && Number(batch.search_plan_id || 0) !== Number(run.plan_id)) {
    throw scanRunError("SCAN_RUN_PLAN_MISMATCH", "scan batch belongs to another search plan");
  }
  return batch;
}

function markBatchRunning(db, batchId) {
  const result = db.prepare(`UPDATE batches
    SET status = 'running', finished_at = NULL, stop_code = NULL, stop_message = NULL
    WHERE id = ?`)
    .run(batchId);
  if (!Number(result.changes || 0)) throw scanRunError("SCAN_BATCH_NOT_FOUND", "scan batch not found");
}

function syncBatchTerminalState(db, batchId, status, finishedAt, stopCode, stopMessage) {
  const result = db.prepare(`UPDATE batches
    SET status = ?, finished_at = ?, stop_code = ?, stop_message = ?
    WHERE id = ?`)
    .run(status, finishedAt, stopCode, stopMessage, batchId);
  if (!Number(result.changes || 0)) throw scanRunError("SCAN_BATCH_NOT_FOUND", "scan batch not found");
}

function processExitStatus(db, run, exitCode, signal) {
  if (signal || exitCode === null) return "interrupted";
  if (exitCode !== 0) return "failed";
  if (!run.batch_id) return "completed";
  const summary = summarizeScanTargets(db, Number(run.batch_id));
  return summary.total ? summary.status : "completed";
}

function scanRunRow(row) {
  return {
    id: row.id,
    runId: row.id,
    site: row.site,
    command: row.command,
    planId: Number(row.plan_id || 0) || null,
    batchId: Number(row.batch_id || 0) || null,
    status: row.status,
    leaseOwner: row.lease_owner || "",
    processId: Number(row.process_id || 0) || null,
    createdAt: row.created_at,
    startedAt: row.started_at || null,
    heartbeatAt: row.heartbeat_at || null,
    finishedAt: row.finished_at || null,
    stopCode: row.stop_code || "",
    stopMessage: row.stop_message || "",
    processExitCode: row.process_exit_code === null ? null : Number(row.process_exit_code),
    processSignal: row.process_signal || ""
  };
}

function rollback(db) {
  try { db.exec("ROLLBACK"); } catch { /* no-op */ }
}

function getSiteRuntimeState(db, site) {
  const row = db.prepare("SELECT * FROM site_runtime_states WHERE site = ?").get(String(site || "").trim().toLowerCase());
  return row ? {
    site: row.site,
    status: row.status,
    reasonCode: row.reason_code || "",
    message: row.message || "",
    details: parseJson(row.details_json, {}),
    updatedAt: row.updated_at
  } : null;
}

function setSiteRuntimeState(db, site, input = {}) {
  const normalizedSite = String(site || "").trim().toLowerCase();
  if (!normalizedSite) throw new Error("site runtime state requires a site");
  db.prepare(`
    INSERT INTO site_runtime_states(site, status, reason_code, message, details_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(site) DO UPDATE SET status=excluded.status, reason_code=excluded.reason_code,
      message=excluded.message, details_json=excluded.details_json, updated_at=excluded.updated_at
  `).run(
    normalizedSite,
    String(input.status || "ready"),
    String(input.reasonCode || "") || null,
    String(input.message || "").slice(0, 1000) || null,
    JSON.stringify(input.details || {}),
    nowIso()
  );
  return getSiteRuntimeState(db, normalizedSite);
}

function clearSiteRuntimeState(db, site) {
  db.prepare("DELETE FROM site_runtime_states WHERE site = ?").run(String(site || "").trim().toLowerCase());
}

function acquireSiteScanLease(db, { site = "boss", owner = crypto.randomUUID(), command = "scan", planId = null, ttlMs = PRODUCT_POLICY.operations.scanLeaseTtlMs } = {}) {
  const normalizedSite = String(site || "").trim().toLowerCase();
  const normalizedOwner = String(owner || "").trim();
  if (!normalizedSite || !normalizedOwner) throw new Error("scan lease site and owner are required");
  const now = new Date();
  const acquiredAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + Math.max(PRODUCT_POLICY.operations.scanLeaseMinTtlMs, Number(ttlMs) || 0)).toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM site_scan_leases WHERE expires_at <= ?").run(acquiredAt);
    const active = db.prepare("SELECT * FROM site_scan_leases WHERE site = ?").get(normalizedSite);
    if (active) {
      const error = new Error(`${normalizedSite} 已有扫描任务运行中（${active.command}，开始于 ${active.acquired_at}）。`);
      error.code = "SCAN_ALREADY_RUNNING";
      error.lease = mapSiteScanLease(active);
      throw error;
    }
    db.prepare(`INSERT INTO site_scan_leases(site, owner, command, plan_id, acquired_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(normalizedSite, normalizedOwner, String(command || "scan"), Number(planId || 0) || null, acquiredAt, expiresAt);
    db.exec("COMMIT");
    return getSiteScanLease(db, normalizedSite);
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* no-op */ }
    throw error;
  }
}

function renewSiteScanLease(db, { site = "boss", owner, ttlMs = PRODUCT_POLICY.operations.scanLeaseTtlMs } = {}) {
  const expiresAt = new Date(Date.now() + Math.max(PRODUCT_POLICY.operations.scanLeaseMinTtlMs, Number(ttlMs) || 0)).toISOString();
  const result = db.prepare("UPDATE site_scan_leases SET expires_at = ? WHERE site = ? AND owner = ?")
    .run(expiresAt, String(site || "").trim().toLowerCase(), String(owner || ""));
  if (!Number(result.changes || 0)) {
    const error = new Error("扫描互斥租约已丢失，不能继续保证单实例运行。");
    error.code = "SCAN_LEASE_LOST";
    throw error;
  }
  return expiresAt;
}

function releaseSiteScanLease(db, { site = "boss", owner } = {}) {
  const result = db.prepare("DELETE FROM site_scan_leases WHERE site = ? AND owner = ?")
    .run(String(site || "").trim().toLowerCase(), String(owner || ""));
  return Number(result.changes || 0) > 0;
}

function getSiteScanLease(db, site = "boss") {
  const normalizedSite = String(site || "").trim().toLowerCase();
  const row = db.prepare("SELECT * FROM site_scan_leases WHERE site = ?").get(normalizedSite);
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) {
    db.prepare("DELETE FROM site_scan_leases WHERE site = ? AND owner = ?").run(normalizedSite, row.owner);
    return null;
  }
  return mapSiteScanLease(row);
}

function mapSiteScanLease(row) {
  return {
    site: row.site,
    owner: row.owner,
    command: row.command,
    planId: Number(row.plan_id || 0) || null,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at
  };
}

function listReusableJobDetails(db, { site = "boss", profileId = 0, maxAgeDays = 7 } = {}) {
  const parsedDays = Number(maxAgeDays);
  const days = Number.isFinite(parsedDays) ? Math.max(1, Math.min(30, parsedDays)) : 7;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const normalizedProfileId = Number(profileId || 0);
  const rows = db.prepare(`
    WITH reusable AS (
      SELECT jobs.source_id, o.title, o.company, o.location, o.salary, o.experience, o.education, o.boss_active_text,
        o.description, o.seen_at,
        ROW_NUMBER() OVER (PARTITION BY jobs.source_id ORDER BY o.seen_at DESC, o.id DESC) AS detail_rank
      FROM job_observations o
      JOIN jobs ON jobs.id = o.job_id
      JOIN batches b ON b.id = o.batch_id
      WHERE jobs.source = ?
        AND LENGTH(TRIM(COALESCE(o.description, ''))) >= 120
        AND o.seen_at >= ?
        AND (? <= 0 OR b.profile_id = ?)
    )
    SELECT * FROM reusable WHERE detail_rank = 1
  `).all(String(site || "boss"), cutoff, normalizedProfileId, normalizedProfileId);

  return rows.map((row) => ({
    sourceId: row.source_id,
    title: row.title || "",
    company: row.company || "",
    location: row.location || "",
    salary: row.salary || "",
    experience: row.experience || "",
    education: row.education || "",
    bossActiveText: Date.parse(row.seen_at) >= Date.now() - 3 * 24 * 60 * 60 * 1000 ? (row.boss_active_text || "") : "",
    description: row.description || "",
    seenAt: row.seen_at
  }));
}

function recordJobRefreshAttempt(db, input = {}) {
  const jobId = Number(input.jobId || 0);
  if (!Number.isInteger(jobId) || jobId <= 0) throw new Error("refresh attempt jobId is required");
  const exists = db.prepare("SELECT id FROM jobs WHERE id = ?").get(jobId);
  if (!exists) throw new Error("refresh attempt job not found");
  const attemptNumber = Number(db.prepare("SELECT COALESCE(MAX(attempt_number), 0) + 1 AS n FROM job_refresh_attempts WHERE job_id = ?").get(jobId)?.n || 1);
  db.prepare(`INSERT INTO job_refresh_attempts(
    job_id, result, error_code, error_message, attempt_number, next_retry_at, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(
      jobId,
      String(input.result || "failed"),
      String(input.errorCode || "") || null,
      String(input.errorMessage || "").slice(0, 1000) || null,
      attemptNumber,
      String(input.nextRetryAt || "") || null,
      String(input.createdAt || nowIso())
    );
  return attemptNumber;
}

function listJobRefreshAttempts(db, jobId, { limit = 20 } = {}) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  return db.prepare("SELECT * FROM job_refresh_attempts WHERE job_id = ? ORDER BY id DESC LIMIT ?").all(Number(jobId), safeLimit).map((row) => ({
    id: Number(row.id),
    jobId: Number(row.job_id),
    result: row.result,
    errorCode: row.error_code || "",
    errorMessage: row.error_message || "",
    attemptNumber: Number(row.attempt_number),
    nextRetryAt: row.next_retry_at || "",
    createdAt: row.created_at
  }));
}

function getLatestJobRefreshAttempt(db, jobId) {
  return listJobRefreshAttempts(db, jobId, { limit: 1 })[0] || null;
}

function getPlatformFilterCatalog(db, site) {
  const row = db.prepare("SELECT * FROM platform_filter_catalogs WHERE site = ?").get(String(site || "").trim());
  if (!row) return null;
  return {
    site: row.site,
    catalog: parseJson(row.catalog_json, {}),
    source: row.source || "",
    discoveredAt: row.discovered_at || "",
    updatedAt: row.updated_at || ""
  };
}

function savePlatformFilterCatalog(db, { site, catalog, source = "live_dom", discoveredAt = nowIso() } = {}) {
  const normalizedSite = String(site || "").trim();
  if (!normalizedSite) throw new Error("platform filter catalog site is required");
  const now = nowIso();
  db.prepare(`INSERT INTO platform_filter_catalogs(site, catalog_json, source, discovered_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(site) DO UPDATE SET catalog_json=excluded.catalog_json, source=excluded.source,
      discovered_at=excluded.discovered_at, updated_at=excluded.updated_at`
  ).run(normalizedSite, JSON.stringify(catalog || {}), String(source || "live_dom"), String(discoveredAt || now), now);
  return getPlatformFilterCatalog(db, normalizedSite);
}


module.exports = {
  SCAN_RUN_STATUSES,
  getSitePacingState,
  setSitePacingState,
  mergeBossPacingStates,
  normalizeBossPacing,
  createBatch,
  createAndBindScanBatch,
  getBatch,
  getLatestResumableBatch,
  createScanRun,
  getScanRun,
  getLatestScanRun,
  beginScanRun,
  claimScanRun,
  heartbeatScanRun,
  finishScanRun,
  recordScanRunProcessExit,
  interruptOrphanedScanRuns,
  checkpointScanProgress,
  checkpointScanTarget,
  recordScanTargetResult,
  listScanTargetResults,
  listLatestScanTargetResults,
  summarizeScanTargets,
  getSiteRuntimeState,
  setSiteRuntimeState,
  clearSiteRuntimeState,
  recordSiteAccessEvent,
  listSiteAccessEvents,
  acquireSiteScanLease,
  renewSiteScanLease,
  releaseSiteScanLease,
  getSiteScanLease,
  listReusableJobDetails,
  recordJobRefreshAttempt,
  listJobRefreshAttempts,
  getLatestJobRefreshAttempt,
  getPlatformFilterCatalog,
  savePlatformFilterCatalog,
};
