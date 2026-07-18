# BOSS Communication Live Acceptance

## Current Status

- Calibration status: `pending`
- Execution enabled: `false`
- Real communication clicks completed: `0`
- Production communication CLI/dashboard execution: disabled

## 2026-07-18 Read-Only Evidence

One existing logged-in Edge session was inspected at low frequency. The test used one saved-style BOSS job URL and did not reload the page or click any communication/application action.

Observed standalone detail structure:

| Field | Observed selector or rule |
| --- | --- |
| URL | `/job_detail/<job-id>.html` |
| Header | `.job-primary.detail-box` |
| Recruiting status | `.job-status`, observed text `招聘中` |
| Job title | `.job-primary h1` |
| Salary | `.job-primary .salary` |
| Company | `.sider-company .company-info` |
| Ready action | `a.btn.btn-startchat`, exact text `立即沟通` |
| Recruiter activity | `.job-boss-info .boss-active-time` |

Safety evidence:

- Detail navigations: 1
- Reloads: 0
- Communication/application clicks: 0
- Risk-control signals: none
- Login-loss signals: none
- Parallel BOSS operations: none

### Merged Adapter Smoke Test

The merged production adapter was then exercised once against an existing logged-in Edge session. The run used the project's default randomized pacing and completed in 4,628 ms.

- Adapter result: `ready`
- Exact action label: `立即沟通`
- Salary and recruiter-activity fields: identified
- Browser operations: 1 detail navigation, 0 reloads, 0 clicks
- Tab topology: 2 tabs before and after the run
- Search tab: preserved with the same fixed tab ID
- Communication tab: reused with the same fixed tab ID
- Window identity: both tabs retained the same known `windowId`
- Risk-control or login-loss signals: none
- Database writes: none

### Already-Communicated State

One previously applied local record was inspected through the merged adapter with one additional standalone-detail navigation. The adapter failed closed as `action_unavailable`; a follow-up read-only DOM inspection established the missing semantic state.

- Recruiting status: exact text `招聘中`
- Communication candidates: exactly one visible, enabled control
- Exact action label: `继续沟通`
- Action class: `btn btn-startchat`
- Live adapter result before semantic support: `action_unavailable`
- Adapter elapsed time: 5,781 ms
- Browser operations: 1 detail navigation, 0 reloads, 0 clicks
- Tab topology: the fixed search tab and fixed communication tab remained separate in the same known window
- Risk-control or login-loss signals: none
- Database writes: none

The classifier now exposes this as a distinct `already_communicated` read-only state. It does not treat `继续沟通` as a fresh `立即沟通` action or click it during initial application dispatch.

No real job ID, job title, company, recruiter identity, JD text, raw HTML, screenshot, resume data, or browser credential is stored in this document.

## Confirmed Design Consequences

1. Search-page capture and standalone-detail communication inspection require different DOM helpers.
2. Communication must open the saved canonical detail URL; it must not search for the old card again.
3. The action element's `ka` value is not a job identity. Pre-click identity must use URL job ID plus visible title and company.
4. The helper retains every visible, enabled control whose label contains `沟通` as a candidate. The classifier requires exactly one candidate with the exact label `立即沟通`; non-communication controls such as favorite are ignored. Missing job status and missing or ambiguous candidates produce `action_unavailable`; a present status other than `招聘中` produces `job_unavailable`. A non-exact candidate fails closed. Hidden or disabled controls are excluded from candidates.
5. The current evidence supports one `立即沟通` ready state and one `继续沟通` state classified as `already_communicated`. It does not support a click implementation.

## Window Identity and Transport Boundary

- The current Edge Control `listTabs` result provides `windowId`. Read-only communication tab preparation pins one immutable search-tab ID and requires that fixed search tab to have a non-empty `windowId` before any page assertion, tab creation, navigation, or click.
- Stored and reusable communication tabs must have the same known `windowId`; a missing ID is never treated as a same-window match or synthesized from a tab ID, URL, title, or ordering.
- CDP does not currently provide a reliable window identity, and communication execution is not wired to CDP. Before any future CDP communication connection, the transport must supply a reliable window identity with the same semantics. Do not silently synthesize one.
- This document records a read-only Edge Control sample and offline regression coverage only. It does not claim that the end-to-end communication flow is available.

## Offline Engineering Verification

- The standalone-detail helper is executed against a sanitized minimal DOM with Node's built-in `vm` module.
- A unique visible and enabled `继续沟通` control maps to `already_communicated`; hidden, disabled, mixed, or ambiguous controls still fail closed.
- The fake-browser regression verifies two jobs reuse one communication tab, with one navigation per job and zero click calls.
- The tab-identity regression rejects an attempted search-tab rebind before page assertion and rejects a fixed search tab without `windowId`; stored or reusable communication tabs without a known matching window are not reused.
- A cached communication tab that changes into a search or unrelated page fails closed before navigation.
- Syntax checks passed for the adapter and its smoke test.
- `npm test` passed all 33 offline checks on 2026-07-18.
- `PRODUCT_POLICY.operations.bossCommunication.calibration.executionEnabled` remains `false`.

## Remaining Live Calibration

The following states still require separate, explicitly approved, low-frequency observation:

- an unavailable or closed job page;
- the immediate post-click standalone detail state;
- active chat identity for the same expected job;
- one explicitly approved single communication click, followed by UI and stored-state verification.

Do not enable production communication until every required state has current real-page evidence and the calibration review passes.
