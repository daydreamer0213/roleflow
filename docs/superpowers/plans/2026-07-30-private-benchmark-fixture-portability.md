# Private Benchmark Fixture Portability v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely reuse the byte-identical confirmed candidate evidence with the user's independently confirmed 20-job recall-first fixture, without weakening legacy portability proofs or allowing checked inputs to differ from model inputs.

**Architecture:** Add an explicit `confirmed-evidence-portability.v3` sidecar mode to the existing private full-chain runner. Legacy v1/v2 proofs keep their exact schemas and four code-blob invariant; v3 freezes four candidate-evidence files, independently validates and hashes the target recall-first fixture, freezes only the three candidate-evidence creation/consumption blobs, and returns the exact parsed objects derived from the bytes it hashed.

**Tech Stack:** Node.js CommonJS, built-in `fs`/`crypto`/`path`, existing assert-based smoke tests, Git blob identity, PowerShell execution on Windows.

## Global Constraints

- Work only on branch `codex/multi-track-recall-continuation` in its isolated worktree and the existing private baseline worktree; do not modify `D:\Guo\ZhiPing`.
- Do not access BOSS, any recruitment platform, the main `data/jobs.sqlite`, cookies, 8787, or communication actions.
- Do not read the formal model configuration or run a real model during Tasks 1–2.
- Never write private resume, profile, matching-card, JD, or label text into Git, logs, reports, tests, or the portability proof.
- v3 stores SHA-256 values for profile/card confirmation IDs, never the raw IDs. Legacy v1/v2 raw-ID fields remain unchanged only for backward compatibility.
- `confirmed-evidence-portability.v3` must be explicit opt-in through `--proof-version confirmed-evidence-portability.v3`; a failed v1/v2 proof must never auto-upgrade.
- v1/v2 proof creation and validation retain their existing exact fields, four consumer blobs, same-job requirement, and label-transition behavior.
- v3 requires byte-identical confirmed profile, confirmed card, redacted resume, and identity manifest.
- v3 target labels must be either the exact legacy-compatible `private-real-jd-labels.v2` / `recall-first.v1` identity or the exact frozen-pool `private-user-confirmed.v2` / `resume-centered-recall-first.v2` identity. Both remain `userConfirmed === true`, time-valid, and strictly bound to the target jobs through `privateJobsAndLabels`; the frozen-pool identity additionally requires its exact 13-field job schema, description SHA-256, complete labeling policy, non-empty user label, raw-file jobs SHA-256, and `keep/discard` disposition contract.
- The model must consume the profile, card, jobs, and labels parsed from the same raw bytes that passed v3 hash validation.
- The self-hash prevents accidental or incomplete mutation; a local administrator maliciously reauthoring the complete proof, manifest, and all hashes is outside the existing threat model and must not trigger a new same-directory HMAC design.
- The candidate product commit for the next acceptance is
  `6cc09c9ef2603ac24e1a7c3928ce05f996c74214`; the earlier
  `87cc68ede886ac0ef3b53f960c38548cce4a831a` remains historical evidence.
  Harness/documentation commits remain evaluated-checkpoint changes only.

---

### Task 1: Implement explicit fixture portability v3 with single-read preflight

**Files:**
- Modify: `tests/private_full_chain_runner_smoke.js`
- Modify: `scripts/private-full-chain-runner.js`

**Interfaces:**
- Consumes: existing `createConfirmedEvidencePortability(options, seam)`, `validatePrivateFullChainRequest`, `privateJobsAndLabels`, `confirmedProfileInput`, `confirmedCardInput`, and injected smoke-test seams.
- Produces: `--proof-version confirmed-evidence-portability.v3`; a v3 proof with target fixture identity; portability validation that returns `{ proof, profileInput, cardInput, fixture, resume }`.

- [x] **Step 1: Add failing v3 creation and explicit-opt-in tests**

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

- [x] **Step 2: Run the smoke test and verify RED**

Run:

```powershell
node tests/private_full_chain_runner_smoke.js
```

Expected: exit 1 because `proofVersion` is not accepted and changed jobs are still rejected by the legacy byte-equality loop. No model/provider counter may increment.

- [x] **Step 3: Add failing safety and compatibility tests**

Add assertions covering all of these before implementation:

1. Existing v1 and v2 proof tests still pass unchanged.
2. v3 rejects modified profile, card, resume, or identity bytes.
3. v3 rejects target labels with `userConfirmed:false`, invalid `confirmedAt`, non-recall policy, source-pool `jobsSha256`, mismatched IDs, or count inconsistent with `targetFixtureTotal`.
4. v3 permits a different injected blob for `src/core/llm_analyzer.js`.
5. v3 rejects a different blob for each of `profile_onboarding.js`, `matching_card.js`, and `search_plan.js`.
6. Removing or adding a v3 proof field, changing only its version/shape, changing commits, changing confirmation-ID hashes, or changing `proofSha256` fails. Complete malicious reauthoring of every proof/manifest/hash field by the local administrator is outside the established threat model.
7. Appending one byte to target jobs or labels after proof creation fails before settings/provider/SQLite/model counters change.
8. The serialized proof does not contain any fixture title, description, label rationale, synthetic name, phone, or email.

- [x] **Step 4: Implement the minimal versioned proof schema**

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
- emit the exact v3 fields from the design, replace raw `profileConfirmationId` / `cardConfirmationId` with `profileConfirmationIdSha256` / `cardConfirmationIdSha256`, and use `PORTABILITY_V3_CONSUMER_FILES`;
- keep the existing v1/v2 object construction unchanged.

- [x] **Step 5: Eliminate portability check/use double reads**

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

- [x] **Step 6: Run focused RED→GREEN verification**

