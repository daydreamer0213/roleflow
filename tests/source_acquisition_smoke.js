const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { chooseAutomationTab } = require("../src/adapters/browser/edge_control");
const {
  PAGE_HELPERS,
  BossSiteAdapter,
  buildBossScanTargets,
  parseBossFilterCatalog
} = require("../src/adapters/sites/boss");
const { resolveNativeFilterSnapshot, assertGeneratedFilterSelections } = require("../src/core/platform_filters");
const { buildInheritedSearchScope } = require("../src/core/inherited_search_scope");
const { compilePlatformRuntimePolicy } = require("../src/core/platform_runtime_policy");
const { CITY_CODES } = require("../src/core/search_plan");
const { PRODUCT_POLICY } = require("../src/core/product_policy");
const {
  openDb,
  createBatch,
  recordScanTargetResult,
  listScanTargetResults,
  getSiteRuntimeState,
  setSiteRuntimeState,
  clearSiteRuntimeState,
  acquireSiteScanLease,
  renewSiteScanLease,
  releaseSiteScanLease,
  getSiteScanLease,
  listReusableJobDetails,
  recordJobRefreshAttempt,
  listJobRefreshAttempts,
  upsertJob
} = require("../src/core/storage");

const activeBoss = { id: "active-boss", active: true, url: "https://www.zhipin.com/web/geek/jobs?query=RAG" };
assert.strictEqual(chooseAutomationTab([
  { id: "old-boss", active: false, url: "https://www.zhipin.com/web/geek/jobs?query=Python" },
  activeBoss,
  { id: "other", active: false, url: "https://example.com" }
]).id, activeBoss.id);

const catalog = parseBossFilterCatalog([
  { options: [
    { ka: "sel-job-rec-salary-405", label: "10-20K" },
    { ka: "sel-job-rec-salary-406", label: "20-30K" }
  ] },
  { options: [
    { ka: "sel-job-rec-exp-101", label: "经验不限" },
    { ka: "sel-job-rec-exp-104", label: "1-3年" }
  ] },
  { options: [
    { ka: "sel-job-rec-jobType-1901", label: "全职" },
    { ka: "sel-job-rec-jobType-1902", label: "实习" }
  ] },
  { options: [
    { ka: "sel-job-rec-degree-203", label: "本科" }
  ] }
]);
const native = resolveNativeFilterSnapshot({
  site: "boss",
  catalog,
  plan: {
    salary: { minK: 10, maxK: 20 },
    experience: ["经验不限", "1-3年"],
    jobTypes: ["全职"],
    degrees: ["本科"],
    platform: { salaryLanes: ["旧的10-20K标签"] }
  }
});
assert.deepStrictEqual(native.params, {
  experience: ["101", "104"],
  jobType: ["1901"],
  degree: ["203"],
  salary: ["405"]
});
assert(native.warnings.some((item) => item.code === "salary_labels_remapped"));
assert.deepStrictEqual(native.unresolvedSelections, [{ field: "salary", label: "旧的10-20K标签" }]);
assert.throws(
  () => assertGeneratedFilterSelections({}, native),
  (error) => error?.code === "GENERATED_FILTER_SELECTION_UNRESOLVED" && /旧的10-20K标签/.test(error.message)
);
const nestedNative = resolveNativeFilterSnapshot({
  site: "boss",
  catalog,
  plan: {
    acquisitionMode: "generated",
    salary: { minK: 10, maxK: 20 },
    platform: {
      site: "boss",
      generated: {
        salaryLanes: ["10-20K"],
        experience: ["0-3年"],
        jobTypes: ["全职"],
        degrees: ["本科"]
      }
    }
  }
});
assert.deepStrictEqual(nestedNative.params, {
  experience: ["104"],
  jobType: ["1901"],
  degree: ["203"],
  salary: ["405"]
});
assert.deepStrictEqual(nestedNative.unresolvedSelections, []);
assert.strictEqual(assertGeneratedFilterSelections({}, nestedNative), nestedNative);
const noPlatformSalary = resolveNativeFilterSnapshot({
  site: "boss",
  catalog,
  plan: {
    acquisitionMode: "generated",
    salary: { minK: 10, maxK: 20 },
    platform: { generated: { salaryLanes: [] } }
  }
});
assert.strictEqual(Object.hasOwn(noPlatformSalary.params, "salary"), false, "empty BOSS salary lanes must mean no platform salary limit");
const ambiguousNative = resolveNativeFilterSnapshot({
  site: "boss",
  catalog: {
    site: "boss",
    fields: {
      jobType: {
        urlParam: "jobType",
        selection: "multiple",
        options: [
          { code: "1901", label: "全职" },
          { code: "1999", label: "全职（其他）" }
        ]
      }
    }
  },
  plan: { platform: { generated: { jobTypes: ["全职"] } } }
});
assert.deepStrictEqual(ambiguousNative.unresolvedSelections, [{ field: "jobType", label: "全职" }]);

(async () => {
  await preflightSmoke();
  await inheritedPageInspectionSmoke();
  await riskPreflightSmoke();
  await scrollSmoke();
  await cardGrowthCheckpointSmoke();
  await scanProgressEventOrderSmoke();
  await delayedAppendAtBottomSmoke();
  await confirmedListEndSmoke();
  await scrollSafetyLimitSmoke();
  await maxCardScrollBudgetSmoke();
  await delayedListSmoke();
  await accessReservationSmoke();
  pageHelperCardActivationPointSmoke();
  await searchPageApiDetailStateMachineSmoke();
  await searchPageApiDetailRoutingSmoke();
  await searchPageApiDetailAbortCleanupSmoke();
  await searchPageApiDetailFatalAndCleanupSmoke();
  await visiblePaneIdentitySmoke();
  await visiblePaneActivationWaitSmoke();
  await visiblePaneTrustedClickOrderSmoke();
  await visiblePaneLocateFailureNoClickSmoke();
  await visiblePaneClickIdentityDriftSmoke();
  await visiblePaneClickCapabilityFailClosedSmoke();
  await visiblePaneHalfSwitchOldDetailSmoke();
  await visiblePanePostClickLoadingSmoke();
  await visiblePaneSelectionMismatchSmoke();
  await visiblePaneMissingIdentitySmoke();
  await visiblePaneTitleIdentitySmoke();
  await searchPaneDetailRoutingSmoke();
  await standaloneDetailTimeoutSmoke();
  await cardActivationPointUnavailableSmoke();
  await scanNullPaneOutcomeSmoke();
  await detailCheckpointAndWorkflowPauseSmoke();
  await fullDetailCoverageSmoke();
  await fairDetailAllocationSmoke();
  await priorityDetailBudgetSmoke();
  await reusableDetailSmoke();
  await changedCardFactsRejectCacheSmoke();
  await detailSafetyLimitSmoke();
  await detailFailureDedupeSmoke();
  await detailOutcomeAuditSmoke();
  await detailFatalOutcomeAuditSmoke();
  await trustedClickTransportFatalSmoke();
  await detailBudgetCheckpointSmoke();
  await targetIsolationSmoke();
  await scanTargetPlanSmoke();
  await scanTargetResumeFilterSmoke();
  await fatalBudgetAfterCompletedTargetSmoke();
  await midDetailAbortIsFatalSmoke();
  await abortedScanStopsBeforeBrowserUseSmoke();
  await partialTargetCheckpointSmoke();
  await pageBudgetSmoke();
  await riskControlSmoke();
  await refreshSafetySmoke();
  await runtimeBindingAndAbortSmoke();
  await refreshCheckpointBeforeFatalSmoke();
  storageSmoke();
  console.log("source_acquisition_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function preflightSmoke() {
  const oldSearch = { id: "old-search", active: false, url: "https://www.zhipin.com/web/geek/jobs?query=old" };
  const activeChat = { id: "active-chat", active: true, url: "https://www.zhipin.com/web/geek/chat" };
  const usableSearch = {
    ...activeBoss,
    active: false,
    url: "https://www.zhipin.com/web/geek/jobs?query=PRIVATE_QUERY&city=101280100&salary=405"
  };
  const inspected = [];
  const logs = [];
  const browser = {
    async listTabs() { return [activeChat, oldSearch, usableSearch]; },
    async activeTabId() { return activeChat.id; },
    async evalValue(tabId, expression) {
      assert(expression.includes("loggedIn"));
      assert(expression.includes("header-username"));
      assert(expression.includes("getBoundingClientRect"));
      inspected.push(tabId);
      if (tabId === oldSearch.id) {
        return {
          url: oldSearch.url,
          title: "登录",
          isBoss: true,
          isLoginPage: true,
          loggedIn: false,
          isSearchPage: true,
          hasJobStructure: false
        };
      }
      return {
        url: tabId === usableSearch.id ? usableSearch.url : activeChat.url,
        title: "RAG招聘",
        isBoss: true,
        isLoginPage: false,
        isRiskPage: false,
        loggedIn: true,
        isSearchPage: tabId === usableSearch.id,
        hasJobStructure: tabId === usableSearch.id
      };
    }
  };
  const adapter = new BossSiteAdapter({
    browser,
    logger: { info(event, details) { logs.push({ event, details }); } },
    sleepFn: async () => {}
  });
  const state = await adapter.preflight();
  assert.strictEqual(state.tabId, usableSearch.id);
  assert.strictEqual(state.loggedIn, true);
  assert.deepStrictEqual(inspected, [oldSearch.id, usableSearch.id, activeChat.id]);
  const preflightLog = logs.find((item) => item.event === "boss_browser_preflight_ok");
  assert(preflightLog);
  assert.strictEqual(preflightLog.details.origin, "https://www.zhipin.com");
  assert.strictEqual(preflightLog.details.path, "/web/geek/jobs");
  const serializedLog = JSON.stringify(preflightLog);
  assert(!serializedLog.includes(usableSearch.url));
  assert(!serializedLog.includes("PRIVATE_QUERY"));
  assert(!serializedLog.includes("101280100"));
  assert(!serializedLog.includes("salary=405"));
}

async function inheritedPageInspectionSmoke() {
  let navigations = 0;
  let clicks = 0;
  let sessionCreations = 0;
  const fixture = JSON.parse(fs.readFileSync(
    path.join(__dirname, "fixtures", "boss_inherited_filter_dom.json"),
    "utf8"
  ));
  const browser = {
    async evalValue(_tabId, expression) {
      if (expression.includes("isSearchPage")) {
        return {
          url: fixture.url,
          title: "全国招聘",
          isBoss: true,
          isLoginPage: false,
          isRiskPage: false,
          loggedIn: true,
          isSearchPage: true,
          hasJobStructure: true
        };
      }
      if (expression.includes("condition-filter-select")) {
        return vm.runInNewContext(expression, inheritedFilterDomSandbox(fixture));
      }
      return {
        url: fixture.url,
        path: "/web/geek/jobs",
        isRiskPage: false,
        isLoginPage: false,
        hasJobStructure: true
      };
    },
    async navigate() { navigations += 1; },
    async clickAt() { clicks += 1; },
    async createTab() { sessionCreations += 1; }
  };
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {} });
  const inspected = await adapter.inspectInheritedSearchPage({ tabId: "BOSS-SEARCH" });
  assert.strictEqual(navigations, 0);
  assert.strictEqual(clicks, 0);
  assert.strictEqual(sessionCreations, 0);
  assert.strictEqual(inspected.tabId, "BOSS-SEARCH");
  assert.strictEqual(inspected.searchTemplate.cityCode, "101280100");
  assert.strictEqual(inspected.catalog.fields.salary.options[0].label, "10-20K");
  assert.deepStrictEqual(inspected.urlOptions.filter((item) => item.label === "天河区"), [
    { param: "district", code: "101280105", label: "天河区" }
  ]);
  assert.strictEqual(inspected.urlOptions.some((item) => item.param === "city" || item.param === "salary"), false);
  assert.strictEqual(inspected.urlOptions.some((item) => item.param === "unknownStable"), false);
  assert.deepStrictEqual(inspected.urlOptions.find((item) => item.param === "futureFilter"), {
    param: "futureFilter",
    code: "preview-9",
    label: "未来筛选"
  });
  const inheritedScope = buildInheritedSearchScope({ profileId: 7, rawUrl: inspected.url });
  const platformPolicy = compilePlatformRuntimePolicy({
    searchScope: inheritedScope.searchScope,
    catalog: inspected.catalog,
    urlOptions: inspected.urlOptions,
    cityCodes: CITY_CODES
  });
  assert.deepStrictEqual(platformPolicy.filters.location.districts, ["天河区"]);
  assert.deepStrictEqual(platformPolicy.unresolvedParams, [
    { param: "unknownStable", codes: ["opaque-7"] }
  ]);
}

function inheritedFilterDomSandbox(fixture) {
  const currentUrl = new URL(fixture.url);
  const filterNodes = fixture.rawFields.map((field) => ({
    querySelector(selector) {
      return selector === ".current-select .placeholder-text" ? { textContent: field.label } : null;
    },
    querySelectorAll(selector) {
      if (selector !== "[ka*='sel-job-rec-']") return [];
      return field.options.map((option) => ({
        textContent: option.label,
        className: option.selected ? "selected" : "",
        getAttribute(name) {
          if (name === "ka") return option.ka;
          if (name === "aria-selected") return option.selected ? "true" : null;
          return null;
        },
        matches(selector) {
          return option.selected && /selected|aria-selected/.test(selector);
        },
        closest(selector) {
          return option.selected && /selected|aria-selected/.test(selector) ? this : null;
        }
      }));
    }
  }));
  const linkNodes = fixture.links.map((link) => ({ href: link.href, textContent: link.label }));
  return {
    URL,
    location: { href: currentUrl.href, origin: currentUrl.origin },
    document: {
      querySelectorAll(selector) {
        if (selector === ".condition-filter-select") return filterNodes;
        if (selector === 'a[href*="/web/geek/jobs"]') return linkNodes;
        return [];
      }
    }
  };
}

async function riskPreflightSmoke() {
  const browser = {
    async listTabs() {
      return [
        { id: "healthy", active: true, url: activeBoss.url },
        { id: "verify", active: false, url: "https://www.zhipin.com/web/passport/zp/verify" }
      ];
    },
    async evalValue(tabId, expression) {
      assert(expression.includes("403"));
      assert(expression.includes("访问受限"));
      assert(expression.includes("没有更多职位"));
      if (tabId === "verify") return { isBoss: true, isRiskPage: true, isLoginPage: false, loggedIn: false, isSearchPage: false };
      return { isBoss: true, isRiskPage: false, isLoginPage: false, loggedIn: true, isSearchPage: true, hasJobStructure: true };
    }
  };
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {} });
  await assert.rejects(() => adapter.preflight(), (error) => error.code === "BOSS_RISK_CONTROL");
}

