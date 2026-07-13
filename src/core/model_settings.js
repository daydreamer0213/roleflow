const fs = require("node:fs");
const path = require("node:path");
const { hasSecret, loadSecret } = require("./secret_store");

const SETTINGS_RELATIVE_PATH = path.join(".runtime", "settings", "model.json");
const SECRET_ID = "model-api-key";

const MODEL_PRESETS = {
  mock: {
    id: "mock",
    label: "离线 Mock",
    provider: "mock",
    baseUrl: "",
    models: ["offline-structured-mock"],
    defaultModel: "offline-structured-mock",
    requiresKey: false
  },
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
  }
};

function listModelPresets() {
  return Object.values(MODEL_PRESETS).map((preset) => ({
    id: preset.id,
    label: preset.label,
    provider: preset.provider,
    baseUrl: preset.baseUrl,
    models: [...preset.models],
    defaultModel: preset.defaultModel,
    requiresKey: preset.requiresKey
  }));
}

function loadModelSettings({ root, fallbackModelConfig }) {
  const file = settingsPath(root);
  const stored = readJson(file);
  const source = stored ? "runtime" : "legacy";
  const settings = normalizeSettings(stored || settingsFromLegacyConfig(fallbackModelConfig));
  return {
    source,
    settings,
    keyConfigured: hasSecret(root, SECRET_ID),
    modelConfig: modelConfigFromSettings(settings, "", source === "legacy" ? legacyApiKeyEnv(fallbackModelConfig) : "ZHIPPING_MODEL_API_KEY")
  };
}

function saveModelSettings({ root, input, fallbackModelConfig }) {
  const current = loadModelSettings({ root, fallbackModelConfig }).settings;
  const settings = normalizeSettings({ ...current, ...input });
  const file = settingsPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, settings);
  return settings;
}

function resolveRuntimeModelConfig({ root, fallbackModelConfig }) {
  const loaded = loadModelSettings({ root, fallbackModelConfig });
  if (loaded.settings.provider === "mock") {
    return { ...loaded, modelConfig: modelConfigFromSettings(loaded.settings) };
  }
  const apiKey = loadSecret(root, SECRET_ID);
  const apiKeyEnv = loaded.source === "legacy" ? legacyApiKeyEnv(fallbackModelConfig) : "ZHIPPING_MODEL_API_KEY";
  return {
    ...loaded,
    modelConfig: modelConfigFromSettings(loaded.settings, apiKey, apiKeyEnv)
  };
}

function isModelReady(modelState) {
  if (!modelState?.settings) return false;
  if (modelState.settings.provider === "mock") return modelState.source === "runtime";
  return Boolean(modelState.keyConfigured);
}

function modelConfigFromSettings(settings, apiKey = "", apiKeyEnv = "ZHIPPING_MODEL_API_KEY") {
  if (settings.provider === "mock") {
    return {
      provider: "mock",
      providers: {
        mock: { model: settings.model || "offline-structured-mock" }
      }
    };
  }
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
  const baseUrl = isCustom
    ? normalizeBaseUrl(raw.baseUrl)
    : normalizeBaseUrl(preset.baseUrl);
  if (preset.provider !== "mock" && !baseUrl) throw new Error("请填写兼容接口基础地址。");
  if (preset.provider !== "mock" && !model) throw new Error("请填写模型名称。");
  return {
    preset: presetId,
    provider: preset.provider,
    baseUrl,
    model,
    timeoutMs: normalizeTimeout(raw.timeoutMs)
  };
}

function settingsFromLegacyConfig(config = {}) {
  const provider = String(config.provider || "mock");
  if (provider === "mock") return { preset: "mock" };
  const legacy = config.providers?.openai_compatible || {};
  const baseUrl = normalizeBaseUrl(legacy.baseUrl);
  const matched = Object.values(MODEL_PRESETS).find((preset) => preset.provider === "openai_compatible" && preset.baseUrl === baseUrl);
  return {
    preset: matched ? matched.id : "custom",
    baseUrl,
    model: legacy.model || "",
    timeoutMs: legacy.timeoutMs
  };
}

function legacyApiKeyEnv(config = {}) {
  return String(config.providers?.openai_compatible?.apiKeyEnv || "OPENAI_API_KEY");
}

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("接口地址必须是有效的 http 或 https URL。");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("接口地址必须使用 http 或 https。");
  return raw;
}

function normalizeTimeout(value) {
  const number = Number(value || 30000);
  if (!Number.isFinite(number)) return 30000;
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

function writeJsonAtomic(file, data) {
  const temp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(temp, file);
}

module.exports = {
  SECRET_ID,
  listModelPresets,
  loadModelSettings,
  saveModelSettings,
  resolveRuntimeModelConfig,
  isModelReady,
  modelConfigFromSettings,
  normalizeSettings,
  settingsPath
};
