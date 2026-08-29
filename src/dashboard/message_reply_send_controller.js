const { randomUUID } = require("node:crypto");
const { createBossMessageReader } = require("../adapters/sites/boss_message_reader");
const { createBossMessageReplySender } = require("../adapters/sites/boss_message_reply_sender");
const { createMessageReplySendingService } = require("../application/message_reply_sending");
const { runMessageReplySendBatch } = require("../core/message_reply_send_executor");
const { createSiteAccessController } = require("../core/site_access_budget");
const {
  acquireSiteScanLease,
  getSiteScanLease,
  renewSiteScanLease,
  releaseSiteScanLease
} = require("../core/storage");

function createMessageReplySendController({
  db,
  browserFactory,
  learningService,
  logger = null,
  now = () => new Date(),
  cleanupBrowser = defaultCleanupBrowser,
  createReader = ({ browser }) => createBossMessageReader({ browser }),
  createSender = ({ browser, reader }) => createBossMessageReplySender({ browser, reader }),
  createAccessController = (options) => createSiteAccessController(options),
  runBatch = runMessageReplySendBatch,
  acquireLease = acquireSiteScanLease,
  renewLease = renewSiteScanLease,
  releaseLease = releaseSiteScanLease,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  leaseHeartbeatMs = 30_000
} = {}) {
  if (!db) throw new TypeError("message reply send controller requires db");
  if (typeof browserFactory !== "function") throw new TypeError("message reply send controller requires browserFactory");
  if (!learningService || typeof learningService.completeDraft !== "function") {
    throw new TypeError("message reply send controller requires learningService.completeDraft");
  }
  let closing = false;
  let closePromise = null;
  const activeByProfile = new Map();
  const scheduledByProfile = new Map();
  const service = createMessageReplySendingService({
    db,
    learningService,
    now,
    executeBatch: startExecution,
    onExecutionError(error, batchId) {
      logger?.warn("message_reply_send_execution_failed", {
        batchId,
        errorCode: safeCode(error)
      });
    }
  });

  return { confirm, status, stop, close };

  function confirm(input = {}) {
    if (closing) throw controllerError("MESSAGE_REPLY_SEND_CONTROLLER_CLOSING", "message reply send controller is closing");
    const profileId = positiveInteger(input.profileId, "profileId");
    const active = db.prepare(`SELECT id FROM message_reply_send_batches
      WHERE profile_id = ? AND status IN ('confirmed','running')
      ORDER BY id DESC LIMIT 1`).get(profileId);
    if (active || activeByProfile.has(profileId)) {
      throw controllerError("MESSAGE_REPLY_SEND_PROFILE_BUSY", "this profile already has an active reply send batch");
    }
    if (getSiteScanLease(db, "boss")) {
      throw controllerError("MESSAGE_REPLY_SEND_LEASE_BUSY", "BOSS is already in use by another task");
    }
    const result = service.confirmBatch({ profileId, items: input.items });
    scheduledByProfile.set(profileId, result.batch.id);
    return service.status({ profileId, batchId: result.batch.id });
  }

  function status(input = {}) {
    return service.status({
      profileId: positiveInteger(input.profileId, "profileId"),
      batchId: positiveInteger(input.batchId, "batchId")
    });
  }

  function stop(input = {}) {
    const profileId = positiveInteger(input.profileId, "profileId");
    const batchId = positiveInteger(input.batchId, "batchId");
    const result = service.stop({ profileId, batchId });
    const active = activeByProfile.get(profileId);
    if (active?.batchId === batchId && !active.abortController.signal.aborted) {
      active.abortController.abort(controllerError("MESSAGE_REPLY_SEND_STOPPED", "message reply send was stopped"));
    }
    return result;
  }

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    for (const [profileId, batchId] of scheduledByProfile) {
      try { service.stop({ profileId, batchId }); } catch {}
    }
    scheduledByProfile.clear();
    const active = [...activeByProfile.values()];
    for (const run of active) {
      if (!run.abortController.signal.aborted) {
        run.abortController.abort(controllerError("MESSAGE_REPLY_SEND_SERVER_CLOSING", "message reply send server is closing"));
      }
    }
    closePromise = Promise.allSettled(active.map((run) => run.completion)).then(() => undefined);
    return closePromise;
  }

  function startExecution(batchIdValue) {
    const batchId = positiveInteger(batchIdValue, "batchId");
    const row = db.prepare("SELECT profile_id, status FROM message_reply_send_batches WHERE id = ?").get(batchId);
    if (!row) throw controllerError("MESSAGE_REPLY_SEND_BATCH_NOT_FOUND", "message reply send batch was not found");
    const profileId = Number(row.profile_id);
    if (scheduledByProfile.get(profileId) === batchId) scheduledByProfile.delete(profileId);
    if (row.status !== "confirmed") return Promise.resolve(status({ profileId, batchId }));
    if (closing) {
      service.stop({ profileId, batchId });
      throw controllerError("MESSAGE_REPLY_SEND_CONTROLLER_CLOSING", "message reply send controller is closing");
    }
    if (activeByProfile.has(profileId)) {
      service.stop({ profileId, batchId });
      throw controllerError("MESSAGE_REPLY_SEND_PROFILE_BUSY", "this profile already has an active reply send batch");
    }
    const abortController = new AbortController();
    const owner = randomUUID();
    const run = { profileId, batchId, abortController, owner, completion: null };
    activeByProfile.set(profileId, run);
    let browser = null;
    let leaseAcquired = false;
    let heartbeat = null;
    run.completion = Promise.resolve().then(async () => {
      acquireLease(db, { site: "boss", owner, command: "message-reply-send", planId: null });
      leaseAcquired = true;
      heartbeat = setIntervalFn(() => {
        try {
          renewLease(db, { site: "boss", owner });
        } catch {
          abortController.abort(controllerError("MESSAGE_REPLY_SEND_LEASE_LOST", "message reply send control was lost"));
        }
      }, Math.max(1000, Number(leaseHeartbeatMs) || 30_000));
      browser = await browserFactory();
      const reader = createReader({ browser });
      const sender = createSender({ browser, reader });
      const accessController = createAccessController({
        db,
        site: "boss",
        runId: `message-reply-send:${batchId}:${randomUUID()}`,
        logger,
        signal: abortController.signal
      });
      return runBatch({
        db,
        batchId,
        sender,
        accessController,
        onVerifiedSuccess: ({ batchId: verifiedBatchId, itemId }) => service.completeVerifiedItem({
          batchId: verifiedBatchId,
          itemId
        }),
        signal: abortController.signal,
        logger
      });
    }).catch((error) => {
      try {
        const current = service.status({ profileId, batchId });
        if (["confirmed", "running"].includes(current.batch.status)) service.stop({ profileId, batchId });
      } catch {}
      throw error;
    }).finally(async () => {
      if (heartbeat !== null) clearIntervalFn(heartbeat);
      try {
        await cleanupBrowser(browser);
      } catch (error) {
        logger?.warn("message_reply_send_browser_cleanup_failed", {
          batchId,
          errorCode: safeCode(error)
        });
      }
      if (leaseAcquired) {
        try {
          releaseLease(db, { site: "boss", owner });
        } catch (error) {
          logger?.warn("message_reply_send_lease_release_failed", {
            batchId,
            errorCode: safeCode(error)
          });
        }
      }
      if (activeByProfile.get(profileId) === run) activeByProfile.delete(profileId);
    });
    return run.completion;
  }
}

async function defaultCleanupBrowser(browser) {
  if (browser && typeof browser.disconnect === "function") await browser.disconnect();
  else if (browser && typeof browser.cleanup === "function") await browser.cleanup();
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`${label} must be a positive integer`);
  return number;
}

function safeCode(error) {
  const code = String(error?.code || "MESSAGE_REPLY_SEND_FAILED");
  return /^[A-Z0-9_]{1,100}$/.test(code) ? code : "MESSAGE_REPLY_SEND_FAILED";
}

function controllerError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = {
  createMessageReplySendController
};
