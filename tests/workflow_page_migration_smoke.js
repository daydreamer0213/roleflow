"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { buildWorkflowViewModel } = require("../src/dashboard/view_models/workflow");
const { renderWorkflowPage } = require("../src/dashboard/pages/workflow");
const { renderPage } = require("../src/dashboard/ui/shell");
const { assertStrictPrimary } = require("../scripts/evaluate-workflow-dashboard");

const root = path.join(__dirname, "..");
const asset = path.join(root, "src", "dashboard", "assets", "workflow.js");
const stylesheet = path.join(root, "src", "dashboard", "assets", "roleflow.css");

(async () => {
  const vm = buildWorkflowViewModel(fixture());
  assert.deepStrictEqual(JSON.parse(JSON.stringify(vm)), vm, "workflow VM must be plain display data without DB or browser dependencies");
  assert.deepStrictEqual(vm.scope.actualKeywords, ["AI应用开发", "RAG", "Agent开发"]);
  assert.strictEqual(vm.scope.candidateKeywordCount, 14);
  assert.strictEqual(vm.overview.acquisitionProgress, "搜索目标 2 / 5 · 已获取 12 个岗位");
  assert.strictEqual(vm.overview.jdProgress, "已读取 5 / 12 · 待补 7");
  assertRendererContracts(vm);
  assertEvaluatorStrictGate();
  await assertClientContracts(vm);
  assertEvaluatorContracts();
  console.log("workflow_page_migration_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

function fixture(overrides = {}) {
  const workflow = {
    id: "workflow-migration-fixture",
    planId: 17,
    status: "scanning",
    sequence: 2,
    localDay: "2099-01-02",
    targetSuccessCount: 35,
    successfulCount: 3,
    inventoryCount: 9,
    errorCode: "",
    errorMessage: "",
    shortfallCode: "",
    communicationBatchId: null,
    keywords: ["AI应用开发", "RAG", "Agent开发"],
    planner: {
      acquisitionMode: "inherited",
      browserMode: "edge",
      searchScope: { key: "scope-fixture" },
      keywordSource: {
        searchPlanId: 17,
        keywords: Array.from({ length: 14 }, (_, index) => ({ word: `候选词${index + 1}` }))
      },
      platformPolicy: { filterSummary: ["上海"], unresolvedParams: [] }
    }
  };
  const progressSnapshot = {
    workflow: { id: workflow.id, status: workflow.status, controlState: "", progressRevision: 4, lastActivityAt: new Date().toISOString() },
    progress: {
      stage: "正在读取岗位详情",
      stageIndex: 1,
      stageCount: 3,
      scanWait: { retryAt: "2099-01-02T10:05:00.000Z" },
      eta: { status: "estimating" },
      scanTargets: { total: 5, completed: 2, pending: 3, partial: 1, failed: 1 },
      details: { collected: 12, read: 5, pending: 7 },
      communication: { total: 0, pending: 0, ambiguous: 0, succeeded: 0, stopped: 0 },
      remainingWorkLabel: "还需完成 3 个搜索目标；7 个岗位详情待读取",
      analysis: { total: 12, succeeded: 3, running: 1, retryPending: 2, detailRequired: 4, failed: 1, skipped: 0, stopped: 0, pending: 5, circuitTimeoutJobs: 0, timeoutPauseThreshold: 10, lifetimeTimeoutJobs: 0 }
    },
    model: { provider: "mock", model: "workflow-fixture" },
    controls: { canPause: true, canResume: false, canStop: true, stopConsumesRunSlot: true },
    recentActivity: [{ type: "analysis_started", taskId: 9 }]
  };
  return {
    workflow: { ...workflow, ...(overrides.workflow || {}) },
    plan: { id: 17, profileId: 8 },
    daily: { successfulToday: 8, dailyTarget: 70 },
    communication: overrides.communication || null,
    runtimeBlock: overrides.runtimeBlock || null,
    progressSnapshot: Object.hasOwn(overrides, "progressSnapshot") ? overrides.progressSnapshot : progressSnapshot,
    stopPreview: { collected: 12, analyzed: 3, failed: 1, unfinished: 8, access: { details: 4, pages: 2, scrolls: 1 }, consumesRunSlot: true },
    healthPanel: "<section data-trusted-health>健康面板</section>",
    reviewCandidates: overrides.reviewCandidates || [],
    quota: overrides.quota || { remaining: 0 }
  };
}

function assertRendererContracts(vm) {
  const unsafe = buildWorkflowViewModel(fixture({ workflow: { status: "interrupted", errorMessage: `<img src=x onerror=alert(1)>` } }));
  const unsafeHtml = renderWorkflowPage(unsafe);
  assert.match(unsafeHtml, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(unsafeHtml, /<img src=x onerror=/);

  const html = renderWorkflowPage(vm);
  assert.match(html, /class="app-shell"/, "workflow must use the shared dashboard frame");
  assertNoPrimary(html, "scanning");
  assert.match(html, /class="secondary"[^>]*data-action="pause"[^>]*>暂停本轮/, "scanning must keep pause available as a secondary action");
  assert.match(html, /系统正在继续处理，无需操作/);
  assert.match(html, /还需完成 3 个搜索目标；7 个岗位详情待读取/);
  assert.match(html, /<script src="\/assets\/workflow\.js"><\/script>/, "workflow behavior must come from the allowlisted external asset");
  assert.strictEqual((html.match(/<script/gi) || []).length, 1, "renderer must not copy client behavior inline");
  assert.doesNotMatch(fs.readFileSync(asset, "utf8"), /\.focus\(\)/, "workflow polling must not move keyboard focus");
  assert.match(html, /name="workflowRunId" value="workflow-migration-fixture"/);
  assert.match(html, /name="action" value="pause"/);
  assert.match(html, /name="action" value="stop"/);
  assert.match(html, /name="confirmStop" value="1"/);
  assert.match(html, /data-scan-wait/);
  assert.match(html, /data-detail-read/);
  assert.match(html, /data-detail-pending/);
  assert.match(html, /data-analysis-detail-required/);
  assert.match(html, /本轮实际关键词：AI应用开发、RAG、Agent开发/);
  assert.match(html, /方案候选词：14 个/);
  assert.doesNotMatch(html, /候选词1、候选词2/);
  assert.match(html, /data-overview-acquisition[^>]*>搜索目标 2 \/ 5 · 已获取 12 个岗位/);
  assert.match(html, /data-overview-jd[^>]*>已读取 5 \/ 12 · 待补 7/);

  const paused = renderWorkflowPage(buildWorkflowViewModel(fixture({ workflow: { status: "paused", errorCode: "SAFE_PAUSE" }, progressSnapshot: { workflow: { id: "workflow-migration-fixture", status: "paused", controlState: "", progressRevision: 5, lastActivityAt: new Date().toISOString() }, controls: { canPause: false, canResume: true, canStop: true, stopConsumesRunSlot: true } } })));
  assert.match(paused, /data-control-group="paused"/);
  assert.match(paused, /name="action" value="resume"/);
  assertSinglePrimary(paused, "paused", "继续本轮");
  assert.match(paused, /data-workflow-primary="true"[^>]*>继续本轮/);
  assertPrimaryBeforeDetails(paused, "paused");

  const review = renderWorkflowPage(buildWorkflowViewModel(fixture({ workflow: { status: "review_required" }, progressSnapshot: null, reviewCandidates: [{ id: 71, url: "https://example.test/immutable", title: "候选岗位", company: "甲公司", salary: "20K", experience: "3年", analysis: {}, workflowTier: "primary", defaultChecked: true }], quota: { remaining: 1 } })));
  assert.match(review, /id="workflow-review-form"/);
  assertSinglePrimary(review, "review", "确认清单");
  assert.match(review, /data-workflow-primary="true"[^>]*>确认清单/);
  assert.ok(review.indexOf('id="workflow-confirm"') < review.indexOf('class="workflow-list"'), "review confirmation must precede the full job list");
  assert.match(review, /name="jobIds" value="71" checked/);
  assert.match(review, /href="https:\/\/example\.test\/immutable"/);

  const confirmed = renderWorkflowPage(buildWorkflowViewModel(fixture({ workflow: { status: "review_required", communicationBatchId: 41 }, progressSnapshot: null, communication: { batch: { id: 41, status: "confirmed" }, calibration: { executionEnabled: true }, summary: { total: 2, statusCounts: {}, terminal: 0 } } })));
  assertSinglePrimary(confirmed, "confirmed", "开始沟通");
  assert.match(confirmed, /name="batchId" value="41"/);
  assert.match(confirmed, /name="action" value="start"/);

  const communicating = renderWorkflowPage(buildWorkflowViewModel(fixture({ workflow: { status: "communicating", communicationBatchId: 41 }, progressSnapshot: null, communication: { batch: { id: 41, status: "running" }, calibration: { executionEnabled: true }, summary: { total: 2, statusCounts: { click_dispatched: 1 }, terminal: 0 } } })));
  assertSinglePrimary(communicating, "communicating", "查看执行明细");
  assert.match(communicating, /正在沟通/);
  assert.match(communicating, /已发出操作/);
  assert.match(communicating, /data-polling-key="communicating\|running\|3\|0\|0\|0"/);
  assert.doesNotMatch(communicating, />click_dispatched</);

  const unknownCommunicationStatus = renderWorkflowPage(buildWorkflowViewModel(fixture({ workflow: { status: "communicating", communicationBatchId: 41 }, progressSnapshot: null, communication: { batch: { id: 41, status: "running" }, calibration: { executionEnabled: true }, summary: { total: 1, statusCounts: { future_status: 1 }, terminal: 0 } } })));
  assert.match(unknownCommunicationStatus, /状态待确认/);
  assert.doesNotMatch(unknownCommunicationStatus, />future_status</);

  const completed = renderWorkflowPage(buildWorkflowViewModel(fixture({ workflow: { status: "completed", successfulCount: 35 }, progressSnapshot: null })));
  assertSinglePrimary(completed, "completed", "返回今日任务");
  assert.match(completed, /本轮已完成/);

  const interrupted = renderWorkflowPage(buildWorkflowViewModel(fixture({ workflow: { status: "interrupted", communicationBatchId: 41, errorCode: "SAFE_STOP" }, progressSnapshot: null })));
  assertSinglePrimary(interrupted, "interrupted", "检查沟通中断项");
  assert.match(interrupted, /检查沟通中断项/);
  assert.match(interrupted, /data-workflow-primary="true"/);
  assert.match(interrupted, /communication\?batchId=41/);

  const actionNotTriggered = renderWorkflowPage(buildWorkflowViewModel(fixture({
    workflow: {
      status: "interrupted",
      communicationBatchId: 41,
      errorCode: "COMMUNICATION_ACTION_NOT_TRIGGERED"
    },
    progressSnapshot: null
  })));
  assert.match(actionNotTriggered, /平台没有响应本次点击，RoleFlow 已停止且不会自动重试。/);
  assert.match(actionNotTriggered, /COMMUNICATION_ACTION_NOT_TRIGGERED/);

  const unsafeUrl = renderWorkflowPage(buildWorkflowViewModel(fixture({ workflow: { status: "review_required" }, progressSnapshot: null, reviewCandidates: [{ id: 91, url: "javascript:alert(1)", title: "不安全链接", company: "甲", analysis: {}, workflowTier: "primary", defaultChecked: true }], quota: { remaining: 1 } })));
  assert.match(unsafeUrl, /不安全链接/);
  assert.doesNotMatch(unsafeUrl, /href="javascript:/i, "review must not create executable links from an unsafe URL");

  const resumable = renderWorkflowPage(buildWorkflowViewModel(fixture({ workflow: { status: "interrupted", communicationBatchId: null, errorCode: "SAFE_STOP" }, progressSnapshot: null })));
  assertSinglePrimary(resumable, "resumable interrupted", "继续本轮");

  const fallback = renderWorkflowPage(buildWorkflowViewModel(fixture({ workflow: { status: "failed", errorCode: "SAFE_FAILURE" }, progressSnapshot: null })));
  assertSinglePrimary(fallback, "fallback", "返回今日任务");
}

async function assertClientContracts(vm) {
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch (error) {
    if (process.env.ROLEFLOW_REQUIRE_PLAYWRIGHT === "1") throw error;
    console.log("workflow_page_migration_smoke browser checks skipped: Playwright unavailable in NODE_PATH");
    return;
  }
  let responses = [validSnapshot("scanning", 5), { malformed: true }];
  let requests = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === "/assets/workflow.js") return serve(res, "application/javascript", fs.readFileSync(asset));
    if (req.url === "/assets/roleflow.css") return serve(res, "text/css", fs.readFileSync(stylesheet));
    if (req.url?.startsWith("/api/workflow-status")) {
      requests += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(80);
      inFlight -= 1;
      return json(res, responses.shift() || validSnapshot("scanning"));
    }
    if (req.url === "/workflow") return serve(res, "text/html", workflowDocument(vm));
    res.writeHead(404); res.end();
  });
  const baseUrl = await listen(server);
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    const diagnostics = { console: [], pageErrors: [], failed: [], asset: [], cdp: [], config: null };
    page.on("console", (message) => diagnostics.console.push({ type: message.type(), text: message.text() }));
    page.on("pageerror", (error) => diagnostics.pageErrors.push({ message: error.message, stack: error.stack || "", name: error.name || "Error" }));
    page.on("requestfailed", (request) => diagnostics.failed.push({ url: request.url(), error: request.failure()?.errorText || "unknown" }));
    page.on("response", (response) => { if (response.url().endsWith("/assets/workflow.js")) diagnostics.asset.push({ status: response.status(), url: response.url() }); });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Runtime.enable");
    cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }) => diagnostics.cdp.push({ url: exceptionDetails.url || "", lineNumber: exceptionDetails.lineNumber, columnNumber: exceptionDetails.columnNumber, text: exceptionDetails.text, description: exceptionDetails.exception?.description || "" }));
    await page.goto(`${baseUrl}/workflow`, { waitUntil: "networkidle" });
    assert.deepStrictEqual(diagnostics.pageErrors, [], `workflow client must initialize without page errors: ${JSON.stringify(diagnostics.cdp)}`);
    await assertNoViewportPrimary(page);
    assert.strictEqual(await page.locator('[data-action="pause"]').isVisible(), true, "pause must remain available while scanning");
    assert.match(await page.locator('[data-action="pause"]').getAttribute("class"), /\bsecondary\b/, "pause must use the secondary treatment");
    const state = async () => page.evaluate(() => {
      const preview = document.querySelector('[data-action="stop-preview"]'); const confirm = document.querySelector('[data-stop-confirmation]');
      const ancestors = []; for (let node = confirm; node; node = node.parentElement) ancestors.push({ tag: node.tagName, hidden: node.hidden, display: getComputedStyle(node).display });
      const root = document.querySelector('[data-workflow-page]');
      return { preview: preview && { visible: !!(preview.offsetWidth || preview.offsetHeight), disabled: preview.disabled }, confirm: confirm && { attr: confirm.hasAttribute("hidden"), hidden: confirm.hidden, display: getComputedStyle(confirm).display, ancestors }, script: document.querySelector('script[src*="workflow.js"]')?.src || "", readyState: document.readyState, page: !!root, panel: !!document.querySelector('[data-workflow-panel]'), config: root && { pollKind: root.dataset.pollingKind, runId: root.dataset.workflowRunId, terminalStates: root.dataset.terminalStates, pollingKey: root.dataset.pollingKey } };
    });
    const before = await state(); diagnostics.config = before.config; await page.locator('[data-action="stop-preview"]').first().click(); const after = await state();
    try { assert.strictEqual(await page.locator('[data-action="stop-confirm"]').isVisible(), true, "stop preview must reveal the confirmation control"); } catch (error) { process.stderr.write(`workflow diagnostic: ${JSON.stringify({ before, after, diagnostics })}\n`); throw error; }
    await page.locator('[data-action="stop-cancel"]').click();
    assert.strictEqual(await page.locator("[data-stop-confirmation]").isHidden(), true, "stop cancellation must hide confirmation");
    await page.waitForFunction(() => {
      const error = document.querySelector("[data-workflow-error]");
      return Boolean(error && !error.hidden);
    }, null, { timeout: 4000 });
    assert.strictEqual(await page.locator("[data-workflow-error]").isVisible(), true, "malformed polling data must fail closed");
    assert.strictEqual(await page.locator('[data-action="pause"]').isDisabled(), true, "failed polling must disable control submission");
    assert.ok(maxInFlight <= 1, "polling requests must remain serialized");
    await waitFor(() => requests >= 3, 5000);
    assert.ok(requests >= 3, "polling must recover after a malformed response");
    await assertNoViewportPrimary(page);
    await page.close();

    const reviewVm = buildWorkflowViewModel(fixture({ workflow: { status: "review_required" }, progressSnapshot: null, reviewCandidates: [{ id: 1, url: "https://example.test/one", title: "一", company: "甲", analysis: {}, workflowTier: "primary", defaultChecked: true }, { id: 2, url: "https://example.test/two", title: "二", company: "乙", analysis: {}, workflowTier: "apply", defaultChecked: false }], quota: { remaining: 1 } }));
    const pausedVm = buildWorkflowViewModel(fixture({ workflow: { status: "paused", errorCode: "SAFE_PAUSE" }, progressSnapshot: { workflow: { id: "workflow-migration-fixture", status: "paused", controlState: "", progressRevision: 5, lastActivityAt: new Date().toISOString() }, controls: { canPause: false, canResume: true, canStop: true, stopConsumesRunSlot: true } } }));
    const interruptedVm = buildWorkflowViewModel(fixture({ workflow: { status: "interrupted", communicationBatchId: 41, errorCode: "SAFE_STOP" }, progressSnapshot: null }));
    const pages = new Map([["/review", reviewVm], ["/paused", pausedVm], ["/interrupted", interruptedVm]]);
    const reviewPage = await browser.newPage({ viewport: { width: 375, height: 812 } });
    server.removeAllListeners("request");
    server.on("request", (req, res) => {
      if (req.url === "/assets/workflow.js") return serve(res, "application/javascript", fs.readFileSync(asset));
      if (req.url === "/assets/roleflow.css") return serve(res, "text/css", fs.readFileSync(stylesheet));
      if (req.url?.startsWith("/api/workflow-status")) return json(res, validSnapshot("paused"));
      if (pages.has(req.url)) return serve(res, "text/html", workflowDocument(pages.get(req.url)));
      res.writeHead(404); res.end();
    });
    await reviewPage.goto(`${baseUrl}/review`, { waitUntil: "networkidle" });
    await assertViewportPrimary(reviewPage, "确认清单");
    assert.strictEqual(await reviewPage.locator("#workflow-selected-count").evaluate((element) => element.value), "1");
    await reviewPage.locator('input[name="jobIds"][value="2"]').check();
    assert.strictEqual(await reviewPage.locator("#workflow-confirm").isDisabled(), true, "review confirmation must respect quota after selection changes");
    await reviewPage.close();

    for (const [url, label] of [["/paused", "继续本轮"], ["/interrupted", "检查沟通中断项"]]) {
      const phasePage = await browser.newPage({ viewport: { width: 375, height: 812 } });
      await phasePage.goto(`${baseUrl}${url}`, { waitUntil: "networkidle" });
      if (url === "/paused") {
        const hierarchy = await phasePage.evaluate(() => {
          const primary = document.querySelector('[data-workflow-primary="true"]');
          const secondary = [...document.querySelectorAll('[data-control-group="paused"] .button-link')];
          const primaryStyle = getComputedStyle(primary);
          const secondaryStyle = secondary[0] ? getComputedStyle(secondary[0]) : null;
          return { count: secondary.length, primaryBackground: primaryStyle.backgroundColor, secondaryBackground: secondaryStyle?.backgroundColor || "", primaryColor: primaryStyle.color, secondaryColor: secondaryStyle?.color || "" };
        });
        assert.strictEqual(hierarchy.count, 2, "paused model settings links must use the secondary treatment");
        assert.notStrictEqual(hierarchy.primaryBackground, hierarchy.secondaryBackground, "paused primary must remain visually distinct without relying on focus");
        assert.notStrictEqual(hierarchy.primaryColor, hierarchy.secondaryColor, "paused secondary links must not mimic the primary action");
      }
      await assertViewportPrimary(phasePage, label);
      await phasePage.close();
    }
  } finally {
    await browser.close();
    await close(server);
  }
}

