"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { PAGE_SPECS, RELEVANT_CONTROL_SELECTOR, VIEWPORTS, assertCanonicalArtifacts, assertStrictPage, pageAudit, parseArgs } = require("../scripts/evaluate-dashboard-wave2");

assert.deepEqual(PAGE_SPECS.map((page) => page.id), ["today-ready", "workflow-scanning", "queue-primary", "jobs-latest", "communication-review", "messages-unresolved", "settings", "onboarding-existing", "match-card", "profile", "resumes", "diagnostics"]);
assert.deepEqual(parseArgs(["--help"]), { help: true }, "the evaluator must expose a dependency-free help path");
assert.throws(() => parseArgs(["--no-strict"]), /Unknown argument: --no-strict/, "the canonical evaluator must never offer a non-strict path");
assert.equal(parseArgs([]).strict, true, "the evaluator must always report strict mode");
const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-dashboard-artifacts-"));
try {
  const label = "beta4-final-v2";
  fs.writeFileSync(path.join(artifactDir, `${label}.json`), "{}\n");
  for (const spec of PAGE_SPECS) for (const viewport of VIEWPORTS) {
    fs.writeFileSync(path.join(artifactDir, `${label}-${spec.id}-${viewport.width}x${viewport.height}.png`), "");
  }
  fs.writeFileSync(path.join(artifactDir, "beta4-final.json"), "{}\n");
  fs.writeFileSync(path.join(artifactDir, "beta4-final-today-ready-1440x900.png"), "");
  assert.doesNotThrow(
    () => assertCanonicalArtifacts(artifactDir, label, PAGE_SPECS.length * VIEWPORTS.length),
    "canonical validation must ignore evidence that belongs to another label in the same directory"
  );
} finally {
  fs.rmSync(artifactDir, { recursive: true, force: true });
}
const matchCardSpec = PAGE_SPECS.find((page) => page.id === "match-card");
assert.equal(matchCardSpec.path({ profileId: 17, matchCardId: 23 }), "/match-card?profileId=17&cardId=23", "the match-card audit must open the confirmed card detail from its fixture");
assert.match(RELEVANT_CONTROL_SELECTOR, /:not\(\[type=checkbox\]\).*:not\(\[type=radio\]\)/, "touch gates must exclude compact choice controls from standalone action targets");
assert.deepEqual(Object.fromEntries(PAGE_SPECS.map((page) => [page.family, page.primaryPolicy])), {
  today: "required", workflow: "none-expected", queue: "none-expected", jobs: "none-expected",
  communication: "required", messages: "required", settings: "none-expected", onboarding: "required", matchCard: "none-expected", profile: "none-expected", resumes: "none-expected", diagnostics: "none-expected"
}, "every audited route family must declare a primary-action policy");
assert.deepEqual(Object.fromEntries(PAGE_SPECS.map((page) => [page.family, page.interactionPolicy])), {
  today: "read-only-none", workflow: "exercised", queue: "exercised", jobs: "exercised",
  communication: "safety-not-executed", messages: "safety-not-executed", settings: "safety-not-executed", onboarding: "safety-not-executed", matchCard: "safety-not-executed", profile: "safety-not-executed", resumes: "safety-not-executed", diagnostics: "read-only-none"
}, "every audited route family must declare an interaction policy");

const passingPage = {
  id: "today-ready",
  viewport: { width: 375, height: 812 },
  audit: {
    scrollTop: 0, viewport: { width: 375, height: 812 }, documentWidth: 375, bodyWidth: 375, horizontalOverflow: false,
    shell: { present: true, framePresent: true, frameCount: 1, navigationPresent: true, primaryNavigationCount: 1, mainPresent: true, activeNavigationCount: 1, navigationMinTarget: 44 },
    primary: { policy: "required", defined: true, markerCount: 1, count: 1, visibleCount: 1, fullyWithinViewport: true, control: { height: 44 } },
    touch: { relevantControlMinTarget: 44 },
    reducedMotion: { mediaMatches: true, longRunningAnimations: 0 },
    accessibility: { viewportMeta: "width=device-width, initial-scale=1", headingOrderValid: true, bodyFontSize: 16, structuralEmoji: [] }
  },
  focusAudit: { focus: { focused: true, outlineStyle: "solid", outlineWidth: 3 } },
  interaction: { kind: "none", policy: "read-only-none", attempted: false, passed: true },
  errors: { console: [], page: [], request: [], external: [] }
};

