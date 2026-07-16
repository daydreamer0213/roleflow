# RoleFlow 健壮性与可维护性审计

审计日期：2026-07-16

## 结论

RoleFlow 当前适合“用户在场、可观察、可人工恢复”的日常试用，尚不适合无人值守长时间运行。

- 数据安全：B+。SQLite WAL、稳定岗位 ID、批次 observation、模型缓存和岗位级状态能保住大部分已完成工作。
- BOSS 访问安全：B-。单标签串行、随机节奏、冷却、风险页识别和跨进程租约已经存在，但浏览器传输层没有完整超时与错误分类。
- 故障恢复：C。目标级结果和待分析状态存在，但没有持久化扫描生命周期，也不能按未完成目标恢复。
- 可观测性：B-。日志结构化、脱敏且能记录模型耗时与请求 ID，但缺少贯穿网页子进程、批次和恢复任务的统一 runId。
- 可维护性：C+。测试覆盖较好，但扫描编排、网页进程管理和数据层存在明确耦合点。

## 已验证的可靠部分

1. 真实小样本从首屏继续加载到 20 张卡片，目标记录为 `card_limit_reached`，3 次滚动、1 次增长，不再把首屏 15 条误报为完整结果。
2. 当前主库 `PRAGMA quick_check=ok`；整改前后仍为 124 个岗位、161 条 observation、5 条人工状态。
3. 同一 BOSS 数据库只能持有一个扫描租约；租约每分钟续期，进程异常后约 10 分钟自动过期。
4. 每个搜索目标结束后会保存岗位来源事实；模型分析中断时，岗位保持 `analysis_pending`，不会伪装成主投。
5. 模型调用有单请求超时、有限重试、JSON mode 回退、契约修复、缓存和失败日志。
6. 日志默认遮蔽 API Key、Authorization、简历正文、JD 正文和文件信息，并按大小、日期轮转。
7. 全套 14 组离线检查通过，包含 31 条人工岗位匹配样本。

## 最高优先级缺口

### R-001 部分采集被报告为成功

真实历史日志中，`2026-07-16T02:13:06Z` 在第 3 个关键词读取右栏时触发 `BOSS_RISK_CONTROL`。程序停止了后续 BOSS 页面动作，但继续分析已采集岗位约 4 分 45 秒，最终写入 `scan_completed`。

这保证了已采数据不丢，但用户看到的是“完成”，无法区分完整扫描与风控中断。

整改：新增持久化扫描运行状态 `running/completed/partial/failed/interrupted`。风控或页面丢失后允许完成本地分析与落库，但最终状态必须是 `partial`，页面明确显示停止原因、已完成目标、未完成目标和恢复入口。

### R-002 浏览器传输层可能无限等待或错误继续扩散

`EdgeControlAdapter.command()` 和 CDP 的 HTTP 列表请求没有 AbortController 超时；Edge bridge 断连错误也没有稳定错误码。BOSS 编排只把少数 `BOSS_*` 错误视为致命错误，普通 bridge 超时可能被当作单关键词失败并继续尝试下一个关键词。

整改：为 Edge/CDP HTTP 命令设置 10-15 秒超时，统一为 `BROWSER_TIMEOUT/BROWSER_DISCONNECTED/BROWSER_COMMAND_FAILED`；连接中断属于整轮致命错误。只对只读状态查询做一次随机退避重试，导航和点击先核对页面状态再决定是否重试，不能盲目重复动作。

### R-003 检查点不能真正恢复

`scan_target_results` 会记录每个目标的完成、部分或失败状态，但新一轮扫描不会读取这些记录，也不会跳过同一筛选快照中已完成的目标。`attempt_number` 当前只是记录，不构成恢复机制。

整改：扫描运行保存计划 ID、筛选快照哈希、关键词目标集合和当前状态。恢复时只继续 `partial/failed/not_started` 目标；已完成目标直接复用同批 observation。筛选条件变化时禁止错误续跑旧批次。

### R-004 批次与岗位写入不是同一个原子检查点

目标回调先写 `scan_target_results`，再逐条 upsert 岗位；进程若在中间退出，目标可能显示完成但岗位尚未全部保存。`upsertJob` 更新 jobs 与 observation 也未包在同一事务中。

整改：一个目标的结果、岗位 current row 和 observation 在一个短事务内提交。SQLite 增加 `busy_timeout`，避免网页进程与 CLI 短暂写竞争直接失败。

## 中优先级缺口

### R-005 模型重试可恢复但不够可控

- 超时错误没有稳定 `MODEL_TIMEOUT` 代码，最终常退化成 `MODEL_ANALYSIS_FAILED`。
- 429/5xx 只做 250ms 级短退避，不读取 `Retry-After`，也没有抖动。
- 单岗位失败能保留，但没有“一次重试本批失败岗位”的批量恢复入口。

