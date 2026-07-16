const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { chooseAutomationTab } = require("../src/adapters/browser/edge_control");
const { BossSiteAdapter, parseBossFilterCatalog } = require("../src/adapters/sites/boss");
const { resolveNativeFilterSnapshot } = require("../src/core/platform_filters");
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

(async () => {
  await preflightSmoke();
  await riskPreflightSmoke();
  await scrollSmoke();
  await delayedAppendAtBottomSmoke();
  await confirmedListEndSmoke();
  await scrollSafetyLimitSmoke();
  await delayedListSmoke();
  await paneSwitchSmoke();
  await leftCardMetadataAvoidsPaneScrollSmoke();
  await fullDetailCoverageSmoke();
  await fairDetailAllocationSmoke();
  await priorityDetailBudgetSmoke();
  await reusableDetailSmoke();
  await changedCardFactsRejectCacheSmoke();
  await detailSafetyLimitSmoke();
  await detailFailureDedupeSmoke();
  await targetIsolationSmoke();
  await partialTargetCheckpointSmoke();
  await pageBudgetSmoke();
  await riskControlSmoke();
  await refreshSafetySmoke();
  storageSmoke();
  console.log("source_acquisition_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function preflightSmoke() {
  const oldSearch = { id: "old-search", active: false, url: "https://www.zhipin.com/web/geek/jobs?query=old" };
  const activeChat = { id: "active-chat", active: true, url: "https://www.zhipin.com/web/geek/chat" };
  const usableSearch = { ...activeBoss, active: false };
  const inspected = [];
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
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {} });
  const state = await adapter.preflight();
  assert.strictEqual(state.tabId, usableSearch.id);
  assert.strictEqual(state.loggedIn, true);
  assert.deepStrictEqual(inspected, [oldSearch.id, usableSearch.id, activeChat.id]);
}

