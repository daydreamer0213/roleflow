# 运行与排错
 
## 流程体检

工作流页面会显示只读的流程体检摘要。体检结果不会自动修复、重新分析、扫描或沟通。各检查项目和人工处理方式见 [流程体检](workflow_health.md)。

## 结果统计（只读）

结果统计面板的范围和人工调整要求见 [结果统计（只读）](outcome_analytics.md)。该面板不发起模型调用、不操作 BOSS，也不写入数据库。

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
4. 运行 `node tests/run_all.js`。当前注册 108 项离线检查，不访问 BOSS；启动边界测试使用注入的进程与 HTTP 探针，不再生成假的 `msedge.exe`。发布时必须以标签所指精确提交重新运行 108/108 门禁，不能沿用历史计数。
5. 只有离线检查通过后，才在已登录 Edge 上做 3–5 条只读小样本验收。

## 浏览器登录资料

- 默认入口是“RoleFlow 专用 Edge（推荐）”，不需要 Edge Control。登录资料固定在 `%LOCALAPPDATA%\RoleFlow\BrowserProfile`，覆盖升级或更换安装目录后继续复用。
- 只有浏览器登录资料跨安装目录稳定。`data\jobs.sqlite`、简历、模型设置、日志和报告仍属于原安装目录，安装到新目录不会自动复制这些数据。
- “使用当前 Edge（高级，需要浏览器连接组件）”必须显式运行 `Start.bat -BrowserMode edge`，并要求已有 Edge Control 扩展与桥接健康；“RoleFlow 专用 Edge（推荐）”失败时绝不自动回退。

从旧安装目录迁移浏览器登录资料时，先关闭占用源或目标 profile 的 Edge，再执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\migrate-browser-profile.ps1 -SourceProfileDir "旧目录\.runtime\edge-profile" -ConfirmMigration
```

迁移是显式、只复制、保留源目录的操作。脚本会拒绝缺少确认、目标已存在、源/目标重叠、路径身份不完整或仍被 Edge 占用的情况；成功标志为 `PROFILE_MIGRATION_OK`。

普通交互卸载默认保留浏览器登录资料；静默卸载也保留。删除 `%LOCALAPPDATA%\RoleFlow\BrowserProfile` 必须在交互卸载中对“删除专用浏览器登录资料”单独确认，不能把删除安装目录内数据的确认当成 profile 删除授权。

## Dashboard 与只读数据库检查

以下命令都在项目根目录执行。查询语句只使用 `SELECT`/`PRAGMA`，不会改写任务状态，也不会访问 BOSS。`openDb()` 会检查 schema 版本；如果数据库很旧，程序可能先自动备份并执行已设计好的迁移，因此诊断旧库或备份时应先复制数据库，再运行这些命令。

### 启动本地 Dashboard

```powershell
node src/cli.js dashboard
```

终端会打印 `http://127.0.0.1:8787/`，在浏览器打开即可。Dashboard 启动时会做一次本地工作流恢复校准（例如回收已过期租约、标记孤儿子进程），因此它不是“完全零写入”的查询命令；它不会自动导航 BOSS、发起沟通或发送消息。按 `Ctrl+C` 停止本地 Dashboard。

### 查看最近 5 轮工作流

```powershell
node -e "const {openDb}=require('./src/core/storage'); const db=openDb('data/jobs.sqlite'); console.log(db.prepare('select id,status,control_state,error_code,recovery_generation,circuit_timeout_job_count,lifetime_timeout_job_count,last_activity_at from workflow_runs order by created_at desc limit 5').all()); db.close()"
```

重点看：`status`（如 `analyzing`、`paused`、`interrupted`、`stopped`）、`control_state`（`none`、`pause_requested`、`stop_requested`）、`recovery_generation`、两个超时计数，以及 `last_activity_at`。不要把返回结果复制到公开工单中，工作流 ID 也应按需遮盖。

### 按工作流聚合任务状态

