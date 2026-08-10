"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const VIEWPORTS = Object.freeze([
  { width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 768, height: 1024 }, { width: 375, height: 812 }
]);
const RELEVANT_CONTROL_SELECTOR = "main form button, main form input:not([type=hidden]):not([type=checkbox]):not([type=radio]), main form select, main form textarea";

const PAGE_SPECS = Object.freeze([
  { id: "today-ready", family: "today", state: "ready", primaryPolicy: "required", primarySelector: "[data-today-primary]", interaction: "none", interactionPolicy: "read-only-none", path: ({ planId }) => `/plan?planId=${planId}` },
  { id: "workflow-scanning", family: "workflow", state: "scanning", primaryPolicy: "required", primarySelector: '[data-workflow-primary="true"]', interaction: "stop-preview-cancel", interactionPolicy: "exercised", path: ({ workflowId }) => `/workflow?runId=${encodeURIComponent(workflowId)}` },
  { id: "queue-primary", family: "queue", state: "primary", primaryPolicy: "none-expected", primaryRationale: "Queue presents several safe local status actions, not one page-level primary.", interaction: "details-toggle", interactionPolicy: "exercised", path: ({ planId }) => `/queue?planId=${planId}&pool=primary` },
  { id: "jobs-latest", family: "jobs", state: "latest-batch", primaryPolicy: "none-expected", primaryRationale: "Jobs filters and local record actions intentionally have no page-level primary.", interaction: "details-toggle", interactionPolicy: "exercised", path: ({ planId }) => `/jobs?planId=${planId}&batch=latest` },
  { id: "communication-review", family: "communication", state: "confirmed-offline", primaryPolicy: "required", primarySelector: "[data-page-primary]", interaction: "none", interactionPolicy: "safety-not-executed", path: ({ communicationBatchId }) => `/communication?batchId=${communicationBatchId}` },
  { id: "settings", family: "settings", state: "default", primaryPolicy: "none-expected", primaryRationale: "Saving settings can test a model connection and is deliberately not promoted or executed by acceptance.", interaction: "none", interactionPolicy: "safety-not-executed", path: () => "/settings" },
  { id: "onboarding-existing", family: "onboarding", state: "existing-profile", primaryPolicy: "required", primarySelector: "[data-page-primary]", interaction: "none", interactionPolicy: "safety-not-executed", path: () => "/onboarding" },
  { id: "diagnostics", family: "diagnostics", state: "empty-log", primaryPolicy: "none-expected", primaryRationale: "Diagnostics is a read-only log surface with no page-level primary.", interaction: "none", interactionPolicy: "read-only-none", path: () => "/diagnostics" }
]);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return process.stdout.write(usage());
  if (process.env.ROLEFLOW_REQUIRE_PLAYWRIGHT !== "1") throw new Error("ROLEFLOW_REQUIRE_PLAYWRIGHT=1 is required for strict dashboard acceptance.");
  let chromium;
  try { ({ chromium } = require("playwright")); } catch { throw new Error("Playwright is unavailable. Set NODE_PATH to the existing Codex runtime node_modules directory; do not install dependencies."); }
  validateOptions(options);
  const targetCleanAtStart = gitStatus(options.targetRoot) === "";
  if (!targetCleanAtStart) throw new Error("Strict dashboard acceptance requires a clean target revision before evidence generation.");
  clearLabelArtifacts(options.outputDir, options.label);
  const result = {
    schemaVersion: 2, generatedAt: new Date().toISOString(), label: options.label, strict: true,
    targetRevision: gitRevision(options.targetRoot), targetCleanAtStart,
    browser: { engine: "chromium", channel: options.browserChannel, headless: true, reducedMotion: "reduce" },
    fixture: { id: "dashboard-wave2-offline-v1", storage: "temporary SQLite", browserReadiness: "mock-ready", realBoss: false, realModel: false, communicationExecution: false },
    viewports: VIEWPORTS, pageSpecs: PAGE_SPECS.map(({ id, family, state, primaryPolicy, primaryRationale, interaction, interactionPolicy }) => ({ id, family, state, primaryPolicy, primaryRationale: primaryRationale || null, interaction, interactionPolicy })), pages: [], errors: []
  };
  const storage = require(path.join(options.targetRoot, "src", "core", "storage"));
  const { matchingCardFromProfile } = require(path.join(options.targetRoot, "src", "core", "matching_card"));
  const { createCommunicationBatch } = require(path.join(options.targetRoot, "src", "core", "communication_batches"));
  const { createDashboardServer } = require(path.join(options.targetRoot, "src", "dashboard", "server"));
  const dbPath = path.join(options.outputDir, `.${options.label}.sqlite`);
  let db; let server; let browser;
  try {
    db = storage.openDb(dbPath);
    const fixture = seedFixture({ storage, matchingCardFromProfile, createCommunicationBatch, db });
    server = createDashboardServer({ db, root: options.targetRoot, dbPath, forceMock: true, logger: quietLogger(), browserReadinessProbe: async () => ({ status: "ready", ready: true, message: "offline fixture ready", checkedAt: "2099-01-01T00:00:00.000Z" }) });
    await listen(server);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ channel: options.browserChannel, headless: true });
    for (const spec of PAGE_SPECS) for (const viewport of VIEWPORTS) {
      const page = await auditPage({ browser, baseUrl, spec, fixture, viewport, outputDir: options.outputDir, label: options.label, revision: result.targetRevision });
      result.pages.push(page);
      assertStrictPage(page);
    }
  } catch (error) {
    result.errors.push(String(error?.stack || error));
    throw error;
  } finally {
    if (browser) await browser.close();
    if (server) await close(server);
    if (db) db.close();
    for (const suffix of ["", "-shm", "-wal"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
    fs.writeFileSync(path.join(options.outputDir, `${options.label}.json`), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  assertCanonicalArtifacts(options.outputDir, options.label, result.pages.length);
}

function seedFixture({ storage, matchingCardFromProfile, createCommunicationBatch, db }) {
  const profile = { candidate: { name: "Dashboard acceptance fixture", city: "Shanghai", targetTitles: ["AI application engineer"], expectedSalary: "15-25K" }, education: [], experiences: [], skills: [{ name: "Python", evidence: ["offline fixture"] }], projects: [{ name: "RAG fixture", canSay: ["RAG"] }], credentials: [], strengths: [] };
  const saved = storage.saveProfileAnalysis(db, { profile, document: { originalFileName: "dashboard-wave2-fixture.txt", format: "text", contentHash: "dashboard-wave2-offline-v1", text: "Python RAG offline dashboard acceptance fixture. ".repeat(16), diagnostics: {} }, searchPlan: { name: "Dashboard acceptance plan", cities: ["Shanghai"], directions: ["AI application"], keywords: [{ word: "RAG", priority: "A", reason: "fixture" }], experience: ["1-3 years"], jobTypes: ["full time"], degrees: [], salary: { minK: 15, maxK: 25 }, bossActiveDays: 3, platform: { site: "boss" } } });
  const card = storage.createMatchingCardDraft(db, { profileId: saved.profileId, profileVersionId: saved.profileVersionId, resumeDocumentId: saved.resumeDocumentId, resumeContentHash: "dashboard-wave2-offline-v1", card: matchingCardFromProfile(profile), source: "migration" });
  storage.confirmMatchingCard(db, { profileId: saved.profileId, cardId: card.id });
  const batchId = storage.createBatch(db, "boss", "dashboard-wave2", "offline dashboard acceptance", { profileId: saved.profileId, searchPlanId: saved.planId });
  const jobId = storage.upsertJob(db, { source: "boss", sourceId: "dashboard-wave2-primary", keyword: "RAG", title: "Offline dashboard role", company: "Fixture Co", location: "Shanghai", salary: "20-25K", experience: "1-3 years", education: "Bachelor", bossActiveText: "Active today", bossActiveDays: 0, url: "https://www.zhipin.com/job_detail/dashboard-wave2-primary.html", tags: ["Python", "RAG"], description: "Complete Python RAG job description used only by the local dashboard acceptance fixture. ".repeat(6), score: 20, level: "priority", matches: ["Python", "RAG"], risks: [], qualityTags: [], analysis: { semanticStatus: "complete", recommendation: "primary", recommendationSchemaVersion: 2, fitLevel: "fit", confidence: 0.9, fitReasons: ["Python and RAG fixture evidence"], evidence: { jd: ["Python RAG"], resume: ["Python RAG"] } } }, batchId);
  const workflow = storage.createWorkflowRun(db, { id: "dashboard-wave2-scanning", profileId: saved.profileId, planId: saved.planId, localDay: chinaDay(), sequence: 1, targetSuccessCount: 35, candidateGap: 35, scanNeeded: true, keywords: [{ word: "RAG", priority: "A" }], budget: { maxDetailTotal: 12, browserPageBudget: 4 }, planner: { browserMode: "edge" }, metrics: {} });
  const scan = storage.createScanRun(db, { runId: "dashboard-wave2-scan", planId: saved.planId, batchId });
  storage.transitionWorkflowRun(db, { id: workflow.id, status: "scanning" });
  storage.attachWorkflowScan(db, { id: workflow.id, scanRunId: scan.id, scanBatchId: batchId });
  storage.recordWorkflowScanWait(db, { workflowRunId: workflow.id, runId: scan.id, action: "detail_open", delayMs: 600000, retryAt: "2099-01-01T00:10:00.000Z", now: "2099-01-01T00:00:00.000Z" });
  const communication = createCommunicationBatch(db, { planId: saved.planId, jobIds: [jobId], browserMode: "edge", now: "2099-01-01T00:00:00.000Z" });
  return { planId: saved.planId, workflowId: workflow.id, communicationBatchId: communication.id };
}

async function auditPage({ browser, baseUrl, spec, fixture, viewport, outputDir, label, revision }) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors = { console: [], page: [], request: [], external: [] };
  page.on("console", (message) => { if (message.type() === "error") errors.console.push(normalizeText(message.text(), baseUrl)); });
  page.on("pageerror", (error) => errors.page.push(normalizeText(error.message, baseUrl)));
  page.on("requestfailed", (request) => errors.request.push({ url: normalizeUrl(request.url(), baseUrl), error: request.failure()?.errorText || "unknown" }));
  page.on("request", (request) => { if (!request.url().startsWith(baseUrl)) errors.external.push(request.url()); });
  try {
    const route = spec.path(fixture);
    await page.goto(`${baseUrl}${route}`, { waitUntil: "networkidle" });
    if (spec.id === "today-ready") await page.waitForFunction(() => !document.querySelector("[data-browser-readiness-button]") || document.querySelector("[data-browser-readiness-button]").disabled === false);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    const audit = await page.evaluate(pageAudit, auditInput(spec));
    const screenshot = `${label}-${spec.id}-${viewport.width}x${viewport.height}.png`;
    await page.screenshot({ path: path.join(outputDir, screenshot), fullPage: false });
    let target = spec.primarySelector ? page.locator(`${spec.primarySelector}:not([disabled])`).first() : page.locator("main a[href], main button:not([disabled]), main input:not([type=hidden]):not([disabled]), main select:not([disabled]), main summary").first();
    if (!await target.count()) target = page.locator(".primary-nav a").first();
    await focusWithKeyboard(page, target);
    const focusAudit = await page.evaluate(pageAudit, auditInput(spec));
    const interaction = await runClientOnlyInteraction(page, spec.interaction, spec.interactionPolicy);
    return { id: spec.id, family: spec.family, state: spec.state, primaryPolicy: spec.primaryPolicy, primaryRationale: spec.primaryRationale || null, interactionPolicy: spec.interactionPolicy, revision, route, viewport, screenshot, auditOrder: ["scrollTop=0", "screenshot", "keyboard-focus", "client-only-interaction"], audit, focusAudit, interaction, errors };
  } finally { await context.close(); }
}

function auditInput(spec) { return { pageId: spec.id, primarySelector: spec.primarySelector || "", primaryPolicy: spec.primaryPolicy, relevantControlSelector: RELEVANT_CONTROL_SELECTOR }; }

async function focusWithKeyboard(page, target) {
  if (!await target.count()) return false;
  for (let index = 0; index < 80; index += 1) {
    if (await target.evaluate((element) => document.activeElement === element)) return true;
    await page.keyboard.press("Tab");
  }
  return false;
}

async function runClientOnlyInteraction(page, kind, policy) {
  if (policy !== "exercised") return { kind: "none", policy, attempted: false, passed: true, result: { reason: policy } };
  if (kind === "stop-preview-cancel") {
    const preview = page.locator('[data-action="stop-preview"]').first(); const cancel = page.locator('[data-action="stop-cancel"]').first();
    if (!await preview.count() || !await cancel.count()) return { kind, policy, attempted: false, passed: false, result: { reason: "control missing" } };
    await preview.click(); const visible = await page.locator("[data-stop-confirmation]").isVisible(); await cancel.click(); const hidden = await page.locator("[data-stop-confirmation]").isHidden();
    return { kind, policy, attempted: true, passed: visible && hidden, result: { visible, hidden } };
  }
  if (kind === "details-toggle") {
    const details = page.locator("main details").first();
    if (!await details.count()) return { kind, policy, attempted: false, passed: false, result: { reason: "details missing" } };
    const before = await details.evaluate((element) => element.open); await details.locator("summary").click(); const after = await details.evaluate((element) => element.open);
    return { kind, policy, attempted: true, passed: before !== after, result: { before, after } };
  }
  return { kind, policy, attempted: false, passed: false, result: { reason: "missing exercised interaction" } };
}

function pageAudit({ pageId = "", primarySelector = "", primaryPolicy = "", relevantControlSelector = "" } = {}) {
  const round = (value) => Math.round(value * 100) / 100;
  const visible = (element) => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none"; };
  const text = (element) => String(element?.textContent || element?.value || "").replace(/\s+/g, " ").trim().slice(0, 180);
  const describe = (element) => { if (!element) return null; const rect = element.getBoundingClientRect(); return { tag: element.tagName.toLowerCase(), text: text(element), disabled: Boolean(element.disabled), width: round(rect.width), height: round(rect.height), top: round(rect.top), bottom: round(rect.bottom), left: round(rect.left), right: round(rect.right), fullyWithinViewport: rect.top >= 0 && rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight }; };
  const actions = [...document.querySelectorAll("main a[href], main button, main input:not([type=hidden]), main select, main summary")].filter(visible);
  const primaryAll = primarySelector ? [...document.querySelectorAll(primarySelector)] : [];
  const primaryVisible = primaryAll.filter(visible);
  const primaryMarkerCount = primaryPolicy === "required" ? primaryAll.length : document.querySelectorAll("[data-page-primary]").length;
  const communicationPrimary = pageId === "communication-review" ? primaryVisible[0] : null;
  const destructive = pageId === "communication-review" ? document.querySelector('button[name="action"][value="discard"]') : null;
  const primaryStyle = communicationPrimary ? getComputedStyle(communicationPrimary) : null;
  const destructiveStyle = destructive ? getComputedStyle(destructive) : null;
  const navigationTargets = [...document.querySelectorAll(".primary-nav a")].filter(visible);
  const focused = document.activeElement; const focusStyle = focused ? getComputedStyle(focused) : null;
  const motionTarget = primaryVisible[0] || actions[0] || document.body;
  const headings = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter(visible).map((heading) => ({ level: Number(heading.tagName.slice(1)), text: text(heading) }));
  const headingOrderValid = headings.every((heading, index) => index === 0 || heading.level <= headings[index - 1].level + 1);
  const labelledInputs = [...document.querySelectorAll("input:not([type=hidden]), select, textarea")].filter(visible).map((element) => ({ tag: element.tagName.toLowerCase(), name: element.getAttribute("name") || "", labelled: Boolean(element.labels?.length || element.getAttribute("aria-label") || element.getAttribute("aria-labelledby")) }));
  const overflowElements = [...document.body.querySelectorAll("*")].filter(visible).filter((element) => { const rect = element.getBoundingClientRect(); return rect.left < -0.5 || rect.right > innerWidth + 0.5; }).slice(0, 20).map((element) => ({ tag: element.tagName.toLowerCase(), id: element.id || "", classes: typeof element.className === "string" ? element.className : "" }));
  const relevantControls = relevantControlSelector ? [...document.querySelectorAll(relevantControlSelector)].filter(visible).map(describe) : [];
  const undersizedInlineLinks = [...document.querySelectorAll("main a[href]")].filter(visible).map(describe).filter((link) => link.height < 44 || link.width < 44);
  return {
    scrollTop: scrollY, viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, horizontalOverflow: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth, overflowElements,
    shell: { roleflowStylesheet: Boolean(document.querySelector('link[href="/assets/roleflow.css"]')), framePresent: Boolean(document.querySelector(".app-shell")), frameCount: document.querySelectorAll(".app-shell").length, present: Boolean(document.querySelector('link[href="/assets/roleflow.css"]')), navigationPresent: Boolean(document.querySelector(".primary-nav")), primaryNavigationCount: document.querySelectorAll(".primary-nav").length, mainPresent: Boolean(document.querySelector("main")), navigationMinTarget: navigationTargets.length ? Math.min(...navigationTargets.map((element) => element.getBoundingClientRect().height)) : 0, activeNavigation: [...document.querySelectorAll('.primary-nav a[aria-current="page"]')].map((element) => ({ text: text(element), href: element.getAttribute("href") })), activeNavigationCount: document.querySelectorAll('.primary-nav a[aria-current="page"]').length },
    touch: { relevantControlCount: relevantControls.length, relevantControlMinTarget: relevantControls.length ? Math.min(...relevantControls.map((control) => control.height)) : 44, relevantControls, undersizedInlineLinks },
    actions: actions.slice(0, 40).map(describe), primary: { policy: primaryPolicy, defined: Boolean(primarySelector), selector: primarySelector || null, markerCount: primaryMarkerCount, count: primaryAll.length, visibleCount: primaryVisible.length, control: describe(primaryVisible[0] || null), fullyWithinViewport: primaryVisible.length === 1 && Boolean(describe(primaryVisible[0])?.fullyWithinViewport) },
    communicationHierarchy: pageId === "communication-review" ? { primarySolid: primaryStyle?.backgroundColor === "rgb(0, 107, 91)" && primaryStyle?.color === "rgb(255, 255, 255)", destructiveOutline: destructiveStyle?.backgroundColor === "rgb(255, 255, 255)" && destructiveStyle?.color === "rgb(178, 58, 50)" && destructiveStyle?.borderColor === "rgb(178, 58, 50)" } : null,
    focus: { focused: Boolean(focused && (actions.includes(focused) || primaryVisible.includes(focused) || navigationTargets.includes(focused))), activeTag: focused?.tagName?.toLowerCase() || null, activeText: text(focused), outlineStyle: focusStyle?.outlineStyle || null, outlineWidth: Number.parseFloat(focusStyle?.outlineWidth || "0"), outlineOffset: focusStyle?.outlineOffset || null },
    reducedMotion: { mediaMatches: matchMedia("(prefers-reduced-motion: reduce)").matches, transitionDuration: getComputedStyle(motionTarget).transitionDuration, animationDuration: getComputedStyle(motionTarget).animationDuration, runningAnimations: document.getAnimations().filter((animation) => animation.playState === "running").length, longRunningAnimations: document.getAnimations().filter((animation) => animation.playState === "running" && Number(animation.effect?.getComputedTiming().duration || 0) > 50).length },
    accessibility: { viewportMeta: document.querySelector('meta[name="viewport"]')?.getAttribute("content") || "", bodyFontSize: Number.parseFloat(getComputedStyle(document.body).fontSize || "0"), headings, headingOrderValid, labelledInputs, alerts: document.querySelectorAll('[role="alert"], [role="status"]').length, structuralEmoji: [...document.querySelectorAll("nav a, button")].filter((element) => /[\u{1F300}-\u{1FAFF}]/u.test(text(element))).map((element) => text(element)) }
  };
}

function assertStrictPage(page) {
  const failures = []; const audit = page.audit || {}; const shell = audit.shell || {}; const primary = audit.primary || {}; const focus = page.focusAudit?.focus || {}; const interaction = page.interaction || {};
  if (!PAGE_SPECS.some((spec) => spec.id === page.id)) failures.push("undeclared page spec");
  if (!["required", "none-expected"].includes(page.primaryPolicy || primary.policy)) failures.push("primary policy");
  if ((page.primaryPolicy || primary.policy) !== primary.policy) failures.push("primary policy mismatch");
  if (!["exercised", "read-only-none", "safety-not-executed"].includes(page.interactionPolicy || interaction.policy)) failures.push("interaction policy");
  if ((page.interactionPolicy || interaction.policy) !== interaction.policy) failures.push("interaction policy mismatch");
  if (audit.scrollTop !== 0) failures.push("scrollTop");
  if (audit.horizontalOverflow) failures.push("horizontal overflow");
  if (audit.documentWidth !== audit.viewport?.width || audit.bodyWidth !== audit.viewport?.width) failures.push("viewport width mismatch");
  if (!shell.present || !shell.framePresent || shell.frameCount !== 1) failures.push("missing shared frame");
  if (!shell.navigationPresent || shell.primaryNavigationCount !== 1) failures.push("duplicate primary navigation");
  if (!shell.mainPresent) failures.push("missing main");
  if (shell.activeNavigationCount !== 1) failures.push("missing active navigation");
  if (shell.navigationMinTarget < 44) failures.push("navigation touch target");
  if (audit.touch?.relevantControlMinTarget < 44) failures.push("undersized relevant form control");
  if (primary.policy === "required" && (primary.markerCount !== 1 || primary.count !== 1 || primary.visibleCount !== 1 || !primary.fullyWithinViewport)) failures.push("primary below the fold");
  if (primary.policy === "required" && primary.control?.height < 44) failures.push("undersized primary");
  if (primary.policy === "none-expected" && primary.markerCount !== 0) failures.push("unexpected page-level primary marker");
  if (page.id === "communication-review" && (!audit.communicationHierarchy?.primarySolid || !audit.communicationHierarchy?.destructiveOutline)) failures.push("communication visual hierarchy");
  if (!focus.focused || focus.outlineStyle !== "solid" || focus.outlineWidth < 2) failures.push("weak keyboard focus");
  if (!audit.reducedMotion?.mediaMatches || audit.reducedMotion?.longRunningAnimations) failures.push("ignored reduced motion");
  if (!audit.accessibility?.viewportMeta.includes("width=device-width") || !audit.accessibility?.headingOrderValid) failures.push("accessibility structure");
  if (page.viewport?.width <= 768 && audit.accessibility?.bodyFontSize < 16) failures.push("mobile body text");
  if (audit.accessibility?.structuralEmoji?.length) failures.push("structural emoji");
  for (const [kind, entries] of Object.entries(page.errors || {})) if (entries.length) failures.push(`${kind} request`);
  if (interaction.policy === "exercised" && (!interaction.attempted || !interaction.passed)) failures.push("failed interaction");
  if (interaction.policy !== "exercised" && interaction.attempted) failures.push("unexpected interaction");
  if (failures.length) throw new Error(`Strict dashboard gate failed for ${page.id} ${page.viewport?.width}x${page.viewport?.height}: ${failures.join(", ")}`);
}

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--help" || key === "-h") return { help: true };
    if (!["--target-root", "--label", "--output-dir", "--browser-channel"].includes(key)) throw new Error(`Unknown argument: ${key}`);
    const value = args[index + 1]; if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    values.set(key, value); index += 1;
  }
  return { help: false, strict: true, targetRoot: path.resolve(values.get("--target-root") || process.cwd()), label: values.get("--label") || "current", outputDir: path.resolve(values.get("--output-dir") || path.join(process.cwd(), ".runtime", "dashboard-wave2-evidence")), browserChannel: values.get("--browser-channel") || "msedge" };
}

