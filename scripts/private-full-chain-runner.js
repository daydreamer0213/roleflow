const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { compareBenchmarkResults, deriveBenchmarkMetrics } = require("./lib/benchmark_metrics");

const PRIVATE_PARENT = "D:\\DevData\\RoleFlow-private-benchmark";
const FIXED_CANDIDATE_WORKTREE = "D:\\DevData\\RoleFlow-worktrees\\claude-generic-evidence-matching-live-fix";
const MODES = new Set(["init-manifest", "prepare", "verify-private-bundle", "profile-live", "card-live", "match-live", "compare"]);
const LIVE_MODES = new Set(["profile-live", "card-live", "match-live"]);
const PRIVATE_HARNESS_VERSION = "private-full-chain-harness.v1";
const SAFE_SEMANTIC_STATUSES = new Set(["complete", "partial", "pending", "failed", "stale", "blocked", "refresh", "rule_only"]);
const SAFE_DECISION_SOURCES = new Set(["local_rules", "model", "analysis_pending", "hard_boundary", "source_refresh"]);
const SAFE_DECISION_STATES = new Set(["ready", "blocked", "refresh"]);
const PRIVATE_JOB_KEYS = [
  "id", "sourceId", "keyword", "title", "company", "location", "salary",
  "url", "description", "sourceContentHash", "capturedAt"
];
const PRIVATE_LABEL_KEYS = ["id", "expectedRecommendation", "expectedBucket", "rationale"];
const PRIVATE_RECOMMENDATIONS = new Set(["apply", "caution", "review", "skip"]);
const PRIVATE_BUCKETS = new Set(["primary", "talk", "backup", "not_recommended"]);
const PRIVATE_LABEL_PAIRS = new Set(["apply/primary", "caution/talk", "review/talk", "skip/not_recommended"]);
const SAFE_ERROR_CODES = new Set([
  "CANDIDATE_PROFILE_REQUIRED",
  "MODEL_ANALYSIS_FAILED",
  "MODEL_CONTRACT_INVALID",
  "MODEL_REQUEST_FAILED",
  "MODEL_TIMEOUT"
]);
const SHARED_MANIFEST_FILES = ["scripts/private-full-chain-runner.js", "scripts/lib/benchmark_metrics.js"];
const PARSE_REPORT_KEYS = [
  "runMode", "authorizationGatePassed", "extractionMethod", "charCount", "detectedSections",
  "missingSections", "textTruncated", "redactions", "resumeContentSha256", "identityManifestSha256", "evaluatedCommit"
];

function fail(code, message) { return { ok: false, code, message }; }
function runnerError(code, message, statusCode = 400) {
  const error = Object.assign(new Error(message), { code, statusCode, privateFullChainSafeError: true });
  return error;
}
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function samePath(left, right) { return String(left).toLowerCase() === String(right).toLowerCase(); }
function isDriveRoot(value) { return path.parse(value).root.toLowerCase() === String(value).toLowerCase(); }
function isWithinDirectory(candidate, directory) {
  const relative = path.relative(String(directory).toLowerCase(), String(candidate).toLowerCase());
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function isLocalAbsolutePath(value) {
  const raw = String(value || "").trim();
  return Boolean(raw) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && path.isAbsolute(raw);
}

// Resolve every existing ancestor. A broken, inaccessible, or drive-root path is never a safe alias.
function canonicalizePath(value, { allowMissingLeaf = true } = {}) {
  if (!isLocalAbsolutePath(value)) return null;
  const absolute = path.resolve(String(value));
  if (isDriveRoot(absolute)) return null;
  let existing = absolute;
  const missing = [];
  while (!fs.existsSync(existing)) {
    try {
      // existsSync is false for a dangling Windows junction/symlink. Do not climb through it.
      fs.lstatSync(existing);
      return null;
    } catch (error) {
      if (error?.code && error.code !== "ENOENT") return null;
    }
    if (!allowMissingLeaf) return null;
    const parent = path.dirname(existing);
    if (parent === existing || isDriveRoot(existing)) return null;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  let canonicalParent;
  try { canonicalParent = fs.realpathSync.native(existing); } catch { return null; }
  if (!canonicalParent || isDriveRoot(canonicalParent)) return null;
  return path.join(canonicalParent, ...missing);
}

const canonicalPrivateParent = canonicalizePath(PRIVATE_PARENT);
const canonicalRuntimeWorktree = canonicalizePath(path.resolve(__dirname, ".."), { allowMissingLeaf: false });

function canonicalFixedCandidateWorktree() {
  return canonicalizePath(FIXED_CANDIDATE_WORKTREE, { allowMissingLeaf: false });
}

function forbiddenArtifactLocation(candidate) {
  if (!candidate || !canonicalRuntimeWorktree) return true;
  const roots = [
    canonicalRuntimeWorktree,
    canonicalizePath(path.join(canonicalRuntimeWorktree, "data")),
    canonicalizePath(path.join(canonicalRuntimeWorktree, ".runtime"))
  ];
  return roots.some((root) => !root || isWithinDirectory(candidate, root)) || /\.sqlite$/i.test(candidate);
}

function hasReparsePoint(value) {
  const absolute = path.resolve(String(value));
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return true;
    } catch { return true; }
  }
  return false;
}