Run:

```powershell
node tests/private_full_chain_runner_smoke.js
node tests/job_match_benchmark.js
git diff --check
```

Expected: both tests exit 0, the private runner smoke confirms all accesses remain zero on unsafe v3 inputs, and `git diff --check` prints nothing.

- [x] **Step 7: Run full offline regression and commit**

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

- [x] **Step 1: Mirror only the shared runner into the baseline**

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

- [x] **Step 2: Verify shared blob identity**

For candidate and baseline, compare Git blobs for:

```text
scripts/private-full-chain-runner.js
scripts/lib/benchmark_metrics.js
scripts/lib/private_resume_privacy.js
```

Expected: all three corresponding blob IDs are exactly equal. Record both evaluated commit hashes in the main plan.

- [x] **Step 3: Record Task 6.5 evidence and fresh live roots**

Amend the main multi-track implementation plan with:

- the original failed preflight root retained as diagnostic evidence;
- v3 design, test, runner, baseline mirror, review, and commit evidence;
- candidate product fixed at `87cc68e`;
- new candidate/baseline evaluated commits;
- fresh roots:
  - `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-v3-live-run-20260730`
  - `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-20-v3-20260730`
- explicit proof creation argument:

```powershell
--proof-version confirmed-evidence-portability.v3
```

- Task 7 must preserve the existing CLI value `--diagnostic-indices '4,9,10'`. These are explicitly zero-based indices under `parseDiagnosticIndices`, corresponding to human-readable fixture rows 5, 10, and 11; do not subtract one again.

- [x] **Step 4: Commit a docs-only evaluated checkpoint**

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

- [x] **Step 5: Independent review gate**

Review the Task 1–2 diff for exact v1/v2 compatibility, explicit v3 opt-in, proof privacy, single-read execution, blob identity, commit topology, and zero external access. Fix every Critical or Important issue and re-run the covering tests before Task 7.

Task 7 may start only after the review is clean. Real model authorization is checked again at execution time; this plan itself does not call the model.

## Execution record: 2026-07-30

- Original v3 chain: design `50e23f8`, plan `deb1507`, implementation `d179a84`, threat-model clarification `44a620c`, and SHA-256 confirmation IDs plus tamper coverage `71885b9`.
- Independent review found two Important gaps and one Moderate issue: runtime evaluated consumer blobs were not bound to the proof, the required check-after-replacement regression was absent, and `preflight.portability = preflight` created a circular object.
- Fix `07ece938a363bf4725fe928cb5a8f778404a4d47` added runtime consumer binding, the six-file single-read/hash-and-use race regression, and a non-circular portability object.
- Re-review found that baseline runtime blobs were still resolved in the fixed candidate repository. Fix `9d7d1a4e4865b76073eca3af007250110db18d20` separated proof resolution from runtime resolution and added an independent-baseline-repository positive test plus baseline/candidate negative tests.
- Final independent result for `71885b9..9d7d1a4`: **Spec PASS** and **Code quality APPROVED**, with no Critical, Important, or Moderate findings.
- Candidate verification at `9d7d1a4`: runner smoke passed, benchmark passed with 31 fixtures, `npm.cmd test` passed all 47 offline checks, and `git diff --check` was clean.
- Baseline mirror commit: `cc5dc6adf158c4c38cfefb808a78a53b4bfdf389`. Its repository-native 41 offline checks and 31 benchmark fixtures passed; the baseline intentionally does not contain the candidate-only `private_full_chain_runner_smoke.js`.
- The first Task 7 proof preflight in `multi-track-recall-first-3-v3-20260730` stopped before any model call because the plan selected the v2 root `full-chain-v40c-role-industry-boundary-2-20260730` as the source, while portability requires a v1 source manifest and v2 target manifest. Preserve that root as failed preflight evidence.
- The unique matching v1 source is `D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725`: its four frozen confirmed-evidence files are byte-identical to the planned source, and its manifest commits match the existing v2 proof source binding. The candidate worktree was restored cleanly before correcting the plan.
- The corrected-source preflight in `multi-track-recall-first-3-v3-v1-source-20260730` then stopped before any model call because the frozen labels use the exact `private-user-confirmed.v2` / `resume-centered-recall-first.v2` envelope, raw-file jobs SHA-256, `userLabel`, and `keep/discard` contract that the synthetic v3 fixture had not covered. Preserve that root as failed fixture-schema evidence.
- The runner regression uses only synthetic values and requires proof creation, full match-live consumption, internal `discard` to `exclude` normalization, comparison identity preservation, and fail-closed rejection of malformed user-confirmed envelopes.
- The next preflight in `multi-track-recall-first-3-v3-user-confirmed-20260730` stopped before any model call because the frozen jobs use an exact 13-field schema and bind `sourceContentHash` directly to the JD description bytes. Preserve that root as failed job-schema preflight evidence.
- The synthetic regression now mirrors that job schema and rejects an incorrect description hash or any extra job field.
- Candidate fix `6152d70cd584531604db867d9a73747c41a75994` passed independent review with **Spec PASS** and **Code quality APPROVED**, runner smoke, 31 benchmark fixtures, all 47 offline checks, and `git diff --check`.
- Baseline mirror `c47992259c6c206887b4bb13cf82765e4af68e3b` passed its repository-native 41 offline checks and 31 benchmark fixtures.
- Candidate frozen-job fix `cebe59f5aae78abdde873adfe211f296d3322519` passed independent review with **Spec PASS** and **Code quality APPROVED**, runner smoke, 31 benchmark fixtures, all 47 offline checks, and `git diff --check`.
- Baseline mirror `63c2ac393aa6cc8a7728fea6f0944d5f4db9cad6` passed its repository-native 41 offline checks and 31 benchmark fixtures.
- Candidate/baseline shared blobs are identical:
  - runner `d3cdc259675005dce1370adbd6f0746e423a305f`
  - benchmark metrics `0edda7c2449639f3fecdee394fa60cc2f0447c05`
  - private resume privacy `8a4b21d7493fb5e7d8ce49662ba3951687903c46`
