const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDb } = require("../src/core/storage");
const { createDashboardServer } = require("../src/dashboard/server");
const { secretPath } = require("../src/core/secret_store");
const {
  loadModelSettings,
  resolveRuntimeModelConfig,
  resolveRuntimeBatchBackup,
  isModelReady,
  secretIdForSettings
} = require("../src/core/model_settings");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "zhiping-model-ui-"));
const dbPath = path.join(root, "data", "jobs.sqlite");
const fallback = {
  provider: "mock",
  providers: { mock: { model: "offline-structured-mock" } }
};
let server;
let db;

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  if (server) server.close();
  if (db) db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function main() {
  db = openDb(dbPath);
  server = createDashboardServer({
    db,
    root,
    dbPath,
    modelConfig: fallback,
    connectionTester: async () => ({ status: "verified", checkedAt: new Date().toISOString(), latencyMs: 7, httpStatus: 200 })
  });
  await listen(server);
  const baseUrl = "http://127.0.0.1:" + server.address().port;

  const beforeSetup = await fetch(baseUrl + "/", { redirect: "manual" });
  assert.strictEqual(beforeSetup.status, 303);
  assert.strictEqual(beforeSetup.headers.get("location"), "/onboarding");
  const onboarding = await fetch(baseUrl + "/onboarding");
  assert((await onboarding.text()).includes("模型尚未通过连接测试"));

  const settings = await fetch(baseUrl + "/settings");
  const settingsHtml = await settings.text();
  assert.strictEqual(settings.status, 200);
  for (const text of [
    'id="model-profile-deep_analysis"',
    'id="model-profile-batch_screening"',
    'id="model-profile-batch_backup"',
    'name="taskProfile" value="deep_analysis"',
    'name="taskProfile" value="batch_screening"',
    "深度分析",
    "批量筛选",
    "当前值",
    "推荐值",
    "恢复推荐值",
    "共享厂商和 API Key",
    'id="shared-model-preset"',
    'id="shared-model-api-key"',
    "独立厂商和 API Key",
    "备用模型默认关闭",
    "备用模型必须先通过连接测试"
  ]) {
    assert(settingsHtml.includes(text), `settings page must include ${text}`);
  }
  assert(/<select[^>]*name="model"[^>]*>[\s\S]*deepseek-v4-pro[\s\S]*deepseek-v4-flash[\s\S]*<\/select>/.test(settingsHtml));
  assert(/model-profile-deep_analysis[\s\S]*name="concurrency" value="1"/.test(settingsHtml));
  assert(/model-profile-batch_screening[\s\S]*<select[^>]*name="concurrency"[\s\S]*value="1"[\s\S]*value="2"/.test(settingsHtml));
  assert(/name="credentialMode"[\s\S]*value="shared"[^>]*selected/.test(settingsHtml));
  assert(/settings-credentials[\s\S]*id="shared-model-preset"[\s\S]*id="shared-model-api-key"/.test(settingsHtml));
  assert(/<details[^>]*id="model-profile-batch_backup"(?![^>]*\sopen)/.test(settingsHtml));
  assert(!settingsHtml.includes("ui-smoke-key-not-visible-after-save"));

  const apiKey = "ui-smoke-key-not-visible-after-save";
  const backupApiKey = "backup-ui-smoke-key-not-visible-after-save";
  const savedDeep = await fetch(baseUrl + "/api/settings/model", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      taskProfile: "deep_analysis",
      action: "save",
      preset: "deepseek",
      model: "deepseek-v4-pro",
      timeoutMs: "120000",
      thinkingMode: "enabled",
      reasoningEffort: "high",
      concurrency: "1",
      credentialMode: "shared",
      apiKey
    }).toString(),
    redirect: "manual"
  });
  assert.strictEqual(savedDeep.status, 303);
  assert.strictEqual(savedDeep.headers.get("location"), "/settings?profile=deep_analysis&modelConfigured=1");

  let publicState = loadModelSettings({ root, fallbackModelConfig: fallback });
  assert.strictEqual(isModelReady(
    resolveRuntimeModelConfig({ root, fallbackModelConfig: fallback, taskProfile: "deep_analysis" }),
    { taskProfile: "deep_analysis" }
  ), true);
  assert.strictEqual(isModelReady(
    resolveRuntimeModelConfig({ root, fallbackModelConfig: fallback, taskProfile: "batch_screening" }),
    { taskProfile: "batch_screening" }
  ), false);
  const deepOnlyOnboarding = await fetch(baseUrl + "/onboarding");
  const deepOnlyHtml = await deepOnlyOnboarding.text();
  assert(!deepOnlyHtml.includes("模型尚未通过连接测试"));
  assert(!/disabled[^>]*>解析并生成筛选建议/.test(deepOnlyHtml));

  const savedBatch = await fetch(baseUrl + "/api/settings/model", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      taskProfile: "batch_screening",
      action: "save",
      preset: "deepseek",
      model: "deepseek-v4-flash",
      timeoutMs: "90000",
      thinkingMode: "disabled",
      reasoningEffort: "high",
      concurrency: "2",
      credentialMode: "shared"
    }).toString(),
    redirect: "manual"
  });
  assert.strictEqual(savedBatch.status, 303);
  assert.strictEqual(savedBatch.headers.get("location"), "/settings?profile=batch_screening&modelConfigured=1");

  const afterSave = await fetch(baseUrl + "/settings");
  const afterHtml = await afterSave.text();
  assert.strictEqual(afterSave.status, 200);
  assert(afterHtml.includes("API Key 已加密保存"));
  assert(!afterHtml.includes(apiKey));
  const deepRuntime = resolveRuntimeModelConfig({ root, fallbackModelConfig: fallback, taskProfile: "deep_analysis" });
  const batchRuntime = resolveRuntimeModelConfig({ root, fallbackModelConfig: fallback, taskProfile: "batch_screening" });
  const secretId = secretIdForSettings(deepRuntime.settings);
  assert(!fs.readFileSync(secretPath(root, secretId), "utf8").includes(apiKey));
  assert(!fs.readFileSync(path.join(root, ".runtime", "settings", "model.json"), "utf8").includes(apiKey));
  const logDir = path.join(root, ".runtime", "logs");
  const logs = fs.readdirSync(logDir).map((name) => fs.readFileSync(path.join(logDir, name), "utf8")).join("\\n");
  assert(!logs.includes(apiKey));
  assert.strictEqual(deepRuntime.modelConfig.providers.openai_compatible.model, "deepseek-v4-pro");
  assert.strictEqual(batchRuntime.modelConfig.providers.openai_compatible.model, "deepseek-v4-flash");
  assert.strictEqual(batchRuntime.concurrency, 2);
  assert.strictEqual(deepRuntime.modelConfig.providers.openai_compatible.apiKey, apiKey);
  assert.strictEqual(batchRuntime.modelConfig.providers.openai_compatible.apiKey, apiKey);

  const settingsFile = path.join(root, ".runtime", "settings", "model.json");
  const beforeInvalid = fs.readFileSync(settingsFile, "utf8");
  const invalidProfile = await fetch(baseUrl + "/api/settings/model", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      taskProfile: "unknown_profile",
      action: "save",
      preset: "deepseek",
      model: "deepseek-v4-flash"
    }).toString(),
    redirect: "manual"
  });
  assert.notStrictEqual(invalidProfile.status, 303);
  assert.strictEqual(fs.readFileSync(settingsFile, "utf8"), beforeInvalid);
  const invalidConcurrency = await fetch(baseUrl + "/api/settings/model", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      taskProfile: "batch_screening",
      action: "save",
      preset: "deepseek",
      model: "deepseek-v4-flash",
      timeoutMs: "90000",
      thinkingMode: "disabled",
      reasoningEffort: "high",
      credentialMode: "shared",
      concurrency: "3"
    }).toString(),
    redirect: "manual"
  });
  assert.notStrictEqual(invalidConcurrency.status, 303);
  assert.strictEqual(fs.readFileSync(settingsFile, "utf8"), beforeInvalid);

  const changedBatch = await fetch(baseUrl + "/api/settings/model", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      taskProfile: "batch_screening",
      action: "save",
      preset: "deepseek",
      model: "deepseek-v4-pro",
      timeoutMs: "30000",
      thinkingMode: "enabled",
      reasoningEffort: "max",
      concurrency: "1",
      credentialMode: "shared"
    }).toString(),
    redirect: "manual"
  });
  assert.strictEqual(changedBatch.status, 303);
  const restored = await fetch(baseUrl + "/api/settings/model", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      taskProfile: "batch_screening",
      action: "restore_recommended"
    }).toString(),
    redirect: "manual"
  });
  assert.strictEqual(restored.status, 303);
  assert.strictEqual(restored.headers.get("location"), "/settings?profile=batch_screening&recommended=1");
  publicState = loadModelSettings({ root, fallbackModelConfig: fallback });
  assert.strictEqual(publicState.settings.taskProfiles.batch_screening.model, "deepseek-v4-flash");
  assert.strictEqual(publicState.settings.taskProfiles.batch_screening.timeoutMs, 90000);
  assert.strictEqual(publicState.settings.taskProfiles.batch_screening.concurrency, 2);
  assert.strictEqual(publicState.settings.taskProfiles.batch_screening.connection.status, "unverified");
  assert.strictEqual(publicState.settings.taskProfiles.deep_analysis.connection.status, "verified");

  const backupSaved = await fetch(baseUrl + "/api/settings/model", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      taskProfile: "batch_backup",
      action: "save",
      enabled: "on",
      credentialMode: "independent",
      preset: "deepseek",
      model: "deepseek-v4-pro",
      timeoutMs: "90000",
      thinkingMode: "disabled",
      reasoningEffort: "high",
      apiKey: backupApiKey
    }).toString(),
    redirect: "manual"
  });
  const backupSavedBody = await backupSaved.text();
  assert.strictEqual(backupSaved.status, 303, backupSavedBody);
  assert.strictEqual(backupSaved.headers.get("location"), "/settings?profile=batch_backup&modelConfigured=1");
  const backupRuntime = resolveRuntimeBatchBackup({ root, fallbackModelConfig: fallback });
  assert(backupRuntime);
  assert.strictEqual(backupRuntime.modelConfig.providers.openai_compatible.apiKey, backupApiKey);
  assert(!JSON.stringify(loadModelSettings({ root, fallbackModelConfig: fallback })).includes(backupApiKey));

  const afterSetup = await fetch(baseUrl + "/", { redirect: "manual" });
  assert.strictEqual(afterSetup.status, 303);
  assert.strictEqual(afterSetup.headers.get("location"), "/onboarding");
  console.log("model_settings_ui_smoke ok");
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}
