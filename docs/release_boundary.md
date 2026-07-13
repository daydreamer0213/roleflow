# 交付与隐私边界

`BuildRelease.bat` 会生成 `dist\RoleFlow-portable.zip`。它包含项目代码、Node 依赖、匿名示例画像和可选的便携 Node；解压后可在另一台 Windows 电脑上运行，不依赖 Codex 或 Edge Control 插件。

默认不打包：

- `data\jobs.sqlite` 与 WAL 文件：投递状态、跟进记录和模型缓存。
- `.runtime\edge-profile`：BOSS 登录态、cookies 与浏览器个人数据。
- `reports\`：历史岗位报告。
- `vendor\edge-control-bridge`：上游许可未明确的本地 vendor 副本。

`BuildRelease.bat` 使用 `-IncludePortableNode`，因此打包前需要先运行一次 `scripts\install.ps1 -InstallPortableNode`。未包含便携 Node 的包仍可使用本机 Node.js 22+；没有 Node 时，`Install.bat` 会下载到项目自己的 `.runtime\node`。

首次在新机器使用：双击 `Install.bat`，在弹出的项目专用 Edge 中重新登录 BOSS，再在工作台上传或更新简历。不要复制旧电脑的 `.runtime\edge-profile`。

这个项目只读取岗位信息并在本地保存人工决策；不会自动点击“立即沟通”、投递或发送消息。模型 Key 只从环境变量读取，不写入发布包配置文件。
