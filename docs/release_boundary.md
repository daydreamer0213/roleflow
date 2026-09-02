# 交付与隐私边界

本文描述 v1.2.2 source candidate 的交付边界。历史版本以各自发布说明为准；不得把本候选的新行为写成旧版本已经交付的能力。

## 标准安装器

`BuildInstaller.bat` 生成 `dist\RoleFlow-Setup-<版本>.exe` 和 SHA-256 校验文件。安装器按当前用户安装，默认位置为 `%LOCALAPPDATA%\Programs\RoleFlow`，包含固定版 Node.js 与生产依赖，不在用户电脑运行 `npm ci` 或完整离线测试。

安装器提供 Windows 安装进度、开始菜单与可选桌面快捷方式、隐藏终端启动和标准卸载入口。卸载默认保留下方列出的用户数据；删除安装目录内的限定数据和删除专用浏览器登录资料是两个独立确认。

当前 source candidate 默认使用“RoleFlow 专用 Edge（推荐）”，不需要 Edge Control。Edge Control 不进入普通安装包，也不会由安装器自动下载；它只服务于显式的“使用当前 Edge（高级，需要浏览器连接组件）”。高级组件缺失或不健康时停止，不会自动切换浏览器。

## 便携绿色包

`BuildRelease.bat` 生成 `dist\RoleFlow-portable.zip`。默认包含代码、依赖、匿名样例和便携 Node.js；另一台 Windows 电脑解压后可运行。默认入口启动“RoleFlow 专用 Edge（推荐）”，不依赖 Edge Control；内部脚本和字段仍可保留 `portable`、CDP 与 `9222` 诊断名称。

运行条件：

- Windows 10/11。
- Microsoft Edge。
- 能访问用户选择的模型服务和 BOSS。

默认 `Start.bat` 使用“RoleFlow 专用 Edge（推荐）”：同一窗口必须正好有一个 `BOSS-SEARCH` 和一个 `BOSS-COMMUNICATION` 固定标签页。就绪检查只读；标签不完整、跨窗口、登录失效或风控信号都会停止并给出处理建议，不会自动回退或静默切换浏览器 authority（浏览器控制权）。

第一次在“RoleFlow 专用 Edge（推荐）”登录后，登录资料保存在 `%LOCALAPPDATA%\RoleFlow\BrowserProfile`。该目录独立于安装目录，可跨覆盖升级和安装目录变化复用。只有浏览器登录资料稳定：数据库、简历、模型设置、日志和报告不会从旧安装目录自动迁到新安装目录。

复用日常 Edge 是高级显式路径：`Start.bat -BrowserMode edge`。该路径要求现有 Edge Control 扩展与桥接健康；“RoleFlow 专用 Edge（推荐）”失败时绝不自动回退到高级模式。

## 不进入发布包

- `data\jobs.sqlite`、WAL/SHM 和备份：含简历、岗位、投递状态和模型缓存。
- `.runtime\secrets`：当前 Windows 用户 DPAPI 加密的 API Key。
- `%LOCALAPPDATA%\RoleFlow\BrowserProfile`：BOSS Cookie、登录态和浏览器数据；它位于安装/暂存目录之外，构建不得复制进去。
- `.runtime\logs`：本机诊断日志。
- `reports\`：历史报告。
- 真实候选人画像和真实简历文件。
- `vendor\edge-control-bridge`：“RoleFlow 专用 Edge（推荐）”不需要它，且 Edge Control 不进入普通交付包。

## 新电脑首次运行

1. 解压到用户可写目录。
2. 双击 `Install.bat` 做 Node、生产依赖和 Edge 环境检查；完整离线回归只在发布构建前执行。
3. 双击 `Start.bat`，在“RoleFlow 专用 Edge（推荐）”中登录 BOSS，并在同一窗口保留一个 BOSS 搜索页和一个 BOSS 沟通页。默认路径不需要 Edge Control。
4. 重新填写模型 Key；DPAPI 密文不能跨 Windows 用户或电脑复用。
5. 更换电脑时在新的“RoleFlow 专用 Edge（推荐）”中重新登录 BOSS，不复制旧电脑的浏览器 profile。只有显式需要复用日常 Edge 时，才准备连接组件并运行高级模式。
6. 上传简历、确认画像和 Search Plan 后再扫描。

## 安全边界

- 绿色包不会包含 API Key、简历、岗位数据库或 BOSS 登录态。
- 模型 Key 不写入源码、普通配置、SQLite 或日志。
- 扫描阶段只读取岗位卡片和详情，不点击沟通；固定沟通标签页在扫描期间保持不动。
- 沟通阶段必须先由用户选择并确认岗位清单，再由用户明确点击开始；执行器才会逐项核验并单次点击“立即沟通”。
- 首次真实校准点击仍需单独明确授权；本发布边界不自动沟通、不放宽校准或确认门禁。
- 浏览器就绪检查失败即停止，不会自动改用高级当前 Edge，也不会在同一运行中切换浏览器 authority。
- 用户启动工作区且未传 `-NoOpen` 时，启动助手可在就绪检查后引导一次前台。扫描、JD 读取、分析、消息发现、沟通、轮询、重试和恢复都保持后台。
- 两个固定 BOSS 页是静止基线。消息发现只有在新会话缺少完整可信本地 JD 时，才允许串行打开一个同窗口、`active: false` 的后台临时详情页，核验、保存并关闭后恢复基线。
- 项目不会后台定时沟通，不会绕过岗位身份校验重复点击，也不会自动填写或发送模型生成的定制文案。
- 云模型会收到用户主动提交的简历文本和待分析岗位内容；UI 必须在上传前明确提示。

## 迁移与卸载

旧 `.runtime\edge-profile` 不会自动迁移。关闭占用源或目标 profile 的 Edge 后，用户必须显式运行 `scripts\migrate-browser-profile.ps1 -SourceProfileDir <旧目录> -ConfirmMigration`。迁移只复制并核对内容，保留源目录；目标已存在、路径不安全或身份不清时停止。

普通交互卸载和静默卸载都保留 `%LOCALAPPDATA%\RoleFlow\BrowserProfile`。交互卸载只有在用户对“删除专用浏览器登录资料”单独确认后才删除它；删除安装目录内 RoleFlow 数据的确认不能替代这项授权。