```powershell
node -e "const {openDb}=require('./src/core/storage'); const db=openDb('data/jobs.sqlite'); console.log(db.prepare('select workflow_run_id,status,count(*) as task_count from workflow_job_tasks group by workflow_run_id,status order by workflow_run_id,status').all()); db.close()"
```

`workflow_job_tasks.status` 的合法值是 `pending`、`running`、`retry_pending`、`succeeded`、`failed`、`skipped`、`stopped`。Dashboard 的“成功/处理中/等待重试/失败/剩余”由这些行聚合；`剩余`等于 `pending + running + retry_pending`。

### 查看最近脱敏岗位尝试

```powershell
node -e "const {openDb}=require('./src/core/storage'); const db=openDb('data/jobs.sqlite'); console.log(db.prepare('select id,workflow_run_id,task_id,recovery_generation,attempt_in_generation,total_attempt_number,profile_kind,model_config_revision,provider,model,thinking_mode,reasoning_effort,backup_used,status,error_code,error_stage,retryable,model_call_count,prompt_tokens,completion_tokens,total_tokens,started_at,finished_at,latency_ms from job_analysis_attempts order by coalesce(finished_at,updated_at,created_at) desc,id desc limit 20').all()); db.close()"
```

这条查询只取尝试编号、模型身份、状态、稳定错误码/阶段、重试标志、token 计数和时间；表本身也不保存 `error_message`、输入、输出或提示词。不要自行拼接 JD、简历或 API Key 到诊断文本中。

### 判断是否有过期租约

租约过期是“任务仍为 `running`，但 `lease_expires_at` 不晚于检查时刻”。用参数传入当前 ISO 时间，避免把 `T` 格式和 SQLite 的时间字符串混比：

```powershell
node -e 'const {openDb}=require("./src/core/storage"); const db=openDb("data/jobs.sqlite"); const now=new Date().toISOString(); const rows=db.prepare("select workflow_run_id,id,status,attempt_count_in_generation,total_attempt_count,lease_owner,leased_at,lease_expires_at,last_error_code,updated_at from workflow_job_tasks where status = ? and lease_expires_at is not null and lease_expires_at <= ? order by lease_expires_at").all("running",now); console.log({now,rows}); db.close()'
```

返回行表示在这次检查时租约已过期；没有返回行不代表没有任务，只代表当前没有已过期的 `running` 租约。恢复逻辑会把仍有岗位级重试额度的任务变成 `retry_pending`，用尽额度的变成 `failed`，并记录 `LEASE_EXPIRED`；不要手工改这些行。

### 区分暂停原因和孤儿中断

先用上面的工作流查询，再按 `status` 与 `error_code` 对照：

| 看到的组合 | 含义与处理 |
| --- | --- |
| `status = 'paused'` 且 `error_code` 为空 | 用户点击了 **“暂停本轮”**，属于可恢复的手动暂停；确认没有未处理的页面提示后可点“继续本轮”。 |
| `status = 'paused'` 且 `error_code = 'MODEL_TIMEOUT_CIRCUIT_OPEN'` | 当前恢复周期第 10 个最终 `MODEL_TIMEOUT` 打开超时熔断。先在“模型设置”里对 `batch_screening` 点击 **“测试连接并保存”**，再回到本轮点 **“继续本轮”**。 |
| `status = 'paused'` 且 `error_code = 'MODEL_AUTH_REQUIRED'` | 鉴权/Key 问题。最近尝试通常会有 `MODEL_KEY_REQUIRED` 或 `MODEL_AUTH_FAILED`；修复 Key 后重新测试并保存。 |
| `status = 'paused'` 且 `error_code = 'MODEL_CONFIGURATION_REQUIRED'` | 模型地址、模型名或配置无效；修正批量筛选配置并测试保存。 |
| `status = 'interrupted'` 且 `error_code` 为 `SCAN_RUN_ORPHANED`、`SCAN_RUN_MISSING`、`WORKFLOW_EXECUTOR_CRASH` 等 | 进程退出、心跳过期或子记录缺失造成的孤儿/异常中断。先查看最近 attempts 和 `LEASE_EXPIRED`，确认本轮 ID 后再使用页面提供的恢复入口；不要另开一轮绕过它。 |

