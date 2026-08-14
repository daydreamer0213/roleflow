const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { appError } = require("./observability");
const { secretPath, hasSecret, saveSecret, loadSecret, inspectSecret, clearSecret } = require("./secret_store");

const SETTINGS_RELATIVE_PATH = path.join(".runtime", "settings", "model.json");
const SECRET_ID = "model-api-key";
const SETTINGS_SCHEMA_VERSION = 2;
const DEFAULT_MODEL_TIMEOUT_MS = 60000;
const THINKING_MODES = new Set(["enabled", "disabled"]);
const REASONING_EFFORTS = new Set(["high", "max"]);
const CREDENTIAL_REFS = new Set(["shared", "independent"]);
const MODEL_TASK_PROFILE_IDS = ["deep_analysis", "batch_screening"];

const RECOMMENDED_TASK_PROFILES = Object.freeze({
  deep_analysis: Object.freeze({
    model: "deepseek-v4-pro",
    timeoutMs: 120000,
    thinkingMode: "enabled",
    reasoningEffort: "high",
    concurrency: 1
  }),
  batch_screening: Object.freeze({
    model: "deepseek-v4-flash",
    timeoutMs: 90000,
    thinkingMode: "disabled",
    reasoningEffort: "high",
    concurrency: 2
  })
});

function supportsDeepSeekV4Thinking(preset, model) {
  return String(preset || "") === "deepseek" && ["deepseek-v4-pro", "deepseek-v4-flash"].includes(String(model || ""));
}

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

function listModelTaskProfiles() {
  return MODEL_TASK_PROFILE_IDS.map((id) => ({
    id,
    label: id === "deep_analysis" ? "深度分析" : "批量筛选",
    recommended: { ...RECOMMENDED_TASK_PROFILES[id] }
  }));
}

function resolveReadOnlyModelSettingsRoot(rawRoot, { worktreeRoot, homeRoot, tempRoot } = {}) {
  const value = String(rawRoot || "").trim();
  if (!value || /^[\\/]{2}/.test(value) || !path.isAbsolute(value) || /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(value)) {
    throw appError("MODEL_SETTINGS_ROOT_INVALID", "Model settings root must be a direct local absolute directory.");
  }
  let rootStat;
  try {
    rootStat = fs.lstatSync(value);
  } catch {
    throw appError("MODEL_SETTINGS_ROOT_NOT_FOUND", "Model settings root does not exist or is not a directory.");
  }
  if (rootStat.isSymbolicLink() || isUncPath(path.resolve(value))) {
    throw appError("MODEL_SETTINGS_ROOT_INVALID", "Model settings root must be a direct local absolute directory.");
  }
  if (!rootStat.isDirectory()) {
    throw appError("MODEL_SETTINGS_ROOT_NOT_FOUND", "Model settings root does not exist or is not a directory.");
  }
  const canonical = fs.realpathSync(value);
  if (isUncPath(canonical)) {
    throw appError("MODEL_SETTINGS_ROOT_INVALID", "Model settings root must be a direct local absolute directory.");
  }
  const worktree = canonicalRootPath(worktreeRoot);
  const home = canonicalRootPath(homeRoot);
  const temp = canonicalRootPath(tempRoot);
  if (worktree && isPathWithin(canonical, worktree)) {
    throw appError("MODEL_SETTINGS_ROOT_WORKTREE", "Model settings root must be outside the current worktree.");
  }
  if ((home && isPathWithin(canonical, home)) || (temp && isPathWithin(canonical, temp))) {
    throw appError("MODEL_SETTINGS_ROOT_PROTECTED", "Model settings root must be outside the user home and system temp directories.");
  }
  const settingsFile = directSettingsFile(canonical);
  if (!settingsFile.exists) {
    throw appError("MODEL_SETTINGS_ROOT_MISSING_SETTINGS", "Model settings root must contain .runtime/settings/model.json.");
  }
  if (!settingsFile.file) {
    throw appError("MODEL_SETTINGS_ROOT_SETTINGS_NOT_FILE", "Model settings root must contain .runtime/settings/model.json as a local regular file.");
  }
  return canonical;
}

function directSettingsFile(root) {
  let current = root;
  const segments = SETTINGS_RELATIVE_PATH.split(path.sep);
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return { exists: false, file: "" };
    }
    if (stat.isSymbolicLink()) {
      return { exists: true, file: "" };
    }
    if (index < segments.length - 1) {
      if (!stat.isDirectory()) return { exists: true, file: "" };
    } else if (!stat.isFile()) {
      return { exists: true, file: "" };
    }
  }
  return { exists: true, file: current };
}

function isUncPath(value) {
  return /^[\\/]{2}/.test(path.normalize(value));
}

function canonicalRootPath(value) {
  if (!value) return "";
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function isPathWithin(candidate, base) {
  const normalizedCandidate = path.normalize(candidate).toLowerCase();
  const normalizedBase = path.normalize(base).toLowerCase();
  if (normalizedCandidate === normalizedBase) return true;
  const prefix = normalizedBase.endsWith(path.sep) ? normalizedBase : normalizedBase + path.sep;
  return normalizedCandidate.startsWith(prefix);
}

function loadModelSettings({ root, fallbackModelConfig, readOnly = false }) {
  const file = settingsPath(root);
  let stored;
  try {
    stored = readJson(file);
  } catch (error) {
    if (readOnly) {
      throw appError("MODEL_SETTINGS_READ_ONLY_SCHEMA_REQUIRED", "Read-only model settings require a stored schema-v2 object; malformed JSON cannot use a fallback.", { cause: error });
    }
    throw error;
  }
  if (
    readOnly
    && stored
    && typeof stored === "object"
    && !Array.isArray(stored)
    && (
      stored.schemaVersion === 1
      || (
        !Object.hasOwn(stored, "schemaVersion")
        && typeof stored.model === "string"
        && (
          typeof stored.preset === "string"
          || typeof stored.provider === "string"
          || typeof stored.baseUrl === "string"
        )
      )
    )
  ) {
    throw appError("MODEL_SETTINGS_READ_ONLY_MIGRATION_REQUIRED", "Read-only model settings require schema v2 and cannot migrate legacy settings.");
  }
  if (readOnly && !isStoredSchemaV2Settings(stored)) {
    throw appError("MODEL_SETTINGS_READ_ONLY_SCHEMA_REQUIRED", "Read-only model settings require a stored schema-v2 object; missing or non-object settings cannot use a fallback.");
  }
  let settings;
  let source;
  if (stored) {
    settings = normalizeSettings(stored);
    source = stored.schemaVersion === 2 ? "runtime" : "migrated_v1";
  } else if (isMockFallback(fallbackModelConfig)) {
    settings = defaultSettings();
    source = "new_install";
  } else {
    settings = settingsFromLegacyConfig(fallbackModelConfig);
    source = "legacy";
  }
  const migrationError = stored && stored.schemaVersion !== 2 ? migrateLegacySecret(root, settings) : "";
  const primary = settings.taskProfiles.deep_analysis;
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
    connectionStatus: primary.connection?.status || "unverified",
    modelConfig: modelConfigFromSettings(settings, "", source === "legacy" ? legacyApiKeyEnv(fallbackModelConfig) : null)
  };
}

