# RoleFlow 逐岗位工作流进度 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为扫描、完整 JD、岗位分析和沟通提供来自 SQLite 已保存事实的独立进度条和逐岗位状态，并用局部更新取代无意义的整页刷新。

**Architecture:** 扫描适配器只在现有 DOM 提取和详情读取节点回传本地进度，CLI 复用现有 scan checkpoint 和 `workflow_runs.progress_revision` 落库。`workflow_progress.js` 继续是轻量读模型，Dashboard 继续使用 2.5 秒 HTTP 轮询、原生 `<progress>` 和稳定 DOM ID 局部更新；不增加数据表、长连接服务或前端框架。

**Tech Stack:** Node.js >= 22.5、CommonJS、SQLite / `better-sqlite3` 现有封装、原生 HTML/CSS/JavaScript、现有 assert 型 smoke tests。

## Global Constraints

- 在现有 `codex/first-principles-audit` 优化分支上连续实施；不再创建课题分支或额外 worktree。
- 严格以 `docs/superpowers/specs/2026-08-16-per-job-workflow-progress-design.md` 为产品语义；不计算跨阶段综合百分比。
- 不新增依赖、数据库迁移、进度事件表、WebSocket、SSE 或常驻进度服务。
- 产品 JD 路径只允许 `trusted_pane`；不启用、修复、验证、优化或删除 `search_page_api`，不使用 `standalone_detail`。
- 保留既有 `BOSS-SEARCH` 和 `BOSS-COMMUNICATION` 两个操作员固定标签；操作串行，不新建标签、窗口或 BOSS 会话。
- 不新增 `Page.bringToFront` 或前台抢占逻辑；保留用户主动启动工作台时唯一有意义的引导调用。
- 扫描 checkpoint 不得增加 `evalValue`、滚动、导航、详情读取、等待、重试或并发；必须保留随机节奏、冷却、租约和风控即停。
- 不降低卡片覆盖、JD 覆盖、召回、匹配质量、分析质量或沟通核验要求。
- 不访问真实 BOSS，不执行真实沟通、申请或其他外部写。
- 不运行 `tests/startup_scripts_smoke.js`；它的未签名 `msedge.exe` fixture 会触发 360 拦截。
- 不直接运行当前硬编码 `channel: "msedge"` 的 `scripts/evaluate-workflow-dashboard.js`；任何本地可视化验收必须显式使用 `--browser-channel chrome` 和隔离 SQLite。
- 每个非平凡逻辑先写最小回归检查，确认失败后再写实现；每个任务独立验证并提交。

---

## File Map

### Production files

- Modify `src/core/workflow_progress.js`: 统一四阶段语义、扫描目标计数、JD 需求分类、扫描动作快照、安全逐任务状态和服务端逐岗位显示行。
- Modify `src/storage/scan_store.js`: 在现有 `filter_snapshot_json.runtime` 中验证并合并有界 `scanProgress`，保留 `bossPacing`。
- Modify `src/adapters/sites/boss.js`: 在现有卡片增长、详情开始和目标终态节点发出本地回调，不增加任何 BOSS 命令。
- Modify `src/cli.js`: 把扫描回调转换为已评分 observation、`runtime.scanProgress` 和现有 workflow revision。
- Modify `src/dashboard/server.js`: 注册沟通静态资产，在分析阶段服务端渲染当前任务显示行。
- Modify `src/dashboard/view_models/workflow.js`: 把读模型映射为四条轨道、结构阶段键和逐岗位分析行。
- Modify `src/dashboard/pages/workflow.js`: 服务端渲染四个原生 `<progress>`、文字分数、当前动作和分析岗位列表。
- Modify `src/dashboard/assets/workflow.js`: 同阶段局部更新轨道、分析行和控件，只在结构阶段变化时刷新一次。
- Modify `src/dashboard/view_models/communication.js`: 向沟通页提供不可变批次轮询身份和初始条目集。
- Modify `src/dashboard/pages/communication.js`: 渲染沟通进度条、稳定条目 hook、错误区和静态资产。
- Create `src/dashboard/assets/communication.js`: 只负责沟通批次可见时轮询、局部更新、错误禁用和单次结构刷新。
- Modify `src/dashboard/assets/roleflow.css`: 追加紧凑轨道、逐岗位状态和窄屏样式；不重写现有样式系统。
- Modify `scripts/evaluate-workflow-dashboard.js`: 仅新增显式 `--browser-channel` 参数和 6 个隔离岗位的分析页验收态，保留原有 Edge 默认能力但本机验收只传 `chrome`。

### Tests and authority docs

- Modify `tests/workflow_progress_smoke.js`
- Modify `tests/scan_recovery_smoke.js`
- Modify `tests/source_acquisition_smoke.js`
- Modify `tests/scan_end_to_end_recovery_smoke.js`
- Modify `tests/workflow_dashboard_smoke.js`
- Modify `tests/dashboard_communication_batch_smoke.js`
- Verify unchanged `tests/communication_application_smoke.js`
- Modify `docs/PROJECT_HANDOFF.md`
- Modify `docs/NEXT_PHASE.md`

---

### Task 1: Make the SQLite progress read model truthful and privacy-safe

**Files:**
- Modify: `src/core/workflow_progress.js:7-190`
- Modify: `src/core/workflow_progress.js:319-460`
- Test: `tests/workflow_progress_smoke.js:152-486`

**Interfaces:**
- Produces: `getWorkflowProgressSnapshot(db, { workflowRunId, now, recentActivityLimit, communicationSummary })`
- Produces: `listWorkflowProgressJobs(db, workflowRunId)` for server-rendered HTML only
- Produces: `progress.phaseKey`, `progress.scan`, `progress.scanTargets.processed`, `progress.details.required`, `progress.details.notRequired`, `progress.details.growing`, `progress.analysis.terminal`, `progress.analysis.tasks`, and numeric `progress.tracks`
- Privacy contract: each polled task is exactly `{ id, position, status, lastErrorCode }`; only `DETAIL_REQUIRED` is allowed through `lastErrorCode`

- [ ] **Step 1: Add failing read-model tests for four stages, terminal targets, JD demand, task rows, and privacy**

Add focused assertions to the existing seeded scenarios:

