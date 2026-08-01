---
name: roleflow-decision-matrix
description: RoleFlow 最终判定规则——根据方向匹配度 + 核心要求符合度决定四档建议
metadata:
  node_type: memory
  type: project
  originSessionId: 355f3b01-a14c-47cd-82a6-e7f1cf6dfe0c
  modified: 2026-08-01T00:00:00.000Z
---

## 判定规则表

|  | 匹配 | 大部分匹配 | 部分匹配 | 不匹配 |
|---|---|---|---|---|
| 符合（≥80%） | 主投 | 主投 | 可投 | 慎投* |
| 大部分符合（≥50%） | 主投 | 可投 | 慎投 | 慎投* |
| 部分符合（>0，<50%） | 可投 | 可投 | 慎投 | 不推荐 |
| 不符合（=0） | 慎投 | 慎投 | 不推荐 | 不推荐 |

> *不匹配 + 符合/大部分符合：方向虽然不匹配但核心技能高度对口，仍需人工审核 → 慎投。只有当不匹配且核心也大面积对不上时才是不推荐。

JD 未声明任何核心要求时不套用百分比，返回可投；核心要求存在但全部为
`unknown` 时返回慎投，等待人工复核或重新分析。

## 执行优先级

以下规则按顺序执行；强制边界和信息残缺会提前返回，其余守卫在判定表结果上降级：

1. **强制不推荐**（第 1-4 条）
2. **信息残缺**（第 10-13 条）— 不进四档，标记待重试
3. **判定表** — 方向匹配度 + 核心要求符合度 → 主投/可投/慎投/不推荐
4. **降级修正**（第 5-7 条）— 在表结果基础上向下修正

## 方向匹配度

模型 `roleAlignment` 字段：
- 匹配（aligned）
- 大部分匹配（mostly_aligned）
- 部分匹配（partially_aligned）
- 不匹配（misaligned）
- 信息不足（insufficient_evidence）— 保留机会，但不得进入主投

## 核心要求符合度

范围：`foundation === true || central === true || indispensable === true`

计算方式：直接对上得 1 分，可显著推导得 0.5 分，`unknown` 与 `missing` 均不加分。

- 符合：得分 ≥ 80%
- 大部分符合：得分 ≥ 50%
- 部分符合：得分 > 0 但 < 50%
- 不符合：得分 = 0（全无证据，多数对不上）
- 信息不足：核心要求存在，但全部为 `unknown`
- 无核心：JD 未声明核心要求，不得直接主投

参见 [[roleflow-terminology]]

## 硬性边界（优先级从高到低，覆盖表中结果）

### 一、强制不推荐

1. 硬性阻断（hardBlocker）→ 不推荐
2. 岗位安全风险（jobQuality.level = risk）→ 不推荐
3. 基础条件不满足（gate = blocked）→ 不推荐
4. 方向不匹配（misaligned）→ 最低慎投。如核心要求符合度 ≥ 50% → 慎投；如核心要求符合度 < 50% → 不推荐

### 二、降级修正

5. 模型置信度 < 0.62 → 最高不超过慎投
6. 年限偏高（experience_stretch / experience_overrange / experience_salary_overlap）→ 主投降可投
7. 存在 indispensable（硬性）要求且只有可显著推导证据 → 主投降可投

### 三、风险信号

8. hiddenRisk 中 medium / high 级别 → 最高慎投，并保留风险证据
9. jobQuality.level = risk → 不推荐

### 四、信息残缺（不参与四档判定）

10. gate = refresh → 重试抓取
11. semanticStatus = failed / stale / pending → 重试模型调用
12. semanticStatus = partial → 重试抓取完整 JD
13. 缺任一侧总证据（evidence 为空）→ 慎投并标记 `model_evidence_gap`

### 五、非核心缺口

14. 普通非核心 missing ≥ 3 条 → 降一级
15. 明确写成优先、加分项、非必须或可选的条目不计入 missing 数量
16. “优先处理”“优先级”等职责表达不得误判为可选项

## 已移除的旧规则

| 规则 | 原因 |
|------|------|
| 模型建议 skip 但无 hardBlocker → 改可投 | 与新表方向不匹配 → 不推荐矛盾 |
| 用 bucket 参与 benchmark pass | pass 只比较 recommendation |
| 信息残缺 → 直接给慎投 | 改为标记待重试 |

`primary / talk / backup` bucket 仍作为运行时展示与工作流安全上限保留，但不属于
模型验收的 pass 判据。
