"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 768, height: 1024 }, { width: 375, height: 812 }];
const STATES = ["scanning", "paused", "review_required", "interrupted"];

async function main() {
  const options = parse(process.argv.slice(2));
  const { chromium } = require("playwright");
  fs.mkdirSync(options.outputDir, { recursive: true });
  const result = { schemaVersion: 1, label: options.label, targetRevision: revision(options.targetRoot), browser: { engine: "msedge", headless: true }, viewports: VIEWPORTS, states: STATES, pages: [], errors: [] };
  const storage = require(path.join(options.targetRoot, "src", "core", "storage"));
  const { createDashboardServer } = require(path.join(options.targetRoot, "src", "dashboard", "server"));
  const dbPath = path.join(options.outputDir, `.${options.label}.sqlite`);
  let db; let server; let browser;
  try {
    db = storage.openDb(dbPath);
    const runs = seed(storage, db);
    server = createDashboardServer({ db, root: options.targetRoot, dbPath, forceMock: true, logger: logger(), browserReadinessProbe: async () => ({ status: "ready", ready: true, message: "fixture ready", checkedAt: "2099-01-01T00:00:00.000Z" }) });
    await listen(server);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ channel: "msedge", headless: true });
    for (const state of STATES) for (const viewport of VIEWPORTS) result.pages.push(await audit({ browser, baseUrl, state, runId: runs[state], viewport, outputDir: options.outputDir, label: options.label }));
  } catch (error) { result.errors.push(String(error?.stack || error)); throw error; } finally {
    if (browser) await browser.close();
    if (server) await close(server);
    if (db) db.close();
    for (const suffix of ["", "-shm", "-wal"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
    fs.writeFileSync(path.join(options.outputDir, `${options.label}.json`), `${JSON.stringify(result, null, 2)}\n`);
  }
}

function seed(storage, db) {
  const now = new Date().toISOString();
  const profile = { candidate: { name: "Workflow evaluation", city: "上海", targetTitles: ["AI 应用开发工程师"] }, education: [], experiences: [], skills: [{ name: "Python", evidence: ["fixture"] }], projects: [{ name: "RAG fixture", canSay: ["RAG"] }], credentials: [], strengths: [] };
  const saved = storage.saveProfileAnalysis(db, { profile, document: { originalFileName: "workflow-evaluation.txt", format: "text", contentHash: "workflow-evaluation", text: "Python RAG fixture ".repeat(20), diagnostics: {} }, searchPlan: { name: "Workflow evaluation plan", cities: ["上海"], directions: ["AI 应用开发"], keywords: [{ word: "RAG", priority: "A", reason: "fixture" }], experience: ["1-3年"], jobTypes: ["全职"], degrees: [], salary: { minK: 15, maxK: 25 }, bossActiveDays: 3, platform: { site: "boss" } } });
  const batchId = storage.createBatch(db, "boss", "RAG", "workflow evaluation", { profileId: saved.profileId, searchPlanId: saved.planId });
  storage.upsertJob(db, { source: "boss", sourceId: "workflow-evaluation-job", keyword: "RAG", title: "Workflow evaluation role", company: "Fixture Co", salary: "20-25K", experience: "1-3年", url: "https://www.zhipin.com/job_detail/workflow-evaluation.html", description: "Complete Python RAG job description for isolated workflow evaluation. ".repeat(6), qualityTags: [], matches: ["Python", "RAG"], analysis: { recommendation: "primary", semanticStatus: "complete", fitReasons: ["Python RAG"], roleSummary: "RAG 应用开发", roleAlignment: "mostly_aligned", roleResumeEvidence: ["fixture"], selectedTrackLabel: "大模型应用开发", requirementMatches: [{ requirement: "RAG", foundation: true, state: "matched" }] } }, batchId);
  const day = chinaDay();
  const create = (id, localDay) => storage.createWorkflowRun(db, { id, profileId: saved.profileId, planId: saved.planId, localDay, sequence: 1, targetSuccessCount: 35, candidateGap: 35, scanNeeded: true, keywords: [{ word: "RAG", priority: "A" }], budget: { maxDetailTotal: 12, browserPageBudget: 4 }, planner: { browserMode: "edge" }, metrics: {} });
  const scanning = create("workflow-eval-scanning", day);
  const scan = storage.createScanRun(db, { runId: "workflow-eval-scan", planId: saved.planId, batchId });
  storage.transitionWorkflowRun(db, { id: scanning.id, status: "scanning" });
  storage.attachWorkflowScan(db, { id: scanning.id, scanRunId: scan.id, scanBatchId: batchId });
  storage.recordWorkflowScanWait(db, { workflowRunId: scanning.id, runId: scan.id, action: "detail_open", delayMs: 600000, retryAt: new Date(Date.now() + 600000).toISOString(), now });
  const paused = create("workflow-eval-paused", "2099-01-02"); storage.transitionWorkflowRun(db, { id: paused.id, status: "scanning" }); storage.transitionWorkflowRun(db, { id: paused.id, status: "paused", errorCode: "SAFE_PAUSE" });
  const review = create("workflow-eval-review", "2099-01-03"); storage.transitionWorkflowRun(db, { id: review.id, status: "scanning" }); db.prepare("UPDATE workflow_runs SET status = 'review_required' WHERE id = ?").run(review.id);
  const interrupted = create("workflow-eval-interrupted", "2099-01-04"); db.prepare("UPDATE workflow_runs SET status = 'interrupted', error_code = 'SAFE_STOP', error_message = 'Fixture interruption' WHERE id = ?").run(interrupted.id);
  return { scanning: scanning.id, paused: paused.id, review_required: review.id, interrupted: interrupted.id };
}

async function audit({ browser, baseUrl, state, runId, viewport, outputDir, label }) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce" }); const page = await context.newPage();
  const consoleErrors = []; const pageErrors = []; const requestFailures = []; const externalRequests = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); }); page.on("pageerror", (e) => pageErrors.push(e.message)); page.on("requestfailed", (r) => requestFailures.push({ url: r.url(), error: r.failure()?.errorText || "unknown" })); page.on("request", (r) => { if (!r.url().startsWith(baseUrl)) externalRequests.push(r.url()); });
  try {
    await page.goto(`${baseUrl}/workflow?runId=${encodeURIComponent(runId)}`, { waitUntil: "networkidle" });
    const action = page.locator("main a[href], main button:not([disabled])").first(); if (await action.count()) await action.focus();
    let interaction = "none";
    if (state === "scanning") { await page.locator('[data-action="stop-preview"]').first().click(); await page.locator('[data-action="stop-cancel"]').click(); interaction = "stop-preview-cancel"; }
    if (state === "review_required") { const checkbox = page.locator('input[name="jobIds"]').first(); if (await checkbox.count()) { await checkbox.check(); interaction = "review-checkbox"; } }
    if (viewport.width === 1440 && ["scanning", "paused"].includes(state)) await page.waitForTimeout(2600);
    const audit = await page.evaluate(() => { const visible = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden"; }; const describe = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { text: String(e.textContent || e.value || "").replace(/\s+/g, " ").trim(), disabled: Boolean(e.disabled), fullyWithinViewport: r.top >= 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }; }; const primary = [...document.querySelectorAll("main a[href], main button, main input[type=submit]")].filter(visible).find((e) => !e.disabled) || null; const active = document.activeElement; const style = getComputedStyle(primary || document.body); return { viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, horizontalOverflow: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth, primary: describe(primary), focus: { matchesPrimary: active === primary, outlineStyle: getComputedStyle(active).outlineStyle }, reducedMotion: { matches: matchMedia("(prefers-reduced-motion: reduce)").matches, transitionDuration: style.transitionDuration, animationDuration: style.animationDuration }, scanWaitVisible: Boolean(document.querySelector("[data-scan-wait]") && !document.querySelector("[data-scan-wait]").hidden), details: { read: document.querySelector("[data-detail-read]")?.textContent || "", pending: document.querySelector("[data-detail-pending]")?.textContent || "", required: document.querySelector("[data-analysis-detail-required]")?.textContent || "" }, pollingKind: document.querySelector("[data-workflow-page]")?.dataset.pollingKind || "none" }; });
    const screenshot = `${label}-${state}-${viewport.width}x${viewport.height}.png`; await page.screenshot({ path: path.join(outputDir, screenshot), fullPage: false });
    return { state, path: `/workflow?runId=${runId}`, screenshot, audit, interaction, consoleErrors, pageErrors, requestFailures, externalRequests };
  } finally { await context.close(); }
}

function parse(args) { const values = new Map(); for (let i = 0; i < args.length; i += 2) values.set(args[i], args[i + 1]); const targetRoot = path.resolve(values.get("--target-root") || process.cwd()); const outputDir = path.resolve(values.get("--output-dir") || path.join(process.cwd(), ".runtime", "workflow-dashboard-evidence")); const label = values.get("--label") || "current"; if (!["--target-root", "--output-dir", "--label"].every((key) => !values.has(key) || values.get(key))) throw new Error("Missing evaluation option value"); return { targetRoot, outputDir, label }; }
function revision(root) { return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); }
function logger() { return { info() {}, warn() {}, error() {}, requestId() { return "workflow-dashboard-evaluation"; }, listRecent() { return []; } }; }
function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); }
function close(server) { return new Promise((resolve) => server.close(resolve)); }
function chinaDay() { const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()); const value = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value])); return `${value.year}-${value.month}-${value.day}`; }
if (require.main === module) main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
