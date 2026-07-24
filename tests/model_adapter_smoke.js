const assert = require("assert");
const http = require("http");
const { OpenAICompatibleAdapter, parseJsonContent } = require("../src/adapters/models/openai_compatible");
const { PRODUCT_POLICY } = require("../src/core/product_policy");

let requests = 0;
const payloads = [];
const server = http.createServer(async (req, res) => {
  requests += 1;
  const body = await readBody(req);
  const payload = JSON.parse(body || "{}");
  payloads.push(payload);
  res.setHeader("content-type", "application/json");
  res.setHeader("x-request-id", `provider-request-${requests}`);
  if (requests === 1 && payload.response_format) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: { message: "response_format unsupported" } }));
    return;
  }
  if (requests === 3) {
    res.statusCode = 503;
    res.end(JSON.stringify({ error: { message: "temporary upstream error" } }));
    return;
  }
  const content = requests === 2 ? [{ type: "text", text: "```json\n{\"ok\":true}\n```" }] : "{\"retried\":true}";
  res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } }));
});

server.listen(0, "127.0.0.1", async () => {
  process.env.ZHIPPING_TEST_MODEL_KEY = "test-key";
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const metrics = [];
  const logger = { info: (event, data) => metrics.push({ level: "info", event, data }), warn: (event, data) => metrics.push({ level: "warn", event, data }) };
  try {
    assert.deepStrictEqual(PRODUCT_POLICY.operations.modelAnalysis, {
      scanConcurrency: 3,
      retryConcurrency: 2,
      maxRetryJobs: 50
    });
    const fallbackAdapter = new OpenAICompatibleAdapter({ baseUrl, apiKeyEnv: "ZHIPPING_TEST_MODEL_KEY", model: "test", maxRetries: 0, logger });
    assert.strictEqual(fallbackAdapter.timeoutMs, 60000);
    assert.deepStrictEqual(await fallbackAdapter.chatJson("return json", { test: true }, { kind: "understandJob" }), { ok: true });
    assert.strictEqual(requests, 2);
    assert.strictEqual(payloads[1].temperature, 0.1);
    assert.strictEqual(payloads[1].max_tokens, 4096);

    const retryAdapter = new OpenAICompatibleAdapter({ baseUrl, apiKeyEnv: "ZHIPPING_TEST_MODEL_KEY", model: "test", jsonMode: false, maxRetries: 1, logger });
    assert.deepStrictEqual(await retryAdapter.chatJson("return json", { test: true }, { kind: "matchJob" }), { retried: true });
    assert.strictEqual(requests, 4);
    assert.deepStrictEqual(parseJsonContent("prefix {\"value\":1} suffix"), { value: 1 });
    assert.strictEqual(metrics[0].event, "model_call_completed");
    assert.strictEqual(metrics[0].data.kind, "understandJob");
    assert.strictEqual(metrics[0].data.attempts, 2);
    assert.strictEqual(metrics[0].data.jsonModeFallback, true);
    assert.strictEqual(metrics[0].data.usage.total_tokens, 14);
    assert.strictEqual(metrics[0].data.providerRequestId, "provider-request-2");
    assert.strictEqual(metrics[1].data.kind, "matchJob");
    assert.strictEqual(metrics[1].data.attempts, 2);
    assert.strictEqual(metrics[1].data.providerRequestId, "provider-request-4");
    await retryAdapter.matchJob({ candidateProfile: {}, candidateMatchCard: { targetDirections: ["电商运营"] }, jobUnderstanding: {}, jobEvidence: {} });
    const matchPrompt = payloads.at(-1).messages[0].content;
    assert(matchPrompt.includes("requirementMatches"));
    assert(matchPrompt.includes("为 jobUnderstanding.coreRequirements 的每一项输出一条 requirementMatches"), "matchJob prompt 必须要求逐项覆盖核心要求");
    assert(matchPrompt.includes("candidateMatchCard"));
    assert(matchPrompt.includes("indispensable_core"));
    assert(matchPrompt.includes('"hardBlockers":[]'));
    assert(matchPrompt.includes("searchPreferences"));
    assert(matchPrompt.includes("userNotes"), "matchJob prompt 必须说明用户补充偏好的语义");
    assert(matchPrompt.includes("优先级高于模型"), "matchJob prompt 必须说明用户补充偏好优先于模型归纳方向");
    assert(matchPrompt.includes("不得作为 resumeEvidence"), "matchJob prompt 必须禁止把用户备注当成简历证据");
    assert(!matchPrompt.includes("Python/Java"), "matchJob prompt 不得保留固定技术栈规则");
    assert(!matchPrompt.includes("二选一"), "matchJob prompt 不得保留固定技术栈规则");
    await retryAdapter.understandJob({ job: { sourceId: "prompt-check", description: "示例 JD" } });
    const understandPrompt = payloads.at(-1).messages[0].content;
    assert(understandPrompt.includes("coreResponsibilities"));
    assert(understandPrompt.includes("coreRequirements[{label,indispensable,evidence}]"), "understandJob prompt 必须要求结构化核心要求对象");
    assert(understandPrompt.includes("jobQuality.level 只能是 normal、caution 或 risk"), "understandJob prompt 必须限定岗位质量枚举");
    assert(understandPrompt.includes("responsibility_sprawl"));
    assert(!understandPrompt.includes("Go/C++"), "understandJob prompt 不得保留固定职业分类");
    console.log("model_adapter_smoke ok");
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  } finally {
    delete process.env.ZHIPPING_TEST_MODEL_KEY;
    server.close();
  }
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let value = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { value += chunk; });
    req.on("end", () => resolve(value));
    req.on("error", reject);
  });
}
