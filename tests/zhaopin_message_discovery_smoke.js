"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  openDb, createBatch, upsertJob, listOpenMessageReplyDrafts,
  listMessageInboundContexts, listSiteAccessEvents, getSitePacingState
} = require("../src/core/storage");
const { runBossMessageDiscovery, projectMessageDecisionCard } = require("../src/core/message_discovery");
const { ensureProgressCard, findMessageDiscoveryJobContext } = require("../src/core/candidate_progress");
const { zhaopinJobIdentity } = require("../src/core/zhaopin_search_scope");
const { createMessageDiscoveryController, createMessageDiscoveryDetailSafety } = require("../src/dashboard/message_discovery_controller");
const { safeDigest } = require("../src/adapters/sites/boss_message_dom");
const { createZhaopinMessageJobContextResolver } = require("../src/application/message_discovery/zhaopin_job_context");
const { listPreviewStates, listUnresolvedMessageDiscoveryItems, recordUnresolvedMessageDiscoveryItem } = require("../src/core/message_preview_state");

const NOW = "2026-09-08T08:00:00.000Z";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-zhaopin-message-"));
let db = openDb(path.join(root, "message-discovery.sqlite"));

async function run() {
  const offlineInput = { availability: "offline", analysis: { recommendation: "apply", fitLevel: "A" } };
  const offlineProjection = projectMessageDecisionCard(offlineInput);
  assert.equal(offlineProjection.availability, "offline");
  assert.equal(offlineProjection.opportunityVerdict, "职位已下线，以下资料用于理解这段沟通");
  assert.equal(offlineInput.analysis.recommendation, "apply", "source availability must not rewrite the frozen model decision");
  const fixture = createFixture();
  assert.equal(db.prepare("SELECT source_id FROM jobs WHERE id = ?").get(fixture.jobId).source_id, "ZL123456");
  assert.equal(findMessageDiscoveryJobContext(db, { profileId: fixture.profileId, planId: fixture.planId, platform: "zhaopin", sourceId: "ZL123456" }).contextComplete, true);
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
  assert.equal(summary.results[0].contextComplete, true);
  db.close();
  db = openDb(path.join(root, "message-discovery.sqlite"));
  const restored = createMessageDiscoveryController({ db });
  const recovered = restored.pageState(fixture.profileId).results[0];
  assert.equal(recovered.jobId, fixture.jobId);
  assert.equal(recovered.contextComplete, true, "producer identity must retain trusted context after database/controller restart");
  await restored.close();
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
  await inboundTransactionRollbackSmoke();
  await manualOnlyReopenSmoke();
  await crossPlatformIdempotencySmoke();
  await resolverIsolationSmoke();
  await zhaopinDetailControllerSmoke();
  await zhaopinFatalDetailRetentionSmoke();
  const regressions = [emptyTextPendingSmoke, unsupportedSelfPendingSmoke, pendingPacingSmoke, confirmedSelfBoundarySmoke];
  const failures = [];
  for (const regression of regressions) {
    try { await regression(); } catch (error) { failures.push(`${regression.name}: ${error.stack}`); }
  }
  assert.deepEqual(failures, []);
}

async function zhaopinFatalDetailRetentionSmoke() {
  const fixture = createFixture({ id: "ZLFATAL001", title: "Fatal Detail Engineer" });
  const conversationKey = safeDigest(["zhaopin", "fatal-detail"]);
  const sourceJobId = "zhaopin:ZLFATAL001";
  const reader = zhaopinReaderFor({
    conversationKey, sourceJobId, title: fixture.title,
    messages: [{ direction: "friend", messageId: "880001", text: "请介绍你的项目。", contentKind: "text" }]
  });
  const summary = await runBossMessageDiscovery({
    db, profileId: fixture.profileId, platform: "zhaopin", reader,
    classifyMessageGroup: async () => { throw new Error("fatal context must stop before drafting"); },
    resolveJobContext: async () => { throw Object.assign(new Error("background changed"), { code: "ZHAOPIN_MESSAGE_DETAIL_NOT_BACKGROUND" }); },
    now: () => NOW, sleepFn: async () => {}
  });
  assert.equal(summary.status, "needs_user_action");
  assert.equal(summary.reasonCode, "ZHAOPIN_MESSAGE_DETAIL_NOT_BACKGROUND");
  const retained = listUnresolvedMessageDiscoveryItems(db, { profileId: fixture.profileId, platform: "zhaopin" })[0];
  assert.deepEqual(retained.inboundMessages, [{ kind: "text", text: "请介绍你的项目。" }]);
  assert.equal(listOpenMessageReplyDrafts(db, { profileId: fixture.profileId }).length, 0);
}

