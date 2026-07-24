const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { loadConfigs } = require("../src/config");
const { createJobAnalysisRunner } = require("../src/core/job_analysis");
const { profileToRuntimeConfigs } = require("../src/core/search_plan");
const { scoreJob, decisionState } = require("../src/core/scoring");
const { openDb, decisionBucket } = require("../src/core/storage");
const { resolveRuntimeModelConfig } = require("../src/core/model_settings");
const { mapWithConcurrency } = require("../src/core/async_pool");

const root = path.resolve(__dirname, "..");
const fixtures = require("./fixtures/job_match_benchmark.json");

const BENCHMARK_HARNESS_VERSION = "sanitized-live-harness.v2";
const LIVE_BENCHMARK_ENV = "ALLOW_LIVE_MODEL_BENCHMARK";
const LIVE_BENCHMARK_OUTPUT_ENV = "BENCHMARK_LIVE_OUTPUT_DIR";
const LIVE_BENCHMARK_EVALUATED_COMMIT_ENV = "BENCHMARK_EVALUATED_COMMIT";
const LIVE_BENCHMARK_BASELINE_COMMIT_ENV = "BENCHMARK_BASELINE_BEHAVIOR_COMMIT";
const LIVE_BENCHMARK_CHILD_ENV = "ROLEFLOW_BENCHMARK_OFFLINE_CHILD";
const LIVE_PROFILE_FIXTURE = path.join("tests", "fixtures", "live_benchmark_profile.json");
const LIVE_RESUME_VERSIONS_FIXTURE = path.join("tests", "fixtures", "live_benchmark_resume_versions.json");
const LIVE_FIXTURE_PROFILE_ID = "live_benchmark_sanitized_profile";
const LIVE_SOURCE_URL = /^https?:\/\//i;
const LIVE_SOURCE_HOST = /(zhipin\.com|zhaopin\.com|liepin\.com|lagou\.com|51job\.com|linkedin\.com)/i;

validateFixtures();

