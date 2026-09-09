# 智联短正文待补项不阻塞其余采集

> Use subagent-driven-development for one bounded implementation and one scoped task review. Existing company, location and scan recovery reviews remain closed.

**Goal:** 已核对身份且页面不在加载、但未达到既有完整JD门槛的岗位保留待补；继续读取其他岗位和目标，已有完整JD进入现有分析。

**Architecture:** 复用 `ZhaopinSiteAdapter.scan` 的岗位/目标检查点和 CLI 对非致命 partial 扫描的分析路径。短项不抛整轮异常，仍保持 `detailRead=false` 和 `ZHAOPIN_DETAIL_INCOMPLETE`，受影响目标保持 partial；预算/滚动上限和真正身份、加载、风控、掉页、停止、持久化失败继续使用原退出路径。无新存储、调度器或重试机制。

**Tech Stack:** 当前 Node/CommonJS、现有假浏览器和内存 SQLite 测试，无新依赖。

## Global Constraints

- Worktree `D:/DevData/RoleFlow-worktrees/zhaopin-readonly`, branch `codex/zhaopin-readonly`。保留主控四份未提交文档；不 reset/amend/stage-all。主控负责真实浏览器、隔离服务、文档和最终完整门禁。实施者不得访问真实站点/真实简历/验收数据库，不推送、合并、打包、发布或改版本。
- `hasCompleteJobDescription` 的120字符和质量标签规则不变；短项不能分析、推荐或用于沟通，不补写或拼接正文。标题/公司/编号/薪资/地点和非loading前提不变。保留全部已读及未完成岗位，不减少用户范围/覆盖率，不把待补目标标为完成。
- 每个短项同样消耗本次未复用详情预算、访问预算及正常随机节奏/冷却；同一目标内记seen，不循环读取它。只有“正常达到card_limit_reached/confirmed_end，但含短项”的partial目标可继续下一关键词，预算/scroll_limit等partial仍按原逻辑停止。无自动整轮重试。
- Node `D:/hermes/node/node.exe`; PATH前置`D:/hermes/node`; NODE_PATH=`C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules`; ROLEFLOW_REQUIRE_PLAYWRIGHT=1; TEMP=TMP=`D:/DevData/RoleFlow-tests`。仅运行指定定向检查，最终 `npm test` 由主控唯一执行。既有 SQLite 实验警告记录、不隐藏、不扩大修复。

## 设计依据与取舍

真实同一run已保存34岗位/33完整JD。当前失败卡片及详情全部身份字段相符、非loading；正文含标签仅70字符，单独正文仅几句话，间隔两分钟读取不变且没有展开控件。不是先前公司/新区问题复发，也不是已有完整JD丢失。真实资料只保留仓库外，合成测试不使用真实公司/编号/正文。

继续等待不能保证平台原文增长；降低120门槛会改变分析质量合同，均不采用。采用既有待补记录局部隔离，继续有用工作。CLI当前 scan 正常返回后即使partial仍分析本批次；队列结束后有partial目标则 `SCAN_TARGETS_PARTIAL` / resumePhase=scanning，没有自动重复。此处只消除单条内容不足的整轮抛错，不声称短项已完成。

## Task 1: 保留短项并继续当前任务

**Ownership:** 修改 `src/adapters/sites/zhaopin.js`、`tests/zhaopin_workflow_smoke.js`。其余源码不改；如现有消费者确实阻碍此契约，先向主控报告具体证据。主控维护文档。

**Interfaces:** 输入既有 `scan(options)` 回调/预算/targetKeys；输出仍是全部已访问岗位数组及原格式检查点。`onDetailResult` 短项只发一次failed（不发succeeded），完整项保留原success/reuse逻辑。`onTargetComplete` 保留原数字计数；短项目标errorCode/stopReason使用既有 `ZHAOPIN_DETAIL_INCOMPLETE` 表示待补，`onScanComplete` partial不得带fatalErrorCode。

- [x] RED：替换既有短JD必须throw的测试，使用现有假浏览器构造首个短正文、后续完整正文，并增加下一关键词。运行真实adapter+内存存储，断言短项保留detailRead=false/error，后续完整项和下一目标均checkpoint；短项不产生success结果，受影响目标partial/扫描partial、未带fatal。旧代码实际在首个短项throw而失败。

```js
assert.equal(shortJob.detailRead, false);
assert.equal(shortJob.detailErrorCode, 'ZHAOPIN_DETAIL_INCOMPLETE');
assert.equal(outcomes.find(x => x.errorCode === 'ZHAOPIN_DETAIL_INCOMPLETE').outcome, 'failed');
assert.equal(targets[0].status, 'partial');
assert.equal(targets.length, 2); // next keyword really visited
assert.equal(terminal.status, 'partial');
assert.equal(Boolean(terminal.fatalErrorCode), false);
```

- [x] 最小实现：去除该单条短项分支整轮throw，统一走现有岗位入集合、检查点、进度、seen、scoped和after-action节奏。短项不走cache复用判定、计入details；完整项cache/contenthash规则不变。正常收齐目标后检查是否存在 `!job.detailRead`：目标partial且原因INCOMPLETE；继续其他目标。预算/scroll_limit导致的partial仍break。任何回调/身份/加载/控制异常不得被新分支吞掉。

```js
const complete = hasCompleteJobDescription(job);
if (!complete) { job.detailRead = false; job.detailErrorCode = 'ZHAOPIN_DETAIL_INCOMPLETE'; }
// preserve existing shared checkpoint/seen/pacing path for both outcomes
const coverageReached = ['card_limit_reached', 'confirmed_end'].includes(stopReason);
const hasPendingDetails = targetJobs.some(job => !job.detailRead);
const status = coverageReached && !hasPendingDetails ? 'completed' : 'partial';
// completed++ only for completed; break only when !coverageReached
```

- [x] 保留最小负向检查：短项也消耗maxDetailTotal=1因而不读下一条；短项checkpoint后若收到取消/风控/存储失败，原错误继续传播且不读后项。原加载中/身份冲突/跨窗测试继续通过。主控复用并实际通过 `workflow_scan_analysis_smoke`，一短一完整的本批次任务证明短项仍 `DETAIL_REQUIRED` 且不调用模型、有效项仍分析；CLI正常partial结束不自动重跑由独立代码追踪核对。
- [x] GREEN：`node tests/zhaopin_workflow_smoke.js`、`node tests/zhaopin_readonly_smoke.js`、`node tests/zhaopin_communication_adapter_smoke.js`、`node tests/workflow_analysis_executor_smoke.js`，两个拥有JS语法和diff检查。两文件提交 `fdc7d21368ffb7a42f731e99cda7e5ffa7ebf896`；完整报告含RED/GREEN与重复检查事实，原SQLite警告保留。
- [x] 主控独立增量审查 Approved，质量门槛/CLI消费者待核对项已由独立追踪及当前分析测试解除。仅拥有的隔离8788已核验，原UI一次继续同一run；02:38UTC推进42岗位/41完整JD/1待补，短项不再阻断后续卡片。
- [ ] 主控完成后续关键词和有效JD真实分析，冻结当前树后并行最终完整离线检查；任何普通招呼前必须拿到最终SHA全测通过及精确当前目标截图/DOM证明。至多一条普通招呼，停止于回复发送前。当前截图缺口未解决，不得以旧图替代或抢前台。
