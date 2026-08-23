# RoleFlow 当前项目交接

> 当前权威交接入口。更新于 2026-08-24。新会话先读根目录 `AGENTS.md`、本文件和 `NEXT_PHASE.md`，再检查当前代码与测试；不要用历史聊天、旧计划或 v1.0.0 发布说明推断当前 source candidate。

## 1. 发布与候选状态

- 已发布正式版仍是 `v1.0.0`，下载资产为 GitHub Release 中的 `RoleFlow-Setup-1.0.0.exe`。
- 当前分支 `codex/stable-dedicated-edge` 是**尚未发布的 source candidate**。它包含 v1.0.0 之后的工作，但尚未推送、合并或发布。
- 当前候选的完整离线门禁：**已通过**。2026-08-24 在 HEAD `f384896227948926f9e3af515804ce8df9e04ab3` 加 Task 8 fix round 2 工作树上运行 `node tests/run_all.js`，退出码为 0，101/101 项通过，原始末行为 `All 101 offline checks passed.`。
- 当前候选没有执行新的真实 BOSS、真实 Edge、安装或卸载验收；历史真实验收不等于本候选已经验收。

## 2. 当前浏览器交付模型

- 默认普通路径是“RoleFlow 专用 Edge（推荐）”。`Start.bat` 和工作区启动默认使用内部 `portable` authority，但普通用户不需要安装 Edge Control，也不需要配置 CDP 或 `9222`。
- 第一次登录保存在 `%LOCALAPPDATA%\RoleFlow\BrowserProfile`。该目录独立于安装目录，覆盖升级或更换安装目录后继续复用。
- 只有浏览器登录资料跨安装目录稳定。数据库、简历、模型设置、日志、报告和其他 RoleFlow 数据仍属于各自安装目录，不会悄悄迁移到新目录。
- “使用当前 Edge（高级，需要浏览器连接组件）”必须显式运行 `Start.bat -BrowserMode edge`，并要求现有 Edge Control 扩展与桥接健康。“RoleFlow 专用 Edge（推荐）”失败时绝不自动回退、自动下载组件或切换 authority。
- Edge Control 不进入普通安装包或绿色包。

## 3. 浏览器安全边界

- 静止基线是同一 Edge 窗口内一个 `BOSS-SEARCH` 和一个 `BOSS-COMMUNICATION` 固定页；每次浏览器运行前重新解析当前绑定的数值 tab ID。
- 用户启动工作区且未传 `-NoOpen` 时，`workspace-tabs` 可在就绪检查后调用一次 `Page.bringToFront`，就绪时引导到 Dashboard，未登录时引导到 BOSS。
- 上述启动引导是唯一前台例外。扫描、JD 读取、分析、消息发现、沟通、轮询、重试和恢复期间禁止激活 BOSS 页、切换窗口或恢复前台焦点。
- 消息发现先复用完整可信的本地 JD。只有新会话缺少完整 JD 时，才允许增加一个同窗口、`active: false`、串行且受共享节奏保护的后台临时详情页；核验、保存、checkpoint 后关闭并恢复两页基线。
- 当前岗位详情产品主线只用 `trusted_pane`。`search_page_api` 保留研究证据但不修、不验、不启用；`message_discovery_detail` 是唯一允许的独立详情例外。
- 登录、风控、页面丢失、标签身份漂移、目标不一致或结果不明确时立即停止，不自动重试。
- BOSS 默认只读。沟通、发送或申请等外部写动作仍需要针对不可变批次的明确授权；历史接受状态不是新批次授权。

## 4. 浏览器 profile 迁移与卸载

- 旧安装目录的 `.runtime\edge-profile` 不会自动迁移。迁移必须显式传入源目录并加 `-ConfirmMigration`。
- `scripts\migrate-browser-profile.ps1` 只复制、核对并写入稳定目录，不移动或删除源目录；目标已存在、路径重叠/不安全、身份不完整或 Edge 正在占用时停止。
- 普通交互卸载和静默卸载都保留 `%LOCALAPPDATA%\RoleFlow\BrowserProfile`。
- 删除浏览器登录资料需要单独确认；删除安装目录内数据库等数据的确认不能替代 profile 删除授权。

## 5. 产品与架构边界

- 继续使用渐进式模块化单体，不做大爆炸拆分、微服务、ORM、依赖注入容器或前端框架迁移。
- 不降低 JD 覆盖、召回或匹配质量。可能降低质量的方案必须先量化并由用户决定。
- 筛选规则实质变化后必须使用全新空 operational baseline；失败或中断数据库不参与质量评测。
- 不启动 Wave 5，不修当前产品路径不可触发的理论问题。
- 测试使用保存 fixture、注入式进程/HTTP 探针和临时数据库，不访问 BOSS，也不再创建假的 `msedge.exe`。

## 6. 当前验证与交接协议

- 危险夹具扫描、`node tests/run_all.js`、installer `StageOnly`、`git diff --check` 和 `git status --short` 均为当前候选的必做离线门禁。
- 以上 101/101 记录只证明 2026-08-24 当时的 HEAD `f384896227948926f9e3af515804ce8df9e04ab3` 与 Task 8 fix round 2 工作树；尚未产生的修正提交 SHA 没有在这条记录中虚构。后续代码变化必须重新运行并记录实际结果。
- 交付必须列出修改文件、验证命令与结果、未验证前提、真实平台读写情况、stage 路径和提交哈希。
- 不自动推送、合并、发布、安装、卸载、启动 Edge、访问真实 BOSS 或执行外部写；这些动作分别需要用户授权。

## 7. 事实优先级

1. 当前代码、测试和本次实际运行证据；
2. `src/core/product_policy.js` 等当前策略源码；
3. `AGENTS.md`、本文件、`NEXT_PHASE.md` 和当前产品文档；
4. v1.0.0 发布说明、历史验收、spec、plan、报告和聊天记录。