function assertGateContractOffline() {
  assert.strictEqual(
    typeof validateLiveBenchmarkRequest,
    "function",
    "实时基准门禁契约未实现：validateLiveBenchmarkRequest(options, env, provider) 必须是可注入 provider 的纯函数"
  );
  const externalOutput = path.join("D:\\DevData", "RoleFlow-benchmark", `gate-${process.pid}`);
  const actualCommit = "1111111111111111111111111111111111111111";
  const otherCommit = "2222222222222222222222222222222222222222";
  const realProvider = () => ({ provider: "openai_compatible" });
  const baseOptions = {
    live: true,
    profilePath: LIVE_PROFILE_FIXTURE,
    resumeVersionsPath: LIVE_RESUME_VERSIONS_FIXTURE,
    outputDir: externalOutput,
    actualCommit,
    worktreeClean: true
  };
  const authorizedEnv = { [LIVE_BENCHMARK_ENV]: "YES" };
  const cases = [
    { name: "缺 --live 请求标记", options: { ...baseOptions, live: false }, env: authorizedEnv, provider: realProvider, code: "LIVE_BENCHMARK_FLAG_REQUIRED" },
    { name: "缺授权环境变量", options: baseOptions, env: {}, provider: realProvider, code: "LIVE_BENCHMARK_NOT_AUTHORIZED" },
    { name: "授权值必须严格等于 YES", options: baseOptions, env: { [LIVE_BENCHMARK_ENV]: "yes" }, provider: realProvider, code: "LIVE_BENCHMARK_NOT_AUTHORIZED" },
    { name: "fixture 指向真实画像", options: { ...baseOptions, profilePath: "profiles/guo_mingfu.json" }, env: authorizedEnv, provider: realProvider, code: "LIVE_BENCHMARK_UNSANITIZED_INPUT" },
    { name: "fixture 指向真实简历版本", options: { ...baseOptions, resumeVersionsPath: "profiles/resume_versions.json" }, env: authorizedEnv, provider: realProvider, code: "LIVE_BENCHMARK_UNSANITIZED_INPUT" },
    { name: "fixture 指向主项目数据库", options: { ...baseOptions, profilePath: "data/jobs.sqlite" }, env: authorizedEnv, provider: realProvider, code: "LIVE_BENCHMARK_UNSANITIZED_INPUT" },
    { name: "fixture 指向招聘网站", options: { ...baseOptions, profilePath: "https://www.zhipin.com/job_detail/x.html" }, env: authorizedEnv, provider: realProvider, code: "LIVE_BENCHMARK_FORBIDDEN_SOURCE" },
    { name: "fixture 路径不在白名单", options: { ...baseOptions, profilePath: "tests/fixtures/job_match_benchmark.json" }, env: authorizedEnv, provider: realProvider, code: "LIVE_BENCHMARK_FIXTURE_MISMATCH" },
    { name: "缺输出目录", options: { ...baseOptions, outputDir: "" }, env: authorizedEnv, provider: realProvider, code: "LIVE_BENCHMARK_OUTPUT_DIR_REQUIRED" },
    { name: "输出目录在主项目 data", options: { ...baseOptions, outputDir: path.join(root, "data", "benchmark") }, env: authorizedEnv, provider: realProvider, code: "LIVE_BENCHMARK_OUTPUT_DIR_FORBIDDEN" },
    { name: "输出目录在仓库 .runtime", options: { ...baseOptions, outputDir: path.join(root, ".runtime", "benchmark") }, env: authorizedEnv, provider: realProvider, code: "LIVE_BENCHMARK_OUTPUT_DIR_FORBIDDEN" },
    { name: "输出目录在默认用户目录", options: { ...baseOptions, outputDir: path.join(os.homedir(), "benchmark") }, env: authorizedEnv, provider: realProvider, code: "LIVE_BENCHMARK_OUTPUT_DIR_FORBIDDEN" },
    { name: "输出目录在系统临时目录（含 8.3 短路径形式）", options: { ...baseOptions, outputDir: path.join(os.tmpdir(), "roleflow-live-benchmark") }, env: authorizedEnv, provider: realProvider, code: "LIVE_BENCHMARK_OUTPUT_DIR_FORBIDDEN" },
    { name: "输出目录为系统临时目录本身", options: { ...baseOptions, outputDir: os.tmpdir() }, env: authorizedEnv, provider: realProvider, code: "LIVE_BENCHMARK_OUTPUT_DIR_FORBIDDEN" },
    { name: "无法读取当前实际 HEAD", options: { ...baseOptions, actualCommit: "" }, env: authorizedEnv, provider: realProvider, code: "LIVE_BENCHMARK_GIT_HEAD_REQUIRED" },
    { name: "命令行伪造评估提交", options: { ...baseOptions, evaluatedCommit: otherCommit }, env: authorizedEnv, provider: realProvider, code: "LIVE_BENCHMARK_COMMIT_MISMATCH" },
    { name: "环境变量伪造评估提交", options: baseOptions, env: { ...authorizedEnv, [LIVE_BENCHMARK_EVALUATED_COMMIT_ENV]: otherCommit }, provider: realProvider, code: "LIVE_BENCHMARK_COMMIT_MISMATCH" },
    { name: "工作树包含未提交改动", options: { ...baseOptions, worktreeClean: false }, env: authorizedEnv, provider: realProvider, code: "LIVE_BENCHMARK_WORKTREE_DIRTY" },
    { name: "provider 为 mock", options: baseOptions, env: authorizedEnv, provider: () => ({ provider: "mock" }), code: "LIVE_BENCHMARK_REAL_MODEL_REQUIRED" },
    { name: "provider 未以纯函数注入", options: baseOptions, env: authorizedEnv, provider: { provider: "openai_compatible" }, code: "LIVE_BENCHMARK_PROVIDER_REQUIRED" }
  ];
  for (const testCase of cases) {
    const result = validateLiveBenchmarkRequest(testCase.options, testCase.env, testCase.provider);
    assert(result && result.ok === false, `${testCase.name}：门禁必须拒绝`);
    assert.strictEqual(result.code, testCase.code, `${testCase.name}：错误码不符`);
    assert(typeof result.message === "string" && result.message.length > 0, `${testCase.name}：必须携带失败原因`);
  }
  let providerCalls = 0;
  const countingProvider = () => {
    providerCalls += 1;
    return { provider: "openai_compatible" };
  };
  validateLiveBenchmarkRequest(baseOptions, {}, countingProvider);
  assert.strictEqual(providerCalls, 0, "未授权时门禁不得解析 provider");
  validateLiveBenchmarkRequest({ ...baseOptions, profilePath: "profiles/guo_mingfu.json" }, authorizedEnv, countingProvider);
  assert.strictEqual(providerCalls, 0, "危险路径时门禁不得解析 provider");
  validateLiveBenchmarkRequest({ ...baseOptions, outputDir: "" }, authorizedEnv, countingProvider);
  assert.strictEqual(providerCalls, 0, "缺输出目录时门禁不得解析 provider");
  validateLiveBenchmarkRequest({ ...baseOptions, evaluatedCommit: otherCommit }, authorizedEnv, countingProvider);
  assert.strictEqual(providerCalls, 0, "评估提交与实际 HEAD 不一致时门禁不得解析 provider");
  validateLiveBenchmarkRequest({ ...baseOptions, worktreeClean: false }, authorizedEnv, countingProvider);
  assert.strictEqual(providerCalls, 0, "工作树有未提交改动时门禁不得解析 provider");
  const granted = validateLiveBenchmarkRequest(baseOptions, authorizedEnv, countingProvider);
  assert.strictEqual(providerCalls, 1, "全部条件满足时门禁恰好解析一次 provider");
  assert(granted.ok === true && granted.code === "OK", "全部条件满足时门禁必须放行");
  assert.strictEqual(granted.request.runMode, "live");
  assert.strictEqual(granted.request.authorizationGatePassed, true);
  assert.strictEqual(granted.request.benchmarkHarnessVersion, BENCHMARK_HARNESS_VERSION);
  assert.strictEqual(granted.request.profilePath, resolveAgainstRoot(LIVE_PROFILE_FIXTURE));
  assert.strictEqual(granted.request.resumeVersionsPath, resolveAgainstRoot(LIVE_RESUME_VERSIONS_FIXTURE));
  assert.strictEqual(granted.request.outputDir, canonicalizeExisting(externalOutput));
  assert.strictEqual(granted.request.evaluatedCommit, actualCommit, "实时结果必须记录当前 checkout 的完整实际 HEAD");
}

