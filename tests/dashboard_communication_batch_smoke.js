const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
  openDb,
  createBatch,
  upsertJob,
  markCandidateJob,
  recordSiteAccessEvent,
  setSiteRuntimeState,
  createWorkflowRun,
  getWorkflowRun,
  transitionWorkflowRun,
  attachWorkflowCommunication
} = require("../src/core/storage");
const {
  getCommunicationBatch,
  createCommunicationBatch,
  bindCommunicationBatchRuntime,
  listCommunicationBatchItems,
  setCommunicationBatchStatus,
  transitionCommunicationItem,
  communicationQuotaSnapshot
} = require("../src/core/communication_batches");
const {
  communicationAmbiguityState,
  communicationAmbiguityStateForBatch
} = require("../src/core/communication_ambiguity");
const { buildCommunicationViewModel } = require("../src/dashboard/view_models/communication");
const { renderCommunicationPage } = require("../src/dashboard/pages/communication");
const { createDashboardServer } = require("../src/dashboard/server");

const root = path.join(__dirname, "..");
const smokeDir = path.join(root, ".runtime", "smoke");
const dbPath = path.join(smokeDir, `dashboard-communication-batch-${Date.now()}.sqlite`);
const logger = { info() {}, warn() {}, error() {}, requestId() { return "dashboard-communication-batch-smoke"; }, listRecent() { return []; } };
let db;
let server;

function communicationStatus(batch = {}, summary = {}, items = []) {
  return {
    batch: { id: 41, profileId: 7, planId: 11, status: "confirmed", ...batch },
    summary: { batchId: 41, batchStatus: "confirmed", total: 1, terminal: 0, remaining: 1, statusCounts: { pending: 1 }, ...summary },
    items,
    quota: { limit: 150, used: 4, reserved: 1, remaining: 145 },
    calibration: { implementation: "implemented", calibration: "calibrated", acceptance: "e2e_pending", executionEnabled: true },
    runtimeBlock: null
  };
}

function assertCommunicationViewModel() {
  const pending = buildCommunicationViewModel({
    scope: { profile: { id: 7 }, plan: { id: 11, name: "Scoped plan" } },
    current: communicationStatus({}, {}, [{ id: 1, batchId: 41, status: "pending", titleSnapshot: "Pending role", companySnapshot: "Example", salarySnapshot: "15-20K", locationSnapshot: "Guangzhou", tierSnapshot: "primary", evidenceSnapshot: ["Python"], riskSnapshot: ["weekend unknown"], proposalReasonSnapshot: "skill match" }])
  });
  assert.equal(pending.state, "pending_review");
  assert.equal(pending.controls.action, "start_one");
  assert.equal(pending.controls.singleItemId, 1);
  assert.equal(pending.controls.singleItemTitle, "Pending role");
  assert.equal(pending.controls.singleItemCompany, "Example");
  assert.equal(pending.controls.visible, true);
  assert.equal(pending.quota.used, 4);
  assert.equal(pending.outcomes.succeeded, 0);
  assert.deepEqual(pending.polling, {
    batchId: 41,
    batchStatus: "confirmed",
    intervalMs: 2500,
    itemIds: [1]
  });
  const pendingHtml = renderCommunicationPage(pending);
  assert.match(pendingHtml, /data-communication-page/);
  assert.match(pendingHtml, /data-communication-batch-id="41"/);
  assert.match(pendingHtml, /data-communication-item-ids="1"/);
  assert.match(pendingHtml, /<progress[^>]+data-communication-meter/);
  assert.match(pendingHtml, /data-communication-terminal/);
  assert.match(pendingHtml, /data-communication-success/);
  assert.match(pendingHtml, /data-communication-remaining/);
  assert.match(pendingHtml, /data-communication-item-id="1"/);
  assert.match(pendingHtml, /data-communication-item-status/);
  assert.match(pendingHtml, /<script src="\/assets\/communication\.js"><\/script>/);

  const running = buildCommunicationViewModel({ scope: { profile: { id: 7 }, plan: { id: 11 } }, current: communicationStatus({ status: "running" }, { batchStatus: "running" }) });
  assert.equal(running.state, "running");
  assert.equal(running.controls.visible, false);

  const needsResolution = buildCommunicationViewModel({
    scope: { profile: { id: 7 }, plan: { id: 11 } },
    current: communicationStatus({ status: "interrupted" }, { batchStatus: "interrupted", statusCounts: { ambiguous: 1, pending: 1 }, total: 2, remaining: 2 }, [
      { id: 2, batchId: 41, status: "pending", titleSnapshot: "Later role" },
      { id: 1, batchId: 41, status: "ambiguous", titleSnapshot: "Ambiguous role" }
    ])
  });
  assert.equal(needsResolution.state, "needs_resolution");
  assert.equal(needsResolution.items[0].status, "ambiguous");
  assert.equal(needsResolution.controls.visible, false);
  assert.equal(needsResolution.controls.rebindVisible, false);
  assert.equal(needsResolution.items[0].resolution.evidenceRequired, true);
  assert.equal(needsResolution.polling, null, "an already-visible resolution form must not enter a reload loop");
  assert.doesNotMatch(renderCommunicationPage(needsResolution), /assets\/communication\.js/);

  const rebindable = buildCommunicationViewModel({
    scope: { profile: { id: 7 }, plan: { id: 11 } },
    current: communicationStatus({
      status: "interrupted",
      browserMode: "edge",
      runtime: { browser: browserBinding() }
    }, { batchStatus: "interrupted" })
  });
  assert.equal(rebindable.controls.rebindVisible, true);
  assert.match(renderCommunicationPage(rebindable), /重新检查浏览器页面/);
  assert.equal(rebindable.polling, null, "interrupted batches must wait for a deliberate resume instead of polling");
  const portableRebindable = buildCommunicationViewModel({
    scope: { profile: { id: 7 }, plan: { id: 11 } },
    current: communicationStatus({
      status: "interrupted",
      browserMode: "portable",
      runtime: { browser: browserBinding({ mode: "portable", windowId: 17, searchTabId: "CDP-search", messageTabId: "CDP-chat" }) }
    }, { batchStatus: "interrupted" })
  });
  assert.equal(portableRebindable.controls.rebindVisible, true);

  const completed = buildCommunicationViewModel({ scope: { profile: { id: 7 }, plan: { id: 11 } }, current: communicationStatus({ status: "completed" }, { batchStatus: "completed", total: 2, terminal: 2, remaining: 0, statusCounts: { succeeded: 1, stopped: 1 } }, [{ id: 1, status: "succeeded" }, { id: 2, status: "stopped" }]) });
  assert.equal(completed.state, "completed");
  assert.equal(completed.outcomes.succeeded, 1);
  assert.equal(completed.polling, null);

  const history = buildCommunicationViewModel({ scope: { profile: { id: 7 }, plan: { id: 11 } }, current: communicationStatus(), history: [communicationStatus({ id: 40, status: "stopped" }, { batchId: 40, batchStatus: "stopped", total: 1, terminal: 1, remaining: 0, statusCounts: { stopped: 1 } })] });
  assert.equal(history.history.length, 1);
  assert.equal(history.history[0].batchId, 40);

  const noBatch = buildCommunicationViewModel({ scope: { profile: { id: 7 }, plan: { id: 11 } } });
  assert.equal(noBatch.state, "no_batch");
  assert.equal(noBatch.controls.visible, false);
  assert.equal(noBatch.polling, null);
  assert.doesNotMatch(renderCommunicationPage(noBatch), /data-communication-batch-id=/);
  assert.doesNotMatch(renderCommunicationPage(noBatch), /assets\/communication\.js/);

  const planIsolation = buildCommunicationViewModel({ scope: { profile: { id: 7 }, plan: { id: 11 } }, current: communicationStatus(), discoveredWorkflowRuns: [{ planId: 11, communicationBatchId: 41 }, { planId: 12, communicationBatchId: 99 }] });
  assert.deepEqual(planIsolation.discoveredBatchIds, [41]);

  const directOrphan = buildCommunicationViewModel({ scope: { profile: { id: 7 }, plan: { id: 11 } }, current: communicationStatus(), directBatch: true });
  assert.equal(directOrphan.source, "direct_orphan");
  assert.equal(directOrphan.history.length, 0);

  const mismatch = buildCommunicationViewModel({ scope: { profile: { id: 7 }, plan: { id: 11 } }, current: communicationStatus({ planId: 12 }), integrityIssue: "batch_plan_mismatch" });
  assert.equal(mismatch.state, "integrity_blocked");
  assert.equal(mismatch.controls.visible, false);
  assert.equal(mismatch.polling, null);
  assert.doesNotMatch(renderCommunicationPage(mismatch), /data-communication-batch-id=/);
  assert.doesNotMatch(renderCommunicationPage(mismatch), /assets\/communication\.js/);

  const unknownStatusHtml = renderCommunicationPage(buildCommunicationViewModel({
    scope: { profile: { id: 7 }, plan: { id: 11 } },
    current: communicationStatus({}, { statusCounts: { future_status: 1 } }, [
      { id: 1, batchId: 41, status: "future_status", titleSnapshot: "Future role" }
    ])
  }));
  assert.match(unknownStatusHtml, /状态待确认/);
  assert.doesNotMatch(unknownStatusHtml, />future_status</);

  const links = buildCommunicationViewModel({
    scope: { profile: { id: 7 }, plan: { id: 11 } },
    current: communicationStatus({}, {}, [
      { id: 1, batchId: 41, status: "pending", jobUrl: "javascript:alert(1)" },
      { id: 2, batchId: 41, status: "pending", jobUrl: "https://example.com/job_detail/role.html" },
      { id: 3, batchId: 41, status: "pending", jobUrl: "https://www.zhipin.com/job_detail/approved-role.html" }
    ])
  });
  assert.deepEqual(links.items.map((item) => item.jobUrl), ["", "", "https://www.zhipin.com/job_detail/approved-role.html"]);
}

