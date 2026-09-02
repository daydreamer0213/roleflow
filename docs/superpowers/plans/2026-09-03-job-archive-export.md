# Job Archive and Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户可逆地整理岗位并导出当前筛选或已选岗位，同时保持求职状态、消息和漏斗统计完全不变。

**Architecture:** 用一张候选人维度的 `candidate_job_archives` 表保存当前归档状态，岗位查询只投影 `archived` 字段，统计查询不自动过滤。Dashboard 的岗位记录和行动清单显式排除归档项；CSV 由服务端按当前用户、方案和筛选重新查询并安全编码。

**Tech Stack:** Node.js 22.5+、CommonJS、`node:sqlite`、服务端 HTML、原生表单、RFC 4180 风格 CSV。

## Global Constraints

- 归档不等于跳过、拒绝、无回复或关闭，不修改 `candidate_job_states.status`。
- 不删除岗位、观察、分析、进度、消息、漏斗或策略轮次数据。
- 内部统计使用的 `listDecisionPool` 不因归档改变样本数或分母。
- 未完成沟通批次或消息发送批次中的岗位不能归档。
- CSV 不包含简历正文、候选人事实、HR 消息正文、草稿、密钥、Cookie 或诊断日志。
- CSV 必须保护以 `= + - @` 开头的单元格，避免表格公式执行。
- 不新增 XLSX 依赖或前端数据表框架。

---

### Task 1: 归档迁移和存储契约

**Files:**
- Modify: `src/core/storage.js`
- Modify: `src/storage/job_store.js`
- Modify: `tests/storage_migration_smoke.js`
- Modify: `tests/job_store_contract_smoke.js`
- Modify: `tests/scan_store_contract_smoke.js`
- Create: `tests/job_archive_store_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Produces: `archiveCandidateJob(db, { profileId, planId, jobId, archivedAt }) -> { jobId, archived: true, archivedAt }`.
- Produces: `restoreCandidateJob(db, { profileId, planId, jobId }) -> { jobId, archived: false, archivedAt: "" }`.
- Produces: `isCandidateJobArchived(db, { profileId, jobId }) -> boolean`.
- Extends: `listReportJobs()` rows with `archived` and `archivedAt`.

- [ ] **Step 1: Write failing migration and behavior tests**

```js
assert.equal(SCHEMA_VERSION, 27);
archiveCandidateJob(db, { profileId, planId, jobId, archivedAt: NOW });
let job = listReportJobs(db, { profileId, planId, batch: "all" }).find((item) => item.id === jobId);
assert.equal(job.archived, true);
assert.equal(job.applicationStatus, "applied");
restoreCandidateJob(db, { profileId, planId, jobId });
job = listReportJobs(db, { profileId, planId, batch: "all" }).find((item) => item.id === jobId);
assert.equal(job.archived, false);
```

Also verify profile A cannot archive profile B's job through an unrelated plan, repeat archive/restore is idempotent, and migration backup/foreign-key checks still pass.

- [ ] **Step 2: Run tests and verify RED**

Run: `node tests/storage_migration_smoke.js && node tests/job_archive_store_smoke.js`

Expected: FAIL because schema version 27 and archive functions are absent.

- [ ] **Step 3: Add schema version 27**

```sql
CREATE TABLE IF NOT EXISTS candidate_job_archives (
  profile_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  archived_at TEXT NOT NULL,
  PRIMARY KEY(profile_id, job_id),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id),
  FOREIGN KEY(job_id) REFERENCES jobs(id)
);
CREATE INDEX IF NOT EXISTS idx_candidate_job_archives_profile
  ON candidate_job_archives(profile_id, archived_at DESC, job_id);
```

Register a single migration after version 26. The migration contains only this table and index.

- [ ] **Step 4: Implement ownership, active-batch and idempotency checks**

Ownership requires the job to appear in the requested plan's observations or an existing progress card bound to that plan and profile. Before insert, query both active batch families:

```sql
SELECT 1
FROM communication_batch_items items
JOIN communication_batches batches ON batches.id = items.batch_id
WHERE batches.profile_id = ? AND items.job_id = ?
  AND batches.status IN ('confirmed','running','paused','stopping')
  AND items.status NOT IN ('succeeded','already_communicated','job_unavailable','target_mismatch','action_unavailable','platform_rejected','transport_failed','ambiguous','stopped')
UNION ALL
SELECT 1
FROM message_reply_send_items items
JOIN message_reply_send_batches batches ON batches.id = items.batch_id
WHERE batches.profile_id = ? AND items.job_id = ?
  AND batches.status IN ('confirmed','running')
  AND items.status IN ('pending','selecting','verified','filled','click_dispatched','ambiguous')
