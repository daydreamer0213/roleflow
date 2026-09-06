const {
  canonicalizeZhaopinSearchTemplate,
  zhaopinJobIdentity
} = require("../../core/zhaopin_search_scope");

const ZHAOPIN_PAGE_HELPERS_EXPRESSION = String.raw`(() => {
  if (window.__zhaopinReadSearchState) return true;
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const signature = (card, index) => [
    index,
    clean(card.querySelector('.vue-clamp__text, .job-card__title-main')?.textContent),
    clean(card.querySelector('.job-card__salary')?.textContent),
    clean(card.querySelector('.job-card__company-name')?.textContent),
    clean(card.querySelector('.job-card__location')?.textContent),
    clean(card.textContent)
  ].join('|');
  const cardState = (card, index) => {
    const tags = Array.from(card.querySelectorAll('.job-card__skill-tag')).map((item) => clean(item.textContent)).filter(Boolean);
    return {
      index,
      signature: signature(card, index),
      title: clean(card.querySelector('.vue-clamp__text, .job-card__title-main')?.textContent),
      salary: clean(card.querySelector('.job-card__salary')?.textContent),
      company: clean(card.querySelector('.job-card__company-name')?.textContent),
      location: clean(card.querySelector('.job-card__location')?.textContent),
      experience: tags.find((item) => /经验不限|\d+(?:-\d+)?年|年以上|以下/.test(item)) || '',
      education: tags.find((item) => /本科|大专|硕士|博士|高中|中专|MBA/.test(item)) || ''
    };
  };
  const detailState = () => {
    const pane = document.querySelector('.job-detail-card');
    if (!pane) return { title: '', salary: '', company: '', clientCompany: '', location: '', experience: '', education: '', description: '', url: '' };
    const textLines = String(pane.querySelector('.job-detail-summary__meta')?.innerText || '').split(/\n+/).map(clean).filter(Boolean);
    const location = textLines.find((item) => item.includes('·')) || '';
    const experience = textLines.find((item) => /经验不限|\d+(?:-\d+)?年|年以上|以下/.test(item)) || '';
    const education = textLines.find((item) => /本科|大专|硕士|博士|高中|中专|MBA/.test(item)) || '';
    const companyLine = textLines.find((item) => item !== location && item !== experience && item !== education) || '';
    const clientMatch = companyLine.match(/^客户公司[：:]\s*(.+)$/);
    const link = Array.from(pane.querySelectorAll('a[href*="/jobdetail/"]')).map((item) => item.href).find(Boolean) || '';
    return {
      title: clean(pane.querySelector('.job-detail-summary__title-text')?.textContent),
      salary: clean(pane.querySelector('.job-detail-summary__salary')?.textContent),
      company: clientMatch ? '' : companyLine,
      clientCompany: clientMatch ? clean(clientMatch[1]) : '',
      location,
      experience,
      education,
      description: clean(pane.querySelector('.job-detail-card__body')?.innerText),
      url: link
    };
  };
  window.__zhaopinReadSearchState = () => {
    const cards = Array.from(document.querySelectorAll('.job-list-panel .job-card')).map(cardState);
    const selectedIndex = Array.from(document.querySelectorAll('.job-list-panel .job-card')).findIndex((item) => item.classList.contains('job-card--active'));
    const bodyText = clean(document.body?.innerText);
    const pathname = location.pathname;
    return {
      url: location.href,
      keyword: clean(document.querySelector('.search-keyword-input, input[aria-label*="搜索"]')?.value),
      filterSummary: Array.from(document.querySelectorAll('.filter-select-box__label')).map((item) => clean(item.textContent)).filter(Boolean),
      cards,
      selectedIndex,
      detail: detailState(),
      loading: document.readyState !== 'complete' || Boolean(document.querySelector('.job-detail-card [class*="loading"], .job-list-panel [class*="loading"]')),
      risk: /安全验证|访问异常|行为验证|访问受限/.test(document.title || '') || /账户存在异常行为|暂时无法访问/.test(bodyText),
      loginRequired: /登录后|请登录/.test(bodyText),
      isSearchPage: location.protocol === 'https:' && location.hostname === 'www.zhaopin.com' && pathname === '/jobs/' && new URL(location.href).searchParams.get('pageMode') === 'search'
    };
  };
  window.__zhaopinActivateCard = (expectedIndex, expectedSignature) => {
    const cards = Array.from(document.querySelectorAll('.job-list-panel .job-card'));
    const card = cards[Number(expectedIndex)];
    if (!card || signature(card, Number(expectedIndex)) !== String(expectedSignature || '')) return { ready: false, reason: 'card_changed' };
    card.click();
    return { ready: true };
  };
  return true;
})()`;

class ZhaopinSiteAdapter {
  constructor({ browser = null, logger = null, sleepFn = sleep, randomFn = Math.random, accessController = null } = {}) {
    this.browser = browser;
    this.logger = logger;
    this.sleep = sleepFn;
    this.random = randomFn;
    this.accessController = accessController;
  }

  async preflight({ tabId } = {}) {
    const state = await this.readSearchState(requiredTabId(tabId));
    return { tabId, url: state.url, isSearchPage: true, loggedIn: !state.loginRequired, hasJobStructure: state.cards.length > 0 };
  }

