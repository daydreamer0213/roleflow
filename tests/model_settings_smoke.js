const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { secretPath, saveSecret, loadSecret, clearSecret } = require("../src/core/secret_store");
const {
  listModelPresets,
  loadModelSettings,
  saveModelSettings,
  resolveRuntimeModelConfig,
  isModelReady,
  settingsPath
} = require("../src/core/model_settings");

const fallback = {
  provider: "openai_compatible",
  providers: {
    openai_compatible: {
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      model: "gpt-4.1-mini",
      timeoutMs: 30000
    }
  }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "zhiping-model-settings-"));

try {
  const presets = listModelPresets();
  assert(presets.some((item) => item.id === "deepseek" && item.baseUrl === "https://api.deepseek.com"));
  assert(presets.some((item) => item.id === "qwen" && item.baseUrl.includes("dashscope.aliyuncs.com")));

  const legacy = resolveRuntimeModelConfig({ root, fallbackModelConfig: fallback });
  assert.strictEqual(legacy.source, "legacy");
  assert.strictEqual(isModelReady(legacy), false);
  assert.strictEqual(legacy.modelConfig.providers.openai_compatible.apiKeyEnv, "OPENAI_API_KEY");

  const saved = saveModelSettings({
    root,
    fallbackModelConfig: fallback,
    input: { preset: "qwen", model: "qwen-plus", timeoutMs: "45000" }
  });
  assert.strictEqual(saved.preset, "qwen");
  assert.strictEqual(saved.baseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.strictEqual(saved.timeoutMs, 45000);

  saveSecret(root, "model-api-key", "test-key-must-not-appear-in-settings");
  assert.strictEqual(loadSecret(root, "model-api-key"), "test-key-must-not-appear-in-settings");
  const settingsText = fs.readFileSync(settingsPath(root), "utf8");
  const encryptedText = fs.readFileSync(secretPath(root, "model-api-key"), "utf8");
  assert(!settingsText.includes("test-key-must-not-appear-in-settings"));
  assert(!encryptedText.includes("test-key-must-not-appear-in-settings"));

  const runtime = resolveRuntimeModelConfig({ root, fallbackModelConfig: fallback });
  assert.strictEqual(runtime.source, "runtime");
  assert.strictEqual(runtime.keyConfigured, true);
  assert.strictEqual(runtime.modelConfig.provider, "openai_compatible");
  assert.strictEqual(runtime.modelConfig.providers.openai_compatible.model, "qwen-plus");
  assert.strictEqual(runtime.modelConfig.providers.openai_compatible.apiKey, "test-key-must-not-appear-in-settings");
  assert.strictEqual(runtime.modelConfig.providers.openai_compatible.apiKeyEnv, "ZHIPPING_MODEL_API_KEY");
  assert.strictEqual(isModelReady(runtime), true);

  const deepseek = saveModelSettings({
    root,
    fallbackModelConfig: fallback,
    input: { preset: "deepseek", model: "deepseek-v4-pro" }
  });
  assert.strictEqual(deepseek.baseUrl, "https://api.deepseek.com");
  assert.strictEqual(deepseek.model, "deepseek-v4-pro");

  assert.throws(() => saveModelSettings({
    root,
    fallbackModelConfig: fallback,
    input: { preset: "custom", baseUrl: "ftp://invalid.example", customModel: "test" }
  }), /http|URL/);

  clearSecret(root, "model-api-key");
  const cleared = loadModelSettings({ root, fallbackModelConfig: fallback });
  assert.strictEqual(cleared.keyConfigured, false);
  assert.strictEqual(isModelReady(cleared), false);
  console.log("model_settings_smoke ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