```js
assert.deepStrictEqual(scanning.progress.scanTargets, {
  total: 3,
  processed: 2,
  completed: 0,
  partial: 1,
  failed: 1,
  pending: 1
});
assert.deepStrictEqual(scanning.progress.details, {
  collected: 3,
  required: 2,
  read: 1,
  pending: 1,
  notRequired: 1,
  growing: true
});
assert.strictEqual(scanning.progress.stageCount, 4);
assert.strictEqual(scanning.progress.stageIndex, 2);
assert.strictEqual(analyzing.progress.stageIndex, 3);
assert.strictEqual(review.progress.stageIndex, 4);
assert.deepStrictEqual(analyzing.progress.analysis.tasks, [
  { id: taskIds[0], position: 1, status: "running", lastErrorCode: null },
  { id: taskIds[1], position: 2, status: "skipped", lastErrorCode: "DETAIL_REQUIRED" },
  { id: taskIds[2], position: 3, status: "failed", lastErrorCode: null }
]);
assert.strictEqual(analyzing.progress.analysis.terminal, 2);
assert.deepStrictEqual(scanning.progress.tracks, {
  scan: { value: 2, max: 3, indeterminate: false },
  jd: { value: 1, max: 2, indeterminate: false, growing: true },
  analysis: { value: 0, max: 0, indeterminate: false },
  communication: { value: 0, max: 0, indeterminate: false }
});

const displayRows = listWorkflowProgressJobs(db, scenario.workflowId);
assert.deepStrictEqual(displayRows.map((row) => Object.keys(row).sort()), [
  ["company", "lastErrorCode", "position", "status", "taskId", "title"],
  ["company", "lastErrorCode", "position", "status", "taskId", "title"],
  ["company", "lastErrorCode", "position", "status", "taskId", "title"]
]);
assert(!JSON.stringify(analyzing.progress.analysis.tasks).includes("Private Company"));
assert(!JSON.stringify(analyzing.progress.analysis.tasks).includes("Private Job Title"));
```

Seed `filter_snapshot_json.runtime.scanProgress` with a known frozen `targetKey` and assert the public scan object resolves its label from `execution.cityScopes` and `execution.targets`, not from a runtime label:

```js
assert.deepStrictEqual(scanning.progress.scan, {
  activity: "reading_detail",
  targetKey: "101280100|RAG|default",
  targetLabel: "广州 · RAG",
  targetPosition: 2,
  targetTotal: 3,
  targetDiscovered: 12,
  detailPosition: 4,
  detailTotal: 7
});
```

- [ ] **Step 2: Run the focused test and confirm the new assertions fail**

Run:

```powershell
node tests/workflow_progress_smoke.js
```

Expected: FAIL because the current model has five stages, counts `partial` and `failed` as pending, uses `collected - read` for JD pending, and does not expose safe per-task rows.

- [ ] **Step 3: Implement the four-stage and count semantics in the existing read model**

Use these exact public stage families:

```js
const WORKFLOW_STAGES = Object.freeze([
  "准备本轮",
  "采集岗位与完整 JD",
  "分析岗位",
  "确认清单与执行沟通"
]);
const STATUS_STAGE_INDEX = Object.freeze({
  created: 1,
  scanning: 2,
  analyzing: 3,
  review_required: 4,
  communicating: 4,
  completed: 4,
  failed: 4,
  stopped: 4
});
```

For paused/interrupted runs, derive `phaseKey` and stage index from `resume_phase`, then from communication/review/task/scan evidence in the same precedence already used by `stageIndexFor()`:

```js
function phaseKeyFor(workflow) {
  const resumed = ["paused", "interrupted"].includes(workflow.status)
    ? String(workflow.resume_phase || "")
    : "";
  if (resumed === "scanning" || workflow.status === "scanning") return "acquisition";
  if (resumed === "analyzing" || workflow.status === "analyzing") return "analysis";
  if (workflow.status === "communicating") return "communication";
  if (workflow.status === "review_required") return "review";
  if (["completed", "failed", "stopped"].includes(workflow.status)) return "terminal";
  return "preparing";
}
```

Classify each current-batch observation once:

```js
const tags = parseJson(row.quality_tags_json, []);
if (hasCompleteJobDescription(row)) read += 1;
else if (Array.isArray(tags) && tags.includes("detail_unverified")) pending += 1;
else notRequired += 1;
return {
  collected: rows.length,
  required: read + pending,
  read,
  pending,
  notRequired
};
```

Count latest target statuses with terminal processing separated from successful completion:

```js
if (status === "completed") counts.completed += 1;
else if (status === "partial") counts.partial += 1;
else if (status === "failed") counts.failed += 1;
if (["completed", "partial", "failed"].includes(status)) counts.processed += 1;
counts.pending = Math.max(0, counts.total - counts.processed);
```

Build the four numeric track models once in this read model so the initial HTML and later JSON polling use the same values:

```js
const tracks = {
  scan: {
    value: scanTargets.processed,
    max: scanTargets.total,
    indeterminate: phaseKey === "acquisition" && scanTargets.total === 0
  },
  jd: {
    value: details.read,
    max: details.required,
    indeterminate: phaseKey === "acquisition" && details.required === 0,
    growing: details.growing
  },
  analysis: {
    value: counts.terminal,
    max: counts.total,
    indeterminate: phaseKey === "analysis" && counts.total === 0
  },
  communication: {
    value: communication.terminal,
    max: communication.total,
    indeterminate: phaseKey === "communication" && communication.total === 0
  }
};
```

`communication.terminal` is `total - pending`; `ambiguous` is a terminal item status that triggers human resolution, so it must remain inside the terminal numerator.

- [ ] **Step 4: Add bounded scan progress and safe task rows without leaking display content**

Read `position` and `last_error_code` in the existing ordered task query. The polled projection must be:

```js
const publicTask = (row) => ({
  id: Number(row.id),
  position: Number(row.position),
  status: String(row.status || ""),
  lastErrorCode: row.last_error_code === "DETAIL_REQUIRED" ? "DETAIL_REQUIRED" : null
});
```

Parse `runtime.scanProgress`, reject it from the snapshot if its `targetKey` is absent from frozen `execution.targets`, and derive `targetLabel` only from the frozen target and city scope:

```js
const city = execution.cityScopes.find((entry) => entry?.cityCode === target.cityCode)?.city
  || target.cityCode;
const targetLabel = [city, target.keyword].filter(Boolean).join(" · ");
```

Add a separate server-only query:

```js
function listWorkflowProgressJobs(db, workflowRunId) {
  return db.prepare(`
    SELECT t.id AS task_id, t.position, t.status, t.last_error_code,
      o.title, o.company
    FROM workflow_job_tasks t
    JOIN job_observations o ON o.id = t.observation_id
    WHERE t.workflow_run_id = ?
    ORDER BY t.position ASC, t.id ASC
  `).all(String(workflowRunId || "").trim()).map((row) => ({
    taskId: Number(row.task_id),
    position: Number(row.position),
    status: String(row.status || ""),
    lastErrorCode: row.last_error_code === "DETAIL_REQUIRED" ? "DETAIL_REQUIRED" : null,
    title: String(row.title || ""),
    company: String(row.company || "")
  }));
}
```

Export it beside `getWorkflowProgressSnapshot`; do not place `title` or `company` inside the polled snapshot.

- [ ] **Step 5: Run the read-model test and related privacy/budget test**

Run:

```powershell
node tests/workflow_progress_smoke.js
node tests/workflow_dashboard_smoke.js
```

Expected: both PASS. Update the existing workflow status row budget only by the exact additional current-task rows returned by the already-existing ordered task query; do not add plan-wide or history-table reads.

- [ ] **Step 6: Commit the truthful read model**

