const assert = require("node:assert");
const {
  openDb,
  recordMessageReplyDrafts,
  getMessageReplyDraft,
  listOpenMessageReplyDrafts,
  saveMessageReplyDraftEdit,
  completeMessageReplyDraft,
  listCandidateAnswerMemories,
  withdrawCandidateAnswerMemory,
  listCandidateFactRevisions,
  closeMessageReplyDrafts,
  saveCandidateFact,
  listCandidateFacts
} = require("../src/core/storage");

const db = openDb(":memory:");

try {
  const fixture = createFixture(db);
  const drafts = recordMessageReplyDrafts(db, {
    profileId: fixture.profileId,
    cardId: fixture.cardId,
    jobId: fixture.jobId,
    messageGroupKey: digest("group-1"),
    questionSummary: "对方正在确认候选人的到岗时间。",
    messageIntent: "information_request",
    messageCategory: "availability",
    messages: ["您好，我目前在职，一个月内可以到岗。", "您好，我可以在确认 offer 后一个月内到岗。", "第三条不应保存"],
    createdAt: "2026-08-28T01:00:00.000Z"
  });
  assert.strictEqual(drafts.length, 2, "one message group must keep at most two drafts");
  assert.deepStrictEqual(drafts.map((draft) => draft.draftIndex), [0, 1]);
  assert.strictEqual(drafts[0].questionSummary, "对方正在确认候选人的到岗时间。");
  assert.strictEqual(drafts[0].originalText, "您好，我目前在职，一个月内可以到岗。");
  assert.strictEqual(drafts[0].currentText, drafts[0].originalText);
  assert.strictEqual(drafts[0].revision, 0);
  assert(!db.prepare("PRAGMA table_info(message_reply_drafts)").all()
    .some((column) => /raw|hr_message|recruiter_message/i.test(column.name)), "durable drafts must not add a raw HR message column");

  const repeatedDrafts = recordMessageReplyDrafts(db, {
    profileId: fixture.profileId,
    cardId: fixture.cardId,
    jobId: fixture.jobId,
    messageGroupKey: digest("group-1"),
    questionSummary: "不同摘要不能覆盖已保存草稿",
    messageIntent: "general_communication",
    messageCategory: "other",
    messages: ["不同原稿不能覆盖用户当前内容"],
    createdAt: "2026-08-28T01:01:00.000Z"
  });
  assert.strictEqual(repeatedDrafts[0].id, drafts[0].id);
  assert.strictEqual(repeatedDrafts[0].originalText, drafts[0].originalText);
  assert.strictEqual(db.prepare("SELECT count(*) AS n FROM message_reply_drafts").get().n, 2);

  const edited = saveMessageReplyDraftEdit(db, {
    profileId: fixture.profileId,
    draftId: drafts[0].id,
    text: "您好，我目前已经离职，下周可以到岗。",
    updatedAt: "2026-08-28T01:02:00.000Z"
  });
  assert.strictEqual(edited.currentText, "您好，我目前已经离职，下周可以到岗。");
  assert.strictEqual(edited.revision, 1);
  assert.strictEqual(db.prepare("SELECT count(*) AS n FROM candidate_answer_memories").get().n, 0, "autosave must not complete a memory");
  assert.strictEqual(db.prepare("SELECT count(*) AS n FROM candidate_facts").get().n, 0, "autosave must not update candidate facts");

  const adopted = completeMessageReplyDraft(db, {
    profileId: fixture.profileId,
    draftId: drafts[1].id,
    finalText: drafts[1].originalText,
    completionKind: "copied",
    scope: { kind: "global", key: "" },
    extractedFacts: [{ factKey: "availability_date", factValue: "一个月内", evidenceText: "一个月内" }],
    completedAt: "2026-08-28T01:03:00.000Z"
  });
  assert.strictEqual(adopted.source, "draft_adopted");
  assert.strictEqual(adopted.changed, false);
  assert.strictEqual(listCandidateFacts(db, fixture.profileId).length, 0, "unchanged model text must not become an authoritative fact");

  const firstCompletion = completeMessageReplyDraft(db, {
    profileId: fixture.profileId,
    draftId: drafts[0].id,
    finalText: edited.currentText,
    changedText: "已经离职，下周可以到岗",
    completionKind: "copied",
    scope: { kind: "global", key: "" },
    extractedFacts: [
      { factKey: "employment_status", factValue: "已离职", evidenceText: "已经离职" },
      { factKey: "availability_date", factValue: "下周", evidenceText: "下周可以到岗" }
    ],
    completedAt: "2026-08-28T01:04:00.000Z"
  });
  assert.strictEqual(firstCompletion.source, "user_edited_reply");
  assert.strictEqual(firstCompletion.changed, true);
  assert.deepStrictEqual(currentFacts(db, fixture.profileId), {
    availability_date: "下周",
    employment_status: "已离职"
  });

  const duplicate = completeMessageReplyDraft(db, {
    profileId: fixture.profileId,
    draftId: drafts[0].id,
    finalText: edited.currentText,
    changedText: "已经离职，下周可以到岗",
    completionKind: "sent",
    scope: { kind: "global", key: "" },
    extractedFacts: [
      { factKey: "employment_status", factValue: "已离职", evidenceText: "已经离职" },
      { factKey: "availability_date", factValue: "下周", evidenceText: "下周可以到岗" }
    ],
    completedAt: "2026-08-28T01:05:00.000Z"
  });
  assert.strictEqual(duplicate.id, firstCompletion.id, "same final draft must reuse the completed memory");
  assert.strictEqual(duplicate.completionKind, "sent", "sent is stronger completion evidence than copied");
  assert.strictEqual(listCandidateAnswerMemories(db, { profileId: fixture.profileId, activeOnly: false }).length, 2);
  assert.strictEqual(listCandidateFactRevisions(db, { profileId: fixture.profileId }).length, 2, "duplicate completion must not duplicate fact revisions");
  assert.strictEqual(listOpenMessageReplyDrafts(db, { profileId: fixture.profileId }).some((draft) => draft.id === drafts[0].id), false, "sent completion closes the draft");
  const staleClosedSave = saveMessageReplyDraftEdit(db, {
    profileId: fixture.profileId,
    draftId: drafts[0].id,
    text: "迟到的自动保存不得覆盖已发送内容",
    updatedAt: "2026-08-28T01:05:30.000Z"
  });
  assert.strictEqual(staleClosedSave.currentText, edited.currentText, "an autosave that returns after sent completion must not rewrite the closed draft");
  assert.strictEqual(staleClosedSave.revision, edited.revision, "a closed draft must not gain a stale autosave revision");

  const restoredDraft = recordMessageReplyDrafts(db, {
    profileId: fixture.profileId,
    cardId: fixture.cardId,
    jobId: fixture.jobId,
    messageGroupKey: digest("group-2"),
    questionSummary: "对方再次确认到岗时间。",
    messageIntent: "information_request",
    messageCategory: "availability",
    messages: ["您好，根据现有资料，你下周可以到岗。"],
    createdAt: "2026-08-28T01:06:00.000Z"
  })[0];
  const corrected = completeMessageReplyDraft(db, {
    profileId: fixture.profileId,
    draftId: restoredDraft.id,
    finalText: "您好，我需要两周完成交接，最快两周后到岗。",
    changedText: "需要两周完成交接，最快两周后到岗",
    completionKind: "copied",
    scope: { kind: "global", key: "" },
    extractedFacts: [{ factKey: "availability_date", factValue: "两周后", evidenceText: "两周后到岗" }],
    completedAt: "2026-08-28T01:07:00.000Z"
  });
  assert.strictEqual(currentFacts(db, fixture.profileId).availability_date, "两周后", "latest user correction must become current");
  assert.deepStrictEqual(
    listCandidateFactRevisions(db, { profileId: fixture.profileId, factKey: "availability_date" }).map((item) => item.factValue),
    ["两周后", "下周"],
    "older fact values must remain traceable"
  );

  const withdrawn = withdrawCandidateAnswerMemory(db, {
    profileId: fixture.profileId,
    memoryId: corrected.id,
    withdrawnAt: "2026-08-28T01:08:00.000Z"
  });
  assert(withdrawn.withdrawnAt);
  assert.strictEqual(currentFacts(db, fixture.profileId).availability_date, "下周", "withdrawing the latest answer must restore the newest remaining revision");
  assert.strictEqual(
    listCandidateAnswerMemories(db, { profileId: fixture.profileId, activeOnly: true, source: "user_edited_reply" })
      .some((memory) => memory.id === corrected.id),
    false,
    "withdrawn answers must not be returned as active memories"
  );
  assert.strictEqual(withdrawCandidateAnswerMemory(db, {
    profileId: fixture.profileId,
    memoryId: corrected.id,
    withdrawnAt: "2026-08-28T01:09:00.000Z"
  }).withdrawnAt, withdrawn.withdrawnAt, "withdraw must be idempotent");

  saveCandidateFact(db, {
    profileId: fixture.profileId,
    factKey: "current_city",
    factValue: "广州",
    source: "user_provided"
  });
  saveCandidateFact(db, {
    profileId: fixture.profileId,
    factKey: "current_city",
    factValue: "广州",
    source: "user_provided"
  });
  saveCandidateFact(db, {
    profileId: fixture.profileId,
    factKey: "current_city",
    factValue: "深圳",
    source: "user_provided"
  });
  assert.deepStrictEqual(
    listCandidateFactRevisions(db, { profileId: fixture.profileId, factKey: "current_city" }).map((item) => item.factValue),
    ["深圳", "广州"],
    "direct user facts must append only changed revisions"
  );

  const openBeforeClose = listOpenMessageReplyDrafts(db, { profileId: fixture.profileId });
  assert(openBeforeClose.some((draft) => draft.id === drafts[1].id), "copied unchanged draft remains available");
  closeMessageReplyDrafts(db, {
    profileId: fixture.profileId,
    cardId: fixture.cardId,
    closedAt: "2026-08-28T01:10:00.000Z"
  });
  assert.strictEqual(listOpenMessageReplyDrafts(db, { profileId: fixture.profileId }).length, 0);
  assert.strictEqual(getMessageReplyDraft(db, { profileId: fixture.profileId, draftId: drafts[0].id }).id, drafts[0].id, "closed drafts remain durable history");

  const other = createFixture(db, "other");
  assert.throws(
    () => saveMessageReplyDraftEdit(db, { profileId: other.profileId, draftId: drafts[0].id, text: "越权修改" }),
    (error) => error.code === "MESSAGE_REPLY_DRAFT_NOT_FOUND",
    "draft ownership must be enforced"
  );

  console.log("message_learning_store_smoke ok");
} finally {
  db.close();
}