async function zhaopinDetailControllerSmoke() {
  const safety = createMessageDiscoveryDetailSafety({
    db,
    profileId: 1,
    owner: "zhaopin-detail-safety",
    platform: "zhaopin",
    now: () => new Date(NOW),
    sleepFn: async () => {},
    randomFn: () => 0
  });
  await safety.beforeOpen({ jobId: "ZLSAFETY001", assertTabBindings: async () => {} });
  await safety.afterIssuedAttempt({ jobId: "ZLSAFETY001", assertTabBindings: async () => {} });
  assert.deepEqual(listSiteAccessEvents(db, { site: "zhaopin" }).slice(-2).map((event) => event.action), ["pane_detail_read", "detail_open"]);
  assert.equal(getSitePacingState(db, "zhaopin").pacing.detailActions, 1);

  const fixture = createFixture({ id: "ZLCONTROLLER001", title: "Controller Engineer" });
  const created = [];
  const controller = createMessageDiscoveryController({
    db,
    modelReady: () => true,
    getModelConfig: () => ({ provider: "fixture" }),
    acquireLease: () => {}, renewLease: () => {}, releaseLease: () => {},
    createBrowser: async () => ({
      async listTabs() { return [{ id: 202, windowId: 7, active: false, url: "https://i.zhaopin.com/im" }]; }
    }),
    cleanupBrowser: async () => {},
    createReader: ({ platform }) => ({ platform, async readSelectedJobTarget() { return {}; } }),
    createDetailSafety: ({ platform }) => {
      created.push(["safety", platform]);
      return { beforeOpen: async () => {}, afterIssuedAttempt: async () => {} };
    },
    createDetailReader: ({ platform, messageReader }) => {
      created.push(["detail", platform, messageReader.platform]);
      return { readSelectedJobDetail: async () => ({}) };
    },
    createJobContextResolver: ({ platform, detailReader }) => {
      created.push(["resolver", platform, Boolean(detailReader)]);
      return async () => ({});
    },
    runDiscovery: async ({ platform }) => ({ status: "completed", reasonCode: "", queued: 0, processed: 0, unresolved: 0, counters: { platform }, results: [] }),
    setInterval: () => 1,
    clearInterval: () => {},
    now: () => new Date(NOW)
  });
  controller.start(fixture.profileId);
  for (let attempt = 0; attempt < 10 && created.length < 3; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await controller.close();
  assert.deepEqual(created, [["safety", "zhaopin"], ["detail", "zhaopin", "zhaopin"], ["resolver", "zhaopin", true]]);
}

async function emptyTextPendingSmoke() {
  await pendingContentSmoke("ZL880001", [{ direction: "friend", messageId: "880001", contentKind: "text", text: "  " }]);
}

async function unsupportedSelfPendingSmoke() {
  await pendingContentSmoke("ZL880002", [
    { direction: "friend", messageId: "880001", contentKind: "text", text: "原先保留的 HR 问题" },
    { direction: "myself", messageId: "880002", contentKind: "unsupported", text: "" }
  ]);
}

async function pendingContentSmoke(id, messages) {
  const fixture = createFixture({ id });
  const conversationKey = safeDigest(["pending-content", id]);
  const sourceJobId = `zhaopin:${id}`;
  const original = [{ kind: "text", text: "原先保留的 HR 问题" }];
  recordUnresolvedMessageDiscoveryItem(db, { profileId: fixture.profileId, platform: "zhaopin", conversationKey,
    previewDigest: safeDigest(["old", id]), previewKind: "possible_hr_reply", reasonCode: "ZHAOPIN_MESSAGE_CONTENT_PENDING",
    observedAt: NOW, sourceJobId, lastMessageId: "880001", inboundMessages: original, identity: { positionTitle: fixture.title } });
  let classified = 0;
  const summary = await runBossMessageDiscovery({ db, profileId: fixture.profileId, platform: "zhaopin",
    reader: zhaopinReaderFor({ conversationKey, sourceJobId, title: fixture.title, messages }),
    classifyMessageGroup: async () => { classified++; return classification(["合成草稿"]); },
    resolveJobContext: createZhaopinMessageJobContextResolver({ db, profileId: fixture.profileId, now: () => NOW }), now: () => NOW, sleepFn: async () => {} });
  assert.equal(classified, 0);
  assert.equal(summary.status, "needs_user_action");
  assert.equal(summary.processed, 0);
  assert.equal(listPreviewStates(db, { profileId: fixture.profileId, platform: "zhaopin" }).length, 0);
  const pending = listUnresolvedMessageDiscoveryItems(db, { profileId: fixture.profileId, platform: "zhaopin" });
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].inboundMessages, original);
  assert.equal(pending[0].reasonCode, "ZHAOPIN_MESSAGE_CONTENT_PENDING");
}

