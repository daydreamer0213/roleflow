"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 768, height: 1024 }, { width: 375, height: 812 }];
const STATES = ["scanning", "analyzing", "paused", "review_required", "interrupted"];

async function main() {
  const options = parse(process.argv.slice(2));
  if (options.help) return process.stdout.write(usage());
  const { chromium } = require("playwright");
  fs.mkdirSync(options.outputDir, { recursive: true });
  const result = { schemaVersion: 2, label: options.label, expectPrimary: options.expectPrimary, targetRevision: revision(options.targetRoot), browser: { engine: options.browserChannel, headless: true }, viewports: VIEWPORTS, states: STATES, pages: [], errors: [] };
  const storage = require(path.join(options.targetRoot, "src", "core", "storage"));
  const { initializeWorkflowJobTasks } = require(path.join(options.targetRoot, "src", "core", "workflow_analysis_tasks"));
  const { createDashboardServer } = require(path.join(options.targetRoot, "src", "dashboard", "server"));
  const dbPath = path.join(options.outputDir, `.${options.label}.sqlite`);
  let db; let server; let browser;
  try {
    db = storage.openDb(dbPath);
    const runs = seed(storage, initializeWorkflowJobTasks, db);
    server = createDashboardServer({ db, root: options.targetRoot, dbPath, forceMock: true, logger: logger(), browserReadinessProbe: async () => ({ status: "ready", ready: true, message: "fixture ready", checkedAt: "2099-01-01T00:00:00.000Z" }) });
    await listen(server);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ channel: options.browserChannel, headless: true });
    for (const state of STATES) for (const viewport of VIEWPORTS) result.pages.push(await audit({ browser, baseUrl, state, runId: runs[state], viewport, outputDir: options.outputDir, label: options.label, expectPrimary: options.expectPrimary }));
  } catch (error) { result.errors.push(String(error?.stack || error)); throw error; } finally {
    if (browser) await browser.close();
    if (server) await close(server);
    if (db) db.close();
    for (const suffix of ["", "-shm", "-wal"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
    fs.writeFileSync(path.join(options.outputDir, `${options.label}.json`), `${JSON.stringify(result, null, 2)}\n`);
  }
}

function seed(storage, initializeWorkflowJobTasks, db) {
  const now = new Date().toISOString();
  const profile = { candidate: { name: "Workflow evaluation", city: "上海", targetTitles: ["AI 应用开发工程师"] }, education: [], experiences: [], skills: [{ name: "Python", evidence: ["fixture"] }], projects: [{ name: "RAG fixture", canSay: ["RAG"] }], credentials: [], strengths: [] };
  const saved = storage.saveProfileAnalysis(db, { profile, document: { originalFileName: "workflow-evaluation.txt", format: "text", contentHash: "workflow-evaluation", text: "Python RAG fixture ".repeat(20), diagnostics: {} }, searchPlan: { name: "Workflow evaluation plan", cities: ["上海"], directions: ["AI 应用开发"], keywords: [{ word: "RAG", priority: "A", reason: "fixture" }], experience: ["1-3年"], jobTypes: ["全职"], degrees: [], salary: { minK: 15, maxK: 25 }, bossActiveDays: 3, platform: { site: "boss" } } });
  const batchId = storage.createBatch(db, "boss", "RAG", "workflow evaluation", { profileId: saved.profileId, searchPlanId: saved.planId });
  storage.upsertJob(db, { source: "boss", sourceId: "workflow-evaluation-job", keyword: "RAG", title: "Workflow evaluation role", company: "Fixture Co", salary: "20-25K", experience: "1-3年", url: "https://www.zhipin.com/job_detail/workflow-evaluation.html", description: "Complete Python RAG job description for isolated workflow evaluation. ".repeat(6), qualityTags: [], matches: ["Python", "RAG"], analysis: { recommendation: "primary", semanticStatus: "complete", fitReasons: ["Python RAG"], roleSummary: "RAG 应用开发", roleAlignment: "mostly_aligned", roleResumeEvidence: ["fixture"], selectedTrackLabel: "大模型应用开发", requirementMatches: [{ requirement: "RAG", foundation: true, state: "matched" }] } }, batchId);
  const progressJobs = Array.from({ length: 6 }, (_, index) => {
    const jobId = storage.upsertJob(db, {
      source: "boss",
      sourceId: `workflow-progress-${index + 1}`,
      keyword: "RAG",
      title: `Workflow progress role ${index + 1}`,
      company: `Fixture Company ${index + 1}`,
      url: `https://www.zhipin.com/job_detail/workflow-progress-${index + 1}.html`,
      description: "Complete local-only RAG job description. ".repeat(8),
      qualityTags: [],
      analysis: { semanticStatus: "pending", decisionSource: "analysis_pending" }
    }, batchId);
    const observationId = Number(db.prepare(`
      SELECT id FROM job_observations WHERE batch_id = ? AND job_id = ?
    `).get(batchId, jobId).id);
    return { jobId, observationId, position: index + 1 };
  });
  const day = chinaDay();
  const create = (id, localDay) => storage.createWorkflowRun(db, { id, profileId: saved.profileId, planId: saved.planId, localDay, sequence: 1, targetSuccessCount: 35, candidateGap: 35, scanNeeded: true, keywords: [{ word: "RAG", priority: "A" }], budget: { maxDetailTotal: 12, browserPageBudget: 4 }, planner: { browserMode: "edge" }, metrics: {} });
  const scanning = create("workflow-eval-scanning", day);
  const scan = storage.createScanRun(db, { runId: "workflow-eval-scan", planId: saved.planId, batchId });
  storage.transitionWorkflowRun(db, { id: scanning.id, status: "scanning" });
  storage.attachWorkflowScan(db, { id: scanning.id, scanRunId: scan.id, scanBatchId: batchId });
  storage.recordWorkflowScanWait(db, { workflowRunId: scanning.id, runId: scan.id, action: "detail_open", delayMs: 600000, retryAt: new Date(Date.now() + 600000).toISOString(), now });
  const analyzing = create("workflow-eval-analyzing", "2099-01-05");
  storage.transitionWorkflowRun(db, { id: analyzing.id, status: "scanning" });
  db.prepare("UPDATE workflow_runs SET scan_batch_id = ?, status = 'analyzing' WHERE id = ?").run(batchId, analyzing.id);
  initializeWorkflowJobTasks(db, { workflowRunId: analyzing.id, batchId, jobs: progressJobs, modelConfigRevision: "workflow-progress-eval", now });
  const statuses = ["pending", "running", "retry_pending", "succeeded", "skipped", "failed"];
  const tasks = db.prepare("SELECT id FROM workflow_job_tasks WHERE workflow_run_id = ? ORDER BY position").all(analyzing.id);
  tasks.forEach((task, index) => db.prepare(`
    UPDATE workflow_job_tasks
    SET status = ?, last_error_code = ?, finished_at = ?
    WHERE id = ?
  `).run(
    statuses[index],
    index === 4 ? "DETAIL_REQUIRED" : null,
    ["succeeded", "skipped", "failed"].includes(statuses[index]) ? now : null,
    task.id
  ));
  const paused = create("workflow-eval-paused", "2099-01-02"); storage.transitionWorkflowRun(db, { id: paused.id, status: "scanning" }); storage.transitionWorkflowRun(db, { id: paused.id, status: "paused", errorCode: "SAFE_PAUSE" });
  const review = create("workflow-eval-review", "2099-01-03"); storage.transitionWorkflowRun(db, { id: review.id, status: "scanning" }); db.prepare("UPDATE workflow_runs SET status = 'review_required' WHERE id = ?").run(review.id);
  const interrupted = create("workflow-eval-interrupted", "2099-01-04"); db.prepare("UPDATE workflow_runs SET status = 'interrupted', error_code = 'SAFE_STOP', error_message = 'Fixture interruption' WHERE id = ?").run(interrupted.id);
  return { scanning: scanning.id, analyzing: analyzing.id, paused: paused.id, review_required: review.id, interrupted: interrupted.id };
}

async function audit({ browser, baseUrl, state, runId, viewport, outputDir, label, expectPrimary }) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce" }); const page = await context.newPage();
  const consoleErrors = []; const pageErrors = []; const requestFailures = []; const externalRequests = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); }); page.on("pageerror", (e) => pageErrors.push(e.message)); page.on("requestfailed", (r) => requestFailures.push({ url: r.url(), error: r.failure()?.errorText || "unknown" })); page.on("request", (r) => { if (!r.url().startsWith(baseUrl)) externalRequests.push(r.url()); });
  try {
    await page.goto(`${baseUrl}/workflow?runId=${encodeURIComponent(runId)}`, { waitUntil: "load" });
    const action = page.locator('[data-workflow-primary="true"]');
    if (await action.count()) await focusPrimaryWithKeyboard(page, action);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    const audit = await page.evaluate(() => {
      const primary = [...document.querySelectorAll('[data-workflow-primary="true"]')];
      const visible = primary.filter((element) => Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length));
      const e = visible[0];
      const r = e?.getBoundingClientRect();
      const style = e ? getComputedStyle(e) : null;
      const documentElement = document.documentElement;
      const body = document.body;
      return {
        viewport: { width: innerWidth, height: innerHeight },
        document: { width: documentElement.scrollWidth, clientWidth: documentElement.clientWidth },
        body: { width: body?.scrollWidth || 0, clientWidth: body?.clientWidth || 0 },
        primaryCount: primary.length,
        visiblePrimaryCount: visible.length,
        primary: e ? {
          text: String(e.textContent || "").trim(),
          rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height },
          fullyWithinViewport: r.top >= 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
          focused: document.activeElement === e,
          outline: { style: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor, offset: style.outlineOffset }
        } : null,
        motion: { reduced: matchMedia("(prefers-reduced-motion: reduce)").matches, runningAnimations: document.getAnimations().filter((animation) => animation.playState === "running").length },
        horizontalOverflow: documentElement.scrollWidth > innerWidth
      };
    });
    const screenshot = `${label}-${state}-${viewport.width}x${viewport.height}.png`; await page.screenshot({ path: path.join(outputDir, screenshot), fullPage: true });
    let interaction = { kind: "none", attempted: false, passed: true, result: {} };
    if (state === "scanning") {
      await page.locator('[data-action="stop-preview"]').first().click();
      const confirmationVisible = await page.locator('[data-stop-confirmation]').isVisible();
      await page.locator('[data-action="stop-cancel"]').click();
      const confirmationHidden = await page.locator('[data-stop-confirmation]').isHidden();
      interaction = { kind: "stop-preview-cancel", attempted: true, passed: confirmationVisible && confirmationHidden, result: { confirmationVisible, confirmationHidden } };
    }
    if (state === "review_required") {
      const checkbox = page.locator('input[name="jobIds"]').first();
      if (await checkbox.count()) {
        const before = await checkbox.isChecked();
        await checkbox.setChecked(!before);
        const after = await checkbox.isChecked();
        interaction = { kind: "review-checkbox", attempted: true, passed: before !== after, result: { before, after } };
      }
    }
    if (viewport.width === 1440 && ["scanning", "paused"].includes(state)) await page.waitForTimeout(2600);
    const errors = { console: consoleErrors, page: pageErrors, request: requestFailures, external: externalRequests };
    const result = { state, path: `/workflow?runId=${runId}`, viewport, screenshot, audit, interaction, errors };
    if (expectPrimary) assertStrictPrimary(result);
    return result;
  } finally { await context.close(); }
}

