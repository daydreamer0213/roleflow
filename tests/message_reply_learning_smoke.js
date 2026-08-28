const assert = require("node:assert");
const {
  normalizeReplyDraftText,
  replyDraftDigest,
  replyDraftWasEdited,
  deriveUserChangedText,
  validateReplyEditFactExtraction
} = require("../src/core/message_reply_learning");
const { createMessageReplyLearningService } = require("../src/application/message_learning");
const {
  openDb,
  recordMessageReplyDrafts,
  listCandidateFacts,
  listCandidateAnswerMemories,
  listCandidateFactRevisions
} = require("../src/core/storage");

assert.strictEqual(normalizeReplyDraftText("  您好，\r\n  我可以到岗。  "), "您好，\n我可以到岗。");
assert.strictEqual(replyDraftWasEdited("您好， 我可以到岗。", "您好，\n我可以到岗。"), false, "whitespace-only changes are not authoritative edits");
assert.strictEqual(replyDraftWasEdited("目前在职，一个月内到岗", "目前已离职，下周到岗"), true);
assert(/^sha256:[a-f0-9]{64}$/.test(replyDraftDigest("最终回答")));
assert.strictEqual(
  replyDraftDigest("我目前 在职"),
  replyDraftDigest("我目前\n在职"),
  "digest idempotency must use the same whitespace equivalence as edit detection"
);

const changed = deriveUserChangedText(
  "您好，我目前在职，一个月内可以到岗。",
  "您好，我目前已经离职，下周可以到岗。"
);
assert(changed.includes("已经离职"));
assert(changed.includes("下周"));
assert(!changed.includes("一个月内"), "changed evidence must not contain removed model wording");
assert("您好，我目前已经离职，下周可以到岗。".includes(changed), "changed evidence must be a literal final-answer span");

const separated = deriveUserChangedText("我在广州，期望20K，可以出差。", "我在深圳，期望25K，可以出差。 ");
assert("我在深圳，期望25K，可以出差。".includes(separated.trim()), "separated edits may use one conservative final-answer span");

const validated = validateReplyEditFactExtraction({
  scope: { kind: "global", key: "" },
  facts: [
    { factKey: "employment_status", factValue: "已离职", evidenceText: "已经离职" },
    { factKey: "unknown_model_guess", factValue: "不能保存", evidenceText: "已经离职" },
    { factKey: "availability_date", factValue: "一个月内", evidenceText: "一个月内" },
    { factKey: "availability_date", factValue: "下周", evidenceText: "下周" }
  ]
}, { changedText: changed });
assert.deepStrictEqual(validated, {
  scope: { kind: "global", key: "" },
  facts: [
    { factKey: "employment_status", factValue: "已离职", evidenceText: "已经离职" },
    { factKey: "availability_date", factValue: "下周", evidenceText: "下周" }
  ]
});
assert.deepStrictEqual(validateReplyEditFactExtraction(null, { changedText: changed }), {
  scope: { kind: "global", key: "" },
  facts: []
});
assert.deepStrictEqual(validateReplyEditFactExtraction({
  scope: { kind: "global", key: "" },
  facts: []
}, {
  changedText: changed,
  scope: { kind: "job", key: "42" }
}).scope, { kind: "job", key: "42" }, "the extractor must not broaden a job-scoped answer into global memory");

const db = openDb(":memory:");

