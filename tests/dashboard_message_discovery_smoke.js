const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const vm = require("node:vm");
const {
  openDb,
  saveProfileAnalysis,
  createBatch,
  createScanRun,
  beginScanRun,
  checkpointScanProgress,
  finishScanRun,
  upsertJob,
  acquireSiteScanLease,
  releaseSiteScanLease,
  getSiteRuntimeState,
  setSiteRuntimeState,
  clearSiteRuntimeState,
  listSiteAccessEvents,
  recordMessageReplyDrafts,
  saveMessageInboundContext,
  getMessageInboundContext,
  closeMessageReplyDrafts
} = require("../src/core/storage");
const {
  ensureProgressCard,
  transitionProgressCard,
  listProgressCardsWithEvents
} = require("../src/core/candidate_progress");
const {
  recordUnresolvedMessageDiscoveryItem,
  listUnresolvedMessageDiscoveryItems,
  getMessageDiscoveryRuntimeState,
  saveMessageDiscoveryRuntimeState
} = require("../src/core/message_preview_state");
const { createDashboardServer } = require("../src/dashboard/server");
const {
  createMessageDiscoveryController,
  createMessageDiscoveryDetailSafety
} = require("../src/dashboard/message_discovery_controller");
const {
  messageDiscoveryReasonText,
  messageIntentLabel
} = require("../src/dashboard/message_discovery_view");
const { installDashboardSignalHandlers, persistBossRiskControl } = require("../src/cli");
const { communicationRuntimeBlock } = require("../src/core/communication_runtime");

