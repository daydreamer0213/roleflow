# Private Benchmark Fixture Portability v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely reuse the byte-identical confirmed candidate evidence with the user's independently confirmed 20-job recall-first fixture, without weakening legacy portability proofs or allowing checked inputs to differ from model inputs.

**Architecture:** Add an explicit `confirmed-evidence-portability.v3` sidecar mode to the existing private full-chain runner. Legacy v1/v2 proofs keep their exact schemas and four code-blob invariant; v3 freezes four candidate-evidence files, independently validates and hashes the target recall-first fixture, freezes only the three candidate-evidence creation/consumption blobs, and returns the exact parsed objects derived from the bytes it hashed.

**Tech Stack:** Node.js CommonJS, built-in `fs`/`crypto`/`path`, existing assert-based smoke tests, Git blob identity, PowerShell execution on Windows.

## Global Constraints

- Work only in `D:\DevData\RoleFlow-worktrees\deepseek-match-nonthinking-ab` and the existing private baseline worktree; do not modify `D:\Guo\ZhiPing`.
- Do not access BOSS, any recruitment platform, the main `data/jobs.sqlite`, cookies, 8787, or communication actions.
- Do not read the formal model configuration or run a real model during Tasks 1–2.
- Never write private resume, profile, matching-card, JD, or label text into Git, logs, reports, tests, or the portability proof.
- `confirmed-evidence-portability.v3` must be explicit opt-in through `--proof-version confirmed-evidence-portability.v3`; a failed v1/v2 proof must never auto-upgrade.
- v1/v2 proof creation and validation retain their existing exact fields, four consumer blobs, same-job requirement, and label-transition behavior.
- v3 requires byte-identical confirmed profile, confirmed card, redacted resume, and identity manifest.
- v3 target labels must be `private-real-jd-labels.v2`, `recall-first.v1`, `userConfirmed === true`, time-valid, and bound to the target jobs through the existing `privateJobsAndLabels` contract.
- The model must consume the profile, card, jobs, and labels parsed from the same raw bytes that passed v3 hash validation.
- The product commit remains `87cc68ede886ac0ef3b53f960c38548cce4a831a`; harness/documentation commits are evaluated-checkpoint changes only.

---

### Task 1: Implement explicit fixture portability v3 with single-read preflight

**Files:**
- Modify: `tests/private_full_chain_runner_smoke.js`
- Modify: `scripts/private-full-chain-runner.js`

**Interfaces:**
- Consumes: existing `createConfirmedEvidencePortability(options, seam)`, `validatePrivateFullChainRequest`, `privateJobsAndLabels`, `confirmedProfileInput`, `confirmedCardInput`, and injected smoke-test seams.
- Produces: `--proof-version confirmed-evidence-portability.v3`; a v3 proof with target fixture identity; portability validation that returns `{ proof, profileInput, cardInput, fixture, resume }`.

- [ ] **Step 1: Add failing v3 creation and explicit-opt-in tests**

Next to the existing portability tests, create a target bundle whose four candidate-evidence files are copied unchanged but whose synthetic jobs and recall-first v2 labels are a different valid set. Assert:

```js
assert.throws(
  () => runner.createConfirmedEvidencePortability({
    sourcePrivateRoot,
    privateRoot: changedTargetRoot,
    output: changedProofPath
  }, seam),
  (error) => error.code === "PRIVATE_FULL_CHAIN_PORTABILITY_INVALID",
  "changed fixtures must not silently upgrade a legacy proof"
);

const proof = runner.createConfirmedEvidencePortability({
  sourcePrivateRoot,
  privateRoot: changedTargetRoot,
  output: changedProofPath,
  proofVersion: "confirmed-evidence-portability.v3"
}, seam);
assert.strictEqual(proof.proofVersion, "confirmed-evidence-portability.v3");
assert.strictEqual(proof.targetFixtureTotal, changedJobs.length);
assert.match(proof.targetJobsFileSha256, /^[0-9a-f]{64}$/);
assert.match(proof.targetLabelsFileSha256, /^[0-9a-f]{64}$/);
assert.strictEqual(proof.targetLabelsVersion, "private-real-jd-labels.v2");
assert.strictEqual(proof.targetEvaluationPolicy, "recall-first.v1");
assert.strictEqual(proof.targetLabelsConfirmedAt, changedLabels.confirmedAt);
assert.deepStrictEqual(Object.keys(proof.consumerCodeBlobs).sort(), [
  "cardCreationBlobId",
  "profileConsumptionBlobId",
  "profileCreationBlobId"
]);
```

