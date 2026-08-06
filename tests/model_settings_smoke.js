const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { secretPath, loadSecret } = require("../src/core/secret_store");
const {
  listModelPresets,
  loadModelSettings,
  saveVerifiedModelConfiguration,
  testModelConnection,
  resolveRuntimeModelConfig,
  isModelReady,
  modelConfigFromSettings,
  normalizeSettings,
  normalizeThinkingMode,
  normalizeReasoningEffort,
  secretIdForSettings,
  settingsPath
} = require("../src/core/model_settings");

const fallback = { provider: "mock", providers: { mock: { model: "offline-structured-mock" } } };
const root = fs.mkdtempSync(path.join(os.tmpdir(), "zhiping-model-settings-"));

(async () => {
  try {
    const presets = listModelPresets({ includeAdvanced: false });
    assert(presets.some((item) => item.id === "deepseek" && item.baseUrl === "https://api.deepseek.com"));
    assert(presets.some((item) => item.id === "qwen" && item.baseUrl.includes("dashscope.aliyuncs.com")));
    assert(!presets.some((item) => item.id === "mock"));

    const legacy = resolveRuntimeModelConfig({ root, fallbackModelConfig: fallback });
    assert.strictEqual(isModelReady(legacy), false);

    const verified = async () => ({ status: "verified", checkedAt: new Date().toISOString(), latencyMs: 12, httpStatus: 200 });
    const qwen = await saveVerifiedModelConfiguration({
      root,
      fallbackModelConfig: fallback,
      connectionTester: verified,
      input: { preset: "qwen", model: "qwen-plus-new", apiKey: "qwen-key-not-public" }
    });
    assert.strictEqual(qwen.settings.model, "qwen-plus-new", "预设厂商应允许填写新模型名");
    assert.strictEqual(qwen.settings.timeoutMs, 120000, "兼容别名 timeoutMs 必须镜像 deep_analysis 推荐超时");
    assert.strictEqual(qwen.connectionStatus, "verified", "兼容别名 connectionStatus 必须镜像 deep_analysis");
    assert.strictEqual(qwen.modelConfig.providers.openai_compatible.model, "qwen-plus-new", "兼容别名 modelConfig 必须镜像 deep_analysis");
    assert.strictEqual(qwen.modelConfig.providers.openai_compatible.apiKey, "", "公开 modelConfig 不得携带明文 Key");
    assert.strictEqual(qwen.settings.taskProfiles.deep_analysis.model, "qwen-plus-new", "兼容包装必须写入 deep_analysis 任务配置");
    assert.strictEqual(qwen.settings.taskProfiles.deep_analysis.thinkingMode, "disabled");
    assert.strictEqual(qwen.settings.taskProfiles.batch_screening.model, "deepseek-v4-flash", "保存深度分析不得改写批量筛选任务配置");
    assert.strictEqual(isModelReady(qwen), true);
    const qwenSecretId = secretIdForSettings(qwen.settings);
    assert.strictEqual(loadSecret(root, qwenSecretId), "qwen-key-not-public");

    await assert.rejects(() => saveVerifiedModelConfiguration({
      root,
      fallbackModelConfig: fallback,
      connectionTester: verified,
      input: { preset: "deepseek", model: "deepseek-v4-pro" }
    }), (error) => error.code === "MODEL_KEY_REQUIRED");
    assert.strictEqual(loadSecret(root, qwenSecretId), "qwen-key-not-public");

    const deepseek = await saveVerifiedModelConfiguration({
      root,
      fallbackModelConfig: fallback,
      connectionTester: verified,
      input: {
        preset: "deepseek",
        model: "deepseek-v4-flash",
        thinkingMode: "enabled",
        reasoningEffort: "high",
        apiKey: "deepseek-key-not-public"
      }
    });
    assert.strictEqual(deepseek.settings.timeoutMs, 120000, "未显式指定超时时保持任务配置当前超时");
    assert.strictEqual(deepseek.settings.thinkingMode, "enabled");
    assert.strictEqual(deepseek.settings.reasoningEffort, "high");
    assert.strictEqual(deepseek.settings.taskProfiles.deep_analysis.model, "deepseek-v4-flash", "兼容别名 model 必须镜像 deep_analysis");
    assert.strictEqual(deepseek.settings.connection.status, "verified", "兼容别名 connection 必须镜像 deep_analysis");
    assert.strictEqual(modelConfigFromSettings(deepseek.settings).providers.openai_compatible.thinkingMode, "enabled");
    assert.strictEqual(modelConfigFromSettings(deepseek.settings).providers.openai_compatible.reasoningEffort, "high");
    assert.throws(() => normalizeThinkingMode("sometimes"), /MODEL_THINKING_MODE_INVALID/);
    assert.throws(() => normalizeReasoningEffort("medium"), /MODEL_REASONING_EFFORT_INVALID/);
    assert.throws(() => normalizeSettings({
      preset: "deepseek",
      model: "deepseek-v4-flash",
      thinkingMode: "sometimes",
      reasoningEffort: "high"
    }), /MODEL_THINKING_MODE_INVALID/);
    const unofficialDeepSeek = normalizeSettings({
      preset: "deepseek",
      model: "deepseek-v4-preview",
      thinkingMode: "enabled",
      reasoningEffort: "max"
    });
    assert.strictEqual(unofficialDeepSeek.thinkingMode, "disabled");
    assert.strictEqual(unofficialDeepSeek.reasoningEffort, "high");
    const pollutedQwen = normalizeSettings({
      preset: "qwen",
      model: "qwen-plus",
      thinkingMode: "sometimes",
      reasoningEffort: "medium"
    });
    assert.strictEqual(pollutedQwen.thinkingMode, "disabled");
    assert.strictEqual(pollutedQwen.reasoningEffort, "high");
    const deepseekSecretId = secretIdForSettings(deepseek.settings);
    assert.notStrictEqual(deepseekSecretId, qwenSecretId);
    assert.strictEqual(loadSecret(root, deepseekSecretId), "deepseek-key-not-public");
    assert.strictEqual(loadSecret(root, qwenSecretId), "qwen-key-not-public");

    const backToQwen = await saveVerifiedModelConfiguration({
      root,
      fallbackModelConfig: fallback,
      connectionTester: verified,
      input: { preset: "qwen", model: "qwen-plus-new" }
    });
    assert.strictEqual(isModelReady(backToQwen), true);
    const publicText = fs.readFileSync(settingsPath(root), "utf8");
    assert(!publicText.includes("qwen-key-not-public"));
    assert(!publicText.includes("deepseek-key-not-public"));
    assert(!fs.readFileSync(secretPath(root, qwenSecretId), "utf8").includes("qwen-key-not-public"));

    fs.writeFileSync(secretPath(root, qwenSecretId), "corrupted-dpapi", "utf8");
    const corrupted = loadModelSettings({ root, fallbackModelConfig: fallback });
    assert.strictEqual(corrupted.keyStored, true);
    assert.strictEqual(corrupted.keyConfigured, false);
    assert.strictEqual(corrupted.keyErrorCode, "SECRET_UNREADABLE");
    assert.strictEqual(isModelReady(corrupted), false);

    await connectionErrorSmoke();
    await connectionProbeSmoke();
    console.log("model_settings_smoke ok");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function connectionErrorSmoke() {
  const settings = { preset: "custom", baseUrl: "https://model.invalid/v1", model: "test-model", timeoutMs: 3000 };
  for (const [status, code] of [[401, "MODEL_AUTH_FAILED"], [402, "MODEL_QUOTA_EXHAUSTED"], [404, "MODEL_ENDPOINT_OR_MODEL_NOT_FOUND"], [429, "MODEL_RATE_LIMITED"], [503, "MODEL_UPSTREAM_UNAVAILABLE"]]) {
    await assert.rejects(() => testModelConnection({
      settings,
      apiKey: "test",
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: "upstream test" } }), { status, headers: { "content-type": "application/json" } })
    }), (error) => error.code === code);
  }
  await assert.rejects(() => testModelConnection({
    settings,
    apiKey: "test",
    fetchImpl: async () => { const error = new Error("aborted"); error.name = "AbortError"; throw error; }
  }), (error) => error.code === "MODEL_CONNECTION_TIMEOUT");
}

