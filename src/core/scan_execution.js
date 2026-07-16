const SCAN_COMMANDS = Object.freeze({
  daily: "scan",
  broad: "scan",
  refresh: "refresh-details",
  activity: "refresh-activity"
});

function resolveScanKind(command, args = {}) {
  const normalizedCommand = String(command || "").trim().toLowerCase();
  if (normalizedCommand === "refresh-details") return "refresh";
  if (normalizedCommand === "refresh-activity") return "activity";
  if (normalizedCommand !== "scan") throw unknownScanKind(normalizedCommand || command);

  const input = args || {};
  const kind = String(input["scan-mode"] || input.scanMode || "daily").trim().toLowerCase();
  if (kind === "daily" || kind === "broad") return kind;
  throw unknownScanKind(kind);
}

function buildScanCliArgs({ kind, dbPath, planId, browserMode, cdpPort, runId } = {}) {
  const normalizedKind = normalizeScanKind(kind);
  const normalizedDbPath = requiredText(dbPath, "dbPath");
  const normalizedRunId = requiredText(runId, "runId");
  const normalizedPlanId = Number(planId);
  if (!Number.isInteger(normalizedPlanId) || normalizedPlanId <= 0) {
    throw scanExecutionError("INVALID_SCAN_INPUT", "planId must be a positive integer");
  }

  const normalizedBrowser = String(browserMode || "").trim().toLowerCase();
  if (normalizedBrowser !== "edge" && normalizedBrowser !== "portable") {
    throw scanExecutionError("UNKNOWN_BROWSER_MODE", `Unknown browser mode: ${browserMode}`);
  }

  const cliArgs = [
    SCAN_COMMANDS[normalizedKind],
    "--db", normalizedDbPath,
    "--plan", String(normalizedPlanId),
    "--run-id", normalizedRunId
  ];
  if (normalizedKind === "daily" || normalizedKind === "broad") {
    cliArgs.push("--site", "boss", "--scan-mode", normalizedKind);
  }
  cliArgs.push("--browser", normalizedBrowser);
  if (normalizedBrowser === "portable") {
    const normalizedPort = Number(cdpPort);
    if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) {
      throw scanExecutionError("INVALID_SCAN_INPUT", "cdpPort must be an integer between 1 and 65535");
    }
    cliArgs.push("--cdp-port", String(normalizedPort));
  }
  return cliArgs;
}

async function withSiteScanLease(deps, input, run) {
  const acquire = requiredFunction(deps?.acquire, "deps.acquire");
  const renew = requiredFunction(deps?.renew, "deps.renew");
  const release = requiredFunction(deps?.release, "deps.release");
  const schedule = deps?.setInterval || setInterval;
  const cancel = deps?.clearInterval || clearInterval;
  requiredFunction(schedule, "deps.setInterval");
  requiredFunction(cancel, "deps.clearInterval");
  requiredFunction(run, "run");

  const {
    site = "boss",
    owner: requestedOwnerValue,
    command = "scan",
    planId = null,
    ttlMs,
    renewIntervalMs = 60_000
  } = input || {};
  const requestedOwner = String(requestedOwnerValue || "").trim();
  const leaseInput = { site, owner: requestedOwnerValue, command, planId };
  if (ttlMs !== undefined) leaseInput.ttlMs = ttlMs;

  const lease = await acquire(leaseInput);
  const owner = String(lease?.owner || requestedOwner).trim();
  const leaseSite = String(lease?.site || site || "boss").trim().toLowerCase();
  if (!owner) throw scanExecutionError("SCAN_LEASE_OWNER_REQUIRED", "Acquired scan lease has no owner");
  if (requestedOwner && owner !== requestedOwner) {
    throw leaseLostError(new Error(`Acquired lease owner changed from ${requestedOwner} to ${owner}`));
  }

  const controller = new AbortController();
  let closed = false;
  let renewing = false;
  let lostError = null;
  let rejectLeaseLost;
  const leaseLost = new Promise((resolve, reject) => {
    rejectLeaseLost = reject;
  });
  const markLeaseLost = (cause) => {
    if (closed || lostError) return;
    lostError = leaseLostError(cause);
    controller.abort(lostError);
    rejectLeaseLost(lostError);
  };
  const renewLease = async () => {
    if (closed || renewing || lostError) return;
    renewing = true;
    try {
      const renewInput = { site: leaseSite, owner };
      if (ttlMs !== undefined) renewInput.ttlMs = ttlMs;
      const renewed = await renew(renewInput);
      const renewedOwner = renewed && typeof renewed === "object" && Object.hasOwn(renewed, "owner")
        ? String(renewed.owner || "").trim()
        : owner;
      if (renewed === false || renewed === null || renewedOwner !== owner) {
        markLeaseLost(new Error(`Scan lease renewal no longer belongs to ${owner}`));
      }
    } catch (error) {
      markLeaseLost(error);
    } finally {
      renewing = false;
    }
  };

  const intervalMs = Math.max(1, Number(renewIntervalMs) || 60_000);
  const heartbeat = schedule(renewLease, intervalMs);
  heartbeat?.unref?.();
  let executionError = null;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => run(controller.signal)),
      leaseLost
    ]);
    if (lostError) throw lostError;
    return result;
  } catch (error) {
    executionError = lostError || error;
    throw executionError;
  } finally {
    closed = true;
    cancel(heartbeat);
    try {
      await release({ site: leaseSite, owner });
    } catch (error) {
      if (!executionError) throw error;
    }
  }
}

function normalizeScanKind(kind) {
  const normalized = String(kind || "").trim().toLowerCase();
  if (Object.hasOwn(SCAN_COMMANDS, normalized)) return normalized;
  throw unknownScanKind(normalized || kind);
}

function requiredText(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw scanExecutionError("INVALID_SCAN_INPUT", `${name} is required`);
  return normalized;
}

function requiredFunction(value, name) {
  if (typeof value !== "function") {
    throw scanExecutionError("INVALID_SCAN_DEPENDENCY", `${name} must be a function`);
  }
  return value;
}

function unknownScanKind(kind) {
  return scanExecutionError("UNKNOWN_SCAN_KIND", `Unknown scan kind: ${kind || "(empty)"}`);
}

function leaseLostError(cause) {
  if (cause instanceof Error && cause.code === "SCAN_LEASE_LOST") return cause;
  const error = scanExecutionError("SCAN_LEASE_LOST", "Site scan lease was lost");
  if (cause !== undefined) error.cause = cause;
  return error;
}

function scanExecutionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  resolveScanKind,
  buildScanCliArgs,
  withSiteScanLease
};