async function focusPrimaryWithKeyboard(page, action) {
  for (let index = 0; index < 32; index += 1) {
    if (await action.count() === 1 && await action.evaluate((element) => document.activeElement === element)) return;
    await page.keyboard.press("Tab");
  }
}

function assertStrictPrimary(result) {
  const failures = [];
  const primary = result.audit.primary;
  const expectedPrimaryCount = ["scanning", "analyzing"].includes(result.state) ? 0 : 1;
  if (result.audit.primaryCount !== expectedPrimaryCount) failures.push(`primaryCount=${result.audit.primaryCount}`);
  if (result.audit.visiblePrimaryCount !== expectedPrimaryCount) failures.push(`visiblePrimaryCount=${result.audit.visiblePrimaryCount}`);
  if (expectedPrimaryCount && !primary?.fullyWithinViewport) failures.push("primary outside viewport");
  if (expectedPrimaryCount && !primary?.focused) failures.push("primary not focused");
  if (expectedPrimaryCount && primary?.outline?.style !== "solid") failures.push(`primary outline=${primary?.outline?.style || "none"}`);
  if (result.audit.horizontalOverflow) failures.push("horizontal overflow");
  if (!result.interaction.passed) failures.push(`interaction=${result.interaction.kind}`);
  for (const [kind, entries] of Object.entries(result.errors)) if (entries.length) failures.push(`${kind} errors=${entries.length}`);
  if (failures.length) throw new Error(`Workflow evaluator gate failed for ${result.state} ${result.viewport.width}x${result.viewport.height}: ${failures.join(", ")}`);
}

