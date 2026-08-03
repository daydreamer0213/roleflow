# DeepSeek V4 Pro / Flash isolated model A/B design

## Status

Approved in conversation on 2026-08-03. This design authorizes an isolated
benchmark implementation and live model calls after an implementation plan is
separately reviewed. It does not authorize changing the production model
setting.

## Decision

Compare the currently configured `deepseek-v4-pro` with
`deepseek-v4-flash` under one frozen product commit, one prompt and scoring
implementation, one confirmed candidate profile and matching card, and one
frozen job fixture.

Use a staged run:

1. run three diagnostic jobs three times per model;
2. continue to one 20-job run per model only when the diagnostic gate passes;
3. inspect the confirmed Golang recommendation-error case separately as an
   adversarial diagnostic;
4. do not switch the saved default model automatically.

The selected product goal is quality non-inferiority: Flash must not reduce
recommendation quality and must also be materially faster and cheaper.

## Why a dedicated model-comparison path is required

The existing private full-chain comparator compares product commits. Its trust
boundary intentionally requires:

- different baseline and candidate product commits;
- the same bound model identity on both sides;
- profile, matching-card and match outputs to share that model identity.

Those invariants are correct for a code-change comparison but reject the
opposite shape needed here: one product commit and two different model
identities.

The generic live benchmark is also not enough. It can execute the configured
model but does not provide a strict two-model manifest, paired fixture
comparison, staged repetition gate or the private recall-first metrics needed
for this decision.

## Considered approaches

### A. Dedicated isolated model A/B runner

This is the selected approach.

- Read the verified production provider, endpoint, timeout and API key through
  the existing read-only model-settings gate.
- Permit only an in-memory model-name override between the two explicitly
  approved DeepSeek model IDs.
- Keep the saved runtime settings unchanged.
- Bind both sides to the same product commit, prompt implementation, frozen
  inputs and pricing snapshot.
- Write new SQLite caches and immutable results below the private benchmark
  root.

This approach isolates the variable being tested and gives the strongest
audit trail without touching operational state.

### B. Temporarily switch the saved project model

This avoids a dedicated override but repeatedly mutates the user's current
settings, changes the verified settings fingerprint and still cannot satisfy
the existing code-comparison identity gates. Recovery after an interruption
would also be less clear. This approach is rejected.

### C. Regenerate the candidate profile and matching card with each model

This measures a broader end-to-end model experience, but it changes several
inputs at once and would require separate human confirmation of both generated
artifacts. It would not isolate job recommendation behavior. This approach is
deferred to a future experiment.

## Scope

### In scope

- A new experimental model A/B execution and comparison path.
- Offline tests for its authorization, identity, privacy and acceptance gates.
- Live calls to the two approved model IDs after the implementation plan is
  approved.
- Sanitized latency, structure, decision and token-count telemetry.
- A private disagreement report and a non-sensitive summary.

### Out of scope

- Changing `.runtime/settings/model.json` or its encrypted secret.
- Accessing BOSS, browser cookies, the dashboard on port 8787 or an operational
  jobs database.
- Reusing pre-baseline job history as accuracy evidence.
- Changing prompts, matching rules, scoring, selectors, timing or production
  recommendation behavior.
- Treating the Golang case as a blacklist or a title-based production rule.
- Automatically switching the default model after the benchmark.

## Execution identity and authorization

The experiment adds a distinct manifest version rather than weakening the
existing full-chain manifest. The manifest binds:

- the clean product commit;
- the A/B harness code hash;
- the complete sanitized identities of Pro and Flash;
- the confirmed profile and matching-card hashes;
- the frozen job-set and label hashes;
- diagnostic indices and repetition count;
- the pricing snapshot and its source date;
- the expected output directory.

Live execution requires an explicit per-command authorization environment
value. The runner must fail closed when:

- the worktree is dirty or the declared commit differs from `HEAD`;
- the saved model configuration is not verified and readable;
- the provider or endpoint is not the current official DeepSeek configuration;
- either model name is outside the approved Pro/Flash pair;
- any bound input hash differs;
- an output path already exists;
- output would be written outside
  `D:\DevData\RoleFlow-private-benchmark`.

The runner reads the API key into process memory through
`resolveRuntimeModelConfig`. It must not copy, print or persist the key,
endpoint, private resume, JD, company, title, URL or model response text.

## Frozen inputs

Both sides use:

