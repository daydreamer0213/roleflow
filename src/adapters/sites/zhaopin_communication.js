const { BossSiteAdapter } = require("./boss");
const {
  ZhaopinSiteAdapter,
  ZHAOPIN_COMPONENT_ACCESSORS_SOURCE,
  resolveZhaopinSearchTab,
  isZhaopinWorkspaceTab,
  releaseSearchRenderScope
} = require("./zhaopin");
const {
  canonicalizeZhaopinSearchTemplate,
  zhaopinJobIdentity
} = require("../../core/zhaopin_search_scope");
const { isBrowserTabId, sameBrowserTabId } = require("../../core/browser_tab_identity");
const {
  ZHAOPIN_MESSAGE_SNAPSHOT_EXPRESSION,
  hasZhaopinOutgoingTextSnapshot,
  isVisibleZhaopinLoginChallenge,
  isZhaopinMessageUrl
} = require("./zhaopin_message_reader");

const PRECHAT_PATH = "/imapi/imV2/createAndUpdateContextV2";
const APPLICATION_PATH = "/c/pc/alan/jobs/application";
const NETWORK_PATHS = Object.freeze([PRECHAT_PATH, APPLICATION_PATH]);
const REJECTED_STATUS_CODES = new Set(["2024", "2025", "2005", "2006", "2007"]);
const REJECTED_ACTION_CODES = new Set(["3000", "3001"]);

const ZHAOPIN_COMMUNICATION_SNAPSHOT_EXPRESSION = String.raw`(() => {
  const isVisibleZhaopinLoginChallenge = ${isVisibleZhaopinLoginChallenge.toString()};
  const clean = value => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  const visible = node => {
    if (!node || node.hidden || node.getAttribute('aria-hidden') === 'true') return false;
    const rect = node.getBoundingClientRect(); const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  };
  const bodyText = clean(document.body?.innerText).slice(0, 3000);
  const summary = document.querySelector('.job-detail-panel .job-detail-summary');
  const prechat = [...(summary?.querySelectorAll('.job-detail-summary__prechat') || [])].filter(visible);
  const apply = [...(summary?.querySelectorAll('.job-detail-summary__apply') || [])].filter(visible);
  const greetingModals = [...document.querySelectorAll('.deliver-greeting-modal,[role="dialog"],.fixture-modal,.modal,.dialog')]
    .filter(visible).filter(node => clean(node.matches('.deliver-greeting-modal')
      ? node.querySelector('.deliver-greeting-modal__title')?.textContent
      : node.textContent) === '已向对方发送打招呼语');
  return {
    risk: /安全验证|访问异常|行为验证|访问受限/.test(document.title || '') || /账户存在异常行为|暂时无法访问/.test(bodyText),
    loginRequired: [...document.querySelectorAll('.login,.login-panel,[class*="login"]')].some(isVisibleZhaopinLoginChallenge),
    prechatCount: prechat.length,
    prechatLabel: prechat.length === 1 ? clean(prechat[0].textContent) : '',
    applyCount: apply.length,
    statusLabel: clean(summary?.querySelector('.job-detail-summary__status')?.textContent),
    greetingModal: greetingModals.length === 1
  };
})()`;

function guardedPrechatExpression(expected) {
  const value = JSON.stringify({ sourceId: expected.sourceId, title: expected.title, company: expected.company });
  return String.raw`(() => {
    const expected = ${value};
    const clean = value => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    const company = value => clean(value).replace(/(?:有限责任公司|股份有限公司|有限公司)$/,'');
    ${ZHAOPIN_COMPONENT_ACCESSORS_SOURCE}
    const validId = value => /^[A-Za-z0-9]{1,160}$/.test(String(value || '')) ? String(value) : '';
    const fail = reason => ({ ready:false, reason });
    if (location.protocol !== 'https:' || location.hostname !== 'www.zhaopin.com' || location.pathname !== '/jobs/' || new URL(location.href).searchParams.get('pageMode') !== 'search') return fail('page_lost');
    const bodyText=clean(document.body?.innerText).slice(0,3000);
    if (/安全验证|访问异常|行为验证|访问受限/.test(document.title || '') || /账户存在异常行为|暂时无法访问/.test(bodyText)) return fail('risk_control');
    const card=document.querySelector('.job-list-panel .job-card.job-card--active'); const summary=document.querySelector('.job-detail-panel .job-detail-summary');
    const job=componentProps(component(card,'JobCard'))?.job;
    const detailVm=component(summary,'JobDetailSummary'); const detail=componentProps(detailVm)?.jobDetail;
    const computed=componentPosition(detailVm);
    const link=document.querySelector('.job-detail-panel .job-company-info__view-all[href*="/jobdetail/"]');
    let linkId=''; try { const url=new URL(link?.href || ''); linkId=(url.origin==='https://www.zhaopin.com' ? (url.pathname.match(/^\/jobdetail\/([A-Za-z0-9]+)\.html?$/i)||[])[1] : '') || '' } catch {}
    const ids=[validId(job?.number),validId(detail?.detailedPosition?.number),validId(computed?.number),linkId];
    const title=clean(summary?.querySelector('.job-detail-summary__title-text')?.textContent);
    const companyText=clean(summary?.querySelector('.job-detail-summary__company-name,.job-company-info__name')?.textContent || document.querySelector('.job-detail-panel .job-company-info__name')?.textContent);
    if (ids.some(id=>id!==expected.sourceId) || clean(job?.name)!==expected.title || title!==expected.title || company(job?.companyName)!==company(expected.company) || company(companyText)!==company(expected.company)) return fail('target_changed');
    const actions=[...(summary?.querySelectorAll('.job-detail-summary__prechat')||[])].filter(node=>{const rect=node.getBoundingClientRect();const style=getComputedStyle(node);return rect.width>0&&rect.height>0&&!node.hidden&&!node.disabled&&node.getAttribute('aria-disabled')!=='true'&&style.display!=='none'&&style.visibility!=='hidden'&&style.pointerEvents!=='none'&&clean(node.textContent)==='先聊聊'});
    if(actions.length!==1)return fail('action_changed'); const action=actions[0]; const rect=action.getBoundingClientRect(); const point={x:Number(rect.left??rect.x)+Number(rect.width)/2,y:Number(rect.top??rect.y)+Number(rect.height)/2};
    const at=document.elementFromPoint(point.x,point.y); if(at!==action&&!action.contains(at))return fail('point_changed');
    return {ready:true,clickPoint:point};
  })()`;
}

