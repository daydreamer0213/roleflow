# Broad requirement direct-instance classification design

## Status

Proposed from the immutable validation-idempotence v1 three-row evidence on
2026-07-30.

## Confirmed failure

The fresh run at
`D:\DevData\RoleFlow-private-benchmark\multi-track-recall-first-3-validation-idempotence-v1-20260730`
completed without contract, structure, empty-response, hard-block, or evidence
failures. The double-validation defect is fixed.

Zero-based index `4` selected `T1`, was `mostly_aligned`, had complete
foundation evidence, and matched every central requirement. Its only
decision-important downgrade was one non-central requirement marked
`transferable`; this produced `caution/talk` instead of the confirmed
`apply/primary`. Two non-core missing rows did not cause the downgrade.

The frozen expected label establishes this as a false caution, but no private
requirement or resume text is recorded here.

## Constraints

- Do not promote every transferable requirement to matched.
- Keep existing cross-domain, named-platform, named-tool, and different-work
  examples at caution when only transferable evidence exists.
- Do not change local recommendation thresholds, hard blockers, validators,
  model-call count, or thinking policy.
- Do not add private examples or job-specific keywords to Git.
- Invalidate old match caches after a prompt change.

## Options

### Ignore a non-central transferable requirement locally

This would make the observed row apply, but it would also allow an explicitly
indispensable cross-domain or named-platform gap to bypass caution. Reject.

### Hard-code the observed requirement or candidate technology

This would overfit private evidence and leak the benchmark. Reject.

### Strengthen the general direct-instance boundary

This is the recommended option.

Add one compact rule to the match prompt:

- when a requirement is a broad capability and does not itself require a
  named domain, platform, tool, or specialist workflow, a narrower concrete
  candidate example of that same capability is `matched`, not `transferable`;
- use `transferable` when the candidate proves the underlying capability but
  the requirement explicitly names a different or unproven domain, platform,
  tool, specialist workflow, work object, action, or deliverable.

This reinforces the existing asymmetric rule without changing local policy.
Increment the match pipeline from v29 to v30.

## Acceptance

- A prompt assertion first fails because the broad-requirement rule is absent.
- The prompt contains both the direct-instance positive rule and the named
  domain/platform/tool/specialist negative boundary.
- No private requirement, resume phrase, job title, company, or technology is
  added.
- `PIPELINE_VERSIONS.matchJob` is exactly `match-decision-v30`; v29 analyses
  become `match_pipeline_changed`.
- Existing generic transferable and caution fixtures remain green.
- Model adapter, semantic pipeline, 31 benchmark fixtures, all offline checks,
  and diff check pass.
- A new private three-row root is required; every older root remains immutable
  and the 20-row root remains absent.
