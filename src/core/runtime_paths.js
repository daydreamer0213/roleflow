const fs = require("node:fs");
const path = require("node:path");

function resolveRuntimePaths({ appRoot, dataRoot } = {}) {
  const resolvedAppRoot = resolveLocalAbsolutePath(appRoot, {
    missingCode: "ROLEFLOW_APP_ROOT_REQUIRED",
    absoluteCode: "ROLEFLOW_APP_ROOT_ABSOLUTE_REQUIRED"
  });
  const explicitDataRoot = dataRoot !== undefined && dataRoot !== null;
  const resolvedDataRoot = explicitDataRoot
    ? resolveLocalAbsolutePath(dataRoot, {
      missingCode: "ROLEFLOW_DATA_ROOT_REQUIRED",
      absoluteCode: "ROLEFLOW_DATA_ROOT_ABSOLUTE_REQUIRED"
    })
    : resolvedAppRoot;

  if (explicitDataRoot && pathsOverlap(resolvedAppRoot, resolvedDataRoot)) {
    throw runtimePathError(
      "ROLEFLOW_APP_DATA_ROOT_OVERLAP",
      "RoleFlow 程序目录和用户数据目录必须彼此独立。"
    );
  }

  assertNoReparsePoint(resolvedAppRoot);
  if (resolvedDataRoot !== resolvedAppRoot) assertNoReparsePoint(resolvedDataRoot);

  return {
    appRoot: resolvedAppRoot,
    dataRoot: resolvedDataRoot,
    dbPath: path.resolve(resolvedDataRoot, "data", "jobs.sqlite"),
    reportRoot: path.resolve(resolvedDataRoot, "reports")
  };
}

function resolveInstalledDataRoot({ localAppData = process.env.LOCALAPPDATA } = {}) {
  const resolvedLocalAppData = resolveLocalAbsolutePath(localAppData, {
    missingCode: "ROLEFLOW_LOCALAPPDATA_REQUIRED",
    absoluteCode: "ROLEFLOW_LOCALAPPDATA_ABSOLUTE_REQUIRED"
  });
  assertNoReparsePoint(resolvedLocalAppData);
  return path.resolve(resolvedLocalAppData, "RoleFlow", "Data");
}

function explicitDataRootForChild({ appRoot, dataRoot } = {}) {
  const resolvedAppRoot = path.resolve(String(appRoot || ""));
  const resolvedDataRoot = path.resolve(String(dataRoot || ""));
  const equal = process.platform === "win32"
    ? resolvedAppRoot.toLowerCase() === resolvedDataRoot.toLowerCase()
    : resolvedAppRoot === resolvedDataRoot;
  return equal ? null : resolvedDataRoot;
}

function resolveLocalAbsolutePath(value, { missingCode, absoluteCode }) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) throw runtimePathError(missingCode, "RoleFlow 运行目录未配置。");
  if (isUncPath(raw)) {
    throw runtimePathError(
      "ROLEFLOW_RUNTIME_UNC_PATH_REJECTED",
      "RoleFlow 运行目录必须位于本机磁盘，不能使用网络路径。"
    );
  }
  if (!path.isAbsolute(raw)) {
    throw runtimePathError(absoluteCode, "RoleFlow 运行目录必须使用绝对路径。");
  }
  return path.resolve(raw);
}

function isUncPath(value) {
  return /^\\\\/.test(String(value || ""));
}

function pathsOverlap(left, right) {
  const normalizedLeft = normalizeForComparison(left);
  const normalizedRight = normalizeForComparison(right);
  return normalizedLeft === normalizedRight
    || normalizedLeft.startsWith(`${normalizedRight}${path.sep}`)
    || normalizedRight.startsWith(`${normalizedLeft}${path.sep}`);
}

function normalizeForComparison(value) {
  return path.resolve(value).replace(/[\\/]+$/, "").toLowerCase();
}

function assertNoReparsePoint(targetPath) {
  const resolved = path.resolve(targetPath);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (cause) {
      throw runtimePathError(
        "ROLEFLOW_RUNTIME_PATH_INSPECTION_FAILED",
        "RoleFlow 无法确认运行目录是否安全。",
        cause
      );
    }
    if (stat.isSymbolicLink()) {
      throw runtimePathError(
        "ROLEFLOW_RUNTIME_REPARSE_POINT_BLOCKED",
        "RoleFlow 运行目录不能经过目录链接或重解析点。"
      );
    }
  }
  return resolved;
}

function runtimePathError(code, message, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

module.exports = {
  assertNoReparsePoint,
  explicitDataRootForChild,
  resolveInstalledDataRoot,
  resolveRuntimePaths
};
