# 交付与隐私边界

## 标准安装器

`BuildInstaller.bat` 生成 `dist\RoleFlow-Setup-<版本>.exe` 和 SHA-256 校验文件。安装器按当前用户安装，默认位置为 `%LOCALAPPDATA%\Programs\RoleFlow`，包含固定版 Node.js 与生产依赖，不在用户电脑运行 `npm ci` 或完整离线测试。

安装器提供 Windows 安装进度、开始菜单与可选桌面快捷方式、隐藏终端启动和标准卸载入口。卸载默认保留下方列出的用户数据；明确二次确认后才删除当前安装目录内经过限定的数据子目录。

Edge Control 目前不进入安装包，也不会由安装器自动下载。缺失或不健康时，普通 Edge 主路径停止并显示依赖说明，不会自动切换到 portable/CDP。这个外部依赖限制意味着当前安装器不能宣称在全新电脑上“一键完成浏览器连接”。

## 便携绿色包

`BuildRelease.bat` 生成 `dist\RoleFlow-portable.zip`。默认包含代码、依赖、匿名样例和便携 Node.js；另一台 Windows 电脑解压后可运行。普通 Edge 默认复用当前已登录会话，但需要健康的 Edge Control 扩展和桥接；显式 portable/CDP 入口仍保留，不依赖 Edge Control 插件。

运行条件：

- Windows 10/11。
- Microsoft Edge。
- 能访问用户选择的模型服务和 BOSS。

默认 `Start.bat` 使用普通 Edge：同一窗口必须正好有一个 `BOSS-SEARCH` 和一个 `BOSS-COMMUNICATION` 固定标签页，且 Edge Control 扩展/桥接健康。就绪检查只读；缺少扩展或桥接、标签不完整、跨窗口、登录失效或风控信号都会停止并给出处理建议，不会自动回退或静默切换浏览器 authority（浏览器控制权）。

项目专用 Edge 通过本机 CDP 控制，作为用户显式选择的 portable 备用模式：`Start.bat -BrowserMode portable` 固定使用 `9222` 和 `.runtime\edge-profile`，需要独立登录 BOSS。该入口及现有 portable/CDP 安装、扫描和发布支持继续保留。

## 不进入发布包

- `data\jobs.sqlite`、WAL/SHM 和备份：含简历、岗位、投递状态和模型缓存。
- `.runtime\secrets`：当前 Windows 用户 DPAPI 加密的 API Key。
- `.runtime\edge-profile`：BOSS Cookie、登录态和浏览器数据。
- `.runtime\logs`：本机诊断日志。
- `reports\`：历史报告。
- 真实候选人画像和真实简历文件。
- `vendor\edge-control-bridge`：便携 CDP 模式不需要它，且不扩大绿色包体积。

## 新电脑首次运行

1. 解压到用户可写目录。
2. 双击 `Install.bat` 做 Node、生产依赖和 Edge 环境检查；完整离线回归只在发布构建前执行。
3. 双击 `Start.bat`；启动前在同一普通 Edge 窗口保留一个 BOSS 搜索页和一个 BOSS 沟通页，并确认 Edge Control 扩展/桥接健康。若需要独立环境，才手动使用 `Start.bat -BrowserMode portable` 并在 `.runtime\edge-profile` 中重新登录。
4. 重新填写模型 Key；DPAPI 密文不能跨 Windows 用户或电脑复用。
5. 普通 Edge 模式使用当前已登录会话；portable 模式需在项目专用 Edge 中重新登录 BOSS，不复制旧电脑的浏览器 profile。
6. 上传简历、确认画像和 Search Plan 后再扫描。

## 安全边界

- 绿色包不会包含 API Key、简历、岗位数据库或 BOSS 登录态。
- 模型 Key 不写入源码、普通配置、SQLite 或日志。
- 扫描阶段只读取岗位卡片和详情，不点击沟通；固定沟通标签页在扫描期间保持不动。
- 沟通阶段必须先由用户选择并确认岗位清单，再由用户明确点击开始；执行器才会逐项核验并单次点击“立即沟通”。
- 首次真实校准点击仍需单独明确授权；本发布边界不自动沟通、不放宽校准或确认门禁。
- 浏览器就绪检查失败即停止，不会自动启动 portable Edge，也不会在同一运行中切换浏览器 authority。
- 项目不会后台定时沟通，不会绕过岗位身份校验重复点击，也不会自动填写或发送模型生成的定制文案。
- 云模型会收到用户主动提交的简历文本和待分析岗位内容；UI 必须在上传前明确提示。
