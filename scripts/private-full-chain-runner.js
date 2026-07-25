const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { compareBenchmarkResults } = require("./lib/benchmark_metrics");

const PRIVATE_PARENT = path.resolve("D:\\DevData\\RoleFlow-private-benchmark");
const MODES = new Set([
  "init-manifest", "prepare", "verify-private-bundle", "profile-live", "card-live", "match-live", "compare"
]);
const LIVE_MODES = new Set(["profile-live", "card-live", "match-live"]);
const SHARED_MANIFEST_FILES = [
  "src/core/resume_parser.js",
  "src/core/pdf_text.js",
  "src/core/resume_privacy.js",
  "scripts/lib/benchmark_metrics.js"
];

function fail(code, message) {
  return { ok: false, code, message };
}

function runnerError(code, message) {
  return Object.assign(new Error(message), { code });
}

function canonicalizeExisting(candidate) {
  const absolute = path.resolve(String(candidate || ""));
  let existing = absolute;
  const missing = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.push(path.basename(existing));
    existing = parent;
  }
  try {
    return path.join(fs.realpathSync.native(existing), ...missing.reverse());
  } catch {
    return absolute;
  }
}

function isWithinDirectory(candidate, directory) {
  const relative = path.relative(String(directory).toLowerCase(), String(candidate).toLowerCase());
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isLocalAbsolutePath(value) {
  const raw = String(value || "").trim();
  return Boolean(raw) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && path.isAbsolute(raw);
}

function isForbiddenLocation(candidate) {
  const resolved = canonicalizeExisting(candidate);
  const repositoryRoot = canonicalizeExisting(path.resolve(__dirname, ".."));
  const forbiddenRoots = [
    repositoryRoot,
    path.join(repositoryRoot, "data"),
    path.join(repositoryRoot, ".runtime"),
    os.homedir(),
    os.tmpdir()
  ].map(canonicalizeExisting);
  return forbiddenRoots.some((root) => isWithinDirectory(resolved, root))
    || /(?:^|[\\/])jobs\.sqlite$/i.test(resolved);
}

function checkPrivateRoot(value) {
  if (!String(value || "").trim()) {
    return fail("PRIVATE_FULL_CHAIN_PRIVATE_ROOT_REQUIRED", "A private benchmark root is required.");
  }
  if (!isLocalAbsolutePath(value)) {
    return fail("PRIVATE_FULL_CHAIN_PRIVATE_ROOT_FORBIDDEN", "The private benchmark root must be an absolute local path.");
  }
  const resolved = canonicalizeExisting(value);
  if (!isWithinDirectory(resolved, PRIVATE_PARENT) || isForbiddenLocation(resolved)) {
    return fail("PRIVATE_FULL_CHAIN_PRIVATE_ROOT_FORBIDDEN", "Private benchmark artifacts must stay below the approved private root.");
  }
  return { ok: true, resolved };
}

function checkPrivateArtifact(value, privateRoot, requiredCode, forbiddenCode = "PRIVATE_FULL_CHAIN_PRIVATE_ROOT_FORBIDDEN") {
  if (!String(value || "").trim()) return fail(requiredCode, "A required private artifact path is missing.");
  if (!isLocalAbsolutePath(value)) return fail(forbiddenCode, "Private artifact paths must be absolute local paths.");
  const resolved = canonicalizeExisting(value);
  if (!isWithinDirectory(resolved, privateRoot) || isForbiddenLocation(resolved)) {
    return fail(forbiddenCode, "Private artifacts must remain inside the approved private root.");
  }
  return { ok: true, resolved };
}

function checkExternalPdf(value, privateRoot) {
  if (!String(value || "").trim()) return fail("PRIVATE_FULL_CHAIN_RESUME_REQUIRED", "Prepare requires an explicit local PDF path.");
  if (!isLocalAbsolutePath(value)) return fail("PRIVATE_FULL_CHAIN_RESUME_REQUIRED", "Prepare accepts only an explicit local PDF path.");
  const resolved = canonicalizeExisting(value);
  if (path.extname(resolved).toLowerCase() !== ".pdf" || isWithinDirectory(resolved, privateRoot) || isForbiddenLocation(resolved)) {
    return fail("PRIVATE_FULL_CHAIN_RESUME_REQUIRED", "The source PDF must be a local PDF outside the private bundle and forbidden locations.");
  }
  return { ok: true, resolved };
}

function checkModelSettingsRoot(value) {
  if (!String(value || "").trim()) {
    return fail("PRIVATE_FULL_CHAIN_MODEL_SETTINGS_ROOT_REQUIRED", "Live modes require an explicit model settings root.");
  }
  if (!isLocalAbsolutePath(value)) {
    return fail("PRIVATE_FULL_CHAIN_MODEL_SETTINGS_ROOT_FORBIDDEN", "The model settings root must be an absolute local path.");
  }
  const resolved = canonicalizeExisting(value);
  if (isForbiddenLocation(resolved) || isWithinDirectory(resolved, PRIVATE_PARENT)) {
    return fail("PRIVATE_FULL_CHAIN_MODEL_SETTINGS_ROOT_FORBIDDEN", "The model settings root must not be a repository, private bundle, home, or temporary path.");
  }
  return { ok: true, resolved };
}

function checkWorktreePath(value) {
  if (!String(value || "").trim()) return fail("PRIVATE_FULL_CHAIN_RESUME_REQUIRED", "A manifest worktree path is required.");
  if (!isLocalAbsolutePath(value)) return fail("PRIVATE_FULL_CHAIN_RESUME_REQUIRED", "Manifest worktrees must be absolute local paths.");
  const resolved = canonicalizeExisting(value);
  const disallowed = [os.homedir(), os.tmpdir()].map(canonicalizeExisting);
  if (disallowed.some((root) => isWithinDirectory(resolved, root))) {
    return fail("PRIVATE_FULL_CHAIN_RESUME_REQUIRED", "Manifest worktrees must not be home or temporary paths.");
  }
  return { ok: true, resolved };
}

function normalizedMode(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.startsWith("--") ? raw.slice(2) : raw;
}

function checkIdentityValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = ["names", "phones", "emails"];
  if (!fields.every((field) => Array.isArray(value[field]) && value[field].every((item) => typeof item === "string"))) return false;
  return fields.some((field) => value[field].some((item) => item.trim()));
}

