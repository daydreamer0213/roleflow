"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDb, createBatch, upsertJob, listOpenMessageReplyDrafts } = require("../src/core/storage");
const { runBossMessageDiscovery } = require("../src/core/message_discovery");
const { safeDigest } = require("../src/adapters/sites/boss_message_dom");
const { createZhaopinMessageJobContextResolver } = require("../src/application/message_discovery/zhaopin_job_context");
const { listPreviewStates, listUnresolvedMessageDiscoveryItems, recordUnresolvedMessageDiscoveryItem } = require("../src/core/message_preview_state");

const NOW = "2026-09-08T08:00:00.000Z";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-zhaopin-message-"));
let db = openDb(path.join(root, "message-discovery.sqlite"));

async function run() {
  const fixture = createFixture();
  const conversationKey = safeDigest(["zhaopin", "session-1"]);
  const sourceJobId = "zhaopin:ZL123456";
  const summary = await runBossMessageDiscovery({
    db,
    profileId: fixture.profileId,
    platform: "zhaopin",
    reader: {
      async scanConversationRows() {
        return {
          tabId: 9,
          rows: [{
            rowIndex: 0,
            unread: true,
            conversationKey,
            previewDigest: safeDigest(["zhaopin", "preview-1"]),
            previewKind: "possible_hr_reply",
            sourceJobId,
            lastMessageId: "900001",
            lastMessageDirection: "friend",
            identityVerified: true
          }]
        };
      },
      async openQueuedConversation() {
        return Object.freeze({
          skipped: false,
          sourceJobId,
          lastMessageId: "900003",
          positionName: "Zhaopin Engineer",
          companyName: "Zhaopin Fixture Co",
          salary: "20-30K",
          city: "Shanghai",
          messages: Object.freeze([
            Object.freeze({ direction: "friend", messageId: "900001", text: "请介绍一下你的项目。", contentKind: "text" }),
            Object.freeze({ direction: "friend", messageId: "900002", text: "也请说明负责范围。", contentKind: "text" }),
            Object.freeze({ direction: "friend", messageId: "900003", text: "HR 邀请你发送简历", contentKind: "resume_request" }),
            Object.freeze({ direction: "platform", messageId: "900004", text: "系统提示", contentKind: "platform_notice" })
          ])
        });
      }
    },
    classifyMessageGroup: async ({ messages }) => {
      assert.deepEqual(messages.map((item) => item.text), ["请介绍一下你的项目。", "也请说明负责范围。"]);
      return {
      messageIntent: "information_request",
      messageCategory: "qualification",
      messageSummary: "招聘方正在确认项目经验。",
      missingFact: null,
      progressUpdate: { stage: "reply_ready" },
      messages: ["我负责过相关项目的交付。", "我可以补充具体负责范围。"]
      };
    },
    resolveJobContext: createZhaopinMessageJobContextResolver({ db, profileId: fixture.profileId, now: () => NOW }),
    now: () => NOW,
    sleepFn: async () => {}
  });

  assert.equal(summary.processed, 1);
  assert.equal(listOpenMessageReplyDrafts(db, { profileId: fixture.profileId }).length, 2);
  assert.deepEqual(summary.results[0].inboundMessages, [
    { kind: "text", text: "请介绍一下你的项目。" },
    { kind: "text", text: "也请说明负责范围。" },
    { kind: "resume_request", text: "HR 邀请你发送简历" }
  ]);
  assert.deepEqual(summary.results[0].manualActions, [{ kind: "resume_request" }]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM candidate_funnel_entries f JOIN jobs j ON j.id = f.job_id WHERE j.source = 'zhaopin'").get().n, 0);
  const baseline = listPreviewStates(db, { profileId: fixture.profileId, platform: "zhaopin" })[0];
  const emptySummary = await runBossMessageDiscovery({
    db, profileId: fixture.profileId, platform: "zhaopin",
    reader: {
      async scanConversationRows() { return { tabId: 9, rows: [{ rowIndex: 0, unread: true, conversationKey,
        previewDigest: safeDigest(["zhaopin", "preview-empty"]), previewKind: "possible_hr_reply", sourceJobId, lastMessageId: "900005", lastMessageDirection: "friend", identityVerified: true }] }; },
      async openQueuedConversation() { return { sourceJobId, lastMessageId: "900005", positionName: "Zhaopin Engineer", companyName: "Zhaopin Fixture Co", messages: [] }; }
    },
    classifyMessageGroup: async () => { throw new Error("empty ZL content must remain pending"); },
    resolveJobContext: createZhaopinMessageJobContextResolver({ db, profileId: fixture.profileId, now: () => NOW }), now: () => NOW, sleepFn: async () => {}
  });
  assert.equal(emptySummary.status, "needs_user_action");
  assert.equal(listPreviewStates(db, { profileId: fixture.profileId, platform: "zhaopin" })[0].previewDigest, baseline.previewDigest);
  assert.equal(listUnresolvedMessageDiscoveryItems(db, { profileId: fixture.profileId, platform: "zhaopin" }).length, 1);
  await unresolvedDisplaySmoke();
}

async function unresolvedDisplaySmoke() {
  const profileId = Number(db.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES (?, '{}', NULL, ?, ?)`)
    .run("Zhaopin unresolved fixture", NOW, NOW).lastInsertRowid);
  const planId = Number(db.prepare(`INSERT INTO search_plans(profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at)
    VALUES (?, 'Zhaopin unresolved plan', '{}', NULL, 1, ?, ?)`)
    .run(profileId, NOW, NOW).lastInsertRowid);
  const conversationKey = safeDigest(["zhaopin", "unresolved-session"]);
  const reader = {
    async scanConversationRows() {
      return { tabId: 10, rows: [{ rowIndex: 0, unread: true, conversationKey,
        previewDigest: safeDigest(["zhaopin", "unresolved-preview"]), previewKind: "possible_hr_reply",
        sourceJobId: "zhaopin:ZL999999", lastMessageId: "901001", lastMessageDirection: "friend", identityVerified: true }] };
    },
    async openQueuedConversation() {
      return { sourceJobId: "zhaopin:ZL999999", lastMessageId: "901001", positionName: "No cached JD", companyName: "Unknown Co", salary: "", city: "",
        messages: [{ direction: "friend", messageId: "901001", text: "请介绍项目经验。", contentKind: "text" }] };
    }
  };
  await runBossMessageDiscovery({ db, profileId, platform: "zhaopin", reader, classifyMessageGroup: async () => { throw new Error("must not classify without cached context"); }, now: () => NOW, sleepFn: async () => {} });
  const first = listUnresolvedMessageDiscoveryItems(db, { profileId, platform: "zhaopin" })[0];
  assert.deepEqual(first.inboundMessages, [{ kind: "text", text: "请介绍项目经验。" }]);
  assert.equal(first.sourceJobId, "zhaopin:ZL999999");
  assert.equal(first.positionTitle, "No cached JD");
  db.close();
  db = openDb(path.join(root, "message-discovery.sqlite"));
  const reopened = listUnresolvedMessageDiscoveryItems(db, { profileId, platform: "zhaopin" })[0];
  assert.deepEqual(reopened.inboundMessages, first.inboundMessages);
  assert.equal(reopened.sourceJobId, first.sourceJobId);
  reader.openQueuedConversation = async () => ({ sourceJobId: "zhaopin:ZL000000", lastMessageId: "901002", positionName: "Changed title", companyName: "Changed Co", messages: [] });
  await runBossMessageDiscovery({ db, profileId, platform: "zhaopin", reader, classifyMessageGroup: async () => { throw new Error("must not classify without cached context"); }, now: () => NOW, sleepFn: async () => {} });
  const retained = listUnresolvedMessageDiscoveryItems(db, { profileId, platform: "zhaopin" })[0];
  assert.deepEqual(retained.inboundMessages, first.inboundMessages);
  assert.equal(retained.sourceJobId, first.sourceJobId);
  assert.equal(retained.positionTitle, first.positionTitle);
  assert.equal(listOpenMessageReplyDrafts(db, { profileId }).length, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM jobs WHERE source = 'zhaopin'").get().n, 1, "only the resolved fixture job may exist");
  reader.openQueuedConversation = async () => { throw Object.assign(new Error("timeline pending"), { code: "ZHAOPIN_MESSAGE_CONTENT_PENDING" }); };
  const stopped = await runBossMessageDiscovery({ db, profileId, platform: "zhaopin", reader, classifyMessageGroup: async () => { throw new Error("must not classify without cached context"); }, now: () => NOW, sleepFn: async () => {} });
  assert.equal(stopped.reasonCode, "ZHAOPIN_MESSAGE_CONTENT_PENDING");
  const afterFailure = listUnresolvedMessageDiscoveryItems(db, { profileId, platform: "zhaopin" })[0];
  assert.deepEqual(afterFailure.inboundMessages, first.inboundMessages);
  assert.equal(afterFailure.positionTitle, first.positionTitle);
  const batchId = createBatch(db, "zhaopin", "zhaopin-retry", "zhaopin retry fixture", { profileId, searchPlanId: planId });
  recordUnresolvedMessageDiscoveryItem(db, {
    profileId, platform: "boss", conversationKey,
    previewDigest: safeDigest(["boss", "unresolved-preview"]), previewKind: "possible_hr_reply",
    reasonCode: "BOSS_MESSAGE_CARD_NOT_FOUND", observedAt: NOW, identity: { positionTitle: "BOSS unresolved" }
  });
  upsertJob(db, {
    source: "zhaopin", sourceId: "zhaopin:ZL999999", keyword: "zhaopin-retry",
    title: "No cached JD", company: "Unknown Co", location: "Shanghai", salary: "20-30K",
    experience: "3-5年", education: "本科", bossActiveText: "", url: "https://www.zhaopin.com/job/ZL999999.html",
    tags: [], description: "可信智联职位描述。".repeat(20), qualityTags: [],
    analysis: { semanticStatus: "complete", recommendation: "primary" }
  }, batchId);
  reader.openQueuedConversation = async () => ({ sourceJobId: "zhaopin:ZL999999", lastMessageId: "901001", positionName: "No cached JD", companyName: "Unknown Co", salary: "20-30K", city: "Shanghai", messages: [
    { direction: "friend", messageId: "901001", text: "请介绍项目经验。", contentKind: "text" }
  ] });
  const retried = await runBossMessageDiscovery({
    db, profileId, platform: "zhaopin", reader,
    classifyMessageGroup: async () => ({ messageIntent: "information_request", messageCategory: "other", messageSummary: "项目经验确认", missingFact: null, progressUpdate: { stage: "reply_ready" }, messages: ["我可以介绍相关项目经验。"] }),
    resolveJobContext: createZhaopinMessageJobContextResolver({ db, profileId, now: () => NOW }), now: () => NOW, sleepFn: async () => {}
  });
  assert.equal(retried.processed, 1);
  assert.equal(listUnresolvedMessageDiscoveryItems(db, { profileId, platform: "zhaopin" }).length, 0);
  assert.equal(listUnresolvedMessageDiscoveryItems(db, { profileId, platform: "boss" }).length, 1);
}

function createFixture() {
  const profileId = Number(db.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES (?, '{}', NULL, ?, ?)`)
    .run("Zhaopin message fixture", NOW, NOW).lastInsertRowid);
  const planId = Number(db.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, ?, '{}', NULL, 1, ?, ?)`)
    .run(profileId, "Zhaopin message plan", NOW, NOW).lastInsertRowid);
  const batchId = createBatch(db, "zhaopin", "zhaopin-message", "zhaopin message fixture", {
    profileId,
    searchPlanId: planId
  });
  const jobId = upsertJob(db, {
    source: "zhaopin",
    sourceId: "zhaopin:ZL123456",
    keyword: "zhaopin-message",
    title: "Zhaopin Engineer",
    company: "Zhaopin Fixture Co",
    location: "Shanghai",
    salary: "20-30K",
    experience: "3-5年",
    education: "本科",
    bossActiveText: "",
    url: "https://www.zhaopin.com/job/ZL123456.html",
    tags: [],
    description: "完整可信的智联职位描述。".repeat(20),
    qualityTags: [],
    analysis: { semanticStatus: "complete", recommendation: "primary" }
  }, batchId);
  return { profileId, planId, jobId };
}

run().then(() => console.log("zhaopin message discovery smoke passed")).finally(() => {
  try { db.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
});
