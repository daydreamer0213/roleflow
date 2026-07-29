# DeepSeek Adaptive Match Thinking Design

## Problem

Disabling DeepSeek thinking for every `matchJob` request greatly reduced
latency in a fresh three-job diagnostic, but one complex job failed the model
contract even after the existing repair request:

- job index 0 completed `matchJob` in 10.3 seconds and preserved the previously
  reviewed `misaligned` / `unproven` / `backup` decision;
- job index 10 spent 14.9 seconds across its initial match and repair, then
  failed with `MODEL_CONTRACT_INVALID`;
- job index 14 completed `matchJob` in 8.3 seconds with complete evidence and a
  conservative `caution` / `talk` decision.

The current default-thinking evidence is much slower and variable: successful
matching calls took 43-116 seconds, and a failed pair of attempts took about
120 seconds. Always disabling thinking is therefore fast but not reliable
enough; always keeping thinking is too slow for the normal path.

## Decision

Use adaptive thinking for official DeepSeek V4 matching:

1. The initial `matchJob` request sends
   `thinking: {type: "disabled"}`.
2. If and only if model-contract validation rejects that result, the existing
   `contractRepair` request does not send `thinking: {type: "disabled"}` and
   therefore uses DeepSeek's default thinking mode.
3. Do not add another retry, another model call, a new timeout, or a new user
   setting.

The existing provider boundary remains unchanged: the behavior applies only to
`deepseek-v4-pro` or `deepseek-v4-flash` on the official
`api.deepseek.com` endpoint. Other models and custom endpoints receive no
DeepSeek-specific field.

`understandJob` keeps its already validated non-thinking behavior.

## What "Non-Compliant" Means

The existing model contract, not a new heuristic, decides whether repair is
needed. Examples include:

- invalid JSON shape, missing fields or wrong field types;
- missing, duplicated or invented requirement IDs;
- unsupported match states;
- evidence-bearing states without candidate evidence;
- hard blockers without the required structured evidence;
- recommendation, blocker, job-quality or confidence fields that contradict
  each other;
- incomplete responsibility, role-alignment or requirement coverage.

This gate detects structurally invalid or internally contradictory output. It
does not prove that a structurally valid judgment is semantically correct.

## Alternatives Rejected

1. **Always disable thinking and strengthen the prompt.** The existing repair
   prompt already named the invalid field, but the complex sample still failed.
   Prompt-only changes cannot guarantee semantic quality.
2. **Keep thinking enabled for every match.** This preserves the current
   behavior but retains 43-116 second successful calls and approximately
   120-second failures.
3. **Increase timeout or add retries.** Four of nine prior successes already
   required retry recovery. Longer waiting raises worst-case latency without
   addressing unnecessary reasoning on ordinary jobs.
4. **Build a new complexity classifier.** The contract failure itself is the
   narrowest reliable signal. A speculative classifier would add rules and
   failure modes before evidence shows they are needed.

## Implementation Scope

The production change is one request-body condition in
`src/adapters/models/openai_compatible.js`:

- official DeepSeek V4 initial `matchJob`: thinking disabled;
- official DeepSeek V4 `matchJob` with `contractRepair`: thinking omitted;
- all existing `understandJob` and non-DeepSeek behavior retained.

`tests/model_adapter_smoke.js` must prove these request bodies before the
production condition is changed. No new dependency, configuration field,
database migration or prompt schema is introduced.

## Validation Sequence

### Stage 1: Offline

Run the focused adapter smoke test and the complete offline suite. Acceptance
requires all existing checks to pass.

### Stage 2: Three-job real diagnostic

Use a fresh private bundle and the same frozen indices 0, 10 and 14.

Acceptance requires:

- all three rows complete;
- no `failed`, `pending` or `partial` row;
- index 10 is recovered by the thinking-enabled contract repair;
- no hard blocker is invented;
- completed rows retain JD and resume evidence;
- index 0 remains `misaligned` / `unproven` / `backup`.

If this stage fails, stop. Do not run 20 jobs.

### Stage 3: Twenty-job real acceptance

Run the hybrid candidate once on all 20 frozen jobs. Judge it on both
reliability and product quality:

- zero failed, pending or partial rows;
- zero false hard exclusions;
- no primary placement without evidence;
- every user-labelled `keep` row remains available for consideration: it must
  not become `skip`, `not_recommended` or hard-blocked;
- every user-labelled `exclude` row remains excluded as
  `skip` / `not_recommended`;
- recommendation and bucket changes are reviewed for over-strict or over-loose
  behavior;
- report total, median, slowest and stage-specific latency.

Exact recommendation/bucket equality is diagnostic, not the only acceptance
criterion. The product remains recall-first: a defensible `talk` or `backup`
placement is preferable to incorrectly excluding an opportunity.

## Baseline Reuse

Do not rerun the full slow baseline unless the overlap is insufficient.

The interrupted current-product default-thinking run has:

- 15 cached `understandJob` results;
- 9 cached successful `matchJob` results;
- no final result file.

Reconstruct only rows whose understanding and match results are both cached,
without model network calls. The offline reconstruction must verify every
required cache key before creating an analyzer and fail closed if any required
entry is missing. Compare those nine overlapping rows with the hybrid
candidate. Ignore unavailable baseline rows rather than treating them as empty
results.

All 20 hybrid rows are also compared with the user-confirmed frozen
keep/exclude labels. Older full-run product commits may be shown as historical
context but must not be presented as an exact code-isolated baseline.

## Acceptance Decision

Keep adaptive thinking only if:

1. the three-job diagnostic is fully successful;
2. the 20-job hybrid run has no incomplete model result or false hard
   exclusion;
3. the nine-row paired overlap shows no material quality regression;
4. manual review finds no systematic role-direction or evidence-quality loss;
5. the 20-row median `matchJob` latency is at most 30 seconds and at least 40%
   lower than the observed 57.4-second default-thinking median.

For the paired overlap, a regression means a previously complete row becomes
failed, pending or partial; a new hard blocker appears without stronger
evidence; or manual review finds a systematically worse role direction. Exact
recommendation and bucket equality is not required.

If any condition fails, revert the experimental match-thinking change and keep
the already validated `understandJob` optimization only.

## Safety and Privacy

- No BOSS or browser access is required.
- Formal model settings are used only through the existing authorized
  `--model-settings-root D:\Guo\ZhiPing` gate.
- Private resume, profile, card, JD and model-response bodies remain below
  `D:\DevData\RoleFlow-private-benchmark`.
- No private text, model response, credential or formal settings content may be
  committed or pushed.
- The main project database and the 8787 workbench remain untouched.
