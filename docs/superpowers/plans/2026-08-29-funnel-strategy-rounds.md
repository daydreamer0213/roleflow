# Funnel Strategy Rounds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. For this repository, use `executing-plans` in the current task; do not spawn subagents unless the user later explicitly asks for delegation.

**Goal:** Replace the rolling mixed-state funnel pool with plan-scoped strategy rounds so changes before and after a greeting, résumé, or strategy update are diagnosed separately and compared only after each round has enough mature evidence.

**Architecture:** Add a v23 SQLite migration for immutable strategy-round membership while retaining legacy cohort tables as read-only compatibility evidence. `funnel_store` owns round creation, idempotent transitions, backfill, and entry binding; `funnel_analysis` reads one current plan/round and the nearest compatible predecessor. The Dashboard adds one local manual-boundary action and renders aggregate round facts only.

**Tech Stack:** Node.js 22 CommonJS, built-in `node:sqlite`, server-rendered Dashboard HTML/CSS, built-in `fetch`, in-memory SQLite smoke tests.

## Global Constraints

- Every real funnel entry belongs permanently to the strategy round active when the action was recorded.
- Feedback matures after 48 hours; a Saturday or Sunday deadline moves to Monday at the same China-local time.
- Each round independently uses 30 mature jobs for preliminary observations, 50 for comparable conclusions, and 70 for formal diagnosis. A round continues beyond 70 until strategy changes.
- Current diagnosis reads only the current round. Late outcomes update their original round and never move jobs into a newer round.
- Formal before/after comparison requires at least 50 mature jobs in both compatible rounds.
- Multiple simultaneous changes are labelled confounded and are never attributed to one change.
- Delivered/read are aggregate funnel counts only; do not add per-job cards for them.
- Keep legacy `candidate_funnel_cohorts` and `cohort_id` readable for migration evidence, but stop freezing new 70-job cohorts.
- Do not add a 30-day cutoff or a fixed 50-job batch.
- Do not access BOSS or add any external write. All work uses local records and fixtures.
- Add no dependency, ORM, queue, microservice, or frontend framework.

---

## Task 1: Add Strategy-Round Storage and Legacy Backfill

**Files:**

- Create: `tests/funnel_strategy_round_store_smoke.js`
- Modify: `src/core/storage.js`
- Modify: `src/storage/funnel_store.js`
- Modify: `tests/storage_migration_smoke.js`
- Modify: `tests/candidate_store_contract_smoke.js`
- Modify: `tests/scan_store_contract_smoke.js`
- Modify: `tests/job_store_contract_smoke.js`
- Modify: `tests/communication_store_contract_smoke.js`
- Modify: `tests/workflow_store_contract_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**

- Consumes: existing `getFunnelPolicy(db, { profileId })`, `candidate_funnel_entries`, `candidate_funnel_cohorts`, and `search_plans.plan_json`.
- Produces:

```js
getActiveFunnelStrategyRound(db, { profileId, planId })
getFunnelStrategyRound(db, { profileId, planId, roundId })
listFunnelStrategyRounds(db, { profileId, planId, limit })
ensureActiveFunnelStrategyRound(db, { profileId, planId, startedAt })
startFunnelStrategyRound(db, {
  profileId, planId, fromRoundId, sourceKey,
  changeKinds, changeNote, resumeVersionId, startedAt
})
```

- `startFunnelStrategyRound` returns the existing target round when `sourceKey` was already used, closes only `fromRoundId`, and creates exactly one active successor. When no active round exists, `fromRoundId: null` creates sequence 1 directly; it must not create an empty initial round first.

- [ ] **Step 1: Write the failing round-store test**

Create `tests/funnel_strategy_round_store_smoke.js` with an in-memory database and assertions equivalent to:

```js
const initial = storage.ensureActiveFunnelStrategyRound(db, {
  profileId, planId, startedAt: "2026-08-20T02:00:00.000Z"
});
assert.equal(initial.sequenceNumber, 1);
assert.equal(initial.status, "active");
assert.deepEqual(initial.thresholds, { preliminary: 30, comparable: 50, formal: 70 });

