# RoleFlow 离线 shadow scorecard 效果评测

评测日期：2026-08-10

评测基线：当前 `main`（工作树在评测前已有 `main...origin/main [ahead 60]`，本次未回退或改写其他提交）

## 结论先行

当前实现证明了一个有限但有用的工具能力：在不调用模型、不访问浏览器、不打开 live SQLite 的前提下，对固定语义输入进行可复现的 scorecard replay，并把硬门槛/风险保护作为独立诊断 guardrail 记录下来。它没有证明推荐产品质量改善，也没有提供召回率、准确率、precision、recall 或校准改善证据。

不建议现在切换生产规则。当前 shadow scorecard 仍应保持离线观察工具，下一阶段先建立新空岗位历史基线和完整 JD 的可比评测集，再决定是否需要用户批准新的权重或阈值。

## 1. 评测范围与设计目标

本次只读取并复用：

- [`scripts/lib/shadow_scorecard.js`](../../../scripts/lib/shadow_scorecard.js)
- [`scripts/compare-shadow-scorecard.js`](../../../scripts/compare-shadow-scorecard.js)
- [`tests/fixtures/job_match_benchmark.json`](../../../tests/fixtures/job_match_benchmark.json)（31 个岗位夹具）
- [`tests/fixtures/generic_evidence_matching.json`](../../../tests/fixtures/generic_evidence_matching.json)（6 个 generic evidence 样例）
- shadow、four-tier、matching-card、benchmark 与设计/基线文档

没有使用或修改 live SQLite、私有简历/JD、旧岗位历史、真实 BOSS 或浏览器状态；没有修改生产规则、测试、脚本或数据。本报告是唯一写入的仓库文件。

设计目标是“旁路观察”而不是替换正式结果：记录 role alignment、responsibility、core/supporting requirement、fit、coverage、policy hash、硬边界和风险来源；使用已批准的四档 tier 做候选诊断；让同一语义输入在同一 policy 下可确定性重放；保护硬门槛和低证据覆盖，且不改变 formal recommendation、decision bucket 或默认批量选择。

## 2. 工具实现效果

### 2.1 实际复用 production `deriveMatrixDecision`

实现证据在 [`shadow_scorecard.js`](../../../scripts/lib/shadow_scorecard.js) 的第 7、17-22 行：`buildShadowScorecard` 直接把完整的 `roleAlignment`、`responsibilityMatches`、`requirementMatches` 传给生产纯函数 `deriveMatrixDecision`。第 42 行以 `productionDecision.matrixRecommendation` 作为未加 shadow guardrail 前的 candidate tier。

因此 shadow 没有复制一套简化的评分规则；它实际继承了 production decision 的 responsibility consistency、alignment consistency、zero-duty-gap / matched-indispensable promotion、foundation/duty-gap ceiling、core/coverage cap 和 approved matrix。`productionMatrixTier` 也被写入 scorecard，便于后续审计。

### 2.2 硬门槛与普通加分分离

分离是成立的，但边界要准确描述：

- 普通 fit 来自 production 的 core/supporting 加权结果、fit band 和矩阵；设计值是 core/supporting 70/30，fit band 阈值为 0.80 和 0.50。
- 低 coverage、无 declared core、unknown core、责任安全 ceiling 等是 cap/promotion 诊断；分数不能补偿证据不足。
- verified hard boundary 或 verified severe risk 在第 44-51 行强制 `not_recommended`；verified medium/high risk 在第 74-75 行最多 cap 到 `caution`。
- 这些 shadow-only boundary/risk 输入不属于 production pure decision 的三个参数，所以它们只改变 shadow candidate，不写回正式推荐。

这符合 [`2026-08-10-shadow-scorecard-design.md`](../specs/2026-08-10-shadow-scorecard-design.md) 和 [`2026-08-01-four-tier-weighted-decision-architecture-design.md`](../specs/2026-08-01-four-tier-weighted-decision-architecture-design.md) 的边界：硬阻断优先，正常候选才由 weighted fit 与 matrix 决定。