function isStoredSchemaV2Settings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.schemaVersion !== 2) return false;
  if (!value.taskProfiles || typeof value.taskProfiles !== "object" || Array.isArray(value.taskProfiles)) return false;
  return MODEL_TASK_PROFILE_IDS.every((id) => {
    const profile = value.taskProfiles[id];
    return Boolean(profile) && typeof profile === "object" && !Array.isArray(profile);
  });
}

function saveModelSettings({ root, input, fallbackModelConfig }) {
  const current = loadModelSettings({ root, fallbackModelConfig }).settings;
  const settings = normalizeSettings({ ...current, ...input });
  writeSettings(root, settings);
  return settings;
}

function saveModelTaskProfileParameters({ root, taskProfile, input, fallbackModelConfig }) {
  const profileId = normalizeTaskProfileId(taskProfile);
  const current = loadModelSettings({ root, fallbackModelConfig });
  const settings = applyTaskProfileInput(current.settings, profileId, input);
  const profile = settings.taskProfiles[profileId];
  const targetSecretId = secretIdForSettings(settings, profileId);
  const suppliedKey = profile.credentialRef === "independent" ? String(input.apiKey || "").trim() : "";
  const settingsFile = settingsPath(root);
  const oldSettings = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile) : null;
  const targetFile = targetSecretId ? secretPath(root, targetSecretId) : "";
  const oldSecret = targetFile && fs.existsSync(targetFile) ? fs.readFileSync(targetFile) : null;
  try {
    if (targetSecretId && suppliedKey) saveSecret(root, targetSecretId, suppliedKey);
    writeSettings(root, settings);
  } catch (error) {
    restoreFile(settingsFile, oldSettings);
    if (targetFile) restoreFile(targetFile, oldSecret);
    throw appError("MODEL_SETTINGS_SAVE_FAILED", "模型参数保存失败；原配置已恢复，请重试。", { cause: error, statusCode: 500 });
  }
  return loadModelSettings({ root, fallbackModelConfig });
}

async function saveVerifiedPrimaryModelProfiles({
  root,
  input,
  fallbackModelConfig,
  connectionTester = testModelConnection
}) {
  const current = loadModelSettings({ root, fallbackModelConfig });
  const settings = applySharedCredentialInput(current.settings, input);
  const sharedSecretId = secretIdForCredential("model-api-key-shared", settings.sharedCredential);
  const suppliedSharedKey = String(input.apiKey || "").trim();
  const storedSharedKey = sharedSecretId && inspectSecret(root, sharedSecretId).configured
    ? loadSecret(root, sharedSecretId)
    : "";
  const verifications = {};

  for (const profileId of MODEL_TASK_PROFILE_IDS) {
    const effective = effectiveTaskProfile(settings, profileId);
    const secretId = secretIdForSettings(settings, profileId);
    const apiKey = effective.credentialRef === "shared"
      ? suppliedSharedKey || storedSharedKey
      : secretId && inspectSecret(root, secretId).configured
        ? loadSecret(root, secretId)
        : "";
    if (effective.provider !== "mock" && !apiKey) {
      throw appError("MODEL_KEY_REQUIRED", `${listModelTaskProfiles().find((item) => item.id === profileId)?.label || profileId}缺少可用 API Key。`, { statusCode: 400 });
    }
    verifications[profileId] = effective.provider === "mock"
      ? { status: "verified", checkedAt: new Date().toISOString(), latencyMs: 0, httpStatus: 0 }
      : await connectionTester({ settings: { ...effective, taskProfile: profileId }, apiKey });
  }

  for (const profileId of MODEL_TASK_PROFILE_IDS) {
    const effective = effectiveTaskProfile(settings, profileId);
    settings.taskProfiles[profileId].connection = {
      ...verifications[profileId],
      fingerprint: profileFingerprint(effective)
    };
  }
  settings.revision = settingsFingerprint(settings);
  const finalized = normalizeSettings(settings);
  const settingsFile = settingsPath(root);
  const oldSettings = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile) : null;
  const targetFile = sharedSecretId ? secretPath(root, sharedSecretId) : "";
  const oldSecret = targetFile && fs.existsSync(targetFile) ? fs.readFileSync(targetFile) : null;
  try {
    if (sharedSecretId && suppliedSharedKey) saveSecret(root, sharedSecretId, suppliedSharedKey);
    writeSettings(root, finalized);
  } catch (error) {
    restoreFile(settingsFile, oldSettings);
    if (targetFile) restoreFile(targetFile, oldSecret);
    throw appError("MODEL_SETTINGS_SAVE_FAILED", "模型已验证，但本机配置保存失败；原配置已恢复，请重试。", { cause: error, statusCode: 500 });
  }
  return loadModelSettings({ root, fallbackModelConfig });
}

async function saveVerifiedModelConfiguration({ root, input, fallbackModelConfig, connectionTester = testModelConnection }) {
  return saveVerifiedModelTaskProfile({
    root,
    taskProfile: "deep_analysis",
    fallbackModelConfig,
    connectionTester,
    input
  });
}