整改：补充稳定错误码、指数退避与随机扰动，尊重 `Retry-After`；达到上限后保持 `analysis_pending`。页面提供按批次重试失败分析，自动降低并发，不重新访问 BOSS。

### R-006 网页子进程状态只存在内存

Dashboard 的 `scanRuns` 是内存 Map。网页进程重启后只能通过租约知道“某个任务仍运行”，看不到输出、进度和最终结果；子进程也没有总时限、心跳状态或安全停止入口。

整改：扫描运行与心跳落库，Dashboard 只展示数据库状态。增加“完成当前页面动作后停止”，不做强制并发控制或粗暴 kill；进程失联后标记 `interrupted`。

### R-007 简历本地解析缺少执行超时

DOCX PowerShell 使用 `spawnSync` 但未设置 timeout；PDF 解析也没有外层超时。异常文件可能长时间占住 Dashboard 请求。

整改：DOCX/PDF 各设置明确超时并返回 `RESUME_DOCX_TIMEOUT/RESUME_PDF_TIMEOUT`，继续保留“粘贴文本”兜底。

### R-008 数据库迁移缺少版本与自动备份

当前迁移通过检查列是否存在来执行，没有 `user_version`/迁移版本历史，也不会在结构升级前自动做一致性备份。长期升级时难以判断某台机器执行到了哪一步。

整改：采用顺序迁移版本；仅在 schema version 提升时执行 `VACUUM INTO` 备份、迁移、`quick_check`，失败自动停止并保留旧库，不在每次启动重复备份。

### R-009 日志完整但运行关联不足

Dashboard 和 CLI 各自生成 sessionId。虽然多数扫描日志带 batchId，但从网页请求、子进程、扫描批次到恢复任务没有统一 runId；日志写失败被静默吞掉，健康页仍显示 logging enabled。

整改：Dashboard 创建 runId 并传给 CLI，所有扫描、模型和恢复日志同时带 runId/batchId/targetKey。Logger 记录最近一次写失败，`/health` 和诊断页可见，但日志故障仍不能阻断投递数据保存。

### R-010 配置所有权不清，旧口径可从旁路重新进入

这不是“完全没有配置文件”，而是同一策略存在多个来源，且缺少统一的解析结果和明确优先级。当前已确认：

1. 当前数据库 Search Plan 的扫描预算是 `50/220/40`，`search_plan.js` 的日常策略也是 `50/220/40`；但 `profile_schema.js` 和 Dashboard 高级设置仍各自使用 `60/300/90` 作为默认值。页面、持久化方案和实际执行因此可能显示不同口径。
2. `ScanPortable.bat` 仍传入 `-MaxCards 60 -DetailLimit 5`。其中 `DetailLimit` 已从 `scan-portable.ps1` 删除，实际运行会在参数绑定阶段直接失败；`MaxCards 60` 又会覆盖当前方案。现有测试只检查脚本包含 `--plan`，没有执行启动参数契约。
3. `configs/keywords.yaml`、`configs/profile.example.json`、`profiles/example_profile.json` 和 `profiles/example_resume_versions.json` 仍包含广州、AI/Python、旧薪资及 GAP 等样例口径。正式 Search Plan 扫描会覆盖其中大部分字段，但 JSON 输入、无 Plan CLI 和兼容 keyword planner 仍可能启用这些后备值。
4. 薪资策略同时来自 Search Plan、`scoring.yaml`、`search_plan.js` 和 `scoring.js`。例如 `hard_max_k` 在运行时还会叠加代码中的 `+12`，导致配置字段名称无法直接说明最终阈值。
5. 近 3 天活跃、经验选项、扫描预算、详情补读数量和页面说明散落在 schema、Dashboard、CLI、adapter、文档和测试中。部分重复是合理的断言，但当前没有测试证明“页面预览值 = CLI 最终值 = 批次实际值”。

根因：历史改造为了兼容旧 CLI、样例配置和发布脚本，持续增加后备值，却没有在新 Search Plan 主链路稳定后删除旁路；同时用户偏好、产品默认、平台安全常量和算法阈值没有明确分层。

整改原则不是建立一个包含所有数字的巨型配置文件，而是让每个参数只有一个权威所有者：

- CandidateProfile 和 Search Plan：保存用户事实、求职偏好、关键词及广泛扫描预算，权威来源为 SQLite。
- Product Policy：保存日常扫描默认值、活跃有效期、评分分池阈值等产品策略，由一个版本化模块提供。
- BOSS Adapter Policy：保存页面字段、卡片权重、随机等待、冷却和安全硬上限；不暴露为普通用户设置。
- Runtime Override：CLI 覆盖只保留给开发诊断，并在日志和批次快照中显式记录；网页与发布脚本默认不得偷偷覆盖 Search Plan。
- Example/Test Data：只能用于首次示例和测试，禁止作为生产扫描的候选人后备画像。

