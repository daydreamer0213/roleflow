const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDb } = require("../src/core/storage");
const { createDashboardServer } = require("../src/dashboard/server");
const { secretPath } = require("../src/core/secret_store");
const { resolveRuntimeModelConfig } = require("../src/core/model_settings");

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
  server = createDashboardServer({ db, root, dbPath, modelConfig: fallback });
  await listen(server);
  const baseUrl = "http://127.0.0.1:" + server.address().port;

  const beforeSetup = await fetch(baseUrl + "/", { redirect: "manual" });
  assert.strictEqual(beforeSetup.status, 303);
  assert.strictEqual(beforeSetup.headers.get("location"), "/settings?required=1&next=%2Fonboarding");

  const settings = await fetch(baseUrl + "/settings");
  const settingsHtml = await settings.text();
  assert.strictEqual(settings.status, 200);
  assert(settingsHtml.includes("DeepSeek"));
  assert(settingsHtml.includes('value="https://api.deepseek.com"'));
  assert(settingsHtml.includes("通义千问"));
  assert(settingsHtml.includes("模型名称"));

  const apiKey = "ui-smoke-key-not-visible-after-save";
  const saved = await fetch(baseUrl + "/api/settings/model", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      preset: "deepseek",
      model: "deepseek-v4-flash",
      timeoutMs: "30000",
      apiKey
    }).toString(),
    redirect: "manual"
  });
  assert.strictEqual(saved.status, 303);
  assert.strictEqual(saved.headers.get("location"), "/onboarding?modelConfigured=1");

  const afterSave = await fetch(baseUrl + "/settings");
  const afterHtml = await afterSave.text();
  assert.strictEqual(afterSave.status, 200);
  assert(afterHtml.includes("已加密保存"));
  assert(!afterHtml.includes(apiKey));
  assert(!fs.readFileSync(secretPath(root, "model-api-key"), "utf8").includes(apiKey));
  assert(!fs.readFileSync(path.join(root, ".runtime", "settings", "model.json"), "utf8").includes(apiKey));
  const logDir = path.join(root, ".runtime", "logs");
  const logs = fs.readdirSync(logDir).map((name) => fs.readFileSync(path.join(logDir, name), "utf8")).join("\\n");
  assert(!logs.includes(apiKey));

  const runtime = resolveRuntimeModelConfig({ root, fallbackModelConfig: fallback });
  assert.strictEqual(runtime.modelConfig.providers.openai_compatible.baseUrl, "https://api.deepseek.com");
  assert.strictEqual(runtime.modelConfig.providers.openai_compatible.apiKey, apiKey);
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