async function pendingPacingSmoke() {
  const fixture = createFixture({ id: "ZL880003" });
  const rows = Array.from({ length: 11 }, (_, rowIndex) => ({ rowIndex, unread: true, identityVerified: true,
    conversationKey: safeDigest(["pending-pace", rowIndex]), previewDigest: safeDigest(["pending-preview", rowIndex]),
    previewKind: "possible_hr_reply", sourceJobId: `zhaopin:ZL8801${rowIndex}`, lastMessageId: "880003", lastMessageDirection: "friend" }));
  for (const row of rows) seedCompleteContext({ profileId: fixture.profileId, planId: fixture.planId,
    source: "zhaopin", sourceId: row.sourceJobId.slice(8), key: `pace-${row.rowIndex}` });
  const opened = [], waits = [], events = [];
  const reader = { async scanConversationRows() { return { tabId: 12, rows }; },
    async openQueuedConversation(target) { opened.push(target.rowIndex); events.push("open"); return { sourceJobId: target.sourceJobId, lastMessageId: "880003",
      messages: [{ direction: "friend", messageId: "880003", contentKind: "unsupported", text: "" }] }; } };
  const options = { db, profileId: fixture.profileId, platform: "zhaopin", reader,
    classifyMessageGroup: async () => { throw Error("unsupported must not classify"); },
    resolveJobContext: createZhaopinMessageJobContextResolver({ db, profileId: fixture.profileId, now: () => NOW }), now: () => NOW,
    randomFn: () => waits.length % 2 ? 0.9 : 0.1,
    sleepFn: async (ms) => { waits.push(ms); events.push("wait"); } };
  const result = await runBossMessageDiscovery(options);
  assert.equal(result.unresolved, 11);
  assert.equal(opened.length, 11);
  assert.deepEqual(waits, [1600, 2400, 1600, 2400, 1600, 2400, 1600, 2400, 1600, 2400, 15000]);
  assert.deepEqual(events.slice(0, 4), ["open", "wait", "open", "wait"]);
  opened.length = 0;
  const controller = new AbortController();
  await assert.rejects(() => runBossMessageDiscovery({ ...options, signal: controller.signal,
    sleepFn: async () => { controller.abort(); } }), error => error.name === "AbortError");
  assert.equal(opened.length, 1, "stop during pacing must prevent the next conversation open");
}

async function confirmedSelfBoundarySmoke() {
  const fixture = createFixture({ id: "ZL880004" });
  const conversationKey = safeDigest(["confirmed-self"]);
  const messages = [
    { direction: "friend", messageId: "880004", contentKind: "text", text: "已回复的问题" },
    { direction: "myself", messageId: "880005", contentKind: "text", text: "实际回复" },
    { direction: "platform", messageId: "880006", contentKind: "platform_notice", text: "系统提示" }
  ];
  const summary = await runBossMessageDiscovery({ db, profileId: fixture.profileId, platform: "zhaopin",
    reader: zhaopinReaderFor({ conversationKey, sourceJobId: "zhaopin:ZL880004", title: fixture.title, messages }),
    classifyMessageGroup: async () => { throw Error("actual self reply must bound prior HR text"); },
    resolveJobContext: createZhaopinMessageJobContextResolver({ db, profileId: fixture.profileId, now: () => NOW }), now: () => NOW, sleepFn: async () => {} });
  assert.equal(summary.status, "completed");
  assert.equal(summary.processed, 0);
  assert.equal(listPreviewStates(db, { profileId: fixture.profileId, platform: "zhaopin" }).length, 1);
}

