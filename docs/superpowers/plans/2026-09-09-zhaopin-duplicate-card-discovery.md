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

- [ ] Step 1: Behavioral RED before product edits. Use actual scan with fake browser representing duplicate same-ID/index0 and laterindex2, same remainder signature, both active -> selectedIndex0. Include another unique job after duplicate and a target requiring that unique job. Old scan should throw identity error or fail the final unique-job outcome, not merely a version/source assertion. Record actual command, failing assertion/code and exit. Synthetic fixtures only.
- [ ] Step 2: Minimal implementation. A visit key may remove exactly the `${card.index}|` prefix when a reliable sourceId exists and the signature really starts with it; retain all remaining content. Otherwise use the untouched signature. Use the same key in find and seen.add; retain after-checkpoint timing/per-target scope. Do not edit activeIndex matching or detailMatches. Identical duplicates skip with no new detail access/click; unique target count unchanged.
- [ ] Step 3: Focused GREEN. Cover duplicate skip + next unique job + physical access/checkpoint counts; different IDs/same title and same ID/changed content are not skipped; unknown ID/format falls back; next keyword still revalidates. Do not add speculative tests or change production behavior to satisfy fake shape. Run zhaopin_workflow_smoke, zhaopin_readonly_smoke, zhaopin_communication_adapter_smoke, workflow_scan_analysis_smoke; node --check src/adapters/sites/zhaopin.js; git diff --check. Do not run npm test (main owns it).
- [ ] Step 4: Self-review and commit only owned files. Write full report with actual RED/GREEN, limits, unchanged contracts and concerns; return brief status/SHA/tests/report path.

Environment: NODE_PATH=C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules; ROLEFLOW_REQUIRE_PLAYWRIGHT=1; TEMP=TMP=D:/DevData/RoleFlow-tests; Node=D:/hermes/node/node.exe. Do not install dependencies.

## Main continuation

- [ ] Scoped review only this task; resolve findings without reopening previous reviews.
- [ ] Freeze clean SHA and new strict full gate; restart only owned8788 isolated service; normal UI resume same original run/batch without reducing targets.
- [ ] Continue real scan/analysis and existing bounded initial-greeting/messages/drafts acceptance; no reply send. Record current evidence and remaining limitations; no push/merge/release.