const PRIVATE_BODY = "脱敏测试问题";
const PRIVATE_PREVIEW = "脱敏会话预览";
const PRIVATE_RECRUITER = "脱敏招聘方";
const PRIVATE_DRAFT = "PRIVATE_DISCOVERY_DRAFT";
const OPEN_HR_TEXT = "方便介绍一下跨境电商项目吗？";
const RESUME_REQUEST_SUMMARY = "HR 邀请你发送简历";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-dashboard-messages-"));
const dbPath = path.join(root, "dashboard-messages.sqlite");
const db = openDb(dbPath);
const logs = [];
const logger = {
  info(event, fields) { logs.push([event, fields]); },
  warn(event, fields) { logs.push([event, fields]); },
  error(event, fields) { logs.push([event, fields]); },
  requestId() { return "dashboard-message-discovery-smoke"; },
  listRecent() { return []; }
};
let server;

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function main() {
  durableDraftRecoverySmoke();
  await controllerBrowserAuthoritySmoke();
  await detailSafetyCompositionSmoke();
  await dashboardSignalShutdownSmoke();
  const fixture = createFixture();
  await modelReadinessGateSmoke(db, root, dbPath, logger, fixture.profileId);
  await browserRuntimeGateSmoke(db, root, dbPath, logger, fixture.profileId);
  const scenarios = [];
  const cleanupTimers = controllableTimers();
  const browsers = [];
  let discoveryBrowserAuthority = null;
  let discoveryReaderBrowser = null;
  const readerCalls = [];
  const reader = {
    async scanConversationRows() {
      readerCalls.push("scan");
      return {
        tabId: "fake-tab",
        path: "/web/geek/chat",
        rows: Object.freeze([0, 1].map((index) => Object.freeze({
          rowIndex: index,
          unread: true,
          selected: false,
          conversationKey: `sha256:${"a".repeat(63)}${index}`,
          previewDigest: `sha256:${"b".repeat(64)}`,
          previewKind: "possible_hr_reply",
          transientSignature: `sha256:${"c".repeat(64)}`
        })))
      };
    },
    async openQueuedConversation(target, signal) {
      throwIfAborted(signal);
      readerCalls.push(`open:${target.rowIndex}`);
      return { rowIndex: target.rowIndex };
    }
  };
  let browserCreations = 0;
  let cleanupFailure = null;
  let nowMs = Date.parse("2026-07-31T01:00:00.000Z");
  server = createDashboardServer({
    db,
    browserAuthority: { browserMode: "portable", cdpPort: 9222, profilePath: path.join(root, "portable-edge-profile") },
    root,
    dbPath,
    forceMock: true,
    logger,
    browserFactory({ browserMode, cdpPort }) {
      browserCreations += 1;
      discoveryBrowserAuthority = { browserMode, cdpPort };
      const browser = { kind: "fake-browser", cleanupCalls: 0 };
      browsers.push(browser);
      return browser;
    },
    messageDiscoveryDependencies: {
      async cleanupBrowser(browser) {
        browser.cleanupCalls += 1;
        if (cleanupFailure) {
          const error = cleanupFailure;
          cleanupFailure = null;
          throw error;
        }
      },
      createReader(input) {
        discoveryReaderBrowser = input.browser;
        return reader;
      },
      createDetailSafety() {
        return { beforeOpen: async () => {}, afterIssuedAttempt: async () => {} };
      },
      createDetailReader() {
        return { readSelectedJobDetail: async () => ({}) };
      },
      createJobContextResolver() {
        return async () => ({});
      },
      async runDiscovery(context) {
        const scenario = scenarios.shift();
        assert(scenario, "an injected discovery scenario is required");
        return scenario(context);
      },
      leaseHeartbeatMs: 5,
      now: () => new Date(nowMs),
      setTimeout: cleanupTimers.setTimeout,
      clearTimeout: cleanupTimers.clearTimeout
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const page = await request(base, `/messages?profileId=${fixture.profileId}`);
  assert.strictEqual(page.status, 200);
  assert(page.body.includes("开始只读发现"));
  assert(page.body.includes("人工粘贴"));
  assert(!page.body.includes("自动发送"));
  assert(!page.body.includes(".chat-input"));
  assert(!page.body.includes(".btn-send"));
  assert(!page.body.includes('name="hrMessage"'));
  assertMessageDiscoveryProductFrame(page.body, fixture);
  await messageDiscoveryClientResponseSmoke(page.body);
  await messageDiscoveryFormActionSmoke(page.body);
  await messageDiscoveryDuplicateSubmitSmoke(page.body);
  await messageDiscoveryPollingSmoke(page.body);
  await messageDiscoveryMalformedResponseSmoke(page.body);
  await messageDiscoveryActionPollRaceSmoke(page.body);
  await messageDiscoveryAcceptedActionStopsPollSmoke(page.body);

  const riskAtMs = nowMs - 47 * 60 * 60_000;
  persistBossRiskControl(db, {
    site: "boss",
    runId: "message-discovery-recovery-floor",
    error: Object.assign(new Error("BOSS risk control"), {
      code: "BOSS_RISK_CONTROL",
      blockedUntil: new Date(riskAtMs + 60 * 60_000).toISOString()
    }),
    nowMs: riskAtMs
  });
  let response = await postJson(base, "/api/message-discovery", {
    action: "start",
    profileId: fixture.profileId
  });
  assert.strictEqual(response.status, 409);
  assert.strictEqual(response.body.errorCode, "BOSS_RISK_CONTROL");
  assert.strictEqual(browserCreations, 0, "recovery floor must stop before browser creation");
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) AS count FROM site_scan_leases WHERE site = 'boss'").get().count,
    0,
    "recovery floor must stop before lease acquisition"
  );
  clearSiteRuntimeState(db, "boss");

  acquireSiteScanLease(db, {
    site: "boss",
    owner: "external-scan",
    command: "daily",
    planId: fixture.planId
  });
  response = await postJson(base, "/api/message-discovery", {
    action: "start",
    profileId: fixture.profileId
  });
  assert.strictEqual(response.status, 409);
  assert.strictEqual(browserCreations, 0, "lease conflict must stop before browser creation");
  releaseSiteScanLease(db, { site: "boss", owner: "external-scan" });

  db.exec(`
    CREATE TEMP TABLE lease_renew_audit(value INTEGER);
    CREATE TEMP TRIGGER lease_renew_audit_trigger
    AFTER UPDATE ON site_scan_leases
    BEGIN
      INSERT INTO lease_renew_audit(value) VALUES (1);
    END
  `);
  const unrelatedJobId = upsertJob(db, {
    source: "boss",
    sourceId: "unrelated-manual-draft",
    title: "无关的历史草稿岗位"
  });
  const unrelatedCard = ensureProgressCard(db, {
    profileId: fixture.profileId,
    planId: fixture.planId,
    jobId: unrelatedJobId,
    source: "boss"
  });
  transitionProgressCard(db, {
    cardId: unrelatedCard.id,
    expectedStage: "contact_started",
    stage: "reply_ready",
    nextAction: "等待用户手动发送"
  });
  const firstPending = controlledPendingRun();
  scenarios.push(firstPending.run);
  response = await postJson(base, "/api/message-discovery", {
    action: "start",
    profileId: fixture.profileId
  });
  assert.strictEqual(response.status, 202);
  await firstPending.started;
  assert.deepStrictEqual(
    discoveryBrowserAuthority,
    { browserMode: "portable", cdpPort: 9222 },
    "message discovery must use the frozen dedicated Edge browser authority"
  );
  assert.strictEqual(
    discoveryReaderBrowser,
    browsers[0],
    "message discovery controller must pass the supplied browser-factory sentinel to the reader"
  );
  assert.strictEqual(
    db.prepare("SELECT command FROM site_scan_leases WHERE site = 'boss'").get().command,
    "discover-messages"
  );
  await waitFor(() => db.prepare("SELECT COUNT(*) AS count FROM lease_renew_audit").get().count > 0);

  response = await postForm(base, "/api/progress", {
    cardId: unrelatedCard.id,
    idempotencyKey: requestKey(900),
    action: "reply_confirmed_sent"
  });
  assert.strictEqual(response.status, 303);
  let runningStatus = await getStatus(base, fixture.profileId);
  assert.strictEqual(runningStatus.status, "running", "confirming an unrelated old draft must not unregister the active discovery run");

  response = await postJson(base, "/api/message-discovery", {
    action: "start",
    profileId: fixture.profileId
  });
  assert.strictEqual(response.status, 409);
  assert.strictEqual(browserCreations, 1, "duplicate run must stop before browser creation");

  response = await postJson(base, "/api/message-discovery", {
    action: "stop",
    profileId: fixture.profileId
  });
  assert.strictEqual(response.status, 202);
  await waitForStatus(base, fixture.profileId, "stopped");
  assert.deepStrictEqual(readerCalls, ["scan", "open:0"], "stop must abort before the next click");
  await waitForLeaseRelease();
  assert.strictEqual(browsers.at(-1).cleanupCalls, 1, "abort must clean up its browser exactly once");

  scenarios.push(failedRun());
  response = await postJson(base, "/api/message-discovery", {
    action: "start",
    profileId: fixture.profileId
  });
  assert.strictEqual(response.status, 202);
  await waitForStatus(base, fixture.profileId, "stopped");
  await waitForLeaseRelease();
  assert.strictEqual(browsers.at(-1).cleanupCalls, 1, "runner failure must clean up its browser exactly once");

  scenarios.push(riskControlRun());
  response = await postJson(base, "/api/message-discovery", {
    action: "start",
    profileId: fixture.profileId
  });
  assert.strictEqual(response.status, 202);
  await waitForStatus(base, fixture.profileId, "needs_user_action");
  await waitForLeaseRelease();
  const riskRuntime = getSiteRuntimeState(db, "boss");
  const riskEvent = listSiteAccessEvents(db, { site: "boss", action: "risk_control" }).at(-1);
  const riskOccurredAtMs = Date.parse(riskEvent.createdAt);
  assert.strictEqual(riskRuntime.reasonCode, "BOSS_RISK_CONTROL");
  assert.strictEqual(
    riskEvent.details.errorCode,
    "BOSS_RISK_CONTROL"
  );
  assert.strictEqual(riskRuntime.details.blockedUntil, riskEvent.details.blockedUntil);
  assert.strictEqual(Date.parse(riskEvent.details.blockedUntil) - riskOccurredAtMs, 48 * 60 * 60_000);
  assert(communicationRuntimeBlock(db, { nowMs: riskOccurredAtMs + 47 * 60 * 60_000 }));
  assert.strictEqual(communicationRuntimeBlock(db, { nowMs: riskOccurredAtMs + 49 * 60 * 60_000 }), null);
  clearSiteRuntimeState(db, "boss");

  scenarios.push(unmatchedRun());
  let status = await startAndWait(base, fixture.profileId, "needs_user_action");
  assert.strictEqual(status.unresolved, 1);
  assert.strictEqual(status.reasonCode, "BOSS_MESSAGE_CARD_NOT_FOUND");
  assertNoPrivateData(status);
  const unresolvedPage = await request(base, `/messages?profileId=${fixture.profileId}`);
  assert(unresolvedPage.body.includes("\u672a\u89e3\u51b3 1"), "the page must show the truthful unresolved count");
  assertNoPrivateData(unresolvedPage.body);
  await waitForLeaseRelease();

  const openMessageGroupKey = `sha256:${"9".repeat(64)}`;
  const renderedDraft = recordMessageReplyDrafts(db, {
    profileId: fixture.profileId,
    cardId: fixture.card.id,
    jobId: fixture.jobId,
    messageGroupKey: openMessageGroupKey,
    questionSummary: "对方正在确认候选人的任职资格。",
    messageIntent: "information_request",
    messageCategory: "qualification",
    messages: [PRIVATE_DRAFT],
    createdAt: "2026-07-31T01:00:00.000Z"
  })[0];
  saveMessageInboundContext(db, {
    profileId: fixture.profileId,
    cardId: fixture.card.id,
    messageGroupKey: openMessageGroupKey,
    conversationKey: `sha256:${"8".repeat(64)}`,
    sourceJobId: "boss:dashboard-message-job",
    lastMessageId: "378917037748761",
    messageIntent: "information_request",
    messageCategory: "qualification",
    inboundMessages: [{ kind: "text", text: OPEN_HR_TEXT }],
    manualActions: [],
    createdAt: "2026-07-31T01:00:00.000Z",
    updatedAt: "2026-07-31T01:00:00.000Z"
  });
  scenarios.push(completedRun({
    fixture,
    drafts: [PRIVATE_DRAFT],
    durableDrafts: [renderedDraft],
    inboundMessages: [{ kind: "text", text: OPEN_HR_TEXT }],
    callModel: true
  }));
  response = await postJson(base, "/api/message-discovery", {
    action: "start",
    profileId: fixture.profileId
  });
  assert.strictEqual(response.status, 202);
  status = await waitForStatus(base, fixture.profileId, "completed");
  assert.strictEqual(cleanupTimers.activeCount(), 1);
  assert.strictEqual(cleanupTimers.latest().delay, 30 * 60 * 1000);
  assert.deepStrictEqual(Object.keys(status).sort(), [
    "expiresAt",
    "phase",
    "processed",
    "profileId",
    "queued",
    "reasonCode",
    "results",
    "startedAt",
    "status",
    "unresolved",
    "updatedAt",
    "waitUntil"
  ]);
  assert.deepStrictEqual(Object.keys(status.results[0]).sort(), [
    "cardId",
    "jobId",
    "messageCategory",
    "missingFactKey",
    "stage"
  ]);
  assert(!Object.hasOwn(status.results[0], "messageSummary"));
  assert(!Object.hasOwn(status.results[0], "messageIntent"));
  assert(!JSON.stringify(status).includes("PRIVATE_MESSAGE_SUMMARY"));
  assertNoPrivateData(status);
  await waitForLeaseRelease();
  assert.strictEqual(browsers.at(-1).cleanupCalls, 1, "successful discovery must clean up its browser exactly once");

  const completedPage = await request(base, `/messages?profileId=${fixture.profileId}`);
  assert.strictEqual(completedPage.status, 200);
  assert(completedPage.body.includes(PRIVATE_DRAFT));
  assert(completedPage.body.includes("HR 消息"));
  assert(completedPage.body.includes(OPEN_HR_TEXT));
  assert(!completedPage.body.includes("工作安排：工作安排未确认"));
  assert.match(completedPage.body, new RegExp(`data-send-single="${renderedDraft.id}"`));
  assert.match(completedPage.body, new RegExp(`data-send-select="${renderedDraft.id}"`));
  assert.match(completedPage.body, new RegExp(`data-draft-revision="${renderedDraft.revision}"`));
  assertManualProgressRemainsOrdinary(completedPage.body);
  assertNoPrivateData(completedPage.body);
  const diagnosticsResponse = await request(base, "/api/runtime-diagnostics");
  assert.strictEqual(diagnosticsResponse.status, 200);
  assert(!diagnosticsResponse.body.includes(OPEN_HR_TEXT), "HR display text must stay out of runtime diagnostics");

  response = await postJson(base, "/api/message-discovery", {
    action: "dismiss",
    profileId: fixture.profileId
  });
  assert.strictEqual(response.status, 200);
  status = await getStatus(base, fixture.profileId);
  assert.strictEqual(status.status, "dismissed");
  assert.deepStrictEqual(status.results, []);
  assert.strictEqual(getMessageInboundContext(db, {
    profileId: fixture.profileId,
    cardId: fixture.card.id,
    messageGroupKey: openMessageGroupKey
  }), null, "dismiss must purge the closed draft's HR display context");
  assert.strictEqual(cleanupTimers.activeCount(), 0, "dismiss must clear the cleanup timer");

  cleanupFailure = new Error("fake browser cleanup failed");
  scenarios.push(completedRun({ fixture, drafts: ["清理失败后仍成功的草稿"] }));
  status = await startAndWait(base, fixture.profileId, "completed");
  await waitForLeaseRelease();
  assert.strictEqual(browsers.at(-1).cleanupCalls, 1, "cleanup hook must run exactly once when it throws");
  status = await getStatus(base, fixture.profileId);
  assert.strictEqual(status.status, "completed", "cleanup failure must not overwrite a successful discovery status");

  scenarios.push(multiResultCompletedRun(fixture));
  await startAndWait(base, fixture.profileId, "completed");
  status = await getStatus(base, fixture.profileId);
  const cappedPage = await request(base, `/messages?profileId=${fixture.profileId}`);
  assert(cappedPage.body.includes("运行额度草稿一"));
  assert(cappedPage.body.includes("运行额度草稿二"));
  assert(cappedPage.body.includes("岗位一草稿二"));
  assert(cappedPage.body.includes("岗位二草稿二"));
  assert(!cappedPage.body.includes("岗位一草稿三"), "each job must be capped at two drafts");
  assert(!cappedPage.body.includes("岗位二草稿三"), "each job must be capped at two drafts");
  assertNoDraftMessagesInJson(status);
  const staleTimerId = cleanupTimers.latest().id;
  await waitForLeaseRelease();

  scenarios.push(jobUnderstandingCompletedRun(fixture));
  await startAndWait(base, fixture.profileId, "completed");
  status = await getStatus(base, fixture.profileId);
  assertNoDraftMessagesInJson(status);
  const understoodPage = await request(base, `/messages?profileId=${fixture.profileId}`);
  assert(understoodPage.body.includes("AI 应用开发工程师"));
  for (const expected of [
    "结论",
    "需要你补充信息",
    "正式面试邀约",
    "这份机会",
    "可以了解，但要先确认关键问题",
    "对方正在确认候选人的任职资格。",
    "岗位主要做什么",
    "把企业知识转成可追溯的智能问答能力",
    "公司做什么",
    "JD 显示该岗位服务于企业知识管理。",
    "匹配度",
    "中",
    "薪资",
    "15-25K·13薪",
    "薪资未说明",
    "下一步",
    "需要在 BOSS 人工处理附件简历请求",
    "请在 BOSS 消息卡片中人工选择“同意”或“拒绝”。",
    "推荐回复",
    "HR 消息",
    OPEN_HR_TEXT,
    RESUME_REQUEST_SUMMARY,
    "岗位理解",
    "工作安排：双休",
    "您好，感谢邀请，请问面试时间和形式如何安排？",
    "JD 暂未说明公司的具体业务。"
  ]) assert(understoodPage.body.includes(expected), `missing user decision content: ${expected}`);
  assert(
    understoodPage.body.indexOf("<h4>需要在 BOSS 人工处理附件简历请求</h4>")
      < understoodPage.body.indexOf("<h4>推荐回复</h4>"),
    "manual BOSS action must appear before the local reply drafts"
  );
  assertHeadingsInOrder(understoodPage.body, [
    "<h3>HR 消息</h3>",
    "<h3>岗位理解</h3>",
    "<h3>结论</h3>",
    "<h3>这份机会</h3>",
    "<h3>岗位主要做什么</h3>",
    "<h3>公司做什么</h3>",
    "<h3>匹配度</h3>",
    "<h3>薪资</h3>",
    "<h3>下一步</h3>"
  ]);
  assert(
    understoodPage.body.indexOf('class="message-inbound"')
      < understoodPage.body.indexOf('class="message-job-understanding"'),
    "HR message must appear before job understanding"
  );
  assert(
    understoodPage.body.indexOf('class="message-job-understanding"')
      < understoodPage.body.indexOf('class="message-draft"'),
    "job understanding must appear before reply drafts"
  );
  for (const rawValue of ["interview_invitation", "information_request", "manual_review"]) {
    assert(!understoodPage.body.includes(rawValue), `raw intent must stay out of markup: ${rawValue}`);
  }
  assert.deepStrictEqual([
    "interview_invitation",
    "interest_check",
    "information_request",
    "information_update",
    "general_communication",
    "manual_review"
  ].map(messageIntentLabel), [
    "正式面试邀约",
    "询问是否有意向",
    "需要你补充信息",
    "对方补充了信息",
    "普通沟通",
    "需要人工判断"
  ]);
  for (const removed of [
    "这个岗位是做什么的",
    "公司资料不足，当前结论只针对这份岗位机会",
    "不能评价公司本身是否值得加入",
    "以上信息只代表 JD 中的岗位业务场景",
    "匹配依据",
    "硬性阻断",
    "建议核实",
    "interview_invitation"
  ]) {
    assert(!understoodPage.body.includes(removed), `message result must not render analysis/internal label: ${removed}`);
  }
  assert(understoodPage.body.includes("缺少事实，暂不生成草稿"));
  assert.strictEqual((understoodPage.body.match(/name="action" value="reply_confirmed_sent"/g) || []).length, 2);
  assert.strictEqual((understoodPage.body.match(/<textarea/g) || []).length, 3);
  assert(!understoodPage.body.includes("PRIVATE_RAW_ANALYSIS"));
  assert(!understoodPage.body.includes("PRIVATE_NAVIGATION_URL"));
  for (const unsafeActionValue of [
    "resume_request",
    "location_confirmation",
    "ATTACKER ACTION TITLE",
    "ATTACKER ACTION INSTRUCTION"
  ]) {
    assert(!understoodPage.body.includes(unsafeActionValue), `${unsafeActionValue} must not enter message result markup`);
  }
  assertNoPrivateData(understoodPage.body);
  await waitForLeaseRelease();

  for (const code of [
    "BOSS_MESSAGE_JOB_TARGET_UNAVAILABLE",
    "BOSS_MESSAGE_DETAIL_NOT_BACKGROUND",
    "BOSS_MESSAGE_DETAIL_TARGET_MISMATCH",
    "BOSS_MESSAGE_DETAIL_BASELINE_NOT_RESTORED",
    "MESSAGE_DISCOVERY_JOB_ANALYSIS_INCOMPLETE"
  ]) {
    const safeMessage = messageDiscoveryReasonText(code);
    assert(safeMessage && !safeMessage.includes("诊断"), `${code} must have a specific safe recovery message`);
    if (code === "BOSS_MESSAGE_DETAIL_NOT_BACKGROUND") {
      assert.match(safeMessage, /还原 RoleFlow 专用 Edge（推荐）窗口/,
        "a minimized dedicated Edge window must tell the user how to restore visibility before retrying");
      assert.match(safeMessage, /会话已保留/,
        "a background-proof failure must say the pending conversation is preserved");
    }
  }

  const secondPending = controlledPendingRun({
    phase: "cooldown",
    waitUntil: new Date(Date.now() + 8_000).toISOString()
  });
  scenarios.push(secondPending.run);
  response = await postJson(base, "/api/message-discovery", {
    action: "start",
    profileId: fixture.profileId
  });
  assert.strictEqual(response.status, 202);
  await secondPending.started;
  status = await getStatus(base, fixture.profileId);
  assert.strictEqual(status.status, "running");
  assert.strictEqual(status.phase, "cooldown");
  assert(status.waitUntil);
  assert.deepStrictEqual(status.results, [], "a new run must clear old drafts");
  const cooldownPage = await request(base, `/messages?profileId=${fixture.profileId}`);
  assert(cooldownPage.body.includes("正在按安全节奏冷却，约"));
  assert.strictEqual(cleanupTimers.activeCount(), 0, "a new run must clear the old timer");
  cleanupTimers.fireEvenIfCleared(staleTimerId);
  status = await getStatus(base, fixture.profileId);
  assert.strictEqual(status.status, "running", "an old timer must not delete a new run");
  await postJson(base, "/api/message-discovery", {
    action: "stop",
    profileId: fixture.profileId
  });
  await waitForStatus(base, fixture.profileId, "stopped");
  await waitForLeaseRelease();

  scenarios.push(completedRun({ fixture, drafts: ["即将过期的草稿"] }));
  status = await startAndWait(base, fixture.profileId, "completed");
  assert(status.expiresAt);
  await waitForLeaseRelease();
  const expiryTimerId = cleanupTimers.latest().id;
  cleanupTimers.fire(expiryTimerId);
  status = await getStatus(base, fixture.profileId);
  assert.strictEqual(status.status, "idle");
  assert.deepStrictEqual(status.results, []);

  scenarios.push(completedRun({
    fixture,
    drafts: ["待手动发送草稿"],
    stage: "interview_invited",
    messageIntent: "interview_invitation",
    messageCategory: "other",
    messageSummary: "PRIMARY_RESULT_SUMMARY",
    additionalResults: [{
      cardId: fixture.card.id + 1000,
      jobId: fixture.jobId + 1000,
      stage: "needs_user_action",
      messageIntent: "information_request",
      messageCategory: "salary",
      messageSummary: "SECONDARY_RESULT_SUMMARY",
      missingFactKey: "",
      messages: []
    }]
  }));
  await startAndWait(base, fixture.profileId, "completed");
  await waitForLeaseRelease();
  status = await getStatus(base, fixture.profileId);
  const manualResultExpiresAt = status.expiresAt;
  const manualResultTimerId = cleanupTimers.latest().id;
  transitionProgressCard(db, {
    cardId: fixture.card.id,
    expectedStage: "contact_started",
    stage: "interview_invited",
    nextAction: "KEEP_INTERVIEW_NEXT_ACTION"
  });
  response = await postForm(base, "/api/progress", {
    cardId: fixture.card.id,
    idempotencyKey: requestKey(1),
    action: "reply_confirmed_sent"
  });
  assert.strictEqual(response.status, 303);
  status = await getStatus(base, fixture.profileId);
  assert.strictEqual(status.results.length, 2, "manual sent must retain every message result summary");
  assert.strictEqual(status.expiresAt, manualResultExpiresAt, "clearing a draft must not extend or remove the result expiry");
  assert.strictEqual(cleanupTimers.activeCount(), 1, "remaining page results must keep their cleanup timer");
  assert.strictEqual(cleanupTimers.latest().id, manualResultTimerId, "clearing a draft must preserve the original timer");
  const progress = listProgressCardsWithEvents(db, { profileId: fixture.profileId })
    .find((item) => item.id === fixture.card.id);
  assert.strictEqual(progress.stage, "interview_invited");
  assert.strictEqual(progress.nextAction, "KEEP_INTERVIEW_NEXT_ACTION");
  assert.strictEqual(progress.events.at(-1).type, "reply_confirmed_sent");
  const confirmedPage = await request(base, `/messages?profileId=${fixture.profileId}`);
  assert(confirmedPage.body.includes("PRIMARY_RESULT_SUMMARY"), "the confirmed message result must remain visible");
  assert(confirmedPage.body.includes("SECONDARY_RESULT_SUMMARY"), "other result summaries must remain visible");
  assert(!confirmedPage.body.includes("待手动发送草稿"), "the short-lived draft must be cleared");
  assert(/action="\/api\/message-discovery"[^>]*>[\s\S]*?value="dismiss"[\s\S]*?<button class="secondary">清除本次结果<\/button>/.test(confirmedPage.body), "results without drafts must retain an explicit clear action");
  cleanupTimers.fire(manualResultTimerId);
  status = await getStatus(base, fixture.profileId);
  assert.strictEqual(status.status, "idle");
  assert.deepStrictEqual(status.results, []);

  response = await postForm(base, "/api/communication", {
    mode: "hr_reply",
    jobId: fixture.jobId,
    profileId: fixture.profileId,
    planId: fixture.planId,
    idempotencyKey: requestKey(2),
    hrMessage: "你有 Python 和 RAG 项目经验吗？"
  });
  const manualHtml = await response.text();
  assert.strictEqual(response.status, 200, manualHtml);
  assert(manualHtml.includes('id="communication-0"'), "manual paste must still return a draft");
  assert(!manualHtml.includes("你有 Python 和 RAG 项目经验吗？"));

  const retainedFixture = createFixture();
  recordUnresolvedMessageDiscoveryItem(db, {
    profileId: retainedFixture.profileId,
    platform: "boss",
    conversationKey: `sha256:${"d".repeat(64)}`,
    previewDigest: `sha256:${"e".repeat(64)}`,
    previewKind: "possible_hr_reply",
    reasonCode: "BOSS_MESSAGE_CARD_NOT_FOUND",
    observedAt: "2026-08-11T08:00:00.000Z"
  });
  let durableStatus = await getStatus(base, retainedFixture.profileId);
  assert.strictEqual(durableStatus.status, "needs_user_action", "an inactive controller must surface durable unresolved work");
  assert.strictEqual(durableStatus.unresolved, 1);
  assert.strictEqual(durableStatus.reasonCode, "BOSS_MESSAGE_CARD_NOT_FOUND");
  assertNoPrivateData(durableStatus);
  let durablePage = await request(base, `/messages?profileId=${retainedFixture.profileId}`);
  assert(durablePage.body.includes("\u672a\u89e3\u51b3 1"), "the no-run page state must show durable unresolved work");
  assertNoPrivateData(durablePage.body);
  scenarios.push(completedRun({ fixture: retainedFixture, drafts: ["durable-cleanup-draft"] }));
  await startAndWait(base, retainedFixture.profileId, "completed");
  await waitForLeaseRelease();
  response = await postJson(base, "/api/message-discovery", {
    action: "dismiss",
    profileId: retainedFixture.profileId
  });
  assert.strictEqual(response.status, 200);
  durablePage = await request(base, `/messages?profileId=${retainedFixture.profileId}`);
  assert(durablePage.body.includes("\u672a\u89e3\u51b3 1"), "a fresh GET must retain the durable unresolved count after dismiss");
  assert(durablePage.body.includes("无法确认本地岗位与会话是否一致"), "a fresh GET must retain the first safe durable reason after dismiss");
  assertNoPrivateData(durablePage.body);
  scenarios.push(completedRun({ fixture: retainedFixture, drafts: ["durable-cleanup-draft"] }));
  await startAndWait(base, retainedFixture.profileId, "completed");
  await waitForLeaseRelease();
  cleanupTimers.fire(cleanupTimers.latest().id);
  durableStatus = await getStatus(base, retainedFixture.profileId);
  assert.strictEqual(durableStatus.status, "needs_user_action", "30-minute cleanup must not hide durable unresolved work");
  assert.strictEqual(durableStatus.unresolved, 1);
  assert.strictEqual(durableStatus.reasonCode, "BOSS_MESSAGE_CARD_NOT_FOUND");
  durablePage = await request(base, `/messages?profileId=${retainedFixture.profileId}`);
  assert(durablePage.body.includes("\u672a\u89e3\u51b3 1"));
  assertNoPrivateData(durablePage.body);

  await inboundResolutionDashboardSmoke({
    base,
    browserCreations: () => browserCreations,
    scenarios
  });

  const closeRace = closeRaceRun(fixture);
  scenarios.push(closeRace.run);
  response = await postJson(base, "/api/message-discovery", {
    action: "start",
    profileId: fixture.profileId
  });
  assert.strictEqual(response.status, 202);
  await closeRace.started;
  const scheduledBeforeClose = cleanupTimers.scheduledCount();
  await new Promise((resolve) => server.close(resolve));
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) AS count FROM site_scan_leases WHERE site = 'boss'").get().count,
    0,
    "server close callback must wait for lease release"
  );
  assert.strictEqual(
    browsers.at(-1).cleanupCalls,
    1,
    "server close callback must wait for browser cleanup"
  );
  await closeRace.aborted;
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(cleanupTimers.activeCount(), 0, "server close must clear every cleanup timer");
  assert.strictEqual(
    cleanupTimers.scheduledCount(),
    scheduledBeforeClose,
    "late onStatus and success summary after close must not schedule a timer"
  );
  server = null;

  await leaseConstraintSmoke(db, root, dbPath, logger, fixture.profileId);
  assertNoPrivateData(logs);
  console.log("dashboard_message_discovery_smoke ok");
}