async function riskPreflightSmoke() {
  const browser = {
    async listTabs() {
      return [
        { id: "healthy", active: true, url: activeBoss.url },
        { id: "verify", active: false, url: "https://www.zhipin.com/web/passport/zp/verify" }
      ];
    },
    async evalValue(tabId) {
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

async function paneSwitchSmoke() {
  let paneReads = 0;
  const paneScrolls = [];
  const browser = {
    async evalValue(_tabId, expression) {
      if (expression.includes("isRiskPage:")) return { isRiskPage: false, isLoginPage: false, isSearchPage: true };
      if (expression.startsWith("(() => window.__bossOpenCard")) return { clicked: true, jobId: "pane-job" };
      if (expression.includes("window.__bossPaneState()")) {
        paneReads += 1;
        if (paneReads === 1) {
          return {
            currentJobId: "pane-job",
            title: "AI应用开发",
            description: "短内容",
            bossActiveText: "",
            salary: "10-15K",
            experience: "1-3年",
            education: "本科",
            canScroll: true
          };
        }
        return {
          currentJobId: "pane-job",
          title: "AI应用开发",
          description: "完整职位描述 Python RAG Agent ".repeat(20),
          bossActiveText: "今日活跃",
          salary: "10-15K",
          experience: "1-3年",
          education: "本科",
          canScroll: true
        };
      }
      if (expression.includes("window.__bossScrollPane(false)")) paneScrolls.push("down");
      if (expression.includes("window.__bossScrollPane(true)")) paneScrolls.push("top");
      return true;
    }
  };
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {}, randomFn: () => 0 });
  const detail = await adapter.readCardDetail("pane-tab", {
    title: "AI应用开发",
    url: "https://www.zhipin.com/job_detail/pane-job.html"
  }, 0);
  assert(detail.description.length >= 120);
  assert.strictEqual(detail.bossActiveText, "今日活跃");
  assert.deepStrictEqual(paneScrolls, ["down", "top"]);
}

async function leftCardMetadataAvoidsPaneScrollSmoke() {
  const paneScrolls = [];
  const browser = {
    async evalValue(_tabId, expression) {
      if (expression.includes("isRiskPage:")) return { isRiskPage: false, isLoginPage: false, isSearchPage: true };
      if (expression.startsWith("(() => window.__bossOpenCard")) return { clicked: true, jobId: "card-facts" };
      if (expression.includes("window.__bossPaneState()")) {
        return {
          currentJobId: "card-facts",
          title: "AI应用开发",
          description: "完整职位描述 Python RAG Agent ".repeat(20),
          bossActiveText: "",
          salary: "",
          experience: "",
          education: "",
          canScroll: true
        };
      }
      if (expression.includes("window.__bossScrollPane(false)")) paneScrolls.push("down");
      if (expression.includes("window.__bossScrollPane(true)")) paneScrolls.push("top");
      return true;
    }
  };
  const adapter = new BossSiteAdapter({ browser, sleepFn: async () => {}, randomFn: () => 0 });
  const detail = await adapter.readCardDetail("pane-tab", {
    title: "AI应用开发",
    url: "https://www.zhipin.com/job_detail/card-facts.html",
    salary: "10-15K",
    experience: "1-3年",
    bossActiveText: "今日活跃"
  }, 0);
  assert(detail.description.length >= 120);
  assert.deepStrictEqual(paneScrolls, ["top"]);
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
  adapter.readCardDetail = async (_tabId, job) => ({
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
  adapter.readCardDetail = async (_tabId, job) => ({
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
  let navigations = 0;
  adapter.navigateWithPacing = async (_tabId, url) => {
    if (navigations >= 1) {
      throw Object.assign(new Error("page budget"), { code: "BOSS_PAGE_BUDGET_REACHED" });
    }
    navigations += 1;
    browser.keyword = new URL(url).searchParams.get("query");
  };
  adapter.collectCards = async () => [card(browser.keyword)];
  adapter.readCardDetail = async (_tabId, job) => ({
    description: `完整职位描述 ${job.title} Python RAG `.repeat(12),
    bossActiveText: "今日活跃",
    salary: job.salary,
    experience: job.experience,
    education: job.education
  });
  const checkpoints = [];
  const jobs = await adapter.scanBrowser({
    tabId: activeBoss.id,
    keywords: ["first", "second", "third"],
    cityScopes: [{ city: "广州", cityCode: "101280100" }],
    maxCards: 20,
    maxDetailTotal: 3,
    onTargetComplete: async (result) => checkpoints.push(result),
    scoreQuick: () => 1
  });
  assert.strictEqual(jobs.length, 1);
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
  adapter.readCardDetail = async () => {
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
  adapter.readCardDetail = async (_tabId, job) => {
    reads.push(job.sourceId);
    return {
      description: `完整职位描述 ${job.title} Python RAG `.repeat(12),
      bossActiveText: "今日活跃",
      salary: job.salary,
      experience: job.experience,
      education: job.education
    };
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
  adapter.readCardDetail = async (_tabId, job) => {
    reads.push(job.title);
    return { description: `完整职位描述 ${job.title} Python RAG `.repeat(12), bossActiveText: "今日活跃" };
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
  adapter.readCardDetail = async (_tabId, job) => {
    reads.push(job.title);
    return { description: `完整职位描述 ${job.title} Python RAG `.repeat(12), bossActiveText: "今日活跃" };
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
  adapter.readCardDetail = async (_tabId, job) => {
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
  adapter.readCardDetail = async (_tabId, job) => {
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
  adapter.readCardDetail = async (_tabId, job) => {
    reads += 1;
    return { description: `完整职位描述 ${job.title} Python RAG `.repeat(12), bossActiveText: "今日活跃" };
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
  adapter.readCardDetail = async () => {
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
  assert.strictEqual(reads, 8);
  assert.strictEqual(refreshed.length, 8);

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
  assert.strictEqual(probes, 8);
  assert.strictEqual(probed.length, 8);
  assert(probed.every((job) => job.bossActiveText === "今日活跃"));
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
