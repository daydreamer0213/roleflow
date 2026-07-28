const assert = require("assert");
const http = require("http");
const { OpenAICompatibleAdapter, parseJsonContent } = require("../src/adapters/models/openai_compatible");
const { PRODUCT_POLICY } = require("../src/core/product_policy");

let requests = 0;
const payloads = [];
const adaptivePayloads = [];
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
  if (payload.model === "adaptive-output-test") {
    const scenario = JSON.parse(payload.messages[1].content).scenario;
    adaptivePayloads.push({ scenario, maxTokens: payload.max_tokens, jsonMode: Boolean(payload.response_format) });
    if (payload.max_tokens <= 4096) {
      if (scenario === "truncated") {
        res.end(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "{\"partial\":" } }] }));
      } else {
        res.end("invalid response envelope");
      }
      return;
    }
    if (scenario === "invalid-response" && payload.response_format) {
      res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "" } }] }));
      return;
    }
    if (scenario === "invalid-response-final-failure") {
      res.end("invalid final response envelope");
      return;
    }
    res.end(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "{\"expanded\":true}" } }],
      usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 }
    }));
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
    if (scenario === "invalid-envelope-html") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end("<html><body>temporary gateway page</body></html>");
      return;
    }
    if (scenario === "invalid-envelope-sse") {
      res.setHeader("content-type", "text/event-stream");
      res.end("data: {\"choices\":[]}\n\n");
      return;
    }
    if (scenario === "invalid-envelope-truncated") {
      res.end("{\"choices\":[");
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
    if (scenario === "invalid-json-finish-sentinel") {
      res.end(JSON.stringify({
        choices: [{
          finish_reason: "finish reason sentinel must never reach errors or observer logs",
          message: { content: sentinel }
        }]
      }));
      return;
    }
  }
  const compactMatchRequest = payload.messages?.[0]?.content?.includes("output only evidence-bearing rows");
  const content = requests === 2
    ? [{ type: "text", text: "```json\n{\"ok\":true}\n```" }]
    : compactMatchRequest
      ? JSON.stringify({ matches: [], eligibility: [], uncertainties: [], cautions: [], certainty: "low" })
      : "{\"retried\":true}";
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
    assert.deepStrictEqual(payloads.slice(2, 4).map((payload) => payload.max_tokens), [4096, 4096]);
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
    const compactNormalized = await retryAdapter.matchJob({
      candidateProfile: {},
      candidateMatchCard: { targetDirections: ["电商运营"] },
      jobUnderstanding: { coreRequirements: [], eligibilityItems: [], jobQuality: { level: "normal", concerns: [] } }
    });
    assert.strictEqual(compactNormalized.recommendation, "review", "OpenAI adapter 必须把紧凑传输格式归一化为既有分析格式");
    const matchPrompt = payloads.at(-1).messages[0].content;
    assert(matchPrompt.includes('matches:[{id,state,resumeEvidence}]'), "matchJob prompt 必须只要求紧凑的核心项证据");
    assert(matchPrompt.includes('eligibility:[{id,state,resumeEvidence}]'), "matchJob prompt 必须只要求紧凑的资格证据");
    assert(!matchPrompt.includes("uncertainties") && !matchPrompt.includes("certainty") && !matchPrompt.includes("cautions:[{kind,detail}]"), "matchJob prompt must only request sparse evidence rows");
    assert(matchPrompt.includes("R1") && matchPrompt.includes("E1"), "matchJob prompt 必须按稳定 ID 覆盖理解结果");
    for (const locallyDerived of [
      "requirementMatches",
      "recommendation",
      "fitLevel",
      "confidence",
      "fitReasons",
      "jobQuality",
      "hardBlockers",
      "softGaps",
      "questionsToVerify",
      "recommendedResumeVersion",
      "primaryProjects",
      "greetingAngle",
      "jdEvidence",
      "evidence.jd",
      "evidence.resume"
    ]) {
      assert(!matchPrompt.includes(locallyDerived), `matchJob prompt 不得要求模型重复本地可派生字段 ${locallyDerived}`);
    }
    assert(matchPrompt.includes("candidateMatchCard"));
    assert(matchPrompt.includes("searchPreferences"));
    assert(matchPrompt.includes("userNotes"), "matchJob prompt 必须说明用户补充偏好的语义");
    assert(matchPrompt.includes("优先级高于模型"), "matchJob prompt 必须说明用户补充偏好优先于模型归纳方向");
    assert(matchPrompt.includes("不得作为 resumeEvidence"), "matchJob prompt 必须禁止把用户备注当成简历证据");
    assert(matchPrompt.includes("omit unknown rows"), "matchJob prompt must allow omitted unknown rows");
    assert(matchPrompt.includes("output only"), "matchJob prompt must request evidence rows only");
    assert(matchPrompt.includes("non-core explicit gap"), "matchJob prompt must retain evidenced non-core gaps as soft signals");
    assert(matchPrompt.includes("indispensable") && matchPrompt.includes("hard blocker"), "matchJob prompt must reserve hard blocking for explicit indispensable incompatibility");
    // 真实模型回归：简历未提供教育背景被当成学历资格不符；信息不足不等于明确冲突。
    assert(matchPrompt.includes("明确冲突"), "matchJob prompt 必须要求 eligibility conflict 具备明确冲突证据");
    assert(matchPrompt.includes("信息不足"), "matchJob prompt 必须区分信息不足与资格不符");
    assert(
      matchPrompt.includes("resumeEvidence 最多 120 个字符"),
      "matchJob prompt 必须限制每段证据摘录最多 120 字符"
    );
    assert(
      matchPrompt.includes("Match by meaning, not exact wording")
        && matchPrompt.includes("narrower concrete candidate fact")
        && matchPrompt.includes("direct instance"),
      "matchJob prompt 必须允许具体简历事实证明更宽泛的岗位要求"
    );
    assert(
      matchPrompt.includes("Do not reverse this relation")
        && matchPrompt.includes("named platform")
        && matchPrompt.includes("specialist workflow")
        && matchPrompt.includes("business system"),
      "matchJob prompt 不得用宽泛或相邻经历冒充明确的平台、流程或业务系统经验"
    );
    assert(
      matchPrompt.includes("semantic-level example, not an occupation rule")
        && matchPrompt.includes("AI 工具实践")
        && matchPrompt.includes("Agent/RAG/Dify")
        && matchPrompt.includes("AI 代码调试")
        && ["logging", "tests", "mock", "exception tracing", "API debugging"]
          .every((term) => matchPrompt.includes(term)),
      "matchJob prompt 必须用非职业硬编码示例说明上位要求与具体事实的证据关系"
    );
    assert(
      ["image-generation/visual workflow", "named Agent platform", "data warehouse", "big-data framework", "ERP integration"]
        .every((term) => matchPrompt.includes(term)),
      "matchJob prompt 的具体示例必须保留相邻方向反向推断限制"
    );
    assert(!matchPrompt.includes("Python/Java"), "matchJob prompt 不得保留固定技术栈规则");
    assert(!matchPrompt.includes("二选一"), "matchJob prompt 不得保留固定技术栈规则");
    await retryAdapter.understandJob({ job: { sourceId: "prompt-check", description: "示例 JD" } });
    const understandPrompt = payloads.at(-1).messages[0].content;
    assert(
      understandPrompt.includes("requirements[{label,central,indispensable,evidence}]"),
      "understandJob prompt 必须保留轻量 central 标记"
    );
    assert(
      understandPrompt.includes("基础开发") && understandPrompt.includes("不能单独") && understandPrompt.includes("central=true"),
      "通用能力不得冒充岗位主线"
    );
    assert(
      ["编程语言", "操作系统", "数据库", "办公工具", "通用数据清洗", "基础 AI 概念"]
        .every((term) => understandPrompt.includes(term)),
      "understandJob prompt 必须明确列出不得单独作为 central 的通用能力"
    );
    assert(
      understandPrompt.includes("岗位特有的工作动作或交付结果")
        && understandPrompt.includes("模型训练")
        && understandPrompt.includes("图像处理")
        && understandPrompt.includes("目标检测")
        && understandPrompt.includes("Agent")
        && understandPrompt.includes("RAG"),
      "understandJob prompt 必须要求 central 包含岗位特有动作或交付结果"
    );
    assert(understandPrompt.includes("eligibility[非空字符串]"), "understandJob prompt 必须要求紧凑 eligibility");
    assert(understandPrompt.includes("riskSignals[{type,severity,evidence}]"), "understandJob prompt 必须要求紧凑 riskSignals");
    assert(understandPrompt.includes("roleSummary"), "understandJob prompt 必须要求 roleSummary");
    for (const removedField of [
      "coreResponsibilities",
      "preferredRequirements",
      "outcomeExpectations",
      "senioritySignal",
      "evidenceSnippets",
      "jobQuality.concerns"
    ]) {
      assert(!understandPrompt.includes(removedField), `understandJob prompt 不得请求旧字段 ${removedField}`);
    }
    assert(/年限[^\n]*不得[^\n]*indispensable=true|indispensable=true[^\n]*不得用于[^\n]*年限/.test(understandPrompt), "understandJob prompt 必须禁止把经验年限标为 indispensable=true");
    assert(understandPrompt.includes("责任发散") && understandPrompt.includes("low 或 medium"), "职责发散必须作为低或中风险信号");
    assert(understandPrompt.includes("收费、诈骗、安全或合规") && understandPrompt.includes("high"), "收费、诈骗、安全或合规必须作为高风险信号");
    assert(understandPrompt.includes("每段 evidence 最多 120 个字符"), "understandJob prompt 必须限制每段证据摘录最多 120 字符");
    assert(understandPrompt.includes("requirements 最多 16 项") && understandPrompt.includes("eligibility 和 riskSignals 各最多 8 项"), "understandJob prompt 必须显式限制紧凑数组");
    assert(
      understandPrompt.includes("若输入含 contractRepair")
        && understandPrompt.includes("contractRepair.invalidOutput")
        && understandPrompt.includes("contractRepair.reason")
        && understandPrompt.includes("返回修正后的完整 JSON"),
      "understandJob prompt 必须给出可执行的单次契约修复指令"
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
    for (const [scenario, code, responseFailureKind, diagnostics = {}] of [
      ["truncated", "MODEL_OUTPUT_TRUNCATED", "truncated_content"],
      ["invalid-envelope", "MODEL_INVALID_RESPONSE", "invalid_response_json", {
        responseContentTypeKind: "json", responseEnvelopeKind: "other", responseParseFailureKind: "unexpected_token"
      }],
      ["invalid-envelope-html", "MODEL_INVALID_RESPONSE", "invalid_response_json", {
        responseContentTypeKind: "html", responseEnvelopeKind: "html", responseParseFailureKind: "unexpected_token"
      }],
      ["invalid-envelope-sse", "MODEL_INVALID_RESPONSE", "invalid_response_json", {
        responseContentTypeKind: "event_stream", responseEnvelopeKind: "event_stream", responseParseFailureKind: "unexpected_token"
      }],
      ["invalid-envelope-truncated", "MODEL_INVALID_RESPONSE", "invalid_response_json", {
        responseContentTypeKind: "json", responseEnvelopeKind: "json_object", responseParseFailureKind: "unexpected_end"
      }],
      ["null-envelope", "MODEL_INVALID_RESPONSE", "invalid_envelope"],
      ["missing-content", "MODEL_INVALID_RESPONSE", "missing_content"],
      ["invalid-json", "MODEL_INVALID_JSON", "invalid_content_json"],
      ["invalid-json-finish-sentinel", "MODEL_INVALID_JSON", "invalid_content_json"]
    ]) {
      const error = await rejectedError(() => structuredFailureAdapter.chatJson("return json", { scenario }, { kind: "structuredFailure" }));
      assert.strictEqual(error.code, code);
      assert.strictEqual(error.responseFailureKind, responseFailureKind);
      assert.strictEqual(error.requestedMaxTokens, 4096);
      assert(!String(error.finishReason || "").includes("finish reason sentinel"));
      assert.strictEqual(error.httpStatus, 200);
      assert(error.providerRequestId.startsWith("provider-request-"));
      assert.strictEqual(error.retryable, true);
      assert.strictEqual(typeof error.contentLength, "number");
      assert.strictEqual(typeof error.finishReason, "string");
      for (const [field, expected] of Object.entries(diagnostics)) assert.strictEqual(error[field], expected);
      if (responseFailureKind === "invalid_response_json") {
        assert.strictEqual(error.responseHadUtf8Bom, false);
      }
    }
    const structuredFailureMetrics = metrics.filter((metric) => metric.data.kind === "structuredFailure");
    assert.strictEqual(structuredFailureMetrics.length, 9);
    for (const metric of structuredFailureMetrics.filter((item) => item.data.responseFailureKind === "invalid_response_json")) {
      assert(["json", "html", "event_stream"].includes(metric.data.responseContentTypeKind));
      assert(["other", "html", "event_stream", "json_object"].includes(metric.data.responseEnvelopeKind));
      assert(["unexpected_token", "unexpected_end"].includes(metric.data.responseParseFailureKind));
      assert.strictEqual(metric.data.responseHadUtf8Bom, false);
    }
    assert(!JSON.stringify(structuredFailureMetrics).includes("response sentinel"));
    assert(!JSON.stringify(structuredFailureMetrics).includes("finish reason sentinel"));
    const adaptiveAdapter = new OpenAICompatibleAdapter({
      baseUrl,
      apiKeyEnv: "ZHIPPING_TEST_MODEL_KEY",
      model: "adaptive-output-test",
      jsonMode: true,
      maxTokens: 4096,
      maxRetries: 1,
      logger
    });
    assert.deepStrictEqual(
      await adaptiveAdapter.chatJson("return json", { scenario: "truncated" }, { kind: "adaptiveTruncated" }),
      { expanded: true }
    );
    assert.deepStrictEqual(
      await adaptiveAdapter.chatJson("return json", { scenario: "invalid-response" }, { kind: "adaptiveInvalidResponse" }),
      { expanded: true }
    );
    const finalFailure = await rejectedError(
      () => adaptiveAdapter.chatJson(
        "return json",
        { scenario: "invalid-response-final-failure" },
        { kind: "adaptiveFinalFailure" }
      )
    );
    assert.strictEqual(finalFailure.code, "MODEL_INVALID_RESPONSE");
    assert.strictEqual(finalFailure.responseFailureKind, "invalid_response_json");
    assert.strictEqual(finalFailure.requestedMaxTokens, 8192);
    assert.strictEqual(finalFailure.httpStatus, 200);
    assert.strictEqual(finalFailure.jsonModeApplied, false, "final failure metadata must prove the no-response_format recovery ran");
    assert.deepStrictEqual(adaptivePayloads, [
      { scenario: "truncated", maxTokens: 4096, jsonMode: true },
      { scenario: "truncated", maxTokens: 8192, jsonMode: true },
      { scenario: "invalid-response", maxTokens: 4096, jsonMode: true },
      { scenario: "invalid-response", maxTokens: 8192, jsonMode: true },
      { scenario: "invalid-response", maxTokens: 8192, jsonMode: false },
      { scenario: "invalid-response-final-failure", maxTokens: 4096, jsonMode: true },
      { scenario: "invalid-response-final-failure", maxTokens: 8192, jsonMode: true },
      { scenario: "invalid-response-final-failure", maxTokens: 8192, jsonMode: false }
    ]);
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
