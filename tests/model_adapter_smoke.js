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
  if (payload.model === "error-message-test") {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: { message: "upstream body must never reach errors or observer logs" } }));
    return;
  }
  if (payload.model === "structured-failure-test") {
    const scenario = JSON.parse(payload.messages[1].content).scenario;
    const sentinel = "response sentinel must never reach errors or observer logs";
    if (scenario === "truncated") {
      res.end(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "{\"partial\":" } }] }));
      return;
    }
    if (scenario === "invalid-envelope") {
      res.end(sentinel);
      return;
    }
    if (scenario === "null-envelope") {
      res.end("null");
      return;
    }
    if (scenario === "missing-content") {
      res.end(JSON.stringify({ choices: [{ message: {} }] }));
      return;
    }
    if (scenario === "invalid-json") {
      res.end(JSON.stringify({ choices: [{ message: { content: sentinel } }] }));
      return;
    }
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
      scanConcurrency: 1,
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
    // 真实模型回归（live-v2-20260725-01）：即使 understandJob 误标 indispensable，年限类要求也不得生成 hardBlockers。
    assert(matchPrompt.includes("年限类要求") && matchPrompt.includes("不得生成 hardBlockers"), "matchJob prompt 必须禁止为年限类要求生成 hardBlockers");
    // 真实模型回归：简历未提供教育背景被当成学历资格不符；信息不足不等于明确冲突。
    assert(matchPrompt.includes("明确冲突"), "matchJob prompt 必须要求 eligibility 阻断具备明确冲突证据");
    assert(matchPrompt.includes("信息不足"), "matchJob prompt 必须区分信息不足与资格不符");
    assert(
      matchPrompt.includes("每个证据摘录（所有 evidence、jdEvidence、resumeEvidence）最多 120 个字符"),
      "matchJob prompt 必须限制每段证据摘录最多 120 字符"
    );
    assert(
      matchPrompt.includes("fitReasons、jobQuality.concerns、hardBlockers、softGaps、questionsToVerify、evidence.jd、evidence.resume 各最多 8 项")
        && matchPrompt.includes("primaryProjects 最多 4 项")
        && matchPrompt.includes("requirementMatches 不设独立数字上限")
        && matchPrompt.includes("每一项恰好输出一条"),
      "matchJob prompt 必须显式限制输出数组且完整覆盖核心要求"
    );
    assert(!matchPrompt.includes("Python/Java"), "matchJob prompt 不得保留固定技术栈规则");
    assert(!matchPrompt.includes("二选一"), "matchJob prompt 不得保留固定技术栈规则");
    await retryAdapter.understandJob({ job: { sourceId: "prompt-check", description: "示例 JD" } });
    const understandPrompt = payloads.at(-1).messages[0].content;
    assert(understandPrompt.includes("coreResponsibilities"));
    assert(understandPrompt.includes("coreRequirements[{label,indispensable,evidence}]"), "understandJob prompt 必须要求结构化核心要求对象");
    assert(understandPrompt.includes("jobQuality.level 只能是 normal、caution 或 risk"), "understandJob prompt 必须限定岗位质量枚举");
    assert(understandPrompt.includes("responsibility_sprawl"));
    // 真实模型回归：DeepSeek 倾向把 eligibilityConstraints 输出为对象数组，prompt 必须显式声明字符串数组形状。
    assert(understandPrompt.includes("eligibilityConstraints[非空字符串]"), "understandJob prompt 必须声明资格约束的字符串数组形状");
    assert(understandPrompt.includes("不要输出对象"), "understandJob prompt 必须禁止对象形式的资格约束");
    // 真实模型回归：经验年限被标 indispensable=true 后成为年限 hardBlockers；产品语义中年限只是偏好。
    assert(/年限[^\n]*不得[^\n]*indispensable=true|indispensable=true[^\n]*不得用于[^\n]*年限/.test(understandPrompt), "understandJob prompt 必须禁止把经验年限标为 indispensable=true");
    // v3 设计：措辞只是重要性信号，不能单独决定 indispensable；understandJob 必须有明确的单次契约修复指令。
    assert(
      understandPrompt.includes("若输入含 contractRepair")
        && understandPrompt.includes("contractRepair.invalidOutput")
        && understandPrompt.includes("contractRepair.reason")
        && understandPrompt.includes("返回修正后的完整 JSON"),
      "understandJob prompt 必须给出可执行的单次契约修复指令"
    );
    assert(
      understandPrompt.includes("措辞只是重要性信号")
        && understandPrompt.includes("岗位持续承担的核心工作")
        && understandPrompt.includes("不可替代"),
      "understandJob prompt 不得仅凭“要求/需要”措辞判 indispensable"
    );
    assert(
      understandPrompt.includes("需要理解业务")
        && understandPrompt.includes("不得仅凭该短语"),
      "普通业务理解要求不得自动升级为硬阻断"
    );
    assert(
      understandPrompt.includes("要求熟悉某平台")
        && understandPrompt.includes("优先")
        && understandPrompt.includes("不得自动"),
      "平台愿望项不得自动升级为硬阻断"
    );
    assert(
      understandPrompt.includes("每个证据摘录（所有 evidence 与 evidenceSnippets）最多 120 个字符"),
      "understandJob prompt 必须限制每段证据摘录最多 120 字符"
    );
    assert(
      understandPrompt.includes("coreResponsibilities 最多 12 项")
        && understandPrompt.includes("coreRequirements 和 preferredRequirements 各最多 16 项")
        && understandPrompt.includes("outcomeExpectations、eligibilityConstraints、hiddenRisks、jobQuality.concerns、evidenceSnippets 各最多 8 项"),
      "understandJob prompt 必须显式限制输出数组"
    );
    assert(!understandPrompt.includes("Go/C++"), "understandJob prompt 不得保留固定职业分类");
    const failureAdapter = new OpenAICompatibleAdapter({
      baseUrl,
      apiKeyEnv: "ZHIPPING_TEST_MODEL_KEY",
      model: "error-message-test",
      maxRetries: 0,
      logger
    });
    await assert.rejects(
      () => failureAdapter.chatJson("return json", { test: true }, { kind: "failurePrivacy" }),
      (error) => error.status === 401
        && error.providerRequestId.startsWith("provider-request-")
        && error.message === "Model request failed (HTTP 401)."
        && !error.message.includes("upstream body")
    );
    const failureMetric = metrics.at(-1);
    assert.strictEqual(failureMetric.event, "model_call_failed");
    assert.strictEqual(failureMetric.data.httpStatus, 401);
    assert(failureMetric.data.providerRequestId.startsWith("provider-request-"));
    assert.strictEqual(failureMetric.data.errorMessage, "Model request failed (HTTP 401).");
    assert(!JSON.stringify(failureMetric).includes("upstream body"));
    const structuredFailureAdapter = new OpenAICompatibleAdapter({
      baseUrl,
      apiKeyEnv: "ZHIPPING_TEST_MODEL_KEY",
      model: "structured-failure-test",
      maxRetries: 0,
      logger
    });
    for (const [scenario, code] of [
      ["truncated", "MODEL_OUTPUT_TRUNCATED"],
      ["invalid-envelope", "MODEL_INVALID_RESPONSE"],
      ["null-envelope", "MODEL_INVALID_RESPONSE"],
      ["missing-content", "MODEL_INVALID_RESPONSE"],
      ["invalid-json", "MODEL_INVALID_JSON"]
    ]) {
      const error = await rejectedError(() => structuredFailureAdapter.chatJson("return json", { scenario }, { kind: "structuredFailure" }));
      assert.strictEqual(error.code, code);
      assert.strictEqual(error.httpStatus, 200);
      assert(error.providerRequestId.startsWith("provider-request-"));
      assert.strictEqual(error.retryable, true);
      assert.strictEqual(typeof error.contentLength, "number");
      assert.strictEqual(typeof error.finishReason, "string");
    }
    const structuredFailureMetrics = metrics.filter((metric) => metric.data.kind === "structuredFailure");
    assert.strictEqual(structuredFailureMetrics.length, 5);
    assert(!JSON.stringify(structuredFailureMetrics).includes("response sentinel"));
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

async function rejectedError(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  assert.fail("Expected operation to reject");
}
