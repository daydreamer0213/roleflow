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
| 部分符合（>0，<50%） | 可投 | 可投 | 慎投 | 慎投* |
| 不符合（=0） | 慎投 | 慎投 | 不推荐 | 不推荐 |

> *不匹配但仍有核心正向证据：方向虽然不匹配，仍保留给人工审核 → 慎投。只有核心得分为 0 或命中更高优先级硬边界时才是不推荐。

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

1. 硬性阻断（hardBlocker）→ 不推荐；核心要求阻断必须同时具备模型
   `indispensable=true`、JD 明确不可协商边界、简历明确不兼容事实
2. 岗位安全风险（jobQuality.level = risk）→ 不推荐
3. 基础条件不满足（gate = blocked）→ 不推荐
4. 方向不匹配（misaligned）→ 有任意核心正向证据时慎投；核心得分为 0 时不推荐

### 二、降级修正

5. 模型置信度 < 0.62 → 正向核心证据不足时最高不超过慎投；核心符合度
   ≥ 80%、至少一条直接匹配有可核对双侧证据、且所有 JD 明确硬边界均直接
   匹配时除外。这里要求总体证据成立，不要求每条正向要求重复填写双侧证据
6. 年限偏高（experience_stretch / experience_overrange / experience_salary_overlap）→ 主投降可投
7. 存在 indispensable（硬性）要求且只有可显著推导证据 → 主投降可投

### 三、风险信号

8. hiddenRisk 中 medium / high 级别（`responsibility_sprawl` 除外）→ 最高慎投，并保留风险证据
9. jobQuality.level = risk → 不推荐

`responsibility_sprawl` 只表示 JD 职责范围偏宽，属于岗位质量提示；它本身不代表明显不匹配，因此不单独触发 `review` / `skip`。若模型同时把岗位质量判为 `caution`，仍可保留 `apply` → `caution` 的轻度提醒。

### 四、信息残缺（不参与四档判定）

10. gate = refresh → 重试抓取
11. semanticStatus = failed / stale / pending → 重试模型调用
12. semanticStatus = partial → 重试抓取完整 JD
13. 缺任一侧总证据（evidence 为空）→ 慎投并标记 `model_evidence_gap`

### 五、非核心缺口

14. 普通非核心 missing ≥ 5 条 → 降一级，但最低停在慎投，不得单独制造不推荐
15. 明确写成优先、加分项、非必须或可选的条目不计入 missing 数量
16. “优先处理”“优先级”等职责表达不得误判为可选项

## 模型与规则的边界

- 模型负责理解普通技能、行业、工具和复杂同句语义；规则不维护 Java、PMP、
  AI 或其他岗位领域词表。没有明确强弱措辞时，有限度保留模型的
  `indispensable` 判断。
- `understandJob` 与 `matchJob` 属于可复核的证据判定阶段，固定使用
  `temperature=0` 以减少同输入采样漂移；这不增加模型调用，也不承诺远端 API
  返回逐字一致。画像、沟通等生成任务继续使用各自配置。
- 规则只确定性识别跨岗位通用的明确表达，例如“仅限、不得上岗、不予录用、
  优先、非必要”。明确软条件归一为非硬门槛；能够可靠归属到单一要求、且不
  混有软条件的明确硬性或否决措辞归一为硬门槛。无法可靠拆分的复杂同句继续
  有限度保留模型判断。
- 模型的 `indispensable=true` 可以参与核心排序，但不能单独形成 `skip`。
  核心硬阻断还必须同时有 JD 明确硬边界和简历明确不兼容事实。
- `apply` / `caution` 允许少量逐项证据字段不完整，只要总体 JD 与简历证据
  可核对；完全缺少任一侧总体证据仍进入慎投和待重试。

## 已移除的旧规则

| 规则 | 原因 |
|------|------|
| 模型建议 skip 但无 hardBlocker → 改可投 | 与新表方向不匹配 → 不推荐矛盾 |
| 用 bucket 参与 benchmark pass | pass 只比较 recommendation |
| 信息残缺 → 直接给慎投 | 改为标记待重试 |

`primary / talk / backup` bucket 仍作为运行时展示与工作流安全上限保留，但不属于
模型验收的 pass 判据。

## 主工作方向边界（2026-08-01）

- `partially_aligned` 只表示相邻职业方向，并且简历对岗位主要交付中的实质部分有直接证据。它仍进入人工复核/备选，不因少量缺口自动排除。
- `misaligned` 表示岗位的主要工作对象、主要动作或主要交付与候选方向不同；共同工具、技术栈、行业、通用能力或次要职责不能把它抬升为相邻岗位。
- 完整语义分析给出 `misaligned` 时，判定矩阵返回 `skip`，最终桶为 `not_recommended`。这不是学历、薪资等资格硬门槛，而是“明显不合适岗位应被排除”的产品边界。
- 匹配提示词已删除成串的 AI、前端、ERP、数据平台等 IT 专例，改为职业无关的“主工作对象/动作/交付”定义。没有增加模型字段、模型调用或重试；`matchJob` 缓存版本升级为 `match-decision-v36`。
- 多分支岗位若没有可派生的主线 requirement gap，`misaligned` 只能使用封闭的 `D1|work_object`、`D1|main_action` 或 `D1|deliverable` 绑定选中分支职责；非法索引、混合非法项、未知维度和超量数组都会触发契约修复。已验证的选中职责和候选主方向证据会进入统一 evidence 信封，避免零 requirement 场景被错误降回 review。