function isInsideGitRepository(value) {
  let current = path.dirname(value);
  while (current && !isDriveRoot(current)) {
    if (fs.existsSync(path.join(current, ".git"))) return true;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

function checkPrivateRoot(value) {
  if (!String(value || "").trim()) return fail("PRIVATE_FULL_CHAIN_PRIVATE_ROOT_REQUIRED", "A private benchmark root is required.");
  const resolved = canonicalizePath(value);
  if (!resolved || !canonicalPrivateParent || samePath(resolved, canonicalPrivateParent)
    || !isWithinDirectory(resolved, canonicalPrivateParent) || forbiddenArtifactLocation(resolved)) {
    return fail("PRIVATE_FULL_CHAIN_PRIVATE_ROOT_FORBIDDEN", "The private benchmark root must be a canonical directory below the approved private parent.");
  }
  return { ok: true, resolved };
}

function checkPrivateArtifact(value, privateRoot, requiredCode, forbiddenCode = "PRIVATE_FULL_CHAIN_PRIVATE_ROOT_FORBIDDEN") {
  if (!String(value || "").trim()) return fail(requiredCode, "A required private artifact path is missing.");
  const resolved = canonicalizePath(value);
  if (!resolved || !isWithinDirectory(resolved, privateRoot) || forbiddenArtifactLocation(resolved)) {
    return fail(forbiddenCode, "Private artifacts must use a canonical local path inside the selected private bundle.");
  }
  return { ok: true, resolved };
}

function newPrivateOutputTarget(privateRoot, file) {
  const root = canonicalizePath(privateRoot, { allowMissingLeaf: false });
  const target = canonicalizePath(file);
  if (!root || !target || !canonicalPrivateParent || !isWithinDirectory(root, canonicalPrivateParent)
    || !isWithinDirectory(target, root) || fs.existsSync(target)) {
    throw runnerError("PRIVATE_FULL_CHAIN_OUTPUT_REQUIRED", "Private output targets must be new files inside the selected private bundle.");
  }
  return target;
}

function preparePrivateSqliteCache(privateRoot, output) {
  const cachePath = path.join(output, "model-cache.sqlite");
  if (fs.existsSync(cachePath)) {
    throw runnerError("PRIVATE_FULL_CHAIN_CACHE_EXISTS", "Match live requires a fresh per-side SQLite cache.");
  }
  for (const target of [cachePath, `${cachePath}-wal`, `${cachePath}-shm`]) {
    newPrivateOutputTarget(privateRoot, target);
  }
  fs.mkdirSync(output, { recursive: true });
  const root = canonicalizePath(privateRoot, { allowMissingLeaf: false });
  const directory = canonicalizePath(output, { allowMissingLeaf: false });
  if (!root || !directory || hasReparsePoint(output) || !isWithinDirectory(directory, root)) {
    throw runnerError("PRIVATE_FULL_CHAIN_OUTPUT_REQUIRED", "SQLite cache directories must remain canonical paths inside the selected private bundle.");
  }
  return cachePath;
}

function exclusivePrivateWrite(privateRoot, file, content) {
  const target = newPrivateOutputTarget(privateRoot, file);
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  const root = canonicalizePath(privateRoot, { allowMissingLeaf: false });
  const parent = canonicalizePath(directory, { allowMissingLeaf: false });
  if (!root || !parent || hasReparsePoint(directory) || !isWithinDirectory(parent, root)) {
    throw runnerError("PRIVATE_FULL_CHAIN_OUTPUT_REQUIRED", "Private output directories must remain canonical paths inside the selected private bundle.");
  }
  try {
    fs.writeFileSync(target, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") throw runnerError("PRIVATE_FULL_CHAIN_OUTPUT_REQUIRED", "Private output targets must not overwrite existing artifacts.");
    throw error;
  }
  const written = canonicalizePath(target, { allowMissingLeaf: false });
  const finalRoot = canonicalizePath(privateRoot, { allowMissingLeaf: false });
  const finalParent = canonicalizePath(directory, { allowMissingLeaf: false });
  if (!written || !finalRoot || !finalParent || hasReparsePoint(directory)
    || !isWithinDirectory(finalParent, finalRoot) || !isWithinDirectory(written, finalRoot)) {
    throw runnerError("PRIVATE_FULL_CHAIN_OUTPUT_REQUIRED", "Private output paths changed during creation.");
  }
}

// Baseline source code is a worktree, not a private run artifact: it is a sibling of the run root.
function checkBaselineWorktree(value) {
  if (!String(value || "").trim()) return fail("PRIVATE_FULL_CHAIN_RESUME_REQUIRED", "A baseline worktree is required.");
  const resolved = canonicalizePath(value);
  const forbiddenRoots = [canonicalizePath(os.homedir()), canonicalizePath(os.tmpdir())];
  const modelRootLiteral = path.resolve("D:\\Guo\\ZhiPing");
  if (!resolved || !canonicalPrivateParent || !isWithinDirectory(resolved, canonicalPrivateParent)
    || forbiddenRoots.some((root) => !root || isWithinDirectory(resolved, root))
    || isWithinDirectory(resolved, modelRootLiteral)
    || samePath(resolved, path.resolve(FIXED_CANDIDATE_WORKTREE))) {
    return fail("PRIVATE_FULL_CHAIN_PRIVATE_ROOT_FORBIDDEN", "Baseline must be a distinct canonical worktree below the approved private parent.");
  }
  return { ok: true, resolved };
}

function checkApprovedPrivateArtifact(value, requiredCode) {
  if (!String(value || "").trim()) return fail(requiredCode, "A required private artifact path is missing.");
  const resolved = canonicalizePath(value);
  if (!resolved || !canonicalPrivateParent || !isWithinDirectory(resolved, canonicalPrivateParent) || forbiddenArtifactLocation(resolved)) {
    return fail("PRIVATE_FULL_CHAIN_PRIVATE_ROOT_FORBIDDEN", "Private artifacts must use a canonical path below the approved private parent.");
  }
  return { ok: true, resolved };
}

function checkExternalPdf(value, privateRoot) {
  if (!String(value || "").trim()) return fail("PRIVATE_FULL_CHAIN_RESUME_REQUIRED", "Prepare requires an explicit local PDF path.");
  const resolved = canonicalizePath(value, { allowMissingLeaf: false });
  const mainProjectData = canonicalizePath("D:\\Guo\\ZhiPing\\data");
  const tempRoot = canonicalizePath(os.tmpdir());
  let regularFile = false;
  try { regularFile = Boolean(resolved && fs.statSync(resolved).isFile()); } catch {}
  if (!resolved || path.extname(resolved).toLowerCase() !== ".pdf" || hasReparsePoint(value)
    || !regularFile || isWithinDirectory(resolved, privateRoot)
    || (canonicalPrivateParent && isWithinDirectory(resolved, canonicalPrivateParent))
    || (mainProjectData && isWithinDirectory(resolved, mainProjectData))
    || (tempRoot && isWithinDirectory(resolved, tempRoot)) || isInsideGitRepository(resolved)) {
    return fail("PRIVATE_FULL_CHAIN_RESUME_REQUIRED", "The source PDF must be a canonical local PDF path outside the private bundle.");
  }
  return { ok: true, resolved };
}

function checkModelSettingsRoot(value) {
  if (!String(value || "").trim()) return fail("PRIVATE_FULL_CHAIN_MODEL_SETTINGS_ROOT_REQUIRED", "Live modes require an explicit model settings root.");
  const resolved = canonicalizePath(value);
  const forbiddenRoots = [canonicalizePath(os.homedir()), canonicalizePath(os.tmpdir())];
  if (!resolved || forbiddenArtifactLocation(resolved)
    || forbiddenRoots.some((root) => !root || isWithinDirectory(resolved, root))
    || (canonicalPrivateParent && isWithinDirectory(resolved, canonicalPrivateParent))) {
    return fail("PRIVATE_FULL_CHAIN_MODEL_SETTINGS_ROOT_FORBIDDEN", "The model settings root must be a canonical local path outside repositories, private bundles, home, and temp.");
  }
  return { ok: true, resolved };
}

function normalizedMode(value) {
  const raw = String(value || "").trim();
  return raw.startsWith("--") ? raw.slice(2) : raw;
}

function checkIdentityManifestShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = ["names", "phones", "emails"];
  return fields.every((field) => Array.isArray(value[field]) && value[field].every((item) => typeof item === "string"))
    && fields.some((field) => value[field].some((item) => item.trim()));
}

function checkSyntheticGitProof(value) {
  if (value == null) return { ok: true, proof: null };
  if (value?.clean !== true || !/^[0-9a-f]{7,40}$/i.test(String(value.commit || ""))) {
    return fail("PRIVATE_FULL_CHAIN_WORKTREE_DIRTY", "The supplied synthetic worktree proof is not clean and commit-bound.");
  }
  return { ok: true, proof: { clean: true, commit: String(value.commit).toLowerCase() } };
}

function checkSideAndOutput(options, privateRoot) {
  const side = String(options.side || "").trim();
  if (side !== "baseline" && side !== "candidate") return fail("PRIVATE_FULL_CHAIN_OUTPUT_REQUIRED", "Live modes require --side baseline or candidate.");
  const output = checkPrivateArtifact(options.output, privateRoot, "PRIVATE_FULL_CHAIN_OUTPUT_REQUIRED");
  if (!output.ok) return output;
  const expected = canonicalizePath(path.join(privateRoot, "runs", side));
  if (!expected || !samePath(output.resolved, expected)) return fail("PRIVATE_FULL_CHAIN_OUTPUT_REQUIRED", "The live output directory must match the selected side.");
  return { ok: true, side, output: output.resolved };
}

function validateComparePaths(options) {
  const reportValue = String(options.report || "").trim();
  const markdownValue = isLocalAbsolutePath(reportValue)
    ? path.join(path.dirname(path.resolve(reportValue)), "full-chain-compare.md")
    : "";
  const baseline = checkApprovedPrivateArtifact(options.baseline, "PRIVATE_FULL_CHAIN_RESUME_REQUIRED");
  const candidate = checkApprovedPrivateArtifact(options.candidate, "PRIVATE_FULL_CHAIN_RESUME_REQUIRED");
  const report = checkApprovedPrivateArtifact(reportValue, "PRIVATE_FULL_CHAIN_OUTPUT_REQUIRED");
  const markdownReport = checkApprovedPrivateArtifact(markdownValue, "PRIVATE_FULL_CHAIN_OUTPUT_REQUIRED");
  const failed = [baseline, candidate, report, markdownReport].find((item) => !item.ok);
  if (failed) return failed;
  const baselineRun = path.dirname(baseline.resolved);
  const candidateRun = path.dirname(candidate.resolved);
  const bundle = path.dirname(path.dirname(baselineRun));
  const reports = path.join(bundle, "reports");
  if (path.basename(baseline.resolved).toLowerCase() !== "match-result.json" || path.basename(candidate.resolved).toLowerCase() !== "match-result.json"
    || path.basename(baselineRun).toLowerCase() !== "baseline" || path.basename(candidateRun).toLowerCase() !== "candidate"
    || path.basename(path.dirname(baselineRun)).toLowerCase() !== "runs" || !samePath(path.dirname(path.dirname(candidateRun)), bundle)
    || !samePath(path.dirname(report.resolved), reports) || !samePath(path.dirname(markdownReport.resolved), reports)
    || path.basename(report.resolved).toLowerCase() !== "full-chain-compare.json"
    || path.basename(markdownReport.resolved).toLowerCase() !== "full-chain-compare.md"
    || samePath(baseline.resolved, candidate.resolved)
    || [baseline.resolved, candidate.resolved].some((input) => samePath(input, report.resolved) || samePath(input, markdownReport.resolved))
    || samePath(report.resolved, markdownReport.resolved)
    || fs.existsSync(report.resolved) || fs.existsSync(markdownReport.resolved)) {
    return fail("PRIVATE_FULL_CHAIN_OUTPUT_REQUIRED", "Compare requires baseline/candidate match-result files from one bundle and new JSON and Markdown targets in that bundle's reports directory.");
  }
  return {
    ok: true,
    request: {
      mode: "compare",
      baseline: baseline.resolved,
      candidate: candidate.resolved,
      report: report.resolved,
      markdownReport: markdownReport.resolved,
      privateRoot: bundle
    }
  };
}

function validatePrivateFullChainRequest(options, env, providerResolver) {
  const opts = options || {};
  const environ = env || {};
  const mode = normalizedMode(opts.mode);
  if (!MODES.has(mode)) return fail("PRIVATE_FULL_CHAIN_MODE_REQUIRED", "Choose exactly one supported private full-chain mode.");
  if (mode === "compare") return validateComparePaths(opts);

  const root = checkPrivateRoot(opts.privateRoot);
  if (!root.ok) return root;
  if (mode === "init-manifest") {
    const baseline = checkBaselineWorktree(opts.baselineWorktree);
    const candidate = isLocalAbsolutePath(opts.candidateWorktree) ? path.resolve(String(opts.candidateWorktree)) : null;
    const output = checkPrivateArtifact(opts.output, root.resolved, "PRIVATE_FULL_CHAIN_OUTPUT_REQUIRED");
    if (!baseline.ok) return baseline;
    if (!candidate || !samePath(candidate, path.resolve(FIXED_CANDIDATE_WORKTREE))
      || samePath(baseline.resolved, root.resolved) || samePath(baseline.resolved, candidate)) {
      return fail("PRIVATE_FULL_CHAIN_PRIVATE_ROOT_FORBIDDEN", "Manifest baseline must be a distinct private worktree and candidate must be the fixed candidate worktree.");
    }
    if (!output.ok) return output;
    if (!/^[0-9a-f]{7,40}$/i.test(String(opts.baselineProductCommit || ""))) {
      return fail("PRIVATE_FULL_CHAIN_WORKTREE_DIRTY", "Manifest initialization requires a baseline product commit to verify from Git evidence.");
    }
    return { ok: true, code: "OK", request: {
      mode, privateRoot: root.resolved, baselineWorktree: baseline.resolved, candidateWorktree: candidate,
      baselineProductCommit: String(opts.baselineProductCommit).toLowerCase(), output: output.resolved
    } };
  }
  if (mode === "prepare") {
    const pdf = checkExternalPdf(opts.pdf, root.resolved);
    const identity = checkPrivateArtifact(opts.identity, root.resolved, "PRIVATE_FULL_CHAIN_IDENTITY_REQUIRED");
    const output = checkPrivateArtifact(opts.output, root.resolved, "PRIVATE_FULL_CHAIN_OUTPUT_REQUIRED");
    if (!pdf.ok) return pdf;
    if (!identity.ok) return identity;
    if (!output.ok) return output;
    if (environ.ALLOW_PRIVATE_RESUME_BENCHMARK !== "YES") return fail("PRIVATE_FULL_CHAIN_NOT_AUTHORIZED", "Prepare requires ALLOW_PRIVATE_RESUME_BENCHMARK=YES.");
    const proof = checkSyntheticGitProof(opts.gitProof);
    if (!proof.ok) return proof;
    return { ok: true, code: "OK", request: { mode, privateRoot: root.resolved, pdf: pdf.resolved, identity: identity.resolved, output: output.resolved, evaluatedCommit: proof.proof?.commit || "" } };
  }
  if (mode === "verify-private-bundle") {
    const resumeText = checkPrivateArtifact(opts.resumeText, root.resolved, "PRIVATE_FULL_CHAIN_RESUME_REQUIRED");
    const identity = checkPrivateArtifact(opts.identity, root.resolved, "PRIVATE_FULL_CHAIN_IDENTITY_REQUIRED");
    const parseReport = checkPrivateArtifact(opts.parseReport, root.resolved, "PRIVATE_FULL_CHAIN_OUTPUT_REQUIRED");
    const failed = [resumeText, identity, parseReport].find((item) => !item.ok);
    if (failed) return failed;
    return { ok: true, code: "OK", request: { mode, privateRoot: root.resolved, resumeText: resumeText.resolved, identity: identity.resolved, parseReport: parseReport.resolved } };
  }

  const side = checkSideAndOutput(opts, root.resolved);
  if (!side.ok) return side;
  const liveInputs = {};
  if (mode === "profile-live") {
    const resumeText = checkPrivateArtifact(opts.resumeText, root.resolved, "PRIVATE_FULL_CHAIN_RESUME_REQUIRED");
    const identity = checkPrivateArtifact(opts.identity, root.resolved, "PRIVATE_FULL_CHAIN_IDENTITY_REQUIRED");
    const failed = [resumeText, identity].find((item) => !item.ok);
    if (failed) return failed;
    Object.assign(liveInputs, { resumeText: resumeText.resolved, identity: identity.resolved });
  } else if (mode === "card-live") {
    const profile = checkPrivateArtifact(opts.profile, root.resolved, "PRIVATE_FULL_CHAIN_RESUME_REQUIRED");
    if (!profile.ok) return profile;
    liveInputs.profile = profile.resolved;
  } else {
    for (const field of ["profile", "matchingCard", "jobs", "labels"]) {
      const checked = checkPrivateArtifact(opts[field], root.resolved, "PRIVATE_FULL_CHAIN_RESUME_REQUIRED");
      if (!checked.ok) return checked;
      liveInputs[field] = checked.resolved;
    }
  }
  if (environ.ALLOW_PRIVATE_RESUME_BENCHMARK !== "YES") return fail("PRIVATE_FULL_CHAIN_NOT_AUTHORIZED", "Live modes require ALLOW_PRIVATE_RESUME_BENCHMARK=YES.");
  if (environ.ALLOW_LIVE_MODEL_BENCHMARK !== "YES") return fail("PRIVATE_FULL_CHAIN_MODEL_NOT_AUTHORIZED", "Live modes require ALLOW_LIVE_MODEL_BENCHMARK=YES.");
  const settings = checkModelSettingsRoot(opts.modelSettingsRoot);
  if (!settings.ok) return settings;
  const descriptor = opts.modelDescriptor;
  if (!descriptor || typeof descriptor.provider !== "string" || !descriptor.provider || descriptor.provider === "mock") return fail("PRIVATE_FULL_CHAIN_REAL_MODEL_REQUIRED", "Live modes require a pre-validated non-mock model descriptor.");
  const proof = checkSyntheticGitProof(opts.gitProof);
  if (!proof.ok) return proof;
  void providerResolver;
  return {
    ok: true,
    code: "OK",
    request: {
      mode,
      privateRoot: root.resolved,
      side: side.side,
      output: side.output,
      modelSettingsRoot: settings.resolved,
      evaluatedCommit: proof.proof?.commit || "",
      ...liveInputs
    }
  };
}

function inspectFixedCandidateWorktree() {
  const candidate = canonicalFixedCandidateWorktree();
  if (!candidate) throw runnerError("PRIVATE_FULL_CHAIN_WORKTREE_DIRTY", "The fixed candidate worktree cannot be canonicalized.");
  const runGit = (args) => execFileSync("git", args, { cwd: candidate, encoding: "utf8", windowsHide: true }).trim();
  try {
    const commit = runGit(["rev-parse", "HEAD"]);
    const dirty = runGit(["status", "--porcelain"]);
    if (!/^[0-9a-f]{40}$/i.test(commit) || dirty) throw runnerError("PRIVATE_FULL_CHAIN_WORKTREE_DIRTY", "The fixed candidate worktree must be clean and commit-bound.");
    return { clean: true, commit: commit.toLowerCase() };
  } catch (error) {
    if (error?.code === "PRIVATE_FULL_CHAIN_WORKTREE_DIRTY") throw error;
    throw runnerError("PRIVATE_FULL_CHAIN_WORKTREE_DIRTY", "The fixed candidate worktree could not be inspected.");
  }
}

function readIdentityFile(identityPath) {
  let raw;
  let identity;
  try { raw = fs.readFileSync(identityPath, "utf8"); identity = JSON.parse(raw); } catch { throw runnerError("PRIVATE_FULL_CHAIN_INPUT_IDENTITY", "The private identity manifest is invalid."); }
  if (!checkIdentityManifestShape(identity)) throw runnerError("PRIVATE_FULL_CHAIN_INPUT_IDENTITY", "The private identity manifest has an invalid schema.");
  return { raw, identity };
}

function safePrepareFailure(error) {
  const code = /^RESUME_(?:UNSUPPORTED_FORMAT|EMPTY_FILE|FILE_TOO_LARGE|TEXT_TOO_SHORT|CONTENT_UNUSABLE|PDF_TIMEOUT|PDF_PARSE_FAILED|DOCX_TIMEOUT|DOCX_PARSE_FAILED)$/.test(String(error?.code || ""))
    ? error.code : "PRIVATE_FULL_CHAIN_PREPARE_FAILED";
  const safe = runnerError(code, "The local resume could not be prepared. Check the PDF text layer and try an export with selectable text.", Number.isInteger(error?.statusCode) ? error.statusCode : 400);
  safe.action = "Use an existing local PDF with selectable text; no source content was written.";
  return safe;
}

function orderedSections(text, assessResumeText) {
  const assessed = assessResumeText(text);
  const patterns = {
    education: /教育|学校|大学|学院|学历|本科|硕士|博士|education/i,
    experience: /工作经历|实习经历|任职|公司|岗位|experience|employment/i,
    project: /项目经历|项目名称|项目背景|项目职责|project/i,
    skills: /专业技能|技能|技术栈|skill/i
  };
  const detectedSections = assessed.detectedSections
    .map((name) => [name, text.search(patterns[name])])
    .filter(([, index]) => index >= 0)
    .sort((left, right) => left[1] - right[1])
    .map(([name]) => name);
  return { detectedSections, missingSections: ["education", "experience", "project", "skills"].filter((name) => !detectedSections.includes(name)), textTruncated: false };
}

async function preparePrivateResume(options, env) {
  const opts = { ...(options || {}) };
  delete opts.worktreeClean;
  delete opts.evaluatedCommit;
  delete opts.gitProof;
  const gate = validatePrivateFullChainRequest({ ...opts, mode: "prepare" }, env, null);
  if (!gate.ok) throw runnerError(gate.code, gate.message);
  const proof = inspectFixedCandidateWorktree();
  const request = { ...gate.request, evaluatedCommit: proof.commit };
  const resumeOutput = path.join(request.output, "resume.redacted.txt");
  const reportOutput = path.join(request.output, "parse-report.json");
  newPrivateOutputTarget(request.privateRoot, resumeOutput);
  newPrivateOutputTarget(request.privateRoot, reportOutput);
  const { raw: identityRaw, identity } = readIdentityFile(request.identity);
  let pdf;
  try { pdf = fs.readFileSync(request.pdf); } catch { throw runnerError("PRIVATE_FULL_CHAIN_RESUME_REQUIRED", "The explicit source PDF could not be read."); }
  try {
    const { parseResumeUpload } = require("../src/core/resume_parser");
    const { prepareResumeTextForModel, assertResumeIdentityRedacted } = require("../src/core/resume_privacy");
    const candidate = canonicalFixedCandidateWorktree();
    if (!candidate) throw runnerError("PRIVATE_FULL_CHAIN_WORKTREE_DIRTY", "The fixed candidate worktree cannot be canonicalized.");
    const parsed = await parseResumeUpload({ fileName: path.basename(request.pdf), buffer: pdf, root: candidate });
    const prepared = prepareResumeTextForModel(parsed.text, { originalFileName: path.basename(request.pdf), identity, strict: true });
    assertResumeIdentityRedacted(prepared.text, identity);
    const { assessResumeText } = require("../src/core/resume_parser");
    const storedText = prepared.text + "\n";
    const sections = orderedSections(prepared.text, assessResumeText);
    const report = {
      runMode: "private-prepare", authorizationGatePassed: true, extractionMethod: parsed.diagnostics.extractionMethod,
      charCount: prepared.text.length, detectedSections: sections.detectedSections, missingSections: sections.missingSections,
      textTruncated: Boolean(parsed.textTruncated), redactions: prepared.redactions,
      resumeContentSha256: sha256(storedText), identityManifestSha256: sha256(identityRaw), evaluatedCommit: request.evaluatedCommit
    };
    exclusivePrivateWrite(request.privateRoot, resumeOutput, storedText);
    exclusivePrivateWrite(request.privateRoot, reportOutput, JSON.stringify(report, null, 2) + "\n");
    return report;
  } catch (error) {
    if (error?.code === "RESUME_PRIVACY_REDACTION_FAILED") throw runnerError("PRIVATE_FULL_CHAIN_INPUT_IDENTITY", "Identity redaction verification failed.");
    throw safePrepareFailure(error);
  }
}

function reportHasOnlySafeShape(report, identity) {
  if (!report || typeof report !== "object" || Array.isArray(report) || JSON.stringify(Object.keys(report).sort()) !== JSON.stringify([...PARSE_REPORT_KEYS].sort())) return false;
  if (report.runMode !== "private-prepare" || report.authorizationGatePassed !== true || typeof report.extractionMethod !== "string"
    || !Number.isInteger(report.charCount) || report.charCount < 0 || !Array.isArray(report.detectedSections)
    || !Array.isArray(report.missingSections) || typeof report.textTruncated !== "boolean"
    || !/^[0-9a-f]{64}$/i.test(String(report.resumeContentSha256 || ""))
    || !/^[0-9a-f]{64}$/i.test(String(report.identityManifestSha256 || ""))
    || !/^[0-9a-f]{7,40}$/i.test(String(report.evaluatedCommit || ""))) return false;
  if (!report.redactions || typeof report.redactions !== "object" || Array.isArray(report.redactions) || Object.values(report.redactions).some((value) => !Number.isInteger(value) || value < 0)) return false;
  const serialized = JSON.stringify(report);
  if (/"(?:preview|[^"\\]*path[^"\\]*|[^"\\]*filename[^"\\]*|[^"\\]*model[^"\\]*setting[^"\\]*)"\s*:/i.test(serialized)) return false;
  const values = [];
  const collectStrings = (value) => {
    if (typeof value === "string") values.push(value);
    else if (value && typeof value === "object") Object.values(value).forEach(collectStrings);
  };
  collectStrings(report);
  if (values.some((value) => /(?:[a-z]:[\\/]|[\\/]|\.pdf\b|preview|file\s*name|model\s*settings?)/i.test(value))) return false;
  try {
    const { assertResumeIdentityRedacted } = require("../src/core/resume_privacy");
    assertResumeIdentityRedacted(serialized, identity);
  } catch { return false; }
  return true;
}

function verifyPrivateBundle(options) {
  const gate = validatePrivateFullChainRequest({ ...(options || {}), mode: "verify-private-bundle" }, {}, null);
  if (!gate.ok) throw runnerError(gate.code, gate.message);
  const request = gate.request;
  let resumeText;
  let identityRaw;
  let report;
  try { resumeText = fs.readFileSync(request.resumeText, "utf8"); identityRaw = fs.readFileSync(request.identity, "utf8"); report = JSON.parse(fs.readFileSync(request.parseReport, "utf8")); }
  catch { throw runnerError("PRIVATE_FULL_CHAIN_INPUT_IDENTITY", "The private bundle is incomplete or invalid."); }
  let identity;
  try { identity = JSON.parse(identityRaw); } catch { throw runnerError("PRIVATE_FULL_CHAIN_INPUT_IDENTITY", "The identity manifest is invalid."); }
  if (!checkIdentityManifestShape(identity) || !reportHasOnlySafeShape(report, identity)) throw runnerError("PRIVATE_FULL_CHAIN_INPUT_IDENTITY", "The private parse report contains invalid or sensitive data.");
  const { assessResumeText, normalizeText } = require("../src/core/resume_parser");
  const privacy = require("../src/core/resume_privacy");
  try { privacy.assertResumeIdentityRedacted(resumeText, identity); } catch { throw runnerError("PRIVATE_FULL_CHAIN_INPUT_IDENTITY", "The private bundle contains unredacted identity data."); }
  const normalized = normalizeText(resumeText);
  const sections = orderedSections(normalized.text, assessResumeText);
  if (report.runMode !== "private-prepare" || report.authorizationGatePassed !== true || report.resumeContentSha256 !== sha256(resumeText)
    || report.identityManifestSha256 !== sha256(identityRaw) || report.charCount !== normalized.text.length
    || JSON.stringify(report.detectedSections) !== JSON.stringify(sections.detectedSections)
    || JSON.stringify(report.missingSections) !== JSON.stringify(sections.missingSections)) {
    throw runnerError("PRIVATE_FULL_CHAIN_INPUT_IDENTITY", "The private bundle report does not match the redacted resume text.");
  }
  return { ok: true, runMode: "offline-verify-private-bundle" };
}

function inspectWorktree(worktree) {
  const cwd = canonicalizePath(worktree, { allowMissingLeaf: false });
  if (!cwd) throw runnerError("PRIVATE_FULL_CHAIN_WORKTREE_DIRTY", "A manifest worktree cannot be canonicalized.");
  const runGit = (args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
  try {
    const head = runGit(["rev-parse", "HEAD"]);
    if (!/^[0-9a-f]{40}$/i.test(head) || runGit(["status", "--porcelain"])) throw runnerError("PRIVATE_FULL_CHAIN_WORKTREE_DIRTY", "A manifest worktree must be clean and commit-bound.");
    return { head: head.toLowerCase(), blobs: Object.fromEntries(SHARED_MANIFEST_FILES.map((file) => [file, runGit(["rev-parse", `HEAD:${file}`])])) };
  } catch (error) {
    if (error?.code === "PRIVATE_FULL_CHAIN_WORKTREE_DIRTY") throw error;
    throw runnerError("PRIVATE_FULL_CHAIN_WORKTREE_DIRTY", "A manifest worktree could not be inspected.");
  }
}

function initializePrivateManifest(options) {
  const gate = validatePrivateFullChainRequest({ ...(options || {}), mode: "init-manifest" }, {}, null);
  if (!gate.ok) throw runnerError(gate.code, gate.message);
  const fixedCandidate = canonicalFixedCandidateWorktree();
  const suppliedCandidate = canonicalizePath(gate.request.candidateWorktree, { allowMissingLeaf: false });
  if (!fixedCandidate || !suppliedCandidate || !samePath(fixedCandidate, suppliedCandidate)) {
    throw runnerError("PRIVATE_FULL_CHAIN_PRIVATE_ROOT_FORBIDDEN", "The manifest candidate must canonicalize to the fixed candidate worktree.");
  }
  const baseline = inspectWorktree(gate.request.baselineWorktree);
  const candidate = inspectWorktree(suppliedCandidate);
  if (samePath(baseline.head, candidate.head) || SHARED_MANIFEST_FILES.some((file) => baseline.blobs[file] !== candidate.blobs[file])) {
    throw runnerError("PRIVATE_FULL_CHAIN_WORKTREE_DIRTY", "Baseline and candidate worktrees must be distinct commits with identical shared runner files.");
  }
  const baselineProductCommit = verifyProductCommit(gate.request.baselineWorktree, gate.request.baselineProductCommit, baseline.head);
  assertDistinctManifestProducts(baselineProductCommit, candidate.head);
  const manifest = {
    runMode: "private-init-manifest",
    harnessVersion: PRIVATE_HARNESS_VERSION,
    baselineProductCommit,
    baselineEvaluatedCommit: baseline.head,
    candidateProductCommit: candidate.head,
    candidateEvaluatedCommit: candidate.head,
    sharedFileBlobs: baseline.blobs
  };
  exclusivePrivateWrite(gate.request.privateRoot, gate.request.output, JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function stableJson(value) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch {
    throw runnerError("PRIVATE_FULL_CHAIN_INPUT_IDENTITY", "Private hash inputs must be JSON serializable.");
  }
  if (serialized === undefined) {
    throw runnerError("PRIVATE_FULL_CHAIN_INPUT_IDENTITY", "Private hash inputs must be JSON serializable.");
  }
  return canonicalJson(JSON.parse(serialized));
}

function valueSha256(value) {
  return sha256(stableJson(value));
}

function readJsonFile(file, code = "PRIVATE_FULL_CHAIN_INPUT_IDENTITY") {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object") throw new Error("invalid");
    return value;
  } catch {
    throw runnerError(code, "A private full-chain input is missing or invalid.");
  }
}

function writeJsonFile(privateRoot, file, value) {
  exclusivePrivateWrite(privateRoot, file, JSON.stringify(value, null, 2) + "\n");
}

function verifyProductCommit(worktree, productCommit, evaluatedCommit) {
  const cwd = canonicalizePath(worktree, { allowMissingLeaf: false });
  if (!cwd) throw runnerError("PRIVATE_FULL_CHAIN_WORKTREE_DIRTY", "A product commit cannot be verified from its worktree.");
  const runGit = (args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
  try {
    const product = runGit(["rev-parse", "--verify", `${productCommit}^{commit}`]).toLowerCase();
    execFileSync("git", ["merge-base", "--is-ancestor", product, evaluatedCommit], { cwd, windowsHide: true });
    if (!/^[0-9a-f]{40}$/.test(product)) throw new Error("invalid product commit");
    return product;
  } catch {
    throw runnerError("PRIVATE_FULL_CHAIN_WORKTREE_DIRTY", "The product commit must be Git-verifiable and precede the evaluated tooling commit.");
  }
}

function assertDistinctManifestProducts(baselineProductCommit, candidateProductCommit) {
  if (String(baselineProductCommit || "").toLowerCase() === String(candidateProductCommit || "").toLowerCase()) {
    throw runnerError("PRIVATE_FULL_CHAIN_WORKTREE_DIRTY", "Baseline and candidate product commits must be distinct.");
  }
}

function privacySafeRequestSettings(value) {
  if (Array.isArray(value)) return value.map(privacySafeRequestSettings);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/(?:api.?key|token|password|authorization|cookie|secret|credential)/i.test(key))
    .map(([key, item]) => [key, privacySafeRequestSettings(item)]));
}

function sanitizedModelIdentity(modelConfig) {
  const provider = String(modelConfig?.provider || "");
  const selected = modelConfig?.providers?.[provider] || {};
  const endpoint = String(selected.baseUrl || "");
  const identity = {
    provider,
    model: String(selected.model || ""),
    timeoutMs: Number(selected.timeoutMs || 0),
    endpointSha256: endpoint ? sha256(endpoint) : "",
    requestSettingsSha256: valueSha256(privacySafeRequestSettings(selected))
  };
  if (!provider || provider === "mock" || !identity.model || !Number.isFinite(identity.timeoutMs)
    || !/^[0-9a-f]{64}$/.test(identity.endpointSha256)) {
    throw runnerError("PRIVATE_FULL_CHAIN_REAL_MODEL_REQUIRED", "Live modes require one complete, non-mock model identity.");
  }
  return identity;
}

function inspectLiveWorktree(side) {
  if (side === "candidate") {
    const fixed = canonicalFixedCandidateWorktree();
    if (!fixed || !canonicalRuntimeWorktree || !samePath(fixed, canonicalRuntimeWorktree)) {
      throw runnerError("PRIVATE_FULL_CHAIN_WORKTREE_DIRTY", "Candidate live mode must run from the fixed candidate worktree.");
    }
  } else {
    const baseline = checkBaselineWorktree(canonicalRuntimeWorktree);
    if (!baseline.ok) throw runnerError(baseline.code, baseline.message);
  }
  const inspected = inspectWorktree(canonicalRuntimeWorktree);
  return { clean: true, commit: inspected.head };
}

function loadProductionModules(mode) {
  const { loadConfigs } = require("../src/config");
  const { resolveRuntimeModelConfig } = require("../src/core/model_settings");
  if (mode === "profile-live") {
    const { analyzeResumeProfile } = require("../src/core/profile_onboarding");
    const { assertResumeIdentityRedacted } = require("../src/core/resume_privacy");
    return { loadConfigs, resolveRuntimeModelConfig, analyzeResumeProfile, assertResumeIdentityRedacted };
  }
  if (mode === "card-live") {
    const onboarding = require("../src/core/profile_onboarding");
    let normalizeMatchingCard = null;
    try { ({ normalizeMatchingCard } = require("../src/core/matching_card")); } catch {}
    return { loadConfigs, resolveRuntimeModelConfig, buildCandidateMatchCard: onboarding.buildCandidateMatchCard, normalizeMatchingCard };
  }
  const { profileToRuntimeConfigs } = require("../src/core/search_plan");
  const { createJobAnalysisRunner } = require("../src/core/job_analysis");
  const { decisionHardBlockers } = require("../src/core/model_contract");
  const { scoreJob, decisionState } = require("../src/core/scoring");
  const { openDb, decisionBucket } = require("../src/core/storage");
  const { mapWithConcurrency } = require("../src/core/async_pool");
  return {
    loadConfigs,
    resolveRuntimeModelConfig,
    profileToRuntimeConfigs,
    createJobAnalysisRunner,
    scoreJob,
    decisionState,
    decisionHardBlockers,
    openDb,
    decisionBucket,
    mapWithConcurrency
  };
}

function liveManifest(privateRoot, side, evaluatedCommit) {
  const manifest = readJsonFile(path.join(privateRoot, "run-manifest.json"));
  const expected = String(side === "baseline" ? manifest.baselineEvaluatedCommit : manifest.candidateEvaluatedCommit || "").toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(expected) || expected !== String(evaluatedCommit || "").toLowerCase()) {
    throw runnerError("PRIVATE_FULL_CHAIN_WORKTREE_DIRTY", "The live worktree commit does not match the private run manifest.");
  }
  return manifest;
}