const next = storage.startFunnelStrategyRound(db, {
  profileId, planId, fromRoundId: initial.id,
  sourceKey: `manual:${initial.id}`,
  changeKinds: ["greeting"], changeNote: "已修改招呼语",
  startedAt: "2026-08-29T02:00:00.000Z"
});
const retried = storage.startFunnelStrategyRound(db, {
  profileId, planId, fromRoundId: initial.id,
  sourceKey: `manual:${initial.id}`,
  changeKinds: ["greeting"], changeNote: "已修改招呼语",
  startedAt: "2026-08-29T02:00:00.000Z"
});
assert.equal(retried.id, next.id);
assert.equal(storage.listFunnelStrategyRounds(db, { profileId, planId }).length, 2);
assert.throws(() => storage.startFunnelStrategyRound(db, {
  profileId, planId, fromRoundId: initial.id,
  sourceKey: "manual:stale", changeKinds: ["strategy"],
  startedAt: "2026-08-29T03:00:00.000Z"
}), (error) => error.code === "FUNNEL_ROUND_STALE");
```

Also build a v22 fixture containing one frozen cohort plus one unassigned pool, reopen it through `openDb`, and assert that migration creates closed legacy round(s), one active legacy-compatible round for the unassigned entries, preserves every `cohort_id`, and gives every plan-scoped entry a non-null `strategy_round_id`.

Insert this test in `tests/run_all.js` immediately before `job_search_funnel_smoke.js`.

- [ ] **Step 2: Run the new test and verify the expected failure**

Run:

```powershell
node tests/funnel_strategy_round_store_smoke.js
```

Expected: failure because migration 23 and `ensureActiveFunnelStrategyRound` do not exist.

- [ ] **Step 3: Add migration 23**

In `src/core/storage.js`, add `FUNNEL_STRATEGY_ROUNDS_SCHEMA`, migration 23, and a `migrateFunnelStrategyRounds` helper:

```js
{
  version: 23,
  name: "funnel_strategy_rounds_v2",
  apply(db) {
    migrateFunnelStrategyRounds(db);
  }
}
```

The new table and indexes must implement this shape:

```sql
CREATE TABLE IF NOT EXISTS candidate_funnel_strategy_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL,
  sequence_number INTEGER NOT NULL CHECK(sequence_number > 0),
  status TEXT NOT NULL CHECK(status IN ('active','closed')),
  source_key TEXT NOT NULL,
  strategy_snapshot_json TEXT NOT NULL DEFAULT '{}',
  change_kinds_json TEXT NOT NULL DEFAULT '[]',
  change_note TEXT NOT NULL DEFAULT '',
  resume_version_id INTEGER,
  preliminary_sample_target INTEGER NOT NULL,
  comparable_sample_target INTEGER NOT NULL,
  formal_sample_target INTEGER NOT NULL,
  legacy_uncertain INTEGER NOT NULL DEFAULT 0 CHECK(legacy_uncertain IN (0,1)),
  started_at TEXT NOT NULL,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(profile_id, plan_id, sequence_number),
  UNIQUE(profile_id, plan_id, source_key),
  FOREIGN KEY(profile_id) REFERENCES candidate_profiles(id),
  FOREIGN KEY(plan_id) REFERENCES search_plans(id),
  FOREIGN KEY(resume_version_id) REFERENCES candidate_resume_versions(id)
);
CREATE UNIQUE INDEX idx_funnel_strategy_round_active
  ON candidate_funnel_strategy_rounds(profile_id, plan_id)
  WHERE status = 'active';
