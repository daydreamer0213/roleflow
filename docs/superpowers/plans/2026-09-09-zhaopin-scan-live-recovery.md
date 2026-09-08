# 智联真实扫描恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. 按独立任务先复现、最小修复、定向验证和复核；不重开已经关闭的分支历史审查。

**Goal:** 修复助手真实验收中首次新扫描的后台渲染、默认筛选摘要与进度合同缺陷，保证中断即时可见，再继续既有验收。

**Architecture:** 复用既有浏览器后台渲染能力、智联适配器和 SQLite 检查点；保留精确身份及真实条件。页面状态变化复用服务端现有中断页面，不另建前端状态系统。

**Tech Stack:** 现有 Node.js、JavaScript、SQLite、Playwright 合成页面，无新依赖。

## Global Constraints

- 工作目录 `D:/DevData/RoleFlow-worktrees/zhaopin-readonly`，现有隔离分支；不是默认 C: worktree。主控独占文档、真实页面、隔离验收服务和完整测试；实施者不访问真实浏览器/验收数据库。保护其他人的改动，不 reset/amend/stage-all。
- 此任务已由用户批准的继续开发与助手验收覆盖，不改设计方向，不增加平台或审批。无推送、合并、打包、发布、版本修改。真实回复、简历同意/拒绝/上传、投递禁止；普通初次招呼仍至多一个新扫描的确定岗位，须新鲜完整检查通过后由主控操作。
- 保留精确岗位四编号、公司、可见标题、薪资和城市校验；不得用组件中岗位名称替代尚未渲染的可见标题作为验证成功。不得调用私有 Vue 方法、重放平台接口、激活窗口/标签页或 `Page.bringToFront`。随机节奏、访问额度、冷却、互斥、检查点、暂停/停止/异常即停均保留。
- 不扩大搜索目标、降低完整 JD 标准、改限额、清除方案、变更数据库结构或放宽存储约束。只修本计划实际复现路径；不做通用框架或全仓库重构。
- 运行定向测试：`D:/hermes/node/node.exe tests/<name>.js`；`NODE_PATH=C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules`，`ROLEFLOW_REQUIRE_PLAYWRIGHT=1`，`TEMP=TMP=D:/DevData/RoleFlow-tests`。完整 `npm test` 仅主控跑一次稳定树，不由各实施者重复运行。

## 当前证据

- `d70a0c88a1c02708bf8f6faaa91b96974051fdde` 严格完整检查 **157/157，exit 0，起止 SHA 相同且 clean**。随后实站证明仍有本计划缺陷；不能用该门禁宣称整条用户流程已通过。
- 新 run `25641478-c928-403a-8d3d-c3f189895298` 首次正常开始：20:59:21 UTC 启动，20:59:35 中断，0 个新扫描岗位，`ZHAOPIN_SEARCH_RESTORE_TIMEOUT`。不是旧 BOSS run。未发送新招呼。
- 21:05 UTC 后台当前页正常登录、20 卡、selected 0、无加载，URL 与保存模板/关键词一致。选中卡 `.vue-clamp__text` 确实为空，组件 `JobCard.$props.job.name` 和右栏标题有值，详细/计算/链接 ID 完整相同。只读最小实验启用已有 `Page.setWebLifecycleState(active)` 与后台 focus emulation 后，1500ms 内可见标题恢复 `AI应用开发岗`；没有导航/点击/激活，前台仍1995703199、总6页。截图命令超时已记录，不能宣称获得新截图。
- 当前筛选栏10项：地区、薪资、学历、经验、公司性质、融资阶段、公司人数、工作性质、职位类别、公司行业。保存摘要9项，仅缺默认“融资阶段”；实际该新增框选中“不限”，URL 参数不变。当前按完整标签数组 JSON 全等，错误认为用户改了条件。
- 同次异常触发 `scan_checkpoint_rejected/SCAN_PROGRESS_INVALID`：异常 onTargetComplete 漏掉位置/总数，归零后与冻结目标1/3冲突。滚动回调使用未允许的 `list_scroll` 并漏计数；正常完成的 `state.cards.length` 可能超过 cardLimit。均为适配器输出不符合既有存储合同，不应放宽 storage。
- 真实 UI 在后台 interrupted 后仍显示“正在筛选/没有阻塞/本轮操作空”；手动 reload 立即出现“本轮已中断，等待继续”、具体原因、“结束本轮…”及“继续本轮”。服务端已有正确渲染。客户端只比较 `phaseKey`，而 scanning 和 interrupted(resume_phase=scanning) 都是 acquisition。持续5秒日志可能是公共 runtime 轮询，不能断言 workflow 轮询仍在运行。

证据入口：仓库外 `D:/DevData/RoleFlow-zhaopin-message-context-20260908/live-acceptance-20260909.md` 和 `probe-post-navigation-state.js`。不得复制真实公司/账户/HR/简历入 fixtures。

## Task 1: 后台扫描就绪及检查点合同

**本地实现与复核完成：** 8cb39ff 完成两条真实RED、5项指定及8项相邻GREEN；一次复审指出双异常覆盖原错，a61e34c 以两条RED、三项GREEN修复，唯一发现已复核关闭。没有新增阻塞，实际平台复验及稳定SHA全测仍由主控接着执行。下列实现项均已完成。