```powershell
git add src/core/workflow_progress.js tests/workflow_progress_smoke.js tests/workflow_dashboard_smoke.js
git commit -m "fix: make workflow progress counts truthful"
```

---

### Task 2: Persist only bounded scan runtime progress

**Files:**
- Modify: `src/storage/scan_store.js:444-540`
- Test: `tests/scan_recovery_smoke.js:47-208`

**Interfaces:**
- Consumes: existing `checkpointScanProgress(db, input)` and `checkpointScanTarget(db, input)`
- Consumes: `input.runtime.bossPacing` unchanged
- Produces: validated `input.runtime.scanProgress`
- `scanProgress` schema: `{ version: 1, activity, targetKey, targetPosition, targetTotal, targetDiscovered, detailPosition, detailTotal, updatedAt }`

- [ ] **Step 1: Add failing storage tests for merge, bounds, frozen target identity, and rollback**

Create a scan batch whose frozen execution contains one target, save pacing first, then save scan progress:

```js
checkpointScanProgress(database, {
  runId,
  batchId,
  leaseOwner: context.owner,
  jobs: [],
  runtime: { bossPacing: { accessCount: 3 } }
});
checkpointScanProgress(database, {
  runId,
  batchId,
  leaseOwner: context.owner,
  jobs: [],
  runtime: {
    scanProgress: {
      version: 1,
      activity: "reading_detail",
      targetKey: "101280100|RAG|default",
      targetPosition: 1,
      targetTotal: 1,
      targetDiscovered: 6,
      detailPosition: 2,
      detailTotal: 4,
      updatedAt: "2099-01-01T00:00:00.000Z"
    }
  }
});
const runtime = getBatch(database, batchId).filterSnapshot.runtime;
assert.deepStrictEqual(runtime.bossPacing, { accessCount: 3 });
assert.strictEqual(runtime.scanProgress.targetDiscovered, 6);
```

Then assert an unknown target rolls back all changes:

```js
const before = getBatch(database, batchId).filterSnapshot;
assert.throws(() => checkpointScanProgress(database, {
  runId,
  batchId,
  leaseOwner: context.owner,
  jobs: [job("must-roll-back", "Must Roll Back")],
  runtime: { scanProgress: { version: 1, activity: "searching", targetKey: "unknown" } }
}), (error) => error.code === "SCAN_PROGRESS_INVALID");
assert.deepStrictEqual(getBatch(database, batchId).filterSnapshot, before);
assert.strictEqual(database.prepare("SELECT COUNT(*) AS n FROM jobs WHERE source_id = 'must-roll-back'").get().n, 0);
```

- [ ] **Step 2: Run the storage test and confirm it fails**

```powershell
node tests/scan_recovery_smoke.js
```

Expected: FAIL because `updateBatchRuntimeSnapshot()` currently accepts arbitrary runtime objects and does not validate frozen target identity.

- [ ] **Step 3: Normalize `scanProgress` inside the existing checkpoint transaction**

Keep `bossPacing` untouched and normalize only the new field:

```js
const SCAN_PROGRESS_ACTIVITIES = new Set(["searching", "reading_detail", "target_complete"]);

function normalizeScanProgress(value, execution) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw scanRunError("SCAN_PROGRESS_INVALID", "scan progress must be an object");
  }
  const targetKey = String(value.targetKey || "").trim();
  const target = (Array.isArray(execution?.targets) ? execution.targets : [])
    .find((entry) => entry?.targetKey === targetKey);
  if (!target || Number(value.version) !== 1 || !SCAN_PROGRESS_ACTIVITIES.has(String(value.activity || ""))) {
    throw scanRunError("SCAN_PROGRESS_INVALID", "scan progress does not match the frozen execution target");
  }
  const integer = (input) => Math.max(0, Math.floor(Number(input) || 0));
  const updatedAt = String(value.updatedAt || "");
  if (!Number.isFinite(Date.parse(updatedAt))) {
    throw scanRunError("SCAN_PROGRESS_INVALID", "scan progress updatedAt must be ISO time");
  }
  const targetPosition = integer(value.targetPosition);
  const targetTotal = integer(value.targetTotal);
  const targetDiscovered = integer(value.targetDiscovered);
  const detailPosition = integer(value.detailPosition);
  const detailTotal = integer(value.detailTotal);
  const frozenPosition = execution.targets.findIndex((entry) => entry?.targetKey === targetKey) + 1;
  if (targetPosition !== frozenPosition
    || targetTotal !== execution.targets.length
    || targetDiscovered > Number(target.cardLimit || 0)
    || detailPosition > detailTotal
    || detailTotal > targetDiscovered) {
    throw scanRunError("SCAN_PROGRESS_INVALID", "scan progress counters exceed the frozen target bounds");
  }
  return {
    version: 1,
    activity: String(value.activity),
    targetKey,
    targetPosition,
    targetTotal,
    targetDiscovered,
    detailPosition,
    detailTotal,
    updatedAt
  };
}
```

In `updateBatchRuntimeSnapshot()`, parse the existing frozen snapshot first, copy runtime, and replace only `scanProgress` with the normalized value when that property is present. The same transaction must still cover observation writes, runtime update, heartbeat, and target result.

- [ ] **Step 4: Run storage and contract regression tests**

```powershell
node tests/scan_recovery_smoke.js
node tests/scan_store_contract_smoke.js
node tests/workflow_store_contract_smoke.js
```

Expected: all PASS; export counts and owner references remain unchanged because no new store export is introduced.

- [ ] **Step 5: Commit bounded runtime persistence**

```powershell
git add src/storage/scan_store.js tests/scan_recovery_smoke.js
git commit -m "feat: persist bounded scan progress"
```

---

### Task 3: Checkpoint observed cards and current scan activity without adding BOSS operations

**Files:**
- Modify: `src/adapters/sites/boss.js:1064-1415`
- Modify: `src/adapters/sites/boss.js:1516-1593`
- Modify: `src/adapters/sites/boss.js:2617-2624`
- Modify: `src/cli.js:1245-1337`
- Test: `tests/source_acquisition_smoke.js:328-452`
- Test: `tests/scan_end_to_end_recovery_smoke.js:820-940`

**Interfaces:**
- Produces adapter option: `onProgressCheckpoint(event)`
- Event shape: `{ activity, targetKey, targetPosition, targetTotal, targetDiscovered, detailPosition, detailTotal, jobs }`
- `jobs` contains only newly observed unique cards for `searching`; it is empty for position-only checkpoints
- Reuses: `checkpointScanProgress`, `checkpointScanTarget`, `incrementWorkflowRunActivity`, and `checkpointScannedJob`

- [ ] **Step 1: Add a failing card-growth test that records new unique batches and browser command counts**

Extend the existing scroll fixture so the same card appears in multiple extraction rounds. Record all browser calls before and after enabling the callback:

