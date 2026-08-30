# Message Job Identity Matching Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correctly associate BOSS message conversations with local job cards when the platform supplies a base city, a raw job ID, or duplicate job titles, without weakening real identity-conflict protection.

**Architecture:** Add one small BOSS identity helper for canonical job IDs and base-city comparison. Use it at the message matcher and message-detail persistence boundary; keep durable unresolved rows and existing progress-card thread immutability unchanged.

**Tech Stack:** Node.js 22 CommonJS, built-in `node:assert`, built-in `node:sqlite`, existing offline smoke-test runner.

## Global Constraints

- BOSS remains read-only during implementation and acceptance; use fixtures and temporary databases only.
- Do not change or overwrite a progress card's existing incompatible `thread_key`.
- Do not migrate, delete, or merge historical jobs, drafts, events, or progress records.
- Do not add dependencies, database tables, or migrations.
- Keep unresolved rows per conversation; do not hide the real count in the dashboard.
- Preserve current company, salary, city, ambiguity, login, risk-control, fixed-tab, and background-focus boundaries.

---

### Task 1: Canonical BOSS identity and layered candidate matching

**Files:**
- Create: `src/core/boss_job_identity.js`
- Modify: `src/core/message_discovery.js:140,386-410,897-904`
- Test: `tests/message_discovery_smoke.js:439-508,2036-2095,2335-2369`

**Interfaces:**
- Produces: `canonicalBossJobSourceId(value: unknown): string`, returning `boss:<jobId>` for a valid raw or already-prefixed BOSS job ID and `""` for an invalid value.
- Produces: `bossLocationConflicts(left: unknown, right: unknown): boolean`, comparing the base city before `·` or whitespace and returning `false` when either side is empty.
- Changes internal call: `resolveUniqueCandidate(candidates, selected, canonicalThreadKey, sourceJobId)`.

- [x] **Step 1: Write failing message-discovery regressions**

Add real end-to-end assertions through `runBossMessageDiscovery`:

```js
const sameCity = createFixture({
  suffix: "same-city",
  title: "Same City Engineer",
  city: "广州·越秀区·东风中路"
});
db.prepare("UPDATE jobs SET source_id = ? WHERE id = ?")
  .run("boss:same-city-job", sameCity.jobId);
let summary = await runBossMessageDiscovery({
  db,
  profileId: sameCity.profileId,
  reader: fakeReader([selectedConversation({
    title: sameCity.title,
    city: "广州",
    sourceJobId: "same-city-job"
  })]),
  classifyMessageGroup,
  sleepFn: async () => {}
});
assert.strictEqual(summary.status, "completed");
```

Create two same-title candidates with different companies and source IDs, pass the selected candidate's raw `sourceJobId`, and assert that only the matching `jobId` reaches `classifyMessageGroup`. Keep the existing Guangzhou/Shenzhen assertion and the incompatible-thread assertion.

Extend `selectedConversation` and `fakeReader` so a fixture may provide `sourceJobId` while all old fixtures retain their current fallback.

- [x] **Step 2: Run the regression and verify RED**

Run: `node tests/message_discovery_smoke.js`

Expected: FAIL because `广州` conflicts with `广州·越秀区·东风中路`, or because the same-title candidates remain ambiguous before the new source-ID narrowing exists.

- [x] **Step 3: Implement the minimal identity helper and matcher**

Create `src/core/boss_job_identity.js` with no dependencies:

```js
function canonicalBossJobSourceId(value) {
  const text = String(value || "").trim();
  if (/^boss:[A-Za-z0-9_-]{6,160}$/.test(text)) return text;
  return /^[A-Za-z0-9_-]{6,160}$/.test(text) ? `boss:${text}` : "";
}

function bossLocationConflicts(left, right) {
  const local = baseCity(left);
  const remote = baseCity(right);
  return Boolean(local && remote && local !== remote);
}
```

In `runBossMessageDiscovery`, pass `target.sourceJobId` into `resolveUniqueCandidate`. In the resolver:

1. Start with active candidates.
2. If canonical source-ID matches exist, narrow to them.
3. If a canonical or legacy thread match exists, narrow to it.
4. Filter exact normalized title, compatible company, salary, and base city.
5. Return the existing field-specific mismatch when a filtering stage reaches zero.
6. Return `BOSS_MESSAGE_CARD_AMBIGUOUS` when more than one candidate remains.
7. Retain the final incompatible-thread rejection before success.

Do not add a configuration object, strategy class, or generic identity framework.

- [x] **Step 4: Run Task 1 verification and verify GREEN**

Run: `node tests/message_discovery_smoke.js`

Expected: `message_discovery_smoke ok` with exit code 0.

- [x] **Step 5: Commit Task 1**

```bash
git add src/core/boss_job_identity.js src/core/message_discovery.js tests/message_discovery_smoke.js
git commit -m "fix: match message jobs by canonical identity"
```

