"use strict";

const assert = require("node:assert/strict");
const { openDb, createBatch, upsertJob, listOpenMessageReplyDrafts } = require("../src/core/storage");
const { runBossMessageDiscovery } = require("../src/core/message_discovery");
const { safeDigest } = require("../src/adapters/sites/boss_message_dom");
const { createZhaopinMessageJobContextResolver } = require("../src/application/message_discovery/zhaopin_job_context");
const { listUnresolvedMessageDiscoveryItems } = require("../src/core/message_preview_state");

const NOW = "2026-09-08T08:00:00.000Z";
const db = openDb(":memory:");

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
            Object.freeze({ direction: "platform", messageId: "900000", text: "系统提示", contentKind: "platform_notice" }),
            Object.freeze({ direction: "friend", messageId: "900001", text: "请介绍一下你的项目。", contentKind: "text" }),
            Object.freeze({ direction: "friend", messageId: "900002", text: "也请说明负责范围。", contentKind: "text" }),
            Object.freeze({ direction: "friend", messageId: "900003", text: "HR 邀请你发送简历", contentKind: "resume_request" })
          ])
        });
      }
    },
    classifyMessageGroup: async () => ({
      messageIntent: "information_request",
      messageCategory: "qualification",
      messageSummary: "招聘方正在确认项目经验。",
      missingFact: null,
      progressUpdate: { stage: "reply_ready" },
      messages: ["我负责过相关项目的交付。", "我可以补充具体负责范围。"]
    }),
    resolveJobContext: createZhaopinMessageJobContextResolver({ db, profileId: fixture.profileId, now: () => NOW }),
    now: () => NOW,
    sleepFn: async () => {}
  });

  assert.equal(summary.processed, 1);
  assert.equal(listOpenMessageReplyDrafts(db, { profileId: fixture.profileId }).length, 2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM candidate_funnel_entries f JOIN jobs j ON j.id = f.job_id WHERE j.source = 'boss'").get().n, 0);
  await unresolvedDisplaySmoke();
}

async function unresolvedDisplaySmoke() {
  const profileId = Number(db.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES (?, '{}', NULL, ?, ?)`)
    .run("Zhaopin unresolved fixture", NOW, NOW).lastInsertRowid);
  db.prepare(`INSERT INTO search_plans(profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at)
    VALUES (?, 'Zhaopin unresolved plan', '{}', NULL, 1, ?, ?)`)
    .run(profileId, NOW, NOW);
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
  reader.openQueuedConversation = async () => ({ sourceJobId: "zhaopin:ZL000000", lastMessageId: "901002", positionName: "No cached JD", companyName: "Unknown Co", messages: [] });
  await runBossMessageDiscovery({ db, profileId, platform: "zhaopin", reader, classifyMessageGroup: async () => { throw new Error("must not classify without cached context"); }, now: () => NOW, sleepFn: async () => {} });
  const retained = listUnresolvedMessageDiscoveryItems(db, { profileId, platform: "zhaopin" })[0];
  assert.deepEqual(retained.inboundMessages, first.inboundMessages);
  assert.equal(retained.sourceJobId, first.sourceJobId);
  assert.equal(listOpenMessageReplyDrafts(db, { profileId }).length, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM jobs WHERE source = 'zhaopin'").get().n, 1, "only the resolved fixture job may exist");
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

run().then(() => console.log("zhaopin message discovery smoke passed")).finally(() => db.close());
