const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { appError } = require("./observability");
const { secretPath, hasSecret, saveSecret, loadSecret, inspectSecret, clearSecret } = require("./secret_store");

const SETTINGS_RELATIVE_PATH = path.join(".runtime", "settings", "model.json");
const SECRET_ID = "model-api-key";
const DEFAULT_MODEL_TIMEOUT_MS = 60000;

const MODEL_PRESETS = {
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    provider: "openai_compatible",
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-v4-pro", "deepseek-v4-flash"],
    defaultModel: "deepseek-v4-pro",
    requiresKey: true
  },
  qwen: {
    id: "qwen",
    label: "通义千问",
    provider: "openai_compatible",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-flash", "qwen-plus", "qwen-max"],
    defaultModel: "qwen-plus",
    requiresKey: true
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    provider: "openai_compatible",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"],
    defaultModel: "gpt-4.1-mini",
    requiresKey: true
  },
  custom: {
    id: "custom",
    label: "自定义兼容接口",
    provider: "openai_compatible",
    baseUrl: "",
    models: [],
    defaultModel: "",
    requiresKey: true
  },
  mock: {
    id: "mock",
    label: "离线 Mock（仅测试）",
    provider: "mock",
    baseUrl: "",
    models: ["offline-structured-mock"],
    defaultModel: "offline-structured-mock",
    requiresKey: false,
    advanced: true
  }
};

function listModelPresets({ includeAdvanced = true } = {}) {
  return Object.values(MODEL_PRESETS).filter((preset) => includeAdvanced || !preset.advanced).map((preset) => ({
    id: preset.id,
    label: preset.label,
    provider: preset.provider,
    baseUrl: preset.baseUrl,
    models: [...preset.models],
    defaultModel: preset.defaultModel,
    requiresKey: preset.requiresKey,
    advanced: Boolean(preset.advanced)
  }));
}

function loadModelSettings({ root, fallbackModelConfig }) {
  const file = settingsPath(root);
  const stored = readJson(file);
  const source = stored ? "runtime" : "legacy";
  const settings = normalizeSettings(stored || settingsFromLegacyConfig(fallbackModelConfig));
  const migrationError = stored ? migrateLegacySecret(root, settings) : "";
  const secretId = secretIdForSettings(settings);
  const keyState = secretId ? inspectSecret(root, secretId) : { stored: false, readable: false, configured: false, errorCode: "" };
  const keyErrorCode = keyState.errorCode || migrationError;
  return {
    source,
    settings,
    secretId,
    keyStored: Boolean(keyState.stored || migrationError),
    keyConfigured: Boolean(keyState.configured),
    keyReadable: Boolean(keyState.readable),
    keyErrorCode,
    connectionStatus: settings.connection?.status || "unverified",
    modelConfig: modelConfigFromSettings(settings, "", source === "legacy" ? legacyApiKeyEnv(fallbackModelConfig) : "ZHIPPING_MODEL_API_KEY")
  };
}

function saveModelSettings({ root, input, fallbackModelConfig }) {
  const current = loadModelSettings({ root, fallbackModelConfig }).settings;
  const settings = normalizeSettings({ ...current, ...input });
  writeSettings(root, settings);
  return settings;
}

async function saveVerifiedModelConfiguration({ root, input, fallbackModelConfig, connectionTester = testModelConnection }) {
  const current = loadModelSettings({ root, fallbackModelConfig });
  const proposed = normalizeSettings({ ...current.settings, ...input, connection: null });
  const targetSecretId = secretIdForSettings(proposed);
  const suppliedKey = String(input.apiKey || "").trim();
  const clearRequested = input.clearApiKey === true || input.clearApiKey === "on";
  let apiKey = suppliedKey;

  if (proposed.provider !== "mock") {
    if (clearRequested) throw appError("MODEL_KEY_REQUIRED", "当前模型需要 API Key，不能在保存并验证时删除密钥。", { statusCode: 400 });
    if (!apiKey && targetSecretId && inspectSecret(root, targetSecretId).configured) apiKey = loadSecret(root, targetSecretId);
    if (!apiKey) throw appError("MODEL_KEY_REQUIRED", "请填写当前模型厂商的 API Key。切换厂商时不会复用上一家的密钥。", { statusCode: 400 });
  }

  const verification = proposed.provider === "mock"
    ? { status: "verified", checkedAt: new Date().toISOString(), latencyMs: 0, httpStatus: 0 }
    : await connectionTester({ settings: proposed, apiKey });
  const settings = normalizeSettings({
    ...proposed,
    connection: { ...verification, fingerprint: modelFingerprint(proposed) }
  });

  const settingsFile = settingsPath(root);
  const oldSettings = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile) : null;
  const targetFile = targetSecretId ? secretPath(root, targetSecretId) : "";
  const oldSecret = targetFile && fs.existsSync(targetFile) ? fs.readFileSync(targetFile) : null;
  try {
    if (targetSecretId && suppliedKey) saveSecret(root, targetSecretId, suppliedKey);
    if (targetSecretId && clearRequested) clearSecret(root, targetSecretId);
    writeSettings(root, settings);
  } catch (error) {
    restoreFile(settingsFile, oldSettings);
    if (targetFile) restoreFile(targetFile, oldSecret);
    throw appError("MODEL_SETTINGS_SAVE_FAILED", "模型已验证，但本机配置保存失败；原配置已恢复，请重试。", { cause: error, statusCode: 500 });
  }
  return loadModelSettings({ root, fallbackModelConfig });
}

