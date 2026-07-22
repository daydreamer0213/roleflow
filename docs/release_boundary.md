# 交付与隐私边界

## 绿色包

`BuildRelease.bat` 生成 `dist\RoleFlow-portable.zip`。默认包含代码、依赖、匿名样例和便携 Node.js；另一台 Windows 电脑解压后可运行，不依赖 Codex 或 Edge Control 插件。

运行条件：

- Windows 10/11。
- Microsoft Edge。
- 能访问用户选择的模型服务和 BOSS。

项目专用 Edge 通过本机 CDP 控制，不安装浏览器扩展。兼容的 Edge Control bridge 保留在源码项目中，但不是绿色包正常运行的依赖。

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
2. 双击 `Install.bat` 做环境与完整离线回归检查。
3. 双击 `Start.bat`。
4. 重新填写模型 Key；DPAPI 密文不能跨 Windows 用户或电脑复用。
5. 在项目专用 Edge 中重新登录 BOSS，不复制旧电脑的浏览器 profile。
6. 上传简历、确认画像和 Search Plan 后再扫描。

## 安全边界

- 绿色包不会包含 API Key、简历、岗位数据库或 BOSS 登录态。
- 模型 Key 不写入源码、普通配置、SQLite 或日志。
- 扫描阶段只读取岗位卡片和详情，不点击沟通。
- 沟通阶段必须先由用户选择并确认岗位清单，再由用户明确点击开始；执行器才会逐项核验并单次点击“立即沟通”。
- 项目不会后台定时沟通，不会绕过岗位身份校验重复点击，也不会自动填写或发送模型生成的定制文案。
- 云模型会收到用户主动提交的简历文本和待分析岗位内容；UI 必须在上传前明确提示。
