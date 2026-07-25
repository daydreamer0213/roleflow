const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { compareBenchmarkResults } = require("./lib/benchmark_metrics");

const PRIVATE_PARENT = "D:\\DevData\\RoleFlow-private-benchmark";
const FIXED_CANDIDATE_WORKTREE = "D:\\DevData\\RoleFlow-worktrees\\claude-generic-evidence-matching-live-fix";
const MODES = new Set(["init-manifest", "prepare", "verify-private-bundle", "profile-live", "card-live", "match-live", "compare"]);
const LIVE_MODES = new Set(["profile-live", "card-live", "match-live"]);
const SHARED_MANIFEST_FILES = ["src/core/resume_parser.js", "src/core/pdf_text.js", "src/core/resume_privacy.js", "scripts/lib/benchmark_metrics.js"];
const PARSE_REPORT_KEYS = [
  "runMode", "authorizationGatePassed", "extractionMethod", "charCount", "detectedSections",
  "missingSections", "textTruncated", "redactions", "resumeContentSha256", "identityManifestSha256", "evaluatedCommit"
];

function fail(code, message) { return { ok: false, code, message }; }
function runnerError(code, message, statusCode = 400) {
  const error = Object.assign(new Error(message), { code, statusCode });
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
    canonicalizePath(path.join(canonicalRuntimeWorktree, ".runtime")),
    canonicalizePath(os.homedir()),
    canonicalizePath(os.tmpdir())
  ];
  return roots.some((root) => !root || isWithinDirectory(candidate, root)) || /\.sqlite$/i.test(candidate);
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
  const resolved = canonicalizePath(value);
  if (!resolved || path.extname(resolved).toLowerCase() !== ".pdf" || isWithinDirectory(resolved, privateRoot) || forbiddenArtifactLocation(resolved)) {
    return fail("PRIVATE_FULL_CHAIN_RESUME_REQUIRED", "The source PDF must be a canonical local PDF path outside the private bundle.");
  }
  return { ok: true, resolved };
}

