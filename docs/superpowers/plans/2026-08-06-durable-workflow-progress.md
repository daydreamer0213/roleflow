# RoleFlow Durable Workflow Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 RoleFlow 的整批岗位分析改造成可逐岗保存、可暂停恢复、有真实进度与超时熔断的持久化任务队列，并把现有单一模型设置升级为“深度分析 / 批量筛选”两套任务配置。

**Architecture:** SQLite 是任务状态、尝试历史、进度和恢复的唯一权威；扫描子进程继续由 Dashboard 按需启动，不新增常驻服务。BOSS 网页采集保持单标签串行，完整 JD 保存后才由最多两个模型 worker 领取本地任务。每个任务的尝试记录、岗位结果和进度版本在同一事务内提交；Dashboard 每 2～3 秒读取聚合快照并局部更新页面。

**Tech Stack:** Node.js 22 CommonJS、`node:sqlite`、现有无框架 HTTP/HTML Dashboard、Windows 本地进程、现有 smoke test runner。

## Global Constraints

- 开始实施前，从当前设计基线创建 `codex/durable-workflow-progress` 分支；不要直接在 `main` 上实现。
- 不得暂存或修改用户已有的未跟踪文件 `docs/superpowers/plans/2026-08-05-inherited-scope-resume-hardening-completion.md`。
- 设计权威为 `docs/superpowers/specs/2026-08-06-durable-workflow-progress-design.md`。本计划的接口细化不得改变其中已确认的产品决策。
- 必须测试驱动：每个行为先写最小失败测试并确认 RED，再写实现并确认 GREEN。
- 不新增常驻 worker、消息队列服务、WebSocket 或 SSE；继续使用 Dashboard + 按轮启动的扫描子进程。
- 数据库是唯一进度事实来源。`src/dashboard/server.js` 中的 `scanRuns` 只保留子进程句柄和短期输出，不得存放权威任务计数。
- BOSS 操作保持一个项目专用 Edge 窗口、固定标签、严格串行。模型并发只处理已保存到本地的 JD，不得增加页面并发、点击频率或标签数量。
- 不减少采集卡片数、完整 JD 覆盖、匹配证据、四档决策质量或推荐召回；性能问题不能通过降低产品质量解决。
- 每个恢复周期内，每个岗位最多两次岗位级尝试：第一次 + 一次自动重试。模型内部的结构修复不另算岗位级尝试。
- 当前恢复周期第 10 个“第二次尝试仍为 `MODEL_TIMEOUT`”的唯一岗位触发安全暂停。系统不得自动创建无限恢复周期。
- 自动暂停后，用户必须在暂停之后重新通过批量模型连接测试，再明确点击继续；继续时才创建新恢复周期。
- 恢复优先级固定为：上一周期最终超时任务、其他 `retry_pending`、未尝试 `pending`。
- 暂停可恢复；结束不可恢复。二者都必须等待当前安全单元落库后再释放精确 runId 的租约。
- 暂停/继续仍是同一轮。用户在第一次 BOSS 访问前结束不占当天轮次；访问后结束占一轮；已消耗的 BOSS 预算不返还。
- 新安装默认推荐：
  - `deep_analysis`: `deepseek-v4-pro`，思考开启，`high`，并发 1，超时 120 秒。
  - `batch_screening`: `deepseek-v4-flash`，思考关闭，并发 2，超时 90 秒。
- 已有用户升级时，把原配置复制到两套任务配置；不得静默切换模型或修改思考参数。
- 默认共享厂商和 API Key。高级设置才允许任务配置使用独立厂商/Key，并允许一个已验证的批量备用模型。
- 备用模型默认关闭，只能用于单岗第二次尝试，不能静默替换整批主模型。
- API、日志和尝试表不得保存简历、完整 JD、提示词、模型原始输出、API Key 或完整上游错误正文。
- 本计划不实现启动器美化、首次使用向导、分模块简历粘贴框、匹配偏好卡重排或执行前关键词展示；这些保留在独立产品改进清单中。
- 每个任务结束后只提交该任务列出的文件。提交前运行该任务的聚焦测试；最终任务再运行全量离线测试。

---

## File Map

| 文件 | 责任 |
|---|---|
| `src/core/model_settings.js` | 版本化的双任务模型设置、兼容迁移、凭据选择、连接验证和运行时配置 |
| `src/core/storage.js` | v6 数据库迁移、工作流扩展字段、任务/尝试的底层持久化与原子提交 |
| `src/core/workflow_analysis_tasks.js` | 队列初始化、领取、完成、重试、熔断、租约恢复等领域操作 |
| `src/core/workflow_analysis_executor.js` | 两个可注入 worker 循环、错误分类、主/备用模型选择和安全收尾 |
| `src/core/workflow_control.js` | pause/resume/stop 的状态校验、恢复周期和轮次语义 |
| `src/core/workflow_progress.js` | 数据库计数聚合、最近活动、模型公开摘要和 ETA 区间 |
| `src/core/workflow_run.js` | 扩展工作流恢复、轮次计数和预算计算 |
| `src/core/product_policy.js` | 批量并发、岗位尝试、超时熔断和 ETA 的集中默认策略 |
| `src/cli.js` | 用持久化 executor 替换整批 `mapWithConcurrency()` 保存边界 |
| `src/dashboard/server.js` | 双模型路由、工作流控制 API、进度 API 和数据面板局部刷新 |
| `tests/model_task_profiles_smoke.js` | 新旧模型设置迁移、推荐值、凭据和运行时路由 |
| `tests/workflow_task_storage_smoke.js` | 任务表、尝试表、原子提交、唯一性与租约 |
| `tests/workflow_analysis_executor_smoke.js` | 重试、备用模型、熔断、恢复优先级和逐岗保存 |
| `tests/workflow_control_smoke.js` | 暂停、继续、结束、轮次和精确租约释放 |
| `tests/workflow_progress_smoke.js` | 聚合计数、ETA、活动脱敏和配置版本切换 |
| `tests/storage_migration_smoke.js` | v5→v6 迁移、备份、回滚、数据保留和任务补建 |
| `tests/scan_cli_lifecycle_smoke.js` | CLI 队列接入、异常退出、暂停/停止收尾 |
| `tests/workflow_recovery_smoke.js` | Dashboard 重启与孤儿任务恢复 |
| `tests/workflow_dashboard_smoke.js` | 控制 API、状态 JSON、数据面板和无整页刷新 |
| `tests/model_settings_ui_smoke.js` | Pro/Flash 明确选项、两套配置、推荐值和高级备用模型 |
| `tests/run_all.js` | 注册全部新增离线测试 |
| `docs/daily_workflow.md` | 用户操作：查看进度、暂停、恢复、结束和模型故障处理 |
| `docs/operations.md` | 运维诊断：任务表、尝试表、熔断和恢复检查 |

---

## Stable Contracts

以下接口名和字段名是实施期间的固定契约。除非测试证明与现有代码无法兼容，否则不要临时改名。

### 1. Model task profile IDs

```js
const MODEL_TASK_PROFILES = Object.freeze({
  DEEP_ANALYSIS: "deep_analysis",
  BATCH_SCREENING: "batch_screening"
});
```

任务路由：

| 调用 | profile |
|---|---|
| 简历解析、画像、搜索建议、匹配偏好卡、用户主动生成沟通内容 | `deep_analysis` |
| 岗位理解、岗位匹配、单岗重试、批量重试 | `batch_screening` |

### 2. Settings v2 shape

`.runtime/settings/model.json` 使用以下稳定结构：

```js
{
  schemaVersion: 2,
  credentialMode: "shared",
  sharedCredential: {
    preset: "deepseek",
    provider: "openai_compatible",
    baseUrl: "https://api.deepseek.com"
  },
  taskProfiles: {
    deep_analysis: {
      model: "deepseek-v4-pro",
      timeoutMs: 120000,
      thinkingMode: "enabled",
      reasoningEffort: "high",
      concurrency: 1,
      credentialRef: "shared",
      revision: "<effective deep profile fingerprint>",
      connection: {
        status: "verified",
        checkedAt: "...",
        latencyMs: 100,
        httpStatus: 200,
        fingerprint: "..."
      }
    },
    batch_screening: {
      model: "deepseek-v4-flash",
      timeoutMs: 90000,
      thinkingMode: "disabled",
      reasoningEffort: "high",
      concurrency: 2,
      credentialRef: "shared",
      revision: "<effective batch profile fingerprint>",
      connection: { "...": "same shape" }
    }
  },
  independentCredentials: {
    deep_analysis: null,
    batch_screening: null
  },
  batchBackup: {
    enabled: false,
    credentialRef: "shared",
    preset: "deepseek",
    provider: "openai_compatible",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    timeoutMs: 90000,
    thinkingMode: "disabled",
    reasoningEffort: "high",
    revision: "<effective backup profile fingerprint>",
    connection: { status: "unverified", checkedAt: "", latencyMs: null, httpStatus: null, fingerprint: "..." }
  },
  revision: "<whole settings fingerprint>"
}
```

`independentCredentials.<profile>` 非空时只包含 `preset/provider/baseUrl`，密钥仍只放 Windows 加密 secret 文件。密钥 ID：

```text
model-api-key-shared-<preset-or-custom-hash>
model-api-key-deep_analysis-<preset-or-custom-hash>
model-api-key-batch_screening-<preset-or-custom-hash>
model-api-key-batch_backup-<preset-or-custom-hash>
```

`reasoningEffort` 对不支持思考的模型仍规范化为 `"high"`，但请求不得发送思考字段。写入 workflow/task/attempt 的 `model_config_revision` 使用相应任务配置的 `revision`，不是根级设置 `revision`；修改深度分析配置不得让批量筛选 ETA 或连接状态失效。

### 3. New workflow columns

`workflow_runs` v6 新增：

```text
control_state                 none | pause_requested | stop_requested
resume_phase                  NULL | scanning | analyzing
recovery_generation           INTEGER >= 0
circuit_timeout_job_count     INTEGER >= 0
lifetime_timeout_job_count    INTEGER >= 0
progress_revision             INTEGER >= 0
last_activity_at              nullable ISO timestamp
model_config_revision         nullable text
platform_access_started_at    nullable ISO timestamp
```