- the same confirmed private candidate profile;
- the same confirmed matching card;
- the same frozen real-JD job set and labels;
- the same product code and deterministic local scoring;
- a fresh empty model-analysis SQLite cache per model and repetition.

The profile and card retain their original provenance hashes. The experiment
records them as fixed evaluation inputs, not as outputs attributed to either
target model. This exception exists only in the new model-comparison manifest;
the production and code-comparison provenance checks remain unchanged.

No saved model result or SQLite cache may be shared between Pro and Flash or
between repetitions.

## Stage 1: repeated three-job diagnostic

Use the three opaque fixture indices already selected by the existing
matching-stability experiment: `5,8,13`. They have known model-variance
evidence and established expected communication behavior.

Each model evaluates all three jobs three times:

- 3 jobs × 3 repetitions × 2 models = 18 job evaluations;
- all work is serial;
- the model order alternates by repetition: Pro/Flash, Flash/Pro, Pro/Flash;
- each job follows the unchanged production analysis pipeline;
- standard production transport retry and contract-repair behavior remains
  part of the measured result.

The diagnostic stage passes only when:

- all 18 evaluations reach a structurally usable product decision;
- there are no failed, stale, pending or partial results;
- there are no false hard exclusions;
- every repetition respects the confirmed expected disposition;
- the known keep/outside-default-communication behavior of the selected
  indices remains intact;
- no repeated input produces a structurally incompatible result;
- neither model leaks private text into the sanitized result.

Any failure stops the experiment before the 20-job run. Results are preserved
for diagnosis and are not silently retried as a new accepted repetition.

## Stage 2: formal 20-job comparison

After Stage 1 passes, run the complete 20-job user-confirmed recall-first
fixture once per model. Both sides must complete all 20 rows for a formal model
decision.

The current fixture contains 20 confirmed `keep` dispositions and no confirmed
`exclude` disposition. Therefore it can measure:

- opportunity retention;
- false hard exclusions;
- structural and evidence coverage;
- bucket, role-alignment and hard-blocker disagreements;
- latency, retry, repair and token differences.

It cannot independently prove real-JD obvious-exclusion precision. The final
report must state this limitation rather than calling the result a complete
precision measurement.

Empty-response overlap may be reported diagnostically, but incomplete coverage
cannot pass the formal decision gate.

## Golang recommendation-error diagnostic

Read the existing confirmed private case
`REC-20260803-001-golang-ai-backend` from the recommendation casebook.

The case is not part of the 20-row accuracy denominator. It is a separate
adversarial review because:

- it was collected after a human-confirmed recommendation error;
- the casebook is not currently a balanced or independently labeled
  evaluation fixture;
- promoting one real error directly into a production rule would overfit.

When the stored snapshot contains all required frozen inputs, run it once per
model through the same isolated path. Compare:

- selected role direction;
- responsibility and requirement states;
- resume-evidence coverage;
- hard blockers;
- final recommendation bucket.

Flash must not produce a more aggressive false-positive recommendation than
Pro. Correctly downgrading the known error is reported as improvement, but
failure to improve it does not by itself prove regression if the formal gates
otherwise pass. If the snapshot is not directly runnable, perform only a
read-only offline diagnosis and record the missing fields; do not reconstruct
private evidence from BOSS.

## Measurements

For every job evaluation, store only sanitized metadata:

- opaque fixture ID;
- model-side identifier;
- repetition number;
- input and output hashes;
- analysis elapsed time;
- model-call count and cumulative model-call latency;
- per-stage latency;
- attempt, empty-response and contract-repair counts;
- input, output and total token counts when returned by the provider;
- semantic status, decision state, bucket and hard-blocker boolean;
- role-alignment enum and evidence counts;
- expected disposition and pass/fail.

The comparison report includes:

- opportunity retention and false hard exclusions;
- failed, stale, pending and partial totals;
- bucket, hard-blocker, role-alignment and evidence-count disagreements;
- median and p95 analysis latency per model;
- total wall-clock and model-call latency;
- retry and contract-repair totals;
- token totals and estimated cost;
- diagnostic stability across repetitions;
- Golang case outcome;
- full-coverage and acceptance status.

Private disagreement details stay under the private benchmark root. Console
and repository reports use counts and opaque IDs only.

## Cost calculation

Freeze the official DeepSeek prices observed at run preparation time in the
private manifest, including source URL and UTC timestamp. Do not fetch pricing
during a model call.