class ZhaopinCommunicationAdapter extends ZhaopinSiteAdapter {
  constructor({ nowFn = Date.now, timeoutMs = 120000, pollIntervalMs = 500, pacingState = null, onPacingCheckpoint = null, ...options } = {}) {
    super(options);
    if (typeof nowFn !== "function" || !Number.isFinite(timeoutMs) || timeoutMs <= 0
      || !Number.isFinite(pollIntervalMs) || pollIntervalMs < 0
      || (onPacingCheckpoint !== null && typeof onPacingCheckpoint !== "function")) {
      throw communicationError("ZHAOPIN_COMMUNICATION_OPTIONS_INVALID", "智联沟通适配器参数无效。");
    }
    this.now = nowFn;
    this.timeoutMs = timeoutMs;
    this.pollIntervalMs = pollIntervalMs;
    this.onPacingCheckpoint = onPacingCheckpoint;
    this.pacing = new BossSiteAdapter({ sleepFn: this.sleep, randomFn: this.random, logger: this.logger });
    this.pacing.restorePacing(pacingState);
    this.binding = null;
    this.activeBaselineTabId = null;
    this.prepared = null;
    this.dispatch = null;
    this.dispatchedSourceIds = new Set();
    this.verifiedImResult = null;
    this.busy = "";
    this.restored = false;
  }

  async captureCommunicationSearchState(tabId) {
    if (!isBrowserTabId(tabId)) throw communicationError("ZHAOPIN_COMMUNICATION_BINDING_REQUIRED", "需要有效的智联搜索标签页。");
    await this.readSearchState(tabId);
    const state = await this.browser.evalValue(tabId, `(() => ({url:location.href,scrollTop:Math.max(0,Math.floor(window.scrollY||document.documentElement.scrollTop||0))}))()`);
    const url = trustedSearchUrl(state?.url);
    if (!url || !Number.isInteger(state?.scrollTop) || state.scrollTop < 0) {
      throw communicationError("ZHAOPIN_SEARCH_PAGE_LOST", "智联搜索页无法提供安全的恢复状态。");
    }
    return { url, scrollTop: state.scrollTop };
  }

  bindCommunicationTabs(binding = {}) {
    const next = normalizeBinding(binding);
    if (this.binding && JSON.stringify(this.binding) !== JSON.stringify(next)) {
      throw communicationError("ZHAOPIN_OPERATOR_TABS_CHANGED", "智联固定标签页不能在沟通过程中重新绑定。");
    }
    this.binding = next;
    this.restored = false;
  }

  async beginCommunicationSession() {
    if (!this.binding) throw communicationError("ZHAOPIN_COMMUNICATION_BINDING_REQUIRED", "智联沟通需要固定搜索标签页绑定。");
    const current = await this.assertBoundTabs({ requireSearch: true, establishActiveBaseline: true });
    this.verifiedImResult = null;
    this.restored = false;
    return current.searchTab.id;
  }

  async restoreCommunicationSearchPage(signal = null) {
    await this.cleanupResources();
    if (!this.binding || this.restored || signal?.aborted) return;
    const current = await this.assertBoundTabs({ allowIm: true });
    throwIfAborted(signal);
    if (isZhaopinMessageUrl(current.searchTab.url)) {
      const snapshot = await this.browser.evalValue(this.binding.searchTabId, ZHAOPIN_MESSAGE_SNAPSHOT_EXPRESSION);
      throwIfAborted(signal);
      hasZhaopinOutgoingTextSnapshot(snapshot, {});
    } else {
      await this.readSearchState(this.binding.searchTabId, signal);
      throwIfAborted(signal);
    }
    await this.reserve("list_navigation", { source: "zhaopin", restore: true });
    throwIfAborted(signal);
    await this.pacing.waitWithPacing("list", {
      signal,
      assertTabBindings: () => this.assertBoundTabs({ allowIm: true })
    });
    throwIfAborted(signal);
    await this.assertBoundTabs({ allowIm: true });
    throwIfAborted(signal);
    await this.browser.navigate(this.binding.searchTabId, this.binding.searchReturnUrl);
    throwIfAborted(signal);
    const template = canonicalizeZhaopinSearchTemplate(this.binding.searchReturnUrl);
    const keyword = new URL(this.binding.searchReturnUrl).searchParams.get("kw") || "";
    await this.waitForSearchReady(this.binding.searchTabId, {
      searchTemplate: template,
      keyword,
      signal,
      assertTabBindings: () => this.assertBoundTabs({ requireSearch: true })
    });
    throwIfAborted(signal);
    await this.browser.evalValue(this.binding.searchTabId, `(() => {const requested=${JSON.stringify(this.binding.searchScrollTop)};const maximum=Math.max(0,document.documentElement.scrollHeight-innerHeight);const applied=Math.min(maximum,requested);scrollTo(0,applied);return {requested,applied}})()`);
    throwIfAborted(signal);
    this.verifiedImResult = null;
    await this.assertBoundTabs({ requireSearch: true });
    throwIfAborted(signal);
    this.restored = true;
  }