function validateFixtures() {
  assert(fixtures.length >= 30, "人工标注集至少需要 30 条");
  assert.strictEqual(new Set(fixtures.map((item) => item.id)).size, fixtures.length);
  for (const item of fixtures) {
    assert(item.title && item.description.length >= 80, `${item.id} 缺少可分析 JD`);
    assert(item.category, `${item.id} 缺少人工分类 category`);
    assert(["apply", "caution", "review", "skip"].includes(item.expectedRecommendation), `${item.id} recommendation 无效`);
    assert(["primary", "talk", "backup", "not_recommended"].includes(item.expectedBucket), `${item.id} bucket 无效`);
    assert(item.rationale, `${item.id} 缺少人工标注理由`);
  }
}

function failLiveBenchmark(code, message) {
  return { ok: false, code, message };
}

function resolveAgainstRoot(candidate) {
  return path.resolve(root, String(candidate)).toLowerCase();
}

function checkLiveFixturePaths(paths) {
  for (const key of Object.keys(paths)) {
    const value = String(paths[key] || "");
    if (LIVE_SOURCE_URL.test(value) || LIVE_SOURCE_HOST.test(value)) {
      return failLiveBenchmark("LIVE_BENCHMARK_FORBIDDEN_SOURCE", `实时基准禁止从 URL 或招聘网站读取 ${key}。`);
    }
  }
  const resolved = {
    profilePath: resolveAgainstRoot(paths.profilePath),
    resumeVersionsPath: resolveAgainstRoot(paths.resumeVersionsPath)
  };
  for (const key of Object.keys(resolved)) {
    const segments = resolved[key].split(path.sep);
    if (segments.includes("profiles") || segments.includes("data") || segments.includes(".runtime") || resolved[key].endsWith(".sqlite")) {
      return failLiveBenchmark("LIVE_BENCHMARK_UNSANITIZED_INPUT", `实时基准禁止读取真实画像、真实简历或项目数据：${key}。`);
    }
  }
  if (resolved.profilePath !== resolveAgainstRoot(LIVE_PROFILE_FIXTURE)
    || resolved.resumeVersionsPath !== resolveAgainstRoot(LIVE_RESUME_VERSIONS_FIXTURE)) {
    return failLiveBenchmark("LIVE_BENCHMARK_FIXTURE_MISMATCH", "实时基准只能读取 tests/fixtures 下两份脱敏 fixture。");
  }
  return { ok: true, resolved };
}

