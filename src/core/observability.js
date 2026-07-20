const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_LOG_DAYS = 21;
const MAX_VALUE_LENGTH = 1600;
const SECRET_KEY = /(?:api[_-]?key|authorization|cookie|token|password|secret|resume(?:text)?|description|content|body|buffer|(?:original)?file(?:name|path))/i;
const SAFE_METRIC_KEY = /^(?:prompt|completion|total)_tokens$/i;

function createLogger({ root, component = "app", context = {} } = {}) {
  const state = {
    logDir: path.join(root || process.cwd(), ".runtime", "logs"),
    component,
    sessionId: crypto.randomUUID().slice(0, 8),
    sequence: 0
  };
  ensureLogDir(state.logDir);
  pruneLogs(state.logDir);
  return createScopedLogger(state, context);
}

function createScopedLogger(state, context = {}) {
  const loggerContext = mergeDefined({}, context);

  function write(level, event, eventContext = {}) {
    const entry = {
      time: new Date().toISOString(),
      level,
      event,
      component: state.component,
      sessionId: state.sessionId,
      ...sanitize(mergeDefined(loggerContext, eventContext))
    };
    try {
      fs.appendFileSync(resolveLogFile(state.logDir), `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      // ponytail: logging must never make the user-facing workflow fail.
    }
    return entry;
  }

  return {
    info: (event, context) => write("info", event, context),
    warn: (event, context) => write("warn", event, context),
    error: (event, context) => write("error", event, context),
    child: (context) => createScopedLogger(state, mergeDefined(loggerContext, context)),
    requestId: () => `${state.sessionId}-${++state.sequence}`,
    listRecent: (limit = 120) => listRecentLogs(state.logDir, limit),
    logDir: state.logDir
  };
}

function mergeDefined(base, override) {
  return {
    ...base,
    ...Object.fromEntries(Object.entries(override || {}).filter(([, value]) => value !== undefined))
  };
}

function appError(code, message, { statusCode = 400, cause = null, details = null } = {}) {
  const error = new Error(message);
  error.name = "AppError";
  error.code = code;
  error.statusCode = statusCode;
  if (cause) error.cause = cause;
  if (details) error.details = details;
  return error;
}

function errorMeta(error) {
  return sanitize({
    name: error?.name || "Error",
    code: error?.code || "UNEXPECTED_ERROR",
    message: error?.message || String(error || ""),
    statusCode: error?.statusCode || null,
    stack: error?.stack || "",
    details: error?.details || null,
    cause: error?.cause ? { name: error.cause.name, message: error.cause.message } : null
  });
}

function publicError(error, { fallbackCode = "REQUEST_FAILED", fallbackMessage = "操作未完成，请根据错误编号查看诊断日志。", statusCode = 400 } = {}) {
  const code = String(error?.code || fallbackCode).replace(/[^A-Z0-9_]/gi, "_").toUpperCase();
  const resultStatus = Number(error?.statusCode || statusCode);
  const safeStatus = resultStatus >= 400 && resultStatus < 600 ? resultStatus : statusCode;
  const message = safeStatus < 500 && error?.message ? error.message : fallbackMessage;
  return { code, message, statusCode: safeStatus };
}

function listRecentLogs(logDir, limit = 120) {
  if (!fs.existsSync(logDir)) return [];
  const count = Math.max(1, Math.min(500, Number(limit) || 120));
  const files = fs.readdirSync(logDir)
    .filter((name) => /^app-\d{4}-\d{2}-\d{2}(?:-\d+)?\.jsonl$/.test(name))
    .sort()
    .reverse();
  const rows = [];
  for (const file of files) {
    const lines = fs.readFileSync(path.join(logDir, file), "utf8").trim().split(/\r?\n/).reverse();
    for (const line of lines) {
      try { rows.push(JSON.parse(line)); } catch { /* ignore a partial final write */ }
      if (rows.length >= count) return rows;
    }
  }
  return rows;
}

function ensureLogDir(logDir) {
  fs.mkdirSync(logDir, { recursive: true });
}

function resolveLogFile(logDir) {
  const date = new Date().toISOString().slice(0, 10);
  for (let index = 0; index < 100; index += 1) {
    const suffix = index ? `-${index}` : "";
    const file = path.join(logDir, `app-${date}${suffix}.jsonl`);
    if (!fs.existsSync(file) || fs.statSync(file).size < MAX_LOG_BYTES) return file;
  }
  return path.join(logDir, `app-${date}-overflow.jsonl`);
}

function pruneLogs(logDir) {
  const oldest = Date.now() - MAX_LOG_DAYS * 24 * 60 * 60 * 1000;
  for (const file of fs.readdirSync(logDir)) {
    const fullPath = path.join(logDir, file);
    try {
      if (fs.statSync(fullPath).isFile() && fs.statSync(fullPath).mtimeMs < oldest) fs.rmSync(fullPath, { force: true });
    } catch { /* ignore transient file-system errors */ }
  }
}

function sanitize(value, key = "", depth = 0) {
  if (SECRET_KEY.test(key) && !SAFE_METRIC_KEY.test(key)) return "[REDACTED]";
  if (value instanceof Error) return errorMeta(value);
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return redactText(value).slice(0, MAX_VALUE_LENGTH);
  if (depth >= 4) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitize(item, "", depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 50).map(([name, item]) => [name, sanitize(item, name, depth + 1)]));
  }
  return String(value);
}

function redactText(value) {
  return String(value)
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]");
}

function workflowLogContext(value = {}) {
  const workflow = value.workflow || value;
  return {
    workflowRunId: textId(workflow.workflowRunId || workflow.id),
    scanRunId: textId(workflow.scanRunId),
    scanBatchId: numericId(workflow.scanBatchId),
    communicationBatchId: numericId(workflow.communicationBatchId)
  };
}

function textId(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function numericId(value) {
  const normalized = Number(value || 0);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}

module.exports = { createLogger, appError, errorMeta, publicError, listRecentLogs, workflowLogContext };