`control_state = 'pause_requested'` 或 `stop_requested` 表示控制请求正在等待当前安全单元收尾，不是最终暂停/结束；应等待页面变为“本轮已暂停”或 `stopped` 后再操作。

### 迁移备份在哪里

当 `data/jobs.sqlite` 是已有数据库且需要升级时，`openDb()` 会先在数据库同级创建 `data/backups/`，用 SQLite `VACUUM INTO` 保存完整副本，再执行迁移和 `PRAGMA quick_check`。文件名格式为：

```text
jobs-before-v<旧版本>-to-v<新版本>-<时间戳>-<进程号>.sqlite
```

每次迁移的实际路径也写在 `schema_migrations.backup_path`。可用下面的只读查询核对：

```powershell
node -e "const {openDb}=require('./src/core/storage'); const db=openDb('data/jobs.sqlite'); console.log(db.prepare('select version,name,applied_at,backup_path from schema_migrations order by version').all()); db.close()"
```

新建的空数据库不需要升级备份；不要删除主库来解决迁移或页面显示问题。迁移失败时保留主库和 `data/backups/`，把错误码、备份路径和 `PRAGMA quick_check` 结果一起交给维护者。

### 不要手改状态

不要用 SQLite 工具直接 `UPDATE`/`DELETE` `workflow_runs.status`、`control_state`、`workflow_job_tasks.status`、`lease_*` 或 `error_code`。这些字段必须由 Dashboard、扫描子进程和 worker 在同一事务中维护；手改会破坏租约、恢复优先级、超时计数和当天轮次判断。暂停、继续、结束或恢复都使用页面按钮和已验证的模型设置；诊断时只读查询并保留原始数据库/备份。

常见错误码：

- `RESUME_UNSUPPORTED_FORMAT`：仅支持 TXT、MD、DOCX、PDF。
- `RESUME_FILE_TOO_LARGE`：文件超过 5 MB。
- `RESUME_DOCX_PARSE_FAILED` / `RESUME_PDF_PARSE_FAILED`：本地文本提取失败。
- `RESUME_TEXT_TOO_SHORT`：常见于扫描 PDF、图片简历或旧 `.doc`；改用粘贴文本。
- `MODEL_AUTH_FAILED`：Key 无效或没有权限。
- `MODEL_AUTH_REQUIRED`：模型鉴权暂停，修复 Key 后必须重新测试批量模型再继续本轮。
- `MODEL_CONFIGURATION_REQUIRED`：批量模型地址、模型名或配置无效。
- `MODEL_TIMEOUT_CIRCUIT_OPEN`：当前恢复周期第 10 个最终模型超时，工作流已安全暂停。
- `LEASE_EXPIRED`：岗位任务租约过期；系统会按剩余岗位级重试额度恢复或终止该任务。
- `WORKFLOW_EXECUTOR_CRASH`：分析 worker 进程异常退出；先检查最近 attempts 和任务租约，再从原工作流恢复。
- `MODEL_QUOTA_EXHAUSTED`：余额或配额不足。
- `MODEL_RATE_LIMITED`：模型服务限流，稍后重试。
- `MODEL_ENDPOINT_OR_MODEL_NOT_FOUND`：基础地址或模型名不正确。
- `MODEL_CONTRACT_INVALID`：结构化输出不符合契约；系统会尝试一次契约修复，仍失败则进入待语义分析。
- `CANDIDATE_PROFILE_REQUIRED`：岗位分析未绑定候选人画像。
- `SCAN_START_FAILED`：扫描前置校验、浏览器连接或子进程启动失败。
- `BOSS_LOGIN_REQUIRED`：没有可用登录态。
- `BOSS_RISK_CONTROL`：发现验证、风控或异常重定向；本轮立即停止。
- `BOSS_PANE_SWITCH_TIMEOUT`：点击左侧卡片后右侧详情未正常切换。
- `WORKFLOW_SCAN_INTERVAL`：距离上一轮扫描开始不足 2 小时；默认建议等到页面提示的时间。若本轮结果确实不足，也可以点击“提前开始下一轮”，阅读风险提示后仅为这一次确认提前开始。
- `WORKFLOW_DAILY_RUN_LIMIT`：当天已创建 3 轮任务。
- `COMMUNICATION_QUOTA_EXHAUSTED`：所选岗位超过当天剩余沟通额度。
- `COMMUNICATION_RESULT_AMBIGUOUS`：点击后无法可靠确认聊天状态；必须人工复核，不能自动重放。
- `COMMUNICATION_RESUME_REQUIRES_REVIEW`：中断点存在未完成单项，恢复前需要人工处理。