function canonicalizeExisting(candidate) {
  const absolute = path.resolve(String(candidate));
  let existing = absolute;
  const missing = [];
  while (!fs.existsSync(existing)) {
    missing.push(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  let canonicalBase = existing;
  try {
    canonicalBase = fs.realpathSync.native(existing);
  } catch (error) {
    // 基路径不可规范化时保留原样；后续比较失败即拒绝，不得放行。
  }
  return path.join(canonicalBase, ...missing.reverse());
}

function isWithinDirectory(candidate, directory) {
  const relative = path.relative(directory.toLowerCase(), candidate.toLowerCase());
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function checkLiveOutputDir(rawOutputDir) {
  const raw = String(rawOutputDir || "").trim();
  if (!raw) {
    return failLiveBenchmark("LIVE_BENCHMARK_OUTPUT_DIR_REQUIRED", `实时基准需要显式输出目录（--output-dir 或 ${LIVE_BENCHMARK_OUTPUT_ENV}）。`);
  }
  const resolved = canonicalizeExisting(raw);
  const rootCanonical = canonicalizeExisting(root);
  const homeCanonical = canonicalizeExisting(os.homedir());
  const tmpCanonical = canonicalizeExisting(os.tmpdir());
  const segments = resolved.toLowerCase().split(path.sep);
  if (isWithinDirectory(resolved, rootCanonical)
    || isWithinDirectory(resolved, homeCanonical)
    || isWithinDirectory(resolved, tmpCanonical)
    || segments.includes(".runtime")
    || segments[segments.length - 1] === "data") {
    return failLiveBenchmark("LIVE_BENCHMARK_OUTPUT_DIR_FORBIDDEN", "实时基准输出目录不得位于仓库、默认用户目录、系统临时目录、.runtime 或 data 目录。");
  }
  return { ok: true, resolved };
}

function validateLiveBenchmarkRequest(options, env, provider) {
  const opts = options || {};
  const environ = env || {};
  if (opts.live !== true) {
    return failLiveBenchmark("LIVE_BENCHMARK_FLAG_REQUIRED", "实时基准必须显式携带 --live 请求标记。");
  }
  if (environ[LIVE_BENCHMARK_ENV] !== "YES") {
    return failLiveBenchmark("LIVE_BENCHMARK_NOT_AUTHORIZED", `实时基准需要 ${LIVE_BENCHMARK_ENV}=YES 的逐次授权。`);
  }
  const fixtureCheck = checkLiveFixturePaths({
    profilePath: opts.profilePath || LIVE_PROFILE_FIXTURE,
    resumeVersionsPath: opts.resumeVersionsPath || LIVE_RESUME_VERSIONS_FIXTURE
  });
  if (!fixtureCheck.ok) return fixtureCheck;
  const outputCheck = checkLiveOutputDir(opts.outputDir || environ[LIVE_BENCHMARK_OUTPUT_ENV]);
  if (!outputCheck.ok) return outputCheck;
  const commitCheck = checkLiveEvaluatedCommit(
    opts.evaluatedCommit || environ[LIVE_BENCHMARK_EVALUATED_COMMIT_ENV],
    opts.actualCommit
  );
  if (!commitCheck.ok) return commitCheck;
  if (opts.worktreeClean !== true) {
    return failLiveBenchmark("LIVE_BENCHMARK_WORKTREE_DIRTY", "实时基准只允许在无未提交改动的干净 worktree 运行，避免结果冒充某个 HEAD。");
  }
  if (typeof provider !== "function") {
    return failLiveBenchmark("LIVE_BENCHMARK_PROVIDER_REQUIRED", "实时基准要求 provider 以纯函数注入。");
  }
  const descriptor = provider();
  if (!descriptor || typeof descriptor.provider !== "string" || !descriptor.provider || descriptor.provider === "mock") {
    return failLiveBenchmark("LIVE_BENCHMARK_REAL_MODEL_REQUIRED", "实时基准需要非 mock 的真实模型配置，不得回退成 mock 宣称通过。");
  }
  return {
    ok: true,
    code: "OK",
    request: {
      runMode: "live",
      authorizationGatePassed: true,
      benchmarkHarnessVersion: BENCHMARK_HARNESS_VERSION,
      profilePath: fixtureCheck.resolved.profilePath,
      resumeVersionsPath: fixtureCheck.resolved.resumeVersionsPath,
      outputDir: outputCheck.resolved,
      evaluatedCommit: commitCheck.resolved
    }
  };
}

function checkLiveEvaluatedCommit(requestedCommit, actualCommit) {
  const actual = commitId(actualCommit);
  if (!actual || actual.length !== 40) {
    return failLiveBenchmark("LIVE_BENCHMARK_GIT_HEAD_REQUIRED", "实时基准必须先读取当前 checkout 的完整 git HEAD，无法确认实际提交时禁止运行。");
  }
  const requested = String(requestedCommit || "").trim();
  if (requested && commitId(requested) !== actual) {
    return failLiveBenchmark("LIVE_BENCHMARK_COMMIT_MISMATCH", `声明的 evaluatedCommit 与当前实际 HEAD 不一致（actual=${actual}）。`);
  }
  return { ok: true, resolved: actual };
}

function parseLiveArgs(argv) {
  const options = { outputDir: "", evaluatedCommit: "", baselineBehaviorCommit: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--live") continue;
    if (arg === "--output-dir" || arg === "--evaluated-commit" || arg === "--baseline-commit") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} 缺少取值`);
      if (arg === "--output-dir") options.outputDir = value;
      if (arg === "--evaluated-commit") options.evaluatedCommit = value;
      if (arg === "--baseline-commit") options.baselineBehaviorCommit = value;
      index += 1;
      continue;
    }
    throw new Error(`未知实时基准参数：${arg}`);
  }
  return options;
}

function tryGitHead() {
  try {
    const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
    if (result.status === 0) return String(result.stdout).trim();
  } catch (error) {
    // 无法确认当前提交时由 live 身份门禁安全拒绝。
  }
  return "";
}

function isGitWorktreeClean() {
  try {
    const result = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
    return result.status === 0 && !String(result.stdout || "").trim();
  } catch (error) {
    return false;
  }
}

function assertLiveFailureBranchesOffline() {
  const externalOutput = path.join("D:\\DevData", "RoleFlow-benchmark", `subprocess-${process.pid}`);
  const branchEnv = (extra) => {
    const env = { ...process.env, [LIVE_BENCHMARK_CHILD_ENV]: "1", ...extra };
    delete env[LIVE_BENCHMARK_OUTPUT_ENV];
    if (!extra || !extra[LIVE_BENCHMARK_ENV]) delete env[LIVE_BENCHMARK_ENV];
    return env;
  };
  const authorized = { [LIVE_BENCHMARK_ENV]: "YES" };
  // 只保留能在 provider 解析之前失败的子进程分支：mock provider 的拒绝由
  // assertGateContractOffline 的纯函数注入用例覆盖；一旦 worktree 配置了真实
  // provider，任何携带授权且越过前三道检查的成功路径都不得出现在离线自检中。
  const branches = [
    { name: "缺授权", args: ["--live", "--output-dir", externalOutput], env: branchEnv(), code: "LIVE_BENCHMARK_NOT_AUTHORIZED" },
    { name: "缺输出目录", args: ["--live"], env: branchEnv(authorized), code: "LIVE_BENCHMARK_OUTPUT_DIR_REQUIRED" },
    { name: "危险输出目录", args: ["--live", "--output-dir", path.join(root, "data", "benchmark")], env: branchEnv(authorized), code: "LIVE_BENCHMARK_OUTPUT_DIR_FORBIDDEN" }
  ];
  for (const branch of branches) {
    const result = spawnSync(process.execPath, [__filename, ...branch.args], { encoding: "utf8", cwd: root, env: branch.env });
    const output = String(result.stdout || "") + String(result.stderr || "");
    assert.notStrictEqual(result.status, 0, `${branch.name}：--live 必须失败退出`);
    assert(output.includes(branch.code), `${branch.name}：输出必须携带门禁错误码 ${branch.code}，实际：${output.slice(0, 300)}`);
  }
  assert(!fs.existsSync(path.join(root, "data", "benchmark")), "危险输出目录分支不得创建任何目录");
  assert(!fs.existsSync(externalOutput), "失败分支不得在任何模型调用前创建输出目录");
  const offline = spawnSync(process.execPath, [__filename], { encoding: "utf8", cwd: root, env: branchEnv(authorized) });
  assert.strictEqual(offline.status, 0, "仅设置授权变量不得改变无 --live 的离线行为");
  assert(String(offline.stdout || "").includes("fixtures ok"), "离线自检必须保持原有通过输出");
}

async function runLive() {
  const cliOptions = parseLiveArgs(process.argv.slice(2));
  const actualCommit = tryGitHead();
  let resolvedModelConfig = null;
  const requestGate = validateLiveBenchmarkRequest(
    {
      live: true,
      profilePath: LIVE_PROFILE_FIXTURE,
      resumeVersionsPath: LIVE_RESUME_VERSIONS_FIXTURE,
      outputDir: cliOptions.outputDir,
      evaluatedCommit: cliOptions.evaluatedCommit,
      actualCommit,
      worktreeClean: isGitWorktreeClean()
    },
    process.env,
    () => {
      if (!resolvedModelConfig) {
        resolvedModelConfig = resolveRuntimeModelConfig({ root, fallbackModelConfig: loadConfigs(root).model }).modelConfig;
      }
      return { provider: resolvedModelConfig && resolvedModelConfig.provider };
    }
  );
  if (!requestGate.ok) {
    const error = new Error(requestGate.message);
    error.code = requestGate.code;
    throw error;
  }
  const base = loadConfigs(root, { profile: LIVE_PROFILE_FIXTURE, resumeVersions: LIVE_RESUME_VERSIONS_FIXTURE });
  if (!base.candidateProfile || base.candidateProfile.id !== LIVE_FIXTURE_PROFILE_ID) {
    const error = new Error("实时基准画像 fixture 缺失或缺少脱敏标识。");
    error.code = "LIVE_BENCHMARK_FIXTURE_MISMATCH";
    throw error;
  }
  base.model = resolvedModelConfig;
  const candidateProfile = base.candidateProfile;
  const searchPlan = benchmarkPlan(candidateProfile);
  const configs = profileToRuntimeConfigs(base, candidateProfile, searchPlan);
  const outputDir = requestGate.request.outputDir;
  fs.mkdirSync(outputDir, { recursive: true });
  const db = openDb(path.join(outputDir, "model-cache.sqlite"));
  const analyze = createJobAnalysisRunner(configs, searchPlan.keywords, { db });
  let rows = [];
  try {
    rows = await mapWithConcurrency(fixtures, 3, async (fixture) => {
      const raw = benchmarkJob(fixture);
      const scored = scoreJob(raw, configs);
      const gate = decisionState(scored);
      const analysis = gate === "ready"
        ? await analyze({ ...raw, ...scored })
        : { provider: "rule-gate", semanticStatus: "blocked", decisionSource: "hard_boundary", recommendation: "skip", fitLevel: "D", confidence: null, evidence: { jd: [fixture.description.slice(0, 120)], resume: [] } };
      const bucket = decisionBucket({ ...raw, ...scored, analysis });
      const row = {
        id: fixture.id,
        category: fixture.category,
        expectedRecommendation: fixture.expectedRecommendation,
        actualRecommendation: analysis.recommendation,
        expectedBucket: fixture.expectedBucket,
        actualBucket: bucket,
        semanticStatus: analysis.semanticStatus,
        evidenceComplete: Boolean(analysis.evidence?.jd?.length && analysis.evidence?.resume?.length),
        fitLevel: analysis.fitLevel,
        confidence: analysis.confidence,
        realRoleType: analysis.realRoleType,
        fitReasons: analysis.fitReasons || [],
        missingPoints: analysis.missingPoints || [],
        blockingGaps: analysis.blockingGaps || [],
        hiddenRisks: analysis.hiddenRisks || [],
        errorCode: analysis.errorCode || "",
        error: analysis.error || "",
        pass: bucket === fixture.expectedBucket && analysis.recommendation === fixture.expectedRecommendation
      };
      console.log(`${row.pass ? "PASS" : "FAIL"} ${fixture.id}: ${analysis.recommendation}/${bucket}`);
      return row;
    });
  } finally {
    db.close();
  }
  const passed = rows.filter((row) => row.pass).length;
  const recommendationMatches = rows.filter((row) => row.actualRecommendation === row.expectedRecommendation).length;
  const bucketMatches = rows.filter((row) => row.actualBucket === row.expectedBucket).length;
  const hardExpected = rows.filter((row) => row.expectedBucket === "not_recommended");
  const hardFalsePlacement = hardExpected.filter((row) => row.actualBucket !== "not_recommended").length;
  const primaryWithoutEvidence = rows.filter((row) => row.actualBucket === "primary" && !row.evidenceComplete).length;
  const summary = {
    runMode: "live",
    authorizationGatePassed: true,
    benchmarkHarnessVersion: BENCHMARK_HARNESS_VERSION,
    evaluatedCommit: requestGate.request.evaluatedCommit,
    baselineBehaviorCommit: cliOptions.baselineBehaviorCommit || process.env[LIVE_BENCHMARK_BASELINE_COMMIT_ENV] || null,
    fixtureProfileId: candidateProfile.id,
    evaluatedAt: new Date().toISOString(),
    total: rows.length,
    passed,
    accuracy: passed / rows.length,
    recommendationAccuracy: recommendationMatches / rows.length,
    bucketAccuracy: bucketMatches / rows.length,
    failed: rows.filter((row) => row.semanticStatus === "failed").length,
    stale: rows.filter((row) => row.semanticStatus === "stale").length,
    pending: rows.filter((row) => row.semanticStatus === "pending").length,
    partial: rows.filter((row) => row.semanticStatus === "partial").length,
    hardFalsePlacement,
    primaryWithoutEvidence,
    rows
  };
  fs.writeFileSync(path.join(outputDir, "latest.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(outputDir, "latest.md"), renderMarkdown(summary), "utf8");
  console.log(`Benchmark: ${passed}/${rows.length}; hard false placement ${hardFalsePlacement}; primary without evidence ${primaryWithoutEvidence}`);
  if (passed !== rows.length || hardFalsePlacement || primaryWithoutEvidence) process.exitCode = 1;
}

function benchmarkPlan(candidateProfile) {
  const directions = candidateProfile.candidate?.targetTitles || ["AI应用开发", "Python后端"];
  return {
    name: "人工标注集评估",
    cities: ["广州"],
    salary: { minK: 8, maxK: 20 },
    salaryMode: "wide",
    experience: ["经验不限", "0-3年", "1-3年", "3-5年（可冲）"],
    allowExperienceStretch: true,
    jobTypes: ["全职"],
    directions,
    keywords: directions.map((word) => ({ word, priority: "A", reason: "候选人目标方向" })),
    bossActiveDays: 3,
    workSchedulePreference: "prefer_double_weekend",
    excludeWords: [],
    hardExcludes: ["培训贷"]
  };
}

function benchmarkJob(fixture) {
  return {
    source: "boss",
    sourceId: `benchmark:${fixture.id}`,
    title: fixture.title,
    company: "Benchmark Corp",
    location: "广州",
    salary: fixture.id === "senior-low-salary-stretch" ? "10-16K" : "10-20K",
    experience: fixture.id === "senior-low-salary-stretch" ? "3-5年" : "1-3年",
    education: "本科",
    bossActiveText: "今日活跃",
    url: `https://www.zhipin.com/job_detail/benchmark-${fixture.id}.html`,
    tags: [],
    description: fixture.description,
    detailRequired: true,
    detailRead: true
  };
}

function renderMarkdown(summary) {
  const lines = [
    "# Job Match Benchmark",
    "",
    `- 时间：${summary.evaluatedAt}`,
    `- 模式：${summary.runMode}（授权门禁已通过）`,
    `- Harness 版本：${summary.benchmarkHarnessVersion}`,
    `- 评估提交：${summary.evaluatedCommit || "未记录"}`,
    `- 基线行为评估点：${summary.baselineBehaviorCommit || "未提供"}`,
    `- 画像 fixture：${summary.fixtureProfileId}`,
    `- 通过：${summary.passed}/${summary.total}`,
    `- recommendation/bucket 准确率：${summary.recommendationAccuracy}/${summary.bucketAccuracy}`,
    `- 失败/过期/待分析/部分：${summary.failed}/${summary.stale}/${summary.pending}/${summary.partial}`,
    `- 硬排除误放：${summary.hardFalsePlacement}`,
    `- 主投缺少双证据：${summary.primaryWithoutEvidence}`,
    "",
    "| ID | 分类 | 期望 | 实际 | 状态 |",
    "|---|---|---|---|---|"
  ];
  for (const row of summary.rows) lines.push(`| ${row.id} | ${row.category} | ${row.expectedRecommendation}/${row.expectedBucket} | ${row.actualRecommendation}/${row.actualBucket} | ${row.pass ? "PASS" : "FAIL"} |`);
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// 离线双结果比较器：只读取两份已生成的 live JSON，不调用模型、不访问网络，
// 也不要求再次设置 ALLOW_LIVE_MODEL_BENCHMARK；任一校验失败即比较失败。
// ---------------------------------------------------------------------------

const COMPARE_METRIC_FIELDS = [
  "total", "passed", "accuracy", "recommendationAccuracy", "bucketAccuracy",
  "failed", "stale", "pending", "partial", "hardFalsePlacement", "primaryWithoutEvidence"
];

function failCompare(code, message) {
  return { ok: false, code, message };
}

function commitId(value) {
  const text = String(value || "").trim();
  return /^[0-9a-f]{7,40}$/i.test(text) ? text.toLowerCase() : "";
}

function pickCompareMetrics(result) {
  return Object.fromEntries(COMPARE_METRIC_FIELDS.map((field) => [field, result[field]]));
}

// 验收门禁：结构可比较只代表两份结果能对齐，是否通过验收由以下硬性条件决定。
// 任一不满足都不得宣称候选行为达标；regressions/improvements 仅作诊断信息保留。
function acceptanceFailures(baseline, candidate) {
  const failures = [];
  for (const field of ["failed", "stale", "pending", "primaryWithoutEvidence"]) {
    if (candidate[field] !== 0) failures.push(`候选 ${field}=${candidate[field]}，验收要求为 0`);
  }
  const partialPrimary = candidate.rows.filter((row) => row && row.semanticStatus === "partial" && row.actualBucket === "primary");
  if (partialPrimary.length) {
    failures.push(`候选存在 ${partialPrimary.length} 条 semanticStatus=partial 却进入 primary 的样本：${partialPrimary.map((row) => row.id).join("、")}`);
  }
  if (candidate.recommendationAccuracy < baseline.recommendationAccuracy) {
    failures.push(`recommendationAccuracy 回退：${baseline.recommendationAccuracy} -> ${candidate.recommendationAccuracy}`);
  }
  if (candidate.bucketAccuracy < baseline.bucketAccuracy) {
    failures.push(`bucketAccuracy 回退：${baseline.bucketAccuracy} -> ${candidate.bucketAccuracy}`);
  }
  if (candidate.hardFalsePlacement > baseline.hardFalsePlacement) {
    failures.push(`hardFalsePlacement 增加：${baseline.hardFalsePlacement} -> ${candidate.hardFalsePlacement}`);
  }
  return failures;
}

function compareBenchmarkResults(baseline, candidate) {
  for (const [label, value] of [["基线", baseline], ["候选", candidate]]) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return failCompare("BENCHMARK_COMPARE_RESULT_MISSING", `缺少可比较的${label}结果 JSON。`);
    }
  }
  if (baseline.runMode !== "live" || candidate.runMode !== "live") {
    return failCompare("BENCHMARK_COMPARE_RUN_MODE", "比较只接受 runMode 均为 live 的两份真实模型结果。");
  }
  if (baseline.authorizationGatePassed !== true || candidate.authorizationGatePassed !== true) {
    return failCompare("BENCHMARK_COMPARE_GATE", "比较只接受授权门禁已通过（authorizationGatePassed=true）的结果。");
  }
  if (!baseline.benchmarkHarnessVersion || baseline.benchmarkHarnessVersion !== candidate.benchmarkHarnessVersion) {
    return failCompare("BENCHMARK_COMPARE_HARNESS_VERSION", "两份结果的 benchmarkHarnessVersion 必须一致。基线与候选必须在同一 harness 版本下产生。");
  }
  // 双跑身份门禁：两次真实运行必须对应不同提交、且使用同一份脱敏画像，否则比较没有意义。
  const baselineFixtureProfileId = String(baseline.fixtureProfileId || "").trim();
  const candidateFixtureProfileId = String(candidate.fixtureProfileId || "").trim();
  if (!baselineFixtureProfileId || !candidateFixtureProfileId) {
    return failCompare("BENCHMARK_COMPARE_FIXTURE_PROFILE", "baseline 与 candidate 都必须记录非空 fixtureProfileId，缺失说明不是完整的真实运行。");
  }
  if (baselineFixtureProfileId !== candidateFixtureProfileId) {
    return failCompare("BENCHMARK_COMPARE_FIXTURE_PROFILE", `baseline 与 candidate 的 fixtureProfileId 必须相同（${baselineFixtureProfileId} ≠ ${candidateFixtureProfileId}）：双跑必须使用同一份脱敏画像。`);
  }
  const baselineCommit = commitId(baseline.evaluatedCommit);
  const candidateCommit = commitId(candidate.evaluatedCommit);
  const mappedBaselineCommit = commitId(candidate.baselineBehaviorCommit);
  if (!baselineCommit || !candidateCommit || !mappedBaselineCommit) {
    return failCompare("BENCHMARK_COMPARE_COMMIT", "两份结果必须完整记录 evaluatedCommit 与 baselineBehaviorCommit（hex 提交标识）。");
  }
  if (baselineCommit.startsWith(candidateCommit) || candidateCommit.startsWith(baselineCommit)) {
    return failCompare("BENCHMARK_COMPARE_EVALUATED_COMMIT", "baseline 与 candidate 的 evaluatedCommit 必须明确对应两个不同提交；同一提交的长短哈希不算不同。");
  }
  if (baselineCommit !== mappedBaselineCommit) {
    return failCompare("BENCHMARK_COMPARE_COMMIT", `基线/候选对应关系错位：候选声明的 baselineBehaviorCommit=${mappedBaselineCommit}，但基线结果的 evaluatedCommit=${baselineCommit}。`);
  }
  for (const [label, value] of [["基线", baseline], ["候选", candidate]]) {
    for (const field of COMPARE_METRIC_FIELDS) {
      if (!Number.isFinite(value[field])) {
        return failCompare("BENCHMARK_COMPARE_METRICS", `${label}结果缺少数值指标字段 ${field}，不得凭部分指标宣称比较有效。`);
      }
    }
    if (!Array.isArray(value.rows)) {
      return failCompare("BENCHMARK_COMPARE_METRICS", `${label}结果缺少逐条 rows，无法核对 fixture 集合。`);
    }
  }
  const baselineIds = baseline.rows.map((row) => row && row.id).filter(Boolean).sort();
  const candidateIds = candidate.rows.map((row) => row && row.id).filter(Boolean).sort();
  if (!baselineIds.length || baselineIds.join("\n") !== candidateIds.join("\n")) {
    return failCompare("BENCHMARK_COMPARE_FIXTURE_SET", "两份结果的 fixture 集合不一致，不能比较：必须使用同一套脱敏 fixture。");
  }
  const baselineById = new Map(baseline.rows.map((row) => [row.id, row]));
  const regressions = [];
  const improvements = [];
  for (const row of candidate.rows) {
    const before = baselineById.get(row.id);
    if (!before) continue;
    if (before.pass === true && row.pass !== true) regressions.push(row.id);
    if (before.pass !== true && row.pass === true) improvements.push(row.id);
  }
  const failureReasons = acceptanceFailures(baseline, candidate);
  return {
    ok: true,
    report: {
      runMode: "offline-compare",
      benchmarkHarnessVersion: baseline.benchmarkHarnessVersion,
      baselineBehaviorCommit: baselineCommit,
      evaluatedCommit: candidateCommit,
      fixtureProfileId: candidateFixtureProfileId,
      accepted: failureReasons.length === 0,
      failureReasons,
      baseline: pickCompareMetrics(baseline),
      candidate: pickCompareMetrics(candidate),
      deltas: Object.fromEntries(COMPARE_METRIC_FIELDS.map((field) => [field, candidate[field] - baseline[field]])),
      regressions,
      improvements
    }
  };
}

function parseCompareArgs(argv) {
  const options = { baselinePath: "", candidatePath: "", reportPath: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--compare") continue;
    if (["--baseline", "--candidate", "--report"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw Object.assign(new Error(`${arg} 缺少取值`), { code: "BENCHMARK_COMPARE_ARGS" });
      if (arg === "--baseline") options.baselinePath = value;
      if (arg === "--candidate") options.candidatePath = value;
      if (arg === "--report") options.reportPath = value;
      index += 1;
      continue;
    }
    throw Object.assign(new Error(`未知比较参数：${arg}`), { code: "BENCHMARK_COMPARE_ARGS" });
  }
  if (!options.baselinePath || !options.candidatePath) {
    throw Object.assign(new Error("离线比较必须同时提供 --baseline 与 --candidate 两份结果 JSON。"), { code: "BENCHMARK_COMPARE_ARGS" });
  }
  return options;
}

function readCompareJson(filePath, label) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    throw Object.assign(new Error(`无法读取${label}结果文件：${filePath}`), { code: "BENCHMARK_COMPARE_RESULT_MISSING" });
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error(`${label}结果文件不是有效 JSON：${filePath}`), { code: "BENCHMARK_COMPARE_RESULT_MISSING" });
  }
}

