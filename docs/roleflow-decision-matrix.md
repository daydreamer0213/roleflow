---
name: roleflow-decision-matrix
description: RoleFlow 当前权威四档判定规则
metadata:
  node_type: memory
  type: project
  originSessionId: 355f3b01-a14c-47cd-82a6-e7f1cf6dfe0c
  modified: 2026-08-01T00:00:00.000Z
---

## 四档建议与沟通行为

| 中文 | 代码值 | 默认批量沟通 | 含义 |
|---|---|---:|---|
| 主投 | `primary` | 是 | 方向和要求均较强，优先沟通 |
| 可投 | `apply` | 是 | 值得沟通，但存在有限缺口 |
| 慎投 | `caution` | 否 | 不完全匹配或需要人工确认 |
| 不推荐 | `not_recommended` | 否，且不可选择 | 明显不合适或命中已确认硬边界 |

`failed`、`stale`、`pending`、`partial`、`refresh` 和证据不完整属于技术状态，
不是第五档。此时 `recommendation=null`、`decisionStatus=needs_retry`，不得伪装成
慎投或不推荐。

## 冻结二维表

| 核心要求符合度 \ 岗位方向 | 匹配 `aligned` | 大部分匹配 `mostly_aligned` | 部分匹配 `partially_aligned` | 不匹配 `misaligned` |
|---|---|---|---|---|
| 符合 `fit`（>=80%） | 主投 | 主投 | 可投 | 慎投 |
| 大部分符合 `mostly_fit`（>=50%） | 主投 | 可投 | 慎投 | 慎投 |
| 部分符合 `partial_fit`（>0） | 可投 | 可投 | 慎投 | 慎投 |
| 不符合 `no_fit`（=0） | 慎投 | 慎投 | 不推荐 | 不推荐 |

这张表是当前冻结产品规则。测试阶段可以分析模型证据、代码计算和人工标签之间的
偏差，但修改表格或权重前必须先取得用户确认。

## 本地计算

1. 模型只提供岗位方向、逐条要求状态和可核对证据，不计算最终分数。
2. 核心集合是 `foundation || central || indispensable`；其余非可选要求进入支持集合。
3. `matched=1`、`transferable=0.5`、`missing=0`、`unknown=0`。
4. 核心集合权重 70%，支持集合权重 30%。只有一个集合存在时使用该集合的实际得分，
   不凭空补另一侧分数。
5. 总证据覆盖率低于 60%时，主投/可投最高封顶为慎投。
6. 核心集合全部为 `unknown` 或岗位方向为 `insufficient_evidence` 时保留机会为慎投。
7. JD 没有可识别核心要求时不得主投，最高为可投。
8. 对 `misaligned + 核心得分=0`，只有支持项具备至少 50% 匹配度、60% 证据覆盖率
   且正向项有双侧证据时才允许支持项救援；否则保持不符合。

所有参数集中在 `src/core/decision_policy.js`，报告记录策略哈希，便于以后低成本调参。

## 执行优先级

1. 本地已确认的基础边界 `gate=blocked` 直接不推荐，不依赖模型语义是否完成。
2. 显式技术失败、过期、等待、局部 JD 或刷新状态先进入待重试。
3. 完整语义结果中的合法结构化硬阻断或 `jobQuality.level=risk` 直接不推荐。
4. 其余完整结果按 70/30 得分查询冻结二维表。
5. 年限跨度、薪资跨度、核心硬要求只有可迁移证据和中高语义风险只能向下封顶，
   不能反向提升。
6. 最终总体 JD 或简历任一侧证据为空时回到待重试，不进入四档。

## 非核心缺口

- 普通非核心 `missing >= 5` 时降一级，最低停在慎投，不得单独制造不推荐。
- 含“优先、加分项、经验优先、熟悉优先、非必须、可选”等明确软条件的条目不计数。
- “优先处理、优先级”等职责表达不属于软条件，仍应正常参与分析。
- 规则只识别跨职业通用语义，不维护 Java、AI、销售或其他领域关键词表。

## 模型建议开关

`modelRecommendationMode` 当前为 `shadow`。模型可以额外输出
`modelRecommendation=primary|apply|caution|not_recommended` 供后续对照，但它不参与
本地最终档位。设为 `off` 时模型必须省略该字段。是否长期保留 shadow 建议，等单链路
和跨岗位测试稳定后再决定。

## 偏差严重度

- 严重：人工不推荐 -> 实际主投/可投；这会让明显不合适岗位进入默认沟通。
- 严重：人工主投/可投 -> 实际不推荐；这是错误硬排除。
- 中度：慎投 <-> 不推荐；两者都不会默认沟通，但机会保留程度不同，必须在报告中展示。
- 其他四档差异继续计入精确率并逐条展示。
- 正式 20 条验收至少 18/20 精确，且技术、安全、证据和两类严重偏差门禁全部满足。

## 兼容边界

新写入和新报告只使用四档代码值，`recommendation` 与业务 `bucket` 必须一致。技术桶
`analysis_pending/refresh` 必须且只能配 `recommendation=null`。历史数据只在读取时映射：

- `apply/primary -> primary`
- `caution/talk -> apply`
- `review/backup -> caution`
- `skip -> not_recommended`

兼容层不得把旧别名写回新结果，也不得让声明为 schema v2 的结果继续使用旧别名。