工作流 `status` CHECK 增加 `paused`。

### 4. `workflow_job_tasks`

```sql
CREATE TABLE workflow_job_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_run_id TEXT NOT NULL,
  batch_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  observation_id INTEGER NOT NULL,
  position INTEGER NOT NULL CHECK(position > 0),
  status TEXT NOT NULL CHECK(status IN (
    'pending','running','retry_pending','succeeded','failed','skipped','stopped'
  )),
  recovery_generation INTEGER NOT NULL DEFAULT 0 CHECK(recovery_generation >= 0),
  attempt_count_in_generation INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count_in_generation BETWEEN 0 AND 2),
  total_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(total_attempt_count >= 0),
  priority INTEGER NOT NULL DEFAULT 100,
  available_at TEXT,
  lease_owner TEXT,
  leased_at TEXT,
  lease_expires_at TEXT,
  model_config_revision TEXT,
  last_attempt_model_revision TEXT,
  last_error_code TEXT,
  last_error_stage TEXT,
  last_error_kind TEXT,
  total_latency_ms INTEGER NOT NULL DEFAULT 0 CHECK(total_latency_ms >= 0),
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workflow_run_id, job_id),
  FOREIGN KEY(workflow_run_id) REFERENCES workflow_runs(id),
  FOREIGN KEY(batch_id) REFERENCES batches(id),
  FOREIGN KEY(job_id) REFERENCES jobs(id),
  FOREIGN KEY(observation_id) REFERENCES job_observations(id)
);
```

优先级数字越小越先领取：

```text
10 = 上一恢复周期最终超时后重新入队
20 = 当前周期普通 retry_pending
100 = 从未尝试 pending
```

### 5. `job_analysis_attempts`

```sql
CREATE TABLE job_analysis_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_run_id TEXT NOT NULL,
  task_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  recovery_generation INTEGER NOT NULL CHECK(recovery_generation >= 0),
  attempt_in_generation INTEGER NOT NULL CHECK(attempt_in_generation BETWEEN 1 AND 2),
  total_attempt_number INTEGER NOT NULL CHECK(total_attempt_number > 0),
  profile_kind TEXT NOT NULL CHECK(profile_kind = 'batch_screening'),
  model_config_revision TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  thinking_mode TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL,
  backup_used INTEGER NOT NULL DEFAULT 0 CHECK(backup_used IN (0,1)),
  status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')),
  error_code TEXT,
  error_stage TEXT,
  retryable INTEGER NOT NULL DEFAULT 0 CHECK(retryable IN (0,1)),
  model_call_count INTEGER NOT NULL DEFAULT 0 CHECK(model_call_count >= 0),
  prompt_tokens INTEGER NOT NULL DEFAULT 0 CHECK(prompt_tokens >= 0),
  completion_tokens INTEGER NOT NULL DEFAULT 0 CHECK(completion_tokens >= 0),
  total_tokens INTEGER NOT NULL DEFAULT 0 CHECK(total_tokens >= 0),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  latency_ms INTEGER CHECK(latency_ms IS NULL OR latency_ms >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, recovery_generation, attempt_in_generation),
  FOREIGN KEY(workflow_run_id) REFERENCES workflow_runs(id),
  FOREIGN KEY(task_id) REFERENCES workflow_job_tasks(id),
  FOREIGN KEY(job_id) REFERENCES jobs(id)
);
```

不得增加 `error_message`、输入、输出或提示词列。可公开错误只使用稳定 `error_code/error_stage`。对没有返回 token usage 的兼容接口，token 字段写 0；不得猜测。

### 6. Workflow status response

`GET /api/workflow-status?runId=<id>` 保留现有 `workflow/communication/today`，新增：

```js
{
  progress: {
    stage: "analyzing",
    stageIndex: 4,
    stageCount: 5,
    collected: 127,
    detailsRead: 120,
    detailsPending: 7,
    analysis: {
      total: 127,
      succeeded: 70,
      running: 1,
      retryPending: 1,
      failed: 5,
      skipped: 0,
      stopped: 0,
      pending: 50,
      circuitTimeoutJobs: 5,
      lifetimeTimeoutJobs: 5,
      timeoutPauseThreshold: 10
    },
    eta: {
      status: "estimating" | "available" | "paused" | "not_applicable",
      minSeconds: null | 2280,
      maxSeconds: null | 3120,
      sampleSize: 0
    }
  },
  model: {
    profile: "batch_screening",
    provider: "openai_compatible",
    model: "deepseek-v4-flash",
    revision: "...",
    backupEnabled: false,
    backupActiveForCurrentAttempt: false
  },
  controls: {
    canPause: true,
    canResume: false,
    canStop: true,
    stopConsumesRunSlot: true
  },
  recentActivity: [
    {
      type: "analysis_succeeded",
      taskId: 42,
      attempt: 1,
      modelRole: "primary",
      at: "..."
    }
  ]
}
```

### 7. Workflow control request

```text
POST /api/workflow-control
content-type: application/x-www-form-urlencoded

workflowRunId=<uuid>
action=pause|resume|stop
confirmStop=1     # action=stop 时必需
```

成功统一 `303` 到 `/workflow?runId=<id>`。非法状态返回带稳定错误码的 409 页面；重复 pause/stop 请求幂等，不重复递增恢复周期或进度版本。

---

### Task 0: Create the Implementation Branch and Record a Clean Baseline

**Files:**
- Read only: `AGENTS.md`
- Read only: `docs/superpowers/specs/2026-08-06-durable-workflow-progress-design.md`
- Read only: `docs/superpowers/plans/2026-08-06-durable-workflow-progress.md`

**Precondition:** 当前设计提交应为 `98f65eb` 或包含该提交的后续 `main`。

- [ ] **Step 1: Confirm repository state without touching user files**

Run:

```powershell
git status --short --branch
git log -3 --oneline
```

Expected:

- 当前在 `main`。
- 能看到设计文档提交。
- 未跟踪的 `docs/superpowers/plans/2026-08-05-inherited-scope-resume-hardening-completion.md` 仍保持未跟踪。

- [ ] **Step 2: Create the implementation branch**

Run:

```powershell
git switch -c codex/durable-workflow-progress
```

Expected: 当前分支为 `codex/durable-workflow-progress`。

- [ ] **Step 3: Run the focused pre-change baseline**

Run:

```powershell
node tests/storage_migration_smoke.js
node tests/workflow_storage_smoke.js
node tests/workflow_recovery_smoke.js
node tests/scan_cli_lifecycle_smoke.js
node tests/workflow_dashboard_smoke.js
node tests/model_settings_smoke.js
node tests/model_settings_ui_smoke.js
```

Expected: all seven commands exit 0. If a baseline test fails, stop implementation and record the exact pre-existing failure; do not “fix around” an unknown baseline.

- [ ] **Step 4: Confirm branch status**

Run:

```powershell
git status --short --branch
```

Expected: only the known user-owned untracked plan is present; no implementation files have changed.

---

### Task 1: Introduce Versioned Dual Model Task Profiles

