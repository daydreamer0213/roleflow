const {
  canonicalizeZhaopinSearchTemplate,
  buildZhaopinSearchUrl,
  zhaopinJobIdentity
} = require("../../core/zhaopin_search_scope");
const { BossSiteAdapter } = require('./boss');
const { buildScanExecutionSnapshot } = require('../../core/scan_snapshot');
const { sourceContentHash } = require('../../storage/job_store');
const { hasCompleteJobDescription } = require('../../core/job_description_readiness');

const ZHAOPIN_DEFAULT_FILTER_LABELS = new Set([
  '地区', '薪资', '学历', '经验', '公司性质', '融资阶段', '公司人数', '工作性质', '职位类别', '公司行业'
]);

const ZHAOPIN_COMPONENT_ACCESSORS_SOURCE = String.raw`
  const component = (node, name) => {
    let current = node?.__vueParentComponent || node?.__vue__;
    while (current) {
      const currentName = current.type?.name || current.type?.__name || current.$options?.name;
      if (currentName === name) return current;
      current = current.parent || current.$parent;
    }
    return null;
  };
  const componentProps = (instance) => instance?.proxy?.$props || instance?.props || instance?.$props;
  const componentPosition = (instance) => instance?.proxy?.position || instance?.ctx?.position || instance?.position;
`;