function runCompareCli() {
  try {
    const options = parseCompareArgs(process.argv.slice(2));
    const baseline = readCompareJson(options.baselinePath, "基线");
    const candidate = readCompareJson(options.candidatePath, "候选");
    const result = compareBenchmarkResults(baseline, candidate);
    if (!result.ok) {
      throw Object.assign(new Error(result.message), { code: result.code });
    }
    // 结构可比较后即写出诊断报告（含 accepted:false 的失败情形），再决定是否宣告验收通过。
    if (options.reportPath) {
      fs.mkdirSync(path.dirname(path.resolve(options.reportPath)), { recursive: true });
      fs.writeFileSync(options.reportPath, JSON.stringify(result.report, null, 2) + "\n", "utf8");
      fs.writeFileSync(options.reportPath.replace(/\.json$/i, "") + ".md", renderComparisonMarkdown(result.report), "utf8");
    }
    if (!result.report.accepted) {
      throw Object.assign(
        new Error(`候选结果未通过验收门禁：${result.report.failureReasons.join("；")}`),
        { code: "BENCHMARK_COMPARE_ACCEPTANCE_FAILED" }
      );
    }
    const { baseline: base, candidate: cand, deltas } = result.report;
    console.log(`benchmark compare ok: ${result.report.baselineBehaviorCommit} -> ${result.report.evaluatedCommit} (harness ${result.report.benchmarkHarnessVersion})`);
    console.log(`accuracy ${base.accuracy} -> ${cand.accuracy} (delta ${deltas.accuracy}); hardFalsePlacement ${base.hardFalsePlacement} -> ${cand.hardFalsePlacement}; primaryWithoutEvidence ${base.primaryWithoutEvidence} -> ${cand.primaryWithoutEvidence}`);
    console.log(`regressions: ${result.report.regressions.length ? result.report.regressions.join(", ") : "none"}; improvements: ${result.report.improvements.length ? result.report.improvements.join(", ") : "none"}`);
  } catch (error) {
    const prefix = error && error.code ? `[${error.code}] ` : "";
    console.error(prefix + (error.stack || error.message));
    process.exitCode = 1;
  }
}