The currently documented prices are:

| Model | Cache-miss input / 1M tokens | Output / 1M tokens |
| --- | ---: | ---: |
| `deepseek-v4-pro` | $0.435 | $0.87 |
| `deepseek-v4-flash` | $0.14 | $0.28 |

Source:
<https://api-docs.deepseek.com/quick_start/pricing/>

When provider telemetry does not expose a trustworthy cache-hit split, use all
input tokens at the cache-miss rate. Label this as a conservative estimated
upper bound, not an invoiced amount.

## Acceptance policy

Flash is eligible to replace Pro only when all of the following hold:

### Quality

- Stage 1 passes in full.
- Stage 2 has 20/20 usable results on both sides.
- Flash retains all 20 confirmed opportunities.
- Flash introduces no false hard exclusion.
- Flash has no additional failed, stale, pending, partial or contract-invalid
  result.
- Manual review of every disagreement finds no systematic loss of role
  direction, indispensable requirement handling or resume evidence.
- The Golang diagnostic does not become a more aggressive false positive.

### Performance

- Flash median analysis latency is at least 20% lower than Pro on Stage 2.
- A smaller improvement is reported as performance-inconclusive rather than a
  pass.
- p95, retry and repair counts are reported as guardrails even when median
  latency passes.

### Cost

- Flash's conservative estimated Stage 2 cost is at least 50% lower than Pro.
- Missing token telemetry makes the cost gate inconclusive; it must not be
  guessed from character counts.

Possible final statuses:

- `flash_eligible`: all quality, performance and cost gates pass;
- `quality_regression`: any quality gate fails;
- `performance_inconclusive`: quality passes but speed gain is below 20%;
- `cost_target_missed`: quality and speed pass but measured cost reduction is
  below 50%;
- `cost_inconclusive`: quality and speed pass but cost cannot be verified;
- `run_incomplete`: coverage, authorization or structural execution is
  incomplete.

No status changes the saved default model. A separate explicit user
confirmation is required for that change.

## Failure and interruption handling

- Run models and jobs serially.
- Stop immediately on authentication, quota, rate-limit or repeated provider
  failure.
- Preserve completed immutable outputs and identify the exact stopped stage.
- Do not count an interrupted run as accepted.
- Resume only into new output files with an explicit manifest-bound resume
  operation; never overwrite a completed result.
- Do not delete prior benchmark directories or casebook material.

## Implementation shape

Prefer a small dedicated script and shared pure metric helpers over adding
model-mismatch exceptions to `comparePrivateFullChainResults`.

Expected components:

1. a model A/B runner under `scripts/`;
2. pure validation, aggregation and comparison helpers;
3. offline smoke tests for all gates;
4. a manifest initializer and live execution modes;
5. sanitized JSON and Markdown reports under the private root.

Reuse the existing production analysis pipeline, private fixture readers,
privacy validators and telemetry concepts where safe. Do not alter production
prompting or decision logic.

## Test design

Add failing offline tests before implementation for:

1. exact approved Pro/Flash pair accepted;
2. a third model rejected;
3. unverified settings or unreadable secret rejected;
4. dirty or mismatched product commit rejected;
5. changed profile, card, job-set, label or harness hash rejected;
6. output outside the private root rejected;
7. existing output rejected without overwrite;
8. model override remains in memory and never writes runtime settings;
9. private text and API key never enter sanitized outputs;
10. caches are unique per side and repetition;
11. alternating serial diagnostic schedule is deterministic;
12. any diagnostic structural or quality failure blocks Stage 2;
13. incomplete 20-row coverage cannot pass;
14. a new false hard exclusion fails quality;
15. latency improvement below 20% is inconclusive;
16. cost reduction below 50% fails the cost gate;
17. missing token telemetry is cost-inconclusive;
18. the conservative cache-miss cost calculation is correct;
19. Golang diagnostic is excluded from the formal denominator;
20. production full-chain comparison behavior remains unchanged.

Run the targeted tests, the complete offline suite and a secret-pattern scan
before any live model call.

## Delivery

After implementation and offline verification:

1. initialize a new private A/B run directory;
2. show the sanitized manifest and intended call counts;
3. execute Stage 1;
4. report its gate result;
5. execute Stage 2 only if Stage 1 passed;
6. run or diagnose the Golang case without changing its casebook status;
7. deliver a concise recommendation with limitations;
8. ask separately before changing the saved default model.
