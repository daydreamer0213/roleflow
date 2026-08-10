"use strict";

const assert = require("node:assert/strict");
const { PAGE_SPECS, assertStrictPage, parseArgs } = require("../scripts/evaluate-dashboard-wave2");

assert.deepEqual(PAGE_SPECS.map((page) => page.id), ["today-ready", "workflow-scanning", "queue-primary", "jobs-latest", "communication-review", "settings", "onboarding-existing", "diagnostics"]);
assert.deepEqual(parseArgs(["--help"]), { help: true }, "the evaluator must expose a dependency-free help path");
assert.throws(() => parseArgs(["--no-strict"]), /Unknown argument: --no-strict/, "the canonical evaluator must never offer a non-strict path");
assert.equal(parseArgs([]).strict, true, "the evaluator must always report strict mode");
assert.deepEqual(Object.fromEntries(PAGE_SPECS.map((page) => [page.family, page.primaryPolicy])), {
  today: "required", workflow: "required", queue: "none-expected", jobs: "none-expected",
  communication: "required", settings: "none-expected", onboarding: "required", diagnostics: "none-expected"
}, "every audited route family must declare a primary-action policy");
assert.deepEqual(Object.fromEntries(PAGE_SPECS.map((page) => [page.family, page.interactionPolicy])), {
  today: "read-only-none", workflow: "exercised", queue: "exercised", jobs: "exercised",
  communication: "safety-not-executed", settings: "safety-not-executed", onboarding: "safety-not-executed", diagnostics: "read-only-none"
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

console.log("dashboard_wave2_acceptance_smoke ok");