function privateSearchPlan(profile) {
  const candidate = profile?.candidate || {};
  const directions = Array.isArray(candidate.targetTitles) ? candidate.targetTitles.filter(Boolean) : [];
  const city = String(candidate.city || "").trim();
  return {
    name: "Private full-chain benchmark",
    cities: city ? [city] : [],
    salary: { minK: 0, maxK: 0 },
    salaryMode: "wide",
    experience: ["经验不限", "0-3年", "1-3年", "3-5年（可冲）"],
    allowExperienceStretch: true,
    jobTypes: ["全职"],
    directions,
    keywords: directions.map((word) => ({ word, priority: "A", reason: "confirmed private profile" })),
    bossActiveDays: 3,
    workSchedulePreference: "prefer_double_weekend",
    excludeWords: [],
    hardExcludes: []
  };
}

function confirmedProfileInput(value, context) {
  if (value?.status !== "confirmed" || value?.userConfirmed !== true || !String(value?.id || "").trim()
    || !Number.isFinite(Date.parse(value?.confirmedAt))) {
    throw runnerError("PRIVATE_FULL_CHAIN_PROFILE_UNCONFIRMED", "Match live requires a user-confirmed canonical profile envelope.");
  }
  try {
    return { envelope: value, ...validateProfileResultProvenance(value, context) };
  } catch {
    throw runnerError("PRIVATE_FULL_CHAIN_PROFILE_UNCONFIRMED", "The confirmed profile provenance does not match this run.");
  }
}

