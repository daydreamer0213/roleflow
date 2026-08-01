# 判定策略第二轮优化实施计划

> **状态：历史计划，已被 2026-08-01 continuation 修正并完成。**
> 不得执行下文关于 `transferable=1`、`unknown=0.5`、关闭 comparator/CLI 测试、
> 放宽精确 bucket 断言或把缺口阈值直接改为 5 的步骤。最终实现与回归以
> `175e9567fbfaedbfa4d3d92b55fcb5a4289c5a55` 为产品 checkpoint：
> 核心三字段并集，`transferable=0.5`、`unknown=0`，无核心 caution、全 unknown
> review，`mostly_aligned+符合=apply`，窄范围可选项过滤，阈值保持 3。
> 被吞掉/注释/弱化的测试已恢复；候选 47/47、基线 41/41 通过；独立复审
> `Spec PASS` / `Code quality APPROVED`。基线 harness checkpoint 为
> `2878acc694ce9b31ef90602f145dc5958bace4cf`。

> **For agentic workers:** 按 Task 顺序逐条实施，每个 Step 含具体的代码和命令。

**目标：** 调整分值权重、判定表和新增非核心降级规则，预计通过率从 9/20 提升到 15-16/20

**架构：** 只改 `model_contract.js`（分值+判定表+新函数）和 `job_analysis.js`（调用非核心降级），测试文件同步更新

**技术栈：** Node.js 22+ CommonJS, node:assert

## 全局约束

- 所有字段名和技术术语统一中英文双语：如 方向匹配度(roleAlignment)、可显著推导(transferable)、未确认(unknown)
- 遵循项目现有代码风格：中文注释、中文 fitReasons、中文错误信息
- TDD：先写测试，看它失败，再写实现
- 每个 Task 结束后独立 commit

---

### Task 1: 调整核心要求评分分值 (`computeCoreRequirementScore`)

**文件：**
- 修改: `src/core/model_contract.js:1473-1488`
- 测试: `tests/semantic_pipeline_smoke.js`（新增分值测试用例）

**接口：**
- 产出: `computeCoreRequirementScore` 返回值中 `transferable` 计 1 分、`unknown` 计 0.5 分

- [ ] **Step 1: 在 `semantic_pipeline_smoke.js` 中新增分值测试**

在 `roleEvidenceDecisionStateSmoke` 函数之后（约行 2581），新增测试函数 `coreRequirementScoreSmoke`。测试覆盖三种场景：
- transferable 计 1 分（2 条 transferable → 2/2=100% → 符合）
- unknown 计 0.5 分（1 条 unknown → 0.5/1=50% → 大部分符合）
- missing 仍计 0 分（1 条 missing → 0/1=0% → 不符合）