async function crossPlatformIdempotencySmoke() {
  const fixture = createFixture({ id: "ZL777003", title: "Shared Id Engineer" });
  const conversationKey = safeDigest(["same-conversation", "777003"]);
  const messageId = "123456789012345";
  const zhaopinReader = zhaopinReaderFor({ conversationKey, sourceJobId: "zhaopin:ZL777003", title: fixture.title, messages: [
    { direction: "friend", messageId, text: "智联问题。", contentKind: "text" }
  ] });
  const bossBatchId = createBatch(db, "boss", "boss-shared-id", "boss shared id fixture", { profileId: fixture.profileId, searchPlanId: fixture.planId });
  const bossJobId = upsertJob(db, {
    source: "boss", sourceId: "boss:shared777", keyword: "boss-shared-id", title: "Shared Id Engineer",
    company: "Boss Fixture Co", location: "Shanghai", salary: "20-30K", experience: "3-5年", education: "本科",
    bossActiveText: "", url: "https://www.zhipin.com/job_detail/shared777.html", tags: [],
    description: "可信 BOSS 职位描述。".repeat(20), qualityTags: [], analysis: { semanticStatus: "complete", recommendation: "primary" }
  }, bossBatchId);
  ensureProgressCard(db, { profileId: fixture.profileId, planId: fixture.planId, jobId: bossJobId, source: "boss", now: NOW });
  const bossReader = {
    async scanConversationRows() { return { tabId: 13, rows: [{ rowIndex: 0, unread: true, conversationKey,
      previewDigest: safeDigest(["boss", "shared-preview"]), previewKind: "possible_hr_reply", sourceJobId: "boss:shared777",
      lastMessageId: messageId, lastMessageDirection: "friend", identityVerified: true }] }; },
    async openQueuedConversation() { return { headerText: "Recruiter", positionName: "Shared Id Engineer", companyName: "Boss Fixture Co", salary: "20-30K", city: "Shanghai", messages: [{ direction: "friend", messageId, text: "BOSS 问题。", contentKind: "text" }] }; }
  };
  const runZl = () => runBossMessageDiscovery({ db, profileId: fixture.profileId, platform: "zhaopin", reader: zhaopinReader,
    classifyMessageGroup: async () => classification(["智联草稿。"]), resolveJobContext: createZhaopinMessageJobContextResolver({ db, profileId: fixture.profileId, now: () => NOW }), now: () => NOW, sleepFn: async () => {} });
  const runBoss = () => runBossMessageDiscovery({ db, profileId: fixture.profileId, reader: bossReader,
    classifyMessageGroup: async () => classification(["BOSS 草稿。"]), now: () => NOW, sleepFn: async () => {} });
  await runZl();
  await runBoss();
  const eventsBefore = db.prepare("SELECT count(*) AS n FROM candidate_progress_events WHERE card_id IN (SELECT id FROM candidate_progress_cards WHERE profile_id = ?)").get(fixture.profileId).n;
  const idempotencyKeys = db.prepare("SELECT idempotency_key FROM candidate_progress_events WHERE card_id IN (SELECT id FROM candidate_progress_cards WHERE profile_id = ?)").all(fixture.profileId).map((row) => row.idempotency_key);
  assert(idempotencyKeys.some((key) => key.startsWith("message:zhaopin:")));
  assert(idempotencyKeys.some((key) => key.startsWith("message:boss:")));
  assert.equal(listPreviewStates(db, { profileId: fixture.profileId, platform: "zhaopin" }).filter((item) => item.conversationKey === conversationKey).length, 1);
  assert.equal(listPreviewStates(db, { profileId: fixture.profileId, platform: "boss" }).filter((item) => item.conversationKey === conversationKey).length, 1);
  assert.equal(listOpenMessageReplyDrafts(db, { profileId: fixture.profileId }).length, 2);
  await runZl();
  await runBoss();
  assert.equal(db.prepare("SELECT count(*) AS n FROM candidate_progress_events WHERE card_id IN (SELECT id FROM candidate_progress_cards WHERE profile_id = ?)").get(fixture.profileId).n, eventsBefore);
  assert.equal(listOpenMessageReplyDrafts(db, { profileId: fixture.profileId }).length, 2);
}

