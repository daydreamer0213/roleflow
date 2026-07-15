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
      input: { preset: "deepseek", model: "deepseek-v4-pro", apiKey: "deepseek-key-not-public" }
    });
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