Also assert the request gate rejects any unknown `proofVersion` and accepts v3 only for `create-portability-proof`.

- [ ] **Step 2: Run the smoke test and verify RED**

Run:

```powershell
node tests/private_full_chain_runner_smoke.js
```

Expected: exit 1 because `proofVersion` is not accepted and changed jobs are still rejected by the legacy byte-equality loop. No model/provider counter may increment.

- [ ] **Step 3: Add failing safety and compatibility tests**

Add assertions covering all of these before implementation:

1. Existing v1 and v2 proof tests still pass unchanged.
2. v3 rejects modified profile, card, resume, or identity bytes.
3. v3 rejects target labels with `userConfirmed:false`, invalid `confirmedAt`, non-recall policy, source-pool `jobsSha256`, mismatched IDs, or count inconsistent with `targetFixtureTotal`.
4. v3 permits a different injected blob for `src/core/llm_analyzer.js`.
5. v3 rejects a different blob for each of `profile_onboarding.js`, `matching_card.js`, and `search_plan.js`.
6. Removing or adding a v3 proof field, rewriting it into a v1/v2 shape, changing commits, or changing `proofSha256` fails.
7. Appending one byte to target jobs or labels after proof creation fails before settings/provider/SQLite/model counters change.
8. The serialized proof does not contain any fixture title, description, label rationale, synthetic name, phone, or email.

- [ ] **Step 4: Implement the minimal versioned proof schema**

In `scripts/private-full-chain-runner.js`, add:

```js
const PORTABILITY_FIXTURE_TRANSITION_PROOF_VERSION = "confirmed-evidence-portability.v3";
const PORTABILITY_V3_CONSUMER_FILES = {
  profileCreationBlobId: "src/core/profile_onboarding.js",
  cardCreationBlobId: "src/core/matching_card.js",
  profileConsumptionBlobId: "src/core/search_plan.js"
};
```

Add `--proof-version` to `parseCli`. Before mode-specific request handling, reject any non-empty `proofVersion` unless the mode is `create-portability-proof`. In that mode, accept only an empty value or the exact v3 constant and return the normalized `proofVersion`.

Make `resolvePortabilityBlobs` accept an explicit file map while preserving the old default:

```js
function resolvePortabilityBlobs(sourceCommit, targetCommit, seam, files = PORTABILITY_CONSUMER_FILES) {
  const resolveBlob = portabilityBlobResolver(seam);
  try {
    return Object.fromEntries(Object.entries(files).map(([name, file]) => {
      const source = String(resolveBlob(sourceCommit, file) || "").toLowerCase();
      const target = String(resolveBlob(targetCommit, file) || "").toLowerCase();
      if (!/^[0-9a-f]{40,64}$/.test(source) || source !== target) throw new Error("blob mismatch");
      return [name, source];
    }));
  } catch {
    throw runnerError("PRIVATE_FULL_CHAIN_PORTABILITY_INVALID", "The approved consumer-code blob binding is invalid.");
  }
}
```

In `createConfirmedEvidencePortability`:

- compare `profile/card/resume/identity` for every version;
- compare `jobs` only on the legacy v1/v2 path;
- parse source jobs with source labels and target jobs with target labels;
- require explicit v3 when the target fixture differs;
- require target v2 recall-first confirmation for v3;
- emit the exact v3 fields from the design and use `PORTABILITY_V3_CONSUMER_FILES`;
- keep the existing v1/v2 object construction unchanged.

- [ ] **Step 5: Eliminate portability check/use double reads**

Refactor `validateConfirmedEvidencePortability` so it reads target profile, card, resume, identity, jobs, and labels exactly once, hashes those buffers, parses those same buffers, and returns:

```js
{
  proof,
  profileInput,
  cardInput,
  fixture,
  resume: { resumeText, identityRaw, identity }
}
```

Pass the existing privacy validator into this function and apply it to `resumeText` and the parsed identity before returning.

In `runPrivateFullChain`, if `request.portabilityProof` is present, call the validator before creating any separately parsed match-live inputs and use its returned `profileInput`, `cardInput`, `fixture`, and `resume`. For native v2 inputs without a sidecar, preserve the existing path. A supplied invalid/irrelevant sidecar must fail; it must not be silently ignored.

