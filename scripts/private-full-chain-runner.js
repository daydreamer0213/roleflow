const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { compareBenchmarkResults, deriveBenchmarkMetrics } = require("./lib/benchmark_metrics");
const { checkIdentityManifestShape, assertResumeIdentityRedacted } = require("./lib/private_resume_privacy");

const PRIVATE_PARENT = "D:\\DevData\\RoleFlow-private-benchmark";
const FIXED_CANDIDATE_WORKTREE = "D:\\DevData\\RoleFlow-worktrees\\claude-generic-evidence-matching-live-fix";
const MODES = new Set(["init-manifest", "prepare", "verify-private-bundle", "create-portability-proof", "profile-live", "card-live", "match-live", "compare"]);
const LIVE_MODES = new Set(["profile-live", "card-live", "match-live"]);
const PRIVATE_HARNESS_VERSION = "private-full-chain-harness.v2";
const PORTABLE_SOURCE_HARNESS_VERSION = "private-full-chain-harness.v1";
const PORTABILITY_PROOF_VERSION = "confirmed-evidence-portability.v1";
const PORTABILITY_LABEL_TRANSITION_PROOF_VERSION = "confirmed-evidence-portability.v2";
const PORTABILITY_FIXTURE_TRANSITION_PROOF_VERSION = "confirmed-evidence-portability.v3";
const PORTABILITY_CONSUMER_FILES = {
  profileCreationBlobId: "src/core/profile_onboarding.js",
  cardCreationBlobId: "src/core/matching_card.js",
  profileConsumptionBlobId: "src/core/search_plan.js",
  cardConsumptionBlobId: "src/core/llm_analyzer.js"
};
const PORTABILITY_V3_CONSUMER_FILES = {
  profileCreationBlobId: "src/core/profile_onboarding.js",
  cardCreationBlobId: "src/core/matching_card.js",
  profileConsumptionBlobId: "src/core/search_plan.js"
};
const SAFE_SEMANTIC_STATUSES = new Set(["complete", "partial", "pending", "failed", "stale", "blocked", "refresh", "rule_only"]);
const SAFE_DECISION_SOURCES = new Set(["local_rules", "model", "analysis_pending", "hard_boundary", "source_refresh"]);
const SAFE_DECISION_STATES = new Set(["ready", "blocked", "refresh"]);
const SAFE_FAILURE_STAGES = new Set(["understandJob", "matchJob"]);
const SAFE_ROLE_ALIGNMENTS = new Set([
  "aligned",
  "mostly_aligned",
  "partially_aligned",
  "misaligned",
  "insufficient_evidence"
]);
const SAFE_FOUNDATION_STATES = new Set(["none", "unproven", "partial", "complete"]);
const MAX_SAFE_TELEMETRY_INTEGER = 10000000;
const SAFE_CONTRACT_FAILURE_CATEGORIES = new Set([
  "selected_track",
  "role_alignment",
  "role_resume_evidence",
  "role_gaps",
  "requirement_matches",
  "eligibility",
  "unknown_keys",
  "result_shape",
  "other",
  "none"
]);
const SAFE_CONTRACT_FAILURE_REASONS = new Set([
  "selected_track",
  "context_shape",
  "role_alignment_enum",
  "responsibility_requires_insufficient",
  "aligned_requires_role_resume",
  "misaligned_requires_evidence_triplet",
  "insufficient_requires_gap",
  "matches_shape",
  "matches_unknown_id",
  "matches_duplicate_id",
  "matches_state",
  "matches_resume_evidence",
  "eligibility_shape",
  "eligibility_unknown_id",
  "eligibility_duplicate_id",
  "eligibility_state",
  "eligibility_resume_evidence",
  "other",
  "none"
]);
const SAFE_FAILURE_PHASES = new Set(["initial", "contract_repair"]);
const SAFE_RESPONSE_FAILURE_KINDS = new Set([
  "empty_response",
  "truncated_content",
  "invalid_response_json",
  "invalid_envelope",
  "missing_content",
  "invalid_content_json"
]);
const SAFE_RESPONSE_CONTENT_TYPE_KINDS = new Set(["json", "event_stream", "html", "plain_text", "other", "missing"]);
const SAFE_RESPONSE_ENVELOPE_KINDS = new Set(["empty", "json_object", "json_array", "event_stream", "html", "other"]);
const SAFE_RESPONSE_PARSE_FAILURE_KINDS = new Set(["unexpected_end", "unexpected_token", "other"]);
const PRIVATE_JOB_KEYS = [
  "id", "sourceId", "keyword", "title", "company", "location", "salary",
  "url", "description", "sourceContentHash", "capturedAt"
];
const PRIVATE_USER_CONFIRMED_JOB_KEYS = [
  "id", "sourceId", "keyword", "title", "company", "location", "salary",
  "experience", "education", "url", "description", "sourceContentHash", "capturedAt"
];
const PRIVATE_LABEL_V1_KEYS = ["id", "expectedRecommendation", "expectedBucket", "rationale"];
const PRIVATE_LABEL_V2_KEYS = [...PRIVATE_LABEL_V1_KEYS, "expectedDisposition"];
const PRIVATE_USER_CONFIRMED_LABEL_KEYS = [...PRIVATE_LABEL_V2_KEYS, "userLabel"];
const PRIVATE_USER_CONFIRMED_LABELING_POLICY_KEYS = [
  "roleDirectionSource", "requirementMatchingSource", "adjacencyBasis", "industryTreatment",
  "genericDutyWeight", "multiBranchJd", "falseNegativeCost"
];
const PRIVATE_RECOMMENDATIONS = new Set(["apply", "caution", "review", "skip"]);
const PRIVATE_BUCKETS = new Set(["primary", "talk", "backup", "not_recommended"]);
const PRIVATE_ACTUAL_BUCKETS = new Set([...PRIVATE_BUCKETS, "analysis_pending", "refresh"]);
const PRIVATE_LABEL_PAIRS = new Set(["apply/primary", "caution/talk", "review/talk", "review/backup", "skip/not_recommended"]);
const PRIVATE_DISPOSITIONS = new Set(["keep", "exclude"]);
const PRIVATE_USER_DISPOSITIONS = new Set(["keep", "discard"]);
const RECALL_FIRST_POLICY = "recall-first.v1";
const PRIVATE_USER_CONFIRMED_LABELS_VERSION = "private-user-confirmed.v2";
const PRIVATE_USER_CONFIRMED_POLICY = "resume-centered-recall-first.v2";
const RECALL_FIRST_POLICIES = new Set([RECALL_FIRST_POLICY, PRIVATE_USER_CONFIRMED_POLICY]);