async function detailSafetyCompositionSmoke() {
  const safetyDb = openDb(":memory:");
  try {
    const now = "2026-08-16T08:00:00.000Z";
    const profileId = Number(safetyDb.prepare(`INSERT INTO candidate_profiles(
      display_name, profile_json, source_hash, created_at, updated_at
    ) VALUES ('Detail Safety', '{}', 'detail-safety', ?, ?)`).run(now, now).lastInsertRowid);
    const secondProfileId = Number(safetyDb.prepare(`INSERT INTO candidate_profiles(
      display_name, profile_json, source_hash, created_at, updated_at
    ) VALUES ('Second Detail Safety', '{}', 'detail-safety-2', ?, ?)`).run(now, now).lastInsertRowid);
    const scanBatchId = createBatch(safetyDb, "boss", "detail-safety", "shared pacing test", {
      status: "running",
      profileId,
      filterSnapshot: {}
    });
    const scanRun = createScanRun(safetyDb, {
      runId: "detail-safety-scan",
      site: "boss",
      command: "scan"
    });
    acquireSiteScanLease(safetyDb, { site: "boss", owner: "detail-safety-owner" });
    beginScanRun(safetyDb, {
      runId: scanRun.id,
      batchId: scanBatchId,
      leaseOwner: "detail-safety-owner"
    });
    checkpointScanProgress(safetyDb, {
      runId: scanRun.id,
      batchId: scanBatchId,
      leaseOwner: "detail-safety-owner",
      jobs: [],
      runtime: { bossPacing: {
        pacedActions: 2,
        nextPacingCooldownAt: 18,
        detailActions: 6,
        nextDetailMicroCooldownAt: 6,
        nextDetailMacroCooldownAt: 16
      } }
    });
    finishScanRun(safetyDb, {
      runId: scanRun.id,
      leaseOwner: "detail-safety-owner",
      status: "interrupted"
    });
    releaseSiteScanLease(safetyDb, { site: "boss", owner: "detail-safety-owner" });
    const run = { phase: "starting", waitUntil: "", updatedAt: now };
    const sleeps = [];
    const safety = createMessageDiscoveryDetailSafety({
      db: safetyDb,
      profileId: secondProfileId,
      owner: "detail-safety-run",
      run,
      now: () => new Date(now),
      sleepFn: async (durationMs) => sleeps.push({ durationMs, phase: run.phase, waitUntil: run.waitUntil }),
      randomFn: () => 0
    });
    assert.deepStrictEqual(safety.pacing.pacingState(), {
      pacedActions: 2,
      nextPacingCooldownAt: 18,
      detailActions: 6,
      nextDetailMicroCooldownAt: 6,
      nextDetailMacroCooldownAt: 16
    });
    await safety.beforeOpen({ jobId: "stable-job-id", assertTabBindings: async () => {} });
    assert.deepStrictEqual(
      listSiteAccessEvents(safetyDb, { site: "boss" }).map((event) => event.action),
      ["pane_detail_read", "detail_open"]
    );
    assert.deepStrictEqual(sleeps.map((item) => item.durationMs), [15000, 8000],
      "message discovery must honor a due cooldown inherited from a normal scan");
    assert.strictEqual(sleeps[0].phase, "cooldown");
    assert.match(sleeps[0].waitUntil, /^2026-08-16T08:00:15\.000Z$/);
    assert.strictEqual(run.phase, "reading_detail");

    await safety.afterIssuedAttempt({ jobId: "stable-job-id", assertTabBindings: async () => {} });
    assert.strictEqual(
      getMessageDiscoveryRuntimeState(safetyDb, { profileId: secondProfileId, platform: "boss" }).pacing.detailActions,
      7
    );

    const stop = new AbortController();
    stop.abort(Object.assign(new Error("stopped"), { code: "MESSAGE_DISCOVERY_STOPPED" }));
    await assert.rejects(
      () => safety.afterIssuedAttempt({
        jobId: "stable-job-id",
        signal: stop.signal,
        assertTabBindings: async () => {}
      }),
      (error) => error.code === "MESSAGE_DISCOVERY_STOPPED"
    );
    assert.strictEqual(
      getMessageDiscoveryRuntimeState(safetyDb, { profileId: secondProfileId, platform: "boss" }).pacing.detailActions,
      8,
      "an aborted issued request must still persist its detail pacing count"
    );

    saveMessageDiscoveryRuntimeState(safetyDb, {
      profileId,
      platform: "boss",
      pacing: {
        pacedActions: 2,
        nextPacingCooldownAt: 18,
        detailActions: 6,
        nextDetailMicroCooldownAt: 6,
        nextDetailMacroCooldownAt: 16
      },
      updatedAt: now
    });
    const resumedSleeps = [];
    const resumed = createMessageDiscoveryDetailSafety({
      db: safetyDb,
      profileId: secondProfileId,
      owner: "detail-safety-resumed",
      run,
      now: () => new Date(now),
      sleepFn: async (durationMs) => resumedSleeps.push(durationMs),
      randomFn: () => 0
    });
    await resumed.beforeOpen({ jobId: "resumed-stable-job", assertTabBindings: async () => {} });
    assert.deepStrictEqual(
      resumedSleeps.slice(0, 2),
      [15000, 8000],
      "a restored due detail cooldown must run before ordinary pre-open pacing"
    );
  } finally {
    safetyDb.close();
  }
}

