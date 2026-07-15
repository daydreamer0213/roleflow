const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createLogger, appError, publicError } = require("../src/core/observability");

const root = path.join(__dirname, "..", ".runtime", `observability-smoke-${Date.now()}`);
try {
  const logger = createLogger({ root, component: "test" });
  const requestId = logger.requestId();
  logger.info("request_started", { requestId, apiKey: "sk-should-not-appear", resumeText: "private resume content", authorization: "Bearer secret-value", fileName: "candidate-private-name.pdf", originalFileName: "candidate-original-name.docx", normal: "ok" });
  logger.info("model_call_completed", {
    kind: "matchJob",
    provider: "test",
    model: "test-model",
    cacheHit: false,
    latencyMs: 123,
    attempts: 1,
    httpStatus: 200,
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    description: "private jd marker",
    content: "private model output marker"
  });
  logger.error("request_failed", { requestId, error: appError("RESUME_TEXT_TOO_SHORT", "too short", { details: { charCount: 9 } }) });
  const rows = logger.listRecent(10);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[2].apiKey, "[REDACTED]");
  assert.strictEqual(rows[2].resumeText, "[REDACTED]");
  assert.strictEqual(rows[2].authorization, "[REDACTED]");
  assert.strictEqual(rows[2].fileName, "[REDACTED]");
  assert.strictEqual(rows[2].originalFileName, "[REDACTED]");
  assert.strictEqual(rows[1].event, "model_call_completed");
  assert.strictEqual(rows[1].latencyMs, 123);
  assert.strictEqual(rows[1].usage.total_tokens, 15);
  assert.strictEqual(rows[1].description, "[REDACTED]");
  assert.strictEqual(rows[1].content, "[REDACTED]");
  assert.strictEqual(rows[0].error.code, "RESUME_TEXT_TOO_SHORT");
  const rawLogs = fs.readdirSync(logger.logDir).map((file) => fs.readFileSync(path.join(logger.logDir, file), "utf8")).join("\n");
  for (const secret of ["sk-should-not-appear", "private resume content", "secret-value", "candidate-private-name.pdf", "candidate-original-name.docx", "private jd marker", "private model output marker"]) {
    assert(!rawLogs.includes(secret), `日志泄露敏感内容：${secret}`);
  }
  const publicFailure = publicError(appError("RESUME_TEXT_TOO_SHORT", "too short"));
  assert.deepStrictEqual(publicFailure, { code: "RESUME_TEXT_TOO_SHORT", message: "too short", statusCode: 400 });
  console.log("observability_smoke ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