**Files:**
- Modify: `src/core/model_settings.js`
- Create: `tests/model_task_profiles_smoke.js`
- Modify: `tests/model_settings_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**

```js
listModelTaskProfiles() => Array<{ id, label, recommended }>
loadModelSettings({ root, fallbackModelConfig }) => PublicModelState
resolveRuntimeModelConfig({ root, fallbackModelConfig, taskProfile }) => RuntimeModelState
resolveRuntimeBatchBackup({ root, fallbackModelConfig }) => null | RuntimeModelState
isModelReady(modelState, { taskProfile = "deep_analysis", checkedAfter = "" } = {}) => boolean
saveVerifiedModelTaskProfile({
  root,
  taskProfile,
  input,
  fallbackModelConfig,
  connectionTester
}) => Promise<PublicModelState>
saveVerifiedBatchBackup({
  root,
  input,
  fallbackModelConfig,
  connectionTester
}) => Promise<PublicModelState>
restoreRecommendedTaskProfile({
  root,
  taskProfile,
  fallbackModelConfig
}) => PublicModelState
```

保留 `saveVerifiedModelConfiguration()` 作为兼容包装：它写入 `deep_analysis`，供尚未迁移的调用和测试使用；新代码不得继续调用它。

- [ ] **Step 1: Write RED tests for new-install defaults**

Create `tests/model_task_profiles_smoke.js`. In a fresh temp root, call `loadModelSettings()` with no settings file and the repository’s mock fallback. Assert:

```js
assert.strictEqual(state.settings.schemaVersion, 2);
assert.deepStrictEqual(state.settings.taskProfiles.deep_analysis, {
  model: "deepseek-v4-pro",
  timeoutMs: 120000,
  thinkingMode: "enabled",
  reasoningEffort: "high",
  concurrency: 1,
  credentialRef: "shared",
  connection: state.settings.taskProfiles.deep_analysis.connection
});
assert.strictEqual(state.settings.taskProfiles.batch_screening.model, "deepseek-v4-flash");
assert.strictEqual(state.settings.taskProfiles.batch_screening.timeoutMs, 90000);
assert.strictEqual(state.settings.taskProfiles.batch_screening.thinkingMode, "disabled");
assert.strictEqual(state.settings.taskProfiles.batch_screening.concurrency, 2);
assert.strictEqual(state.settings.batchBackup.enabled, false);
```

Also assert no file is written merely by loading defaults.

- [ ] **Step 2: Write RED tests for v1 settings compatibility**

Write a current-format v1 file:

```js
{
  preset: "deepseek",
  provider: "openai_compatible",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-pro",
  timeoutMs: 60000,
  thinkingMode: "enabled",
  reasoningEffort: "max",
  connection: verifiedConnection
}
```

Assert both v2 task profiles copy `model/timeoutMs/thinkingMode/reasoningEffort`, `source === "migrated_v1"`, and neither profile silently becomes Flash. Assert the old provider secret is migrated to the shared secret ID without exposing plaintext in JSON.

Also cover a legacy non-mock `fallbackModelConfig` with no runtime settings file. It represents an existing command-line/config-file user, so both task profiles must copy that legacy model instead of receiving new-install recommendations. Only “no runtime settings + mock fallback” is treated as a new installation.

- [ ] **Step 3: Write RED tests for task routing and readiness**

Using an injected successful `connectionTester`:

- save `deep_analysis`, then assert deep readiness is true and batch readiness is false;
- save `batch_screening`, then assert both are true;
- resolve each runtime profile and assert correct model/thinking/timeout/concurrency;
- assert `checkedAfter` rejects a verification timestamp before an automatic pause;
- assert changing model parameters invalidates only the changed profile’s fingerprint;
- assert unsupported models omit thinking in the probe payload.

- [ ] **Step 4: Write RED tests for independent credentials and backup**

Assert:

- shared mode resolves both profiles to one encrypted key;
- enabling an independent batch credential uses a different secret ID and never copies the shared plaintext key;
- backup cannot be enabled until its exact fingerprint has a successful connection;
- a verified backup resolves through `resolveRuntimeBatchBackup()`;
- disabling backup keeps stored configuration but makes runtime backup `null`;
- neither settings JSON nor public state contains any API Key.

- [ ] **Step 5: Run tests and verify RED**

Run:

```powershell
node tests/model_task_profiles_smoke.js
node tests/model_settings_smoke.js
```

Expected: fail on missing v2 profile APIs or old shape.

- [ ] **Step 6: Implement constants, normalization and migration**

In `src/core/model_settings.js`:

- add `SETTINGS_SCHEMA_VERSION = 2`;
- add frozen recommended profile objects;
- split credential normalization from task parameter normalization;
- make `loadModelSettings()` normalize in memory but not write on read;
- mark sources exactly as `"runtime"`, `"migrated_v1"`, `"legacy"`, or `"new_install"`;
- compute `revision` from provider/base URL, both task parameters, credential refs and backup parameters, never from secret plaintext;
- generate per-profile connection fingerprints from the effective provider/base URL/model/thinking/reasoning/timeout;
- migrate the current per-provider secret to the shared secret ID only after successful decrypt + encrypted rewrite; preserve current rollback behavior on failure.

- [ ] **Step 7: Implement save/test/runtime functions**

Use the existing atomic file write and rollback pattern. A task-profile save must:

1. load and normalize current settings;
2. merge only the requested profile and selected credential;
3. locate only the appropriate existing/supplied key;
4. test the exact effective profile;
5. write secret and settings atomically with rollback;
6. return public state with secret booleans, never plaintext.

`restoreRecommendedTaskProfile()` changes parameters and invalidates connection; it must not claim verified until the user submits a connection test.

- [ ] **Step 8: Preserve old public compatibility fields temporarily**

For one release, `PublicModelState` should expose:

```js
state.settings.model       // deep_analysis model
state.settings.timeoutMs   // deep_analysis timeout
state.modelConfig          // deep_analysis runtime-shaped config without plaintext key
state.connectionStatus     // deep_analysis connection status
```

These are read-only aliases. Add assertions to `tests/model_settings_smoke.js` so old onboarding code continues to work until Task 10 routes every call explicitly.

- [ ] **Step 9: Run GREEN tests**

Run:

```powershell
node tests/model_task_profiles_smoke.js
node tests/model_settings_smoke.js
```

Expected: both pass.

- [ ] **Step 10: Commit**

```powershell
git add src/core/model_settings.js tests/model_task_profiles_smoke.js tests/model_settings_smoke.js tests/run_all.js
git commit -m "feat: add task-specific model profiles"
```

Do not stage the known user-owned untracked plan.

---

### Task 2: Add the v6 Workflow Task and Attempt Schema

**Files:**
- Modify: `src/core/storage.js`
- Modify: `tests/storage_migration_smoke.js`
- Modify: `tests/workflow_storage_smoke.js`

**Interfaces:**

```js
SCHEMA_VERSION === 6
WORKFLOW_RUN_STATUSES includes "paused"
WORKFLOW_TRANSITIONS supports the status table below
```

Required transitions:

```text
created       -> scanning | review_required | failed | stopped
scanning      -> analyzing | paused | interrupted | failed | stopped
analyzing     -> paused | review_required | interrupted | failed | stopped
paused        -> scanning | analyzing | stopped
interrupted   -> scanning | analyzing | review_required | communicating | failed | stopped
review_required -> communicating | completed | stopped
communicating -> completed | interrupted | failed | stopped
completed / failed / stopped -> no different status
```

- [ ] **Step 1: Extend migration tests first**

In `tests/storage_migration_smoke.js`, add v6 to the expected migration list:

```js
{ version: 6, name: "durable_workflow_progress_v1", backup_path: null }
```

For a fresh DB assert both new tables and indexes exist. Assert `PRAGMA quick_check = ok`.

- [ ] **Step 2: Add a true v5→v6 fixture**

Create a temp database using the current v5 schema, insert:

- one profile, plan, job and observation;
- one `analyzing` workflow linked to a batch;
- one completed workflow;
- one communication batch/item;
- one model cache row;
- candidate profile, resume and matching-card data.

Downgrade only `user_version`/migration metadata to v5 before opening with new code. After migration assert:

- all original record counts and IDs remain;
- the workflow CHECK accepts `paused`;
- old workflows have `control_state='none'`, generation/counters/revision 0, and nullable new timestamps;
- task backfill does not label a rule-only or `analysis_pending` observation as `succeeded`;
- backup path exists and opens read-only;
- reopening v6 creates no second backup.

- [ ] **Step 3: Add rollback and constraint tests**

Inject a migration failure after the workflow table rebuild. Assert the entire v6 migration rolls back, `user_version` remains 5, original rows remain readable and neither partial new table exists.

Assert DB rejects:

- duplicate `(workflow_run_id, job_id)`;
- `attempt_count_in_generation > 2`;
- attempt number 0 or 3;
- invalid task/control/status enum;
- task referencing a nonexistent batch or job.

- [ ] **Step 4: Run migration tests and verify RED**

Run:

```powershell
node tests/storage_migration_smoke.js
node tests/workflow_storage_smoke.js
```

Expected: fail because schema version remains 5 and `paused`/new tables do not exist.

- [ ] **Step 5: Implement schema strings and v6 migration**

In `src/core/storage.js`:

- extend `WORKFLOW_SCHEMA` to the v6 definition for fresh DBs;
- add a separate `WORKFLOW_TASK_SCHEMA`;
- add migration `{ version: 6, name: "durable_workflow_progress_v1" }`;
- rebuild `workflow_runs` because SQLite cannot alter the existing status CHECK;
- explicitly list old and new columns during copy; never use `SELECT *`;
- recreate `idx_workflow_runs_active`, `idx_workflow_runs_daily` and all foreign keys;
- create:

```sql
CREATE INDEX idx_workflow_job_tasks_claim
  ON workflow_job_tasks(workflow_run_id, status, priority, position);
CREATE INDEX idx_workflow_job_tasks_lease
  ON workflow_job_tasks(status, lease_expires_at);
CREATE INDEX idx_job_analysis_attempts_progress
  ON job_analysis_attempts(workflow_run_id, model_config_revision, finished_at);
CREATE INDEX idx_job_analysis_attempts_task
  ON job_analysis_attempts(task_id, recovery_generation, attempt_in_generation);
```

- [ ] **Step 6: Backfill tasks conservatively**

Implement `backfillWorkflowAnalysisTasks(db)` inside the v6 migration:

- only consider workflows with a non-null `scan_batch_id`;
- join `job_observations` for that exact batch;
- use stable observation order, then job ID, to assign `position`;
- `analysis.semanticStatus === "complete"` and `decisionSource === "model"` → `succeeded`;
- local hard-boundary result (`decisionSource === "local_rules"` or semantic `rule_only`) → `skipped`;
- everything else, including `analysis_pending`, `pending`, `failed`, missing/short JD → `pending`;
- insert no synthetic `job_analysis_attempts` for historical work;
- set `model_config_revision` null for historical tasks;
- do not rewrite `jobs.analysis_json`.

- [ ] **Step 7: Extend row mapping and transition code**

`workflowRunRow()` must expose camelCase forms of all nine new columns. `createWorkflowRun()` accepts optional `modelConfigRevision` and initializes `lastActivityAt` to creation time. `transitionWorkflowRun()`:

- handles `paused`;
- sets `finished_at` only for `completed/failed/stopped`;
- does not clear existing finished timestamps except impossible invalid transitions;
- updates control/resume/counters/revision/activity only when explicitly supplied;
- clears transient error fields on valid resume from paused/interrupted.

- [ ] **Step 8: Run GREEN tests**

Run:

```powershell
node tests/storage_migration_smoke.js
node tests/workflow_storage_smoke.js
```

Expected: both pass, including v5 data preservation and rollback.

- [ ] **Step 9: Commit**

```powershell
git add src/core/storage.js tests/storage_migration_smoke.js tests/workflow_storage_smoke.js
git commit -m "feat: add durable workflow task schema"
```

---

### Task 3: Implement Atomic Workflow Task Storage Operations

**Files:**
- Modify: `src/core/storage.js`
- Create: `src/core/workflow_analysis_tasks.js`
- Create: `tests/workflow_task_storage_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**

```js
initializeWorkflowJobTasks(db, {
  workflowRunId,
  batchId,
  jobs,
  modelConfigRevision,
  now
}) => { inserted, existing, total }

claimWorkflowJobTask(db, {
  workflowRunId,
  leaseOwner,
  leaseTtlMs,
  selectModelIdentity,
  now
}) => null | { task, attempt, job }

commitWorkflowJobTaskSuccess(db, {
  taskId,
  leaseOwner,
  analyzedJob,
  modelIdentity,
  telemetry,
  startedAt,
  finishedAt
}) => { task, workflow }

commitWorkflowJobTaskFailure(db, {
  taskId,
  leaseOwner,
  errorCode,
  retryable,
  retryAt,
  errorStage,
  modelIdentity,
  telemetry,
  startedAt,
  finishedAt
}) => { task, workflow, outcome: "retry_pending" | "failed" | "pause_requested" }

commitWorkflowJobTaskSkipped(db, {
  taskId,
  leaseOwner,
  analyzedJob,
  reasonCode,
  startedAt,
  finishedAt
}) => { task, workflow }

recoverExpiredWorkflowJobTasks(db, {
  workflowRunId,
  now
}) => { recovered, failed }

listWorkflowJobTasks(db, { workflowRunId, statuses, limit }) => Task[]
listJobAnalysisAttempts(db, { workflowRunId, taskId, limit }) => Attempt[]
```

