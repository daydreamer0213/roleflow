# Wave 4 正式验收与条件收口报告

**日期：** 2026-08-13

**总结论：** Wave 4 有条件通过，Wave 5 继续暂停

**正式 Gate D：** 主线抓取与技术评测通过

**当前唯一详情主线：** `trusted_pane`

## 1. 本轮边界

- 使用更换后的已登录 BOSS 账号和独立账号安全账本。
- 使用全新空 operational baseline，不混入任何历史、中断或失败数据库。
- 完整执行 5 个正式关键词，保留 `maxDetailTotal=220` 和完整 JD 覆盖目标。
- 未传入或启用 `search_page_api`，也未使用 `standalone_detail`。
- BOSS 仅只读；未沟通、未发送消息、未申请，也未确认或执行沟通批次。
- Dashboard 人工验收使用本地无登录态浏览器；真实 Edge 仅做固定双标签的只读检查。

正式证据目录：

`D:\DevData\RoleFlow-gate-d\baseline\formal-trusted-pane-account02-20260813-094114`

正式数据库：

`D:\DevData\RoleFlow-gate-d\baseline\formal-trusted-pane-account02-20260813-094114\jobs.sqlite`

账号安全账本：

`D:\DevData\RoleFlow-gate-d\account-safety\boss-account-02.sqlite`

## 2. 正式 Gate D 结果

本轮 scan run 从北京时间 09:50:55 运行到 10:18:13，约 27 分 18 秒。

| 项目 | 结果 |
|---|---:|
| 正式关键词 | 5/5 完成 |
| 每个关键词发现的列表岗位 | 15 |
| 去重后岗位 | 51 |
| 要求读取详情 | 51 |
| `trusted_pane` 详情尝试 | 51 |
| 详情成功 | 51 |
| 详情失败 | 0 |
| 完整 JD | 51 |
| 模型任务成功 | 48 |
| 模型任务失败 | 3 |
| 最终可进入主投/可投清单 | 13 |

运行、批次和 5 个 target 均为 `completed`，进程退出码为 0，supervisor 标记
`eligibleForEvaluation=true`。SQLite `quick_check=ok`、无外键错误、无残留扫描租约。

### 风控与执行方式

- 固定复用一个普通 Edge 窗口中的搜索页和消息页两个既有标签。
- BOSS 操作串行；每个关键词完成后再进入下一个关键词。
- 每个关键词通过 4 轮列表滚动和 2 个静默窗口确认列表到底，共记录 20 次滚动。
- 共记录 5 次列表导航、51 次右栏详情读取；账号账本另含启动前的 1 次只读导航检查。
- 每次详情通过左栏岗位卡片打开可信右栏，再读取右栏内容；详情访问模式只有
  `visible_pane`。
- 保留项目既有随机间隔、阶段冷却、账号预算、检查点和登录/风控立即停止策略。
- 本轮没有登录丢失、风控、页面身份漂移或预算阻断。

浏览器命令审计显示：

- `Page.bringToFront=0`
- `focus_tab=0`
- 未出现非数值 tab ID
- 未访问固定双标签之外的标签
- 所有焦点模拟窗口均正常关闭

因此，本轮项目没有抢占前台。此前混合环境中的前台跳转不登记为 RoleFlow 缺陷。

## 3. 岗位分析与 Gate D 评测

正式运行中的分析状态：

| 状态 | 数量 |
|---|---:|
| complete | 43 |
| blocked | 4 |
| pending | 3 |
| refresh | 1 |

正式数据库中的产品推荐分布：

| 推荐 | 数量 |
|---|---:|
| 主投 | 7 |
| 可投 | 6 |
| 慎投 | 26 |
| 不推荐 | 7 |
| 无推荐 | 5 |

决策来源分布：

| 来源 | 数量 |
|---|---:|
| weighted_decision_matrix | 28 |
| salary_stretch_guard | 12 |
| hard_boundary | 4 |
| analysis_pending | 3 |
| experience_stretch_guard | 1 |
| indispensable_transferable_guard | 1 |
| model_evidence_gap | 1 |
| source_refresh | 1 |

对这一个合格正式 baseline 只执行了一次有效评测导出：

- fixture：`D:\DevData\RoleFlow-gate-d\baseline\fixtures\gate-d-evaluation-fixture.json`
- labels：`D:\DevData\RoleFlow-gate-d\baseline\labels\gate-d-evaluation-labels.json`
- manifest：`D:\DevData\RoleFlow-gate-d\baseline\reports\gate-d-evaluation-manifest.json`
- receipt：`D:\DevData\RoleFlow-gate-d\baseline\reports\gate-d-evaluation-receipt.json`

导出收据为 `complete=true`、`cohortComplete=true`、`qualityEligible=true`：

| 评测项目 | 数量 |
|---|---:|
| 原始观测 / 唯一岗位 | 51 / 51 |
| 可做质量评测的岗位 | 43 |
| 技术状态岗位 | 8 |
| 正式二维表：主投 / 可投 / 慎投 / 不推荐 | 19 / 6 / 15 / 3 |
| 影子积分卡：主投 / 可投 / 慎投 / 不推荐 | 19 / 6 / 15 / 3 |
| contract_failure / blocked / refresh | 3 / 4 / 1 |