- [ ] **Step 6: Run focused RED→GREEN verification**

Run:

```powershell
node tests/private_full_chain_runner_smoke.js
node tests/job_match_benchmark.js
git diff --check
```

Expected: both tests exit 0, the private runner smoke confirms all accesses remain zero on unsafe v3 inputs, and `git diff --check` prints nothing.

- [ ] **Step 7: Run full offline regression and commit**

Run:

```powershell
npm.cmd test
git status --short
```

Expected: all offline checks pass; only the runner and its smoke test are modified.

Commit:

```powershell
git add -- scripts/private-full-chain-runner.js tests/private_full_chain_runner_smoke.js
git commit -m "test: support confirmed fixture portability v3"
```

### Task 2: Mirror the shared runner and prepare a new evaluated checkpoint

**Files:**
- Modify in candidate: `docs/superpowers/plans/2026-07-30-multi-track-recall-first-matching.md`
- Modify in candidate: `docs/superpowers/plans/2026-07-30-private-benchmark-fixture-portability.md`
- Modify in baseline: `scripts/private-full-chain-runner.js`

**Interfaces:**
- Consumes: Task 1 runner commit, candidate product `87cc68e`, baseline checkpoint `8544a53`, fixed candidate worktree, frozen 20-job pool.
- Produces: byte-identical shared runner blobs, a new candidate evaluated commit, a new baseline evaluated commit, and fresh v3 private-root commands for Task 7.

- [ ] **Step 1: Mirror only the shared runner into the baseline**

Copy the committed candidate `scripts/private-full-chain-runner.js` bytes to:

`D:\DevData\RoleFlow-private-benchmark\baseline-worktree-multi-track-recall-v1\scripts\private-full-chain-runner.js`

Do not copy candidate product modules, private fixtures, tests absent from the baseline, or documentation.

Run:

```powershell
node --check scripts/private-full-chain-runner.js
node tests/job_match_benchmark.js
npm.cmd test
git diff --check
```

Expected: syntax check, benchmark fixtures, and all baseline offline checks pass.

Commit in the baseline:

```powershell
git add -- scripts/private-full-chain-runner.js
git commit -m "test: mirror fixture portability v3 harness"
```

- [ ] **Step 2: Verify shared blob identity**

For candidate and baseline, compare Git blobs for:

```text
scripts/private-full-chain-runner.js
scripts/lib/benchmark_metrics.js
scripts/lib/private_resume_privacy.js
```

Expected: all three corresponding blob IDs are exactly equal. Record both evaluated commit hashes in the main plan.

- [ ] **Step 3: Record Task 6.5 evidence and fresh live roots**

Amend the main multi-track implementation plan with:

- the original failed preflight root retained as diagnostic evidence;
- v3 design, test, runner, baseline mirror, review, and commit evidence;
- candidate product fixed at `87cc68e`;
- new candidate/baseline evaluated commits;
- fresh roots:
  - `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-v3-20260730`
  - `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-20-v3-20260730`
- explicit proof creation argument:

```powershell
--proof-version confirmed-evidence-portability.v3
```

- Task 7 must preserve the existing CLI value `--diagnostic-indices '4,9,10'`. These are explicitly zero-based indices under `parseDiagnosticIndices`, corresponding to human-readable fixture rows 5, 10, and 11; do not subtract one again.

- [ ] **Step 4: Commit a docs-only evaluated checkpoint**

Run candidate full verification again:

```powershell
node tests/private_full_chain_runner_smoke.js
node tests/model_adapter_smoke.js
node tests/semantic_pipeline_smoke.js
npm.cmd test
git diff --check
```

Commit the two plan files:

```powershell
git add -- docs/superpowers/plans/2026-07-30-multi-track-recall-first-matching.md docs/superpowers/plans/2026-07-30-private-benchmark-fixture-portability.md
git commit -m "docs: prepare fixture portability live acceptance"
```

The new HEAD is the candidate evaluated commit. `87cc68e` remains its strict ancestor and declared product commit.

- [ ] **Step 5: Independent review gate**

Review the Task 1–2 diff for exact v1/v2 compatibility, explicit v3 opt-in, proof privacy, single-read execution, blob identity, commit topology, and zero external access. Fix every Critical or Important issue and re-run the covering tests before Task 7.

Task 7 may start only after the review is clean. Real model authorization is checked again at execution time; this plan itself does not call the model.