`selectModelIdentity({ attemptInGeneration, totalAttemptNumber })` is synchronous and returns provider/model/revision/thinking/reasoning/backup metadata before the attempt row is inserted. `job` is reconstructed from the task’s exact `observation_id`, not from the mutable latest job row.

- [ ] **Step 1: Write RED tests for idempotent initialization**

Create `tests/workflow_task_storage_smoke.js` with a temp DB and real profile/plan/batch/jobs. Assert:

- initializing 3 jobs inserts 3 tasks in input order;
- calling again returns `inserted: 0` and preserves state/position;
- a job from another batch is rejected;
- a workflow linked to another batch is rejected;
- already model-complete observations become `succeeded`, rule-gated jobs become `skipped`, pending analysis becomes `pending`.

- [ ] **Step 2: Write RED tests for atomic claim**

Assert:

- two sequential claim calls with different owners return different tasks;
- claimed task becomes `running`, has non-empty lease and a `running` attempt row;
- the running attempt already contains the exact selected primary/backup model identity before any external model request starts;
- attempt counters increment exactly once;
- owner mismatch cannot complete a task;
- repeated completion is rejected with `WORKFLOW_TASK_NOT_RUNNING`;
- claim order is priority then position;
- a `retry_pending` task whose `available_at` is in the future cannot be claimed;
- `control_state !== 'none'` returns `null` without mutation.

- [ ] **Step 3: Write RED tests for atomic success**

Claim a task, call `commitWorkflowJobTaskSuccess()`, then assert in one state:

- `jobs.analysis_json` contains the analyzed result;
- a batch observation exists/updates through `upsertJob()`;
- task is `succeeded`, lease cleared and `finished_at` set;
- attempt is `succeeded` with latency, model identity, model-call count and available token usage;
- workflow `progress_revision` increased by one and `last_activity_at` equals finish time.

Install a temporary trigger that fails the job observation write. Assert the entire transaction rolls back: task and attempt stay running, job result is unchanged and progress revision does not increment.

- [ ] **Step 4: Write RED tests for failure and recovery**

Cover:

- first retryable failure → `retry_pending`, `attempt_count_in_generation` 1;
- retryable failure persists `available_at=retryAt`, and another worker cannot bypass the cooldown;
- second retryable non-timeout failure → `failed`, no circuit increment;
- second `MODEL_TIMEOUT` → `failed`, both circuit and lifetime increments once;
- recommitting/recovering the same final timeout cannot increment twice;
- non-retryable auth/config errors finish the current attempt, leave the task `retry_pending`, and set `pause_requested` immediately with the stable reason; they do not trigger the automatic second attempt under the broken configuration;
- expired first-attempt running task → `retry_pending`;
- expired second-attempt running task → `failed`;
- succeeded/skipped tasks are never recovered or reclaimed.

- [ ] **Step 5: Run tests and verify RED**

Run:

```powershell
node tests/workflow_task_storage_smoke.js
```

Expected: module or functions missing.

- [ ] **Step 6: Implement storage row mappers and transaction helpers**

Keep SQL in `src/core/storage.js` and domain ordering in `workflow_analysis_tasks.js`.

Add unexported transaction helper:

```js
function immediateTransaction(db, work) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}
```

Do not use it inside a caller that already owns a transaction. Task commit functions own the transaction and call the existing `upsertJob()` inside it.

- [ ] **Step 7: Implement claim with compare-and-set semantics**

Within one `BEGIN IMMEDIATE`:

1. reload workflow and require `status === "analyzing"` and `control_state === "none"`;
2. select one `pending/retry_pending` row whose `available_at` is null or due, ordered by priority, position, id;
3. calculate the next attempt numbers and call `selectModelIdentity()` before changing state;
4. update the task only when current status still matches and lease is null/expired;
5. increment attempt counters;
6. insert the unique running attempt with that model identity;
7. increment workflow `progress_revision`, update `last_activity_at`;
8. return mapped task + attempt + exact observation job.

Because SQLite access is synchronous, the immediate transaction plus conditional update is the anti-double-claim guarantee; do not rely on JavaScript worker timing.

- [ ] **Step 8: Implement success/failure/skipped commits**

All terminal commits must:

- verify `lease_owner`;
- finish the current attempt;
- update task state and clear lease;
- update workflow activity/revision;
- commit atomically.

For retryable first failures, persist the executor-supplied `retryAt`; for final timeouts, increment counters with a conditional task transition from non-final to final so a duplicate call cannot double-count.

- [ ] **Step 9: Run GREEN tests**

Run:

```powershell
node tests/workflow_task_storage_smoke.js
node tests/storage_migration_smoke.js
```

Expected: pass.

- [ ] **Step 10: Commit**

```powershell
git add src/core/storage.js src/core/workflow_analysis_tasks.js tests/workflow_task_storage_smoke.js tests/run_all.js
git commit -m "feat: persist workflow analysis tasks atomically"
```

---

### Task 4: Build the Recoverable Analysis Executor and Timeout Circuit

**Files:**
- Create: `src/core/workflow_analysis_executor.js`
- Modify: `src/core/product_policy.js`
- Create: `tests/workflow_analysis_executor_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**

```js
const WORKFLOW_ANALYSIS_ERROR_KINDS = Object.freeze({
  RETRYABLE: "retryable",
  CONFIGURATION: "configuration",
  TERMINAL: "terminal",
  CONTROLLED_STOP: "controlled_stop"
});

classifyWorkflowAnalysisError(error) => {
  kind,
  code,
  retryable,
  pauseCode
}

runWorkflowAnalysis({
  db,
  workflowRunId,
  primaryRuntime,
  backupRuntime,
  createAnalyzeJob,
  analyzeScannedJob,
  logger,
  now,
  workerIdFactory
}) => Promise<{
  status: "drained" | "paused" | "stopped" | "interrupted",
  claimed,
  succeeded,
  failed,
  skipped
}>
```

`createAnalyzeJob(runtime, { logger })` returns the existing per-job analyzer function. The executor supplies a per-attempt logger proxy that forwards redacted events to the normal logger and aggregates only `model_call_completed` counts/token usage. `analyzeScannedJob(raw, { configs, analyzeJob })` remains injectable so tests never call a live model.

Policy additions:

```js
modelAnalysis: {
  scanConcurrency: 2,
  retryConcurrency: 2,
  maxRetryJobs: 50,
  maxAttemptsPerGeneration: 2,
  timeoutCircuitThreshold: 10,
  taskLeaseTtlMs: 3 * 60 * 1000,
  retryBackoffMs: [1000, 3000],
  etaSampleMinimum: 3,
  etaSampleLimit: 10
}
```

The runtime profile’s `concurrency` is authoritative but clamp it to `1..2` in v1. Do not tie it to BOSS browser concurrency.

- [ ] **Step 1: Write RED tests for error classification**

Test exact mappings:

```text
MODEL_TIMEOUT, MODEL_CONNECTION_FAILED, MODEL_RATE_LIMITED,
MODEL_UPSTREAM_UNAVAILABLE, HTTP 429, HTTP 5xx -> retryable

MODEL_KEY_REQUIRED, MODEL_AUTH_FAILED, MODEL_ENDPOINT_OR_MODEL_NOT_FOUND,
MODEL_CONFIGURATION_REQUIRED -> configuration pause

MODEL_CONTRACT_INVALID after internal repair, local input errors -> terminal