- Candidate product remains `87cc68ede886ac0ef3b53f960c38548cce4a831a`; it is a strict ancestor of frozen evaluated commit `cebe59f5aae78abdde873adfe211f296d3322519`. Baseline product `fb0168afce265cf351f03e80f66d9e0f24015887` is a strict ancestor of baseline evaluated commit `63c2ac393aa6cc8a7728fea6f0944d5f4db9cad6`.
- Live execution must use candidate evaluated `cebe59f5aae78abdde873adfe211f296d3322519` and baseline evaluated `63c2ac393aa6cc8a7728fea6f0944d5f4db9cad6`; later docs-only records do not replace either manifest binding.
- Keep `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-20260730` unchanged as failed diagnostic evidence.
- Keep `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-v3-20260730` unchanged as failed v1/v2 manifest preflight evidence.
- Keep `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-v3-v1-source-20260730` unchanged as failed frozen-label-schema preflight evidence.
- Keep `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-v3-user-confirmed-20260730` unchanged as failed frozen-job-schema preflight evidence.
- Fresh live roots:
  - `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-v3-live-run-20260730`
  - `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-20-v3-20260730`
- Preserve zero-based `--diagnostic-indices '4,9,10'` exactly and create v3 proof with `--proof-version confirmed-evidence-portability.v3`.

## 2026-07-30 live-shell interruption checkpoint

- Preserve `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-v3-job-schema-20260730` unchanged as shell-orchestration interruption evidence.
- The evaluated fixture-portability preflight completed before the live wrapper was interrupted by PowerShell promoting Node's SQLite experimental stderr warning to a terminating error.
- Read-only inspection found no match result, zero-byte redirected logs, zero model-cache rows, and no application/model/state rows. No live acceptance conclusion may be drawn from this root.
- The next 3-row run must use the initially absent root `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-v3-live-run-20260730`; the evaluated candidate and baseline commits remain `cebe59f5aae78abdde873adfe211f296d3322519` and `63c2ac393aa6cc8a7728fea6f0944d5f4db9cad6`.
## 2026-07-30 private contract-failure diagnostic checkpoint

- The fresh three-row root `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-v3-live-run-20260730` exited `0` but is not accepted: zero-based index `4` ended in `MODEL_CONTRACT_INVALID` after `matchJob` contract repair and entered `analysis_pending`.
- Preserve that root unchanged. Indices `9` and `10` being structurally complete does not permit the 20-row run.
- The candidate privacy-safe diagnostic implementation is commits `7de5d8d9b29cb1f6ea4b6d1a9f4b74d9b0f2db26` and `4416d295f10bedf1f6774a5b0dc37dd4836ac0b2`; the final candidate evaluated commit is `4416d295f10bedf1f6774a5b0dc37dd4836ac0b2`.
- The mechanically mirrored baseline evaluated commit is `d20606192986f40f49db634e6db999f3cd5d576c`.
- Product commits remain candidate `87cc68ede886ac0ef3b53f960c38548cce4a831a` and baseline `fb0168afce265cf351f03e80f66d9e0f24015887`.
- Candidate verification passed the focused private runner smoke, 31 fixtures, 47 offline checks, and diff check. Baseline verification passed 31 fixtures, 41 native offline checks, and diff check.
- Candidate/baseline shared blobs are runner `f45d50450ccd294917db5cc5d995c34eac403c50`, metrics `0edda7c2449639f3fecdee394fa60cc2f0447c05`, and privacy `8a4b21d7493fb5e7d8ce49662ba3951687903c46`.
- Independent review concluded `Spec PASS` and `Code quality APPROVED` with no Critical, Important, or Moderate finding.
- The new fields are closed-enum private telemetry only. They do not persist error text, arbitrary output-shape keys, model output, prompts, private evidence, provider metadata, or model configuration.

The next and only permitted live diagnostic root is
`D:\DevData\RoleFlow-private-benchmark\multi-track-recall-index-4-contract-diagnostic-v1-20260730`.
It must use an empty cache, v1 source evidence, the frozen jobs/labels, v3 proof,
candidate evaluated `4416d295f10bedf1f6774a5b0dc37dd4836ac0b2`,
baseline evaluated `d20606192986f40f49db634e6db999f3cd5d576c`, and exactly
zero-based `--diagnostic-indices '4'`. The result is root-cause evidence only.
Do not create `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-20-v3-20260730`.

## 2026-07-30 契约失败原因码复审检查点

