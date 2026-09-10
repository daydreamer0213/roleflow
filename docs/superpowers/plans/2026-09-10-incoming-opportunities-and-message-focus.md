# 收到的机会与消息处理焦点 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 正式展示所有可靠已收到联系，并使消息页优先呈现待处理对象与当前回复。

**Architecture:** 一个只读的消息联系投影复用现有上下文、进度事件和待关联记录，供体检与消息记录入口使用；消息页继续服务端模板和现有自动保存/发送脚本，重排信息、补筛选和响应式切换，不改平台执行器。

**Tech Stack:** Node.js CommonJS、原生 SQLite、服务端 HTML/CSS/JavaScript、现有 Playwright 离线验收。

## Global Constraints

- 工作树 `D:/DevData/RoleFlow-worktrees/zhaopin-readonly`；分支 `codex/zhaopin-readonly`；基线 `93676e4647aeae9765501850660120dc6462e723`。
- 只读本地既有数据；不访问真实招聘平台，不发送消息，不修改用户数据库；只推送保存，不合并、打包、发布或改版本。
- 48 小时、周末顺延与 30/50/70 诊断规则和各平台策略隔离不变。明确反馈立即计数，不能把无主动联系记录当作 HR 主动发起的证据。
- 复用现有 SQLite 和前端，不新增依赖、框架、迁移或泛化基础设施；不得用岗位资料不完整排除已读到的真实请求。
- 保留自动保存、失败保留当前编辑、复制点击时文字、单击确认及不可变发送目标；智联不具备自动回复发送能力。
- Node `D:/hermes/node/node.exe`；测试 `TEMP`/`TMP` 均为 `D:/DevData/RoleFlow-tests`，`NODE_PATH=C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules`，`ROLEFLOW_REQUIRE_PLAYWRIGHT=1`。

### Task 1: 正式联系统计与可核对的记录

**Ownership / files:**
- Create `src/application/funnel_analysis/incoming_contacts.js`：只读聚合和明细，不经通用 storage facade 新增导出。
- Modify `src/application/funnel_analysis/index.js`、`src/dashboard/pages/funnel.js`。
- Tests `tests/funnel_platform_feedback_smoke.js`、`tests/dashboard_funnel_smoke.js`，必要时单独 `tests/incoming_contacts_smoke.js` 并登记 `tests/run_all.js`。
- 不修改消息页、共享 CSS、浏览器执行器、用户 DB；确实需要 storage 变更先与主控协调。

**Requirements / interface:**
- Export `listIncomingContacts(db, { profileId })` 返回数组。每项 `key`（稳定摘要键）、`platform`、`conversationKey`、`cardId`（可为 null）、`jobId`（可为 null）、`title`、`company`、`observedAt`、`resumeRequested`、`interviewInvited`、`inboundMessages`（已有安全展示内容）、`messageIntent`。可增加最少的来源/已处理字段并告知下一任务。
- 可靠 conversationKey 是会话去重依据；上下文→已绑定卡片 thread_key→未关联会话可以合并，跨平台/跨用户不能合并。历史只有卡片事件且缺少 thread_key 时不猜新会话；其主动联系数据仍保留在原表。
- 保留真实正文/请求卡的未关联消息；排除空白加载项；多个分组或重读不能重复计数；同一线程解除未关联后仍为同一条。使用全部记录，不能只调 bounded 500 的列表函数冒充累计。
- 读取可靠分类事件识别已发生的 résumé 请求/邀请；请求卡本身足以证实请求。只对已有消息内容做有限安全规范化，不用宽泛正则猜测邀请。后续礼貌消息不能抹掉历史已收到请求。撤销/无效关联按现有事实状态处理。
- 明确的纯文字索要简历同样算请求，不能要求 HR 必须使用平台请求卡：例如“方便发份详细的简历过来吗？”应计入；“已经收到简历”“不用发简历”“你的简历不错”不应仅因包含“简历”被计入。只读投影可做最窄识别，不因此启用任何附件动作。
- `dashboard.incomingContacts = { items, platforms }`，platforms 固定 BOSS/智联，各行 `site, contacted, resumeRequested, interviewInvited`；contacted 按会话计数，名称实现需保持一致并在报告列出。
- 体检正式第二节“收到的联系”，说明“已读取并保存在本地的会话”；平台三项计数，不再输出“其他消息中还有”。数字跳到同页可展开的精确对应明细（用原生 details 或独立安全 GET 筛选），每条可到 `/messages?planId=…&source=boss|zhaopin&contact=<key>&task=all`。不要用默认待处理列表承诺覆盖全部历史。
- 原主动联系表保留已联系、回复占比；索要/邀请属于对应已联系子集时可保留，必须清楚与收到联系全体的不同口径，避免两个无说明同名表格。推荐主动联系表只保留平台、已联系岗位、已回复及占比。
- 全体联系人属于当前 profile 的已保存记录，不受体检当前方案/累计切换改变。不编造 HR 主动占比。