  async inspectCommunicationJob(job, signal = null) {
    this.begin("inspection");
    let releaseSearchRendering = null;
    let operationError = null;
    try {
      const expected = normalizeJob(job);
      throwIfAborted(signal);
      const bound = await this.assertBoundTabs({ allowIm: true });
      const returningFromIm = isZhaopinMessageUrl(bound.searchTab.url);
      if (returningFromIm) {
        const previous = this.verifiedImResult;
        const snapshot = await this.browser.evalValue(this.binding.searchTabId, ZHAOPIN_MESSAGE_SNAPSHOT_EXPRESSION);
        if (!previous || !hasZhaopinOutgoingTextSnapshot(snapshot, previous)) {
          throw communicationError("ZHAOPIN_SEARCH_PAGE_LOST", "智联工作标签页进入了未经核验的沟通页面。");
        }
      } else {
        this.verifiedImResult = null;
        releaseSearchRendering = await this.openSearchRenderScope(this.binding.searchTabId);
        const current = await this.currentSelectedInspection(expected, signal);
        if (current) return current;
      }
      await this.reserve("list_navigation", { source: "zhaopin", sourceId: expected.sourceId });
      await this.pacing.waitWithPacing("list", {
        signal,
        assertTabBindings: () => this.assertBoundTabs(returningFromIm ? { allowIm: true } : { requireSearch: true })
      });
      await this.assertBoundTabs(returningFromIm ? { allowIm: true } : { requireSearch: true });
      await this.browser.navigate(this.binding.searchTabId, expected.searchUrl);
      this.verifiedImResult = null;
      if (!releaseSearchRendering) releaseSearchRendering = await this.openSearchRenderScope(this.binding.searchTabId);
      const template = canonicalizeZhaopinSearchTemplate(expected.searchUrl);
      const keyword = new URL(expected.searchUrl).searchParams.get("kw") || "";
      await this.waitForSearchReady(this.binding.searchTabId, {
        searchTemplate: template,
        keyword,
        signal,
        assertTabBindings: () => this.assertBoundTabs({ requireSearch: true })
      });
      for (let scrolls = 0; scrolls <= 20; scrolls += 1) {
        throwIfAborted(signal);
        await this.assertBoundTabs({ requireSearch: true });
        const state = await this.readSearchState(this.binding.searchTabId);
        const card = state.cards.find((item) => item.sourceId === expected.sourceId);
        if (card) return await this.inspectCard(expected, card, signal);
        if (state.confirmedEnd || scrolls === 20) break;
        await this.pace("scroll", signal);
        await this.reserve("list_scroll", { source: "zhaopin", sourceId: expected.sourceId });
        await this.assertBoundTabs({ requireSearch: true });
        await this.browser.evalValue(this.binding.searchTabId, "(() => window.__zhaopinScrollResults())()");
      }
      throw communicationError("ZHAOPIN_COMMUNICATION_TARGET_NOT_FOUND", "保存的智联岗位未在当前结果中找到，已保留剩余项目。");
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      try {
        await releaseSearchRenderScope(releaseSearchRendering, operationError);
      } finally {
        this.end("inspection");
      }
    }
  }

  async prepareCommunicationDispatch(inspection, signal = null) {
    this.begin("preparation");
    try {
      const expected = inspectionJob(inspection);
      if (!expected) throw communicationError("ZHAOPIN_COMMUNICATION_INSPECTION_INVALID", "需要刚刚核验通过的智联岗位。");
      if (this.dispatchedSourceIds.has(expected.sourceId)) throw communicationError("ZHAOPIN_COMMUNICATION_ALREADY_DISPATCHED", "该智联岗位已进入沟通发送，不能重复点击。");
      assertBrowserCapabilities(this.browser);
      throwIfAborted(signal);
      await this.cleanupResources();
      await this.assertBoundTabs({ requireSearch: true });
      const ready = await this.currentSelectedInspection(expected, signal);
      if (ready?.state !== "ready") throw communicationError("ZHAOPIN_COMMUNICATION_TARGET_CHANGED", "智联岗位在发送准备前已变化。");
      const tabId = this.binding.searchTabId;
      const start = await this.browser.startNetworkLog(tabId, {
        maxEntries: 12,
        maxBodies: 4,
        maxBodyBytes: 8192,
        resourceTypes: ["XHR", "Fetch"],
        bodyUrlIncludes: [PRECHAT_PATH],
        urlIncludes: NETWORK_PATHS,
        captureBodies: true,
        clear: true
      });
      const prepared = { expected, tabId, networkSequence: null, networkStarted: true, focusEnabled: false };
      this.prepared = prepared;
      validateStart(start, tabId);
      const mark = await this.browser.getNetworkLogMark(tabId);
      prepared.networkSequence = validateMark(mark, tabId);
      let cancelled = false;
      return {
        state: "prepared",
        sourceId: expected.sourceId,
        cancel: async () => {
          if (cancelled) return;
          if (this.prepared !== prepared) {
            cancelled = true;
            return;
          }
          try {
            await this.cleanupResources();
          } finally {
            cancelled = this.prepared !== prepared;
          }
        }
      };
    } catch (error) {
      await this.cleanupResources();
      throw error;
    } finally {
      this.end("preparation");
    }
  }