```js
const batches = [];
const result = await adapter.collectCards(
  "tab",
  4,
  null,
  null,
  async ({ cards, total }) => batches.push({ ids: cards.map((entry) => entry.sourceId), total })
);
assert.deepStrictEqual(batches, [
  { ids: ["progress-1", "progress-2"], total: 2 },
  { ids: ["progress-3", "progress-4"], total: 4 }
]);
assert.strictEqual(result.cards.length, 4);
assert.deepStrictEqual(commandCountsWithCheckpoint, commandCountsWithoutCheckpoint);
```

The command-count object must count `evalValue`, `scrollList`, navigation, detail reads, waits, and retry attempts separately; every count must be equal.

- [ ] **Step 2: Add a failing adapter event-order test**

For one target with two selected details, assert this ordered projection:

```js
assert.deepStrictEqual(events.map((event) => [
  event.activity,
  event.targetPosition,
  event.detailPosition,
  event.detailTotal,
  event.jobs.length
]), [
  ["searching", 1, 0, 0, 0],
  ["searching", 1, 0, 0, 2],
  ["reading_detail", 1, 1, 2, 0],
  ["reading_detail", 1, 2, 2, 0]
]);
```

Keep `onTargetComplete` as the existing terminal event; do not duplicate it inside `onProgressCheckpoint`.

- [ ] **Step 3: Run the adapter test and confirm it fails**

```powershell
node tests/source_acquisition_smoke.js
```

Expected: FAIL because `collectCards()` currently returns only the final card set and has no progress callback.

- [ ] **Step 4: Implement unique-batch emission inside existing extraction rounds**

Change the private merge helper to return the newly added card objects:

```js
function mergeUniqueCards(found, cards) {
  const added = [];
  for (const card of cards || []) {
    const key = bossSourceId(card) || `${card.company}|${card.title}|${card.salary}|${card.cardText}`;
    if (found.has(key)) continue;
    found.set(key, card);
    added.push(card);
  }
  return added;
}
```

After each existing `__bossExtractCards` result, await the callback only when `added.length > 0`. Pass the same callback through `waitForCardGrowth()`; retain its public `{ grew, added, polls }` shape by returning `added.length`.

- [ ] **Step 5: Emit normalized scan events from `scanBrowser()`**

At target start, emit a local `searching` event before `navigateWithPacing()`. Pass a closure into `collectCards()` that normalizes only the new cards and applies the existing `shouldReadDetail` decision:

```js
const progressJob = (card) => {
  const job = normalizeBossJob({ ...card, keyword, source: "boss", searchCity: city.city || "" });
  job.detailRequired = typeof options.shouldReadDetail !== "function"
    || options.shouldReadDetail(job) !== false;
  return job;
};
```

Resume filtering must not change the user-visible frozen denominator. Keep the existing `targetPosition` and `targetCount` variables for remaining-detail allocation, but emit these separate frozen values:

```js
const frozenTargetPosition = allTargets.findIndex((entry) => entry.targetKey === targetKey) + 1;
const frozenTargetTotal = allTargets.length;
```

Every `onProgressCheckpoint` and `onTargetComplete` runtime snapshot uses `frozenTargetPosition` and `frozenTargetTotal`; resumed execution therefore reports the original target order rather than renumbering the remaining subset.

Extend each existing `onTargetComplete` result with these numeric fields so CLI can persist `target_complete` without reconstructing adapter state:

```js
targetPosition: frozenTargetPosition,
targetTotal: frozenTargetTotal,
targetDiscovered,
detailPosition: lastDetailPosition,
detailTotal
```

Initialize `targetDiscovered`, `lastDetailPosition`, and `detailTotal` to zero outside the target `try` block; update them only from already-observed card and detail-loop facts so the failed-target callback can report the last safe position.

Immediately before each existing detail read, emit `reading_detail` with the 1-based detail position and fixed `detailEntries.length`. These awaits are local checkpoints and must occur before the next BOSS command, so a checkpoint failure stops safely.

- [ ] **Step 6: Add a failing end-to-end persistence/revision test**

In the fake adapter used by `scan_end_to_end_recovery_smoke.js`, invoke `options.onProgressCheckpoint` with one card-growth event and one position event, then invoke the existing detail and target callbacks. Assert:

```js
assert.strictEqual(observationCount, 2);
assert.deepStrictEqual(batch.filterSnapshot.runtime.scanProgress, {
  version: 1,
  activity: "target_complete",
  targetKey: frozenTargetKey,
  targetPosition: 1,
  targetTotal: 1,
  targetDiscovered: 2,
  detailPosition: 1,
  detailTotal: 1,
  updatedAt: batch.filterSnapshot.runtime.scanProgress.updatedAt
});
assert.strictEqual(afterRevision - beforeRevision, 4);
```

The four revision bumps are: new-card checkpoint, detail-position checkpoint, successful detail checkpoint, and target terminal checkpoint. Add a pacing-only callback after them and assert the revision remains unchanged.

- [ ] **Step 7: Run the end-to-end test and confirm the new assertions fail**

```powershell
node tests/scan_end_to_end_recovery_smoke.js
```

Expected: FAIL because CLI does not yet persist `onProgressCheckpoint` or bump workflow revision for scan facts.

- [ ] **Step 8: Persist progress through the existing CLI checkpoints**

Import the already-exported `incrementWorkflowRunActivity`. Add one local helper inside the scan command:

```js
const checkpointVisibleScanProgress = ({ jobs = [], scanProgress }) => {
  checkpointScanProgress(db, {
    runId: execution.runId,
    batchId,
    leaseOwner: execution.leaseOwner,
    jobs: jobs.map((raw) => checkpointScannedJob(raw, configs)),
    runtime: { scanProgress: { version: 1, ...scanProgress, updatedAt: new Date().toISOString() } }
  });
  if (workflowRun) incrementWorkflowRunActivity(db, {
    workflowRunId: workflowRun.id,
    now: new Date().toISOString()
  });
};
```

Use it for `onProgressCheckpoint`. Add matching `runtime.scanProgress` to `onTargetComplete`, and call `incrementWorkflowRunActivity` after successful target/detail checkpoints. Leave `onPacingCheckpoint` exactly as pacing-only storage with no revision bump.

Wrap any failure from the local checkpoint or revision update with existing `SCAN_CHECKPOINT_FAILED`, while preserving `SCAN_LEASE_LOST` and `SCAN_RUN_LEASE_MISMATCH` unchanged.

- [ ] **Step 9: Run scan regressions and verify no browser-call growth**

```powershell
node tests/source_acquisition_smoke.js
node tests/boss_safe_pacing_smoke.js
node tests/scan_recovery_smoke.js
node tests/scan_end_to_end_recovery_smoke.js
node tests/workflow_scan_smoke.js
```

Expected: all PASS; the new command-count assertion proves no extra BOSS operation.

- [ ] **Step 10: Commit scan progress checkpoints**

```powershell
git add src/adapters/sites/boss.js src/cli.js tests/source_acquisition_smoke.js tests/scan_end_to_end_recovery_smoke.js
git commit -m "feat: checkpoint observed scan progress"
```