function checkSideAndOutput(options, privateRoot) {
  const side = String(options.side || "").trim();
  if (side !== "baseline" && side !== "candidate") {
    return fail("PRIVATE_FULL_CHAIN_OUTPUT_REQUIRED", "Live modes require --side baseline or candidate.");
  }
  const output = checkPrivateArtifact(options.output, privateRoot, "PRIVATE_FULL_CHAIN_OUTPUT_REQUIRED", "PRIVATE_FULL_CHAIN_PRIVATE_ROOT_FORBIDDEN");
  if (!output.ok) return output;
  const expected = path.join(privateRoot, "runs", side);
  if (output.resolved.toLowerCase() !== canonicalizeExisting(expected).toLowerCase()) {
    return fail("PRIVATE_FULL_CHAIN_OUTPUT_REQUIRED", "The live output directory must match the selected side.");
  }
  return { ok: true, side, output: output.resolved };
}

function validatePrivateFullChainRequest(options, env, providerResolver) {
  const opts = options || {};
  const environ = env || {};
  const mode = normalizedMode(opts.mode);
  if (!MODES.has(mode)) return fail("PRIVATE_FULL_CHAIN_MODE_REQUIRED", "Choose exactly one supported private full-chain mode.");

  if (mode === "compare") {
    const paths = [
      ["baseline", "PRIVATE_FULL_CHAIN_RESUME_REQUIRED"],
      ["candidate", "PRIVATE_FULL_CHAIN_RESUME_REQUIRED"],
      ["report", "PRIVATE_FULL_CHAIN_OUTPUT_REQUIRED"]
    ].map(([field, code]) => checkPrivateArtifact(opts[field], PRIVATE_PARENT, code));
    const failed = paths.find((result) => !result.ok);
    if (failed) return failed;
    return { ok: true, code: "OK", request: { mode, baseline: paths[0].resolved, candidate: paths[1].resolved, report: paths[2].resolved } };
  }

  const privateRoot = checkPrivateRoot(opts.privateRoot);
  if (!privateRoot.ok) return privateRoot;

  if (mode === "prepare") {
    const pdf = checkExternalPdf(opts.pdf, privateRoot.resolved);
    if (!pdf.ok) return pdf;
    const identity = checkPrivateArtifact(opts.identity, privateRoot.resolved, "PRIVATE_FULL_CHAIN_IDENTITY_REQUIRED");
    if (!identity.ok) return identity;
    const output = checkPrivateArtifact(opts.output, privateRoot.resolved, "PRIVATE_FULL_CHAIN_OUTPUT_REQUIRED");
    if (!output.ok) return output;
    if (environ.ALLOW_PRIVATE_RESUME_BENCHMARK !== "YES") {
      return fail("PRIVATE_FULL_CHAIN_NOT_AUTHORIZED", "Prepare requires ALLOW_PRIVATE_RESUME_BENCHMARK=YES.");
    }
    if (opts.worktreeClean !== true) {
      return fail("PRIVATE_FULL_CHAIN_WORKTREE_DIRTY", "Private preparation requires a clean, identified worktree.");
    }
    return { ok: true, code: "OK", request: { mode, privateRoot: privateRoot.resolved, pdf: pdf.resolved, identity: identity.resolved, output: output.resolved, evaluatedCommit: String(opts.evaluatedCommit || "") } };
  }

  if (mode === "verify-private-bundle") {
    const resumeText = checkPrivateArtifact(opts.resumeText, privateRoot.resolved, "PRIVATE_FULL_CHAIN_RESUME_REQUIRED");
    if (!resumeText.ok) return resumeText;
    const identity = checkPrivateArtifact(opts.identity, privateRoot.resolved, "PRIVATE_FULL_CHAIN_IDENTITY_REQUIRED");
    if (!identity.ok) return identity;
    const parseReport = checkPrivateArtifact(opts.parseReport, privateRoot.resolved, "PRIVATE_FULL_CHAIN_OUTPUT_REQUIRED");
    if (!parseReport.ok) return parseReport;
    return { ok: true, code: "OK", request: { mode, privateRoot: privateRoot.resolved, resumeText: resumeText.resolved, identity: identity.resolved, parseReport: parseReport.resolved } };
  }

  if (mode === "init-manifest") {
    const baselineWorktree = checkWorktreePath(opts.baselineWorktree);
    if (!baselineWorktree.ok) return baselineWorktree;
    const candidateWorktree = checkWorktreePath(opts.candidateWorktree);
    if (!candidateWorktree.ok) return candidateWorktree;
    const output = checkPrivateArtifact(opts.output, privateRoot.resolved, "PRIVATE_FULL_CHAIN_OUTPUT_REQUIRED");
    if (!output.ok) return output;
    return { ok: true, code: "OK", request: { mode, privateRoot: privateRoot.resolved, baselineWorktree: baselineWorktree.resolved, candidateWorktree: candidateWorktree.resolved, output: output.resolved } };
  }

  const sideAndOutput = checkSideAndOutput(opts, privateRoot.resolved);
  if (!sideAndOutput.ok) return sideAndOutput;
  const identity = checkPrivateArtifact(opts.identity, privateRoot.resolved, "PRIVATE_FULL_CHAIN_IDENTITY_REQUIRED");
  if (!identity.ok) return identity;
  if (mode === "profile-live") {
    const resumeText = checkPrivateArtifact(opts.resumeText, privateRoot.resolved, "PRIVATE_FULL_CHAIN_RESUME_REQUIRED");
    if (!resumeText.ok) return resumeText;
  }
  if (mode === "card-live") {
    const profile = checkPrivateArtifact(opts.profile, privateRoot.resolved, "PRIVATE_FULL_CHAIN_RESUME_REQUIRED");
    if (!profile.ok) return profile;
  }
  if (mode === "match-live") {
    for (const field of ["profile", "matchingCard", "jobs", "labels"]) {
      const checked = checkPrivateArtifact(opts[field], privateRoot.resolved, "PRIVATE_FULL_CHAIN_RESUME_REQUIRED");
      if (!checked.ok) return checked;
    }
  }
  if (environ.ALLOW_PRIVATE_RESUME_BENCHMARK !== "YES") {
    return fail("PRIVATE_FULL_CHAIN_NOT_AUTHORIZED", "Live modes require ALLOW_PRIVATE_RESUME_BENCHMARK=YES.");
  }
  if (environ.ALLOW_LIVE_MODEL_BENCHMARK !== "YES") {
    return fail("PRIVATE_FULL_CHAIN_MODEL_NOT_AUTHORIZED", "Live modes require ALLOW_LIVE_MODEL_BENCHMARK=YES.");
  }
  if (opts.worktreeClean !== true) {
    return fail("PRIVATE_FULL_CHAIN_WORKTREE_DIRTY", "Live modes require a clean, identified worktree.");
  }
  const modelSettingsRoot = checkModelSettingsRoot(opts.modelSettingsRoot);
  if (!modelSettingsRoot.ok) return modelSettingsRoot;
  const descriptor = opts.modelDescriptor;
  if (!descriptor || typeof descriptor.provider !== "string" || !descriptor.provider || descriptor.provider === "mock") {
    return fail("PRIVATE_FULL_CHAIN_REAL_MODEL_REQUIRED", "Live modes require a pre-validated non-mock model descriptor.");
  }
  // providerResolver is intentionally not invoked here: every failed request stays offline.
  void providerResolver;
  return { ok: true, code: "OK", request: { mode, privateRoot: privateRoot.resolved, side: sideAndOutput.side, output: sideAndOutput.output, identity: identity.resolved, modelSettingsRoot: modelSettingsRoot.resolved } };
}

