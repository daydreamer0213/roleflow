const COMPARE_METRIC_FIELDS = [
  "total", "passed", "accuracy", "recommendationAccuracy", "bucketAccuracy",
  "failed", "stale", "pending", "partial", "hardFalsePlacement",
  "falseHardExclusion", "primaryWithoutEvidence"
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

// 比较器逐行核对的全部汇总字段：任何一项与 rows 复算不一致都视为结构伪造。
const DERIVED_SUMMARY_FIELDS = [
  "total", "passed", "accuracy", "recommendationAccuracy", "bucketAccuracy",
  "failed", "stale", "pending", "partial", "primaryWithoutEvidence",
  "hardFalsePlacement", "falseHardExclusion"
];

function sameNonEmptyIdentity(baseline, candidate, field) {
  const left = String(baseline[field] || "").trim();
  const right = String(candidate[field] || "").trim();
  return Boolean(left && right && left === right);
}

function sameSha256(baseline, candidate, field) {
  const left = String(baseline[field] || "").trim().toLowerCase();
  const right = String(candidate[field] || "").trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(left) && left === right;
}

const VALID_ROW_RECOMMENDATIONS = new Set(["apply", "caution", "review", "skip"]);
// expectedBucket 只收人工 fixture 标签；actualBucket 允许 decisionBucket() 的全部运行时返回值。
const VALID_EXPECTED_BUCKETS = new Set(["primary", "talk", "backup", "not_recommended"]);
const VALID_ACTUAL_BUCKETS = new Set(["primary", "talk", "backup", "analysis_pending", "refresh", "not_recommended"]);

// 逐行指标派生：不信任任何汇总字段。rows 必须非空、row.id 非空且唯一、
// 关键字段必须是合法枚举/类型（缺失字段的 undefined===undefined 不得冒充通过）、
// row.pass 必须与 expected/actual recommendation+bucket 复算一致；
// total/passed/双准确率/语义状态计数/双证据与两类硬排除全部从这里统一产生，
// 生成端（runLive）与核对端（compare）共用同一实现，避免漂移。
function deriveBenchmarkMetrics(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    return failCompare("BENCHMARK_COMPARE_METRICS", "结果必须包含非空 rows 数组。");
  }
  const ids = new Set();
  for (const row of rows) {
    const id = String(row?.id || "").trim();
    if (!id) return failCompare("BENCHMARK_COMPARE_METRICS", "每条 row 必须有非空 id。");
    if (ids.has(id)) return failCompare("BENCHMARK_COMPARE_METRICS", `row.id 重复：${id}，fixture 集合不得被重复 ID 冒充。`);
    ids.add(id);
    if (!VALID_ROW_RECOMMENDATIONS.has(row.expectedRecommendation)
      || !VALID_ROW_RECOMMENDATIONS.has(row.actualRecommendation)) {
      return failCompare("BENCHMARK_COMPARE_METRICS", `row ${id} 的 recommendation 必须是 ${[...VALID_ROW_RECOMMENDATIONS].join("/")} 之一。`);
    }
    if (!VALID_EXPECTED_BUCKETS.has(row.expectedBucket)) {
      return failCompare("BENCHMARK_COMPARE_METRICS", `row ${id} 的 expectedBucket 必须是人工标签 ${[...VALID_EXPECTED_BUCKETS].join("/")} 之一。`);
    }
    if (!VALID_ACTUAL_BUCKETS.has(row.actualBucket)) {
      return failCompare("BENCHMARK_COMPARE_METRICS", `row ${id} 的 actualBucket 必须是运行时桶 ${[...VALID_ACTUAL_BUCKETS].join("/")} 之一。`);
    }
    if (typeof row.pass !== "boolean") {
      return failCompare("BENCHMARK_COMPARE_METRICS", `row ${id} 的 pass 必须是 boolean。`);
    }
    if (typeof row.semanticStatus !== "string" || !row.semanticStatus.trim()) {
      return failCompare("BENCHMARK_COMPARE_METRICS", `row ${id} 的 semanticStatus 必须是非空字符串。`);
    }
    if (typeof row.evidenceComplete !== "boolean") {
      return failCompare("BENCHMARK_COMPARE_METRICS", `row ${id} 的 evidenceComplete 必须是 boolean。`);
    }
    const derivedPass = row.actualRecommendation === row.expectedRecommendation && row.actualBucket === row.expectedBucket;
    if (row.pass !== derivedPass) {
      return failCompare("BENCHMARK_COMPARE_METRICS", `row ${id} 的 pass=${row.pass} 与 recommendation/bucket 复算结果 ${derivedPass} 不一致。`);
    }
  }
  const hardFalsePlacementIds = rows
    .filter((row) => row.expectedBucket === "not_recommended" && row.actualBucket !== "not_recommended")
    .map((row) => row.id)
    .sort();
  const falseHardExclusionIds = rows
    .filter((row) => row.expectedBucket !== "not_recommended" && row.actualBucket === "not_recommended")
    .map((row) => row.id)
    .sort();
  const total = rows.length;
  const passed = rows.filter((row) => row.pass === true).length;
  const recommendationMatches = rows.filter((row) => row.actualRecommendation === row.expectedRecommendation).length;
  const bucketMatches = rows.filter((row) => row.actualBucket === row.expectedBucket).length;
  return {
    ok: true,
    metrics: {
      total,
      passed,
      accuracy: passed / total,
      recommendationAccuracy: recommendationMatches / total,
      bucketAccuracy: bucketMatches / total,
      failed: rows.filter((row) => row.semanticStatus === "failed").length,
      stale: rows.filter((row) => row.semanticStatus === "stale").length,
      pending: rows.filter((row) => row.semanticStatus === "pending").length,
      partial: rows.filter((row) => row.semanticStatus === "partial").length,
      primaryWithoutEvidence: rows.filter((row) => row.actualBucket === "primary" && !row.evidenceComplete).length,
      hardFalsePlacement: hardFalsePlacementIds.length,
      hardFalsePlacementIds,
      falseHardExclusion: falseHardExclusionIds.length,
      falseHardExclusionIds
    }
  };
}