---

### Task 4: Server-render four progress tracks and analysis job rows

**Files:**
- Modify: `src/dashboard/server.js:166-200`
- Modify: `src/dashboard/server.js:3958-3993`
- Modify: `src/dashboard/view_models/workflow.js:6-117`
- Modify: `src/dashboard/pages/workflow.js:8-60`
- Modify: `src/dashboard/assets/roleflow.css`
- Test: `tests/workflow_dashboard_smoke.js:1580-1824`

**Interfaces:**
- Consumes: `listWorkflowProgressJobs(db, workflowRunId)` from Task 1
- Consumes numeric read-model tracks: `progressSnapshot.progress.tracks.scan`, `.jd`, `.analysis`, and `.communication`
- Produces view model: `progress.tracks.scan`, `progress.tracks.jd`, `progress.tracks.analysis`, `progress.tracks.communication`, adding only display fractions and labels
- Produces view model: `progress.analysisJobs[]`
- Produces DOM hooks: `[data-progress-track]`, `[data-track-meter]`, `[data-track-fraction]`, `[data-analysis-task-id]`, `[data-analysis-task-status]`, `[data-current-activity]`

- [ ] **Step 1: Add failing HTML/view-model tests for all four tracks and six analysis rows**

Seed six tasks covering `pending`, `running`, `retry_pending`, `succeeded`, `skipped/DETAIL_REQUIRED`, and `failed`. Assert the server page contains:

```js
for (const track of ["scan", "jd", "analysis", "communication"]) {
  assert.match(page.body, new RegExp(`data-progress-track="${track}"`));
  assert.match(page.body, new RegExp(`data-track-meter="${track}"`));
  assert.match(page.body, new RegExp(`data-track-fraction="${track}"`));
}
assert.strictEqual((page.body.match(/data-analysis-task-id=/g) || []).length, 6);
assert.match(page.body, /<progress[^>]+aria-describedby="workflow-track-scan-description"/);
assert.match(page.body, /aria-live="polite"[^>]*data-current-activity/);
assert.doesNotMatch(page.body, /data-overall-percentage/);
```

Assert the initial page includes the six seeded titles and companies, while the `/api/workflow-status` response does not include any of them.

- [ ] **Step 2: Run the dashboard test and confirm it fails**

```powershell
node tests/workflow_dashboard_smoke.js
```

Expected: FAIL because only one analysis meter exists and no analysis task list is rendered.

- [ ] **Step 3: Pass server-only analysis rows into the workflow view model**

Import `listWorkflowProgressJobs` beside `getWorkflowProgressSnapshot`. Query display rows only when `progressSnapshot.progress.phaseKey === "analysis"`:

```js
const progressJobs = progressSnapshot?.progress?.phaseKey === "analysis"
  ? listWorkflowProgressJobs(db, workflow.id)
  : [];
```

Pass `progressJobs` into `buildWorkflowViewModel`. Do not add it to `handleWorkflowStatus()` or the JSON response.

- [ ] **Step 4: Build four explicit track view models**

Format the numeric read-model tracks without recalculating their semantics:

```js
tracks: {
  scan: {
    ...source.tracks.scan,
    fraction: `${number(source.tracks.scan.value)} / ${number(source.tracks.scan.max)}`
  },
  jd: {
    ...source.tracks.jd,
    fraction: `${number(source.tracks.jd.value)} / ${number(source.tracks.jd.max)}`
  },
  analysis: {
    ...source.tracks.analysis,
    fraction: `${number(source.tracks.analysis.value)} / ${number(source.tracks.analysis.max)}`
  },
  communication: {
    ...source.tracks.communication,
    fraction: `${number(source.tracks.communication.value)} / ${number(source.tracks.communication.max)}`
  }
}
```

Map initial rows by `taskId`, retain title/company only in the view model used for HTML, and use the fixed Chinese status labels:

```js
const ANALYSIS_STATUS_LABELS = Object.freeze({
  pending: "等待分析",
  running: "分析中",
  retry_pending: "等待重试",
  succeeded: "已完成",
  skipped: "已按本地规则处理",
  failed: "分析失败",
  stopped: "已停止"
});
```

When `lastErrorCode === "DETAIL_REQUIRED"`, display `详情待补` instead of the generic skipped label.

- [ ] **Step 5: Render native progress and accessible task rows in the primary page flow**

Place the track section directly after `本轮概览`, outside the collapsed technical details. Each track must follow this shape:

```html
<section class="workflow-track" data-progress-track="scan" aria-labelledby="workflow-track-scan-label">
  <div class="workflow-track-head">
    <h3 id="workflow-track-scan-label">扫描岗位</h3>
    <strong data-track-fraction="scan">2 / 5</strong>
  </div>
  <progress data-track-meter="scan" aria-describedby="workflow-track-scan-description" max="5" value="2"></progress>
  <p id="workflow-track-scan-description">已处理 2 个目标；成功 1、部分 1、失败 0</p>
</section>
```

Omit `value` for an active zero-denominator track. Analysis rows must use:

```html
<article class="workflow-task-row" data-analysis-task-id="123">
  <span class="workflow-task-position">#1</span>
  <span class="workflow-task-name"><strong>RAG 工程师</strong><small>示例公司</small></span>
  <span class="workflow-task-status" data-analysis-task-status>分析中</span>
</article>
```

Set `aria-current="step"` only on the current running row. Use one `data-current-activity aria-live="polite"` node for changed activity text; remove the old live region from the complete recent-activity paragraph to prevent repeated reading.

- [ ] **Step 6: Append minimal responsive styles**

Append focused selectors without reformatting unrelated CSS:

```css
.workflow-tracks{display:grid;gap:10px;margin-top:14px}.workflow-track{padding:12px;border:1px solid var(--rf-rule);background:#fff}.workflow-track-head{display:flex;justify-content:space-between;gap:12px;align-items:center}.workflow-track progress{width:100%;margin:8px 0;accent-color:var(--rf-teal)}.workflow-task-row{display:grid;grid-template-columns:40px minmax(0,1fr) auto;gap:10px;padding:9px 0;border-bottom:1px solid var(--rf-rule)}.workflow-task-name small{display:block;color:var(--rf-ink-soft)}@media(max-width:760px){.workflow-task-row{grid-template-columns:32px minmax(0,1fr)}.workflow-task-status{grid-column:2}}
```

Do not add continuous animation or override the existing `@media(prefers-reduced-motion:reduce)` rule. Add a dashboard assertion that the shared stylesheet still contains that rule after the appended selectors.

- [ ] **Step 7: Run server-render and accessibility regressions**

```powershell
node tests/workflow_progress_smoke.js
node tests/workflow_dashboard_smoke.js
node tests/dashboard_shell_smoke.js
node tests/workflow_page_migration_smoke.js
```

Expected: all PASS; there is no combined percentage and no polled title/company leakage.

- [ ] **Step 8: Commit the server-rendered progress UI**

