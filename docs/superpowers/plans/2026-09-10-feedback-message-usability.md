# Feedback and Message Usability Implementation Plan

**Goal:** Make message previews useful and connect verified cross-platform feedback to truthful, understandable statistics.

**Architecture:** Reuse existing progress events and strategy rounds. Keep diagnostic conditional rates, expose common-denominator positive counts, and present untracked inbound opportunities separately. Render previews from existing display-only message context.

**Tech Stack:** Existing CommonJS, SQLite, server-rendered HTML/CSS, Node assertion smokes and local browser.

## Constraints

Existing worktree/branch, base80998f0. No external messaging, new dependencies, new tables, raw-message learning memory, merge, release or version change. 48-hour/weekend maturity and30/50/70 thresholds stay. New statistics require existing verified job/profile/plan/event identity. Historical feedback stays with its original strategy interval.

## Task 1: Connect feedback and explain the denominator

Files: `src/storage/funnel_store.js`, `src/core/candidate_progress.js`, `src/application/funnel_analysis/index.js`, `src/dashboard/pages/funnel.js`; tests `zhaopin_communication_storage_smoke.js`, `dashboard_funnel_smoke.js`, focused cross-platform integration smoke if needed.

- [ ] Reproduce missing entry after fake-browser verified Zhaopin success: assert exactly one `candidate_funnel_entries` row, correct card/plan,48-hour maturity. Verify old code fails.
- [ ] Test actual dashboard service:3 trusted inbound resume requests without applications remain visible in inbound feedback while no false funnel entry is created; duplicates/profile/plan separation preserved.
- [ ] Test recovery from a missing historical verified entry after strategy switch: restore original round once; unrelated/pending/ambiguous/copy-only rows remain excluded. Test transaction rollback on entry-write failure.
- [ ] Allow only verified Zhaopin contact-start events into existing entry path; sync missing entries on local funnel refresh using event/batch/item ownership and original round time bounds.
- [ ] Add untracked inbound counts from progress events scoped to candidate/plan and exact platform ownership; no raw message strings in the read model.
- [ ] Render main feedback shares over mature total with positive counts, specific missing-observation copy and separate conditional-rate detail. Keep the30/50/70 diagnostic policy.
- [ ] Run funnel/strategy/maturity/communication and dashboard focused regressions.

## Task 2: Make message and job records readable

Files: `src/dashboard/message_discovery_view.js`, `src/dashboard/server.js`; tests `dashboard_message_discovery_smoke.js`, existing compact jobs/dashboard checks.

- [ ] Add real renderer assertions: same broad intent with different HR questions yields different visible previews, resume request remains visible, HTML escapes, saved safe summary remains unchanged.
- [ ] Build short preview from existing validated inbound display text plus explicit resume request; use existing generic summary only when original content is unavailable. Reuse it for the communication conclusion when appropriate.
- [ ] Display internal message-discovery keyword as“消息发现”in job record metadata and keyword presentation; retain normal keywords and internal source data.
- [ ] Run focused message UI/contract/jobs regressions and syntax/diff checks.

## Task 3: User-flow acceptance and handoff

- [ ] One bounded independent correctness review of this new diff only.
- [ ] Commit frozen implementation, run fresh full offline gate, fix actual failures if any.
- [ ] Update isolated local service only after verifying no active job, preserve current records, load messages→job records→funnel in background local browser. Verify specific preview,3 resume opportunities, verified communication waiting sample and explicit denominator visually.
- [ ] Record what is proven versus remaining true platform acceptance, update authority docs/checkboxes, verify code unchanged after doc closure and save current branch per standing authorization. No merge/release.