```

Add `strategy_round_id INTEGER REFERENCES candidate_funnel_strategy_rounds(id)` to `candidate_funnel_entries` and index `(profile_id, plan_id, strategy_round_id, mature_at, id)`.

Backfill one closed legacy round per existing `cohort_id`. Backfill remaining unassigned entries into one active legacy round per `(profile_id, plan_id)`. Rows with no reliable `plan_id` remain preserved but are explicitly excluded from plan-scoped current diagnosis; do not invent a plan. Set `legacy_uncertain=1` whenever a historical strategy boundary cannot be proven.

- [ ] **Step 4: Implement round mapping and transitions**

In `src/storage/funnel_store.js`, add the five interfaces above. Build `strategy_snapshot_json` from the owned plan and selected résumé:

```js
function strategySnapshot(plan, resumeVersionId) {
  return {
    planId: plan.id,
    directions: Array.isArray(plan.plan?.directions) ? plan.plan.directions : [],
    resumeVersionId: resumeVersionId || null
  };
}
```

Normalize `changeKinds` to unique values from `greeting`, `resume`, and `strategy`; allow `initial` only for lazy creation. Snapshot the current 30/50/70 policy into every round. Run close-and-create in one `immediateTransaction`; if the supplied `sourceKey` already exists, return it before checking `fromRoundId` so an HTTP retry is idempotent. If there is no active round, accept only `fromRoundId: null` and create sequence 1 using the supplied change metadata. If an active round exists, require its ID to equal `fromRoundId`.

- [ ] **Step 5: Export the storage surface and update exact facade contracts**

Re-export the five new functions from `src/core/storage.js`. Add their exact names to `FACADE_EXPORTS` in `tests/candidate_store_contract_smoke.js` and update the four exact facade counts from 181 to 186. Do not weaken those contract checks.

Update `tests/storage_migration_smoke.js` so the latest expected schema version is 23 and add assertions for the new table, partial active-round index, new entry column, preserved legacy membership, and migration rollback/backup behavior.

- [ ] **Step 6: Run storage and migration checks**

Run:

```powershell
node tests/funnel_strategy_round_store_smoke.js
node tests/storage_migration_smoke.js
node tests/candidate_store_contract_smoke.js
node tests/scan_store_contract_smoke.js
node tests/job_store_contract_smoke.js
node tests/communication_store_contract_smoke.js
node tests/workflow_store_contract_smoke.js
```

Expected: every command prints its `ok` line and exits 0.

- [ ] **Step 7: Commit the storage checkpoint**

```powershell
git add src/core/storage.js src/storage/funnel_store.js tests/funnel_strategy_round_store_smoke.js tests/storage_migration_smoke.js tests/candidate_store_contract_smoke.js tests/scan_store_contract_smoke.js tests/job_store_contract_smoke.js tests/communication_store_contract_smoke.js tests/workflow_store_contract_smoke.js tests/run_all.js
git commit -m "feat: add funnel strategy rounds"
```

---

## Task 2: Bind Every New Funnel Entry to Its Active Round

**Files:**

- Modify: `src/storage/funnel_store.js`
- Modify: `tests/job_search_funnel_smoke.js`
- Modify: `tests/funnel_strategy_round_store_smoke.js`

**Interfaces:**

- Consumes: `ensureActiveFunnelStrategyRound(db, { profileId, planId, startedAt })` from Task 1.
- Produces: `ensureFunnelEntry` rows with a stable `strategyRoundId`; late events continue to project through the existing `listFunnelProgressEvents` path.

- [ ] **Step 1: Add failing entry-membership cases**

Extend the tests with this sequence:

```js
const entryA = storage.ensureFunnelEntry(db, {
  profileId, planId, jobId: jobA, sourceKind: "applied", startedAt: T0
});
const roundA = storage.getActiveFunnelStrategyRound(db, { profileId, planId });
assert.equal(entryA.strategyRoundId, roundA.id);

