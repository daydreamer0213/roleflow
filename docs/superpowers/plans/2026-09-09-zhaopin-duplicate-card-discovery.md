# 智联同目标重复卡片去重 Implementation Plan

> REQUIRED: superpowers:subagent-driven-development. One small implementation and scoped spec/quality review; closed historical tasks are not reopened. User approved autonomous continuation.

**Goal:** 本目标内重复卡片不再造成错误中断，唯一岗位覆盖不减少。
**Architecture:** Only normalize the scan-local seen key from the existing exact signature for reliable IDs; keep all detail-reader/helper/communication contracts unchanged.
**Tech:** Existing Node/CommonJS, fake browser and fixture tests. No dependency.

## Global Constraints

- Work only in D:/DevData/RoleFlow-worktrees/zhaopin-readonly, branch codex/zhaopin-readonly; preserve others' edits.
- Background only; no real browser/site/service/database/model access by workers, no focus/screenshot/viewport/refresh/private API or external communication/application.
- Keep full JD coverage/quality, same-card identity/signature guards, scan-only one empty-detail retry, 120000ms loading budget, pacing/cooldowns, physical access accounting and checkpoints.
- Dedup only after successful current-target read/checkpoint, with reliable sourceId and otherwise identical whole signature except current index prefix; unknown IDs or unexpected signature shape retain the old exact-signature behavior.
- Do not dedup changed card content, distinct IDs, across keyword targets, across scan invocations or from historical cache. Duplicate cards must not consume the unique-job target; continue discovering unique jobs.
- Reuse existing seen Set and tests. No helper/protocol/UI/communication change, new dependencies, generic cache/retry framework, version change, push, merge, package, release or cleanup deletion.
- Main alone owns real acceptance/service/final full gate; worker runs only focused offline regressions with temporary files on D:.

### Task 1: Normalize scan-local visited identity for verified duplicates

**Owned files:** src/adapters/sites/zhaopin.js (scan-local seen-key only and a small pure helper if necessary); tests/zhaopin_workflow_smoke.js; optional minimal duplicate fixture proof in tests/zhaopin_readonly_smoke.js. Other files need concrete reason reported to main. You are not alone; preserve main docs and prior implementation.

**Binding Global Constraints (verbatim):**

- Work only in D:/DevData/RoleFlow-worktrees/zhaopin-readonly, branch codex/zhaopin-readonly; preserve others' edits.
- Background only; no real browser/site/service/database/model access by workers, no focus/screenshot/viewport/refresh/private API or external communication/application.
- Keep full JD coverage/quality, same-card identity/signature guards, scan-only one empty-detail retry, 120000ms loading budget, pacing/cooldowns, physical access accounting and checkpoints.
- Dedup only after successful current-target read/checkpoint, with reliable sourceId and otherwise identical whole signature except current index prefix; unknown IDs or unexpected signature shape retain the old exact-signature behavior.
- Do not dedup changed card content, distinct IDs, across keyword targets, across scan invocations or from historical cache. Duplicate cards must not consume the unique-job target; continue discovering unique jobs.
- Reuse existing seen Set and tests. No helper/protocol/UI/communication change, new dependencies, generic cache/retry framework, version change, push, merge, package, release or cleanup deletion.
- Main alone owns real acceptance/service/final full gate; worker runs only focused offline regressions with temporary files on D:.

**Observed contract:** helper returns first selectedIndex; native ZL may mark multiple same-ID cards active. Existing signature is `[index, rawSourceId, title, salary, company, location, fullText].join('|')`. sourceId is exposed only after component number/name/company agrees with public fields. Existing seen is reset within each target; seen.add occurs after saved detail/progress/results callbacks. Keep these points.

- [x] Step 1: Behavioral RED before product edits. Actual scan failed the expected three-unique-job outcome (only two returned after consuming detail budget on a duplicate), exit1, not a version/source assertion. Synthetic fixtures only; full command/output in task report.
- [x] Step 2: Minimal implementation. A visit key removes exactly the `${card.index}|` prefix when a reliable sourceId exists and the signature really starts with it; all remaining content stays. Otherwise untouched signature. Same key in find/add, after-checkpoint timing and per-target scope retained. ActiveIndex/detailMatches unchanged. Duplicate has no new detail access/click; unique target count unchanged.
- [x] Step 3: Focused GREEN. Duplicate skip/next unique/physical and checkpoint counts, changed/different/unknown ID and signature, and next-keyword revalidation covered. zhaopin_workflow_smoke, zhaopin_readonly_smoke, zhaopin_communication_adapter_smoke, workflow_scan_analysis_smoke, syntax and diff all exit0. No worker full suite.
- [x] Step 4: Self-review and commit only owned files. `153272bd41e0a3b455daaa934b42ff51e4e40e68`; full RED/GREEN report retained in this plan's SDD workspace.

Environment: NODE_PATH=C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules; ROLEFLOW_REQUIRE_PLAYWRIGHT=1; TEMP=TMP=D:/DevData/RoleFlow-tests; Node=D:/hermes/node/node.exe. Do not install dependencies.

## Main continuation

- [x] Scoped review only this task; `153272b` Spec compliant/Approved, no Critical/Important/Minor. Previous reviews remain closed; live/service/new full gate remain main-owned.
- [x] Frozen clean `1f6a8dd4c9ff43e48cdbe8f80c1fb70a17976df4` strict157/157 passed, exit0/start=end/clean; restarted only owned8788 and resumed the same original run/batch through ordinary UI. Advanced92 to94 jobs before a separate city-only location mismatch; duplicate task remains closed, new task `2026-09-09-zhaopin-city-only-location`.
- [ ] Continue real scan/analysis and existing bounded initial-greeting/messages/drafts acceptance; no reply send. Record current evidence and remaining limitations; no push/merge/release.