async function inboundResolutionDashboardSmoke({ base, browserCreations, scenarios }) {
  const createFixtureValue = createFixture();
  const createKey = `sha256:${"1".repeat(64)}`;
  const createPreview = `sha256:${"2".repeat(64)}`;
  recordUnresolvedMessageDiscoveryItem(db, {
    profileId: createFixtureValue.profileId,
    platform: "boss",
    conversationKey: createKey,
    previewDigest: createPreview,
    previewKind: "possible_hr_reply",
    reasonCode: "BOSS_MESSAGE_CARD_NOT_FOUND",
    observedAt: "2026-08-13T08:00:00.000Z",
    identity: {
      positionTitle: "RAG 应用工程师",
      company: "示例科技",
      salary: "15-25K",
      city: "广州",
      recruiterLabel: PRIVATE_RECRUITER,
      messageText: PRIVATE_BODY
    }
  });
  const beforeBrowser = browserCreations();
  const beforeScenarios = scenarios.length;
  const page = await request(base, `/messages?profileId=${createFixtureValue.profileId}`);
  assert.match(page.body, /RAG 应用工程师/);
  assert.match(page.body, /示例科技/);
  assert.match(page.body, /15-25K/);
  assert.match(page.body, /关联现有岗位/);
  assert.match(page.body, /保存为 HR 主动机会/);
  assert.match(page.body, /不纳入 RoleFlow/);
  assert.doesNotMatch(page.body, /action="[^"]*communication|发送消息/);
  assertNoPrivateData(page.body);
  let response = await postForm(base, "/api/message-discovery-unresolved", {
    profileId: createFixtureValue.profileId,
    conversationKey: createKey,
    previewDigest: createPreview,
    action: "create"
  });
  assert.strictEqual(response.status, 303);
  assert.strictEqual(response.headers.get("location"), `/messages?profileId=${createFixtureValue.profileId}`);
  assert.strictEqual(browserCreations(), beforeBrowser, "local inbound resolution must not create a browser");
  assert.strictEqual(scenarios.length, beforeScenarios, "local inbound resolution must not start message discovery");
  const created = listProgressCardsWithEvents(db, { profileId: createFixtureValue.profileId })
    .find((card) => card.job.sourceId === `inbound:${createKey.slice(7)}`);
  assert(created);
  assert.strictEqual(created.stage, "needs_user_action");

  const queue = await request(
    base,
    `/queue?planId=${createFixtureValue.planId}&pool=needs_user_action`
  );
  assert.match(queue.body, /RAG 应用工程师/);
  assert.match(queue.body, /HR 主动联系/);
  const recommendations = await request(
    base,
    `/queue?planId=${createFixtureValue.planId}&pool=apply`
  );
  assert.doesNotMatch(recommendations.body, /RAG 应用工程师/);

  const linkFixture = createFixture();
  const linkKey = `sha256:${"3".repeat(64)}`;
  const linkPreview = `sha256:${"4".repeat(64)}`;
  recordUnresolvedMessageDiscoveryItem(db, {
    profileId: linkFixture.profileId,
    platform: "boss",
    conversationKey: linkKey,
    previewDigest: linkPreview,
    previewKind: "possible_hr_reply",
    reasonCode: "BOSS_MESSAGE_CARD_NOT_FOUND",
    observedAt: "2026-08-13T08:00:00.000Z",
    identity: {
      positionTitle: "AI应用开发工程师",
      company: "测试公司",
      salary: "10-18K",
      city: "广州"
    }
  });
  const linkPage = await request(base, `/messages?profileId=${linkFixture.profileId}`);
  assert.match(linkPage.body, new RegExp(`name="jobId" value="${linkFixture.jobId}"`));
  response = await postForm(base, "/api/message-discovery-unresolved", {
    profileId: linkFixture.profileId,
    conversationKey: linkKey,
    previewDigest: linkPreview,
    action: "link",
    jobId: linkFixture.jobId
  });
  assert.strictEqual(response.status, 303);
  assert.strictEqual(
    listProgressCardsWithEvents(db, { profileId: linkFixture.profileId })
      .find((card) => card.jobId === linkFixture.jobId).threadKey,
    linkKey
  );

  const ignoreFixture = createFixture();
  const ignoreKey = `sha256:${"5".repeat(64)}`;
  const ignorePreview = `sha256:${"6".repeat(64)}`;
  recordUnresolvedMessageDiscoveryItem(db, {
    profileId: ignoreFixture.profileId,
    platform: "boss",
    conversationKey: ignoreKey,
    previewDigest: ignorePreview,
    previewKind: "possible_hr_reply",
    reasonCode: "BOSS_MESSAGE_CARD_NOT_FOUND",
    observedAt: "2026-08-13T08:00:00.000Z",
    identity: {
      positionTitle: "忽略岗位",
      company: "忽略公司"
    }
  });
  const jobsBeforeIgnore = db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count;
  response = await postForm(base, "/api/message-discovery-unresolved", {
    profileId: ignoreFixture.profileId,
    conversationKey: ignoreKey,
    previewDigest: ignorePreview,
    action: "ignore"
  });
  assert.strictEqual(response.status, 303);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count, jobsBeforeIgnore);

  const staleFixture = createFixture();
  const staleKey = `sha256:${"7".repeat(64)}`;
  const stalePreview = `sha256:${"8".repeat(64)}`;
  recordUnresolvedMessageDiscoveryItem(db, {
    profileId: staleFixture.profileId,
    platform: "boss",
    conversationKey: staleKey,
    previewDigest: stalePreview,
    previewKind: "possible_hr_reply",
    reasonCode: "BOSS_MESSAGE_CARD_NOT_FOUND",
    observedAt: "2026-08-13T08:00:00.000Z",
    identity: {
      positionTitle: "过期表单岗位",
      company: "过期表单公司"
    }
  });
  response = await postForm(base, "/api/message-discovery-unresolved", {
    profileId: staleFixture.profileId,
    conversationKey: staleKey,
    previewDigest: `sha256:${"9".repeat(64)}`,
    action: "ignore"
  });
  assert.strictEqual(response.status, 409);
  assert.strictEqual(
    listUnresolvedMessageDiscoveryItems(db, { profileId: staleFixture.profileId })
      .some((item) => item.conversationKey === staleKey),
    true
  );
  assert.strictEqual(browserCreations(), beforeBrowser, "all local inbound actions must remain browser-free");
}

