#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") values.help = true;
    else if (arg.startsWith("--")) values[arg.slice(2)] = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : true;
  }
  return values;
}

function usage() {
  return [
    "Usage:",
    "  node docs/prototypes/roleflow-dashboard/verify.mjs --playwright <module-path> --edge <edge-executable>",
    "",
    "Optional:",
    "  --root <prototype-dir>    Defaults to this script's directory",
    "  --report <json-path>      Defaults to screenshots/viewport-audit.json",
    "",
    "Environment alternatives:",
    "  ROLEFLOW_PLAYWRIGHT       Existing Playwright module path",
    "  ROLEFLOW_EDGE_EXECUTABLE  Existing Edge executable path"
  ].join("\n");
}

function pngSize(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) throw new Error("screenshot is not a PNG");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function luminance(hex) {
  const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = (value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  return 0.2126 * linear(channels[0]) + 0.7152 * linear(channels[1]) + 0.0722 * linear(channels[2]);
}

function contrastRatio(foreground, background) {
  const foregroundLum = luminance(foreground);
  const backgroundLum = luminance(background);
  return (Math.max(foregroundLum, backgroundLum) + 0.05) / (Math.min(foregroundLum, backgroundLum) + 0.05);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}

const root = path.resolve(String(args.root || scriptDir));
const screenshotDir = path.join(root, "screenshots");
const reportPath = path.resolve(String(args.report || path.join(screenshotDir, "viewport-audit.json")));
const playwrightSource = String(args.playwright || process.env.ROLEFLOW_PLAYWRIGHT || "playwright");
const edgeExecutable = String(args.edge || process.env.ROLEFLOW_EDGE_EXECUTABLE || "");
const pageNames = ["today", "workflow", "queue"];
const viewports = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1024x768", width: 1024, height: 768 },
  { name: "768x1024", width: 768, height: 1024 },
  { name: "375x812", width: 375, height: 812 }
];
const primarySelectors = {
  today: ".action-panel .button:not(.quiet)",
  workflow: ".heading-meta .button",
  queue: ".queue-head .button"
};
const textSelectors = [
  "h1",
  ".page-heading .lede",
  ".action-panel h2",
  ".action-panel .muted",
  ".heading-meta",
  ".metric-grid",
  ".queue-head",
  ".job-card h2",
  ".review-main",
  ".metric-note",
  ".pool-tabs"
];
const criticalTextSelectors = [
  "h1",
  ".page-heading .lede",
  ".action-panel h2",
  ".action-panel .muted",
  ".heading-meta",
  ".job-card h2",
  ".review-main",
  ".metric-note",
  ".pool-tabs a"
];
const contrastPairs = [
  ["#13252B", "#EEF2EF"],
  ["#40545A", "#FFFFFF"],
  ["#006B5B", "#FFFFFF"],
  ["#F07824", "#13252B"],
  ["#2F6FDB", "#FFFFFF"],
  ["#B23A32", "#FFFFFF"],
  ["#956B19", "#FFFFFF"]
].map(([foreground, background]) => ({
  foreground,
  background,
  ratio: Number(contrastRatio(foreground, background).toFixed(2)),
  pass: contrastRatio(foreground, background) >= 4.5
}));

fs.mkdirSync(screenshotDir, { recursive: true });
const failures = [];
const results = [];
let browser;
let context;
let page;