async function testModelConnection({ settings, apiKey, fetchImpl = fetch }) {
  const normalized = normalizeSettings(settings);
  if (normalized.provider === "mock") return { status: "verified", checkedAt: new Date().toISOString(), latencyMs: 0, httpStatus: 0 };
  if (!String(apiKey || "").trim()) throw appError("MODEL_KEY_REQUIRED", "请填写当前模型厂商的 API Key。", { statusCode: 400 });
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), normalized.timeoutMs);
  let response;
  let payload;
  try {
    response = await fetchImpl(`${normalized.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${String(apiKey).trim()}` },
      body: JSON.stringify({
        model: normalized.model,
        messages: [{ role: "user", content: "只返回 JSON：{\"ok\":true}" }],
        temperature: 0,
        max_tokens: 16,
        response_format: { type: "json_object" }
      }),
      signal: controller.signal
    });
    const body = await response.text();
    try { payload = body ? JSON.parse(body) : {}; } catch { payload = {}; }
  } catch (error) {
    if (error?.name === "AbortError") throw appError("MODEL_CONNECTION_TIMEOUT", `模型连接超过 ${normalized.timeoutMs}ms，请检查网络或提高高级设置中的超时时间。`, { cause: error, statusCode: 408 });
    throw appError("MODEL_CONNECTION_FAILED", "无法连接模型接口，请检查网络和接口地址。", { cause: error, statusCode: 502 });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) throw modelHttpError(response.status, upstreamMessage(payload));
  if (!Array.isArray(payload?.choices) || !payload.choices.length) {
    throw appError("MODEL_INVALID_RESPONSE", "模型接口已响应，但返回格式不符合 OpenAI 兼容协议。", { statusCode: 502, details: { httpStatus: response.status } });
  }
  return { status: "verified", checkedAt: new Date().toISOString(), latencyMs: Date.now() - startedAt, httpStatus: response.status };
}

function resolveRuntimeModelConfig({ root, fallbackModelConfig }) {
  const loaded = loadModelSettings({ root, fallbackModelConfig });
  if (loaded.settings.provider === "mock") return { ...loaded, modelConfig: modelConfigFromSettings(loaded.settings) };
  const apiKey = loaded.keyConfigured ? loadSecret(root, loaded.secretId) : "";
  const apiKeyEnv = loaded.source === "legacy" ? legacyApiKeyEnv(fallbackModelConfig) : "ZHIPPING_MODEL_API_KEY";
  return { ...loaded, modelConfig: modelConfigFromSettings(loaded.settings, apiKey, apiKeyEnv) };
}

function isModelReady(modelState) {
  if (!modelState?.settings) return false;
  if (modelState.settings.provider === "mock") return modelState.source === "runtime" && modelState.settings.connection?.status === "verified";
  return Boolean(modelState.keyConfigured && modelState.keyReadable && modelState.settings.connection?.status === "verified"
    && modelState.settings.connection?.fingerprint === modelFingerprint(modelState.settings));
}

function modelConfigFromSettings(settings, apiKey = "", apiKeyEnv = "ZHIPPING_MODEL_API_KEY") {
  if (settings.provider === "mock") return { provider: "mock", providers: { mock: { model: settings.model || "offline-structured-mock" } } };
  return {
    provider: "openai_compatible",
    providers: {
      openai_compatible: {
        baseUrl: settings.baseUrl,
        model: settings.model,
        timeoutMs: settings.timeoutMs,
        apiKey: apiKey || "",
        apiKeyEnv
      }
    }
  };
}

function normalizeSettings(raw = {}) {
  const presetId = MODEL_PRESETS[String(raw.preset || "").trim()] ? String(raw.preset).trim() : "custom";
  const preset = MODEL_PRESETS[presetId];
  const isCustom = presetId === "custom";
  const requestedModel = String(raw.customModel || raw.model || preset.defaultModel || "").trim().slice(0, 160);
  const model = requestedModel || preset.defaultModel;
  const baseUrl = isCustom ? normalizeBaseUrl(raw.baseUrl) : normalizeBaseUrl(preset.baseUrl);
  if (preset.provider !== "mock" && !baseUrl) throw new Error("请填写兼容接口基础地址。");
  if (preset.provider !== "mock" && !model) throw new Error("请填写模型名称。");
  const basic = { preset: presetId, provider: preset.provider, baseUrl, model, timeoutMs: normalizeTimeout(raw.timeoutMs) };
  const connection = normalizeConnection(raw.connection, modelFingerprint(basic));
  return { ...basic, connection };
}

