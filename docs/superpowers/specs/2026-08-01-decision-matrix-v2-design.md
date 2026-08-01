# 判定策略第二轮优化设计

> 日期：2026-08-01
> 基于：第一轮 20 样本验证结果分析

## 背景

新判定表（方向匹配度 × 核心要求符合度 → 四档建议）第一轮 20 样本验证结果：9/20 通过（45%）。11 个失败案例经逐条分析后，确认三类需要调整的问题：

1. 分值权重：可显著推导(transferable) 0.5 分过低，未确认(unknown) 0 分不合理
2. 判定表：`大部分匹配+符合→主投` 过于激进，`部分匹配→一律慎投` 不看核心得分
3. 信息遗漏：非核心要求大量缺失(missing)时完全没有影响最终建议

## 改动范围

两个文件、三个改动点：

### 一、分值调整（`model_contract.js` — `computeCoreRequirementScore`）

| 状态(state) | 旧分值 | 新分值 |
|------------|--------|--------|
| 直接对上(matched) | 1 | 1 |
| 可显著推导(transferable) | 0.5 | 1 |
| 未确认(unknown) | 0 | 0.5 |
| 缺证据(missing) | 0 | 0 |

等级阈值不变：符合(≥80%)、大部分符合(≥50%)、部分符合(>0)、不符合(=0)

### 二、判定表调整（`model_contract.js` — `computeDecisionFromMatrix`）

新判定表（括号内为旧值，仅标注有变化者）：

| 方向匹配度 | 符合(≥80%) | 大部分符合(≥50%) | 部分符合(>0) | 不符合(=0) |
|-----------|-----------|----------------|-------------|-----------|
| 匹配(aligned) | 主投 | 主投 | 可投 | 慎投 |
| 大部分匹配(mostly_aligned) | 可投(旧:主投) | 可投 | 慎投 | 慎投 |
| 部分匹配(partially_aligned) | 可投(旧:慎投) | 慎投 | 慎投 | 不推荐(旧:慎投) |
| 不匹配(misaligned) | 慎投 | 慎投 | 不推荐 | 不推荐 |

三个核心变化：
- `大部分匹配+符合`：主投→可投。方向没完全对上时，即使核心全中也应先沟通确认
- `部分匹配`：不再一律慎投，按核心得分分为可投/慎投/不推荐三档
- `不匹配`：不变

### 三、非核心缺口降级（`model_contract.js` 新增 + `job_analysis.js` 调用）

**新增函数 `countNonCentralMissing(requirementMatches)`：**
- 统计非核心(central !== true)条目中 state === "missing" 的数量
- 返回整数

**在 `applyRuleGuard` 中，判定表查表之后、降级修正之前，新增规则：**
- 非核心 missing ≥ 3 条 → 降一级：apply→caution, caution→review, review→skip
- 非核心 missing < 3 条 → 不影响

## 影响预测

基于第一轮 11 个失败案例的分析：

| 案例 | 旧结果 | 新预测 | 原因 |
|------|--------|--------|------|
| [2] 智能体开发 | caution | apply | transferable→1分，2/2 核心符合 |
| [6] 电商AI | apply | caution | 判定表降级 + 非核心missing=5降一级 |
| [8] AI业务 | review | caution 或 review | unknown→0.5，1/1=50%→大部分符合，方向匹配→可投 |
| [9] AI全栈 | review | review 或不推荐 | 部分匹配+部分符合→慎投，非核心missing=2不触发降级 |
| [10] 前端AI | skip | 不推荐（不变） | 不匹配+不符合→不推荐 |
| [12] Java AI | apply | review | 判定表→可投，非核心missing=3→降为慎投 |
| [13] 全栈 | caution | review | 判定表→可投，非核心missing=2不触发，低置信度降1级 |
| [14] 商科教育AI | apply | caution | 判定表降级，非核心missing=1不触发 |
| [17] 工业AI | review | skip | 部分匹配+不符合→不推荐 |
| [20] AI算法 | review | skip | 部分匹配+不符合→不推荐 |

预计通过率：15-16/20（75-80%）

## 暂缓项

- 置信度降级力度（案例[13]）：等本轮改动生效后重新评估
- 核心要求提取质量（模型侧）：需独立验证，不在此次改动范围

## 测试影响

需更新的测试文件：
- `tests/semantic_pipeline_smoke.js`：判定表测试用例需要更新新格子
- `tests/generic_evidence_matching_smoke.js`：转移/对上/未确认的分值变化可能影响已有断言