**Steps:**
- [ ] 对真实持久层写手算 fixture：无 outbound + 未满 48 小时的请求立即进入；重复上下文合一；未关联正文/请求包含、空白排除；跨平台隔离；多 profile 隔离；关联前后不重复；已处理/历史分类仍可核对。记录行为 RED。
- [ ] 实现最小聚合与体检展示/精确明细、必要兼容现有测试，记录 GREEN。
- [ ] 运行定向回归、自审并提交本任务显式文件；报告接口和潜在无法匹配的历史数据，不隐瞒。
- [ ] 独立任务复审（符合设计和代码质量）关闭重要问题。

### Task 2: 消息页以处理当前联系为中心

**Ownership / files:**
- Modify `src/dashboard/message_discovery_view.js`、`src/dashboard/assets/roleflow.css`；仅必要时改 `src/dashboard/message_discovery_controller.js` 的本地结果投影。Task 1 关闭后可微调 `src/dashboard/pages/funnel.js` 的文案/明细展开呈现，不改统计逻辑。
- Tests `tests/dashboard_message_discovery_smoke.js`、`tests/dashboard_communication_profile_smoke.js`、相关已有消息浏览器测试；可新增 `tests/dashboard_message_focus_browser_smoke.js` 并登记 `tests/run_all.js`。
- 消费 Task 1 的只读 `listIncomingContacts`；不得修改统计所有者文件、平台执行器或用户 DB。

**Requirements:**
- 保留桌面 master/detail。列表紧凑展示岗位、公司、平台、HR 原话预览和“索要简历 / 面试邀请 / 待回复 / 待补岗位资料”等具体状态。不开列表卡片大面积编号或内部阶段标签。
- 默认待处理；可切 `task=pending|all|resume|interview`，`source=all|boss|zhaopin`；query 优先于本地记忆。`contact=<key>` 从统计精确到同一会话。关联现有结果用已验证 cardId + conversationKey，不只凭公司名匹配。未处理结果/未关联项与 incoming 联系去重；已处理或历史项只读渲染，不能重建 draft/发送操作。
- 指定联系已经不存在、与所选用户/平台不符时，显示清楚的未找到状态，不悄悄把另一条草稿当作目标；用户重新选择列表后才能转到其他联系。
- 待处理定义基于真实开放草稿、明确人工事项、未关联项；`processed` 是系统分析完成，不能用它断言用户已处理。已有已发送状态不能反向显示待回复。历史原文已清理时明确告知，只展示可靠事实。
- 首屏紧凑页头、一个“读取新消息”主动作、来源/任务筛选及列表。空态引导读取；运行时停止和简洁进度可见。内部计数/平台详细原因归到折叠“读取详情”；单条岗位关联失败不做整页错误标题，但真正平台级停止原因要显示并可理解。
- 体检第二表下不要常驻六行重复计数的明细摘要；数字点击后才展示相应明细，其他明细收起。范围文案说用户看得懂的“包含 HR 新招呼和对投递的回复，同一会话只计一次”，不解释页面实现或本地数据存储机制。历史原文缺失时说“已记录这次联系，原文暂不可查看”。
- HR 原话 → 简短岗位判断 → 当前草稿；一版主草稿，其他版本折叠/切换。保留每份草稿和自动保存语义、手动已发送绑定及学习。
- BOSS 当前项可确认发送，智联当前项仅复制和原会话处理；没有可信 deep link 时不编造链接，使用已有平台消息入口/说明。
- 主动进入批量，零默认选择；退出清空选择，切换来源避免隐藏项被发。活动批次进度和停止入口始终可见；单条发送仍不要求先进入批量。一个会话最多一版，发送前冻结用户实际所见文字。
- 窄屏（现有 760px breakpoint）默认只列表，点击后只详情并有返回按钮；同页来源/任务切换和自动保存失败必须保持正确面板/选中/键盘焦点。不能因隐藏 details 备用草稿而丢失文字。

**Steps:**
- [ ] 阅读 Task 1 接口报告与现有保存/复制/批次脚本，扩展真实浏览器 fixture 写 RED：首屏无预选批次、点请求统计到对应联系、窄窗进退、备用稿、切换保存失败保留。
- [ ] 最小改模板、客户端状态和 CSS；运行对应 GREEN、消息控制/学习/发送安全回归。
- [ ] 自审并提交本任务显式文件，报告测试与未验证项。
- [ ] 独立任务复审，关闭重要问题。

### Task 3: 整体用户验收、冻结验证与保存

**Owner:** 主控。只在前两项集成通过后做最终门禁。

- [ ] 用临时 DB + 本地浏览器走“统计 → 对应消息 → 编辑/保存 → 切换/返回”，不发送。1440px 和窄窗截图复核首屏，确认不是只满足 HTML 断言。
- [ ] 确认 8788 属于本任务且空闲后重启该服务；现有用户 DB 只读核对实际计数，不注入样本、不访问平台，不清除结果。
- [ ] 做一次整个本次功能差异的独立复审，处理有依据的重要发现。
- [ ] 冻结干净代码 SHA，从头 `npm test`，记录实际总数、退出码和起止 SHA，不在运行中编辑仓库。
- [ ] 更新 NEXT_PHASE、PROJECT_HANDOFF、本计划和验收报告；最终文档 SHA 再做相称定向回归与 diff 检查。
- [ ] 仅推送 `codex/zhaopin-readonly`，核对远端相等、main 未改变；给用户简短验收入口和未验证边界。