async function controllerBrowserAuthoritySmoke() {
  const browserSentinel = { kind: "controller-browser-sentinel" };
  const readerSentinel = { kind: "controller-reader-sentinel" };
  const detailReaderSentinel = { kind: "controller-detail-reader-sentinel" };
  const resolverSentinel = async () => ({ kind: "controller-context-sentinel" });
  const beforeOpen = async () => {};
  const afterIssuedAttempt = async () => {};
  let factoryCalls = 0;
  let readerBrowser = null;
  let detailSafetyInput = null;
  let detailReaderInput = null;
  let contextResolverInput = null;
  let runResolver = null;
  let cleanupBrowser = null;
  const controllerDb = {
    prepare() {
      return { get: () => ({ id: 1 }) };
    }
  };
  const controller = createMessageDiscoveryController({
    db: controllerDb,
    browserFactory: () => {
      factoryCalls += 1;
      return browserSentinel;
    },
    createReader: ({ browser }) => {
      readerBrowser = browser;
      return readerSentinel;
    },
    createDetailSafety: (input) => {
      detailSafetyInput = input;
      return { beforeOpen, afterIssuedAttempt };
    },
    createDetailReader: (input) => {
      detailReaderInput = input;
      return detailReaderSentinel;
    },
    createJobContextResolver: (input) => {
      contextResolverInput = input;
      return resolverSentinel;
    },
    createAnalyzer: () => ({}),
    runDiscovery: async (input) => {
      runResolver = input.resolveJobContext;
      return {
        status: "completed",
        queued: 0,
        processed: 0,
        reasonCode: "",
        results: []
      };
    },
    modelReady: () => true,
    assertRuntimeAvailable: () => {},
    acquireLease: () => {},
    renewLease: () => {},
    releaseLease: () => {},
    cleanupBrowser: async (browser) => { cleanupBrowser = browser; },
    setInterval: () => 0,
    clearInterval: () => {}
  });
  controller.start(1);
  await controller.close();
  assert.strictEqual(factoryCalls, 1, "controller must call the supplied browser factory exactly once");
  assert.strictEqual(readerBrowser, browserSentinel, "controller must pass the factory sentinel to the reader");
  assert.strictEqual(detailSafetyInput.profileId, 1);
  assert.strictEqual(detailSafetyInput.browser, undefined, "detail pacing must not receive browser authority");
  assert.strictEqual(detailReaderInput.browser, browserSentinel);
  assert.strictEqual(detailReaderInput.messageReader, readerSentinel);
  assert.strictEqual(detailReaderInput.beforeOpen, beforeOpen);
  assert.strictEqual(detailReaderInput.afterIssuedAttempt, afterIssuedAttempt);
  assert.strictEqual(contextResolverInput.messageReader, readerSentinel);
  assert.strictEqual(contextResolverInput.detailReader, detailReaderSentinel);
  assert.strictEqual(runResolver, resolverSentinel);
  assert.strictEqual(cleanupBrowser, browserSentinel, "controller cleanup must receive the owned adapter");
}

async function dashboardSignalShutdownSmoke() {
  const events = [];
  const processRef = new EventEmitter();
  processRef.exitCode = null;
  const fakeServer = {
    close(callback) {
      events.push("server-close-start");
      setImmediate(() => {
        events.push("server-close-finished");
        callback();
      });
    }
  };
  const fakeDb = {
    close() {
      events.push("db-close");
    }
  };
  const controls = installDashboardSignalHandlers({
    server: fakeServer,
    db: fakeDb,
    processRef,
    logger
  });
  processRef.emit("SIGTERM");
  await controls.shutdown("SIGTERM");
  assert.deepStrictEqual(events, ["server-close-start", "server-close-finished", "db-close"]);
  assert.strictEqual(processRef.exitCode, 0);
  assert.strictEqual(processRef.listenerCount("SIGINT"), 0);
  assert.strictEqual(processRef.listenerCount("SIGTERM"), 0);
  await controls.shutdown("SIGINT");
  assert.deepStrictEqual(
    events,
    ["server-close-start", "server-close-finished", "db-close"],
    "dashboard signal shutdown must be idempotent"
  );
}

async function modelReadinessGateSmoke(database, projectRoot, databasePath, scopedLogger, profileId) {
  let browserCreations = 0;
  const readinessServer = createDashboardServer({
    db: database,
    browserAuthority: { browserMode: "edge", cdpPort: null, profilePath: "" },
    root: projectRoot,
    dbPath: databasePath,
    forceMock: true,
    modelReadinessChecker: () => false,
    logger: scopedLogger,
    messageDiscoveryDependencies: {
      createBrowser() {
        browserCreations += 1;
        return {};
      }
    }
  });
  await new Promise((resolve, reject) => {
    readinessServer.once("error", reject);
    readinessServer.listen(0, "127.0.0.1", resolve);
  });
  try {
    const base = `http://127.0.0.1:${readinessServer.address().port}`;
    const response = await postJson(base, "/api/message-discovery", {
      action: "start",
      profileId
    });
    assert.strictEqual(response.status, 409);
    assert.strictEqual(response.body.errorCode, "MESSAGE_DISCOVERY_MODEL_NOT_READY");
    assert.strictEqual(browserCreations, 0, "unready model must stop before browser creation");
    assert.strictEqual(
      database.prepare("SELECT COUNT(*) AS count FROM site_scan_leases WHERE site = 'boss'").get().count,
      0,
      "unready model must stop before lease acquisition"
    );
  } finally {
    await new Promise((resolve) => readinessServer.close(resolve));
  }
}

