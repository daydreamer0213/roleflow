const { buildBossSearchUrl, buildBossScanTargets } = require("../../adapters/sites/boss");
const { canonicalizeBossSearchTemplate } = require("../../core/inherited_search_scope");
const {
  inspectBossOperatorTabs,
  assertBossRuntimeTabBindings
} = require("../../core/workspace_tabs");

function chooseInitialSearchKeyword(planRecord = {}) {
  const plan = planRecord?.plan && typeof planRecord.plan === "object"
    ? planRecord.plan
    : planRecord;
  const rank = { A: 0, B: 1, C: 2 };
  return (Array.isArray(plan?.keywords) ? plan.keywords : [])
    .map((item, index) => ({
      word: String(typeof item === "string" ? item : item?.word || "").replace(/\s+/g, " ").trim(),
      priority: String(typeof item === "object" ? item?.priority || "B" : "B").toUpperCase(),
      index
    }))
    .filter((item) => item.word)
    .sort((left, right) => (rank[left.priority] ?? 1) - (rank[right.priority] ?? 1) || left.index - right.index)[0]?.word || "";
}

async function prepareInitialSearchPage({ plan, workflow, browser, adapter } = {}) {
  let keyword = chooseInitialSearchKeyword(plan) || chooseInitialSearchKeyword(workflow);
  if (!keyword) return { status: "skipped", reason: "keyword_missing" };
  if (!browser || typeof browser.listTabs !== "function") {
    throw new TypeError("prepareInitialSearchPage requires browser.listTabs()");
  }
  if (!adapter
    || typeof adapter.preflight !== "function"
    || typeof adapter.navigateWithPacing !== "function"
    || typeof adapter.assertSearchPage !== "function") {
    throw new TypeError("prepareInitialSearchPage requires a BOSS site adapter");
  }

  const inspected = await inspectBossOperatorTabs({
    browser,
    inspectTab: (tabId) => adapter.preflight({ tabId })
  });
  const currentUrl = new URL(String(inspected.searchState?.url || inspected.searchTab.url || ""));
  if (String(currentUrl.searchParams.get("query") || "").trim()) {
    return { status: "skipped", reason: "query_present" };
  }
  let searchTemplate = currentUrl.toString();
  const frozenTemplate = workflow?.planner?.searchScope?.templateUrl;
  const currentTemplate = new URL(canonicalizeBossSearchTemplate(searchTemplate).url);
  if (!currentTemplate.search && frozenTemplate) {
    // Only repair an empty startup page; existing user filters always win.
    searchTemplate = canonicalizeBossSearchTemplate(frozenTemplate).url;
    keyword = chooseInitialSearchKeyword(workflow) || keyword;
  } else if (!currentTemplate.search && workflow?.planner?.acquisitionMode === "generated") {
    keyword = chooseInitialSearchKeyword(workflow) || keyword;
    const target = buildBossScanTargets({
      keywords: [keyword], cityScopes: workflow.planner.cityScopes,
      nativeFilters: workflow.planner.nativeFilters
    })[0];
    searchTemplate = buildBossSearchUrl({ cityCode: target.city.cityCode, nativeFilters: target.lane });
  }

  const expectedSearchTabId = inspected.searchTab.id;
  const expectedCommunicationTabId = inspected.communicationTab.id;
  const assertTabBindings = async () => assertBossRuntimeTabBindings(
    await browser.listTabs({ scope: "boss" }),
    { expectedSearchTabId, expectedCommunicationTabId }
  );
  const targetUrl = buildBossSearchUrl({
    keyword,
    searchTemplate
  });
  await adapter.navigateWithPacing(expectedSearchTabId, targetUrl, "list", {
    enforceBudget: true,
    assertTabBindings
  });
  await adapter.assertSearchPage(expectedSearchTabId);
  return { status: "prepared", tabId: expectedSearchTabId };
}

module.exports = { chooseInitialSearchKeyword, prepareInitialSearchPage };