function sameIds(left, right) {
  return JSON.stringify([...(left || [])].sort()) === JSON.stringify([...(right || [])].sort());
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
  if (candidate.falseHardExclusion > baseline.falseHardExclusion) {
    failures.push(`falseHardExclusion 增加：${baseline.falseHardExclusion} -> ${candidate.falseHardExclusion}`);
  }
  const newHardFalsePlacementIds = candidate.hardFalsePlacementIds
    .filter((id) => !baseline.hardFalsePlacementIds.includes(id));
  if (newHardFalsePlacementIds.length) {
    failures.push(`新增硬排除漏拦：${newHardFalsePlacementIds.join("、")}`);
  }
  const newFalseHardExclusionIds = candidate.falseHardExclusionIds
    .filter((id) => !baseline.falseHardExclusionIds.includes(id));
  if (newFalseHardExclusionIds.length) {
    failures.push(`新增错误硬排除：${newFalseHardExclusionIds.join("、")}`);
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
  if (!sameSha256(baseline, candidate, "fixtureProfileSha256")) {
    return failCompare("BENCHMARK_COMPARE_FIXTURE_PROFILE", "两侧必须使用相同且非空的 profile SHA-256。");
  }
  if (!sameSha256(baseline, candidate, "fixtureResumeVersionsSha256")) {
    return failCompare("BENCHMARK_COMPARE_RESUME_VERSIONS", "两侧必须使用相同且非空的 resume versions SHA-256。");
  }
  if (!sameNonEmptyIdentity(baseline, candidate, "fixtureMatchingCardId")
    || !sameSha256(baseline, candidate, "fixtureMatchingCardSha256")) {
    return failCompare("BENCHMARK_COMPARE_MATCHING_CARD", "两侧必须使用相同且非空的匹配卡 ID 与 SHA-256。");
  }
  if (!sameSha256(baseline, candidate, "fixtureJobSetSha256")) {
    return failCompare("BENCHMARK_COMPARE_FIXTURE_SET", "两侧必须使用相同且非空的 JD fixture SHA-256。");
  }
  const modelFields = ["provider", "model", "timeoutMs", "endpointSha256"];
  if (!baseline.modelIdentity || !candidate.modelIdentity
    || !String(baseline.modelIdentity.provider || "")
    || !String(baseline.modelIdentity.model || "")
    || !Number.isFinite(baseline.modelIdentity.timeoutMs)
    || !/^[0-9a-f]{64}$/.test(String(baseline.modelIdentity.endpointSha256 || ""))
    || modelFields.some((field) => baseline.modelIdentity[field] !== candidate.modelIdentity[field])) {
    return failCompare("BENCHMARK_COMPARE_MODEL_IDENTITY", "两侧必须使用相同的去密钥模型身份与参数。");
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
  const derivedBySide = new Map();
  for (const [label, value] of [["基线", baseline], ["候选", candidate]]) {
    for (const field of COMPARE_METRIC_FIELDS) {
      if (!Number.isFinite(value[field])) {
        return failCompare("BENCHMARK_COMPARE_METRICS", `${label}结果缺少数值指标字段 ${field}，不得凭部分指标宣称比较有效。`);
      }
    }
    // 行级结构（非空、id 非空且唯一、pass 与复算一致）先于集合比较校验。
    const derived = deriveBenchmarkMetrics(value.rows);
    if (!derived.ok) return derived;
    derivedBySide.set(label, { value, metrics: derived.metrics });
  }
  const baselineIds = baseline.rows.map((row) => row && row.id).filter(Boolean).sort();
  const candidateIds = candidate.rows.map((row) => row && row.id).filter(Boolean).sort();
  if (!baselineIds.length || baselineIds.join("\n") !== candidateIds.join("\n")) {
    return failCompare("BENCHMARK_COMPARE_FIXTURE_SET", "两份结果的 fixture 集合不一致，不能比较：必须使用同一套脱敏 fixture。");
  }
  // 人工预期标签是 fixture 身份的一部分：candidate 不得通过改写 expected 制造满分。
  const baselineById = new Map(baseline.rows.map((row) => [row.id, row]));
  for (const row of candidate.rows) {
    const expected = baselineById.get(row.id);
    if (!expected) continue;
    if (row.expectedRecommendation !== expected.expectedRecommendation
      || row.expectedBucket !== expected.expectedBucket) {
      return failCompare(
        "BENCHMARK_COMPARE_FIXTURE_SET",
        `样本 ${row.id} 的人工预期标签在两侧不一致：candidate 不得改写 expectedRecommendation/expectedBucket。`
      );
    }
  }
  for (const [label, side] of derivedBySide) {
    // 汇总指标必须与 rows 复算完全一致。准确率为 JSON 双精度往返（精确表示），
    // 同一派生函数两端复算，使用严格相等比较，不会误伤合法结果。
    for (const field of DERIVED_SUMMARY_FIELDS) {
      if (side.value[field] !== side.metrics[field]) {
        return failCompare(
          "BENCHMARK_COMPARE_METRICS",
          `${label}汇总字段 ${field}=${side.value[field]} 与 rows 复算值 ${side.metrics[field]} 不一致。`
        );
      }
    }
    if (!sameIds(side.value.hardFalsePlacementIds, side.metrics.hardFalsePlacementIds)
      || !sameIds(side.value.falseHardExclusionIds, side.metrics.falseHardExclusionIds)) {
      return failCompare(
        "BENCHMARK_COMPARE_METRICS",
        `${label}两类硬排除 ID 与 rows 复算结果不一致。`
      );
    }
  }
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
      fixtureProfileSha256: candidate.fixtureProfileSha256,
      fixtureResumeVersionsSha256: candidate.fixtureResumeVersionsSha256,
      fixtureMatchingCardId: candidate.fixtureMatchingCardId,
      fixtureMatchingCardSha256: candidate.fixtureMatchingCardSha256,
      fixtureJobSetSha256: candidate.fixtureJobSetSha256,
      modelIdentity: candidate.modelIdentity,
      hardFalsePlacementIds: [...candidate.hardFalsePlacementIds],
      falseHardExclusionIds: [...candidate.falseHardExclusionIds],
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


module.exports = {
  COMPARE_METRIC_FIELDS,
  compareBenchmarkResults,
  deriveBenchmarkMetrics
};