async function browserRuntimeGateSmoke(database, projectRoot, databasePath, scopedLogger, profileId) {
  let browserCreations = 0;
  let ensureCalls = 0;
  const runtimeServer = createDashboardServer({
    db: database,
    browserAuthority: {
      browserMode: "portable",
      cdpPort: 9222,
      profilePath: path.join(projectRoot, "runtime-gate-profile")
    },
    root: projectRoot,
    dbPath: databasePath,
    forceMock: true,
    logger: scopedLogger,
    browserSupervisor: {
      getSnapshot() {
        return {
          status: "unavailable",
          ready: false,
          message: "fixture unavailable",
          action: "recover",
          checkedAt: "2099-01-01T00:00:00.000Z",
          failureCount: 1,
          sessionId: ""
        };
      },
      async ensure() { ensureCalls += 1; throw new Error("fixture recovery failed"); },
      close() {}
    },
    messageDiscoveryDependencies: {
      createBrowser() {
        browserCreations += 1;
        return {};
      }
    }
  });
  await new Promise((resolve, reject) => {
    runtimeServer.once("error", reject);
    runtimeServer.listen(0, "127.0.0.1", resolve);
  });
  try {
    const base = `http://127.0.0.1:${runtimeServer.address().port}`;
    const page = await request(base, `/messages?profileId=${profileId}`);
    assert.strictEqual(page.status, 200, "saved message results must remain readable without Edge");
    const response = await postJson(base, "/api/message-discovery", {
      action: "start",
      profileId
    });
    assert.strictEqual(response.status, 409);
    assert.strictEqual(response.body.errorCode, "BROWSER_RUNTIME_NOT_READY");
    assert.strictEqual(browserCreations, 0, "browser gate must stop before message browser creation");
    assert.strictEqual(
      database.prepare("SELECT COUNT(*) AS count FROM site_scan_leases WHERE site = 'boss'").get().count,
      0,
      "browser gate must stop before message lease acquisition"
    );
    assert.strictEqual(ensureCalls, 1, "message discovery must try the managed Edge recovery once before stopping");
  } finally {
    await new Promise((resolve) => runtimeServer.close(resolve));
  }
}