## 3. 可复现样例与 disagreement 限制

### 3.1 CLI 合法夹具样例

用 `compare-shadow-scorecard.js` 对 4 个脱敏、合成的语义输入做了可复现比较，输入只由 smoke test 已有的结构改写而来；临时输入/输出位于 `D:\DevData`，命令结束后删除。CLI 输出摘要如下：

| 样例 | production finalRecommendation（显式输入） | shadow candidateTier | 观察 |
|---|---|---|---|
| `synthetic-strong` | `primary` | `primary` | 高匹配矩阵结果保持一致 |
| `synthetic-hard-boundary` | `not_recommended` | `not_recommended` | verified hard boundary 不被高 fit 补偿 |
| `synthetic-low-coverage` | `caution` | `caution` | coverage 低于 0.60 时受 cap 保护 |
| `synthetic-zero-duty-gap` | `apply` | `apply` | 生产 zero-duty-gap promotion 路径保持一致 |

总数 4；candidate tier 分布为 `primary=1`、`apply=1`、`caution=1`、`not_recommended=1`；可比较的 finalRecommendation 为 4；tier disagreement 为 0。

这个 0 不是产品质量指标：这 4 个 `finalRecommendation` 是为验证 replay/guardrail 而显式放入合成 CLI 夹具的，且 shadow 的基础 tier 本来就调用同一个 production decision。它只能证明样例结构和 deterministic path 没有产生意外差异，不能外推准确率或召回率。

### 3.2 31 个岗位夹具和 generic evidence 的限制

`job_match_benchmark` 的 31 个夹具是岗位描述加既有 benchmark 期望/结果格式；`generic_evidence_matching` 的 6 个样例也是其自身 matching contract。它们没有统一提供 shadow CLI 所需的完整 `{ roleAlignment, responsibilityMatches, requirementMatches, boundaries, risks }` 语义输入，也没有在同一行提供可严格对齐的 production tier 与 shadow tier。

因此本次不能合法地把 31 或 6 个样例硬转换后计算 production-vs-shadow disagreement；报告明确记为“不可直接比较”，没有伪造数量。现有检查只能证明这些夹具和既有匹配/四档行为仍通过各自合同。

## 4. 阈值附近稳定性：能证明什么、不能证明什么

能证明的内容：

- 同一语义对象、同一 policy 的两次 `buildShadowScorecard` 结果深度相等，且输入不被修改。
- smoke test 覆盖了高 fit、verified hard boundary、低 coverage 和 production consistency/zero-duty-gap 路径。
- scorecard 记录 `policyVersion` 与 `policyHash`，本次合成 CLI 运行记录为 `four-tier-weighted-v4.8`，policy hash 为 `ae0b1dc5eca1bd12d9d0dffd06a20e14ee0e7b101cedf3aaf6b414e42ad48cba`。

不能证明的内容：

- 没有在 0.80、0.50 或 0.60 附近做系统性的微扰网格，所以不能报告阈值边界的敏感度、置信区间或稳定半径。
- scorecard 不调用模型；它不能证明 semantic analyzer 在重复运行时的 role alignment、match state 或 evidence 是否稳定。
- 没有真实或人工标注的独立结果，不能估计阈值是否改善用户选择、沟通转化或推荐质量。

## 5. CLI 同文件保护与输入校验

实现和 smoke test 均覆盖以下保护：

- `--input` 与 `--output` 必须同时显式提供，未知参数、缺值、重复参数都会拒绝。
- 输入必须是对象且含 `cases` 数组。
- 每个 case 必须有非空、唯一 `id`，`input` 必须是非数组对象。
- 输入/输出同路径、Windows 大小写别名、真实路径别名或同文件 identity 会拒绝，避免覆盖 fixture。
- 结果按 `id` 排序，只读取显式输入文件，只写显式输出文件；没有目录扫描、SQLite、模型、网络或浏览器调用。

