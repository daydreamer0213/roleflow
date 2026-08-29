const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const storage = require("../src/core/storage");
const store = require("../src/storage/message_reply_send_store");
const { ensureProgressCard } = require("../src/core/candidate_progress");

const NAMES = [
  "saveMessageInboundContext",
  "getMessageInboundContext",
  "listMessageInboundContexts",
  "deleteMessageInboundContext",
  "createMessageReplySendBatch",
  "getMessageReplySendBatch",
  "listMessageReplySendItems",
  "transitionMessageReplySendBatch",
  "transitionMessageReplySendItem",
  "stopPendingMessageReplySendItems"
];
assert.deepEqual(Object.keys(store).sort(), [...NAMES].sort());
for (const name of NAMES) assert.equal(storage[name], store[name], `${name} must be a direct facade reference`);

const db = storage.openDb(":memory:");
try {
  const now = "2026-08-29T01:00:00.000Z";
  const owner = createOwner(db, now);
  const first = createDraft(db, owner, "first", "第一条模型草稿", now);
  const second = createDraft(db, owner, "second", "第二条模型草稿", now);
  const third = createDraft(db, owner, "third", "第三条模型草稿", now);
  const alternatives = createDraftAlternatives(db, owner, "alternatives", ["备选版本甲", "备选版本乙"], now);
  const secretHrText = "HR 原文只允许保存在开放展示上下文";
  const forbiddenRecruiter = "FORBIDDEN_RECRUITER_LABEL";
  const forbiddenSecurity = "FORBIDDEN_SECURITY_ID";

  const saved = store.saveMessageInboundContext(db, {
    profileId: owner.profileId,
    cardId: first.card.id,
    messageGroupKey: first.groupKey,
    conversationKey: digest("conversation-first"),
    sourceJobId: "boss:encrypt-job-first",
    lastMessageId: "378917037748750",
    messageIntent: "information_request",
    messageCategory: "qualification",
    inboundMessages: [{ kind: "text", text: secretHrText }],
    manualActions: [],
    recruiterLabel: forbiddenRecruiter,
    securityId: forbiddenSecurity,
    previewText: "FORBIDDEN_PREVIEW",
    createdAt: now,
    updatedAt: now
  });
  assert.deepEqual(saved.inboundMessages, [{ kind: "text", text: secretHrText }]);
  assert.equal(saved.sourceJobId, "boss:encrypt-job-first");
  assert.equal(store.getMessageInboundContext(db, {
    profileId: owner.profileId,
    cardId: first.card.id,
    messageGroupKey: first.groupKey
  }).lastMessageId, "378917037748750");
  assert.equal(store.listMessageInboundContexts(db, { profileId: owner.profileId }).length, 1);
  assert.doesNotMatch(
    JSON.stringify(db.prepare("SELECT * FROM message_inbound_contexts").all()),
    new RegExp(`${forbiddenRecruiter}|${forbiddenSecurity}|FORBIDDEN_PREVIEW`)
  );

  const later = "2026-08-29T01:01:00.000Z";
  const updated = store.saveMessageInboundContext(db, {
    profileId: owner.profileId,
    cardId: first.card.id,
    messageGroupKey: first.groupKey,
    conversationKey: digest("conversation-first"),
    sourceJobId: "boss:encrypt-job-first",
    lastMessageId: "378917037748750",
    messageIntent: "information_request",
    messageCategory: "qualification",
    inboundMessages: [{ kind: "text", text: `${secretHrText}（更新）` }],
    manualActions: [],
    createdAt: later,
    updatedAt: later
  });
  assert.equal(updated.createdAt, now, "upsert must preserve the first created time");
  assert.equal(updated.updatedAt, later);

  saveContext(second, "conversation-second", "encrypt-job-second", "378917037748751");
  saveContext(third, "conversation-third", "encrypt-job-third", "378917037748752");
  saveContext(alternatives, "conversation-alternatives", "encrypt-job-alternatives", "378917037748753");
  assert.throws(
    () => saveContext(third, "conversation-third", "encrypt-job-third", "bad-message-id"),
    (error) => error.code === "MESSAGE_INBOUND_CONTEXT_INVALID"
  );
  assert.throws(
    () => store.saveMessageInboundContext(db, {
      profileId: owner.profileId,
      cardId: third.card.id,
      messageGroupKey: third.groupKey,
      conversationKey: digest("conversation-third"),
      sourceJobId: "boss:encrypt-job-third",
      lastMessageId: "378917037748752",
      inboundMessages: [{ kind: "resume_request", text: "伪造的附件简历文字" }],
      createdAt: now,
      updatedAt: now
    }),
    (error) => error.code === "MESSAGE_INBOUND_CONTEXT_INVALID"
  );

  const firstEdited = storage.saveMessageReplyDraftEdit(db, {
    profileId: owner.profileId,
    draftId: first.draft.id,
    text: "我可以介绍   第一段项目经验。",
    updatedAt: "2026-08-29T01:02:00.000Z"
  });
  const secondEdited = storage.saveMessageReplyDraftEdit(db, {
    profileId: owner.profileId,
    draftId: second.draft.id,
    text: "这是第二条确认文字。",
    updatedAt: "2026-08-29T01:02:00.000Z"
  });
  assert.throws(
    () => store.createMessageReplySendBatch(db, {
      profileId: owner.profileId,
      items: alternatives.drafts.map((draft) => ({ draftId: draft.id, revision: draft.revision })),
      createdAt: "2026-08-29T01:02:30.000Z"
    }),
    (error) => error.code === "MESSAGE_REPLY_SEND_CONVERSATION_DUPLICATE",
    "two alternative drafts for one HR conversation must never enter the same batch"
  );
  const frozen = store.createMessageReplySendBatch(db, {
    profileId: owner.profileId,
    items: [
      { draftId: firstEdited.id, revision: firstEdited.revision },
      { draftId: secondEdited.id, revision: secondEdited.revision }
    ],
    createdAt: "2026-08-29T01:03:00.000Z"
  });
  assert.equal(frozen.batch.status, "confirmed");
  assert.deepEqual(frozen.items.map((item) => item.position), [0, 1]);
  assert.deepEqual(frozen.items.map((item) => item.replyText), [
    "我可以介绍   第一段项目经验。",
    "这是第二条确认文字。"
  ]);
  assert.equal(frozen.items[0].replyDigest, digest("我可以介绍 第一段项目经验。"));
  assert.equal(frozen.items[0].conversationKey, digest("conversation-first"));
  assert(!JSON.stringify(frozen).includes(secretHrText), "frozen batches must not expose inbound HR text");

  storage.saveMessageReplyDraftEdit(db, {
    profileId: owner.profileId,
    draftId: firstEdited.id,
    text: "批次创建后继续输入的文字",
    updatedAt: "2026-08-29T01:04:00.000Z"
  });
  assert.equal(
    store.listMessageReplySendItems(db, { profileId: owner.profileId, batchId: frozen.batch.id })[0].replyText,
    "我可以介绍   第一段项目经验。",
    "batch text must remain immutable after confirmation"
  );
  assert.throws(
    () => store.createMessageReplySendBatch(db, {
      profileId: owner.profileId,
      items: [{ draftId: firstEdited.id, revision: firstEdited.revision }],
      createdAt: later
    }),
    (error) => error.code === "MESSAGE_REPLY_SEND_DRAFT_BUSY"
  );
  assert.throws(
    () => store.createMessageReplySendBatch(db, {
      profileId: owner.profileId,
      items: [
        { draftId: third.draft.id, revision: third.draft.revision },
        { draftId: third.draft.id, revision: third.draft.revision }
      ],
      createdAt: later
    }),
    (error) => error.code === "MESSAGE_REPLY_SEND_DRAFT_DUPLICATE"
  );
  assert.throws(
    () => store.createMessageReplySendBatch(db, {
      profileId: owner.profileId,
      items: [{ draftId: third.draft.id, revision: third.draft.revision + 1 }],
      createdAt: later
    }),
    (error) => error.code === "MESSAGE_REPLY_SEND_REVISION_CONFLICT"
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM message_reply_send_batches").get().n, 1,
    "failed batch creation must roll back its batch row");

  const running = store.transitionMessageReplySendBatch(db, {
    profileId: owner.profileId,
    batchId: frozen.batch.id,
    expectedStatus: "confirmed",
    status: "running",
    updatedAt: "2026-08-29T01:05:00.000Z"
  });
  assert.equal(running.status, "running");
  assert.throws(
    () => store.transitionMessageReplySendBatch(db, {
      profileId: owner.profileId,
      batchId: frozen.batch.id,
      expectedStatus: "confirmed",
      status: "completed",
      updatedAt: later
    }),
    (error) => error.code === "MESSAGE_REPLY_SEND_BATCH_CONFLICT"
  );

  let firstItem = frozen.items[0];
  for (const status of ["selecting", "verified", "filled"]) {
    firstItem = store.transitionMessageReplySendItem(db, {
      profileId: owner.profileId,
      batchId: frozen.batch.id,
      itemId: firstItem.id,
      expectedStatus: firstItem.status,
      status,
      updatedAt: later
    });
  }
  firstItem = store.transitionMessageReplySendItem(db, {
    profileId: owner.profileId,
    batchId: frozen.batch.id,
    itemId: firstItem.id,
    expectedStatus: "filled",
    status: "click_dispatched",
    clickCount: 1,
    evidence: { selectedMessageId: "378917037748750", replyDigest: firstItem.replyDigest },
    updatedAt: later
  });
  assert.equal(firstItem.clickCount, 1);
  assert.throws(
    () => store.transitionMessageReplySendItem(db, {
      profileId: owner.profileId,
      batchId: frozen.batch.id,
      itemId: firstItem.id,
      expectedStatus: "click_dispatched",
      status: "ambiguous",
      clickCount: 2,
      updatedAt: later
    }),
    (error) => error.code === "MESSAGE_REPLY_SEND_CLICK_COUNT_INVALID"
  );
  firstItem = store.transitionMessageReplySendItem(db, {
    profileId: owner.profileId,
    batchId: frozen.batch.id,
    itemId: firstItem.id,
    expectedStatus: "click_dispatched",
    status: "ambiguous",
    clickCount: 1,
    errorCode: "BOSS_REPLY_RESULT_AMBIGUOUS",
    errorMessage: "result could not be verified",
    updatedAt: later
  });
  assert.equal(firstItem.status, "ambiguous");
  assert.throws(
    () => store.createMessageReplySendBatch(db, {
      profileId: owner.profileId,
      items: [{
        draftId: firstItem.draftId,
        revision: storage.getMessageReplyDraft(db, { profileId: owner.profileId, draftId: firstItem.draftId }).revision
      }],
      createdAt: later
    }),
    (error) => error.code === "MESSAGE_REPLY_SEND_DRAFT_BUSY",
    "an ambiguous post-click item must remain non-retryable"
  );

  const secondItem = store.transitionMessageReplySendItem(db, {
    profileId: owner.profileId,
    batchId: frozen.batch.id,
    itemId: frozen.items[1].id,
    expectedStatus: "pending",
    status: "target_mismatch",
    errorCode: "BOSS_MESSAGE_TARGET_MISMATCH",
    errorMessage: "target changed",
    updatedAt: later
  });
  assert.equal(secondItem.status, "target_mismatch");
  const released = store.createMessageReplySendBatch(db, {
    profileId: owner.profileId,
    items: [{ draftId: secondEdited.id, revision: secondEdited.revision }],
    createdAt: "2026-08-29T01:06:00.000Z"
  });
  assert.equal(released.items[0].status, "pending", "a pre-click terminal item may be confirmed again");
  assert.equal(store.stopPendingMessageReplySendItems(db, {
    profileId: owner.profileId,
    batchId: released.batch.id,
    errorCode: "MESSAGE_REPLY_SEND_STOPPED",
    updatedAt: later
  }), 1);
  assert.equal(store.listMessageReplySendItems(db, {
    profileId: owner.profileId,
    batchId: released.batch.id
  })[0].status, "stopped");

  const interrupted = store.transitionMessageReplySendBatch(db, {
    profileId: owner.profileId,
    batchId: frozen.batch.id,
    expectedStatus: "running",
    status: "interrupted",
    stopCode: "BOSS_REPLY_RESULT_AMBIGUOUS",
    completedAt: "2026-08-29T01:07:00.000Z",
    updatedAt: "2026-08-29T01:07:00.000Z"
  });
  assert.equal(interrupted.status, "interrupted");
  assert.equal(store.getMessageReplySendBatch(db, {
    profileId: owner.profileId,
    batchId: frozen.batch.id
  }).stopCode, "BOSS_REPLY_RESULT_AMBIGUOUS");
  assert.equal(store.getMessageReplySendBatch(db, { profileId: owner.profileId + 999, batchId: frozen.batch.id }), null);

  assert.equal(store.deleteMessageInboundContext(db, {
    profileId: owner.profileId,
    cardId: third.card.id,
    messageGroupKey: third.groupKey
  }), true);
  assert.equal(store.getMessageInboundContext(db, {
    profileId: owner.profileId,
    cardId: third.card.id,
    messageGroupKey: third.groupKey
  }), null);

  console.log("message_reply_send_store_smoke ok");

  function saveContext(entry, conversation, sourceJob, lastMessageId) {
    return store.saveMessageInboundContext(db, {
      profileId: owner.profileId,
      cardId: entry.card.id,
      messageGroupKey: entry.groupKey,
      conversationKey: digest(conversation),
      sourceJobId: `boss:${sourceJob}`,
      lastMessageId,
      messageIntent: "information_request",
      messageCategory: "other",
      inboundMessages: [{ kind: "text", text: `HR context for ${conversation}` }],
      manualActions: [],
      createdAt: now,
      updatedAt: now
    });
  }
} finally {
  db.close();
}