执行顺序：在阶段 A 之前先做一次最小配置收口。原因是阶段 A 需要持久化 scan run 和筛选快照；若此时仍有多个参数来源，恢复任务可能用新默认值续跑旧批次，检查点语义仍然不可靠。

## 耦合判断

### 需要拆的边界

1. `src/cli.js` 同时负责命令解析、扫描编排、来源落库、模型分析和报告生成；Dashboard 又通过字符串参数启动 CLI。应提取一个 `scan_workflow`，CLI 和 Dashboard 子进程共同调用，避免入口规则再次漂移。
2. `src/dashboard/server.js` 同时包含 HTTP 路由、扫描进程管理和页面渲染。优先只抽出持久化 `scan_run_manager`；页面模板暂时不拆，避免大面积 UI 回归。
3. `src/core/storage.js` 反向依赖 BOSS adapter 的活跃度解析，也直接调用评分与模型硬阻断逻辑。应让 adapter/domain 先归一化事实，storage 只保存和查询；这也是未来接入智联等平台前必须解除的层级反转。

### 暂时不拆的部分

1. `boss.js` 虽然较大，但 DOM 选择器、双栏切换、节奏和 BOSS URL 规则都属于同一平台变化面。先增加故障契约和夹具测试，不立即拆成多层类。
2. `storage.js` 不按“一个表一个文件”机械拆分。完成迁移器、扫描生命周期和层级反转后，再根据真实修改频率分文件。
3. 不引入消息队列、任务框架或微服务。当前单机 SQLite + 子进程足够，先把状态机与恢复语义做正确。

## 建议整改顺序

### 阶段 0：配置所有权收口

1. 建立参数所有权清单与固定优先级：显式诊断覆盖 > 已确认 Search Plan > Product Policy 默认；平台安全硬上限不允许被普通配置突破。
2. 提供唯一的运行策略解析函数，Dashboard 预览、CLI 扫描、批次日志和后续恢复都使用同一份 resolved policy。
3. 删除发布脚本的旧参数，隔离 AI/Python 样例后备值，消除 schema、页面和运行时的重复默认值。
4. 为 resolved policy 生成版本与哈希，并随批次保存；参数变化后禁止静默续跑旧快照。

验收：同一 Search Plan 分别从 Dashboard、CLI 和发布脚本启动，得到完全相同的关键词、城市、薪资档、经验档和预算；页面展示值与批次快照一致；无画像/无 Plan 时不得带入广州、AI/Python、旧薪资或 GAP 样例口径；`ScanPortable.bat` 参数契约测试真实执行通过。

### 阶段 A：状态真实与可恢复

1. 持久化 scan run、批次最终状态和停止原因。
2. 修复风控中断仍显示完成。
3. 原子提交目标检查点与岗位 observation。
4. 支持按相同筛选快照恢复未完成目标。
5. 增加 Edge/CDP 超时和致命错误分类。

验收：注入第 3 个关键词风控、bridge 断连和进程退出；已采岗位不丢，运行显示 partial/interrupted，恢复后不重复已完成关键词。

### 阶段 B：模型、解析与诊断兜底

1. 模型稳定错误码、Retry-After、指数退避和批量失败重试。
2. DOCX/PDF 解析超时。
3. runId 贯穿日志，健康页报告日志写入状态。
4. 数据库 busy timeout、版本迁移和升级前备份。

验收：注入模型超时、429、非法 JSON、日志目录不可写、损坏 DOCX/PDF 和 SQLite 写竞争；页面都有明确错误码和下一步，已保存数据不回滚。

### 阶段 C：最小必要解耦

1. 提取 `scan_workflow` 和 `scan_run_manager`。
2. 移除 storage 对 BOSS adapter 的反向依赖。
3. Dashboard/CLI 对同一工作流跑契约测试。

验收：网页与 CLI 对同一输入产生相同目标集合、检查点、批次状态和错误分类；新增一个假平台 adapter 时无需修改 storage。

## 长期维护门槛

每次发布至少执行：

1. 14 组离线回归与故障注入测试。
2. 临时数据库迁移、回滚备份和 `quick_check`。
3. 单关键词 10-20 卡真实只读探针；不为测试跑全量 BOSS。
4. 人工核对 3 个岗位的左卡、右栏、活跃度、详情和最终匹配证据。
5. 检查日志无 API Key、简历正文和 JD 正文泄露。
6. 对同一 Search Plan 比较 Dashboard、CLI、发布脚本的 resolved policy 哈希，禁止入口间配置漂移。
7. 只有来源、模型、配置快照、持久化和恢复状态全部可解释时才标记可发布。
