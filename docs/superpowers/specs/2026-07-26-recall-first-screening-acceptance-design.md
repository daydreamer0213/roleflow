# Recall-first Screening Acceptance Design

## Goal

RoleFlow 的岗位筛选默认优先保留机会，只排除有明确证据的不合适岗位。模型仍须严格遵守 JSON、证据、资格和安全契约，但不再因为年限、愿望清单、可迁移能力、普通信息不足或推荐档位不够精确而判定整条链路失败。

## Problem

当前运行时已经把年限、加分项、愿望条件和多数不确定项作为软信号，但私有真实简历 benchmark 仍以 `apply/caution/review/skip` 与 `primary/talk/backup/not_recommended` 的逐条精确命中作为主要验收标准。

冻结的 v1 私有标签共有 20 条，其中 13 条标为 `skip/not_recommended`。安全聚合检查显示，11 条的理由主要是方向不一致或缺少直接证据，只有 2 条包含明确资格冲突。按新的产品原则，前 11 条不应仅凭“简历没有证明能做”就硬淘汰；否则 benchmark 会倒逼模型制造候选人反证。

## Product Boundary

### Always strict

- 模型输出必须符合结构化契约，不得用 Markdown 或自由文本替代机器字段。
- JD 证据与候选人证据不得编造。
- `primary` 必须具备可核对的双侧证据。
- 明确资格冲突、明确不可替代核心能力冲突、收费/违规/虚假等安全风险仍可硬排除。
- 用户明确设置的排除条件仍是硬边界。
- 模型失败、截断、待处理、缓存过期不得伪装为成功推荐。

### Recall first

- 年限差距、学历未写、行业不同、工具或平台愿望项、非核心技能缺口、可迁移能力、职责较杂和普通信息不足不得单独硬淘汰。
- 证据充分的岗位进入 `primary`。
- 有机会但不确定的岗位可进入 `talk` 或 `backup`。
- 只有有明确排除证据的岗位才进入 `not_recommended`。
- “候选人当前从事另一类工作”不能证明候选人不能承担目标工作；不得据此制造 `indispensable_core` blocker。

## Versioned Private Labels

旧 `private-real-jd-labels.v1` 文件和历史结果保持只读，不迁移、不覆盖。

新私有包使用：

```json
{
  "labelsVersion": "private-real-jd-labels.v2",
  "evaluationPolicy": "recall-first.v1",
  "userConfirmed": true,
  "confirmedAt": "ISO-8601",
  "jobsSha256": "64 lowercase hex",
  "rows": [
    {
      "id": "frozen private job id",
      "expectedDisposition": "keep",
      "expectedRecommendation": "review",
      "expectedBucket": "talk",
      "rationale": "non-empty user-reviewed rationale"
    }
  ]
}
```

`expectedDisposition` 只能是：

- `keep`：保留尝试机会。运行结果为 `primary`、`talk` 或 `backup` 都满足召回目标。
- `exclude`：有明确证据应排除。运行结果必须为 `not_recommended`。

`expectedRecommendation` 与 `expectedBucket` 继续保留，用于诊断模型落在哪一档；它们不再决定 recall-first 门禁是否通过。

为保持现有逐行防伪指标与 v2 处置语义一致，v2 还必须满足：

- `expectedDisposition: "keep"` 时 `expectedBucket` 只能是 `primary`、`talk` 或 `backup`。
- `expectedDisposition: "exclude"` 时必须是 `expectedRecommendation: "skip"` 与 `expectedBucket: "not_recommended"`。

v2 草稿的初始转换规则是：

- v1 中非 `skip/not_recommended` 的 7 条全部为 `keep`。
- v1 中仅因方向不一致或缺少直接证据而标成 `skip/not_recommended` 的 11 条改为 `keep`，诊断参考档改为 `review/talk`。
- v1 中有明确资格冲突的 2 条保留为 `exclude` 与 `skip/not_recommended`。
- 任何逐条调整都写入新 v2 文件；不得回写 v1。
- v2 在真实双跑前必须由用户一次性确认，确认后冻结哈希。

## Recall-first Metrics

每条运行结果先映射为实际处置：

- `primary`、`talk`、`backup` -> `keep`
- `not_recommended` -> `exclude`
- `analysis_pending`、`refresh` -> `unresolved`

从逐行结果派生以下指标，不信任结果文件自报的汇总值：

