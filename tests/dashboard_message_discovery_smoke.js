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
  upsertJob,
  acquireSiteScanLease,
  releaseSiteScanLease,
  getSiteRuntimeState,
  setSiteRuntimeState,
  clearSiteRuntimeState,
  listSiteAccessEvents
} = require("../src/core/storage");
const {
  ensureProgressCard,
  transitionProgressCard,
  listProgressCardsWithEvents
} = require("../src/core/candidate_progress");
const {
  recordUnresolvedMessageDiscoveryItem,
  listUnresolvedMessageDiscoveryItems
} = require("../src/core/message_preview_state");
const { createDashboardServer } = require("../src/dashboard/server");
const { createMessageDiscoveryController } = require("../src/dashboard/message_discovery_controller");
const { installDashboardSignalHandlers, persistBossRiskControl } = require("../src/cli");
const { communicationRuntimeBlock } = require("../src/core/communication_runtime");

const PRIVATE_BODY = "脱敏测试问题";
const PRIVATE_PREVIEW = "脱敏会话预览";
const PRIVATE_RECRUITER = "脱敏招聘方";
const PRIVATE_DRAFT = "PRIVATE_DISCOVERY_DRAFT";
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
  await controllerBrowserAuthoritySmoke();
  await dashboardSignalShutdownSmoke();
  const fixture = createFixture();
  await modelReadinessGateSmoke(db, root, dbPath, logger, fixture.profileId);
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
    { browserMode: "edge", cdpPort: null },
    "message discovery must use the dashboard's default Edge browser authority"
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

  scenarios.push(completedRun({
    fixture,
    drafts: [PRIVATE_DRAFT],
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
    "processed",
    "profileId",
    "queued",
    "reasonCode",
    "results",
    "startedAt",
    "status",
    "unresolved",
    "updatedAt"
  ]);
  assert.deepStrictEqual(Object.keys(status.results[0]).sort(), [
    "cardId",
    "jobId",
    "messageCategory",
    "missingFactKey",
    "stage"
  ]);
  assertNoPrivateData(status);
  await waitForLeaseRelease();
  assert.strictEqual(browsers.at(-1).cleanupCalls, 1, "successful discovery must clean up its browser exactly once");

  const completedPage = await request(base, `/messages?profileId=${fixture.profileId}`);
  assert.strictEqual(completedPage.status, 200);
  assert(completedPage.body.includes(PRIVATE_DRAFT));
  assertManualProgressRemainsOrdinary(completedPage.body);
  assertNoPrivateData(completedPage.body);

  response = await postJson(base, "/api/message-discovery", {
    action: "dismiss",
    profileId: fixture.profileId
  });
  assert.strictEqual(response.status, 200);
  status = await getStatus(base, fixture.profileId);
  assert.strictEqual(status.status, "dismissed");
  assert.deepStrictEqual(status.results, []);
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
  assert(!cappedPage.body.includes("不应返回的第三条"), "all results in one run must share a two-message budget");
  const staleTimerId = cleanupTimers.latest().id;
  await waitForLeaseRelease();

  const secondPending = controlledPendingRun();
  scenarios.push(secondPending.run);
  response = await postJson(base, "/api/message-discovery", {
    action: "start",
    profileId: fixture.profileId
  });
  assert.strictEqual(response.status, 202);
  await secondPending.started;
  status = await getStatus(base, fixture.profileId);
  assert.strictEqual(status.status, "running");
  assert.deepStrictEqual(status.results, [], "a new run must clear old drafts");
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

  scenarios.push(completedRun({ fixture, drafts: ["待手动发送草稿"] }));
  await startAndWait(base, fixture.profileId, "completed");
  await waitForLeaseRelease();
  transitionProgressCard(db, {
    cardId: fixture.card.id,
    expectedStage: "contact_started",
    stage: "reply_ready",
    nextAction: "请用户复制后手动发送"
  });
  response = await postForm(base, "/api/progress", {
    cardId: fixture.card.id,
    idempotencyKey: requestKey(1),
    action: "reply_confirmed_sent"
  });
  assert.strictEqual(response.status, 303);
  status = await getStatus(base, fixture.profileId);
  assert.deepStrictEqual(status.results, [], "manual sent progress must clear the matching draft");
  assert.strictEqual(cleanupTimers.activeCount(), 0, "manual sent must clear the cleanup timer");

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
  let factoryCalls = 0;
  let readerBrowser = null;
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
      return {};
    },
    createAnalyzer: () => ({}),
    runDiscovery: async () => ({
      status: "completed",
      queued: 0,
      processed: 0,
      reasonCode: "",
      results: []
    }),
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

async function leaseConstraintSmoke(database, root, dbPath, logger, profileId) {
  const constraintServer = createDashboardServer({
    db: database,
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

function controlledPendingRun() {
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  return {
    started,
    async run({ reader, signal, onStatus }) {
      onStatus({ status: "running", queued: 2, processed: 0, reasonCode: "", results: [] });
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

function completedRun({ fixture, drafts, callModel = false }) {
  return async ({ classifyMessageGroup, onStatus }) => {
    onStatus({
      status: "running",
      queued: 1,
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
      queued: 1,
      processed: 1,
      reasonCode: "",
      privateBody: PRIVATE_BODY,
      results: [{
        cardId: fixture.card.id,
        jobId: fixture.jobId,
        stage: "reply_ready",
        messageCategory: "qualification",
        missingFactKey: "",
        messages: drafts,
        hrMessage: PRIVATE_BODY,
        previewText: PRIVATE_PREVIEW,
        recruiterLabel: PRIVATE_RECRUITER,
        url: "https://www.zhipin.com/web/geek/chat"
      }]
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
        messageCategory: "qualification",
        missingFactKey: "",
        messages: ["运行额度草稿一"]
      }, {
        cardId: fixture.card.id + 1,
        jobId: fixture.jobId + 1,
        stage: "reply_ready",
        messageCategory: "qualification",
        missingFactKey: "",
        messages: ["运行额度草稿二", "不应返回的第三条"]
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
  assert.match(markup, /<form method="post" action="\/api\/progress">[\s\S]*?name="action" value="reply_confirmed_sent"/, "manual sent must remain an ordinary progress form");
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
