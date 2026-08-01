---
name: roleflow-terminology
description: RoleFlow 项目统一中英文术语对照，所有代码和讨论中必须使用中文，必要时英文加括号中文备注
metadata:
  node_type: memory
  type: project
  originSessionId: 355f3b01-a14c-47cd-82a6-e7f1cf6dfe0c
  modified: 2026-08-01T00:00:00.000Z
---

## 岗位要求分类

- **基础要求**（foundation）：直接支撑岗位主要交付结果的能力或经验，例如
  客户开发、账务结算、设备操作或业务系统交付
- **硬性要求**（indispensable，不可或缺）：模型判断为不可协商的要求。
  这个布尔值可以参与核心排序，但只有 JD 明确硬边界和简历明确冲突同时存在时
  才能形成硬性阻断
- **核心要求**：`foundation || central || indispensable` 任一字段为 true 即计入核心集合

## 四档建议

| 中文 | 英文 | 含义 |
|------|------|------|
| 主投 | apply | 匹配度高，直接投 |
| 可投 | caution | 可以投但要先沟通确认 |
| 慎投 | review | AI 拿不准，需要人来看 |
| 不推荐 | skip | 硬性不匹配，排除 |

## 角色匹配度（roleAlignment）

- **匹配**（aligned）：岗位方向完全匹配简历
- **大部分匹配**（mostly_aligned）：大体匹配，经验不完全对口
- **部分匹配**（partially_aligned）：部分匹配，有交叉但不完全对应
- **不匹配**（misaligned）：方向完全不同
- **信息不足**（insufficient_evidence）：JD 信息不够，AI 无法判断

## 逐条要求匹配状态（requirementMatches.state）

- **直接对上**（matched）：简历有直接证据
- **可显著推导**（transferable，可迁移）：没有直接证据，但底层能力可以紧密
  迁移到不同工具、行业或工作对象。宽泛相似、只共享一个关键词或只有通用能力
  不能算可迁移
- **对不上**（missing）：简历没有相关证据
- **未知**（unknown）：信息不足无法判断

## 核心要求符合度

计算范围：`foundation === true || central === true || indispensable === true`。

按"直接对上 + 可显著推导 × 0.5"占核心要求总数的比例；`unknown` 和 `missing`
均为 0 分：

- **符合**：得分 ≥ 80%
- **大部分符合**：得分 ≥ 50%
- **部分符合**：得分 > 0 但 < 50%
- **不符合**：得分 = 0（全无证据，多数对不上）
- **信息不足**：核心集合非空，但全部条目都是 `unknown`
- **无核心**：JD 未声明核心要求，进入可投沟通，不得直接主投

例如 5 条核心要求：2 条直接对上 + 1 条可显著推导 + 2 条对不上 → 得分 = (2 + 0.5) / 5 = 50% → 大部分符合

## 其他

- **通道**（bucket）：运行时展示与工作流安全上限，分主投（primary）、沟通（talk）、备选（backup）；benchmark pass 不比较 bucket
- **证据**（evidence）：可核对的 JD 或简历事实。正向推荐必须同时有总体 JD
  与简历证据；不要求每个正向条目重复填写同一事实
- **缺口**（gap）：核心要求对不上或可推导的情况
- **硬性阻断**（hardBlocker）：经过核实的不可沟通排除理由。核心要求阻断必须
  同时满足 `indispensable=true`、JD 有明确不可协商边界、`state=missing`，
  且简历有明确不兼容事实

## 兼容概念

- **角色证据上限**（roleEvidenceDecisionState）：不替代判定矩阵，只防止证据不足、
  partial 或明确核心缺口在展示/工作流层被提升。