function createOwner(database, now) {
  const profileId = Number(database.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES ('Reply sender', '{}', NULL, ?, ?)`).run(now, now).lastInsertRowid);
  const planId = Number(database.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, 'Reply sender plan', '{}', NULL, 1, ?, ?)`).run(profileId, now, now).lastInsertRowid);
  return { profileId, planId };
}

function createDraft(database, owner, suffix, text, now) {
  const jobId = Number(database.prepare(`INSERT INTO jobs(
    source, source_id, title, first_seen_at, last_seen_at
  ) VALUES ('boss', ?, ?, ?, ?)`).run(`boss:encrypt-job-${suffix}`, `Reply ${suffix}`, now, now).lastInsertRowid);
  const card = ensureProgressCard(database, { ...owner, jobId, source: "boss", now });
  const groupKey = digest(`group-${suffix}`);
  const draft = storage.recordMessageReplyDrafts(database, {
    profileId: owner.profileId,
    cardId: card.id,
    jobId,
    messageGroupKey: groupKey,
    questionSummary: `Question ${suffix}`,
    messageIntent: "information_request",
    messageCategory: "other",
    messages: [text],
    createdAt: now
  })[0];
  return { jobId, card, groupKey, draft };
}

function createDraftAlternatives(database, owner, suffix, messages, now) {
  const jobId = Number(database.prepare(`INSERT INTO jobs(
    source, source_id, title, first_seen_at, last_seen_at
  ) VALUES ('boss', ?, ?, ?, ?)`).run(`boss:encrypt-job-${suffix}`, `Reply ${suffix}`, now, now).lastInsertRowid);
  const card = ensureProgressCard(database, { ...owner, jobId, source: "boss", now });
  const groupKey = digest(`group-${suffix}`);
  const drafts = storage.recordMessageReplyDrafts(database, {
    profileId: owner.profileId,
    cardId: card.id,
    jobId,
    messageGroupKey: groupKey,
    questionSummary: `Question ${suffix}`,
    messageIntent: "information_request",
    messageCategory: "other",
    messages,
    createdAt: now
  });
  return { jobId, card, groupKey, drafts };
}

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value)).digest("hex")}`;
}