本次 CLI 合成运行退出码为 0，并产生上述 4 行稳定摘要；同文件别名和非法 case 输入由 `shadow_scorecard_smoke` 直接断言通过。

## 6. 离线检查结果

以下命令均退出 0：

```text
node tests/shadow_scorecard_smoke.js
  shadow_scorecard_smoke ok
node tests/four_tier_decision_smoke.js
  four_tier_decision_smoke ok
node tests/four_tier_pipeline_smoke.js
  four_tier_pipeline_smoke ok
node tests/four_tier_product_surface_smoke.js
  four_tier_product_surface_smoke ok
node tests/four_tier_benchmark_metrics_smoke.js
  four_tier_benchmark_metrics_smoke ok
node tests/matching_card_smoke.js
  matching_card_smoke ok
node tests/job_match_benchmark.js
  job_match_benchmark fixtures ok (31)
node tests/generic_evidence_matching_smoke.js
  6 个 fixture 输出 ok；generic_evidence_matching_smoke ok
```

完整 `npm.cmd test` 未完成：`self_check.js` 之后的既有 `startup_scripts_smoke.js` 在端口 8787 发现该端口监听者属于另一个项目，因 dashboard identity check 失败而停止。这个失败发生在本次目标范围之外，未安装依赖、未启动/关闭浏览器、未修改生产文件，也不应被解释成 shadow scorecard 失败。

评测期间工作树没有出现除本报告外的目标变更；最后还会运行 `git diff --check`，并再次核对写入范围。

## 7. 当前价值与失败模式

### 当前价值

当前价值属于工具实现层：它提供了低风险、可审计、带 policy hash 的离线 replay；能把生产矩阵结果、coverage、责任/要求分组、硬边界和风险 cap 放在一个诊断对象中；能用固定输入复现 promotion、cap 与 non-compensation 行为；还能在未来接收人工标注或新基线，而不必先改生产推荐链路。

### 失败模式

按影响看，主要风险是：

1. semantic analyzer 改变 role alignment、match state 或证据文本，导致 scorecard 变化；scorecard 本身不会隔离这种语义漂移。
2. boundary/risk 被错误标记为 `verified`，会让 shadow 产生过强的 hard block 或 risk cap；当前工具不替调用方验证事实真实性。
3. incomplete JD 或 unknown core 会触发 coverage/core cap，可能使诊断结果偏保守；这是保护行为，不是 recall 改善证据。
4. 现有 benchmark fixture schema 与 scorecard semantic schema 不对齐，暂时无法做同一岗位的严格 paired disagreement。
5. policy、权重或阈值变化会改变 deterministic tier；虽有 version/hash 记录，但尚未有阈值敏感度报告或校准曲线。
6. full suite 仍可能受共享运行环境（例如端口 8787）影响；这与离线 scorecard 单元/fixture 检查是不同层面的失败。

## 8. 下一步（按影响排序）

1. 建立新的空岗位历史基线，并只用基线之后的新样本评测，避免旧岗位历史污染比较。
2. 为每个可比较岗位补齐完整 JD 以及完整、脱敏的 semantic input，建立 production tier / shadow tier 的严格 paired fixture；先解决 schema 对齐，再谈 disagreement。
3. 做重复模型分析：同一岗位/候选输入重复获得 semantic output，分离模型语义不稳定与 deterministic policy 敏感度。
4. 引入人工标签（至少包含岗位方向、硬门槛、可投/慎投/不推荐和证据充分性），形成独立质量参照。
5. 在人工标签集上报告 precision、recall、分层混淆矩阵和校准曲线；fixture-only 结果不得写成召回率或准确率改善。
6. 最后才由用户批准权重与阈值实验方案，明确变更范围、保护门槛和回滚标准；在批准前不切换生产规则。

## 最终判断

Shadow scorecard 的离线工具链当前可复现、可校验，且对硬门槛/证据不足有明确保护；但现有证据只支持“实现可行、诊断路径可审计”，不支持“推荐产品质量已经改善”。维持离线 shadow 状态，不建议现在切换生产规则。