assertCommunicationViewModel();

async function assertCommunicationClient() {
  const script = fs.readFileSync(path.join(root, "src", "dashboard", "assets", "communication.js"), "utf8");
  const itemIds = [11, 12, 13, 14];
  const response = (overrides = {}) => ({
    batch: { id: 41, status: "running", ...(overrides.batch || {}) },
    summary: {
      batchId: 41,
      batchStatus: "running",
      total: 4,
      terminal: 2,
      remaining: 2,
      statusCounts: { succeeded: 1, stopped: 1 },
      ...(overrides.summary || {})
    },
    items: overrides.items || [
      { id: 11, status: "verified" },
      { id: 12, status: "succeeded" },
      { id: 13, status: "stopped" },
      { id: 14, status: "pending" }
    ]
  });

  function harness(responses) {
    let timerId = 0;
    let reloads = 0;
    let fetches = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const timeouts = new Map();
    const documentListeners = new Map();
    const windowListeners = new Map();
    const element = (textContent = "") => ({
      textContent,
      hidden: false,
      disabled: false,
      value: 0,
      max: 1,
      attributes: new Map(),
      setAttribute(name, value) { this.attributes.set(name, String(value)); },
      removeAttribute(name) { this.attributes.delete(name); },
      getAttribute(name) { return this.attributes.get(name) ?? null; }
    });
    const terminalNode = element("0");
    const successNode = element("0");
    const remainingNode = element("4");
    const meter = element();
    const errorNode = element("无法读取沟通状态");
    errorNode.hidden = true;
    const controls = [element(), element()];
    const rows = new Map(itemIds.map((id) => {
      const row = element();
      const status = element("待执行");
      row.querySelector = (selector) => selector === "[data-communication-item-status]" ? status : null;
      return [id, { row, status }];
    }));
    const page = {
      dataset: {
        communicationBatchId: "41",
        communicationItemIds: itemIds.join(","),
        communicationBatchStatus: "confirmed",
        communicationPollingInterval: "2500"
      },
      querySelector(selector) {
        if (selector === "[data-communication-terminal]") return terminalNode;
        if (selector === "[data-communication-success]") return successNode;
        if (selector === "[data-communication-remaining]") return remainingNode;
        if (selector === "[data-communication-meter]") return meter;
        if (selector === "[data-communication-error]") return errorNode;
        const match = selector.match(/^\[data-communication-item-id="(\d+)"\]$/);
        return match ? rows.get(Number(match[1]))?.row || null : null;
      },
      querySelectorAll(selector) {
        if (selector === "[data-communication-control]") return controls;
        return [];
      }
    };
    const document = {
      hidden: false,
      querySelector(selector) { return selector === "[data-communication-page]" ? page : null; },
      addEventListener(event, callback) { documentListeners.set(event, callback); }
    };
    const context = vm.createContext({
      document,
      window: { addEventListener(event, callback) { windowListeners.set(event, callback); } },
      fetch: async () => {
        fetches += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const next = responses.shift() || response();
        await Promise.resolve();
        inFlight -= 1;
        if (next.httpError) return { ok: false, json: async () => ({}) };
        return { ok: true, json: async () => next };
      },
      setTimeout(callback, delay) { timerId += 1; timeouts.set(timerId, { callback, delay }); return timerId; },
      clearTimeout(id) { timeouts.delete(id); },
      encodeURIComponent,
      location: { reload() { reloads += 1; } }
    });
    new vm.Script(script).runInContext(context);
    return {
      document,
      documentListeners,
      windowListeners,
      timeouts,
      rows,
      controls,
      terminalNode,
      successNode,
      remainingNode,
      meter,
      errorNode,
      async fire() {
        const [id, timer] = timeouts.entries().next().value || [];
        assert(timer, "expected one scheduled communication status request");
        timeouts.delete(id);
        await timer.callback();
      },
      counts() { return { reloads, fetches, maxInFlight }; }
    };
  }

  const active = harness([
    response(),
    { httpError: true },
    response({
      summary: { terminal: 1, remaining: 3, statusCounts: { ambiguous: 1 } },
      items: [
        { id: 11, status: "ambiguous" },
        { id: 12, status: "pending" },
        { id: 13, status: "pending" },
        { id: 14, status: "pending" }
      ]
    })
  ]);
  assert.strictEqual(active.timeouts.size, 1);
  await active.fire();
  assert.strictEqual(active.terminalNode.textContent, "2");
  assert.strictEqual(active.successNode.textContent, "1");
  assert.strictEqual(active.remainingNode.textContent, "2");
  assert.strictEqual(active.rows.get(11).status.textContent, "身份已核验");
  assert.strictEqual(active.rows.get(11).row.getAttribute("aria-current"), "step");
  assert.strictEqual(active.counts().reloads, 0);
  assert.strictEqual(active.timeouts.size, 1);

  active.document.hidden = true;
  active.documentListeners.get("visibilitychange")();
  active.documentListeners.get("visibilitychange")();
  assert.strictEqual(active.timeouts.size, 0);
  const hiddenFetches = active.counts().fetches;
  active.document.hidden = false;
  active.documentListeners.get("visibilitychange")();
  active.documentListeners.get("visibilitychange")();
  assert.strictEqual(active.timeouts.size, 1);
  await active.fire();
  assert.strictEqual(active.counts().fetches - hiddenFetches, 1);
  assert.strictEqual(active.counts().maxInFlight, 1);
  assert.strictEqual(active.errorNode.hidden, false);
  assert.strictEqual(active.terminalNode.textContent, "2");
  assert(active.controls.every((control) => control.disabled));
  assert.strictEqual(active.timeouts.size, 1);

  await active.fire();
  assert.strictEqual(active.counts().reloads, 1);
  assert.strictEqual(active.timeouts.size, 0);
  active.windowListeners.get("pageshow")();
  active.windowListeners.get("pageshow")();
  assert.strictEqual(active.counts().reloads, 1);
  assert.strictEqual(active.timeouts.size, 0);

  const drift = harness([response({ items: [{ id: 11, status: "pending" }] })]);
  await drift.fire();
  assert.strictEqual(drift.counts().reloads, 1, "an immutable item-set drift must reload once");
  const batchDrift = harness([response({ batch: { id: 42 } })]);
  await batchDrift.fire();
  assert.strictEqual(batchDrift.counts().reloads, 1, "a batch identity drift must reload once");
  const terminal = harness([response({ batch: { status: "completed" } })]);
  await terminal.fire();
  assert.strictEqual(terminal.counts().reloads, 1, "a terminal batch must reload once");
}