SCAN_ABORTED after pause/stop request -> controlled stop
```

Preserve the original stable error code; never persist the full message.

- [ ] **Step 2: Write RED tests for primary/backup selection**

With one task:

- primary times out, backup disabled → attempt 2 uses primary;
- primary times out, verified backup enabled → attempt 2 uses backup;
- primary succeeds → backup is never constructed;
- backup succeeds → only that attempt records `backup_used=1` and its mapped public `modelRole` is `"backup"`;
- successful backup does not change the batch primary runtime.

- [ ] **Step 3: Write RED tests for the 9/10 circuit boundary**

Seed 10 jobs whose two attempts time out. Run concurrency 2 and assert:

- after 9 final-timeout jobs, workflow remains analyzing/control none;
- the 10th unique final timeout sets `pause_requested`;
- workers stop claiming new tasks immediately;
- at most the already-running sibling completes its current attempt and persists;
- executor transitions workflow to `paused` only after both worker promises settle;
- error code is `MODEL_TIMEOUT_CIRCUIT_OPEN`;
- no new recovery generation appears automatically.

- [ ] **Step 4: Write RED tests for configuration pause**

First job returns `MODEL_AUTH_FAILED`. Assert no automatic job-level retry, no second task claim, safe transition to paused and `MODEL_AUTH_REQUIRED`.

- [ ] **Step 5: Write RED tests for crash-safe incremental results**

Have job 1 succeed, job 2 throw a synthetic process-level executor error, jobs 3–5 remain pending. Assert job 1 is already in DB before the executor rejects, job 2 is recoverable, and no successful result is held only in an array.

- [ ] **Step 6: Run tests and verify RED**

Run:

```powershell
node tests/workflow_analysis_executor_smoke.js
```

Expected: missing executor.

- [ ] **Step 7: Implement worker loops**

Implementation outline:

```js
async function workerLoop(context) {
  while (true) {
    const claimed = claimWorkflowJobTask(...);
    if (!claimed) return;
    const runtime = selectAttemptRuntime(claimed.attempt, context);
    const telemetry = createAttemptTelemetry();
    const attemptLogger = createAttemptTelemetryLogger(context.logger, telemetry);
    try {
      const analyzedJob = await context.executeTask(claimed, runtime, attemptLogger);
      if (isLocalRuleSkip(analyzedJob)) commitWorkflowJobTaskSkipped(...telemetry);
      else commitWorkflowJobTaskSuccess(...telemetry);
    } catch (error) {
      const classified = classifyWorkflowAnalysisError(error);
      commitWorkflowJobTaskFailure(...classified, ...telemetry);
    }
  }
}
```

Telemetry rules:

- add `data.attempts` from each `model_call_completed` event to `model_call_count`; a cache hit reports 0 external calls;
- sum only finite non-negative `usage.prompt_tokens/completion_tokens/total_tokens`;
- attempt `latency_ms` is the job-level wall-clock duration, not a sum of overlapping log durations;
- ignore all other event fields and never persist raw error text, input or output.

Start exactly `clamp(primaryRuntime.concurrency, 1, 2)` loops and await `Promise.allSettled()`. After they settle:

- `stop_requested` → mark remaining pending/retry tasks `stopped`, then workflow `stopped`;
- `pause_requested` → workflow `paused`, preserving `resume_phase="analyzing"`;
- queue drained with no pending/running/retry → return `drained`;
- unexpected worker rejection → workflow `interrupted`, never `completed`.

- [ ] **Step 8: Add bounded retry delay**

For a retryable first failure, compute a retry timestamp using an injected delay/random source inside the policy range and pass it to `commitWorkflowJobTaskFailure()`. The claim query enforces `available_at`, so the second worker cannot bypass the cooldown. Tests inject a deterministic clock and zero/small backoff. This delay affects model calls only and must not touch BOSS.

- [ ] **Step 9: Run GREEN tests**

Run:

```powershell
node tests/workflow_analysis_executor_smoke.js
node tests/workflow_task_storage_smoke.js
```

Expected: pass.

- [ ] **Step 10: Commit**

```powershell
git add src/core/workflow_analysis_executor.js src/core/product_policy.js tests/workflow_analysis_executor_smoke.js tests/run_all.js
git commit -m "feat: add recoverable analysis executor"
```

---

### Task 5: Replace the CLI Whole-Batch Save Boundary

**Files:**
- Modify: `src/cli.js`
- Modify: `src/core/job_analysis.js`
- Modify: `tests/scan_cli_lifecycle_smoke.js`
- Create: `tests/workflow_scan_analysis_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**

```js
runWorkflowAnalysisPhase(db, {
  workflowRun,
  batchId,
  jobsToAnalyze,
  configs,
  keywordPlan,
  logger,
  signal,
  modelRuntimes
}) => Promise<ExecutorSummary>
```

Direct non-workflow scans may retain the existing batch path for compatibility, but inherited workflow runs must use the durable executor.

- [ ] **Step 1: Write RED test reproducing the real data-loss bug**

In `tests/workflow_scan_analysis_smoke.js`, seed 5 saved JD checkpoints and inject an analyzer:

- job 1 success;
- job 2 success;
- job 3 throws a process-level error;
- jobs 4–5 never run.

Call the extracted workflow analysis phase. Assert jobs 1–2 are immediately model-complete in SQLite even though the phase rejects/interruption occurs. Assert tasks 4–5 remain pending.

- [ ] **Step 2: Write RED test for existing pending observations**

Seed a resumed batch with:

- one already successful model result;
- one rule-skipped result;
- one `analysis_pending`;
- one failed timeout.

Initialize/resume the phase and assert only pending/retry work is claimed; successful/skipped jobs are not analyzed again.

- [ ] **Step 3: Write RED test for report timing**

Assert `renderReports()` is invoked only after queue drain and workflow transition, not after a pause/interruption. A paused run keeps all saved jobs and can regenerate the report after resume.

- [ ] **Step 4: Run tests and verify RED**

Run:

```powershell
node tests/workflow_scan_analysis_smoke.js
node tests/scan_cli_lifecycle_smoke.js
```

Expected: new test fails because CLI still waits for `mapWithConcurrency()` and one final `upsertJob()` loop.

- [ ] **Step 5: Resolve both model runtimes at CLI entry**

At `scan()` setup:

```js
const primaryState = resolveRuntimeModelConfig({
  root: ROOT,
  fallbackModelConfig: configs.model,
  taskProfile: "batch_screening"
});
const backupState = resolveRuntimeBatchBackup({
  root: ROOT,
  fallbackModelConfig: configs.model
});
```

Use `primaryState.modelConfig` for `configs.model`. Save the immutable settings revision in the workflow before claims begin.

Do not route `profile-create`, resume parsing, plan recommendation or communication through batch screening; those remain deep analysis and are handled in Task 10.

- [ ] **Step 6: Replace only the workflow analysis block**

At the current `job_analysis_started` block:

1. keep `checkpointScannedJob()` behavior so raw facts/JD exist before analysis;
2. reload analysis candidates from `listReportJobs(db, { batchId, limit: 10000 })` so every queue item has a persisted numeric `job.id`; do not pass transient adapter objects to the queue;
3. for local-input workflow tests, checkpoint all raw input jobs with `upsertJob()` before that reload;
4. call `initializeWorkflowJobTasks()` with the persisted candidates;
5. transition to analyzing with DB-derived progress;
6. run `runWorkflowAnalysis()`;
7. if drained, verify no pending/running/retry tasks remain;
8. compute inventory from saved DB rows;
9. transition to `review_required`;
10. render reports from `listReportJobs()`.

Delete the workflow path’s:

```js
const analyzedJobs = await mapWithConcurrency(...);
for (const job of analyzedJobs) upsertJob(...);
```

The existing direct scan/refresh paths can keep `mapWithConcurrency()` until separately redesigned.

- [ ] **Step 7: Make analyzer failures throwable to the executor**

The current `createJobAnalysisRunner()` converts all errors to `failedAnalysis`, so the executor cannot distinguish retryable timeouts. Add option:

```js
createJobAnalysisRunner(configs, keywordPlan, {
  db,
  analyzer,
  logger,
  errorMode: "result" | "throw"
})
```

Default remains `"result"` for compatibility. Workflow executor uses `"throw"`. In throw mode:

- log the same redacted event;
- attach stage/phase metadata already produced by `cachedModelCall()`;
- rethrow before `failedAnalysis()`;
- keep model contract repair internal to one attempt.

Add a focused assertion that non-workflow callers still receive failed analysis objects.

- [ ] **Step 8: Add cooperative control checks around BOSS safe units**

During scanning, read `control_state`:

- before starting a new target;
- after `onTargetComplete` checkpoint;
- after each detail/card safe checkpoint already exposed by the adapter, if an existing callback supports it.

Do not add rapid polling or interrupt a page action mid-command. If pause/stop is observed, abort through a distinct controlled code that preserves the batch checkpoint and lets the outer lifecycle choose paused/stopped rather than generic failed.

- [ ] **Step 9: Run GREEN tests**

Run:

```powershell
node tests/workflow_scan_analysis_smoke.js
node tests/scan_cli_lifecycle_smoke.js
node tests/scan_end_to_end_recovery_smoke.js
node tests/analyzer_initialization_smoke.js
```

Expected: pass.

- [ ] **Step 10: Commit**

```powershell
git add src/cli.js src/core/job_analysis.js tests/workflow_scan_analysis_smoke.js tests/scan_cli_lifecycle_smoke.js tests/run_all.js
git commit -m "fix: save workflow analysis results per job"
```

---

### Task 6: Implement Pause, Resume, Stop, Recovery Generation and Run-Slot Rules

