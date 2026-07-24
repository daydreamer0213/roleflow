const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { loadConfigs } = require("../src/config");
const { createJobAnalysisRunner } = require("../src/core/job_analysis");
const { profileToRuntimeConfigs } = require("../src/core/search_plan");
const { openDb, decisionBucket } = require("../src/core/storage");
const { compareBenchmarkResults, BENCHMARK_HARNESS_VERSION } = require("./job_match_benchmark");

const root = path.resolve(__dirname, "..");
const benchmarkScript = path.join(root, "tests", "job_match_benchmark.js");
const fixtures = require("./fixtures/generic_evidence_matching.json");

validateGenericFixtures();

(async () => {
  const db = openDb(":memory:");
  try {
    for (const fixture of fixtures) {
      await runGenericFixture(db, fixture);
    }
    comparatorSmoke();
    compareCliSmoke();
    console.log(`generic_evidence_matching_smoke ok (${fixtures.length} samples)`);
  } finally {
    db.close();
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

function validateGenericFixtures() {
  assert.strictEqual(fixtures.length, 6, "通用验收集必须恰好六个样本");
  assert.strictEqual(new Set(fixtures.map((item) => item.id)).size, 6, "样本 ID 必须唯一");
  for (const required of ["ecommerce-core-match", "ecommerce-wishlist-sprawl", "content-to-user-transfer", "user-ops-vs-pure-sales", "insufficient-evidence", "java-core-missing"]) {
    assert(fixtures.some((item) => item.id === required), `缺少验收样本 ${required}`);
  }
  for (const fixture of fixtures) {
    assert(fixture.candidateProfile?.candidate?.targetTitles?.length, `${fixture.id} 缺少候选人事实`);
    assert(fixture.matchingCard?.targetDirections?.length && Array.isArray(fixture.matchingCard?.strongEvidence), `${fixture.id} 缺少匹配偏好卡`);
    assert(fixture.searchPlan?.directions?.length, `${fixture.id} 缺少搜索方案`);
    assert(fixture.job?.title && fixture.job?.description?.length >= 40, `${fixture.id} 缺少完整 JD`);
    assert(Array.isArray(fixture.jobUnderstanding?.coreRequirements), `${fixture.id} 缺少假模型 JobUnderstanding`);
    assert(fixture.matchDecision?.recommendation && fixture.matchDecision?.evidence, `${fixture.id} 缺少假模型 MatchDecision`);
    assert(fixture.expected?.recommendation && fixture.expected?.bucket, `${fixture.id} 缺少唯一预期`);
  }
}

async function runGenericFixture(db, fixture) {
  const analyzer = {
    understandJob: async (input) => {
      assert(input.job, "understandJob 输入仍应只有 JD facts");
      assert.strictEqual(input.candidateProfile, undefined, "understandJob 不得读取候选人画像");
      assert.strictEqual(input.candidateMatchCard, undefined, "understandJob 不得读取匹配卡");
      return { jobId: input.job.sourceId, ...fixture.jobUnderstanding };
    },
    matchJob: async (input) => {
      assert(input.candidateMatchCard, "matchJob 输入必须携带匹配偏好卡");
      assert.deepStrictEqual(input.candidateMatchCard.targetDirections, fixture.matchingCard.targetDirections);
      return fixture.matchDecision;
    }
  };
  const configs = profileToRuntimeConfigs(loadConfigs(root), fixture.candidateProfile, fixture.searchPlan, [], fixture.matchingCard);
  const job = {
    source: "boss",
    sourceId: fixture.id,
    title: fixture.job.title,
    company: "Fixture Corp",
    location: "广州",
    salary: fixture.job.salary || "",
    experience: fixture.job.experience || "",
    education: "本科",
    bossActiveText: "今日活跃",
    url: `https://www.zhipin.com/job_detail/${fixture.id}.html`,
    tags: fixture.job.tags || [],
    description: fixture.job.description,
    detailRead: true,
    detailRequired: true,
    qualityTags: [],
    risks: []
  };
  const result = await createJobAnalysisRunner(configs, [], { db, analyzer })(job);
  const expected = fixture.expected;
  assert.strictEqual(result.semanticStatus, "complete", `${fixture.id} 应保持完整语义状态`);
  assert.strictEqual(result.recommendation, expected.recommendation, `${fixture.id} recommendation 不符`);
  if (expected.jobQualityLevel) {
    assert.strictEqual(result.jobQuality?.level, expected.jobQualityLevel, `${fixture.id} jobQuality 不符`);
  }
  if (["apply", "caution", "skip"].includes(result.recommendation)) {
    assert(result.evidence?.jd?.[0], `${fixture.id} 缺少 JD 证据`);
    assert(result.evidence?.resume?.[0], `${fixture.id} 缺少候选人证据`);
  }
  if (expected.concernType) {
    assert((result.jobQuality?.concerns || []).some((concern) => concern.type === expected.concernType), `${fixture.id} 缺少 ${expected.concernType} 质量关注`);
  }
  if (expected.minTransferable) {
    const transferable = (result.requirementMatches || []).filter((item) => item.state === "transferable").length;
    assert(transferable >= expected.minTransferable, `${fixture.id} 至少需要 ${expected.minTransferable} 项 transferable`);
  }
  if (expected.hardBlockerKind) {
    assert.strictEqual(result.hardBlockers?.[0]?.kind, expected.hardBlockerKind, `${fixture.id} hardBlocker kind 不符`);
    assert(result.hardBlockers[0].jdEvidence && result.hardBlockers[0].resumeEvidence, `${fixture.id} hardBlocker 必须具备双侧证据`);
  }
  if (expected.requireUnknown) {
    const hasUnknown = (result.requirementMatches || []).some((item) => item.state === "unknown");
    const hasPendingReason = [...(result.softGaps || []), ...(result.questionsToVerify || [])]
      .some((item) => /待确认|未说明|无法确认|缺少/.test(item));
    assert(hasUnknown || hasPendingReason, `${fixture.id} review 必须带 unknown 或待确认理由`);
    assert.strictEqual(fixture.matchDecision.fitReasons.length, 0, `${fixture.id} 信息不足时假模型不得虚构匹配理由`);
  }
  const bucket = decisionBucket({ ...job, analysis: result, qualityTags: [], risks: [] });
  assert.strictEqual(bucket, expected.bucket, `${fixture.id} 分桶不符`);
  console.log(`fixture ${fixture.id} ok (${result.recommendation}/${bucket})`);
}

// ---------------------------------------------------------------------------
// 离线双结果比较器：合成 JSON 断言全部失败模式安全失败，成功路径产出完整报告。
// ---------------------------------------------------------------------------

const BASELINE_COMMIT = "fb0168afce265cf351f03e80f66d9e0f24015887";
const CANDIDATE_COMMIT = "d90adee6c16b1e6cb4a2b9a0f6b5b4b3b2b1b0c9";

function liveResult(commit, overrides = {}) {
  return {
    runMode: "live",
    authorizationGatePassed: true,
    benchmarkHarnessVersion: BENCHMARK_HARNESS_VERSION,
    evaluatedCommit: commit,
    baselineBehaviorCommit: null,
    fixtureProfileId: "fixture-profile-a",
    total: 6,
    passed: 5,
    accuracy: 5 / 6,
    recommendationAccuracy: 5 / 6,
    bucketAccuracy: 1,
    failed: 0,
    stale: 0,
    pending: 0,
    partial: 0,
    hardFalsePlacement: 0,
    primaryWithoutEvidence: 0,
    rows: [
      { id: "ecommerce-core-match", pass: true },
      { id: "ecommerce-wishlist-sprawl", pass: true },
      { id: "content-to-user-transfer", pass: true },
      { id: "user-ops-vs-pure-sales", pass: true },
      { id: "insufficient-evidence", pass: true },
      { id: "java-core-missing", pass: false }
    ],
    ...overrides
  };
}

function validResultPair() {
  const baseline = liveResult(BASELINE_COMMIT);
  const candidate = liveResult(CANDIDATE_COMMIT, {
    baselineBehaviorCommit: BASELINE_COMMIT,
    passed: 6,
    accuracy: 1,
    recommendationAccuracy: 1,
    rows: [
      { id: "ecommerce-core-match", pass: true },
      { id: "ecommerce-wishlist-sprawl", pass: true },
      { id: "content-to-user-transfer", pass: true },
      { id: "user-ops-vs-pure-sales", pass: true },
      { id: "insufficient-evidence", pass: true },
      { id: "java-core-missing", pass: true }
    ]
  });
  return { baseline, candidate };
}

function comparatorSmoke() {
  const { baseline, candidate } = validResultPair();
  const ok = compareBenchmarkResults(baseline, candidate);
  assert(ok.ok === true, "有效双结果必须通过比较校验");
  assert.strictEqual(ok.report.baselineBehaviorCommit, BASELINE_COMMIT);
  assert.strictEqual(ok.report.evaluatedCommit, CANDIDATE_COMMIT);
  assert.strictEqual(ok.report.benchmarkHarnessVersion, BENCHMARK_HARNESS_VERSION);
  assert.strictEqual(ok.report.fixtureProfileId, "fixture-profile-a", "报告必须记录双跑共用的脱敏画像标识");
  assert.deepStrictEqual(ok.report.improvements, ["java-core-missing"]);
  assert.deepStrictEqual(ok.report.regressions, []);
  for (const field of ["total", "passed", "accuracy", "recommendationAccuracy", "bucketAccuracy", "hardFalsePlacement", "primaryWithoutEvidence"]) {
    assert(Number.isFinite(ok.report.baseline[field]) && Number.isFinite(ok.report.candidate[field]), `报告必须记录全部指标：${field}`);
  }

  const failures = [
    { name: "缺基线结果", baseline: null, candidate, code: "BENCHMARK_COMPARE_RESULT_MISSING" },
    { name: "缺候选结果", baseline, candidate: null, code: "BENCHMARK_COMPARE_RESULT_MISSING" },
    { name: "基线 runMode 非 live", baseline: { ...baseline, runMode: "offline" }, candidate, code: "BENCHMARK_COMPARE_RUN_MODE" },
    { name: "候选 runMode 非 live", baseline, candidate: { ...candidate, runMode: "offline" }, code: "BENCHMARK_COMPARE_RUN_MODE" },
    { name: "基线未过授权门禁", baseline: { ...baseline, authorizationGatePassed: false }, candidate, code: "BENCHMARK_COMPARE_GATE" },
    { name: "候选未过授权门禁", baseline, candidate: { ...candidate, authorizationGatePassed: false }, code: "BENCHMARK_COMPARE_GATE" },
    { name: "harness 版本不一致", baseline, candidate: { ...candidate, benchmarkHarnessVersion: `${BENCHMARK_HARNESS_VERSION}-other` }, code: "BENCHMARK_COMPARE_HARNESS_VERSION" },
    { name: "两侧提交相同", baseline, candidate: { ...candidate, evaluatedCommit: BASELINE_COMMIT }, code: "BENCHMARK_COMPARE_EVALUATED_COMMIT" },
    { name: "同一提交的长短哈希不得伪装成不同提交", baseline, candidate: { ...candidate, evaluatedCommit: BASELINE_COMMIT.slice(0, 7) }, code: "BENCHMARK_COMPARE_EVALUATED_COMMIT" },
    { name: "缺基线 fixtureProfileId", baseline: { ...baseline, fixtureProfileId: "" }, candidate, code: "BENCHMARK_COMPARE_FIXTURE_PROFILE" },
    { name: "缺候选 fixtureProfileId", baseline, candidate: { ...candidate, fixtureProfileId: null }, code: "BENCHMARK_COMPARE_FIXTURE_PROFILE" },
    { name: "fixtureProfileId 不一致", baseline, candidate: { ...candidate, fixtureProfileId: "fixture-profile-b" }, code: "BENCHMARK_COMPARE_FIXTURE_PROFILE" },
    { name: "缺候选提交标识", baseline, candidate: { ...candidate, evaluatedCommit: "" }, code: "BENCHMARK_COMPARE_COMMIT" },
    { name: "缺基线映射标识", baseline, candidate: { ...candidate, baselineBehaviorCommit: null }, code: "BENCHMARK_COMPARE_COMMIT" },
    { name: "基线/候选错位", baseline, candidate: { ...candidate, baselineBehaviorCommit: CANDIDATE_COMMIT }, code: "BENCHMARK_COMPARE_COMMIT" },
    { name: "候选指标字段缺失", baseline, candidate: { ...candidate, accuracy: undefined }, code: "BENCHMARK_COMPARE_METRICS" },
    { name: "候选缺逐条 rows", baseline, candidate: { ...candidate, rows: undefined }, code: "BENCHMARK_COMPARE_METRICS" },
    { name: "fixture 集合不一致", baseline, candidate: { ...candidate, rows: candidate.rows.slice(1) }, code: "BENCHMARK_COMPARE_FIXTURE_SET" }
  ];
  for (const testCase of failures) {
    const result = compareBenchmarkResults(testCase.baseline, testCase.candidate);
    assert(result && result.ok === false, `${testCase.name}：比较必须安全失败`);
    assert.strictEqual(result.code, testCase.code, `${testCase.name}：错误码不符`);
    assert(typeof result.message === "string" && result.message.length > 0, `${testCase.name}：失败原因必须可定位`);
  }

  // 结构可比较 ≠ 验收通过：门禁失败必须给出 accepted=false 与可定位原因，诊断字段保留。
  assert.strictEqual(ok.report.accepted, true, "无回退的比较必须验收通过");
  assert.deepStrictEqual(ok.report.failureReasons, []);
  const acceptanceFailures = [
    { name: "候选 failed 非零", mutate: (c) => ({ ...c, failed: 1 }), reason: /failed=1/ },
    { name: "候选 stale 非零", mutate: (c) => ({ ...c, stale: 1 }), reason: /stale=1/ },
    { name: "候选 pending 非零", mutate: (c) => ({ ...c, pending: 2 }), reason: /pending=2/ },
    { name: "候选 primaryWithoutEvidence 非零", mutate: (c) => ({ ...c, primaryWithoutEvidence: 1 }), reason: /primaryWithoutEvidence=1/ },
    { name: "候选 partial 进入 primary", mutate: (c) => ({ ...c, rows: c.rows.map((row) => row.id === "ecommerce-core-match" ? { ...row, semanticStatus: "partial", actualBucket: "primary" } : row) }), reason: /partial/ },
    { name: "recommendationAccuracy 回退", mutate: (c) => ({ ...c, accuracy: 0.5, recommendationAccuracy: 0.5, bucketAccuracy: 0.5 }), reason: /recommendationAccuracy 回退/ },
    { name: "bucketAccuracy 回退", mutate: (c) => ({ ...c, bucketAccuracy: 0.5 }), reason: /bucketAccuracy 回退/ },
    { name: "hardFalsePlacement 增加", mutate: (c) => ({ ...c, hardFalsePlacement: 1 }), reason: /hardFalsePlacement 增加/ }
  ];
  for (const testCase of acceptanceFailures) {
    const result = compareBenchmarkResults(baseline, testCase.mutate(candidate));
    assert(result.ok === true, `${testCase.name}：结构仍可比较，不得伪装成结构失败`);
    assert.strictEqual(result.report.accepted, false, `${testCase.name}：验收必须失败`);
    assert(result.report.failureReasons.some((reason) => testCase.reason.test(reason)), `${testCase.name}：失败原因必须可定位：${result.report.failureReasons.join("；")}`);
  }
}

function compareCliSmoke() {
  const tmpDir = path.join(root, ".runtime", "smoke", `compare-cli-${process.pid}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const env = { ...process.env };
  delete env.ALLOW_LIVE_MODEL_BENCHMARK;
  try {
    const { baseline, candidate } = validResultPair();
    const baselinePath = path.join(tmpDir, "baseline.json");
    const candidatePath = path.join(tmpDir, "candidate.json");
    const reportPath = path.join(tmpDir, "compare-report.json");
    fs.writeFileSync(baselinePath, JSON.stringify(baseline), "utf8");
    fs.writeFileSync(candidatePath, JSON.stringify(candidate), "utf8");
    const okRun = spawnSync(process.execPath, [benchmarkScript, "--compare", "--baseline", baselinePath, "--candidate", candidatePath, "--report", reportPath], { cwd: root, encoding: "utf8", env });
    assert.strictEqual(okRun.status, 0, `有效比较必须 exit 0：${okRun.stderr}`);
    assert(String(okRun.stdout).includes("benchmark compare ok"), "成功比较必须打印交付摘要");
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.strictEqual(report.baselineBehaviorCommit, BASELINE_COMMIT);
    assert.strictEqual(report.evaluatedCommit, CANDIDATE_COMMIT);
    assert.strictEqual(report.benchmarkHarnessVersion, BENCHMARK_HARNESS_VERSION);
    assert.strictEqual(report.fixtureProfileId, "fixture-profile-a", "JSON 报告必须记录 fixtureProfileId");
    assert.strictEqual(report.accepted, true, "有效比较的报告必须记录 accepted:true");
    assert.deepStrictEqual(report.failureReasons, []);
    const reportMarkdown = fs.readFileSync(reportPath.replace(/\.json$/i, "") + ".md", "utf8");
    assert(reportMarkdown.includes("fixture-profile-a"), "Markdown 报告必须记录 fixtureProfileId");

    // 验收失败：仍写出 accepted:false 诊断报告，但非零退出、携带稳定错误码，且不得打印成功摘要。
    const rejectedCandidatePath = path.join(tmpDir, "rejected-candidate.json");
    const rejectedReportPath = path.join(tmpDir, "rejected-report.json");
    fs.writeFileSync(rejectedCandidatePath, JSON.stringify({ ...candidate, failed: 1, hardFalsePlacement: 1 }), "utf8");
    const rejectedRun = spawnSync(process.execPath, [benchmarkScript, "--compare", "--baseline", baselinePath, "--candidate", rejectedCandidatePath, "--report", rejectedReportPath], { cwd: root, encoding: "utf8", env });
    assert.notStrictEqual(rejectedRun.status, 0, "验收未通过的比较必须非零退出");
    assert(`${rejectedRun.stdout}\n${rejectedRun.stderr}`.includes("BENCHMARK_COMPARE_ACCEPTANCE_FAILED"), "验收失败输出必须携带稳定错误码");
    assert(!String(rejectedRun.stdout).includes("benchmark compare ok"), "验收失败不得打印成功摘要");
    const rejectedReport = JSON.parse(fs.readFileSync(rejectedReportPath, "utf8"));
    assert.strictEqual(rejectedReport.accepted, false, "诊断报告必须记录 accepted:false");
    assert(rejectedReport.failureReasons.length >= 2, "诊断报告必须保留全部失败原因");
    assert(fs.existsSync(rejectedReportPath.replace(/\.json$/i, "") + ".md"), "验收失败的诊断 markdown 报告必须同时产出");

    const badCandidatePath = path.join(tmpDir, "bad-candidate.json");
    const badReportPath = path.join(tmpDir, "bad-report.json");
    fs.writeFileSync(badCandidatePath, JSON.stringify({ ...candidate, runMode: "offline" }), "utf8");
    const badRun = spawnSync(process.execPath, [benchmarkScript, "--compare", "--baseline", baselinePath, "--candidate", badCandidatePath, "--report", badReportPath], { cwd: root, encoding: "utf8", env });
    assert.notStrictEqual(badRun.status, 0, "runMode 非 live 的比较必须非零退出");
    assert(`${badRun.stdout}\n${badRun.stderr}`.includes("BENCHMARK_COMPARE_RUN_MODE"), "失败输出必须携带可定位错误码");
    assert(!fs.existsSync(badReportPath), "比较失败不得写出任何报告文件");

    // 双跑身份不符：稳定非零退出，不生成任何 accepted 报告。
    const sameCommitPath = path.join(tmpDir, "same-commit-candidate.json");
    const sameCommitReportPath = path.join(tmpDir, "same-commit-report.json");
    fs.writeFileSync(sameCommitPath, JSON.stringify({ ...candidate, evaluatedCommit: BASELINE_COMMIT }), "utf8");
    const sameCommitRun = spawnSync(process.execPath, [benchmarkScript, "--compare", "--baseline", baselinePath, "--candidate", sameCommitPath, "--report", sameCommitReportPath], { cwd: root, encoding: "utf8", env });
    assert.notStrictEqual(sameCommitRun.status, 0, "两侧 evaluatedCommit 相同必须非零退出");
    assert(`${sameCommitRun.stdout}\n${sameCommitRun.stderr}`.includes("BENCHMARK_COMPARE_EVALUATED_COMMIT"), "同提交失败输出必须携带可定位错误码");
    assert(!fs.existsSync(sameCommitReportPath), "身份不符不得生成 accepted 报告");

    const wrongProfilePath = path.join(tmpDir, "wrong-profile-candidate.json");
    const wrongProfileReportPath = path.join(tmpDir, "wrong-profile-report.json");
    fs.writeFileSync(wrongProfilePath, JSON.stringify({ ...candidate, fixtureProfileId: "fixture-profile-b" }), "utf8");
    const wrongProfileRun = spawnSync(process.execPath, [benchmarkScript, "--compare", "--baseline", baselinePath, "--candidate", wrongProfilePath, "--report", wrongProfileReportPath], { cwd: root, encoding: "utf8", env });
    assert.notStrictEqual(wrongProfileRun.status, 0, "fixtureProfileId 不一致必须非零退出");
    assert(`${wrongProfileRun.stdout}\n${wrongProfileRun.stderr}`.includes("BENCHMARK_COMPARE_FIXTURE_PROFILE"), "画像不一致失败输出必须携带可定位错误码");
    assert(!fs.existsSync(wrongProfileReportPath), "画像不一致不得生成 accepted 报告");

    const offlineRun = spawnSync(process.execPath, [benchmarkScript], { cwd: root, encoding: "utf8", env });
    assert.strictEqual(offlineRun.status, 0, "无 --live 的离线命令必须保持 exit 0");
    assert(String(offlineRun.stdout).includes("fixtures ok"), "无 --live 时只做离线 fixture 校验");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