- 类别级单条诊断目录 `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-index-4-contract-diagnostic-v1-20260730` 保持不可变；其安全字段为 initial/repair category 均为 `other`，不足以定位具体 validator 规则，不能覆盖或复用。
- 原因码设计与计划扩展提交为 `4434b6d60de47fef8ff8584a4a68cf6c32c13ec9`。初版实现提交为 `2508b9c6f2872a47d1c5b75e712a8cffbb026cc6`；独立复审发现 failed-only initial reason 未对称回填、以及 pure-unknown/multi-template 回归覆盖不足。
- TDD 修复提交为 `3903b5c0a2a2138033ecd96a46fe7995761df6f5`：先以 failed-only 用例稳定复现 `initial reason = none`，再增加封闭枚举回填；pure unknown 与多模板歧义均固定归为 `other`。复审结论：无 Critical/Important/Moderate/Minor，`Spec PASS`，`Code quality APPROVED`。
- 候选离线证据：`private_full_chain_runner_smoke` 通过，`job_match_benchmark` 31 fixtures 通过，`npm.cmd test` 47 项通过，`git diff --check` 通过，工作树干净。
- 基线只机械镜像 `scripts/private-full-chain-runner.js`，提交为 `90606956713c3666fca42a30f4afd3f0a33af133`；31 fixtures、41 项离线检查、`git diff --check` 均通过，工作树干净。
- 三个共享 Git blob 候选/基线一致：runner `52935822d9b6141ec871b85e2c97cc8719324ef2`，metrics `0edda7c2449639f3fecdee394fa60cc2f0447c05`，privacy `8a4b21d7493fb5e7d8ce49662ba3951687903c46`。
- 产品提交不变：候选 `87cc68ede886ac0ef3b53f960c38548cce4a831a`，基线 `fb0168afce265cf351f03e80f66d9e0f24015887`；产品提交必须继续是 evaluated commit 的严格祖先。
- 下一 live 步骤只允许使用全新目录 `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-index-4-contract-reason-v1-20260730`、全新缓存和零基 `--diagnostic-indices '4'`。先核验冻结岗位池 raw SHA；只读取闭合的安全状态/category/reason 字段；完成后立即恢复固定候选原分支 `codex/claude-generic-evidence-matching-live-fix` @ `1fc49dac3670a71c720bfcaed943fa29204d93c5` 并确认干净。
- 在单条原因码证据支持产品侧根因修复、离线回归与独立复审前，不得重新运行 3 条，也不得创建或运行 20 条目录。

### Evaluated 绑定替换说明

- 本检查点明确 supersede（替换）前一个 category checkpoint 的“下一 live 动作”和 evaluated 绑定；旧 `4416d295f10bedf1f6774a5b0dc37dd4836ac0b2` 及其 category root 只保留为不可变历史证据，不再是 reason live 的允许 HEAD 或允许 next root。
- 新 candidate evaluated 精确为 `3903b5c0a2a2138033ecd96a46fe7995761df6f5`；新 baseline evaluated 精确为 `90606956713c3666fca42a30f4afd3f0a33af133`。后续 docs-only checkpoint 只记录证据，不替换这两个 evaluated 提交。
- 创建 reason root 前，临时候选分支 `codex/multi-track-recall-contract-diagnostic-v1` 必须精确指向并检出 candidate evaluated `3903b5c0a2a2138033ecd96a46fe7995761df6f5`；基线分支 `codex/multi-track-recall-private-baseline-v1` 的 HEAD 必须精确为 baseline evaluated `90606956713c3666fca42a30f4afd3f0a33af133`，两边工作树都必须干净。
- reason root 的 manifest 与 v3 proof 必须分别绑定上述 candidate/baseline evaluated；任一 HEAD、绑定或冻结输入哈希不符都立即停止，不运行模型。
- 已重新验证产品提交的严格祖先关系：candidate product `87cc68ede886ac0ef3b53f960c38548cce4a831a` 是 candidate evaluated 的严格祖先；baseline product `fb0168afce265cf351f03e80f66d9e0f24015887` 是 baseline evaluated 的严格祖先。

### Reason v1 建根失败与 v2 替换

- `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-index-4-contract-reason-v1-20260730` 在建根阶段因 PowerShell 原生重定向报 `path format is not supported` 而中止；固定候选已在 `finally` 中恢复原分支/原提交并确认干净。
- 安全状态核验：v1 根已有 manifest 与 v3 proof，但没有 `model-cache.sqlite`、没有 `match-result.json`，未发现真实模型运行产物，不能将该根视为已运行或验收证据；该根保持不可变，禁止覆盖、删除、补跑或复用。
- 本条 supersede 上一节对 reason v1 的 next-root 绑定。新的唯一允许 reason live 根为 `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-index-4-contract-reason-v2-20260730`；开始前必须不存在，并重新复制 7 个冻结文件、重新核验 raw SHA、重新生成 manifest/v3 proof、重新执行 candidate/baseline 双侧 preflight。
- v2 继续绑定 candidate evaluated `3903b5c0a2a2138033ecd96a46fe7995761df6f5` 与 baseline evaluated `90606956713c3666fca42a30f4afd3f0a33af133`，只运行零基 `--diagnostic-indices '4'`。命令输出只写 v2 私有 reports；改用 `Start-Process` 的 stdout/stderr 重定向，避免重现 shell 重定向错误。
- v2 live 完成或失败后都必须恢复固定候选 `codex/claude-generic-evidence-matching-live-fix` @ `1fc49dac3670a71c720bfcaed943fa29204d93c5` 并确认干净；3 条和 20 条继续 gated。

### Reason v2 CLI 根因与 v3 替换

- `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-index-4-contract-reason-v2-20260730` 在 candidate `--preflight` 命令处以 CLI argument 错误停止；runner 的实际 `MODES` 集合不包含 `preflight`，因此不存在可单独调用的 `--preflight` 模式。v2 没有 cache/result，保持不可变并禁止补跑、覆盖或复用。
- 旧成功 category 诊断根只有 `match-live` 私有日志，也佐证此前“preflight 通过”指 live 前的编排门禁与 `match-live` 内部 preflight，不是一个独立 CLI 命令。
- 本条 supersede reason v2 的 next-root 绑定。新的唯一允许根为 `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-index-4-contract-reason-v3-20260730`；必须全新复制 7 个冻结文件并核验 raw SHA，全新生成 manifest/v3 proof，重新 verify-private-bundle，并在 live 前显式核验 candidate/baseline HEAD、clean、产品提交严格祖先、三个共享 blob、固定分支、输出不存在。
- 不再调用不存在的 `--preflight`。候选 `--match-live` 会在模型配置解析与模型调用前执行 runner 内部 manifest、proof、隐私、fixture、diagnostic-index 等 preflight；任一失败都会在 live 产物中止并由外层 `finally` 恢复固定候选。
- v3 继续精确绑定 candidate evaluated `3903b5c0a2a2138033ecd96a46fe7995761df6f5` 与 baseline evaluated `90606956713c3666fca42a30f4afd3f0a33af133`，只运行零基 `--diagnostic-indices '4'`，所有 stdout/stderr 只写 v3 私有 reports。3 条和 20 条继续 gated。

