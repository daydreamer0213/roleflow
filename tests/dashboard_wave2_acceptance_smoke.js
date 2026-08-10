"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  PAGE_SPECS,
  assertStrictPage,
  parseArgs
} = require("../scripts/evaluate-dashboard-wave2");

const expectedPageIds = [
  "today-ready",
  "workflow-scanning",
  "queue-primary",
  "jobs-latest",
  "communication-review",
  "settings",
  "onboarding-existing",
  "diagnostics"
];

assert.deepEqual(PAGE_SPECS.map((page) => page.id), expectedPageIds, "the combined audit must retain one representative route for every Wave 2 page family");
assert.deepEqual(parseArgs(["--help"]), { help: true }, "the evaluator must expose a dependency-free help path");

const passingPage = {
  id: "today-ready",
  viewport: { width: 375, height: 812 },
  audit: {
    scrollTop: 0,
    viewport: { width: 375, height: 812 },
    documentWidth: 375,
    bodyWidth: 375,
    horizontalOverflow: false,
    shell: { present: true, navigationPresent: true, mainPresent: true, activeNavigationCount: 1, navigationMinTarget: 44 },
    primary: { defined: true, count: 1, visibleCount: 1, fullyWithinViewport: true },
    focus: { focused: true, outlineStyle: "solid", outlineWidth: 3 },
    reducedMotion: { mediaMatches: true, transitionDuration: "0.01s", animationDuration: "0.01s" },
    accessibility: { viewportMeta: "width=device-width, initial-scale=1", headingOrderValid: true, bodyFontSize: 16, structuralEmoji: [] }
  },
  interaction: { kind: "client-only", attempted: true, passed: true },
  errors: { console: [], page: [], request: [], external: [] }
};

assert.doesNotThrow(() => assertStrictPage(passingPage), "a complete offline audit sample must satisfy the strict gate");
for (const [name, mutate] of [
  ["horizontal overflow", (page) => { page.audit.horizontalOverflow = true; }],
  ["missing shell", (page) => { page.audit.shell.present = false; }],
  ["missing active navigation", (page) => { page.audit.shell.activeNavigationCount = 0; }],
  ["primary below the fold", (page) => { page.audit.primary.fullyWithinViewport = false; }],
  ["weak keyboard focus", (page) => { page.audit.focus.outlineWidth = 1; }],
  ["ignored reduced motion", (page) => { page.audit.reducedMotion.mediaMatches = false; }],
  ["external request", (page) => { page.errors.external.push("https://example.invalid"); }],
  ["failed interaction", (page) => { page.interaction.passed = false; }]
]) {
  const broken = structuredClone(passingPage);
  mutate(broken);
  assert.throws(() => assertStrictPage(broken), new RegExp(name), `strict acceptance must fail closed for ${name}`);
}

const root = path.join(__dirname, "..");
const outputDir = path.join(root, ".runtime", `dashboard-wave2-acceptance-smoke-${process.pid}`);
try {
  const result = spawnSync(process.execPath, [
    path.join(root, "scripts", "evaluate-dashboard-wave2.js"),
    "--no-strict",
    "--label", "smoke",
    "--output-dir", outputDir
  ], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...process.env,
      NODE_PATH: "C:\\Users\\Administrator\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\node_modules",
      ROLEFLOW_REQUIRE_PLAYWRIGHT: "1"
    }
  });
  assert.strictEqual(result.status, 0, `the focused offline evaluator must run: ${result.stderr}`);
  const evidence = JSON.parse(fs.readFileSync(path.join(outputDir, "smoke.json"), "utf8"));
  assert.strictEqual(evidence.pages.length, 32, "the focused evaluator must capture every page family at all four viewports");
  assert.deepEqual(evidence.errors, [], "the focused evaluator must retain its own clean run result");
  assert(evidence.pages.every((page) => !page.audit.horizontalOverflow), "all audited dashboard routes must fit every acceptance viewport without horizontal overflow");
  assert(evidence.pages.every((page) => page.audit.shell.navigationMinTarget >= 44), "shared navigation must provide 44px touch targets across every audited route");
} finally {
  fs.rmSync(outputDir, { recursive: true, force: true });
}

console.log("dashboard_wave2_acceptance_smoke ok");
