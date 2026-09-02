"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const {
  openDb,
  recordMessageReplyDrafts,
  listOpenMessageReplyDrafts,
  saveMessageInboundContext,
  getMessageInboundContext,
  createMessageReplySendBatch
} = require("../src/core/storage");
const { createMessageFollowUpService } = require("../src/application/message_follow_up");

const NOW = "2026-09-03T08:00:00.000Z";
const CONVERSATION_KEY = digest("follow-up-conversation");
const FIRST_MESSAGE_ID = "378917037748760";
const NEXT_MESSAGE_ID = "378917037748761";

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const db = openDb(":memory:");
  try {
    const fixture = createFixture(db);
    let generated = 0;
    const service = createMessageFollowUpService({
      db,
      now: () => NOW,
      generateDraft: async ({ previousOutboundText, candidate }) => {
        generated += 1;
        assert.equal(previousOutboundText, "您好，想了解这个岗位。");
        assert.equal(candidate.jobId, fixture.jobId);
        return {
          messages: ["您好，想再确认一下这个岗位目前是否仍在推进。"],
          missingFact: null
        };
      }
    });

    assert.deepEqual(
      service.listCandidates({ profileId: fixture.profileId, planId: fixture.planId })
        .map((item) => item.jobId),
      [fixture.jobId]
    );
    const required = service.requireCandidate({
      profileId: fixture.profileId,
      planId: fixture.planId,
      jobId: fixture.jobId
    });
    assert.equal(required.card.id, fixture.cardId);
    assert.equal(required.job.sourceId, fixture.sourceJobId);

    const ordinaryGroup = digest("ordinary-reply");
    const ordinaryDraft = recordMessageReplyDrafts(db, {
      profileId: fixture.profileId,
      cardId: fixture.cardId,
      jobId: fixture.jobId,
      messageGroupKey: ordinaryGroup,
      questionSummary: "招聘方问题已分类",
      messageIntent: "general_communication",
      messageCategory: "other",
      messages: ["您好，感谢您的消息。"],
      createdAt: "2026-09-03T07:00:00.000Z"
    })[0];
    saveMessageInboundContext(db, {
      profileId: fixture.profileId,
      cardId: fixture.cardId,
      messageGroupKey: ordinaryGroup,
      conversationKey: CONVERSATION_KEY,
      sourceJobId: fixture.sourceJobId,
      lastMessageId: "378917037748750",
      messageIntent: "general_communication",
      messageCategory: "other",
      inboundMessages: [{ kind: "text", text: "方便了解一下吗？" }],
      manualActions: [],
      createdAt: "2026-09-03T07:00:00.000Z",
      updatedAt: "2026-09-03T07:00:00.000Z"
    });

    const first = await service.savePreparedDraft({
      profileId: fixture.profileId,
      planId: fixture.planId,
      jobId: fixture.jobId,
      snapshot: snapshot(fixture.sourceJobId, FIRST_MESSAGE_ID)
    });
    assert.equal(first.draft.messageIntent, "follow_up");
    assert.equal(first.draft.currentText, "您好，想再确认一下这个岗位目前是否仍在推进。");
    assert.equal(first.context.lastMessageId, FIRST_MESSAGE_ID);
    assert.deepEqual(first.context.inboundMessages, [
      { kind: "text", text: "您好，想了解这个岗位。" }
    ]);
    assert.equal(generated, 1);

    const repeated = await service.savePreparedDraft({
      profileId: fixture.profileId,
      planId: fixture.planId,
      jobId: fixture.jobId,
      snapshot: snapshot(fixture.sourceJobId, FIRST_MESSAGE_ID)
    });
    assert.equal(repeated.draft.id, first.draft.id, "same immutable baseline must reuse the open draft");
    assert.equal(generated, 1, "repeated preparation must not call the model again");

    const refreshed = await service.savePreparedDraft({
      profileId: fixture.profileId,
      planId: fixture.planId,
      jobId: fixture.jobId,
      snapshot: snapshot(fixture.sourceJobId, NEXT_MESSAGE_ID)
    });
    assert.notEqual(refreshed.draft.id, first.draft.id);
    assert.equal(generated, 2);
    const openDrafts = listOpenMessageReplyDrafts(db, { profileId: fixture.profileId, cardId: fixture.cardId });
    assert(openDrafts.some((draft) => draft.id === ordinaryDraft.id), "refreshing follow-up must not close an HR reply draft");
    assert(openDrafts.some((draft) => draft.id === refreshed.draft.id));
    assert(!openDrafts.some((draft) => draft.id === first.draft.id));
    assert.equal(getMessageInboundContext(db, {
      profileId: fixture.profileId,
      cardId: fixture.cardId,
      messageGroupKey: first.draft.messageGroupKey
    }), null, "obsolete follow-up snapshot must be purged");

    const failingService = createMessageFollowUpService({
      db,
      now: () => NOW,
      generateDraft: async () => { throw Object.assign(new Error("model unavailable"), { code: "MODEL_UNAVAILABLE" }); }
    });
    await assert.rejects(
      failingService.savePreparedDraft({
        profileId: fixture.profileId,
        planId: fixture.planId,
        jobId: fixture.jobId,
        snapshot: snapshot(fixture.sourceJobId, "378917037748762")
      }),
      (error) => error.code === "MODEL_UNAVAILABLE"
    );
    assert(listOpenMessageReplyDrafts(db, { profileId: fixture.profileId, cardId: fixture.cardId })
      .some((draft) => draft.id === refreshed.draft.id), "model failure must preserve the previous open draft");

    await assert.rejects(
      service.savePreparedDraft({
        profileId: fixture.profileId,
        planId: fixture.planId,
        jobId: fixture.jobId,
        snapshot: { ...snapshot(fixture.sourceJobId, "378917037748763"), lastMessageDirection: "friend" }
      }),
      (error) => error.code === "FOLLOW_UP_CONVERSATION_CHANGED"
    );
    assert.equal(generated, 2, "HR reply must be rejected before model generation");

    const activeSend = createMessageReplySendBatch(db, {
      profileId: fixture.profileId,
      items: [{ draftId: refreshed.draft.id, revision: refreshed.draft.revision }],
      createdAt: NOW
    });
    assert.deepEqual(
      service.listCandidates({ profileId: fixture.profileId, planId: fixture.planId }),
      [],
      "a follow-up already frozen in an unfinished batch must leave the candidate list"
    );
    db.prepare("UPDATE message_reply_send_items SET status = 'stopped' WHERE batch_id = ?")
      .run(activeSend.batch.id);
    assert.equal(service.listCandidates({ profileId: fixture.profileId, planId: fixture.planId }).length, 1);

    const other = createProfileAndPlan(db, "other");
    assert.throws(
      () => service.requireCandidate({ profileId: other.profileId, planId: fixture.planId, jobId: fixture.jobId }),
      (error) => error.code === "FOLLOW_UP_NOT_ELIGIBLE"
    );

    db.prepare(`INSERT INTO candidate_progress_events(
      card_id, idempotency_key, type, actor, summary, metadata_json, occurred_at, created_at
    ) VALUES (?, ?, 'follow_up_sent', 'system', '跟进已发送', '{}', ?, ?)`)
      .run(fixture.cardId, "follow-up-sent:test", NOW, NOW);
    assert.deepEqual(service.listCandidates({ profileId: fixture.profileId, planId: fixture.planId }), []);

    console.log("message_follow_up_service_smoke ok");
  } finally {
    db.close();
  }
}