正式二维表和影子积分卡在 43 个合格岗位上的四档分布完全一致，但 51 条人工标签仍全部是
`pending-human`，所以本轮不能宣称精确率、召回率已经得到人工确认，也不能据此切换产品决策机制。

## 4. 正式运行暴露并修复的真实问题

3 个岗位在 `understandJob` 阶段以 `MODEL_CONTRACT_INVALID` 终止。结合上一轮相同现象，
该问题已经稳定复现，确实会让岗位缺少分析结果。

已确认的根因是模型输出的 `requirements.evidence` 或 `riskSignals.evidence` 超过 120 个字符，
现有单次契约修复提示过于泛化，模型可能原样返回超长证据。

最小修复：

- 不增加模型调用次数，仍只使用原有的一次契约修复。
- 仅对三条当前 evidence 长度错误精确匹配，其他契约错误完全保持原行为。
- 修复提示明确要求复制连续 JD 原文、以 `JD：` 开头并限制在 120 个字符内。
- 修复结果仍超长时，只有整段内容能被逐字证明是 `job.description` 中的连续原文，才确定性缩短到
  120 个字符。
- 改写、拼接、来源不明或不带正确前缀的内容不会被截成“合法证据”，仍由原校验拒绝。
- 未改变 validator、推荐规则、关键词、详情读取、风控节奏或 JD 覆盖。

回归测试覆盖 `responsibilityEvidence`、`requirements.evidence` 和 `riskSignals.evidence`，
同时覆盖非原文拒绝、非精确错误原因不触发和调用方输入不被修改。

用正式数据库中两份稳定失败的已保存 JD 做模型复核，均在初次超长后通过原有单次修复：

- 样本 967：修复后最大 evidence 为 94 个字符；
- 样本 990：修复后最大 evidence 为 120 个字符。

证据：

`D:\DevData\RoleFlow-gate-d\baseline\formal-trusted-pane-account02-20260813-094114\understand-contract-evidence-reproduction-v6.json`

这项修复发生在正式 Gate D 之后，不回写也不重算正式 baseline；下一次全量运行将验证其批量稳定性。

## 5. Dashboard、自动沟通与消息页只读验收

本地 UI 对 6 个桌面路由和 1 个手机视口完成验收：

- 7/7 HTTP 200；
- 无 console error、无 page error；
- 岗位页桌面和手机均显示 51 个岗位；
- 原始 `multiBusinessDistrict` 在所有页面均未展示；
- 桌面侧栏文字无旋转倒字，手机端侧栏正常隐藏；
- 工作流页显示 39 条可复核岗位，流程体检为紧凑折叠块；
- 自动沟通入口可见；
- 批量沟通清单默认选中 13 个主投/可投岗位供人工审核，这是本地表单状态，不会创建批次；
- 浏览器权威默认复用当前 Edge；
- 自动沟通中心无批次、无执行入口；
- 消息页为空闲只读状态，无草稿，也未点击开始发现。

最初自动检查把“默认选中应为 0”当作预期，因此原报告记为失败；补充报告核对产品设计后修正为：
默认选中 13 条供人工审核是预期行为。全过程提交表单 0 次，数据库中的沟通批次、沟通条目和申请均为 0。

UI 证据：

- `D:\DevData\RoleFlow-gate-d\baseline\formal-trusted-pane-account02-20260813-094114\acceptance-ui-v3\dashboard-ui-acceptance.json`
- `D:\DevData\RoleFlow-gate-d\baseline\formal-trusted-pane-account02-20260813-094114\acceptance-ui-v3\dashboard-ui-acceptance-supplement.json`

真实 BOSS 消息固定标签保持登录且无风控，页面显示“30天内暂无联系人”“当前暂无消息”。
因为新账号消息页为空，本轮只能验收真实空状态，无法抽样读取实际会话。未点击任何联系人、沟通或发送控件。

## 6. Fresh 验证

- 定向模型适配器测试：`model_adapter_smoke ok`
- 两份历史失败 JD 的当前模型复核：2/2 修复后契约有效
- 独立只读代码复审：无未解决的 Critical 或 Important 问题
- 完整离线套件：`All 93 offline checks passed`

完整日志：

`D:\DevData\RoleFlow-gate-d\verification\wave4-formal-closeout-20260813.stdout.log`

## 7. 条件结论与后续边界

Wave 4 记为“有条件通过”：

- `trusted_pane` 正式抓取、5 个关键词、51/51 完整 JD 和 Gate D 技术导出通过；
- Dashboard、自动沟通入口和空消息页只读验收通过；
- 本轮无 BOSS 外部写动作；
- 本轮真实复现的模型 evidence 修复缺陷已经最小整改并通过保存样本与离线验证。

仍保留以下条件：

1. 下一次全量运行确认模型 evidence 修复在批量流程中的稳定性。
2. 完成 51 条人工标签后，才能计算并宣称正式精确率、召回率。
3. 自动沟通真实人工端到端仍未完整验收；没有用户明确授权前，不执行真实沟通或发送。
4. 新账号消息为空，因此有真实会话后的只读消息抽样仍待验收。
5. AGPLv3 允许商业使用，不满足“禁止他人盈利使用”的硬要求，许可证仍需用户最终决定。
6. `search_page_api` 保留为后续独立拓展任务，本轮不修、不验、不删，也不进入产品主线。

Wave 5 继续暂停。
