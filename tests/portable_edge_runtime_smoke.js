const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPortableEdgeRuntime } = require("../src/adapters/browser/portable_edge_runtime");

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function output(overrides = {}) {
  return {
    schemaVersion: 1,
    pid: 4242,
    edgePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    profilePath: "C:\\Users\\Example\\AppData\\Local\\RoleFlow\\BrowserProfile",
    cdpUrl: "http://127.0.0.1:9222",
    browser: "Edge/140",
    ...overrides
  };
}

async function rejectedCode(run, code) {
  await assert.rejects(run, (error) => error?.code === code);
}

(async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-portable-runtime-"));
  const sessionFile = path.join(tempRoot, "Runtime", "browser-session.json");
  const calls = [];
  const probeResults = [codedError("BROWSER_DISCONNECTED"), { ready: true }, { ready: true }];
  let probeCalls = 0;
  let sleeps = 0;
  let uuid = 0;
  try {
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, JSON.stringify({ schemaVersion: 1, sessionId: "stale-session", pid: 9 }), "utf8");
    const runtime = createPortableEdgeRuntime({
      projectRoot: tempRoot,
      profilePath: output().profilePath,
      cdpPort: 9222,
      sessionFile,
      runPowerShell: async (request) => {
        calls.push(request);
        return { exitCode: 0, stdout: JSON.stringify(output()), stderr: "" };
      },
      cdpFactory: ({ host, port }) => {
        assert.deepStrictEqual({ host, port }, { host: "127.0.0.1", port: 9222 });
        return {
          async inspectTransport() {
            const result = probeResults[probeCalls++];
            if (result instanceof Error) throw result;
            return { browser: "Edge/140", pageCount: 1 };
          }
        };
      },
      sleep: async () => { sleeps += 1; },
      readinessAttempts: 4,
      now: () => "2099-01-01T00:00:00.000Z",
      randomUUID: () => `uuid-${++uuid}`
    });

    const ready = await runtime.ensure({ dashboardUrl: "http://127.0.0.1:8787/" });
    assert.deepStrictEqual(ready, {
      schemaVersion: 1,
      sessionId: "uuid-1",
      pid: 4242,
      edgePath: output().edgePath,
      profilePath: output().profilePath,
      cdpUrl: "http://127.0.0.1:9222",
      startedAt: "2099-01-01T00:00:00.000Z",
      inspectedAt: "2099-01-01T00:00:00.000Z"
    });
    assert.strictEqual(calls.length, 1, "a stale descriptor must never bypass live identity verification");
    assert.strictEqual(probeCalls, 3, "readiness requires two consecutive successful probes");
    assert.strictEqual(sleeps, 2);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(sessionFile, "utf8")), ready);
    assert.deepStrictEqual(fs.readdirSync(path.dirname(sessionFile)), ["browser-session.json"]);

    const request = calls[0];
    assert.strictEqual(request.cwd, tempRoot);
    assert.deepStrictEqual(request.args.slice(-9), [
      "-File", path.join(tempRoot, "scripts", "start-portable-edge.ps1"),
      "-Port", "9222",
      "-ProfileDir", output().profilePath,
      "-StartUrl", "http://127.0.0.1:8787/",
      "-OutputJson"
    ]);
    assert.doesNotMatch(request.args.join(" "), /zhipin\.com/i);

    probeResults.push({ ready: true });
    assert.deepStrictEqual(await runtime.inspect(ready), { ready: true, browser: "Edge/140", pageCount: 1 });

    const createFailureRuntime = (result, options = {}) => createPortableEdgeRuntime({
      projectRoot: tempRoot,
      profilePath: output().profilePath,
      cdpPort: 9222,
      sessionFile: path.join(tempRoot, `failure-${Math.random()}.json`),
      runPowerShell: async () => result,
      cdpFactory: () => ({
        inspectTransport: options.inspectTransport || (async () => ({ browser: "Edge/140", pageCount: 1 }))
      }),
      sleep: async () => {},
      readinessAttempts: options.readinessAttempts || 3,
      now: () => "2099-01-01T00:00:00.000Z",
      randomUUID: () => "failure-session"
    });

    await rejectedCode(
      () => createFailureRuntime({ exitCode: 0, stdout: "not-json", stderr: "" }).ensure({ dashboardUrl: "http://127.0.0.1:8787/" }),
      "PORTABLE_EDGE_RESULT_INVALID"
    );
    await rejectedCode(
      () => createFailureRuntime({ exitCode: 0, stdout: JSON.stringify(output({ cdpUrl: "http://0.0.0.0:9222" })), stderr: "" }).ensure({ dashboardUrl: "http://127.0.0.1:8787/" }),
      "PORTABLE_EDGE_IDENTITY_MISMATCH"
    );
    await rejectedCode(
      () => createFailureRuntime({ exitCode: 0, stdout: JSON.stringify(output({ profilePath: "C:\\Other Profile" })), stderr: "" }).ensure({ dashboardUrl: "http://127.0.0.1:8787/" }),
      "PORTABLE_EDGE_IDENTITY_MISMATCH"
    );
    await rejectedCode(
      () => createFailureRuntime({ exitCode: 1, stdout: "", stderr: "PORTABLE_EDGE_NOT_FOUND: install Edge" }).ensure({ dashboardUrl: "http://127.0.0.1:8787/" }),
      "PORTABLE_EDGE_NOT_FOUND"
    );
    await rejectedCode(
      () => createFailureRuntime(
        { exitCode: 0, stdout: JSON.stringify(output()), stderr: "" },
        { inspectTransport: async () => { throw codedError("BROWSER_DISCONNECTED"); }, readinessAttempts: 2 }
      ).ensure({ dashboardUrl: "http://127.0.0.1:8787/" }),
      "PORTABLE_EDGE_START_TIMEOUT"
    );
    await rejectedCode(
      () => runtime.ensure({ dashboardUrl: "https://www.zhipin.com/web/geek/jobs" }),
      "PORTABLE_EDGE_DASHBOARD_URL_INVALID"
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log("portable_edge_runtime_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