async function connectionProbeSmoke() {
  const matrix = [
    { name: "DeepSeek V4 Pro", settings: { preset: "deepseek", model: "deepseek-v4-pro", thinkingMode: "enabled", reasoningEffort: "max" }, expectsThinking: true },
    { name: "DeepSeek V4 Flash", settings: { preset: "deepseek", model: "deepseek-v4-flash", thinkingMode: "enabled", reasoningEffort: "max" }, expectsThinking: true },
    { name: "Qwen", settings: { preset: "qwen", model: "qwen-plus", thinkingMode: "enabled", reasoningEffort: "max" }, expectsThinking: false },
    { name: "custom compatible endpoint", settings: { preset: "custom", baseUrl: "https://model.invalid/v1", model: "compatible-model", thinkingMode: "enabled", reasoningEffort: "max" }, expectsThinking: false },
    { name: "non-V4 DeepSeek model", settings: { preset: "deepseek", model: "deepseek-v4-preview", thinkingMode: "enabled", reasoningEffort: "max" }, expectsThinking: false }
  ];

  for (const probe of matrix) {
    let body;
    await testModelConnection({
      settings: probe.settings,
      apiKey: "test",
      fetchImpl: async (_url, options) => {
        body = JSON.parse(options.body);
        return new Response(JSON.stringify({ choices: [{ message: { content: "{\\\"ok\\\":true}" } }] }), { status: 200 });
      }
    });
    assert.strictEqual(Object.hasOwn(body, "reasoning_effort"), false, `${probe.name} probe must omit reasoning_effort`);
    if (probe.expectsThinking) {
      assert.deepStrictEqual(body.thinking, { type: "disabled" }, `${probe.name} probe must disable thinking`);
    } else {
      assert.strictEqual(Object.hasOwn(body, "thinking"), false, `${probe.name} probe must omit thinking`);
    }
  }
}