async function saveVerifiedModelTaskProfile({
  root,
  taskProfile,
  input,
  fallbackModelConfig,
  connectionTester = testModelConnection
}) {
  const profileId = normalizeTaskProfileId(taskProfile);
  const current = loadModelSettings({ root, fallbackModelConfig });
  const proposedSettings = applyTaskProfileInput(current.settings, profileId, input);
  const profile = proposedSettings.taskProfiles[profileId];
  const targetSecretId = secretIdForSettings(proposedSettings, profileId);
  const suppliedKey = String(input.apiKey || "").trim();
  const clearRequested = input.clearApiKey === true || input.clearApiKey === "on";
  let apiKey = suppliedKey;
  const effective = effectiveTaskProfile(proposedSettings, profileId);

  if (effective.provider !== "mock") {
    if (clearRequested) throw appError("MODEL_KEY_REQUIRED", "当前模型需要 API Key，不能在保存并验证时删除密钥。", { statusCode: 400 });
    if (!apiKey && targetSecretId && inspectSecret(root, targetSecretId).configured) apiKey = loadSecret(root, targetSecretId);
    if (!apiKey) throw appError("MODEL_KEY_REQUIRED", "请填写当前模型厂商的 API Key。切换厂商时不会复用上一家的密钥。", { statusCode: 400 });
  }

  const verification = effective.provider === "mock"
    ? { status: "verified", checkedAt: new Date().toISOString(), latencyMs: 0, httpStatus: 0 }
    : await connectionTester({ settings: { ...effective, taskProfile: profileId }, apiKey });
  profile.connection = { ...verification, fingerprint: profileFingerprint(effective) };
  const settings = normalizeSettings(proposedSettings);
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

async function saveVerifiedBatchBackup({ root, input, fallbackModelConfig, connectionTester = testModelConnection }) {
  const current = loadModelSettings({ root, fallbackModelConfig });
  const settings = normalizeSettings({ ...current.settings });
  const previous = settings.batchBackup;
  const presetId = input.preset ? normalizePresetId(input.preset) : previous.preset;
  const preset = MODEL_PRESETS[presetId];
  const isCustom = presetId === "custom";
  const model = input.model !== undefined && input.model !== null
    ? String(input.model).trim().slice(0, 160)
    : previous.model;
  const baseUrl = isCustom
    ? normalizeBaseUrl(input.baseUrl || previous.baseUrl)
    : normalizeBaseUrl(preset.baseUrl);
  const supportsThinking = supportsDeepSeekV4Thinking(presetId, model);
  const backup = {
    enabled: Boolean(input.enabled),
    credentialRef: input.credentialRef ? normalizeCredentialRef(input.credentialRef) : previous.credentialRef,
    preset: presetId,
    provider: preset.provider,
    baseUrl,
    model,
    timeoutMs: normalizeTimeout(input.timeoutMs),
    thinkingMode: supportsThinking ? normalizeThinkingMode(input.thinkingMode) : "disabled",
    reasoningEffort: supportsThinking ? normalizeReasoningEffort(input.reasoningEffort) : "high"
  };
  const targetSecretId = secretIdForBatchBackup(settings, backup);
  const suppliedKey = String(input.apiKey || "").trim();
  let apiKey = suppliedKey;
  if (backup.provider !== "mock" && !apiKey && targetSecretId && inspectSecret(root, targetSecretId).configured) {
    apiKey = loadSecret(root, targetSecretId);
  }
  if (backup.provider !== "mock" && !apiKey && backup.enabled) {
    throw appError("MODEL_KEY_REQUIRED", "请填写当前模型厂商的 API Key。切换厂商时不会复用上一家的密钥。", { statusCode: 400 });
  }
  const fingerprint = profileFingerprint(backup);
  if (!backup.enabled) {
    backup.connection = { status: "unverified", checkedAt: "", latencyMs: null, httpStatus: null, fingerprint };
  } else {
    const verification = backup.provider === "mock"
      ? { status: "verified", checkedAt: new Date().toISOString(), latencyMs: 0, httpStatus: 0 }
      : await connectionTester({
        settings: {
          preset: backup.preset,
          baseUrl: backup.baseUrl,
          model: backup.model,
          timeoutMs: backup.timeoutMs,
          thinkingMode: backup.thinkingMode,
          reasoningEffort: backup.reasoningEffort
        },
        apiKey
      });
    backup.connection = { ...verification, fingerprint };
  }
  backup.revision = fingerprint;
  settings.batchBackup = backup;
  settings.revision = settingsFingerprint(settings);
  const settingsFile = settingsPath(root);
  const oldSettings = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile) : null;
  const targetFile = targetSecretId ? secretPath(root, targetSecretId) : "";
  const oldSecret = targetFile && fs.existsSync(targetFile) ? fs.readFileSync(targetFile) : null;
  try {
    if (targetSecretId && suppliedKey) saveSecret(root, targetSecretId, suppliedKey);
    writeSettings(root, settings);
  } catch (error) {
    restoreFile(settingsFile, oldSettings);
    if (targetFile) restoreFile(targetFile, oldSecret);
    throw appError("MODEL_SETTINGS_SAVE_FAILED", "模型已验证，但本机配置保存失败；原配置已恢复，请重试。", { cause: error, statusCode: 500 });
  }
  return loadModelSettings({ root, fallbackModelConfig });
}

