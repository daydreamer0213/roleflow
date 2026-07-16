const fs = require("fs");
const { mergeJobMetadata } = require("../../core/job_metadata");
const { normalizePlatformFilterCatalog } = require("../../core/platform_filters");

const DEFAULT_CITY_CODE = "101280100";
const DETAIL_PACING = Object.freeze({
  microEvery: [9, 13],
  microDelayMs: [7000, 12000],
  macroEvery: [32, 40],
  macroDelayMs: [90000, 150000]
});
const BOSS_FILTER_FIELDS = {
  salary: { key: "salary", label: "\u85aa\u8d44\u5f85\u9047", urlParam: "salary", selection: "single", semantic: "salary_range" },
  exp: { key: "experience", label: "\u5de5\u4f5c\u7ecf\u9a8c", urlParam: "experience", selection: "multiple", semantic: "experience" },
  degree: { key: "degree", label: "\u5b66\u5386\u8981\u6c42", urlParam: "degree", selection: "single", semantic: "choice" },
  jobType: { key: "jobType", label: "\u6c42\u804c\u7c7b\u578b", urlParam: "jobType", selection: "single", semantic: "choice" },
  scale: { key: "scale", label: "\u516c\u53f8\u89c4\u6a21", urlParam: "scale", selection: "single", semantic: "choice" },
  stage: { key: "stage", label: "\u878d\u8d44\u9636\u6bb5", urlParam: "stage", selection: "single", semantic: "choice" }
};
const PAGE_HELPERS = String.raw`
(() => {
  window.__bossDecode = function(value) {
    const map = {
      0xe031: "0", 0xe032: "1", 0xe033: "2", 0xe034: "3", 0xe035: "4",
      0xe036: "5", 0xe037: "6", 0xe038: "7", 0xe039: "8", 0xe03a: "9"
    };
    return String(value || "")
      .replace(/[\ue031-\ue03a]/g, (ch) => map[ch.charCodeAt(0)] || ch)
      .replace(/[ \t]+/g, " ")
      .trim();
  };

  window.__bossLines = function(el) {
    return window.__bossDecode(el.innerText || "").split(/\n+/).map((x) => x.trim()).filter(Boolean);
  };

  window.__bossJobMetadata = function(value) {
    const text = (Array.isArray(value) ? value.join(" ") : String(value || "")).replace(/\s+/g, " ").trim();
    const salary = text.match(/\d+\s*[-~—]\s*\d+\s*[kK](?:\s*[·.]\s*\d+\s*薪)?|\d+\s*[kK](?:\s*[·.]\s*\d+\s*薪)?|面议/)?.[0] || "";
    const strongExperience = text.match(/(?:工作|开发|相关)?经验\s*(?:不限|无|\d+\s*[-~—]\s*\d+\s*年|\d+\s*年以上)|(?:经验不限|无经验|应届(?:生)?|在校生?)/)?.[0];
    const experience = (strongExperience || text.match(/\b\d+\s*[-~—]\s*\d+\s*年(?:工作|开发|相关)?(?:经验)?|\b\d+\s*年以上(?:工作|开发|相关)?(?:经验)?/)?.[0] || "").replace(/^(?:工作|开发|相关)?经验\s*/, "");
    const education = text.match(/学历不限|大专(?:及以上)?|本科(?:及以上)?|硕士(?:及以上)?|博士(?:及以上)?/)?.[0] || "";
    return { salary, experience, education };
  };

  window.__bossActivity = function(value) {
    const text = window.__bossDecode(value || "");
    const readable = text.match(/刚刚活跃|今日活跃|今天活跃|昨日活跃|昨天活跃|近半年活跃|半年内活跃|近(?:\d+|一|二|三|四|五|六|七|八|九|十)个?月活跃|\d+(?:日|周|月|年)内活跃|本周活跃|本月活跃/);
    if (readable) return /刚刚|今日|今天/.test(readable[0]) ? "今日活跃" : readable[0].replace(/\s+/g, "");
    const online = text.match(/(?:^|\s)(?:[\u4e00-\u9fa5]{1,8}(?:先生|女士)|HR|hr)\s+(在线)(?=\s|$)/);
    return online ? "今日活跃" : "";
  };

  window.__bossCards = function() {
    let cards = Array.from(document.querySelectorAll(".rec-job-list .job-card-box, .job-list-container .job-card-box, .job-card-wrapper"))
      .filter((card) => card.querySelector('a[href*="/job_detail/"]'));
    if (!cards.length) {
      cards = Array.from(document.querySelectorAll('a[href*="/job_detail/"]'))
        .map((link) => link.closest(".job-card-box, .job-card-wrapper, li[class*='job']"))
        .filter(Boolean);
    }
    const seen = new Set();
    return cards.filter((card) => {
      const key = window.__bossDecode(card.innerText).replace(/\s+/g, " ").slice(0, 180);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  window.__bossExtractCards = function(maxCards) {
    const salaryRe = /\d+\s*[-~—]\s*\d+\s*K(?:·\d+薪)?|\d+\s*K(?:·\d+薪)?|面议/;
    const salaryLineRe = /^(?:\d+\s*[-~—]\s*\d+\s*K(?:·\d+薪)?|\d+\s*K(?:·\d+薪)?|面议)$/;
    const expRe = /经验不限|在校|应届|无经验|\d+年|本科|大专|硕士|博士|学历不限/;
    const cityRe = /^(广州|深圳|佛山|东莞|珠海|北京|上海|杭州|成都|武汉|南京|苏州|远程)($|·)/;
    return window.__bossCards().slice(0, maxCards || 60).map((card, index) => {
      const q = (selector) => card.querySelector(selector);
      const lines = window.__bossLines(card);
      const flat = window.__bossDecode(card.innerText).replace(/\s+/g, " ");
      const title = window.__bossDecode((q(".job-name") || q(".job-title") || {}).innerText || lines[0] || "");
      const metadata = window.__bossJobMetadata(lines);
      const salary = window.__bossDecode((q(".job-salary") || q(".salary") || q(".red") || {}).innerText || metadata.salary || (flat.match(salaryRe) || [""])[0]);
      const companyNode = q(".boss-name") || q(".company-name");
      let company = window.__bossDecode(companyNode?.innerText || "");
      const salaryIndex = lines.findIndex((line) => salaryLineRe.test(line));
      if (!company) {
        company = lines.slice(Math.max(0, salaryIndex + 1)).find((line) => {
          if (!line || line === title || line === salary) return false;
          if (expRe.test(line) || cityRe.test(line) || salaryLineRe.test(line)) return false;
          return line.length <= 40;
        }) || "";
      }
      const href = (card.querySelector('a[href*="job_detail"]') || card.querySelector("a"))?.href || "";
      const onlineIcon = q(".boss-online-icon") || q("[class*='online-icon']");
      return {
        index,
        title,
        company,
        salary,
        experience: metadata.experience,
        education: metadata.education,
        location: window.__bossDecode(q(".company-location")?.innerText || "") || lines.find((line) => cityRe.test(line)) || "",
        tags: lines.filter((line) => expRe.test(line)).slice(0, 8),
        url: href,
        cardText: flat.slice(0, 500),
        bossActiveText: parseActivity(flat) || (onlineIcon ? "今日活跃" : "")
      };
    });

    function parseActivity(text) {
      return window.__bossActivity(text);
    }
  };

  window.__bossScrollList = function() {
    const cards = window.__bossCards();
    let target = cards[0]?.parentElement || null;
    while (target && target !== document.body && target !== document.documentElement) {
      const style = getComputedStyle(target);
      if (/(auto|scroll)/.test(style.overflowY) && target.scrollHeight > target.clientHeight + 8) break;
      target = target.parentElement;
    }
    if (!target || target === document.body || target === document.documentElement || target.scrollHeight <= target.clientHeight + 8) {
      target = document.scrollingElement || document.documentElement;
    }
    if (!target) return { target: "unavailable", before: 0, scrollTop: 0, viewport: 0, scrollHeight: 0, moved: false, atBottom: false };
    const isDocument = target === document.scrollingElement || target === document.documentElement || target === document.body;
    const before = isDocument ? window.scrollY : target.scrollTop;
    const viewport = isDocument ? window.innerHeight : target.clientHeight;
    const height = target.scrollHeight;
    const next = Math.min(Math.max(0, height - viewport), before + Math.max(600, Math.round(viewport * 0.85)));
    if (isDocument) window.scrollTo({ top: next, behavior: "auto" });
    else target.scrollTo({ top: next, behavior: "auto" });
    target.dispatchEvent(new Event("scroll", { bubbles: true }));
    return {
      target: isDocument ? "document" : target.tagName.toLowerCase() + "." + String(target.className || "").trim().replace(/\s+/g, "."),
      before,
      scrollTop: next,
      viewport,
      scrollHeight: height,
      moved: next > before,
      atBottom: next >= Math.max(0, height - viewport - 3)
    };
  };

  window.__bossPaneState = function() {
    const decode = window.__bossDecode || ((value) => String(value || ""));
    const root = document.querySelector(".job-detail-container")
      || document.querySelector(".job-detail")
      || document.querySelector(".detail-content")
      || document.querySelector(".job-detail-box");
    if (!root) return { currentJobId: "", title: "", description: "", bossActiveText: "", salary: "", experience: "", education: "", hasRoot: false };
    const activeCard = document.querySelector(".job-card-wrap.active .job-card-box, .job-card-box.active, .job-card-wrapper.active, li.active[class*='job']");
    const detailLink = root.querySelector('a[href*="job_detail"]') || activeCard?.querySelector('a[href*="job_detail"]');
    const currentJobId = (detailLink?.href?.match(/\/job_detail\/([^/?#]+)\.html/i) || [])[1] || "";
    const header = root.querySelector(".job-primary")
      || root.querySelector(".job-banner")
      || root.querySelector(".job-detail-header")
      || root;
    const titleNode = header.querySelector(".name, .job-name, .job-title, h1, h2") || header;
    const descriptionNode = root.querySelector(".job-sec-text")
      || root.querySelector(".job-detail-body .desc")
      || root.querySelector("p.desc")
      || root.querySelector(".job-detail-section .text")
      || root.querySelector("[class*='job-sec-text']")
      || root.querySelector("[class*='job-detail-section']")
      || root;
    const activityText = decode(root.innerText || "");
    const onlineIcon = root.querySelector(".boss-online-icon, [class*='online-icon']");
    const metadata = (window.__bossJobMetadata || (() => ({})))(decode(header.innerText || ""));
    return {
      currentJobId,
      title: decode(titleNode.innerText || "").split(/\n+/)[0].trim(),
      description: decode(descriptionNode.innerText || "").replace(/\s+/g, " ").slice(0, 12000),
      bossActiveText: (window.__bossActivity || (() => ""))(activityText) || (onlineIcon ? "今日活跃" : ""),
      ...metadata,
      hasRoot: true,
      canScroll: root.scrollHeight > root.clientHeight + 8,
      scrollTop: root.scrollTop,
      scrollHeight: root.scrollHeight,
      clientHeight: root.clientHeight
    };
  };

  window.__bossOpenCard = function(jobId, fallbackIndex, expectedTitle) {
    const cards = window.__bossCards();
    const byId = jobId ? cards.find((card) => {
      const href = (card.querySelector('a[href*="job_detail"]') || card.querySelector("a"))?.href || "";
      return href.includes("/job_detail/" + jobId + ".html");
    }) : null;
    const byTitle = expectedTitle ? cards.find((card) => window.__bossDecode(card.innerText || "").includes(expectedTitle)) : null;
    const card = byId || byTitle || cards[Number(fallbackIndex) || 0];
    if (!card) return { clicked: false, reason: "card_not_found", cardCount: cards.length };
    const target = card.tagName === "A"
      ? (card.closest("li, .job-card-box, .job-card-wrapper") || card)
      : card;
    target.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
    target.click();
    return { clicked: true, cardCount: cards.length };
  };

  window.__bossScrollPane = function(toTop) {
    const root = document.querySelector(".job-detail-container")
      || document.querySelector(".job-detail")
      || document.querySelector(".detail-content")
      || document.querySelector(".job-detail-box");
    if (!root) return { found: false };
    const top = toTop ? 0 : Math.max(0, root.scrollHeight - root.clientHeight);
    root.scrollTo({ top, behavior: "auto" });
    root.dispatchEvent(new Event("scroll", { bubbles: true }));
    return { found: true, top, scrollHeight: root.scrollHeight, clientHeight: root.clientHeight };
  };
  return true;
})()
`;