  async dispatchCommunication(inspection, signal = null) {
    const expected = inspectionJob(inspection);
    if (!expected) throw communicationError("ZHAOPIN_COMMUNICATION_INSPECTION_INVALID", "需要刚刚核验通过的智联岗位。");
    if (!samePrepared(this.prepared, expected)) await this.prepareCommunicationDispatch(inspection, signal);
    this.begin("dispatch");
    try {
      if (this.dispatchedSourceIds.has(expected.sourceId)) throw communicationError("ZHAOPIN_COMMUNICATION_ALREADY_DISPATCHED", "该智联岗位已进入沟通发送，不能重复点击。");
      const prepared = this.prepared;
      if (!samePrepared(prepared, expected)) throw communicationError("ZHAOPIN_COMMUNICATION_PREPARATION_LOST", "智联沟通准备状态已丢失。");
      throwIfAborted(signal);
      await this.assertBoundTabs({ requireSearch: true });
      await this.browser.cdp(prepared.tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
      prepared.focusEnabled = true;
      await this.assertBoundTabs({ requireSearch: true });
      const guarded = await this.browser.evalValue(prepared.tabId, guardedPrechatExpression(expected));
      throwIfAborted(signal);
      if (guarded?.ready !== true) throw guardedError(guarded?.reason);
      prepared.dispatchNotBeforeMs = this.now();
      if (!Number.isFinite(prepared.dispatchNotBeforeMs)) throw communicationError("ZHAOPIN_COMMUNICATION_CLOCK_INVALID", "无法建立智联发送时间边界。");
      this.dispatchedSourceIds.add(expected.sourceId);
      this.dispatch = prepared;
      this.prepared = null;
      await this.browser.clickAt(prepared.tabId, guarded.clickPoint);
      return { state: "dispatched", sourceId: expected.sourceId };
    } catch (error) {
      if (this.dispatch || this.prepared) await this.cleanupResources();
      throw error;
    } finally {
      this.end("dispatch");
    }
  }

  async verifyCommunicationResult(job, signal = null) {
    this.begin("verification");
    try {
      const expected = normalizeJob(job);
      const dispatch = this.dispatch;
      if (!samePrepared(dispatch, expected) || !Number.isFinite(dispatch.dispatchNotBeforeMs)) {
        throw communicationError("ZHAOPIN_COMMUNICATION_DISPATCH_MISSING", "没有可核验的智联发送记录。");
      }
      const deadline = this.now() + this.timeoutMs;
      let lastEvidence = { endpoints: [], pageState: "no_matching_request", diagnostics: {} };
      while (true) {
        throwIfAborted(signal);
        await this.assertVerificationPageSafe();
        const log = await this.browser.readNetworkLog(dispatch.tabId, {
          sinceSequence: dispatch.networkSequence,
          maxEntries: 12,
          includeBodies: true,
          resourceTypes: ["XHR", "Fetch"],
          urlIncludes: NETWORK_PATHS,
          consume: false
        });
        const network = classifyNetworkLog(log, dispatch);
        lastEvidence = network.evidence;
        if (network.state === "application_observed") {
          return { state: "ambiguous", errorCode: "ZHAOPIN_APPLICATION_ENDPOINT_OBSERVED", evidence: lastEvidence };
        }
        if (network.state === "transport_failed") return { state: "transport_failed", evidence: lastEvidence };
        if (network.state === "platform_rejected") return { state: "platform_rejected", evidence: lastEvidence };
        if (network.state === "accepted" && log?.meta?.pendingRequests === 0) {
          const pageState = await this.verifyPageOutcome(expected, network.sessionId);
          if (pageState.succeeded) {
            this.verifiedImResult = pageState.sameTabIm ? Object.freeze({ sessionId: network.sessionId, jobNumber: expected.sourceId }) : null;
            return { state: "succeeded", evidence: { ...lastEvidence, pageState: pageState.pageState, diagnostics: pageState.diagnostics } };
          }
          lastEvidence = { ...lastEvidence, pageState: pageState.pageState, diagnostics: pageState.diagnostics };
        }
        if (this.now() >= deadline) {
          return {
            state: "ambiguous",
            errorCode: network.state === "none" && log?.meta?.pendingRequests === 0
              ? "COMMUNICATION_ACTION_NOT_TRIGGERED" : "COMMUNICATION_RESULT_AMBIGUOUS",
            evidence: {
              ...lastEvidence,
              pageState: Number(log?.meta?.pendingRequests || 0) > 0 ? "request_pending" : lastEvidence.pageState
            }
          };
        }
        await abortableSleep(this.sleep(this.pollIntervalMs), signal);
      }
    } finally {
      try {
        await this.cleanupResources();
      } finally {
        this.end("verification");
      }
    }
  }

  async currentSelectedInspection(expected, signal) {
    const state = await this.readSearchState(this.binding.searchTabId);
    const card = state.cards[state.selectedIndex];
    if (!card || card.sourceId !== expected.sourceId) return null;
    if (!sameTarget(expected, card, state.detail)) return { state: "target_mismatch" };
    return this.inspectCard(expected, card, signal);
  }

  async inspectCard(expected, card, signal) {
    await this.pace("pane_detail_read", signal);
    await this.pacing.waitForPendingDetailCooldown({
      signal,
      assertTabBindings: () => this.assertBoundTabs({ requireSearch: true }),
      onPacingCheckpoint: this.onPacingCheckpoint
    });
    let detail;
    try {
      detail = await this.readVisiblePaneDetail(this.binding.searchTabId, card, signal, () => this.assertBoundTabs({ requireSearch: true }));
    } finally {
      await this.pacing.waitAfterDetailAction({
        signal,
        assertTabBindings: () => this.assertBoundTabs({ requireSearch: true }),
        onPacingCheckpoint: this.onPacingCheckpoint
      });
    }
    if (!detail || !sameTarget(expected, card, detail)) return { state: "target_mismatch" };
    const snapshot = await this.readCommunicationSnapshot();
    if (isUnavailableStatus(snapshot.statusLabel)) return { state: "job_unavailable", statusLabel: snapshot.statusLabel };
    if (snapshot.greetingModal === true) return { state: "action_unavailable" };
    if (snapshot.prechatCount !== 1 || snapshot.prechatLabel !== "先聊聊") return { state: "action_unavailable" };
    return Object.freeze({ state: "ready", ...expected, actionLabel: "先聊聊" });
  }

  async readCommunicationSnapshot() {
    const snapshot = await this.browser.evalValue(this.binding.searchTabId, ZHAOPIN_COMMUNICATION_SNAPSHOT_EXPRESSION);
    if (snapshot?.risk) throw communicationError("ZHAOPIN_RISK_CONTROL", "智联当前要求安全验证，已停止沟通。");
    if (snapshot?.loginRequired) throw communicationError("ZHAOPIN_LOGIN_REQUIRED", "智联登录状态已失效，已停止沟通。");
    return snapshot && typeof snapshot === "object" ? snapshot : {};
  }

  async verifyPageOutcome(expected, sessionId) {
    const current = await this.assertBoundTabs({ allowIm: true });
    if (isZhaopinMessageUrl(current.searchTab.url)) {
      const snapshot = await this.browser.evalValue(this.binding.searchTabId, ZHAOPIN_MESSAGE_SNAPSHOT_EXPRESSION);
      const succeeded = hasZhaopinOutgoingTextSnapshot(snapshot, { sessionId, jobNumber: expected.sourceId });
      return { succeeded, sameTabIm: true, pageState: succeeded ? "succeeded" : "page_unverified", diagnostics: { dialogVisible: false } };
    }
    const state = await this.readSearchState(this.binding.searchTabId);
    const card = state.cards[state.selectedIndex];
    const exact = !state.loading && card && card.sourceId === expected.sourceId && sameTarget(expected, card, state.detail);
    const snapshot = await this.readCommunicationSnapshot();
    const succeeded = Boolean(exact && snapshot.greetingModal === true);
    return { succeeded, sameTabIm: false, pageState: succeeded ? "confirmation_dialog" : "page_unverified", diagnostics: { dialogVisible: snapshot.greetingModal === true } };
  }

  async assertVerificationPageSafe() {
    const current = await this.assertBoundTabs({ allowIm: true });
    if (isZhaopinMessageUrl(current.searchTab.url)) {
      const snapshot = await this.browser.evalValue(this.binding.searchTabId, ZHAOPIN_MESSAGE_SNAPSHOT_EXPRESSION);
      hasZhaopinOutgoingTextSnapshot(snapshot, {});
    } else {
      await this.readCommunicationSnapshot();
    }
  }

  async assertBoundTabs({ requireSearch = false, allowIm = false, establishActiveBaseline = false } = {}) {
    if (!this.binding) throw communicationError("ZHAOPIN_COMMUNICATION_BINDING_REQUIRED", "智联沟通需要固定搜索标签页绑定。");
    const tabs = await this.browser.listTabs();
    const searchTab = tabs.find((tab) => sameBrowserTabId(tab?.id, this.binding.searchTabId));
    if (!searchTab) throw communicationError("ZHAOPIN_OPERATOR_TABS_CHANGED", "智联固定搜索标签页已丢失。");
    if (searchTab.windowId !== this.binding.windowId) throw communicationError("ZHAOPIN_WINDOW_MISMATCH", "智联固定搜索标签页已移动到其他窗口。");
    const active = tabs.filter((tab) => tab.windowId === this.binding.windowId && tab.active === true);
    if (active.length !== 1 || !isBrowserTabId(active[0].id)) throw communicationError("ZHAOPIN_ACTIVE_TAB_CHANGED", "无法确认当前窗口的活动标签页。");
    if (establishActiveBaseline) this.activeBaselineTabId = active[0].id;
    else if (!sameBrowserTabId(active[0].id, this.activeBaselineTabId)) throw communicationError("ZHAOPIN_ACTIVE_TAB_CHANGED", "沟通过程改变了用户当前标签页。");
    const search = Boolean(trustedSearchUrl(searchTab.url));
    if ((requireSearch && !search) || (!search && !(allowIm && isZhaopinMessageUrl(searchTab.url)))) {
      throw communicationError("ZHAOPIN_SEARCH_PAGE_LOST", "智联工作标签页离开了允许的搜索或沟通结果页面。");
    }
    return { searchTab, windowId: this.binding.windowId };
  }

  async pace(kind, signal = null) {
    return this.pacing.waitWithPacing(kind, {
      signal,
      assertTabBindings: () => this.assertBoundTabs({ requireSearch: true })
    });
  }

  async reserve(kind, details) {
    return this.accessController?.reserve?.(kind, details);
  }

  async disableFocus(resource) {
    if (!resource?.focusEnabled) return;
    await this.browser.cdp(resource.tabId, "Emulation.setFocusEmulationEnabled", { enabled: false });
    resource.focusEnabled = false;
  }

  async safeStopNetworkLog(tabId) {
    if (!isBrowserTabId(tabId) || typeof this.browser?.stopNetworkLog !== "function") return;
    await this.browser.stopNetworkLog(tabId, { clear: true, detachIfIdle: false });
  }

  async cleanupResources() {
    const resources = [["prepared", this.prepared], ["dispatch", this.dispatch]].filter(([, resource]) => resource);
    let failure = null;
    for (const [owner, resource] of resources) {
      try { await this.disableFocus(resource); } catch (error) { failure ||= error; }
      if (resource.networkStarted) {
        try {
          await this.safeStopNetworkLog(resource.tabId);
          resource.networkStarted = false;
        } catch (error) {
          failure ||= error;
        }
      }
      if (!resource.focusEnabled && !resource.networkStarted && this[owner] === resource) this[owner] = null;
    }
    if (failure) throw failure;
  }

  begin(kind) {
    if (this.busy) throw communicationError("ZHAOPIN_COMMUNICATION_BUSY", `智联沟通 ${this.busy} 尚未结束。`);
    this.busy = kind;
  }

  end(kind) {
    if (this.busy === kind) this.busy = "";
  }
}

async function inspectZhaopinCommunicationTabs({ browser, adapter } = {}) {
  if (typeof browser?.listTabs !== "function" || typeof adapter?.preflight !== "function") {
    throw communicationError("ZHAOPIN_COMMUNICATION_BROWSER_CAPABILITY_MISSING", "智联沟通标签页检查缺少浏览器能力。");
  }
  const tabId = await resolveZhaopinSearchTab(browser);
  const tabs = await browser.listTabs();
  const searchTab = tabs.find((tab) => sameBrowserTabId(tab?.id, tabId));
  if (!searchTab || !Number.isInteger(searchTab.windowId) || searchTab.windowId <= 0
    || !tabs.some((tab) => tab.windowId === searchTab.windowId && isZhaopinWorkspaceTab(tab))) {
    throw communicationError("ZHAOPIN_WINDOW_MISMATCH", "无法确认智联搜索页与 RoleFlow 在同一窗口。");
  }
  await adapter.preflight({ tabId });
  return { windowId: searchTab.windowId, searchTab };
}

function normalizeJob(job = {}) {
  const sourceId = String(job.sourceId || "").trim();
  const title = clean(job.title);
  const company = clean(job.company);
  let identity;
  try { identity = zhaopinJobIdentity(job.url); } catch {}
  const searchUrl = trustedSearchUrl(job.searchUrl);
  if (job.source !== "zhaopin" || !/^[A-Za-z0-9]{1,160}$/.test(sourceId)
    || identity?.sourceId !== sourceId || !title || !company || !searchUrl
    || !(new URL(searchUrl).searchParams.get("kw") || "").trim()) {
    throw communicationError("ZHAOPIN_COMMUNICATION_JOB_INVALID", "智联沟通岗位缺少冻结的精确身份或搜索地址。");
  }
  return Object.freeze({ sourceId, title, company, searchUrl, url: identity.url });
}

function inspectionJob(inspection) {
  if (inspection?.state !== "ready" || inspection?.actionLabel !== "先聊聊") return null;
  try { return normalizeJob({ ...inspection, source: "zhaopin" }); } catch { return null; }
}

function samePrepared(prepared, expected) {
  return Boolean(prepared && prepared.expected.sourceId === expected.sourceId
    && prepared.expected.title === expected.title && prepared.expected.company === expected.company
    && prepared.expected.searchUrl === expected.searchUrl && isBrowserTabId(prepared.tabId)
    && Number.isInteger(prepared.networkSequence) && prepared.networkSequence >= 0);
}

function normalizeBinding(value) {
  const searchReturnUrl = trustedSearchUrl(value?.searchReturnUrl);
  if (!["edge", "portable"].includes(value?.mode)
    || !Number.isInteger(value?.windowId) || value.windowId <= 0
    || !isBrowserTabId(value?.searchTabId)
    || !searchReturnUrl
    || !Number.isInteger(value?.searchScrollTop) || value.searchScrollTop < 0
    || !Number.isInteger(value?.bindingGeneration) || value.bindingGeneration <= 0) {
    throw communicationError("ZHAOPIN_COMMUNICATION_BINDING_REQUIRED", "智联沟通需要完整的固定搜索标签页绑定。");
  }
  return Object.freeze({
    mode: value.mode,
    windowId: value.windowId,
    searchTabId: value.searchTabId,
    searchReturnUrl,
    searchScrollTop: value.searchScrollTop,
    bindingGeneration: value.bindingGeneration
  });
}

function validateStart(value, tabId) {
  if (value?.tabId !== undefined && !sameBrowserTabId(value.tabId, tabId)) {
    throw communicationError("ZHAOPIN_COMMUNICATION_NETWORK_UNAVAILABLE", "智联网络观察标签页发生变化。");
  }
  const direct = value?.started === true;
  const edge = sameBrowserTabId(value?.tabId, tabId) && value?.meta?.enabled === true;
  if (!direct && !edge) throw communicationError("ZHAOPIN_COMMUNICATION_NETWORK_UNAVAILABLE", "浏览器未确认智联网络观察已启动。");
}

function validateMark(value, tabId) {
  if (value?.tabId !== undefined && !sameBrowserTabId(value.tabId, tabId)) {
    throw communicationError("ZHAOPIN_COMMUNICATION_NETWORK_UNAVAILABLE", "智联网络观察标签页发生变化。");
  }
  const sequence = value?.mark?.lastSequence;
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw communicationError("ZHAOPIN_COMMUNICATION_NETWORK_UNAVAILABLE", "智联网络观察缺少有效序号。");
  }
  if (value?.meta !== undefined && value?.meta?.enabled !== true) {
    throw communicationError("ZHAOPIN_COMMUNICATION_NETWORK_UNAVAILABLE", "智联网络观察状态无效。");
  }
  return sequence;
}