function validateOptions(options) {
  if (!/^[a-zA-Z0-9._-]+$/.test(options.label)) throw new Error("Label may contain only letters, numbers, dot, underscore, and hyphen.");
  if (!fs.existsSync(path.join(options.targetRoot, "src", "dashboard", "server.js"))) throw new Error(`Target root does not contain src/dashboard/server.js: ${options.targetRoot}`);
}
function clearLabelArtifacts(outputDir, label) { fs.mkdirSync(outputDir, { recursive: true }); for (const name of fs.readdirSync(outputDir)) if (name === `${label}.json` || name === `.${label}.sqlite` || name.startsWith(`.${label}.sqlite-`) || (name.startsWith(`${label}-`) && name.endsWith(".png"))) fs.rmSync(path.join(outputDir, name), { force: true }); }
function assertCanonicalArtifacts(outputDir, label, pageCount) { const names = fs.readdirSync(outputDir).sort(); const expected = new Set([`${label}.json`, ...PAGE_SPECS.flatMap((spec) => VIEWPORTS.map((viewport) => `${label}-${spec.id}-${viewport.width}x${viewport.height}.png`))]); if (pageCount !== 32 || names.length !== expected.size || names.some((name) => !expected.has(name))) throw new Error(`Canonical evidence must contain exactly ${expected.size - 1} PNGs and one UTF-8 JSON manifest; found: ${names.join(", ")}`); JSON.parse(fs.readFileSync(path.join(outputDir, `${label}.json`), "utf8")); }
function gitRevision(targetRoot) { return execFileSync("git", ["-C", targetRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); }
function gitStatus(targetRoot) { return execFileSync("git", ["-C", targetRoot, "status", "--porcelain"], { encoding: "utf8" }).trim(); }
function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); }
function close(server) { return new Promise((resolve) => server.close(resolve)); }
function chinaDay() { const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()); const fields = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value])); return `${fields.year}-${fields.month}-${fields.day}`; }
function normalizeUrl(url, baseUrl) { if (!url.startsWith(baseUrl)) return url; const parsed = new URL(url); return `${parsed.pathname}${parsed.search}`; }
function normalizeText(value, baseUrl) { return String(value || "").split(baseUrl).join("<local-dashboard>"); }
function quietLogger() { return { info() {}, warn() {}, error() {}, requestId() { return "dashboard-wave2-evaluation"; }, listRecent() { return []; } }; }
function usage() { return ["Usage: node scripts/evaluate-dashboard-wave2.js [options]", "", "Strict prerequisites: ROLEFLOW_REQUIRE_PLAYWRIGHT=1 and NODE_PATH containing Playwright.", "", "Options:", "  --target-root <path>       RoleFlow checkout to evaluate", "  --label <name>             Artifact prefix and JSON filename", "  --output-dir <path>        Directory for JSON and viewport PNGs", "  --browser-channel <name>   Playwright Chromium channel (default: msedge)", "  -h, --help                 Show this help", ""].join("\n"); }

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
module.exports = { PAGE_SPECS, RELEVANT_CONTROL_SELECTOR, VIEWPORTS, assertStrictPage, parseArgs };
