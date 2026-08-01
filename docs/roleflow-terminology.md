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

- **基础要求**（foundation）：JD 里提到的关键能力或经验，比如"Python精通""熟悉 LangChain"
- **硬性要求**（indispensable，不可或缺）：没它就不行的要求，比如 Python 岗不会 Python
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
- **可显著推导**（transferable，可迁移）：没有直接证据，但相关能力可以显著迁移。推导关系必须紧密，比如"熟悉 LangGraph 开发 Agent"可以推导出"有 Agent 架构设计能力"。不能宽松推导（如"会用 ChatGPT"不能推导出"会训练大模型"）
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
- **证据**（evidence）：简历中对某条要求的具体证明，必须以"简历："开头引用原文
- **缺口**（gap）：核心要求对不上或可推导的情况
- **硬性阻断**（hardBlocker）：经过核实的、不可沟通的排除理由，必须是 indispensable 且 state=missing 且有明确的拒绝证据

## 兼容概念

- **角色证据上限**（roleEvidenceDecisionState）：不替代判定矩阵，只防止证据不足、
  partial 或明确核心缺口在展示/工作流层被提升。