**Files:**
- Create: `src/core/workflow_control.js`
- Modify: `src/core/workflow_run.js`
- Modify: `src/core/storage.js`
- Create: `tests/workflow_control_smoke.js`
- Modify: `tests/workflow_recovery_smoke.js`
- Modify: `tests/workflow_planner_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**

```js
requestWorkflowPause(db, { workflowRunId, now }) => WorkflowRun
resumeWorkflowRun(db, {
  workflowRunId,
  batchModelRevision,
  batchModelVerifiedAt,
  now
}) => WorkflowRun
requestWorkflowStop(db, { workflowRunId, confirmStop, now }) => {
  workflow,
  stopConsumesRunSlot
}
finalizeWorkflowControl(db, { workflowRunId, now }) => WorkflowRun
workflowRunConsumesSlot(run) => boolean
workflowStopPreview(db, { workflowRunId }) => {
  collected,
  analyzed,
  failed,
  unfinished,
  access,
  consumesRunSlot
}
```

- [ ] **Step 1: Write RED state-transition and idempotency tests**

Cover:

- analyzing + pause → `pause_requested`; repeated pause does not change revision twice;
- after current tasks settle, finalize → `paused` with `resume_phase="analyzing"`;
- scanning pause records `resume_phase="scanning"`;
- paused + resume returns to saved phase;
- stopped/failed/completed cannot resume;
- pause is rejected during `review_required/communicating`;
- stop requires `confirmStop === true`;
- repeated stop on already stopped is idempotent.

- [ ] **Step 2: Write RED recovery-generation tests**

Seed a paused timeout-circuit workflow with final-timeout tasks. Assert resume:

- requires batch verification strictly after the pause `updated_at` or `last_activity_at`;
- increments `recovery_generation` once;
- resets circuit count to zero;
- retains lifetime count;
- changes previous generation final-timeout tasks to `retry_pending`;
- also carries the task that triggered a configuration/authentication pause into the new generation as `retry_pending`;
- sets their generation to the new value, `attempt_count_in_generation` to zero and priority 10;
- updates every unfinished task’s `model_config_revision` to the newly verified batch revision;
- leaves succeeded/skipped tasks unchanged;
- does not move unrelated terminal failures back to pending;
- repeated form submission cannot create another generation.

- [ ] **Step 3: Write RED run-slot tests**

Update planner fixtures:

- stopped before `platform_access_started_at` → does not count in `completedRuns/slotsUsed`;
- stopped after platform access → counts;
- paused/interrupted active run blocks creation of a separate run but is not double-counted;
- resumed same run keeps its sequence;
- completed/failed and access-consuming stopped runs count once;
- planned/consumed BOSS budget is never refunded after access.

Replace `runs.length` in Dashboard planning with `runs.filter(workflowRunConsumesSlot).length`, while active-run detection remains independent.

- [ ] **Step 4: Write RED exact-lease tests**

Create two fake workflow/scan records. Stopping run A must release/finish only the scan run and lease whose owner/run ID belongs to A; run B remains untouched. Never kill by port, site alone or process name.

- [ ] **Step 5: Run tests and verify RED**

Run:

```powershell
node tests/workflow_control_smoke.js
node tests/workflow_recovery_smoke.js
node tests/workflow_planner_smoke.js
```

Expected: missing control module or incorrect slot counts.

- [ ] **Step 6: Implement control domain**

All control functions reload the workflow in a transaction and validate current state. Use stable error codes:

```text
WORKFLOW_PAUSE_NOT_ALLOWED
WORKFLOW_RESUME_NOT_ALLOWED
WORKFLOW_STOP_CONFIRMATION_REQUIRED
WORKFLOW_RUN_TERMINAL
WORKFLOW_MODEL_RECHECK_REQUIRED
WORKFLOW_CONTROL_TARGET_MISMATCH
```

Configuration pauses and timeout-circuit pauses both require a post-pause batch model verification and create one new recovery generation. The task that exposed a configuration failure is not retried automatically before that user action. Manual pause without a model error resumes in the same generation with the existing verified revision.

- [ ] **Step 7: Update recovery**

`recoverWorkflowRuns()` must:

- preserve `paused` without touching BOSS or launching a child;
- recover expired running tasks before marking an orphaned analyzing run interrupted;
- never demote succeeded/skipped tasks;
- recognize analyzing recovery without requiring BOSS readiness;
- include paused in recoverable/active-run queries;
- return counts for recovered/failed tasks in its report.

- [ ] **Step 8: Run GREEN tests**

Run:

```powershell
node tests/workflow_control_smoke.js
node tests/workflow_recovery_smoke.js
node tests/workflow_planner_smoke.js
node tests/workflow_storage_smoke.js
```

Expected: pass.

- [ ] **Step 9: Commit**

```powershell
git add src/core/workflow_control.js src/core/workflow_run.js src/core/storage.js tests/workflow_control_smoke.js tests/workflow_recovery_smoke.js tests/workflow_planner_smoke.js tests/run_all.js
git commit -m "feat: add safe workflow pause resume and stop"
```

---

### Task 7: Build Database-Derived Progress, Activity and ETA

**Files:**
- Create: `src/core/workflow_progress.js`
- Modify: `src/core/storage.js`
- Create: `tests/workflow_progress_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**

```js
getWorkflowProgressSnapshot(db, {
  workflowRunId,
  now = new Date().toISOString(),
  recentActivityLimit = 8
}) => WorkflowProgressSnapshot

estimateWorkflowAnalysisEta({
  tasks,
  attempts,
  now,
  status,
  modelConfigRevision,
  concurrency
}) => {
  status,
  minSeconds,
  maxSeconds,
  sampleSize
}
```

- [ ] **Step 1: Write RED aggregate tests**

Seed tasks in every status and assert API counts exactly equal SQL row counts. Required invariant:

```js
total === pending + running + retryPending + succeeded + failed + skipped + stopped
```

Collected/detail counts come from persisted workflow metrics/observations, never from `scanRuns`.

- [ ] **Step 2: Write RED ETA tests**

Use fixed timestamps:

- 0–2 completed terminal task intervals → `estimating`, null bounds;
- 3 completed tasks → available range;
- only the newest 10 terminal completions with the current `model_config_revision` are used;
- old revision samples are excluded;
- paused → `paused` with frozen bounds saved in the snapshot calculation, no decreasing countdown;
- review/completed/stopped → `not_applicable`;
- retry-pending ratio widens only the upper bound;
- min is never greater than max, both are non-negative integers.

Use a deterministic estimator:

1. sort up to 10 terminal task `finished_at` values;
2. compute positive wall-clock intervals between consecutive completions;
3. throughput center = median interval;
4. lower interval = 25th percentile, upper interval = 75th percentile;
5. remaining work units = pending + retryPending + running;
6. upper work units additionally include `retryPending + running` once;
7. divide by effective concurrency;
8. round outward to seconds.

If fewer than 3 terminal tasks for the current revision exist, return estimating.

- [ ] **Step 3: Write RED redaction tests**

`recentActivity` may expose task ID, type, attempt, model role, stable error code and timestamp. Assert it does not contain job title/company/URL, JD, resume, prompt, raw model output, API key or full error message.

- [ ] **Step 4: Run tests and verify RED**

Run:

```powershell
node tests/workflow_progress_smoke.js
```

Expected: module missing.

- [ ] **Step 5: Implement bounded storage query**

One snapshot query may use grouped SQL plus a second bounded attempt query. It must:

- require exact workflow ID;
- cap recent activity at 20 internally;
- avoid returning job content;
- remain read-only;
- use the task/attempt indexes from v6;
- expose the current primary batch model identity from the workflow’s saved planner snapshot/settings revision, not global mutable defaults.

- [ ] **Step 6: Implement stage mapping**

Use fixed five-stage labels:

```text
1 准备本轮
2 读取搜索结果
3 获取完整 JD
4 分析岗位
5 等待确认 / 执行沟通
```

Map `created/scanning/analyzing/review_required/communicating/terminal` deterministically. Paused uses `resume_phase` for stage index while status remains paused.

- [ ] **Step 7: Run GREEN tests**

Run:

```powershell
node tests/workflow_progress_smoke.js
node tests/workflow_task_storage_smoke.js
```

Expected: pass.

- [ ] **Step 8: Commit**

```powershell
git add src/core/workflow_progress.js src/core/storage.js tests/workflow_progress_smoke.js tests/run_all.js
git commit -m "feat: expose durable workflow progress"
```

---

### Task 8: Add Workflow Status and Control HTTP APIs

**Files:**
- Modify: `src/dashboard/server.js`
- Modify: `tests/workflow_dashboard_smoke.js`

**Interfaces:**

```text
GET  /api/workflow-status?runId=<id>
POST /api/workflow-control
```

- [ ] **Step 1: Write RED status response tests**

In `tests/workflow_dashboard_smoke.js`, create a workflow with mixed task states and fetch status. Assert:

- response status 200;
- stable `progress/model/controls/recentActivity` shape;
- numbers match DB;
- secrets and job content are absent from serialized body;
- unknown run returns 404 `WORKFLOW_RUN_NOT_FOUND`;
- status read does not mutate workflow unless the existing orphan recovery has objective stale evidence.

- [ ] **Step 2: Write RED control endpoint tests**

POST pause/resume/stop and assert:

- URL-encoded form parsing;
- 303 redirect on success;
- 409 stable errors on illegal actions;
- stop without confirmation rejected;
- exact run ID validation;
- repeated requests idempotent;
- resume analyzing does not invoke browser readiness or navigate BOSS;
- resume scanning still uses the stored inherited browser authority and existing readiness guard.

- [ ] **Step 3: Run test and verify RED**

Run:

```powershell
node tests/workflow_dashboard_smoke.js
```

Expected: missing route or missing progress fields.

- [ ] **Step 4: Wire the read endpoint**

Replace `handleWorkflowStatus()`’s direct raw response assembly with:

```js
const snapshot = getWorkflowProgressSnapshot(db, { workflowRunId });
sendJson(res, 200, {
  workflow: publicWorkflow(snapshot.workflow),
  progress: snapshot.progress,
  model: snapshot.model,
  controls: snapshot.controls,
  recentActivity: snapshot.recentActivity,
  communication,
  today
});
```

`publicWorkflow()` may include IDs/status/control/activity/revision/counters, but omit `errorMessage` and verbose planner data. Preserve existing fields needed by current UI tests only when safe.

- [ ] **Step 5: Wire the control endpoint**

Add one route and handler. For `resume`:

- load the current batch model public state;
- require verified-after-pause only for model-caused pause;
- analyzing resume launches `startPlanScan()` with the same batch and `--workflow-run`; CLI must enter analysis without BOSS access when all scan targets are already checkpointed;
- scanning resume performs existing browser readiness validation before launching;
- never create a new workflow row or sequence.

For pause/stop, write DB control first. If the child is present, let it exit cooperatively. Only after the task/model timeout grace window may the Dashboard terminate `scanRuns.get(exactKey).child`, after rechecking its stored `workflowRunId`.

- [ ] **Step 6: Record first platform access**

At the first persisted BOSS `site_access` event belonging to the workflow run, set `platform_access_started_at = COALESCE(platform_access_started_at, eventTime)`. Do this in the existing access recording/checkpoint path, not from UI inference.

- [ ] **Step 7: Run GREEN tests**

Run:

```powershell
node tests/workflow_dashboard_smoke.js
node tests/workflow_control_smoke.js
node tests/workflow_recovery_smoke.js
```

Expected: pass.

- [ ] **Step 8: Commit**

```powershell
git add src/dashboard/server.js tests/workflow_dashboard_smoke.js
git commit -m "feat: add workflow progress and control APIs"
```

---

### Task 9: Replace the Static Workflow Message with a Live Data Panel

**Files:**
- Modify: `src/dashboard/server.js`
- Modify: `tests/workflow_dashboard_smoke.js`

**Visible requirements:**

- 顶部显示“第几阶段 / 共 5 阶段”和阶段名称。
- 分析卡显示总数、成功、处理中、等待重试、失败、剩余。
- 显示“当前恢复周期最终超时 N/10”和本轮累计超时。
- 少于 3 个样本显示“正在估算”；否则显示区间和样本数。
- 显示最近活动，但不显示岗位标题或敏感正文。
- 运行态显示主按钮“暂停本轮”和次要危险按钮“结束本轮…”。
- 暂停态显示暂停原因、测试模型连接、调整批量模型、继续本轮、结束本轮。
- 结束前必须在页面展示摘要和是否占当天轮次，再提交 `confirmStop=1`。
- 状态接口失败时显示“无法读取任务状态”，禁用控制按钮。
- 不允许通过 `location.reload()` 更新分析进度。

