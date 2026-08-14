const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { secretPath, saveSecret, loadSecret } = require("../src/core/secret_store");
const {
  listModelTaskProfiles,
  loadModelSettings,
  resolveRuntimeModelConfig,
  resolveRuntimeBatchBackup,
  isModelReady,
  saveModelTaskProfileParameters,
  saveVerifiedPrimaryModelProfiles,
  saveVerifiedModelTaskProfile,
  saveVerifiedBatchBackup,
  restoreRecommendedTaskProfile,
  secretIdForSettings,
  settingsPath,
  testModelConnection,
  modelFingerprint,
  normalizeSettings
} = require("../src/core/model_settings");

const fallback = { provider: "mock", providers: { mock: { model: "offline-structured-mock" } } };
const verified = async () => ({ status: "verified", checkedAt: new Date().toISOString(), latencyMs: 8, httpStatus: 200 });

(async () => {
  await newInstallDefaultsSmoke();
  await v1MigrationSmoke();
  await legacyFallbackSmoke();
  await taskRoutingAndReadinessSmoke();
  await primaryProfilesAtomicVerificationSmoke();
  await independentCredentialsAndBackupSmoke();
  console.log("model_task_profiles_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function newInstallDefaultsSmoke() {
  const root = tempRoot("zhiping-profiles-new-");
  try {
    const state = loadModelSettings({ root, fallbackModelConfig: fallback });
    assert.strictEqual(state.source, "new_install");
    assert.strictEqual(state.settings.schemaVersion, 2);
    assert.strictEqual(state.settings.credentialMode, "shared");
    assert.deepStrictEqual(state.settings.taskProfiles.deep_analysis, {
      model: "deepseek-v4-pro",
      timeoutMs: 120000,
      thinkingMode: "enabled",
      reasoningEffort: "high",
      concurrency: 1,
      credentialRef: "shared",
      connection: state.settings.taskProfiles.deep_analysis.connection,
      revision: state.settings.taskProfiles.deep_analysis.revision
    });
    assert.strictEqual(state.settings.taskProfiles.deep_analysis.revision.length, 64);
    assert.strictEqual(state.settings.taskProfiles.batch_screening.model, "deepseek-v4-flash");
    assert.strictEqual(state.settings.taskProfiles.batch_screening.timeoutMs, 90000);
    assert.strictEqual(state.settings.taskProfiles.batch_screening.thinkingMode, "disabled");
    assert.strictEqual(state.settings.taskProfiles.batch_screening.reasoningEffort, "high");
    assert.strictEqual(state.settings.taskProfiles.batch_screening.concurrency, 2);
    assert.strictEqual(state.settings.taskProfiles.batch_screening.revision.length, 64);
    assert.strictEqual(state.settings.batchBackup.enabled, false);
    assert.strictEqual(state.settings.taskProfiles.deep_analysis.connection.status, "unverified");
    assert.strictEqual(state.settings.taskProfiles.batch_screening.connection.status, "unverified");
    assert(!fs.existsSync(settingsPath(root)), "loading defaults must not write a settings file");
    assert(!JSON.stringify(state.settings).includes("apiKey"));

    const profiles = listModelTaskProfiles();
    assert.deepStrictEqual(profiles.map((item) => item.id), ["deep_analysis", "batch_screening"]);
    const deep = profiles.find((item) => item.id === "deep_analysis");
    assert.strictEqual(deep.recommended.model, "deepseek-v4-pro");
    assert.strictEqual(deep.recommended.timeoutMs, 120000);
    assert.strictEqual(deep.recommended.thinkingMode, "enabled");
    assert.strictEqual(deep.recommended.concurrency, 1);
    const batch = profiles.find((item) => item.id === "batch_screening");
    assert.strictEqual(batch.recommended.model, "deepseek-v4-flash");
    assert.strictEqual(batch.recommended.timeoutMs, 90000);
    assert.strictEqual(batch.recommended.thinkingMode, "disabled");
    assert.strictEqual(batch.recommended.concurrency, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function v1MigrationSmoke() {
  const root = tempRoot("zhiping-profiles-v1-");
  try {
    const oldFingerprint = modelFingerprint(normalizeSettings({
      preset: "deepseek",
      model: "deepseek-v4-pro",
      timeoutMs: 60000,
      thinkingMode: "enabled",
      reasoningEffort: "max"
    }));
    saveSecret(root, "model-api-key-deepseek", "v1-secret-not-plain");
    fs.mkdirSync(path.dirname(settingsPath(root)), { recursive: true });
    fs.writeFileSync(settingsPath(root), JSON.stringify({
      preset: "deepseek",
      provider: "openai_compatible",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
      timeoutMs: 60000,
      thinkingMode: "enabled",
      reasoningEffort: "max",
      connection: {
        status: "verified",
        checkedAt: "2026-08-01T00:00:00.000Z",
        latencyMs: 15,
        httpStatus: 200,
        fingerprint: oldFingerprint
      }
    }, null, 2));

    const migrated = loadModelSettings({ root, fallbackModelConfig: fallback });
    assert.strictEqual(migrated.source, "migrated_v1");
    assert.strictEqual(migrated.settings.schemaVersion, 2);
    for (const profile of Object.values(migrated.settings.taskProfiles)) {
      assert.strictEqual(profile.model, "deepseek-v4-pro");
      assert.strictEqual(profile.timeoutMs, 60000);
      assert.strictEqual(profile.thinkingMode, "enabled");
      assert.strictEqual(profile.reasoningEffort, "max");
      assert.strictEqual(profile.credentialRef, "shared");
    }
    assert.notStrictEqual(migrated.settings.taskProfiles.batch_screening.model, "deepseek-v4-flash");
    assert.strictEqual(migrated.settings.taskProfiles.deep_analysis.connection.status, "verified");
    assert.strictEqual(migrated.settings.taskProfiles.batch_screening.connection.status, "verified");
    assert.notStrictEqual(migrated.settings.taskProfiles.deep_analysis.connection.fingerprint, oldFingerprint);

    const sharedSecretId = secretIdForSettings(migrated.settings);
    assert.strictEqual(sharedSecretId, "model-api-key-shared-deepseek");
    assert.strictEqual(loadSecret(root, sharedSecretId), "v1-secret-not-plain");
    assert.strictEqual(isModelReady(migrated, { taskProfile: "deep_analysis" }), true);
    const publicText = fs.readFileSync(settingsPath(root), "utf8");
    assert(!publicText.includes("v1-secret-not-plain"), "migration must not expose plaintext in settings JSON");
    assert(!publicText.includes("schemaVersion"), "loading a v1 file must not rewrite it");
    assert(fs.existsSync(secretPath(root, "model-api-key-deepseek")), "legacy secret must be kept as a rollback artifact");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function legacyFallbackSmoke() {
  const root = tempRoot("zhiping-profiles-legacy-");
  try {
    const legacyFallback = {
      provider: "openai_compatible",
      providers: {
        openai_compatible: {
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-v4-pro",
          timeoutMs: 60000,
          thinkingMode: "enabled",
          reasoningEffort: "max",
          apiKeyEnv: "DEEPSEEK_TEST_ENV"
        }
      }
    };
    const state = loadModelSettings({ root, fallbackModelConfig: legacyFallback });
    assert.strictEqual(state.source, "legacy");
    assert.strictEqual(state.settings.schemaVersion, 2);
    for (const profile of Object.values(state.settings.taskProfiles)) {
      assert.strictEqual(profile.model, "deepseek-v4-pro");
      assert.strictEqual(profile.timeoutMs, 60000);
      assert.strictEqual(profile.thinkingMode, "enabled");
      assert.strictEqual(profile.reasoningEffort, "max");
    }
    assert.notStrictEqual(state.settings.taskProfiles.batch_screening.model, "deepseek-v4-flash");
    assert(!fs.existsSync(settingsPath(root)), "loading legacy config must not write a settings file");
    assert.strictEqual(state.modelConfig.providers.openai_compatible.apiKeyEnv, "DEEPSEEK_TEST_ENV");
    assert.strictEqual(isModelReady(state), false);
    assert.strictEqual(state.settings.taskProfiles.deep_analysis.connection.status, "unverified");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function taskRoutingAndReadinessSmoke() {
  const root = tempRoot("zhiping-profiles-routing-");
  try {
    let state = await saveVerifiedModelTaskProfile({
      root,
      taskProfile: "deep_analysis",
      fallbackModelConfig: fallback,
      connectionTester: verified,
      input: {
        preset: "deepseek",
        model: "deepseek-v4-pro",
        timeoutMs: 120000,
        thinkingMode: "enabled",
        reasoningEffort: "high",
        concurrency: 1,
        apiKey: "routing-key-not-public"
      }
    });
    assert.strictEqual(state.source, "runtime");
    assert.strictEqual(state.settings.schemaVersion, 2);
    assert.strictEqual(isModelReady(state, { taskProfile: "deep_analysis" }), true);
    assert.strictEqual(isModelReady(state, { taskProfile: "batch_screening" }), false);

    state = await saveVerifiedModelTaskProfile({
      root,
      taskProfile: "batch_screening",
      fallbackModelConfig: fallback,
      connectionTester: verified,
      input: {
        model: "deepseek-v4-flash",
        timeoutMs: 90000,
        thinkingMode: "disabled",
        reasoningEffort: "high",
        concurrency: 2
      }
    });
    assert.strictEqual(isModelReady(state, { taskProfile: "deep_analysis" }), true);
    assert.strictEqual(isModelReady(state, { taskProfile: "batch_screening" }), true);

    const deep = resolveRuntimeModelConfig({ root, fallbackModelConfig: fallback, taskProfile: "deep_analysis" });
    assert.strictEqual(deep.modelConfig.providers.openai_compatible.model, "deepseek-v4-pro");
    assert.strictEqual(deep.modelConfig.providers.openai_compatible.thinkingMode, "enabled");
    assert.strictEqual(deep.modelConfig.providers.openai_compatible.timeoutMs, 120000);
    assert.strictEqual(deep.concurrency, 1);
    assert.strictEqual(deep.revision.length, 64);
    const batch = resolveRuntimeModelConfig({ root, fallbackModelConfig: fallback, taskProfile: "batch_screening" });
    assert.strictEqual(batch.modelConfig.providers.openai_compatible.model, "deepseek-v4-flash");
    assert.strictEqual(batch.modelConfig.providers.openai_compatible.thinkingMode, "disabled");
    assert.strictEqual(batch.modelConfig.providers.openai_compatible.timeoutMs, 90000);
    assert.strictEqual(batch.concurrency, 2);
    assert.strictEqual(deep.secretId, batch.secretId, "shared mode must resolve both profiles to one secret");
    assert.strictEqual(loadSecret(root, batch.secretId), "routing-key-not-public");
    assert.strictEqual(deep.modelConfig.providers.openai_compatible.apiKey, "routing-key-not-public");

    const deepCheckedAt = state.settings.taskProfiles.deep_analysis.connection.checkedAt;
    assert.strictEqual(isModelReady(state, { taskProfile: "deep_analysis", checkedAfter: deepCheckedAt }), true);
    assert.strictEqual(isModelReady(state, { taskProfile: "deep_analysis", checkedAfter: new Date(Date.now() + 60000).toISOString() }), false);

    const deepFingerprintBefore = state.settings.taskProfiles.deep_analysis.connection.fingerprint;
    const batchFingerprintBefore = state.settings.taskProfiles.batch_screening.connection.fingerprint;
    state = await saveVerifiedModelTaskProfile({
      root,
      taskProfile: "deep_analysis",
      fallbackModelConfig: fallback,
      connectionTester: verified,
      input: { model: "deepseek-v4-pro-2" }
    });
    assert.notStrictEqual(state.settings.taskProfiles.deep_analysis.connection.fingerprint, deepFingerprintBefore);
    assert.strictEqual(state.settings.taskProfiles.batch_screening.connection.fingerprint, batchFingerprintBefore);
    assert.strictEqual(state.settings.taskProfiles.batch_screening.connection.status, "verified");

    let body;
    await testModelConnection({
      settings: { preset: "qwen", model: "qwen-plus", thinkingMode: "enabled", reasoningEffort: "max" },
      apiKey: "probe-key",
      fetchImpl: async (_url, options) => {
        body = JSON.parse(options.body);
        return new Response(JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" } }] }), { status: 200 });
      }
    });
    assert.strictEqual(Object.hasOwn(body, "thinking"), false);
    assert.strictEqual(Object.hasOwn(body, "reasoning_effort"), false);

    state = restoreRecommendedTaskProfile({ root, taskProfile: "deep_analysis", fallbackModelConfig: fallback });
    assert.strictEqual(state.settings.taskProfiles.deep_analysis.model, "deepseek-v4-pro");
    assert.strictEqual(state.settings.taskProfiles.deep_analysis.timeoutMs, 120000);
    assert.strictEqual(state.settings.taskProfiles.deep_analysis.thinkingMode, "enabled");
    assert.strictEqual(state.settings.taskProfiles.deep_analysis.concurrency, 1);
    assert.strictEqual(state.settings.taskProfiles.deep_analysis.connection.status, "unverified");
    assert.strictEqual(isModelReady(state, { taskProfile: "deep_analysis" }), false);
    assert.strictEqual(state.settings.taskProfiles.batch_screening.connection.status, "verified", "restore must not touch the other profile");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function primaryProfilesAtomicVerificationSmoke() {
  const root = tempRoot("zhiping-profiles-primary-");
  try {
    let state = saveModelTaskProfileParameters({
      root,
      taskProfile: "batch_screening",
      fallbackModelConfig: fallback,
      input: {
        credentialRef: "shared",
        model: "deepseek-v4-flash",
        timeoutMs: 45000,
        thinkingMode: "disabled",
        reasoningEffort: "high",
        concurrency: 2
      }
    });
    assert.strictEqual(state.settings.taskProfiles.batch_screening.timeoutMs, 45000);
    assert.strictEqual(state.settings.taskProfiles.batch_screening.connection.status, "unverified");

    const probes = [];
    state = await saveVerifiedPrimaryModelProfiles({
      root,
      fallbackModelConfig: fallback,
      input: { preset: "deepseek", apiKey: "shared-primary-key" },
      connectionTester: async ({ settings }) => {
        probes.push(settings.taskProfile);
        return {
          status: "verified",
          checkedAt: "2026-08-14T08:00:00.000Z",
          latencyMs: settings.taskProfile === "deep_analysis" ? 11 : 13,
          httpStatus: 200
        };
      }
    });
    assert.deepStrictEqual(probes, ["deep_analysis", "batch_screening"]);
    assert.strictEqual(state.settings.taskProfiles.deep_analysis.connection.status, "verified");
    assert.strictEqual(state.settings.taskProfiles.batch_screening.connection.status, "verified");
    assert.strictEqual(
      loadSecret(root, secretIdForSettings(state.settings, "deep_analysis")),
      "shared-primary-key"
    );

    const settingsBeforeFailure = fs.readFileSync(settingsPath(root));
    const sharedSecretFile = secretPath(root, secretIdForSettings(state.settings, "deep_analysis"));
    const secretBeforeFailure = fs.readFileSync(sharedSecretFile);
    const failedProbes = [];
    await assert.rejects(
      () => saveVerifiedPrimaryModelProfiles({
        root,
        fallbackModelConfig: fallback,
        input: { preset: "deepseek", apiKey: "must-not-replace-shared-key" },
        connectionTester: async ({ settings }) => {
          failedProbes.push(settings.taskProfile);
          if (settings.taskProfile === "batch_screening") {
            const error = new Error("batch authentication failed");
            error.code = "MODEL_AUTH_FAILED";
            throw error;
          }
          return {
            status: "verified",
            checkedAt: "2026-08-14T08:01:00.000Z",
            latencyMs: 9,
            httpStatus: 200
          };
        }
      }),
      (error) => error.code === "MODEL_AUTH_FAILED"
    );
    assert.deepStrictEqual(failedProbes, ["deep_analysis", "batch_screening"]);
    assert.deepStrictEqual(fs.readFileSync(settingsPath(root)), settingsBeforeFailure);
    assert.deepStrictEqual(fs.readFileSync(sharedSecretFile), secretBeforeFailure);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function independentCredentialsAndBackupSmoke() {
  const root = tempRoot("zhiping-profiles-credentials-");
  const sharedKey = "shared-mode-key-not-public";
  const independentKey = "independent-batch-key-not-public";
  const backupKey = "backup-key-not-public";
  try {
    let state = await saveVerifiedModelTaskProfile({
      root,
      taskProfile: "deep_analysis",
      fallbackModelConfig: fallback,
      connectionTester: verified,
      input: {
        preset: "deepseek",
        model: "deepseek-v4-pro",
        timeoutMs: 120000,
        thinkingMode: "enabled",
        reasoningEffort: "high",
        concurrency: 1,
        apiKey: sharedKey
      }
    });
    state = await saveVerifiedModelTaskProfile({
      root,
      taskProfile: "batch_screening",
      fallbackModelConfig: fallback,
      connectionTester: verified,
      input: {
        model: "deepseek-v4-flash",
        timeoutMs: 90000,
        thinkingMode: "disabled",
        reasoningEffort: "high",
        concurrency: 2
      }
    });
    const sharedSecretId = secretIdForSettings(state.settings);
    const sharedDeep = resolveRuntimeModelConfig({ root, fallbackModelConfig: fallback, taskProfile: "deep_analysis" });
    const sharedBatch = resolveRuntimeModelConfig({ root, fallbackModelConfig: fallback, taskProfile: "batch_screening" });
    assert.strictEqual(sharedDeep.secretId, sharedSecretId);
    assert.strictEqual(sharedBatch.secretId, sharedSecretId);
    assert.strictEqual(loadSecret(root, sharedSecretId), sharedKey);
    assert.strictEqual(sharedDeep.modelConfig.providers.openai_compatible.apiKey, sharedKey);
    assert.strictEqual(sharedBatch.modelConfig.providers.openai_compatible.apiKey, sharedKey);
    assert.strictEqual(sharedDeep.modelConfig.providers.openai_compatible.apiKeyEnv, null);
    assert.strictEqual(sharedBatch.modelConfig.providers.openai_compatible.apiKeyEnv, null);

    state = await saveVerifiedModelTaskProfile({
      root,
      taskProfile: "batch_screening",
      fallbackModelConfig: fallback,
      connectionTester: verified,
      input: { credentialRef: "independent", preset: "deepseek", apiKey: independentKey }
    });
    const independentBatch = resolveRuntimeModelConfig({ root, fallbackModelConfig: fallback, taskProfile: "batch_screening" });
    assert.notStrictEqual(independentBatch.secretId, sharedSecretId);
    assert.strictEqual(loadSecret(root, independentBatch.secretId), independentKey);
    assert.strictEqual(loadSecret(root, sharedSecretId), sharedKey, "independent mode must never copy the shared plaintext key");
    assert.strictEqual(independentBatch.modelConfig.providers.openai_compatible.apiKey, independentKey);
    assert.strictEqual(independentBatch.modelConfig.providers.openai_compatible.apiKeyEnv, null);
    assert.strictEqual(isModelReady(independentBatch, { taskProfile: "batch_screening" }), true);
    assert.strictEqual(state.settings.independentCredentials.batch_screening.preset, "deepseek");

    await assert.rejects(() => saveVerifiedBatchBackup({
      root,
      fallbackModelConfig: fallback,
      connectionTester: async () => {
        const error = new Error("backup connection refused");
        error.code = "MODEL_CONNECTION_FAILED";
        throw error;
      },
      input: {
        enabled: true,
        model: "deepseek-v4-pro",
        timeoutMs: 90000,
        thinkingMode: "disabled",
        reasoningEffort: "high",
        apiKey: backupKey
      }
    }), (error) => error.code === "MODEL_CONNECTION_FAILED");

    state = await saveVerifiedBatchBackup({
      root,
      fallbackModelConfig: fallback,
      connectionTester: verified,
      input: {
        enabled: false,
        model: "deepseek-v4-pro",
        timeoutMs: 90000,
        thinkingMode: "disabled",
        reasoningEffort: "high"
      }
    });
    assert.strictEqual(state.settings.batchBackup.enabled, false);
    assert.strictEqual(state.settings.batchBackup.model, "deepseek-v4-pro");
    assert.strictEqual(state.settings.batchBackup.timeoutMs, 90000);
    assert.strictEqual(resolveRuntimeBatchBackup({ root, fallbackModelConfig: fallback }), null);

    state = await saveVerifiedBatchBackup({
      root,
      fallbackModelConfig: fallback,
      connectionTester: verified,
      input: {
        enabled: true,
        credentialRef: "independent",
        model: "deepseek-v4-pro",
        timeoutMs: 90000,
        thinkingMode: "disabled",
        reasoningEffort: "high",
        apiKey: backupKey
      }
    });
    assert.strictEqual(state.settings.batchBackup.enabled, true);
    const backup = resolveRuntimeBatchBackup({ root, fallbackModelConfig: fallback });
    assert(backup, "verified backup must resolve");
    assert.strictEqual(backup.modelConfig.providers.openai_compatible.model, "deepseek-v4-pro");
    assert.strictEqual(backup.modelConfig.providers.openai_compatible.timeoutMs, 90000);
    assert.strictEqual(backup.modelConfig.providers.openai_compatible.apiKey, backupKey);
    assert.strictEqual(backup.modelConfig.providers.openai_compatible.apiKeyEnv, null);
    assert.strictEqual(loadSecret(root, backup.secretId), backupKey);
    assert.notStrictEqual(backup.secretId, sharedSecretId);
    fs.unlinkSync(secretPath(root, backup.secretId));
    assert.strictEqual(
      resolveRuntimeBatchBackup({ root, fallbackModelConfig: fallback }),
      null,
      "a verified backup without a readable configured key must not resolve or fall back to an environment key"
    );

    state = await saveVerifiedBatchBackup({
      root,
      fallbackModelConfig: fallback,
      connectionTester: testModelConnection,
      input: { enabled: false }
    });
    assert.strictEqual(state.settings.batchBackup.enabled, false);
    assert.strictEqual(state.settings.batchBackup.model, "deepseek-v4-pro", "disabling must keep the stored configuration");
    assert.strictEqual(state.settings.batchBackup.connection.status, "unverified");
    assert.strictEqual(resolveRuntimeBatchBackup({ root, fallbackModelConfig: fallback }), null);

    const publicText = JSON.stringify(state);
    const fileText = fs.readFileSync(settingsPath(root), "utf8");
    for (const secret of [sharedKey, independentKey, backupKey]) {
      assert(!publicText.includes(secret), "public state must not contain API keys");
      assert(!fileText.includes(secret), "settings JSON must not contain API keys");
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
