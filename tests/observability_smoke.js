const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createLogger, appError, publicError } = require("../src/core/observability");

const root = path.join(__dirname, "..", ".runtime", `observability-smoke-${Date.now()}`);
try {
  const logger = createLogger({ root, component: "test" });
  const requestId = logger.requestId();
  logger.info("request_started", { requestId, apiKey: "sk-should-not-appear", resumeText: "private resume content", authorization: "Bearer secret-value", normal: "ok" });
  logger.error("request_failed", { requestId, error: appError("RESUME_TEXT_TOO_SHORT", "too short", { details: { charCount: 9 } }) });
  const rows = logger.listRecent(10);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[1].apiKey, "[REDACTED]");
  assert.strictEqual(rows[1].resumeText, "[REDACTED]");
  assert.strictEqual(rows[1].authorization, "[REDACTED]");
  assert.strictEqual(rows[0].error.code, "RESUME_TEXT_TOO_SHORT");
  const publicFailure = publicError(appError("RESUME_TEXT_TOO_SHORT", "too short"));
  assert.deepStrictEqual(publicFailure, { code: "RESUME_TEXT_TOO_SHORT", message: "too short", statusCode: 400 });
  console.log("observability_smoke ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