```powershell
git add src/dashboard/server.js src/dashboard/view_models/workflow.js src/dashboard/pages/workflow.js src/dashboard/assets/roleflow.css tests/workflow_dashboard_smoke.js
git commit -m "feat: render per-job workflow progress"
```

---

### Task 5: Update workflow tracks and task rows locally

**Files:**
- Modify: `src/dashboard/assets/workflow.js:17-170`
- Test: `tests/workflow_dashboard_smoke.js:1826-1940`

**Interfaces:**
- Consumes: `/api/workflow-status?runId=...` from Task 1
- Consumes: `progress.phaseKey`, numeric `progress.tracks`, and `progress.analysis.tasks[]`
- Produces: local DOM updates and at most one structural reload
- Polling invariant: visible active page = 2.5 seconds; hidden page = zero requests; one request in flight

- [ ] **Step 1: Replace the client fixture with failing local-update and lifecycle assertions**

Feed snapshots with the same `phaseKey` but changing track counts and one task moving `running -> succeeded`. Assert:

```js
assert.strictEqual(scanFraction.textContent, "2 / 5");
assert.strictEqual(jdFraction.textContent, "4 / 7");
assert.strictEqual(analysisFraction.textContent, "3 / 6");
assert.strictEqual(taskStatus.textContent, "已完成");
assert.strictEqual(taskRow.hasAttribute("aria-current"), false);
assert.strictEqual(reloads, 0);
assert.strictEqual(fetches, 1);
```

Then trigger `visibilitychange` twice while hidden and twice while visible:

```js
assert.strictEqual(fetchesWhileHidden, 0);
assert.strictEqual(fetchesAfterVisible, 1);
assert.strictEqual(maxConcurrentFetches, 1);
assert.strictEqual(activeTimerCount, 1);
```

Finally feed `phaseKey: "review"` after `phaseKey: "analysis"` and assert `reloads === 1` even if more timer callbacks fire.

Add an error response and assert the last successful fractions remain, the inline error becomes visible, and workflow action buttons become disabled.

- [ ] **Step 2: Run the client test and confirm it fails**

```powershell
node tests/workflow_dashboard_smoke.js
```

Expected: FAIL because the current script reloads on any status/control change, has no task-row renderer, and uses a one-second scheduler around a 2.5-second poll gate.

- [ ] **Step 3: Use one phase-family comparison instead of raw status/control comparisons**

Render `data-workflow-phase-key` on the page. Replace `structureChanged()` with:

```js
const structureChanged = (snapshot) => String(snapshot.progress.phaseKey || "")
  !== String(page.dataset.workflowPhaseKey || "");
```

Pause/resume and `controlState` changes in the same family must only update controls. Review, communication, ambiguity, and terminal family changes call the existing guarded `requestReload()` once.

- [ ] **Step 4: Add minimal generic meter and task-row updaters**

```js
const renderTrack = (name, track = {}) => {
  setText(`[data-track-fraction="${name}"]`, `${number(track.value)} / ${number(track.max)}`);
  const meter = node(`[data-track-meter="${name}"]`);
  if (!meter) return;
  meter.max = Math.max(1, number(track.max));
  if (track.indeterminate) meter.removeAttribute("value");
  else meter.value = Math.min(meter.max, number(track.value));
};

const renderAnalysisTasks = (tasks = []) => {
  for (const task of tasks) {
    const row = node(`[data-analysis-task-id="${number(task.id)}"]`);
    if (!row) continue;
    const status = row.querySelector("[data-analysis-task-status]");
    if (status) status.textContent = analysisStatusText(task);
    if (task.status === "running") row.setAttribute("aria-current", "step");
    else row.removeAttribute("aria-current");
  }
};
```

Update the single live region only when the activity key `[activity,targetKey,targetPosition,detailPosition]` changes.

- [ ] **Step 5: Simplify polling to one scheduled request path**

Use a recursive `setTimeout` after each completed request rather than stacking intervals:

```js
function schedule(delay = interval) {
  stopTimer();
  if (reloadRequested || document.hidden || terminal.has(page.dataset.workflowStatus)) return;
  timer = setTimeout(async () => {
    timer = null;
    await pollWorkflow();
    schedule(interval);
  }, delay);
}
```

On `visibilitychange` to visible, call `schedule(0)`; the `pollInFlight` guard still prevents overlap. Keep the existing one-second cooldown countdown as a separate local-only timer only if it is active; it must not trigger HTTP requests.

- [ ] **Step 6: Run workflow client and API regressions**

```powershell
node tests/workflow_dashboard_smoke.js
node tests/workflow_progress_smoke.js
node tests/workflow_application_smoke.js
```

Expected: all PASS; same-phase snapshots update in place, hidden pages send no requests, and structural change reloads once.

- [ ] **Step 7: Commit local workflow updates**

```powershell
git add src/dashboard/assets/workflow.js tests/workflow_dashboard_smoke.js
git commit -m "fix: update workflow progress without reloads"
```

---

### Task 6: Add local per-item communication progress

**Files:**
- Create: `src/dashboard/assets/communication.js`
- Modify: `src/dashboard/server.js:192-201`
- Modify: `src/dashboard/view_models/communication.js:9-67`
- Modify: `src/dashboard/pages/communication.js:7-56`
- Modify: `src/dashboard/assets/roleflow.css`
- Test: `tests/dashboard_communication_batch_smoke.js:43-130`
- Test: `tests/dashboard_communication_batch_smoke.js:450-510`
- Verify: `tests/communication_application_smoke.js:160-210`

**Interfaces:**
- Consumes unchanged: `GET /api/communication-status?batchId=<positive integer>`
- Produces page data: `data-communication-page`, `data-communication-batch-id`, `data-communication-item-ids`, `data-communication-batch-status`
- Produces DOM hooks: `[data-communication-meter]`, `[data-communication-terminal]`, `[data-communication-success]`, `[data-communication-remaining]`, `[data-communication-item-id]`, `[data-communication-item-status]`

- [ ] **Step 1: Add failing server-render tests for progress, stable IDs, and the asset**

Assert an active batch page contains:

```js
assert.match(html, /data-communication-page/);
assert.match(html, /data-communication-batch-id="\d+"/);
assert.match(html, /data-communication-item-ids="[\d,]+"/);
assert.match(html, /<progress[^>]+data-communication-meter/);
assert.match(html, /data-communication-terminal/);
assert.match(html, /data-communication-item-id="\d+"/);
assert.match(html, /data-communication-item-status/);
assert.match(html, /<script src="\/assets\/communication\.js"><\/script>/);
```

Assert `no_batch` and `integrity_blocked` pages do not start polling because they have no batch ID.

- [ ] **Step 2: Add a failing VM client test for item updates, hidden polling, ambiguity, drift, and errors**

Run the new asset in the same `node:vm` style used by workflow tests. Feed a normal update first:

