const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const storage = require("../src/core/storage");
const { createMessageReplyLearningService } = require("../src/application/message_learning");
const { createMessageReplySendingService } = require("../src/application/message_reply_sending");
const {
  transitionReplySendBatch,
  transitionReplySendItem
} = require("../src/core/message_reply_send_batches");

const db = storage.openDb(":memory:");

(async () => {
  try {
    const now = "2026-08-29T03:00:00.000Z";
    const owner = createOwner(db, now);
    const other = createOwner(db, now, "other");
    const extractionCalls = [];
    const learningService = createMessageReplyLearningService({
      db,
      adapter: {
        async extractReplyEditFacts(input) {
          extractionCalls.push(structuredClone(input));
          return { scope: input.scope, facts: [] };
        }
      },
      now: () => now
    });
    const executed = [];
    const executionErrors = [];
    const service = createMessageReplySendingService({
      db,
      learningService,
      now: () => now,
      executeBatch(batchId) { executed.push(batchId); },
      onExecutionError(error) { executionErrors.push(error); }
    });

    const first = seedDraft(db, owner, "first", "模型初稿", now);
    saveContext(db, owner, first, "378917037748770", now);
    const edited = storage.saveMessageReplyDraftEdit(db, {
      profileId: owner.profileId,
      draftId: first.draft.id,
      text: "这是用户点击确认时的最终文字。",
      updatedAt: now
    });
    assert.throws(
      () => service.confirmBatch({
        profileId: owner.profileId,
        items: [{
          draftId: edited.id,
          revision: edited.revision,
          replyText: "不得信任前端文字"
        }]
      }),
      (error) => error.code === "MESSAGE_REPLY_SEND_INPUT_INVALID"
    );
    const confirmed = service.confirmBatch({
      profileId: owner.profileId,
      items: [{ draftId: edited.id, revision: edited.revision }]
    });
    assert.equal(confirmed.batch.status, "confirmed");
    assert.equal(confirmed.items[0].replyText, "这是用户点击确认时的最终文字。");
    assert.deepEqual(executed, [], "executor must not run inside the confirmation transaction");
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(executed, [confirmed.batch.id]);
    assert.deepEqual(executionErrors, []);
    const publicStatus = service.status({ profileId: owner.profileId, batchId: confirmed.batch.id });
    assert(!JSON.stringify(publicStatus).includes("这是用户点击确认时的最终文字。"));
    assert(!Object.hasOwn(publicStatus.items[0], "replyText"));
    assert(!Object.hasOwn(publicStatus.items[0], "conversationKey"));
    assert.throws(
      () => service.status({ profileId: other.profileId, batchId: confirmed.batch.id }),
      (error) => error.code === "MESSAGE_REPLY_SEND_BATCH_NOT_FOUND"
    );

    storage.saveMessageReplyDraftEdit(db, {
      profileId: owner.profileId,
      draftId: edited.id,
      text: "确认之后继续输入的新文字",
      updatedAt: now
    });
    assert.equal(storage.listMessageReplySendItems(db, {
      profileId: owner.profileId,
      batchId: confirmed.batch.id
    })[0].replyText, "这是用户点击确认时的最终文字。");

    assert.throws(
      () => transitionReplySendItem(db, {
        profileId: owner.profileId,
        batchId: confirmed.batch.id,
        itemId: confirmed.items[0].id,
        expectedStatus: "pending",
        status: "succeeded",
        updatedAt: now
      }),
      (error) => error.code === "MESSAGE_REPLY_SEND_TRANSITION_INVALID"
    );
    transitionReplySendBatch(db, {
      profileId: owner.profileId,
      batchId: confirmed.batch.id,
      expectedStatus: "confirmed",
      status: "running",
      updatedAt: now
    });
    let firstItem = confirmed.items[0];
    for (const status of ["selecting", "verified", "filled"]) {
      firstItem = transitionReplySendItem(db, {
        profileId: owner.profileId,
        batchId: confirmed.batch.id,
        itemId: firstItem.id,
        expectedStatus: firstItem.status,
        status,
        updatedAt: now
      });
    }
    firstItem = transitionReplySendItem(db, {
      profileId: owner.profileId,
      batchId: confirmed.batch.id,
      itemId: firstItem.id,
      expectedStatus: "filled",
      status: "click_dispatched",
      clickCount: 1,
      updatedAt: now
    });
    const completed = await service.completeVerifiedItem({
      batchId: confirmed.batch.id,
      itemId: firstItem.id
    });
    assert.equal(completed.item.status, "succeeded");
    assert.equal(completed.learning.draftId, edited.id);
    assert(storage.getMessageReplyDraft(db, { profileId: owner.profileId, draftId: edited.id }).closedAt);
    assert.equal(storage.getMessageInboundContext(db, {
      profileId: owner.profileId,
      cardId: first.cardId,
      messageGroupKey: first.groupKey
    }), null);
    assert.equal(countMemories(db, edited.id), 1);
    assert.equal(countSentEvents(db, first.cardId), 1);
    const repeated = await service.completeVerifiedItem({
      batchId: confirmed.batch.id,
      itemId: firstItem.id
    });
    assert.equal(repeated.item.status, "succeeded");
    assert.equal(countMemories(db, edited.id), 1);
    assert.equal(countSentEvents(db, first.cardId), 1);

    const missingContext = seedDraft(db, owner, "missing-context", "缺少上下文", now);
    assert.throws(
      () => service.confirmBatch({
        profileId: owner.profileId,
        items: [{ draftId: missingContext.draft.id, revision: missingContext.draft.revision }]
      }),
      (error) => error.code === "MESSAGE_REPLY_SEND_CONTEXT_REQUIRED"
    );
    assert.throws(
      () => service.confirmBatch({
        profileId: other.profileId,
        items: [{ draftId: missingContext.draft.id, revision: missingContext.draft.revision }]
      }),
      (error) => error.code === "MESSAGE_REPLY_SEND_DRAFT_NOT_FOUND"
    );

    const stale = seedDraft(db, owner, "stale", "旧版本", now);
    saveContext(db, owner, stale, "378917037748771", now);
    assert.throws(
      () => service.confirmBatch({
        profileId: owner.profileId,
        items: [{ draftId: stale.draft.id, revision: stale.draft.revision + 1 }]
      }),
      (error) => error.code === "MESSAGE_REPLY_SEND_REVISION_CONFLICT"
    );

    const empty = seedDraft(db, owner, "empty", "会被清空", now);
    saveContext(db, owner, empty, "378917037748772", now);
    const emptyEdited = storage.saveMessageReplyDraftEdit(db, {
      profileId: owner.profileId,
      draftId: empty.draft.id,
      text: "",
      updatedAt: now
    });
    assert.throws(
      () => service.confirmBatch({
        profileId: owner.profileId,
        items: [{ draftId: emptyEdited.id, revision: emptyEdited.revision }]
      }),
      (error) => error.code === "MESSAGE_REPLY_SEND_TEXT_INVALID"
    );

    const invalidIdentity = seedDraft(db, owner, "identity", "身份无效", now);
    saveContext(db, owner, invalidIdentity, "378917037748773", now);
    db.prepare("UPDATE message_inbound_contexts SET source_job_id = '' WHERE card_id = ? AND message_group_key = ?")
      .run(invalidIdentity.cardId, invalidIdentity.groupKey);
    assert.throws(
      () => service.confirmBatch({
        profileId: owner.profileId,
        items: [{ draftId: invalidIdentity.draft.id, revision: invalidIdentity.draft.revision }]
      }),
      (error) => error.code === "MESSAGE_INBOUND_CONTEXT_INVALID"
    );

    const closed = seedDraft(db, owner, "closed", "已关闭", now);
    saveContext(db, owner, closed, "378917037748774", now);
    storage.completeMessageReplyDraft(db, {
      profileId: owner.profileId,
      draftId: closed.draft.id,
      finalText: closed.draft.currentText,
      completionKind: "sent",
      completedAt: now
    });
    assert.throws(
      () => service.confirmBatch({
        profileId: owner.profileId,
        items: [{ draftId: closed.draft.id, revision: closed.draft.revision }]
      }),
      (error) => error.code === "MESSAGE_REPLY_SEND_DRAFT_CLOSED"
    );
    assert.throws(
      () => service.confirmBatch({
        profileId: owner.profileId,
        items: [
          { draftId: stale.draft.id, revision: stale.draft.revision },
          { draftId: stale.draft.id, revision: stale.draft.revision }
        ]
      }),
      (error) => error.code === "MESSAGE_REPLY_SEND_DRAFT_DUPLICATE"
    );
    assert.throws(
      () => service.confirmBatch({
        profileId: owner.profileId,
        items: Array.from({ length: 51 }, () => ({ draftId: stale.draft.id, revision: stale.draft.revision }))
      }),
      (error) => error.code === "MESSAGE_REPLY_SEND_ITEMS_INVALID"
    );

    const atomic = seedDraft(db, owner, "atomic", "原子失败前的草稿", now);
    saveContext(db, owner, atomic, "378917037748775", now);
    const atomicBatch = service.confirmBatch({
      profileId: owner.profileId,
      items: [{ draftId: atomic.draft.id, revision: atomic.draft.revision }]
    });
    await Promise.resolve();
    transitionReplySendBatch(db, {
      profileId: owner.profileId,
      batchId: atomicBatch.batch.id,
      expectedStatus: "confirmed",
      status: "running",
      updatedAt: now
    });
    let atomicItem = atomicBatch.items[0];
    for (const status of ["selecting", "verified", "filled"]) {
      atomicItem = transitionReplySendItem(db, {
        profileId: owner.profileId,
        batchId: atomicBatch.batch.id,
        itemId: atomicItem.id,
        expectedStatus: atomicItem.status,
        status,
        updatedAt: now
      });
    }
    atomicItem = transitionReplySendItem(db, {
      profileId: owner.profileId,
      batchId: atomicBatch.batch.id,
      itemId: atomicItem.id,
      expectedStatus: "filled",
      status: "click_dispatched",
      clickCount: 1,
      updatedAt: now
    });
    db.exec(`CREATE TEMP TRIGGER fail_reply_send_progress
      BEFORE INSERT ON candidate_progress_events
      WHEN NEW.type = 'reply_confirmed_sent'
      BEGIN SELECT RAISE(ABORT, 'forced reply send progress failure'); END`);
    await assert.rejects(
      () => service.completeVerifiedItem({ batchId: atomicBatch.batch.id, itemId: atomicItem.id }),
      /forced reply send progress failure/
    );
    assert.equal(storage.listMessageReplySendItems(db, {
      profileId: owner.profileId,
      batchId: atomicBatch.batch.id
    })[0].status, "click_dispatched", "local rollback must retain the non-retryable post-click state");
    assert.equal(storage.getMessageReplyDraft(db, {
      profileId: owner.profileId,
      draftId: atomic.draft.id
    }).closedAt, "");
    assert.equal(countMemories(db, atomic.draft.id), 0);
    assert(storage.getMessageInboundContext(db, {
      profileId: owner.profileId,
      cardId: atomic.cardId,
      messageGroupKey: atomic.groupKey
    }), "rolled-back local completion must retain the open HR context");
    db.exec("DROP TRIGGER fail_reply_send_progress");

    const stopFirst = seedDraft(db, owner, "stop-first", "第一条待停止", now);
    const stopSecond = seedDraft(db, owner, "stop-second", "第二条待停止", now);
    saveContext(db, owner, stopFirst, "378917037748776", now);
    saveContext(db, owner, stopSecond, "378917037748777", now);
    const stopBatch = service.confirmBatch({
      profileId: owner.profileId,
      items: [
        { draftId: stopFirst.draft.id, revision: stopFirst.draft.revision },
        { draftId: stopSecond.draft.id, revision: stopSecond.draft.revision }
      ]
    });
    await Promise.resolve();
    transitionReplySendBatch(db, {
      profileId: owner.profileId,
      batchId: stopBatch.batch.id,
      expectedStatus: "confirmed",
      status: "running",
      updatedAt: now
    });
    let dispatched = stopBatch.items[0];
    for (const status of ["selecting", "verified", "filled"]) {
      dispatched = transitionReplySendItem(db, {
        profileId: owner.profileId,
        batchId: stopBatch.batch.id,
        itemId: dispatched.id,
        expectedStatus: dispatched.status,
        status,
        updatedAt: now
      });
    }
    transitionReplySendItem(db, {
      profileId: owner.profileId,
      batchId: stopBatch.batch.id,
      itemId: dispatched.id,
      expectedStatus: "filled",
      status: "click_dispatched",
      clickCount: 1,
      updatedAt: now
    });
    const stopped = service.stop({ profileId: owner.profileId, batchId: stopBatch.batch.id });
    assert.deepEqual(stopped.items.map((item) => item.status), ["click_dispatched", "stopped"]);
    assert.equal(stopped.batch.status, "interrupted");

    const qualityOwner = createOwner(db, now, "quality");
    const evidenceDraft = seedDraft(db, qualityOwner, "evidence", "模型未填写联系方式", now);
    const evidence = storage.completeMessageReplyDraft(db, {
      profileId: qualityOwner.profileId,
      draftId: evidenceDraft.draft.id,
      finalText: "用户确认手机号是 13800138000。",
      changedText: "用户确认手机号是 13800138000。",
      scope: { kind: "global", key: "" },
      completionKind: "copied",
      extractedFacts: [],
      completedAt: now
    });
    const unsupported = seedDraft(db, qualityOwner, "unsupported", "我的手机号是 13800138000。", now);
    saveContext(db, qualityOwner, unsupported, "378917037748778", now);
    storage.withdrawCandidateAnswerMemory(db, {
      profileId: qualityOwner.profileId,
      memoryId: evidence.id,
      withdrawnAt: "2026-08-29T03:01:00.000Z"
    });
    const batchCountBeforeQualityFailure = db.prepare("SELECT COUNT(*) AS n FROM message_reply_send_batches").get().n;
    assert.throws(
      () => service.confirmBatch({
        profileId: qualityOwner.profileId,
        items: [{ draftId: unsupported.draft.id, revision: unsupported.draft.revision }]
      }),
      (error) => error.code === "MESSAGE_DRAFT_FACT_UNSUPPORTED"
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM message_reply_send_batches").get().n, batchCountBeforeQualityFailure,
      "an unsupported untouched model draft must fail before a batch is created");
    const userConfirmed = storage.saveMessageReplyDraftEdit(db, {
      profileId: qualityOwner.profileId,
      draftId: unsupported.draft.id,
      text: "用户亲自补充：我的手机号是 13800138000。",
      updatedAt: "2026-08-29T03:02:00.000Z"
    });
    const userConfirmedBatch = service.confirmBatch({
      profileId: qualityOwner.profileId,
      items: [{ draftId: userConfirmed.id, revision: userConfirmed.revision }]
    });
    assert.equal(userConfirmedBatch.batch.status, "confirmed", "a user edit is the authoritative confirmation input");

    const factOwner = createOwner(db, now, "fact-evidence");
    storage.saveCandidateFact(db, {
      profileId: factOwner.profileId,
      factKey: "availability_date",
      factValue: "本周三",
      source: "user_provided"
    });
    const supportedByFact = seedDraft(db, factOwner, "supported", "我本周三可以到岗。", now);
    saveContext(db, factOwner, supportedByFact, "378917037748779", now);
    const supportedBatch = service.confirmBatch({
      profileId: factOwner.profileId,
      items: [{ draftId: supportedByFact.draft.id, revision: supportedByFact.draft.revision }]
    });
    assert.equal(supportedBatch.batch.status, "confirmed", "a current candidate fact should support the untouched model draft");

    console.log("message_reply_send_service_smoke ok");
  } finally {
    db.close();
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

function createOwner(database, now, suffix = "main") {
  const profileId = Number(database.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES (?, '{}', NULL, ?, ?)`).run(`Reply sender ${suffix}`, now, now).lastInsertRowid);
  const planId = Number(database.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, ?, '{}', NULL, 1, ?, ?)`).run(profileId, `Reply plan ${suffix}`, now, now).lastInsertRowid);
  return { profileId, planId, suffix };
}

function seedDraft(database, owner, suffix, text, now) {
  const jobId = Number(database.prepare(`INSERT INTO jobs(
    source, source_id, title, first_seen_at, last_seen_at
  ) VALUES ('boss', ?, ?, ?, ?)`).run(`boss:send-${owner.suffix}-${suffix}`, `Send ${suffix}`, now, now).lastInsertRowid);
  const cardId = Number(database.prepare(`INSERT INTO candidate_progress_cards(
    profile_id, plan_id, job_id, source, stage, next_action, last_event_at, created_at, updated_at
  ) VALUES (?, ?, ?, 'boss', 'reply_ready', 'Review reply', ?, ?, ?)`)
    .run(owner.profileId, owner.planId, jobId, now, now, now).lastInsertRowid);
  const groupKey = digest(`group:${owner.suffix}:${suffix}`);
  const draft = storage.recordMessageReplyDrafts(database, {
    profileId: owner.profileId,
    cardId,
    jobId,
    messageGroupKey: groupKey,
    questionSummary: "对方正在确认候选人的任职资格。",
    messageIntent: "information_request",
    messageCategory: "qualification",
    messages: [text],
    createdAt: now
  })[0];
  return { cardId, jobId, groupKey, draft, suffix };
}

function saveContext(database, owner, entry, lastMessageId, now) {
  return storage.saveMessageInboundContext(database, {
    profileId: owner.profileId,
    cardId: entry.cardId,
    messageGroupKey: entry.groupKey,
    conversationKey: digest(`conversation:${owner.suffix}:${entry.suffix}`),
    sourceJobId: `boss:send-${owner.suffix}-${entry.suffix}`,
    lastMessageId,
    messageIntent: "information_request",
    messageCategory: "qualification",
    inboundMessages: [{ kind: "text", text: `HR context ${entry.suffix}` }],
    manualActions: [],
    createdAt: now,
    updatedAt: now
  });
}

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value)).digest("hex")}`;
}

function countMemories(database, draftId) {
  return Number(database.prepare("SELECT COUNT(*) AS n FROM candidate_answer_memories WHERE draft_id = ?")
    .get(draftId).n);
}

function countSentEvents(database, cardId) {
  return Number(database.prepare(`SELECT COUNT(*) AS n FROM candidate_progress_events
    WHERE card_id = ? AND type = 'reply_confirmed_sent'`).get(cardId).n);
}