async function scrollSmoke() {
  let page = 0;
  const browser = {
    async evalValue(_tabId, expression) {
      if (expression.includes("isRiskPage:")) return { isRiskPage: false, isLoginPage: false, isSearchPage: true };
      if (!expression.includes("__bossExtractCards")) return true;
      const total = Math.min(35, 10 + page * 10);
      return Array.from({ length: total }, (_, index) => card(`scroll-${index}`));
    }
  };
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {} });
  adapter.assertSearchPage = async () => ({ isSearchPage: true });
  adapter.scrollList = async () => {
    page += 1;
    return { moved: true, atBottom: page >= 3, scrollTop: page * 700 };
  };
  const result = await adapter.collectCards("tab", 35);
  assert.strictEqual(result.cards.length, 35);
  assert.strictEqual(result.status, "completed");
  assert.strictEqual(result.stopReason, "card_limit_reached");
  assert.strictEqual(page, 3);
}

async function cardGrowthCheckpointSmoke() {
  async function collect(onCards = null) {
    let visible = 2;
    const counts = { evalValue: 0, scrollList: 0, searchChecks: 0, waits: 0 };
    const browser = {
      async evalValue(_tabId, expression) {
        counts.evalValue += 1;
        if (!expression.includes("__bossExtractCards")) return true;
        return Array.from({ length: visible }, (_, index) => card(`progress-${index + 1}`));
      }
    };
    const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {} });
    adapter.assertSearchPage = async () => { counts.searchChecks += 1; return { isSearchPage: true }; };
    adapter.scrollList = async () => {
      counts.scrollList += 1;
      visible = 4;
      return { moved: true, atBottom: false, scrollTop: 700 };
    };
    adapter.waitWithPacing = async () => { counts.waits += 1; };
    const result = await adapter.collectCards("tab", 4, null, null, onCards);
    return { result, counts };
  }

  const batches = [];
  const withCheckpoint = await collect(async ({ cards, total }) => {
    batches.push({ ids: cards.map((entry) => entry.title), total });
  });
  const withoutCheckpoint = await collect();
  assert.deepStrictEqual(batches, [
    { ids: ["progress-1", "progress-2"], total: 2 },
    { ids: ["progress-3", "progress-4"], total: 4 }
  ]);
  assert.strictEqual(withCheckpoint.result.cards.length, 4);
  assert.deepStrictEqual(withCheckpoint.counts, withoutCheckpoint.counts,
    "card checkpoints must not add evaluation, scrolling, search checks, or waits");
}

async function scanProgressEventOrderSmoke() {
  const browser = {
    async activeTabId() { return activeBoss.id; },
    async navigate() {}
  };
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {} });
  adapter.assertSearchPage = async () => ({ isSearchPage: true });
  const cards = [card("event-1"), card("event-2")];
  adapter.collectCards = async (_tabId, _maxCards, _signal, _assertBindings, onCards) => {
    await onCards?.({ cards, total: cards.length });
    return cards;
  };
  adapter.readVisiblePaneDetail = async (_tabId, job) => ({
    description: `完整职位描述 ${job.title} Python RAG `.repeat(12),
    bossActiveText: "今日活跃"
  });
  const events = [];
  await adapter.scanBrowser({
    tabId: activeBoss.id,
    keywords: ["RAG"],
    cityScopes: [{ city: "广州", cityCode: "101280100" }],
    maxCards: 2,
    maxDetailTotal: 2,
    onProgressCheckpoint: async (event) => events.push(event)
  });
  assert.deepStrictEqual(events.map((event) => [
    event.activity,
    event.targetPosition,
    event.detailPosition,
    event.detailTotal,
    event.jobs.length
  ]), [
    ["searching", 1, 0, 0, 0],
    ["searching", 1, 0, 0, 2],
    ["reading_detail", 1, 1, 2, 0],
    ["reading_detail", 1, 2, 2, 0]
  ]);
}

async function delayedAppendAtBottomSmoke() {
  let reads = 0;
  let scrolls = 0;
  const browser = {
    async evalValue(_tabId, expression) {
      if (expression.includes("isRiskPage:")) return { isRiskPage: false, isLoginPage: false, isSearchPage: true };
      if (!expression.includes("__bossExtractCards")) return true;
      reads += 1;
      const total = reads >= 8 ? 30 : 15;
      return Array.from({ length: total }, (_, index) => card(`lazy-${index}`));
    }
  };
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {}, randomFn: () => 0 });
  adapter.assertSearchPage = async () => ({ isSearchPage: true });
  adapter.scrollList = async () => {
    scrolls += 1;
    return { moved: true, atBottom: true, scrollTop: 1700, scrollHeight: 2400 };
  };
  const result = await adapter.collectCards("tab", 30);
  assert.strictEqual(result.cards.length, 30);
  assert.strictEqual(result.status, "completed");
  assert.strictEqual(result.stopReason, "card_limit_reached");
  assert(scrolls >= 1);
}

async function confirmedListEndSmoke() {
  const browser = {
    async evalValue(_tabId, expression) {
      if (expression.includes("isRiskPage:")) return { isRiskPage: false, isLoginPage: false, isSearchPage: true };
      if (!expression.includes("__bossExtractCards")) return true;
      return Array.from({ length: 15 }, (_, index) => card(`end-${index}`));
    }
  };
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {}, randomFn: () => 0 });
  adapter.assertSearchPage = async () => ({ isSearchPage: true });
  adapter.scrollList = async () => ({ moved: false, atBottom: true, scrollTop: 1700, scrollHeight: 2400 });
  const result = await adapter.collectCards("tab", 30);
  assert.strictEqual(result.cards.length, 15);
  assert.strictEqual(result.status, "completed");
  assert.strictEqual(result.stopReason, "confirmed_end");
  assert.strictEqual(result.quietWindows, 2);
}

async function scrollSafetyLimitSmoke() {
  const browser = {
    async evalValue(_tabId, expression) {
      if (expression.includes("isRiskPage:")) return { isRiskPage: false, isLoginPage: false, isSearchPage: true };
      if (!expression.includes("__bossExtractCards")) return true;
      return Array.from({ length: 15 }, (_, index) => card(`limit-${index}`));
    }
  };
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {}, randomFn: () => 0 });
  adapter.assertSearchPage = async () => ({ isSearchPage: true });
  adapter.scrollList = async () => ({ moved: true, atBottom: false, scrollTop: 600, scrollHeight: 9000 });
  const result = await adapter.collectCards("tab", 30);
  assert.strictEqual(result.cards.length, 15);
  assert.strictEqual(result.status, "partial");
  assert.strictEqual(result.stopReason, "scroll_safety_limit");
}

async function maxCardScrollBudgetSmoke() {
  const maxCards = PRODUCT_POLICY.searchPlan.scanBounds.maxCards[1];
  let visibleCards = 1;
  const browser = {
    async evalValue(_tabId, expression) {
      if (!expression.includes("__bossExtractCards")) return true;
      return Array.from({ length: visibleCards }, (_, index) => card(`max-${index}`));
    }
  };
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {}, randomFn: () => 0 });
  adapter.assertSearchPage = async () => ({ isSearchPage: true });
  adapter.scrollList = async () => {
    visibleCards = Math.min(maxCards, visibleCards + 1);
    return { moved: true, atBottom: false, scrollTop: visibleCards * 600 };
  };
  const result = await adapter.collectCards("tab", maxCards);
  assert.strictEqual(result.cards.length, maxCards);
  assert.strictEqual(result.stopReason, "card_limit_reached");
  assert.strictEqual(result.scrollRounds, maxCards - 1);
}

async function delayedListSmoke() {
  let reads = 0;
  let scrolls = 0;
  const browser = {
    async evalValue(_tabId, expression) {
      if (!expression.includes("__bossExtractCards")) return true;
      reads += 1;
      return reads < 4 ? [] : [card("delayed")];
    }
  };
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {}, randomFn: () => 0 });
  adapter.assertSearchPage = async () => ({ isSearchPage: true });
  adapter.scrollList = async () => {
    scrolls += 1;
    return { moved: false, atBottom: true };
  };
  const result = await adapter.collectCards("tab", 1);
  assert.strictEqual(result.cards.length, 1);
  assert.strictEqual(scrolls, 0);
  assert(reads >= 4);
}

async function accessReservationSmoke() {
  const accessActions = [];
  const browser = {
    async navigate() {},
    async evalValue(_tabId, expression) {
      if (expression.includes("isRiskPage:")) return { isRiskPage: false, isLoginPage: false, isSearchPage: true };
      if (expression.includes("window.__bossScrollList()")) return { moved: true, atBottom: false };
      return true;
    }
  };
  const adapter = new BossSiteAdapter({
    browser,
    sleepFn: async () => {},
    randomFn: () => 0,
    accessController: { reserve: async (action, details) => accessActions.push({ action, details }) }
  });
  await adapter.navigateWithPacing("tab", "https://www.zhipin.com/web/geek/jobs?query=RAG", "list");
  await adapter.navigateWithPacing("tab", "https://www.zhipin.com/job_detail/detail-job.html", "detail");
  await adapter.scrollList("tab");
  assert.deepStrictEqual(accessActions.map((item) => item.action), ["list_navigation", "detail_open", "list_scroll"]);
  assert.deepStrictEqual(accessActions[0].details, { kind: "list" });
  assert.deepStrictEqual(accessActions[1].details, { jobId: "detail-job" });
}

function pageHelperCardActivationPointSmoke() {
  const visible = runCardActivationPointFixture();
  assert.deepStrictEqual({ ...visible.result }, {
    ready: true,
    jobId: "target-job",
    x: 130,
    y: 220,
    reason: ""
  });
  assert.deepStrictEqual(visible.events, ["scroll", "rect", "hit"]);

  for (const [label, options, reason] of [
    ["interactive hit", { hit: "interactive-self" }, "interactive_hit"],
    ["interactive descendant", { hit: "interactive" }, "interactive_hit"],
    ["overlay", { hit: "overlay" }, "point_obscured"],
    ["no hit", { hit: "none" }, "point_unavailable"],
    ["right boundary", { rect: { left: 290, top: 100, width: 20, height: 40 } }, "point_out_of_viewport"],
    ["bottom boundary", { rect: { left: 100, top: 280, width: 40, height: 40 } }, "point_out_of_viewport"]
  ]) {
    const observation = runCardActivationPointFixture(options);
    assert.strictEqual(observation.result.ready, false, `${label} must fail closed`);
    assert.strictEqual(observation.result.jobId, "target-job", `${label} must preserve only the checked job id`);
    assert.strictEqual(observation.result.reason, reason);
  }
  const componentMismatch = runCardActivationPointFixture({ componentJobId: "other-job" }).result;
  assert.deepStrictEqual({ ...componentMismatch }, {
    ready: false,
    jobId: "other-job",
    x: 0,
    y: 0,
    reason: "component_job_mismatch"
  });
}

async function visiblePaneIdentitySmoke() {
  const accessActions = [];
  let paneReads = 0;
  const browser = {
    async evalValue(_tabId, expression) {
      if (expression.includes("isRiskPage:")) {
        return { isRiskPage: false, isLoginPage: false, isSearchPage: true };
      }
      if (expression.includes("window.__bossPaneState()")) {
        paneReads += 1;
        return {
          activeJobId: "pane-job",
          componentCurrentJobId: "pane-job",
          paneJobId: "pane-job",
          currentJobId: "pane-job",
          jobDetailLoading: null,
          title: "AI application developer",
          description: "Complete Python RAG Agent job description ".repeat(12),
          bossActiveText: "浠婃棩娲昏穬",
          salary: "10-15K",
          experience: "1-3 years",
          education: "Bachelor",
          canScroll: false
        };
      }
      return true;
    }
  };
  const adapter = new BossSiteAdapter({
    browser,
    sleepFn: async () => {},
    randomFn: () => 0,
    accessController: {
      reserve: async (action, details) => accessActions.push({ action, details })
    }
  });
  const detail = await adapter.readVisiblePaneDetail("pane-tab", {
    title: "AI application developer",
    url: "https://www.zhipin.com/job_detail/pane-job.html"
  });
  assert(detail.description.length >= 120);
  assert.strictEqual(paneReads, 1);
  assert.deepStrictEqual(accessActions.map((item) => item.action), ["pane_detail_read"]);
  assert.deepStrictEqual(accessActions[0].details, { jobId: "pane-job" });
}

async function visiblePaneActivationWaitSmoke() {
  let paneReads = 0;
  let locates = 0;
  let clicks = 0;
  let fronts = 0;
  const focusStates = [];
  let navigations = 0;
  const accessActions = [];
  const browser = {
    async navigate() { navigations += 1; },
    async bringToFront() { fronts += 1; },
    async cdp(_tabId, method, params) {
      assert.strictEqual(method, "Emulation.setFocusEmulationEnabled");
      focusStates.push(params.enabled);
    },
    async clickAt() { clicks += 1; },
    async evalValue(_tabId, expression) {
      if (expression.includes("isRiskPage:")) {
        return { isRiskPage: false, isLoginPage: false, isSearchPage: true };
      }
      if (expression.includes("(() => window.__bossCardActivationPoint(")) {
        locates += 1;
        return { ready: true, jobId: "slow-pane-job", x: 360, y: 480, reason: "" };
      }
      if (expression.includes("window.__bossPaneState()")) {
        paneReads += 1;
        if (paneReads <= 12) {
          return {
            activeJobId: paneReads === 1 ? "old-job" : "slow-pane-job",
            componentCurrentJobId: paneReads === 1 ? "old-job" : "slow-pane-job",
            paneJobId: "old-job",
            currentJobId: "old-job",
            jobDetailLoading: paneReads > 1,
            title: "Old job",
            description: "Old detail",
            canScroll: false
          };
        }
        return {
          activeJobId: "slow-pane-job",
          componentCurrentJobId: "slow-pane-job",
          paneJobId: "slow-pane-job",
          currentJobId: "slow-pane-job",
          jobDetailLoading: false,
          title: "Slow pane job",
          description: "Complete Python RAG Agent job description ".repeat(12),
          canScroll: false
        };
      }
      return true;
    }
  };
  const adapter = new BossSiteAdapter({
    browser,
    sleepFn: async () => {},
    randomFn: () => 0,
    accessController: {
      reserve: async (action, details) => accessActions.push({ action, details })
    }
  });
  const detail = await adapter.readVisiblePaneDetail("pane-tab", {
    title: "Slow pane job",
    url: "https://www.zhipin.com/job_detail/slow-pane-job.html"
  });
  assert(detail.description.length >= 120);
  assert(paneReads > 8, "must survive the old eight-poll timeout");
  assert.strictEqual(locates, 1);
  assert.strictEqual(clicks, 1);
  assert.strictEqual(fronts, 0);
  assert.deepStrictEqual(focusStates, [true, false]);
  assert.strictEqual(navigations, 0);
  assert.deepStrictEqual(accessActions, [{
    action: "pane_detail_read",
    details: { jobId: "slow-pane-job" }
  }]);
}