(async () => {
  fs.mkdirSync(smokeDir, { recursive: true });
  await assertCommunicationClient();
  db = openDb(dbPath);
  const fixture = seed(db);
  const spawns = [];
  let ambiguityOverride = null;
  let liveSearchUrl = "https://www.zhipin.com/web/geek/jobs?city=100010000&query=RAG&page=3";
  const browserMutations = [];
  const browserEvents = [];
  const edgeBrowser = {
    async listTabs() {
      browserEvents.push("listTabs");
      return [
        { id: 1995685534, windowId: 1995685675, url: liveSearchUrl },
        { id: 1995685619, windowId: 1995685675, url: "https://www.zhipin.com/web/geek/chat" }
      ];
    },
    async evalValue(tabId) {
      const search = tabId === 1995685534;
      return {
        url: search ? liveSearchUrl : "https://www.zhipin.com/web/geek/chat",
        path: search ? "/web/geek/jobs" : "/web/geek/chat",
        title: search ? "BOSS 搜索" : "BOSS 沟通",
        isBoss: true,
        isLoginPage: false,
        isRiskPage: false,
        loggedIn: true,
        isSearchPage: search,
        hasJobStructure: search,
        scrollTop: search ? 360 : 0
      };
    },
    async createTab() {
      browserMutations.push("create");
      throw new Error("communication rebind must not create a tab");
    },
    async navigate() {
      browserMutations.push("navigate");
      throw new Error("communication rebind must not navigate");
    }
  };
  server = createDashboardServer({ db, root, dbPath, browserAuthority: { browserMode: "edge", cdpPort: null, profilePath: "" }, logger,
    browserFactory({ browserMode }) {
      assert.strictEqual(browserMode, "edge");
      return edgeBrowser;
    },
    communicationAmbiguityReader(database, requestedBatchId) {
      return ambiguityOverride || communicationAmbiguityStateForBatch(database, requestedBatchId);
    },
    spawnProcess(file, args, options) {
    browserEvents.push("spawn");
    spawns.push({ file, args, options });
    const child = new EventEmitter();
    child.pid = 5252;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    return child;
  } });
  const baseUrl = await listen(server);

  const builder = await getText(baseUrl, `/communication/new?planId=${fixture.planId}`);
  assert.match(builder.body, new RegExp(`name="jobIds" value="${fixture.primaryId}" checked`));
  assert.match(builder.body, new RegExp(`name="jobIds" value="${fixture.talkId}"`));
  assert.match(builder.body, /· apply<\/small>/);
  assert.match(builder.body, new RegExp(`name="jobIds" value="${fixture.backupId}"`));
  assert.doesNotMatch(builder.body, new RegExp(`name="jobIds" value="${fixture.backupId}" checked`));
  assert.doesNotMatch(builder.body, new RegExp(`value="${fixture.notRecommendedId}"`));
  assert.doesNotMatch(builder.body, new RegExp(`value="${fixture.appliedId}"`));
  assert.doesNotMatch(builder.body, new RegExp(`value="${fixture.skippedId}"`));
  assert.match(builder.body, /<output[^>]*id="selected-count"/);
  assert.match(builder.body, /form\.addEventListener\('change',update\);update\(\)/);
  assert.match(builder.body, /浏览器：使用当前 Edge（高级，需要浏览器连接组件）（Dashboard 已固定）/);
  assert.match(builder.body, /<input type="hidden" name="browserMode" value="edge">/);
  assert.doesNotMatch(builder.body, /<select name="browserMode">/);
  assert.strictEqual((builder.body.match(/<input[^>]*name="jobIds"[^>]*checked/g) || []).length, 30);
  assert.match(builder.body, /已达到日常沟通区间，无需为凑满 30 个补扫/);

  const malformedApiResponse = await fetch(`${baseUrl}/api/communication-batch`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: "{"
  });
  assert.strictEqual(malformedApiResponse.status, 400);
  assert.match(malformedApiResponse.headers.get("content-type") || "", /^application\/json/);
  assert.strictEqual((await malformedApiResponse.json()).errorCode, "COMMUNICATION_REQUEST_FAILED");

  const oversizedFormResponse = await fetch(`${baseUrl}/api/communication-batch`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
    body: new URLSearchParams({
      planId: String(fixture.planId),
      jobIds: String(fixture.primaryId),
      browserMode: "edge",
      padding: "x".repeat(70 * 1024)
    }),
    redirect: "manual"
  });
  assert.strictEqual(oversizedFormResponse.status, 413);
  assert.match(oversizedFormResponse.headers.get("content-type") || "", /^text\/html/);
  assert.match(await oversizedFormResponse.text(), /请求内容过大，请返回清单后重新确认。/);

  const oversizedApiResponse = await fetch(`${baseUrl}/api/communication-batch`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ padding: "x".repeat(70 * 1024) })
  });
  assert.strictEqual(oversizedApiResponse.status, 413);
  assert.match(oversizedApiResponse.headers.get("content-type") || "", /^application\/json/);
  assert.strictEqual((await oversizedApiResponse.json()).errorCode, "REQUEST_BODY_TOO_LARGE");

  const oversizedUnicodeApiResponse = await fetch(`${baseUrl}/api/communication-batch`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ padding: "中".repeat(25 * 1024) })
  });
  assert.strictEqual(oversizedUnicodeApiResponse.status, 413);
  assert.strictEqual((await oversizedUnicodeApiResponse.json()).errorCode, "REQUEST_BODY_TOO_LARGE");
  assert.strictEqual((await getJson(baseUrl, "/health")).status, 200);

  const historical = await postJson(baseUrl, "/api/communication-batch", {
    planId: fixture.planId,
    jobIds: fixture.historySucceededId,
    browserMode: "edge"
  });
  const historicalItem = listCommunicationBatchItems(db, historical.body.batch.id)[0];
  transitionCommunicationItem(db, { itemId: historicalItem.id, expectedStatus: "pending", status: "opening" });
  transitionCommunicationItem(db, { itemId: historicalItem.id, expectedStatus: "opening", status: "verified" });
  transitionCommunicationItem(db, { itemId: historicalItem.id, expectedStatus: "verified", status: "click_dispatched", audit: clickAudit(historicalItem) });
  transitionCommunicationItem(db, { itemId: historicalItem.id, expectedStatus: "click_dispatched", status: "succeeded" });
  setCommunicationBatchStatus(db, { batchId: historical.body.batch.id, status: "running" });
  setCommunicationBatchStatus(db, { batchId: historical.body.batch.id, status: "completed" });
  const refreshedBuilder = await getText(baseUrl, `/communication/new?planId=${fixture.planId}`);
  assert.doesNotMatch(refreshedBuilder.body, new RegExp(`name="jobIds" value="${fixture.historySucceededId}"`));
  await expectApiError(baseUrl, "/api/communication-batch", {
    planId: fixture.planId,
    jobIds: fixture.historySucceededId,
    browserMode: "edge"
  }, "COMMUNICATION_JOB_INELIGIBLE");
  const staleForm = await postForm(baseUrl, "/api/communication-batch", {
    planId: fixture.planId,
    jobIds: fixture.historySucceededId,
    browserMode: "edge"
  });
  assert.strictEqual(staleForm.status, 400);
  assert.match(staleForm.contentType, /^text\/html/);
  assert.match(staleForm.body, /所选岗位已沟通过或当前不可加入清单，请刷新后重新确认。/);
  assert.match(staleForm.body, /COMMUNICATION_JOB_INELIGIBLE/);

  const smallBuilder = await getText(baseUrl, `/communication/new?planId=${fixture.smallPlanId}`);
  assert.strictEqual((smallBuilder.body.match(/<input[^>]*name="jobIds"[^>]*checked/g) || []).length, 21);
  assert.match(smallBuilder.body, /当前可沟通候选不足 22 个，可在风险额度允许时补扫一轮/);
  assert.doesNotMatch(smallBuilder.body, /自动补扫|开始补扫/);

  const queue = await getText(baseUrl, `/queue?planId=${fixture.planId}`);
  const plan = await getText(baseUrl, `/plan?planId=${fixture.planId}`);
  assert.match(queue.body, new RegExp(`/communication/new\\?planId=${fixture.planId}`));
  assert.match(plan.body, new RegExp(`/communication/new\\?planId=${fixture.planId}`));
  assert.match(queue.body, /批量沟通清单/);
  assert.match(queue.body, /薪资与目标贴合/);
  assert.match(plan.body, /批量沟通清单/);
  assert.doesNotMatch(plan.body, />Resume</);

  await expectApiError(baseUrl, "/api/communication-batch", { planId: fixture.planId, jobIds: fixture.notRecommendedId, browserMode: "edge", title: "forged" }, "COMMUNICATION_JOB_INELIGIBLE");
  await expectApiError(baseUrl, "/api/communication-batch", { planId: fixture.planId, jobIds: fixture.appliedId, browserMode: "edge", company: "forged" }, "COMMUNICATION_JOB_INELIGIBLE");
  await expectApiError(baseUrl, "/api/communication-batch", { planId: fixture.planId, jobIds: fixture.skippedId, browserMode: "edge", company: "forged" }, "COMMUNICATION_JOB_INELIGIBLE");
  await expectApiError(baseUrl, "/api/communication-batch", { planId: fixture.planId, browserMode: "edge" }, "COMMUNICATION_JOB_INELIGIBLE");

  const beforeForgedAuthority = communicationAuthorityWriteSnapshot(db);
  await expectApiError(baseUrl, "/api/communication-batch", {
    planId: fixture.planId,
    jobIds: fixture.primaryId,
    browserMode: "portable",
    cdpPort: 9222
  }, "DASHBOARD_BROWSER_AUTHORITY_MISMATCH", 409);
  assert.deepStrictEqual(communicationAuthorityWriteSnapshot(db), beforeForgedAuthority);

  const created = await postJson(baseUrl, "/api/communication-batch", { planId: fixture.planId, jobIds: [fixture.primaryId, fixture.backupId], title: "forged", company: "forged", bucket: "not_recommended", url: "https://invalid.example" });
  assert.strictEqual(created.status, 200);
  assert.strictEqual(created.body.batch.browserMode, "edge");
  const batchId = created.body.batch.id;
  assert.deepStrictEqual(listCommunicationBatchItems(db, batchId).map((item) => [item.jobId, item.titleSnapshot, item.companySnapshot]), [
    [fixture.primaryId, "Primary role", "Company primary"],
    [fixture.backupId, "Backup role", "Company backup"]
  ]);

  const historyWorkflow = reviewWorkflow(db, { id: "communication-history", planId: fixture.planId, localDay: "2098-01-02" });
  const historyBatch = await postJson(baseUrl, "/api/communication-batch", { planId: fixture.planId, jobIds: fixture.talkId, browserMode: "edge" });
  attachWorkflowCommunication(db, { workflowRunId: historyWorkflow.id, communicationBatchId: historyBatch.body.batch.id });
  setCommunicationBatchStatus(db, { batchId: historyBatch.body.batch.id, status: "stopped" });
  const currentWorkflow = reviewWorkflow(db, { id: "communication-current", planId: fixture.planId, localDay: "2098-01-03" });
  const currentBatch = await postJson(baseUrl, "/api/communication-batch", { planId: fixture.planId, jobIds: fixture.safeId, browserMode: "edge" });
  attachWorkflowCommunication(db, { workflowRunId: currentWorkflow.id, communicationBatchId: currentBatch.body.batch.id });
  const automaticCenter = await getText(baseUrl, `/communication?planId=${fixture.planId}`);
  assert.match(automaticCenter.body, new RegExp(`当前批次</p><h2>批次 #${currentBatch.body.batch.id}</h2>`));
  assert.match(automaticCenter.body, new RegExp(`href="/communication\\?batchId=${historyBatch.body.batch.id}"`));
  assert.match(automaticCenter.body, /<dt>薪资<\/dt><dd>10-15K<\/dd>/);
  assert.match(automaticCenter.body, /<dt>地点<\/dt><dd>Guangzhou<\/dd>/);
  assert.doesNotMatch(automaticCenter.body, new RegExp(`批次 #${batchId}</h2>`), "unlinked legacy batches must not enter automatic history");
  for (const pathname of [
    "/communication?planId=999999",
    `/communication?planId=${fixture.planId}&profileId=${fixture.otherProfileId}`,
    "/communication?profileId=999999"
  ]) {
    const spawnsBeforeInvalidScope = spawns.length;
    const invalidScope = await getText(baseUrl, pathname);
    assert.match(invalidScope.body, /批次范围无法安全确认/, `${pathname} must fail closed`);
    assert.doesNotMatch(invalidScope.body, /name="action" value="(?:start|resume)(?:_one)?"/, `${pathname} must not expose execution controls`);
    assert.strictEqual(spawns.length, spawnsBeforeInvalidScope, `${pathname} must not spawn communication`);
  }
  const [unsafeSchemeItem, unsafeOriginItem] = listCommunicationBatchItems(db, batchId);
  db.prepare("UPDATE communication_batch_items SET job_url = ? WHERE id = ?").run("javascript:alert(1)", unsafeSchemeItem.id);
  db.prepare("UPDATE communication_batch_items SET job_url = ? WHERE id = ?").run("https://example.com/job_detail/role.html", unsafeOriginItem.id);
  const unsafeLinks = await getText(baseUrl, `/communication?batchId=${batchId}`);
  assert.doesNotMatch(unsafeLinks.body, /href="javascript:alert\(1\)"/);
  assert.doesNotMatch(unsafeLinks.body, /href="https:\/\/example\.com\/job_detail\/role\.html"/);
  const validLinks = await getText(baseUrl, `/communication?batchId=${currentBatch.body.batch.id}`);
  assert.match(validLinks.body, /href="https:\/\/www\.zhipin\.com\/job_detail\/safe\.html"/);

  const rebindBatch = await postJson(baseUrl, "/api/communication-batch", {
    planId: fixture.planId,
    jobIds: fixture.rebindId,
    browserMode: "edge"
  });
  const rebindWorkflow = reviewWorkflow(db, {
    id: "communication-rebind",
    planId: fixture.planId,
    localDay: "2098-01-04",
    planner: {
      browserMode: "edge",
      acquisitionMode: "inherited",
      searchScope: {
        templateUrl: "https://www.zhipin.com/web/geek/jobs?city=100010000"
      }
    }
  });
  attachWorkflowCommunication(db, {
    workflowRunId: rebindWorkflow.id,
    communicationBatchId: rebindBatch.body.batch.id
  });
  bindCommunicationBatchRuntime(db, {
    batchId: rebindBatch.body.batch.id,
    browser: browserBinding()
  });
  setCommunicationBatchStatus(db, { batchId: rebindBatch.body.batch.id, status: "running" });
  setCommunicationBatchStatus(db, { batchId: rebindBatch.body.batch.id, status: "paused" });
  const rebound = await postForm(baseUrl, "/api/communication-rebind", { batchId: rebindBatch.body.batch.id });
  assert.strictEqual(rebound.status, 303);
  assert.strictEqual(rebound.location, `/communication?batchId=${rebindBatch.body.batch.id}`);
  assert.deepStrictEqual(getCommunicationBatch(db, rebindBatch.body.batch.id).runtime.browser, {
    mode: "edge",
    windowId: 1995685675,
    searchTabId: 1995685534,
    messageTabId: 1995685619,
    searchReturnUrl: liveSearchUrl,
    searchScrollTop: 360,
    bindingGeneration: 2
  });
  assert.deepStrictEqual(browserMutations, []);
  const rebindResumeItem = listCommunicationBatchItems(db, rebindBatch.body.batch.id)[0];
  const spawnsBeforeRebindResume = spawns.length;
  browserEvents.length = 0;
  const reboundOnResume = await postJson(baseUrl, "/api/communication-control", {
    batchId: rebindBatch.body.batch.id,
    action: "resume"
  });
  assert.strictEqual(reboundOnResume.status, 200);
  assert.strictEqual(browserEvents.includes("listTabs"), true);
  assert.strictEqual(browserEvents.indexOf("listTabs") < browserEvents.indexOf("spawn"), true);
  assert.deepStrictEqual(getCommunicationBatch(db, rebindBatch.body.batch.id).runtime.browser, {
    mode: "edge",
    windowId: 1995685675,
    searchTabId: 1995685534,
    messageTabId: 1995685619,
    searchReturnUrl: liveSearchUrl,
    searchScrollTop: 360,
    bindingGeneration: 3
  });
  assert.strictEqual(spawns.length, spawnsBeforeRebindResume + 1);
  setCommunicationBatchStatus(db, { batchId: rebindBatch.body.batch.id, status: "paused" });
  const rebindReview = await getText(baseUrl, `/communication?batchId=${rebindBatch.body.batch.id}`);
  assert.match(rebindReview.body, /name="action" value="resume"/);
  assert.doesNotMatch(rebindReview.body, /重新检查浏览器页面/);
  for (const [body, code] of [
    [{ batchId: rebindBatch.body.batch.id, action: "resume_one", itemId: rebindResumeItem.id + 1 }, "COMMUNICATION_SINGLE_ITEM_MISMATCH"]
  ]) {
    const generationBeforeInvalidResume = getCommunicationBatch(db, rebindBatch.body.batch.id).runtime.browser.bindingGeneration;
    const spawnsBeforeInvalidResume = spawns.length;
    browserEvents.length = 0;
    await expectApiError(baseUrl, "/api/communication-control", body, code, 409);
    assert.deepStrictEqual(browserEvents, [], `${code} must stop before browser rebind or process launch`);
    assert.strictEqual(getCommunicationBatch(db, rebindBatch.body.batch.id).runtime.browser.bindingGeneration, generationBeforeInvalidResume);
    assert.strictEqual(spawns.length, spawnsBeforeInvalidResume);
  }
  liveSearchUrl = "https://www.zhipin.com/web/geek/jobs?city=101010100";
  const spawnsBeforeRebindScopeFailure = spawns.length;
  await expectApiError(
    baseUrl,
    "/api/communication-control",
    { batchId: rebindBatch.body.batch.id, action: "resume" },
    "BOSS_COMMUNICATION_SCOPE_MISMATCH",
    409
  );
  assert.strictEqual(getCommunicationBatch(db, rebindBatch.body.batch.id).status, "paused");
  assert.strictEqual(spawns.length, spawnsBeforeRebindScopeFailure);
  await expectApiError(
    baseUrl,
    "/api/communication-rebind",
    { batchId: rebindBatch.body.batch.id },
    "BOSS_COMMUNICATION_SCOPE_MISMATCH",
    409
  );
  assert.strictEqual(getCommunicationBatch(db, rebindBatch.body.batch.id).runtime.browser.bindingGeneration, 3);
  assert.deepStrictEqual(browserMutations, []);
  liveSearchUrl = "https://www.zhipin.com/web/geek/jobs?city=100010000&query=RAG&page=3";

  const directOrphan = await getText(baseUrl, `/communication?batchId=${batchId}`);
  assert.match(directOrphan.body, new RegExp(`批次 #${batchId}</h2>`), "a direct legacy batch URL must remain readable");
  const mismatchedBatch = await getText(baseUrl, `/communication?batchId=${batchId}&planId=${fixture.smallPlanId}`);
  assert.match(mismatchedBatch.body, /批次范围无法安全确认/);
  assert.doesNotMatch(mismatchedBatch.body, /name="action" value="(?:start|resume)(?:_one)?"/);

  const review = await getText(baseUrl, `/communication?batchId=${batchId}`);
  assert.strictEqual((review.body.match(/class="app-shell"/g) || []).length, 1, "communication review must use one shared app shell");
  assert.strictEqual((review.body.match(/class="primary-nav"/g) || []).length, 1, "communication review must use one primary navigation");
  assert.doesNotMatch(review.body, /<main[^>]*>\s*<nav(?:\s|>)/, "communication review must not retain an inner navigation");
  assert.match(review.body, /实施：已实现/);
  assert.match(review.body, /校准：已完成/);
  assert.match(review.body, /端到端验收：accepted/);
  assert.match(review.body, /技术执行门：已启用/);
  const reviewItem = listCommunicationBatchItems(db, batchId)[0];
  assert.match(review.body, /Primary role/);
  assert.match(review.body, /Company primary/);
  assert.match(review.body, /name="action" value="start"/);
  assert.doesNotMatch(review.body, /验收这个岗位并自动暂停/);
  assert.match(review.body, /class="communication-discard" name="action" value="discard"/);
  const communicationAsset = await getText(baseUrl, "/assets/communication.js");
  assert.strictEqual(communicationAsset.status, 200);
  assert.match(communicationAsset.body, /api\/communication-status/);
  const status = await getJson(baseUrl, `/api/communication-status?batchId=${batchId}`);
  assert.deepStrictEqual(Object.keys(status.body).sort(), ["batch", "calibration", "items", "quota", "runtimeBlock", "summary"]);
  assert.deepStrictEqual(status.body.calibration, {
    implementation: "implemented",
    calibration: "calibrated",
    acceptance: "accepted",
    executionEnabled: true
  });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(status.body.calibration, "status"), false);
  assert.strictEqual(status.body.calibration.executionEnabled, true);
  assert.strictEqual(status.body.quota.limit, 150);
  assert.strictEqual(typeof communicationAmbiguityState, "function");
  assert.strictEqual(communicationAmbiguityState(
    { statusCounts: { ambiguous: 1, pending: 1 } },
    [{ ...reviewItem, status: "pending" }]
  ).blocked, true);
  assert.strictEqual(communicationAmbiguityState(
    { statusCounts: { pending: 2 } },
    [{ ...reviewItem, status: "ambiguous" }]
  ).firstItemId, reviewItem.id);
  for (const [drift, action, jobId] of [
    ["summary-only", "start", fixture.summaryDriftStartId],
    ["summary-only", "resume", fixture.summaryDriftResumeId],
    ["item-only", "start", fixture.itemDriftStartId],
    ["item-only", "resume", fixture.itemDriftResumeId]
  ]) {
    const driftBatch = await postJson(baseUrl, "/api/communication-batch", {
      planId: fixture.planId,
      jobIds: jobId,
      browserMode: "edge"
    });
    if (action === "resume") {
      setCommunicationBatchStatus(db, { batchId: driftBatch.body.batch.id, status: "running" });
      setCommunicationBatchStatus(db, { batchId: driftBatch.body.batch.id, status: "paused" });
    }
    const driftItem = listCommunicationBatchItems(db, driftBatch.body.batch.id)[0];
    ambiguityOverride = drift === "summary-only"
      ? communicationAmbiguityState({ statusCounts: { ambiguous: 1 } }, [{ ...driftItem, status: "pending" }])
      : communicationAmbiguityState({ statusCounts: {} }, [{ ...driftItem, status: "ambiguous" }]);
    const batchBefore = getCommunicationBatch(db, driftBatch.body.batch.id);
    const itemsBefore = listCommunicationBatchItems(db, driftBatch.body.batch.id);
    const spawnsBefore = spawns.length;
    await expectApiError(baseUrl, "/api/communication-control", {
      batchId: driftBatch.body.batch.id,
      action
    }, "COMMUNICATION_RESUME_REQUIRES_REVIEW", 409);
    assert.deepStrictEqual(getCommunicationBatch(db, driftBatch.body.batch.id), batchBefore);
    assert.deepStrictEqual(listCommunicationBatchItems(db, driftBatch.body.batch.id), itemsBefore);
    assert.strictEqual(spawns.length, spawnsBefore);
    ambiguityOverride = null;
  }

  const started = await postJson(baseUrl, "/api/communication-control", {
    batchId,
    action: "start"
  });
  assert.strictEqual(started.status, 200);
  assert.strictEqual(started.body.batch.status, "running");
  assert.strictEqual(spawns.length, 2);
  assert.deepStrictEqual(
    spawns[1].args.slice(spawns[1].args.indexOf("--browser")),
    ["--browser", "edge"]
  );

  setCommunicationBatchStatus(db, {
    batchId,
    status: "interrupted",
    stopCode: "BROWSER_DISCONNECTED",
    stopMessage: "test interruption"
  });
  const interruptedReview = await getText(baseUrl, `/communication?batchId=${batchId}`);
  assert.match(interruptedReview.body, /name="action" value="resume"/);
  const resumedBatch = await postJson(baseUrl, "/api/communication-control", {
    batchId,
    action: "resume"
  });
  assert.strictEqual(resumedBatch.status, 200);
  assert.strictEqual(resumedBatch.body.batch.status, "running");
  assert.strictEqual(spawns.length, 3);
  assert(spawns[1].args.includes("communicate"));
  assert(spawns[1].args.includes(String(batchId)));
  await expectApiError(baseUrl, "/api/communication-control", { batchId, action: "start" }, "COMMUNICATION_BATCH_STATUS_INVALID", 409);

  const [ambiguousItem, pendingAfterAmbiguity] = listCommunicationBatchItems(db, batchId);
  transitionCommunicationItem(db, { itemId: ambiguousItem.id, expectedStatus: "pending", status: "opening" });
  transitionCommunicationItem(db, { itemId: ambiguousItem.id, expectedStatus: "opening", status: "verified" });
  transitionCommunicationItem(db, { itemId: ambiguousItem.id, expectedStatus: "verified", status: "click_dispatched", audit: clickAudit(ambiguousItem) });
  transitionCommunicationItem(db, {
    itemId: ambiguousItem.id,
    expectedStatus: "click_dispatched",
    status: "ambiguous",
    errorCode: "COMMUNICATION_ACTION_NOT_TRIGGERED"
  });
  setCommunicationBatchStatus(db, {
    batchId,
    status: "interrupted",
    stopCode: "COMMUNICATION_RESULT_AMBIGUOUS",
    stopMessage: "manual review required"
  });
  const ambiguousReview = await getText(baseUrl, `/communication?batchId=${batchId}`);
  assert.match(ambiguousReview.body, /name="evidenceNote"[^>]*required/);
  assert.doesNotMatch(ambiguousReview.body, /name="action" value="resume"/);
  assert.match(ambiguousReview.body, /等待人工确认沟通结果/);
  assert.match(ambiguousReview.body, /平台没有响应本次点击，RoleFlow 已停止且不会自动重试。/);
  assert.match(ambiguousReview.body, /COMMUNICATION_ACTION_NOT_TRIGGERED/);
  assert.doesNotMatch(ambiguousReview.body, /重新检查浏览器页面/);
  assert.match(ambiguousReview.body, new RegExp(`href="/communication\\?batchId=${batchId}#communication-item-${ambiguousItem.id}"`));
  assert.match(ambiguousReview.body, new RegExp(`id="communication-item-${ambiguousItem.id}"`));
  await expectApiError(baseUrl, "/api/communication-control", { batchId, action: "resume" }, "COMMUNICATION_RESUME_REQUIRES_REVIEW", 409);
  await expectApiError(baseUrl, "/api/communication-resolve", { batchId, itemId: ambiguousItem.id, status: "pending", evidenceNote: "invalid status" }, "COMMUNICATION_AMBIGUOUS_RESOLUTION_INVALID");
  await expectApiError(baseUrl, "/api/communication-resolve", { batchId, itemId: ambiguousItem.id, status: "stopped" }, "COMMUNICATION_AMBIGUOUS_EVIDENCE_REQUIRED");
  const evidenceNote = "岗位页无法确认结果，人工停止";
  const resolved = await postJson(baseUrl, "/api/communication-resolve", { batchId, itemId: ambiguousItem.id, status: "stopped", evidenceNote });
  assert.strictEqual(resolved.status, 200);
  assert.strictEqual(resolved.body.item.status, "stopped");
  const resolutionAudit = db.prepare("SELECT payload_json FROM events WHERE job_id = ? AND event_type = 'communication_manual_resolution' ORDER BY id DESC LIMIT 1").get(fixture.primaryId);
  assert.strictEqual(JSON.parse(resolutionAudit.payload_json).note, evidenceNote);
  assert.strictEqual(db.prepare("SELECT status FROM candidate_job_states WHERE profile_id = ? AND job_id = ?").get(1, fixture.primaryId), undefined);
  const resumedAfterReview = await postJson(baseUrl, "/api/communication-control", {
    batchId,
    action: "resume"
  });
  assert.strictEqual(resumedAfterReview.status, 200);
  assert.strictEqual(resumedAfterReview.body.batch.status, "running");
  assert.strictEqual(spawns.length, 4);

  const discardable = await postJson(baseUrl, "/api/communication-batch", { planId: fixture.planId, jobIds: fixture.talkId, browserMode: "edge" });
  const discarded = await postForm(baseUrl, "/api/communication-control", { batchId: discardable.body.batch.id, action: "discard" });
  assert.strictEqual(discarded.status, 303);
  assert.strictEqual(discarded.location, `/communication?batchId=${discardable.body.batch.id}`);
  assert.strictEqual(getCommunicationBatch(db, discardable.body.batch.id).status, "stopped");
  assert.deepStrictEqual(listCommunicationBatchItems(db, discardable.body.batch.id).map((item) => item.status), ["stopped"]);

  const protectedBatch = await postJson(baseUrl, "/api/communication-batch", { planId: fixture.planId, jobIds: fixture.safeId, browserMode: "edge" });
  const protectedItem = listCommunicationBatchItems(db, protectedBatch.body.batch.id)[0];
  transitionCommunicationItem(db, { itemId: protectedItem.id, expectedStatus: "pending", status: "opening" });
  transitionCommunicationItem(db, { itemId: protectedItem.id, expectedStatus: "opening", status: "verified" });
  transitionCommunicationItem(db, { itemId: protectedItem.id, expectedStatus: "verified", status: "click_dispatched", audit: clickAudit(protectedItem) });
  transitionCommunicationItem(db, { itemId: protectedItem.id, expectedStatus: "click_dispatched", status: "succeeded" });
  await expectApiError(baseUrl, "/api/communication-control", { batchId: protectedBatch.body.batch.id, action: "discard" }, "COMMUNICATION_DISCARD_PROTECTED");

  for (let index = 0; index < 150; index += 1) recordSiteAccessEvent(db, { site: "boss", action: "communication_visit" });
  await expectApiError(baseUrl, "/api/communication-batch", { planId: fixture.planId, jobIds: fixture.safeId, browserMode: "edge" }, "COMMUNICATION_QUOTA_EXHAUSTED");
  setSiteRuntimeState(db, "boss", { status: "blocked", reasonCode: "BOSS_RISK_CONTROL", details: { blockedUntil: "2099-01-01T00:00:00.000Z" } });
  const blockedBuilder = await getText(baseUrl, `/communication/new?planId=${fixture.planId}`);
  assert.match(blockedBuilder.body, /BOSS_RISK_CONTROL/);
  const blockedPlan = await getText(baseUrl, `/plan?planId=${fixture.planId}`);
  assert.match(blockedPlan.body, /data-scan-button name="scanKind" value="daily" disabled/);
  assert.match(blockedPlan.body, /data-scan-button name="scanKind" value="broad" disabled/);
  assert.strictEqual(spawns.length, 4);
  await portableDashboardAuthoritySmoke();
  console.log("dashboard_communication_batch_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (db) db.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.rmSync(`${dbPath}${suffix}`, { force: true }); } catch {}
  }
});