LIMIT 1;
```

Throw `JOB_ARCHIVE_ACTIVE_BATCH` before changing state. Use `INSERT ... ON CONFLICT DO UPDATE` for archive and `DELETE` for restore.

- [ ] **Step 5: Project archive state without filtering analytics**

Add a profile-scoped left join or correlated subquery to `listReportJobs` and map:

```js
archived: Boolean(row.archived_at),
archivedAt: row.archived_at || ""
```

Do not add an implicit `WHERE archived_at IS NULL` to `listReportJobs` or `listDecisionPool`.

- [ ] **Step 6: Run storage contracts and commit**

Run: `node tests/storage_migration_smoke.js && node tests/job_archive_store_smoke.js && node tests/job_store_contract_smoke.js && node tests/scan_store_contract_smoke.js`

Expected: all tests print `ok`. Update exact export counts only after adding the three named facade functions.

```powershell
git add src/core/storage.js src/storage/job_store.js tests/storage_migration_smoke.js tests/job_archive_store_smoke.js tests/job_store_contract_smoke.js tests/scan_store_contract_smoke.js tests/run_all.js
git commit -m "feat: add reversible candidate job archives"
```

### Task 2: 行动清单过滤和岗位记录操作

**Files:**
- Modify: `src/storage/job_store.js`
- Modify: `src/storage/communication_store.js`
- Modify: `src/core/workflow_inventory.js`
- Modify: `src/dashboard/server.js`
- Modify: `src/dashboard/assets/components.css`
- Modify: `tests/job_archive_store_smoke.js`
- Create: `tests/dashboard_job_archive_smoke.js`
- Modify: `tests/communication_smoke.js`
- Modify: `tests/job_search_funnel_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Consumes: `job.archived` from `listReportJobs`.
- Produces: POST `/api/job-archive` with exact fields `{ profileId, planId, jobId, action }`, where action is `archive` or `restore`.

- [ ] **Step 1: Write failing list and HTTP tests**

```js
archiveCandidateJob(db, { profileId, planId, jobId, archivedAt: NOW });
assert.equal(listDecisionQueue(db, { planId }).some((item) => item.id === jobId), false);
assert.equal(listCommunicationCandidates(db, planId).some((item) => item.id === jobId), false);
assert.equal(funnelService.getDashboard({ profileId, planId }).currentRound.started, startedBefore);
```

HTTP assertions must prove the normal jobs page hides archived cards, `archive=only` shows them, restore makes them visible, and an active batch returns 409 with a user-readable message.

- [ ] **Step 2: Run tests and verify RED**

Run: `node tests/job_archive_store_smoke.js && node tests/dashboard_job_archive_smoke.js && node tests/communication_smoke.js`

Expected: FAIL because user-facing lists and routes do not yet filter archives.

- [ ] **Step 3: Filter only action-producing lists**

Add `.filter((job) => !job.archived)` in `listDecisionQueue`, communication candidate building, workflow review inventory and message follow-up candidate building. Leave `listDecisionPool`, funnel entry reads and analytical snapshots unchanged.

- [ ] **Step 4: Add archive and restore forms**

The jobs page parses `archive=active|only|all`, with `active` as the default. Each active card gets a quiet “归档” button; archived cards get “恢复”。The handler validates exact keys and redirects back to the same plan/archive/filter view.

```js
if (params.action === "archive") archiveCandidateJob(db, params);
else if (params.action === "restore") restoreCandidateJob(db, params);
else throw appError("JOB_ARCHIVE_ACTION_INVALID", "归档操作无效。", { statusCode: 400 });
```

- [ ] **Step 5: Run focused tests and commit**

Run: `node tests/dashboard_job_archive_smoke.js && node tests/communication_smoke.js && node tests/job_search_funnel_smoke.js`

Expected: all tests pass and funnel counts remain identical before and after archive.

```powershell
git add src/storage/job_store.js src/storage/communication_store.js src/core/workflow_inventory.js src/dashboard/server.js src/dashboard/assets/components.css tests/job_archive_store_smoke.js tests/dashboard_job_archive_smoke.js tests/communication_smoke.js tests/job_search_funnel_smoke.js tests/run_all.js
git commit -m "feat: add job archive and restore controls"
```

### Task 3: 安全 CSV 编码与导出选择