(async () => {
  try {
    const fixture = createFixture(db);
    const calls = [];
    let extractionMode = "success";
    const service = createMessageReplyLearningService({
      db,
      adapter: {
        async extractReplyEditFacts(input) {
          calls.push(structuredClone(input));
          if (extractionMode === "failure") throw Object.assign(new Error("model unavailable"), { code: "MODEL_UNAVAILABLE" });
          return {
            scope: { kind: "global", key: "" },
            facts: [
              { factKey: "employment_status", factValue: "已离职", evidenceText: "已经离职" },
              { factKey: "availability_date", factValue: "下周", evidenceText: "下周" },
              { factKey: "unknown_model_guess", factValue: "丢弃", evidenceText: "已经离职" },
              { factKey: "current_city", factValue: "广州", evidenceText: "广州" }
            ]
          };
        }
      },
      logger: { warn() {} },
      now: sequenceNow([
        "2026-08-28T02:01:00.000Z",
        "2026-08-28T02:02:00.000Z",
        "2026-08-28T02:03:00.000Z",
        "2026-08-28T02:04:00.000Z",
        "2026-08-28T02:05:00.000Z"
      ])
    });

    const firstDraft = seedDraft(db, fixture, "service-1", "您好，我目前在职，一个月内可以到岗。");
    const saved = service.saveDraft({
      profileId: fixture.profileId,
      draftId: firstDraft.id,
      text: "您好，我目前已经离职，下周可以到岗。"
    });
    assert.strictEqual(saved.currentText, "您好，我目前已经离职，下周可以到岗。");
    assert.strictEqual(calls.length, 0, "autosave must never invoke fact extraction");
    assert.strictEqual(listCandidateFacts(db, fixture.profileId).length, 0);

    const completed = await service.completeDraft({
      profileId: fixture.profileId,
      draftId: firstDraft.id,
      finalText: saved.currentText,
      completionKind: "copied"
    });
    assert.deepStrictEqual(completed, {
      memoryId: completed.memoryId,
      draftId: firstDraft.id,
      revision: 1,
      changed: true,
      learnedFactCount: 2,
      extractionStatus: "succeeded"
    });
    assert(completed.memoryId > 0);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].originalText, firstDraft.originalText);
    assert.strictEqual(calls[0].finalText, saved.currentText);
    assert.strictEqual(calls[0].changedText, changed);
    assert(!Object.hasOwn(calls[0], "profile"), "extractor receives only reply-edit context, not the whole candidate profile");
    assert.deepStrictEqual(currentFacts(db, fixture.profileId), {
      availability_date: "下周",
      employment_status: "已离职"
    });

    const repeated = await service.completeDraft({
      profileId: fixture.profileId,
      draftId: firstDraft.id,
      finalText: saved.currentText,
      completionKind: "copied"
    });
    assert.strictEqual(repeated.memoryId, completed.memoryId);
    assert.strictEqual(calls.length, 1, "idempotent completion should not pay for extraction twice");
    assert.strictEqual(listCandidateFactRevisions(db, { profileId: fixture.profileId }).length, 2);

    const unchangedDraft = seedDraft(db, fixture, "service-2", "您好，感谢沟通。这个岗位我愿意继续了解。");
    const unchanged = await service.completeDraft({
      profileId: fixture.profileId,
      draftId: unchangedDraft.id,
      finalText: "您好，感谢沟通。这个岗位我愿意继续了解。",
      completionKind: "copied"
    });
    assert.strictEqual(unchanged.changed, false);
    assert.strictEqual(unchanged.extractionStatus, "not_needed");
    assert.strictEqual(unchanged.learnedFactCount, 0);
    assert.strictEqual(calls.length, 1, "unchanged model draft must not invoke extraction");

    extractionMode = "failure";
    const failureDraft = seedDraft(db, fixture, "service-3", "您好，我目前在广州。", "other");
    const failed = await service.completeDraft({
      profileId: fixture.profileId,
      draftId: failureDraft.id,
      finalText: "您好，我目前在深圳。",
      completionKind: "copied"
    });
    assert.strictEqual(failed.changed, true);
    assert.strictEqual(failed.extractionStatus, "failed");
    assert.strictEqual(failed.learnedFactCount, 0);
    assert(listCandidateAnswerMemories(db, { profileId: fixture.profileId, activeOnly: true, source: "user_edited_reply" })
      .some((memory) => memory.finalText === "您好，我目前在深圳。"), "extractor failure must not lose the user's final answer");

    const noAdapterDraft = seedDraft(db, fixture, "service-4", "您好，我暂不接受出差。", "qualification");
    const noAdapterService = createMessageReplyLearningService({ db, adapter: {}, now: () => "2026-08-28T02:06:00.000Z" });
    const unavailable = await noAdapterService.completeDraft({
      profileId: fixture.profileId,
      draftId: noAdapterDraft.id,
      finalText: "您好，我可以接受短期出差。",
      completionKind: "sent"
    });
    assert.strictEqual(unavailable.extractionStatus, "unavailable");
    assert.strictEqual(unavailable.learnedFactCount, 0);

    const dynamicUnavailableDraft = seedDraft(db, fixture, "service-5", "您好，我目前在广州。", "other");
    const dynamicUnavailableService = createMessageReplyLearningService({
      db,
      adapter: {
        async extractReplyEditFacts() {
          throw Object.assign(new Error("model is not configured"), {
            code: "MESSAGE_REPLY_FACT_EXTRACTION_UNAVAILABLE"
          });
        }
      },
      logger: { warn() {} },
      now: () => "2026-08-28T02:07:00.000Z"
    });
    const dynamicUnavailable = await dynamicUnavailableService.completeDraft({
      profileId: fixture.profileId,
      draftId: dynamicUnavailableDraft.id,
      finalText: "您好，我目前在佛山。",
      completionKind: "copied"
    });
    assert.strictEqual(dynamicUnavailable.extractionStatus, "unavailable");
    assert(listCandidateAnswerMemories(db, { profileId: fixture.profileId, activeOnly: true, source: "user_edited_reply" })
      .some((memory) => memory.finalText === "您好，我目前在佛山。"), "unavailable extraction must still keep the edited answer");

    const communicationProfile = service.listCommunicationProfile({ profileId: fixture.profileId });
    assert(communicationProfile.facts.some((fact) => fact.factKey === "employment_status"));
    assert(communicationProfile.answers.every((answer) => answer.source === "user_edited_reply"));
    assert(communicationProfile.revisions.length >= 2);

    service.withdrawMemory({ profileId: fixture.profileId, memoryId: completed.memoryId });
    assert.strictEqual(currentFacts(db, fixture.profileId).employment_status, undefined);

    console.log("message_reply_learning_smoke ok");
  } finally {
    db.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

function createFixture(database) {
  const now = "2026-08-28T02:00:00.000Z";
  const profileId = Number(database.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES ('Learning candidate', '{}', NULL, ?, ?)`).run(now, now).lastInsertRowid);
  const planId = Number(database.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, 'Learning plan', '{}', NULL, 1, ?, ?)`).run(profileId, now, now).lastInsertRowid);
  const jobId = Number(database.prepare(`INSERT INTO jobs(
    source, source_id, title, first_seen_at, last_seen_at
  ) VALUES ('boss', 'learning-job', 'Learning job', ?, ?)`).run(now, now).lastInsertRowid);
  const cardId = Number(database.prepare(`INSERT INTO candidate_progress_cards(
    profile_id, plan_id, job_id, source, stage, next_action, last_event_at, created_at, updated_at
  ) VALUES (?, ?, ?, 'boss', 'reply_ready', 'Review draft before manual send', ?, ?, ?)`)
    .run(profileId, planId, jobId, now, now, now).lastInsertRowid);
  return { profileId, planId, jobId, cardId };
}

function seedDraft(database, fixture, suffix, message, category = "availability") {
  return recordMessageReplyDrafts(database, {
    ...fixture,
    messageGroupKey: digest(suffix),
    questionSummary: "对方正在确认候选人的情况。",
    messageIntent: "information_request",
    messageCategory: category,
    messages: [message],
    createdAt: "2026-08-28T02:00:00.000Z"
  })[0];
}

function digest(value) {
  return `sha256:${require("node:crypto").createHash("sha256").update(value).digest("hex")}`;
}

function currentFacts(database, profileId) {
  return Object.fromEntries(listCandidateFacts(database, profileId).map((fact) => [fact.factKey, fact.factValue]));
}

function sequenceNow(values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}
