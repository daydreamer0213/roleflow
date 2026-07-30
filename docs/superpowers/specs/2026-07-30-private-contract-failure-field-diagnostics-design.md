# Private Contract-Failure Field Diagnostics Design

**Date:** 2026-07-30

## Context

The first fresh three-row live diagnostic completed with a trustworthy native
exit code and preserved all three logical rows. Frozen index `4` failed during
`matchJob` after one contract-repair attempt:

- `errorCode = MODEL_CONTRACT_INVALID`;
- `failureStage = matchJob`;
- `failurePhase = contract_repair`;
- `actualBucket = analysis_pending`;
- no selected track, role summary, or complete evidence was produced.

Indices `9` and `10` completed structurally, but the acceptance plan requires
stopping at the first failed row. The 20-row run therefore remains prohibited.

The existing private runner deliberately drops model error text. That protects
private data, but it also drops the fixed contract field name needed to
distinguish a prompt-shape failure from a validator defect. The failed live root
must remain unchanged and must not be rerun.

## Goal

Add the smallest private-runner-only diagnostic that identifies the contract
field category for the initial validation failure and the failed repair without
persisting or printing model text, prompt text, JD text, resume text, arbitrary
object keys, provider metadata, or configuration.

This change is acceptance tooling only. It must not change matching behavior,
model prompts, model settings, model calls, retry counts, product code, or
product commits.

## Considered Approaches

### 1. Fixed allowlist categories in the private telemetry collector

Map the existing in-memory contract error message to a closed enum, discard the
message, and emit only the enum in the private result row.

This is the selected approach. It reuses the current logger boundary, requires
no provider or product changes, and makes privacy testable.

### 2. Preserve a hash or raw contract error

A hash is not actionable without an external lookup. Raw error text can contain
model-provided values and would expand the private-output threat surface.

Rejected.

### 3. Guess a prompt or validator fix from `MODEL_CONTRACT_INVALID`

The current signal cannot identify which side is wrong. A guessed fix could
weaken validation or hide a real model failure.

Rejected.

## Design

### Closed diagnostic enum

Add a private-runner helper that returns exactly one of:

- `selected_track`;
- `role_alignment`;
- `role_resume_evidence`;
- `role_gaps`;
- `requirement_matches`;
- `eligibility`;
- `unknown_keys`;
- `result_shape`;
- `other`;
- `none`.

The helper may inspect an in-memory error message only for literal,
implementation-owned contract tokens. It must never return a substring from the
message. Unknown or ambiguous text maps to `other`; an absent failure maps to
`none`.

### Telemetry flow

The existing private telemetry collector will:

1. On `model_contract_repair_requested`, increment the existing repair count and
   store the allowlisted initial category.
2. On `model_contract_repair_failed`, store allowlisted initial and repair
   categories.
3. On reset, clear both categories to `none`.
4. On snapshot, return only the two enum values with the existing safe numeric
   telemetry.

The private result row will add:

- `initialContractFailureCategory`;
- `repairContractFailureCategory`.

Normal rows must contain `none` for both fields. A repair success may contain an
initial category and `none` for the repair category.

### Privacy boundary

The implementation must not persist or expose:

- `errorMessage` or `initialErrorMessage`;
- `outputShape` or arbitrary model-generated keys;
- invalid or repaired model output;
- prompt, JD, resume, identity, title, company, URL, provider, model, base URL,
  API key, or model configuration;
- any new log file.

Tests must include a deliberately sensitive fake error message and prove that
neither the sensitive marker nor the original message appears in the result.

### Compatibility

The new fields are additive private telemetry. Existing v1/v2/v3 fixture,
manifest, proof, comparison, and acceptance semantics remain unchanged. The
candidate and baseline copies of `scripts/private-full-chain-runner.js` must
remain byte-identical after the mechanical mirror.

Candidate product commit remains
`87cc68ede886ac0ef3b53f960c38548cce4a831a`. Baseline product commit remains
`fb0168afce265cf351f03e80f66d9e0f24015887`.

## Test-First Implementation

Add one focused regression to `tests/private_full_chain_runner_smoke.js` before
changing the runner. The red test must prove:

- initial and repair events become the expected allowlisted categories;
- unknown text becomes `other`;
- reset prevents one row's failure from leaking into the next row;
- normal rows report `none`;
- fake sensitive message text and arbitrary output-shape keys are absent.

Run the focused smoke test and confirm it fails because the two fields do not
exist. Then implement the minimum collector and row changes, rerun the focused
test, run the 31-fixture benchmark, and run the full offline suite.

After candidate verification, mechanically mirror only
`scripts/private-full-chain-runner.js` to the baseline worktree, run the
baseline offline checks, commit both evaluated checkpoints, verify the three
shared Git blobs, update the two execution plans, obtain independent review,
and push the continuation checkpoint.