- [ ] **Step 1: Write RED HTML structure tests**

Assert initial workflow page contains stable hooks:

```text
data-workflow-panel
data-progress-revision
data-stage-label
data-analysis-succeeded
data-analysis-failed
data-analysis-remaining
data-analysis-timeouts
data-eta
data-recent-activity
data-action="pause"
data-action="stop-preview"
data-workflow-error
```

Assert form targets `/api/workflow-control` and includes exact run ID.

- [ ] **Step 2: Write RED script behavior tests**

Inspect returned script text and assert:

- polls `/api/workflow-status` every 2500 ms;
- compares `progressRevision`;
- updates text content through named rendering functions;
- contains no `location.reload()` in the workflow progress poller;
- handles non-OK/fetch rejection by showing error and disabling controls;
- stops or slows polling in terminal states;
- renders paused state immediately.

Use a small exported pure helper if string-only assertions become brittle:

```js
renderWorkflowProgressPanel(snapshot) => string
workflowProgressClientScript({ runId, initialRevision }) => string
```

- [ ] **Step 3: Write RED stop-preview tests**

The “结束本轮…” button first reveals/opens an inline confirmation section containing collected/analyzed/failed/unfinished/access usage and “会/不会占用今天一轮”. Only the second button posts `confirmStop=1`.

- [ ] **Step 4: Run test and verify RED**

Run:

```powershell
node tests/workflow_dashboard_smoke.js
```

Expected: old page only displays a static phase message and reload poller.

- [ ] **Step 5: Implement accessible server-rendered panel**

Initial HTML must already contain the DB snapshot so refresh/restart works without JavaScript. Use:

- `<progress>` or an ARIA-labelled progress bar for completed terminal tasks;
- text counts in addition to color;
- `aria-live="polite"` only on the compact status/activity region;
- disabled buttons during submitted control requests;
- a visually secondary red-outline stop action, not adjacent ambiguous primary buttons.

- [ ] **Step 6: Implement incremental client rendering**

Client code:

1. fetches every 2500 ms with `cache:"no-store"`;
2. validates minimum expected fields before rendering;
3. returns early when revision/status/control state is unchanged;
4. updates text and button states without inserting untrusted HTML;
5. uses `textContent`, never `innerHTML`, for API-derived values;
6. freezes ETA text when paused;
7. shows stale-activity warning when `lastActivityAt` exceeds the existing health threshold;
8. disables controls on fetch/validation error.

- [ ] **Step 7: Run GREEN tests**

Run:

```powershell
node tests/workflow_dashboard_smoke.js
node tests/data_visibility_smoke.js
```

Expected: pass.

- [ ] **Step 8: Commit**

```powershell
git add src/dashboard/server.js tests/workflow_dashboard_smoke.js
git commit -m "feat: render live workflow progress panel"
```

---

### Task 10: Route Product Calls to the Correct Model Profile and Redesign Settings UI

**Files:**
- Modify: `src/dashboard/server.js`
- Modify: `src/cli.js`
- Modify: `tests/model_settings_ui_smoke.js`
- Modify: `tests/onboarding_smoke.js`
- Modify: `tests/workflow_dashboard_smoke.js`

**Routing changes:**

```js
getRuntimeModelConfig("deep_analysis")
getRuntimeModelConfig("batch_screening")
modelReady("deep_analysis")
modelReady("batch_screening")
```

- [ ] **Step 1: Write RED routing tests**

Inject distinct fake models:

```text
deep_analysis-model
batch_screening-model
```

Assert:

- resume upload/profile/plan recommendation/matching card/communication draft call deep;
- single/bulk job retry and workflow start validation call batch;
- scan CLI uses batch;
- onboarding can proceed when deep is ready even if batch is not;
- starting a scan requiring analysis is blocked when batch is not ready, with a link to the batch settings section.

- [ ] **Step 2: Write RED settings HTML tests**

Assert `/settings` contains:

- two named sections with IDs `model-profile-deep_analysis` and `model-profile-batch_screening`;
- real `<select name="model">` options containing both `deepseek-v4-pro` and `deepseek-v4-flash` for DeepSeek;
- current and recommended values;
- “恢复推荐值” for each profile;
- deep concurrency fixed/displayed as 1;
- batch concurrency select/options 1 and 2;
- shared credential is the default;
- advanced independent credential controls;
- backup section default collapsed and disabled;
- backup verification warning;
- no secret values.

The current datalist-only model field is not sufficient; DeepSeek must have an explicit select. Custom providers may reveal a separate text input only after choosing “自定义模型”.

- [ ] **Step 3: Write RED POST tests**

Use route fields:

```text
taskProfile=deep_analysis|batch_screening
action=save|restore_recommended
preset
model
timeoutMs
thinkingMode
reasoningEffort
concurrency
credentialMode=shared|independent
apiKey
```

Backup fields use `taskProfile=batch_backup`.

Assert save redirects back to `/settings?profile=<id>&modelConfigured=1`, validation failures do not alter the prior verified configuration, and restore-recommended invalidates readiness until tested.

- [ ] **Step 4: Run tests and verify RED**

Run:

```powershell
node tests/model_settings_ui_smoke.js
node tests/onboarding_smoke.js
node tests/workflow_dashboard_smoke.js
```

Expected: old one-profile UI/routing fails.

- [ ] **Step 5: Refactor Dashboard model accessors**

Inside `createDashboardServer()` define:

```js
const getPublicModelSettings = () => ...;
const getRuntimeModel = (taskProfile) => ...;
const modelReady = (taskProfile, options) => ...;
```

Update every call site explicitly. Do not leave an argument-less accessor except a short compatibility wrapper used only by tests slated for removal.

- [ ] **Step 6: Implement task-profile save handler**

`handleModelSettingsSave()` dispatches by `taskProfile` and `action`. It must:

- reject unknown profile IDs;
- clamp/validate concurrency and timeout server-side;
- ignore disabled thinking controls only for unsupported models;
- test exact effective model before saving;
- never reuse another provider’s key implicitly;
- log only task profile, provider, model, revision, status and latency.

- [ ] **Step 7: Render the two-profile UI**

Reuse existing visual language, but make the core choices visible without opening “高级设置”. For each section:

- task purpose in plain Chinese;
- explicit provider and model select;
- thinking/strength;
- timeout;
- concurrency;
- connection state;
- recommended comparison;
- save/test and restore actions.

Keep provider/key sharing controls in a top-level credentials card. Independent credentials and backup stay under advanced details.

- [ ] **Step 8: Persist workflow model snapshots**

When creating a workflow, store in `planner_json.modelProfiles` only redacted immutable snapshots:

```js
{
  batch_screening: {
    revision,
    provider,
    model,
    thinkingMode,
    reasoningEffort,
    timeoutMs,
    concurrency
  },
  batch_backup: null | {
    revision,
    provider,
    model,
    thinkingMode,
    reasoningEffort,
    timeoutMs
  }
}
```

Never save base URL credentials or API keys in planner JSON. On resume, unfinished tasks use the current newly verified batch revision and attempts record that actual revision; succeeded tasks keep their existing results.

- [ ] **Step 9: Run GREEN tests**

Run:

```powershell
node tests/model_task_profiles_smoke.js
node tests/model_settings_smoke.js
node tests/model_settings_ui_smoke.js
node tests/onboarding_smoke.js
node tests/workflow_dashboard_smoke.js
node tests/analyzer_initialization_smoke.js
```

Expected: pass.

- [ ] **Step 10: Commit**

```powershell
git add src/dashboard/server.js src/cli.js tests/model_settings_ui_smoke.js tests/onboarding_smoke.js tests/workflow_dashboard_smoke.js
git commit -m "feat: route deep and batch model profiles"
```

---

### Task 11: Prove End-to-End Crash, Pause and Resume Behavior Offline

**Files:**
- Modify: `tests/workflow_end_to_end_smoke.js`
- Modify: `tests/scan_end_to_end_recovery_smoke.js`
- Modify: `tests/workflow_recovery_smoke.js`
- Modify: `tests/run_all.js` only if a new file is split out

- [ ] **Step 1: Add RED crash-after-success scenario**

Drive the real storage + executor + workflow functions:

1. create workflow and 8 tasks;
2. complete 3;
3. simulate child disappearance with task 4 lease expired;
4. run recovery;
5. assert 3 successes remain;
6. resume same workflow/generation when not circuit-paused;
7. finish remaining tasks;
8. assert exactly 8 terminal tasks and no duplicate attempts.

- [ ] **Step 2: Add RED manual pause scenario**

With concurrency 2:

1. let two tasks run;
2. request pause;
3. release both fake model promises;
4. assert both results save;
5. assert no third claim;
6. resume same run;
7. drain remaining tasks;
8. assert sequence/slot unchanged.

- [ ] **Step 3: Add RED automatic timeout recovery scenario**

1. produce 10 final-timeout jobs;
2. assert safe pause;
3. try resume without new verification and expect rejection;
4. record successful connection after pause;
5. resume and assert generation +1;
6. assert old timeout jobs are claimed before untouched pending;
7. succeed those tasks;
8. assert lifetime timeout count remains and circuit count is zero.

- [ ] **Step 4: Add RED stop scenario**

Stop once before any site access and once after site access. Assert terminal state, precise lease release, preserved saved results, no resume and correct daily slots.

- [ ] **Step 5: Run tests and verify RED**

Run:

```powershell
node tests/workflow_end_to_end_smoke.js
node tests/scan_end_to_end_recovery_smoke.js
node tests/workflow_recovery_smoke.js
```

Expected: at least one new scenario fails before final integration corrections.

- [ ] **Step 6: Make the smallest integration fixes**

Only adjust production behavior required by the failing scenarios. Do not add special-case test branches. Keep all recovery decisions based on persisted state and timestamps.

- [ ] **Step 7: Run GREEN tests**

Run the same three commands. Expected: pass.

- [ ] **Step 8: Commit**