- `expectedKeep`：标签要求保留的岗位数。
- `retainedOpportunity`：要求保留且实际保留的岗位数。
- `falseHardExclusion`：要求保留但实际进入 `not_recommended` 的岗位数。
- `expectedExclude`：标签要求明确排除的岗位数。
- `obviousMismatchExcluded`：要求排除且实际进入 `not_recommended` 的岗位数。
- `missedObviousExclusion`：要求排除但实际仍被保留的岗位数。
- `unresolvedDisposition`：实际仍为 `analysis_pending` 或 `refresh` 的岗位数。
- `opportunityRetentionRate = retainedOpportunity / expectedKeep`。
- `obviousExclusionRate = obviousMismatchExcluded / expectedExclude`。

精确 recommendation/bucket accuracy 继续输出，但只作诊断，不进入 recall-first 接受条件。

## Acceptance Gate

正式 v2 双跑只有同时满足下列条件才可 `accepted:true`：

- `failed === 0`
- `stale === 0`
- `pending === 0`
- `unresolvedDisposition === 0`
- `primaryWithoutEvidence === 0`
- 不存在 `partial -> primary`
- `falseHardExclusion === 0`
- `missedObviousExclusion === 0`
- baseline 与 candidate 使用相同的 v2 标签哈希、画像、匹配卡、JD 集合、模型身份和 harness
- candidate 不得改写 `expectedDisposition`

候选的精确 recommendationAccuracy 或 bucketAccuracy 低于 baseline，不再单独导致 v2 验收失败。旧 v1 比较仍保持原有精确门禁，保证历史结果可复现。

## Implementation Boundary

第一阶段只扩展私有 full-chain runner 的 v2 标签解析、逐行输出、派生指标和比较报告：

- `scripts/private-full-chain-runner.js`
- `tests/private_full_chain_runner_smoke.js`
- 必要时在 `scripts/lib/benchmark_metrics.js` 增加无副作用的通用处置派生函数，但不得改变 v1 默认语义

通用脱敏 benchmark、历史 v1 结果和运行时匹配契约默认不改。只有后续小样本证明运行时仍会错误硬淘汰，才以独立失败测试修改产品逻辑。

不新增依赖、不新增数据库迁移、不建立自动改写提示词系统。

## Diagnostics and Calibration

诊断运行使用 2–5 条代表样本，`diagnosticMode:true`、`acceptanceEligible:false`，不得冒充正式 20 条验收。

每轮只回答一个问题：

1. 链路是否完整结束，无 JSON、截断或模型失败？
2. 是否出现可尝试岗位被错误硬排除？
3. 是否有明确不合适岗位没有排除？
4. 主推是否具备双侧证据？

若边缘岗位进入 `talk`，不视为失败。只有上述安全或明显排除问题出现，才修改规则或提示词。每次修改后先跑离线红绿测试，再用全新输出目录重跑最小样本；不得复用模型缓存来证明新行为。

## Privacy and Safety

- 私有 v2 标签、真实简历、JD、模型缓存和 live 结果只写入 `D:\DevData\RoleFlow-private-benchmark`。
- Git 只提交代码、脱敏测试和不含岗位/简历正文的聚合报告。
- 正式模型设置只允许通过现有只读 `--model-settings-root D:\Guo\ZhiPing` 门禁使用，不复制或打印密钥。
- 不访问真实招聘平台，不操作浏览器，不读写 `D:\Guo\ZhiPing\data\jobs.sqlite`，不启动或操作 8787。
- 所有模型调用串行执行。

## Compatibility

- v1 标签继续接受且保持原有精确比较语义。
- v2 标签必须显式声明 `evaluationPolicy: "recall-first.v1"` 和逐行 `expectedDisposition`；缺字段、非法枚举、混用版本均安全失败。
- baseline/candidate 两侧必须使用完全相同的 v2 标签文件与哈希。
- 旧结果没有 v2 字段时不得自动推断或升级，避免把历史结果误报为 recall-first 验收。

## Success Criteria

- v1 私有 runner 离线测试保持绿色。
- v2 标签结构、哈希冻结、跨侧身份和汇总防伪均有失败测试。
- v2 比较证明：`keep -> talk` 可以通过，`keep -> not_recommended` 必须失败，`exclude -> talk` 必须失败，精确档位变化本身不失败。
- 全部离线检查通过。
- v2 私有标签经过一次集中确认。
- 至少一轮 2–5 条真实模型诊断完成，无错误硬淘汰、无无证据主推，并记录安全聚合结果。
- 代码和非敏感文档提交并推送隔离分支；不自动合并主项目。