async function visiblePaneTrustedClickOrderSmoke() {
  const events = [];
  let navigations = 0;
  let paneReads = 0;
  const browser = {
    async navigate() { navigations += 1; },
    async bringToFront(tabId) {
      events.push({ type: "bring_to_front", tabId });
    },
    async cdp(tabId, method, params) {
      assert.strictEqual(method, "Emulation.setFocusEmulationEnabled");
      events.push({ type: params.enabled ? "focus_enabled" : "focus_disabled", tabId });
    },
    async clickAt(tabId, point) { events.push({ type: "click_at", tabId, point }); },
    async evalValue(_tabId, expression) {
      if (expression.includes("isRiskPage:")) {
        return { isRiskPage: false, isLoginPage: false, isSearchPage: true };
      }
      if (expression.includes("(() => window.__bossCardActivationPoint(")) {
        events.push({ type: "locate" });
        return { ready: true, jobId: "click-job", x: 123, y: 456, reason: "" };
      }
      if (expression.includes("window.__bossPaneState()")) {
        paneReads += 1;
        events.push({ type: "pane_state" });
        if (paneReads === 1) {
          return {
            activeJobId: "old-job",
            componentCurrentJobId: "old-job",
            paneJobId: "old-job",
            currentJobId: "old-job",
            title: "Old job",
            description: "Old detail",
            canScroll: false
          };
        }
        return {
          activeJobId: "click-job",
          componentCurrentJobId: "click-job",
          paneJobId: "click-job",
          currentJobId: "click-job",
          jobDetailLoading: false,
          title: "Click job",
          description: "Complete Python RAG Agent job description ".repeat(12),
          canScroll: false
        };
      }
      return true;
    }
  };
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {}, randomFn: () => 0 });
  adapter.assertSearchPage = async () => {
    events.push({ type: "assert_search" });
    return { isSearchPage: true };
  };
  const detail = await adapter.readVisiblePaneDetail("pane-tab", {
    title: "Click job",
    url: "https://www.zhipin.com/job_detail/click-job.html"
  }, null, async () => events.push({ type: "assert_bindings" }));
  assert(detail.description.length >= 120);
  assert.strictEqual(events.filter((event) => event.type === "bring_to_front").length, 0);
  const trustedClickStart = events.findIndex((event) => event.type === "focus_enabled");
  assert.deepStrictEqual(
    events.slice(trustedClickStart, trustedClickStart + 10).map((event) => event.type),
    ["focus_enabled", "assert_bindings", "assert_search", "locate", "assert_bindings", "assert_search", "click_at", "focus_disabled", "assert_bindings", "assert_search"]
  );
  assert.deepStrictEqual(
    events.filter((event) => ["locate", "click_at"].includes(event.type)).map((event) => event.type),
    ["locate", "click_at"]
  );
  assert.deepStrictEqual(
    events.find((event) => event.type === "click_at"),
    { type: "click_at", tabId: "pane-tab", point: { x: 123, y: 456 } }
  );
  assert.strictEqual(events.filter((event) => event.type === "click_at").length, 1);
  assert.strictEqual(navigations, 0);
}

async function visiblePaneLocateFailureNoClickSmoke() {
  const fixture = paneBrowserFixture({
    activation: { ready: false, jobId: "", x: 0, y: 0, reason: "card_not_found" }
  });
  const adapter = new BossSiteAdapter({ browser: fixture.browser, sleepFn: async () => {} });
  const detail = await adapter.readVisiblePaneDetail("pane-tab", {
    title: "Missing job",
    url: "https://www.zhipin.com/job_detail/missing-job.html"
  });
  assert.strictEqual(detail, null, "failed card location must fail closed");
  assert.strictEqual(fixture.count("locate"), 1);
  assert.strictEqual(fixture.count("click_at"), 0);
  assert.strictEqual(fixture.count("bring_to_front"), 0);
  assert.deepStrictEqual(fixture.focusStates(), [true, false]);
}

async function visiblePaneClickIdentityDriftSmoke() {
  const fixture = paneBrowserFixture({
    activation: { ready: true, jobId: "drift-job", x: 200, y: 300, reason: "" },
    states: (read) => read === 1 ? paneState("old-job", "Old job") : paneState("other-job", "Other job")
  });
  const adapter = new BossSiteAdapter({ browser: fixture.browser, sleepFn: async () => {} });
  const detail = await adapter.readVisiblePaneDetail("pane-tab", {
    title: "Drift job",
    url: "https://www.zhipin.com/job_detail/drift-job.html"
  });
  assert.strictEqual(detail, null, "identity drift after trusted click must not be adopted");
  assert.strictEqual(fixture.count("locate"), 1);
  assert.strictEqual(fixture.count("click_at"), 1);
  assert.strictEqual(fixture.count("bring_to_front"), 0);
  assert.deepStrictEqual(fixture.focusStates(), [true, false]);
  assert(fixture.paneReads() >= 2, "pane identity must be rechecked after the trusted click");
}

async function visiblePaneClickCapabilityFailClosedSmoke() {
  const noFocusEmulation = paneBrowserFixture({
    trustedFocus: false,
    activation: () => assert.fail("locator must not run without pane focus capability")
  });
  const adapterNoFocus = new BossSiteAdapter({ browser: noFocusEmulation.browser, sleepFn: async () => {} });
  assert.strictEqual(await adapterNoFocus.readVisiblePaneDetail("pane-tab", {
    title: "Cap job",
    url: "https://www.zhipin.com/job_detail/cap-job.html"
  }), null, "browser without pane focus support must fail closed");
  assert.strictEqual(noFocusEmulation.count("locate"), 0);
  assert.strictEqual(noFocusEmulation.count("click_at"), 0);

  const noClickAt = paneBrowserFixture({
    trustedClick: false,
    activation: () => assert.fail("locator must not run without trusted click capability")
  });
  const adapterNoClick = new BossSiteAdapter({ browser: noClickAt.browser, sleepFn: async () => {} });
  assert.strictEqual(await adapterNoClick.readVisiblePaneDetail("pane-tab", {
    title: "Cap job",
    url: "https://www.zhipin.com/job_detail/cap-job.html"
  }), null, "browser without trusted click support must fail closed");
  assert.deepStrictEqual(noClickAt.focusStates(), []);

  for (const [label, x, y] of [
    ["null", null, 100],
    ["numeric string", "100", 100],
    ["NaN", NaN, 100],
    ["Infinity", Infinity, 100],
    ["negative", -1, 100]
  ]) {
    const invalidPoint = paneBrowserFixture({
      activation: { ready: true, jobId: "cap-job", x, y, reason: "" }
    });
    const adapterInvalidPoint = new BossSiteAdapter({ browser: invalidPoint.browser, sleepFn: async () => {} });
    assert.strictEqual(await adapterInvalidPoint.readVisiblePaneDetail("pane-tab", {
      title: "Cap job",
      url: "https://www.zhipin.com/job_detail/cap-job.html"
    }), null, `${label} click coordinate must fail closed`);
    assert.strictEqual(invalidPoint.count("click_at"), 0, `${label} click coordinate must not reach clickAt`);
    assert.deepStrictEqual(invalidPoint.focusStates(), [true, false], `${label} click coordinate must restore focus emulation`);
  }
}

async function visiblePaneHalfSwitchOldDetailSmoke() {
  const fixture = paneBrowserFixture({
    activation: { ready: true, jobId: "half-job", x: 100, y: 100, reason: "" },
    states: (read) => read === 1
      ? paneState("old-job", "Old job", { description: "Old job description ".repeat(12) })
      : paneState("half-job", "Half job", {
        paneJobId: "",
        currentJobId: "half-job",
        jobDetailLoading: true,
        description: "Long stale description from the previous job ".repeat(12)
      })
  });
  const adapter = new BossSiteAdapter({ browser: fixture.browser, sleepFn: async () => {}, randomFn: () => 0 });
  const detail = await adapter.readVisiblePaneDetail("pane-tab", {
    title: "Half job",
    url: "https://www.zhipin.com/job_detail/half-job.html"
  });
  assert.strictEqual(detail, null, "half-switched pane must not adopt a long stale description");
  assert.strictEqual(fixture.count("click_at"), 1);
  assert(fixture.paneReads() > 1);
}

async function visiblePanePostClickLoadingSmoke() {
  for (const loading of [true, null, undefined]) {
    const fixture = paneBrowserFixture({
      activation: { ready: true, jobId: "loading-job", x: 100, y: 100, reason: "" },
      states: (read) => read === 1
        ? paneState("old-job", "Old job")
        : paneState("loading-job", "Loading job", { jobDetailLoading: loading })
    });
    const adapter = new BossSiteAdapter({ browser: fixture.browser, sleepFn: async () => {}, randomFn: () => 0 });
    const detail = await adapter.readVisiblePaneDetail("pane-tab", {
      title: "Loading job",
      url: "https://www.zhipin.com/job_detail/loading-job.html"
    });
    assert.strictEqual(detail, null, `post-click loading=${String(loading)} must not be adopted`);
  }
}

async function visiblePaneSelectionMismatchSmoke() {
  const browser = {
    async evalValue(_tabId, expression) {
      if (expression.includes("isRiskPage:")) {
        return { isRiskPage: false, isLoginPage: false, isSearchPage: true };
      }
      if (expression.includes("window.__bossPaneState()")) {
        return {
          activeJobId: "old-job",
          componentCurrentJobId: "old-job",
          paneJobId: "target-job",
          currentJobId: "target-job",
          jobDetailLoading: false,
          title: "Target job",
          description: "Complete Python RAG Agent job description ".repeat(12),
          canScroll: false
        };
      }
      return true;
    }
  };
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {} });
  const detail = await adapter.readVisiblePaneDetail("pane-tab", {
    title: "Target job",
    url: "https://www.zhipin.com/job_detail/target-job.html"
  });
  assert.strictEqual(detail, null, "stale card selection must not authorize a target pane");
}

async function visiblePaneMissingIdentitySmoke() {
  const fixture = paneBrowserFixture({
    activation: { ready: true, jobId: "pane-job", x: 100, y: 100, reason: "" },
    states: [paneState("pane-job", "pane-job", {
      componentCurrentJobId: "",
      paneJobId: "",
      currentJobId: "",
      jobDetailLoading: null
    })]
  });
  const adapter = new BossSiteAdapter({ browser: fixture.browser, sleepFn: async () => {}, randomFn: () => 0 });
  const detail = await adapter.readVisiblePaneDetail("pane-tab", {
    title: "pane-job",
    url: "https://www.zhipin.com/job_detail/pane-job.html"
  });
  assert.strictEqual(detail, null, "partial target identity must not authorize pane reuse");
  assert.strictEqual(fixture.count("click_at"), 0, "partial target identity must not authorize another click");
}

async function visiblePaneTitleIdentitySmoke() {
  const browser = {
    async evalValue(_tabId, expression) {
      if (expression.includes("isRiskPage:")) {
        return { isRiskPage: false, isLoginPage: false, isSearchPage: true };
      }
      if (expression.includes("window.__bossPaneState()")) {
        return {
          activeJobId: "title-job",
          componentCurrentJobId: "title-job",
          paneJobId: "title-job",
          currentJobId: "title-job",
          jobDetailLoading: null,
          title: "AI application developer - senior",
          description: "Complete Python RAG Agent job description ".repeat(12),
          canScroll: false
        };
      }
      return true;
    }
  };
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {}, randomFn: () => 0 });
  const url = "https://www.zhipin.com/job_detail/title-job.html";
  const normalized = await adapter.readVisiblePaneDetail("pane-tab", {
    title: "AI application developer",
    url
  });
  assert(normalized.description.length >= 120);
  const missing = await adapter.readVisiblePaneDetail("pane-tab", { url });
  assert.strictEqual(missing, null, "missing expected title must fail closed");
  const empty = await adapter.readVisiblePaneDetail("pane-tab", { title: "   ", url });
  assert.strictEqual(empty, null, "empty expected title must fail closed");
}

async function standaloneDetailTimeoutSmoke() {
  const navigations = [];
  const browser = {
    async navigate(_tabId, url) { navigations.push(url); },
    async evalValue(_tabId, expression) {
      if (expression.includes("const currentJobId")) {
        return {
          currentJobId: "strict-timeout",
          description: "short",
          bossActiveText: "",
          salary: "",
          experience: "",
          education: ""
        };
      }
      return true;
    }
  };
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {}, randomFn: () => 0 });
  adapter.assertDetailPage = async () => ({ jobId: "strict-timeout" });
  await assert.rejects(
    () => adapter.readDetail("detail-tab", "https://www.zhipin.com/job_detail/strict-timeout.html"),
    (error) => error.code === "BOSS_DETAIL_LOAD_TIMEOUT"
  );
  assert.deepStrictEqual(navigations, ["https://www.zhipin.com/job_detail/strict-timeout.html"]);
  await assert.rejects(
    () => adapter.readDetail("detail-tab", "https://example.invalid/job_detail/external.html"),
    (error) => error.code === "BOSS_DETAIL_URL_INVALID"
  );
  await assert.rejects(
    () => adapter.readDetail("detail-tab", "http://www.zhipin.com/job_detail/insecure.html"),
    (error) => error.code === "BOSS_DETAIL_URL_INVALID"
  );
  assert.deepStrictEqual(
    navigations,
    ["https://www.zhipin.com/job_detail/strict-timeout.html"],
    "an external host must be rejected before browser navigation"
  );
}

async function searchPaneDetailRoutingSmoke() {
  const events = [];
  const outcomes = [];
  let visiblePaneReads = 0;
  const browser = {
    async navigate(tabId, url) { events.push({ type: "list", tabId, url }); }
  };
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {}, randomFn: () => 0 });
  adapter.assertSearchPage = async () => ({ isSearchPage: true });
  adapter.collectCards = async () => [card("direct-1"), card("direct-2")];
  adapter.readVisiblePaneDetail = async (tabId, job) => {
    visiblePaneReads += 1;
    events.push({ type: "visible_pane", tabId, url: job.url });
    return {
      description: `Complete pane detail ${job.url} `.repeat(12),
      bossActiveText: "active",
      salary: "10-15K",
      experience: "1-3 years",
      education: "bachelor"
    };
  };
  adapter.readDetail = async () => {
    throw new Error("normal scan must not open standalone detail");
  };
  const jobs = await adapter.scanBrowser({
    tabId: activeBoss.id,
    keywords: ["direct"],
    cityScopes: [{ city: "Guangzhou", cityCode: "101280100" }],
    maxCards: 20,
    maxDetailTotal: 2,
    onDetailResult: async (result) => outcomes.push(result)
  });
  assert.strictEqual(visiblePaneReads, 2);
  assert.strictEqual(events.filter((event) => event.type === "list").length, 1);
  assert.deepStrictEqual(events.map((event) => event.type), ["list", "visible_pane", "visible_pane"]);
  assert(events.every((event) => event.tabId === activeBoss.id));
  assert.strictEqual(jobs.filter((job) => job.detailRead).length, 2);
  assert.deepStrictEqual(outcomes, [
    { outcome: "succeeded", errorCode: "", accessMode: "visible_pane" },
    { outcome: "succeeded", errorCode: "", accessMode: "visible_pane" }
  ]);
}

