const fs = require("node:fs");
const path = require("node:path");
const { randomUUID: systemRandomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { CdpBrowserAdapter } = require("./cdp");

function createPortableEdgeRuntime({
  projectRoot,
  profilePath,
  cdpPort = 9222,
  sessionFile = defaultSessionFile(),
  runPowerShell = defaultRunPowerShell,
  cdpFactory = (options) => new CdpBrowserAdapter(options),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  readinessAttempts = 6,
  readinessDelayMs = 250,
  now = () => new Date().toISOString(),
  randomUUID = systemRandomUUID
} = {}) {
  const root = requireAbsolutePath(projectRoot, "project root");
  const profile = requireAbsolutePath(profilePath, "browser profile");
  const port = requirePort(cdpPort);
  const descriptorPath = requireAbsolutePath(sessionFile, "browser session file");
  const attempts = Math.max(2, Number(readinessAttempts) || 0);

  async function inspect(session) {
    assertSessionAuthority(session, { profilePath: profile, cdpPort: port });
    const result = await cdpFactory({ host: "127.0.0.1", port }).inspectTransport();
    return { ready: true, ...result };
  }

  async function ensure({ dashboardUrl } = {}) {
    const startUrl = requireDashboardUrl(dashboardUrl);
    const result = await runPowerShell({
      file: powershellPath(),
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-File", path.join(root, "scripts", "start-portable-edge.ps1"),
        "-Port", String(port),
        "-ProfileDir", profile,
        "-StartUrl", startUrl,
        "-OutputJson"
      ],
      cwd: root
    });
    if (Number(result?.exitCode) !== 0) throw processFailure(result);

    const launched = parseLaunchResult(result?.stdout);
    assertLaunchAuthority(launched, { profilePath: profile, cdpPort: port });
    await waitForStableTransport({ cdpFactory, port, attempts, sleep, readinessDelayMs });

    const timestamp = now();
    const session = {
      schemaVersion: 1,
      sessionId: randomUUID(),
      pid: launched.pid,
      edgePath: launched.edgePath,
      profilePath: profile,
      cdpUrl: `http://127.0.0.1:${port}`,
      startedAt: timestamp,
      inspectedAt: now()
    };
    writeJsonAtomic(descriptorPath, session, randomUUID);
    return session;
  }

  return { ensure, inspect };
}

async function waitForStableTransport({ cdpFactory, port, attempts, sleep, readinessDelayMs }) {
  const browser = cdpFactory({ host: "127.0.0.1", port });
  let consecutive = 0;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await browser.inspectTransport();
      consecutive += 1;
      if (consecutive === 2) return;
    } catch (error) {
      lastError = error;
      consecutive = 0;
    }
    if (attempt < attempts - 1) await sleep(readinessDelayMs);
  }
  throw runtimeError("PORTABLE_EDGE_START_TIMEOUT", "RoleFlow 专用 Edge 的本地控制连接未能稳定就绪。", lastError);
}

function parseLaunchResult(stdout) {
  try {
    const parsed = JSON.parse(String(stdout || "").trim());
    if (!parsed || parsed.schemaVersion !== 1) throw new Error("unsupported result schema");
    return parsed;
  } catch (error) {
    throw runtimeError("PORTABLE_EDGE_RESULT_INVALID", "RoleFlow 专用 Edge 启动结果无法识别。", error);
  }
}

function assertLaunchAuthority(result, expected) {
  if (!Number.isInteger(result?.pid) || result.pid <= 0
    || !path.isAbsolute(String(result?.edgePath || ""))
    || path.basename(String(result.edgePath)).toLowerCase() !== "msedge.exe") {
    throw runtimeError("PORTABLE_EDGE_IDENTITY_MISMATCH", "RoleFlow 专用 Edge 的进程身份无法确认。");
  }
  assertSessionAuthority(result, expected);
}

function assertSessionAuthority(session, { profilePath, cdpPort }) {
  let cdpUrl;
  try {
    cdpUrl = new URL(String(session?.cdpUrl || ""));
  } catch {
    throw runtimeError("PORTABLE_EDGE_IDENTITY_MISMATCH", "RoleFlow 专用 Edge 的本地连接地址无法确认。");
  }
  if (!samePath(session?.profilePath, profilePath)
    || cdpUrl.protocol !== "http:"
    || cdpUrl.hostname !== "127.0.0.1"
    || Number(cdpUrl.port) !== cdpPort) {
    throw runtimeError("PORTABLE_EDGE_IDENTITY_MISMATCH", "RoleFlow 专用 Edge 的浏览器身份与当前请求不一致。");
  }
}

function processFailure(result) {
  const detail = `${result?.stderr || ""}\n${result?.stdout || ""}`.trim();
  const known = detail.match(/\b(PORTABLE_EDGE_[A-Z0-9_]+|ROLEFLOW_BROWSER_PROFILE_IN_USE)\b/)?.[1];
  if (known) return runtimeError(known, detail || known);
  if (/Portable Edge identity check failed/i.test(detail)) {
    return runtimeError("PORTABLE_EDGE_IDENTITY_MISMATCH", detail);
  }
  return runtimeError("PORTABLE_EDGE_START_FAILED", detail || "RoleFlow 专用 Edge 启动命令失败。");
}

function requireDashboardUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol === "http:" && url.hostname === "127.0.0.1" && Number(url.port) > 0) {
      return url.toString();
    }
  } catch {
    // Fall through to one public error.
  }
  throw runtimeError("PORTABLE_EDGE_DASHBOARD_URL_INVALID", "专用 Edge 必须从本机 RoleFlow 工作台启动。");
}

function requireAbsolutePath(value, label) {
  const resolved = String(value || "");
  if (!resolved || !path.isAbsolute(resolved)) {
    throw runtimeError("PORTABLE_EDGE_RUNTIME_PATH_INVALID", `RoleFlow ${label}必须是本机绝对路径。`);
  }
  return path.resolve(resolved);
}

function requirePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw runtimeError("PORTABLE_EDGE_RUNTIME_PORT_INVALID", "RoleFlow 专用 Edge 的本地端口无效。");
  }
  return port;
}

function samePath(left, right) {
  if (!left || !right || !path.isAbsolute(String(left)) || !path.isAbsolute(String(right))) return false;
  return path.resolve(String(left)).toLowerCase() === path.resolve(String(right)).toLowerCase();
}

function writeJsonAtomic(file, value, randomUUID) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function defaultSessionFile() {
  const localAppData = String(process.env.LOCALAPPDATA || "");
  return localAppData ? path.join(localAppData, "RoleFlow", "Runtime", "browser-session.json") : "";
}

function powershellPath() {
  return path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function defaultRunPowerShell({ file, args, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => resolve({ exitCode: -1, stdout, stderr: `${stderr}\n${error.message}`.trim() }));
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

function runtimeError(code, message, cause = null) {
  const error = cause ? new Error(message, { cause }) : new Error(message);
  error.code = code;
  return error;
}

module.exports = { createPortableEdgeRuntime };