function createFixture(db) {
  const { profileId, planId } = createProfileAndPlan(db, "main");
  const sourceJobId = "boss:follow-up-job-1";
  const batchId = Number(db.prepare(`INSERT INTO batches(
    site, keyword, started_at, note, profile_id, search_plan_id, filter_snapshot_json,
    status, finished_at, stop_code, stop_message
  ) VALUES ('boss', '运营', ?, '', ?, ?, '{}', 'completed', ?, NULL, NULL)`)
    .run("2026-08-25T06:00:00.000Z", profileId, planId, "2026-08-25T06:10:00.000Z").lastInsertRowid);
  const analysis = {
    semanticStatus: "complete",
    recommendation: "primary",
    recommendationSchemaVersion: 2,
    confidence: 0.9
  };
  const jobId = Number(db.prepare(`INSERT INTO jobs(
    source, source_id, title, company, location, salary, analysis_json,
    first_seen_at, last_seen_at, batch_id
  ) VALUES ('boss', ?, '内容运营', '示例公司', '广州', '10-15K', ?, ?, ?, ?)`)
    .run(sourceJobId, JSON.stringify(analysis), "2026-08-25T06:00:00.000Z", "2026-08-25T06:00:00.000Z", batchId).lastInsertRowid);
  db.prepare(`INSERT INTO job_observations(
    job_id, batch_id, keyword, title, company, location, salary, tags_json,
    description, score, matches_json, risks_json, quality_tags_json, greeting,
    analysis_json, content_hash, content_hash_version, seen_at
  ) VALUES (?, ?, '运营', '内容运营', '示例公司', '广州', '10-15K', '[]', ?, 88, '[]', '[]', '[]', ?, ?, ?, 1, ?)`)
    .run(
      jobId,
      batchId,
      "负责内容策划、用户运营和数据复盘。".repeat(8),
      "您好，想了解这个岗位。",
      JSON.stringify(analysis),
      createHash("sha256").update("job-observation").digest("hex"),
      "2026-08-25T06:00:00.000Z"
    );
  db.prepare(`INSERT INTO candidate_job_states(
    profile_id, job_id, plan_id, status, reason_code, note, review_at, updated_at
  ) VALUES (?, ?, ?, 'applied', 'communication_succeeded', '', NULL, ?)`)
    .run(profileId, jobId, planId, "2026-08-25T07:00:00.000Z");
  const cardId = Number(db.prepare(`INSERT INTO candidate_progress_cards(
    profile_id, plan_id, job_id, source, recruiter_name, thread_key, stage,
    next_action, scheduled_at, last_event_at, created_at, updated_at
  ) VALUES (?, ?, ?, 'boss', '', ?, 'waiting_reply', '等待招聘方回复', NULL, ?, ?, ?)`)
    .run(
      profileId,
      planId,
      jobId,
      CONVERSATION_KEY,
      "2026-08-25T07:00:00.000Z",
      "2026-08-25T07:00:00.000Z",
      "2026-08-25T07:00:00.000Z"
    ).lastInsertRowid);
  db.prepare(`INSERT INTO candidate_funnel_entries(
    profile_id, job_id, card_id, cohort_id, plan_id, strategy_round_id, source_kind,
    started_at, mature_at, direction_key, decision_bucket, resume_version_id,
    greeting_key, created_at, updated_at
  ) VALUES (?, ?, ?, NULL, ?, NULL, 'communication', ?, ?, '运营', 'primary', NULL, ?, ?, ?)`)
    .run(
      profileId,
      jobId,
      cardId,
      planId,
      "2026-08-25T07:00:00.000Z",
      "2026-08-27T07:00:00.000Z",
      digest("greeting"),
      "2026-08-25T07:00:00.000Z",
      "2026-08-25T07:00:00.000Z"
    );
  db.prepare(`INSERT INTO candidate_progress_events(
    card_id, idempotency_key, type, actor, summary, metadata_json, occurred_at, created_at
  ) VALUES (?, 'progress:11111111-1111-4111-8111-111111111111',
    'outbound_delivered_observed', 'system', '消息已送达', '{}', ?, ?)`)
    .run(cardId, "2026-08-25T07:00:00.000Z", "2026-08-25T07:00:00.000Z");
  return { profileId, planId, jobId, cardId, sourceJobId };
}

function createProfileAndPlan(db, suffix) {
  const at = "2026-08-25T06:00:00.000Z";
  const profileId = Number(db.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, is_ready, created_at, updated_at
  ) VALUES (?, '{}', NULL, 1, ?, ?)`)
    .run(`Candidate ${suffix}`, at, at).lastInsertRowid);
  const planId = Number(db.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, ?, '{}', NULL, 1, ?, ?)`)
    .run(profileId, `Plan ${suffix}`, at, at).lastInsertRowid);
  return { profileId, planId };
}

function snapshot(sourceJobId, lastMessageId) {
  return {
    conversationKey: CONVERSATION_KEY,
    sourceJobId,
    lastMessageId,
    lastMessageDirection: "myself",
    previousOutboundText: "您好，想了解这个岗位。"
  };
}

function digest(value) {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
}