## Live Diagnostic Boundary

Preserve this failed root unchanged:

`D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-v3-live-run-20260730`

After the reviewed tooling checkpoint, create a new private root:

`D:\DevData\RoleFlow-private-benchmark\multi-track-recall-index-4-contract-diagnostic-v1-20260730`

Use the same frozen pool, v1 confirmed evidence, v3 portability proof, formal
runner gate, and a new empty cache. Run only zero-based diagnostic index `4`.
Do not run indices `9`, `10`, or the 20-row acceptance during this diagnostic.

The result is diagnostic evidence, not acceptance. Use the two safe categories
to determine whether the next root-cause change belongs in the prompt, contract
validator, or neither. Restore the fixed candidate worktree immediately after
the one-row result is inspected.

## Success Criteria

- Focused red-green evidence exists.
- All candidate and baseline offline checks pass.
- Candidate and baseline runner blobs are identical.
- Independent review reports no Critical, Important, or Moderate finding.
- The one-row result exposes both fixed categories without private text.
- The failed three-row root remains unchanged.
- The 20-row root remains absent.
## 2026-07-30 Reason-Code Extension

The first reviewed category-only diagnostic reproduced index `4` with both
categories equal to `other`. That proves the failure is not safely attributable
to one field category, but it still combines several validator-owned outcomes.
The category diagnostic root must remain unchanged:

`D:\DevData\RoleFlow-private-benchmark\multi-track-recall-index-4-contract-diagnostic-v1-20260730`

Extend the same private telemetry boundary with two additional closed-enum
fields:

- `initialContractFailureReason`;
- `repairContractFailureReason`.

Allowed reasons are:

- `selected_track`;
- `context_shape`;
- `role_alignment_enum`;
- `responsibility_requires_insufficient`;
- `aligned_requires_role_resume`;
- `misaligned_requires_evidence_triplet`;
- `insufficient_requires_gap`;
- `matches_shape`;
- `matches_unknown_id`;
- `matches_duplicate_id`;
- `matches_state`;
- `matches_resume_evidence`;
- `eligibility_shape`;
- `eligibility_unknown_id`;
- `eligibility_duplicate_id`;
- `eligibility_state`;
- `eligibility_resume_evidence`;
- `other`;
- `none`.

The classifier may match only literal templates owned by
`src/core/model_contract.js`. It must not return message fragments, IDs,
requirement names, evidence, arbitrary keys, or captures. An absent error maps
to `none`; an unknown or ambiguous template maps to `other`.

Tests must cover repair success, repair failure, unknown text, row reset, exact
schema, and the existing sensitive marker. The new live root is:

`D:\DevData\RoleFlow-private-benchmark\multi-track-recall-index-4-contract-reason-v1-20260730`

Run only zero-based index `4` with a new cache after candidate/baseline review
and synchronization. Inspect only the two categories, two reasons, and existing
safe status fields. The result remains diagnostic evidence rather than
acceptance.

## 2026-07-30 顶层非对象原因码扩展

### 证据与边界

- reason v3 单条诊断可信退出 0，但 initial/repair category 与 reason 均为 `other`；未读取或持久化原始错误、模型输出或 `outputShape`。
- 静态源码对照显示，已知字段级错误都会命中 category，context 错误也已有 reason；`validateModelResult` 的顶层 `必须返回 JSON 对象` 规则同时漏过现有 category/reason classifier。故当前只将其视为高置信“诊断分类器缺口”，尚不宣称产品根因。

### 安全扩展

- 在 `SAFE_CONTRACT_FAILURE_REASONS` 增加唯一闭合值 `result_not_object`。
- 仅当错误消息匹配 validator 自有静态模板 `必须返回 JSON 对象` 或等价固定英文 `must return a JSON object` 时，category 返回 `result_shape`、reason 返回 `result_not_object`。
- 不输出 raw message、regex capture、动态字段、对象 key、数组长度、模型内容或 `outputShape`；零命中/多命中继续返回 `other`。
- TDD 必须覆盖 requested+completed 流程：initial 精确归类为 `result_shape/result_not_object`，repair 保持 `none/none`；现有 failed-only、unknown、multi-template、reset 回归继续保留。
- 工具通过完整离线门禁与独立复审后，基线仍只机械镜像 runner；新的单条确认必须使用全新根，旧 v1/v2/v3 均 immutable。

### Supersede 条款

本增量明确 supersede 本文此前所有 reason v1 live/new-root 指令及实施计划旧 Step 6；这些旧条目只保留为历史记录，不得执行。reason v1、v2、v3 均为 immutable，唯一允许的下一诊断根是 reason v4。