async function searchPageApiDetailStateMachineSmoke() {
  const privateSentinel = "private-security-and-response";
  const sent = [];
  const fixture = apiDetailPageFixture({
    onXhrSend: (xhr) => sent.push(xhr)
  });
  const { window } = fixture;

  const first = window.__bossStartDetailFetch("api-job");
  const duplicate = window.__bossStartDetailFetch("api-job");
  const busy = window.__bossStartDetailFetch("other-job");
  assert.strictEqual(first.state, "running");
  assert.strictEqual(duplicate.state, "running", "same job must reuse its running state");
  assert.strictEqual(busy.errorCode, "BOSS_DETAIL_API_BUSY", "different jobs must fail closed while one fetch runs");
  assert.strictEqual(sent.length, 1, "only one XHR request may start for a job");
  assert.strictEqual(sent[0].method, "GET");
  assert(sent[0].url.includes("detail.json"));
  assert(sent[0].url.includes("securityId=fixture-security"));
  assert.strictEqual(sent[0].withCredentials, true, "XHR must carry same-origin cookies");
  assert.strictEqual(sent[0].headers.Accept, "application/json, text/plain, */*");
  assert.strictEqual(sent[0].timeout, 20000, "page XHR timeout must allow for previously observed slow BOSS responses");
  assert(!JSON.stringify(first).includes(privateSentinel));

  sent[0].respond(200, {
      code: 0,
      zpData: { jobInfo: {
        encryptId: "api-job",
        postDescription: "Complete API job description Python RAG ".repeat(12),
        salaryDesc: "20-30K",
        experienceName: "3-5 years",
        degreeName: "bachelor",
        activeTimeDesc: "active"
      }, privateSentinel }
  });
  const succeeded = await waitForDetailFetchState(window, "api-job");
  assert.strictEqual(succeeded.state, "succeeded");
  assert.strictEqual(succeeded.result.jobId, "api-job");
  assert(succeeded.result.description.length >= 120);
  assert(!JSON.stringify(succeeded).includes("fixture-security"));
  assert(!JSON.stringify(succeeded).includes(privateSentinel));
  const consumed = window.__bossConsumeDetailFetch("api-job");
  assert.strictEqual(consumed.state, "succeeded");
  assert.strictEqual(window.__bossDetailFetchState("api-job").state, "idle");
  const repeatAfterConsume = window.__bossStartDetailFetch("api-job");
  assert.strictEqual(repeatAfterConsume.errorCode, "BOSS_DETAIL_API_REPEAT_REQUEST");
  assert.strictEqual(sent.length, 1, "consumed jobs must never issue a second GET");
  fixture.reinject();
  const repeatAfterHelperReinject = window.__bossStartDetailFetch("api-job");
  assert.strictEqual(repeatAfterHelperReinject.errorCode, "BOSS_DETAIL_API_REPEAT_REQUEST");
  assert.strictEqual(sent.length, 1, "helper reinjection must retain the page-lifetime repeat guard");

  const nextScanSession = window.__bossStartDetailFetch("scan-session-2", "api-job");
  assert.strictEqual(nextScanSession.state, "running", "a new scan session may read the same job once");
  assert.strictEqual(sent.length, 2, "the repeat guard must be scoped to one scan session");
  sent[1].respond(200, {
    code: 0,
    zpData: { jobInfo: {
      encryptId: "api-job",
      postDescription: "Complete second-session job description Python RAG ".repeat(12)
    } }
  });
  assert.strictEqual((await waitForDetailFetchState(window, "scan-session-2", "api-job")).state, "succeeded");
  window.__bossConsumeDetailFetch("scan-session-2", "api-job");

  const second = window.__bossStartDetailFetch("abort-job");
  assert.strictEqual(second.state, "running");
  assert.strictEqual(sent.length, 3);
  assert.strictEqual(window.__bossCancelDetailFetch("abort-job").state, "idle");
  assert.strictEqual(sent[2].aborted, true, "cancelling must abort and clear the running XHR");
  assert.strictEqual(window.__bossDetailFetchState("abort-job").state, "idle");
  const repeatAfterCancel = window.__bossStartDetailFetch("abort-job");
  assert.strictEqual(repeatAfterCancel.errorCode, "BOSS_DETAIL_API_REPEAT_REQUEST");
  assert.strictEqual(sent.length, 3, "cancelled jobs must never issue a second GET");

  for (const { name, response, status, errorCode, event } of [
    { name: "unauthorized", response: {}, status: 401, errorCode: "BOSS_LOGIN_REQUIRED" },
    { name: "forbidden", response: {}, status: 403, errorCode: "BOSS_RISK_CONTROL" },
    { name: "http", response: {}, status: 500, errorCode: "BOSS_DETAIL_API_HTTP_FAILED" },
    { name: "business", response: { code: 1, zpData: { jobInfo: {} } }, status: 200, errorCode: "BOSS_DETAIL_API_RESPONSE_INVALID" },
    { name: "id", response: { code: 0, zpData: { jobInfo: { encryptId: "wrong", postDescription: "Complete detail ".repeat(12) } } }, status: 200, errorCode: "BOSS_DETAIL_API_ID_MISMATCH" },
    { name: "description", response: { code: 0, zpData: { jobInfo: { encryptId: "api-job", postDescription: "short" } } }, status: 200, errorCode: "BOSS_DETAIL_API_DESCRIPTION_INCOMPLETE" },
    { name: "timeout", event: "timeout", errorCode: "BOSS_DETAIL_API_TIMEOUT" },
    { name: "network", event: "error", errorCode: "BOSS_DETAIL_API_HTTP_FAILED" },
    { name: "aborted", event: "abort", errorCode: "BOSS_DETAIL_API_RESPONSE_INVALID" }
  ]) {
    let sentXhr = null;
    const errorFixture = apiDetailPageFixture({
      onXhrSend: (xhr) => { sentXhr = xhr; }
    });
    const start = errorFixture.window.__bossStartDetailFetch("api-job");
    assert.strictEqual(start.state, "running", `${name} fixture must start one request`);
    if (event) sentXhr.trigger(event);
    else sentXhr.respond(status, response);
    const failed = await waitForDetailFetchState(errorFixture.window, "api-job");
    assert.deepStrictEqual({ ...failed }, { state: "failed", jobId: "api-job", errorCode });
    assert(!JSON.stringify(failed).includes(privateSentinel), `${name} error must be sanitized`);
  }
}

async function searchPageApiDetailRoutingSmoke() {
  const events = [];
  const outcomes = [];
  const browser = {
    async navigate(tabId, url) { events.push({ type: "list", tabId, url }); },
    async cdp(tabId, method, params) { events.push({ type: "cdp", tabId, method, params }); },
    async evalValue(tabId, expression) {
      events.push({ type: "eval", tabId, expression });
      if (expression.includes("__bossStartDetailFetch")) return { state: "running", jobId: "api-route" };
      if (expression.includes("__bossDetailFetchState")) return { state: "succeeded" };
      if (expression.includes("__bossConsumeDetailFetch")) {
        return {
          state: "succeeded",
          result: {
            jobId: "api-route",
            description: "Complete API routed description Python RAG ".repeat(12),
            salary: "20-30K",
            experience: "3-5 years",
            education: "bachelor",
            bossActiveText: "active"
          }
        };
      }
      return true;
    },
    async bringToFront() { throw new Error("API detail mode must not activate the pane"); },
    async clickAt() { throw new Error("API detail mode must not click the pane"); }
  };
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {}, randomFn: () => 0 });
  adapter.assertSearchPage = async () => ({ isSearchPage: true });
  adapter.collectCards = async () => [card("api-route")];
  adapter.readVisiblePaneDetail = async () => {
    throw new Error("API detail mode must not fall back to readVisiblePaneDetail");
  };
  const jobs = await adapter.scanBrowser({
    tabId: activeBoss.id,
    keywords: ["api-route"],
    cityScopes: [{ city: "Guangzhou", cityCode: "101280100" }],
    maxCards: 20,
    maxDetailTotal: 1,
    detailMode: "search_page_api",
    onDetailResult: async (result) => outcomes.push(result)
  });
  assert.strictEqual(jobs[0].detailRead, true);
  assert.deepStrictEqual(outcomes, [{ outcome: "succeeded", errorCode: "", accessMode: "search_page_api" }]);
  assert.strictEqual(events.filter((event) => event.type === "list").length, 1);
  assert.deepStrictEqual(
    events.filter((event) => event.type === "cdp"),
    [{ type: "cdp", tabId: activeBoss.id, method: "Page.setWebLifecycleState", params: { state: "active" } }],
    "API detail mode must wake the hidden search page without bringing it to the foreground"
  );
  assert(!events.some((event) => /bringToFront|clickAt/.test(event.expression || "")));

  let visibleFallbacks = 0;
  const failedApi = new BossSiteAdapter({ browser: { async navigate() {} }, sleepFn: async () => {}, randomFn: () => 0 });
  failedApi.assertSearchPage = async () => ({ isSearchPage: true });
  failedApi.collectCards = async () => [card("api-failure")];
  failedApi.readSearchPageApiDetail = async () => {
    throw Object.assign(new Error("API detail failed"), { code: "BOSS_DETAIL_API_RESPONSE_INVALID" });
  };
  failedApi.readVisiblePaneDetail = async () => { visibleFallbacks += 1; };
  const failedJobs = await failedApi.scanBrowser({
    tabId: "api-failure-tab",
    keywords: ["api-failure"],
    cityScopes: [{ city: "Guangzhou", cityCode: "101280100" }],
    maxCards: 20,
    maxDetailTotal: 1,
    detailMode: "search_page_api"
  });
  assert.strictEqual(failedJobs[0].detailErrorCode, "BOSS_DETAIL_API_RESPONSE_INVALID");
  assert.strictEqual(visibleFallbacks, 0, "a failed API detail read must never fall back to the visible pane");

  let invalidModePaneReads = 0;
  const invalidMode = new BossSiteAdapter({ browser: { async navigate() {} }, sleepFn: async () => {}, randomFn: () => 0 });
  invalidMode.assertSearchPage = async () => ({ isSearchPage: true });
  invalidMode.collectCards = async () => [card("invalid-mode")];
  invalidMode.readVisiblePaneDetail = async () => {
    invalidModePaneReads += 1;
    return { description: "This must never be read through an implicit fallback. ".repeat(5) };
  };
  await assert.rejects(() => invalidMode.scanBrowser({
    tabId: "invalid-mode-tab",
    keywords: ["invalid-mode"],
    cityScopes: [{ city: "Guangzhou", cityCode: "101280100" }],
    maxCards: 20,
    maxDetailTotal: 1,
    detailMode: "search_page_ap1"
  }), (error) => error.code === "BOSS_DETAIL_MODE_INVALID");
  assert.strictEqual(invalidModePaneReads, 0, "an invalid detail mode must not fall back to the trusted pane");

  let repeatReservations = 0;
  const repeatAdapter = new BossSiteAdapter({
    browser: {
      async evalValue(_tabId, expression) {
        if (expression.includes("__bossCanStartDetailFetch")) {
          return { state: "failed", jobId: "repeat-route", errorCode: "BOSS_DETAIL_API_REPEAT_REQUEST" };
        }
        if (expression.includes("__bossStartDetailFetch")) {
          return { state: "failed", jobId: "repeat-route", errorCode: "BOSS_DETAIL_API_REPEAT_REQUEST" };
        }
        return true;
      }
    },
    sleepFn: async () => {},
    accessController: { reserve: async () => { repeatReservations += 1; } }
  });
  repeatAdapter.assertSearchPage = async () => ({ isSearchPage: true });
  await assert.rejects(
    () => repeatAdapter.readSearchPageApiDetail("repeat-tab", card("repeat-route")),
    (error) => error.code === "BOSS_DETAIL_API_REPEAT_REQUEST"
  );
  assert.strictEqual(repeatReservations, 0, "a repeated API detail request must not consume another access reservation");

  const order = [];
  let startIssued = false;
  const reservationFirst = new BossSiteAdapter({
    browser: {
      async cdp(_tabId, method, params) {
        assert.strictEqual(method, "Page.setWebLifecycleState");
        assert.deepStrictEqual(params, { state: "active" });
        order.push("wake");
      },
      async evalValue(_tabId, expression) {
        if (expression.includes("__bossCanStartDetailFetch")) return { state: "idle", jobId: "order-route" };
        if (expression.includes("__bossDetailFetchState")) return startIssued ? { state: "succeeded" } : { state: "idle" };
        if (expression.includes("__bossStartDetailFetch")) {
          startIssued = true;
          order.push("start");
          return { state: "running", jobId: "order-route" };
        }
        if (expression.includes("__bossConsumeDetailFetch")) {
          return { state: "succeeded", result: { jobId: "order-route", description: "Complete ordered API detail ".repeat(12) } };
        }
        return true;
      }
    },
    sleepFn: async () => {},
    accessController: { reserve: async () => order.push("reserve") }
  });
  reservationFirst.assertSearchPage = async () => ({ isSearchPage: true });
  await reservationFirst.readSearchPageApiDetail("order-tab", card("order-route"));
  assert.deepStrictEqual(order, ["reserve", "wake", "start"], "the access reservation and hidden-page wake must complete before a first API GET can start");

  let reservationCompleted = false;
  let startAfterReservationDrift = 0;
  const postReservationDrift = new BossSiteAdapter({
    browser: {
      async evalValue(_tabId, expression) {
        if (expression.includes("__bossCanStartDetailFetch")) return { state: "idle", jobId: "drift-route" };
        if (expression.includes("__bossStartDetailFetch")) {
          startAfterReservationDrift += 1;
          return { state: "running", jobId: "drift-route" };
        }
        return true;
      }
    },
    sleepFn: async () => {},
    accessController: { reserve: async () => { reservationCompleted = true; } }
  });
  postReservationDrift.assertSearchPage = async () => {
    if (reservationCompleted) throw Object.assign(new Error("page changed during budget wait"), { code: "BOSS_SEARCH_PAGE_LOST" });
    return { isSearchPage: true };
  };
  await assert.rejects(
    () => postReservationDrift.readSearchPageApiDetail("drift-tab", card("drift-route")),
    (error) => error.code === "BOSS_SEARCH_PAGE_LOST"
  );
  assert.strictEqual(startAfterReservationDrift, 0, "page identity must be rechecked after budget reservation and before GET");
}

async function searchPageApiDetailAbortCleanupSmoke() {
  const controller = new AbortController();
  let cancelled = 0;
  const browser = {
    async cdp() {},
    async evalValue(_tabId, expression) {
      if (expression.includes("__bossStartDetailFetch")) return { state: "running", jobId: "abort-route" };
      if (expression.includes("__bossDetailFetchState")) {
        controller.abort(Object.assign(new Error("stop scan"), { code: "SCAN_ABORTED" }));
        return { state: "running", jobId: "abort-route" };
      }
      if (expression.includes("__bossCancelDetailFetch")) {
        cancelled += 1;
        return { state: "idle", jobId: "" };
      }
      return true;
    }
  };
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {}, randomFn: () => 0 });
  adapter.assertSearchPage = async () => ({ isSearchPage: true });
  await assert.rejects(
    () => adapter.readSearchPageApiDetail("abort-tab", card("abort-route"), controller.signal),
    (error) => error.code === "SCAN_ABORTED"
  );
  assert.strictEqual(cancelled, 1, "aborting the scan must cancel the page-local fetch exactly once");
}