```js
assert.strictEqual(terminalNode.textContent, "2");
assert.strictEqual(successNode.textContent, "1");
assert.strictEqual(remainingNode.textContent, "2");
assert.strictEqual(itemStatus.textContent, "身份已核验");
assert.strictEqual(activeItem.getAttribute("aria-current"), "step");
assert.strictEqual(reloads, 0);
```

Then verify:

```js
assert.strictEqual(fetchesWhileHidden, 0);
assert.strictEqual(fetchesAfterVisible, 1);
assert.strictEqual(maxConcurrentFetches, 1);
assert.strictEqual(reloadsAfterAmbiguous, 1);
assert.strictEqual(reloadsAfterRepeatedAmbiguous, 1);
assert.strictEqual(reloadsAfterItemSetDrift, 1);
assert.strictEqual(errorNode.hidden, false);
assert.strictEqual(terminalNode.textContent, "2");
assert(communicationControls.every((control) => control.disabled));
```

- [ ] **Step 3: Run the communication dashboard test and confirm it fails**

```powershell
node tests/dashboard_communication_batch_smoke.js
```

Expected: FAIL because the communication page has no polling asset or stable local-update hooks.

- [ ] **Step 4: Add immutable polling identity to the existing view model and page**

Return polling only for an existing active batch:

```js
polling: batch.id && !TERMINAL_BATCH_STATUSES.has(text(batch.status)) ? {
  batchId: number(batch.id),
  batchStatus: text(batch.status),
  intervalMs: 2500,
  itemIds: items.map((item) => number(item.id)).sort((left, right) => left - right)
} : null
```

Extend the existing view-model terminal set to `completed`, `stopped`, `interrupted`, and `failed` before applying this condition.

Render the initial IDs as a comma-separated numeric list. Add `data-communication-control` to controls that can start, resume, rebind, discard, or resolve an external state. Add a hidden `role="alert"` error node while keeping the last visible counts.

- [ ] **Step 5: Register and implement the small communication asset**

Register `/assets/communication.js` in `DASHBOARD_ASSETS`. The client must validate:

```js
const sameItems = (items) => items.map((item) => number(item.id))
  .sort((left, right) => left - right).join(",") === initialItemIds;
const active = new Set(["opening", "verified", "click_dispatched"]);
const terminalBatches = new Set(["completed", "stopped", "interrupted", "failed"]);
const statusLabels = Object.freeze({
  pending: "待执行",
  opening: "正在核对",
  verified: "身份已核验",
  click_dispatched: "已发出操作",
  succeeded: "已核验成功",
  already_communicated: "已确认已沟通",
  ambiguous: "结果待人工确认",
  stopped: "已停止",
  job_unavailable: "岗位不可用",
  target_mismatch: "目标不匹配",
  action_unavailable: "操作不可用",
  platform_rejected: "平台拒绝",
  transport_failed: "传输失败"
});
```

For a normal response, update summary numbers, meter, and item status labels by ID. Reload once when:

```js
Number(data.summary?.statusCounts?.ambiguous || 0) > 0
  || (data.items || []).some((item) => item.status === "ambiguous")
  || terminalBatches.has(data.batch.status)
  || number(data.batch.id) !== batchId
  || !sameItems(data.items || [])
```

Use guarded recursive `setTimeout`, stop while hidden, poll immediately when visible, and never issue a second fetch while one is in flight. A failed fetch must show the error, disable `[data-communication-control]`, keep existing progress, and schedule the next read without reloading.

- [ ] **Step 6: Append communication progress styles**

```css
.communication-progress{margin:14px 0;padding:12px;border:1px solid var(--rf-rule);background:#fff}.communication-progress progress{width:100%;margin:8px 0;accent-color:var(--rf-teal)}.communication-item[aria-current="step"]{border-left:4px solid var(--rf-orange);padding-left:10px}
```

Use visible status text for every state; color remains supplementary.

- [ ] **Step 7: Run communication API, server-render, and client regressions**

```powershell
node tests/communication_application_smoke.js
node tests/dashboard_communication_batch_smoke.js
node tests/workflow_communication_smoke.js
node tests/communication_executor_smoke.js
```

Expected: all PASS. The existing API remains unchanged, ambiguity is never auto-resolved, and uncertain results are never retried.

- [ ] **Step 8: Commit local communication updates**

```powershell
git add src/dashboard/assets/communication.js src/dashboard/server.js src/dashboard/view_models/communication.js src/dashboard/pages/communication.js src/dashboard/assets/roleflow.css tests/dashboard_communication_batch_smoke.js
git commit -m "feat: update communication progress in place"
```

---

### Task 7: Safe visual acceptance, full offline regression, and authority docs

**Files:**
- Modify: `scripts/evaluate-workflow-dashboard.js:7-31`
- Modify: `scripts/evaluate-workflow-dashboard.js:33-61`
- Modify: `scripts/evaluate-workflow-dashboard.js:145-155`
- Modify: `docs/PROJECT_HANDOFF.md`
- Modify: `docs/NEXT_PHASE.md`

**Interfaces:**
- Produces evaluator option: `--browser-channel <name>`
- Safe local command must pass: `--browser-channel chrome`
- Produces screenshots and JSON under project-local `.runtime/workflow-progress-evidence`

- [ ] **Step 1: Add explicit browser-channel parsing without changing product code**

Extend evaluator options:

```js
const browserChannel = values.get("--browser-channel") || "msedge";
return { help: false, targetRoot, outputDir, label, expectPrimary, browserChannel };
```

Launch with the chosen channel and report it:

```js
result.browser = { engine: options.browserChannel, headless: true };
browser = await chromium.launch({ channel: options.browserChannel, headless: true });
```

Add the help line:

```text
--browser-channel <name>   Playwright browser channel (default: msedge; use chrome on 360-protected hosts)
```

- [ ] **Step 2: Expand only the isolated visual fixture to six analysis jobs**

Seed six local jobs named `Workflow progress role 1` through `Workflow progress role 6`, initialize six workflow tasks, and set their statuses to `pending`, `running`, `retry_pending`, `succeeded`, `skipped/DETAIL_REQUIRED`, and `failed`. Add an `analyzing` workflow state to `STATES` and its run ID to the seed return value:

```js
const progressJobs = Array.from({ length: 6 }, (_, index) => {
  const jobId = storage.upsertJob(db, {
    source: "boss",
    sourceId: `workflow-progress-${index + 1}`,
    keyword: "RAG",
    title: `Workflow progress role ${index + 1}`,
    company: `Fixture Company ${index + 1}`,
    url: `https://www.zhipin.com/job_detail/workflow-progress-${index + 1}.html`,
    description: "Complete local-only RAG job description. ".repeat(8),
    qualityTags: [],
    analysis: { semanticStatus: "pending", decisionSource: "analysis_pending" }
  }, batchId);
  const observationId = Number(db.prepare(`
    SELECT id FROM job_observations WHERE batch_id = ? AND job_id = ?
  `).get(batchId, jobId).id);
  return { jobId, observationId, position: index + 1 };
});
const analyzing = create("workflow-eval-analyzing", "2099-01-05");
storage.transitionWorkflowRun(db, { id: analyzing.id, status: "scanning" });
db.prepare("UPDATE workflow_runs SET scan_batch_id = ?, status = 'analyzing' WHERE id = ?")
  .run(batchId, analyzing.id);
