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
4. 运行 `npm.cmd test`。当前 41 项离线检查不访问 BOSS。
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
- `WORKFLOW_SCAN_INTERVAL`：距离上一轮扫描开始不足 2 小时；等待页面提示的时间后再启动。
- `WORKFLOW_DAILY_RUN_LIMIT`：当天已创建 3 轮任务。
- `COMMUNICATION_QUOTA_EXHAUSTED`：所选岗位超过当天剩余沟通额度。
- `COMMUNICATION_RESULT_AMBIGUOUS`：点击后无法可靠确认聊天状态；必须人工复核，不能自动重放。
- `COMMUNICATION_RESUME_REQUIRES_REVIEW`：中断点存在未完成单项，恢复前需要人工处理。

## BOSS 安全处置

- 出现验证页、登录失效、结构异常或频繁超时时，立即停止，不自动刷新硬闯。
- 不同时运行多个扫描，不用多个标签并发点卡片。
- 两次正式扫描开始时间至少间隔 2 小时；不要为了凑数量连续追加扫描。
- 留足冷却后再小样本验证；不要连续重跑整轮扫描。
- 本地模型分析可以有限并行，因为岗位内容已经落盘，不会增加 BOSS 请求频率。

## 工作流恢复

- 扫描、模型分析、清单确认和沟通批次分别保存状态，并通过 workflow、scan run、scan batch、communication batch ID 关联。
- 扫描中断时继续原轮次和检查点，不创建新轮次来绕过失败。
- 工作流处于 `review_required` 时可以关闭程序，之后继续确认清单。
- 沟通处于 `paused` 或安全中断状态时可由用户恢复；`click_dispatched` 等不明确状态不会自动再次点击。
- 重启只执行本地失联校准，不会自行导航 BOSS 或继续沟通。

## 数据库检查

主数据库为 `data\jobs.sqlite`。升级前先复制到 `data\backups`，再执行迁移和 `PRAGMA quick_check`。不得通过删除主库来解决显示或迁移问题。

岗位、观测、详情快照和候选人决策分开存储。重复扫描同一岗位不会删除历史未处理项，也不会覆盖已投、跳过、约面等状态。

## 边界

扫描链路只读采集岗位。沟通链路只有在用户选择岗位、确认清单并明确点击开始后才会串行操作 BOSS；每项都要先核验岗位身份并在点击后验证结果。项目不会后台定时沟通，也不会自动填写或发送模型生成的定制文案。