## BOSS 安全处置

- 出现验证页、登录失效、结构异常或频繁超时时，立即停止，不自动刷新硬闯。
- 静止基线只保留同一窗口内一个 `BOSS-SEARCH` 和一个 `BOSS-COMMUNICATION` 固定页，不同时运行多个扫描，不用多个标签并发点卡片。
- 消息发现只有在新会话没有完整可信本地 JD 时，才允许串行打开一个 `active: false` 的后台临时详情页；核验、保存并关闭后恢复两页基线。
- 启动助手可在用户启动工作区且未传 `-NoOpen` 时引导一次前台。扫描、JD 读取、分析、消息发现、沟通、轮询、重试和恢复不得激活 BOSS 页或恢复前台焦点。
- 两次正式扫描默认建议至少间隔 2 小时；本轮结果不足时，用户可以明确确认一次提前开始。每日访问额度、短窗口限流、登录与风控停止等硬性保护不会因此放宽。
- 不要只为了凑固定数量连续重跑整轮扫描；先看本轮候选质量和剩余库存，再决定等待或提前开始。
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


## 消息发现常见错误码

| 错误码 | 含义 | 处理 |
| --- | --- | --- |
| `BOSS_MESSAGE_TAB_MISSING` | 没有已登录的 BOSS 消息页 | 打开唯一 `BOSS-COMMUNICATION` 消息页后重试 |
| `BOSS_MESSAGE_TAB_AMBIGUOUS` | 检测到多个消息页 | 只保留一个消息页 |
| `BOSS_MESSAGE_GROUP_LIMIT` | 连续 HR 消息超过 5 条 | 改用人工粘贴 |
| `BOSS_MESSAGE_GROUP_TEXT_LIMIT` | 连续消息文本超过 1000 字符 | 改用人工粘贴 |
| `BOSS_MESSAGE_CONTENT_UNSUPPORTED` | 含语音、图片、普通附件或未验证的消息卡片 | 改用人工粘贴；不要按可见关键词猜卡片类型 |
| `BOSS_RISK_CONTROL` / `BOSS_LOGIN_REQUIRED` | 安全验证或登录失效 | 立即停止，处理后重试 |
| `MESSAGE_DISCOVERY_LEASE_LOST` | BOSS 租约丢失 | 停止后重新启动 |

恢复步骤：先安全停止，再检查 RoleFlow 专用 Edge（推荐）和固定消息页，最后重新开始一轮。出现登录、风控、页面漂移或身份不确定时立即停止，不重试点击。

已验证的附件简历请求不是错误：页面会显示“需要在 BOSS 人工处理附件简历请求”，但不会点击“同意/拒绝”。若同一轮还有 HR 纯文字，模型只读取文字并生成本地草稿；BOSS 岗位竞争情况卡片不进入模型。位置确认、面试排期等尚未取证的卡片仍走上述不支持分支。