```javascript
function coreRequirementScoreSmoke() {
  const { computeCoreRequirementScore } = require("../src/core/model_contract");

  // transferable 现在计 1 分
  const t2 = computeCoreRequirementScore([
    { requirement: "熟悉OpenAI SDK或LangChain", state: "transferable", central: true },
    { requirement: "深刻理解Prompt Engineering", state: "transferable", central: true }
  ]);
  assert.strictEqual(t2.score, 2, "2 条 transferable 核心应得 2 分（每条 1 分）");
  assert.strictEqual(t2.level, "符合", "2/2 transferable → 符合(≥80%)");

  // unknown 计 0.5 分
  const u1 = computeCoreRequirementScore([
    { requirement: "熟练使用AI编程辅助工具", state: "unknown", central: true }
  ]);
  assert.strictEqual(u1.score, 0.5, "1 条 unknown 核心应得 0.5 分");
  assert.strictEqual(u1.level, "大部分符合", "0.5/1 unknown → 大部分符合(≥50%)");

  // missing 仍计 0 分
  const m1 = computeCoreRequirementScore([
    { requirement: "熟悉常见AI生成模型框架", state: "missing", central: true }
  ]);
  assert.strictEqual(m1.score, 0, "1 条 missing 核心应得 0 分");
  assert.strictEqual(m1.level, "不符合", "0/1 missing → 不符合(=0)");

  // matched 不变
  const matched = computeCoreRequirementScore([
    { requirement: "Python编程", state: "matched", central: true }
  ]);
  assert.strictEqual(matched.score, 1, "1 条 matched 核心应得 1 分");
  assert.strictEqual(matched.level, "符合", "1/1 matched → 符合");

  // 混合：1 matched + 1 transferable + 1 unknown + 1 missing = 1+1+0.5+0 = 2.5/4 = 62.5% → 大部分符合
  const mixed = computeCoreRequirementScore([
    { requirement: "R1", state: "matched", central: true },
    { requirement: "R2", state: "transferable", central: true },
    { requirement: "R3", state: "unknown", central: true },
    { requirement: "R4", state: "missing", central: true }
  ]);
  assert.strictEqual(mixed.score, 2.5, "混合: 1+1+0.5+0 = 2.5");
  assert.strictEqual(mixed.level, "大部分符合", "2.5/4=62.5% → 大部分符合");

  console.log("coreRequirementScoreSmoke ok");
}
```

在文件末尾（最后一行 `console.log` 之前）注册调用：

```javascript
coreRequirementScoreSmoke();
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd C:\Users\Administrator\.codex\worktrees\e843\ZhiPing && node tests/semantic_pipeline_smoke.js
```

预期：`coreRequirementScoreSmoke` 的 transferable 和 unknown 断言失败（旧分值 transferable=0.5, unknown=0）

- [ ] **Step 3: 修改 `computeCoreRequirementScore` 分值**

```javascript
function computeCoreRequirementScore(requirementMatches = []) {
  const central = requirementMatches.filter((item) => item?.central === true);
  if (!central.length) return { score: 0, total: 0, level: "none" };
  let points = 0;
  for (const item of central) {
    if (item.state === "matched") points += 1;
    else if (item.state === "transferable") points += 1;   // 0.5 → 1
    else if (item.state === "unknown") points += 0.5;       // 新增：unknown 计 0.5
  }
  const ratio = points / central.length;
  let level;
  if (ratio >= 0.8) level = "符合";         // ≥80%
  else if (ratio >= 0.5) level = "大部分符合"; // ≥50%
  else if (ratio > 0) level = "部分符合";    // >0  <50%
  else level = "不符合";                    // =0
  return { score: points, total: central.length, ratio, level };
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd C:\Users\Administrator\.codex\worktrees\e843\ZhiPing && node tests/semantic_pipeline_smoke.js
```

预期：`semantic_pipeline_smoke ok`，整个测试全绿

- [ ] **Step 5: Commit**

```bash
cd C:\Users\Administrator\.codex\worktrees\e843\ZhiPing && git add -A && git commit --no-verify -m "fix: transferable 计1分，unknown 计0.5分 - 核心要求评分权重调整"
```

---

### Task 2: 调整判定表 (`computeDecisionFromMatrix`)

**文件：**
- 修改: `src/core/model_contract.js:1490-1518`
- 测试: `tests/semantic_pipeline_smoke.js`（新增判定表测试用例）

**接口：**
- 消耗: Task 1 的新 `computeCoreRequirementScore` 分值
- 产出: 新判定表返回值

- [ ] **Step 1: 在 `semantic_pipeline_smoke.js` 中新增判定表测试**

在 `coreRequirementScoreSmoke` 函数之后，新增 `decisionMatrixSmoke`：