async function resolverIsolationSmoke() {
  const profileId = Number(db.prepare("INSERT INTO candidate_profiles(display_name, profile_json, source_hash, created_at, updated_at) VALUES ('Resolver isolation', '{}', NULL, ?, ?)").run(NOW, NOW).lastInsertRowid);
  const activePlanId = Number(db.prepare("INSERT INTO search_plans(profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at) VALUES (?, 'Active', '{}', NULL, 1, ?, ?)").run(profileId, NOW, NOW).lastInsertRowid);
  const inactivePlanId = Number(db.prepare("INSERT INTO search_plans(profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at) VALUES (?, 'Inactive', '{}', NULL, 0, ?, ?)").run(profileId, NOW, NOW).lastInsertRowid);
  const sourceId = "ZL777004";
  seedCompleteContext({ profileId, planId: inactivePlanId, source: "zhaopin", sourceId, key: "inactive" });
  seedCompleteContext({ profileId, planId: activePlanId, source: "boss", sourceId, key: "foreign-source" });
  const otherProfileId = Number(db.prepare("INSERT INTO candidate_profiles(display_name, profile_json, source_hash, created_at, updated_at) VALUES ('Other profile', '{}', NULL, ?, ?)").run(NOW, NOW).lastInsertRowid);
  const otherPlanId = Number(db.prepare("INSERT INTO search_plans(profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at) VALUES (?, 'Other', '{}', NULL, 1, ?, ?)").run(otherProfileId, NOW, NOW).lastInsertRowid);
  seedCompleteContext({ profileId: otherProfileId, planId: otherPlanId, source: "zhaopin", sourceId, key: "foreign-profile" });
  const resolver = createZhaopinMessageJobContextResolver({ db, profileId, now: () => NOW });
  const target = { sourceJobId: `zhaopin:${sourceId}`, conversationKey: safeDigest(["zhaopin", "resolver-isolation"]) };
  await assert.rejects(() => resolver({ target }), (error) => error.code === "MESSAGE_DISCOVERY_JOB_CONTEXT_UNAVAILABLE");
  assert.equal(db.prepare("SELECT count(*) AS n FROM candidate_progress_cards WHERE profile_id = ?").get(profileId).n, 0);
  assert.equal(listOpenMessageReplyDrafts(db, { profileId }).length, 0);
  seedCompleteContext({ profileId, planId: activePlanId, source: "zhaopin", sourceId, key: "correct" });
  const resolved = await resolver({ target });
  assert.equal(resolved.contextSource, "local_cache");
  assert.equal(resolved.job.source, "zhaopin");
  assert.equal(db.prepare("SELECT count(*) AS n FROM candidate_progress_cards WHERE profile_id = ?").get(profileId).n, 1);
}

function seedCompleteContext({ profileId, planId, source, sourceId, key }) {
  const batchId = createBatch(db, source, `resolver-${key}`, `resolver ${key}`, { profileId, searchPlanId: planId });
  return upsertJob(db, { source, sourceId, keyword: `resolver-${key}`, title: `Resolver ${key}`, company: "Resolver Co", location: "Shanghai", salary: "20-30K", experience: "3-5年", education: "本科", bossActiveText: "", url: `https://example.test/${key}`, tags: [], description: "可信职位描述。".repeat(20), qualityTags: [], analysis: { semanticStatus: "complete", recommendation: "primary" } }, batchId);
}