function readIdentity(options, request) {
  let raw;
  let identity;
  try {
    raw = options.identityValue == null ? fs.readFileSync(request.identity, "utf8") : JSON.stringify(options.identityValue);
    identity = options.identityValue == null ? JSON.parse(raw) : options.identityValue;
  } catch {
    throw runnerError("PRIVATE_FULL_CHAIN_INPUT_IDENTITY", "The private identity manifest is not valid JSON.");
  }
  if (!checkIdentityValue(identity)) {
    throw runnerError("PRIVATE_FULL_CHAIN_INPUT_IDENTITY", "The private identity manifest must contain a non-empty names, phones, or emails value.");
  }
  return { raw, identity };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function preparePrivateResume(options, env) {
  const gate = validatePrivateFullChainRequest({ ...(options || {}), mode: "prepare" }, env, null);
  if (!gate.ok) throw runnerError(gate.code, gate.message);
  const { request } = gate;
  const { raw: identityRaw, identity } = readIdentity(options || {}, request);
  let pdf;
  try {
    pdf = fs.readFileSync(request.pdf);
  } catch {
    throw runnerError("PRIVATE_FULL_CHAIN_RESUME_REQUIRED", "The explicit source PDF could not be read.");
  }
  const { parseResumeUpload } = require("../src/core/resume_parser");
  const { prepareResumeTextForModel, assertResumeIdentityRedacted } = require("../src/core/resume_privacy");
  const parsed = await parseResumeUpload({ fileName: path.basename(request.pdf), buffer: pdf, root: path.resolve(__dirname, "..") });
  const prepared = prepareResumeTextForModel(parsed.text, { originalFileName: path.basename(request.pdf), identity, strict: true });
  try {
    assertResumeIdentityRedacted(prepared.text, identity);
  } catch {
    throw runnerError("PRIVATE_FULL_CHAIN_INPUT_IDENTITY", "Identity redaction verification failed.");
  }
  const storedText = prepared.text + "\n";
  const report = {
    runMode: "private-prepare",
    authorizationGatePassed: true,
    extractionMethod: parsed.diagnostics.extractionMethod,
    charCount: prepared.text.length,
    detectedSections: parsed.diagnostics.quality.detectedSections,
    missingSections: parsed.diagnostics.quality.missingSections,
    textTruncated: Boolean(parsed.textTruncated),
    redactions: prepared.redactions,
    resumeContentSha256: sha256(storedText),
    identityManifestSha256: sha256(identityRaw),
    evaluatedCommit: request.evaluatedCommit
  };
  fs.mkdirSync(request.output, { recursive: true });
  fs.writeFileSync(path.join(request.output, "resume.redacted.txt"), storedText, "utf8");
  fs.writeFileSync(path.join(request.output, "parse-report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  return report;
}

function verifyPrivateBundle(options) {
  const gate = validatePrivateFullChainRequest({ ...(options || {}), mode: "verify-private-bundle" }, {}, null);
  if (!gate.ok) throw runnerError(gate.code, gate.message);
  const request = gate.request;
  let resumeText;
  let identityRaw;
  let report;
  try {
    resumeText = fs.readFileSync(request.resumeText, "utf8");
    identityRaw = fs.readFileSync(request.identity, "utf8");
    report = JSON.parse(fs.readFileSync(request.parseReport, "utf8"));
  } catch {
    throw runnerError("PRIVATE_FULL_CHAIN_INPUT_IDENTITY", "The private bundle is incomplete or invalid.");
  }
  let identity;
  try { identity = JSON.parse(identityRaw); } catch { throw runnerError("PRIVATE_FULL_CHAIN_INPUT_IDENTITY", "The identity manifest is invalid."); }
  if (!checkIdentityValue(identity) || report?.runMode !== "private-prepare" || report.resumeContentSha256 !== sha256(resumeText)
    || report.identityManifestSha256 !== sha256(identityRaw)) {
    throw runnerError("PRIVATE_FULL_CHAIN_INPUT_IDENTITY", "The private bundle hashes or identity manifest do not match.");
  }
  const { assertResumeIdentityRedacted } = require("../src/core/resume_privacy");
  try { assertResumeIdentityRedacted(resumeText, identity); } catch { throw runnerError("PRIVATE_FULL_CHAIN_INPUT_IDENTITY", "The private bundle contains unredacted identity data."); }
  return { ok: true, runMode: "offline-verify-private-bundle" };
}

function inspectWorktree(worktree) {
  const cwd = canonicalizeExisting(worktree);
  const runGit = (args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
  try {
    const head = runGit(["rev-parse", "HEAD"]);
    const status = runGit(["status", "--porcelain"]);
    if (!/^[0-9a-f]{40}$/i.test(head) || status) throw runnerError("PRIVATE_FULL_CHAIN_WORKTREE_DIRTY", "A manifest worktree must be clean and have a concrete HEAD.");
    const blobs = Object.fromEntries(SHARED_MANIFEST_FILES.map((file) => [file, runGit(["rev-parse", `HEAD:${file}`])]));
    return { head, blobs };
  } catch (error) {
    if (error?.code === "PRIVATE_FULL_CHAIN_WORKTREE_DIRTY") throw error;
    throw runnerError("PRIVATE_FULL_CHAIN_WORKTREE_DIRTY", "A manifest worktree could not be verified as clean.");
  }
}

function initializePrivateManifest(options) {
  const gate = validatePrivateFullChainRequest({ ...(options || {}), mode: "init-manifest" }, {}, null);
  if (!gate.ok) throw runnerError(gate.code, gate.message);
  const baseline = inspectWorktree(gate.request.baselineWorktree);
  const candidate = inspectWorktree(gate.request.candidateWorktree);
  for (const file of SHARED_MANIFEST_FILES) {
    if (baseline.blobs[file] !== candidate.blobs[file]) {
      throw runnerError("PRIVATE_FULL_CHAIN_WORKTREE_DIRTY", `Shared runner dependency differs between worktrees: ${file}`);
    }
  }
  const manifest = {
    runMode: "private-init-manifest",
    baselineCommit: baseline.head,
    candidateCommit: candidate.head,
    sharedFileBlobs: baseline.blobs
  };
  fs.mkdirSync(path.dirname(gate.request.output), { recursive: true });
  fs.writeFileSync(gate.request.output, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return manifest;
}

function comparePrivateFullChainResults(baseline, candidate) {
  return compareBenchmarkResults(baseline, candidate);
}

function parseCli(argv) {
  const options = {};
  const flags = new Set(["--init-manifest", "--prepare", "--verify-private-bundle", "--profile-live", "--card-live", "--match-live", "--compare"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (flags.has(arg)) {
      if (options.mode) throw runnerError("PRIVATE_FULL_CHAIN_MODE_REQUIRED", "Choose exactly one mode.");
      options.mode = arg.slice(2);
      continue;
    }
    if (!arg.startsWith("--")) throw runnerError("PRIVATE_FULL_CHAIN_MODE_REQUIRED", `Unknown argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw runnerError("PRIVATE_FULL_CHAIN_MODE_REQUIRED", `Missing value for ${arg}`);
    const field = arg.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    options[field] = value;
    index += 1;
  }
  return options;
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.mode === "prepare" || LIVE_MODES.has(options.mode)) {
    const worktree = inspectWorktree(path.resolve(__dirname, ".."));
    options.worktreeClean = true;
    options.evaluatedCommit = worktree.head;
  }
  if (options.mode === "prepare") {
    await preparePrivateResume(options, process.env);
    return;
  }
  if (options.mode === "init-manifest") {
    initializePrivateManifest(options);
    return;
  }
  if (options.mode === "verify-private-bundle") {
    verifyPrivateBundle(options);
    return;
  }
  if (options.mode === "compare") {
    const gate = validatePrivateFullChainRequest(options, process.env, null);
    if (!gate.ok) throw runnerError(gate.code, gate.message);
    const result = comparePrivateFullChainResults(
      JSON.parse(fs.readFileSync(gate.request.baseline, "utf8")),
      JSON.parse(fs.readFileSync(gate.request.candidate, "utf8"))
    );
    if (!result.ok) throw runnerError(result.code, result.message);
    fs.mkdirSync(path.dirname(gate.request.report), { recursive: true });
    fs.writeFileSync(gate.request.report, JSON.stringify(result.report, null, 2) + "\n", "utf8");
    return;
  }
  const gate = validatePrivateFullChainRequest(options, process.env, null);
  if (!gate.ok) throw runnerError(gate.code, gate.message);
  throw runnerError("PRIVATE_FULL_CHAIN_REAL_MODEL_REQUIRED", "Live execution wiring is intentionally deferred until the mode-local implementation is available.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[${error.code || "PRIVATE_FULL_CHAIN_FAILURE"}] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  validatePrivateFullChainRequest,
  preparePrivateResume,
  verifyPrivateBundle,
  initializePrivateManifest,
  comparePrivateFullChainResults
};