function cardDraftPayload(value) {
  const payload = { ...value };
  delete payload.draftSha256;
  return payload;
}

function confirmedCardInput(value, profileInput, context) {
  const card = value?.card;
  const draft = value?.draft;
  const currentFields = [
    "runMode", "authorizationGatePassed", "benchmarkHarnessVersion", "runManifestSha256", "side",
    "evaluatedCommit", "worktreeClean", "modelIdentitySha256", "resumeContentSha256",
    "identityManifestSha256", "profileResultSha256", "profileSha256"
  ];
  const expectedDraftRunMode = context.injected ? "offline-test" : "live-card-draft";
  const expectedDraftAuthorized = !context.injected;
  let cardSha256;
  try { cardSha256 = valueSha256(card); } catch { cardSha256 = ""; }
  if (value?.status !== "confirmed" || value?.userConfirmed !== true || !String(value?.id || "").trim()
    || !Number.isFinite(Date.parse(value?.confirmedAt))
    || !card || typeof card !== "object" || value.cardSha256 !== cardSha256
    || currentFields.some((field) => value[field] !== profileInput.envelope[field])
    || !hasBoundModelIdentity(value)
    || !draft || typeof draft !== "object" || Array.isArray(draft)
    || value.draftSha256 !== draft.draftSha256
    || draft.draftSha256 !== valueSha256(cardDraftPayload(draft))
    || draft.runMode !== expectedDraftRunMode
    || draft.authorizationGatePassed !== expectedDraftAuthorized
    || draft.benchmarkHarnessVersion !== PRIVATE_HARNESS_VERSION
    || draft.runManifestSha256 !== context.runManifestSha256
    || draft.side !== "candidate"
    || String(draft.evaluatedCommit || "").toLowerCase() !== String(context.manifest?.candidateEvaluatedCommit || "").toLowerCase()
    || draft.worktreeClean !== true
    || !hasBoundModelIdentity(draft)
    || draft.modelIdentitySha256 !== value.modelIdentitySha256
    || draft.resumeContentSha256 !== value.resumeContentSha256
    || draft.identityManifestSha256 !== value.identityManifestSha256
    || draft.profileSha256 !== value.profileSha256
    || !/^[0-9a-f]{64}$/.test(String(value.draftProfileResultSha256 || ""))
    || draft.profileResultSha256 !== value.draftProfileResultSha256
    || (context.side === "candidate" && draft.profileResultSha256 !== value.profileResultSha256)
    || draft.cardSha256 !== valueSha256(draft.card)) {
    throw runnerError("PRIVATE_FULL_CHAIN_CARD_UNCONFIRMED", "Match live requires a confirmed card whose profile hash matches the canonical profile.");
  }
  return { envelope: value, card, cardSha256 };
}

function sameKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function frozenJobSourceContentHash(job) {
  return sha256(JSON.stringify({
    title: job.title || "",
    company: job.company || "",
    location: job.location || "",
    salary: job.salary || "",
    experience: "",
    education: "",
    tags: [],
    description: job.description || ""
  }));
}

function privateJobsAndLabels(jobsValue, labelsValue) {
  const jobs = Array.isArray(jobsValue) ? jobsValue : jobsValue?.rows;
  const labels = labelsValue?.rows;
  const labelEnvelopeKeys = ["labelsVersion", "userConfirmed", "confirmedAt", "jobsSha256", "rows"];
  if (!Array.isArray(jobs) || !jobs.length || !Array.isArray(labels)
    || !sameKeys(labelsValue, labelEnvelopeKeys)
    || labelsValue.labelsVersion !== "private-real-jd-labels.v1"
    || labelsValue.userConfirmed !== true
    || !String(labelsValue.confirmedAt || "").trim()
    || !Number.isFinite(Date.parse(labelsValue.confirmedAt))) {
    throw runnerError("PRIVATE_FULL_CHAIN_FIXTURE_INVALID", "Match live requires non-empty jobs and user-confirmed labels.");
  }
  for (const job of jobs) {
    if (!sameKeys(job, PRIVATE_JOB_KEYS)
      || PRIVATE_JOB_KEYS.filter((field) => field !== "sourceContentHash").some((field) => !String(job[field] ?? "").trim())
      || String(job.description).trim().length < 120
      || !/^[0-9a-f]{64}$/.test(String(job.sourceContentHash || ""))
      || job.sourceContentHash !== frozenJobSourceContentHash(job)
      || !Number.isFinite(Date.parse(job.capturedAt))) {
      throw runnerError("PRIVATE_FULL_CHAIN_FIXTURE_INVALID", "Every frozen job must match the canonical JD schema, analysis length, and source content hash.");
    }
  }
  const jobIds = jobs.map((job) => String(job?.id || "").trim());
  const labelIds = labels.map((label) => String(label?.id || "").trim());
  if (jobIds.some((id) => !id) || labelIds.some((id) => !id)
    || new Set(jobIds).size !== jobIds.length || new Set(labelIds).size !== labelIds.length
    || JSON.stringify([...jobIds].sort()) !== JSON.stringify([...labelIds].sort())
    || labels.some((label) => !sameKeys(label, PRIVATE_LABEL_KEYS)
      || !String(label.rationale || "").trim()
      || !PRIVATE_RECOMMENDATIONS.has(label.expectedRecommendation)
      || !PRIVATE_BUCKETS.has(label.expectedBucket)
      || !PRIVATE_LABEL_PAIRS.has(`${label.expectedRecommendation}/${label.expectedBucket}`))) {
    throw runnerError("PRIVATE_FULL_CHAIN_FIXTURE_INVALID", "Job and label IDs must be unique, complete, and exactly equal.");
  }
  const jobsSha256 = valueSha256(jobs);
  if (!/^[0-9a-f]{64}$/.test(String(labelsValue.jobsSha256 || ""))
    || labelsValue.jobsSha256 !== jobsSha256) {
    throw runnerError("PRIVATE_FULL_CHAIN_FIXTURE_INVALID", "The frozen label set does not match the frozen job set.");
  }
  return {
    jobs,
    labels,
    jobsSha256,
    labelsSha256: valueSha256(labelsValue),
    labelById: new Map(labels.map((label) => [String(label.id), label]))
  };
}