const roundB = storage.startFunnelStrategyRound(db, {
  profileId, planId, fromRoundId: roundA.id,
  sourceKey: `manual:${roundA.id}`,
  changeKinds: ["greeting"], changeNote: "修改招呼语", startedAt: T1
});
const entryB = storage.ensureFunnelEntry(db, {
  profileId, planId, jobId: jobB, sourceKind: "communication", startedAt: T1
});
assert.equal(entryB.strategyRoundId, roundB.id);
assert.equal(storage.getFunnelEntry(db, { profileId, jobId: jobA }).strategyRoundId, roundA.id);
```

Record a late reply for `jobA` after B starts and assert its entry remains in A.

- [ ] **Step 2: Run the focused tests and verify failure**

```powershell
node tests/funnel_strategy_round_store_smoke.js
node tests/job_search_funnel_smoke.js
```

Expected: the new `strategyRoundId` assertions fail.

- [ ] **Step 3: Bind inside the existing entry transaction**

In `ensureFunnelEntry`, require the resolved owned `planId` for new plan-scoped entries, call `ensureActiveFunnelStrategyRound` after resolving contact context, and insert `strategy_round_id` with the round ID. Preserve the existing `(profile_id, job_id)` idempotency: a repeated real action returns the original entry and never rebinds it to a newer round.

Extend `mapEntry` with:

```js
strategyRoundId: Number(row.strategy_round_id || 0) || null
```

Add an optional `strategyRoundId` filter to `listFunnelEntries`; the filter must combine with `profileId` and `planId`, not replace ownership checks.

- [ ] **Step 4: Run entry and maturity regression checks**

```powershell
node tests/funnel_strategy_round_store_smoke.js
node tests/job_search_funnel_smoke.js
node tests/funnel_threshold_policy_smoke.js
node tests/funnel_message_observation_smoke.js
```

Expected: all pass; the existing 48-hour/weekend calculations remain unchanged.

- [ ] **Step 5: Commit immutable membership**

```powershell
git add src/storage/funnel_store.js tests/funnel_strategy_round_store_smoke.js tests/job_search_funnel_smoke.js
git commit -m "feat: bind funnel entries to strategy rounds"
```

---

## Task 3: Diagnose Only the Current Round and Compare a Compatible Predecessor

**Files:**

- Modify: `src/application/funnel_analysis/index.js`
- Modify: `tests/funnel_diagnosis_smoke.js`

**Interfaces:**

- Consumes: plan-scoped round/entry functions from Tasks 1–2 and existing `buildFunnelSnapshot(entries, events, { now })`.
- Produces:

```js
service.refresh({ profileId, planId })
service.getDashboard({ profileId, planId })
service.startStrategyRound({
  profileId, planId, fromRoundId, changeKinds, changeNote, sourceKey
})
```

The dashboard result contains:

```js
{
  policy,
  currentRound: { ...round, started, mature, waiting, unknown, strength, nextTarget },
  previousRound: null | { ...round, started, mature, strength, headline },
  roundComparison: {
    status: "ready" | "insufficient" | "incompatible" | "confounded" | "none",
    note: string,
    before: null | { roundId, mature, stages },
    after: null | { roundId, mature, stages }
  },
  funnel, comparisons, headline, priorityCheck, evidenceNotes
}
```

- [ ] **Step 1: Replace rolling-pool fixtures with A/B round fixtures**

In `tests/funnel_diagnosis_smoke.js`, create round A with 50 mature entries, start round B after a greeting change, add B entries at 29/30/49/50/69/70/83 boundaries, and assert:

```js
assert.equal(at29.currentRound.strength, "facts");
assert.equal(at30.currentRound.strength, "preliminary");
assert.equal(at50.currentRound.strength, "comparable");
assert.equal(at70.currentRound.strength, "formal");
assert.equal(at83.currentRound.mature, 83);
assert.equal(at83.currentRound.id, roundB.id);
assert.equal(at50.roundComparison.status, "ready");
assert.equal(at49.roundComparison.status, "insufficient");
```

Add one late reply to A after B begins and assert A changes while B's numerator and denominator do not. Add direction mismatch and multi-change fixtures; expect `incompatible` and `confounded`, respectively, and ensure no copy contains `证明`, `导致`, or `准确率`.

- [ ] **Step 2: Run the diagnosis test and verify old rolling behavior fails**

```powershell
node tests/funnel_diagnosis_smoke.js
```

Expected: failure because the service still analyzes unassigned entries and freezes cohorts.

- [ ] **Step 3: Make the service plan- and round-scoped**

Change `dashboard`, `refresh`, and `snapshotFor` to accept `planId`. Load or lazily create the current round, then query only entries with its `strategy_round_id`. Remove `freezeReadyFunnelCohort` from the refresh path; do not delete the compatibility function.

Use the round's frozen thresholds for `diagnosisStrength` and `nextTarget`. At 70+, keep `nextTarget` as `null` and leave every later entry in the same round.

- [ ] **Step 4: Implement compatibility and comparison rules**

Choose the nearest earlier round from the same `(profileId, planId)`. Compare only when both have at least their frozen comparable target, both strategy snapshots contain the same normalized direction list, and neither is `legacyUncertain`.

If `currentRound.changeKinds.length > 1`, return `status: "confounded"` with the exact user-facing meaning “多项调整共同发生，无法区分单项影响”. Otherwise compute before/after stage counts from each round independently. Keep differences descriptive; do not calculate a causal score.

- [ ] **Step 5: Preserve useful within-round grouping without greeting leakage**

Keep direction, recommendation bucket, and résumé version group observations only when the current round is `comparable` or `formal`. Remove the per-job `greeting_key` group from main comparison because personalized greetings are not a global strategy version. Return no raw digest in the dashboard object.

- [ ] **Step 6: Run diagnosis regressions**

```powershell
node tests/funnel_diagnosis_smoke.js
node tests/job_search_funnel_smoke.js
node tests/funnel_threshold_policy_smoke.js
```

Expected: all pass with current-round isolation and unchanged maturity semantics.

- [ ] **Step 7: Commit the analysis checkpoint**

```powershell
git add src/application/funnel_analysis/index.js tests/funnel_diagnosis_smoke.js
git commit -m "feat: isolate funnel diagnosis by strategy round"
```

---

## Task 4: Add the Manual Strategy Boundary and Round-Based Dashboard

**Files:**

- Modify: `src/dashboard/server.js`
- Modify: `src/dashboard/pages/funnel.js`
- Modify: `src/dashboard/assets/roleflow.css`
- Modify: `tests/dashboard_funnel_smoke.js`

**Interfaces:**

- Consumes: `funnelAnalysis.startStrategyRound` and the round-based dashboard object from Task 3.
- Produces: `POST /api/funnel/strategy-round` with fields `planId`, `fromRoundId`, `changeKinds`, and `changeNote`.

- [ ] **Step 1: Write failing Dashboard and endpoint assertions**

Update `tests/dashboard_funnel_smoke.js` to assert:

```js
assert.match(page.body, /当前策略轮次/);
assert.match(page.body, /第 2 轮/);
assert.match(page.body, /修改完成，开始验证新方案/);
assert.match(page.body, /30 个[^<]*初步观察/);
assert.match(page.body, /50 个[^<]*可比较结论/);
assert.match(page.body, /70 个[^<]*正式诊断/);
assert.doesNotMatch(page.body, /下一批滚动样本|冻结本批/);
assert.doesNotMatch(page.body, /岗位卡片.*已读|岗位卡片.*送达/);
```

POST the same form twice with `fromRoundId=A`; assert both responses redirect to `/funnel?planId=...` and the service receives the same deterministic `sourceKey: manual:A` without creating a third round. Add a stale `fromRoundId` service error fixture and assert the response explains that the page must be refreshed rather than silently starting another round.

- [ ] **Step 2: Run the Dashboard test and verify failure**

```powershell
node tests/dashboard_funnel_smoke.js
```

Expected: failure on round copy and the missing endpoint.

- [ ] **Step 3: Add the local POST handler**

Register:

```js
if (req.method === "POST" && url.pathname === "/api/funnel/strategy-round") {
  return handleFunnelStrategyRound(req, res, { db, funnelAnalysis });
}
```

The handler owns `planId`, passes `sourceKey: manual:${fromRoundId}`, accepts only `greeting` and `strategy` from this form, trims `changeNote` to 300 characters, and redirects after success. It never calls a browser or external service.

- [ ] **Step 4: Render the current round and comparison**

Replace rolling/frozen-cohort copy in `src/dashboard/pages/funnel.js` with:

- current round number, strategy start time, change labels, mature/waiting counts, and 30/50/70 ruler;
- current-round funnel totals, with delivered/read only in aggregates;
- previous compatible round and before/after stage metrics when `roundComparison.status === "ready"`;
- the appropriate insufficient/incompatible/confounded explanation otherwise;
- a form headed “我已经完成外部调整” with the button “修改完成，开始验证新方案”.

The form sends the visible current round ID. Escape every plan, note, direction, and strategy label. Keep the footer explicitly local and read-only with respect to BOSS.

- [ ] **Step 5: Add minimal responsive styles**

Add only selectors needed for `.funnel-round`, `.funnel-round-change`, `.funnel-round-comparison`, and `.funnel-round-boundary`. Reuse current cards, metrics, buttons, colors, and mobile breakpoint; do not create a new visual system.

- [ ] **Step 6: Run Dashboard and server regressions**

```powershell
node tests/dashboard_funnel_smoke.js
node tests/dashboard_runtime_smoke.js
node tests/dashboard_shell_smoke.js
```

Expected: all pass; no browser-readiness probe is called by the funnel page or POST.

- [ ] **Step 7: Commit the user flow**

```powershell
git add src/dashboard/server.js src/dashboard/pages/funnel.js src/dashboard/assets/roleflow.css tests/dashboard_funnel_smoke.js
git commit -m "feat: expose funnel strategy rounds"
```

---

## Task 5: Final Stage-Two Verification and Documentation

**Files:**

- Modify: `docs/NEXT_PHASE.md`
- Modify: `docs/PROJECT_HANDOFF.md`
- Modify: `docs/superpowers/plans/2026-08-29-funnel-strategy-rounds.md`

**Interfaces:**

- Consumes: all stage-two implementation tasks.
- Produces: verified stage-two checkpoint and an explicit stage-three entry.

- [ ] **Step 1: Run the focused stage-two gate**

```powershell
node tests/storage_migration_smoke.js
node tests/funnel_strategy_round_store_smoke.js
node tests/funnel_threshold_policy_smoke.js
node tests/job_search_funnel_smoke.js
node tests/funnel_message_observation_smoke.js
node tests/funnel_diagnosis_smoke.js
node tests/dashboard_funnel_smoke.js
```

Expected: every process exits 0.

- [ ] **Step 2: Run the complete offline gate**

```powershell
npm test
```

Expected: `All <current count> offline checks passed.` Record the actual count in `docs/PROJECT_HANDOFF.md`; do not reuse an older number.

- [ ] **Step 3: Update user-facing project documents**

In `docs/NEXT_PHASE.md` and `docs/PROJECT_HANDOFF.md`, record:

- current diagnosis is strategy-round scoped;
- 48-hour/weekend maturity and 30/50/70 thresholds remain;
- old results stay in old rounds and late outcomes still update them;
- manual boundary copy and automatic résumé boundary interface;
- no real BOSS access occurred;
- next implementation entry is the complete editable résumé draft plan.

Do not describe stage three or four as implemented.

- [ ] **Step 4: Self-review the completed plan checkboxes and diff**

```powershell
rg -n "^- \[ \]" docs/superpowers/plans/2026-08-29-funnel-strategy-rounds.md
git diff --check
git status --short
```

Expected: no unchecked implementation step, no whitespace error, and only intended files changed.

- [ ] **Step 5: Commit the stage-two closeout**

```powershell
git add docs/NEXT_PHASE.md docs/PROJECT_HANDOFF.md docs/superpowers/plans/2026-08-29-funnel-strategy-rounds.md
git commit -m "docs: close funnel strategy round stage"
```

- [ ] **Step 6: Verify the exact final commit**

```powershell
node tests/funnel_strategy_round_store_smoke.js
node tests/funnel_diagnosis_smoke.js
node tests/dashboard_funnel_smoke.js
git diff --check HEAD^
git status --short --branch
git rev-parse HEAD
```

Expected: focused tests pass, the worktree is clean, and the exact SHA is ready for the stage handoff. Do not push, merge, package, change the version, or create a release without a new explicit user request.