function normalizeConnection(value, fingerprint) {
  const item = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  if (item.status !== "verified" || item.fingerprint !== fingerprint) return { status: "unverified", checkedAt: "", latencyMs: null, httpStatus: null, fingerprint };
  return {
    status: "verified",
    checkedAt: String(item.checkedAt || ""),
    latencyMs: Number.isFinite(Number(item.latencyMs)) ? Number(item.latencyMs) : null,
    httpStatus: Number.isFinite(Number(item.httpStatus)) ? Number(item.httpStatus) : null,
    fingerprint
  };
}

function settingsFromLegacyConfig(config = {}) {
  const provider = String(config.provider || "mock");
  if (provider === "mock") return { preset: "mock" };
  const legacy = config.providers?.openai_compatible || {};
  const baseUrl = normalizeBaseUrl(legacy.baseUrl);
  const matched = Object.values(MODEL_PRESETS).find((preset) => preset.provider === "openai_compatible" && preset.baseUrl === baseUrl);
  return { preset: matched ? matched.id : "custom", baseUrl, model: legacy.model || "", timeoutMs: legacy.timeoutMs };
}

function secretIdForSettings(settings = {}) {
  if (settings.provider === "mock") return "";
  if (settings.preset && settings.preset !== "custom") return `model-api-key-${settings.preset}`;
  const hash = crypto.createHash("sha256").update(String(settings.baseUrl || "custom")).digest("hex").slice(0, 12);
  return `model-api-key-custom-${hash}`;
}

function migrateLegacySecret(root, settings) {
  const targetId = secretIdForSettings(settings);
  if (!targetId || hasSecret(root, targetId) || !hasSecret(root, SECRET_ID)) return "";
  try {
    const value = loadSecret(root, SECRET_ID);
    if (!value) return "SECRET_EMPTY";
    saveSecret(root, targetId, value);
    clearSecret(root, SECRET_ID);
    return "";
  } catch {
    return "SECRET_UNREADABLE";
  }
}

function modelFingerprint(settings = {}) {
  return crypto.createHash("sha256").update([settings.provider, settings.baseUrl, settings.model].join("|")).digest("hex").slice(0, 20);
}

function modelHttpError(status, upstream = "") {
  const suffix = upstream ? `（${upstream}）` : "";
  if ([401, 403].includes(status)) return appError("MODEL_AUTH_FAILED", `API Key 无效或没有当前模型权限${suffix}`, { statusCode: 400, details: { httpStatus: status } });
  if (status === 402) return appError("MODEL_QUOTA_EXHAUSTED", `模型账户余额或额度不足${suffix}`, { statusCode: 400, details: { httpStatus: status } });
  if (status === 429) return appError("MODEL_RATE_LIMITED", `模型接口正在限流或额度受限，请稍后重试${suffix}`, { statusCode: 429, details: { httpStatus: status } });
  if (status === 404) return appError("MODEL_ENDPOINT_OR_MODEL_NOT_FOUND", `接口地址或模型名称不存在${suffix}`, { statusCode: 400, details: { httpStatus: status } });
  if (status >= 500) return appError("MODEL_UPSTREAM_UNAVAILABLE", `模型服务暂时不可用${suffix}`, { statusCode: 502, details: { httpStatus: status } });
  return appError("MODEL_REQUEST_REJECTED", `模型接口拒绝了连接测试${suffix}`, { statusCode: 400, details: { httpStatus: status } });
}

function upstreamMessage(payload) {
  return String(payload?.error?.message || payload?.message || "").replace(/[\r\n]+/g, " ").slice(0, 180);
}

function legacyApiKeyEnv(config = {}) {
  return String(config.providers?.openai_compatible?.apiKeyEnv || "OPENAI_API_KEY");
}

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error("接口地址必须是有效的 http 或 https URL。"); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("接口地址必须使用 http 或 https。");
  return raw;
}

function normalizeTimeout(value) {
  const number = Number(value || DEFAULT_MODEL_TIMEOUT_MS);
  if (!Number.isFinite(number)) return DEFAULT_MODEL_TIMEOUT_MS;
  return Math.max(3000, Math.min(120000, Math.round(number)));
}

function settingsPath(root) {
  return path.join(root || process.cwd(), SETTINGS_RELATIVE_PATH);
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data && typeof data === "object" ? data : null;
  } catch {
    throw new Error("模型设置文件无法读取，请在模型设置页面重新保存。");
  }
}

function writeSettings(root, settings) {
  const file = settingsPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, settings);
}

function writeJsonAtomic(file, data) {
  const temp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(temp, file);
}

function restoreFile(file, content) {
  if (content === null) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + "." + process.pid + ".restore";
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, file);
}

module.exports = {
  SECRET_ID,
  listModelPresets,
  loadModelSettings,
  saveModelSettings,
  saveVerifiedModelConfiguration,
  testModelConnection,
  resolveRuntimeModelConfig,
  isModelReady,
  modelConfigFromSettings,
  normalizeSettings,
  secretIdForSettings,
  modelFingerprint,
  settingsPath
};