function readProfileLiveInputs(request, assertResumeIdentityRedacted) {
  let redactedText;
  let identityRaw;
  let identity;
  try {
    redactedText = fs.readFileSync(request.resumeText, "utf8");
    identityRaw = fs.readFileSync(request.identity, "utf8");
    identity = JSON.parse(identityRaw);
  } catch {
    throw runnerError("PRIVATE_FULL_CHAIN_INPUT_IDENTITY", "The redacted resume or private identity manifest is invalid.");
  }
  if (!checkIdentityManifestShape(identity)) {
    throw runnerError("PRIVATE_FULL_CHAIN_INPUT_IDENTITY", "The private identity manifest has an invalid schema.");
  }
  try {
    assertResumeIdentityRedacted(redactedText, identity);
  } catch {
    throw runnerError("PRIVATE_FULL_CHAIN_INPUT_IDENTITY", "Profile live requires identity-redacted resume text.");
  }
  return { redactedText, identityRaw, identity };
}

function profileResultPayload(value) {
  const payload = { ...value };
  for (const field of ["id", "status", "userConfirmed", "confirmedAt", "profileResultSha256"]) delete payload[field];
  return payload;
}

function validateProfileResultProvenance(value, context) {
  const expectedRunMode = context.injected ? "offline-test" : "live-profile";
  const expectedAuthorized = !context.injected;
  const expectedCommit = String(context.manifest?.candidateEvaluatedCommit || "").toLowerCase();
  let profileSha256;
  try { profileSha256 = valueSha256(value?.profile); } catch { profileSha256 = ""; }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.runMode !== expectedRunMode
    || value.authorizationGatePassed !== expectedAuthorized
    || value.benchmarkHarnessVersion !== PRIVATE_HARNESS_VERSION
    || value.runManifestSha256 !== context.runManifestSha256
    || value.side !== "candidate"
    || String(value.evaluatedCommit || "").toLowerCase() !== expectedCommit
    || value.worktreeClean !== true
    || value.profileReviewStatus !== "pending"
    || value.profileSha256 !== profileSha256
    || !/^[0-9a-f]{64}$/.test(String(value.resumeContentSha256 || ""))
    || !/^[0-9a-f]{64}$/.test(String(value.identityManifestSha256 || ""))
    || !hasBoundModelIdentity(value)
    || value.profileResultSha256 !== valueSha256(profileResultPayload(value))) {
    throw runnerError("PRIVATE_FULL_CHAIN_INPUT_IDENTITY", "The private profile result provenance is incomplete or mismatched.");
  }
  return { profileResult: value, profile: value.profile, profileSha256 };
}

function readCardLiveInput(request, context) {
  const profileResult = readJsonFile(request.profile);
  return validateProfileResultProvenance(profileResult, context);
}

function readMatchResumeAndIdentity(privateRoot, assertResumeIdentityRedacted) {
  let resumeText;
  let identityRaw;
  try {
    resumeText = fs.readFileSync(path.join(privateRoot, "input", "resume.redacted.txt"), "utf8");
    identityRaw = fs.readFileSync(path.join(privateRoot, "identity.private.json"), "utf8");
  } catch {
    try {
      identityRaw = fs.readFileSync(path.join(privateRoot, "input", "identity.private.json"), "utf8");
      resumeText = fs.readFileSync(path.join(privateRoot, "input", "resume.redacted.txt"), "utf8");
    } catch {
      throw runnerError("PRIVATE_FULL_CHAIN_INPUT_IDENTITY", "Match live cannot verify the redacted resume and identity hashes.");
    }
  }
  let identity;
  try { identity = JSON.parse(identityRaw); } catch {
    throw runnerError("PRIVATE_FULL_CHAIN_INPUT_IDENTITY", "Match live cannot verify the redacted resume and identity hashes.");
  }
  if (!checkIdentityManifestShape(identity)) {
    throw runnerError("PRIVATE_FULL_CHAIN_INPUT_IDENTITY", "Match live cannot verify the redacted resume and identity hashes.");
  }
  try {
    assertResumeIdentityRedacted(resumeText, identity);
  } catch {
    throw runnerError("PRIVATE_FULL_CHAIN_INPUT_IDENTITY", "Match live cannot verify the redacted resume and identity hashes.");
  }
  return { resumeText, identityRaw };
}

function preflightPrivacyValidator(testSeam) {
  if (typeof testSeam?.modules?.assertResumeIdentityRedacted === "function") {
    return testSeam.modules.assertResumeIdentityRedacted;
  }
  return require("../src/core/resume_privacy").assertResumeIdentityRedacted;
}

function runAuthorizationMetadata(testSeam, liveRunMode) {
  return testSeam
    ? { runMode: "offline-test", authorizationGatePassed: false }
    : { runMode: liveRunMode, authorizationGatePassed: true };
}

function ruleBlockedAnalysis() {
  return {
    provider: "rule-gate",
    semanticStatus: "blocked",
    decisionSource: "hard_boundary",
    recommendation: "skip",
    fitLevel: "D",
    confidence: null,
    fitReasons: [],
    missingPoints: [],
    hardBlockers: [],
    evidence: { jd: [], resume: [] },
    errorCode: ""
  };
}

function safeEnum(value, allowed, fallback) {
  const text = String(value || "");
  return allowed.has(text) ? text : fallback;
}

function safeErrorCode(value) {
  const text = String(value || "");
  if (!text) return "";
  if (SAFE_ERROR_CODES.has(text) || /^HTTP_[1-5][0-9]{2}$/.test(text)) return text;
  return "MODEL_ANALYSIS_FAILED";
}