function classifyNetworkLog(log, dispatch) {
  const entries = Array.isArray(log?.entries) ? log.entries.slice(0, 12) : [];
  const observations = [];
  for (const entry of entries) {
    const observation = normalizeNetworkEntry(entry, dispatch);
    if (observation) observations.push(observation);
  }
  const matching = observations.filter((entry) => entry.kind === "prechat" && entry.targetMatched);
  if (observations.some((entry) => entry.malformed || (entry.kind === "prechat" && !entry.targetMatched))) {
    return { state: "ambiguous", evidence: { endpoints: matching.map(safeEndpoint), pageState: "request_conflict", diagnostics: diagnostics(log) } };
  }
  const application = observations.find((entry) => entry.kind === "application");
  if (application) return { state: "application_observed", evidence: { endpoints: [], pageState: "request_conflict", diagnostics: diagnostics(log) } };
  if (!matching.length) return { state: "none", evidence: { endpoints: [], pageState: Number(log?.meta?.pendingRequests || 0) > 0 ? "request_pending" : "no_matching_request", diagnostics: diagnostics(log) } };
  if (matching.length !== 1) return { state: "ambiguous", evidence: { endpoints: matching.map(safeEndpoint), pageState: "request_conflict", diagnostics: diagnostics(log) } };
  const entry = matching[0];
  const evidence = { endpoints: [safeEndpoint(entry)], pageState: entry.pageState, diagnostics: diagnostics(log) };
  return { state: entry.state, sessionId: entry.sessionId, evidence };
}