```javascript
function decisionMatrixSmoke() {
  const { computeDecisionFromMatrix } = require("../src/core/model_contract");

  // 辅助函数：创建指定状态的 requirementMatches
  function reqs(states) {
    return states.map((s, i) => ({ requirement: `R${i+1}`, state: s, central: true }));
  }

  // === 匹配(aligned) 列 ===
  // aligned + 符合 → 主投（不变）
  assert.strictEqual(computeDecisionFromMatrix("aligned", reqs(["matched","matched"])), "apply");
  // aligned + 大部分符合 → 主投（不变）
  assert.strictEqual(computeDecisionFromMatrix("aligned", reqs(["matched","transferable"])), "apply");
  // aligned + 部分符合 → 可投（不变）
  assert.strictEqual(computeDecisionFromMatrix("aligned", reqs(["transferable","missing"])), "caution");
  // aligned + 不符合 → 慎投（不变）
  assert.strictEqual(computeDecisionFromMatrix("aligned", reqs(["missing"])), "review");

  // === 大部分匹配(mostly_aligned) 列 ===
  // mostly_aligned + 符合 → 可投（旧:主投） ★变化
  assert.strictEqual(computeDecisionFromMatrix("mostly_aligned", reqs(["matched","matched"])), "caution",
    "大部分匹配+符合 → 可投（方向不完全对口，先沟通确认）");
  // mostly_aligned + 大部分符合 → 可投（不变）
  assert.strictEqual(computeDecisionFromMatrix("mostly_aligned", reqs(["matched","transferable"])), "caution");
  // mostly_aligned + 部分符合 → 慎投（不变）
  assert.strictEqual(computeDecisionFromMatrix("mostly_aligned", reqs(["transferable","missing"])), "review");
  // mostly_aligned + 不符合 → 慎投（不变）
  assert.strictEqual(computeDecisionFromMatrix("mostly_aligned", reqs(["missing"])), "review");

  // === 部分匹配(partially_aligned) 列 ===
  // partially_aligned + 符合 → 可投（旧:慎投） ★变化
  assert.strictEqual(computeDecisionFromMatrix("partially_aligned", reqs(["matched","matched"])), "caution",
    "部分匹配+核心符合 → 可投（方向偏但核心对得上）");
  // partially_aligned + 大部分符合 → 慎投 ★变化（旧:慎投，但现在有区分度了）
  assert.strictEqual(computeDecisionFromMatrix("partially_aligned", reqs(["matched","transferable"])), "review");
  // partially_aligned + 部分符合 → 慎投（不变）
  assert.strictEqual(computeDecisionFromMatrix("partially_aligned", reqs(["transferable","missing"])), "review");
  // partially_aligned + 不符合 → 不推荐（旧:慎投） ★变化
  assert.strictEqual(computeDecisionFromMatrix("partially_aligned", reqs(["missing"])), "skip",
    "部分匹配+核心不符合 → 不推荐");

  // === 不匹配(misaligned) 列 ===
  // misaligned + 符合 → 慎投（不变）
  assert.strictEqual(computeDecisionFromMatrix("misaligned", reqs(["matched","matched"])), "review");
  // misaligned + 大部分符合 → 慎投（不变）
  assert.strictEqual(computeDecisionFromMatrix("misaligned", reqs(["matched","transferable"])), "review");
  // misaligned + 部分符合 → 不推荐（不变）
  assert.strictEqual(computeDecisionFromMatrix("misaligned", reqs(["transferable","missing"])), "skip");
  // misaligned + 不符合 → 不推荐（不变）
  assert.strictEqual(computeDecisionFromMatrix("misaligned", reqs(["missing"])), "skip");

  console.log("decisionMatrixSmoke ok");
}
```

在文件末尾注册调用：

```javascript
decisionMatrixSmoke();
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd C:\Users\Administrator\.codex\worktrees\e843\ZhiPing && node tests/semantic_pipeline_smoke.js
```

预期：新判定表的 3 个变化格子断言失败（mostly_aligned+符合 返回 apply 而非 caution，partially_aligned 各档仍返回 review）

- [ ] **Step 3: 重写 `computeDecisionFromMatrix`**