async function runPrivateFullChain(options, env, testSeam = null) {
  const opts = { ...(options || {}) };
  const gateOptions = testSeam ? opts : { ...opts, modelDescriptor: { provider: "post-gate-runtime-resolution" } };
  const gate = validatePrivateFullChainRequest(gateOptions, env, null);
  if (!gate.ok) throw runnerError(gate.code, gate.message);
  const request = gate.request;
  if (request.mode === "profile-live" && request.side !== "candidate") {
    throw runnerError("PRIVATE_FULL_CHAIN_PROFILE_UNSUPPORTED", "The baseline product does not generate the canonical candidate profile.");
  }
  const resultFile = request.mode === "profile-live" ? path.join(request.output, "profile.json")
    : request.mode === "card-live" ? path.join(request.output, "matching-card-draft.json")
      : path.join(request.output, "match-result.json");
  if (request.mode !== "match-live") newPrivateOutputTarget(request.privateRoot, resultFile);
  const proof = testSeam
    ? { clean: true, commit: request.evaluatedCommit }
    : inspectLiveWorktree(request.side);
  if (!proof.commit) throw runnerError("PRIVATE_FULL_CHAIN_WORKTREE_DIRTY", "Live mode requires a clean, commit-bound worktree.");
  const manifest = liveManifest(request.privateRoot, request.side, proof.commit);
  const runManifestSha256 = valueSha256(manifest);
  const privacyValidator = request.mode === "card-live" ? null : preflightPrivacyValidator(testSeam);
  const preflight = request.mode === "profile-live"
    ? readProfileLiveInputs(request, privacyValidator)
    : request.mode === "card-live"
      ? readCardLiveInput(request, {
        injected: Boolean(testSeam),
        manifest,
        runManifestSha256,
        side: request.side,
        evaluatedCommit: proof.commit
      })
      : {
        profileValue: readJsonFile(request.profile),
        cardValue: readJsonFile(request.matchingCard),
        jobsValue: readJsonFile(request.jobs),
        labelsValue: readJsonFile(request.labels),
        resume: readMatchResumeAndIdentity(request.privateRoot, privacyValidator)
      };
  if (request.mode === "match-live") {
    const provenanceContext = {
      injected: Boolean(testSeam),
      manifest,
      runManifestSha256,
      side: request.side,
      evaluatedCommit: proof.commit
    };
    preflight.profileInput = confirmedProfileInput(preflight.profileValue, provenanceContext);
    preflight.cardInput = confirmedCardInput(preflight.cardValue, preflight.profileInput, provenanceContext);
    if (preflight.profileInput.envelope.resumeContentSha256 !== sha256(preflight.resume.resumeText)
      || preflight.profileInput.envelope.identityManifestSha256 !== sha256(preflight.resume.identityRaw)) {
      throw runnerError("PRIVATE_FULL_CHAIN_PROFILE_UNCONFIRMED", "The confirmed profile is not bound to the current resume evidence.");
    }
    preflight.fixture = privateJobsAndLabels(preflight.jobsValue, preflight.labelsValue);
  }
  if (request.mode === "card-live" && request.side !== "candidate") {
    throw runnerError("PRIVATE_FULL_CHAIN_CARD_UNSUPPORTED", "The baseline product does not support matching-card generation.");
  }

  const modules = testSeam?.modules || loadProductionModules(request.mode);
  if (request.mode === "card-live"
    && (typeof modules.buildCandidateMatchCard !== "function" || typeof modules.normalizeMatchingCard !== "function")) {
    throw runnerError("PRIVATE_FULL_CHAIN_CARD_UNSUPPORTED", "This product commit does not support matching-card generation.");
  }
  const base = testSeam?.baseConfigs || modules.loadConfigs(canonicalRuntimeWorktree);
  const modelConfig = testSeam?.modelConfig || modules.resolveRuntimeModelConfig({
    root: request.modelSettingsRoot,
    fallbackModelConfig: base.model
  }).modelConfig;
  const modelIdentity = sanitizedModelIdentity(modelConfig);
  const modelIdentitySha256 = valueSha256(modelIdentity);
  if (request.mode === "card-live" && preflight.profileResult.modelIdentitySha256 !== modelIdentitySha256) {
    throw runnerError("PRIVATE_FULL_CHAIN_INPUT_IDENTITY", "Card live model identity must match the bound profile result.");
  }
  if (request.mode === "match-live" && preflight.profileInput.envelope.modelIdentitySha256 !== modelIdentitySha256) {
    throw runnerError("PRIVATE_FULL_CHAIN_PROFILE_UNCONFIRMED", "Match live model identity must match the confirmed provenance chain.");
  }

  if (request.mode === "profile-live") {
    const resume = {
      originalFileName: "private-resume.redacted.txt",
      format: "text",
      text: preflight.redactedText,
      contentHash: sha256(preflight.redactedText),
      diagnostics: { extractionMethod: "private_redacted_text" }
    };
    const profile = await modules.analyzeResumeProfile({ modelConfig, resume, identity: preflight.identity, strictPrivacy: true });
    const result = {
      ...runAuthorizationMetadata(testSeam, "live-profile"),
      benchmarkHarnessVersion: PRIVATE_HARNESS_VERSION,
      runManifestSha256,
      side: request.side,
      evaluatedCommit: proof.commit,
      productCommit: manifest.candidateProductCommit,
      worktreeClean: true,
      modelIdentity,
      modelIdentitySha256,
      resumeContentSha256: resume.contentHash,
      identityManifestSha256: sha256(preflight.identityRaw),
      profileSha256: valueSha256(profile),
      profileReviewStatus: "pending",
      profile
    };
    result.profileResultSha256 = valueSha256(result);
    writeJsonFile(request.privateRoot, resultFile, result);
    return result;
  }

  if (request.mode === "card-live") {
    const card = await modules.buildCandidateMatchCard({ modelConfig, profile: preflight.profile });
    const normalized = modules.normalizeMatchingCard(card, { source: "model" });
    const result = {
      ...runAuthorizationMetadata(testSeam, "live-card-draft"),
      benchmarkHarnessVersion: PRIVATE_HARNESS_VERSION,
      runManifestSha256,
      side: request.side,
      evaluatedCommit: proof.commit,
      productCommit: manifest.candidateProductCommit,
      worktreeClean: true,
      modelIdentity,
      modelIdentitySha256,
      resumeContentSha256: preflight.profileResult.resumeContentSha256,
      identityManifestSha256: preflight.profileResult.identityManifestSha256,
      profileSha256: preflight.profileSha256,
      profileResultSha256: preflight.profileResult.profileResultSha256,
      status: "draft",
      userConfirmed: false,
      cardSha256: valueSha256(normalized),
      card: normalized
    };
    result.draftSha256 = valueSha256(result);
    writeJsonFile(request.privateRoot, resultFile, result);
    return result;
  }

  const { profileInput, cardInput, fixture } = preflight;
  const { resumeText, identityRaw } = preflight.resume;
  const searchPlan = privateSearchPlan(profileInput.profile);
  const runtimeBase = { ...base, model: modelConfig, candidateProfile: profileInput.profile };
  const configs = modules.profileToRuntimeConfigs(
    runtimeBase,
    profileInput.profile,
    searchPlan,
    null,
    cardInput.card
  );
  const matchingCardConsumed = configs?.matchingCard != null
    && valueSha256(configs.matchingCard) === cardInput.cardSha256;
  const cachePath = preparePrivateSqliteCache(request.privateRoot, request.output);
  newPrivateOutputTarget(request.privateRoot, resultFile);
  const db = modules.openDb(cachePath);
  let rows;
  try {
    const analyze = modules.createJobAnalysisRunner(configs, searchPlan.keywords, {
      db,
      ...(testSeam?.adapter ? { analyzer: testSeam.adapter } : {})
    });
    rows = await modules.mapWithConcurrency(fixture.jobs, 3, async (job) => {
      const scored = modules.scoreJob(job, configs);
      const state = modules.decisionState(scored);
      const analysis = state === "ready" ? await analyze({ ...job, ...scored }) : ruleBlockedAnalysis();
      const actualBucket = modules.decisionBucket({ ...job, ...scored, analysis });
      const label = fixture.labelById.get(String(job.id));
      const actualRecommendation = String(analysis.recommendation || "review");
      return {
        id: String(job.id),
        expectedRecommendation: label.expectedRecommendation,
        actualRecommendation,
        expectedBucket: label.expectedBucket,
        actualBucket,
        semanticStatus: safeEnum(analysis.semanticStatus, SAFE_SEMANTIC_STATUSES, "failed"),
        evidenceComplete: Boolean(analysis.evidence?.jd?.length && analysis.evidence?.resume?.length),
        explanation: {
          decisionSource: safeEnum(analysis.decisionSource, SAFE_DECISION_SOURCES, "unknown"),
          fitReasonCount: Array.isArray(analysis.fitReasons) ? analysis.fitReasons.length : 0,
          missingPointCount: Array.isArray(analysis.missingPoints || analysis.softGaps)
            ? (analysis.missingPoints || analysis.softGaps).length
            : 0
        },
        hardBlocked: state === "blocked" || modules.decisionHardBlockers(analysis).length > 0,
        decisionState: safeEnum(state, SAFE_DECISION_STATES, "unknown"),
        errorCode: safeErrorCode(analysis.errorCode),
        pass: actualRecommendation === label.expectedRecommendation && actualBucket === label.expectedBucket
      };
    });
  } finally {
    db.close();
  }
  const derived = deriveBenchmarkMetrics(rows);
  if (!derived.ok) throw runnerError(derived.code, derived.message);
  const result = {
    ...runAuthorizationMetadata(testSeam, "live"),
    benchmarkHarnessVersion: PRIVATE_HARNESS_VERSION,
    runManifestSha256,
    side: request.side,
    evaluatedCommit: proof.commit,
    productCommit: request.side === "baseline" ? manifest.baselineProductCommit : manifest.candidateProductCommit,
    baselineBehaviorCommit: request.side === "candidate" ? manifest.baselineProductCommit : null,
    worktreeClean: true,
    resumeContentSha256: sha256(resumeText),
    identityManifestSha256: sha256(identityRaw),
    fixtureProfileId: String(profileInput.envelope.id || "confirmed-private-profile"),
    fixtureProfileSha256: profileInput.profileSha256,
    fixtureProfileResultSha256: profileInput.envelope.profileResultSha256,
    fixtureResumeVersionsSha256: valueSha256(profileInput.profile.resumeVersions || []),
    profileReviewStatus: "confirmed",
    fixtureMatchingCardId: String(cardInput.envelope.id),
    fixtureMatchingCardSha256: cardInput.cardSha256,
    fixtureMatchingCardDraftSha256: cardInput.envelope.draftSha256,
    matchingCardProvided: true,
    matchingCardConsumed,
    cardReviewStatus: "confirmed",
    fixtureJobSetSha256: fixture.jobsSha256,
    fixtureLabelsSha256: fixture.labelsSha256,
    modelIdentity,
    modelIdentitySha256,
    ...derived.metrics,
    rows
  };
  writeJsonFile(request.privateRoot, resultFile, result);
  return result;
}