async function searchPageApiDetailFatalAndCleanupSmoke() {
  for (const code of ["BOSS_LOGIN_REQUIRED", "BOSS_RISK_CONTROL"]) {
    let reads = 0;
    const outcomes = [];
    const audits = [];
    const privateSentinel = `private-${code}`;
    const adapter = new BossSiteAdapter({
      browser: { async navigate() {} },
      sleepFn: async () => {},
      randomFn: () => 0,
      logger: { info: () => {}, warn: (event, details) => audits.push({ event, details }) }
    });
    adapter.assertSearchPage = async () => ({ isSearchPage: true });
    adapter.collectCards = async () => [card(`fatal-${code}-1`), card(`fatal-${code}-2`)];
    adapter.readSearchPageApiDetail = async () => {
      reads += 1;
      throw Object.assign(new Error(privateSentinel), { code });
    };
    await assert.rejects(() => adapter.scanBrowser({
      tabId: "fatal-api-tab",
      keywords: ["fatal-api"],
      cityScopes: [{ city: "Guangzhou", cityCode: "101280100" }],
      maxCards: 20,
      maxDetailTotal: 2,
      detailMode: "search_page_api",
      onDetailResult: async (outcome) => outcomes.push(outcome)
    }), (error) => error.code === code);
    assert.strictEqual(reads, 1, `${code} must stop the scan after the first detail`);
    assert.deepStrictEqual(outcomes, [{ outcome: "failed", errorCode: code, accessMode: "search_page_api" }]);
    assert(!JSON.stringify(outcomes).includes(privateSentinel), `${code} callback must not receive sensitive error text`);
    assert(!JSON.stringify(audits).includes(privateSentinel), `${code} audit input must not receive sensitive error text`);
  }

  for (const boundary of ["timeout", "page_loss", "tab_drift"]) {
    let cancellations = 0;
    let searchChecks = 0;
    let bindingChecks = 0;
    const browser = {
      async cdp() {},
      async evalValue(_tabId, expression) {
        if (expression.includes("__bossStartDetailFetch")) return { state: "running", jobId: "cleanup-route" };
        if (expression.includes("__bossDetailFetchState")) return { state: "running", jobId: "cleanup-route" };
        if (expression.includes("__bossCancelDetailFetch")) {
          cancellations += 1;
          return { state: "idle", jobId: "" };
        }
        return true;
      }
    };
    const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {}, randomFn: () => 0 });
    adapter.assertSearchPage = async () => {
      searchChecks += 1;
      if (boundary === "page_loss" && searchChecks > 2) throw Object.assign(new Error("page lost"), { code: "BOSS_SEARCH_PAGE_LOST" });
      return { isSearchPage: true };
    };
    const assertTabBindings = async () => {
      bindingChecks += 1;
      if (boundary === "tab_drift" && bindingChecks > 4) throw Object.assign(new Error("tabs changed"), { code: "BOSS_OPERATOR_TABS_CHANGED" });
    };
    const expectedCode = boundary === "timeout" ? "BOSS_DETAIL_API_TIMEOUT" : boundary === "page_loss" ? "BOSS_SEARCH_PAGE_LOST" : "BOSS_OPERATOR_TABS_CHANGED";
    await assert.rejects(
      () => adapter.readSearchPageApiDetail("cleanup-tab", card("cleanup-route"), null, assertTabBindings),
      (error) => error.code === expectedCode
    );
    assert.strictEqual(cancellations, 1, `${boundary} must cancel the page-local request`);
  }
}

async function cardActivationPointUnavailableSmoke() {
  const fixture = paneBrowserFixture({
    activation: { ready: false, jobId: "", x: 0, y: 0, reason: "card_not_found" }
  });
  const adapter = new BossSiteAdapter({ browser: fixture.browser, sleepFn: async () => {} });
  const detail = await adapter.readVisiblePaneDetail("pane-tab", {
    title: "Target job",
    url: "https://www.zhipin.com/job_detail/target-job.html"
  });
  assert.strictEqual(detail, null);
  assert.strictEqual(fixture.count("locate"), 1);
  assert.strictEqual(fixture.count("click_at"), 0);
}

async function scanNullPaneOutcomeSmoke() {
  const browser = {
    async activeTabId() { return "scan-tab"; },
    async navigate() {}
  };
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {}, randomFn: () => 0 });
  adapter.assertSearchPage = async () => ({ isSearchPage: true });
  adapter.collectCards = async () => [card("pane-null")];
  adapter.readVisiblePaneDetail = async () => null;
  adapter.readDetail = async () => {
    throw new Error("normal scan must not open standalone detail");
  };
  const outcomes = [];
  const jobs = await adapter.scanBrowser({
    tabId: "scan-tab",
    keywords: ["pane-null"],
    cityScopes: [{ city: "广州", cityCode: "101280100" }],
    maxCards: 20,
    maxDetailTotal: 1,
    onDetailResult: async (outcome) => outcomes.push(outcome)
  });
  assert.strictEqual(jobs.length, 1);
  assert.strictEqual(jobs[0].detailRead, false);
  assert.strictEqual(jobs[0].detailErrorCode, "BOSS_PANE_SWITCH_TIMEOUT");
  assert.deepStrictEqual(outcomes, [{
    outcome: "failed",
    errorCode: "BOSS_PANE_SWITCH_TIMEOUT",
    accessMode: "visible_pane"
  }]);
}

async function targetIsolationSmoke() {
  const browser = {
    keyword: "",
    async activeTabId() { return activeBoss.id; },
    async navigate(_tabId, url) { this.keyword = new URL(url).searchParams.get("query"); }
  };
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {} });
  adapter.assertSearchPage = async () => ({ isSearchPage: true });
  adapter.collectCards = async () => {
    if (browser.keyword === "broken") throw Object.assign(new Error("white page"), { code: "BOSS_WHITE_PAGE" });
    return [card(browser.keyword)];
  };
  adapter.readVisiblePaneDetail = async (_tabId, job) => ({
    description: `完整职位描述 ${job.title} Python RAG `.repeat(12),
    bossActiveText: "今日活跃",
    salary: job.salary,
    experience: job.experience,
    education: job.education
  });
  const checkpoints = [];
  const jobs = await adapter.scanBrowser({
    tabId: activeBoss.id,
    keywords: ["first", "broken", "last"],
    keywordPlan: [
      { word: "first", priority: "A" },
      { word: "broken", priority: "A" },
      { word: "last", priority: "A" }
    ],
    cityScopes: [{ city: "广州", cityCode: "101280100" }],
    maxCards: 20,
    maxDetailTotal: 3,
    onTargetComplete: async (result) => checkpoints.push(result),
    scoreQuick: () => 1
  });
  assert.strictEqual(jobs.length, 2);
  assert.strictEqual(checkpoints.length, 3);
  assert.deepStrictEqual(checkpoints.map((item) => item.status), ["completed", "failed", "completed"]);
  assert(jobs.every((job) => job.detailRead));
  assert(jobs.every((job) => job.detailRequired));
}

async function scanTargetPlanSmoke() {
  const targets = buildBossScanTargets({
    keywords: ["secondary", "primary"],
    keywordPlan: [
      { word: "secondary", priority: "B", order: 0 },
      { word: "primary", priority: "A", order: 1 }
    ],
    cityScopes: [
      { city: "广州", cityCode: "101280100" },
      { city: "深圳", cityCode: "101280600" }
    ],
    nativeFilters: {
      lanes: [
        { id: "main", params: { experience: ["101", "104"] } },
        { id: "stretch", params: { experience: ["105"] } }
      ]
    },
    maxCards: 50
  });
  assert.deepStrictEqual(targets.map((target) => target.targetKey), [
    "101280100|primary|main",
    "101280100|secondary|main",
    "101280100|primary|stretch",
    "101280100|secondary|stretch",
    "101280600|primary|main",
    "101280600|secondary|main",
    "101280600|primary|stretch",
    "101280600|secondary|stretch"
  ]);
  assert.deepStrictEqual(targets.map((target) => target.cardLimit), [50, 33, 50, 33, 50, 33, 50, 33]);

  const dailyTargets = buildBossScanTargets({
    keywords: ["secondary", "primary"],
    keywordPlan: [
      { word: "secondary", priority: "B", order: 0 },
      { word: "primary", priority: "A", order: 1 }
    ],
    cityScopes: [{ city: "广州", cityCode: "101280100" }],
    nativeFilters: {
      lanes: [
        { id: "salary-405", rank: 0, params: { salary: ["405"] } },
        { id: "salary-404", rank: 1, params: { salary: ["404"] } }
      ]
    },
    maxCards: 50,
    supplementalSalaryLaneKeywordLimit: 1,
    supplementalSalaryLaneCardLimit: 20,
    supplementalSalaryLaneDetailLimit: 10
  });
  assert.deepStrictEqual(dailyTargets.map((target) => target.targetKey), [
    "101280100|primary|salary-405",
    "101280100|secondary|salary-405",
    "101280100|primary|salary-404"
  ]);
  assert.deepStrictEqual(dailyTargets.map((target) => target.cardLimit), [50, 33, 20]);
  assert.deepStrictEqual(dailyTargets.map((target) => target.detailLimitOverride), [null, null, 10]);
}

async function scanTargetResumeFilterSmoke() {
  const navigated = [];
  const browser = {
    async activeTabId() { return activeBoss.id; },
    async navigate(_tabId, url) { navigated.push(new URL(url).searchParams.get("query")); }
  };
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {} });
  adapter.assertSearchPage = async () => ({ isSearchPage: true });
  adapter.collectCards = async () => [card("resumed")];
  const summaries = [];
  const checkpoints = [];
  const jobs = await adapter.scanBrowser({
    tabId: activeBoss.id,
    keywords: ["first", "second"],
    keywordPlan: [{ word: "first", priority: "A" }, { word: "second", priority: "A" }],
    cityScopes: [{ city: "广州", cityCode: "101280100" }],
    targetKeys: ["101280100|second|lane-1"],
    maxCards: 20,
    maxDetailTotal: 0,
    shouldReadDetail: () => false,
    onTargetComplete: async (result) => checkpoints.push(result),
    onScanComplete: async (summary) => summaries.push(summary)
  });
  assert.deepStrictEqual(navigated, ["second"]);
  assert.strictEqual(jobs.length, 1);
  assert.strictEqual(checkpoints[0].targetPosition, 2);
  assert.strictEqual(checkpoints[0].targetTotal, 2);
  assert.strictEqual(summaries[0].status, "completed");

  await assert.rejects(() => adapter.scanBrowser({
    tabId: activeBoss.id,
    keywords: ["first"],
    cityScopes: [{ city: "广州", cityCode: "101280100" }],
    targetKeys: ["101280100|missing|lane-1"]
  }), (error) => error.code === "BOSS_SCAN_TARGETS_NOT_FOUND");
}

async function fatalBudgetAfterCompletedTargetSmoke() {
  const visited = [];
  const expectedUsage = { "10m": 20, "1h": 80, "24h": 120 };
  const budgetError = Object.assign(new Error("budget exhausted after first target"), {
    code: "BOSS_ACCESS_BUDGET_EXHAUSTED",
    retryAt: "2026-08-10T00:00:00.000Z",
    action: "pane_detail_read",
    limit: 120,
    usage: { ...expectedUsage }
  });
  const browser = {
    keyword: "",
    async activeTabId() { return activeBoss.id; },
    async navigate(_tabId, url) {
      this.keyword = new URL(url).searchParams.get("query");
      visited.push(this.keyword);
    }
  };
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {} });
  adapter.assertSearchPage = async () => ({ isSearchPage: true });
  adapter.collectCards = async () => {
    if (browser.keyword === "first") return [card("first")];
    return [card("budget-pending"), card("budget-unvisited")];
  };
  adapter.readVisiblePaneDetail = async (_tabId, job) => {
    if (job.title !== "first") throw budgetError;
    return {
      description: `完整职位描述 ${job.title} Python RAG `.repeat(12),
      bossActiveText: "今日活跃"
    };
  };
  const checkpoints = [];
  const summaries = [];
  let receivedError = null;
  await assert.rejects(() => adapter.scanBrowser({
    tabId: activeBoss.id,
    keywords: ["first", "second", "third"],
    keywordPlan: [
      { word: "first", priority: "A" },
      { word: "second", priority: "A" },
      { word: "third", priority: "A" }
    ],
    cityScopes: [{ city: "广州", cityCode: "101280100" }],
    maxCards: 20,
    maxDetailTotal: 3,
    onTargetComplete: async (result) => checkpoints.push(result),
    onScanComplete: async (summary) => summaries.push(summary)
  }), (error) => {
    receivedError = error;
    return true;
  });
  assert.deepStrictEqual(visited, ["first", "second"]);
  assert.deepStrictEqual(checkpoints.map((item) => item.status), ["completed", "failed"]);
  assert.strictEqual(checkpoints[0].jobs[0].detailRead, true);
  assert.strictEqual(checkpoints[1].jobs.length, 2);
  assert(checkpoints[1].jobs.every((job) => !job.detailRead));
  const pendingByTitle = new Map(checkpoints[1].jobs.map((job) => [job.title, job]));
  assert.strictEqual(pendingByTitle.get("budget-pending").detailErrorCode || "", "");
  assert.strictEqual(pendingByTitle.get("budget-unvisited").detailErrorCode, "BOSS_DETAIL_FAIR_SHARE_PENDING");
  assert.strictEqual(summaries[0].status, "partial");
  assert.strictEqual(summaries[0].fatalErrorCode, "BOSS_ACCESS_BUDGET_EXHAUSTED");
  assert.strictEqual(receivedError, budgetError);
  assert.strictEqual(receivedError.retryAt, "2026-08-10T00:00:00.000Z");
  assert.strictEqual(receivedError.action, "pane_detail_read");
  assert.strictEqual(receivedError.limit, 120);
  assert.deepStrictEqual(receivedError.usage, expectedUsage);
}

async function midDetailAbortIsFatalSmoke() {
  const abortError = Object.assign(new Error("stop during detail"), { code: "SCAN_ABORTED" });
  const checkpoints = [];
  const summaries = [];
  const outcomes = [];
  let paneAttempts = 0;
  let standaloneAttempts = 0;
  let detailWaits = 0;
  const adapter = new BossSiteAdapter({ browser: { async navigate() {} }, sleepFn: async () => {} });
  adapter.assertSearchPage = async () => ({ isSearchPage: true });
  adapter.collectCards = async () => [card("aborted-detail")];
  adapter.readVisiblePaneDetail = async () => {
    paneAttempts += 1;
    throw abortError;
  };
  adapter.readDetail = async () => {
    standaloneAttempts += 1;
    return null;
  };
  adapter.waitAfterDetailAction = async () => { detailWaits += 1; };
  let receivedError = null;
  await assert.rejects(() => adapter.scanBrowser({
    tabId: activeBoss.id,
    keywords: ["aborted"],
    cityScopes: [{ city: "广州", cityCode: "101280100" }],
    maxCards: 20,
    maxDetailTotal: 1,
    onTargetComplete: async (result) => checkpoints.push(result),
    onDetailResult: async (result) => outcomes.push(result),
    onScanComplete: async (summary) => summaries.push(summary)
  }), (error) => {
    receivedError = error;
    return true;
  });
  assert.strictEqual(receivedError, abortError);
  assert.strictEqual(paneAttempts, 1);
  assert.strictEqual(standaloneAttempts, 0);
  assert.strictEqual(detailWaits, 0);
  assert.deepStrictEqual(outcomes, []);
  assert.strictEqual(checkpoints.length, 1);
  assert.strictEqual(checkpoints[0].status, "failed");
  assert.strictEqual(checkpoints[0].jobs[0].detailErrorCode || "", "");
  assert.strictEqual(summaries[0].fatalErrorCode, "SCAN_ABORTED");
}