function parse(args) {
  const values = new Map(); let expectPrimary = false;
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--help" || key === "-h") return { help: true };
    if (key === "--expect-primary") { expectPrimary = true; continue; }
    const value = args[index + 1];
    if (!key.startsWith("--") || value == null || value.startsWith("--")) throw new Error(`Missing evaluation option value for ${key}`);
    values.set(key, value); index += 1;
  }
  const targetRoot = path.resolve(values.get("--target-root") || process.cwd()); const outputDir = path.resolve(values.get("--output-dir") || path.join(process.cwd(), ".runtime", "workflow-dashboard-evidence")); const label = values.get("--label") || "current"; const browserChannel = values.get("--browser-channel") || "msedge";
  return { help: false, targetRoot, outputDir, label, expectPrimary, browserChannel };
}
function usage() { return ["Usage: node scripts/evaluate-workflow-dashboard.js [options]", "", "Strict prerequisites: NODE_PATH containing Playwright.", "", "Options:", "  --target-root <path>       RoleFlow checkout to evaluate", "  --label <name>             Artifact prefix and JSON filename", "  --output-dir <path>        Directory for JSON and viewport PNGs", "  --browser-channel <name>   Playwright browser channel (default: msedge; use chrome on 360-protected hosts)", "  --expect-primary           Fail on primary-action, overflow, interaction, or error gate violations", "  -h, --help                 Show this help", ""].join("\n"); }
function revision(root) { return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); }
function logger() { return { info() {}, warn() {}, error() {}, requestId() { return "workflow-dashboard-evaluation"; }, listRecent() { return []; } }; }
function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); }
function close(server) { return new Promise((resolve) => server.close(resolve)); }
function chinaDay() { const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()); const value = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value])); return `${value.year}-${value.month}-${value.day}`; }
if (require.main === module) main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
module.exports = { assertStrictPrimary };