function renderComparisonMarkdown(report) {
  const metricRows = COMPARE_METRIC_FIELDS.map((field) => `| ${field} | ${report.baseline[field]} | ${report.candidate[field]} | ${report.deltas[field]} |`);
  return [
    "# Job Match Benchmark 双结果比较",
    "",
    `- 模式：${report.runMode}（离线比较，不调用模型）`,
    `- Harness 版本：${report.benchmarkHarnessVersion}`,
    `- 基线行为评估点 baselineBehaviorCommit：${report.baselineBehaviorCommit}`,
    `- 候选提交 evaluatedCommit：${report.evaluatedCommit}`,
    `- 脱敏画像 fixtureProfileId：${report.fixtureProfileId}`,
    `- 验收结论：${report.accepted ? "通过" : `未通过：${report.failureReasons.join("；")}`}`,
    "",
    "| 指标 | 基线 | 候选 | 差值 |",
    "|---|---|---|---|",
    ...metricRows,
    "",
    `- 回退样本：${report.regressions.length ? report.regressions.join("、") : "无"}`,
    `- 改善样本：${report.improvements.length ? report.improvements.join("、") : "无"}`,
    ""
  ].join("\n");
}

if (require.main === module) {
  if (process.argv.includes("--compare")) {
    runCompareCli();
  } else if (!process.argv.includes("--live")) {
    assertGateContractOffline();
    if (process.env[LIVE_BENCHMARK_CHILD_ENV] !== "1") assertLiveFailureBranchesOffline();
    console.log(`job_match_benchmark fixtures ok (${fixtures.length})`);
  } else {
    runLive().catch((error) => {
      const prefix = error && error.code ? `[${error.code}] ` : "";
      console.error(prefix + (error.stack || error.message));
      process.exitCode = 1;
    });
  }
}

module.exports = { BENCHMARK_HARNESS_VERSION, compareBenchmarkResults };