function normalizeNetworkEntry(entry, dispatch) {
  let url;
  try { url = new URL(String(entry.url || "")); } catch { return null; }
  const method = String(entry.method || "").toUpperCase();
  const kind = url.origin === "https://fe-api.zhaopin.com" && url.pathname === APPLICATION_PATH && method === "POST"
    ? "application"
    : url.origin === "https://cgate.zhaopin.com" && url.pathname === PRECHAT_PATH && method === "GET" ? "prechat" : "";
  if (!kind) return null;
  if (Number.isInteger(entry?.sequence) && entry.sequence <= dispatch.networkSequence) return null;
  const started = Date.parse(String(entry.startedAt || ""));
  if (Number.isFinite(started) && started < dispatch.dispatchNotBeforeMs) return null;
  if (!Number.isInteger(entry?.sequence) || !Number.isFinite(started)) return { kind, malformed: true };
  const completed = Date.parse(String(entry.completedAt || ""));
  if (!Number.isFinite(completed)) return null;
  if (kind === "application") return { kind };
  const target = entry.requestTarget && typeof entry.requestTarget === "object"
    ? entry.requestTarget : targetFromRawUrl(url);
  if (!target) return { kind: "prechat", malformed: true };
  const targetMatched = target.jobNumber === dispatch.expected.sourceId && target.scene === "2" && target.operateType === "2";
  const elapsedMs = Math.max(0, Math.min(60000, completed - started));
  if (entry.failed === true) return { kind: "prechat", targetMatched, state: "transport_failed", businessCategory: "network_rejected", pageState: "request_failed", elapsedMs };
  const status = entry.status;
  if (!Number.isInteger(status)) return { kind: "prechat", targetMatched, state: "ambiguous", businessCategory: "response_unparsed", pageState: "request_unparsed", elapsedMs };
  if (status < 200 || status >= 300) return { kind: "prechat", targetMatched, state: "platform_rejected", httpStatus: status, businessCategory: "http_failure", pageState: "request_rejected", elapsedMs };
  const outcome = responseOutcome(entry.content);
  return { kind: "prechat", targetMatched, httpStatus: status, elapsedMs, ...outcome };
}

