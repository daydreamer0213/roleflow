# Detail-read outcome audit design

## Goal

Make every reserved BOSS pane-detail read durably explainable after a scan finishes, without changing BOSS navigation, clicks, pacing, filters, card/detail limits, matching, or communication behavior.

## Observed problem

The scanner already keeps `detailErrorCode` in its in-memory job object and logs a warning when `readCardDetail()` fails. `upsertJob()` and `recordJobObservation()` do not retain that field. After a scan, the durable state can show `DETAIL_REQUIRED` and aggregate `detailsFailed`, but cannot identify the stable failure code for each attempted pane read.

## Options considered

1. **Durable site-access outcome event — selected.** Add a sanitized `pane_detail_result` event for every attempt. It reuses the existing event table, needs no migration, and keeps scan diagnostics separate from job content.
2. **Add a detail-error column to jobs and observations.** Rejected: it requires a schema migration and makes transient browser diagnostics part of the job's long-lived product state.
3. **Keep warnings only.** Rejected: detached scan output and ephemeral logs cannot support later evidence-based diagnosis.

## Design

### Adapter callback

`BossSiteAdapter.scanBrowser()` gains an optional awaited callback, `onDetailResult(result)`.

It is invoked exactly once for every detail read that has already reserved `pane_detail_read`:

```js
{
  outcome: "succeeded" | "failed",
  errorCode: "" | "BOSS_*"
}
```

- A successful result is emitted only after `readCardDetail()` returns an accepted complete description.
- A failed result uses the caught stable error code, or `BOSS_CARD_DETAIL_READ_FAILED` when the error has no code.
- The callback receives no job ID, source ID, title, company, URL, JD text, error message, DOM, recruiter data, or credential.
- The callback runs outside the detail-read `try/catch`, so a persistence failure cannot be misclassified as a BOSS read failure. It propagates through the existing scan checkpoint/error path instead of silently losing audit evidence.
- Existing fatal browser-error behavior remains unchanged after the failure result has been reported.

### CLI persistence

The browser scan call in `src/cli.js` supplies `onDetailResult`. For each callback it calls existing `recordSiteAccessEvent()` with:

```js
{
  site: "boss",
  action: "pane_detail_result",
  runId,
  details: {
    batchId,
    outcome,
    errorCode
  }
}
```

`recordSiteAccessEvent()` appends the normalized site, action, and run ID. No database schema change is needed. The event is diagnostic only and does not reserve another access slot, alter quota accounting, or create a communication/application record.

## Testing

Tests run only fake browser adapters and in-memory SQLite:

1. A successful detail read emits exactly one sanitized `succeeded` callback with an empty error code.
2. A thrown `BOSS_PANE_SWITCH_TIMEOUT` emits exactly one sanitized `failed` callback with that code, while existing failed-job behavior remains intact.
3. CLI persistence writes `pane_detail_result` events with batch/run linkage and the three safe detail fields, and assertions prove no job/title/URL/JD/error-message field appears in the payload.
4. Existing BOSS source-acquisition and site-access-budget tests remain green, proving that the new audit event does not consume a browser-access reservation or change existing pace/limit behavior.

## Non-goals

- This change does not diagnose or fix any BOSS selector, timing, or page behavior.
- It does not replay failed reads, increase budgets, or trigger a live scan.
- It does not change the user-owned chat-page exception documented in the acceptance evidence.