function isRecallFirstPolicy(value) {
  return RECALL_FIRST_POLICIES.has(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isV3TargetLabelIdentity(labelsVersion, evaluationPolicy) {
  return (labelsVersion === "private-real-jd-labels.v2" && evaluationPolicy === RECALL_FIRST_POLICY)
    || (labelsVersion === PRIVATE_USER_CONFIRMED_LABELS_VERSION
      && evaluationPolicy === PRIVATE_USER_CONFIRMED_POLICY);
}
const SAFE_ERROR_CODES = new Set([
  "CANDIDATE_PROFILE_REQUIRED",
  "MODEL_ANALYSIS_FAILED",
  "MODEL_CONTRACT_INVALID",
  "MODEL_EMPTY_RESPONSE",
  "MODEL_INVALID_JSON",
  "MODEL_INVALID_RESPONSE",
  "MODEL_OUTPUT_TRUNCATED",
  "MODEL_REQUEST_FAILED",
  "MODEL_TIMEOUT"
]);
const SHARED_MANIFEST_FILES = [
  "scripts/private-full-chain-runner.js",
  "scripts/lib/benchmark_metrics.js",
  "scripts/lib/private_resume_privacy.js"
];
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

function parseDiagnosticIndices(value) {
  const raw = String(value || "").trim();
  if (!raw) return { ok: true, indices: null };
  const parts = raw.split(",");
  if (parts.length > 5 || parts.some((part) => !/^(0|[1-9][0-9]*)$/.test(part))) {
    return fail("PRIVATE_FULL_CHAIN_DIAGNOSTIC_INVALID", "Diagnostic selection requires one to five unique zero-based indices.");
  }
  const indices = parts.map(Number);
  if (new Set(indices).size !== indices.length) {
    return fail("PRIVATE_FULL_CHAIN_DIAGNOSTIC_INVALID", "Diagnostic selection requires one to five unique zero-based indices.");
  }
  return { ok: true, indices };
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
  const proofVersion = String(opts.proofVersion || "").trim();
  if (proofVersion && mode !== "create-portability-proof") {
    return fail("PRIVATE_FULL_CHAIN_MODE_REQUIRED", "Proof version is only available when creating a portability proof.");
  }
  const diagnostic = parseDiagnosticIndices(opts.diagnosticIndices);
  if (!diagnostic.ok) return diagnostic;
  if (diagnostic.indices && mode !== "match-live") {
    return fail("PRIVATE_FULL_CHAIN_DIAGNOSTIC_INVALID", "Diagnostic selection is only available for match-live.");
  }
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
    if (!/^[0-9a-f]{7,40}$/i.test(String(opts.baselineProductCommit || ""))
      || !/^[0-9a-f]{7,40}$/i.test(String(opts.candidateProductCommit || ""))) {
      return fail("PRIVATE_FULL_CHAIN_WORKTREE_DIRTY", "Manifest initialization requires baseline and candidate product commits to verify from Git evidence.");
    }
    return { ok: true, code: "OK", request: {
      mode, privateRoot: root.resolved, baselineWorktree: baseline.resolved, candidateWorktree: candidate,
      baselineProductCommit: String(opts.baselineProductCommit).toLowerCase(),
      candidateProductCommit: String(opts.candidateProductCommit).toLowerCase(), output: output.resolved
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
  if (mode === "create-portability-proof") {
    if (proofVersion && proofVersion !== PORTABILITY_FIXTURE_TRANSITION_PROOF_VERSION) {
      return fail("PRIVATE_FULL_CHAIN_MODE_REQUIRED", "Use the exact supported portability proof version.");
    }
    const source = checkPrivateRoot(opts.sourcePrivateRoot);
    const output = checkPrivateArtifact(opts.output, root.resolved, "PRIVATE_FULL_CHAIN_OUTPUT_REQUIRED");
    if (!source.ok) return source;
    if (!output.ok) return output;
    const expected = canonicalizePath(path.join(root.resolved, "input", "confirmed-evidence-portability.json"));
    if (samePath(source.resolved, root.resolved) || !expected || !samePath(output.resolved, expected)) {
      return fail("PRIVATE_FULL_CHAIN_OUTPUT_REQUIRED", "Portability requires distinct source and target bundles and the fixed new sidecar target.");
    }
    return { ok: true, code: "OK", request: {
      mode,
      sourcePrivateRoot: source.resolved,
      privateRoot: root.resolved,
      output: output.resolved,
      proofVersion
    } };
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
    if (String(opts.portabilityProof || "").trim()) {
      const portabilityProof = checkPrivateArtifact(opts.portabilityProof, root.resolved, "PRIVATE_FULL_CHAIN_PORTABILITY_INVALID");
      if (!portabilityProof.ok) return portabilityProof;
      liveInputs.portabilityProof = portabilityProof.resolved;
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
      diagnosticIndices: diagnostic.indices,
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
  try { assertResumeIdentityRedacted(serialized, identity); } catch { return false; }
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
  try { assertResumeIdentityRedacted(resumeText, identity); } catch { throw runnerError("PRIVATE_FULL_CHAIN_INPUT_IDENTITY", "The private bundle contains unredacted identity data."); }
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
  const candidateProductCommit = verifyProductCommit(suppliedCandidate, gate.request.candidateProductCommit, candidate.head);
  assertDistinctManifestProducts(baselineProductCommit, candidateProductCommit);
  const manifest = {
    runMode: "private-init-manifest",
    harnessVersion: PRIVATE_HARNESS_VERSION,
    baselineProductCommit,
    baselineEvaluatedCommit: baseline.head,
    candidateProductCommit,
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
    const evaluated = runGit(["rev-parse", "--verify", `${evaluatedCommit}^{commit}`]).toLowerCase();
    if (product === evaluated) throw new Error("product commit equals evaluated commit");
    execFileSync("git", ["merge-base", "--is-ancestor", product, evaluated], { cwd, windowsHide: true });
    if (!/^[0-9a-f]{40}$/.test(product) || !/^[0-9a-f]{40}$/.test(evaluated)) throw new Error("invalid product commit");
    return product;
  } catch {
    throw runnerError("PRIVATE_FULL_CHAIN_WORKTREE_DIRTY", "The product commit must be a Git-verifiable strict ancestor of the evaluated tooling commit.");
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
  const { decisionHardBlockers, effectiveHardBlockers, roleEvidenceDecisionState } = require("../src/core/model_contract");
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
    effectiveHardBlockers,
    roleEvidenceDecisionState,
    openDb,
    decisionBucket,
    mapWithConcurrency
  };
}

function productDecisionHardBlockers(modules, analysis) {
  const select = typeof modules.decisionHardBlockers === "function"
    ? modules.decisionHardBlockers
    : modules.effectiveHardBlockers;
  if (typeof select !== "function") {
    throw runnerError("PRIVATE_FULL_CHAIN_FAILURE", "The evaluated product does not expose blocker semantics.");
  }
  return select(analysis);
}

function frozenBenchmarkScoreInput(job) {
  return {
    ...job,
    source: "boss",
    bossActiveText: "今日活跃",
    detailRequired: true,
    detailRead: true
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
    || draft.benchmarkHarnessVersion !== (context.harnessVersion || PRIVATE_HARNESS_VERSION)
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

function portabilityArtifactPaths(privateRoot) {
  const input = path.join(privateRoot, "input");
  return {
    manifest: path.join(privateRoot, "run-manifest.json"),
    profile: path.join(input, "confirmed-profile.private.json"),
    card: path.join(input, "confirmed-card.private.json"),
    resume: path.join(input, "resume.redacted.txt"),
    identity: path.join(input, "identity.private.json"),
    jobs: path.join(input, "jobs.private.json"),
    labels: path.join(privateRoot, "labels", "jobs.reviewed.json")
  };
}

function readPortabilityArtifacts(privateRoot) {
  const paths = portabilityArtifactPaths(privateRoot);
  try {
    const bytes = Object.fromEntries(Object.entries(paths).map(([name, file]) => [name, fs.readFileSync(file)]));
    return {
      bytes,
      manifest: JSON.parse(bytes.manifest.toString("utf8")),
      profile: JSON.parse(bytes.profile.toString("utf8")),
      card: JSON.parse(bytes.card.toString("utf8"))
    };
  } catch {
    throw runnerError("PRIVATE_FULL_CHAIN_PORTABILITY_INVALID", "Confirmed evidence portability inputs are missing or invalid.");
  }
}

function portabilityManifest(value, harnessVersion) {
  const manifestKeys = [
    "runMode", "harnessVersion", "baselineProductCommit", "baselineEvaluatedCommit",
    "candidateProductCommit", "candidateEvaluatedCommit", "sharedFileBlobs"
  ];
  return sameKeys(value, manifestKeys)
    && value.runMode === "private-init-manifest"
    && value?.harnessVersion === harnessVersion
    && /^[0-9a-f]{40}$/.test(String(value?.baselineProductCommit || ""))
    && /^[0-9a-f]{40}$/.test(String(value?.baselineEvaluatedCommit || ""))
    && /^[0-9a-f]{40}$/.test(String(value?.candidateProductCommit || ""))
    && /^[0-9a-f]{40}$/.test(String(value?.candidateEvaluatedCommit || ""))
    && sameKeys(value.sharedFileBlobs, SHARED_MANIFEST_FILES)
    && Object.values(value.sharedFileBlobs).every((blob) => /^[0-9a-f]{40,64}$/.test(String(blob || "")));
}

function resolvePortabilityTargetCommits(manifest, seam) {
  if (seam?.targetCommits) {
    const productCommit = String(seam.targetCommits.productCommit || "").toLowerCase();
    const evaluatedCommit = String(seam.targetCommits.evaluatedCommit || "").toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(productCommit) || !/^[0-9a-f]{40}$/.test(evaluatedCommit)) {
      throw runnerError("PRIVATE_FULL_CHAIN_PORTABILITY_INVALID", "The target commit binding is invalid.");
    }
    return { productCommit, evaluatedCommit };
  }
  try {
    const inspected = inspectWorktree(FIXED_CANDIDATE_WORKTREE);
    return {
      productCommit: verifyProductCommit(FIXED_CANDIDATE_WORKTREE, manifest.candidateProductCommit, inspected.head),
      evaluatedCommit: inspected.head
    };
  } catch {
    throw runnerError("PRIVATE_FULL_CHAIN_PORTABILITY_INVALID", "The target commit binding is invalid.");
  }
}

function resolvePortabilitySourceProduct(manifest, seam) {
  const declared = String(manifest?.candidateProductCommit || "").toLowerCase();
  const evaluated = String(manifest?.candidateEvaluatedCommit || "").toLowerCase();
  try {
    const resolved = typeof seam?.sourceProductResolver === "function"
      ? String(seam.sourceProductResolver(declared, evaluated) || "").toLowerCase()
      : verifyProductCommit(FIXED_CANDIDATE_WORKTREE, declared, evaluated);
    if (!/^[0-9a-f]{40}$/.test(declared) || resolved !== declared) throw new Error("source product mismatch");
    return resolved;
  } catch {
    throw runnerError("PRIVATE_FULL_CHAIN_PORTABILITY_INVALID", "The source product commit is not the declared strict ancestor.");
  }
}

function portabilityBlobResolver(seam) {
  if (typeof seam?.blobResolver === "function") return seam.blobResolver;
  return (commit, file) => execFileSync("git", ["rev-parse", `${commit}:${file}`], {
    cwd: FIXED_CANDIDATE_WORKTREE,
    encoding: "utf8",
    windowsHide: true
  }).trim().toLowerCase();
}

function runtimePortabilityBlobResolver(seam) {
  if (typeof seam?.runtimeBlobResolver === "function") return seam.runtimeBlobResolver;
  return (commit, file) => execFileSync("git", ["rev-parse", `${commit}:${file}`], {
    cwd: canonicalRuntimeWorktree,
    encoding: "utf8",
    windowsHide: true
  }).trim().toLowerCase();
}

function resolvePortabilityBlobs(sourceCommit, targetCommit, seam, files = PORTABILITY_CONSUMER_FILES) {
  const resolveBlob = portabilityBlobResolver(seam);
  try {
    return Object.fromEntries(Object.entries(files).map(([name, file]) => {
      const source = String(resolveBlob(sourceCommit, file) || "").toLowerCase();
      const target = String(resolveBlob(targetCommit, file) || "").toLowerCase();
      if (!/^[0-9a-f]{40,64}$/.test(source) || source !== target) throw new Error("blob mismatch");
      return [name, source];
    }));
  } catch {
    throw runnerError("PRIVATE_FULL_CHAIN_PORTABILITY_INVALID", "The approved consumer-code blob binding is invalid.");
  }
}

function portabilityProofPayload(value) {
  const payload = { ...value };
  delete payload.proofSha256;
  return payload;
}

function genericPortabilityConfirmationId(value) {
  return /^[a-z0-9][a-z0-9._-]{0,99}$/i.test(String(value || ""));
}

function createConfirmedEvidencePortability(options, seam = null) {
  const gate = validatePrivateFullChainRequest({ ...(options || {}), mode: "create-portability-proof" }, {}, null);
  if (!gate.ok) throw runnerError(gate.code, gate.message);
  newPrivateOutputTarget(gate.request.privateRoot, gate.request.output);
  const source = readPortabilityArtifacts(gate.request.sourcePrivateRoot);
  const target = readPortabilityArtifacts(gate.request.privateRoot);
  if (!portabilityManifest(source.manifest, PORTABLE_SOURCE_HARNESS_VERSION)
    || !portabilityManifest(target.manifest, PRIVATE_HARNESS_VERSION)) {
    throw runnerError("PRIVATE_FULL_CHAIN_PORTABILITY_INVALID", "Portability requires a known v1 source manifest and current v2 target manifest.");
  }
  const targetCommits = resolvePortabilityTargetCommits(target.manifest, seam);
  const sourceProductCommit = resolvePortabilitySourceProduct(source.manifest, seam);
  if (targetCommits.productCommit !== target.manifest.candidateProductCommit
    || targetCommits.evaluatedCommit !== target.manifest.candidateEvaluatedCommit) {
    throw runnerError("PRIVATE_FULL_CHAIN_PORTABILITY_INVALID", "The target manifest and candidate commits do not match.");
  }
  const fixtureTransition = gate.request.proofVersion === PORTABILITY_FIXTURE_TRANSITION_PROOF_VERSION;
  for (const field of ["profile", "card", "resume", "identity"]) {
    if (!source.bytes[field].equals(target.bytes[field])) {
      throw runnerError("PRIVATE_FULL_CHAIN_PORTABILITY_INVALID", "Source and target confirmed evidence bytes do not match.");
    }
  }
  if (!fixtureTransition && !source.bytes.jobs.equals(target.bytes.jobs)) {
    throw runnerError("PRIVATE_FULL_CHAIN_PORTABILITY_INVALID", "Source and target confirmed evidence bytes do not match.");
  }
  let sourceFixture;
  let targetFixture;
  try {
    sourceFixture = privateJobsAndLabels(
      JSON.parse(source.bytes.jobs.toString("utf8")),
      JSON.parse(source.bytes.labels.toString("utf8")),
      source.bytes.jobs
    );
    targetFixture = privateJobsAndLabels(
      JSON.parse(target.bytes.jobs.toString("utf8")),
      JSON.parse(target.bytes.labels.toString("utf8")),
      target.bytes.jobs
    );
  } catch {
    throw runnerError("PRIVATE_FULL_CHAIN_PORTABILITY_INVALID", "Source and target labels must both be confirmed valid fixtures.");
  }
  const labelsIdentical = source.bytes.labels.equals(target.bytes.labels);
  const labelPolicyTransition = !labelsIdentical
    && sourceFixture.labelsVersion === "private-real-jd-labels.v1"
    && targetFixture.labelsVersion === "private-real-jd-labels.v2"
    && targetFixture.evaluationPolicy === RECALL_FIRST_POLICY;
  if (fixtureTransition && !isV3TargetLabelIdentity(
    targetFixture.labelsVersion,
    targetFixture.evaluationPolicy
  )) {
    throw runnerError("PRIVATE_FULL_CHAIN_PORTABILITY_INVALID", "Fixture portability requires confirmed recall-first v2 target labels.");
  }
  if (!fixtureTransition && !labelsIdentical && !labelPolicyTransition) {
    throw runnerError("PRIVATE_FULL_CHAIN_PORTABILITY_INVALID", "Only a confirmed v1 to recall-first v2 label-policy transition may change label bytes.");
  }
  const sourceContext = {
    injected: false,
    harnessVersion: PORTABLE_SOURCE_HARNESS_VERSION,
    manifest: source.manifest,
    runManifestSha256: valueSha256(source.manifest),
    side: "candidate",
    evaluatedCommit: source.manifest.candidateEvaluatedCommit
  };
  const profileInput = confirmedProfileInput(source.profile, sourceContext);
  const cardInput = confirmedCardInput(source.card, profileInput, sourceContext);
  if (profileInput.envelope.resumeContentSha256 !== sha256(source.bytes.resume)
    || profileInput.envelope.identityManifestSha256 !== sha256(source.bytes.identity)
    || profileInput.envelope.productCommit !== sourceProductCommit
    || cardInput.envelope.draft?.productCommit !== sourceProductCommit
    || !genericPortabilityConfirmationId(profileInput.envelope.id)
    || !genericPortabilityConfirmationId(cardInput.envelope.id)) {
    throw runnerError("PRIVATE_FULL_CHAIN_PORTABILITY_INVALID", "The source confirmation chain does not match its evidence hashes.");
  }
  const proof = {
    proofVersion: fixtureTransition
      ? PORTABILITY_FIXTURE_TRANSITION_PROOF_VERSION
      : labelPolicyTransition ? PORTABILITY_LABEL_TRANSITION_PROOF_VERSION : PORTABILITY_PROOF_VERSION,
    runMode: "offline-confirmed-evidence-portability",
    modelCallPerformed: false,
    sourceHarness: PORTABLE_SOURCE_HARNESS_VERSION,
    targetHarness: PRIVATE_HARNESS_VERSION,
    sourceRunManifestSha256: valueSha256(source.manifest),
    targetRunManifestSha256: valueSha256(target.manifest),
    sourceProductCommit,
    sourceEvaluatedCommit: source.manifest.candidateEvaluatedCommit,
    targetProductCommit: targetCommits.productCommit,
    targetEvaluatedCommit: targetCommits.evaluatedCommit,
    confirmedProfileFileSha256: sha256(source.bytes.profile),
    confirmedCardFileSha256: sha256(source.bytes.card),
    resumeContentSha256: sha256(source.bytes.resume),
    identityManifestSha256: sha256(source.bytes.identity),
    ...(fixtureTransition ? {
      targetJobsFileSha256: sha256(target.bytes.jobs),
      targetLabelsFileSha256: sha256(target.bytes.labels),
      targetFixtureTotal: targetFixture.jobs.length,
      targetLabelsVersion: targetFixture.labelsVersion,
      targetEvaluationPolicy: targetFixture.evaluationPolicy,
      targetLabelsConfirmedAt: JSON.parse(target.bytes.labels.toString("utf8")).confirmedAt
    } : {
      jobsFileSha256: sha256(source.bytes.jobs),
      ...(labelPolicyTransition ? {
      sourceLabelsFileSha256: sha256(source.bytes.labels),
      targetLabelsFileSha256: sha256(target.bytes.labels),
      sourceLabelsVersion: sourceFixture.labelsVersion,
      targetLabelsVersion: targetFixture.labelsVersion,
      targetEvaluationPolicy: targetFixture.evaluationPolicy
      } : {
      labelsFileSha256: sha256(source.bytes.labels)
      })
    }),
    modelIdentitySha256: profileInput.envelope.modelIdentitySha256,
    ...(fixtureTransition ? {
      profileConfirmationIdSha256: sha256(String(profileInput.envelope.id)),
      cardConfirmationIdSha256: sha256(String(cardInput.envelope.id))
    } : {
      profileConfirmationId: String(profileInput.envelope.id),
      cardConfirmationId: String(cardInput.envelope.id)
    }),
    profileConfirmedAt: profileInput.envelope.confirmedAt,
    cardConfirmedAt: cardInput.envelope.confirmedAt,
    consumerCodeBlobs: resolvePortabilityBlobs(
      source.manifest.candidateEvaluatedCommit,
      targetCommits.productCommit,
      seam,
      fixtureTransition ? PORTABILITY_V3_CONSUMER_FILES : PORTABILITY_CONSUMER_FILES
    )
  };
  proof.proofSha256 = valueSha256(proof);
  writeJsonFile(gate.request.privateRoot, gate.request.output, proof);
  return proof;
}

function validateConfirmedEvidencePortability(request, context, assertPrivacy, seam = null) {
  let proof;
  try {
    proof = JSON.parse(fs.readFileSync(request.portabilityProof).toString("utf8"));
  } catch {
    throw runnerError("PRIVATE_FULL_CHAIN_PORTABILITY_INVALID", "An explicit valid portability proof is required for v1 confirmed evidence.");
  }
  const commonKeys = [
    "proofVersion", "runMode", "modelCallPerformed", "sourceHarness", "targetHarness",
    "sourceRunManifestSha256", "targetRunManifestSha256", "sourceProductCommit", "sourceEvaluatedCommit",
    "targetProductCommit", "targetEvaluatedCommit", "confirmedProfileFileSha256",
    "confirmedCardFileSha256", "resumeContentSha256", "identityManifestSha256",
    "modelIdentitySha256", "profileConfirmedAt", "cardConfirmedAt", "consumerCodeBlobs", "proofSha256"
  ];
  const labelTransition = proof?.proofVersion === PORTABILITY_LABEL_TRANSITION_PROOF_VERSION;
  const fixtureTransition = proof?.proofVersion === PORTABILITY_FIXTURE_TRANSITION_PROOF_VERSION;
  const expectedKeys = [
    ...commonKeys,
    ...(fixtureTransition
      ? [
        "targetJobsFileSha256", "targetLabelsFileSha256", "targetFixtureTotal",
        "targetLabelsVersion", "targetEvaluationPolicy", "targetLabelsConfirmedAt",
        "profileConfirmationIdSha256", "cardConfirmationIdSha256"
      ]
      : ["profileConfirmationId", "cardConfirmationId", "jobsFileSha256", ...(labelTransition
      ? [
        "sourceLabelsFileSha256", "targetLabelsFileSha256",
        "sourceLabelsVersion", "targetLabelsVersion", "targetEvaluationPolicy"
      ]
      : ["labelsFileSha256"])])
  ];
  if (!sameKeys(proof, expectedKeys)
    || ![PORTABILITY_PROOF_VERSION, PORTABILITY_LABEL_TRANSITION_PROOF_VERSION, PORTABILITY_FIXTURE_TRANSITION_PROOF_VERSION].includes(proof.proofVersion)
    || proof.runMode !== "offline-confirmed-evidence-portability"
    || proof.modelCallPerformed !== false
    || proof.sourceHarness !== PORTABLE_SOURCE_HARNESS_VERSION
    || proof.targetHarness !== PRIVATE_HARNESS_VERSION
    || proof.proofSha256 !== valueSha256(portabilityProofPayload(proof))
    || !portabilityManifest(context.manifest, PRIVATE_HARNESS_VERSION)
    || proof.targetRunManifestSha256 !== context.runManifestSha256
    || !/^[0-9a-f]{40}$/.test(String(proof.sourceProductCommit || ""))
    || proof.targetProductCommit !== context.manifest.candidateProductCommit
    || proof.targetEvaluatedCommit !== context.manifest.candidateEvaluatedCommit
    || (!fixtureTransition && (!genericPortabilityConfirmationId(proof.profileConfirmationId)
      || !genericPortabilityConfirmationId(proof.cardConfirmationId)))
    || (labelTransition && (
      !/^[0-9a-f]{64}$/.test(String(proof.sourceLabelsFileSha256 || ""))
      || !/^[0-9a-f]{64}$/.test(String(proof.targetLabelsFileSha256 || ""))
      || proof.sourceLabelsFileSha256 === proof.targetLabelsFileSha256
      || proof.sourceLabelsVersion !== "private-real-jd-labels.v1"
      || proof.targetLabelsVersion !== "private-real-jd-labels.v2"
      || proof.targetEvaluationPolicy !== RECALL_FIRST_POLICY
    ))
    || (fixtureTransition && (
      !/^[0-9a-f]{64}$/.test(String(proof.targetJobsFileSha256 || ""))
      || !/^[0-9a-f]{64}$/.test(String(proof.targetLabelsFileSha256 || ""))
      || !Number.isSafeInteger(proof.targetFixtureTotal) || proof.targetFixtureTotal < 1
      || !isV3TargetLabelIdentity(proof.targetLabelsVersion, proof.targetEvaluationPolicy)
      || !Number.isFinite(Date.parse(proof.targetLabelsConfirmedAt))
      || !/^[0-9a-f]{64}$/.test(String(proof.profileConfirmationIdSha256 || ""))
      || !/^[0-9a-f]{64}$/.test(String(proof.cardConfirmationIdSha256 || ""))
    ))) {
    throw runnerError("PRIVATE_FULL_CHAIN_PORTABILITY_INVALID", "The confirmed evidence portability proof is invalid.");
  }
  const targetCommits = resolvePortabilityTargetCommits(context.manifest, seam);
  const sourceProductCommit = resolvePortabilitySourceProduct({
    candidateProductCommit: proof.sourceProductCommit,
    candidateEvaluatedCommit: proof.sourceEvaluatedCommit
  }, seam);
  if (targetCommits.productCommit !== proof.targetProductCommit
    || targetCommits.evaluatedCommit !== proof.targetEvaluatedCommit) {
    throw runnerError("PRIVATE_FULL_CHAIN_PORTABILITY_INVALID", "The target commit binding is invalid.");
  }
  let target;
  try {
    const profileRaw = fs.readFileSync(request.profile);
    const cardRaw = fs.readFileSync(request.matchingCard);
    const resumeRaw = fs.readFileSync(path.join(request.privateRoot, "input", "resume.redacted.txt"));
    const identityRaw = fs.readFileSync(path.join(request.privateRoot, "input", "identity.private.json"));
    const jobsRaw = fs.readFileSync(request.jobs);
    const labelsRaw = fs.readFileSync(request.labels);
    target = {
      profileRaw, cardRaw, resumeRaw, identityRaw, jobsRaw, labelsRaw,
      profileValue: JSON.parse(profileRaw.toString("utf8")),
      cardValue: JSON.parse(cardRaw.toString("utf8")),
      jobsValue: JSON.parse(jobsRaw.toString("utf8")),
      labelsValue: JSON.parse(labelsRaw.toString("utf8")),
      identity: JSON.parse(identityRaw.toString("utf8"))
    };
  } catch {
    throw runnerError("PRIVATE_FULL_CHAIN_PORTABILITY_INVALID", "The target evidence files are missing or invalid.");
  }
  for (const [value, field] of [
    [target.profileRaw, "confirmedProfileFileSha256"],
    [target.cardRaw, "confirmedCardFileSha256"],
    [target.resumeRaw, "resumeContentSha256"],
    [target.identityRaw, "identityManifestSha256"],
    ...(!fixtureTransition ? [[target.jobsRaw, "jobsFileSha256"]] : [])
  ]) {
    if (sha256(value) !== proof[field]) {
      throw runnerError("PRIVATE_FULL_CHAIN_PORTABILITY_INVALID", "The target evidence bytes do not match the portability proof.");
    }
  }
  if (sha256(target.labelsRaw) !== (labelTransition || fixtureTransition ? proof.targetLabelsFileSha256 : proof.labelsFileSha256)
    || (fixtureTransition && sha256(target.jobsRaw) !== proof.targetJobsFileSha256)) {
    throw runnerError("PRIVATE_FULL_CHAIN_PORTABILITY_INVALID", "The target label file does not match the portability proof.");
  }
  let targetFixture;
  try {
    targetFixture = privateJobsAndLabels(target.jobsValue, target.labelsValue, target.jobsRaw);
  } catch {
    throw runnerError("PRIVATE_FULL_CHAIN_PORTABILITY_INVALID", "The target recall-first labels are invalid.");
  }
  if (labelTransition || fixtureTransition) {
    if (targetFixture.labelsVersion !== proof.targetLabelsVersion
      || targetFixture.evaluationPolicy !== proof.targetEvaluationPolicy) {
      throw runnerError("PRIVATE_FULL_CHAIN_PORTABILITY_INVALID", "The target recall-first label policy does not match the portability proof.");
    }
  }
  if (fixtureTransition && (targetFixture.jobs.length !== proof.targetFixtureTotal
    || target.labelsValue.confirmedAt !== proof.targetLabelsConfirmedAt)) {
    throw runnerError("PRIVATE_FULL_CHAIN_PORTABILITY_INVALID", "The target fixture identity does not match the portability proof.");
  }
  const resumeText = target.resumeRaw.toString("utf8");
  if (!checkIdentityManifestShape(target.identity)) {
    throw runnerError("PRIVATE_FULL_CHAIN_PORTABILITY_INVALID", "The target resume identity manifest is invalid.");
  }
  try {
    assertPrivacy(resumeText, target.identity);
  } catch {
    throw runnerError("PRIVATE_FULL_CHAIN_PORTABILITY_INVALID", "The target resume evidence is not redacted.");
  }
  const sourceContext = {
    injected: false,
    harnessVersion: PORTABLE_SOURCE_HARNESS_VERSION,
    manifest: {
      candidateProductCommit: sourceProductCommit,
      candidateEvaluatedCommit: proof.sourceEvaluatedCommit
    },
    runManifestSha256: proof.sourceRunManifestSha256,
    side: context.side,
    evaluatedCommit: context.evaluatedCommit
  };
  let profileInput;
  let cardInput;
  try {
    profileInput = confirmedProfileInput(target.profileValue, sourceContext);
    cardInput = confirmedCardInput(target.cardValue, profileInput, sourceContext);
  } catch {
    throw runnerError("PRIVATE_FULL_CHAIN_PORTABILITY_INVALID", "The v1 confirmation provenance chain is invalid.");
  }
  if ((fixtureTransition
    ? sha256(String(profileInput.envelope.id)) !== proof.profileConfirmationIdSha256
      || sha256(String(cardInput.envelope.id)) !== proof.cardConfirmationIdSha256
    : profileInput.envelope.id !== proof.profileConfirmationId
      || cardInput.envelope.id !== proof.cardConfirmationId)
    || profileInput.envelope.confirmedAt !== proof.profileConfirmedAt
    || cardInput.envelope.confirmedAt !== proof.cardConfirmedAt
    || profileInput.envelope.modelIdentitySha256 !== proof.modelIdentitySha256
    || profileInput.envelope.productCommit !== sourceProductCommit
    || cardInput.envelope.draft?.productCommit !== sourceProductCommit
    || JSON.stringify(resolvePortabilityBlobs(
      proof.sourceEvaluatedCommit,
      proof.targetProductCommit,
      seam,
      fixtureTransition ? PORTABILITY_V3_CONSUMER_FILES : PORTABILITY_CONSUMER_FILES
    ))
      !== JSON.stringify(proof.consumerCodeBlobs)) {
    throw runnerError("PRIVATE_FULL_CHAIN_PORTABILITY_INVALID", "The portability proof bindings are invalid.");
  }
  if (fixtureTransition) {
    let runtimeConsumerCodeBlobs;
    try {
      const resolveBlob = runtimePortabilityBlobResolver(seam);
      runtimeConsumerCodeBlobs = Object.fromEntries(Object.entries(PORTABILITY_V3_CONSUMER_FILES).map(([name, file]) => {
        const blob = String(resolveBlob(context.evaluatedCommit, file) || "").toLowerCase();
        if (!/^[0-9a-f]{40,64}$/.test(blob)) throw new Error("runtime blob invalid");
        return [name, blob];
      }));
    } catch {
      throw runnerError("PRIVATE_FULL_CHAIN_PORTABILITY_INVALID", "The portability proof bindings are invalid.");
    }
    if (JSON.stringify(runtimeConsumerCodeBlobs) !== JSON.stringify(proof.consumerCodeBlobs)) {
      throw runnerError("PRIVATE_FULL_CHAIN_PORTABILITY_INVALID", "The portability proof bindings are invalid.");
    }
  }
  return {
    proof,
    profileInput,
    cardInput,
    fixture: targetFixture,
    resume: { resumeText, identityRaw: target.identityRaw, identity: target.identity }
  };
}

function frozenJobSourceContentHash(job, userConfirmed = false) {
  if (userConfirmed) return sha256(job.description || "");
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

function privateJobsAndLabels(jobsValue, labelsValue, jobsRaw = null) {
  const jobs = Array.isArray(jobsValue) ? jobsValue : jobsValue?.rows;
  const rawLabels = labelsValue?.rows;
  const isV1 = labelsValue?.labelsVersion === "private-real-jd-labels.v1";
  const isV2 = labelsValue?.labelsVersion === "private-real-jd-labels.v2";
  const isUserV2 = labelsValue?.labelsVersion === PRIVATE_USER_CONFIRMED_LABELS_VERSION;
  const isRecallV2 = isV2 || isUserV2;
  const labelEnvelopeKeys = isUserV2
    ? ["labelsVersion", "evaluationPolicy", "labelingPolicy", "userConfirmed", "confirmedAt", "jobsSha256", "rows"]
    : isV2
      ? ["labelsVersion", "evaluationPolicy", "userConfirmed", "confirmedAt", "jobsSha256", "rows"]
      : ["labelsVersion", "userConfirmed", "confirmedAt", "jobsSha256", "rows"];
  const labelingPolicy = labelsValue?.labelingPolicy;
  if (!Array.isArray(jobs) || !jobs.length || !Array.isArray(rawLabels)
    || !sameKeys(labelsValue, labelEnvelopeKeys)
    || (!isV1 && !isRecallV2)
    || (isV2 && labelsValue.evaluationPolicy !== RECALL_FIRST_POLICY)
    || (isUserV2 && (labelsValue.evaluationPolicy !== PRIVATE_USER_CONFIRMED_POLICY
      || !labelingPolicy || typeof labelingPolicy !== "object" || Array.isArray(labelingPolicy)
      || !sameKeys(labelingPolicy, PRIVATE_USER_CONFIRMED_LABELING_POLICY_KEYS)
      || Object.values(labelingPolicy).some((value) => !isNonEmptyString(value))))
    || labelsValue.userConfirmed !== true
    || !String(labelsValue.confirmedAt || "").trim()
    || !Number.isFinite(Date.parse(labelsValue.confirmedAt))) {
    throw runnerError("PRIVATE_FULL_CHAIN_FIXTURE_INVALID", "Match live requires non-empty jobs and user-confirmed labels.");
  }
  for (const job of jobs) {
    const jobKeys = isUserV2 ? PRIVATE_USER_CONFIRMED_JOB_KEYS : PRIVATE_JOB_KEYS;
    const optionalJobFields = isUserV2 ? new Set(["experience", "education"]) : new Set();
    const invalidJobFields = isUserV2
      ? jobKeys.some((field) => typeof job[field] !== "string")
        || jobKeys.filter((field) => field !== "sourceContentHash" && !optionalJobFields.has(field))
          .some((field) => !isNonEmptyString(job[field]))
      : jobKeys.filter((field) => field !== "sourceContentHash")
        .some((field) => !String(job[field] ?? "").trim());
    if (!sameKeys(job, jobKeys)
      || invalidJobFields
      || String(job.description).trim().length < 120
      || !/^[0-9a-f]{64}$/.test(String(job.sourceContentHash || ""))
      || job.sourceContentHash !== frozenJobSourceContentHash(job, isUserV2)
      || !Number.isFinite(Date.parse(job.capturedAt))) {
      throw runnerError("PRIVATE_FULL_CHAIN_FIXTURE_INVALID", "Every frozen job must match the canonical JD schema, analysis length, and source content hash.");
    }
  }
  const jobIds = jobs.map((job) => String(job?.id || "").trim());
  const labelIds = rawLabels.map((label) => String(label?.id || "").trim());
  if (jobIds.some((id) => !id) || labelIds.some((id) => !id)
    || new Set(jobIds).size !== jobIds.length || new Set(labelIds).size !== labelIds.length
    || JSON.stringify([...jobIds].sort()) !== JSON.stringify([...labelIds].sort())
    || rawLabels.some((label) => {
      const disposition = isUserV2 && label.expectedDisposition === "discard"
        ? "exclude"
        : label.expectedDisposition;
      return !sameKeys(label, isUserV2
        ? PRIVATE_USER_CONFIRMED_LABEL_KEYS
        : isV2 ? PRIVATE_LABEL_V2_KEYS : PRIVATE_LABEL_V1_KEYS)
      || (isUserV2 && !isNonEmptyString(label.userLabel))
      || !String(label.rationale || "").trim()
      || !PRIVATE_RECOMMENDATIONS.has(label.expectedRecommendation)
      || !PRIVATE_BUCKETS.has(label.expectedBucket)
      || !PRIVATE_LABEL_PAIRS.has(`${label.expectedRecommendation}/${label.expectedBucket}`)
      || (isRecallV2 && (!(isUserV2 ? PRIVATE_USER_DISPOSITIONS : PRIVATE_DISPOSITIONS).has(label.expectedDisposition)
        || (disposition === "exclude"
          ? label.expectedRecommendation !== "skip" || label.expectedBucket !== "not_recommended"
          : label.expectedBucket === "not_recommended")));
    })) {
    throw runnerError("PRIVATE_FULL_CHAIN_FIXTURE_INVALID", "Job and label IDs must be unique, complete, and exactly equal.");
  }
  const jobsSha256 = isUserV2
    ? (Buffer.isBuffer(jobsRaw) ? sha256(jobsRaw) : "")
    : valueSha256(jobs);
  if (!/^[0-9a-f]{64}$/.test(String(labelsValue.jobsSha256 || ""))
    || labelsValue.jobsSha256 !== jobsSha256) {
    throw runnerError("PRIVATE_FULL_CHAIN_FIXTURE_INVALID", "The frozen label set does not match the frozen job set.");
  }
  const labels = isUserV2
    ? rawLabels.map((label) => ({
      ...label,
      expectedDisposition: label.expectedDisposition === "discard" ? "exclude" : label.expectedDisposition
    }))
    : rawLabels;
  return {
    jobs,
    labels,
    labelsVersion: labelsValue.labelsVersion,
    evaluationPolicy: isRecallV2 ? labelsValue.evaluationPolicy : "exact.v1",
    jobsSha256,
    labelsSha256: valueSha256(labelsValue),
    labelById: new Map(labels.map((label) => [String(label.id), label]))
  };
}

function deriveRecallFirstMetrics(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    return fail("BENCHMARK_COMPARE_METRICS", "Recall-first results require non-empty rows.");
  }
  const ids = new Set();
  for (const row of rows) {
    const id = String(row?.id || "").trim();
    if (!id || ids.has(id)
      || !PRIVATE_DISPOSITIONS.has(row?.expectedDisposition)
      || !PRIVATE_ACTUAL_BUCKETS.has(row?.actualBucket)) {
      return fail("BENCHMARK_COMPARE_METRICS", "Recall-first row structure is invalid.");
    }
    ids.add(id);
  }
  const expectedKeepRows = rows.filter((row) => row.expectedDisposition === "keep");
  const expectedExcludeRows = rows.filter((row) => row.expectedDisposition === "exclude");
  const retainedRows = expectedKeepRows.filter((row) => ["primary", "talk", "backup"].includes(row.actualBucket));
  const falseHardExclusionIds = expectedKeepRows
    .filter((row) => row.actualBucket === "not_recommended")
    .map((row) => row.id)
    .sort();
  const obviousMismatchExcludedRows = expectedExcludeRows.filter((row) => row.actualBucket === "not_recommended");
  const missedObviousExclusionIds = expectedExcludeRows
    .filter((row) => ["primary", "talk", "backup"].includes(row.actualBucket))
    .map((row) => row.id)
    .sort();
  const unresolvedDispositionIds = rows
    .filter((row) => ["analysis_pending", "refresh"].includes(row.actualBucket))
    .map((row) => row.id)
    .sort();
  return {
    ok: true,
    metrics: {
      expectedKeep: expectedKeepRows.length,
      retainedOpportunity: retainedRows.length,
      falseHardExclusion: falseHardExclusionIds.length,
      falseHardExclusionIds,
      expectedExclude: expectedExcludeRows.length,
      obviousMismatchExcluded: obviousMismatchExcludedRows.length,
      missedObviousExclusion: missedObviousExclusionIds.length,
      missedObviousExclusionIds,
      unresolvedDisposition: unresolvedDispositionIds.length,
      unresolvedDispositionIds,
      opportunityRetentionRate: expectedKeepRows.length ? retainedRows.length / expectedKeepRows.length : 1,
      obviousExclusionRate: expectedExcludeRows.length ? obviousMismatchExcludedRows.length / expectedExcludeRows.length : 1
    }
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
    || value.benchmarkHarnessVersion !== (context.harnessVersion || PRIVATE_HARNESS_VERSION)
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
  return assertResumeIdentityRedacted;
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

function safeTelemetryInteger(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_SAFE_TELEMETRY_INTEGER ? value : 0;
}

function privateContractFailureCategory(value) {
  const message = String(value || "");
  if (!message) return "none";
  if (/unknown key|unknown field|unexpected key|\u672a\u77e5\u5b57\u6bb5|\u4e0d\u5141\u8bb8\u5b57\u6bb5/i.test(message)) {
    return "unknown_keys";
  }
  const categories = [];
  if (/selectedTrackId/.test(message)) categories.push("selected_track");
  if (/roleResumeEvidence/.test(message)) categories.push("role_resume_evidence");
  if (/roleAlignment/.test(message)) categories.push("role_alignment");
  if (/roleGaps/.test(message)) categories.push("role_gaps");
  if (/\beligibility\b/.test(message)) categories.push("eligibility");
  if (/\bmatches\b|requirement|coverage/i.test(message)) categories.push("requirement_matches");
  const distinct = [...new Set(categories)];
  if (distinct.length === 1) return distinct[0];
  if (distinct.length > 1) return "other";
  if (/must be (?:an? )?(?:object|array)|\u5fc5\u987b\u662f(?:\u5bf9\u8c61|\u6570\u7ec4)|result shape/i.test(message)) {
    return "result_shape";
  }
  return "other";
}

function privateContractFailureReason(value) {
  const message = String(value || "");
  if (!message) return "none";
  const reasons = [];
  const add = (pattern, reason) => {
    if (pattern.test(message)) reasons.push(reason);
  };
  add(/selectedTrackId.*(?:\u4e0d\u5b58\u5728|required|must be|missing)/i, "selected_track");
  add(/match evidence requires jobUnderstanding|sparse match evidence requires jobUnderstanding|\u7d27\u51d1\u5339\u914d\u8bc1\u636e\u5fc5\u987b\u643a\u5e26\u672c\u6b21 jobUnderstanding/i, "context_shape");
  add(/roleAlignment must be one of/i, "role_alignment_enum");
  add(/empty responsibilityEvidence requires insufficient_evidence/i, "responsibility_requires_insufficient");
  add(/(?:aligned|mostly_aligned|partially_aligned) requires roleResumeEvidence/i, "aligned_requires_role_resume");
  add(/misaligned requires responsibility evidence, resume evidence, and a gap/i, "misaligned_requires_evidence_triplet");
  add(/insufficient_evidence requires a concrete gap/i, "insufficient_requires_gap");
  for (const field of ["matches", "eligibility"]) {
    const prefix = field === "matches" ? "matches" : "eligibility";
    add(new RegExp(`${field} (?:must be an array|must contain evidence objects)|${field} \u5fc5\u987b\u662f(?:\u6570\u7ec4|[^\\n]*\u5bf9\u8c61\u6570\u7ec4)`, "i"), `${prefix}_shape`);
    add(new RegExp(`${field} (?:contains unknown ID|\u5305\u542b\u4e0d\u5b58\u5728\u7684 ID)`, "i"), `${prefix}_unknown_id`);
    add(new RegExp(`${field} (?:contains duplicate ID|[^\\n]*ID[^\\n]*\u91cd\u590d)`, "i"), `${prefix}_duplicate_id`);
    add(new RegExp(`${field}\\.state (?:is invalid|\u5fc5\u987b\u662f)`, "i"), `${prefix}_state`);
    add(new RegExp(`${field}(?:\\.[^\\s]+)?[^\\n]*(?:requires resumeEvidence|\u5fc5\u987b\u63d0\u4f9b resumeEvidence|resumeEvidence \u5fc5\u987b)`, "i"), `${prefix}_resume_evidence`);
  }
  const distinct = [...new Set(reasons)];
  return distinct.length === 1 ? distinct[0] : "other";
}

function createPrivateTelemetryCollector() {
  let values;
  const reset = () => {
    values = {
      understandJobLatencyMs: 0,
      matchJobLatencyMs: 0,
      modelCallCount: 0,
      modelAttemptCount: 0,
      emptyResponseAttemptCount: 0,
      modelAttemptLatencyMs: 0,
      contractRepairCount: 0,
      initialContractFailureCategory: "none",
      repairContractFailureCategory: "none",
      initialContractFailureReason: "none",
      repairContractFailureReason: "none",
      responseContentChars: 0
    };
  };
  const collect = (event, data) => {
    if (event === "model_contract_repair_requested") {
      values.contractRepairCount = Math.min(MAX_SAFE_TELEMETRY_INTEGER, values.contractRepairCount + 1);
      values.initialContractFailureCategory = safeEnum(
        privateContractFailureCategory(data?.errorMessage),
        SAFE_CONTRACT_FAILURE_CATEGORIES,
        "other"
      );
      values.initialContractFailureReason = safeEnum(
        privateContractFailureReason(data?.errorMessage),
        SAFE_CONTRACT_FAILURE_REASONS,
        "other"
      );
      return;
    }
    if (event === "model_contract_repair_failed") {
      if (values.initialContractFailureCategory === "none") {
        values.initialContractFailureCategory = safeEnum(
          privateContractFailureCategory(data?.initialErrorMessage),
          SAFE_CONTRACT_FAILURE_CATEGORIES,
          "other"
        );
      }
      if (values.initialContractFailureReason === "none") {
        values.initialContractFailureReason = safeEnum(
          privateContractFailureReason(data?.initialErrorMessage),
          SAFE_CONTRACT_FAILURE_REASONS,
          "other"
        );
      }
      values.repairContractFailureCategory = safeEnum(
        privateContractFailureCategory(data?.errorMessage),
        SAFE_CONTRACT_FAILURE_CATEGORIES,
        "other"
      );
      values.repairContractFailureReason = safeEnum(
        privateContractFailureReason(data?.errorMessage),
        SAFE_CONTRACT_FAILURE_REASONS,
        "other"
      );
      return;
    }
    if (event === "model_call_attempt_completed" || event === "model_call_attempt_failed") {
      const stage = safeEnum(data?.kind, SAFE_FAILURE_STAGES, "");
      if (!stage) return;
      values.modelAttemptCount = Math.min(MAX_SAFE_TELEMETRY_INTEGER, values.modelAttemptCount + 1);
      values.modelAttemptLatencyMs = Math.min(
        MAX_SAFE_TELEMETRY_INTEGER,
        values.modelAttemptLatencyMs + safeTelemetryInteger(data?.latencyMs)
      );
      if (
        event === "model_call_attempt_failed"
        && data?.errorCode === "MODEL_EMPTY_RESPONSE"
        && data?.responseFailureKind === "empty_response"
      ) {
        values.emptyResponseAttemptCount = Math.min(
          MAX_SAFE_TELEMETRY_INTEGER,
          values.emptyResponseAttemptCount + 1
        );
      }
      return;
    }
    if (event !== "model_call_completed") return;
    const stage = safeEnum(data?.kind, SAFE_FAILURE_STAGES, "");
    if (!stage) return;
    values[`${stage}LatencyMs`] = Math.min(
      MAX_SAFE_TELEMETRY_INTEGER,
      values[`${stage}LatencyMs`] + safeTelemetryInteger(data?.latencyMs)
    );
    values.modelCallCount = Math.min(MAX_SAFE_TELEMETRY_INTEGER, values.modelCallCount + 1);
    values.responseContentChars = Math.min(
      MAX_SAFE_TELEMETRY_INTEGER,
      values.responseContentChars + safeTelemetryInteger(data?.contentLength)
    );
  };
  reset();
  return {
    logger: { info: collect, warn: collect },
    reset,
    snapshot: () => ({ ...values })
  };
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
  const provenanceContext = {
    injected: Boolean(testSeam),
    manifest,
    runManifestSha256,
    side: request.side,
    evaluatedCommit: proof.commit
  };
  const preflight = request.mode === "profile-live"
    ? readProfileLiveInputs(request, privacyValidator)
    : request.mode === "card-live"
      ? readCardLiveInput(request, {
        ...provenanceContext
      })
      : request.portabilityProof
        ? validateConfirmedEvidencePortability(request, provenanceContext, privacyValidator, testSeam)
        : {
        profileValue: readJsonFile(request.profile),
        cardValue: readJsonFile(request.matchingCard),
        jobsValue: readJsonFile(request.jobs),
        labelsValue: readJsonFile(request.labels),
        resume: readMatchResumeAndIdentity(request.privateRoot, privacyValidator)
      };
  if (request.mode === "match-live") {
    if (request.portabilityProof) {
      preflight.portability = { proof: preflight.proof };
    } else if (preflight.profileValue?.benchmarkHarnessVersion === PORTABLE_SOURCE_HARNESS_VERSION) {
      if (!request.portabilityProof) {
        throw runnerError("PRIVATE_FULL_CHAIN_PROFILE_UNCONFIRMED", "V1 confirmed evidence requires an explicit portability proof.");
      }
    } else {
      preflight.profileInput = confirmedProfileInput(preflight.profileValue, provenanceContext);
      preflight.cardInput = confirmedCardInput(preflight.cardValue, preflight.profileInput, provenanceContext);
    }
    if (preflight.profileInput.envelope.resumeContentSha256 !== sha256(preflight.resume.resumeText)
      || preflight.profileInput.envelope.identityManifestSha256 !== sha256(preflight.resume.identityRaw)) {
      throw runnerError("PRIVATE_FULL_CHAIN_PROFILE_UNCONFIRMED", "The confirmed profile is not bound to the current resume evidence.");
    }
    if (!preflight.fixture) preflight.fixture = privateJobsAndLabels(preflight.jobsValue, preflight.labelsValue);
    if (request.diagnosticIndices?.some((index) => index >= preflight.fixture.jobs.length)) {
      throw runnerError("PRIVATE_FULL_CHAIN_DIAGNOSTIC_INVALID", "A diagnostic index is outside the frozen fixture.");
    }
    preflight.selectedJobs = request.diagnosticIndices
      ? request.diagnosticIndices.map((index) => preflight.fixture.jobs[index])
      : preflight.fixture.jobs;
    if (typeof testSeam?.onMatchPreflight === "function") testSeam.onMatchPreflight(preflight);
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

  const { profileInput, cardInput, fixture, selectedJobs } = preflight;
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
    const telemetry = createPrivateTelemetryCollector();
    const analyze = modules.createJobAnalysisRunner(configs, searchPlan.keywords, {
      db,
      ...(testSeam?.adapter ? { analyzer: testSeam.adapter } : {}),
      logger: telemetry.logger
    });
    rows = await modules.mapWithConcurrency(selectedJobs, 1, async (job) => {
      // The frozen fixture is already a complete, read-only JD snapshot. Activity/detail refresh
      // is an operational acquisition gate and is intentionally neutral in this matching benchmark.
      const benchmarkJob = frozenBenchmarkScoreInput(job);
      const scored = modules.scoreJob(benchmarkJob, configs);
      const state = modules.decisionState(scored);
      const analysisJob = { ...job, source: "boss", detailRequired: true, detailRead: true, ...scored };
      telemetry.reset();
      const analysisStartedAt = Date.now();
      const analysis = state === "ready" ? await analyze(analysisJob) : ruleBlockedAnalysis();
      const telemetryValues = telemetry.snapshot();
      const actualBucket = modules.decisionBucket({ ...analysisJob, analysis });
      const label = fixture.labelById.get(String(job.id));
      const actualRecommendation = String(analysis.recommendation || "review");
      return {
        id: String(job.id),
        expectedRecommendation: label.expectedRecommendation,
        ...(isRecallFirstPolicy(fixture.evaluationPolicy)
          ? { expectedDisposition: label.expectedDisposition }
          : {}),
        actualRecommendation,
        expectedBucket: label.expectedBucket,
        actualBucket,
        selectedTrackId: String(analysis.selectedTrackId || "").slice(0, 8),
        selectedTrackLabel: String(analysis.selectedTrackLabel || "").slice(0, 80),
        roleSummary: String(analysis.roleSummary || "").slice(0, 160),
        roleResumeEvidenceCount: Array.isArray(analysis.roleResumeEvidence) ? analysis.roleResumeEvidence.length : 0,
        roleGapCount: Array.isArray(analysis.roleGaps) ? analysis.roleGaps.length : 0,
        roleAlignment: safeEnum(analysis.roleAlignment, SAFE_ROLE_ALIGNMENTS, "insufficient_evidence"),
        foundationState: safeEnum(
          modules.roleEvidenceDecisionState(analysis).foundationState,
          SAFE_FOUNDATION_STATES,
          "none"
        ),
        analysisElapsedMs: safeTelemetryInteger(Date.now() - analysisStartedAt),
        ...telemetryValues,
        semanticStatus: safeEnum(analysis.semanticStatus, SAFE_SEMANTIC_STATUSES, "failed"),
        evidenceComplete: Boolean(analysis.evidence?.jd?.length && analysis.evidence?.resume?.length),
        explanation: {
          decisionSource: safeEnum(analysis.decisionSource, SAFE_DECISION_SOURCES, "unknown"),
          fitReasonCount: Array.isArray(analysis.fitReasons) ? analysis.fitReasons.length : 0,
          missingPointCount: Array.isArray(analysis.missingPoints || analysis.softGaps)
            ? (analysis.missingPoints || analysis.softGaps).length
            : 0
        },
        hardBlocked: state === "blocked" || productDecisionHardBlockers(modules, analysis).length > 0,
        decisionState: safeEnum(state, SAFE_DECISION_STATES, "unknown"),
        errorCode: safeErrorCode(analysis.errorCode),
        failureStage: safeEnum(analysis.errorStage, SAFE_FAILURE_STAGES, ""),
        failurePhase: safeEnum(analysis.errorPhase, SAFE_FAILURE_PHASES, ""),
        responseFailureKind: safeEnum(analysis.errorResponseKind, SAFE_RESPONSE_FAILURE_KINDS, ""),
        requestedMaxTokens: Number.isInteger(analysis.errorRequestedMaxTokens)
          && analysis.errorRequestedMaxTokens > 0
          && analysis.errorRequestedMaxTokens <= 65536
          ? analysis.errorRequestedMaxTokens
          : null,
        responseHttpStatus: Number.isInteger(analysis.errorHttpStatus)
          && analysis.errorHttpStatus >= 100
          && analysis.errorHttpStatus <= 599
          ? analysis.errorHttpStatus
          : null,
        responseJsonModeApplied: typeof analysis.errorJsonModeApplied === "boolean"
          ? analysis.errorJsonModeApplied
          : null,
        responseContentLength: Number.isInteger(analysis.errorContentLength)
          && analysis.errorContentLength >= 0
          && analysis.errorContentLength <= 10000000
          ? analysis.errorContentLength
          : null,
        responseContentTypeKind: safeEnum(analysis.errorContentTypeKind, SAFE_RESPONSE_CONTENT_TYPE_KINDS, ""),
        responseEnvelopeKind: safeEnum(analysis.errorEnvelopeKind, SAFE_RESPONSE_ENVELOPE_KINDS, ""),
        responseParseFailureKind: safeEnum(analysis.errorParseFailureKind, SAFE_RESPONSE_PARSE_FAILURE_KINDS, ""),
        responseHadUtf8Bom: typeof analysis.errorHadUtf8Bom === "boolean"
          ? analysis.errorHadUtf8Bom
          : null,
        pass: actualRecommendation === label.expectedRecommendation && actualBucket === label.expectedBucket
      };
    });
  } finally {
    db.close();
  }
  const derived = deriveBenchmarkMetrics(rows);
  if (!derived.ok) throw runnerError(derived.code, derived.message);
  const recallDerived = isRecallFirstPolicy(fixture.evaluationPolicy)
    ? deriveRecallFirstMetrics(rows)
    : null;
  if (recallDerived && !recallDerived.ok) throw runnerError(recallDerived.code, recallDerived.message);
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
    confirmedEvidencePortabilitySha256: preflight.portability?.proof.proofSha256 || null,
    confirmedEvidenceSourceHarnessVersion: preflight.portability?.proof.sourceHarness || PRIVATE_HARNESS_VERSION,
    modelIdentity,
    modelIdentitySha256,
    diagnosticMode: Boolean(request.diagnosticIndices),
    acceptanceEligible: !request.diagnosticIndices,
    frozenFixtureTotal: fixture.jobs.length,
    diagnosticIndices: request.diagnosticIndices || [],
    ...derived.metrics,
    ...(recallDerived ? {
      labelsVersion: fixture.labelsVersion,
      evaluationPolicy: fixture.evaluationPolicy,
      ...recallDerived.metrics
    } : {}),
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

const RECALL_FIRST_SUMMARY_FIELDS = [
  "expectedKeep",
  "retainedOpportunity",
  "falseHardExclusion",
  "expectedExclude",
  "obviousMismatchExcluded",
  "missedObviousExclusion",
  "unresolvedDisposition",
  "opportunityRetentionRate",
  "obviousExclusionRate"
];
const RECALL_FIRST_ID_FIELDS = [
  "falseHardExclusionIds",
  "missedObviousExclusionIds",
  "unresolvedDispositionIds"
];

function sameSortedStrings(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function verifyStoredRecallFirstMetrics(value) {
  const derived = deriveRecallFirstMetrics(value.rows);
  if (!derived.ok) return derived;
  for (const field of RECALL_FIRST_SUMMARY_FIELDS) {
    if (value[field] !== derived.metrics[field]) {
      return fail("BENCHMARK_COMPARE_METRICS", `Recall-first summary ${field} does not match rows.`);
    }
  }
  for (const field of RECALL_FIRST_ID_FIELDS) {
    if (!sameSortedStrings(value[field], derived.metrics[field])) {
      return fail("BENCHMARK_COMPARE_METRICS", `Recall-first ID summary ${field} does not match rows.`);
    }
  }
  return { ok: true, metrics: derived.metrics };
}

function recallFirstAcceptanceFailures(candidate) {
  const failures = [];
  for (const field of ["failed", "stale", "pending", "primaryWithoutEvidence", "unresolvedDisposition"]) {
    if (candidate[field] !== 0) failures.push(`候选 ${field}=${candidate[field]}，召回优先验收要求为 0`);
  }
  if (candidate.falseHardExclusion !== 0) failures.push(`存在 ${candidate.falseHardExclusion} 条错误硬排除`);
  if (candidate.missedObviousExclusion !== 0) failures.push(`存在 ${candidate.missedObviousExclusion} 条明确排除漏拦`);
  const partialPrimary = candidate.rows.filter((row) => row.semanticStatus === "partial" && row.actualBucket === "primary");
  if (partialPrimary.length) failures.push(`存在 ${partialPrimary.length} 条 partial -> primary`);
  return failures;
}

function isSkippableEmptyResponse(row) {
  return row?.semanticStatus === "failed"
    && row?.failurePhase === "initial"
    && ["understandJob", "matchJob"].includes(row?.failureStage)
    && row?.responseHttpStatus === 200
    && row?.responseContentLength === 0
    && row?.responseContentTypeKind === "json"
    && row?.responseEnvelopeKind === "empty"
    && (
      (row?.errorCode === "MODEL_EMPTY_RESPONSE" && row?.responseFailureKind === "empty_response")
      || (row?.errorCode === "MODEL_INVALID_RESPONSE" && row?.responseFailureKind === "invalid_response_json")
    );
}

function projectPrivateResult(value, excludedIds, recallMode) {
  const rows = value.rows.filter((row) => !excludedIds.has(String(row.id)));
  if (!rows.length) return fail("BENCHMARK_COMPARE_METRICS", "Paired overlap requires at least one comparable row.");
  const benchmark = deriveBenchmarkMetrics(rows);
  if (!benchmark.ok) return benchmark;
  const result = { ...value, rows, ...benchmark.metrics };
  if (!recallMode) return { ok: true, result, recall: null };
  const recall = deriveRecallFirstMetrics(rows);
  if (!recall.ok) return recall;
  return { ok: true, result: { ...result, ...recall.metrics }, recall: recall.metrics };
}

function pairedProjection(baseline, candidate, recallMode) {
  const baselineEmptyIds = new Set(baseline.rows.filter(isSkippableEmptyResponse).map((row) => String(row.id)));
  const candidateEmptyIds = new Set(candidate.rows.filter(isSkippableEmptyResponse).map((row) => String(row.id)));
  const excludedIds = new Set([...baselineEmptyIds, ...candidateEmptyIds]);
  const baselineProjected = projectPrivateResult(baseline, excludedIds, recallMode);
  if (!baselineProjected.ok) return baselineProjected;
  const candidateProjected = projectPrivateResult(candidate, excludedIds, recallMode);
  if (!candidateProjected.ok) return candidateProjected;
  return {
    ok: true,
    baseline: baselineProjected.result,
    candidate: candidateProjected.result,
    pairedRecall: recallMode ? {
      baseline: baselineProjected.recall,
      candidate: candidateProjected.recall
    } : null,
    coverage: {
      frozenTotal: baseline.frozenFixtureTotal,
      comparableTotal: baselineProjected.result.rows.length,
      excludedEmptyTotal: excludedIds.size,
      baselineEmptyTotal: baselineEmptyIds.size,
      candidateEmptyTotal: candidateEmptyIds.size,
      bothEmptyTotal: [...baselineEmptyIds].filter((id) => candidateEmptyIds.has(id)).length,
      fullCoverageComplete: excludedIds.size === 0
    }
  };
}

function pairedInputFailures(value, sideLabel) {
  return ["failed", "stale", "pending"]
    .filter((field) => value[field] !== 0)
    .map((field) => `${sideLabel} ${field}=${value[field]}，不是可忽略的空响应`);
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
      || value.diagnosticMode !== false
      || value.acceptanceEligible !== true
      || !Array.isArray(value.diagnosticIndices)
      || value.diagnosticIndices.length !== 0
      || !Number.isInteger(value.frozenFixtureTotal)
      || value.frozenFixtureTotal <= 0
      || !Array.isArray(value.rows)
      || ![PRIVATE_HARNESS_VERSION, PORTABLE_SOURCE_HARNESS_VERSION].includes(value.confirmedEvidenceSourceHarnessVersion)
      || (value.confirmedEvidencePortabilitySha256 !== null
        && !/^[0-9a-f]{64}$/.test(String(value.confirmedEvidencePortabilitySha256 || "")))
      || !/^[0-9a-f]{64}$/.test(String(value.fixtureProfileResultSha256 || ""))
      || !hasBoundModelIdentity(value)) {
      return fail("PRIVATE_FULL_CHAIN_COMPARE_IDENTITY", "Private comparison requires strict live authorization, confirmation, side, worktree, and card-state fields.");
    }
  }
  if (baseline.frozenFixtureTotal !== candidate.frozenFixtureTotal) {
    return fail("PRIVATE_FULL_CHAIN_COMPARE_IDENTITY", "Private comparison requires the same complete frozen fixture on both sides.");
  }
  if (baseline.confirmedEvidenceSourceHarnessVersion !== candidate.confirmedEvidenceSourceHarnessVersion
    || baseline.confirmedEvidencePortabilitySha256 !== candidate.confirmedEvidencePortabilitySha256
    || (baseline.confirmedEvidenceSourceHarnessVersion === PORTABLE_SOURCE_HARNESS_VERSION
      && baseline.confirmedEvidencePortabilitySha256 === null)
    || (baseline.confirmedEvidenceSourceHarnessVersion === PRIVATE_HARNESS_VERSION
      && baseline.confirmedEvidencePortabilitySha256 !== null)) {
    return fail("PRIVATE_FULL_CHAIN_COMPARE_IDENTITY", "Private comparison portability identity does not match.");
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
  const recallMode = isV3TargetLabelIdentity(baseline.labelsVersion, baseline.evaluationPolicy)
    && isV3TargetLabelIdentity(candidate.labelsVersion, candidate.evaluationPolicy);
  const hasVersionedPolicy = Boolean(baseline.evaluationPolicy || candidate.evaluationPolicy
    || baseline.labelsVersion || candidate.labelsVersion);
  const hasRecallRows = [baseline, candidate].some((value) => value.rows.some((row) =>
    Object.prototype.hasOwnProperty.call(row, "expectedDisposition")));
  if ((hasVersionedPolicy || hasRecallRows) && (!recallMode
    || baseline.labelsVersion !== candidate.labelsVersion
    || baseline.evaluationPolicy !== candidate.evaluationPolicy)) {
    return fail("PRIVATE_FULL_CHAIN_COMPARE_IDENTITY", "Private comparison label policy identity does not match.");
  }
  const fullCompared = compareBenchmarkResults(
    { ...baseline, evaluatedCommit: baseline.productCommit },
    candidate
  );
  if (!fullCompared.ok) return fullCompared;
  let recallMetrics = null;
  if (recallMode) {
    const baselineById = new Map(baseline.rows.map((row) => [row.id, row]));
    for (const row of candidate.rows) {
      if (row.expectedDisposition !== baselineById.get(row.id)?.expectedDisposition) {
        return fail("BENCHMARK_COMPARE_FIXTURE_SET", "Candidate must not rewrite expectedDisposition.");
      }
    }
    const baselineRecall = verifyStoredRecallFirstMetrics(baseline);
    if (!baselineRecall.ok) return baselineRecall;
    const candidateRecall = verifyStoredRecallFirstMetrics(candidate);
    if (!candidateRecall.ok) return candidateRecall;
    recallMetrics = { baseline: baselineRecall.metrics, candidate: candidateRecall.metrics };
  }
  if (baseline.rows.length !== baseline.frozenFixtureTotal
    || candidate.rows.length !== candidate.frozenFixtureTotal) {
    return fail("PRIVATE_FULL_CHAIN_COMPARE_IDENTITY", "Private comparison requires every row in the complete frozen fixture.");
  }
  const projected = pairedProjection(baseline, candidate, recallMode);
  if (!projected.ok) return projected;
  const pairedCompared = projected.coverage.fullCoverageComplete
    ? fullCompared
    : compareBenchmarkResults(
        { ...projected.baseline, evaluatedCommit: projected.baseline.productCommit },
        projected.candidate
      );
  if (!pairedCompared.ok) return pairedCompared;
  const pairedFailureReasons = [...new Set([
    ...pairedInputFailures(projected.baseline, "基线"),
    ...pairedInputFailures(projected.candidate, "候选"),
    ...(recallMode
      ? recallFirstAcceptanceFailures(projected.candidate)
      : pairedCompared.report.failureReasons)
  ])];
  const pairedAccepted = pairedFailureReasons.length === 0;
  const accepted = pairedAccepted && projected.coverage.fullCoverageComplete;
  const status = accepted
    ? "full_pass"
    : pairedAccepted
      ? "paired_pass_full_incomplete"
      : "paired_fail";
  const failureReasons = projected.coverage.fullCoverageComplete
    ? pairedFailureReasons
    : [
        ...pairedFailureReasons,
        `有效配对 ${projected.coverage.comparableTotal}/${projected.coverage.frozenTotal}，全量覆盖未完成`
      ];
  const before = new Map(projected.baseline.rows.map((row) => [row.id, row]));
  const changed = (predicate) => projected.candidate.rows
    .filter((row) => predicate(before.get(row.id), row))
    .map((row) => row.id)
    .sort();
  return {
    ok: true,
    report: {
      ...pairedCompared.report,
      runMode: "offline-private-compare",
      coverage: projected.coverage,
      pairedAccepted,
      accepted,
      status,
      failureReasons,
      ...(recallMode ? {
        labelsVersion: candidate.labelsVersion,
        evaluationPolicy: candidate.evaluationPolicy,
        recall: recallMetrics,
        pairedRecall: projected.pairedRecall
      } : {}),
      fullSummary: {
        baseline: {
          total: baseline.total,
          failed: baseline.failed,
          stale: baseline.stale,
          pending: baseline.pending,
          partial: baseline.partial,
          primaryWithoutEvidence: baseline.primaryWithoutEvidence,
          hardFalsePlacement: baseline.hardFalsePlacement
        },
        candidate: {
          total: candidate.total,
          failed: candidate.failed,
          stale: candidate.stale,
          pending: candidate.pending,
          partial: candidate.partial,
          primaryWithoutEvidence: candidate.primaryWithoutEvidence,
          hardFalsePlacement: candidate.hardFalsePlacement
        }
      },
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
      portability: {
        proofSha256: baseline.confirmedEvidencePortabilitySha256,
        sourceHarness: baseline.confirmedEvidenceSourceHarnessVersion
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
  const lines = [
    "# Private full-chain comparison",
    "",
    `- Accepted: ${report.accepted}`,
    `- Status: ${report.status || (report.accepted ? "full_pass" : "paired_fail")}`,
    `- Paired accepted: ${report.pairedAccepted ?? report.accepted}`,
    `- Comparable rows: ${report.coverage?.comparableTotal ?? report.total}/${report.coverage?.frozenTotal ?? report.total}`,
    `- Empty-response rows excluded: ${report.coverage?.excludedEmptyTotal ?? 0}`,
    `- Full coverage complete: ${report.coverage?.fullCoverageComplete ?? true}`,
    `- Baseline: ${report.baselineBehaviorCommit}`,
    `- Candidate: ${report.evaluatedCommit}`,
    `- Baseline card consumed: ${report.card.baselineConsumed}`,
    `- Candidate card consumed: ${report.card.candidateConsumed}`,
    `- Source harness: ${report.portability.sourceHarness}`,
    `- Portability proof: ${report.portability.proofSha256 || "native-v2"}`,
    `- Failure reasons: ${report.failureReasons.length ? report.failureReasons.join("; ") : "none"}`
  ];
  if (isRecallFirstPolicy(report.evaluationPolicy)) {
    const recall = report.pairedRecall?.candidate || report.recall.candidate;
    lines.push(
      `- Labels version: ${report.labelsVersion}`,
      `- Evaluation policy: ${report.evaluationPolicy}`,
      `- Opportunities retained: ${recall.retainedOpportunity}/${recall.expectedKeep}`,
      `- False hard exclusions: ${recall.falseHardExclusion}`,
      `- Obvious mismatches excluded: ${recall.obviousMismatchExcluded}/${recall.expectedExclude}`,
      `- Missed obvious exclusions: ${recall.missedObviousExclusion}`
    );
  }
  return [...lines, ""].join("\n");
}

function parseCli(argv) {
  const options = {};
  const flags = new Set([...MODES].map((mode) => `--${mode}`));
  const valueOptions = new Set([
    "--private-root", "--baseline-worktree", "--candidate-worktree", "--output", "--pdf", "--identity",
    "--resume-text", "--parse-report", "--side", "--profile", "--matching-card", "--jobs", "--labels",
    "--model-settings-root", "--baseline", "--candidate", "--report", "--baseline-product-commit", "--candidate-product-commit",
    "--source-private-root", "--portability-proof", "--proof-version", "--diagnostic-indices"
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
  if (options.mode === "create-portability-proof") return createConfirmedEvidencePortability(options);
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
  verifyProductCommit,
  initializePrivateManifest,
  createConfirmedEvidencePortability,
  validateProfileResultProvenance,
  runPrivateFullChain,
  comparePrivateFullChainResults,
  deriveRecallFirstMetrics
};
