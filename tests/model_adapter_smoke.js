const assert = require("assert");
const http = require("http");
const { OpenAICompatibleAdapter, parseJsonContent } = require("../src/adapters/models/openai_compatible");
const { MockModelAdapter } = require("../src/adapters/models/mock");
const { PRODUCT_POLICY } = require("../src/core/product_policy");
const {
  deriveRoleAlignment,
  normalizeResponsibilityOutput,
} = require("../src/core/split_semantic_matching");

let requests = 0;
const payloads = [];
const adaptivePayloads = [];
const emptyResponsePayloads = [];
const emptyResponseAttempts = new Map();
const PRIVATE_RESPONSE_CONTENT_SENTINEL = "PRIVATE_RESPONSE_CONTENT_SENTINEL";
const sentinelResponseContent = `\`\`\`json\n{"ok":true,"marker":"${PRIVATE_RESPONSE_CONTENT_SENTINEL}"}\n\`\`\``;

function assertSafeCompletedEvent(metric) {
  const serialized = JSON.stringify(metric);
  assert(!serialized.includes(PRIVATE_RESPONSE_CONTENT_SENTINEL),
    "successful model telemetry must not expose response content");
  const keys = new Set();
  JSON.stringify(metric, (key, value) => {
    if (key) keys.add(key);
    return value;
  });
  for (const forbiddenKey of ["response", "content", "raw"]) {
    assert(!keys.has(forbiddenKey), `successful model telemetry must not expose ${forbiddenKey}`);
  }
}

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
  if (payload.model === "empty-response-test") {
    const scenario = JSON.parse(payload.messages[1].content).scenario;
    const attempt = (emptyResponseAttempts.get(scenario) || 0) + 1;
    emptyResponseAttempts.set(scenario, attempt);
    emptyResponsePayloads.push({
      scenario,
      maxTokens: payload.max_tokens,
      jsonMode: Boolean(payload.response_format)
    });
    if (scenario === "empty-response-then-valid" && attempt > 1) {
      res.end(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "{\"ok\":true}" } }]
      }));
      return;
    }
    res.end(scenario === "empty-response-then-valid" ? " \r\n" : "");
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
  const selectedTrackRequest = payload.messages?.[1]?.content?.includes("synthetic-t1");
  const content = requests === 2
    ? [{ type: "text", text: sentinelResponseContent }]
    : selectedTrackRequest
      ? JSON.stringify({ selectedTrackId: "T1", roleAlignment: "mostly_aligned", roleResumeEvidence: ["简历：交付过应用"], roleGaps: [], matches: [], eligibility: [], modelRecommendation: "apply" })
      : compactMatchRequest
        ? JSON.stringify({ roleAlignment: "insufficient_evidence", roleResumeEvidence: [], roleGaps: ["No responsibility evidence was provided"], matches: [], eligibility: [], modelRecommendation: "caution" })
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
    assert.deepStrictEqual(
      await fallbackAdapter.chatJson("return json", { test: true }, { kind: "understandJob" }),
      { ok: true, marker: PRIVATE_RESPONSE_CONTENT_SENTINEL }
    );
    assert.strictEqual(requests, 2);
    assert.strictEqual(payloads[1].temperature, 0,
      "understandJob evidence extraction must use deterministic temperature");
    assert.strictEqual(payloads[1].max_tokens, 4096);

    const retryAdapter = new OpenAICompatibleAdapter({ baseUrl, apiKeyEnv: "ZHIPPING_TEST_MODEL_KEY", model: "test", jsonMode: false, maxRetries: 1, logger });
    assert.deepStrictEqual(await retryAdapter.chatJson("return json", { test: true }, { kind: "matchJob" }), { retried: true });
    assert.strictEqual(requests, 4);
    assert.deepStrictEqual(payloads.slice(2, 4).map((payload) => payload.max_tokens), [4096, 4096]);
    assert.deepStrictEqual(payloads.slice(2, 4).map((payload) => payload.temperature), [0, 0],
      "every matchJob retry must keep deterministic temperature");
    const generativeAdapter = new OpenAICompatibleAdapter({
      baseUrl,
      apiKeyEnv: "ZHIPPING_TEST_MODEL_KEY",
      model: "test",
      temperature: 0.37,
      jsonMode: false,
      maxRetries: 0,
      logger
    });
    assert.deepStrictEqual(
      await generativeAdapter.chatJson("return json", { test: true }, { kind: "draftCommunication" }),
      { retried: true }
    );
    assert.strictEqual(payloads.at(-1).temperature, 0.37,
      "non-evidence generation must preserve its configured temperature");
    assert.deepStrictEqual(parseJsonContent("prefix {\"value\":1} suffix"), { value: 1 });
    const understandCompletedMetric = metrics.find((metric) =>
      metric.event === "model_call_completed" && metric.data.kind === "understandJob");
    const matchCompletedMetric = metrics.find((metric) =>
      metric.event === "model_call_completed" && metric.data.kind === "matchJob");
    assert.strictEqual(understandCompletedMetric.data.attempts, 2);
    assert.strictEqual(understandCompletedMetric.data.jsonModeFallback, true);
    assert.strictEqual(understandCompletedMetric.data.usage.total_tokens, 14);
    assert.strictEqual(understandCompletedMetric.data.providerRequestId, "provider-request-2");
    assert.strictEqual(understandCompletedMetric.data.contentLength, sentinelResponseContent.length);
    assert(Number.isInteger(understandCompletedMetric.data.contentLength));
    assert.throws(
      () => assertSafeCompletedEvent({
        level: "info",
        event: "model_call_completed",
        data: { content: PRIVATE_RESPONSE_CONTENT_SENTINEL }
      }),
      assert.AssertionError,
      "privacy assertion must reject a synthetic event containing raw response content"
    );
    for (const forbiddenKey of ["response", "content", "raw"]) {
      assert.throws(
        () => assertSafeCompletedEvent({ event: "model_call_completed", data: { [forbiddenKey]: "redacted" } }),
        assert.AssertionError,
        `privacy assertion must reject the ${forbiddenKey} key even without the sentinel`
      );
    }
    assertSafeCompletedEvent(understandCompletedMetric);
    assert.strictEqual(matchCompletedMetric.data.attempts, 2);
    assert.strictEqual(matchCompletedMetric.data.providerRequestId, "provider-request-4");
    const compactNormalized = await retryAdapter.matchJob({
      candidateProfile: {},
      candidateMatchCard: { targetDirections: ["电商运营"] },
      jobUnderstanding: {
        roleSummary: "运营交付",
        responsibilityEvidence: ["JD：负责运营交付"],
        coreRequirements: [],
        eligibilityItems: [],
        jobQuality: { level: "normal", concerns: [] }
      }
    });
    assert.strictEqual(compactNormalized.recommendation, "review", "OpenAI adapter 必须把紧凑传输格式归一化为既有分析格式");
    const selectedTrackDecision = await retryAdapter.matchJob({
      candidateProfile: { marker: "synthetic-t1" },
      jobUnderstanding: {
        hiringTracks: [{
          id: "T1",
          label: "应用开发",
          roleSummary: "交付应用",
          responsibilityEvidence: ["JD：负责应用交付"]
        }],
        coreRequirements: [],
        eligibilityItems: [],
        jobQuality: { level: "normal", concerns: [] }
      }
    });
    assert.strictEqual(selectedTrackDecision.selectedTrackId, "T1", "OpenAI adapter 必须保留模型选择的分支 ID");
    assert.strictEqual(selectedTrackDecision.modelRecommendation, "apply",
      "默认 shadow 模式必须保留模型四档建议，但不得把它当作最终档位");
    const matchPrompt = payloads.at(-1).messages[0].content;
    for (const field of ["roleAlignment", "roleResumeEvidence", "roleGaps", "responsibilityMatches", "matches", "eligibility", "modelRecommendation"]) {
      assert(matchPrompt.includes(field), `matchJob prompt must request ${field}`);
    }
    assert(matchPrompt.includes('matches:[{id,state,resumeEvidence}]'), "matchJob prompt 必须只要求紧凑的核心项证据");
    assert(matchPrompt.includes('eligibility:[{id,state,resumeEvidence}]'), "matchJob prompt 必须只要求紧凑的资格证据");
    assert(!matchPrompt.includes("uncertainties") && !matchPrompt.includes("certainty") && !matchPrompt.includes("cautions:[{kind,detail}]"), "matchJob prompt must only request sparse evidence rows");
    assert(
      matchPrompt.includes("For responsibilityMatches, use exactly D1 through D<n>")
        && matchPrompt.includes("For matches, use only existing R* IDs")
        && matchPrompt.includes("for eligibility, use only existing E* IDs"),
      "matchJob prompt 必须把 D*、R*、E* 编号限制在各自字段"
    );
    assert(
      matchPrompt.includes('"responsibilityMatches":[{"id":"D1"'),
      "matchJob prompt 的精确 JSON 示例必须包含 D1 职责匹配"
    );
    assert(
      matchPrompt.includes(
        "Return exactly these eight top-level keys and no others: selectedTrackId, roleAlignment, roleResumeEvidence, roleGaps, responsibilityMatches, matches, eligibility, modelRecommendation."
      ),
      "matchJob shadow prompt 必须声明包含责任项匹配的精确八键顶层契约"
    );
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
      assert(matchPrompt.includes(locallyDerived), `matchJob prompt 必须明确禁止本地可派生字段 ${locallyDerived}`);
    }
    assert(matchPrompt.includes("Forbidden top-level keys"), "matchJob prompt 必须把本地决策字段声明为禁止的顶层键");
    assert(matchPrompt.includes("candidateMatchCard"));
    assert(matchPrompt.includes("searchPreferences"));
    assert(matchPrompt.includes("userNotes"), "matchJob prompt 必须说明用户补充偏好的语义");
    assert(matchPrompt.includes("优先级高于模型"), "matchJob prompt 必须说明用户补充偏好优先于模型归纳方向");
    assert(matchPrompt.includes("不得作为 resumeEvidence"), "matchJob prompt 必须禁止把用户备注当成简历证据");
    assert(matchPrompt.includes("omit unknown rows"), "matchJob prompt must allow omitted unknown rows");
    assert(matchPrompt.includes("output only"), "matchJob prompt must request evidence rows only");
    assert(matchPrompt.includes("non-core explicit gap"), "matchJob prompt must retain evidenced non-core gaps as soft signals");
    assert(matchPrompt.includes("indispensable") && matchPrompt.includes("hard blocker"), "matchJob prompt must reserve hard blocking for explicit indispensable incompatibility");
    assert(!matchPrompt.includes("adjacent_misaligned"),
      "四方向契约不得继续暴露临时 adjacent_misaligned 状态");
    assert(!/70\s*[%/]|30\s*[%/]|0\.7|0\.3|weighted score/i.test(matchPrompt),
      "模型只做语义判断，提示词不得要求计算 70/30 权重或分数");
    assert(matchPrompt.includes("Do not calculate scores or weights"),
      "shadow 建议必须明确禁止模型执行本地权重计算");
    const sparseRepairReason = "matchJob 模型输出不符合契约：multi-track matching requires sparse evidence";
    const validSparseResult = {
      selectedTrackId: "T1",
      roleAlignment: "mostly_aligned",
      roleResumeEvidence: ["简历：交付过应用"],
      roleGaps: [],
      matches: [],
      eligibility: [],
      modelRecommendation: "apply"
    };
    const baseSparseRepairInput = {
      candidateProfile: { marker: "synthetic-repair" },
      candidateMatchCard: { targetDirections: ["应用开发"] },
      searchPreferences: { userNotes: ["优先应用开发"] },
      jobUnderstanding: {
        hiringTracks: [{
          id: "T1",
          label: "应用开发",
          roleSummary: "交付应用",
          responsibilityEvidence: ["JD：负责应用交付"]
        }],
        coreRequirements: [],
        eligibilityItems: [],
        jobQuality: { level: "normal", concerns: [] }
      }
    };
    async function captureSparseRepairInput(reason) {
      const adapter = new OpenAICompatibleAdapter({
        baseUrl: "https://example.invalid",
        apiKey: "test-key",
        model: "test"
      });
      let capturedInput;
      adapter.chatJson = async (_prompt, modelInput, { kind }) => {
        assert.strictEqual(kind, "matchJob");
        capturedInput = modelInput;
        return validSparseResult;
      };
      const input = {
        ...baseSparseRepairInput,
        contractRepair: {
          reason,
          instruction: "repair only the named fields",
          invalidOutput: {
            recommendation: "apply",
            fitLevel: "strong"
          }
        }
      };
      const originalInput = JSON.parse(JSON.stringify(input));
      await adapter.matchJob(input);
      assert.deepStrictEqual(input, originalInput, "matchJob repair preparation must not mutate caller input");
      return { capturedInput, originalInput };
    }
    for (const positiveReason of [sparseRepairReason, ` \n${sparseRepairReason}\t `]) {
      const { capturedInput, originalInput } = await captureSparseRepairInput(positiveReason);
      assert(
        !Object.prototype.hasOwnProperty.call(capturedInput.contractRepair, "invalidOutput"),
        "exact sparse validator repair must omit invalidOutput"
      );
      assert(
        capturedInput.contractRepair.instruction.includes("exactly the six-key sparse JSON object"),
        "exact sparse validator repair must use the fixed sparse rebuild instruction"
      );
      assert.deepStrictEqual(capturedInput.candidateProfile, originalInput.candidateProfile);
      assert.deepStrictEqual(capturedInput.candidateMatchCard, originalInput.candidateMatchCard);
      assert.deepStrictEqual(capturedInput.searchPreferences, originalInput.searchPreferences);
      assert.deepStrictEqual(capturedInput.jobUnderstanding, originalInput.jobUnderstanding);
    }
    for (const unchangedReason of [
      "synthetic contract failure",
      `prefix: ${sparseRepairReason}`,
      `${sparseRepairReason} suffix`,
      `${sparseRepairReason}; another failure`,
      "matchJob 模型输出不符合契约：multi-track matching requires sparse evidences"
    ]) {
      const { capturedInput, originalInput } = await captureSparseRepairInput(unchangedReason);
      assert.deepStrictEqual(
        capturedInput,
        originalInput,
        "non-exact sparse repair reasons must preserve the existing repair input"
      );
    }
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
      matchPrompt.includes("broad capability without naming a domain, platform, tool, or specialist workflow")
        && matchPrompt.includes("must use matched, not transferable"),
      "宽泛且未绑定领域、平台、工具或专业流程的要求，必须把具体直接实例判为 matched"
    );
    assert(
      matchPrompt.includes("A central transferable requirement must have a corresponding concrete named difference in roleGaps.")
        && matchPrompt.includes("Do not invent a roleGap to justify transferable."),
      "matchJob prompt 必须让中心 transferable 与具体 roleGap 保持一致"
    );
    assert(
      matchPrompt.includes("An eligibility conflict requires an explicit candidate fact that fails every accepted alternative in that eligibility item."),
      "matchJob prompt 必须只在候选人明确不满足全部可接受资格分支时输出 conflict"
    );
    assert(
      matchPrompt.includes("explicitly names an unproven domain, platform, tool, specialist workflow, work object, action, or deliverable")
        && matchPrompt.includes("use transferable"),
      "明确但未证明的领域、平台、工具、专业流程或工作交付差异必须保留 transferable 边界"
    );
    assert(
      matchPrompt.includes("Do not reverse this relation")
        && matchPrompt.includes("named platform")
        && matchPrompt.includes("specialist workflow")
        && matchPrompt.includes("business system"),
      "matchJob prompt 不得用宽泛或相邻经历冒充明确的平台、流程或业务系统经验"
    );
    assert(
      matchPrompt.includes("A shared tool, framework, industry, or secondary duty is not evidence of the required primary work object, action, or deliverable."),
      "matchJob prompt 必须用职业无关规则限制工具或次要职责重叠"
    );
    assert(
      ["Agent/RAG/Dify", "AI 代码调试", "image-generation/visual workflow", "named Agent platform", "data warehouse", "big-data framework", "ERP integration"]
        .every((term) => !matchPrompt.includes(term)),
      "matchJob prompt 不得继续堆叠当前 IT 测试集的专用示例"
    );
    assert(!matchPrompt.includes("Python/Java"), "matchJob prompt 不得保留固定技术栈规则");
    assert(!matchPrompt.includes("二选一"), "matchJob prompt 不得保留固定技术栈规则");
    await retryAdapter.understandJob({ job: { sourceId: "prompt-check", description: "示例 JD" } });
    const understandPrompt = payloads.at(-1).messages[0].content;
    for (const token of [
      "hiringTracks[{id,label,roleSummary,responsibilityEvidence}]",
      "requirements[{label,trackIds,foundation,central,indispensable,evidence}]",
      "最多四个",
      "普通 JD",
      "T1",
      "不得为了规避要求而虚构分支",
      "愿望清单",
      "同一个人承担",
      "全局要求",
      "全部分支 ID"
    ]) {
      assert(understandPrompt.includes(token), `understandJob prompt 缺少多分支规则：${token}`);
    }
    assert(!understandPrompt.includes("只输出且必须输出这六个字段"));
    assert(
      matchPrompt.includes("selectedTrackId")
        && matchPrompt.includes("only the selected track")
        && matchPrompt.includes("all-track requirement")
        && matchPrompt.includes("Never match requirements from another track"),
      "matchJob prompt 必须先选一支，再匹配该支与全局要求"
    );
    assert(matchPrompt.includes(
      '{"selectedTrackId":"T1","roleAlignment":"mostly_aligned"'
    ));
    assert(
      matchPrompt.includes("roleSummary")
        && matchPrompt.includes("responsibilityEvidence")
        && matchPrompt.includes("primary work object")
        && matchPrompt.includes("main action")
        && matchPrompt.includes("primary deliverable"),
      "matchJob prompt must compare the primary work object, action, and deliverable"
    );
    assert(
      matchPrompt.includes("responsibilityMatches")
        && matchPrompt.includes("D1 means the first selected-track responsibilityEvidence item")
        && matchPrompt.includes("matched, transferable, missing, or unknown"),
      "matchJob prompt must bind every selected-track primary duty to structured candidate evidence"
    );
    assert(
      matchPrompt.includes(
        "For responsibilityMatches, do not use missing merely because the resume lacks the exact named domain, platform, tool, framework, or specialist workflow."
      )
        && matchPrompt.includes(
          "If a concrete resume fact proves the same underlying work action and deliverable through a different named context, use transferable."
        )
        && matchPrompt.includes(
          "If the exact context is unproven and no comparable responsibility is evidenced, use unknown with empty resumeEvidence."
        )
        && matchPrompt.includes(
          "Use missing only when a concrete resume fact explicitly proves an incompatible responsibility, work action, or deliverable."
        ),
      "responsibilityMatches must distinguish named-context gaps from missing underlying duties"
    );
    assert(
      matchPrompt.includes("partially_aligned includes an adjacent role family")
        && matchPrompt.includes("same artifact class or professional delivery lifecycle")
        && matchPrompt.includes("meaningful transferable evidence for primary duties"),
      "partially_aligned 必须覆盖同类产物或同一交付生命周期中的相邻职业"
    );
    assert(
      matchPrompt.includes("substantially different overall across the work object, main action, and primary deliverable")
        && matchPrompt.includes("no meaningful adjacent artifact-class or professional-delivery-lifecycle path exists")
        && matchPrompt.includes("If only one layer differs and a meaningful transferable path exists, use partially_aligned"),
      "misaligned 必须只覆盖整体主方向明显不同且不存在相邻迁移路径的岗位"
    );
    assert(
      matchPrompt.includes("Overlap limited to generic capabilities")
        && matchPrompt.includes("generic capabilities, tools, technologies, industry context, or secondary duties")
        && matchPrompt.includes("A compatible secondary duty cannot redefine the job's primary direction"),
      "misaligned 必须表达主方向不同，不能被工具或次要职责重叠抬升"
    );
    assert(
      matchPrompt.includes("For multi-track misaligned results without a missing foundation or central requirement")
        && matchPrompt.includes("D<n>|work_object, D<n>|main_action, or D<n>|deliverable")
        && matchPrompt.includes("D1 means the first responsibilityEvidence string of the selected track"),
      "无主线 requirement 的多分支 misaligned gap 必须绑定选中分支职责证据"
    );
    let offPrompt = "";
    const offAdapter = new OpenAICompatibleAdapter({
      baseUrl,
      apiKey: "test-key",
      model: "test"
    });
    offAdapter.chatJson = async (prompt) => {
      offPrompt = prompt;
      return {
        roleAlignment: "insufficient_evidence",
        roleResumeEvidence: [],
        roleGaps: ["No responsibility evidence was provided"],
        matches: [],
        eligibility: []
      };
    };
    const offDecision = await offAdapter.matchJob({
      modelRecommendationMode: "off",
      candidateProfile: {},
      jobUnderstanding: {
        roleSummary: "运营交付",
        responsibilityEvidence: [],
        coreRequirements: [],
        eligibilityItems: [],
        jobQuality: { level: "normal", concerns: [] }
      }
    });
    assert(!offPrompt.includes("modelRecommendation"),
      "off 模式不得要求模型输出整体建议");
    assert(!Object.prototype.hasOwnProperty.call(offDecision, "modelRecommendation"),
      "off 模式归一化结果不得携带模型整体建议");
    const splitCalls = [];
    const splitAdapter = new OpenAICompatibleAdapter({
      baseUrl,
      apiKey: "test-key",
      model: "test"
    });
    splitAdapter.chatJson = async (prompt, modelInput, { kind }) => {
      splitCalls.push({ prompt, modelInput, kind });
      if (kind === "matchResponsibilities") {
        return {
          selectedTrackId: "T1",
          matches: [{
            id: "D1",
            state: "transferable",
            resumeEvidence: `简历：${"具体事实".repeat(40)}`
          }]
        };
      }
      if (kind === "matchRequirements") {
        return {
          matches: [{
            id: "R1",
            state: "transferable",
            resumeEvidence: "简历：有直接要求证据"
          }],
          eligibility: []
        };
      }
      throw new Error(`unexpected split call kind: ${kind}`);
    };
    const splitInput = {
      semanticMatchingMode: "split",
      modelRecommendationMode: "off",
      candidateProfile: {},
      candidateMatchCard: null,
      searchPreferences: {},
      jobUnderstanding: {
        industryContext: "示例行业",
        hiringTracks: [{
          id: "T1",
          label: "示例方向",
          roleSummary: "处理业务对象并交付结果",
          responsibilityEvidence: ["JD：负责职责一", "JD：负责职责二"]
        }],
        coreRequirements: [{
          id: "R1",
          label: "要求一",
          trackIds: ["T1"],
          foundation: false,
          central: true,
          indispensable: false,
          evidence: "JD：具备要求一"
        }, {
          id: "R2",
          label: "要求二",
          trackIds: ["T1"],
          foundation: false,
          central: false,
          indispensable: false,
          evidence: "JD：具备要求二"
        }],
        eligibilityItems: [],
        riskSignals: [],
        jobQuality: { level: "normal", concerns: [] }
      }
    };
    const splitDecision = await splitAdapter.matchJob(splitInput);
    assert.deepStrictEqual(
      splitCalls.map((call) => call.kind),
      ["matchResponsibilities", "matchRequirements"],
      "split 模式必须恰好执行职责与要求两次窄调用"
    );
    assert.strictEqual(splitDecision.roleAlignment, "partially_aligned");
    assert.strictEqual(splitDecision.responsibilityMatches[0].resumeEvidence.length, 120,
      "非空超长证据必须由本地代码确定性截断");
    assert.strictEqual(splitDecision.responsibilityMatches[1].state, "unknown",
      "职责调用省略的预期 ID 必须保守归一化为 unknown");
    assert.strictEqual(splitDecision.requirementMatches[1].state, "unknown",
      "要求调用省略的预期 ID 必须保守归一化为 unknown");
    assert(splitDecision.roleGaps.length > 0,
      "central transferable 必须由本地代码生成可核对的要求差异");
    assert(!Object.prototype.hasOwnProperty.call(splitDecision, "modelRecommendation"),
      "split 模式不得重新引入模型整体建议");
    assert(
      splitCalls[0].prompt.length < matchPrompt.length
        && splitCalls[1].prompt.length < matchPrompt.length,
      "每个拆分提示词必须比旧的组合提示词更短"
    );
    assert.deepStrictEqual(
      Object.keys(splitCalls[0].modelInput).sort(),
      ["candidateMatchCard", "candidateProfile", "hiringTracks", "searchPreferences"],
      "职责调用只能看到候选人事实、偏好和分支职责"
    );
    assert.deepStrictEqual(
      Object.keys(splitCalls[1].modelInput).sort(),
      ["candidateMatchCard", "candidateProfile", "eligibility", "requirements", "searchPreferences", "selectedTrack"],
      "要求调用只能看到所选分支要求与资格"
    );

    const splitUnderstanding = splitInput.jobUnderstanding;
    assert.throws(() => normalizeResponsibilityOutput({
      selectedTrackId: "T1",
      matches: [
        { id: "D1", state: "matched", resumeEvidence: "简历：事实" },
        { id: "D1", state: "matched", resumeEvidence: "简历：事实" }
      ]
    }, splitUnderstanding), /duplicate id/);
    assert.throws(() => normalizeResponsibilityOutput({
      selectedTrackId: "T1",
      matches: [
        { id: "D9", state: "matched", resumeEvidence: "简历：事实" }
      ]
    }, splitUnderstanding), /unknown id/);
    assert.throws(() => normalizeResponsibilityOutput({
      selectedTrackId: "T1",
      matches: [
        { id: "D1", state: "matched", resumeEvidence: { text: "简历：错误类型" } }
      ]
    }, splitUnderstanding), /resumeEvidence must be a string/);
    for (const resumeEvidence of ["参与过相关项目", "简历：   "]) {
      assert.throws(() => normalizeResponsibilityOutput({
        selectedTrackId: "T1",
        matches: [
          { id: "D1", state: "matched", resumeEvidence }
        ]
      }, splitUnderstanding), /resumeEvidence must start with 简历： and contain evidence/);
    }
    assert.deepStrictEqual(
      deriveRoleAlignment([
        { state: "transferable", resumeEvidence: "简历：事实一" },
        { state: "transferable", resumeEvidence: "简历：事实二" },
        { state: "unknown", resumeEvidence: "" },
        { state: "unknown", resumeEvidence: "" }
      ]),
      {
        roleAlignment: "mostly_aligned",
        total: 4,
        known: 2,
        coverage: 0.5,
        score: 0.5
      }
    );

    const badResponsibilityCalls = [];
    const badResponsibilityAdapter = new OpenAICompatibleAdapter({
      baseUrl,
      apiKey: "test-key",
      model: "test"
    });
    badResponsibilityAdapter.chatJson = async (_prompt, _modelInput, { kind }) => {
      badResponsibilityCalls.push(kind);
      if (kind !== "matchResponsibilities") {
        throw new Error("requirements must not run after invalid responsibilities");
      }
      return {
        selectedTrackId: "T1",
        matches: [{
          id: "D1",
          state: "matched",
          resumeEvidence: { text: "简历：错误类型" }
        }]
      };
    };
    await assert.rejects(
      () => badResponsibilityAdapter.matchJob(splitInput),
      (error) => error.code === "MODEL_CONTRACT_INVALID"
        && error.modelStage === "matchResponsibilities"
        && error.modelPhase === "contract_repair"
    );
    assert.deepStrictEqual(
      badResponsibilityCalls,
      ["matchResponsibilities", "matchResponsibilities"],
      "职责结构失败只能重试职责一次，且不得调用要求阶段"
    );

    const requirementRepairCalls = [];
    const requirementRepairAdapter = new OpenAICompatibleAdapter({
      baseUrl,
      apiKey: "test-key",
      model: "test"
    });
    requirementRepairAdapter.chatJson = async (_prompt, modelInput, { kind }) => {
      requirementRepairCalls.push(kind);
      if (kind === "matchResponsibilities") {
        return {
          selectedTrackId: "T1",
          matches: [{
            id: "D1",
            state: "transferable",
            resumeEvidence: "简历：职责事实"
          }]
        };
      }
      if (!modelInput.contractRepair) {
        return {
          matches: [{
            id: "R9",
            state: "matched",
            resumeEvidence: "简历：错误 ID"
          }],
          eligibility: []
        };
      }
      return {
        matches: [{
          id: "R1",
          state: "transferable",
          resumeEvidence: "简历：要求事实"
        }],
        eligibility: []
      };
    };
    await requirementRepairAdapter.matchJob(splitInput);
    assert.deepStrictEqual(
      requirementRepairCalls,
      ["matchResponsibilities", "matchRequirements", "matchRequirements"],
      "要求结构失败只能重试要求，不得重跑已经通过的职责阶段"
    );

    const multiTrackAdapter = new OpenAICompatibleAdapter({
      baseUrl,
      apiKey: "test-key",
      model: "test"
    });
    multiTrackAdapter.chatJson = async (_prompt, _modelInput, { kind }) => (
      kind === "matchResponsibilities"
        ? {
          selectedTrackId: "T2",
          matches: [{
            id: "D1",
            state: "missing",
            gapDimension: "work_object",
            resumeEvidence: "简历：候选人的主要工作对象明确不同"
          }]
        }
        : {
          matches: [{
            id: "R1",
            state: "matched",
            resumeEvidence: "简历：满足要求"
          }],
          eligibility: []
        }
    );
    const multiTrackDecision = await multiTrackAdapter.matchJob({
      ...splitInput,
      jobUnderstanding: {
        ...splitUnderstanding,
        hiringTracks: [{
          id: "T1",
          label: "方向一",
          roleSummary: "交付方向一",
          responsibilityEvidence: ["JD：负责方向一"]
        }, {
          id: "T2",
          label: "方向二",
          roleSummary: "交付方向二",
          responsibilityEvidence: ["JD：负责方向二"]
        }],
        coreRequirements: [{
          ...splitUnderstanding.coreRequirements[0],
          trackIds: ["T2"]
        }]
      }
    });
    assert.strictEqual(multiTrackDecision.selectedTrackId, "T2");
    assert.strictEqual(multiTrackDecision.roleAlignment, "misaligned");
    assert.match(multiTrackDecision.roleGaps[0], /主要工作对象不同/);

    const multiTrackResponsibilityOnlyAdapter = new OpenAICompatibleAdapter({
      baseUrl,
      apiKey: "test-key",
      model: "test"
    });
    multiTrackResponsibilityOnlyAdapter.chatJson = async (_prompt, _modelInput, { kind }) => (
      kind === "matchResponsibilities"
        ? {
          selectedTrackId: "T2",
          matches: [{
            id: "D1",
            state: "matched",
            resumeEvidence: "简历：直接完成过同类职责交付"
          }]
        }
        : { matches: [], eligibility: [] }
    );
    const responsibilityOnlyDecision = await multiTrackResponsibilityOnlyAdapter.matchJob({
      ...splitInput,
      jobUnderstanding: {
        ...splitUnderstanding,
        hiringTracks: [{
          id: "T1",
          label: "方向一",
          roleSummary: "交付方向一",
          responsibilityEvidence: ["JD：负责方向一"]
        }, {
          id: "T2",
          label: "方向二",
          roleSummary: "交付方向二",
          responsibilityEvidence: ["JD：负责方向二"]
        }],
        coreRequirements: [{
          ...splitUnderstanding.coreRequirements[0],
          trackIds: ["T2"]
        }]
      }
    });
    assert.strictEqual(responsibilityOnlyDecision.roleAlignment, "partially_aligned");
    assert.deepStrictEqual(
      responsibilityOnlyDecision.roleResumeEvidence,
      ["简历：直接完成过同类职责交付"],
      "多分支岗位必须优先保留 D<n> 绑定的职责证据，不能被空要求证据覆盖"
    );
    assert(
      understandPrompt.includes("requirements[{label,trackIds,foundation,central,indispensable,evidence}]"),
      "understandJob prompt 必须保留 foundation 与 central 标记"
    );
    assert(
      understandPrompt.includes("industryContext")
        && understandPrompt.includes("主体行业")
        && understandPrompt.includes("roleSummary 只描述主体工作")
        && understandPrompt.includes("工作对象、主要动作和交付结果")
        && understandPrompt.includes("不得根据公司名或常识猜测"),
      "understandJob 必须把主体行业和主体工作分开"
    );
    assert(
      understandPrompt.includes("跨行业不变的最低忠实抽象")
        && understandPrompt.includes("ERP 维护与二次开发")
        && understandPrompt.includes("业务软件维护、扩展与接口集成")
        && understandPrompt.includes("量化策略研究与回测"),
      "roleSummary 必须去掉行业外壳，但保留真正改变工作的领域动作"
    );
    assert(
      matchPrompt.includes("Ignore jobUnderstanding.industryContext")
        && matchPrompt.includes("employer domain, customer type, named tools, platforms, frameworks, and technology stack")
        && matchPrompt.includes("They may be requirement gaps")
        && matchPrompt.includes("do not by themselves change the primary role direction"),
      "matchJob 必须用职业无关规则剥离行业、客户和工具外壳"
    );
    assert(
      understandPrompt.includes("基础开发") && understandPrompt.includes("不能单独") && understandPrompt.includes("central=true"),
      "通用能力不得冒充岗位主线"
    );
    assert(
      understandPrompt.includes("稀缺的最低履职前提")
        && understandPrompt.includes("不等于‘要求、精通、掌握’")
        && understandPrompt.includes("仅支撑某个环节的工具、平台、部署、通用工程能力默认 false")
        && understandPrompt.includes("工具或平台本身就是主要工作对象时")
        && understandPrompt.includes("不能仅凭不可协商标为 foundation=true")
        && understandPrompt.includes("要标为 foundation，该要求仍须直接决定主要工作对象、动作或交付结果")
        && understandPrompt.includes("主要工作对象、动作或交付结果")
        && understandPrompt.includes("JD 明确为不可协商前提")
        && understandPrompt.includes("不确定时 false"),
      "foundation=true 必须只标记稀缺的最低履职前提，不能放大支持性能力"
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
    for (const phrase of [
      "responsibilityEvidence",
      "foundation",
      "工作对象",
      "主要动作",
      "交付结果",
      "复合要求必须拆开"
    ]) {
      assert(understandPrompt.includes(phrase), `understandJob prompt 必须包含 ${phrase}`);
    }
    assert(understandPrompt.includes("只输出 JSON") && understandPrompt.includes("不输出 Markdown"),
      "understandJob prompt 必须请求 JSON 而非 Markdown");
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
    assert(
      understandPrompt.includes("Evaluate responsibility_sprawl within each independent hiring track")
        && understandPrompt.includes("Do not combine duties across independent tracks"),
      "understandJob prompt 必须在分支内判断职责发散，禁止跨独立招聘分支合并职责"
    );
    assert(
      understandPrompt.includes("Preserve logical alternatives and scope when normalizing eligibility.")
        && understandPrompt.includes("Only emit separate eligibility items when each condition is independently mandatory."),
      "understandJob prompt 必须保留资格条件的逻辑替代关系，禁止把非独立硬门槛拆开"
    );
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
    const structuredFailureMetrics = metrics.filter((metric) =>
      metric.event === "model_call_failed" && metric.data.kind === "structuredFailure");
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
    const emptyResponseAdapter = new OpenAICompatibleAdapter({
      baseUrl,
      apiKeyEnv: "ZHIPPING_TEST_MODEL_KEY",
      model: "empty-response-test",
      jsonMode: true,
      maxTokens: 4096,
      maxRetries: 1,
      logger
    });
    const emptyResponseFailure = await rejectedError(
      () => emptyResponseAdapter.chatJson(
        "return json",
        { scenario: "empty-response-final-failure" },
        { kind: "emptyResponseFinalFailure" }
      )
    );
    assert.strictEqual(emptyResponseFailure.code, "MODEL_EMPTY_RESPONSE");
    assert.strictEqual(emptyResponseFailure.responseFailureKind, "empty_response");
    assert.strictEqual(emptyResponseFailure.responseEnvelopeKind, "empty");
    assert.strictEqual(emptyResponseFailure.contentLength, 0);
    assert.strictEqual(emptyResponseFailure.requestedMaxTokens, 4096);
    assert.strictEqual(emptyResponseFailure.jsonModeApplied, true);
    assert.deepStrictEqual(
      await emptyResponseAdapter.chatJson(
        "return json",
        { scenario: "empty-response-then-valid" },
        { kind: "emptyResponseThenValid" }
      ),
      { ok: true }
    );
    assert.deepStrictEqual(emptyResponsePayloads, [
      { scenario: "empty-response-final-failure", maxTokens: 4096, jsonMode: true },
      { scenario: "empty-response-final-failure", maxTokens: 4096, jsonMode: true },
      { scenario: "empty-response-then-valid", maxTokens: 4096, jsonMode: true },
      { scenario: "empty-response-then-valid", maxTokens: 4096, jsonMode: true }
    ]);
    const expectedAttemptKeys = [
      "attempt",
      "errorCode",
      "httpStatus",
      "jsonModeApplied",
      "kind",
      "latencyMs",
      "requestedMaxTokens",
      "responseContentLength",
      "responseFailureKind"
    ];
    const emptyFinalAttemptEvents = metrics.filter((metric) =>
      metric.data.kind === "emptyResponseFinalFailure"
      && metric.event.startsWith("model_call_attempt_"));
    const emptyRecoveryAttemptEvents = metrics.filter((metric) =>
      metric.data.kind === "emptyResponseThenValid"
      && metric.event.startsWith("model_call_attempt_"));
    assert.deepStrictEqual(
      emptyFinalAttemptEvents.map((metric) => metric.event),
      ["model_call_attempt_failed", "model_call_attempt_failed"]
    );
    assert.deepStrictEqual(
      emptyRecoveryAttemptEvents.map((metric) => metric.event),
      ["model_call_attempt_failed", "model_call_attempt_completed"]
    );
    for (const metric of [...emptyFinalAttemptEvents, ...emptyRecoveryAttemptEvents]) {
      assert.deepStrictEqual(Object.keys(metric.data).sort(), expectedAttemptKeys);
      assert(Number.isInteger(metric.data.attempt) && metric.data.attempt > 0);
      assert(Number.isInteger(metric.data.latencyMs) && metric.data.latencyMs >= 0);
      assert.strictEqual(metric.data.requestedMaxTokens, 4096);
      assert.strictEqual(metric.data.jsonModeApplied, true);
      for (const forbiddenKey of [
        "response", "content", "raw", "prompt", "provider", "model",
        "baseUrl", "apiKey", "providerRequestId", "usage"
      ]) {
        assert(!Object.prototype.hasOwnProperty.call(metric.data, forbiddenKey));
      }
    }
    assert.strictEqual(emptyFinalAttemptEvents[0].data.errorCode, "MODEL_EMPTY_RESPONSE");
    assert.strictEqual(emptyFinalAttemptEvents[0].data.responseFailureKind, "empty_response");
    assert.strictEqual(emptyRecoveryAttemptEvents[0].data.responseContentLength, 3);
    assert(!JSON.stringify([...emptyFinalAttemptEvents, ...emptyRecoveryAttemptEvents]).includes("PRIVATE_RESPONSE_CONTENT_SENTINEL"));

    const mockReplyAdapter = new MockModelAdapter();
    const mockReply = await mockReplyAdapter.draftMessageGroup({
      messages: [{ messageKey: "sha256:" + "a".repeat(64), text: "什么时候可以到岗？" }],
      facts: [
        { key: "employment_status", value: "在职" },
        { key: "availability_date", value: "2026-08-15" }
      ]
    });
    assert.strictEqual(mockReply.messageCategory, "availability");
    assert.deepStrictEqual(mockReply.messages, ["mock message reply draft"]);

    const openAiReplyAdapter = new OpenAICompatibleAdapter({
      baseUrl,
      apiKeyEnv: "ZHIPPING_TEST_MODEL_KEY",
      model: "test",
      maxRetries: 0
    });
    let replyPrompt = "";
    let replyInput = null;
    openAiReplyAdapter.chatJson = async (prompt, modelInput, { kind }) => {
      assert.strictEqual(kind, "draftMessageGroup");
      replyPrompt = prompt;
      replyInput = modelInput;
      return {
        messageCategory: "qualification",
        requiredFactKeys: [],
        usedFactKeys: [],
        responseItems: [],
        coverage: [],
        missingFact: null,
        messages: ["draft"]
      };
    };
    const openAiReply = await openAiReplyAdapter.draftMessageGroup({
      messages: [{ messageKey: "sha256:" + "b".repeat(64), text: "你好" }],
      facts: []
    });
    assert.deepStrictEqual(openAiReply.messages, ["draft"]);
    assert.strictEqual(replyInput.messages[0].messageKey, "sha256:" + "b".repeat(64));
    for (const phrase of [
      "Treat ordered messages as one recruiter turn.",
      "Do not confirm interview times.",
      "Do not claim resume submission.",
      "Return at most two complete alternative drafts."
    ]) {
      assert(replyPrompt.includes(phrase), `draftMessageGroup prompt must include ${phrase}`);
    }

    const originalFetch = global.fetch;
    const flashThinkingBodies = [];
    const response = (content) => new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }]
    }), {
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": "deepseek-thinking-test" }
    });
    let flashNonThinkingBody;
    let nonDeepSeekBody;
    let customEndpointBody;
    global.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      const modelInput = JSON.parse(body.messages[1].content);
      const systemPrompt = body.messages[0].content;
      if (body.model === "deepseek-v4-flash" && systemPrompt.includes("job ")) {
        flashThinkingBodies.push(body);
      }
      if (body.model === "deepseek-v4-flash" && body.thinking?.type === "disabled") {
        flashNonThinkingBody = body;
      }
      if (body.model === "other-model") nonDeepSeekBody = body;
      if (body.model === "deepseek-v4-flash" && _url.startsWith("https://example.invalid")) {
        customEndpointBody = body;
      }
      if (systemPrompt.includes("job evidence checker")) {
        return response(modelInput.contractRepair
          ? {
            selectedTrackId: "T1",
            roleAlignment: "insufficient_evidence",
            roleResumeEvidence: [],
            roleGaps: ["No responsibility evidence was provided"],
            responsibilityMatches: [],
            matches: [],
            eligibility: []
          }
          : { malformed: true });
      }
      if (systemPrompt.includes("job responsibility evidence extractor")) {
        return response(modelInput.contractRepair
          ? { selectedTrackId: "T1", matches: [] }
          : { malformed: true });
      }
      if (systemPrompt.includes("job requirement evidence extractor")) {
        return response({ matches: [], eligibility: [] });
      }
      return response({ ok: true });
    };
    try {
      const flashAdapter = new OpenAICompatibleAdapter({
        baseUrl: "https://api.deepseek.com",
        apiKey: "test-key",
        model: "deepseek-v4-flash",
        thinkingMode: "enabled",
        reasoningEffort: "high",
        jsonMode: false,
        maxRetries: 0,
        logger
      });
      const topLevelInput = {
        ...splitInput,
        semanticMatchingMode: "legacy",
        modelRecommendationMode: "off"
      };
      const topLevelFailure = await rejectedError(() => flashAdapter.matchJob(topLevelInput));
      assert.strictEqual(topLevelFailure.code, "MODEL_CONTRACT_INVALID");
      await flashAdapter.matchJob({
        ...topLevelInput,
        contractRepair: {
          reason: topLevelFailure.message,
          invalidOutput: topLevelFailure.invalidOutput
        }
      });

      await flashAdapter.matchJob({
        ...topLevelInput,
        semanticMatchingMode: "split"
      });

      const flashNonThinkingAdapter = new OpenAICompatibleAdapter({
        baseUrl: "https://api.deepseek.com",
        apiKey: "test-key",
        model: "deepseek-v4-flash",
        thinkingMode: "disabled",
        reasoningEffort: "high",
        jsonMode: false,
        maxRetries: 0,
        logger
      });
      await flashNonThinkingAdapter.chatJson("return json", { test: true }, { kind: "understandJob" });

      const nonDeepSeekAdapter = new OpenAICompatibleAdapter({
        baseUrl: "https://api.deepseek.com",
        apiKey: "test-key",
        model: "other-model",
        thinkingMode: "enabled",
        reasoningEffort: "high",
        jsonMode: false,
        maxRetries: 0,
        logger
      });
      await nonDeepSeekAdapter.chatJson("return json", { test: true }, { kind: "understandJob" });

      const customEndpointAdapter = new OpenAICompatibleAdapter({
        baseUrl: "https://example.invalid",
        apiKey: "test-key",
        model: "deepseek-v4-flash",
        thinkingMode: "enabled",
        reasoningEffort: "high",
        jsonMode: false,
        maxRetries: 0,
        logger
      });
      await customEndpointAdapter.chatJson("return json", { test: true }, { kind: "understandJob" });
    } finally {
      global.fetch = originalFetch;
    }
    for (const body of flashThinkingBodies) {
      assert.deepStrictEqual(body.thinking, { type: "enabled" });
      assert.strictEqual(body.reasoning_effort, "high");
      assert.strictEqual(Object.hasOwn(body, "temperature"), false);
    }
    assert.strictEqual(flashThinkingBodies.length, 5);
    assert.strictEqual(
      flashThinkingBodies.filter((body) =>
        Object.hasOwn(JSON.parse(body.messages[1].content), "contractRepair")).length,
      2,
      "top-level and split repairs must both keep the selected thinking mode"
    );
    assert.deepStrictEqual(flashNonThinkingBody.thinking, { type: "disabled" });
    assert.strictEqual(flashNonThinkingBody.temperature, 0);
    for (const body of [nonDeepSeekBody, customEndpointBody]) {
      assert.strictEqual(Object.hasOwn(body, "thinking"), false);
      assert.strictEqual(Object.hasOwn(body, "reasoning_effort"), false);
    }
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
