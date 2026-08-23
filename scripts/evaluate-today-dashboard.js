"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const VIEWPORTS = Object.freeze([
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 375, height: 812 }
]);

const FIXTURE = Object.freeze({
  id: "today-dashboard-v1",
  candidateCity: "上海",
  targetTitle: "AI 应用开发工程师",
  keywords: ["RAG", "Python"],
  salary: { minK: 15, maxK: 25 }
});

async function main() {
  const options = parseArgs(process.argv.slice(2), process.env);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch (error) {
    throw new Error(
      "Playwright is unavailable. Set NODE_PATH to an existing workspace Node packages directory that contains playwright; do not install dependencies for this evaluation."
    );
  }

  validateOptions(options);
  fs.mkdirSync(options.outputDir, { recursive: true });

  const storage = require(path.join(options.targetRoot, "src", "core", "storage"));
  const { matchingCardFromProfile } = require(path.join(options.targetRoot, "src", "core", "matching_card"));
  const { createDashboardServer } = require(path.join(options.targetRoot, "src", "dashboard", "server"));
  const dbPath = path.join(options.outputDir, `.${options.label}-today-dashboard.sqlite`);
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    label: options.label,
    targetRevision: gitRevision(options.targetRoot),
    fixture: FIXTURE,
    browser: { engine: "chromium", channel: options.browserChannel, headless: true },
    viewports: VIEWPORTS,
    pages: [],
    errors: []
  };

  let db;
  let server;
  let browser;
  try {
    db = storage.openDb(dbPath);
    const ready = seed({ storage, matchingCardFromProfile, db, name: "Ready", confirmCard: true });
    const blocked = seed({ storage, matchingCardFromProfile, db, name: "Blocked", confirmCard: false });
    server = createDashboardServer({
      db,
      browserAuthority: { browserMode: "edge", cdpPort: null, profilePath: "" },
      root: options.targetRoot,
      dbPath,
      forceMock: true,
      logger: quietLogger(),
      browserReadinessProbe: async () => ({
        status: "ready",
        ready: true,
        message: "fixture ready",
        checkedAt: "2099-01-01T00:00:00.000Z"
      }),
      inheritedPreviewResolver: async () => ({
        acquisitionMode: "inherited",
        platformPolicy: {
          filterSummary: ["地点：上海", "经验：1-3年"],
          unresolvedParams: []
        }
      })
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ channel: options.browserChannel, headless: true });

    for (const [state, planId] of [["ready", ready.planId], ["blocked", blocked.planId]]) {
      for (const viewport of VIEWPORTS) {
        result.pages.push(await auditPage({
          browser,
          baseUrl,
          state,
          planId,
          viewport,
          label: options.label,
          outputDir: options.outputDir
        }));
      }
    }
  } catch (error) {
    result.errors.push(String(error?.message || error));
    throw error;
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (db) db.close();
    for (const suffix of ["", "-shm", "-wal"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
    fs.writeFileSync(path.join(options.outputDir, `${options.label}.json`), `${JSON.stringify(result, null, 2)}\n`);
  }
}

async function auditPage({ browser, baseUrl, state, planId, viewport, label, outputDir }) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const requestFailures = [];
  const externalRequests = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(normalizeText(message.text(), baseUrl));
  });
  page.on("pageerror", (error) => pageErrors.push(normalizeText(error.message, baseUrl)));
  page.on("requestfailed", (request) => requestFailures.push({
    method: request.method(),
    url: normalizeUrl(request.url(), baseUrl),
    error: request.failure()?.errorText || "unknown"
  }));
  page.on("request", (request) => {
    if (!request.url().startsWith(baseUrl)) externalRequests.push(request.url());
  });

  try {
    await page.goto(`${baseUrl}/plan?planId=${planId}`, { waitUntil: "networkidle" });
    if (state === "ready") {
      await page.waitForFunction(() => {
        const button = document.querySelector("[data-browser-readiness-button]");
        return !button || button.disabled === false;
      });
    }
    await page.evaluate(() => {
      const target = document.querySelector("[data-today-primary]")
        || document.querySelector("[data-browser-readiness-button]")
        || document.querySelector("main a[href], main button:not([disabled])");
      if (target && !target.disabled) target.focus();
    });

    const audit = await page.evaluate(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const describe = (element) => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          text: String(element.textContent || element.value || "").replace(/\s+/g, " ").trim(),
          disabled: Boolean(element.disabled),
          top: round(rect.top),
          right: round(rect.right),
          bottom: round(rect.bottom),
          left: round(rect.left),
          width: round(rect.width),
          height: round(rect.height),
          fullyWithinViewport: rect.top >= 0 && rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight
        };
      };
      const round = (value) => Math.round(value * 100) / 100;
      const primary = [...document.querySelectorAll("[data-today-primary]")].filter(visible);
      const actions = [...document.querySelectorAll("main a[href], main button, main input[type=submit], main summary")].filter(visible);
      const recommended = primary[0]
        || document.querySelector("[data-browser-readiness-button]")
        || actions.find((element) => !element.disabled)
        || actions[0]
        || null;
      const active = document.activeElement;
      const focusStyle = active ? getComputedStyle(active) : null;
      const motionStyle = recommended ? getComputedStyle(recommended) : getComputedStyle(document.body);
      const overflowElements = [...document.body.querySelectorAll("*")]
        .filter(visible)
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.left < -0.5 || rect.right > innerWidth + 0.5;
        })
        .slice(0, 20)
        .map((element) => {
          let ancestor = element.parentElement;
          while (ancestor && !["auto", "scroll"].includes(getComputedStyle(ancestor).overflowX)) ancestor = ancestor.parentElement;
          return {
            tag: element.tagName.toLowerCase(),
            id: element.id || "",
            classes: typeof element.className === "string" ? element.className : "",
            scrollContainer: ancestor ? {
              tag: ancestor.tagName.toLowerCase(),
              id: ancestor.id || "",
              classes: typeof ancestor.className === "string" ? ancestor.className : ""
            } : null
          };
        });
      const currentNavigation = [...document.querySelectorAll('a[aria-current="page"]')].map((element) => ({
        text: String(element.textContent || "").trim(),
        href: element.getAttribute("href")
      }));
      return {
        viewport: { width: innerWidth, height: innerHeight },
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
        overflowElements,
        actionCount: actions.length,
        primaryCount: primary.length,
        primary: describe(primary[0] || null),
        recommendedAction: describe(recommended),
        focus: {
          focusedRecommendedAction: Boolean(recommended && active === recommended),
          activeTag: active?.tagName?.toLowerCase() || null,
          activeText: String(active?.textContent || active?.value || "").replace(/\s+/g, " ").trim().slice(0, 160),
          outlineStyle: focusStyle?.outlineStyle || null,
          outlineWidth: focusStyle?.outlineWidth || null,
          outlineOffset: focusStyle?.outlineOffset || null
        },
        reducedMotion: {
          mediaMatches: matchMedia("(prefers-reduced-motion: reduce)").matches,
          transitionDuration: motionStyle.transitionDuration,
          animationDuration: motionStyle.animationDuration
        },
        currentNavigation,
        nestedDocuments: document.querySelectorAll("html html, body body").length
      };
    });

    const screenshot = `${label}-${state}-${viewport.width}x${viewport.height}.png`;
    await page.screenshot({ path: path.join(outputDir, screenshot), fullPage: false });
    return {
      state,
      path: `/plan?planId=${planId}`,
      screenshot,
      audit,
      consoleErrors,
      pageErrors,
      requestFailures,
      externalRequests
    };
  } finally {
    await context.close();
  }
}