async function testModelConnection({ settings, apiKey, fetchImpl = fetch }) {
  const profileId = settings?.taskProfile && MODEL_TASK_PROFILE_IDS.includes(String(settings.taskProfile))
    ? String(settings.taskProfile)
    : "deep_analysis";
  const profile = settings?.taskProfiles
    ? effectiveTaskProfile(normalizeSettings(settings), profileId)
    : normalizeProbeProfile(settings);
  if (profile.provider === "mock") return { status: "verified", checkedAt: new Date().toISOString(), latencyMs: 0, httpStatus: 0 };
  if (!String(apiKey || "").trim()) throw appError("MODEL_KEY_REQUIRED", "请填写当前模型厂商的 API Key。", { statusCode: 400 });
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), profile.timeoutMs);
  let response;
  let payload;
  try {
    const probeBody = {
      model: profile.model,
      messages: [{ role: "user", content: "Return JSON: {\\\"ok\\\":true}" }],
      temperature: 0,
      max_tokens: 16,
      response_format: { type: "json_object" }
    };
    if (supportsDeepSeekV4Thinking(profile.preset, profile.model)) probeBody.thinking = { type: "disabled" };
    response = await fetchImpl(`${profile.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${String(apiKey).trim()}` },
      body: JSON.stringify(probeBody),
      signal: controller.signal
    });
    const body = await response.text();
    try { payload = body ? JSON.parse(body) : {}; } catch { payload = {}; }
  } catch (error) {
    if (error?.name === "AbortError") throw appError("MODEL_CONNECTION_TIMEOUT", `模型连接超过 ${profile.timeoutMs}ms，请检查网络或提高高级设置中的超时时间。`, { cause: error, statusCode: 408 });
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

function resolveRuntimeModelConfig({ root, fallbackModelConfig, taskProfile, readOnly = false }) {
  const loaded = loadModelSettings({ root, fallbackModelConfig, readOnly });
  const profileId = normalizeTaskProfileId(taskProfile || "deep_analysis");
  const profile = loaded.settings.taskProfiles[profileId];
  const secretId = secretIdForSettings(loaded.settings, profileId);
  const keyState = secretId ? inspectSecret(root, secretId) : { stored: false, readable: false, configured: false, errorCode: "" };
  const effective = effectiveTaskProfile(loaded.settings, profileId);
  const base = {
    ...loaded,
    secretId,
    concurrency: profile.concurrency,
    revision: profile.revision,
    keyStored: Boolean(keyState.stored),
    keyConfigured: Boolean(keyState.configured),
    keyReadable: Boolean(keyState.readable),
    keyErrorCode: keyState.errorCode || ""
  };
  if (effective.provider === "mock") {
    return { ...base, modelConfig: modelConfigFromProfile(effective, "") };
  }
  const apiKey = keyState.configured ? loadSecret(root, secretId) : "";
  const apiKeyEnv = loaded.source === "legacy" ? legacyApiKeyEnv(fallbackModelConfig) : null;
  return { ...base, modelConfig: modelConfigFromProfile(effective, apiKey, apiKeyEnv) };
}

function resolveRuntimeBatchBackup({ root, fallbackModelConfig, readOnly = false }) {
  const loaded = loadModelSettings({ root, fallbackModelConfig, readOnly });
  const backup = loaded.settings.batchBackup;
  if (!backup.enabled) return null;
  if (backup.connection?.status !== "verified" || backup.connection.fingerprint !== profileFingerprint(backup)) return null;
  const secretId = secretIdForBatchBackup(loaded.settings, backup);
  const keyState = secretId ? inspectSecret(root, secretId) : { stored: false, readable: false, configured: false, errorCode: "" };
  if (backup.provider !== "mock" && !(keyState.configured && keyState.readable)) return null;
  const apiKey = keyState.configured ? loadSecret(root, secretId) : "";
  return {
    ...loaded,
    secretId,
    concurrency: 1,
    revision: backup.revision,
    keyStored: Boolean(keyState.stored),
    keyConfigured: Boolean(keyState.configured),
    keyReadable: Boolean(keyState.readable),
    keyErrorCode: keyState.errorCode || "",
    modelConfig: modelConfigFromProfile(backup, apiKey, null)
  };
}

function isModelReady(modelState, { taskProfile = "deep_analysis", checkedAfter = "" } = {}) {
  if (!modelState?.settings?.taskProfiles) return false;
  const profileId = normalizeTaskProfileId(taskProfile);
  const profile = modelState.settings.taskProfiles[profileId];
  if (!profile) return false;
  const effective = effectiveTaskProfile(modelState.settings, profileId);
  const keyOk = effective.provider === "mock"
    ? modelState.source === "runtime"
    : Boolean(modelState.keyConfigured && modelState.keyReadable);
  if (!keyOk) return false;
  const verified = profile.connection?.status === "verified"
    && profile.connection?.fingerprint === profileFingerprint(effective);
  if (!verified) return false;
  if (checkedAfter) {
    const checkedAt = Date.parse(profile.connection.checkedAt || "");
    if (!Number.isFinite(checkedAt) || checkedAt < Date.parse(checkedAfter)) return false;
  }
  return true;
}

function restoreRecommendedTaskProfile({ root, taskProfile, fallbackModelConfig }) {
  const profileId = normalizeTaskProfileId(taskProfile);
  const current = loadModelSettings({ root, fallbackModelConfig }).settings;
  const settings = normalizeSettings({ ...current });
  const recommended = RECOMMENDED_TASK_PROFILES[profileId];
  const profile = settings.taskProfiles[profileId];
  profile.model = recommended.model;
  profile.timeoutMs = recommended.timeoutMs;
  profile.thinkingMode = recommended.thinkingMode;
  profile.reasoningEffort = recommended.reasoningEffort;
  profile.concurrency = recommended.concurrency;
  profile.connection = { status: "unverified", checkedAt: "", latencyMs: null, httpStatus: null, fingerprint: "" };
  profile.revision = profileFingerprint(profile);
  settings.revision = settingsFingerprint(settings);
  writeSettings(root, settings);
  return loadModelSettings({ root, fallbackModelConfig });
}

function modelConfigFromSettings(settings, apiKey = "", apiKeyEnv = "ZHIPPING_MODEL_API_KEY") {
  const normalized = normalizeSettings(settings);
  return modelConfigFromProfile(effectiveTaskProfile(normalized, "deep_analysis"), apiKey, apiKeyEnv);
}

function normalizeSettings(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("模型设置必须是对象。");
  if (raw.schemaVersion === 2 && raw.taskProfiles) {
    const sharedCredential = normalizeCredential(raw.sharedCredential || raw.shared || {});
    const taskProfiles = {};
    for (const id of MODEL_TASK_PROFILE_IDS) {
      const input = raw.taskProfiles[id] || {};
      const independent = raw.independentCredentials?.[id] && String(input.credentialRef || "").trim() === "independent";
      const credential = independent ? raw.independentCredentials[id] : sharedCredential;
      taskProfiles[id] = normalizeTaskProfile(id, {
        ...input,
        preset: input.preset || credential.preset,
        baseUrl: input.baseUrl || credential.baseUrl,
        provider: input.provider || credential.provider
      });
    }
    const independentCredentials = {
      deep_analysis: raw.independentCredentials?.deep_analysis ? normalizeCredential(raw.independentCredentials.deep_analysis) : null,
      batch_screening: raw.independentCredentials?.batch_screening ? normalizeCredential(raw.independentCredentials.batch_screening) : null
    };
    const batchBackup = normalizeBatchBackup(raw.batchBackup || {});
    const settings = {
      schemaVersion: 2,
      credentialMode: raw.credentialMode === "independent" ? "independent" : "shared",
      sharedCredential,
      taskProfiles,
      independentCredentials,
      batchBackup,
      revision: ""
    };
    settings.revision = settingsFingerprint(settings);
    return withPublicAliases(settings);
  }
  return settingsFromLegacyV1(raw);
}

function settingsFromLegacyV1(raw = {}) {
  const presetId = normalizePresetId(raw.preset);
  const preset = MODEL_PRESETS[presetId];
  const isCustom = presetId === "custom";
  const model = String(raw.customModel || raw.model || preset.defaultModel || "").trim().slice(0, 160) || preset.defaultModel;
  const baseUrl = isCustom ? normalizeBaseUrl(raw.baseUrl) : normalizeBaseUrl(preset.baseUrl);
  if (preset.provider !== "mock" && !baseUrl) throw new Error("请填写兼容接口基础地址。");
  if (preset.provider !== "mock" && !model) throw new Error("请填写模型名称。");
  const supportsThinking = supportsDeepSeekV4Thinking(presetId, model);
  const basic = {
    preset: presetId,
    provider: preset.provider,
    baseUrl,
    model,
    timeoutMs: normalizeTimeout(raw.timeoutMs),
    thinkingMode: supportsThinking ? normalizeThinkingMode(raw.thinkingMode) : "disabled",
    reasoningEffort: supportsThinking ? normalizeReasoningEffort(raw.reasoningEffort) : "high"
  };
  const rawConnection = raw.connection && typeof raw.connection === "object" && !Array.isArray(raw.connection) ? raw.connection : {};
  const shared = {
    preset: presetId,
    provider: preset.provider,
    baseUrl
  };
  const taskProfiles = {};
  for (const id of MODEL_TASK_PROFILE_IDS) {
    const concurrency = id === "deep_analysis" ? 1 : 2;
    const profile = { ...basic, concurrency, credentialRef: "shared" };
    const fingerprint = profileFingerprint(profile);
    profile.revision = fingerprint;
    profile.connection = rawConnection.status === "verified"
      ? {
        status: "verified",
        checkedAt: String(rawConnection.checkedAt || ""),
        latencyMs: Number.isFinite(Number(rawConnection.latencyMs)) ? Number(rawConnection.latencyMs) : null,
        httpStatus: Number.isFinite(Number(rawConnection.httpStatus)) ? Number(rawConnection.httpStatus) : null,
        fingerprint
      }
      : { status: "unverified", checkedAt: "", latencyMs: null, httpStatus: null, fingerprint };
    taskProfiles[id] = {
      model: profile.model,
      timeoutMs: profile.timeoutMs,
      thinkingMode: profile.thinkingMode,
      reasoningEffort: profile.reasoningEffort,
      concurrency: profile.concurrency,
      credentialRef: profile.credentialRef,
      revision: profile.revision,
      connection: profile.connection
    };
  }
  const settings = {
    schemaVersion: 2,
    credentialMode: "shared",
    sharedCredential: shared,
    taskProfiles,
    independentCredentials: { deep_analysis: null, batch_screening: null },
    batchBackup: defaultBatchBackup(),
    revision: ""
  };
  settings.revision = settingsFingerprint(settings);
  return withPublicAliases(settings);
}

function defaultSettings() {
  const sharedCredential = normalizeCredential({ preset: "deepseek" });
  const taskProfiles = {};
  for (const id of MODEL_TASK_PROFILE_IDS) {
    const recommended = RECOMMENDED_TASK_PROFILES[id];
    taskProfiles[id] = normalizeTaskProfile(id, {
      ...recommended,
      preset: sharedCredential.preset,
      baseUrl: sharedCredential.baseUrl,
      provider: sharedCredential.provider,
      credentialRef: "shared"
    });
  }
  const settings = {
    schemaVersion: 2,
    credentialMode: "shared",
    sharedCredential,
    taskProfiles,
    independentCredentials: { deep_analysis: null, batch_screening: null },
    batchBackup: defaultBatchBackup(),
    revision: ""
  };
  settings.revision = settingsFingerprint(settings);
  return withPublicAliases(settings);
}

function defaultBatchBackup() {
  const preset = MODEL_PRESETS.deepseek;
  const basic = {
    enabled: false,
    credentialRef: "shared",
    preset: "deepseek",
    provider: preset.provider,
    baseUrl: preset.baseUrl,
    model: "deepseek-v4-pro",
    timeoutMs: 90000,
    thinkingMode: "disabled",
    reasoningEffort: "high"
  };
  const fingerprint = profileFingerprint(basic);
  return {
    ...basic,
    revision: fingerprint,
    connection: { status: "unverified", checkedAt: "", latencyMs: null, httpStatus: null, fingerprint }
  };
}

function settingsFromLegacyConfig(config = {}) {
  const provider = String(config.provider || "mock");
  if (provider === "mock") return defaultSettings();
  const legacy = config.providers?.openai_compatible || {};
  const baseUrl = normalizeBaseUrl(legacy.baseUrl);
  const preset = matchedPresetId(baseUrl);
  return normalizeSettings({
    preset,
    model: legacy.model || "",
    timeoutMs: legacy.timeoutMs,
    thinkingMode: legacy.thinkingMode,
    reasoningEffort: legacy.reasoningEffort
  });
}

function normalizeTaskProfile(id, raw = {}) {
  const presetId = normalizePresetId(raw.preset);
  const preset = MODEL_PRESETS[presetId];
  const isCustom = presetId === "custom";
  const model = String(raw.customModel || raw.model || preset.defaultModel || "").trim().slice(0, 160) || preset.defaultModel;
  const baseUrl = isCustom ? normalizeBaseUrl(raw.baseUrl) : normalizeBaseUrl(preset.baseUrl);
  if (preset.provider !== "mock" && !baseUrl) throw new Error("请填写兼容接口基础地址。");
  if (preset.provider !== "mock" && !model) throw new Error("请填写模型名称。");
  const supportsThinking = supportsDeepSeekV4Thinking(presetId, model);
  const basic = {
    preset: presetId,
    provider: preset.provider,
    baseUrl,
    model,
    timeoutMs: normalizeTimeout(raw.timeoutMs),
    thinkingMode: supportsThinking ? normalizeThinkingMode(raw.thinkingMode) : "disabled",
    reasoningEffort: supportsThinking ? normalizeReasoningEffort(raw.reasoningEffort) : "high",
    concurrency: normalizeConcurrency(raw.concurrency, id),
    credentialRef: normalizeCredentialRef(raw.credentialRef)
  };
  const fingerprint = profileFingerprint(basic);
  const connection = normalizeConnection(raw.connection, fingerprint);
  return {
    model: basic.model,
    timeoutMs: basic.timeoutMs,
    thinkingMode: basic.thinkingMode,
    reasoningEffort: basic.reasoningEffort,
    concurrency: basic.concurrency,
    credentialRef: basic.credentialRef,
    revision: fingerprint,
    connection
  };
}

function effectiveTaskProfile(settings, profileId) {
  const profile = settings?.taskProfiles?.[profileId];
  if (!profile) return null;
  const independent = profile.credentialRef === "independent" && settings.independentCredentials?.[profileId];
  const credential = independent || settings.sharedCredential || {};
  return {
    preset: credential.preset,
    provider: credential.provider,
    baseUrl: credential.baseUrl,
    model: profile.model,
    timeoutMs: profile.timeoutMs,
    thinkingMode: profile.thinkingMode,
    reasoningEffort: profile.reasoningEffort,
    concurrency: profile.concurrency,
    credentialRef: profile.credentialRef
  };
}

function normalizeProbeProfile(raw = {}) {
  const presetId = normalizePresetId(raw.preset);
  const preset = MODEL_PRESETS[presetId];
  const isCustom = presetId === "custom";
  const model = String(raw.customModel || raw.model || preset.defaultModel || "").trim().slice(0, 160) || preset.defaultModel;
  const baseUrl = isCustom ? normalizeBaseUrl(raw.baseUrl) : normalizeBaseUrl(preset.baseUrl);
  const supportsThinking = supportsDeepSeekV4Thinking(presetId, model);
  return {
    preset: presetId,
    provider: preset.provider,
    baseUrl,
    model,
    timeoutMs: normalizeTimeout(raw.timeoutMs),
    thinkingMode: supportsThinking ? normalizeThinkingMode(raw.thinkingMode) : "disabled",
    reasoningEffort: supportsThinking ? normalizeReasoningEffort(raw.reasoningEffort) : "high",
    concurrency: 1
  };
}

function withPublicAliases(settings) {
  const deep = effectiveTaskProfile(settings, "deep_analysis") || {};
  return {
    ...settings,
    preset: deep.preset || "custom",
    provider: deep.provider || "openai_compatible",
    baseUrl: deep.baseUrl || "",
    model: deep.model || "",
    timeoutMs: deep.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS,
    thinkingMode: deep.thinkingMode || "disabled",
    reasoningEffort: deep.reasoningEffort || "high",
    connection: settings.taskProfiles.deep_analysis.connection
  };
}

function normalizeTaskProfileId(value) {
  const id = String(value || "").trim();
  if (!MODEL_TASK_PROFILE_IDS.includes(id)) throw new Error("MODEL_TASK_PROFILE_INVALID");
  return id;
}

function normalizeConcurrency(value, id) {
  if (id !== "batch_screening") return 1;
  const number = Number(value);
  if (Number.isFinite(number)) return Math.max(1, Math.min(2, Math.round(number)));
  return RECOMMENDED_TASK_PROFILES.batch_screening.concurrency;
}

function normalizeCredentialRef(value) {
  const ref = String(value || "shared").trim().toLowerCase();
  if (!CREDENTIAL_REFS.has(ref)) throw new Error("MODEL_CREDENTIAL_REF_INVALID");
  return ref;
}

function normalizeCredential(raw = {}) {
  const presetId = normalizePresetId(raw.preset);
  const preset = MODEL_PRESETS[presetId];
  return {
    preset: presetId,
    provider: preset.provider,
    baseUrl: presetId === "custom" ? normalizeBaseUrl(raw.baseUrl) : normalizeBaseUrl(preset.baseUrl)
  };
}

function normalizeBatchBackup(raw = {}) {
  const presetId = raw.preset ? normalizePresetId(raw.preset) : "deepseek";
  const preset = MODEL_PRESETS[presetId];
  const isCustom = presetId === "custom";
  const model = String(raw.model || preset.defaultModel || "").trim().slice(0, 160);
  const baseUrl = isCustom ? normalizeBaseUrl(raw.baseUrl) : normalizeBaseUrl(preset.baseUrl);
  const supportsThinking = supportsDeepSeekV4Thinking(presetId, model);
  const basic = {
    enabled: Boolean(raw.enabled),
    credentialRef: normalizeCredentialRef(raw.credentialRef),
    preset: presetId,
    provider: preset.provider,
    baseUrl,
    model,
    timeoutMs: normalizeTimeout(raw.timeoutMs),
    thinkingMode: supportsThinking ? normalizeThinkingMode(raw.thinkingMode) : "disabled",
    reasoningEffort: supportsThinking ? normalizeReasoningEffort(raw.reasoningEffort) : "high"
  };
  const fingerprint = profileFingerprint(basic);
  const connection = normalizeConnection(raw.connection, fingerprint);
  return { ...basic, revision: fingerprint, connection };
}

function applyTaskProfileInput(settings, profileId, input = {}) {
  const result = normalizeSettings({ ...settings });
  const profile = result.taskProfiles[profileId];
  const independent = String(input.credentialRef || profile.credentialRef || "shared").trim().toLowerCase() === "independent";
  if (independent) {
    if (input.preset) {
      const presetId = normalizePresetId(input.preset);
      const preset = MODEL_PRESETS[presetId];
      const credential = {
        preset: presetId,
        provider: preset.provider,
        baseUrl: presetId === "custom" ? normalizeBaseUrl(input.baseUrl || profile.baseUrl) : normalizeBaseUrl(preset.baseUrl)
      };
      result.independentCredentials[profileId] = credential;
      profile.preset = credential.preset;
      profile.provider = credential.provider;
      profile.baseUrl = credential.baseUrl;
    } else if (input.baseUrl) {
      const current = result.independentCredentials[profileId] || result.sharedCredential;
      const credential = {
        preset: current.preset,
        provider: current.provider,
        baseUrl: normalizeBaseUrl(input.baseUrl)
      };
      result.independentCredentials[profileId] = credential;
      profile.preset = credential.preset;
      profile.provider = credential.provider;
      profile.baseUrl = credential.baseUrl;
    } else if (!result.independentCredentials[profileId]) {
      result.independentCredentials[profileId] = { ...result.sharedCredential };
      profile.preset = result.independentCredentials[profileId].preset;
      profile.provider = result.independentCredentials[profileId].provider;
      profile.baseUrl = result.independentCredentials[profileId].baseUrl;
    }
    profile.credentialRef = "independent";
  } else {
    profile.credentialRef = "shared";
    if (input.preset) {
      const presetId = normalizePresetId(input.preset);
      const preset = MODEL_PRESETS[presetId];
      result.sharedCredential = {
        preset: presetId,
        provider: preset.provider,
        baseUrl: presetId === "custom" ? normalizeBaseUrl(input.baseUrl || profile.baseUrl) : normalizeBaseUrl(preset.baseUrl)
      };
    } else if (input.baseUrl) {
      result.sharedCredential.baseUrl = normalizeBaseUrl(input.baseUrl);
    }
    result.independentCredentials[profileId] = null;
    profile.preset = result.sharedCredential.preset;
    profile.provider = result.sharedCredential.provider;
    profile.baseUrl = result.sharedCredential.baseUrl;
  }
  if (input.model !== undefined && input.model !== null) profile.model = String(input.model).trim().slice(0, 160);
  if (input.timeoutMs !== undefined && input.timeoutMs !== null) profile.timeoutMs = normalizeTimeout(input.timeoutMs);
  if (input.concurrency !== undefined && input.concurrency !== null) profile.concurrency = normalizeConcurrency(input.concurrency, profileId);
  const supportsThinking = supportsDeepSeekV4Thinking(profile.preset, profile.model);
  if (input.thinkingMode !== undefined && input.thinkingMode !== null && supportsThinking) {
    profile.thinkingMode = normalizeThinkingMode(input.thinkingMode);
  }
  if (input.reasoningEffort !== undefined && input.reasoningEffort !== null && supportsThinking) {
    profile.reasoningEffort = normalizeReasoningEffort(input.reasoningEffort);
  }
  if (!supportsThinking) {
    profile.thinkingMode = "disabled";
    profile.reasoningEffort = "high";
  }
  profile.connection = { status: "unverified", checkedAt: "", latencyMs: null, httpStatus: null, fingerprint: "" };
  profile.revision = profileFingerprint(profile);
  const finalized = normalizeSettings(result);
  finalized.revision = settingsFingerprint(finalized);
  return finalized;
}

function applySharedCredentialInput(settings, input = {}) {
  const result = normalizeSettings(settings);
  const presetId = normalizePresetId(input.preset || result.sharedCredential.preset);
  const preset = MODEL_PRESETS[presetId];
  result.sharedCredential = {
    preset: presetId,
    provider: preset.provider,
    baseUrl: presetId === "custom"
      ? normalizeBaseUrl(input.baseUrl || result.sharedCredential.baseUrl)
      : normalizeBaseUrl(preset.baseUrl)
  };
  for (const profileId of MODEL_TASK_PROFILE_IDS) {
    const profile = result.taskProfiles[profileId];
    if (profile.credentialRef !== "shared") continue;
    profile.preset = result.sharedCredential.preset;
    profile.provider = result.sharedCredential.provider;
    profile.baseUrl = result.sharedCredential.baseUrl;
    profile.connection = { status: "unverified", checkedAt: "", latencyMs: null, httpStatus: null, fingerprint: "" };
    profile.revision = profileFingerprint(profile);
  }
  result.revision = settingsFingerprint(result);
  return normalizeSettings(result);
}

function secretIdForSettings(settings = {}, taskProfile = "") {
  const normalized = normalizeSettings(settings);
  if (taskProfile) {
    const profileId = normalizeTaskProfileId(taskProfile);
    const profile = normalized.taskProfiles[profileId];
    if (!profile) return "";
    if (profile.credentialRef === "independent" && normalized.independentCredentials?.[profileId]) {
      return secretIdForCredential(`model-api-key-${profileId}`, normalized.independentCredentials[profileId]);
    }
    if (profile.credentialRef === "independent") return "";
    return secretIdForCredential("model-api-key-shared", normalized.sharedCredential);
  }
  const primary = normalized.taskProfiles.deep_analysis;
  if (!primary) return "";
  if (primary.credentialRef === "independent" && normalized.independentCredentials?.deep_analysis) {
    return secretIdForCredential("model-api-key-deep_analysis", normalized.independentCredentials.deep_analysis);
  }
  if (primary.credentialRef === "independent") return "";
  return secretIdForCredential("model-api-key-shared", normalized.sharedCredential);
}

function secretIdForBatchBackup(settings, backup) {
  if (!backup || backup.provider === "mock") return "";
  return secretIdForCredential("model-api-key-batch_backup", backup);
}

function secretIdForCredential(prefix, credential) {
  if (!credential || credential.provider === "mock") return "";
  const safePrefix = String(prefix || "").replace(/_/g, "-");
  if (credential.preset && credential.preset !== "custom") return `${safePrefix}-${credential.preset}`;
  const hash = crypto.createHash("sha256").update(String(credential.baseUrl || "custom")).digest("hex").slice(0, 12);
  return `${safePrefix}-custom-${hash}`;
}

function migrateLegacySecret(root, settings) {
  const targetId = secretIdForSettings(settings);
  const legacyPresetId = legacySecretIdForSettings(settings);
  if (!targetId || !legacyPresetId || hasSecret(root, targetId) || !hasSecret(root, legacyPresetId)) return "";
  try {
    const value = loadSecret(root, legacyPresetId);
    if (!value) return "SECRET_EMPTY";
    saveSecret(root, targetId, value);
    return "";
  } catch {
    return "SECRET_UNREADABLE";
  }
}

function legacySecretIdForSettings(settings) {
  const primary = settings.taskProfiles?.deep_analysis;
  const effective = primary ? effectiveTaskProfile(settings, "deep_analysis") : null;
  if (!effective || effective.provider === "mock") return "";
  if (effective.preset && effective.preset !== "custom") return `model-api-key-${effective.preset}`;
  const hash = crypto.createHash("sha256").update(String(effective.baseUrl || "custom")).digest("hex").slice(0, 12);
  return `model-api-key-custom-${hash}`;
}

function profileFingerprint(profile = {}) {
  return crypto.createHash("sha256").update([
    profile.provider,
    profile.baseUrl,
    profile.model,
    profile.thinkingMode,
    profile.reasoningEffort,
    profile.timeoutMs,
    profile.concurrency
  ].join("|")).digest("hex").slice(0, 64);
}

function legacyProfileFingerprint(profile = {}) {
  return crypto.createHash("sha256").update([
    profile.provider,
    profile.baseUrl,
    profile.model,
    profile.thinkingMode,
    profile.reasoningEffort
  ].join("|")).digest("hex").slice(0, 20);
}

function settingsFingerprint(settings) {
  const parts = [
    settings.credentialMode,
    settings.sharedCredential?.provider,
    settings.sharedCredential?.baseUrl,
    settings.sharedCredential?.preset
  ];
  for (const id of MODEL_TASK_PROFILE_IDS) {
    const profile = settings.taskProfiles?.[id] || {};
    const credential = profile.credentialRef === "independent" && settings.independentCredentials?.[id]
      ? settings.independentCredentials[id]
      : settings.sharedCredential || {};
    parts.push(
      id,
      credential.provider,
      credential.baseUrl,
      credential.preset,
      profile.model,
      profile.thinkingMode,
      profile.reasoningEffort,
      profile.timeoutMs,
      profile.concurrency,
      profile.credentialRef
    );
  }
  const backup = settings.batchBackup || {};
  parts.push("backup", backup.enabled, backup.provider, backup.baseUrl, backup.model, backup.thinkingMode, backup.reasoningEffort, backup.timeoutMs, backup.credentialRef);
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex");
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

function modelConfigFromProfile(profile, apiKey = "", apiKeyEnv = "ZHIPPING_MODEL_API_KEY") {
  if (profile.provider === "mock") return { provider: "mock", providers: { mock: { model: profile.model || "offline-structured-mock" } } };
  return {
    provider: "openai_compatible",
    providers: {
      openai_compatible: {
        baseUrl: profile.baseUrl,
        model: profile.model,
        timeoutMs: profile.timeoutMs,
        thinkingMode: profile.thinkingMode,
        reasoningEffort: profile.reasoningEffort,
        apiKey: apiKey || "",
        apiKeyEnv
      }
    }
  };
}

function normalizeThinkingMode(value, fallback = "disabled") {
  const normalized = String(value || fallback).trim().toLowerCase();
  if (!THINKING_MODES.has(normalized)) throw new Error("MODEL_THINKING_MODE_INVALID");
  return normalized;
}

function normalizeReasoningEffort(value, fallback = "high") {
  const normalized = String(value || fallback).trim().toLowerCase();
  if (!REASONING_EFFORTS.has(normalized)) throw new Error("MODEL_REASONING_EFFORT_INVALID");
  return normalized;
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

function normalizePresetId(value) {
  const id = String(value || "").trim();
  return MODEL_PRESETS[id] ? id : "custom";
}

function matchedPresetId(baseUrl) {
  const matched = Object.values(MODEL_PRESETS).find((preset) => preset.provider === "openai_compatible" && preset.baseUrl === baseUrl);
  return matched ? matched.id : "custom";
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

function isMockFallback(config = {}) {
  return String(config.provider || "mock") === "mock";
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

function modelFingerprint(value = {}) {
  const normalized = normalizeSettings(value);
  return legacyProfileFingerprint(effectiveTaskProfile(normalized, "deep_analysis") || {});
}

module.exports = {
  SECRET_ID,
  SETTINGS_SCHEMA_VERSION,
  listModelPresets,
  listModelTaskProfiles,
  loadModelSettings,
  saveModelSettings,
  saveModelTaskProfileParameters,
  saveVerifiedPrimaryModelProfiles,
  saveVerifiedModelConfiguration,
  saveVerifiedModelTaskProfile,
  saveVerifiedBatchBackup,
  restoreRecommendedTaskProfile,
  resolveReadOnlyModelSettingsRoot,
  testModelConnection,
  resolveRuntimeModelConfig,
  resolveRuntimeBatchBackup,
  isModelReady,
  modelConfigFromSettings,
  normalizeSettings,
  normalizeThinkingMode,
  normalizeReasoningEffort,
  supportsDeepSeekV4Thinking,
  secretIdForSettings,
  modelFingerprint,
  settingsPath
};