```powershell
git add tests/workflow_end_to_end_smoke.js tests/scan_end_to_end_recovery_smoke.js tests/workflow_recovery_smoke.js tests/run_all.js src/core/workflow_analysis_tasks.js src/core/workflow_analysis_executor.js src/core/workflow_control.js src/core/workflow_progress.js src/core/workflow_run.js src/core/storage.js src/core/model_settings.js src/core/product_policy.js src/core/job_analysis.js src/cli.js src/dashboard/server.js
git status --short
```

Before committing, inspect the staged list and unstage anything outside the specific integration fix. Then:

```powershell
git commit -m "test: cover durable workflow recovery end to end"
```

---

### Task 12: Document User Operations and Failure Diagnosis

**Files:**
- Modify: `docs/daily_workflow.md`
- Modify: `docs/operations.md`
- Modify: `README.md` only if it already links to the daily workflow/settings docs

- [ ] **Step 1: Update the daily workflow guide**

Add beginner-readable sections with exact UI labels:

1. what the five stages mean;
2. how to read success/failure/retry/remaining;
3. when ETA is only “正在估算”;
4. how “暂停本轮” differs from “结束本轮…”;
5. why an automatic timeout pause occurs at 10;
6. exact recovery order: open model settings → test batch model → return to workflow → continue;
7. whether stop occupies today’s run slot;
8. reminder that communication does not start automatically.

- [ ] **Step 2: Update operations diagnosis**

Document read-only queries/commands:

```powershell
node src/cli.js dashboard
node -e "const {openDb}=require('./src/core/storage'); const db=openDb('data/jobs.sqlite'); console.log(db.prepare('select id,status,control_state,recovery_generation,circuit_timeout_job_count,lifetime_timeout_job_count,last_activity_at from workflow_runs order by created_at desc limit 5').all()); db.close()"
```

Also document:

- task-status aggregate query;
- latest redacted attempts query;
- how to identify an expired lease;
- how to distinguish manual pause, timeout circuit, auth pause and orphan interruption;
- never edit statuses manually as routine recovery;
- backup locations created by schema migration.

- [ ] **Step 3: Verify documentation matches implemented names**

Run:

```powershell
rg -n "暂停本轮|结束本轮|MODEL_TIMEOUT_CIRCUIT_OPEN|deep_analysis|batch_screening|workflow_job_tasks|job_analysis_attempts" docs README.md
rg -n "TODO|TBD|待定|稍后补充" docs/daily_workflow.md docs/operations.md
```

Expected: required terms are present; no placeholder text introduced.

- [ ] **Step 4: Commit**

```powershell
git add docs/daily_workflow.md docs/operations.md
git diff --cached --check
git commit -m "docs: explain durable workflow progress"
```

If `README.md` needed a link change, run `git add README.md` before `git diff --cached --check`. Otherwise leave it unstaged.

---

### Task 13: Run Full Offline Verification and Migration Rehearsal

**Files:**
- Modify only if verification reveals a real regression.

- [ ] **Step 1: Run static diff checks**

```powershell
git diff --check
git status --short --branch
```

Expected: no whitespace errors; only intentional branch changes plus the known user-owned untracked plan.

- [ ] **Step 2: Run all offline tests**

```powershell
npm test
```

Expected final line:

```text
All <N> offline checks passed.
```

If a test hits the 120-second runner timeout, first run that test alone and diagnose the blocking handle. Do not merely raise the global timeout unless the test is intentionally exercising a bounded model timeout with a shorter injected clock.

- [ ] **Step 3: Run a v5 database-copy migration rehearsal**

Do not open the real production DB directly with unreviewed branch code. Make a recoverable copy on `D:`:

```powershell
$sourceDb = (Resolve-Path "data\jobs.sqlite").Path
$rehearsalDir = "D:\DevData\RoleFlow-migration-rehearsal-20260806"
New-Item -ItemType Directory -Force -Path $rehearsalDir | Out-Null
$rehearsalDb = Join-Path $rehearsalDir "jobs-v5-copy.sqlite"
Copy-Item -LiteralPath $sourceDb -Destination $rehearsalDb -Force
node src/cli.js init-db --db $rehearsalDb
```

Then run a read-only integrity/count check:

```powershell
node -e "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1],{readOnly:true}); console.log({version:db.prepare('pragma user_version').get().user_version,quick:db.prepare('pragma quick_check').get().quick_check,jobs:db.prepare('select count(*) n from jobs').get().n,workflows:db.prepare('select count(*) n from workflow_runs').get().n,tasks:db.prepare('select count(*) n from workflow_job_tasks').get().n}); db.close()" $rehearsalDb
```

Expected: version 6, quick check `ok`, pre-existing counts preserved, and a pre-v6 backup beside the rehearsal DB.

- [ ] **Step 4: Verify secrets and public payloads**

Run:

```powershell
node tests/model_task_profiles_smoke.js
node tests/model_settings_ui_smoke.js
node tests/data_visibility_smoke.js
node tests/observability_context_smoke.js
```

Expected: pass. Inspect one workflow status fixture and confirm it contains no API key, JD, resume, prompt, raw output or full error message.

- [ ] **Step 5: Review the final diff against design invariants**

Run:

```powershell
git diff main...HEAD --stat
git diff main...HEAD -- src/core/product_policy.js src/core/storage.js src/core/workflow_analysis_tasks.js src/core/workflow_analysis_executor.js src/core/workflow_control.js src/core/workflow_progress.js src/cli.js src/dashboard/server.js
```

Manually confirm:

- no BOSS concurrency increase;
- no reduced detail/card budgets;
- no new automatic communication path;
- no infinite recovery loop;
- no whole-batch result array remains in the workflow path;
- no secret/raw model content is persisted;
- stopped-before-access slot behavior is implemented.

- [ ] **Step 6: Commit any verification-only fixes separately**

If no fixes were needed, do not create an empty commit. If fixes were needed:

```powershell
git commit -m "fix: close durable workflow verification gaps"
npm test
```

Before that commit, stage each actually fixed file with an explicit `git add path\to\file` command. Do not use a directory, wildcard, `git add .` or `git add -A`.

---

### Task 14: Conduct a Controlled 5–10 Job Live Acceptance

**This task is not automatically authorized by plan execution. Stop and obtain the user’s explicit approval before any real BOSS navigation or scan. Do not start communication.**

**Files/Data:**
- Use a fresh isolated database under `D:\DevData`, not historical production job data.
- Preserve candidate profile, resume, matching card, search plan and model settings as explicitly copied acceptance fixtures.

- [ ] **Step 1: Ask for explicit live-read approval**

State the exact scope:

- one existing logged-in project Edge session;
- one inherited search scope;
- 1–2 current user-selected keywords;
- at most 5–10 complete JD reads;
- no communication/application;
- serial BOSS access with existing pacing and cooldowns.

Do not continue without approval.

- [ ] **Step 2: Create a fresh evaluation database**

Use an explicit path such as:

```text
D:\DevData\RoleFlow-durable-progress-acceptance-20260806\jobs.sqlite
```

Do not delete or reset the production DB. Copy only the approved profile/settings fixtures needed for the run.

- [ ] **Step 3: Verify login/readiness read-only**

Open/read the existing project Edge tabs through the project’s normal startup path. Confirm actual login state and inherited search page before starting. Respect all BOSS safety stops.

- [ ] **Step 4: Run the small inherited workflow**

Observe:

- stage/count changes every completed job;
- each successful job appears in DB immediately;
- ETA begins estimating and only becomes a range after 3 terminal samples;
- no extra tabs/windows or parallel BOSS access.

- [ ] **Step 5: Exercise manual pause/resume**

Pause during analysis, verify in-flight jobs settle/save, verify no new claim, then resume the same run. Analysis-phase resume must not navigate BOSS.

- [ ] **Step 6: Exercise timeout pause only through a controlled test setting**

Prefer an injected/fake upstream in the isolated acceptance environment. Do not deliberately abuse the live provider. Verify threshold behavior and the post-pause connection-test gate.

- [ ] **Step 7: Record acceptance evidence**

Record only redacted counts, timestamps, task statuses, attempts, model revision and UI screenshots without resume/JD/API key content. Compare DB counts with the panel.

- [ ] **Step 8: Stop before communication**

The acceptance ends at `review_required` or an explicitly tested stopped state. Do not create/confirm/execute a communication batch.

- [ ] **Step 9: Report the result and integration options**

Report:

- pass/fail for each acceptance criterion;
- exact remaining defects;
- migration backup path;
- branch and commits;
- whether it is safe to merge.

Use the `finishing-a-development-branch` skill only after all offline tests and the approved live acceptance are complete.

---

## Final Acceptance Checklist

- [ ] Every successful job is queryable immediately after its own completion.
- [ ] Killing/interruption after N successes does not lose those N results.
- [ ] A task is never simultaneously owned by two workers.
- [ ] One recovery generation allows at most two job-level attempts.
- [ ] The 10th unique final timeout in the current generation opens the circuit.
- [ ] No new generation is created without post-pause verification and user resume.
- [ ] Previous-generation final timeouts are retried before untouched pending jobs.
- [ ] Pause and resume keep the same workflow ID and daily sequence.
- [ ] Stop is terminal and releases only the target run’s resources.
- [ ] Stop before platform access does not consume a daily slot; stop after access does.
- [ ] The panel’s totals equal task-table totals.
- [ ] ETA uses at least 3 and at most 10 current-revision terminal samples.
- [ ] Paused ETA does not count down.
- [ ] Existing users retain their current model behavior after settings migration.
- [ ] New users see explicit Pro/Flash choices and recommended two-profile values.
- [ ] Backup is off by default, separately verified and only used on attempt 2.
- [ ] Resume/profile/plan/card/communication use `deep_analysis`.
- [ ] Job understanding/matching/retry use `batch_screening`.
- [ ] Public API/logs/DB attempts contain no secrets or sensitive model payloads.
- [ ] BOSS page access remains serial and quality budgets are unchanged.
- [ ] All offline tests pass.
- [ ] A separately approved 5–10 job live acceptance passes before merge.