async function leaseConstraintSmoke(database, root, dbPath, logger, profileId) {
  const constraintServer = createDashboardServer({
    db: database,
    browserAuthority: { browserMode: "edge", cdpPort: null, profilePath: "" },
    root,
    dbPath,
    forceMock: true,
    logger,
    messageDiscoveryDependencies: {
      acquireLease() {
        const error = new Error("UNIQUE constraint failed: site_scan_leases.site");
        error.code = "ERR_SQLITE_CONSTRAINT";
        throw error;
      }
    }
  });
  await new Promise((resolve, reject) => {
    constraintServer.once("error", reject);
    constraintServer.listen(0, "127.0.0.1", resolve);
  });
  try {
    const base = `http://127.0.0.1:${constraintServer.address().port}`;
    const response = await fetch(`${base}/api/message-discovery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "start", profileId })
    });
    assert.strictEqual(response.status, 409);
    const body = await response.json();
    assert.strictEqual(body.errorCode, "MESSAGE_DISCOVERY_LEASE_BUSY");
  } finally {
    await new Promise((resolve) => constraintServer.close(resolve));
  }
}

function createFixture() {
  const saved = saveProfileAnalysis(db, {
    profile: {
      candidate: {
        name: "测试候选人",
        city: "广州",
        targetTitles: ["AI应用开发工程师"],
        expectedSalary: "10-18K"
      },
      education: [{ school: "测试大学", degree: "本科", major: "电子信息" }],
      experiences: [],
      skills: [{ name: "Python", evidence: ["KnowledgeFlow"] }, { name: "RAG", evidence: ["KnowledgeFlow"] }],
      projects: [{ name: "KnowledgeFlow", roleBoundary: "独立项目", canSay: ["RAG 应用开发"] }],
      credentials: [],
      strengths: [],
      riskMessaging: PRIVATE_BODY
    },
    document: {
      originalFileName: "resume.txt",
      format: "text",
      contentHash: "dashboard-message-discovery-resume",
      text: "教育经历 测试大学 本科。项目经历 KnowledgeFlow，使用 Python 和 RAG 完成应用开发。".repeat(5),
      diagnostics: {}
    },
    searchPlan: {
      name: "广州 AI",
      cities: ["广州"],
      directions: ["AI应用开发"],
      keywords: [{ word: "AI应用开发", priority: "A" }],
      experience: ["1-3年"],
      jobTypes: ["全职"],
      bossActiveDays: 3
    }
  });
  const batchId = createBatch(db, "boss", "AI应用开发", "dashboard messages", {
    profileId: saved.profileId,
    searchPlanId: saved.planId,
    filterSnapshot: { execution: { scanKind: "daily" } }
  });
  const jobId = upsertJob(db, {
    source: "boss",
    sourceId: "dashboard-message-job",
    keyword: "AI应用开发",
    title: "AI应用开发工程师",
    company: "测试公司",
    location: "广州",
    salary: "10-18K",
    experience: "1-3年",
    education: "本科",
    bossActiveText: "今日活跃",
    bossActiveDays: 0,
    url: "https://www.zhipin.com/job_detail/dashboard-message.html",
    tags: ["Python", "RAG"],
    description: "负责企业知识库 RAG 与 Agent 应用开发，需要 Python 项目经验。".repeat(5),
    score: 20,
    level: "优先",
    matches: ["Python", "RAG"],
    risks: [],
    qualityTags: ["work_schedule_double"],
    analysis: {
      provider: "mock",
      model: "offline-structured-mock",
      semanticStatus: "complete",
      decisionSource: "model",
      recommendation: "apply",
      fitLevel: "A",
      confidence: 0.9,
      realRoleType: "ai_application",
      businessScenario: "企业知识库 RAG",
      coreRequirements: ["Python", "RAG"],
      coreStack: ["Python", "RAG"],
      hiddenRisks: [],
      primaryProjects: ["KnowledgeFlow"],
      recommendedResumeVersion: "main",
      fitReasons: ["项目证据匹配"],
      missingPoints: [],
      blockingGaps: [],
      riskQuestions: [],
      evidence: {
        jd: ["负责企业知识库 RAG 与 Agent 应用开发"],
        resume: ["KnowledgeFlow 使用 Python 与 RAG"]
      }
    }
  }, batchId);
  const card = ensureProgressCard(db, {
    profileId: saved.profileId,
    planId: saved.planId,
    jobId,
    source: "boss"
  });
  return { profileId: saved.profileId, planId: saved.planId, jobId, card };
}

function controlledPendingRun({ phase = "", waitUntil = "" } = {}) {
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  return {
    started,
    async run({ reader, signal, onStatus }) {
      onStatus({ status: "running", queued: 2, processed: 0, reasonCode: "", phase, waitUntil, results: [] });
      const { rows } = await reader.scanConversationRows();
      await reader.openQueuedConversation({ ...rows[0], operation: "unread" }, signal);
      markStarted();
      await waitForAbort(signal);
      await reader.openQueuedConversation({ ...rows[1], operation: "unread" }, signal);
      throw new Error("the second click must be unreachable");
    }
  };
}

function failedRun() {
  return async ({ onStatus }) => {
    onStatus({ status: "running", queued: 1, processed: 0, reasonCode: "", results: [] });
    throw new Error("fake discovery failed");
  };
}

function riskControlRun() {
  return async ({ onStatus }) => {
    const summary = {
      status: "needs_user_action",
      queued: 1,
      processed: 0,
      reasonCode: "BOSS_RISK_CONTROL",
      results: []
    };
    onStatus(summary);
    return summary;
  };
}

function unmatchedRun() {
  return async ({ onStatus }) => {
    const summary = {
      status: "needs_user_action",
      queued: 2,
      processed: 1,
      unresolved: 1,
      reasonCode: "BOSS_MESSAGE_CARD_NOT_FOUND",
      recruiterLabel: PRIVATE_RECRUITER,
      previewText: PRIVATE_PREVIEW,
      message: PRIVATE_BODY,
      results: []
    };
    onStatus(summary);
    return summary;
  };
}

function completedRun({
  fixture,
  drafts,
  durableDrafts = [],
  inboundMessages = [],
  callModel = false,
  stage = "reply_ready",
  messageIntent = "information_request",
  messageCategory = "qualification",
  messageSummary = "对方正在确认候选人的任职资格。",
  additionalResults = []
}) {
  return async ({ classifyMessageGroup, onStatus }) => {
    onStatus({
      status: "running",
      queued: 1 + additionalResults.length,
      processed: 0,
      reasonCode: "",
      results: []
    });
    if (callModel) {
      const modelResult = await classifyMessageGroup({
        card: {
          id: fixture.card.id,
          profileId: fixture.profileId,
          planId: fixture.planId,
          jobId: fixture.jobId,
          source: "boss",
          stage: "contact_started",
          threadKey: ""
        },
        job: { id: fixture.jobId, title: "AI应用开发工程师" },
        messages: [{ text: PRIVATE_BODY }],
        facts: []
      });
      assert.strictEqual(typeof modelResult.messageCategory, "string");
    }
    const summary = {
      status: "completed",
      queued: 1 + additionalResults.length,
      processed: 1 + additionalResults.length,
      reasonCode: "",
      privateBody: PRIVATE_BODY,
      results: [{
        cardId: fixture.card.id,
        jobId: fixture.jobId,
        stage,
        messageIntent,
        messageCategory,
        messageSummary,
        missingFactKey: "",
        inboundMessages,
        drafts: durableDrafts.map((draft) => ({
          id: draft.id,
          text: draft.text || draft.currentText,
          revision: draft.revision
        })),
        messages: drafts,
        hrMessage: PRIVATE_BODY,
        previewText: PRIVATE_PREVIEW,
        recruiterLabel: PRIVATE_RECRUITER,
        url: "https://www.zhipin.com/web/geek/chat"
      }, ...additionalResults]
    };
    onStatus(summary);
    return summary;
  };
}

function multiResultCompletedRun(fixture) {
  return async ({ onStatus }) => {
    const summary = {
      status: "completed",
      queued: 2,
      processed: 2,
      reasonCode: "",
      results: [{
        cardId: fixture.card.id,
        jobId: fixture.jobId,
        stage: "reply_ready",
        messageIntent: "information_request",
        messageCategory: "qualification",
        missingFactKey: "",
        messages: ["运行额度草稿一", "岗位一草稿二", "岗位一草稿三"]
      }, {
        cardId: fixture.card.id + 1,
        jobId: fixture.jobId + 1,
        stage: "reply_ready",
        messageIntent: "information_request",
        messageCategory: "qualification",
        missingFactKey: "",
        messages: ["运行额度草稿二", "岗位二草稿二", "岗位二草稿三"]
      }]
    };
    onStatus(summary);
    return summary;
  };
}

function jobUnderstandingCompletedRun(fixture) {
  return async ({ onStatus }) => {
    const job = {
      title: "AI 应用开发工程师",
      company: "示例科技",
      roleSummary: "把企业知识转成可追溯的智能问答能力",
      companyBusiness: "JD 显示该岗位服务于企业知识管理。",
      fitLabel: "中",
      fitSummary: "候选人有 RAG 项目经验；生产运维经验仍需确认",
      workSchedule: "双休",
      salary: "15-25K·13薪",
      opportunityVerdict: "可以了解，但要先确认关键问题",
      opportunitySummary: "候选人有 RAG 项目经验；生产运维经验仍需确认"
    };
    const summary = {
      status: "completed",
      queued: 3,
      processed: 3,
      unresolved: 0,
      reasonCode: "",
      results: [{
        cardId: fixture.card.id,
        jobId: fixture.jobId,
        stage: "reply_ready",
        messageIntent: "information_request",
        messageCategory: "qualification",
        messageSummary: "对方正在确认候选人的任职资格。",
        missingFactKey: "",
        manualActionReason: "",
        contextSource: "local_cache",
        contextComplete: true,
        job,
        inboundMessages: [{ kind: "text", text: OPEN_HR_TEXT }],
        manualActions: [{
          kind: "resume_request",
          title: "ATTACKER ACTION TITLE",
          instruction: "ATTACKER ACTION INSTRUCTION"
        }, {
          kind: "location_confirmation",
          title: "ATTACKER LOCATION TITLE",
          instruction: "ATTACKER LOCATION INSTRUCTION"
        }],
        messages: ["岗位草稿甲", "岗位草稿乙"],
        analysis: "PRIVATE_RAW_ANALYSIS",
        navigationUrl: "PRIVATE_NAVIGATION_URL"
      }, {
        cardId: fixture.card.id + 1,
        jobId: fixture.jobId + 1,
        stage: "interview_invited",
        messageIntent: "interview_invitation",
        messageCategory: "other",
        messageSummary: "对方正式邀请候选人参加面试。",
        missingFactKey: "",
        manualActionReason: "",
        contextSource: "message_discovery_detail",
        contextComplete: true,
        job: { ...job, title: "面试岗位" },
        inboundMessages: [{ kind: "resume_request", text: RESUME_REQUEST_SUMMARY }],
        messages: ["您好，感谢邀请，请问面试时间和形式如何安排？"]
      }, {
        cardId: fixture.card.id + 2,
        jobId: fixture.jobId + 2,
        stage: "contact_started",
        messageIntent: "information_request",
        messageCategory: "missing_fact",
        messageSummary: "对方需要补充关键信息。",
        missingFactKey: "availability",
        manualActionReason: "missing_fact",
        contextSource: "message_discovery_detail",
        contextComplete: true,
        job: { ...job, title: "待补事实岗位", salary: "", companyBusiness: "" },
        messages: []
      }]
    };
    onStatus(summary);
    return summary;
  };
}

function closeRaceRun(fixture) {
  let markStarted;
  let markAborted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const aborted = new Promise((resolve) => { markAborted = resolve; });
  const lateSummary = {
    status: "completed",
    queued: 1,
    processed: 1,
    reasonCode: "",
    results: [{
      cardId: fixture.card.id,
      jobId: fixture.jobId,
      stage: "reply_ready",
      messageIntent: "information_request",
      messageCategory: "qualification",
      missingFactKey: "",
      messages: ["关闭后不得回写"]
    }]
  };
  return {
    started,
    aborted,
    async run({ signal, onStatus }) {
      onStatus({
        status: "running",
        queued: 1,
        processed: 1,
        reasonCode: "",
        results: [{
          cardId: fixture.card.id,
          jobId: fixture.jobId,
          stage: "reply_ready",
          messageIntent: "information_request",
          messageCategory: "qualification",
          missingFactKey: "",
          messages: ["关闭前应主动清空"]
        }]
      });
      markStarted();
      await new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          onStatus(lateSummary);
          markAborted();
          resolve();
        }, { once: true });
      });
      return lateSummary;
    }
  };
}

function controllableTimers() {
  let nextId = 1;
  const active = new Map();
  const scheduled = new Map();
  return {
    setTimeout(callback, delay) {
      const id = nextId++;
      const timer = { id, callback, delay };
      active.set(id, timer);
      scheduled.set(id, timer);
      return id;
    },
    clearTimeout(id) {
      active.delete(id);
    },
    activeCount() {
      return active.size;
    },
    scheduledCount() {
      return scheduled.size;
    },
    latest() {
      return scheduled.get(nextId - 1);
    },
    fire(id) {
      const timer = active.get(id);
      assert(timer, `timer ${id} must be active`);
      active.delete(id);
      timer.callback();
    },
    fireEvenIfCleared(id) {
      const timer = scheduled.get(id);
      assert(timer, `timer ${id} must have been scheduled`);
      active.delete(id);
      timer.callback();
    }
  };
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || new Error("aborted");
}

function waitForAbort(signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason || new Error("aborted")), { once: true });
  });
}

async function request(base, route) {
  const response = await fetch(base + route);
  return { status: response.status, body: await response.text() };
}

async function postJson(base, route, body) {
  const response = await fetch(base + route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "manual"
  });
  const text = await response.text();
  assertNoDraftMessagesInJson(text);
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function postForm(base, route, values) {
  return fetch(base + route, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(Object.entries(values).map(([key, value]) => [key, String(value)])).toString(),
    redirect: "manual"
  });
}

async function getStatus(base, profileId) {
  const response = await fetch(`${base}/api/message-discovery-status?profileId=${profileId}`);
  assert.strictEqual(response.status, 200);
  const text = await response.text();
  assertNoDraftMessagesInJson(text);
  return JSON.parse(text);
}

async function waitForStatus(base, profileId, expected) {
  let latest;
  await waitFor(async () => {
    latest = await getStatus(base, profileId);
    return latest.status === expected;
  });
  return latest;
}

async function startAndWait(base, profileId, expected) {
  const response = await postJson(base, "/api/message-discovery", {
    action: "start",
    profileId
  });
  assert.strictEqual(response.status, 202);
  return waitForStatus(base, profileId, expected);
}

async function waitForLeaseRelease() {
  await waitFor(() => !db.prepare("SELECT 1 AS found FROM site_scan_leases WHERE site = 'boss'").get());
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for condition");
}

function assertNoPrivateData(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const forbidden of [PRIVATE_BODY, PRIVATE_PREVIEW, PRIVATE_RECRUITER]) {
    assert(!text.includes(forbidden), `${forbidden} must not leave the discovery callback`);
  }
}

function assertNoDraftMessagesInJson(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  assert(!text.includes('"messages"'), "message discovery JSON must use an explicit safe-field whitelist");
  assert(!text.includes(PRIVATE_DRAFT), "message discovery JSON must not expose draft text");
}

function durableDraftRecoverySmoke() {
  const durableDb = openDb(":memory:");
  try {
    const now = "2026-08-28T03:00:00.000Z";
    const profileId = Number(durableDb.prepare(`INSERT INTO candidate_profiles(
      display_name, profile_json, source_hash, created_at, updated_at
    ) VALUES ('Durable candidate', '{}', NULL, ?, ?)`).run(now, now).lastInsertRowid);
    const planId = Number(durableDb.prepare(`INSERT INTO search_plans(
      profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
    ) VALUES (?, 'Durable plan', '{}', NULL, 1, ?, ?)`).run(profileId, now, now).lastInsertRowid);
    const jobId = Number(durableDb.prepare(`INSERT INTO jobs(
      source, source_id, title, company, salary, first_seen_at, last_seen_at
    ) VALUES ('boss', 'durable-job', '持久化岗位', '持久化公司', '20-30K', ?, ?)`)
      .run(now, now).lastInsertRowid);
    const cardId = Number(durableDb.prepare(`INSERT INTO candidate_progress_cards(
      profile_id, plan_id, job_id, source, stage, next_action, last_event_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'boss', 'reply_ready', 'Review draft before manual send', ?, ?, ?)`)
      .run(profileId, planId, jobId, now, now, now).lastInsertRowid);
    const draft = recordMessageReplyDrafts(durableDb, {
      profileId,
      cardId,
      jobId,
      messageGroupKey: `sha256:${"d".repeat(64)}`,
      questionSummary: "对方正在确认候选人的任职资格。",
      messageIntent: "information_request",
      messageCategory: "qualification",
      messages: [PRIVATE_DRAFT],
      createdAt: now
    })[0];
    saveMessageInboundContext(durableDb, {
      profileId,
      cardId,
      messageGroupKey: `sha256:${"d".repeat(64)}`,
      conversationKey: `sha256:${"c".repeat(64)}`,
      sourceJobId: "boss:durable-job",
      lastMessageId: "378917037748762",
      messageIntent: "information_request",
      messageCategory: "qualification",
      inboundMessages: [{ kind: "text", text: OPEN_HR_TEXT }],
      manualActions: [],
      createdAt: now,
      updatedAt: now
    });
    const controller = createMessageDiscoveryController({ db: durableDb });
    const pageState = controller.pageState(profileId);
    assert.strictEqual(pageState.status, "completed");
    assert.strictEqual(pageState.results[0].drafts[0].id, draft.id);
    assert.strictEqual(pageState.results[0].drafts[0].text, PRIVATE_DRAFT);
    assert.strictEqual(pageState.results[0].job.title, "持久化岗位");
    assert.deepStrictEqual(pageState.results[0].inboundMessages, [{ kind: "text", text: OPEN_HR_TEXT }]);
    const publicStatus = controller.status(profileId);
    assert(!JSON.stringify(publicStatus).includes(PRIVATE_DRAFT), "durable draft text must stay out of public status JSON");
    assert(!Object.hasOwn(publicStatus.results[0], "drafts"));
    controller.clearDraftForCard(profileId, cardId);
    assert.strictEqual(controller.pageState(profileId).results.length, 0);
    assert.strictEqual(getMessageInboundContext(durableDb, {
      profileId,
      cardId,
      messageGroupKey: `sha256:${"d".repeat(64)}`
    }), null);
    assert.strictEqual(closeMessageReplyDrafts(durableDb, { profileId, cardId, closedAt: now }), 0, "clearDraftForCard must already close durable rows");
  } finally {
    durableDb.close();
  }
}

function assertHeadingsInOrder(markup, headings) {
  let previous = -1;
  for (const heading of headings) {
    const index = markup.indexOf(heading);
    assert(index > previous, `${heading} must appear after the preceding decision section`);
    previous = index;
  }
}

function requestKey(sequence) {
  return `progress:00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function assertMessageDiscoveryProductFrame(markup, fixture) {
  assert.match(markup, /class="app-shell"/, "message discovery must use the shared dashboard frame");
  assert.match(markup, /class="primary-nav"/, "message discovery must have one shared primary navigation");
  assert.match(markup, /href="\/messages\?profileId=\d+" aria-current="page">消息发现<\/a>/, "message discovery must be the active navigation destination");
  assert.strictEqual((markup.match(/<nav\b/g) || []).length, 1, "message discovery must not render a competing inner navigation");
  assert.strictEqual((markup.match(/<style>/g) || []).length, 0, "message discovery styles must come from the shared stylesheet");
  assert.match(markup, /data-discovery-feedback[^>]*role="status"[^>]*aria-live="polite"/, "action feedback must be announced in a live status region");
  assert.match(markup, new RegExp(`href="/messages\\?profileId=${fixture.profileId}" aria-current="page">消息发现`));
}

function assertManualProgressRemainsOrdinary(markup) {
  assert.match(markup, /<form[^>]*action="\/api\/progress"[^>]*>[\s\S]*?name="action" value="reply_confirmed_sent"/, "manual sent must remain an ordinary progress form");
  assert.doesNotMatch(markup, /<form[^>]*action="\/api\/progress"[^>]*data-discovery-form/, "manual sent must stay outside discovery fetch wiring");
}

async function messageDiscoveryClientResponseSmoke(markup) {
  for (const scenario of [
    { name: "accepted JSON", response: jsonResponse(202, { status: "running" }), reloads: 1, feedback: "" },
    { name: "already running conflict", response: jsonResponse(409, { errorCode: "MESSAGE_DISCOVERY_ALREADY_RUNNING" }), reloads: 0, feedback: "正在运行" },
    { name: "application error", response: jsonResponse(409, { errorCode: "BOSS_RISK_CONTROL" }), reloads: 0, feedback: "安全检查" },
    { name: "non-JSON response", response: textResponse(502, "bad gateway"), reloads: 0, feedback: "本地服务" },
    { name: "network rejection", reject: new Error("offline"), reloads: 0, feedback: "Edge" }
  ]) {
    const client = runMessageDiscoveryClient(markup, scenario);
    await assert.doesNotReject(client.submit(), `${scenario.name} must stay handled in the current page`);
    assert.strictEqual(client.reloads(), scenario.reloads, `${scenario.name} must reload only after an accepted JSON response`);
    assert.strictEqual(client.feedback.busy, "false", `${scenario.name} must clear busy state after the request settles`);
    assert.strictEqual(client.button.disabled, false, `${scenario.name} must re-enable controls after a rejected request`);
    if (scenario.feedback) assert.match(client.feedback.textContent, new RegExp(scenario.feedback));
  }
}

async function messageDiscoveryFormActionSmoke(markup) {
  let destination;
  const client = runMessageDiscoveryClient(markup, {
    fetch(url) {
      destination = url;
      return jsonResponse(202, { status: "running" });
    }
  });
  await client.submit();
  assert.strictEqual(destination, "/api/message-discovery", "discovery submits to the form action attribute");
  assert.notStrictEqual(String(destination), "[object HTMLInputElement]", "discovery must not submit to the named action control");
}

async function messageDiscoveryPollingSmoke(markup) {
  const failedPoll = runMessageDiscoveryClient(markup, { response: textResponse(502, "bad gateway") }, { status: "running" });
  assert.strictEqual(failedPoll.timerCount(), 1, "a running page must schedule one poll");
  await assert.doesNotReject(failedPoll.runTimer(0), "a failed poll must be handled in the current page");
  assert.strictEqual(failedPoll.reloads(), 0, "a failed poll must never reload the page");
  assert.match(failedPoll.feedback.textContent, /本地服务/);
  assert.strictEqual(failedPoll.timerCount(), 1, "a failed poll must not add a duplicate interval");

  const runningPoll = runMessageDiscoveryClient(markup, { response: jsonResponse(200, { status: "running" }) }, { status: "running" });
  await runningPoll.runTimer(0);
  assert.strictEqual(runningPoll.timerCount(), 2, "each successful running poll must schedule exactly one successor");
}

async function messageDiscoveryMalformedResponseSmoke(markup) {
  for (const scenario of [
    { name: "array", body: [] },
    { name: "empty object", body: {} },
    { name: "empty error code", body: { status: "running", errorCode: "" } },
    { name: "invalid status", body: { status: "unknown" } }
  ]) {
    const action = runMessageDiscoveryClient(markup, { response: jsonResponse(202, scenario.body) });
    await assert.doesNotReject(action.submit(), `a 2xx ${scenario.name} action response must stay in the current page`);
    assert.strictEqual(action.reloads(), 0, `a 2xx ${scenario.name} action response must not reload`);

    const poll = runMessageDiscoveryClient(markup, { response: jsonResponse(200, scenario.body) }, { status: "running" });
    await assert.doesNotReject(poll.runTimer(0), `a 2xx ${scenario.name} poll response must stay handled`);
    assert.strictEqual(poll.reloads(), 0, `a 2xx ${scenario.name} poll response must not reload`);
  }
}

async function messageDiscoveryActionPollRaceSmoke(markup) {
  const pollResponse = deferred();
  const actionResponse = deferred();
  const client = runMessageDiscoveryClient(markup, {
    fetch(url) {
      return String(url).includes("message-discovery-status") ? pollResponse.promise : actionResponse.promise;
    }
  }, { status: "running" });
  const poll = client.runTimer(0);
  await Promise.resolve();
  const action = client.submit();
  await Promise.resolve();
  actionResponse.resolve(jsonResponse(409, { errorCode: "BOSS_RISK_CONTROL" }));
  await action;
  assert.match(client.feedback.textContent, /安全检查/, "a failed manual action must keep its recovery feedback");
  assert.strictEqual(client.timerCount(), 2, "a failed action on a running page must restore one poll");

  pollResponse.resolve(jsonResponse(200, { status: "completed" }));
  await poll;
  assert.strictEqual(client.reloads(), 0, "a poll that began before a manual action must not refresh later");
  assert.match(client.feedback.textContent, /安全检查/, "a late poll must not overwrite failed action feedback");
  assert.strictEqual(client.timerCount(), 2, "a late poll must not add a duplicate timer");
}

async function messageDiscoveryAcceptedActionStopsPollSmoke(markup) {
  const pollResponse = deferred();
  const actionResponse = deferred();
  const client = runMessageDiscoveryClient(markup, {
    fetch(url) {
      return String(url).includes("message-discovery-status") ? pollResponse.promise : actionResponse.promise;
    }
  }, { status: "running" });
  const poll = client.runTimer(0);
  await Promise.resolve();
  const action = client.submit();
  await Promise.resolve();
  actionResponse.resolve(jsonResponse(202, { status: "stopped" }));
  await action;
  const feedbackAfterReload = client.feedback.textContent;
  assert.strictEqual(client.reloads(), 1, "an accepted stop action must request one reload");
  assert.strictEqual(client.timerCount(), 1, "an accepted stop action must not schedule another poll");

  pollResponse.resolve(jsonResponse(200, { status: "running" }));
  await poll;
  assert.strictEqual(client.reloads(), 1, "a late poll after accepted reload must not reload again");
  assert.strictEqual(client.timerCount(), 1, "a late poll after accepted reload must not schedule a timer");
  assert.strictEqual(client.feedback.textContent, feedbackAfterReload, "a late poll after accepted reload must not change feedback");
}

async function messageDiscoveryDuplicateSubmitSmoke(markup) {
  let resolveResponse;
  const pendingResponse = new Promise((resolve) => { resolveResponse = resolve; });
  const client = runMessageDiscoveryClient(markup, { fetch: async () => pendingResponse });
  const first = client.submit();
  const second = client.submit();
  assert.strictEqual(client.fetchCalls(), 1, "a pending discovery request must reject duplicate submits");
  assert.strictEqual(client.button.disabled, true, "a pending discovery request must disable the visible control");
  assert.strictEqual(client.feedback.busy, "true", "a pending discovery request must mark the status region busy");
  assert.match(client.feedback.textContent, /正在处理/, "a pending discovery request must visibly report that it is busy");
  resolveResponse(jsonResponse(202, { status: "running" }));
  await Promise.all([first, second]);
  assert.strictEqual(client.reloads(), 1, "the accepted pending request must reload once");
}

function runMessageDiscoveryClient(markup, scenario, options = {}) {
  const script = markup.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert(script, "message discovery must provide its client behavior");
  const clientScript = options.status ? script.replace(/"status":"[^"]+"/, `"status":"${options.status}"`) : script;
  const handlers = new Map();
  const button = { disabled: false, dataset: {} };
  const form = {
    action: { nodeName: "INPUT", name: "action", toString() { return "[object HTMLInputElement]"; } },
    formData: [["action", "start"], ["profileId", "1"]],
    getAttribute(name) { return name === "action" ? "/api/message-discovery" : null; },
    querySelectorAll(selector) { return selector === "button" ? [button] : []; },
    addEventListener(type, handler) { handlers.set(type, handler); }
  };
  const feedback = { textContent: "", dataset: {}, setAttribute(name, value) { if (name === "aria-busy") this.busy = value; } };
  const document = {
    querySelector(selector) {
      return selector === "[data-discovery-feedback]" ? feedback : null;
    },
    querySelectorAll(selector) {
      if (selector === "[data-discovery-form]") return [form];
      if (selector === "[data-copy-draft]") return [];
      return [];
    },
    getElementById() { return null; }
  };
  let reloadCount = 0;
  let fetchCallCount = 0;
  const timers = [];
  const context = {
    document,
    URLSearchParams,
    FormData: class FormData { constructor(target) { return target.formData; } },
    fetch: async (...args) => {
      fetchCallCount += 1;
      if (scenario.fetch) return scenario.fetch(...args);
      if (scenario.reject) throw scenario.reject;
      return scenario.response;
    },
    navigator: { clipboard: { writeText: async () => {} } },
    location: { reload() { reloadCount += 1; } },
    setTimeout(callback) { timers.push(callback); return timers.length; },
    clearTimeout() {},
    encodeURIComponent,
    console
  };
  vm.runInNewContext(clientScript, context);
  return {
    button,
    feedback,
    fetchCalls: () => fetchCallCount,
    reloads: () => reloadCount,
    timerCount: () => timers.length,
    runTimer: (index) => timers[index](),
    submit: () => handlers.get("submit")({ preventDefault() {} })
  };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

function textResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}