async function abortedScanStopsBeforeBrowserUseSmoke() {
  let browserCalls = 0;
  const browser = {
    async activeTabId() {
      browserCalls += 1;
      return activeBoss.id;
    }
  };
  const controller = new AbortController();
  const reason = Object.assign(new Error("lease lost"), { code: "SCAN_LEASE_LOST" });
  controller.abort(reason);
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {} });
  await assert.rejects(() => adapter.scanBrowser({
    keywords: ["first"],
    cityScopes: [{ city: "广州", cityCode: "101280100" }],
    signal: controller.signal
  }), (error) => error === reason);
  assert.strictEqual(browserCalls, 0);
}

async function partialTargetCheckpointSmoke() {
  const browser = { async activeTabId() { return activeBoss.id; }, async navigate() {} };
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {} });
  adapter.assertSearchPage = async () => ({ isSearchPage: true });
  adapter.collectCards = async () => ({
    cards: [card("partial")],
    status: "partial",
    stopReason: "scroll_safety_limit",
    scrollRounds: 35,
    growthRounds: 1,
    quietWindows: 0
  });
  adapter.readVisiblePaneDetail = async (_tabId, job) => ({
    description: `完整职位描述 ${job.title} Python RAG `.repeat(12),
    bossActiveText: "今日活跃",
    salary: job.salary,
    experience: job.experience,
    education: job.education
  });
  const checkpoints = [];
  await adapter.scanBrowser({
    tabId: activeBoss.id,
    keywords: ["partial"],
    cityScopes: [{ city: "广州", cityCode: "101280100" }],
    maxCards: 20,
    maxDetailTotal: 1,
    onTargetComplete: async (result) => checkpoints.push(result)
  });
  assert.strictEqual(checkpoints[0].status, "partial");
  assert.deepStrictEqual(checkpoints[0].details, {
    cardLimit: 13,
    stopReason: "scroll_safety_limit",
    scrollRounds: 35,
    growthRounds: 1,
    quietWindows: 0
  });
}

async function pageBudgetSmoke() {
  const browser = {
    keyword: "",
    async activeTabId() { return activeBoss.id; },
    async navigate(_tabId, url) { this.keyword = new URL(url).searchParams.get("query"); }
  };
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {} });
  adapter.assertSearchPage = async () => ({ isSearchPage: true });
  const pageBudgetError = Object.assign(new Error("page budget"), { code: "BOSS_PAGE_BUDGET_REACHED" });
  let navigations = 0;
  adapter.navigateWithPacing = async (_tabId, url) => {
    if (navigations >= 1) {
      throw pageBudgetError;
    }
    navigations += 1;
    browser.keyword = new URL(url).searchParams.get("query");
  };
  adapter.collectCards = async () => [card(browser.keyword)];
  adapter.readVisiblePaneDetail = async (_tabId, job) => ({
    description: `完整职位描述 ${job.title} Python RAG `.repeat(12),
    bossActiveText: "今日活跃",
    salary: job.salary,
    experience: job.experience,
    education: job.education
  });
  const checkpoints = [];
  let receivedError = null;
  await assert.rejects(() => adapter.scanBrowser({
    tabId: activeBoss.id,
    keywords: ["first", "second", "third"],
    cityScopes: [{ city: "广州", cityCode: "101280100" }],
    maxCards: 20,
    maxDetailTotal: 3,
    onTargetComplete: async (result) => checkpoints.push(result),
    scoreQuick: () => 1
  }), (error) => {
    receivedError = error;
    return true;
  });
  assert.strictEqual(receivedError, pageBudgetError);
  assert.deepStrictEqual(checkpoints.map((item) => item.status), ["completed", "failed"]);
  assert.strictEqual(checkpoints[1].errorCode, "BOSS_PAGE_BUDGET_REACHED");
}

async function riskControlSmoke() {
  const browser = {
    keyword: "",
    async activeTabId() { return activeBoss.id; },
    async navigate(_tabId, url) { this.keyword = new URL(url).searchParams.get("query"); }
  };
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {} });
  adapter.assertSearchPage = async () => ({ isSearchPage: true });
  adapter.collectCards = async () => [card(browser.keyword)];
  adapter.readVisiblePaneDetail = async () => {
    throw Object.assign(new Error("risk control"), { code: "BOSS_RISK_CONTROL" });
  };
  const checkpoints = [];
  const riskEvents = [];
  await assert.rejects(() => adapter.scanBrowser({
    tabId: activeBoss.id,
    keywords: ["first", "second", "third"],
    cityScopes: [{ city: "广州", cityCode: "101280100" }],
    maxCards: 20,
    maxDetailTotal: 3,
    onRiskControl: async (event) => riskEvents.push(event),
    onTargetComplete: async (result) => checkpoints.push(result),
    scoreQuick: () => 1
  }), (error) => error.code === "BOSS_RISK_CONTROL");
  assert.strictEqual(checkpoints.length, 1);
  assert.strictEqual(checkpoints[0].status, "failed");
  assert.strictEqual(checkpoints[0].jobCount, 1);
  assert.strictEqual(riskEvents.length, 1);
  assert.strictEqual(riskEvents[0].errorCode, "BOSS_RISK_CONTROL");
}

async function fullDetailCoverageSmoke() {
  const browser = {
    keyword: "",
    async activeTabId() { return activeBoss.id; },
    async navigate(_tabId, url) { this.keyword = new URL(url).searchParams.get("query"); }
  };
  const fixtures = {
    primary: [card("shared"), card("primary-only"), card("internship")],
    secondary: [card("shared"), card("secondary-only")],
    broad: [card("broad-only")]
  };
  fixtures.primary[2].title = "AI开发实习生";
  const reads = [];
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {} });
  adapter.assertSearchPage = async () => ({ isSearchPage: true });
  adapter.collectCards = async () => fixtures[browser.keyword];
  adapter.readVisiblePaneDetail = async (_tabId, job) => {
    reads.push(job.sourceId);
    return {
      description: `完整职位描述 ${job.title} Python RAG `.repeat(12),
      bossActiveText: "今日活跃",
      salary: job.salary,
      experience: job.experience,
      education: job.education
    };
  };
  adapter.readDetail = async (_tabId, url) => {
    const sourceId = url.match(/job_detail\/([^./]+)/)?.[1] || "";
    reads.push(`boss:${sourceId}`);
    return { description: `瀹屾暣鑱屼綅鎻忚堪 ${sourceId} Python RAG `.repeat(12), bossActiveText: "浠婃棩娲昏穬" };
  };
  const jobs = await adapter.scanBrowser({
    tabId: activeBoss.id,
    keywords: ["primary", "secondary", "broad"],
    keywordPlan: [
      { word: "primary", priority: "A" },
      { word: "secondary", priority: "B" },
      { word: "broad", priority: "C" }
    ],
    cityScopes: [{ city: "广州", cityCode: "101280100" }],
    maxCards: 20,
    maxDetailTotal: 100,
    shouldReadDetail: (job) => !/实习/.test(job.title)
  });
  assert.strictEqual(jobs.length, 5);
  assert.strictEqual(reads.length, 4, "所有未硬排除的唯一岗位都应读取右栏");
  assert.strictEqual(new Set(reads).size, 4, "跨关键词重复岗位不得重复点击");
  assert(jobs.filter((job) => job.detailRequired).every((job) => job.detailRead));
  assert.strictEqual(jobs.find((job) => /实习/.test(job.title)).detailRequired, false);
}

async function detailCheckpointAndWorkflowPauseSmoke() {
  const pause = Object.assign(new Error("pause"), { code: "WORKFLOW_PAUSE_REQUESTED" });
  const detailCheckpoints = [];
  const targetCheckpoints = [];
  const adapter = new BossSiteAdapter({ browser: { async navigate() {} }, sleepFn: async () => {} });
  adapter.assertSearchPage = async () => ({ isSearchPage: true });
  adapter.collectCards = async () => [card("workflow-pause-detail")];
  adapter.readVisiblePaneDetail = async () => ({
    description: "Complete checkpointed job description Python RAG ".repeat(12),
    bossActiveText: "active today"
  });
  adapter.waitAfterDetailAction = async () => { throw pause; };

  await assert.rejects(() => adapter.scanBrowser({
    tabId: activeBoss.id,
    keywords: ["workflow-pause"],
    cityScopes: [{ city: "Guangzhou", cityCode: "101280100" }],
    maxCards: 20,
    maxDetailTotal: 1,
    onDetailCheckpoint: async (result) => detailCheckpoints.push(result),
    onTargetComplete: async (result) => targetCheckpoints.push(result)
  }), (error) => error.code === "WORKFLOW_PAUSE_REQUESTED");

  assert.strictEqual(detailCheckpoints.length, 1);
  assert.strictEqual(detailCheckpoints[0].job.detailRead, true);
  assert.strictEqual(detailCheckpoints[0].job.description, "Complete checkpointed job description Python RAG ".repeat(12).trim());
  assert.deepStrictEqual(targetCheckpoints, []);
}

async function fairDetailAllocationSmoke() {
  const browser = {
    keyword: "",
    async activeTabId() { return activeBoss.id; },
    async navigate(_tabId, url) { this.keyword = new URL(url).searchParams.get("query"); }
  };
  const reads = [];
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {}, randomFn: () => 0 });
  adapter.assertSearchPage = async () => ({ isSearchPage: true });
  adapter.collectCards = async () => Array.from({ length: 10 }, (_, index) => card(`${browser.keyword}-${index}`));
  adapter.readVisiblePaneDetail = async (_tabId, job) => {
    reads.push(job.title);
    return { description: `完整职位描述 ${job.title} Python RAG `.repeat(12), bossActiveText: "今日活跃" };
  };
  adapter.readDetail = async (_tabId, url) => {
    const title = url.match(/job_detail\/([^./]+)/)?.[1] || "";
    reads.push(title);
    return { description: `standalone detail ${title} `.repeat(12), bossActiveText: "active" };
  };
  const jobs = await adapter.scanBrowser({
    tabId: activeBoss.id,
    keywords: ["first", "second", "third"],
    keywordPlan: [
      { word: "first", priority: "A" },
      { word: "second", priority: "A" },
      { word: "third", priority: "A" }
    ],
    cityScopes: [{ city: "广州", cityCode: "101280100" }],
    maxCards: 20,
    maxDetailTotal: 6
  });
  assert.strictEqual(reads.length, 6);
  assert.deepStrictEqual(["first", "second", "third"].map((keyword) => reads.filter((title) => title.startsWith(keyword)).length), [2, 2, 2]);
  assert.strictEqual(jobs.filter((job) => job.detailRead).length, 6);
  assert(jobs.some((job) => job.detailErrorCode === "BOSS_DETAIL_FAIR_SHARE_PENDING"));
}

async function priorityDetailBudgetSmoke() {
  const browser = {
    keyword: "",
    async activeTabId() { return activeBoss.id; },
    async navigate(_tabId, url) { this.keyword = new URL(url).searchParams.get("query"); }
  };
  const reads = [];
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {}, randomFn: () => 0 });
  adapter.assertSearchPage = async () => ({ isSearchPage: true });
  adapter.collectCards = async () => Array.from({ length: 10 }, (_, index) => card(`${browser.keyword}-${index}`));
  adapter.readVisiblePaneDetail = async (_tabId, job) => {
    reads.push(job.title);
    return { description: `完整职位描述 ${job.title} Python RAG `.repeat(12), bossActiveText: "今日活跃" };
  };
  adapter.readDetail = async (_tabId, url) => {
    const title = url.match(/job_detail\/([^./]+)/)?.[1] || "";
    reads.push(title);
    return { description: `standalone detail ${title} `.repeat(12), bossActiveText: "active" };
  };
  await adapter.scanBrowser({
    tabId: activeBoss.id,
    keywords: ["primary", "secondary"],
    keywordPlan: [{ word: "primary", priority: "A" }, { word: "secondary", priority: "B" }],
    cityScopes: [{ city: "广州", cityCode: "101280100" }],
    maxCards: 20,
    maxDetailTotal: 7,
    detailLimits: { A: 4, B: 3 }
  });
  assert.deepStrictEqual([
    reads.filter((title) => title.startsWith("primary")).length,
    reads.filter((title) => title.startsWith("secondary")).length
  ], [4, 3]);
}

async function reusableDetailSmoke() {
  const browser = { async activeTabId() { return activeBoss.id; }, async navigate() {} };
  const reads = [];
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {}, randomFn: () => 0 });
  adapter.assertSearchPage = async () => ({ isSearchPage: true });
  adapter.collectCards = async () => [card("cached"), card("fresh")];
  adapter.readVisiblePaneDetail = async (_tabId, job) => {
    reads.push(job.sourceId);
    return { description: `实时职位描述 ${job.title} Python RAG `.repeat(12), bossActiveText: "今日活跃" };
  };
  const jobs = await adapter.scanBrowser({
    tabId: activeBoss.id,
    keywords: ["cache"],
    cityScopes: [{ city: "广州", cityCode: "101280100" }],
    maxCards: 20,
    maxDetailTotal: 2,
    getReusableDetail: (job) => job.sourceId === "boss:cached" ? {
      sourceId: job.sourceId,
      description: "缓存职位描述 Python RAG ".repeat(12),
      bossActiveText: "今日活跃"
    } : null
  });
  assert.deepStrictEqual(reads, ["boss:fresh"]);
  assert.strictEqual(jobs.find((job) => job.sourceId === "boss:cached").detailRead, true);
  assert.strictEqual(jobs.filter((job) => job.detailRead).length, 2);
}

async function changedCardFactsRejectCacheSmoke() {
  const browser = { async activeTabId() { return activeBoss.id; }, async navigate() {} };
  const reads = [];
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {}, randomFn: () => 0 });
  adapter.assertSearchPage = async () => ({ isSearchPage: true });
  adapter.collectCards = async () => [card("changed-cache")];
  adapter.readVisiblePaneDetail = async (_tabId, job) => {
    reads.push(job.sourceId);
    return {
      description: `实时职位描述 ${job.title} Python RAG `.repeat(12),
      bossActiveText: "今日活跃",
      salary: job.salary,
      experience: job.experience,
      education: job.education
    };
  };
  const jobs = await adapter.scanBrowser({
    tabId: activeBoss.id,
    keywords: ["cache-change"],
    cityScopes: [{ city: "广州", cityCode: "101280100" }],
    maxCards: 20,
    maxDetailTotal: 1,
    getReusableDetail: (job) => ({
      sourceId: job.sourceId,
      title: job.title,
      company: job.company,
      location: job.location,
      salary: "8-10K",
      experience: job.experience,
      education: job.education,
      description: "旧职位描述 Python RAG ".repeat(12),
      bossActiveText: "今日活跃"
    })
  });
  assert.deepStrictEqual(reads, ["boss:changed-cache"]);
  assert.strictEqual(jobs[0].salary, "10-15K");
  assert(!jobs[0].description.includes("旧职位描述"));
}