## 2026-07-30 `result_not_object` evaluated 检查点

- reason v3 根 `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-index-4-contract-reason-v3-20260730` 已以冻结 raw SHA 和零基 index `4` 可信退出 0；安全结果为 total 1、failed 1、`MODEL_CONTRACT_INVALID`、matchJob/contract_repair，initial/repair category 与 reason 均为 `other`，未持久化原始错误或 shape。固定候选已恢复原分支/原提交并干净，20 条根仍不存在。v3 保持 immutable。
- 静态 validator 对照将该结果限定为分类器缺口推断；新增闭合 reason `result_not_object` 只匹配固定“必须返回 JSON 对象”或 `must return a JSON object`，category 为 `result_shape`，不保存 raw/capture/key/length/`outputShape`。
- 初版 TDD 提交 `43950770a3e373b98b2f6273317a269eebffbd10`；独立复审指出 category 提前返回会绕过歧义去重、英文模板缺独立覆盖。修复提交 `31e53ef6e728912e19fd207b2b28b4ecf9f6b6d5` 已把 result-shape 纳入统一去重，并锁定中文单模板、英文单模板与混合模板。最终复审无 Critical/Important/Moderate/Minor，`Spec PASS`、`Code quality APPROVED`。
- 新 candidate evaluated 精确为 `31e53ef6e728912e19fd207b2b28b4ecf9f6b6d5`；候选 focused smoke、31 fixtures、47 项离线检查、diff check 全通过，工作树干净。
- 基线仅机械镜像 runner，提交 `fb2f6fe17b171f7cc974b75c6a3740d614c2cacd`；31 fixtures、41 项离线检查、diff check 全通过，工作树干净。新 baseline evaluated 精确为该提交。
- 三项共享 blob 一致：runner `630d958d6de81e0ed2e57ad9d72231919b917b70`，metrics `0edda7c2449639f3fecdee394fa60cc2f0447c05`，privacy `8a4b21d7493fb5e7d8ce49662ba3951687903c46`。
- 本检查点 supersede 此前 reason v1-v3 的 next-root 与旧 evaluated 绑定；v1-v3 只作 immutable 历史证据。后续 docs-only commit 不替换上述 candidate/baseline evaluated。
- 唯一允许的下一根为 `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-index-4-contract-reason-v4-20260730`。临时候选分支与 manifest/proof 必须绑定 candidate evaluated `31e53ef6e728912e19fd207b2b28b4ecf9f6b6d5`，基线 HEAD 与 manifest/proof 必须绑定 baseline evaluated `fb2f6fe17b171f7cc974b75c6a3740d614c2cacd`；重新复制 7 文件、raw SHA、v3 proof、bundle 与所有外层 gates，只运行零基 index `4`，私有日志，最后恢复固定候选。
- 产品提交保持候选 `87cc68ede886ac0ef3b53f960c38548cce4a831a` 与基线 `fb0168afce265cf351f03e80f66d9e0f24015887`，并继续是对应 evaluated 的严格祖先。v4 确认具体规则前不得做产品修复、3 条或 20 条运行。

## 2026-07-30 matchJob 阶段隔离与 sparse reason 检查点

- reason v4 根 `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-index-4-contract-reason-v4-20260730` 可信退出 0；安全结果仍为 matchJob/contract_repair failed、initial/repair `other/other`，但 `modelCallCount=4`、`contractRepairCount=2`。固定候选恢复原分支/提交并干净，20 根不存在；v4 immutable。
- 源码对照发现固定 validator 规则 `multi-track matching requires sparse evidence` 未被分类，且旧 collector 混合 understandJob/matchJob repair。该证据只支持分类器候选，不宣称产品根因。
- 新闭合 reason `multi_track_requires_sparse` 对应 category `result_shape`。新增有界整数 `understandJobContractRepairCount` 与 `matchJobContractRepairCount`；total 统计所有 exact requested，两个子计数只统计已知 kind；四个原因字段只接受 matchJob 事件，unknown kind 只增加 total，failed-only 可回填，逐行 reset。
- 实现提交 `82ae8477c28dab2cc2863749959f0a03df9dff53`；后续测试加强提交 `269430f3e9aae1705b0503f5ff4e83df7da6c280` 与 `c4418e5314e8694c727f56a55ba5486ff2fb1e69` 分别锁定 unknown 后置不覆盖，以及严格 sparse+roleAlignment 双模板歧义。最终独立复审无 Critical/Important/Moderate/Minor，`Spec PASS`、`Code quality APPROVED`。
- 新 candidate evaluated 精确为 `c4418e5314e8694c727f56a55ba5486ff2fb1e69`；focused、31 fixtures、47 项离线检查、diff check 通过且 clean。
- 基线只镜像 runner，提交及新 baseline evaluated 为 `7b3375b29a8f63ce9cbeb587ef965e77aa3355d5`；31 fixtures、41 项离线检查、diff check 通过且 clean。
- 共享 blob 一致：runner `c80e179d9e665b5e75139dfa9704107e95c5300c`，metrics `0edda7c2449639f3fecdee394fa60cc2f0447c05`，privacy `8a4b21d7493fb5e7d8ce49662ba3951687903c46`。
- 本检查点 supersede reason v1-v4 next-root 与旧 evaluated；v1-v4 immutable。docs-only commit 不替代 candidate/baseline evaluated。
- 唯一 next root 为 `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-index-4-contract-reason-v5-20260730`，全新复制/哈希/manifest/v3 proof/bundle/gates，临时分支和 manifest/proof 精确绑定 candidate evaluated `c4418e5314e8694c727f56a55ba5486ff2fb1e69`，基线绑定 `7b3375b29a8f63ce9cbeb587ef965e77aa3355d5`，仅零基 index `4`，私有日志，finally 恢复固定候选。
- 产品 commits 仍为 candidate `87cc68ede886ac0ef3b53f960c38548cce4a831a`、baseline `fb0168afce265cf351f03e80f66d9e0f24015887` 且为严格祖先。v5 确认前不得产品修复、3 条或 20 条。

