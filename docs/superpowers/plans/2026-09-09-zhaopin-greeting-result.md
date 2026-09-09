# Zhaopin Greeting Result Implementation Plan

**Goal:** Recognize the actual dedicated greeting-success modal without weakening the existing network and job-identity checks.

**Architecture:** Extend the existing communication snapshot selector and read the dedicated title for that modal only. No new fallback workflow or external action.

**Tech Stack:** Existing CommonJS, Playwright fixture and fake browser.

## Global Constraints

- Existing isolated `D:/DevData/RoleFlow-worktrees/zhaopin-readonly`, branch `codex/zhaopin-readonly`, base32891a7. Do not reopen closed tasks.
- No true greeting/reply/resume/application, foreground operation, source-data reset, quota change or new dependency.
- Preserve network/time/identity/pending-request checks and no dispatch retry.
- User authorized push after verification only; no merge, release, packaging or version change.

## Task 1: Recognize the observed modal

Files: `src/adapters/sites/zhaopin_communication.js`, `tests/fixtures/zhaopin/communication.html`, `tests/zhaopin_communication_adapter_smoke.js`.

- [ ] Replace the synthetic title-only modal with the observed root/title/content/footer structure, retaining synthetic content and hidden state. Keep `fixture.modal()` and `reset()` behavior.

```html
<div class="deliver-greeting-modal" hidden>
  <h3 class="deliver-greeting-modal__title">已向对方发送打招呼语</h3>
  <p class="deliver-greeting-modal__content-text">合成招呼正文</p>
  <button type="button">留在此页</button><button type="button">继续沟通</button>
</div>
```

- [ ] Run existing `zhaopin_communication_adapter_smoke.js`; record actual RED at the real adapter's expected succeeded result (not setup failure).
- [ ] Add `.deliver-greeting-modal` to the existing snapshot candidates. For that specific root compare the dedicated title; other candidates retain the existing entire-text behavior.

```js
const label = node.matches('.deliver-greeting-modal')
  ? node.querySelector('.deliver-greeting-modal__title')?.textContent
  : node.textContent;
```

- [ ] Add table-driven accepted-network negative cases for hidden modal, wrong title, missing title and duplicate visible success roots; expect ambiguous and exactly one simulated dispatch, no application. Existing stale-modal and network/identity cases remain.
- [ ] Run syntax, adapter, readonly, dashboard communication and communication storage smokes with existing NODE_PATH; TEMP/TMP stay onD. Record GREEN and commit implementation.
- [ ] Arrange one bounded independent read-only review of this diff, resolve important findings; do not audit the earlier branch again.
- [ ] Freeze final source, run fresh complete offline gate, update authority docs and push the same branch. Verify remote SHA equals local; do not merge/release. State that post-fix real sending was not repeated.