initializeWorkflowJobTasks(db, {
  workflowRunId: analyzing.id,
  batchId,
  jobs: progressJobs,
  modelConfigRevision: "workflow-progress-eval",
  now
});
const statuses = ["pending", "running", "retry_pending", "succeeded", "skipped", "failed"];
const tasks = db.prepare(`
  SELECT id FROM workflow_job_tasks WHERE workflow_run_id = ? ORDER BY position
`).all(analyzing.id);
tasks.forEach((task, index) => db.prepare(`
  UPDATE workflow_job_tasks
  SET status = ?, last_error_code = ?, finished_at = ?
  WHERE id = ?
`).run(
  statuses[index],
  index === 4 ? "DETAIL_REQUIRED" : null,
  ["succeeded", "skipped", "failed"].includes(statuses[index]) ? now : null,
  task.id
));
```

Import `initializeWorkflowJobTasks` from `src/core/workflow_analysis_tasks.js`. Do not create production-only fixture code. The evaluator remains local SQLite, mock readiness, no BOSS, no model, and no communication execution.

Update the evaluator's primary-action expectation so both active machine-driven states have no primary action:

```js
const expectedPrimaryCount = ["scanning", "analyzing"].includes(result.state) ? 0 : 1;
```

- [ ] **Step 3: Run focused behavior checks once more before visual acceptance**

```powershell
node tests/source_acquisition_smoke.js
node tests/scan_recovery_smoke.js
node tests/scan_end_to_end_recovery_smoke.js
node tests/workflow_progress_smoke.js
node tests/workflow_dashboard_smoke.js
node tests/communication_application_smoke.js
node tests/dashboard_communication_batch_smoke.js
```

Expected: all seven commands PASS.

- [ ] **Step 4: Run isolated visual acceptance with Chrome, never Edge**

Load the bundled Node package path, but use the installed signed Chrome channel explicitly:

```powershell
$env:NODE_PATH = 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
node scripts/evaluate-workflow-dashboard.js --target-root . --label per-job-progress --output-dir .runtime/workflow-progress-evidence --browser-channel chrome --expect-primary
$exit = $LASTEXITCODE
Remove-Item Env:NODE_PATH
if ($exit -ne 0) { exit $exit }
```

Expected:

- JSON report has zero `errors`.
- `scanning`, `analyzing`, `paused`, `review_required`, and `interrupted` render at 1440×900, 1024×768, 768×1024, and 375×812 without horizontal overflow.
- The analyzing screenshots show all six job rows, readable status text, four progress tracks, and no continuous animation under reduced motion.
- No external request leaves the local dashboard origin.
- No `msedge.exe` process is started by this command.

Open the generated PNG files with the local image viewer and inspect at least the 1440×900 and 375×812 analyzing screenshots. If layout is unclear, change only the focused CSS selectors from Tasks 4 and 6, rerun `workflow_dashboard_smoke.js`, and repeat this exact Chrome command.

- [ ] **Step 5: Run all safe registered offline checks**

Do not run `npm test` or `node tests/run_all.js`, because both would execute the 360-blocked startup fixture. Run the same registered list with that one file excluded:

```powershell
$files = Select-String -Path tests/run_all.js -Pattern '^\s+"([^"]+\.js)"' |
  ForEach-Object { $_.Matches[0].Groups[1].Value } |
  Where-Object { $_ -ne 'startup_scripts_smoke.js' }
foreach ($file in $files) {
  node (Join-Path tests $file)
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
"Safe offline checks passed: $($files.Count) / $($files.Count + 1); startup_scripts_smoke.js excluded for 360 safety."
```

Expected: `96 / 97` safe registered checks pass. Report the excluded test explicitly; do not describe it as a failure.

- [ ] **Step 6: Run fresh JavaScript syntax and safety-boundary checks**

```powershell
$jsFiles = @(rg --files -g '*.js')
foreach ($file in $jsFiles) {
  node --check $file
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
"JavaScript syntax checks passed: $($jsFiles.Count)"

$foreground = @(rg -n "Page\.bringToFront|browser\.bringToFront" src -g '*.js')
$foreground
if ($foreground.Count -ne 1) { throw "expected exactly one meaningful startup foreground call" }

$productApi = @(rg -n "detailMode\s*:\s*[\"']search_page_api[\"']|--detail-mode[^\r\n]*search_page_api" src/cli.js src/dashboard src/application -g '*.js')
if ($productApi.Count -ne 0) { $productApi; throw "search_page_api entered a product pass-through" }
```

Expected: all JS files pass syntax; exactly one meaningful startup foreground call remains; no product pass-through enables `search_page_api`.

- [ ] **Step 7: Update authority docs with measured evidence**

In `docs/PROJECT_HANDOFF.md`, record:

- the four-track SQLite read-model architecture;
- scan/JD interleaving and `processed` target semantics;
- exact JD denominator `read + pending` and `notRequired` exclusion;
- per-job analysis and communication local updates;
- no added BOSS operations and preserved fixed-tab/focus boundaries;
- exact safe test count, syntax count, Chrome visual evidence path, and the one 360-blocked startup fixture.

In `docs/NEXT_PHASE.md`, mark this topic complete and advance to the next design topic in the already-agreed risk order. Do not copy this implementation plan into either authority document.

- [ ] **Step 8: Verify the final diff contains only intended files**

```powershell
git diff --check
git status --short
git diff --stat HEAD~6..HEAD
```

Expected: no whitespace errors, no generated `.runtime` evidence staged, no database file staged, and no unrelated user changes modified.

- [ ] **Step 9: Commit evaluator and authority docs**

```powershell
git add scripts/evaluate-workflow-dashboard.js docs/PROJECT_HANDOFF.md docs/NEXT_PHASE.md
git commit -m "docs: complete per-job progress phase"
```

- [ ] **Step 10: Perform post-commit verification before reporting completion**

```powershell
git status --short --branch
git log -7 --oneline --decorate
git diff HEAD^ HEAD --check
```

Expected: worktree clean, seven topic commits visible after the design commit, and the final documentation commit has no whitespace errors. Do not push, merge, tag, or release.

---

## Execution Order and Stop Conditions

1. Execute Tasks 1–7 strictly in order because each later interface consumes the previous task.
2. Stop immediately if any test shows added BOSS commands, lost fixed-tab identity, title/JD/message leakage in the lightweight workflow API, automatic ambiguous-result handling, or reduced JD demand.
3. Stop before any browser command if a scan checkpoint fails; never continue to the next BOSS operation with unsaved observed facts.
4. If Chrome visual acceptance cannot start, report that isolated visual gate as blocked; do not fall back to `msedge`, do not install a browser on `C:`, and do not access real BOSS.
5. Every commit remains local until the user separately authorizes push, merge, or release.
