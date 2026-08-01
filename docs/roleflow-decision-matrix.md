---
name: roleflow-decision-matrix
description: RoleFlow 最终判定规则——根据方向匹配度 + 核心要求符合度决定四档建议
metadata: 
  node_type: memory
  type: project
  originSessionId: 355f3b01-a14c-47cd-82a6-e7f1cf6dfe0c
  modified: 2026-07-31T10:36:36.471Z
---

## 判定规则表

|  | 匹配 | 大部分匹配 | 部分匹配 | 不匹配 |
|---|---|---|---|---|
| 符合（≥80%） | 主投 | 主投 | 慎投 | 慎投* |
| 大部分符合（≥50%） | 主投 | 可投 | 慎投 | 慎投* |
| 部分符合（>0，<50%） | 可投 | 可投 | 慎投 | 不推荐 |
| 不符合（=0） | — | — | — | 不推荐 |

> *不匹配 + 符合/大部分符合：方向虽然不匹配但核心技能高度对口，仍需人工审核 → 慎投。只有当不匹配且核心也大面积对不上时才是不推荐。

左下角空缺（匹配/大部分匹配 + 不符合）理论上不成立——方向匹配时核心要求不太可能全部对不上。

## 执行优先级

以下规则从上到下依次检查，命中即停止：

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
- 信息不足（insufficient_evidence）— 暂按部分匹配处理

## 核心要求符合度

范围：核心要求（central = 基础（foundation）∪ 硬性（indispensable，不可或缺））

计算方式：直接对上得 1 分，可显著推导得 0.5 分

- 符合：得分 ≥ 80%
- 大部分符合：得分 ≥ 50%
- 部分符合：得分 > 0 但 < 50%
- 不符合：得分 = 0（全无证据，多数对不上）

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

### 三、风险信号（不影响判定）

8. hiddenRisk 中 medium 级别 → 保留展示，不影响四档
9. hiddenRisk 中 high 级别 → 已由 jobQuality.level = risk 处理

### 四、信息残缺（不参与四档判定）

10. gate = refresh → 重试抓取
11. semanticStatus = failed / stale / pending → 重试模型调用
12. semanticStatus = partial → 重试抓取完整 JD
13. 缺证据（evidence 为空）→ 标记异常待排查

## 已移除的旧规则

| 规则 | 原因 |
|------|------|
| 模型建议 skip 但无 hardBlocker → 改可投 | 与新表方向不匹配 → 不推荐矛盾 |
| 通道上限 = 备选 → 强制慎投 | 通道策略已移除 |
| 通道上限 = 沟通 + 模型给主投 → 压可投 | 通道策略已移除 |
| 通道兜底 = 沟通 + 模型给慎投 → 升可投 | 通道策略已移除 |
| 信息残缺 → 直接给慎投 | 改为标记待重试 |
| hiddenRisk medium → 降可投 | 改为仅展示 |
