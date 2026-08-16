const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cli = require("../src/cli");
const { saveVerifiedModelTaskProfile } = require("../src/core/model_settings");

(async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "zhiping-cli-model-settings-root-"));
  try {
    const worktreeRoot = path.resolve(__dirname, "..");
    const homeRoot = path.join(sandbox, "home");
    const tempRoot = path.join(sandbox, "temp");
    const externalRoot = path.join(sandbox, "external");
    fs.mkdirSync(homeRoot);
    fs.mkdirSync(tempRoot);
    writeFixtureSettings(externalRoot, {
      schemaVersion: 2,
      sharedCredential: { preset: "mock" },
      taskProfiles: {
        deep_analysis: { model: "offline-structured-mock", credentialRef: "shared" },
        batch_screening: { model: "offline-structured-mock", credentialRef: "shared" }
      },
      batchBackup: { enabled: false }
    });
    const pathPolicy = { worktreeRoot, homeRoot, tempRoot };

    assert.strictEqual(typeof cli.resolveScanModelSettingsContext, "function", "CLI must export resolveScanModelSettingsContext");
    assert.strictEqual(typeof cli.resolveScanModelRuntime, "function", "CLI must export resolveScanModelRuntime");

    const fallbackConfig = { provider: "mock" };
    const injectedContext = { root: externalRoot, readOnly: true };
    const primary = ({ root, readOnly, fallbackModelConfig, taskProfile }) => ({
      root,
      readOnly,
      fallbackModelConfig,
      taskProfile,
      modelConfig: { provider: "stub-primary" }
    });
    const backup = ({ root, readOnly, fallbackModelConfig }) => ({
      root,
      readOnly,
      fallbackModelConfig,
      backupConfig: { provider: "stub-backup" }
    });
    const runtime = cli.resolveScanModelRuntime({
      context: injectedContext,
      fallbackModelConfig: fallbackConfig,
      primaryResolver: primary,
      backupResolver: backup
    });
    assert.deepStrictEqual(
      runtime.primaryState.modelConfig,
      { provider: "stub-primary" },
      "scan model runtime must return the primary model config"
    );
    assert.deepStrictEqual(
      runtime.backupState,
      { root: externalRoot, readOnly: true, fallbackModelConfig: fallbackConfig, backupConfig: { provider: "stub-backup" } },
      "scan model runtime must return the backup state"
    );

    const primaryCalls = [];
    const backupCalls = [];
    cli.resolveScanModelRuntime({
      context: injectedContext,
      fallbackModelConfig: fallbackConfig,
      primaryResolver: (...args) => { primaryCalls.push(args); return { modelConfig: { provider: "stub-primary" } }; },
      backupResolver: (...args) => { backupCalls.push(args); return { backupConfig: { provider: "stub-backup" } }; }
    });
    assert.strictEqual(primaryCalls.length, 1, "primary resolver must be called exactly once");
    assert.strictEqual(backupCalls.length, 1, "backup resolver must be called exactly once");
    assert.deepStrictEqual(primaryCalls[0][0], {
      root: externalRoot,
      readOnly: true,
      fallbackModelConfig: fallbackConfig,
      taskProfile: "batch_screening"
    }, "primary resolver must receive the canonical external root, readOnly, fallback and batch_screening profile");
    assert.deepStrictEqual(backupCalls[0][0], {
      root: externalRoot,
      readOnly: true,
      fallbackModelConfig: fallbackConfig
    }, "backup resolver must receive the same canonical external root, readOnly and fallback");

    let contextResolverCalls = 0;
    let runtimeResolverCalls = 0;
    let browserSeamReached = false;
    const stubStatement = { run: () => ({ lastInsertRowid: 1 }) };
    const stubDb = { prepare: () => stubStatement };
    let unsupportedModeBrowserCalls = 0;
    await assert.rejects(
      () => cli.scan(stubDb, {
        input: "synthetic-input.json",
        "force-mock": true,
        keywords: "test-keyword",
        "detail-mode": "search_page_api"
      }, {
        createBrowser() {
          unsupportedModeBrowserCalls += 1;
          throw new Error("browser seam must not be reached");
        }
      }),
      (error) => error.code === "PRODUCT_DETAIL_MODE_UNSUPPORTED" && /trusted_pane/.test(error.message)
    );
    assert.strictEqual(unsupportedModeBrowserCalls, 0, "CLI 必须在初始化浏览器前拒绝研究模式");
    const browserSeam = () => {
      browserSeamReached = true;
      const error = new Error("browser seam reached by force-mock scan without model routing");
      error.code = "TEST_BROWSER_SEAM_REACHED";
      throw error;
    };
    try {
      await cli.scan(stubDb, { input: "synthetic-input.json", "force-mock": true, keywords: "test-keyword" }, {
        resolveScanModelSettingsContext: () => { contextResolverCalls += 1; return injectedContext; },
        resolveScanModelRuntime: () => { runtimeResolverCalls += 1; return { primaryState: { modelConfig: {} }, backupState: null }; },
        createBrowser: browserSeam
      });
    } catch (error) {
      assert.strictEqual(error?.code, "TEST_BROWSER_SEAM_REACHED", "force-mock scan must reach the browser seam without model routing");
    }
    assert.strictEqual(browserSeamReached, true, "force-mock scan must reach the browser seam");
    assert.strictEqual(contextResolverCalls, 0, "force-mock must not call the model settings context resolver");
    assert.strictEqual(runtimeResolverCalls, 0, "force-mock must not call the scan model runtime resolver");

    const mockBatchRoot = path.join(sandbox, "external-mock-batch");
    await saveVerifiedModelTaskProfile({
      root: mockBatchRoot,
      taskProfile: "batch_screening",
      fallbackModelConfig: fallbackConfig,
      connectionTester: async () => {
        throw new Error("mock batch profile must not call the connection tester");
      },
      input: { preset: "mock", model: "offline-structured-mock" }
    });
    const realContext = cli.resolveScanModelSettingsContext(
      { "model-settings-root": mockBatchRoot },
      { root: worktreeRoot, pathPolicy }
    );
    assert.strictEqual(realContext.root, fs.realpathSync(mockBatchRoot), "mock batch context must canonicalize the external root");
    assert.strictEqual(realContext.readOnly, true, "mock batch context must be read-only");

    let realContextCalls = 0;
    let nonForceBrowserSeamReached = false;
    const nonForceBrowserSeam = () => {
      nonForceBrowserSeamReached = true;
      const error = new Error("browser seam reached by read-only scan model init without force-mock");
      error.code = "TEST_BROWSER_SEAM_REACHED";
      throw error;
    };
    try {
      await cli.scan(
        stubDb,
        { input: "synthetic-input.json", "model-settings-root": mockBatchRoot, keywords: "test-keyword" },
        {
          resolveScanModelSettingsContext: (args) => {
            realContextCalls += 1;
            return cli.resolveScanModelSettingsContext(args, { root: worktreeRoot, pathPolicy });
          },
          createBrowser: nonForceBrowserSeam
        }
      );
    } catch (error) {
      assert.strictEqual(error?.code, "TEST_BROWSER_SEAM_REACHED", "read-only scan must reach the browser seam after real model init");
    }
    assert.strictEqual(nonForceBrowserSeamReached, true, "read-only scan must reach the browser seam");
    assert.strictEqual(realContextCalls, 1, "read-only scan must resolve the context through the real CLI resolver exactly once");

    const defaultContext = cli.resolveScanModelSettingsContext({}, { root: worktreeRoot, pathPolicy });
    assert.strictEqual(defaultContext.root, worktreeRoot, "default context must keep the candidate ROOT");
    assert.strictEqual(defaultContext.readOnly, false, "default context must stay writable");

    const explicitContext = cli.resolveScanModelSettingsContext(
      { "model-settings-root": externalRoot },
      { root: worktreeRoot, pathPolicy }
    );
    assert.strictEqual(explicitContext.root, fs.realpathSync(externalRoot), "explicit context must canonicalize the external root");
    assert.strictEqual(explicitContext.readOnly, true, "explicit context must be read-only");

    assert.throws(
      () => cli.resolveScanModelSettingsContext(
        { "model-settings-root": worktreeRoot },
        { root: worktreeRoot, pathPolicy }
      ),
      (error) => error.code === "MODEL_SETTINGS_ROOT_WORKTREE",
      "unsafe root must surface the Task 1 stable error"
    );

    console.log("cli_model_settings_root_smoke ok");
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

function writeFixtureSettings(root, data) {
  const file = path.join(root, ".runtime", "settings", "model.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
  return file;
}
