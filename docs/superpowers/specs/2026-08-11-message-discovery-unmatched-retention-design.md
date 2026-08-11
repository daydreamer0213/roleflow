# Message Discovery Unmatched Retention Design

**Date:** 2026-08-11  
**Wave:** Wave 4 acceptance remediation  
**Issue:** RF-A06  
**Status:** approved by the controller under the user's standing instruction to use the recommended option and continue without blocking on non-user decisions

## Evidence

The post-Task-4 real Edge acceptance reached the actual Dashboard product route:

- the ordinary Edge adapter read 40 BOSS conversation rows;
- 39 first-seen non-unread rows became preview baselines;
- one unread row was queued and opened;
- its job identity did not match the only eligible local progress card;
- the run stopped with `BOSS_MESSAGE_CARD_NOT_FOUND`;
- no draft was produced and no editor or send control was used.

The safety stop is correct. The current recovery semantics are not:

1. `runBossMessageDiscovery` returns on the first identity mismatch, so later valid queue items are not processed in the same run.
2. Opening an unread conversation may make it read.
3. The failed item has no persisted preview baseline and no persisted unresolved marker.
4. On the next run, that now-read row is treated as a first-seen historical row and silently becomes a baseline instead of being reconsidered.

This can lose current incoming-message coverage. It is a Wave 4 product-quality defect, not an acceptable performance trade-off.

## Options

### A. Keep fail-fast behavior

Safest mechanically, but one unrelated or stale conversation blocks all later valid work and can lose the opened message on the next run.

**Rejected.**

### B. Skip the item and commit its preview as processed

Allows the rest of the queue to continue and needs no new storage, but permanently treats an unresolved incoming message as handled.

**Rejected because it silently reduces message recall.**

### C. Persist a sanitized unresolved item and continue the queue

Keep the strict identity gate. Persist only digests, reason code, timestamps, and safe operational metadata. Continue with later queue items. A later run requeues the unresolved item even if BOSS has marked it read. Clear it only after a successful match or an explicit future local resolution.

**Recommended.**

## Design

### Durable unresolved state

Add a small SQLite table owned by message discovery:

- `profile_id`
- `platform`
- `conversation_key`
- `preview_digest`
- `preview_kind`
- `reason_code`
- `first_observed_at`
- `last_observed_at`

The primary key is `(profile_id, platform, conversation_key)`. Do not persist recruiter names, message text, full headers, DOM, URLs, or model prompts.

The schema change must use the existing forward-migration mechanism and preserve existing databases transactionally.

### Queue planning

Queue priority:

1. currently unread rows;
2. rows with a durable unresolved marker;
3. rows whose preview changed from an existing baseline.

A first-seen read row with no unresolved marker remains baseline-only, preserving the current rule that RoleFlow does not ingest arbitrary history.

### Item processing

Identity mismatch reason codes are item-local:

- `BOSS_MESSAGE_CARD_NOT_FOUND`
- `BOSS_MESSAGE_CARD_AMBIGUOUS`
- `BOSS_MESSAGE_SALARY_MISMATCH`
- `BOSS_MESSAGE_CITY_MISMATCH`
- `BOSS_MESSAGE_COMPANY_MISMATCH`
- `BOSS_MESSAGE_THREAD_MISMATCH`

For these reasons:

1. clear all sensitive in-memory snapshot fields;
2. upsert the sanitized unresolved marker;
3. add a sanitized issue result to the run summary;
4. continue to the next immutable queue item;
5. do not call the model and do not create a candidate-progress event.

Reader failures, risk control, login loss, page loss, target drift, lease loss, or user stop remain whole-run terminal conditions.

On successful identity resolution and message processing, delete the matching unresolved marker and commit the current preview baseline.

### Run status

The run returns:

- `completed` when all queued items are handled or safely skipped with no unresolved items;
- `needs_user_action` when one or more durable unresolved items remain, even if later valid items were processed successfully.

Keep separate counts:

- `queued`: immutable queue length;
- `processed`: successfully classified message groups;
- `unresolved`: item-local identity issues.

Do not count unresolved items as successful communication or successful message processing.

### Product recovery

The current Wave 4 Gate A change only needs truthful state and durable retention. Gate B Task 8 will render:

- the unresolved count;
- a plain-language identity-mismatch explanation;
- a recovery action to inspect/fix local job progress data;
- no start/send shortcut and no raw external identity data.

An explicit local “ignore this conversation” resolution may be added only with its own evidence-preserving action and test. It is not implicit in “dismiss drafts.”

## Regression requirements

1. A two-item queue where the first identity is unmatched and the second is valid must process the second item without model activity for the first.
2. The run must end `needs_user_action` with `processed=1` and `unresolved=1`.
3. After the first item becomes read, a second run must still requeue it from the durable marker.
4. Successful later resolution clears the marker and commits the preview baseline.
5. Risk control and reader/page failures must still stop the whole run immediately.
6. Storage migration must preserve existing preview rows, communication rows, foreign keys, and indexes.
7. Public/controller output and logs must contain no message text, recruiter identity, full DOM, or request payloads.
