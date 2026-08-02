---
name: roleflow-terminology
description: RoleFlow 当前统一中英文术语
metadata:
  node_type: memory
  type: project
  originSessionId: 355f3b01-a14c-47cd-82a6-e7f1cf6dfe0c
  modified: 2026-08-01T00:00:00.000Z
---

## 四档建议

| 中文 | 代码值 | 默认沟通 | 简单解释 |
|---|---|---:|---|
| 主投 | `primary` | 是 | 最值得优先沟通 |
| 可投 | `apply` | 是 | 可以沟通，但不是最优先 |
| 慎投 | `caution` | 否 | 不完全匹配，需要人工判断 |
| 不推荐 | `not_recommended` | 否 | 明显不合适，排除 |

四档同时是最终 `recommendation` 和业务 `bucket`。技术待处理使用
`analysis_pending` 或 `refresh`，此时 `recommendation=null`，不属于四档。

## 岗位要求分类

- **核心要求**：`foundation || central || indispensable` 任一字段为 true。
- **支持要求**：不是核心、也不是明确可选项，但仍会影响岗位胜任度的要求。
- **软条件**：JD 明确写成优先、加分、非必须或可选的条件，不计入普通非核心缺口数量。
- **硬性要求**（indispensable）：岗位明确不可缺少的要求。这个字段可以参与核心计分，
  但不能单独制造硬阻断。
- **硬性阻断**（hardBlocker）：必须有合法 kind、具体 requirement、JD 明确不可协商边界、
  候选人明确不兼容事实和双侧证据，才可直接形成不推荐。

## 岗位方向（roleAlignment）

- **匹配**（aligned）：主要工作对象、动作和交付与候选方向一致。
- **大部分匹配**（mostly_aligned）：主线一致，但存在有限差异。
- **部分匹配**（partially_aligned）：相邻方向，候选人对主要交付中的实质部分有证据。
- **不匹配**（misaligned）：主要工作对象、动作或交付不同；共同工具或通用能力不能自动抬升。
- **信息不足**（insufficient_evidence）：现有信息不足以判断方向，不直接硬猜四档正向建议。

## 逐条要求状态

- **直接对上**（matched）：候选人有直接证据，计 1 分。
- **可显著推导**（transferable）：底层能力可紧密迁移，计 0.5 分。
- **对不上**（missing）：有足够信息确认缺口，计 0 分。
- **未知**（unknown）：现有信息无法确认，计 0 分，同时降低证据覆盖率。

核心集合占 70%，支持集合占 30%。符合度分为 `fit`、`mostly_fit`、`partial_fit`、
`no_fit`，最终档位查询 `docs/roleflow-decision-matrix.md` 中冻结二维表。

## 证据与技术状态

- **双侧证据**：总体结论至少包含可核对 JD 事实和候选人事实；不要求每个正向条目重复同一事实。
- **技术待重试**（needs_retry）：模型失败、缓存过期、等待分析、只有局部 JD、需要刷新、方向无法进入
  二维表或总体任一侧证据为空。技术状态不等于慎投。
- **模型 shadow 建议**：模型的整体语义建议，只用于对照，不控制最终档位。

## 偏差术语

- **严重错放**（hardFalsePlacement）：人工不推荐，实际进入主投或可投。
- **错误硬排除**（falseHardExclusion）：人工主投或可投，实际进入不推荐。
- **中度偏差**（moderateDeviation）：慎投与不推荐之间互相偏移。

## 历史只读别名

旧 `apply/caution/review/skip` recommendation 和 `primary/talk/backup` bucket 只用于读取历史结果。
新写入统一使用 `primary/apply/caution/not_recommended`，不得混写。