async function detailSafetyLimitSmoke() {
  const browser = { async activeTabId() { return activeBoss.id; }, async navigate() {} };
  let reads = 0;
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {} });
  adapter.assertSearchPage = async () => ({ isSearchPage: true });
  adapter.collectCards = async () => Array.from({ length: 5 }, (_, index) => card(`safety-${index}`));
  adapter.readVisiblePaneDetail = async (_tabId, job) => {
    reads += 1;
    return { description: `完整职位描述 ${job.title} Python RAG `.repeat(12), bossActiveText: "今日活跃" };
  };
  adapter.readDetail = async (_tabId, url) => {
    reads += 1;
    return { description: `standalone detail ${url} `.repeat(12), bossActiveText: "active" };
  };
  const jobs = await adapter.scanBrowser({
    tabId: activeBoss.id,
    keywords: ["safety"],
    cityScopes: [{ city: "广州", cityCode: "101280100" }],
    maxCards: 20,
    maxDetailTotal: 2
  });
  assert.strictEqual(reads, 2);
  assert.strictEqual(jobs.filter((job) => job.detailRequired).length, 5);
  assert.strictEqual(jobs.filter((job) => job.detailRead).length, 2);
  assert.strictEqual(jobs.filter((job) => job.detailErrorCode === "BOSS_DETAIL_SAFETY_LIMIT").length, 3);
}

async function detailFailureDedupeSmoke() {
  const browser = {
    keyword: "",
    async activeTabId() { return activeBoss.id; },
    async navigate(_tabId, url) { this.keyword = new URL(url).searchParams.get("query"); }
  };
  let reads = 0;
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {} });
  adapter.assertSearchPage = async () => ({ isSearchPage: true });
  adapter.collectCards = async () => [card("same-failure")];
  adapter.readVisiblePaneDetail = async () => {
    reads += 1;
    throw Object.assign(new Error("pane timeout"), { code: "BOSS_PANE_SWITCH_TIMEOUT" });
  };
  const jobs = await adapter.scanBrowser({
    tabId: activeBoss.id,
    keywords: ["first", "second"],
    cityScopes: [{ city: "广州", cityCode: "101280100" }],
    maxCards: 20,
    maxDetailTotal: 10
  });
  assert.strictEqual(reads, 1, "同一岗位详情失败后不得在同一轮跨关键词反复点击");
  assert.strictEqual(jobs.length, 1);
  assert.strictEqual(jobs[0].detailRequired, true);
  assert.strictEqual(jobs[0].detailRead, false);
  assert.strictEqual(jobs[0].detailErrorCode, "BOSS_PANE_SWITCH_TIMEOUT");
}

async function detailOutcomeAuditSmoke() {
  const browser = {
    keyword: "",
    async activeTabId() { return activeBoss.id; },
    async navigate(_tabId, url) { this.keyword = new URL(url).searchParams.get("query"); }
  };
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {} });
  adapter.assertSearchPage = async () => ({ isSearchPage: true });
  adapter.collectCards = async () => [card("audit-success"), card("audit-failure")];
  adapter.readVisiblePaneDetail = async (_tabId, job) => {
    if (job.title === "audit-failure") {
      throw Object.assign(new Error("pane timeout"), { code: "BOSS_PANE_SWITCH_TIMEOUT" });
    }
    return { description: "Complete detail Python RAG ".repeat(12), bossActiveText: "今日活跃" };
  };
  adapter.readDetail = async () => {
    throw new Error("normal scan must not open standalone detail");
  };
  const outcomes = [];
  const jobs = await adapter.scanBrowser({
    tabId: activeBoss.id,
    keywords: ["audit"],
    cityScopes: [{ city: "广州", cityCode: "101280100" }],
    maxCards: 20,
    maxDetailTotal: 2,
    onDetailResult: async (outcome) => outcomes.push(outcome)
  });
  assert.deepStrictEqual(outcomes, [
    { outcome: "succeeded", errorCode: "", accessMode: "visible_pane" },
    { outcome: "failed", errorCode: "BOSS_PANE_SWITCH_TIMEOUT", accessMode: "visible_pane" }
  ]);
  assert.strictEqual(jobs.find((job) => job.title === "audit-failure").detailErrorCode, "BOSS_PANE_SWITCH_TIMEOUT");
  assert(!JSON.stringify(outcomes).includes("audit-failure"));
}

async function detailFatalOutcomeAuditSmoke() {
  const browser = {
    keyword: "",
    async activeTabId() { return activeBoss.id; },
    async navigate(_tabId, url) { this.keyword = new URL(url).searchParams.get("query"); }
  };
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {} });
  adapter.assertSearchPage = async () => ({ isSearchPage: true });
  adapter.collectCards = async () => [card("audit-fatal")];
  adapter.readVisiblePaneDetail = async () => {
    throw Object.assign(new Error("risk"), { code: "BOSS_RISK_CONTROL" });
  };
  const outcomes = [];
  await assert.rejects(() => adapter.scanBrowser({
    tabId: activeBoss.id,
    keywords: ["audit-fatal"],
    cityScopes: [{ city: "骞垮窞", cityCode: "101280100" }],
    maxCards: 20,
    maxDetailTotal: 1,
    onDetailResult: async (outcome) => {
      outcomes.push(outcome);
      throw new Error("audit sink unavailable");
    }
  }), (error) => error.code === "BOSS_RISK_CONTROL");
  assert.deepStrictEqual(outcomes, [
    { outcome: "failed", errorCode: "BOSS_RISK_CONTROL", accessMode: "visible_pane" }
  ]);
}

async function trustedClickTransportFatalSmoke() {
  for (const [stage, code] of [
    ["focusEnable", "BROWSER_COMMAND_FAILED"],
    ["clickAt", "BROWSER_COMMAND_FAILED"],
    ["clickAt", "BROWSER_TIMEOUT"],
    ["clickAt", "BROWSER_DISCONNECTED"],
    ["focusDisable", "BROWSER_COMMAND_FAILED"]
  ]) {
    const fatal = Object.assign(new Error(`${stage} fatal`), { code });
    const outcomes = [];
    const focusStates = [];
    let navigations = 0;
    const browser = {
      async navigate() { navigations += 1; },
      async cdp(_tabId, method, params) {
        assert.strictEqual(method, "Emulation.setFocusEmulationEnabled");
        focusStates.push(params.enabled);
        if (stage === "focusEnable" && params.enabled) throw fatal;
        if (stage === "focusDisable" && !params.enabled) throw fatal;
      },
      async clickAt() {
        if (stage === "clickAt") throw fatal;
      },
      async evalValue(_tabId, expression) {
        if (expression.includes("window.__bossPaneState()")) {
          return paneState("old-job", "Old job");
        }
        if (expression.includes("(() => window.__bossCardActivationPoint(")) {
          return { ready: true, jobId: `fatal-${code}`, x: 100, y: 100, reason: "" };
        }
        return true;
      }
    };
    const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {}, randomFn: () => 0 });
    adapter.assertSearchPage = async () => ({ isSearchPage: true });
    adapter.collectCards = async () => [card(`fatal-${code}`)];

    await assert.rejects(() => adapter.scanBrowser({
      tabId: "pane-tab",
      keywords: [`fatal-${code}`],
      cityScopes: [{ city: "Guangzhou", cityCode: "101280100" }],
      maxCards: 20,
      maxDetailTotal: 1,
      onDetailResult: async (outcome) => {
        outcomes.push(outcome);
        throw new Error("audit sink unavailable");
      }
    }), (error) => error === fatal);

    assert.deepStrictEqual(outcomes, [
      { outcome: "failed", errorCode: code, accessMode: "visible_pane" }
    ]);
    assert.strictEqual(navigations, 1, `${stage} fatal must not navigate to a detail page`);
    assert(!JSON.stringify(outcomes).includes("BOSS_PANE_SWITCH_TIMEOUT"));
    assert.deepStrictEqual(focusStates, [true, false], `${stage} fatal must attempt focus cleanup exactly once`);
  }
}

async function detailBudgetCheckpointSmoke() {
  const checkpoints = [];
  const summaries = [];
  const outcomes = [];
  const expectedUsage = { "10m": 20, "1h": 80, "24h": 120 };
  const budgetError = Object.assign(new Error("daily detail budget exhausted; resume at 2026-08-10T00:00:00.000Z"), {
    code: "BOSS_ACCESS_BUDGET_EXHAUSTED",
    site: "boss",
    action: "pane_detail_read",
    mode: "recovery",
    window: "24h",
    limit: 120,
    usage: { ...expectedUsage },
    retryAt: "2026-08-10T00:00:00.000Z"
  });
  let receivedError = null;
  let detailCalls = 0;
  const browser = {
    async navigate() {}
  };
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {}, randomFn: () => 0 });
  adapter.assertSearchPage = async () => ({ isSearchPage: true });
  adapter.collectCards = async () => [
    card("budget-complete"),
    card("budget-pending"),
    card("budget-unvisited")
  ];
  adapter.readVisiblePaneDetail = async () => {
    detailCalls += 1;
    if (detailCalls === 1) {
      return {
        description: "Complete detail before budget stop ".repeat(12),
        bossActiveText: "浠婃棩娲昏穬"
      };
    }
    throw budgetError;
  };
  await assert.rejects(() => adapter.scanBrowser({
    tabId: activeBoss.id,
    keywords: ["budget"],
    cityScopes: [{ city: "骞垮窞", cityCode: "101280100" }],
    maxCards: 20,
    maxDetailTotal: 3,
    onTargetComplete: async (result) => checkpoints.push(result),
    onDetailResult: async (result) => outcomes.push(result),
    onScanComplete: async (summary) => summaries.push(summary)
  }), (error) => {
    receivedError = error;
    return true;
  });

  assert.strictEqual(receivedError, budgetError);
  assert.strictEqual(receivedError.code, "BOSS_ACCESS_BUDGET_EXHAUSTED");
  assert.strictEqual(receivedError.retryAt, "2026-08-10T00:00:00.000Z");
  assert.strictEqual(receivedError.action, "pane_detail_read");
  assert.strictEqual(receivedError.limit, 120);
  assert.deepStrictEqual(receivedError.usage, expectedUsage);
  assert.strictEqual(detailCalls, 2);
  assert.strictEqual(checkpoints.length, 1);
  assert.strictEqual(checkpoints[0].status, "failed");
  const byTitle = new Map(checkpoints[0].jobs.map((job) => [job.title, job]));
  assert.strictEqual(byTitle.get("budget-complete").detailRead, true);
  assert.strictEqual(byTitle.get("budget-pending").detailRead, false);
  assert.strictEqual(byTitle.get("budget-pending").detailErrorCode || "", "");
  assert.strictEqual(byTitle.get("budget-unvisited").detailRead, false);
  assert.strictEqual(byTitle.get("budget-unvisited").detailErrorCode || "", "");
  assert.strictEqual(summaries[0].fatalErrorCode, "BOSS_ACCESS_BUDGET_EXHAUSTED");
  assert.match(summaries[0].fatalErrorMessage, /2026-08-10T00:00:00\.000Z/);
  assert.deepStrictEqual(outcomes.at(-1), {
    outcome: "failed",
    errorCode: "BOSS_ACCESS_BUDGET_EXHAUSTED",
    accessMode: "visible_pane"
  });
}

async function refreshSafetySmoke() {
  const attempts = [];
  const adapter = new BossSiteAdapter({ browser: {}, sleepFn: async () => {} });
  adapter.readDetail = async () => {
    throw Object.assign(new Error("risk control"), { code: "BOSS_RISK_CONTROL" });
  };
  await assert.rejects(() => adapter.refreshDetails(
    Array.from({ length: 12 }, (_, index) => card(`refresh-${index}`)),
    { limit: 12, tabId: "tab", onAttempt: async (attempt) => attempts.push(attempt) }
  ), (error) => error.code === "BOSS_RISK_CONTROL");
  assert.strictEqual(attempts.length, 1, "风控后不得继续尝试后续岗位");

  let reads = 0;
  const capped = new BossSiteAdapter({ browser: {}, sleepFn: async () => {} });
  capped.readDetail = async () => {
    reads += 1;
    return { description: "完整职位描述 Python RAG ".repeat(12), bossActiveText: "今日活跃" };
  };
  const refreshed = await capped.refreshDetails(Array.from({ length: 12 }, (_, index) => card(`cap-${index}`)), { limit: 12, tabId: "tab" });
  assert.strictEqual(reads, PRODUCT_POLICY.operations.refreshLimit);
  assert.strictEqual(refreshed.length, PRODUCT_POLICY.operations.refreshLimit);

  const probeAttempts = [];
  const blockedProbe = new BossSiteAdapter({ browser: {}, sleepFn: async () => {} });
  blockedProbe.readActivity = async () => {
    throw Object.assign(new Error("risk control"), { code: "BOSS_RISK_CONTROL" });
  };
  await assert.rejects(() => blockedProbe.probeActivities(
    Array.from({ length: 3 }, (_, index) => card(`probe-risk-${index}`)),
    { limit: 3, tabId: "tab", onAttempt: async (attempt) => probeAttempts.push(attempt) }
  ), (error) => error.code === "BOSS_RISK_CONTROL");
  assert.strictEqual(probeAttempts.length, 1, "探针遇到风控后不得继续访问后续岗位");

  let probes = 0;
  const cappedProbe = new BossSiteAdapter({ browser: {}, sleepFn: async () => {} });
  cappedProbe.readActivity = async () => {
    probes += 1;
    return "今日活跃";
  };
  const probed = await cappedProbe.probeActivities(Array.from({ length: 12 }, (_, index) => card(`probe-cap-${index}`)), { limit: 12, tabId: "tab" });
  assert.strictEqual(probes, PRODUCT_POLICY.operations.refreshLimit);
  assert.strictEqual(probed.length, PRODUCT_POLICY.operations.refreshLimit);
  assert(probed.every((job) => job.bossActiveText === "今日活跃"));
}

