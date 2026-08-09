const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { secretPath, hasSecret, saveSecret, loadSecret } = require("../src/core/secret_store");
const {
  listModelPresets,
  loadModelSettings,
  saveVerifiedModelConfiguration,
  testModelConnection,
  resolveReadOnlyModelSettingsRoot,
  resolveRuntimeModelConfig,
  resolveRuntimeBatchBackup,
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
    readOnlySchemaRequiredSmoke();
    await readOnlyRootSmoke();
    readOnlyLegacySecretSmoke();
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

async function readOnlyRootSmoke() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "zhiping-readonly-root-"));
  try {
    const homeRoot = path.join(sandbox, "home");
    const tempRoot = path.join(sandbox, "temp");
    const externalRoot = path.join(sandbox, "external");
    const v1Root = path.join(sandbox, "v1");
    const emptyRoot = path.join(sandbox, "empty");
    const missingRoot = path.join(sandbox, "missing");
    fs.mkdirSync(homeRoot);
    fs.mkdirSync(tempRoot);
    fs.mkdirSync(emptyRoot);
    writeFixtureSettings(externalRoot, {
      schemaVersion: 2,
      sharedCredential: { preset: "mock" },
      taskProfiles: {
        deep_analysis: { model: "offline-structured-mock", credentialRef: "shared" },
        batch_screening: { model: "offline-structured-mock", credentialRef: "shared" }
      },
      batchBackup: { enabled: false }
    });
    writeFixtureSettings(v1Root, {
      schemaVersion: 1,
      preset: "mock",
      model: "offline-structured-mock"
    });

    const worktreeRoot = path.resolve(__dirname, "..");
    const options = { worktreeRoot, homeRoot, tempRoot };

    const resolved = resolveReadOnlyModelSettingsRoot(externalRoot, options);
    assert.strictEqual(resolved, fs.realpathSync(externalRoot), "valid external root must resolve to its canonical path");

    assertRootError("relative/model-settings", options, "MODEL_SETTINGS_ROOT_INVALID");
    assertRootError("https://example.com/model-settings", options, "MODEL_SETTINGS_ROOT_INVALID");
    assertRootError(worktreeRoot, options, "MODEL_SETTINGS_ROOT_WORKTREE");
    assertRootError(homeRoot, options, "MODEL_SETTINGS_ROOT_PROTECTED");
    assertRootError(tempRoot, options, "MODEL_SETTINGS_ROOT_PROTECTED");
    assertRootError(emptyRoot, options, "MODEL_SETTINGS_ROOT_MISSING_SETTINGS");
    assertRootError(missingRoot, options, "MODEL_SETTINGS_ROOT_NOT_FOUND");
    assertRootError("\\\\192.168.1.10\\share\\model-settings", options, "MODEL_SETTINGS_ROOT_INVALID");
    assertRootError("//192.168.1.10/share/model-settings", options, "MODEL_SETTINGS_ROOT_INVALID");
    assertRootError(path.normalize("//192.168.1.10/share/model-settings"), options, "MODEL_SETTINGS_ROOT_INVALID");
    assertRootError("\\\\?\\UNC\\192.168.1.10\\share\\model-settings", options, "MODEL_SETTINGS_ROOT_INVALID");

    const dirSettingsRoot = path.join(sandbox, "dir-settings");
    fs.mkdirSync(path.join(dirSettingsRoot, ".runtime", "settings", "model.json"), { recursive: true });
    assertRootError(dirSettingsRoot, options, "MODEL_SETTINGS_ROOT_SETTINGS_NOT_FILE");

    const rootLink = path.join(sandbox, "root-link");
    fs.symlinkSync(externalRoot, rootLink, "junction");
    assertRootError(rootLink, options, "MODEL_SETTINGS_ROOT_INVALID");

    const settingsLink = createSettingsPathLink(sandbox, externalRoot);
    assertRootError(settingsLink.root, options, "MODEL_SETTINGS_ROOT_SETTINGS_NOT_FILE");

    const v1Hash = fileHash(settingsPath(v1Root));
    assert.throws(
      () => loadModelSettings({ root: v1Root, fallbackModelConfig: fallback, readOnly: true }),
      (error) => error.code === "MODEL_SETTINGS_READ_ONLY_MIGRATION_REQUIRED"
    );
    assert.strictEqual(fileHash(settingsPath(v1Root)), v1Hash, "read-only load must not rewrite the schema-v1 fixture");
    assert.throws(
      () => resolveRuntimeModelConfig({ root: v1Root, fallbackModelConfig: fallback, readOnly: true }),
      (error) => error.code === "MODEL_SETTINGS_READ_ONLY_MIGRATION_REQUIRED"
    );
    assert.throws(
      () => resolveRuntimeBatchBackup({ root: v1Root, fallbackModelConfig: fallback, readOnly: true }),
      (error) => error.code === "MODEL_SETTINGS_READ_ONLY_MIGRATION_REQUIRED"
    );
    assert.strictEqual(
      loadModelSettings({ root: v1Root, fallbackModelConfig: fallback }).source,
      "migrated_v1",
      "default writable loading must keep legacy migration behavior"
    );
    assert.strictEqual(
      loadModelSettings({ root: externalRoot, fallbackModelConfig: fallback, readOnly: true }).source,
      "runtime",
      "read-only schema-v2 loading must still succeed"
    );
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

function writeFixtureSettings(root, data) {
  const file = settingsPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
  return file;
}

function fileHash(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function assertRootError(rawRoot, options, code) {
  assert.throws(
    () => resolveReadOnlyModelSettingsRoot(rawRoot, options),
    (error) => error.code === code
  );
}

function createSettingsPathLink(sandbox, sourceRoot) {
  const linkedRoot = path.join(sandbox, "settings-link-root");
  fs.mkdirSync(linkedRoot, { recursive: true });
  fs.mkdirSync(path.join(linkedRoot, ".runtime"));
  const sourceFile = settingsPath(sourceRoot);
  const linkFile = path.join(linkedRoot, ".runtime", "settings", "model.json");
  try {
    fs.mkdirSync(path.dirname(linkFile), { recursive: true });
    fs.symlinkSync(sourceFile, linkFile, "file");
    return { root: linkedRoot, kind: "file-symlink" };
  } catch (error) {
    if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
    fs.rmSync(path.dirname(linkFile), { recursive: true, force: true });
    fs.symlinkSync(
      path.join(sourceRoot, ".runtime", "settings"),
      path.join(linkedRoot, ".runtime", "settings"),
      "junction"
    );
    return { root: linkedRoot, kind: "settings-junction" };
  }
}

function assertReadOnlyRejections(root, fallbackModelConfig, code, label, before) {
  assert.throws(
    () => loadModelSettings({ root, fallbackModelConfig, readOnly: true }),
    (error) => error.code === code,
    `${label} read-only load must reject before fallback`
  );
  assert.throws(
    () => resolveRuntimeModelConfig({ root, fallbackModelConfig, readOnly: true }),
    (error) => error.code === code,
    `${label} read-only runtime config must reject before fallback`
  );
  assert.throws(
    () => resolveRuntimeBatchBackup({ root, fallbackModelConfig, readOnly: true }),
    (error) => error.code === code,
    `${label} read-only batch backup must reject before fallback`
  );
  assert.deepStrictEqual(
    settingsAndSecretsSnapshot(root),
    before,
    `${label} read-only rejection must not change settings or secrets`
  );
}

function readOnlySchemaRequiredSmoke() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "zhiping-readonly-schema-"));
  try {
    const nonMockFallback = {
      provider: "openai_compatible",
      providers: {
        openai_compatible: {
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-v4-pro",
          apiKeyEnv: "TEST_READONLY_MODEL_API_KEY"
        }
      }
    };
    const cases = [
      { name: "missing", prepare: () => {}, writable: "legacy" },
      { name: "json-null", prepare: (root) => writeFixtureSettings(root, null), writable: "legacy" },
      { name: "json-false", prepare: (root) => writeFixtureSettings(root, false), writable: "legacy" },
      { name: "json-string", prepare: (root) => writeFixtureSettings(root, "not-an-object"), writable: "legacy" },
      {
        name: "schema-v1",
        prepare: (root) => writeFixtureSettings(root, {
          schemaVersion: 1,
          preset: "mock",
          model: "offline-structured-mock"
        }),
        code: "MODEL_SETTINGS_READ_ONLY_MIGRATION_REQUIRED",
        writable: "migrated_v1"
      },
      {
        name: "legacy-v1-no-schema-version",
        prepare: (root) => writeFixtureSettings(root, {
          preset: "deepseek",
          provider: "openai_compatible",
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-v4-pro",
          timeoutMs: 60000,
          thinkingMode: "enabled",
          reasoningEffort: "max"
        }),
        code: "MODEL_SETTINGS_READ_ONLY_MIGRATION_REQUIRED",
        writable: "migrated_v1"
      },
      {
        name: "schema-v2-missing-task-profiles",
        prepare: (root) => writeFixtureSettings(root, { schemaVersion: 2, sharedCredential: { preset: "mock" } })
      },
      {
        name: "schema-version-string",
        prepare: (root) => writeFixtureSettings(root, {
          schemaVersion: "2",
          sharedCredential: { preset: "mock" },
          taskProfiles: {
            deep_analysis: { model: "offline-structured-mock", credentialRef: "shared" },
            batch_screening: { model: "offline-structured-mock", credentialRef: "shared" }
          }
        })
      },
      {
        name: "schema-v2-task-profiles-null",
        prepare: (root) => writeFixtureSettings(root, {
          schemaVersion: 2,
          sharedCredential: { preset: "mock" },
          taskProfiles: null
        })
      },
      {
        name: "schema-v2-task-profiles-array",
        prepare: (root) => writeFixtureSettings(root, {
          schemaVersion: 2,
          sharedCredential: { preset: "mock" },
          taskProfiles: []
        })
      },
      {
        name: "schema-v2-task-profiles-string",
        prepare: (root) => writeFixtureSettings(root, {
          schemaVersion: 2,
          sharedCredential: { preset: "mock" },
          taskProfiles: "not-an-object"
        })
      },
      {
        name: "schema-v2-task-profiles-empty",
        prepare: (root) => writeFixtureSettings(root, {
          schemaVersion: 2,
          sharedCredential: { preset: "mock" },
          taskProfiles: {}
        })
      },
      {
        name: "schema-v2-task-profiles-partial",
        prepare: (root) => writeFixtureSettings(root, {
          schemaVersion: 2,
          sharedCredential: { preset: "mock" },
          taskProfiles: {
            deep_analysis: { model: "offline-structured-mock", credentialRef: "shared" }
          }
        })
      },
      {
        name: "json-malformed",
        prepare: (root) => {
          fs.mkdirSync(path.dirname(settingsPath(root)), { recursive: true });
          fs.writeFileSync(settingsPath(root), "{ not json", "utf8");
        },
        writable: "read-error"
      },
      { name: "json-array", prepare: (root) => writeFixtureSettings(root, []), writable: "array-format-error" }
    ];

    for (const item of cases) {
      const root = path.join(sandbox, item.name);
      fs.mkdirSync(root, { recursive: true });
      item.prepare(root);
      saveSecret(root, "model-api-key-deepseek", "synthetic-readonly-non-object-value");
      const before = settingsAndSecretsSnapshot(root);

      assertReadOnlyRejections(
        root,
        nonMockFallback,
        item.code || "MODEL_SETTINGS_READ_ONLY_SCHEMA_REQUIRED",
        item.name,
        before
      );

      if (item.writable === "legacy") {
        const writable = loadModelSettings({ root, fallbackModelConfig: nonMockFallback });
        assert.strictEqual(writable.source, "legacy", `${item.name} default writable load must keep legacy fallback`);
      } else if (item.writable === "array-format-error") {
        assert.throws(
          () => loadModelSettings({ root, fallbackModelConfig: nonMockFallback }),
          (error) => !error.code && /对象/.test(error.message),
          `${item.name} writable load must keep the explicit array format error`
        );
      } else if (item.writable === "read-error") {
        assert.throws(
          () => loadModelSettings({ root, fallbackModelConfig: nonMockFallback }),
          (error) => !error.code && /无法读取/.test(error.message),
          `${item.name} writable load must keep the generic malformed-JSON error`
        );
      } else if (item.writable === "migrated_v1") {
        const writable = loadModelSettings({ root, fallbackModelConfig: nonMockFallback });
        assert.strictEqual(writable.source, "migrated_v1", `${item.name} writable load must keep v1 migration`);
      }
    }

    const mixedRoot = path.join(sandbox, "mixed-v2-v1-fields");
    writeFixtureSettings(mixedRoot, {
      schemaVersion: 2,
      preset: "mock",
      model: "offline-structured-mock",
      sharedCredential: { preset: "mock" },
      taskProfiles: {
        deep_analysis: { model: "offline-structured-mock", credentialRef: "shared" },
        batch_screening: { model: "offline-structured-mock", credentialRef: "shared" }
      },
      batchBackup: { enabled: false }
    });
    const mixed = loadModelSettings({ root: mixedRoot, fallbackModelConfig: nonMockFallback, readOnly: true });
    assert.strictEqual(mixed.source, "runtime", "a schema-v2 object with legacy alias fields must stay runtime");
    assert.strictEqual(mixed.settings.schemaVersion, 2, "mixed v2/v1 fields must normalize as schema v2");
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

function settingsAndSecretsSnapshot(root) {
  const file = settingsPath(root);
  return {
    settings: fs.existsSync(file) ? fileHash(file) : null,
    secrets: secretFilesSnapshot(root)
  };
}

function readOnlyLegacySecretSmoke() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "zhiping-readonly-secret-"));
  try {
    const legacyRoot = path.join(sandbox, "legacy-secret");
    writeFixtureSettings(legacyRoot, {
      schemaVersion: 1,
      preset: "deepseek",
      model: "deepseek-v4-pro"
    });
    const legacySecretId = "model-api-key-deepseek";
    const targetSecretId = secretIdForSettings({
      schemaVersion: 1,
      preset: "deepseek",
      model: "deepseek-v4-pro"
    });
    const syntheticSecret = "synthetic-readonly-fix-value";
    saveSecret(legacyRoot, legacySecretId, syntheticSecret);

    assert.strictEqual(hasSecret(legacyRoot, legacySecretId), true, "legacy secret fixture must exist");
    assert.strictEqual(hasSecret(legacyRoot, targetSecretId), false, "target secret must be absent before read-only load");
    const settingsHashBefore = fileHash(settingsPath(legacyRoot));
    const secretsBefore = secretFilesSnapshot(legacyRoot);
    assert.strictEqual(secretsBefore.length, 1, "fixture must contain exactly one legacy secret file");

    assert.throws(
      () => loadModelSettings({ root: legacyRoot, fallbackModelConfig: fallback, readOnly: true }),
      (error) => error.code === "MODEL_SETTINGS_READ_ONLY_MIGRATION_REQUIRED"
    );
    assert.strictEqual(fileHash(settingsPath(legacyRoot)), settingsHashBefore, "read-only load must not rewrite settings");
    assert.deepStrictEqual(secretFilesSnapshot(legacyRoot), secretsBefore, "read-only load must not change secret files");
    assert.strictEqual(hasSecret(legacyRoot, targetSecretId), false, "read-only load must not create the target secret");

    const writable = loadModelSettings({ root: legacyRoot, fallbackModelConfig: fallback });
    assert.strictEqual(writable.source, "migrated_v1");
    assert.strictEqual(hasSecret(legacyRoot, targetSecretId), true, "writable load must migrate the legacy synthetic secret");
    assert.strictEqual(loadSecret(legacyRoot, targetSecretId), syntheticSecret, "migrated secret must equal the synthetic value");
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

function secretFilesSnapshot(root) {
  const dir = path.join(root, ".runtime", "secrets");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".dpapi"))
    .sort()
    .map((name) => {
      const file = path.join(dir, name);
      return {
        name,
        bytes: fs.statSync(file).size,
        hash: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
      };
    });
}