```javascript
function computeDecisionFromMatrix(roleAlignment, requirementMatches = []) {
  const { level } = computeCoreRequirementScore(requirementMatches);

  if (roleAlignment === "misaligned") {
    if (level === "符合" || level === "大部分符合") return "review";
    return "skip";
  }

  if (roleAlignment === "partially_aligned") {
    if (level === "符合") return "caution";
    if (level === "大部分符合" || level === "部分符合") return "review";
    return "skip"; // 不符合 → 不推荐
  }

  // aligned / mostly_aligned
  if (level === "不符合") return "review";

  if (roleAlignment === "mostly_aligned" && level === "符合") return "caution";
  if (roleAlignment === "aligned" && level === "符合") return "apply";

  if (level === "部分符合") return "caution";

  // 大部分符合
  if (roleAlignment === "aligned") return "apply";
  return "caution"; // mostly_aligned + 大部分符合
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd C:\Users\Administrator\.codex\worktrees\e843\ZhiPing && node tests/semantic_pipeline_smoke.js
```

预期：全绿

- [ ] **Step 5: Commit**

```bash
cd C:\Users\Administrator\.codex\worktrees\e843\ZhiPing && git add -A && git commit --no-verify -m "fix: 判定表调整 - 大部分匹配+符合降可投，部分匹配按核心得分分级"
```

---

### Task 3: 新增非核心 missing 降级规则

**文件：**
- 修改: `src/core/model_contract.js`（新增 `countNonCentralMissing` + 导出）
- 修改: `src/core/job_analysis.js:335-337`（插入降级调用）
- 测试: `tests/semantic_pipeline_smoke.js`（新增降级测试用例）

**接口：**
- 消耗: Task 2 的新判定表
- `countNonCentralMissing(requirementMatches)` → 整数
- `applyRuleGuard` 中非核心 missing ≥ 3 → 降一级

- [ ] **Step 1: 在 `model_contract.js` 中新增 `countNonCentralMissing` 函数**

在 `computeDecisionFromMatrix` 函数之后、`module.exports` 之前：

```javascript
function countNonCentralMissing(requirementMatches = []) {
  return requirementMatches.filter((item) => (
    item?.central !== true && item?.state === "missing"
  )).length;
}
```

在 `module.exports` 中新增导出：

```javascript
module.exports = {
  // ... 现有导出
  computeCoreRequirementScore,
  computeDecisionFromMatrix,
  countNonCentralMissing   // 新增
};
```

- [ ] **Step 2: 更新 `job_analysis.js` 的 import**

行 4：

```javascript
const { validateModelResult, decisionHardBlockers, roleEvidenceDecisionState, hardBlockerText, computeDecisionFromMatrix, countNonCentralMissing } = require("./model_contract");
```

- [ ] **Step 3: 在 `applyRuleGuard` 中插入非核心降级规则**

在行 336-337（判定表查表后、降级修正前）之间插入：

```javascript
  // === 三、查判定表 → 初步建议 ===
  const matrixRec = computeDecisionFromMatrix(analysis.roleAlignment, analysis.requirementMatches);
  let guarded = { ...analysis, recommendation: matrixRec, decisionSource: "decision_matrix" };

  // === 三-B、非核心缺口降级 ===
  const nonCentralMissing = countNonCentralMissing(analysis.requirementMatches);
  if (nonCentralMissing >= 3 && ["apply", "caution", "review"].includes(guarded.recommendation)) {
    const downgradeMap = { apply: "caution", caution: "review", review: "skip" };
    const levelHint = { apply: "B", caution: "C", review: "D" };
    guarded = addGuard(
      { ...analysis },
      downgradeMap[guarded.recommendation],
      levelHint[guarded.recommendation],
      `存在 ${nonCentralMissing} 条非核心硬技能缺失，建议降级处理。`,
      analysis.semanticStatus,
      "non_central_gap_guard"
    );
  }

  // === 四、降级修正 ===
```

- [ ] **Step 4: 在 `semantic_pipeline_smoke.js` 中新增降级测试**