async function inboundTransactionRollbackSmoke() {
  const fixture = createFixture({ id: "ZL777001", title: "Rollback Engineer" });
  const conversationKey = safeDigest(["zhaopin", "rollback-session"]);
  const reader = zhaopinReaderFor({
    conversationKey, sourceJobId: "zhaopin:ZL777001", title: fixture.title,
    messages: [{ direction: "friend", messageId: "777001", text: "请介绍项目经验。", contentKind: "text" }]
  });
  db.exec(`CREATE TRIGGER fail_zhaopin_inbound_context
    BEFORE INSERT ON message_inbound_contexts
    BEGIN SELECT RAISE(ABORT, 'zhaopin inbound fixture failure'); END;`);
  await assert.rejects(
    () => runBossMessageDiscovery({
      db, profileId: fixture.profileId, platform: "zhaopin", reader,
      classifyMessageGroup: async () => classification(["我可以介绍项目经验。"]),
      resolveJobContext: createZhaopinMessageJobContextResolver({ db, profileId: fixture.profileId, now: () => NOW }), now: () => NOW, sleepFn: async () => {}
    }),
    /zhaopin inbound fixture failure/
  );
  assert.equal(db.prepare("SELECT count(*) AS n FROM candidate_progress_events WHERE card_id IN (SELECT id FROM candidate_progress_cards WHERE profile_id = ?)").get(fixture.profileId).n, 0);
  assert.equal(listOpenMessageReplyDrafts(db, { profileId: fixture.profileId }).length, 0);
  assert.equal(listMessageInboundContexts(db, { profileId: fixture.profileId }).length, 0);
  assert.equal(listPreviewStates(db, { profileId: fixture.profileId, platform: "zhaopin" }).length, 0);
  db.exec("DROP TRIGGER fail_zhaopin_inbound_context");
  const retried = await runBossMessageDiscovery({
    db, profileId: fixture.profileId, platform: "zhaopin", reader,
    classifyMessageGroup: async () => classification(["我可以介绍项目经验。"]),
    resolveJobContext: createZhaopinMessageJobContextResolver({ db, profileId: fixture.profileId, now: () => NOW }), now: () => NOW, sleepFn: async () => {}
  });
  assert.equal(retried.processed, 1);
  assert.equal(listOpenMessageReplyDrafts(db, { profileId: fixture.profileId }).length, 1);
}

async function manualOnlyReopenSmoke() {
  const fixture = createFixture({ id: "ZL777002", title: "Manual Resume Engineer" });
  const conversationKey = safeDigest(["zhaopin", "manual-session"]);
  const reader = zhaopinReaderFor({
    conversationKey, sourceJobId: "zhaopin:ZL777002", title: fixture.title,
    messages: [{ direction: "friend", messageId: "777002", text: "HR 邀请你发送简历", contentKind: "resume_request" }]
  });
  const summary = await runBossMessageDiscovery({
    db, profileId: fixture.profileId, platform: "zhaopin", reader,
    classifyMessageGroup: async () => { throw new Error("resume request must not call the model"); },
    resolveJobContext: createZhaopinMessageJobContextResolver({ db, profileId: fixture.profileId, now: () => NOW }), now: () => NOW, sleepFn: async () => {}
  });
  assert.equal(summary.processed, 1);
  assert.equal(listOpenMessageReplyDrafts(db, { profileId: fixture.profileId }).length, 0);
  db.close();
  db = openDb(path.join(root, "message-discovery.sqlite"));
  const context = listMessageInboundContexts(db, { profileId: fixture.profileId })[0];
  assert.equal(context.platform, "zhaopin");
  assert.deepEqual(context.manualActions, [{ kind: "resume_request" }]);
  assert.deepEqual(context.inboundMessages, [{ kind: "resume_request", text: "HR 邀请你发送简历" }]);
}

function zhaopinReaderFor({ conversationKey, sourceJobId, title, messages }) {
  return {
    async scanConversationRows() { return { tabId: 12, rows: [{ rowIndex: 0, unread: true, conversationKey,
      previewDigest: safeDigest(["zhaopin", "fixture", sourceJobId]), previewKind: "possible_hr_reply",
      sourceJobId, lastMessageId: String(messages.at(-1).messageId), lastMessageDirection: "friend", identityVerified: true }] }; },
    async openQueuedConversation() { return { sourceJobId, lastMessageId: String(messages.at(-1).messageId), positionName: title, companyName: "Zhaopin Fixture Co", salary: "20-30K", city: "Shanghai", messages }; }
  };
}