function samePrivateSha(baseline, candidate, field) {
  const left = String(baseline?.[field] || "").toLowerCase();
  const right = String(candidate?.[field] || "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(left) && left === right;
}

function hasBoundModelIdentity(value) {
  try {
    return /^[0-9a-f]{64}$/.test(String(value?.modelIdentity?.requestSettingsSha256 || ""))
      && valueSha256(value.modelIdentity) === value.modelIdentitySha256;
  } catch {
    return false;
  }
}

function comparePrivateFullChainResults(baseline, candidate) {
  for (const [value, side] of [[baseline, "baseline"], [candidate, "candidate"]]) {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || value.runMode !== "live"
      || value.authorizationGatePassed !== true
      || value.worktreeClean !== true
      || value.side !== side
      || value.profileReviewStatus !== "confirmed"
      || value.cardReviewStatus !== "confirmed"
      || value.matchingCardProvided !== true
      || typeof value.matchingCardConsumed !== "boolean"
      || !/^[0-9a-f]{64}$/.test(String(value.fixtureProfileResultSha256 || ""))
      || !hasBoundModelIdentity(value)) {
      return fail("PRIVATE_FULL_CHAIN_COMPARE_IDENTITY", "Private comparison requires strict live authorization, confirmation, side, worktree, and card-state fields.");
    }
  }
  for (const field of [
    "resumeContentSha256",
    "identityManifestSha256",
    "fixtureProfileResultSha256",
    "fixtureProfileSha256",
    "fixtureMatchingCardSha256",
    "fixtureMatchingCardDraftSha256",
    "fixtureJobSetSha256",
    "fixtureLabelsSha256",
    "runManifestSha256",
    "modelIdentitySha256"
  ]) {
    if (!samePrivateSha(baseline, candidate, field)) {
      return fail("PRIVATE_FULL_CHAIN_COMPARE_IDENTITY", `Private comparison identity mismatch: ${field}.`);
    }
  }
  if (baseline?.benchmarkHarnessVersion !== PRIVATE_HARNESS_VERSION
    || candidate?.benchmarkHarnessVersion !== PRIVATE_HARNESS_VERSION
    || !/^[0-9a-f]{7,40}$/.test(String(baseline?.evaluatedCommit || ""))
    || !/^[0-9a-f]{7,40}$/.test(String(candidate?.evaluatedCommit || ""))
    || !/^[0-9a-f]{7,40}$/.test(String(baseline?.productCommit || ""))
    || !/^[0-9a-f]{7,40}$/.test(String(candidate?.productCommit || ""))
    || baseline.evaluatedCommit === candidate.evaluatedCommit
    || baseline.productCommit === candidate.productCommit
    || candidate.baselineBehaviorCommit !== baseline.productCommit
  ) {
    return fail("PRIVATE_FULL_CHAIN_COMPARE_IDENTITY", "Private comparison requires clean, confirmed, harness-bound live results.");
  }
  for (const value of [baseline, candidate]) {
    if (!Array.isArray(value.rows) || value.rows.some((row) => typeof row?.hardBlocked !== "boolean")) {
      return fail("BENCHMARK_COMPARE_METRICS", "Private comparison rows must record a boolean hard-blocker state.");
    }
  }
  const compared = compareBenchmarkResults({ ...baseline, evaluatedCommit: baseline.productCommit }, candidate);
  if (!compared.ok) return compared;
  const before = new Map(baseline.rows.map((row) => [row.id, row]));
  const changed = (predicate) => candidate.rows.filter((row) => predicate(before.get(row.id), row)).map((row) => row.id).sort();
  return {
    ok: true,
    report: {
      ...compared.report,
      runMode: "offline-private-compare",
      profile: {
        baselineSha256: baseline.fixtureProfileSha256,
        candidateSha256: candidate.fixtureProfileSha256,
        baselineReviewStatus: baseline.profileReviewStatus,
        candidateReviewStatus: candidate.profileReviewStatus
      },
      card: {
        providedToBoth: baseline.matchingCardProvided === true && candidate.matchingCardProvided === true,
        baselineConsumed: baseline.matchingCardConsumed === true,
        candidateConsumed: candidate.matchingCardConsumed === true
      },
      commits: {
        baselineProductCommit: baseline.productCommit,
        baselineEvaluatedCommit: baseline.evaluatedCommit,
        candidateProductCommit: candidate.productCommit,
        candidateEvaluatedCommit: candidate.evaluatedCommit
      },
      enteredNotRecommended: changed((left, right) => left?.actualBucket !== "not_recommended" && right.actualBucket === "not_recommended"),
      exitedNotRecommended: changed((left, right) => left?.actualBucket === "not_recommended" && right.actualBucket !== "not_recommended"),
      enteredPrimary: changed((left, right) => left?.actualBucket !== "primary" && right.actualBucket === "primary"),
      hardBlockerChanges: changed((left, right) => Boolean(left?.hardBlocked) !== Boolean(right.hardBlocked))
    }
  };
}

function renderPrivateCompareMarkdown(report) {
  return [
    "# Private full-chain comparison",
    "",
    `- Accepted: ${report.accepted}`,
    `- Baseline: ${report.baselineBehaviorCommit}`,
    `- Candidate: ${report.evaluatedCommit}`,
    `- Baseline card consumed: ${report.card.baselineConsumed}`,
    `- Candidate card consumed: ${report.card.candidateConsumed}`,
    `- Failure reasons: ${report.failureReasons.length ? report.failureReasons.join("; ") : "none"}`,
    ""
  ].join("\n");
}

function parseCli(argv) {
  const options = {};
  const flags = new Set([...MODES].map((mode) => `--${mode}`));
  const valueOptions = new Set([
    "--private-root", "--baseline-worktree", "--candidate-worktree", "--output", "--pdf", "--identity",
    "--resume-text", "--parse-report", "--side", "--profile", "--matching-card", "--jobs", "--labels",
    "--model-settings-root", "--baseline", "--candidate", "--report", "--baseline-product-commit"
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (flags.has(arg)) { if (options.mode) throw runnerError("PRIVATE_FULL_CHAIN_MODE_REQUIRED", "Choose exactly one mode."); options.mode = arg.slice(2); continue; }
    if (!valueOptions.has(arg)) throw runnerError("PRIVATE_FULL_CHAIN_MODE_REQUIRED", "Unknown command argument.");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw runnerError("PRIVATE_FULL_CHAIN_MODE_REQUIRED", `Missing value for ${arg}.`);
    options[arg.slice(2).replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase())] = value;
    index += 1;
  }
  return options;
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const pureOptions = LIVE_MODES.has(options.mode)
    ? { ...options, modelDescriptor: { provider: "post-gate-runtime-resolution" } }
    : options;
  const pureGate = validatePrivateFullChainRequest(pureOptions, process.env, null);
  if (!pureGate.ok) throw runnerError(pureGate.code, pureGate.message);
  if (options.mode === "prepare") return preparePrivateResume(options, process.env);
  if (options.mode === "init-manifest") return initializePrivateManifest(options);
  if (options.mode === "verify-private-bundle") return verifyPrivateBundle(options);
  if (options.mode === "compare") {
    const result = comparePrivateFullChainResults(JSON.parse(fs.readFileSync(pureGate.request.baseline, "utf8")), JSON.parse(fs.readFileSync(pureGate.request.candidate, "utf8")));
    if (!result.ok) throw runnerError(result.code, result.message);
    exclusivePrivateWrite(pureGate.request.privateRoot, pureGate.request.report, JSON.stringify(result.report, null, 2) + "\n");
    exclusivePrivateWrite(pureGate.request.privateRoot, pureGate.request.markdownReport, renderPrivateCompareMarkdown(result.report));
    if (!result.report.accepted) process.exitCode = 1;
    return;
  }
  return runPrivateFullChain(options, process.env);
}

function safeCliFailure(error) {
  if (error?.privateFullChainSafeError === true && typeof error.code === "string") {
    return `[${error.code}] ${error.message}`;
  }
  const code = SAFE_ERROR_CODES.has(String(error?.code || "")) ? error.code : "PRIVATE_FULL_CHAIN_FAILURE";
  return `[${code}] The private full-chain runner failed safely.`;
}

if (require.main === module) main().catch((error) => { console.error(safeCliFailure(error)); process.exitCode = 1; });

module.exports = {
  validatePrivateFullChainRequest,
  assertDistinctManifestProducts,
  exclusivePrivateWrite,
  preparePrivateResume,
  verifyPrivateBundle,
  initializePrivateManifest,
  validateProfileResultProvenance,
  runPrivateFullChain,
  comparePrivateFullChainResults
};
