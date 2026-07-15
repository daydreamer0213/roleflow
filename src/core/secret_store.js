const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ENTROPY = "ZhiPing:model-secret:v1";

function secretPath(root, id) {
  const safeId = String(id || "");
  if (!/^[a-z0-9-]{1,80}$/.test(safeId)) throw new Error("invalid local secret id");
  return path.join(root || process.cwd(), ".runtime", "secrets", safeId + ".dpapi");
}

function hasSecret(root, id) {
  try {
    const file = secretPath(root, id);
    return fs.existsSync(file) && fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

function saveSecret(root, id, value) {
  const plain = String(value || "").trim();
  if (!plain) throw new Error("API Key 不能为空。");
  const encrypted = runDpapi(PROTECT_SCRIPT, plain);
  const file = secretPath(root, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeTextAtomic(file, encrypted);
  return { configured: true };
}

function loadSecret(root, id) {
  if (!hasSecret(root, id)) return "";
  const encrypted = fs.readFileSync(secretPath(root, id), "utf8").trim();
  if (!encrypted) return "";
  return runDpapi(UNPROTECT_SCRIPT, encrypted).trim();
}

function inspectSecret(root, id) {
  if (!hasSecret(root, id)) return { stored: false, readable: false, configured: false, errorCode: "" };
  try {
    const value = loadSecret(root, id);
    return { stored: true, readable: Boolean(value), configured: Boolean(value), errorCode: value ? "" : "SECRET_EMPTY" };
  } catch {
    return { stored: true, readable: false, configured: false, errorCode: "SECRET_UNREADABLE" };
  }
}

function clearSecret(root, id) {
  fs.rmSync(secretPath(root, id), { force: true });
}

function writeTextAtomic(file, content) {
  const temp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, file);
}

function runDpapi(command, input) {
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    command
  ], {
    input,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 1024 * 1024
  });
  if (result.error) throw new Error("本机加密密钥库不可用，请检查 PowerShell 与当前 Windows 用户权限。");
  if (result.status !== 0) throw new Error("本机加密密钥库操作失败，请重新保存 API Key。");
  return String(result.stdout || "");
}

const PROTECT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Security",
  "$entropy = [Text.Encoding]::UTF8.GetBytes('" + ENTROPY + "')",
  "$plain = [Console]::In.ReadToEnd()",
  "if ([string]::IsNullOrWhiteSpace($plain)) { throw 'empty secret' }",
  "$bytes = [Text.Encoding]::UTF8.GetBytes($plain)",
  "$encrypted = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Convert]::ToBase64String($encrypted))"
].join("; ");

const UNPROTECT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Security",
  "$entropy = [Text.Encoding]::UTF8.GetBytes('" + ENTROPY + "')",
  "$encoded = [Console]::In.ReadToEnd().Trim()",
  "if ([string]::IsNullOrWhiteSpace($encoded)) { throw 'empty secret' }",
  "$encrypted = [Convert]::FromBase64String($encoded)",
  "$bytes = [Security.Cryptography.ProtectedData]::Unprotect($encrypted, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))"
].join("; ");

module.exports = { secretPath, hasSecret, saveSecret, loadSecret, inspectSecret, clearSecret };