async function portableDashboardAuthoritySmoke() {
  const database = openDb(":memory:");
  const portableSpawns = [];
  let portableServer;
  try {
    const fixture = seed(database);
    const portableWorkflowScanBatchId = createBatch(database, "boss", "portable-dashboard-workflow", "portable dashboard workflow", {
      profileId: fixture.profileId,
      searchPlanId: fixture.planId
    });
    const portableWorkflowJobId = upsertJob(database, job("portable-dashboard-workflow", {
      title: "Portable dashboard workflow role",
      description: "Build and operate production Python services with complete delivery ownership and measurable outcomes. ".repeat(4)
    }), portableWorkflowScanBatchId);
    const portableSearchUrl = "https://www.zhipin.com/web/geek/jobs?city=100010000&query=portable";
    const portableBrowser = {
      async listTabs() {
        return [
          { id: "CDP-search", windowId: 17, url: portableSearchUrl },
          { id: "CDP-chat", windowId: 17, url: "https://www.zhipin.com/web/geek/chat" }
        ];
      },
      async evalValue(tabId) {
        const search = tabId === "CDP-search";
        return {
          url: search ? portableSearchUrl : "https://www.zhipin.com/web/geek/chat",
          path: search ? "/web/geek/jobs" : "/web/geek/chat",
          title: search ? "BOSS portable search" : "BOSS portable chat",
          isBoss: true,
          isLoginPage: false,
          isRiskPage: false,
          loggedIn: true,
          isSearchPage: search,
          hasJobStructure: search,
          scrollTop: search ? 360 : 0
        };
      },
      async createTab() { throw new Error("portable rebind must not create a tab"); },
      async navigate() { throw new Error("portable rebind must not navigate"); }
    };
    portableServer = createDashboardServer({
      db: database,
      root,
      dbPath: "D:\\DevData\\roleflow-portable-dashboard-fixture.sqlite",
      browserAuthority: {
        browserMode: "portable",
        cdpPort: 9222,
        profilePath: "D:\\DevData\\roleflow-portable-dashboard-profile"
      },
      logger,
      browserFactory(authority) {
        assert.deepStrictEqual(authority, { browserMode: "portable", cdpPort: 9222 });
        return portableBrowser;
      },
      spawnProcess(file, args, options) {
        portableSpawns.push({ file, args, options });
        const child = new EventEmitter();
        child.pid = 6262;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        return child;
      }
    });
    const portableBaseUrl = await listen(portableServer);
    const builder = await getText(portableBaseUrl, `/communication/new?planId=${fixture.planId}`);
    assert.match(builder.body, /浏览器：RoleFlow 专用 Edge（推荐）（Dashboard 已固定）/);
    assert.match(builder.body, /<input type="hidden" name="browserMode" value="portable">/);
    assert.doesNotMatch(builder.body, /<select name="browserMode">/);

    const beforeForged = communicationAuthorityWriteSnapshot(database);
    await expectApiError(portableBaseUrl, "/api/communication-batch", {
      planId: fixture.planId,
      jobIds: fixture.primaryId,
      browserMode: "edge"
    }, "DASHBOARD_BROWSER_AUTHORITY_MISMATCH", 409);
    await expectApiError(portableBaseUrl, "/api/communication-batch", {
      planId: fixture.planId,
      jobIds: fixture.primaryId,
      browserMode: "portable",
      cdpPort: 9223
    }, "DASHBOARD_BROWSER_AUTHORITY_MISMATCH", 409);
    assert.deepStrictEqual(communicationAuthorityWriteSnapshot(database), beforeForged);

    const defaulted = await postJson(portableBaseUrl, "/api/communication-batch", {
      planId: fixture.planId,
      jobIds: fixture.primaryId
    });
    assert.strictEqual(defaulted.status, 200);
    assert.deepStrictEqual(defaulted.body.batch.policySnapshot.browser, { mode: "portable", cdpPort: 9222 });

    const mismatchedWorkflow = reviewWorkflow(database, {
      id: "portable-dashboard-workflow-mismatch",
      planId: fixture.planId,
      localDay: "2098-02-01",
      planner: { browserMode: "portable", cdpPort: 9223, acquisitionMode: "inherited" }
    });
    const beforeWorkflowPortMismatch = communicationAuthorityWriteSnapshot(database);
    await expectApiError(portableBaseUrl, "/api/communication-batch", {
      workflowRunId: mismatchedWorkflow.id,
      planId: fixture.planId,
      jobIds: portableWorkflowJobId
    }, "DASHBOARD_BROWSER_AUTHORITY_MISMATCH", 409);
    assert.deepStrictEqual(communicationAuthorityWriteSnapshot(database), beforeWorkflowPortMismatch);
    assert.strictEqual(getWorkflowRun(database, mismatchedWorkflow.id).communicationBatchId, null);

    database.prepare("UPDATE workflow_runs SET planner_json = ? WHERE id = ?").run(JSON.stringify({
      ...mismatchedWorkflow.planner,
      browserMode: "edge",
      cdpPort: null
    }), mismatchedWorkflow.id);
    const beforeWorkflowModeMismatch = communicationAuthorityWriteSnapshot(database);
    await expectApiError(portableBaseUrl, "/api/communication-batch", {
      workflowRunId: mismatchedWorkflow.id,
      planId: fixture.planId,
      jobIds: portableWorkflowJobId
    }, "DASHBOARD_BROWSER_AUTHORITY_MISMATCH", 409);
    assert.deepStrictEqual(communicationAuthorityWriteSnapshot(database), beforeWorkflowModeMismatch);
    assert.strictEqual(getWorkflowRun(database, mismatchedWorkflow.id).communicationBatchId, null);

    database.prepare("UPDATE workflow_runs SET planner_json = ? WHERE id = ?").run(JSON.stringify({
      ...mismatchedWorkflow.planner,
      browserMode: "portable",
      cdpPort: 9222
    }), mismatchedWorkflow.id);
    const matchedWorkflow = getWorkflowRun(database, mismatchedWorkflow.id);
    const workflowBatch = await postJson(portableBaseUrl, "/api/communication-batch", {
      workflowRunId: matchedWorkflow.id,
      planId: fixture.planId,
      jobIds: portableWorkflowJobId,
      browserMode: "portable",
      cdpPort: 9222
    });
    assert.strictEqual(workflowBatch.status, 200, JSON.stringify(workflowBatch.body));
    assert.strictEqual(getWorkflowRun(database, matchedWorkflow.id).communicationBatchId, workflowBatch.body.batch.id);

    const rebindBatch = await postJson(portableBaseUrl, "/api/communication-batch", {
      planId: fixture.planId,
      jobIds: fixture.rebindId
    });
    bindCommunicationBatchRuntime(database, {
      batchId: rebindBatch.body.batch.id,
      browser: browserBinding({
        mode: "portable",
        windowId: 17,
        searchTabId: "CDP-search-old",
        messageTabId: "CDP-chat-old",
        searchReturnUrl: portableSearchUrl
      })
    });
    setCommunicationBatchStatus(database, { batchId: rebindBatch.body.batch.id, status: "running" });
    setCommunicationBatchStatus(database, { batchId: rebindBatch.body.batch.id, status: "paused" });
    const rebound = await postJson(portableBaseUrl, "/api/communication-rebind", { batchId: rebindBatch.body.batch.id });
    assert.strictEqual(rebound.status, 200);
    assert.deepStrictEqual(getCommunicationBatch(database, rebindBatch.body.batch.id).runtime.browser, browserBinding({
      mode: "portable",
      windowId: 17,
      searchTabId: "CDP-search",
      messageTabId: "CDP-chat",
      searchReturnUrl: portableSearchUrl,
      searchScrollTop: 360,
      bindingGeneration: 2
    }));
    const resumed = await postJson(portableBaseUrl, "/api/communication-control", {
      batchId: rebindBatch.body.batch.id,
      action: "resume"
    });
    assert.strictEqual(resumed.status, 200);
    assert.strictEqual(getCommunicationBatch(database, rebindBatch.body.batch.id).runtime.browser.bindingGeneration, 3);
    assert.strictEqual(portableSpawns.length, 1);

    const wrongModeBatch = createCommunicationBatch(database, {
      planId: fixture.planId,
      jobIds: [fixture.safeId],
      browserMode: "edge"
    });
    const wrongModeItem = listCommunicationBatchItems(database, wrongModeBatch.id)[0];
    await expectApiError(portableBaseUrl, "/api/communication-control", {
      batchId: wrongModeBatch.id,
      action: "start_one",
      itemId: wrongModeItem.id
    }, "DASHBOARD_BROWSER_AUTHORITY_MISMATCH", 409);
    assert.strictEqual(getCommunicationBatch(database, wrongModeBatch.id).status, "confirmed");
    assert.strictEqual(portableSpawns.length, 1);
    bindCommunicationBatchRuntime(database, { batchId: wrongModeBatch.id, browser: browserBinding() });
    setCommunicationBatchStatus(database, { batchId: wrongModeBatch.id, status: "running" });
    setCommunicationBatchStatus(database, { batchId: wrongModeBatch.id, status: "paused" });
    await expectApiError(portableBaseUrl, "/api/communication-rebind", {
      batchId: wrongModeBatch.id
    }, "DASHBOARD_BROWSER_AUTHORITY_MISMATCH", 409);

    const wrongPortBatch = createCommunicationBatch(database, {
      planId: fixture.planId,
      jobIds: [fixture.backupId],
      browserMode: "portable"
    });
    database.prepare("UPDATE communication_batches SET policy_json = ? WHERE id = ?").run(JSON.stringify({
      ...wrongPortBatch.policySnapshot,
      browser: { mode: "portable", cdpPort: 9223 }
    }), wrongPortBatch.id);
    const wrongPortItem = listCommunicationBatchItems(database, wrongPortBatch.id)[0];
    await expectApiError(portableBaseUrl, "/api/communication-control", {
      batchId: wrongPortBatch.id,
      action: "start_one",
      itemId: wrongPortItem.id
    }, "DASHBOARD_BROWSER_AUTHORITY_MISMATCH", 409);
    assert.strictEqual(portableSpawns.length, 1);
  } finally {
    if (portableServer) await new Promise((resolve) => portableServer.close(resolve));
    database.close();
  }
}