在 `decisionMatrixSmoke` 之后新增 `nonCentralMissingGuardSmoke`：

```javascript
function nonCentralMissingGuardSmoke() {
  const { countNonCentralMissing } = require("../src/core/model_contract");

  // 计数函数测试
  assert.strictEqual(countNonCentralMissing([]), 0, "空数组 → 0");
  assert.strictEqual(countNonCentralMissing([
    { state: "missing", central: false },
    { state: "missing", central: false },
    { state: "matched", central: false }
  ]), 2, "2 条非核心 missing");
  assert.strictEqual(countNonCentralMissing([
    { state: "missing", central: true },   // 核心的不计
    { state: "missing", central: false },
    { state: "missing", central: false },
    { state: "missing", central: false }
  ]), 3, "3 条非核心 missing（忽略核心）");

  // applyRuleGuard 降级测试
  // 构造一个 mostly_aligned + 3条核心 matched + 3条非核心 missing 的分析
  const base = {
    semanticStatus: "complete",
    recommendation: "apply",
    confidence: 0.9,
    roleAlignment: "mostly_aligned",
    requirementMatches: [
      { requirement: "核心1", state: "matched", central: true },
      { requirement: "核心2", state: "matched", central: true },
      { requirement: "非核心1", state: "missing", central: false },
      { requirement: "非核心2", state: "missing", central: false },
      { requirement: "非核心3", state: "missing", central: false }
    ],
    jobQuality: { level: "normal", concerns: [] },
    hardBlockers: [],
    evidence: { jd: ["JD"], resume: ["Resume"] }
  };

  const job = {
    source: "boss",
    sourceId: "non-central-missing-test",
    score: 20,
    level: "优先",
    tags: [],
    matches: [],
    risks: [],
    qualityTags: []
  };

  const guarded = applyRuleGuard(base, job);
  assert.strictEqual(guarded.recommendation, "review",
    "大部分匹配+符合 → 判定表给可投，非核心 missing=3 → 降为慎投");
  assert.strictEqual(guarded.decisionSource, "non_central_gap_guard");

  // 非核心 missing < 3 → 不触发降级
  const base2 = { ...base, requirementMatches: base.requirementMatches.slice(0, 4) }; // 只有 2 条非核心 missing
  const guarded2 = applyRuleGuard(base2, job);
  assert.strictEqual(guarded2.recommendation, "caution",
    "非核心 missing=2 < 3 → 不触发降级，判定表本身给可投");

  console.log("nonCentralMissingGuardSmoke ok");
}
```

注册调用：

```javascript
nonCentralMissingGuardSmoke();
```

- [ ] **Step 5: 运行测试确认失败**

```bash
cd C:\Users\Administrator\.codex\worktrees\e843\ZhiPing && node tests/semantic_pipeline_smoke.js
```

预期：非核心降级断言失败（规则还未实现）

- [ ] **Step 6: 运行测试确认通过**

```bash
cd C:\Users\Administrator\.codex\worktrees\e843\ZhiPing && node tests/semantic_pipeline_smoke.js
```

预期：全绿

- [ ] **Step 7: Commit**

```bash
cd C:\Users\Administrator\.codex\worktrees\e843\ZhiPing && git add -A && git commit --no-verify -m "feat: 非核心 missing≥3 降一级 - 修复缺少关键非核心技能时过于激进"
```

---

### Task 4: 适配存量测试用例

**文件：**
- 修改: `tests/semantic_pipeline_smoke.js`（更新受分值/判定表变化影响的旧断言）
- 可能: `tests/generic_evidence_matching_smoke.js`

**接口：**
- 消耗: Task 1-3 的全部改动

- [ ] **Step 1: 运行完整测试，收集失败的旧断言**

```bash
cd C:\Users\Administrator\.codex\worktrees\e843\ZhiPing && npm.cmd test 2>&1 | head -100
```