## 2026-07-30 multi-track sparse repair product checkpoint

- This checkpoint supersedes the prior reason-v5 next action and product
  binding. All earlier diagnostic roots remain immutable historical evidence.
- Reason v5 at
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-index-4-contract-reason-v5-20260730`
  exited `0` for exact zero-based index `4`. Its private-safe result was one
  failed row at `matchJob` contract repair: initial and repair category
  `result_shape`, reason `multi_track_requires_sparse`, one match repair, zero
  understand-job repairs, no selected track, and incomplete evidence. The raw
  response shape was neither persisted nor inspected; this proves the repeated
  strict sparse-validator failure, not any particular raw legacy key.
- Reviewed design checkpoint `ce3a6f1ae1dc30c6fa2f9a1d9b471ce92a17216c`
  chose exact-key prompt reinforcement plus narrowly targeted repair
  de-anchoring. Product commit
  `9783d0b652ebb4db2233dba6135615494ca2feb9` implements it without weakening
  the validator, adding a repair, changing DeepSeek thinking policy, mutating
  caller input, or changing unrelated repair inputs.
- The TDD regression failed first on the absent exact six-key contract. After
  implementation, `model_adapter_smoke`, `semantic_pipeline_smoke`, all 31
  benchmark fixtures, all 47 candidate offline checks, and `git diff --check`
  passed from a clean product commit. Independent review found no Critical,
  Important, Moderate, or Minor findings and concluded `Spec PASS` and
  `Code quality APPROVED`.
- The docs-only commit produced by this checkpoint is the new candidate
  evaluated commit. A direct descendant docs-only binding record must add its
  exact SHA before any private root is created; that later record does not
  replace the evaluated commit. Candidate product `9783d0b652ebb4db2233dba6135615494ca2feb9`
  must be its strict ancestor.
- Baseline product remains
  `fb0168afce265cf351f03e80f66d9e0f24015887`; baseline evaluated remains
  `7b3375b29a8f63ce9cbeb587ef965e77aa3355d5`. No shared harness file changed,
  so the reviewed candidate/baseline blobs remain runner
  `c80e179d9e665b5e75139dfa9704107e95c5300c`, metrics
  `0edda7c2449639f3fecdee394fa60cc2f0447c05`, and privacy
  `8a4b21d7493fb5e7d8ce49662ba3951687903c46`.
- Recheck the frozen pool before every live root: jobs raw SHA-256
  `612547b099d71f13fc5dd58e78a31756b4b56c7ad9375f7b3d182d73b5e0d35b`
  and labels raw SHA-256
  `97b4e5830fbf0fad8a694a3cfc1fcedfd5918b3e9723b811ebba09f1fb46da39`.
- Preserve the existing
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-v3-20260730`
  unchanged. The only permitted three-row acceptance root is the initially
  absent
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-sparse-repair-v1-20260730`.
  Create/copy/hash all seven frozen files, generate and verify manifest plus
  v3 proof, confirm cache/result/output absence, then run exact zero-based
  `--diagnostic-indices '4,9,10'` with a fresh cache.
- The 20-row root
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-20-v3-20260730`
  must remain absent until all three rows are structurally complete and pass
  their expected bucket/recommendation and safety gates. The 20-row run must
  rebuild its own root, manifest, v3 proof, and fresh cache.
- Every live attempt must stage
  `codex/multi-track-recall-contract-diagnostic-v1` at the exact candidate
  evaluated commit, bind candidate/baseline product and evaluated commits in
  the manifest/proof, and restore
  `codex/claude-generic-evidence-matching-live-fix` at
  `1fc49dac3670a71c720bfcaed943fa29204d93c5` with clean status in `finally`.

### Exact evaluated binding

- Candidate evaluated is exactly
  `e906f6b55c112e89b2a9ec43c9c8168ea74786b9`. Candidate product
  `9783d0b652ebb4db2233dba6135615494ca2feb9` must be verified as its strict
  ancestor immediately before root creation.
- This binding record is documentation-only and does not replace candidate
  evaluated `e906f6b55c112e89b2a9ec43c9c8168ea74786b9` in the manifest, v3 proof,
  temporary evaluation branch, or final offline verification.
- Baseline evaluated remains exactly
  `7b3375b29a8f63ce9cbeb587ef965e77aa3355d5`, with baseline product
  `fb0168afce265cf351f03e80f66d9e0f24015887` as its strict ancestor.

### Sparse-repair three-row v1 orchestration failure and v2 replacement