try {
  const { chromium } = require(playwrightSource);
  browser = await chromium.launch({
    headless: true,
    ...(edgeExecutable ? { executablePath: edgeExecutable } : {})
  });
  context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  page = await context.newPage();

  for (const pageName of pageNames) {
    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const consoleErrors = [];
      const pageErrors = [];
      const requestFailures = [];
      page.removeAllListeners("console");
      page.removeAllListeners("pageerror");
      page.removeAllListeners("requestfailed");
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("requestfailed", (request) => {
        const url = request.url();
        if (!/^(file|data|about):/i.test(url)) requestFailures.push(`${url} :: ${request.failure()?.errorText || "unknown error"}`);
      });

      const sourcePath = path.join(root, `${pageName}.html`);
      await page.goto(pathToFileURL(sourcePath).href, { waitUntil: "load" });
      const screenshot = await page.screenshot({
        path: path.join(screenshotDir, `${pageName}-${viewport.name}.png`)
      });
      const metrics = await page.evaluate(({ primarySelector, textSelectors, criticalTextSelectors, pageName }) => {
        const root = document.documentElement;
        const primary = document.querySelector(primarySelector);
        const primaryRect = primary?.getBoundingClientRect();
        const text = [];
        for (const selector of textSelectors) {
          for (const element of document.querySelectorAll(selector)) {
            const elementRect = element.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(element);
            const style = getComputedStyle(element);
            text.push({
              selector,
              rect: { left: elementRect.left, right: elementRect.right, top: elementRect.top, bottom: elementRect.bottom },
              ranges: [...range.getClientRects()].filter((rect) => rect.width || rect.height).map((rect) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })),
              computed: { minWidth: style.minWidth, overflowWrap: style.overflowWrap, whiteSpace: style.whiteSpace, overflowX: style.overflowX }
            });
          }
        }
        const criticalStyles = criticalTextSelectors.flatMap((selector) => [...document.querySelectorAll(selector)].map((element) => {
          const style = getComputedStyle(element);
          return { selector, minWidth: style.minWidth, overflowWrap: style.overflowWrap };
        }));
        const nav = document.querySelector(".primary-nav");
        const navRect = nav?.getBoundingClientRect();
        const navHint = document.querySelector(".nav-scroll-hint");
        const form = pageName === "workflow" ? document.querySelector('form[action="/api/communication-batch"]') : null;
        const formFields = form ? [...form.querySelectorAll("[name]")].map((input) => ({ name: input.name, value: input.value, type: input.type, checked: input.checked })) : [];
        return {
          viewport: { innerWidth, innerHeight, clientWidth: root.clientWidth, clientHeight: root.clientHeight, devicePixelRatio },
          scroll: { root: root.scrollWidth, body: document.body.scrollWidth },
          primary: primaryRect ? { left: primaryRect.left, right: primaryRect.right, top: primaryRect.top, bottom: primaryRect.bottom } : null,
          text,
          criticalStyles,
          nav: navRect ? { left: navRect.left, right: navRect.right, scrollWidth: nav.scrollWidth, clientWidth: nav.clientWidth, overflowX: getComputedStyle(nav).overflowX, flexWrap: getComputedStyle(nav).flexWrap } : null,
          navHint: navHint ? { display: getComputedStyle(navHint).display, rect: navHint.getBoundingClientRect().toJSON() } : null,
          externalLinks: [...document.querySelectorAll("a[href]")].filter((link) => /^https?:/i.test(link.href)).length,
          externalResources: performance.getEntriesByType("resource").map((entry) => entry.name).filter((name) => !name.startsWith("file:") && !name.startsWith("data:") && !name.startsWith("about:")),
          formContract: form ? {
            method: form.getAttribute("method"),
            action: form.getAttribute("action"),
            prototypeBlocked: /return false/.test(form.getAttribute("onsubmit") || ""),
            fields: formFields,
            checkedJobIds: formFields.filter((field) => field.name === "jobIds" && field.checked).map((field) => field.value)
          } : null
        };
      }, { primarySelector: primarySelectors[pageName], textSelectors, criticalTextSelectors, pageName });

      await page.emulateMedia({ reducedMotion: "reduce" });
      const reducedMotion = await page.evaluate(() => ({
        transitionDuration: getComputedStyle(document.querySelector(".button")).transitionDuration,
        transitionSeconds: parseFloat(getComputedStyle(document.querySelector(".button")).transitionDuration || "0")
      }));
      await page.keyboard.press("Tab");
      const focus = await page.evaluate(() => ({
        tag: document.activeElement?.tagName || "",
        className: document.activeElement?.className || "",
        outline: getComputedStyle(document.activeElement).outlineStyle,
        outlineWidth: getComputedStyle(document.activeElement).outlineWidth
      }));

      const checks = [];
      const viewportMatch = metrics.viewport.innerWidth === viewport.width
        && metrics.viewport.innerHeight === viewport.height
        && metrics.viewport.clientWidth === viewport.width
        && metrics.viewport.clientHeight === viewport.height;
      if (!viewportMatch) checks.push("layout viewport mismatch");
      if (metrics.scroll.root !== viewport.width || metrics.scroll.body !== viewport.width) checks.push("root overflow");
      if (!metrics.primary || metrics.primary.left < 0 || metrics.primary.right > viewport.width || metrics.primary.top < 0 || metrics.primary.bottom > viewport.height) checks.push("primary CTA not fully in first viewport");
      for (const item of metrics.text) {
        if (item.rect.left < -0.5 || item.rect.right > viewport.width + 0.5) checks.push(`${item.selector} container exceeds viewport`);
        for (const range of item.ranges) {
          if (range.left < item.rect.left - 0.5 || range.right > item.rect.right + 0.5 || range.left < -0.5 || range.right > viewport.width + 0.5) checks.push(`${item.selector} text range exceeds container`);
        }
      }
      for (const item of metrics.criticalStyles) {
        if (item.minWidth !== "0px" || item.overflowWrap !== "anywhere") checks.push(`${item.selector} missing mobile text safeguards`);
      }
      if (viewport.width < 700) {
        if (!metrics.nav || metrics.nav.left < 0 || metrics.nav.right > viewport.width + 0.5 || metrics.nav.overflowX !== "auto" || metrics.nav.flexWrap !== "nowrap") checks.push("mobile nav contract");
        if (!metrics.navHint || metrics.navHint.display === "none" || metrics.navHint.rect.right > viewport.width + 0.5) checks.push("mobile nav hint missing or out of bounds");
      }
      if (metrics.externalLinks || metrics.externalResources.length) checks.push("external URL or resource");
      if (consoleErrors.length) checks.push(`console errors: ${consoleErrors.join(" | ")}`);
      if (pageErrors.length) checks.push(`page errors: ${pageErrors.join(" | ")}`);
      if (requestFailures.length) checks.push(`request failures: ${requestFailures.join(" | ")}`);
      if (reducedMotion.transitionSeconds > 0.001) checks.push("reduced motion not honored");
      if (focus.tag !== "A" || focus.className !== "skip-link" || focus.outline !== "solid" || focus.outlineWidth !== "3px") checks.push("focus ring");
      if (pageName === "workflow") {
        const contract = metrics.formContract;
        const names = contract?.fields.map((field) => field.name) || [];
        if (!contract || contract.method !== "post" || contract.action !== "/api/communication-batch" || !contract.prototypeBlocked || !["planId", "workflowRunId", "browserMode", "jobIds"].every((name) => names.includes(name)) || contract.checkedJobIds.length !== 3) checks.push("communication batch form contract");
      }

      const png = pngSize(screenshot);
      if (png.width !== viewport.width || png.height !== viewport.height) checks.push("PNG size mismatch");
      results.push({
        page: pageName,
        viewport: viewport.name,
        pass: checks.length === 0,
        checks,
        metrics,
        screenshot: `${pageName}-${viewport.name}.png`,
        png,
        consoleErrors,
        pageErrors,
        requestFailures,
        reducedMotion,
        focus
      });
      if (checks.length) failures.push(`${pageName} ${viewport.name}: ${checks.join(", ")}`);
    }
  }
} catch (error) {
  failures.push(`fatal: ${error.stack || error.message}`);
} finally {
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
}

const report = {
  renderer: {
    tool: "Playwright",
    viewportMethod: "page.setViewportSize",
    deviceScaleFactor: 1,
    edgeExecutable: edgeExecutable ? path.basename(edgeExecutable) : "Playwright default"
  },
  pages: pageNames,
  viewports,
  contrast: contrastPairs,
  summary: {
    expectedCases: pageNames.length * viewports.length,
    completedCases: results.length,
    passedCases: results.filter((result) => result.pass).length,
    failedCases: results.filter((result) => !result.pass).length,
    failures
  },
  results
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ report: reportPath, summary: report.summary }, null, 2));
if (failures.length || results.length !== pageNames.length * viewports.length || contrastPairs.some((pair) => !pair.pass)) process.exitCode = 1;