**Ownership:** `src/adapters/sites/zhaopin.js`；测试 `tests/zhaopin_readonly_smoke.js`、`tests/zhaopin_workflow_smoke.js`、`tests/fixtures/zhaopin/` 的合成内容。必要相邻测试可运行，不修改 storage/CLI/browser transport/communication 模块；确需扩大先告知主控。

**Interfaces:** 保持 `ZhaopinSiteAdapter` 公开接口；`waitForSearchReady` 同时被 dashboard 预检和沟通检查/恢复使用，改动须覆盖这些调用且不拆掉沟通已有 focus scope。`onProgressCheckpoint` 需要 storage 合法 activity=`searching|reading_detail|target_complete` 与完整冻结计数；`onTargetComplete` 同样需要五个计数。真实阶段仍是扫描完成后分析。

- [x] RED：合成后台页标题初始空，既有后台渲染开启后通过可见 DOM 出现；成功、超时、登录/风控、取消与清理失败分别证明 scope 释放，前台不变、无激活，不吞清理异常。不要以假 readSearchState 直接返回成功替代真实 helper 行为。考虑滚动新增卡片仍需要后台渲染，以及继承类沟通 scope 不被提前释放。选最小充分的有界作用域，不写新的全平台管理器；不能仅把超时加长或退回组件标题。
- [x] RED：同模板/关键词下，保存九项默认标签与当前新增默认融资阶段兼容；一旦出现具体筛选值、丢失原选中值、未知标签变化、URL/关键词变化仍拒绝。实现只忽略已验证的默认类别标签 `地区/薪资/学历/经验/公司性质/融资阶段/公司人数/工作性质/职位类别/公司行业`，保留其余实际选择的严格比较，不改已保存数据，不删除任意未知摘要。
- [x] RED：适配器真实 callback 接入临时 SQLite 的既有 checkpoint 函数，覆盖首次导航失败、读过一条再失败、正常 cardLimit 小于页面卡数、滚动后进度、暂停/恢复。检查不再产生 `SCAN_PROGRESS_INVALID`，错误仍保留原原因，已存 JD 不丢，恢复目标位置仍按完整冻结 targets 编号。
- [x] 实现最小局部进度构造并在所有输出路径复用：`targetPosition = targets.indexOf(target)+1`，`targetTotal=targets.length`；进度的 `targetDiscovered/detailTotal/detailPosition` 在当前 target.cardLimit 内且关系一致，用当前已知卡片与已完成条数计算，不以0覆盖已完成值。例：页面20卡、cardLimit2、成功2 => discovered2/detailTotal2/detailPosition2；导航未成功=> discovered0/detailTotal0/detailPosition0，但位置/总数仍1/3。不要截断实际保存的合格已读岗位以掩盖计数错误。
- [x] 跑最小RED确认后实现；定向GREEN至少覆盖 readonly、workflow、communication_adapter、dashboard_zhaopin 和 workflow_scan 相关；所有改动JS语法、diff --check；仅提交所有权文件，报告真实RED/GREEN/边界/疑点。由主控发独立任务复核。

## Task 2: 中断立即展示真实状态

**Ownership:** `src/dashboard/assets/workflow.js`；测试优先 `tests/workflow_dashboard_smoke.js`、`tests/workflow_page_migration_smoke.js`（按既有真实脚本覆盖选择）；仅必要时窄改 `src/dashboard/pages/workflow.js` 的数据属性。不要重写页面模型、错误系统或 core phaseKey 合同。

**Interfaces:** `/api/workflow-status` 给出 workflow.status、errorCode、progress.phaseKey、controls；server 已能正确展示中断页面及 stop-only 控制。

- [x] RED：从 rendered scanning 页开始，通过真实客户端脚本收到 interrupted、相同 acquisition phaseKey、canStop=true 的 snapshot；断言会加载正确的服务端中断页且只有一次导航，而不是静态匹配代码文本。验证 interrupted 后错误、继续/结束按钮可见，不再显示“没有阻塞”。
- [x] 实现：结构性的终态变化除 phaseKey 外也触发既有 reload 路径；在设置 dataset.status、停止轮询前正确判断，保留 reloadRequested 防重复。不要对每个 progressRevision/计数/控制值变化无限刷新；暂停/恢复、通信阶段、BOSS 现有流程保持原语义。
- [x] GREEN：覆盖同阶段终态、相同活动状态不刷新、已有阶段切换/暂停/停止；语法、diff --check、现有相关页面测试；仅提交所有权文件，提供报告，由主控独立任务复核。e0258bc 已通过一次真实RED、两项相关GREEN、语法/diff及规格/质量复核；既有SQLite实验警告记为非阻塞，不为消除输出而扩范围。

## 主控后续

- [x] 两任务定向复核关闭后重启仅拥有的隔离8788服务，不碰安装版或旧BOSS批次。1bc7879实际恢复保存4岗位/4JD，终态自动刷新已通过；新客户公司字段缺陷转入独立 `2026-09-09-zhaopin-panel-client-company.md`，不重开这两任务。
- [ ] 同一智联 interrupted run 使用正常“继续本轮”恢复，不暗改参数/数据库，验证扫描/分析，再选择至多一个可用新岗位。确实无法恢复时按页面安全结束；不得自动重试不确定写。
- [ ] 源码冻结后重跑严格完整门禁，记录真实数量/精确SHA；之后才可实发已授权普通初次招呼。消息原文/JD/模型/编辑保存的已有通过证据保留，不重复旧探测。
- [ ] 记录所有真实动作、当前不足与最终回到页面的验收入口；不把局部通过包装成整条通过。