assert.doesNotThrow(() => assertStrictPage(passingPage), "a complete offline audit sample must satisfy the strict gate");
for (const [name, mutate] of [
  ["horizontal overflow", (page) => { page.audit.horizontalOverflow = true; }],
  ["missing shared frame", (page) => { page.audit.shell.framePresent = false; }],
  ["duplicate primary navigation", (page) => { page.audit.shell.primaryNavigationCount = 2; }],
  ["missing active navigation", (page) => { page.audit.shell.activeNavigationCount = 0; }],
  ["primary below the fold", (page) => { page.audit.primary.fullyWithinViewport = false; }],
  ["undersized primary", (page) => { page.audit.primary.control.height = 43; }],
  ["undersized relevant form control", (page) => { page.audit.touch.relevantControlMinTarget = 43; }],
  ["weak keyboard focus", (page) => { page.focusAudit.focus.outlineWidth = 1; }],
  ["ignored reduced motion", (page) => { page.audit.reducedMotion.mediaMatches = false; }],
  ["external request", (page) => { page.errors.external.push("https://example.invalid"); }],
  ["failed interaction", (page) => { page.interaction.policy = "exercised"; page.interaction.attempted = true; page.interaction.passed = false; page.interactionPolicy = "exercised"; }]
]) {
  const broken = structuredClone(passingPage);
  mutate(broken);
  assert.throws(() => assertStrictPage(broken), new RegExp(name), `strict acceptance must fail closed for ${name}`);
}

const noPrimaryMarker = structuredClone(passingPage);
noPrimaryMarker.audit.primary = { policy: "none-expected", defined: false, markerCount: 1, count: 0, visibleCount: 0, fullyWithinViewport: false, control: null };
assert.throws(() => assertStrictPage(noPrimaryMarker), /unexpected page-level primary marker/, "none-expected pages must fail if a page-level primary marker is present");

const unlabeledStrictPage = structuredClone(passingPage);
unlabeledStrictPage.audit.accessibility.unlabeledVisibleControlCount = 1;
unlabeledStrictPage.audit.accessibility.unlabeledVisibleControls = [{ tag: "input", name: "hrMessage" }];
assert.throws(() => assertStrictPage(unlabeledStrictPage), /unlabeled visible controls.*input\[name=hrMessage\]/, "the pure strict gate must reject an unnamed visible control without Playwright");

const namedStrictPage = structuredClone(passingPage);
namedStrictPage.audit.accessibility.unlabeledVisibleControlCount = 0;
namedStrictPage.audit.accessibility.unlabeledVisibleControls = [];
assert.doesNotThrow(() => assertStrictPage(namedStrictPage), "the pure strict gate must accept a named visible control without Playwright");

async function assertAccessibleNameRegression() {
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch (error) {
    if (process.env.ROLEFLOW_REQUIRE_PLAYWRIGHT === "1") throw error;
    console.log("dashboard_wave2_acceptance_smoke skipped-runtime-fixture: Playwright is unavailable; pure strict-gate coverage still ran");
    return;
  }
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    for (const [html, expectedUnlabeled] of [
      ['<input name="hrMessage" placeholder="Paste message" title="Paste message">', [{ tag: "input", name: "hrMessage" }]],
      ['<label for="hr-message">HR original message</label><textarea id="hr-message" name="hrMessage"></textarea>', []]
    ]) {
      const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
      await page.setContent(html);
      const audit = await page.evaluate(pageAudit);
      assert.deepEqual(audit.accessibility.unlabeledVisibleControls, expectedUnlabeled, "the runtime evaluator must ignore placeholder/title and accept an associated label");
      const candidate = structuredClone(passingPage);
      candidate.audit.accessibility = { ...candidate.audit.accessibility, labelledInputs: audit.accessibility.labelledInputs, unlabeledVisibleControlCount: audit.accessibility.unlabeledVisibleControlCount, unlabeledVisibleControls: audit.accessibility.unlabeledVisibleControls };
      if (expectedUnlabeled.length) assert.throws(() => assertStrictPage(candidate), /unlabeled visible controls.*input\[name=hrMessage\]/, "an unnamed visible fixture must fail the strict page gate");
      else assert.doesNotThrow(() => assertStrictPage(candidate), "a named visible fixture must pass the strict page gate");
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log("dashboard_wave2_acceptance_smoke runtime-fixture ok");
}

const workflowHelp = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "evaluate-workflow-dashboard.js"), "--help"], { encoding: "utf8" });
assert.equal(workflowHelp.status, 0, `workflow evaluator help must exit cleanly: ${workflowHelp.stderr}`);
assert.match(workflowHelp.stdout, /Usage: node scripts\/evaluate-workflow-dashboard\.js/, "workflow evaluator help must be useful");
assert.doesNotMatch(workflowHelp.stdout, /\\n/, "workflow evaluator help must use real line breaks");

assertAccessibleNameRegression().then(() => console.log("dashboard_wave2_acceptance_smoke ok")).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
