const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cli = require("../src/cli");

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