function assertEvaluatorContracts() {
  try {
    require.resolve("playwright");
  } catch (error) {
    if (process.env.ROLEFLOW_REQUIRE_PLAYWRIGHT === "1") throw error;
    console.log("workflow_page_migration_smoke evaluator checks skipped: Playwright unavailable in NODE_PATH");
    return;
  }
  const outputDir = fs.mkdtempSync(path.join(root, ".runtime", "workflow-evaluator-smoke-"));
  try {
    const result = spawnSync(process.execPath, [path.join(root, "scripts", "evaluate-workflow-dashboard.js"), "--target-root", root, "--output-dir", outputDir, "--label", "smoke", "--expect-primary"], { cwd: root, encoding: "utf8", env: process.env });
    assert.strictEqual(result.status, 0, `workflow evaluator must enforce the primary-action gate: ${result.stderr || result.stdout}`);
    const evaluation = JSON.parse(fs.readFileSync(path.join(outputDir, "smoke.json"), "utf8"));
    assert.strictEqual(evaluation.expectPrimary, true, "evaluator output must record strict primary mode");
    assert.strictEqual(evaluation.pages.length, 16, "evaluator must audit every state and viewport");
    for (const page of evaluation.pages) {
      const expectedPrimaryCount = page.state === "scanning" ? 0 : 1;
      assert.strictEqual(page.audit.primaryCount, expectedPrimaryCount, `${page.state} ${page.viewport.width}x${page.viewport.height} primary count must match the state contract`);
      assert.strictEqual(page.audit.visiblePrimaryCount, expectedPrimaryCount, `${page.state} ${page.viewport.width}x${page.viewport.height} visible primary count must match the state contract`);
      if (expectedPrimaryCount) {
        assert.strictEqual(page.audit.primary.fullyWithinViewport, true, `${page.state} ${page.viewport.width}x${page.viewport.height} primary must remain in the initial viewport`);
        assert.strictEqual(page.audit.primary.focused, true, `${page.state} ${page.viewport.width}x${page.viewport.height} primary must retain focus`);
        assert.strictEqual(page.audit.primary.outline.style, "solid", `${page.state} ${page.viewport.width}x${page.viewport.height} primary must have a solid focus outline`);
      }
      assert.ok(page.audit.document.width >= page.viewport.width && page.audit.body.width >= 0, "evaluator must record document and body widths");
      assert.strictEqual(typeof page.audit.motion.reduced, "boolean", "evaluator must record reduced-motion state");
      assert.strictEqual(typeof page.interaction, "object", "evaluator must record structured interaction results");
    }
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}

function assertEvaluatorStrictGate() {
  assert.throws(() => assertStrictPrimary({
    state: "scanning",
    viewport: { width: 375, height: 812 },
    audit: { primaryCount: 2, visiblePrimaryCount: 1, primary: { fullyWithinViewport: true, focused: true, outline: { style: "solid" } }, horizontalOverflow: false },
    interaction: { passed: true },
    errors: { console: [], page: [], request: [], external: [] }
  }), /primaryCount=2/, "strict evaluator must fail closed when a hidden duplicate primary remains");
}

function validSnapshot(status) {
  return {
    workflow: { status, controlState: "", progressRevision: status === "interrupted" ? 6 : 5, lastActivityAt: new Date().toISOString(), errorCode: "" },
    progress: { stage: "阶段", stageIndex: 1, stageCount: 3, scanWait: null, eta: { status: "estimating" }, scanTargets: { total: 5, completed: 2, pending: 3, partial: 0, failed: 0 }, details: { collected: 12, read: 5, pending: 7 }, remainingWorkLabel: "还需完成 3 个搜索目标；7 个岗位详情待读取", analysis: { total: 12, succeeded: 3, running: 0, retryPending: 0, detailRequired: 0, failed: 0, skipped: 0, stopped: 0, pending: 9, circuitTimeoutJobs: 0, timeoutPauseThreshold: 10, lifetimeTimeoutJobs: 0 } },
    controls: { canPause: status === "scanning", canResume: status === "paused", canStop: status !== "interrupted", stopConsumesRunSlot: true },
    recentActivity: []
  };
}

function serve(res, type, body) { res.writeHead(200, { "content-type": `${type}; charset=utf-8` }); res.end(body); }
function json(res, body) { serve(res, "application/json", JSON.stringify(body)); }
function workflowDocument(vm) { return renderPage({ title: "Workflow fixture", body: renderWorkflowPage(vm) }); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await delay(50);
  }
  return true;
}
function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`))); }
function close(server) { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
function assertSinglePrimary(html, phase, label) {
  assert.strictEqual((html.match(/data-workflow-primary="true"/g) || []).length, 1, `${phase} must render exactly one primary marker`);
  assert.match(html, new RegExp(`data-workflow-primary="true"[^>]*>${label}`), `${phase} must mark ${label} as primary`);
}
function assertNoPrimary(html, phase) {
  assert.strictEqual((html.match(/data-workflow-primary="true"/g) || []).length, 0, `${phase} must not promote an interruption action as the page primary`);
}
function assertPrimaryBeforeDetails(html, phase) {
  const primary = html.indexOf('data-workflow-primary="true"');
  const header = html.indexOf("</header>");
  const details = Math.min(...["class=\"workflow-scope\"", "class=\"workflow-live\""].map((marker) => html.indexOf(marker)).filter((index) => index >= 0));
  assert.ok(primary > header && primary < details, `${phase} primary command must render after the header and before details`);
}
async function assertViewportPrimary(page, label) {
  await focusPrimaryWithKeyboard(page);
  const state = await page.evaluate(async () => {
    const visible = [...document.querySelectorAll('[data-workflow-primary="true"]')].filter((element) => Boolean(element.offsetWidth || element.offsetHeight));
    window.scrollTo(0, 0);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const element = visible[0];
    const rect = element?.getBoundingClientRect();
    const style = element ? getComputedStyle(element) : null;
    return {
      count: visible.length,
      text: String(element?.textContent || "").trim(),
      focused: document.activeElement === element,
      outlineStyle: style?.outlineStyle || "",
      focusVisible: element?.matches(":focus-visible") || false,
      rect: rect && { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
      withinViewport: Boolean(rect && rect.top >= 0 && rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight)
    };
  });
  assert.strictEqual(state.count, 1, "phase must have exactly one visible primary action");
  assert.match(state.text, new RegExp(label));
  assert.strictEqual(state.withinViewport, true, `${label} must be inside the initial 375x812 viewport: ${JSON.stringify(state)}`);
  assert.strictEqual(state.focused, true, `${label} must retain focus at the top of the page`);
  assert.strictEqual(state.outlineStyle, "solid", `${label} must have a solid focus outline: ${JSON.stringify(state)}`);
}
async function assertNoViewportPrimary(page) {
  const state = await page.evaluate(() => ({
    total: document.querySelectorAll('[data-workflow-primary="true"]').length,
    pauseFocused: document.activeElement === document.querySelector('[data-action="pause"]')
  }));
  assert.deepStrictEqual(state, { total: 0, pauseFocused: false }, "an active run must not promote or automatically focus pause");
}
async function focusPrimaryWithKeyboard(page) {
  const primary = page.locator('[data-workflow-primary="true"]');
  for (let index = 0; index < 32; index += 1) {
    if (await primary.count() === 1 && await primary.evaluate((element) => document.activeElement === element)) return;
    await page.keyboard.press("Tab");
  }
  assert.fail("keyboard navigation must reach the workflow primary action");
}