function communicationAuthorityWriteSnapshot(database) {
  return {
    batches: Number(database.prepare("SELECT COUNT(*) AS count FROM communication_batches").get().count),
    items: Number(database.prepare("SELECT COUNT(*) AS count FROM communication_batch_items").get().count),
    events: Number(database.prepare("SELECT COUNT(*) AS count FROM events").get().count),
    quota: communicationQuotaSnapshot(database)
  };
}

function seed(database) {
  const now = new Date().toISOString();
  const profileId = Number(database.prepare("INSERT INTO candidate_profiles(display_name, profile_json, created_at, updated_at) VALUES (?, ?, ?, ?)").run("Dashboard smoke", "{}", now, now).lastInsertRowid);
  const planId = Number(database.prepare("INSERT INTO search_plans(profile_id, name, plan_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(profileId, "Dashboard smoke", "{}", now, now).lastInsertRowid);
  const scanBatchId = createBatch(database, "boss", "dashboard-communication", "dashboard communication smoke", { profileId, searchPlanId: planId });
  const primaryId = upsertJob(database, job("primary", { title: "Primary role", qualityTags: ["salary_target_core"], analysis: completeAnalysis() }), scanBatchId);
  const talkId = upsertJob(database, job("talk", { title: "Talk role", analysis: completeAnalysis("apply") }), scanBatchId);
  const backupId = upsertJob(database, job("backup", { title: "Backup role", analysis: completeAnalysis("caution"), qualityTags: ["experience_overrange"] }), scanBatchId);
  const notRecommendedId = upsertJob(database, job("not-recommended", { title: "Not recommended role", level: "不建议", analysis: completeAnalysis("not_recommended"), qualityTags: ["hard_exclude"] }), scanBatchId);
  const appliedId = upsertJob(database, job("applied", { title: "Applied role" }), scanBatchId);
  const safeId = upsertJob(database, job("safe", { title: "Safe role" }), scanBatchId);
  const rebindId = upsertJob(database, job("rebind", { title: "Rebind role" }), scanBatchId);
  const historySucceededId = upsertJob(database, job("history-succeeded", { title: "Previously communicated role" }), scanBatchId);
  const skippedId = upsertJob(database, job("skipped", { title: "Skipped role" }), scanBatchId);
  const summaryDriftStartId = upsertJob(database, job("summary-drift-start"), scanBatchId);
  const summaryDriftResumeId = upsertJob(database, job("summary-drift-resume"), scanBatchId);
  const itemDriftStartId = upsertJob(database, job("item-drift-start"), scanBatchId);
  const itemDriftResumeId = upsertJob(database, job("item-drift-resume"), scanBatchId);
  for (let index = 0; index < 35; index += 1) {
    upsertJob(database, job(`extra-${index}`, { title: `Extra role ${index}`, analysis: completeAnalysis("apply") }), scanBatchId);
  }
  markCandidateJob(database, { profileId, planId, jobId: appliedId, status: "applied" });
  markCandidateJob(database, { profileId, planId, jobId: skippedId, status: "skipped" });

  const smallPlanId = Number(database.prepare("INSERT INTO search_plans(profile_id, name, plan_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(profileId, "Small dashboard smoke", "{}", now, now).lastInsertRowid);
  const smallBatchId = createBatch(database, "boss", "small-dashboard-communication", "small dashboard communication smoke", { profileId, searchPlanId: smallPlanId });
  for (let index = 0; index < 21; index += 1) {
    upsertJob(database, job(`small-${index}`, { title: `Small role ${index}`, analysis: completeAnalysis("apply") }), smallBatchId);
  }
  const otherProfileId = Number(database.prepare("INSERT INTO candidate_profiles(display_name, profile_json, created_at, updated_at) VALUES (?, ?, ?, ?)").run("Other dashboard smoke", "{}", now, now).lastInsertRowid);
  Number(database.prepare("INSERT INTO search_plans(profile_id, name, plan_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(otherProfileId, "Other dashboard plan", "{}", now, now).lastInsertRowid);
  return { profileId, scanBatchId, planId, smallPlanId, otherProfileId, primaryId, talkId, backupId, notRecommendedId, appliedId, skippedId, safeId, rebindId, historySucceededId, summaryDriftStartId, summaryDriftResumeId, itemDriftStartId, itemDriftResumeId };
}

function reviewWorkflow(database, { id, planId, localDay, planner = {} }) {
  const run = createWorkflowRun(database, {
    id,
    profileId: 1,
    planId,
    localDay,
    sequence: 1,
    targetSuccessCount: 2,
    inventoryCount: 2,
    scanNeeded: false,
    planner
  });
  return transitionWorkflowRun(database, { id: run.id, status: "review_required" });
}

function browserBinding(overrides = {}) {
  return {
    mode: "edge",
    windowId: 103,
    searchTabId: 101,
    messageTabId: 102,
    searchReturnUrl: "https://www.zhipin.com/web/geek/jobs?city=100010000&query=old&page=1",
    searchScrollTop: 120,
    bindingGeneration: 1,
    ...overrides
  };
}

function job(sourceId, overrides = {}) {
  return { source: "boss", sourceId, keyword: "dashboard-communication", title: "Communication role", company: `Company ${sourceId}`, location: "Guangzhou", salary: "10-15K", experience: "1-3 years", education: "Bachelor", bossActiveText: "Active today", bossActiveDays: 0, url: `https://www.zhipin.com/job_detail/${sourceId}.html`, tags: ["Python"], description: "Dashboard communication batch smoke job.", score: 20, level: "可投", matches: ["Python"], risks: [], qualityTags: [], analysis: completeAnalysis(), ...overrides };
}

function completeAnalysis(recommendation = "primary") {
  return { semanticStatus: "complete", recommendation, recommendationSchemaVersion: 2, fitLevel: recommendation === "primary" ? "fit" : "mostly_fit", confidence: 0.9, evidence: { jd: ["Python"], resume: ["Python"] } };
}

function clickAudit(item) {
  return { eventType: "communication_click", payload: { batchId: item.batchId, itemId: item.id, jobId: item.jobId, state: "click_dispatched" } };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function getText(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  return { status: response.status, body: await response.text() };
}

async function getJson(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  return { status: response.status, body: await response.json() };
}

async function postJson(baseUrl, pathname, body) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, String(item));
  }
  const response = await fetch(`${baseUrl}${pathname}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: params, redirect: "manual" });
  return { status: response.status, body: await response.json() };
}

async function postForm(baseUrl, pathname, body) {
  const params = new URLSearchParams(body);
  const response = await fetch(`${baseUrl}${pathname}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: params, redirect: "manual" });
  return {
    status: response.status,
    location: response.headers.get("location"),
    contentType: response.headers.get("content-type") || "",
    body: await response.text()
  };
}

async function expectApiError(baseUrl, pathname, body, code, status = 400) {
  const response = await postJson(baseUrl, pathname, body);
  assert.strictEqual(response.status, status);
  assert.strictEqual(response.body.errorCode, code);
}