async function runtimeBindingAndAbortSmoke() {
  let bindingIntact = true;
  const reads = [];
  const bindingError = Object.assign(new Error("fixed BOSS communication tab changed"), {
    code: "BOSS_OPERATOR_TABS_CHANGED"
  });
  const adapter = new BossSiteAdapter({ browser: {}, sleepFn: async () => {} });
  adapter.readDetail = async (_tabId, url) => {
    reads.push(url);
    bindingIntact = false;
    return { description: "完整职位描述 Python RAG ".repeat(12), bossActiveText: "今日活跃" };
  };
  await assert.rejects(
    () => adapter.refreshDetails([card("runtime-binding-1"), card("runtime-binding-2")], {
      limit: 2,
      tabId: "fixed-search",
      assertTabBindings: async () => {
        if (!bindingIntact) throw bindingError;
      }
    }),
    (error) => error === bindingError
  );
  assert.deepStrictEqual(reads, [card("runtime-binding-1").url]);

  const detailController = new AbortController();
  const detailAbort = Object.assign(new Error("detail refresh aborted"), { code: "SCAN_ABORTED" });
  let detailSignal = null;
  const detailAdapter = new BossSiteAdapter({ browser: {}, sleepFn: async () => {} });
  detailAdapter.readDetail = async (_tabId, _url, signal) => {
    detailSignal = signal;
    detailController.abort(detailAbort);
    return { description: "完整职位描述 Python RAG ".repeat(12), bossActiveText: "今日活跃" };
  };
  await assert.rejects(
    () => detailAdapter.refreshDetails([card("refresh-signal")], {
      tabId: "fixed-search",
      signal: detailController.signal
    }),
    (error) => error === detailAbort
  );
  assert.strictEqual(detailSignal, detailController.signal);

  const activityController = new AbortController();
  const activityAbort = Object.assign(new Error("activity refresh aborted"), { code: "SCAN_ABORTED" });
  let activitySignal = null;
  const activityAdapter = new BossSiteAdapter({ browser: {}, sleepFn: async () => {} });
  activityAdapter.readActivity = async (_tabId, _url, signal) => {
    activitySignal = signal;
    activityController.abort(activityAbort);
    return "今日活跃";
  };
  await assert.rejects(
    () => activityAdapter.probeActivities([card("activity-signal")], {
      tabId: "fixed-search",
      signal: activityController.signal
    }),
    (error) => error === activityAbort
  );
  assert.strictEqual(activitySignal, activityController.signal);
}

async function refreshCheckpointBeforeFatalSmoke() {
  let reads = 0;
  const attempts = [];
  const adapter = new BossSiteAdapter({ browser: {}, sleepFn: async () => {} });
  adapter.readDetail = async (_tabId, url) => {
    reads += 1;
    if (reads === 2) {
      const error = new Error("edge disconnected after one success");
      error.code = "BROWSER_DISCONNECTED";
      throw error;
    }
    return {
      description: `persisted detail for ${url}`,
      bossActiveText: "今日活跃"
    };
  };
  await assert.rejects(() => adapter.refreshDetails([
    card("refresh-before-fatal-1"),
    card("refresh-before-fatal-2")
  ], {
    limit: 2,
    tabId: "tab",
    onAttempt: async (attempt) => attempts.push(attempt)
  }), (error) => error.code === "BROWSER_DISCONNECTED");
  assert.strictEqual(attempts.length, 2);
  assert.strictEqual(attempts[0].result, "success");
  assert(attempts[0].refreshedJob.description.includes("persisted detail"));
  assert.strictEqual(attempts[1].result, "failed");
}

function storageSmoke() {
  const root = path.resolve(__dirname, "..");
  const dbPath = path.join(root, ".runtime", "smoke", `source-acquisition-${Date.now()}.sqlite`);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);
  try {
    const batchId = createBatch(db, "boss", "RAG", "source-acquisition-smoke");
    recordScanTargetResult(db, {
      batchId,
      targetKey: "广州|RAG|salary-405",
      city: "广州",
      keyword: "RAG",
      laneId: "salary-405",
      status: "failed",
      jobCount: 12,
      errorCode: "BOSS_WHITE_PAGE",
      errorMessage: "white page",
      details: { cardLimit: 50, stopReason: "page_error", scrollRounds: 3 }
    });
    const targets = listScanTargetResults(db, batchId);
    assert.strictEqual(targets.length, 1);
    assert.strictEqual(targets[0].errorCode, "BOSS_WHITE_PAGE");
    assert.deepStrictEqual(targets[0].details, { cardLimit: 50, stopReason: "page_error", scrollRounds: 3 });

    setSiteRuntimeState(db, "boss", { status: "blocked", reasonCode: "BOSS_RISK_CONTROL", message: "verify" });
    assert.strictEqual(getSiteRuntimeState(db, "boss").status, "blocked");
    clearSiteRuntimeState(db, "boss");
    assert.strictEqual(getSiteRuntimeState(db, "boss"), null);

    const lease = acquireSiteScanLease(db, { site: "boss", owner: "smoke-1", command: "scan", planId: 1 });
    assert.strictEqual(lease.owner, "smoke-1");
    assert.strictEqual(lease.planId, 1);
    const secondDb = openDb(dbPath);
    try {
      assert.throws(
        () => acquireSiteScanLease(secondDb, { site: "boss", owner: "smoke-2", command: "refresh-details", planId: 2 }),
        (error) => error.code === "SCAN_ALREADY_RUNNING"
      );
    } finally {
      secondDb.close();
    }
    assert(Date.parse(renewSiteScanLease(db, { site: "boss", owner: "smoke-1" })) > Date.now());
    assert.strictEqual(releaseSiteScanLease(db, { site: "boss", owner: "wrong-owner" }), false);
    assert.strictEqual(releaseSiteScanLease(db, { site: "boss", owner: "smoke-1" }), true);
    assert.strictEqual(getSiteScanLease(db, "boss"), null);
    acquireSiteScanLease(db, { site: "boss", owner: "expired", command: "scan" });
    db.prepare("UPDATE site_scan_leases SET expires_at = ? WHERE site = 'boss'").run("2000-01-01T00:00:00.000Z");
    assert.strictEqual(getSiteScanLease(db, "boss"), null);
    assert.strictEqual(acquireSiteScanLease(db, { site: "boss", owner: "reclaimed", command: "scan" }).owner, "reclaimed");
    releaseSiteScanLease(db, { site: "boss", owner: "reclaimed" });

    upsertJob(db, {
      source: "boss",
      sourceId: "boss:reusable-smoke",
      keyword: "RAG",
      title: "Reusable",
      company: "Quality Corp",
      location: "广州",
      salary: "10-15K",
      experience: "1-3年",
      education: "本科",
      bossActiveText: "今日活跃",
      url: "https://www.zhipin.com/job_detail/reusable-smoke.html",
      tags: [],
      description: "完整职位描述 Python RAG ".repeat(12),
      matches: [],
      risks: [],
      qualityTags: [],
      analysis: {}
    }, batchId);
    const reusable = listReusableJobDetails(db, { site: "boss", maxAgeDays: 7 });
    assert.strictEqual(reusable.length, 1);
    assert.strictEqual(reusable[0].sourceId, "boss:reusable-smoke");
    assert.strictEqual(reusable[0].title, "Reusable");
    assert.strictEqual(reusable[0].company, "Quality Corp");
    assert.strictEqual(reusable[0].salary, "10-15K");

    const now = new Date().toISOString();
    const jobId = Number(db.prepare(`INSERT INTO jobs(source,source_id,title,tags_json,matches_json,risks_json,quality_tags_json,analysis_json,first_seen_at,last_seen_at)
      VALUES ('boss','boss:refresh-smoke','Refresh','[]','[]','[]','[]','{}',?,?)`).run(now, now).lastInsertRowid);
    recordJobRefreshAttempt(db, { jobId, result: "failed", errorCode: "BOSS_LOGIN_REQUIRED", errorMessage: "login" });
    recordJobRefreshAttempt(db, { jobId, result: "failed", errorCode: "BOSS_LOGIN_REQUIRED", errorMessage: "login" });
    const attempts = listJobRefreshAttempts(db, jobId);
    assert.strictEqual(attempts.length, 2);
    assert.strictEqual(attempts[0].attemptNumber, 2);
  } finally {
    db.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      try { fs.rmSync(`${dbPath}${suffix}`, { force: true }); } catch { /* no-op */ }
    }
  }
}

function card(id) {
  return {
    title: id,
    company: "Source Corp",
    location: "广州",
    salary: "10-15K",
    experience: "1-3年",
    education: "本科",
    bossActiveText: "今日活跃",
    url: `https://www.zhipin.com/job_detail/${id}.html`,
    cardText: `${id} Python RAG 今日活跃`
  };
}

function runCardActivationPointFixture({
  hit = "safe",
  rect = { left: 100, top: 200, width: 60, height: 40 },
  componentJobId = "target-job"
} = {}) {
  const events = [];
  let scrolled = false;
  const interactiveSelector = "a,button,[role=button],input,select,textarea,label";
  const targetLink = {
    href: "https://www.zhipin.com/job_detail/target-job.html",
    closest(selector) {
      return selector === interactiveSelector ? this : null;
    }
  };
  const safeHit = {
    closest(selector) {
      return hit === "interactive" && selector === interactiveSelector ? targetLink : null;
    }
  };
  const overlay = { closest() { return null; } };
  const wrap = {
    __vue__: { data: { encryptJobId: componentJobId } },
    scrollIntoView() {
      scrolled = true;
      events.push("scroll");
    },
    getBoundingClientRect() {
      assert.strictEqual(scrolled, true, "rect must be read only after scrollIntoView");
      events.push("rect");
      return rect;
    },
    contains(node) {
      return node === targetCard || node === targetLink || node === safeHit;
    }
  };
  const targetCard = {
    innerText: "Target job unique card",
    querySelector(selector) {
      return selector.startsWith("a") ? targetLink : null;
    },
    closest(selector) {
      return selector === ".job-card-wrap" ? wrap : null;
    }
  };
  const decoyLink = { href: "https://www.zhipin.com/job_detail/decoy-job.html" };
  const decoyCard = {
    innerText: "Decoy job unique card",
    querySelector(selector) {
      return selector.startsWith("a") ? decoyLink : null;
    },
    closest() {
      return { __vue__: { data: { encryptJobId: "decoy-job" } } };
    }
  };
  const document = {
    documentElement: { clientWidth: 300, clientHeight: 300 },
    querySelectorAll(selector) {
      if (selector.includes(".job-card-box")) return [decoyCard, targetCard];
      return [];
    },
    elementFromPoint() {
      events.push("hit");
      if (hit === "none") return null;
      if (hit === "overlay") return overlay;
      if (hit === "interactive-self") return targetLink;
      return safeHit;
    }
  };
  const window = { innerWidth: 300, innerHeight: 300 };
  vm.runInNewContext(PAGE_HELPERS, { window, document });
  return {
    result: window.__bossCardActivationPoint("target-job"),
    events
  };
}

function paneBrowserFixture({
  states = [paneState("old-job", "Old job")],
  activation = null,
  trustedClick = true,
  trustedFocus = true,
  events = []
} = {}) {
  let paneReads = 0;
  let focused = false;
  const focusStates = [];
  const browser = {
    async navigate(tabId, url) {
      events.push({ type: "navigate", tabId, url });
    },
    async bringToFront(tabId) {
      events.push({ type: "bring_to_front", tabId });
    },
    async cdp(tabId, method, params) {
      assert.strictEqual(method, "Emulation.setFocusEmulationEnabled");
      focused = params.enabled;
      focusStates.push(params.enabled);
      events.push({ type: params.enabled ? "focus_enabled" : "focus_disabled", tabId });
    },
    async clickAt(tabId, point) {
      events.push({ type: "click_at", tabId, point });
    },
    async evalValue(tabId, expression) {
      if (expression.includes("isRiskPage:")) {
        return { isRiskPage: false, isLoginPage: false, isSearchPage: true };
      }
      if (expression.includes("(() => window.__bossCardActivationPoint(")) {
        events.push({ type: "locate", tabId });
        return typeof activation === "function"
          ? activation({ focused, paneReads, tabId })
          : activation;
      }
      if (expression.includes("window.__bossPaneState()")) {
        paneReads += 1;
        events.push({ type: "pane_state", tabId });
        return typeof states === "function"
          ? states(paneReads)
          : states[Math.min(paneReads - 1, states.length - 1)];
      }
      return true;
    }
  };
  if (!trustedFocus) delete browser.cdp;
  if (!trustedClick) delete browser.clickAt;
  return {
    browser,
    events,
    focusStates: () => focusStates.slice(),
    paneReads: () => paneReads,
    count: (type) => events.filter((event) => event.type === type).length
  };
}

function paneState(jobId, title = jobId, overrides = {}) {
  return {
    activeJobId: jobId,
    componentCurrentJobId: jobId,
    paneJobId: jobId,
    currentJobId: jobId,
    jobDetailLoading: false,
    title,
    description: "Complete Python RAG Agent job description ".repeat(12),
    bossActiveText: "",
    salary: "",
    experience: "",
    education: "",
    hasRoot: true,
    canScroll: false,
    ...overrides
  };
}

function apiDetailPageFixture({ onXhrSend }) {
  const linkFor = (jobId) => ({ href: `https://www.zhipin.com/job_detail/${jobId}.html` });
  const makeCard = (jobId, data) => {
    const link = linkFor(jobId);
    const wrap = { __vue__: { data } };
    return {
      innerText: `${jobId} unique card`,
      querySelector(selector) { return selector.startsWith("a") ? link : null; },
      closest(selector) { return selector === ".job-card-wrap" ? wrap : null; }
    };
  };
  const cards = [
    makeCard("api-job", { encryptJobId: "api-job", securityId: "fixture-security", lid: "fixture-lid" }),
    makeCard("abort-job", { encryptJobId: "abort-job", securityId: "abort-security", lid: "abort-lid" }),
    makeCard("other-job", { encryptJobId: "other-job", securityId: "other-security", lid: "other-lid" })
  ];
  const document = {
    querySelectorAll(selector) { return selector.includes(".job-card-box") ? cards : []; }
  };
  class FixtureXMLHttpRequest {
    constructor() {
      this.headers = {};
      this.timeout = 0;
      this.withCredentials = false;
      this.status = 0;
      this.responseText = "";
      this.aborted = false;
    }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    send() { onXhrSend?.(this); }
    abort() { this.aborted = true; this.onabort?.(); }
    respond(status, body) {
      this.status = status;
      this.responseText = JSON.stringify(body);
      this.onload?.();
    }
    trigger(event) { this[`on${event}`]?.(); }
  }
  const window = {
    fetch() { throw new Error("BOSS detail helper must use XMLHttpRequest, not fetch"); },
    location: { origin: "https://www.zhipin.com" }
  };
  const context = { window, document, URL, URLSearchParams, XMLHttpRequest: FixtureXMLHttpRequest, Date, setTimeout, clearTimeout };
  vm.runInNewContext(PAGE_HELPERS, context);
  return { window, reinject: () => vm.runInNewContext(PAGE_HELPERS, context) };
}

async function waitForDetailFetchState(window, sessionId, jobId = undefined) {
  let state = jobId === undefined
    ? window.__bossDetailFetchState(sessionId)
    : window.__bossDetailFetchState(sessionId, jobId);
  for (let attempt = 0; attempt < 10 && state.state === "running"; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    state = jobId === undefined
      ? window.__bossDetailFetchState(sessionId)
      : window.__bossDetailFetchState(sessionId, jobId);
  }
  return state;
}