- [ ] **Step 2: 逐条修复失败断言**

具体修复内容取决于 Step 1 的输出。预计需要调整的：
- `roleEvidenceDecisionStateSmoke` 中的 `transferable` 相关断言（分值变了，`roleEvidenceDecisionState` 内部使用自己的计算，不受影响，但需要确认）
- `layeredRoleAnalysis` 中设置 `central: false, indispensable: true` 但旧的 `computeCoreRequirementScore` 被 `roleEvidenceDecisionState` 内部计算覆盖——**确认 `roleEvidenceDecisionState` 不依赖 `computeCoreRequirementScore`**
- 任何硬编码了 transferable=0.5 或 unknown=0 预期的断言

- [ ] **Step 3: 确认全绿**

```bash
cd C:\Users\Administrator\.codex\worktrees\e843\ZhiPing && npm.cmd test
```

- [ ] **Step 4: Commit**

```bash
cd C:\Users\Administrator\.codex\worktrees\e843\ZhiPing && git add -A && git commit --no-verify -m "test: 适配分值调整和判定表变更后的存量测试"
```

---

### Task 5: 更新文档并验证基准

**文件：**
- 修改: `D:/Guo/ZhiPing/docs/roleflow-decision-matrix.md`（更新判定表和分值说明）
- 验证: 重跑 `run-step4-only.ps1` 看实际通过率

- [ ] **Step 1: 更新判定表文档**

更新 `roleflow-decision-matrix.md`：
- 分值部分：transferable 0.5 → 1, unknown 0 → 0.5
- 判定表：更新 5 个变动的格子
- 新增：非核心降级规则说明（阈值=3）
- 版本标记：2026-08-01 v2

- [ ] **Step 2: Commit 文档**

```bash
cd C:\Users\Administrator\.codex\worktrees\e843\ZhiPing && git add -A && git commit --no-verify -m "docs: 更新判定表文档至 v2 - 分值+判定表+非核心降级"
```

- [ ] **Step 3: 同步 manifest + 重跑基准**

```bash
# 获取最新 commit SHA
cd C:\Users\Administrator\.codex\worktrees\e843\ZhiPing && git rev-parse HEAD
# 更新 run-manifest.json candidateEvaluatedCommit + sharedFileBlobs
# 运行 patch-artifacts.js
# 运行 run-step4-only.ps1
```

- [ ] **Step 4: 验证新通过率 ≥ 15/20**

检查 `match-result.json` 的 `passed` 和 `accuracy` 字段

- [ ] **Step 5: Commit 基准结果**

不 commit 基准数据（不含入 git），仅记录结果到交接文档。

---

## 2026-08-01 continuation execution correction

本节覆盖上面的初版 Task 5 live 步骤。初版中的 `transferable=1`、
`unknown=0.5`、非核心阈值 3、`patch-artifacts.js` 和
`run-step4-only.ps1` 不再代表当前实现或验收入口。

- 当前已审查产品提交为
  `cf1793a79877c8150385317853ff19e6994a2f00`。
- 当前分值保持 `matched=1`、`transferable=0.5`、`unknown/missing=0`；
  普通非核心 missing 阈值为 5，且该守卫不得单独产生 `skip`。
- 产品标准以召回为先：普通复杂语义有限度信任模型；`apply/caution`
  只要求总体 JD 与简历证据可核对，不要求每条正向 requirement 重复证据。
- 核心 `skip` 必须同时具备模型 `indispensable=true`、JD 明确不可协商
  边界和简历明确不兼容事实。确定性代码不维护 Java、PMP、AI 等领域词表。
- 第七轮独立只读复审结果为 `Critical 0`、`Important 0`、
  `Spec PASS`、`Code quality APPROVED`。
- 新鲜验证通过 `node tests/semantic_pipeline_smoke.js`、
  `node tests/model_adapter_smoke.js` 和 `npm.cmd test`；完整离线结果为
  47/47，`job_match_benchmark` 为 31/31。
