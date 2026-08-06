const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  openDb,
  saveProfileAnalysis,
  createBatch,
  upsertJob,
  acquireSiteScanLease,
  releaseSiteScanLease
} = require("../src/core/storage");
const {
  ensureProgressCard,
  transitionProgressCard
} = require("../src/core/candidate_progress");
const { createDashboardServer } = require("../src/dashboard/server");

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
  const fixture = createFixture();
  const scenarios = [];
  const cleanupTimers = controllableTimers();
  const browsers = [];
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
    messageDiscoveryDependencies: {
      createBrowser() {
        browserCreations += 1;
        const browser = { port: 9222, kind: "fake-browser", cleanupCalls: 0 };
        browsers.push(browser);
        return browser;
      },
      async cleanupBrowser(browser) {
        browser.cleanupCalls += 1;
        if (cleanupFailure) {
          const error = cleanupFailure;
          cleanupFailure = null;
          throw error;
        }
      },
      createReader(input) {
        assert(browsers.includes(input.browser));
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

  acquireSiteScanLease(db, {
    site: "boss",
    owner: "external-scan",
    command: "daily",
    planId: fixture.planId
  });
  let response = await postJson(base, "/api/message-discovery", {
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
  assert.strictEqual(browsers[0].port, 9222, "portable message discovery must use fixed CDP port 9222");
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
  let status = await waitForStatus(base, fixture.profileId, "completed");
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
  await closeRace.aborted;
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(cleanupTimers.activeCount(), 0, "server close must clear every cleanup timer");
  assert.strictEqual(
    cleanupTimers.scheduledCount(),
    scheduledBeforeClose,
    "late onStatus and success summary after close must not schedule a timer"
  );
  server = null;

  assertNoPrivateData(logs);
  console.log("dashboard_message_discovery_smoke ok");
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
  return { status: response.status };
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