  async inspectInheritedSearchPage({ tabId } = {}) {
    const state = await this.readSearchState(requiredTabId(tabId));
    return { tabId, url: state.url, searchTemplate: canonicalizeZhaopinSearchTemplate(state.url), filterSummary: state.filterSummary };
  }

  async readSearchState(tabId) {
    tabId = requiredTabId(tabId);
    await this.assertBoundTab(tabId);
    await this.browser.evalValue(tabId, ZHAOPIN_PAGE_HELPERS_EXPRESSION);
    await this.assertBoundTab(tabId);
    const state = assertSafeSearchState(await this.browser.evalValue(tabId, "(() => window.__zhaopinReadSearchState())()"));
    const identity = safeIdentity(state.detail?.url);
    if (identity) state.detail = { ...state.detail, ...identity };
    return state;
  }

  async readVisiblePaneDetail(tabId, card, signal = null, assertTabBindings = null) {
    throwIfAborted(signal);
    await assertBindings(assertTabBindings);
    const before = await this.readSearchState(tabId);
    const expected = before.cards[Number(card?.index)];
    if (!expected || expected.signature !== card?.signature || !expected.title) return null;
    const wasSelected = before.selectedIndex === expected.index;
    const beforeUrl = before.detail.url;
    if (!wasSelected) {
      await assertBindings(assertTabBindings);
      await this.assertBoundTab(tabId);
      const activation = await this.browser.evalValue(tabId, `(() => window.__zhaopinActivateCard(${JSON.stringify(expected.index)}, ${JSON.stringify(expected.signature)}))()`);
      if (activation?.ready !== true) return null;
    }
    await this.reserveAccess(expected);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      throwIfAborted(signal);
      await assertBindings(assertTabBindings);
      const state = await this.readSearchState(tabId);
      if (state.selectedIndex === expected.index && (!state.loading || attempt > 0) && detailMatches(expected, state.detail)) {
        if (!wasSelected && state.detail.url === beforeUrl) return null;
        const identity = safeIdentity(state.detail.url);
        if (!identity) return null;
        return { ...state.detail, ...identity };
      }
      if (attempt < 5) await this.waitWithChecks(signal, assertTabBindings);
    }
    return null;
  }

  async assertBoundTab(tabId) {
    if (!this.browser || typeof this.browser.listTabs !== "function" || typeof this.browser.evalValue !== "function") {
      throw zhaopinError("ZHAOPIN_BROWSER_REQUIRED", "智联只读预检需要 listTabs 和 evalValue 浏览器能力。");
    }
    const tab = (await this.browser.listTabs()).find((item) => item.id === tabId);
    if (!tab || !/^https:\/\/www\.zhaopin\.com\//i.test(String(tab.url || ""))) {
      throw zhaopinError("ZHAOPIN_TAB_BINDING_LOST", "智联标签页已丢失或不再属于当前会话。");
    }
  }

  async reserveAccess(card) {
    if (typeof this.accessController?.reserve === "function") {
      await this.accessController.reserve("pane_detail_read", { source: "zhaopin", cardIndex: card.index });
    }
  }

  async waitWithChecks(signal, assertTabBindings) {
    throwIfAborted(signal);
    await assertBindings(assertTabBindings);
    await abortableSleep(this.sleep(120), signal);
    throwIfAborted(signal);
    await assertBindings(assertTabBindings);
  }
}

function assertSafeSearchState(state) {
  if (state?.risk) throw zhaopinError("ZHAOPIN_RISK_CONTROL", "智联当前要求安全验证，已停止本轮页面读取。");
  if (state?.loginRequired) throw zhaopinError("ZHAOPIN_LOGIN_REQUIRED", "智联登录状态已失效，已停止本轮页面读取。");
  if (!state?.isSearchPage) throw zhaopinError("ZHAOPIN_SEARCH_PAGE_LOST", "智联搜索页已离开，已停止本轮页面读取。");
  return state;
}

function detailMatches(card, detail) {
  const company = detail?.company || detail?.clientCompany || "";
  return Boolean(detail?.title && detail?.description && detail?.url)
    && sameText(detail.title, card.title)
    && (!card.salary || sameText(detail.salary, card.salary))
    && (!card.company || sameText(company, card.company) || Boolean(detail.clientCompany))
    && (!card.location || sameText(detail.location, card.location));
}

function sameText(left, right) {
  return String(left || "").replace(/\s+/g, " ").trim() === String(right || "").replace(/\s+/g, " ").trim();
}

function safeIdentity(url) {
  try { return zhaopinJobIdentity(url); } catch { return null; }
}

function requiredTabId(tabId) {
  if (tabId === null || tabId === undefined || tabId === "") {
    throw zhaopinError("ZHAOPIN_TAB_REQUIRED", "智联只读操作必须显式指定搜索标签页。")
  }
  return tabId;
}

function zhaopinError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw zhaopinError("ZHAOPIN_ABORTED", "智联只读操作已取消。");
}

async function assertBindings(assertTabBindings) {
  if (typeof assertTabBindings === "function") await assertTabBindings();
}

function abortableSleep(promise, signal) {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(zhaopinError("ZHAOPIN_ABORTED", "智联只读操作已取消。")); };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

module.exports = { ZhaopinSiteAdapter, ZHAOPIN_PAGE_HELPERS_EXPRESSION };