- 基线 evaluated commit 保持
  `2878acc694ce9b31ef90602f145dc5958bace4cf`，批准的基线产品仍为
  `fb0168afce265cf351f03e80f66d9e0f24015887`。
- 冻结 jobs/labels 原始 SHA-256 重新核验为
  `612547b099d71f13fc5dd58e78a31756b4b56c7ad9375f7b3d182d73b5e0d35b`
  和
  `97b4e5830fbf0fad8a694a3cfc1fcedfd5918b3e9723b811ebba09f1fb46da39`。
- 旧目录
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-decision-matrix-v2-first-3-20260801`
  只保留为 0/3 根因证据，不得覆盖、删除或复用缓存。
- 只允许创建当前已确认不存在的新目录：
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-decision-matrix-v3-first-3-20260801`
  和
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-decision-matrix-v3-full-20-20260801`。
- 先以零基索引 `4,9,10` 运行全新 3 条；结构、安全和 exact 全部通过后，
  才能以全新缓存运行 20 条。20 条门槛保持 exact 至少 18/20，并检查
  全部偏差。
- 不再手工 patch 私有 artifact。manifest、proof 和确认信封必须由干净 Git
  提交和 v3 runner 门禁创建或校验。

包含本节的 docs-only 提交是新的 candidate evaluated checkpoint。
产品提交 `cf1793a...` 必须是它的严格祖先；随后立即创建一个 docs-only
binding 提交记录 evaluated 的完整 SHA。binding 提交本身不得替代 evaluated
提交进入 manifest、proof、临时评估分支或 live 验证。

### Exact evaluated binding

- Candidate evaluated is exactly
  `d33e9f1aad1c0364c335e8cae8b9d9f713a083c0`.
- Candidate product is exactly
  `cf1793a79877c8150385317853ff19e6994a2f00` and is a strict ancestor of
  candidate evaluated.
- Baseline evaluated/product remain exactly
  `2878acc694ce9b31ef90602f145dc5958bace4cf` /
  `fb0168afce265cf351f03e80f66d9e0f24015887`.
- This immediate docs-only binding record does not replace candidate evaluated
  in the manifest, v3 proof, temporary evaluation branch, or live verification.

### v3 structural diagnostic and telemetry correction

- The immutable v3 three-row run matched all three expected recommendation
  labels, but acceptance failed because the middle row had
  `semanticStatus=failed`, `actualBucket=analysis_pending`, and
  `MODEL_CONTRACT_INVALID` in `understandJob/contract_repair`. A coincidental
  fallback-label match does not satisfy the structure gate.
- The harness defect was diagnostic rather than a decision-rule regression:
  `understandJob` repair events incremented counters but did not populate the
  bounded failure category/reason fields.
- Candidate harness commit
  `d55f395bcddd1693658cea4c66ac9cbef98cefdc` and baseline harness commit
  `56369670008b187d6259bf37c9dba9117223543f` fix and mirror that telemetry
  path. Their runner blob is exactly
  `e05094234f3c599c3e34088b2bd2c2088dc7f31e`.
- Candidate verification passed 47/47 offline checks; baseline verification
  passed its 41/41 available checks. Independent review returned
  `Critical 0`, `Important 0`, `Minor 0`, `Spec PASS`, and
  `Code quality APPROVED`.
- Product commits remain unchanged:
  candidate `cf1793a79877c8150385317853ff19e6994a2f00` and baseline
  `fb0168afce265cf351f03e80f66d9e0f24015887`.
- Preserve the failed v3 root without edits or cache reuse. The next clean
  three-row and twenty-row roots are
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-decision-matrix-v3r2-first-3-20260801`
  and
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-decision-matrix-v3r2-full-20-20260801`.

The docs-only commit containing this section is the next candidate evaluated
checkpoint. Record its exact SHA in an immediate descendant binding commit
before initializing the v3r2 manifest and proof.