- Preserve
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-sparse-repair-v1-20260730`
  unchanged. Manifest initialization, v3 proof creation, and bundle
  verification each exited `0`, but an extra outer assertion incorrectly
  required the v3 portability proof to contain the baseline evaluated commit.
  The failure occurred before `match-live`; no model cache, match result, or
  match-live stdout/stderr file exists. The fixed candidate was restored to
  `codex/claude-generic-evidence-matching-live-fix` at
  `1fc49dac3670a71c720bfcaed943fa29204d93c5` with clean status.
- The runner-owned schemas are authoritative: `run-manifest.json` binds both
  candidate and baseline product/evaluated commits. The v3 portability proof
  separately binds its historical source product/evaluated commits and current
  target candidate product/evaluated commits plus the three consumer blobs; it
  does not carry a baseline evaluated field. The successful bundle verifier
  validates this division of responsibility.
- The only permitted replacement root is the initially absent
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-sparse-repair-v2-20260730`.
  Rebuild all seven frozen files, manifest, v3 proof, and verifier outputs.
  Require the manifest to bind all four candidate/baseline commits; require the
  proof to bind target product
  `9783d0b652ebb4db2233dba6135615494ca2feb9` and target evaluated
  `e906f6b55c112e89b2a9ec43c9c8168ea74786b9`. Do not add a synthetic baseline
  field requirement to the proof.
- All other gates remain unchanged: exact raw hashes, identical shared blobs,
  zero-based `4,9,10`, fresh cache/output absence, no 20-row root, private log
  redirection, and fixed-candidate restoration in `finally`.

## 2026-07-30 multi-track validation idempotence product checkpoint

- Preserve
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-sparse-repair-v2-20260730`
  unchanged. Its live process exited `0`: indices `9` and `10` were exact and
  structurally complete, while zero-based index `4` failed after one
  `matchJob` repair with initial/repair category `result_shape`, reason
  `multi_track_requires_sparse`, empty selected track, and incomplete evidence.
  The private-safe aggregate was two of three exact, with no false hard
  exclusion, primary-without-evidence, hard false placement, or missed obvious
  exclusion. The fixed candidate was restored cleanly and the 20-row root
  remained absent.
- Static control-flow inspection, not raw model-output inspection, established
  the product root cause. `validateSparseMatchEvidence` derived a full local
  decision but discarded its validated `matches` and `eligibility`; subsequent
  analyzer/cache validation therefore routed the normalized multi-track value
  through the forbidden legacy full-decision path. The v2 result does not prove
  that DeepSeek returned a legacy shape.
- Reviewed design commit
  `9ca6ddf391a208635711ff6cff3992c0179b4d75` selected validation idempotence:
  retain only the two already normalized sparse arrays in the internal
  decision, keep every validation layer, and increment the match pipeline from
  v28 to v29.
- Product commit
  `099a71331f74d0b21a149b835908744e74962794` implements that design. The focused
  regression first failed because normalized `matches` was absent, then passed
  multi-/single-track repeat validation, JSON cache round-trip, raw extra-key
  and privacy-sentinel removal, injected-adapter validation, legacy boundary
  checks, and v28 stale behavior.
- Candidate verification passed `model_adapter_smoke`,
  `semantic_pipeline_smoke`, all 31 benchmark fixtures, all 47 offline checks,
  and `git diff --check` from a clean product commit. Independent review found
  no Critical, Important, Moderate, or Minor finding and concluded
  `Spec PASS` and `Code quality APPROVED`.
- The docs-only commit produced by this checkpoint is the next candidate
  evaluated commit. Its exact SHA must be recorded by an immediate descendant
  docs-only binding record before private root creation. Candidate product
  `099a71331f74d0b21a149b835908744e74962794` must be its strict ancestor.
- Baseline product/evaluated remain
  `fb0168afce265cf351f03e80f66d9e0f24015887` /
  `7b3375b29a8f63ce9cbeb587ef965e77aa3355d5`; no shared harness file changed,
  so runner/metrics/privacy blobs remain
  `c80e179d9e665b5e75139dfa9704107e95c5300c`,
  `0edda7c2449639f3fecdee394fa60cc2f0447c05`, and
  `8a4b21d7493fb5e7d8ce49662ba3951687903c46`.
- Preserve both sparse-repair v1/v2 roots. The only permitted next three-row
  root is the initially absent
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-validation-idempotence-v1-20260730`.
  Rebuild all seven frozen files, exact hashes, manifest, v3 proof, verifier
  outputs, and fresh cache; run exact zero-based `4,9,10`; restore the fixed
  candidate in `finally`. Do not create the 20-row root until all three rows
  pass exact, structural, recall, and safety gates.

### Validation-idempotence exact evaluated binding

- Candidate evaluated is exactly
  `e28333c0e1410fb6d784aa6f0dc93cb3b695eacb`. Candidate product
  `099a71331f74d0b21a149b835908744e74962794` must be verified as its strict
  ancestor immediately before root creation.
- This docs-only binding record does not replace candidate evaluated
  `e28333c0e1410fb6d784aa6f0dc93cb3b695eacb` in the manifest, v3 proof,
  temporary evaluation branch, or final offline verification.
- Baseline evaluated/product remain exactly
  `7b3375b29a8f63ce9cbeb587ef965e77aa3355d5` /
  `fb0168afce265cf351f03e80f66d9e0f24015887`.

## 2026-07-30 broad requirement direct-instance product checkpoint