function seed({ storage, matchingCardFromProfile, db, name, confirmCard }) {
  const profile = {
    candidate: { name, city: FIXTURE.candidateCity, targetTitles: [FIXTURE.targetTitle] },
    education: [],
    experiences: [],
    skills: [{ name: "Python", evidence: ["fixed evaluation fixture"] }],
    projects: [{ name: "Fixed RAG fixture", canSay: ["RAG"] }],
    credentials: [],
    strengths: []
  };
  const contentHash = `today-dashboard-v1-${name.toLowerCase()}`;
  const saved = storage.saveProfileAnalysis(db, {
    profile,
    document: {
      originalFileName: `${name}.txt`,
      format: "text",
      contentHash,
      text: "Python RAG fixed evaluation fixture. ".repeat(20),
      diagnostics: {}
    },
    searchPlan: {
      name: `${name} fixed plan`,
      cities: [FIXTURE.candidateCity],
      directions: ["AI 应用开发"],
      keywords: [
        { word: FIXTURE.keywords[0], priority: "A", reason: "fixed fixture" },
        { word: FIXTURE.keywords[1], priority: "B", reason: "fixed fixture" }
      ],
      experience: ["1-3年"],
      jobTypes: ["全职"],
      degrees: [],
      salary: FIXTURE.salary,
      bossActiveDays: 3,
      platform: { site: "boss" }
    }
  });
  const draft = storage.createMatchingCardDraft(db, {
    profileId: saved.profileId,
    profileVersionId: saved.profileVersionId,
    resumeDocumentId: saved.resumeDocumentId,
    resumeContentHash: contentHash,
    card: matchingCardFromProfile(profile),
    source: "migration"
  });
  if (confirmCard) storage.confirmMatchingCard(db, { profileId: saved.profileId, cardId: draft.id });
  return saved;
}

