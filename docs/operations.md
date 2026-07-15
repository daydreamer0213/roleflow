# 运行与排错

## 日志

日志写入 `.runtime\logs\app-YYYY-MM-DD.jsonl`，单文件最大 5 MB，保留 21 天。诊断页展示最近 120 条脱敏事件。

记录内容：

- 时间、级别、组件、事件、请求编号和错误码。
- 扫描批次、方案 ID、岗位来源 ID 等定位元数据。
- 模型调用类型、提供商、模型、缓存命中、延迟、重试次数、HTTP 状态和 token 用量。

永不记录：

- API Key、Authorization、Cookie、Token、密码和 BOSS 登录态。
- 简历正文、JD 全文、模型输入输出、上传文件内容和 HTTP body。

日志写入失败不会中断用户流程。所有输出在写盘前统一脱敏。

## 标准排错

1. 记录页面显示的错误编号和请求编号。
2. 打开工作台“诊断”，按请求编号查最近事件。
3. 需要更完整的上下文时，搜索 `.runtime\logs` 下的 JSONL。
4. 运行 `npm.cmd test`。这 14 组离线测试不访问 BOSS。
5. 只有离线检查通过后，才在已登录 Edge 上做 3–5 条只读小样本验收。

常见错误码：

- `RESUME_UNSUPPORTED_FORMAT`：仅支持 TXT、MD、DOCX、PDF。
- `RESUME_FILE_TOO_LARGE`：文件超过 5 MB。
- `RESUME_DOCX_PARSE_FAILED` / `RESUME_PDF_PARSE_FAILED`：本地文本提取失败。
- `RESUME_TEXT_TOO_SHORT`：常见于扫描 PDF、图片简历或旧 `.doc`；改用粘贴文本。
- `MODEL_AUTH_FAILED`：Key 无效或没有权限。
- `MODEL_QUOTA_EXCEEDED`：余额或配额不足。
- `MODEL_RATE_LIMITED`：模型服务限流，稍后重试。
- `MODEL_NOT_FOUND`：基础地址或模型名不正确。
- `MODEL_CONTRACT_INVALID`：结构化输出不符合契约；系统会尝试一次契约修复，仍失败则进入待语义分析。
- `CANDIDATE_PROFILE_REQUIRED`：岗位分析未绑定候选人画像。
- `SEARCH_PLAN_STALE`：画像已有新版本，方案需要重新确认。
- `SCAN_START_FAILED`：扫描前置校验、浏览器连接或子进程启动失败。
- `BOSS_LOGIN_REQUIRED`：没有可用登录态。
- `BOSS_RISK_CONTROL`：发现验证、风控或异常重定向；本轮立即停止。
- `BOSS_PANE_SWITCH_TIMEOUT`：点击左侧卡片后右侧详情未正常切换。

## BOSS 安全处置

- 出现验证页、登录失效、结构异常或频繁超时时，立即停止，不自动刷新硬闯。
- 不同时运行多个扫描，不用多个标签并发点卡片。
- 留足冷却后再小样本验证；不要连续重跑整轮扫描。
- 本地模型分析可以有限并行，因为岗位内容已经落盘，不会增加 BOSS 请求频率。

## 数据库检查

主数据库为 `data\jobs.sqlite`。升级前先复制到 `data\backups`，再执行迁移和 `PRAGMA quick_check`。不得通过删除主库来解决显示或迁移问题。

岗位、观测、详情快照和候选人决策分开存储。重复扫描同一岗位不会删除历史未处理项，也不会覆盖已投、跳过、约面等状态。

## 边界

RoleFlow 只读采集岗位并保存本地人工决策，不会自动沟通、投递、发送消息或修改 BOSS 账号状态。
