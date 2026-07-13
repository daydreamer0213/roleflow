# 运行与排错

## 日志

日志写入项目目录的 `.runtime\logs\app-YYYY-MM-DD.jsonl`。每个文件最大 5MB，保留最近 21 天；日志按 JSON Lines 存储，方便用编辑器、PowerShell 或脚本筛选。

不会写入日志的内容：简历正文、JD 全文、上传文件内容、请求 body、API Key、Authorization、Cookie、BOSS 登录态。

会记录：时间、级别、组件、事件、请求编号、错误码、持续时间、扫描批次或画像 ID 等必要元数据。

## 诊断流程

1. 页面出错时先记录 `错误编号` 和 `请求编号`。
2. 打开本地工作台的“诊断”页，查看最近的脱敏日志摘要。
3. 需要细节时查看对应 JSONL 中同一 `requestId` 的记录。
4. 运行 `powershell -ExecutionPolicy Bypass -File .\run.ps1 check`；HTTP 上传问题再运行 `node tests\onboarding_smoke.js`。

常用错误码：

- `RESUME_UNSUPPORTED_FORMAT`：文件格式不支持。
- `RESUME_FILE_TOO_LARGE`：文件超过 5MB。
- `RESUME_DOCX_PARSE_FAILED` / `RESUME_PDF_PARSE_FAILED`：文档无法抽取文本。
- `RESUME_TEXT_TOO_SHORT`：常见于扫描 PDF、图片简历或旧版 `.doc`；改用粘贴简历文本。
- `MODEL_CONTRACT_INVALID`：模型响应不符合结构化契约，系统会保留规则回退和日志。
- `SCAN_START_FAILED`：扫描前置校验、浏览器连接或子进程启动失败。

## 边界

日志用于本机排错，不会上传。扫描仍是只读；不会自动沟通、投递或修改 BOSS 账号状态。