**Files:**
- Create: `src/core/job_export.js`
- Create: `tests/job_export_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Produces: `encodeJobExportCsv(jobs) -> string` including the UTF-8 BOM.
- Produces: `jobExportFileName({ planName, date }) -> string`.

- [ ] **Step 1: Write the failing encoder test**

```js
const csv = encodeJobExportCsv([{
  id: 7,
  title: "=HYPERLINK(\"bad\")",
  company: "甲,乙公司",
  conclusion: "第一行\n第二行"
}]);
assert.equal(csv.charCodeAt(0), 0xfeff);
assert.match(csv, /"'=HYPERLINK\(""bad""\)"/);
assert.match(csv, /"甲,乙公司"/);
assert.match(csv, /"第一行\r\n第二行"/);
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node tests/job_export_smoke.js`

Expected: FAIL because `src/core/job_export.js` does not exist.

- [ ] **Step 3: Implement the fixed column projection and encoder**

```js
const COLUMNS = [
  ["岗位编号", (job) => job.id],
  ["岗位名称", (job) => job.title],
  ["公司", (job) => job.company],
  ["城市", (job) => job.location],
  ["薪资", (job) => job.salary],
  ["经验", (job) => job.experience],
  ["学历", (job) => job.education],
  ["岗位链接", (job) => job.url],
  ["首次发现", (job) => job.firstSeenAt],
  ["最近发现", (job) => job.lastSeenAt],
  ["是否归档", (job) => job.archived ? "是" : "否"],
  ["推荐结论", (job) => job.decisionBucket],
  ["岗位摘要", (job) => job.analysis?.businessScenario],
  ["匹配依据", (job) => (job.analysis?.fitReasons || []).join("；")],
  ["需要确认", (job) => (job.analysis?.questionsToVerify || []).join("；")],
  ["求职状态", (job) => job.applicationStatus],
  ["状态时间", (job) => job.applicationUpdatedAt],
  ["HR 状态", (job) => job.messageStatus],
  ["HR 状态时间", (job) => job.messageStatusAt]
];
```

Normalize internal newlines to CRLF, double embedded quotes, quote every field and prefix formula-like trimmed values with `'`.

- [ ] **Step 4: Run the encoder test and commit**

Run: `node tests/job_export_smoke.js`

Expected: `job_export_smoke ok`.

```powershell
git add src/core/job_export.js tests/job_export_smoke.js tests/run_all.js
git commit -m "feat: encode safe job CSV exports"
```

### Task 4: 当前筛选与已选岗位导出

**Files:**
- Modify: `src/dashboard/server.js`
- Modify: `src/dashboard/assets/components.css`
- Create: `tests/dashboard_job_export_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Consumes: `encodeJobExportCsv()` and the same normalized filters used by the jobs page.
- Produces: GET `/jobs/export.csv` for current filters and POST `/api/jobs/export` for exact selected `jobIds`.

- [ ] **Step 1: Write failing HTTP tests**

```js
const response = await request(base, `/jobs/export.csv?profileId=${profileId}&planId=${planId}&archive=active&pool=primary`);
assert.equal(response.status, 200);
assert.match(response.headers.get("content-type"), /^text\/csv; charset=utf-8$/);
assert.match(response.headers.get("content-disposition"), /attachment/);
assert.deepEqual(csvIds(response.body), [primaryJobId]);
```

POST tests must reject an unknown job, a job from another profile, duplicate IDs and more than 500 IDs without returning a partial file.

- [ ] **Step 2: Run the test and verify RED**

Run: `node tests/dashboard_job_export_smoke.js`

Expected: FAIL because export routes do not exist.

- [ ] **Step 3: Implement server-owned selection**

For current-filter export, call the same filter parser and job filtering function as the rendered jobs page. For selected export, load the current profile and plan, build a map from `listReportJobs({ profileId, planId, batch: "all", limit: 10000 })`, and require every submitted ID to exist in that map before encoding.

Return:

```js
res.writeHead(200, {
  "content-type": "text/csv; charset=utf-8",
  "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
});
res.end(csv);
```

- [ ] **Step 4: Add visible export controls**

The jobs page always shows “导出当前结果”。When checkboxes contain at least one selected ID, enable “导出已选岗位”。Checkboxes submit IDs only; server reloads all text fields.

- [ ] **Step 5: Run focused tests and commit**

Run: `node tests/job_export_smoke.js && node tests/dashboard_job_export_smoke.js && node tests/dashboard_job_archive_smoke.js`

Expected: all three tests pass.

```powershell
git add src/dashboard/server.js src/dashboard/assets/components.css tests/dashboard_job_export_smoke.js tests/run_all.js
git commit -m "feat: export filtered and selected jobs"
```

### Task 5: 完整回归与交接更新

**Files:**
- Modify: `docs/NEXT_PHASE.md`
- Modify: `docs/PROJECT_HANDOFF.md`

- [ ] **Step 1: Run the complete archive/export gate**

```powershell
node tests/storage_migration_smoke.js
node tests/job_archive_store_smoke.js
node tests/dashboard_job_archive_smoke.js
node tests/job_export_smoke.js
node tests/dashboard_job_export_smoke.js
node tests/communication_smoke.js
node tests/job_search_funnel_smoke.js
npm test
git diff --check
git status --short
```

Expected: focused tests print `ok`; full suite reports the current exact total; diff check has no output.

- [ ] **Step 2: Update documentation**

Record the reversible state model, unchanged funnel counts, CSV privacy boundary, exact test result and absence of real-platform access.

- [ ] **Step 3: Commit documentation**

```powershell
git add docs/NEXT_PHASE.md docs/PROJECT_HANDOFF.md
git commit -m "docs: record job archive and export delivery"
```