function targetFromRawUrl(url) {
  const fields = [
    ["jobNumber", "jobNumber"],
    ["positionChatBeforeDeliveryScene", "scene"],
    ["positionChatBeforeDeliveryOperateType", "operateType"]
  ];
  const target = {};
  for (const [query, name] of fields) {
    const values = url.searchParams.getAll(query);
    if (values.length !== 1) return null;
    target[name] = String(values[0] || "");
  }
  return target;
}

function responseOutcome(content) {
  let body;
  try { body = JSON.parse(String(content || "")); } catch {
    return { state: "ambiguous", businessCategory: "response_unparsed", pageState: "request_unparsed" };
  }
  const statusCode = safeCode(body?.statusCode);
  const actionCode = safeCode(body?.actionCode);
  const businessCode = REJECTED_STATUS_CODES.has(statusCode) ? statusCode : REJECTED_ACTION_CODES.has(actionCode) ? actionCode : "";
  if (businessCode) return { state: "platform_rejected", businessCategory: "business_rejected", businessCode, pageState: "request_rejected" };
  const sessionId = String(body?.data?.sessionId || body?.sessionId || "").trim();
  if (!/^[a-f0-9]{32}$/i.test(sessionId)) return { state: "ambiguous", businessCategory: "response_unparsed", pageState: "request_unparsed" };
  return { state: "accepted", businessCategory: "success", pageState: "request_accepted", sessionId };
}