- Preserve
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-validation-idempotence-v1-20260730`
  unchanged. All three rows were structurally complete with selected tracks,
  evidence, no hard blockers, and no contract/empty-response failure. Index
  `9` was exact. Index `4` was `caution/talk` instead of confirmed
  `apply/primary`; index `10` was `review/talk` instead of confirmed
  `caution/talk`. The 20-row root remained absent and the fixed candidate was
  restored cleanly.
- The first wrong row's private-safe state isolated its false caution: every
  central requirement was `matched`; two non-core rows were `missing`; one
  non-central foundation/indispensable row was `transferable`. Local policy
  therefore behaved consistently, but the evidence classification did not
  meet the confirmed label.
- Public synthetic fixtures prove that globally promoting transferable
  indispensable evidence would break valid cross-domain caution behavior.
  Reviewed locally, design commit
  `5fcf7399f4d40464f3de2d9f7b7a63a3e95d0304` therefore keeps local policy
  unchanged and strengthens only the generic prompt boundary: a concrete
  direct instance of a broad unqualified capability is `matched`, while an
  explicitly named but unproved domain/platform/tool/work difference remains
  `transferable`.
- Product commit
  `2ef0798bea0c33ae267d0fee8649ff673e9665b4` adds that symmetric prompt rule
  without private examples and increments the match pipeline from v29 to v30.
  The prompt assertion failed before implementation, then adapter, semantic
  pipeline, all six generic evidence fixtures, all 31 benchmark fixtures, all
  47 offline checks, and `git diff --check` passed from a clean commit.
- Independent reviewer capacity was exhausted during this checkpoint. No
  independent approval is claimed. The change is limited to prompt text,
  version invalidation, and tests; the next immutable three-row live result is
  an additional required gate. A later independent review must still be
  attempted if capacity returns.
- The docs-only commit produced by this checkpoint is the next candidate
  evaluated commit. Its exact SHA must be recorded by an immediate descendant
  docs-only binding record. Candidate product
  `2ef0798bea0c33ae267d0fee8649ff673e9665b4` must be its strict ancestor.
- Baseline product/evaluated and all three shared harness blobs remain
  unchanged. The only permitted next three-row root is the initially absent
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-direct-instance-v1-20260730`.
  Rebuild the seven frozen files, exact hashes, manifest, v3 proof, verifier
  outputs, and fresh cache; run zero-based `4,9,10`; restore the fixed
  candidate in `finally`. Keep the 20-row root absent unless all three pass.

### Direct-instance exact evaluated binding

- Candidate evaluated is exactly
  `4845fb37d5c19f9741a17ea074f906c61269a924`. Candidate product
  `2ef0798bea0c33ae267d0fee8649ff673e9665b4` must be verified as its strict
  ancestor before root creation.
- This docs-only binding record does not replace candidate evaluated
  `4845fb37d5c19f9741a17ea074f906c61269a924` in the manifest, v3 proof,
  temporary evaluation branch, or final verification.
- Baseline evaluated/product remain
  `7b3375b29a8f63ce9cbeb587ef965e77aa3355d5` /
  `fb0168afce265cf351f03e80f66d9e0f24015887`.

## 2026-07-30 cross-track responsibility sprawl product checkpoint

- Preserve
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-direct-instance-v1-20260730`
  unchanged. Its live process exited `0`; zero-based indices `9` and `10`
  matched their confirmed bucket/recommendation exactly, while index `4`
  remained `caution/talk` instead of `apply/primary`. All three rows were
  structurally complete with evidence, selected tracks, and no hard blocker,
  contract failure, or empty response. The fixed candidate was restored cleanly
  and the 20-row root remained absent.
- The direct-instance change worked on the first wrong row: its non-central
  foundation/indispensable R3 moved from `transferable` to `matched`. The
  remaining downgrade was the job-quality `responsibility_sprawl` signal even
  though `understandJob` had separated multiple explicit independent hiring
  tracks. This isolates the next root cause to combining duties across tracks
  when evaluating sprawl, rather than match evidence or local recommendation
  policy.
- Design commit `66357ac1621971607ffc233291c227cfc2062c81` requires
  `responsibility_sprawl` to be evaluated inside each independent hiring track
  while preserving the existing signal for a single track that itself mixes
  unrelated duties.
- Product commit `6cc09c9ef2603ac24e1a7c3928ce05f996c74214` adds only that
  prompt boundary and increments `understandJob` from v15 to v16 and `matchJob`
  from v30 to v31. The two focused regressions failed first for the absent
  boundary and stale versions, then passed after the minimal implementation.
- Fresh verification passed `model_adapter_smoke`, `semantic_pipeline_smoke`,
  all six generic evidence fixtures, all 31 benchmark fixtures, all 47 offline
  checks, and `git diff --check`. Independent reviewer capacity remains
  exhausted; no independent approval is claimed.
- Baseline product/evaluated and the three shared harness blobs remain
  unchanged. The only permitted next three-row root is the initially absent
  `D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-cross-track-sprawl-v1-20260730`,
  using a fresh manifest, v3 proof, cache, output, and exact zero-based
  `4,9,10`. The 20-row root must remain absent until this three-row gate is
  exact and safe.
- The docs-only commit containing this checkpoint is the next candidate
  evaluated commit. Its exact SHA must be recorded by an immediate descendant
  docs-only binding record before private root creation. Candidate product
  `6cc09c9ef2603ac24e1a7c3928ce05f996c74214` must be its strict ancestor.

### Cross-track sprawl exact evaluated binding

- Candidate evaluated is exactly
  `615fe7fd5d0c1150017d0a1dcfd686eb67c894fb`. Candidate product
  `6cc09c9ef2603ac24e1a7c3928ce05f996c74214` is its strict ancestor.
- This immediate docs-only binding record does not replace candidate evaluated
  `615fe7fd5d0c1150017d0a1dcfd686eb67c894fb` in the manifest, v3 proof,
  temporary evaluation branch, or live verification.
- Baseline evaluated/product remain exactly
  `7b3375b29a8f63ce9cbeb587ef965e77aa3355d5` /
  `fb0168afce265cf351f03e80f66d9e0f24015887`.
