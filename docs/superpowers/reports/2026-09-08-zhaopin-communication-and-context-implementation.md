# 智联普通沟通、消息岗位补全与统一布局：实施回执

更新于 2026-09-09。**实现任务已全部完成独立任务复核；全阶段复核、完整门禁与真实全流程仍待验收。** 本文件区分已有证据和剩余任务，不用旧版本完整门禁代替当前验证。

## 用户变化与边界

- 已批准方向：消息待办采用同一左侧紧凑列表、右侧单条详情；智联消息缺少本地岗位资料时读取对应真实 JD 并复用现有分析和本地草稿；分析结果可进入现有独立沟通清单，发起普通初次打招呼。
- 真实验收由助手操作现有简历的隔离副本，停在回复草稿保存、未发送。普通初次沟通的本轮授权不包含回复发送、简历同意/拒绝、投递或申请。
- 不推送、合并、打包、发布、改版本或替换安装版。智联单岗位技术验收不继承 BOSS 的已验收结论。

## 当前可核对检查点

| 部分 | 当前状态 | 证据 |
|---|---|---|
| 统一消息布局 | 任务复核和本地浏览器回归完成；待阶段最终复核与真实验收 | `622e0ce`、`767c22b`、`e975a92`；整组草稿稳定保存后才切换。主控在 `17cc3d4` 新鲜严格旅程退出码 0 |
| 消息岗位资料补全 | 实现、定向回归和独立任务复核完成；真实验收待完成 | `ab7a246` 后的两项重要问题由 `5664310` 修复；补充回归通过，复核确认两项关闭且无新增重要问题 |
| 新版搜索结构与准备页等待 | 实现和独立任务复核完成；真实 prepare/save/start 待验收 | `5ffabe7` 通过 4 项定向检查；`6163af6` 补齐页面消失、严格清理归属、祖先隐藏 loader 与取消来源，新增失败回归后两项覆盖检查、语法和差异检查通过；四项复核问题关闭，无新增重要问题 |
| 智联普通初次沟通 | 来源控制、浏览器适配及产品入口全部完成任务复核；待最终阶段验证 | 底层 `d67e4ec`、`8c13026`；适配器 `9108e0c`；产品 `f975872`、`3b1d76b`、`d7e7340`；仅开放 `dom_verified / e2e_pending` 单岗位技术验收，未宣称正式通过 |
| 当前代码完整门禁 | 未运行 | 完成各任务及复核后，从头运行一次严格完整门禁并记录精确 SHA |
| 当前真实端到端 | 未运行 | 尚未发起本轮普通打招呼、回复、简历处理或投递 |

## 新鲜定向验证

消息岗位补全恢复验证起点 `ab7a2469af279e924bd022ffd56d6a7f92a84d4c`，终点 `44010da6ad47c12e271ac8e898c157d46aa7448f`；期间只有两份交接文档变化，`src/` 和 `tests/` 不变。以下检查全部退出码 0：

- `zhaopin_message_reader_smoke`
- `zhaopin_message_detail_reader_smoke`
- `zhaopin_message_job_context_smoke`
- `zhaopin_message_discovery_smoke`
- `message_discovery_job_context_smoke`
- `dashboard_message_discovery_smoke`
- `dashboard_unified_messages_journey`

使用严格 Playwright 环境及 D 盘临时资料；保留已知 Node SQLite ExperimentalWarning。`git diff --check` 退出码 0。原实现者没有留下修复前失败记录，无法恢复历史 RED 证据，因此这里只主张当前回归通过，不虚构原始红绿过程。后续修复如有发生，须追加覆盖当前代码的验证。

独立复核随后复现两项缺陷：正确编号但标题/公司尚空的骨架页立即被误判为错岗位；详情层的 `ZHAOPIN_MESSAGE_RISK_CONTROL` 未被控制器识别，停止当轮却没有保存后续智联阻断。`5664310c1048badf2dc7f1c13e7701ec0d087168` 先补真实失败回归，再分别允许缺失字段等待、统一识别两种实际智联风险码。`zhaopin_message_detail_reader_smoke`、`zhaopin_message_discovery_smoke`、`dashboard_message_discovery_smoke` 和 `git diff --check` 均退出码 0。修复复核确认两项均已处理，没有新增 Critical/Important；普通加载超时不会进入风险冷却，BOSS 状态不变。

## 实际环境与资料保护