function createFixture(database, suffix = "main") {
  const now = "2026-08-28T00:00:00.000Z";
  const profileId = Number(database.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES (?, '{}', NULL, ?, ?)`).run(`Candidate ${suffix}`, now, now).lastInsertRowid);
  const planId = Number(database.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, ?, '{}', NULL, 1, ?, ?)`).run(profileId, `Plan ${suffix}`, now, now).lastInsertRowid);
  const jobId = Number(database.prepare(`INSERT INTO jobs(
    source, source_id, title, first_seen_at, last_seen_at
  ) VALUES ('boss', ?, ?, ?, ?)`).run(`job-${suffix}`, `Job ${suffix}`, now, now).lastInsertRowid);
  const cardId = Number(database.prepare(`INSERT INTO candidate_progress_cards(
    profile_id, plan_id, job_id, source, stage, next_action, last_event_at, created_at, updated_at
  ) VALUES (?, ?, ?, 'boss', 'reply_ready', 'Review draft before manual send', ?, ?, ?)`)
    .run(profileId, planId, jobId, now, now, now).lastInsertRowid);
  return { profileId, planId, jobId, cardId };
}

function digest(value) {
  return `sha256:${require("node:crypto").createHash("sha256").update(value).digest("hex")}`;
}

function currentFacts(database, profileId) {
  return Object.fromEntries(listCandidateFacts(database, profileId).map((fact) => [fact.factKey, fact.factValue]));
}