const ZHAOPIN_PAGE_HELPERS_EXPRESSION = String.raw`(() => {
  if (window.__zhaopinReadSearchState?.__roleflowVersion === 6) return true;
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const validSourceId = (value) => /^[A-Za-z0-9]{1,160}$/.test(String(value || '')) ? String(value) : '';
  ${ZHAOPIN_COMPONENT_ACCESSORS_SOURCE}
  const cardJob = (card) => {
    const instance = component(card, 'JobCard');
    return componentProps(instance)?.job;
  };
  const signature = (card, index) => [
    index,
    validSourceId(cardJob(card)?.number),
    clean(card.querySelector('.vue-clamp__text, .job-card__title-main')?.textContent),
    clean(card.querySelector('.job-card__salary')?.textContent),
    clean(card.querySelector('.job-card__company-name')?.textContent),
    clean(card.querySelector('.job-card__location')?.textContent),
    clean(card.textContent)
  ].join('|');
  const cardState = (card, index) => {
    const tags = Array.from(card.querySelectorAll('.job-card__skill-tag')).map((item) => clean(item.textContent)).filter(Boolean);
    const title = clean(card.querySelector('.vue-clamp__text, .job-card__title-main')?.textContent);
    const company = clean(card.querySelector('.job-card__company-name')?.textContent);
    const job = cardJob(card);
    const rawSourceId = clean(job?.number);
    const sourceId = validSourceId(job?.number);
    return {
      index,
      signature: signature(card, index),
      ...(sourceId && clean(job?.name) === title && clean(job?.companyName) === company ? { sourceId } : {}),
      ...(rawSourceId ? { currentSourceIdSupplied: true } : {}),
      title,
      salary: clean(card.querySelector('.job-card__salary')?.textContent),
      company,
      location: clean(card.querySelector('.job-card__location')?.textContent),
      experience: tags.find((item) => /经验不限|\d+(?:-\d+)?年|年以上|以下/.test(item)) || '',
      education: tags.find((item) => /本科|大专|硕士|博士|高中|中专|MBA/.test(item)) || ''
    };
  };
  const detailState = () => {
    const panel = document.querySelector('.job-detail-panel');
    const pane = panel || document.querySelector('.job-detail-card');
    if (!pane) return { title: '', salary: '', company: '', clientCompany: '', location: '', experience: '', education: '', description: '', url: '' };
    const summary = pane.querySelector('.job-detail-summary');
    const textLines = panel
      ? Array.from(summary?.querySelectorAll('.job-detail-summary__tags li') || []).map((item) => clean(item.textContent)).filter(Boolean)
      : String(pane.querySelector('.job-detail-summary__meta')?.innerText || '').split(/\n+/).map(clean).filter(Boolean);
    const location = panel ? textLines[0] || '' : textLines.find((item) => item.includes('·')) || '';
    const experience = textLines.find((item) => /经验不限|\d+(?:-\d+)?年|年以上|以下/.test(item)) || '';
    const education = textLines.find((item) => /本科|大专|硕士|博士|高中|中专|MBA/.test(item)) || '';
    const companyLine = panel
      ? clean(summary?.querySelector('.job-detail-summary__company-name')?.textContent)
      : textLines.find((item) => item !== location && item !== experience && item !== education) || '';
    const clientMatch = companyLine.match(/^客户公司[：:]\s*(.+)$/);
    const publisher = panel ? clean(pane.querySelector('.job-company-info__name')?.textContent) : '';
    const link = panel
      ? clean(pane.querySelector('.job-company-info__view-all[href*="/jobdetail/"]')?.href)
      : Array.from(pane.querySelectorAll('a[href*="/jobdetail/"]')).map((item) => item.href).find(Boolean) || '';
    const descriptionCard = panel
      ? Array.from(pane.querySelectorAll('.job-detail-card')).find((item) => /^职位描述$/.test(clean(item.querySelector('.job-detail-card__title, h1, h2, h3')?.textContent)))
      : pane;
    const summaryComponent = component(summary, 'JobDetailSummary');
    const jobDetail = componentProps(summaryComponent)?.jobDetail;
    const rawDetailedSourceId = clean(jobDetail?.detailedPosition?.number);
    const rawComputedSourceId = clean(componentPosition(summaryComponent)?.number);
    const detailedSourceId = validSourceId(rawDetailedSourceId);
    const computedSourceId = validSourceId(rawComputedSourceId);
    const observedSourceIds = [detailedSourceId, computedSourceId].filter(Boolean);
    return {
      title: clean(pane.querySelector('.job-detail-summary__title-text')?.textContent),
      salary: clean(pane.querySelector('.job-detail-summary__salary')?.textContent),
      company: panel ? (clientMatch ? publisher : companyLine || publisher) : clientMatch ? '' : companyLine,
      clientCompany: clientMatch ? clean(clientMatch[1]) : '',
      publisherCompany: publisher,
      location,
      experience,
      education,
      description: clean(descriptionCard?.querySelector('.job-detail-card__body')?.innerText),
      url: link,
      observedSourceId: observedSourceIds[0] || '',
      observedSourceIdSupplied: Boolean(rawDetailedSourceId || rawComputedSourceId),
      observedSourceIdsComplete: Boolean(detailedSourceId && computedSourceId && detailedSourceId === computedSourceId),
      observedSourceIdConflict: Boolean((rawDetailedSourceId && !detailedSourceId) || (rawComputedSourceId && !computedSourceId)) || new Set(observedSourceIds).size > 1
    };
  };
  window.__zhaopinReadSearchState = () => {
    const cardNodes = Array.from(document.querySelectorAll('.job-list-panel .job-card'));
    const cards = cardNodes.map(cardState);
    const selectedIndex = cardNodes.findIndex((item) => item.classList.contains('job-card--active'));
    const detail = detailState();
    const bodyText = clean(document.body?.innerText);
    const pathname = location.pathname;
    const confirmedEnd = Array.from(document.querySelectorAll('.job-list-panel__status.job-list-panel__status--more')).some(item => clean(item.textContent) === '没有更多了');
    const visibleLoader = Array.from(document.querySelectorAll('.job-detail-panel [class*="loading"], .job-detail-panel [class*="skeleton"], .job-detail-card [class*="loading"], .job-detail-card [class*="skeleton"], .job-list-panel [class*="loading"], .job-list-panel [class*="skeleton"]')).some((item) => {
      const style = getComputedStyle(item);
      return item.getClientRects().length > 0 && !item.hidden && item.getAttribute('aria-hidden') !== 'true' && style.display !== 'none' && style.visibility !== 'hidden';
    });
    return {
      url: location.href,
      keyword: clean(document.querySelector('.query-sug__input, .search-keyword-input, input[aria-label*="搜索"]')?.value),
      filterSummary: Array.from(document.querySelectorAll('.filter-select-box__label')).map((item) => clean(item.textContent)).filter(Boolean),
      cards,
      selectedIndex,
      detail,
      loading: visibleLoader || (cards.length === 0 ? !confirmedEnd : selectedIndex < 0 || !detail.title || !detail.description || !detail.url),
      confirmedEnd,
      risk: /安全验证|访问异常|行为验证|访问受限/.test(document.title || '') || /账户存在异常行为|暂时无法访问/.test(bodyText),
      loginRequired: /登录后|请登录/.test(bodyText),
      isSearchPage: location.protocol === 'https:' && location.hostname === 'www.zhaopin.com' && pathname === '/jobs/' && new URL(location.href).searchParams.get('pageMode') === 'search'
    };
  };
  window.__zhaopinReadSearchState.__roleflowVersion = 6;
  window.__zhaopinActivateCard = (expectedIndex, expectedSignature) => {
    const cards = Array.from(document.querySelectorAll('.job-list-panel .job-card'));
    const card = cards[Number(expectedIndex)];
    if (!card || signature(card, Number(expectedIndex)) !== String(expectedSignature || '')) return { ready: false, reason: 'card_changed' };
    card.click();
    return { ready: true };
  };
  window.__zhaopinScrollResults = () => {
    const scroller = document.scrollingElement;
    if (!scroller) return false;
    scroller.scrollTop = scroller.scrollHeight;
    window.dispatchEvent(new Event('scroll'));
    return true;
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
    this.searchRenderScopes = new Map();
  }

  async preflight({ tabId } = {}) {
    if (tabId === undefined || tabId === null) tabId = await resolveZhaopinSearchTab(this.browser);
    const state = await this.readSearchState(requiredTabId(tabId));
    return { tabId, url: state.url, isSearchPage: true, loggedIn: !state.loginRequired, hasJobStructure: state.cards.length > 0 };
  }

  async inspectInheritedSearchPage({ tabId } = {}) {
    const state = await this.readSearchState(requiredTabId(tabId));
    return { tabId, url: state.url, searchTemplate: canonicalizeZhaopinSearchTemplate(state.url), filterSummary: state.filterSummary };
  }

  async scan(options = {}) {
    const tabId = requiredTabId(options.tabId);
    const searchTemplate = canonicalizeZhaopinSearchTemplate(options.searchTemplate?.url);
    const targets = buildScanExecutionSnapshot({ site: 'zhaopin', searchTemplate,
      keywordPlan: options.keywordPlan || (options.keywords || []).map(word => ({ word, priority: 'B' })),
      limits: { maxCards: options.maxCards } }).targets;
    const selected = options.targetKeys ? new Set(options.targetKeys) : null;
    if (selected && [...selected].some(key => !targets.some(target => target.targetKey === key))) {
      throw zhaopinError('SCAN_RESUME_TARGET_UNKNOWN', '保存的智联扫描目标与本轮范围不一致。');
    }
    const pacing = new BossSiteAdapter({ sleepFn: this.sleep, randomFn: this.random });
    pacing.restorePacing(options.pacingState);
    const jobs = new Map();
    let details = 0, pages = 0, completed = 0, attempted = 0;
    const active = async () => { throwIfAborted(options.signal); await assertBindings(options.assertTabBindings); await this.readSearchState(tabId); };
    const pace = async (kind, bindings = active) => pacing.waitWithPacing(kind, { signal: options.signal, assertTabBindings: bindings });
    for (const target of targets.filter(item => !selected || selected.has(item.targetKey))) {
      await active();
      if (pages >= Number(options.browserPageBudget) || details >= Number(options.maxDetailTotal)) break;
      attempted++;
      const targetJobs = [];
      const startedAt = new Date().toISOString();
      let stopReason = 'scroll_limit', state;
      let releaseSearchRendering = null;
      let operationError = null;
      const url = buildZhaopinSearchUrl({ keyword: target.keyword, searchTemplate });
      const scoped = async () => {
        await active();
        const current = await this.readSearchState(tabId);
        if (!searchStateMatches(current, searchTemplate, target.keyword, options.filterSummary)) {
          throw zhaopinError('ZHAOPIN_SEARCH_SCOPE_CHANGED', '智联搜索条件已改变，请恢复本轮保存的条件后继续。');
        }
      };
      try {
        await pace('list');
        await this.accessController?.reserve?.('list_navigation', { source: 'zhaopin', targetKey: target.targetKey });
        await active();
        await this.browser.navigate(tabId, url);
        pages++;
        releaseSearchRendering = await this.openSearchRenderScope(tabId);
        state = await this.waitForSearchReady(tabId, { searchTemplate, keyword: target.keyword, filterSummary: options.filterSummary, signal: options.signal, assertTabBindings: options.assertTabBindings });
        const seen = new Set();
        let scrolls = 0;
        while (true) {
          await scoped();
          state = await this.readSearchState(tabId);
          const card = state.cards.find(item => !seen.has(item.signature));
          if (targetJobs.length >= target.cardLimit) { stopReason = 'card_limit_reached'; break; }
          if (card) {
            if (details >= Number(options.maxDetailTotal)) { stopReason = 'detail_budget'; break; }
            await pace('pane_detail_read', scoped);
            await pacing.waitForPendingDetailCooldown({ signal: options.signal, assertTabBindings: scoped, onPacingCheckpoint: options.onPacingCheckpoint });
            await scoped();
            const detail = await this.readVisiblePaneDetail(tabId, card, options.signal, scoped);
            if (!detail) throw zhaopinError('ZHAOPIN_DETAIL_IDENTITY_UNCONFIRMED', '智联岗位身份或完整详情尚未确认，已保留进度，请恢复后继续。');
            const job = { ...detail, keyword: target.keyword, tags: [], detailRequired: true, detailRead: true, detailSource: 'trusted_pane' };
            if (!hasCompleteJobDescription(job)) {
              job.detailRead = false;
              job.detailErrorCode = 'ZHAOPIN_DETAIL_INCOMPLETE';
              await options.onDetailCheckpoint?.({ job, targetKey: target.targetKey });
              await options.onDetailResult?.({ outcome: 'failed', errorCode: job.detailErrorCode, accessMode: 'visible_pane' });
              throw zhaopinError(job.detailErrorCode, '智联完整 JD 尚未就绪，已保存待补详情并停止本次读取。');
            }
            const cached = await options.getReusableDetail?.(job);
            // Reuse is decided only after this visit verified the actual pane ID
            // and complete content. Every visit still reserves physical access.
            const reused = cached?.source === 'zhaopin' && cached.sourceId === job.sourceId
              && hasCompleteJobDescription(cached) && sourceContentHash(cached) === sourceContentHash(job);
            if (reused) job.detailReused = true;
            else details++;
            if (!targetJobs.some(item => item.sourceId === job.sourceId)) targetJobs.push(job);
            jobs.set(job.sourceId, job);
            await options.onDetailCheckpoint?.({ job, targetKey: target.targetKey });
            await options.onProgressCheckpoint?.({ jobs: [], targetKey: target.targetKey, activity: 'reading_detail', ...scanProgressCounters(target, targets, state, targetJobs) });
            await options.onDetailResult?.({ outcome: 'succeeded', reused, accessMode: 'visible_pane', job });
            seen.add(card.signature);
            await scoped();
            await pacing.waitAfterDetailAction({ signal: options.signal, assertTabBindings: scoped, onPacingCheckpoint: options.onPacingCheckpoint });
            continue;
          }
          if (state.confirmedEnd) { stopReason = 'confirmed_end'; break; }
          if (scrolls >= 20) break;
          await pace('scroll', scoped);
          await this.accessController?.reserve?.('list_scroll', { source: 'zhaopin', targetKey: target.targetKey });
          await scoped();
          await this.browser.evalValue(tabId, '(() => window.__zhaopinScrollResults())()');
          scrolls++;
          await pace('list', scoped);
          await options.onProgressCheckpoint?.({ jobs: [], targetKey: target.targetKey, activity: 'searching', ...scanProgressCounters(target, targets, state, targetJobs) });
        }
        const status = ['card_limit_reached', 'confirmed_end'].includes(stopReason) ? 'completed' : 'partial';
        await options.onTargetComplete?.({ ...target, status, jobs: targetJobs, jobCount: targetJobs.length, ...scanProgressCounters(target, targets, state, targetJobs), details: { cardLimit: target.cardLimit, stopReason }, startedAt, finishedAt: new Date().toISOString() });
        await active();
        if (status === 'completed') completed++;
        else break;
        await pace('target', scoped);
      } catch (error) {
        operationError = error;
        if (!['WORKFLOW_PAUSE_REQUESTED', 'WORKFLOW_STOP_REQUESTED', 'ZHAOPIN_ABORTED', 'SCAN_ABORTED', 'SCAN_CHECKPOINT_FAILED', 'SCAN_LEASE_LOST', 'SCAN_RUN_LEASE_MISMATCH'].includes(error.code)) {
          try { await options.onTargetComplete?.({ ...target, status: 'partial', jobs: targetJobs, jobCount: targetJobs.length, ...scanProgressCounters(target, targets, state, targetJobs), details: { cardLimit: target.cardLimit, stopReason: error.code || 'read_interrupted' }, errorCode: error.code || '', startedAt, finishedAt: new Date().toISOString() }); } catch {}
        }
        await options.onScanComplete?.({ status: 'partial', targetCount: targets.length, attemptedTargets: attempted, successfulTargets: completed, fatalErrorCode: error.code || '' });
        throw error;
      } finally {
        await releaseSearchRenderScope(releaseSearchRendering, operationError);
      }
    }
    const targetCount = selected ? selected.size : targets.length;
    await options.onScanComplete?.({ status: completed === targetCount ? 'completed' : 'partial', targetCount, attemptedTargets: attempted, successfulTargets: completed });
    return [...jobs.values()];
  }

  async waitForSearchReady(tabId, { searchTemplate, keyword, filterSummary, signal, assertTabBindings } = {}) {
    const releaseSearchRendering = await this.openSearchRenderScope(tabId);
    let operationError = null;
    try {
      for (let attempt = 0; attempt < 30; attempt++) {
        throwIfAborted(signal);
        await assertBindings(assertTabBindings);
        throwIfAborted(signal);
        const state = await this.readSearchState(tabId, signal);
        const selected = state.cards[state.selectedIndex];
        const readyResult = state.cards.length === 0 ? state.confirmedEnd === true
          : selected && detailMatches(selected, state.detail, state.detailSourceIdConfirmed, state.detailSourceIdFullyConfirmed);
        if (!state.loading && readyResult
          && searchStateMatches(state, searchTemplate, keyword, filterSummary)) return state;
        await this.waitWithChecks(signal, assertTabBindings);
      }
      throw zhaopinError('ZHAOPIN_SEARCH_RESTORE_TIMEOUT', '智联未能恢复保存的关键词和筛选条件，请在智联搜索页重新设置并保存条件后再开始。');
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      await releaseSearchRenderScope(releaseSearchRendering, operationError);
    }
  }

  async openSearchRenderScope(tabId) {
    tabId = requiredTabId(tabId);
    if (this.prepared?.focusEnabled === true || this.dispatch?.focusEnabled === true) return async () => {};
    if (typeof this.browser?.setPageLifecycleActive !== 'function' || typeof this.browser?.cdp !== 'function') return async () => {};
    const existing = this.searchRenderScopes.get(tabId);
    if (existing) {
      existing.depth += 1;
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        existing.depth -= 1;
      };
    }
    const scope = { depth: 1, focusAttempted: false, closed: false };
    this.searchRenderScopes.set(tabId, scope);
    const close = async () => {
      if (scope.closed) return;
      scope.depth -= 1;
      if (scope.depth > 0) return;
      scope.closed = true;
      this.searchRenderScopes.delete(tabId);
      if (scope.focusAttempted) await this.browser.cdp(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false });
    };
    try {
      await this.browser.setPageLifecycleActive(tabId);
      scope.focusAttempted = true;
      await this.browser.cdp(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true });
      return close;
    } catch (error) {
      try { await close(); } catch (cleanupError) {
        if (cleanupError.cause === undefined) cleanupError.cause = error;
        throw cleanupError;
      }
      throw error;
    }
  }

  async readSearchState(tabId, signal = null) {
    tabId = requiredTabId(tabId);
    throwIfAborted(signal);
    await this.assertBoundTab(tabId);
    throwIfAborted(signal);
    await this.browser.evalValue(tabId, ZHAOPIN_PAGE_HELPERS_EXPRESSION);
    throwIfAborted(signal);
    await this.assertBoundTab(tabId);
    throwIfAborted(signal);
    const rawState = await this.browser.evalValue(tabId, "(() => window.__zhaopinReadSearchState())()");
    throwIfAborted(signal);
    const state = assertSafeSearchState(rawState);
    const identity = safeIdentity(state.detail?.url);
    const observedSourceId = state.detail?.observedSourceId;
    state.detailSourceIdConfirmed = Boolean(identity)
      && state.detail?.observedSourceIdConflict !== true
      && (state.detail?.observedSourceIdSupplied !== true || observedSourceId === identity.sourceId);
    state.detailSourceIdFullyConfirmed = state.detailSourceIdConfirmed
      && state.detail?.observedSourceIdsComplete === true
      && observedSourceId === identity?.sourceId;
    if (state.detail) {
      const { observedSourceId: _observedSourceId, observedSourceIdSupplied: _observedSourceIdSupplied, observedSourceIdsComplete: _observedSourceIdsComplete, observedSourceIdConflict: _observedSourceIdConflict, ...detail } = state.detail;
      state.detail = identity ? { ...detail, ...identity } : detail;
    }
    return state;
  }

  async readVisiblePaneDetail(tabId, card, signal = null, assertTabBindings = null) {
    throwIfAborted(signal);
    await assertBindings(assertTabBindings);
    const before = await this.readSearchState(tabId);
    const expected = before.cards[Number(card?.index)];
    if (!expected || expected.signature !== card?.signature || !expected.title) return null;
    await this.reserveAccess(expected);
    throwIfAborted(signal);
    await assertBindings(assertTabBindings);
    const refreshed = await this.readSearchState(tabId);
    const refreshedCard = refreshed.cards[expected.index];
    if (!refreshedCard || refreshedCard.signature !== expected.signature || !refreshedCard.title) return null;
    if (refreshed.selectedIndex !== before.selectedIndex) return null;
    const wasSelected = refreshed.selectedIndex === refreshedCard.index;
    const beforeUrl = refreshed.detail.url;
    if (!wasSelected) {
      throwIfAborted(signal);
      await assertBindings(assertTabBindings);
      await this.assertBoundTab(tabId);
      const activation = await this.browser.evalValue(tabId, `(() => window.__zhaopinActivateCard(${JSON.stringify(refreshedCard.index)}, ${JSON.stringify(refreshedCard.signature)}))()`);
      if (activation?.ready !== true) return null;
    }
    for (let attempt = 0; attempt < 6; attempt += 1) {
      throwIfAborted(signal);
      await assertBindings(assertTabBindings);
      const state = await this.readSearchState(tabId);
      if (state.selectedIndex === refreshedCard.index && !state.loading && detailMatches(refreshedCard, state.detail, state.detailSourceIdConfirmed, state.detailSourceIdFullyConfirmed)) {
        if (!wasSelected && state.detail.url === beforeUrl) return null;
        const identity = safeIdentity(state.detail.url);
        if (!identity) return null;
        const { publisherCompany: _publisherCompany, ...detail } = state.detail;
        return { ...detail, company: detail.company || refreshedCard.company || '', ...identity };
      }
      if (attempt < 5) await this.waitWithChecks(signal, assertTabBindings);
    }
    return null;
  }

  async assertBoundTab(tabId) {
    if (!this.browser || typeof this.browser.listTabs !== "function" || typeof this.browser.evalValue !== "function") {
      throw zhaopinError("ZHAOPIN_BROWSER_REQUIRED", "智联只读预检需要 listTabs 和 evalValue 浏览器能力。");
    }
    const tabs = await this.browser.listTabs();
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab || !/^https:\/\/www\.zhaopin\.com\//i.test(String(tab.url || ""))) {
      throw zhaopinError("ZHAOPIN_TAB_BINDING_LOST", "智联标签页已丢失或不再属于当前会话。");
    }
    assertZhaopinWorkspaceWindow(tabs, tab);
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

function detailMatches(card, detail, detailSourceIdConfirmed = true, detailSourceIdFullyConfirmed = false) {
  const company = detail?.company || detail?.clientCompany || "";
  const publisher = detail?.publisherCompany || "";
  const exactComponentIdentity = detailSourceIdFullyConfirmed === true && card?.currentSourceIdSupplied === true
    && Boolean(card?.sourceId) && card.sourceId === detail?.sourceId;
  return detailSourceIdConfirmed === true && Boolean(detail?.title && detail?.description && detail?.url)
    && sameText(detail.title, card.title)
    && (!card.currentSourceIdSupplied || (Boolean(card.sourceId) && card.sourceId === detail.sourceId))
    && (!card.salary || sameText(detail.salary, card.salary))
    && (!card.company || !publisher || sameText(publisher, card.company))
    && (!card.company || sameText(company, card.company) || (Boolean(detail.clientCompany) && !detail.company))
    && (!card.location || sameLocation(detail.location, card.location, exactComponentIdentity));
}

function sameText(left, right) {
  return String(left || "").replace(/\s+/g, " ").trim() === String(right || "").replace(/\s+/g, " ").trim();
}

function sameLocation(left, right, allowBusinessDistrict = false) {
  const compact = value => String(value || "").replace(/[·•・\s]+/g, "").trim();
  if (compact(left) === compact(right)) return true;
  if (!allowBusinessDistrict) return false;
  const parts = value => String(value || "").split(/[·•・\s]+/).map(item => item.trim()).filter(Boolean);
  const leftParts = parts(left);
  const rightParts = parts(right);
  if (leftParts.length < 2 || rightParts.length < 2) return false;
  const city = value => value.replace(/市$/, "");
  const district = value => value.replace(/(?:新区|区|县)$/, "");
  return city(leftParts[0]) === city(rightParts[0]) && district(leftParts[1]) === district(rightParts[1]);
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

async function releaseSearchRenderScope(release, operationError = null) {
  try {
    await release?.();
  } catch (cleanupError) {
    if (!operationError) throw cleanupError;
    const combined = new AggregateError([cleanupError, operationError], cleanupError.message, { cause: operationError });
    for (const property of ['code', 'statusCode', 'details']) {
      if (cleanupError[property] !== undefined) combined[property] = cleanupError[property];
    }
    throw combined;
  }
}

function scanProgressCounters(target, targets, state, targetJobs) {
  const cardLimit = Math.max(0, Math.floor(Number(target?.cardLimit) || 0));
  const completed = Math.min(cardLimit, Array.isArray(targetJobs) ? targetJobs.length : 0);
  const visible = Array.isArray(state?.cards) ? state.cards.length : 0;
  const targetDiscovered = Math.min(cardLimit, Math.max(completed, visible));
  return {
    targetPosition: targets.indexOf(target) + 1,
    targetTotal: targets.length,
    targetDiscovered,
    detailPosition: completed,
    detailTotal: targetDiscovered
  };
}

function searchStateMatches(state, template, keyword, filterSummary) {
  return canonicalizeZhaopinSearchTemplate(state.url).url === template.url
    && new URL(state.url).searchParams.get('kw') === keyword && state.keyword === keyword
    && (!Array.isArray(filterSummary) || sameFilterSummary(state.filterSummary, filterSummary));
}

function sameFilterSummary(current, saved) {
  const selected = values => (Array.isArray(values) ? values : [])
    .map(value => String(value || '').replace(/\s+/g, ' ').trim())
    .filter(value => value && !ZHAOPIN_DEFAULT_FILTER_LABELS.has(value));
  return JSON.stringify(selected(current)) === JSON.stringify(selected(saved));
}

async function resolveZhaopinSearchTab(browser, expectedTabId = null) {
  const allTabs = await browser.listTabs();
  const tabs = allTabs.filter(tab => {
    try { canonicalizeZhaopinSearchTemplate(tab.url); return true; } catch { return false; }
  });
  if (expectedTabId !== null) {
    const expected = tabs.find(tab => tab.id === expectedTabId);
    if (expected) { assertZhaopinWorkspaceWindow(allTabs, expected); return expectedTabId; }
    throw zhaopinError('ZHAOPIN_TAB_BINDING_LOST', '本轮智联搜索标签页已丢失，请恢复后继续。');
  }
  if (tabs.length !== 1) throw zhaopinError('ZHAOPIN_SEARCH_TAB_REQUIRED', '请保留一个智联岗位搜索页并保存条件后开始。');
  assertZhaopinWorkspaceWindow(allTabs, tabs[0]);
  return tabs[0].id;
}

function isZhaopinWorkspaceTab(tab) {
  try {
    const url = new URL(tab.url);
    return ['127.0.0.1', 'localhost'].includes(url.hostname);
  } catch { return false; }
}

function assertZhaopinWorkspaceWindow(tabs, search) {
  if (!String(search?.windowId ?? '').trim()
    || !tabs.some(tab => isZhaopinWorkspaceTab(tab) && tab.windowId === search.windowId)) {
    throw zhaopinError('ZHAOPIN_WINDOW_MISMATCH', '无法确认智联搜索页与 RoleFlow 在同一窗口，请回到同窗今日任务页并检查浏览器窗口信息后重试。');
  }
}

module.exports = { ZhaopinSiteAdapter, ZHAOPIN_PAGE_HELPERS_EXPRESSION, ZHAOPIN_COMPONENT_ACCESSORS_SOURCE, resolveZhaopinSearchTab, isZhaopinWorkspaceTab, assertZhaopinWorkspaceWindow };