### Task 2: Prevent raw message-detail job IDs from creating duplicates

**Files:**
- Modify: `src/application/message_discovery/job_context.js:34-75,105-132`
- Test: `tests/message_discovery_job_context_smoke.js:38-195,287-326`

**Interfaces:**
- Consumes: `canonicalBossJobSourceId` from Task 1.
- Preserves browser-facing `jobTarget.jobId` as the raw BOSS ID used in `/job_detail/<jobId>.html`.
- Persists and queries local jobs with canonical `boss:<jobId>`.

- [x] **Step 1: Write the failing duplicate-prevention regression**

Change `seedJob` to persist `sourceId: `boss:${sourceId}`` while keeping the URL raw. In `fetchedContextSmoke`, assert:

```js
assert.strictEqual(result.job.sourceId, "boss:fetched-job");
assert.strictEqual(
  db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE source = ? AND source_id IN (?, ?)")
    .get("boss", "fetched-job", "boss:fetched-job").count,
  1
);
```

Keep the existing assertion that the returned progress card still refers to the original seeded `jobId`. Update cache-hit expectations to canonical source IDs.

- [x] **Step 2: Run the regression and verify RED**

Run: `node tests/message_discovery_job_context_smoke.js`

Expected: FAIL because the current resolver queries and persists the raw ID, causing a second job instead of reusing `boss:fetched-job`.

- [x] **Step 3: Canonicalize only at the message job-context boundary**

Import `canonicalBossJobSourceId`. After validating the raw `jobTarget.jobId`, derive one local source ID:

```js
const localSourceId = canonicalBossJobSourceId(jobTarget.jobId);
```

Use `localSourceId` for `candidateMatches`, `findMessageDiscoveryJobContext`, the detail batch snapshot, `upsertJob`, and the final context lookup. Keep `jobTarget.jobId` for detail-reader identity checks and `canonicalBossJobUrl`.

Make `trustedDetail` return canonical `sourceId` only after proving the detail's raw source ID equals the selected raw target. Do not change the shared `upsertJob` behavior for non-message callers.

- [x] **Step 4: Run Task 2 verification and verify GREEN**

Run: `node tests/message_discovery_job_context_smoke.js`

Expected: `message_discovery_job_context_smoke ok` with exit code 0.

Run: `node tests/message_discovery_smoke.js`

Expected: `message_discovery_smoke ok` with exit code 0.

- [x] **Step 5: Commit Task 2**

```bash
git add src/application/message_discovery/job_context.js tests/message_discovery_job_context_smoke.js
git commit -m "fix: reuse canonical BOSS jobs in message detail"
```

### Task 3: Final regression gate and handoff evidence

**Files:**
- Modify: `docs/PROJECT_HANDOFF.md`
- Modify: `docs/superpowers/plans/2026-08-30-message-job-identity-matching-fix.md`

**Interfaces:**
- Consumes: the completed matcher and job-context behavior from Tasks 1 and 2.
- Produces: exact test count, exact commit IDs, no-live-BOSS statement, and next-step note for the project handoff.

- [x] **Step 1: Run focused neighboring checks**

Run:

```bash
node tests/message_discovery_smoke.js
node tests/message_discovery_job_context_smoke.js
node tests/candidate_progress_storage_smoke.js
node tests/dashboard_message_discovery_smoke.js
```

Expected: all four commands exit 0 and print their corresponding `ok` line.

- [x] **Step 2: Run the complete offline gate**

Run: `npm test`

Expected: exit code 0 with the current `All <N> offline checks passed.` count. Record the actual value; do not reuse an older count.

- [x] **Step 3: Inspect the final diff and syntax hygiene**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Expected: no whitespace errors; only the files listed in this plan are changed.

- [x] **Step 4: Update handoff evidence and plan checkboxes**

Add a concise `docs/PROJECT_HANDOFF.md` entry stating:

- base-city comparison now treats Guangzhou district detail as the same city;
- canonical BOSS job IDs and existing thread bindings disambiguate same-title candidates;
- message detail no longer creates a raw-ID duplicate;
- historical duplicates were not automatically merged;
- all verification used fixtures and temporary databases with no real BOSS action;
- exact focused/full-gate outputs and implementation commit IDs.

Mark every completed checkbox in this plan as `[x]`.

- [x] **Step 5: Verify documentation and commit final evidence**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors and only the two documentation files remain uncommitted.

Commit:

```bash
git add docs/PROJECT_HANDOFF.md docs/superpowers/plans/2026-08-30-message-job-identity-matching-fix.md
git commit -m "docs: record message identity verification"
```

- [x] **Step 6: Re-run exact-HEAD risk checks**

Run:

```bash
node tests/message_discovery_smoke.js
node tests/message_discovery_job_context_smoke.js
git diff --check
git status --short --branch
```

Expected: both focused checks pass, the diff check is clean, and the branch has no uncommitted files.