function safeEndpoint(entry) {
  return {
    endpointKind: "zhaopin_prechat",
    ...(Number.isInteger(entry.httpStatus) && entry.httpStatus >= 100 && entry.httpStatus <= 599 ? { httpStatus: entry.httpStatus } : {}),
    ...(entry.businessCode ? { businessCode: entry.businessCode } : {}),
    businessCategory: entry.businessCategory,
    elapsedMs: entry.elapsedMs
  };
}

function diagnostics(log) {
  const pending = Number(log?.meta?.pendingRequests);
  return Number.isInteger(pending) && pending >= 0 && pending <= 100 ? { pendingRequests: pending } : {};
}

function trustedSearchUrl(value) {
  try {
    canonicalizeZhaopinSearchTemplate(value);
    const url = new URL(String(value));
    const keywords = url.searchParams.getAll("kw");
    if (url.hash || keywords.length !== 1 || !keywords[0].trim()) return "";
    return url.toString();
  } catch { return ""; }
}

function sameTarget(expected, card, detail) {
  return card?.sourceId === expected.sourceId
    && detail?.sourceId === expected.sourceId
    && clean(card.title) === expected.title
    && clean(detail.title) === expected.title
    && sameCompany(card.company, expected.company)
    && sameCompany(detail.company || card.company, expected.company);
}

function sameCompany(left, right) {
  const normalize = value => clean(value).replace(/(?:有限责任公司|股份有限公司|有限公司)$/, "");
  return Boolean(normalize(left) && normalize(right)) && normalize(left) === normalize(right);
}

function isUnavailableStatus(value) {
  return new Set(["停止招聘", "已停止招聘", "职位已关闭", "职位已下架", "已下架"]).has(clean(value));
}

function safeCode(value) {
  const code = String(value == null ? "" : value).trim();
  return /^[A-Za-z0-9_-]{1,32}$/.test(code) ? code : "";
}

function assertBrowserCapabilities(browser) {
  for (const method of ["cdp", "clickAt", "startNetworkLog", "getNetworkLogMark", "readNetworkLog", "stopNetworkLog"]) {
    if (typeof browser?.[method] !== "function") {
      throw communicationError("ZHAOPIN_COMMUNICATION_BROWSER_CAPABILITY_MISSING", `智联沟通浏览器缺少 ${method}。`);
    }
  }
}

function guardedError(reason) {
  const code = reason === "risk_control" ? "ZHAOPIN_RISK_CONTROL"
    : reason === "page_lost" ? "ZHAOPIN_SEARCH_PAGE_LOST" : "ZHAOPIN_COMMUNICATION_TARGET_CHANGED";
  return communicationError(code, "智联岗位或“先聊聊”按钮在发送前已变化。");
}

function clean(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw communicationError("ZHAOPIN_COMMUNICATION_ABORTED", "智联沟通已取消。");
}

function abortableSleep(promise, signal) {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => { cleanup(); reject(communicationError("ZHAOPIN_COMMUNICATION_ABORTED", "智联沟通已取消。")); };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) return onAbort();
    Promise.resolve(promise).then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

function communicationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  ZhaopinCommunicationAdapter,
  inspectZhaopinCommunicationTabs
};