function parseArgs(args, env) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (!["--target-root", "--label", "--output-dir", "--browser-channel"].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
    values.set(argument, value);
    index += 1;
  }
  return {
    help: false,
    targetRoot: path.resolve(values.get("--target-root") || env.ROLEFLOW_EVAL_TARGET_ROOT || process.cwd()),
    label: values.get("--label") || env.ROLEFLOW_EVAL_LABEL || "current",
    outputDir: path.resolve(values.get("--output-dir") || env.ROLEFLOW_EVAL_OUTPUT_DIR || path.join(process.cwd(), ".runtime", "today-dashboard-evidence")),
    browserChannel: values.get("--browser-channel") || env.ROLEFLOW_EVAL_BROWSER_CHANNEL || "msedge"
  };
}

function validateOptions(options) {
  if (!/^[a-zA-Z0-9._-]+$/.test(options.label)) throw new Error("Label may contain only letters, numbers, dot, underscore, and hyphen.");
  const serverPath = path.join(options.targetRoot, "src", "dashboard", "server.js");
  if (!fs.existsSync(serverPath)) throw new Error(`Target root does not contain src/dashboard/server.js: ${options.targetRoot}`);
}

function gitRevision(targetRoot) {
  try {
    return execFileSync("git", ["-C", targetRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function normalizeUrl(url, baseUrl) {
  if (!url.startsWith(baseUrl)) return url;
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

function normalizeText(value, baseUrl) {
  return String(value || "").split(baseUrl).join("<local-dashboard>");
}

function quietLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    requestId() { return "today-dashboard-evaluation"; },
    listRecent() { return []; }
  };
}

function usage() {
  return [
    "Usage: node scripts/evaluate-today-dashboard.js [options]",
    "",
    "Options:",
    "  --target-root <path>       RoleFlow checkout to evaluate",
    "  --label <name>             Artifact prefix and JSON filename",
    "  --output-dir <path>        Directory for JSON and viewport PNGs",
    "  --browser-channel <name>   Playwright Chromium channel (default: msedge)",
    "  -h, --help                 Show this help",
    "",
    "Environment equivalents: ROLEFLOW_EVAL_TARGET_ROOT, ROLEFLOW_EVAL_LABEL,",
    "ROLEFLOW_EVAL_OUTPUT_DIR, ROLEFLOW_EVAL_BROWSER_CHANNEL.",
    ""
  ].join("\n");
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { VIEWPORTS, FIXTURE, parseArgs, normalizeUrl };