产品接线 `f975872e82dc50fc0b84d609c62fdd1c93b7b5d3` 的真实 HTTP/临时 DB 回归先复现智联 builder 混入 BOSS，以及 CLI 未按冻结来源选适配器；实现后 8 项定向检查全部退出码 0（dashboard communication batch、CLI authority、communication application、workflow communication、ZL workflow、ZL dashboard 含严格 Playwright、ZL communication storage、新 ZL communication HTTP）。独立审查发现失锁后的页面恢复、默认岗位记录缺少下一批入口，以及智联共用错误仍指向 BOSS 三项问题。`3b1d76b` 先补失败回归，再修正入口/文案和两平台取消恢复，5 项覆盖检查通过；内层读取的取消空隙由 `d7e7340317b7c9015a39230980f9136cf750a56f` 通过真实基础 reader 的失败回归关闭，adapter、readonly、CLI 三项检查及语法/差异检查通过。最终定向复核确认三项全部关闭，无新增 Critical/Important。BOSS 正常行为保持，仅新增失去共享执行锁时的清理后停止；没有修改选择器、节奏数值或身份/结果证明规则。

以下底层任务的 `executionEnabled:false` 是其当时的中间检查点；当前产品仅将智联技术执行开关开启，仍保留 `e2e_pending` 和单岗位约束。所有本节测试均使用合成平台、假浏览器和临时数据库，不是当前真实验收副本上的假成功。

普通沟通浏览器适配 `bf407876be73987ebce9e73a7c4948cd4b08f26f` 的 6 项定向检查（adapter、browser transport、message reader、readonly search、communication executor、CLI authority）全部退出码 0，8 项 JS 语法和差异检查通过。独立审查提出 5 项重要问题：焦点释放过早、IM 成功后不能继续下一项、等待网络时不独立检查风险、损坏证据误分类，以及不应缩小 BOSS 既有方法范围；`44555a0` 补齐逐项失败回归并修复，adapter/transport 检查通过。该修复又暴露一次清理失败后资源引用丢失的问题；`9108e0c1ee6032856ebecf301d64972b3c2fcdab` 保留未释放资源、确保结束操作，并通过真实调用计数的合成恢复回归。最终差异复核确认原 5 项和清理恢复问题全部关闭，无新增 Critical/Important。以上均为本地合成验证，未运行本阶段完整门禁或真实发送。

普通沟通存储/控制任务在 `d67e4ec` 完成 6 项新鲜定向检查：`zhaopin_communication_storage_smoke`、`communication_batch_storage_smoke`、`communication_application_smoke`、`communication_runtime_smoke`、`communication_calibration_gate_smoke`、`communication_executor_smoke`，均退出码 0。独立复核发现“同计划、不同用户资料的观察记录”可过晚才被拒绝；`8c130267bbf877da192996b309e9fd0cfbcea8cb` 新增失败回归后，提前在创建事务核对观察记录的资料/计划/来源，拒绝时不产生批次。3 项覆盖回归、语法和差异检查通过，修复复核无新增重要问题。BOSS 行为不变，智联仍为 `dom_verified / e2e_pending / executionEnabled:false`。

用户重新打开页面后，主控于 12:51 UTC 只读查看已加载 `job-apply` 客户端。调用模块引用环境模块 `36040` 与请求模块 `69508`，确认普通 prechat 为 GET `https://cgate.zhaopin.com/imapi/imV2/createAndUpdateContextV2`，application 为 POST `https://fe-api.zhaopin.com/c/pc/alan/jobs/application`；后者仅作为停止信号，绝不执行。资源 SHA256 为 `211af7a360cd141e27a6931f17e7dc639b9c89dcba42001af2853f8a3da6ce94`，浏览器拦截器不改写这些绝对 URL。证据在 `D:/DevData/RoleFlow-zhaopin-message-context-20260908/client-origin-evidence.md`。没有点击、导航、新标签或私有 API 请求，前后台标签身份保持不变；这是代码依据，不是发送成功证据。

- 开发工作树：`D:/DevData/RoleFlow-worktrees/zhaopin-readonly`，分支 `codex/zhaopin-readonly`。
- 隔离验收数据：`D:/DevData/RoleFlow-unified-message-acceptance-20260908`，不是用户当前安装版或空白新用户资料。
- 验收前计数快照：`D:/DevData/RoleFlow-zhaopin-message-context-20260908/acceptance-baseline.md`。含 BOSS 历史成功及未确认记录，不自动重试、改写，也不作为当前质量或成功证据。
- 当前检查时旧 8788 验收服务未运行。主控在代码冻结后自行启动和管理服务，不依赖用户手动启动。
- 真实页面仅由主控读取补证；实现与回归使用合成页面、假浏览器和临时数据库。原始页面证据保留仓库外，不把用户消息正文或凭证加入测试。

## 剩余交付门槛

实现任务与其独立复核已经完成，不重做搜索兼容或普通沟通三项任务。剩余为全阶段综合复核和新鲜完整门禁；再从产品页面实际完成找岗、分析、单岗位普通打招呼、消息发现、生成和保存草稿。记录精确目标、实际动作数量、历史回复与本轮新沟通的区别，以及刷新/再次进入后的保留结果。最后交付用户最终验收，不把小样本或未发送回复扩写为所有平台功能验收完成。