function classification(messages) {
  return { messageIntent: "information_request", messageCategory: "other", messageSummary: "项目经验确认", missingFact: null, progressUpdate: { stage: "reply_ready" }, messages };
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
  let failTimeline = true;
  const reader = {
    async scanConversationRows() {
      return { tabId: 10, rows: [{ rowIndex: 0, unread: true, conversationKey,
        previewDigest: safeDigest(["zhaopin", "unresolved-preview"]), previewKind: "possible_hr_reply",
        sourceJobId: "zhaopin:ZL999999", lastMessageId: "901001", lastMessageDirection: "friend", identityVerified: true }] };
    },
    async openQueuedConversation() {
      if (failTimeline) throw Object.assign(new Error("timeline failed"), { code: "ZHAOPIN_MESSAGE_TIMELINE_FAILED" });
      return { sourceJobId: "zhaopin:ZL999999", lastMessageId: "901001", positionName: "No cached JD", companyName: "Unknown Co", salary: "", city: "",
        messages: [{ direction: "friend", messageId: "901001", text: "请介绍项目经验。", contentKind: "text" }] };
    }
  };
  const timelineFailed = await runBossMessageDiscovery({ db, profileId, platform: "zhaopin", reader, classifyMessageGroup: async () => { throw new Error("must not classify without cached context"); }, now: () => NOW, sleepFn: async () => {} });
  assert.equal(timelineFailed.reasonCode, "ZHAOPIN_MESSAGE_TIMELINE_FAILED");
  const firstTimelinePending = listUnresolvedMessageDiscoveryItems(db, { profileId, platform: "zhaopin" })[0];
  assert.equal(firstTimelinePending.reasonCode, "ZHAOPIN_MESSAGE_TIMELINE_FAILED");
  assert.equal("inboundMessages" in firstTimelinePending, false);
  assert.equal(listPreviewStates(db, { profileId, platform: "zhaopin" }).length, 0, "timeline failure must not advance the preview baseline");
  assert.equal(db.prepare("SELECT count(*) AS n FROM candidate_progress_cards c JOIN jobs j ON j.id = c.job_id WHERE c.profile_id = ? AND j.source = 'zhaopin'").get(profileId).n, 0, "timeline failure must not create a fake job");
  failTimeline = false;
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
  reader.openQueuedConversation = async () => { throw Object.assign(new Error("timeline failed again"), { code: "ZHAOPIN_MESSAGE_TIMELINE_FAILED" }); };
  const stopped = await runBossMessageDiscovery({ db, profileId, platform: "zhaopin", reader, classifyMessageGroup: async () => { throw new Error("must not classify without cached context"); }, now: () => NOW, sleepFn: async () => {} });
  assert.equal(stopped.reasonCode, "ZHAOPIN_MESSAGE_TIMELINE_FAILED");
  const afterFailure = listUnresolvedMessageDiscoveryItems(db, { profileId, platform: "zhaopin" })[0];
  assert.deepEqual(afterFailure.inboundMessages, first.inboundMessages);
  assert.equal(afterFailure.positionTitle, first.positionTitle);
  assert.equal(afterFailure.sourceJobId, first.sourceJobId);
  const batchId = createBatch(db, "zhaopin", "zhaopin-retry", "zhaopin retry fixture", { profileId, searchPlanId: planId });
  recordUnresolvedMessageDiscoveryItem(db, {
    profileId, platform: "boss", conversationKey,
    previewDigest: safeDigest(["boss", "unresolved-preview"]), previewKind: "possible_hr_reply",
    reasonCode: "BOSS_MESSAGE_CARD_NOT_FOUND", observedAt: NOW, identity: { positionTitle: "BOSS unresolved" }
  });
  upsertJob(db, {
    ...zhaopinJobIdentity("https://www.zhaopin.com/jobdetail/ZL999999.htm"), keyword: "zhaopin-retry",
    title: "No cached JD", company: "Unknown Co", location: "Shanghai", salary: "20-30K",
    experience: "3-5年", education: "本科", bossActiveText: "",
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

function createFixture({ id = "ZL123456", title = "Zhaopin Engineer" } = {}) {
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
    ...zhaopinJobIdentity(`https://www.zhaopin.com/jobdetail/${id}.htm`),
    keyword: "zhaopin-message",
    title,
    company: "Zhaopin Fixture Co",
    location: "Shanghai",
    salary: "20-30K",
    experience: "3-5年",
    education: "本科",
    bossActiveText: "",
    tags: [],
    description: "完整可信的智联职位描述。".repeat(20),
    qualityTags: [],
    analysis: { semanticStatus: "complete", recommendation: "primary" }
  }, batchId);
  return { profileId, planId, jobId, title };
}

run().then(() => console.log("zhaopin message discovery smoke passed")).finally(() => {
  try { db.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
});
