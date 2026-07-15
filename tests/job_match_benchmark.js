const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { loadConfigs } = require("../src/config");
const { createJobAnalysisRunner } = require("../src/core/job_analysis");
const { profileToRuntimeConfigs } = require("../src/core/search_plan");
const { scoreJob, decisionState } = require("../src/core/scoring");
const { openDb, decisionBucket } = require("../src/core/storage");
const { resolveRuntimeModelConfig } = require("../src/core/model_settings");
const { mapWithConcurrency } = require("../src/core/async_pool");

const root = path.resolve(__dirname, "..");
const fixtures = require("./fixtures/job_match_benchmark.json");

validateFixtures();
if (!process.argv.includes("--live")) {
  console.log(`job_match_benchmark fixtures ok (${fixtures.length})`);
} else {
  runLive().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

function validateFixtures() {
  assert(fixtures.length >= 30, "人工标注集至少需要 30 条");
  assert.strictEqual(new Set(fixtures.map((item) => item.id)).size, fixtures.length);
  for (const item of fixtures) {
    assert(item.title && item.description.length >= 80, `${item.id} 缺少可分析 JD`);
    assert(["apply", "caution", "review", "skip"].includes(item.expectedRecommendation), `${item.id} recommendation 无效`);
    assert(["primary", "talk", "backup", "not_recommended"].includes(item.expectedBucket), `${item.id} bucket 无效`);
    assert(item.rationale, `${item.id} 缺少人工标注理由`);
  }
}

async function runLive() {
  const base = loadConfigs(root, { profile: "profiles/guo_mingfu.json", resumeVersions: "profiles/resume_versions.json" });
  base.model = resolveRuntimeModelConfig({ root, fallbackModelConfig: base.model }).modelConfig;
  if (base.model.provider === "mock") throw new Error("实时标注集评估需要先配置真实模型。");
  const candidateProfile = base.candidateProfile;
  const searchPlan = benchmarkPlan(candidateProfile);
  const configs = profileToRuntimeConfigs(base, candidateProfile, searchPlan);
  const outputDir = path.join(root, ".runtime", "benchmark");
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
  const hardExpected = rows.filter((row) => row.expectedBucket === "not_recommended");
  const hardFalsePlacement = hardExpected.filter((row) => row.actualBucket !== "not_recommended").length;
  const primaryWithoutEvidence = rows.filter((row) => row.actualBucket === "primary" && !row.evidenceComplete).length;
  const summary = { evaluatedAt: new Date().toISOString(), total: rows.length, passed, accuracy: passed / rows.length, hardFalsePlacement, primaryWithoutEvidence, rows };
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
    `- 通过：${summary.passed}/${summary.total}`,
    `- 硬排除误放：${summary.hardFalsePlacement}`,
    `- 主投缺少双证据：${summary.primaryWithoutEvidence}`,
    "",
    "| ID | 分类 | 期望 | 实际 | 状态 |",
    "|---|---|---|---|---|"
  ];
  for (const row of summary.rows) lines.push(`| ${row.id} | ${row.category} | ${row.expectedRecommendation}/${row.expectedBucket} | ${row.actualRecommendation}/${row.actualBucket} | ${row.pass ? "PASS" : "FAIL"} |`);
  return lines.join("\n") + "\n";
}