class BossSiteAdapter {
  constructor({ browser = null, logger = null, sleepFn = sleep, randomFn = Math.random } = {}) {
    this.browser = browser;
    this.logger = logger;
    this.sleep = sleepFn;
    this.random = randomFn;
    this.pageNavigations = 0;
    this.listNavigations = 0;
    this.pageBudget = 90;
    this.resetPacing();
  }

  async preflight({ tabId = null } = {}) {
    if (!this.browser) throw bossError("BOSS_BROWSER_REQUIRED", "BOSS 预检需要浏览器连接。");
    const tabs = typeof this.browser.listTabs === "function" ? await this.browser.listTabs() : [];
    const fallbackId = tabId || (!tabs.length ? await this.browser.activeTabId() : null);
    const candidates = (tabId
      ? [tabs.find((item) => String(item.id) === String(tabId)) || { id: tabId, url: "", title: "" }]
      : tabs.filter((item) => /zhipin\.com/i.test(String(item.url || ""))).sort(compareBossTabs));
    if (!candidates.length && fallbackId) candidates.push({ id: fallbackId, url: "", title: "" });
    if (!candidates.length) throw bossError("BOSS_TAB_REQUIRED", "Edge 中没有可控制的 BOSS 直聘标签页。");

    const inspected = [];
    const healthy = [];
    for (const tab of candidates) {
      try {
        const state = await this.browser.evalValue(tab.id, `(() => {
          const url = location.href;
          const path = location.pathname;
          const isBoss = /(^|\\.)zhipin\\.com$/i.test(location.hostname);
          const hasVisibleLoginForm = [...document.querySelectorAll(".sign-form, .login-register, [class*='login-form']")].some((element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
          });
          const isLoginPage = /\\/web\\/user\\//i.test(path) || hasVisibleLoginForm;
          const isRiskPage = /\\/web\\/passport\\/zp\\/verify/i.test(path)
            || /安全验证|访问异常|行为验证/.test(document.title || "");
          const hasUserSurface = Boolean(document.querySelector(".nav-figure, .user-nav, [ka='header-personal'], [ka='header-username'], [class*='user-nav']"));
          const hasJobStructure = Boolean(document.querySelector(".job-list-container, .rec-job-list, .job-card-box, .job-detail-container"));
          const isSearchPage = /\\/web\\/geek\\/jobs/i.test(path);
          return {
            url,
            title: document.title || "",
            isBoss,
            isLoginPage,
            isRiskPage,
            loggedIn: isBoss && !isLoginPage && !isRiskPage && (hasUserSurface || hasJobStructure),
            isSearchPage,
            hasJobStructure
          };
        })()`);
        const result = { tabId: tab.id, tab: { id: tab.id, url: tab.url || state?.url || "", title: tab.title || state?.title || "" }, ...state };
        inspected.push(result);
        if (result.isBoss && !result.isLoginPage && !result.isRiskPage && result.loggedIn) healthy.push(result);
      } catch (error) {
        inspected.push({ tabId: tab.id, url: tab.url || "", error: error.message || String(error) });
      }
    }
    if (inspected.some((item) => item.isRiskPage)) {
      throw bossError("BOSS_RISK_CONTROL", "BOSS 当前要求安全验证，请完成验证并稍后重试。");
    }
    const selected = healthy.find((item) => item.isSearchPage);
    const fallback = selected || healthy[0];
    if (fallback) {
      this.logger?.info("boss_browser_preflight_ok", {
        tabId: fallback.tabId,
        url: fallback.url || fallback.tab.url,
        isSearchPage: fallback.isSearchPage,
        hasJobStructure: fallback.hasJobStructure,
        inspectedTabs: inspected.length
      });
      return fallback;
    }
    if (inspected.some((item) => item.isBoss)) throw bossError("BOSS_LOGIN_REQUIRED", "已找到 BOSS 标签页，但未确认可用登录状态。请在搜索页完成登录后重试。");
    throw bossError("BOSS_TAB_REQUIRED", "Edge 中没有可用的 BOSS 直聘标签页。");
  }