function checkModelSettingsRoot(value) {
  if (!String(value || "").trim()) return fail("PRIVATE_FULL_CHAIN_MODEL_SETTINGS_ROOT_REQUIRED", "Live modes require an explicit model settings root.");
  const resolved = canonicalizePath(value);
  if (!resolved || forbiddenArtifactLocation(resolved) || (canonicalPrivateParent && isWithinDirectory(resolved, canonicalPrivateParent))) {
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
  const baseline = checkApprovedPrivateArtifact(options.baseline, "PRIVATE_FULL_CHAIN_RESUME_REQUIRED");
  const candidate = checkApprovedPrivateArtifact(options.candidate, "PRIVATE_FULL_CHAIN_RESUME_REQUIRED");
  const report = checkApprovedPrivateArtifact(options.report, "PRIVATE_FULL_CHAIN_OUTPUT_REQUIRED");
  const failed = [baseline, candidate, report].find((item) => !item.ok);
  if (failed) return failed;
  const baselineRun = path.dirname(baseline.resolved);
  const candidateRun = path.dirname(candidate.resolved);
  const bundle = path.dirname(path.dirname(baselineRun));
  if (path.basename(baseline.resolved).toLowerCase() !== "match-result.json" || path.basename(candidate.resolved).toLowerCase() !== "match-result.json"
    || path.basename(baselineRun).toLowerCase() !== "baseline" || path.basename(candidateRun).toLowerCase() !== "candidate"
    || path.basename(path.dirname(baselineRun)).toLowerCase() !== "runs" || !samePath(path.dirname(path.dirname(candidateRun)), bundle)
    || !isWithinDirectory(report.resolved, path.join(bundle, "reports"))
    || samePath(baseline.resolved, candidate.resolved) || samePath(baseline.resolved, report.resolved) || samePath(candidate.resolved, report.resolved)
    || fs.existsSync(report.resolved)) {
    return fail("PRIVATE_FULL_CHAIN_OUTPUT_REQUIRED", "Compare requires baseline/candidate match-result files from one bundle and a new report below that bundle's reports directory.");
  }
  return { ok: true, request: { mode: "compare", baseline: baseline.resolved, candidate: candidate.resolved, report: report.resolved, privateRoot: bundle } };
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
    const baseline = checkPrivateArtifact(opts.baselineWorktree, root.resolved, "PRIVATE_FULL_CHAIN_RESUME_REQUIRED");
    const candidate = isLocalAbsolutePath(opts.candidateWorktree) ? path.resolve(String(opts.candidateWorktree)) : null;
    const output = checkPrivateArtifact(opts.output, root.resolved, "PRIVATE_FULL_CHAIN_OUTPUT_REQUIRED");
    if (!baseline.ok) return baseline;
    if (!candidate || !samePath(candidate, path.resolve(FIXED_CANDIDATE_WORKTREE)) || samePath(baseline.resolved, candidate)) {
      return fail("PRIVATE_FULL_CHAIN_PRIVATE_ROOT_FORBIDDEN", "Manifest baseline must be a distinct private worktree and candidate must be the fixed candidate worktree.");
    }
    if (!output.ok) return output;
    return { ok: true, code: "OK", request: { mode, privateRoot: root.resolved, baselineWorktree: baseline.resolved, candidateWorktree: candidate, output: output.resolved } };
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
  if (mode === "profile-live") {
    const resumeText = checkPrivateArtifact(opts.resumeText, root.resolved, "PRIVATE_FULL_CHAIN_RESUME_REQUIRED");
    const identity = checkPrivateArtifact(opts.identity, root.resolved, "PRIVATE_FULL_CHAIN_IDENTITY_REQUIRED");
    const failed = [resumeText, identity].find((item) => !item.ok);
    if (failed) return failed;
  } else if (mode === "card-live") {
    const profile = checkPrivateArtifact(opts.profile, root.resolved, "PRIVATE_FULL_CHAIN_RESUME_REQUIRED");
    if (!profile.ok) return profile;
  } else {
    for (const field of ["profile", "matchingCard", "jobs", "labels"]) {
      const checked = checkPrivateArtifact(opts[field], root.resolved, "PRIVATE_FULL_CHAIN_RESUME_REQUIRED");
      if (!checked.ok) return checked;
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
  return { ok: true, code: "OK", request: { mode, privateRoot: root.resolved, side: side.side, output: side.output, modelSettingsRoot: settings.resolved, evaluatedCommit: proof.proof?.commit || "" } };
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
  delete opts.identityValue;
  delete opts.worktreeClean;
  delete opts.evaluatedCommit;
  delete opts.gitProof;
  const gate = validatePrivateFullChainRequest({ ...opts, mode: "prepare" }, env, null);
  if (!gate.ok) throw runnerError(gate.code, gate.message);
  const proof = inspectFixedCandidateWorktree();
  const request = { ...gate.request, evaluatedCommit: proof.commit };
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
    fs.mkdirSync(request.output, { recursive: true });
    fs.writeFileSync(path.join(request.output, "resume.redacted.txt"), storedText, "utf8");
    fs.writeFileSync(path.join(request.output, "parse-report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
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
  const manifest = { runMode: "private-init-manifest", baselineCommit: baseline.head, candidateCommit: candidate.head, sharedFileBlobs: baseline.blobs };
  fs.mkdirSync(path.dirname(gate.request.output), { recursive: true });
  fs.writeFileSync(gate.request.output, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return manifest;
}

function comparePrivateFullChainResults(baseline, candidate) { return compareBenchmarkResults(baseline, candidate); }

function parseCli(argv) {
  const options = {};
  const flags = new Set([...MODES].map((mode) => `--${mode}`));
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (flags.has(arg)) { if (options.mode) throw runnerError("PRIVATE_FULL_CHAIN_MODE_REQUIRED", "Choose exactly one mode."); options.mode = arg.slice(2); continue; }
    if (!arg.startsWith("--")) throw runnerError("PRIVATE_FULL_CHAIN_MODE_REQUIRED", "Unknown command argument.");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw runnerError("PRIVATE_FULL_CHAIN_MODE_REQUIRED", `Missing value for ${arg}.`);
    options[arg.slice(2).replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase())] = value;
    index += 1;
  }
  return options;
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const pureGate = validatePrivateFullChainRequest(options, process.env, null);
  if (!pureGate.ok) throw runnerError(pureGate.code, pureGate.message);
  if (options.mode === "prepare") return preparePrivateResume(options, process.env);
  if (options.mode === "init-manifest") return initializePrivateManifest(options);
  if (options.mode === "verify-private-bundle") return verifyPrivateBundle(options);
  if (options.mode === "compare") {
    const result = comparePrivateFullChainResults(JSON.parse(fs.readFileSync(pureGate.request.baseline, "utf8")), JSON.parse(fs.readFileSync(pureGate.request.candidate, "utf8")));
    if (!result.ok) throw runnerError(result.code, result.message);
    fs.mkdirSync(path.dirname(pureGate.request.report), { recursive: true });
    fs.writeFileSync(pureGate.request.report, JSON.stringify(result.report, null, 2) + "\n", "utf8");
    return;
  }
  inspectFixedCandidateWorktree();
  throw runnerError("PRIVATE_FULL_CHAIN_REAL_MODEL_REQUIRED", "Live execution wiring is intentionally deferred until Task 5.");
}

if (require.main === module) main().catch((error) => { console.error(`[${error.code || "PRIVATE_FULL_CHAIN_FAILURE"}] ${error.message}`); process.exitCode = 1; });

module.exports = { validatePrivateFullChainRequest, preparePrivateResume, verifyPrivateBundle, initializePrivateManifest, comparePrivateFullChainResults };