  async scan(options = {}) {
    const { input } = options;
    if (!input) {
      return this.scanBrowser(options);
    }
    const jobs = JSON.parse(fs.readFileSync(input, "utf8"));
    return jobs.map(normalizeBossJob);
  }

  async discoverFilterCatalog({ cityCode = DEFAULT_CITY_CODE, keyword = "Python", tabId = null } = {}) {
    if (!this.browser) throw new Error("BOSS 筛选目录预读需要浏览器连接。");
    const targetTabId = tabId || await this.browser.activeTabId();
    const url = buildBossSearchUrl({ keyword, cityCode });
    await this.navigateWithPacing(targetTabId, url, "catalog", { enforceBudget: false });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await this.assertSearchPage(targetTabId);
      const rawFields = await this.browser.evalValue(targetTabId, `(() => Array.from(document.querySelectorAll(".condition-filter-select")).map((node) => ({
        label: (node.querySelector(".current-select .placeholder-text")?.textContent || "").replace(/\\s+/g, " ").trim(),
        options: Array.from(node.querySelectorAll("[ka*='sel-job-rec-']")).map((option) => ({
          ka: option.getAttribute("ka") || "",
          label: (option.textContent || "").replace(/\\s+/g, " ").trim()
        }))
      })))()`);
      const catalog = parseBossFilterCatalog(rawFields);
      if (Object.keys(catalog.fields).length >= 2) {
        this.logger?.info("boss_filter_catalog_discovered", {
          fieldCount: Object.keys(catalog.fields).length,
          optionCount: Object.values(catalog.fields).reduce((total, field) => total + field.options.length, 0),
          cityCode
        });
        return catalog;
      }
      await this.sleep(600);
    }
    throw new Error("BOSS 筛选目录读取失败：页面未返回薪资或经验条件。");
  }

  async navigateWithPacing(tabId, url, kind, { enforceBudget = true } = {}) {
    if (enforceBudget && kind === "list" && this.listNavigations >= this.pageBudget) {
      const error = new Error(`BOSS 本批列表页面达到安全上限 ${this.pageBudget}，已停止继续搜索。`);
      error.code = "BOSS_PAGE_BUDGET_REACHED";
      throw error;
    }
    await this.browser.navigate(tabId, url);
    this.pageNavigations += 1;
    if (kind === "list") this.listNavigations += 1;
    await this.waitWithPacing(kind);
  }

  async waitWithPacing(kind) {
    const ranges = {
      catalog: [1500, 2500],
      list: [1800, 3200],
      detail: [1800, 3000],
      retry: [400, 800],
      scroll: [900, 1600],
      card: [1000, 2000],
      card_retry: [300, 700],
      list_ready: [450, 750],
      refresh: [1200, 2200],
      target: [2500, 4500]
    };
    const [min, max] = ranges[kind] || ranges.list;
    await this.sleep(randomBetween(min, max, this.random));
    if (!["catalog", "list", "detail", "scroll", "card", "refresh", "target"].includes(kind)) return;
    this.pacedActions += 1;
    if (this.pacedActions < this.nextPacingCooldownAt) return;
    const cooldownMs = randomBetween(4000, 7000, this.random);
    this.logger?.info("boss_pacing_cooldown", { pacedActions: this.pacedActions, cooldownMs });
    await this.sleep(cooldownMs);
    this.nextPacingCooldownAt += randomBetween(18, 26, this.random);
  }

  resetPacing() {
    this.pacedActions = 0;
    this.nextPacingCooldownAt = randomBetween(18, 26, this.random);
    this.detailActions = 0;
    this.nextDetailMicroCooldownAt = randomBetween(...DETAIL_PACING.microEvery, this.random);
    this.nextDetailMacroCooldownAt = randomBetween(...DETAIL_PACING.macroEvery, this.random);
  }

  async waitAfterDetailAction() {
    this.detailActions += 1;
    if (this.detailActions >= this.nextDetailMacroCooldownAt) {
      const cooldownMs = randomBetween(...DETAIL_PACING.macroDelayMs, this.random);
      console.error(`[boss] 已读取 ${this.detailActions} 个右栏详情，阶段冷却 ${Math.ceil(cooldownMs / 1000)} 秒后继续`);
      this.logger?.info("boss_detail_macro_cooldown", { detailActions: this.detailActions, cooldownMs });
      await this.sleep(cooldownMs);
      this.nextDetailMacroCooldownAt += randomBetween(...DETAIL_PACING.macroEvery, this.random);
      while (this.nextDetailMicroCooldownAt <= this.detailActions) {
        this.nextDetailMicroCooldownAt += randomBetween(...DETAIL_PACING.microEvery, this.random);
      }
      return;
    }
    if (this.detailActions >= this.nextDetailMicroCooldownAt) {
      const cooldownMs = randomBetween(...DETAIL_PACING.microDelayMs, this.random);
      this.logger?.info("boss_detail_micro_cooldown", { detailActions: this.detailActions, cooldownMs });
      await this.sleep(cooldownMs);
      this.nextDetailMicroCooldownAt += randomBetween(...DETAIL_PACING.microEvery, this.random);
    }
  }

  async scanBrowser(options) {
    if (!this.browser) throw new Error("真实扫描需要 --browser edge。");
    const keywords = options.keywords?.length ? options.keywords : ["AI应用开发"];
    const keywordPlan = normalizeKeywordPlan(keywords, options.keywordPlan)
      .sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority) || left.order - right.order);
    const cityScopes = normalizeCityScopes(options);
    const tabId = options.tabId || await this.browser.activeTabId();
    const maxCards = Number(options.maxCards || 60);
    const maxDetailTotal = Math.min(1000, Math.max(0, Number(options.maxDetailTotal ?? 300)));
    const nativeFilterLanes = normalizeNativeFilterLanes(options.nativeFilters);
    this.pageNavigations = 0;
    this.listNavigations = 0;
    this.pageBudget = normalizePageBudget(options.browserPageBudget);
    this.resetPacing();
    const candidates = new Map();
    const detailAttempts = new Set();
    let detailsRead = 0;
    let detailsReused = 0;
    let detailsFailed = 0;
    let successfulTargets = 0;
    let fatalError = null;
    const targetCount = cityScopes.length * keywordPlan.length * nativeFilterLanes.length;
    let targetPosition = 0;

    scanTargets: for (const [cityOrder, city] of cityScopes.entries()) {
      for (const item of keywordPlan) {
        const keyword = item.word;
        const cardLimit = weightedCardLimit(item.priority, maxCards);
        for (const lane of nativeFilterLanes) {
          targetPosition += 1;
          const laneId = lane.id || "default";
          const targetKey = [city.cityCode, keyword, laneId].join("|");
          const startedAt = new Date().toISOString();
          let targetJobs = [];
          let targetEntries = [];
          try {
            const url = buildBossSearchUrl({ keyword, cityCode: city.cityCode, nativeFilters: lane });
            console.error(`[boss] 打开城市：${city.city || city.cityCode} · ${keyword}（${item.priority}，最多 ${cardLimit} 条）`);
            this.logger?.info("boss_keyword_opened", {
              targetKey,
              keyword,
              priority: item.priority,
              city: city.city || "",
              cityCode: city.cityCode,
              cardLimit,
              nativeFilterLane: laneId,
              nativeFilters: normalizeNativeFilters(lane)
            });
            await this.navigateWithPacing(tabId, url, "list");
            await this.assertSearchPage(tabId);
            const cards = await this.collectCards(tabId, cardLimit);
            console.error(`[boss] ${city.city || city.cityCode} · ${keyword} 列表岗位：${cards.length}`);
            this.logger?.info("boss_cards_collected", { targetKey, keyword, city: city.city || "", cardCount: cards.length, nativeFilterLane: laneId });
            const entries = cards.map((card, index) => {
              const cardJob = normalizeBossJob({ ...card, keyword, source: "boss", searchCity: city.city || "" });
              const reusable = typeof options.getReusableDetail === "function" ? options.getReusableDetail(cardJob) : null;
              const job = reusable?.description ? normalizeBossJob({
                ...cardJob,
                ...reusable,
                bossActiveText: cardJob.bossActiveText || reusable.bossActiveText || "",
                detailRead: true
              }) : cardJob;
              if (reusable?.description) job.detailReused = true;
              return {
                job,
                keyword,
                priority: item.priority,
                keywordOrder: item.order,
                cityOrder,
                index,
                laneRank: Number(lane.rank || 0),
                laneId,
                quickScore: options.scoreQuick ? options.scoreQuick(job) : 0
              };
            });
            targetEntries = entries;

            const eligibleDetailEntries = [];
            for (const entry of entries) {
              const key = bossSourceId(entry.job);
              const existing = candidates.get(key)?.job;
              const detailRequired = typeof options.shouldReadDetail !== "function" || options.shouldReadDetail(entry.job) !== false;
              entry.job.detailRequired = detailRequired;
              if (entry.job.detailReused && !existing?.detailRead) detailsReused += 1;
              if (detailRequired && !entry.job.detailRead && !existing?.detailRead && !detailAttempts.has(key)) {
                eligibleDetailEntries.push(entry);
              }
              mergeScanCandidate(candidates, entry);
            }
            const remainingTargets = Math.max(1, targetCount - targetPosition + 1);
            const remainingDetailBudget = Math.max(0, maxDetailTotal - detailAttempts.size);
            const configuredDetailLimit = Number(options.detailLimits?.[item.priority]);
            const targetDetailQuota = Number.isFinite(configuredDetailLimit)
              ? Math.min(Math.max(0, configuredDetailLimit), remainingDetailBudget)
              : Math.ceil(remainingDetailBudget / remainingTargets);
            const detailEntries = eligibleDetailEntries.slice(0, targetDetailQuota);
            const selectedDetailIds = new Set(detailEntries.map((entry) => bossSourceId(entry.job)));
            for (const entry of eligibleDetailEntries) {
              const key = bossSourceId(entry.job);
              if (selectedDetailIds.has(key)) {
                detailAttempts.add(key);
                continue;
              }
              const pendingJob = {
                ...entry.job,
                detailErrorCode: remainingTargets === 1 ? "BOSS_DETAIL_SAFETY_LIMIT" : "BOSS_DETAIL_FAIR_SHARE_PENDING"
              };
              mergeScanCandidate(candidates, { ...entry, job: pendingJob });
            }
            this.logger?.info("boss_target_detail_allocation", {
              targetKey,
              targetPosition,
              targetCount,
              remainingTargets,
              remainingDetailBudget,
              eligibleDetails: eligibleDetailEntries.length,
              configuredDetailLimit: Number.isFinite(configuredDetailLimit) ? configuredDetailLimit : null,
              targetDetailQuota,
              selectedDetails: detailEntries.length
            });
            targetJobs = targetEntries.map((entry) => candidates.get(bossSourceId(entry.job))?.job || entry.job);

            for (const entry of detailEntries) {
              console.error(`[boss] 读右栏：${keyword}（${item.priority}） ${entry.job.title}`);
              try {
                const detail = await this.readCardDetail(tabId, entry.job, entry.index);
                const detailedJob = normalizeBossJob({
                  ...entry.job,
                  description: detail.description,
                  salary: detail.salary || entry.job.salary || "",
                  experience: detail.experience || entry.job.experience || "",
                  education: detail.education || entry.job.education || "",
                  bossActiveText: detail.bossActiveText || entry.job.bossActiveText || "",
                  detailRequired: true,
                  detailRead: true
                });
                detailedJob.detailRequired = true;
                mergeScanCandidate(candidates, { ...entry, job: detailedJob });
                detailsRead += 1;
                await this.waitAfterDetailAction();
              } catch (error) {
                detailsFailed += 1;
                this.logger?.warn("boss_card_detail_read_failed", {
                  targetKey,
                  keyword,
                  jobId: entry.job.sourceId || entry.job.url || "",
                  errorCode: error?.code || "BOSS_CARD_DETAIL_READ_FAILED",
                  errorMessage: error?.message || String(error)
                });
                const failedJob = { ...entry.job, detailRequired: true, detailRead: false, detailErrorCode: error?.code || "BOSS_CARD_DETAIL_READ_FAILED" };
                mergeScanCandidate(candidates, { ...entry, job: failedJob });
                if (isFatalBrowserError(error)) throw error;
                await this.waitAfterDetailAction();
              }
            }

            targetJobs = targetEntries.map((entry) => candidates.get(bossSourceId(entry.job))?.job || entry.job);
            successfulTargets += 1;
            if (typeof options.onTargetComplete === "function") {
              await options.onTargetComplete({
                targetKey,
                city: city.city || "",
                cityCode: city.cityCode,
                keyword,
                laneId,
                status: "completed",
                jobs: targetJobs,
                jobCount: targetJobs.length,
                startedAt,
                finishedAt: new Date().toISOString()
              });
            }
            await this.waitWithPacing("target");
          } catch (error) {
            this.logger?.warn("boss_scan_target_failed", {
              targetKey,
              keyword,
              city: city.city || "",
              cityCode: city.cityCode,
              laneId,
              errorCode: error?.code || "BOSS_SCAN_TARGET_FAILED",
              errorMessage: error?.message || String(error)
            });
            targetJobs = targetEntries.map((entry) => candidates.get(bossSourceId(entry.job))?.job || entry.job);
            if (typeof options.onTargetComplete === "function") {
              await options.onTargetComplete({
                targetKey,
                city: city.city || "",
                cityCode: city.cityCode,
                keyword,
                laneId,
                status: "failed",
                jobs: targetJobs,
                jobCount: targetJobs.length,
                errorCode: error?.code || "BOSS_SCAN_TARGET_FAILED",
                errorMessage: error?.message || String(error),
                startedAt,
                finishedAt: new Date().toISOString()
              });
            }
            if (isFatalBrowserError(error)) {
              fatalError = error;
              break scanTargets;
            }
            await this.waitWithPacing("target");
          }
        }
      }
    }
    const resultJobs = [...candidates.values()].map((item) => item.job);
    const detailRequired = resultJobs.filter((job) => job.detailRequired).length;
    const detailReadTotal = resultJobs.filter((job) => job.detailRequired && job.detailRead).length;
    const detailsPending = resultJobs.filter((job) => job.detailRequired && !job.detailRead).length;
    this.logger?.info("boss_detail_plan", {
      uniqueCandidates: resultJobs.length,
      detailRequired,
      detailAttempts: detailAttempts.size,
      detailsRead: detailReadTotal,
      detailsReadNew: detailsRead,
      detailsReused,
      detailsFailed,
      detailsPending,
      maxDetailTotal,
      listPageBudget: this.pageBudget,
      listPagesUsed: this.listNavigations
    });
    if (fatalError?.code === "BOSS_RISK_CONTROL" && typeof options.onRiskControl === "function") {
      await options.onRiskControl({
        errorCode: fatalError.code,
        errorMessage: fatalError.message,
        detailsRead,
        detailsReused,
        candidates: resultJobs.length
      });
    }
    if (!successfulTargets && fatalError) throw fatalError;
    if (!successfulTargets) throw bossError("BOSS_SCAN_NO_TARGET_SUCCEEDED", "本轮所有 BOSS 搜索目标均失败，已保留逐目标错误记录。");
    return resultJobs;
  }

  async refreshDetails(jobs, { limit = 8, tabId = null, onAttempt = null } = {}) {
    if (!this.browser) throw new Error("补读岗位详情需要浏览器连接。");
    const selectedTabId = tabId || await this.browser.activeTabId();
    const selected = (jobs || []).filter((job) => job?.url).slice(0, Math.min(8, Math.max(1, Number(limit) || 8)));
    this.pageNavigations = 0;
    this.listNavigations = 0;
    this.resetPacing();
    const refreshed = [];
    for (const job of selected) {
      console.error(`[boss] 补读详情：${job.title}`);
      try {
        const detail = await this.readDetail(selectedTabId, job.url);
        if (!detail.description) throw new Error("岗位详情未加载完成");
        const normalized = normalizeBossJob({
          ...job,
          description: detail.description,
          salary: detail.salary || job.salary || "",
          experience: detail.experience || job.experience || "",
          education: detail.education || job.education || "",
          bossActiveText: detail.bossActiveText || job.bossActiveText || "",
          detailRead: true
        });
        refreshed.push(normalized);
        if (typeof onAttempt === "function") await onAttempt({ job, result: "success" });
        await this.waitWithPacing("refresh");
      } catch (error) {
        this.logger?.warn("boss_detail_refresh_failed", {
          jobId: job.sourceId || job.url || "",
          errorCode: error?.code || "BOSS_DETAIL_REFRESH_FAILED",
          errorMessage: error?.message || String(error)
        });
        if (typeof onAttempt === "function") await onAttempt({
          job,
          result: "failed",
          errorCode: error?.code || "BOSS_DETAIL_REFRESH_FAILED",
          errorMessage: error?.message || String(error)
        });
        if (isFatalBrowserError(error)) throw error;
        await this.waitWithPacing("refresh");
      }
    }
    return refreshed.map((job) => ({ ...job, detailRequired: true, detailRead: true }));
  }

  async probeActivities(jobs, { limit = 8, tabId = null, onAttempt = null } = {}) {
    if (!this.browser) throw new Error("更新招聘方活跃状态需要浏览器连接。");
    const selectedTabId = tabId || await this.browser.activeTabId();
    const selected = (jobs || []).filter((job) => job?.url).slice(0, Math.min(8, Math.max(1, Number(limit) || 8)));
    this.pageNavigations = 0;
    this.listNavigations = 0;
    this.resetPacing();
    const refreshed = [];
    for (const job of selected) {
      console.error(`[boss] 更新活跃状态：${job.title}`);
      try {
        const bossActiveText = await this.readActivity(selectedTabId, job.url);
        if (!bossActiveText) throw bossError("BOSS_ACTIVITY_UNAVAILABLE", "页面没有返回可识别的招聘方活跃状态");
        refreshed.push(normalizeBossJob({ ...job, bossActiveText }));
        if (typeof onAttempt === "function") await onAttempt({ job, result: "success" });
        await this.waitWithPacing("refresh");
      } catch (error) {
        this.logger?.warn("boss_activity_probe_failed", {
          jobId: job.sourceId || job.url || "",
          errorCode: error?.code || "BOSS_ACTIVITY_PROBE_FAILED",
          errorMessage: error?.message || String(error)
        });
        if (typeof onAttempt === "function") await onAttempt({
          job,
          result: "failed",
          errorCode: error?.code || "BOSS_ACTIVITY_PROBE_FAILED",
          errorMessage: error?.message || String(error)
        });
        if (isFatalBrowserError(error)) throw error;
        await this.waitWithPacing("refresh");
      }
    }
    return refreshed;
  }

  async collectCards(tabId, maxCards) {
    const found = new Map();
    let readinessAttempts = 0;
    while (!found.size && readinessAttempts < 10) {
      await this.assertSearchPage(tabId);
      await this.browser.evalValue(tabId, PAGE_HELPERS);
      const initialCards = await this.browser.evalValue(tabId, `(() => window.__bossExtractCards(${maxCards}))()`);
      for (const card of initialCards || []) {
        const key = bossSourceId(card) || `${card.company}|${card.title}|${card.salary}|${card.cardText}`;
        if (!found.has(key)) found.set(key, card);
      }
      if (found.size) break;
      readinessAttempts += 1;
      await this.waitWithPacing("list_ready");
    }
    if (readinessAttempts) {
      this.logger?.info("boss_list_content_waited", { attempts: readinessAttempts, cardCount: found.size });
    }
    let lastSize = 0;
    let bottomStable = 0;
    const maxRounds = Math.max(12, Math.min(40, Math.ceil(Number(maxCards || 60) / 5) + 4));
    for (let round = 0; round < maxRounds && found.size < maxCards; round += 1) {
      await this.assertSearchPage(tabId);
      await this.browser.evalValue(tabId, PAGE_HELPERS);
      const cards = await this.browser.evalValue(tabId, `(() => window.__bossExtractCards(${maxCards}))()`);
      for (const card of cards || []) {
        const key = bossSourceId(card) || `${card.company}|${card.title}|${card.salary}|${card.cardText}`;
        if (!found.has(key)) found.set(key, card);
      }
      const noGrowth = found.size === lastSize;
      lastSize = found.size;
      if (found.size >= maxCards) break;
      const scroll = await this.scrollList(tabId);
      bottomStable = noGrowth && scroll?.atBottom ? bottomStable + 1 : 0;
      if (bottomStable >= 2) break;
      await this.waitWithPacing("scroll");
    }
    return [...found.values()].slice(0, maxCards);
  }

  async scrollList(tabId) {
    await this.assertSearchPage(tabId);
    await this.browser.evalValue(tabId, PAGE_HELPERS);
    const result = await this.browser.evalValue(tabId, "(() => window.__bossScrollList())()");
    this.logger?.info("boss_list_scrolled", result || {});
    return result || { moved: false, atBottom: false };
  }

  async readCardDetail(tabId, job, fallbackIndex = 0) {
    await this.assertSearchPage(tabId);
    await this.browser.evalValue(tabId, PAGE_HELPERS);
    const expectedJobId = (normalizeBossUrl(job?.url || "").match(/\/job_detail\/([^/?#]+)\.html/i) || [])[1] || "";
    const opened = await this.browser.evalValue(tabId, `(() => window.__bossOpenCard(${JSON.stringify(expectedJobId)}, ${Number(fallbackIndex) || 0}, ${JSON.stringify(job?.title || "")}))()`);
    if (!opened?.clicked) throw bossError("BOSS_CARD_NOT_FOUND", `左侧岗位卡片未找到：${job?.title || expectedJobId || "unknown"}`);
    await this.waitWithPacing("card");
    let scrolled = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await this.assertSearchPage(tabId);
      await this.browser.evalValue(tabId, PAGE_HELPERS);
      const detail = await this.browser.evalValue(tabId, "(() => window.__bossPaneState())()");
      const titleMatches = normalizedComparableText(detail?.title).includes(normalizedComparableText(job?.title));
      const identityMatches = expectedJobId && detail?.currentJobId
        ? detail.currentJobId === expectedJobId
        : titleMatches;
      if (identityMatches && detail?.description) {
        const missingUsefulField = detail.description.length < 120
          || !detail.salary
          || !detail.experience
          || !detail.bossActiveText;
        if (!scrolled && detail.canScroll && missingUsefulField) {
          scrolled = true;
          await this.browser.evalValue(tabId, "(() => window.__bossScrollPane(false))()");
          await this.waitWithPacing("card_retry");
          continue;
        }
        if (detail.description.length >= 120) {
          await this.browser.evalValue(tabId, "(() => window.__bossScrollPane(true))()");
          return {
            description: cleanDetailText(detail.description),
            bossActiveText: parseBossActivityText(detail.bossActiveText),
            salary: detail.salary || "",
            experience: detail.experience || "",
            education: detail.education || ""
          };
        }
      }
      await this.waitWithPacing("card_retry");
    }
    await this.browser.evalValue(tabId, "(() => window.__bossScrollPane(true))()");
    throw bossError("BOSS_PANE_SWITCH_TIMEOUT", `右侧详情未切换到目标岗位：${job?.title || expectedJobId || "unknown"}`);
  }

  async assertSearchPage(tabId) {
    const state = await this.browser.evalValue(tabId, `(() => ({
      path: location.pathname,
      title: document.title || "",
      isRiskPage: /\\/web\\/passport\\/zp\\/verify/i.test(location.pathname) || /安全验证|访问异常|行为验证/.test(document.title || ""),
      isLoginPage: /\\/web\\/user\\//i.test(location.pathname) || [...document.querySelectorAll(".sign-form, .login-register, [class*='login-form']")].some((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      }),
      isSearchPage: /\\/web\\/geek\\/jobs/i.test(location.pathname)
    }))()`);
    if (state?.isRiskPage) throw bossError("BOSS_RISK_CONTROL", "BOSS 当前要求安全验证，已停止本轮页面访问。");
    if (state?.isLoginPage) throw bossError("BOSS_LOGIN_REQUIRED", "BOSS 登录状态已失效，已停止本轮页面访问。");
    if (!state?.isSearchPage) throw bossError("BOSS_SEARCH_PAGE_LOST", `BOSS 搜索页已离开：${state?.title || state?.path || "unknown"}`);
    return state;
  }

  async assertDetailPage(tabId, expectedJobId = "") {
    const state = await this.browser.evalValue(tabId, `(() => ({
      path: location.pathname,
      title: document.title || "",
      isRiskPage: /\\/web\\/passport\\/zp\\/verify/i.test(location.pathname) || /安全验证|访问异常|行为验证/.test(document.title || ""),
      isLoginPage: /\\/web\\/user\\//i.test(location.pathname) || [...document.querySelectorAll(".sign-form, .login-register, [class*='login-form']")].some((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      }),
      jobId: (location.pathname.match(/\\/job_detail\\/([^/?#]+)\\.html/i) || [])[1] || ""
    }))()`);
    if (state?.isRiskPage) throw bossError("BOSS_RISK_CONTROL", "BOSS 当前要求安全验证，已停止本轮页面访问。");
    if (state?.isLoginPage) throw bossError("BOSS_LOGIN_REQUIRED", "BOSS 登录状态已失效，已停止本轮页面访问。");
    if (!state?.jobId || (expectedJobId && state.jobId !== expectedJobId)) {
      throw bossError("BOSS_DETAIL_PAGE_LOST", `BOSS 详情页已离开：${state?.title || state?.path || "unknown"}`);
    }
    return state;
  }

  async readDetail(tabId, url) {
    const expectedJobId = (normalizeBossUrl(url).match(/\/job_detail\/([^/?#]+)\.html/i) || [])[1] || "";
    await this.navigateWithPacing(tabId, url, "detail");
    for (let i = 0; i < 8; i += 1) {
      await this.assertDetailPage(tabId, expectedJobId);
      await this.browser.evalValue(tabId, PAGE_HELPERS);
      const detail = await this.browser.evalValue(tabId, `(() => {
        const decode = window.__bossDecode || ((x) => String(x || ""));
        const root = document.querySelector(".job-detail-container")
          || document.querySelector(".job-detail")
          || document.querySelector(".detail-content")
          || document.querySelector(".job-detail-box");
        const currentJobId = (window.location.pathname.match(/\\/job_detail\\/([^/?#]+)\\.html/i) || [])[1] || "";
        if (!root) return { currentJobId, description: "", bossActiveText: "", salary: "", experience: "", education: "" };
        const header = document.querySelector(".job-primary")
          || document.querySelector(".job-banner")
          || document.querySelector(".job-detail-header")
          || root;
        const description = root.querySelector(".job-sec-text")
          || root.querySelector(".job-detail-body .desc")
          || root.querySelector("p.desc")
          || root.querySelector(".job-detail-section .text")
          || root.querySelector("[class*='job-sec-text']")
          || root;
        const detailText = decode(description.innerText || "").replace(/\\s+/g, " ").slice(0, 3000);
        const activityText = decode(root.innerText || "");
        const bossActiveText = (window.__bossActivity || (() => ""))(activityText);
        const metadata = (window.__bossJobMetadata || (() => ({})))(decode(header.innerText || ""));
        return { currentJobId, description: detailText, bossActiveText, ...metadata };
      })()`);
      if ((!expectedJobId || detail?.currentJobId === expectedJobId) && detail?.description && detail.description.length > 120) {
        return {
          description: cleanDetailText(detail.description),
          bossActiveText: parseBossActivityText(detail.bossActiveText),
          salary: detail.salary || "",
          experience: detail.experience || "",
          education: detail.education || ""
        };
      }
      await this.waitWithPacing("retry");
    }
    return { description: "", bossActiveText: "", salary: "", experience: "", education: "" };
  }

  async readActivity(tabId, url) {
    const expectedJobId = (normalizeBossUrl(url).match(/\/job_detail\/([^/?#]+)\.html/i) || [])[1] || "";
    await this.navigateWithPacing(tabId, url, "detail");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await this.assertDetailPage(tabId, expectedJobId);
      await this.browser.evalValue(tabId, PAGE_HELPERS);
      const state = await this.browser.evalValue(tabId, `(() => {
        const decode = window.__bossDecode || ((value) => String(value || ""));
        const root = document.querySelector(".job-detail-container")
          || document.querySelector(".job-detail")
          || document.querySelector(".detail-content")
          || document.querySelector(".job-detail-box");
        if (!root) return { bossActiveText: "" };
        const onlineIcon = root.querySelector(".boss-online-icon, [class*='online-icon']");
        return {
          bossActiveText: (window.__bossActivity || (() => ""))(decode(root.innerText || ""))
            || (onlineIcon ? "今日活跃" : "")
        };
      })()`);
      const parsed = parseBossActivityText(state?.bossActiveText);
      if (parsed) return parsed;
      await this.waitWithPacing("retry");
    }
    return "";
  }
}

function normalizeBossJob(job) {
  const description = cleanDetailText(job.description || job.detail || "");
  const url = normalizeBossNavigationUrl(job.url || "");
  const metadata = mergeJobMetadata(job, description);
  return {
    source: job.source || "boss",
    sourceId: job.sourceId || bossSourceId({ ...job, url }),
    keyword: job.keyword || "",
    title: job.title || job.name || "",
    company: job.company || "",
    location: job.location || "",
    salary: metadata.salary,
    experience: metadata.experience,
    education: metadata.education,
    bossActiveText: parseBossActivityText(job.bossActiveText || job.active || description),
    url,
    tags: job.tags || [],
    description,
    detailRead: Boolean(job.detailRead)
  };
}

function parseBossActivityText(text) {
  const value = String(text || "");
  if (/(?:^|\s)在线(?:\s|$)|刚刚活跃|今日活跃|今天活跃/.test(value)) return "今日活跃";
  const readable = value.match(/昨日活跃|昨天活跃|近半年活跃|半年内活跃|近(?:\d+|一|二|三|四|五|六|七|八|九|十)个?月活跃|\d+\s*(?:日|周|月|年)内活跃|本周活跃|本月活跃/);
  return readable ? readable[0].replace(/\s+/g, "") : "";
}

function cleanDetailText(value) {
  let text = String(value || "").replace(/\s+/g, " ").trim();
  text = text.replace(/^(?:微\s*信)?扫码分享\s*举?\s*报\s*职位描述\s*/i, "");
  const markers = [
    "工作地址", "公司介绍", "公司信息", "工商信息", "查看全部工商信息",
    "BOSS安全提示", "求职安全", "BOSS直聘严禁", "求职工具", "热门职位", "热门城市",
    "包括但不限于扣押求职者证件", "请勿向任何第三方机构或个人支付费用"
  ];
  let end = text.length;
  for (const marker of markers) {
    const index = text.indexOf(marker);
    if (index > 0 && index < end) end = index;
  }
  text = text.slice(0, end).trim();
  return text;
}

function normalizeKeywordPlan(keywords, keywordPlan = []) {
  const byWord = new Map((keywordPlan || []).map((item, index) => [String(item.word || "").trim().toLowerCase(), { ...item, order: index }]));
  return keywords.map((word, index) => {
    const saved = byWord.get(String(word || "").trim().toLowerCase());
    return {
      word,
      priority: normalizePriority(saved?.priority),
      order: saved?.order ?? index
    };
  });
}

function normalizeCityScopes(options = {}) {
  const input = Array.isArray(options.cityScopes) && options.cityScopes.length
    ? options.cityScopes
    : [{ city: "", cityCode: options.cityCode || DEFAULT_CITY_CODE }];
  const scopes = [];
  for (const item of input) {
    const cityCode = String(item?.cityCode || item?.code || "").trim();
    if (!cityCode || scopes.some((scope) => scope.cityCode === cityCode)) continue;
    scopes.push({ city: String(item?.city || "").trim(), cityCode });
  }
  return scopes.length ? scopes : [{ city: "", cityCode: DEFAULT_CITY_CODE }];
}

function parseBossFilterCatalog(rawFields = []) {
  const fields = {};
  for (const rawField of rawFields || []) {
    const grouped = new Map();
    for (const option of rawField?.options || []) {
      const match = String(option?.ka || "").match(/^sel-job-rec-([A-Za-z]+)-(\d+)$/);
      if (!match || match[2] === "0") continue;
      const fieldConfig = BOSS_FILTER_FIELDS[match[1]];
      const label = String(option?.label || "").replace(/\s+/g, " ").trim();
      if (!fieldConfig || !label) continue;
      if (!grouped.has(match[1])) grouped.set(match[1], { fieldConfig, options: [] });
      grouped.get(match[1]).options.push({ code: match[2], label });
    }
    for (const { fieldConfig, options } of grouped.values()) {
      if (!options.length) continue;
      fields[fieldConfig.key] = { ...fieldConfig, options };
    }
  }
  return normalizePlatformFilterCatalog({
    site: "boss",
    source: "live_dom",
    discoveredAt: new Date().toISOString(),
    fields
  });
}

function normalizePriority(value) {
  return ["A", "B", "C"].includes(value) ? value : "B";
}

function buildBossSearchUrl({ keyword, cityCode, nativeFilters } = {}) {
  const filters = normalizeNativeFilters(nativeFilters);
  const url = new URL("https://www.zhipin.com/web/geek/jobs");
  if (keyword) url.searchParams.set("query", keyword);
  if (cityCode) url.searchParams.set("city", cityCode);
  for (const [name, values] of Object.entries(filters.params)) {
    if (values.length) url.searchParams.set(name, values.join(","));
  }
  return url.toString();
}

function normalizeNativeFilterLanes(value = {}) {
  const source = Array.isArray(value?.lanes) && value.lanes.length ? value.lanes : [value];
  return source.map((lane, index) => ({
    ...normalizeNativeFilters(lane),
    id: String(lane?.id || `lane-${index + 1}`),
    rank: Number.isFinite(Number(lane?.rank)) ? Number(lane.rank) : index
  }));
}

function normalizeNativeFilters(value = {}) {
  const codes = (items) => [...new Set((Array.isArray(items) ? items : [])
    .map((item) => String(item || "").trim())
    .filter((item) => /^\d+$/.test(item)))];
  const params = {};
  const sourceParams = value?.params && typeof value.params === "object" ? value.params : {
    salary: value?.salaryCodes,
    experience: value?.experienceCodes
  };
  for (const [name, values] of Object.entries(sourceParams)) {
    const normalized = codes(values);
    if (normalized.length) params[String(name || "").trim()] = normalized;
  }
  return {
    params,
    salaryCodes: params.salary || [],
    experienceCodes: params.experience || []
  };
}

function priorityRank(priority) {
  return { A: 0, B: 1, C: 2 }[normalizePriority(priority)] ?? 9;
}

function weightedCardLimit(priority, baseLimit) {
  const base = Math.max(10, Number(baseLimit) || 60);
  const ratio = { A: 1, B: 0.65, C: 0.4 }[normalizePriority(priority)];
  return Math.max(10, Math.ceil(base * ratio));
}

function normalizePageBudget(value) {
  const budget = Number(value);
  return Number.isFinite(budget) ? Math.max(20, Math.min(300, Math.floor(budget))) : 90;
}

function randomBetween(min, max, randomFn = Math.random) {
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  return Math.round(low + (high - low) * Math.max(0, Math.min(1, Number(randomFn()) || 0)));
}

function mergeScanCandidate(target, candidate) {
  if (!candidate.job.url) return;
  const key = bossSourceId(candidate.job);
  const existing = target.get(key);
  if (!existing) {
    target.set(key, { ...candidate, keywords: [candidate.keyword] });
    return;
  }
  if (!existing.keywords.includes(candidate.keyword)) existing.keywords.push(candidate.keyword);
  const mergedJob = mergeBossJobFacts(existing.job, candidate.job);
  const incomingBetter = priorityRank(candidate.priority) < priorityRank(existing.priority)
    || (priorityRank(candidate.priority) === priorityRank(existing.priority) && Number(candidate.laneRank || 0) < Number(existing.laneRank || 0))
    || (priorityRank(candidate.priority) === priorityRank(existing.priority)
      && Number(candidate.laneRank || 0) === Number(existing.laneRank || 0)
      && candidate.quickScore > existing.quickScore);
  if (incomingBetter) {
    target.set(key, { ...candidate, job: mergedJob, keywords: existing.keywords });
  } else {
    existing.job = mergedJob;
  }
}

function mergeBossJobFacts(existing = {}, incoming = {}) {
  const incomingHasDetail = Boolean(incoming.detailRead);
  const existingHasDetail = Boolean(existing.detailRead);
  const preferred = incomingHasDetail && !existingHasDetail ? incoming
    : existingHasDetail && !incomingHasDetail ? existing
      : String(incoming.description || "").length > String(existing.description || "").length ? incoming : existing;
  const fallback = preferred === incoming ? existing : incoming;
  return {
    ...fallback,
    ...preferred,
    salary: preferred.salary || fallback.salary || "",
    experience: preferred.experience || fallback.experience || "",
    education: preferred.education || fallback.education || "",
    bossActiveText: preferred.bossActiveText || fallback.bossActiveText || "",
    description: preferred.description || fallback.description || "",
    detailRequired: Boolean(existing.detailRequired || incoming.detailRequired),
    detailRead: Boolean(existing.detailRead || incoming.detailRead),
    detailErrorCode: incoming.detailRead ? "" : (incoming.detailErrorCode || existing.detailErrorCode || "")
  };
}

function dedupeJobs(jobs) {
  const byKey = new Map();
  for (const job of jobs) {
    const key = bossSourceId(job);
    const old = byKey.get(key);
    if (!old || (job.detailRead && !old.detailRead) || (job.description || "").length > (old.description || "").length) {
      byKey.set(key, { ...job, sourceId: key, url: normalizeBossNavigationUrl(job.url) });
    }
  }
  return [...byKey.values()];
}

function normalizeBossUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  try {
    const parsed = new URL(value, "https://www.zhipin.com");
    const id = parsed.pathname.match(/\/job_detail\/([^/?#]+)\.html/i);
    if (id) return `${parsed.origin}/job_detail/${id[1]}.html`;
    return "";
  } catch {
    return "";
  }
}

function normalizeBossNavigationUrl(url) {
  const canonical = normalizeBossUrl(url);
  if (!canonical) return "";
  try {
    const securityId = new URL(String(url), "https://www.zhipin.com").searchParams.get("securityId");
    return securityId ? `${canonical}?securityId=${encodeURIComponent(securityId)}` : canonical;
  } catch {
    return canonical;
  }
}

function bossSourceId(job) {
  const url = normalizeBossUrl(job.url || "");
  const id = url.match(/\/job_detail\/([^/?#]+)\.html/i);
  if (id) return `boss:${id[1]}`;
  return `boss:${[job.company, job.title, job.location, job.salary].map((x) => String(x || "").trim()).join("|").toLowerCase()}`;
}

function compareBossTabs(left, right) {
  return bossTabRank(left) - bossTabRank(right);
}

function bossTabRank(tab) {
  const url = String(tab?.url || "");
  const isSearch = /zhipin\.com\/web\/geek\/jobs/i.test(url);
  const isBoss = /zhipin\.com/i.test(url);
  if (isSearch && tab?.active) return 0;
  if (isSearch) return 1;
  if (isBoss && tab?.active) return 2;
  if (isBoss) return 3;
  return 9;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bossError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isFatalBrowserError(error) {
  return new Set([
    "BOSS_PAGE_BUDGET_REACHED",
    "BOSS_RISK_CONTROL",
    "BOSS_LOGIN_REQUIRED",
    "BOSS_TAB_REQUIRED",
    "BOSS_SEARCH_PAGE_LOST",
    "BOSS_DETAIL_PAGE_LOST"
  ]).has(String(error?.code || ""));
}

function normalizedComparableText(value) {
  return String(value || "").toLowerCase().replace(/[\s·._()（）\-_/]/g, "");
}

module.exports = {
  BossSiteAdapter,
  normalizeBossJob,
  parseBossActivityText,
  normalizeBossUrl,
  normalizeBossNavigationUrl,
  bossSourceId,
  cleanDetailText,
  weightedCardLimit,
  mergeScanCandidate,
  buildBossSearchUrl,
  normalizeNativeFilters,
  normalizeNativeFilterLanes,
  normalizePageBudget,
  randomBetween,
  parseBossFilterCatalog,
  BOSS_FILTER_FIELDS
};
