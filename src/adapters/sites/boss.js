const fs = require("fs");
const { parseBossActivityText } = require("../../core/activity_status");
const { mergeJobMetadata } = require("../../core/job_metadata");
const { canonicalizeBossSearchTemplate } = require("../../core/inherited_search_scope");
const { normalizePlatformFilterCatalog } = require("../../core/platform_filters");
const { PRODUCT_POLICY } = require("../../core/product_policy");
const { isBrowserTabId, sameBrowserTabId } = require("../../core/browser_tab_identity");

const SEARCH_PLAN_POLICY = PRODUCT_POLICY.searchPlan;
const REFRESH_LIMIT = PRODUCT_POLICY.operations.refreshLimit;
const BOSS_PACING_POLICY = PRODUCT_POLICY.operations.bossPacing;
const PACING_STATE_FIELDS = Object.freeze([
  "pacedActions",
  "nextPacingCooldownAt",
  "detailActions",
  "nextDetailMicroCooldownAt",
  "nextDetailMacroCooldownAt"
]);

const DEFAULT_CITY_CODE = "101280100";
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

  window.__bossCardActivationPoint = function(jobId) {
    const expectedJobId = String(jobId || "").trim();
    if (!expectedJobId) return { ready: false, jobId: "", x: 0, y: 0, reason: "job_id_missing" };
    const card = window.__bossCards().find((item) => {
      const href = (item.querySelector('a[href*="/job_detail/"]') || item.querySelector("a"))?.href || "";
      const id = (href.match(/\/job_detail\/([^/?#]+)\.html/i) || [])[1] || "";
      return id === expectedJobId;
    });
    if (!card) return { ready: false, jobId: "", x: 0, y: 0, reason: "card_not_found" };
    const wrap = card.closest(".job-card-wrap") || card;
    const component = wrap.__vue__ || card.__vue__ || null;
    const componentJobId = String(component?.data?.encryptJobId || "").trim();
    if (componentJobId !== expectedJobId) {
      return { ready: false, jobId: componentJobId, x: 0, y: 0, reason: "component_job_mismatch" };
    }
    wrap.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
    const rect = wrap.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    if (!(rect.width > 0 && rect.height > 0)) {
      return { ready: false, jobId: componentJobId, x: 0, y: 0, reason: "card_not_visible" };
    }
    if (!(x >= 0 && y >= 0 && x < viewportWidth && y < viewportHeight)) {
      return { ready: false, jobId: componentJobId, x: 0, y: 0, reason: "point_out_of_viewport" };
    }
    if (typeof document.elementFromPoint !== "function") {
      return { ready: false, jobId: componentJobId, x: 0, y: 0, reason: "point_unavailable" };
    }
    const hit = document.elementFromPoint(x, y);
    if (!hit) {
      return { ready: false, jobId: componentJobId, x: 0, y: 0, reason: "point_unavailable" };
    }
    if (!wrap.contains(hit)) {
      return { ready: false, jobId: componentJobId, x: 0, y: 0, reason: "point_obscured" };
    }
    const interactive = hit.closest?.("a,button,[role=button],input,select,textarea,label");
    if (interactive && (interactive === wrap || wrap.contains(interactive))) {
      return { ready: false, jobId: componentJobId, x: 0, y: 0, reason: "interactive_hit" };
    }
    return { ready: true, jobId: componentJobId, x, y, reason: "" };
  };

  window.__bossExtractCards = function(maxCards) {
    const salaryRe = /\d+\s*[-~—]\s*\d+\s*K(?:·\d+薪)?|\d+\s*K(?:·\d+薪)?|面议/;
    const salaryLineRe = /^(?:\d+\s*[-~—]\s*\d+\s*K(?:·\d+薪)?|\d+\s*K(?:·\d+薪)?|面议)$/;
    const expRe = /经验不限|在校|应届|无经验|\d+年|本科|大专|硕士|博士|学历不限/;
    const cityRe = /^(广州|深圳|佛山|东莞|珠海|北京|上海|杭州|成都|武汉|南京|苏州|远程)($|·)/;
    return window.__bossCards().slice(0, Number(maxCards) || 0).map((card, index) => {
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

  const detailFetchStore = window.__bossDetailFetchStore?.version === 2
    ? window.__bossDetailFetchStore
    : { version: 2, sessions: new Map(), runningKey: "" };
  window.__bossDetailFetchStore = detailFetchStore;
  const detailFetchTimeoutMs = Math.min(20000, Math.max(1000, Number(window.__bossDetailFetchTimeoutMs) || 20000));

  function detailFetchIdentity(sessionOrJobId, optionalJobId) {
    const legacy = optionalJobId === undefined;
    return {
      sessionId: String(legacy ? "legacy" : sessionOrJobId || "").trim(),
      jobId: String(legacy ? sessionOrJobId : optionalJobId || "").trim()
    };
  }

  function detailFetchSession(sessionId) {
    let session = detailFetchStore.sessions.get(sessionId);
    if (!session) {
      session = { fetches: new Map(), attemptedJobIds: new Set() };
      detailFetchStore.sessions.set(sessionId, session);
    }
    return session;
  }

  function detailFetchStatus(record) {
    if (!record) return { state: "idle", jobId: "" };
    const status = { state: record.state, jobId: record.jobId };
    if (record.state === "succeeded") status.result = record.result;
    if (record.state === "failed") status.errorCode = record.errorCode;
    return status;
  }

  function detailFetchCard(jobId) {
    const expectedJobId = String(jobId || "").trim();
    const card = window.__bossCards().find((item) => {
      const href = (item.querySelector('a[href*="/job_detail/"]') || item.querySelector("a"))?.href || "";
      const cardJobId = (href.match(/\/job_detail\/([^/?#]+)\.html/i) || [])[1] || "";
      return cardJobId === expectedJobId;
    });
    const wrap = card?.closest(".job-card-wrap") || card;
    const data = wrap?.__vue__?.data || card?.__vue__?.data || null;
    const securityId = String(data?.securityId || "").trim();
    const lid = String(data?.lid || "").trim();
    if (!card || String(data?.encryptJobId || "").trim() !== expectedJobId || !securityId || !lid) return null;
    return { securityId, lid };
  }

  function cleanApiDetailText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function detailFetchStartStatus(sessionId, expectedJobId) {
    const session = detailFetchSession(sessionId);
    const existing = session.fetches.get(expectedJobId);
    if (existing) return detailFetchStatus(existing);
    if (session.attemptedJobIds.has(expectedJobId)) {
      return { state: "failed", jobId: expectedJobId, errorCode: "BOSS_DETAIL_API_REPEAT_REQUEST" };
    }
    const requestKey = sessionId + "\u0000" + expectedJobId;
    if (detailFetchStore.runningKey && detailFetchStore.runningKey !== requestKey) {
      return { state: "failed", jobId: expectedJobId, errorCode: "BOSS_DETAIL_API_BUSY" };
    }
    const params = detailFetchCard(expectedJobId);
    if (!params) return { state: "failed", jobId: expectedJobId, errorCode: "BOSS_DETAIL_API_PARAMS_INVALID" };
    return { state: "idle", jobId: expectedJobId };
  }

  window.__bossCanStartDetailFetch = function(sessionOrJobId, optionalJobId) {
    const identity = detailFetchIdentity(sessionOrJobId, optionalJobId);
    return detailFetchStartStatus(identity.sessionId, identity.jobId);
  };

  window.__bossStartDetailFetch = function(sessionOrJobId, optionalJobId) {
    const { sessionId, jobId: expectedJobId } = detailFetchIdentity(sessionOrJobId, optionalJobId);
    const startStatus = detailFetchStartStatus(sessionId, expectedJobId);
    if (startStatus.state !== "idle") return startStatus;
    const session = detailFetchSession(sessionId);
    const params = detailFetchCard(expectedJobId);
    const record = { jobId: expectedJobId, state: "running", cancel: null, result: null, errorCode: "" };
    session.attemptedJobIds.add(expectedJobId);
    session.fetches.set(expectedJobId, record);
    const requestKey = sessionId + "\u0000" + expectedJobId;
    detailFetchStore.runningKey = requestKey;
    const finish = (state, errorCode = "") => {
      if (record.state !== "running") return;
      record.state = state;
      record.errorCode = errorCode;
      record.cancel = null;
      if (detailFetchStore.runningKey === requestKey) detailFetchStore.runningKey = "";
    };
    try {
      const query = new URLSearchParams({ securityId: params.securityId, lid: params.lid, _: String(Date.now()) });
      const xhr = new XMLHttpRequest();
      record.cancel = () => xhr.abort();
      xhr.open("GET", "/wapi/zpgeek/job/detail.json?" + query.toString(), true);
      xhr.withCredentials = true;
      xhr.timeout = detailFetchTimeoutMs;
      xhr.setRequestHeader("Accept", "application/json, text/plain, */*");
      xhr.onload = () => {
        if (xhr.status === 401) return finish("failed", "BOSS_LOGIN_REQUIRED");
        if (xhr.status === 403) return finish("failed", "BOSS_RISK_CONTROL");
        if (xhr.status !== 200) return finish("failed", "BOSS_DETAIL_API_HTTP_FAILED");
        try {
          const body = JSON.parse(xhr.responseText || "");
          const info = body?.zpData?.jobInfo;
          if (body?.code !== 0 || !info) return finish("failed", "BOSS_DETAIL_API_RESPONSE_INVALID");
          if (String(info.encryptId || "") !== expectedJobId) return finish("failed", "BOSS_DETAIL_API_ID_MISMATCH");
          const description = cleanApiDetailText(info.postDescription);
          if (description.length < 120) return finish("failed", "BOSS_DETAIL_API_DESCRIPTION_INCOMPLETE");
          record.result = {
            jobId: expectedJobId,
            description,
            salary: cleanApiDetailText(info.salaryDesc || info.salary),
            experience: cleanApiDetailText(info.experienceName || info.experience),
            education: cleanApiDetailText(info.degreeName || info.degree),
            bossActiveText: cleanApiDetailText(info.activeTimeDesc || info.bossActiveText)
          };
          finish("succeeded");
        } catch {
          finish("failed", "BOSS_DETAIL_API_RESPONSE_INVALID");
        }
      };
      xhr.onerror = () => finish("failed", "BOSS_DETAIL_API_HTTP_FAILED");
      xhr.ontimeout = () => finish("failed", "BOSS_DETAIL_API_TIMEOUT");
      xhr.onabort = () => finish("failed", "BOSS_DETAIL_API_RESPONSE_INVALID");
      xhr.send();
    } catch {
      finish("failed", "BOSS_DETAIL_API_RESPONSE_INVALID");
    }
    return detailFetchStatus(record);
  };

  window.__bossDetailFetchState = function(sessionOrJobId, optionalJobId) {
    const { sessionId, jobId } = detailFetchIdentity(sessionOrJobId, optionalJobId);
    return detailFetchStatus(detailFetchStore.sessions.get(sessionId)?.fetches.get(jobId));
  };

  window.__bossConsumeDetailFetch = function(sessionOrJobId, optionalJobId) {
    const { sessionId, jobId: expectedJobId } = detailFetchIdentity(sessionOrJobId, optionalJobId);
    const session = detailFetchStore.sessions.get(sessionId);
    const record = session?.fetches.get(expectedJobId);
    const status = detailFetchStatus(record);
    if (record && record.state !== "running") session.fetches.delete(expectedJobId);
    return status;
  };

  window.__bossCancelDetailFetch = function(sessionOrJobId, optionalJobId) {
    const { sessionId, jobId: expectedJobId } = detailFetchIdentity(sessionOrJobId, optionalJobId);
    const session = detailFetchStore.sessions.get(sessionId);
    const record = session?.fetches.get(expectedJobId);
    if (record?.state === "running") record.cancel?.();
    const requestKey = sessionId + "\u0000" + expectedJobId;
    if (detailFetchStore.runningKey === requestKey) detailFetchStore.runningKey = "";
    session?.fetches.delete(expectedJobId);
    return { state: "idle", jobId: "" };
  };

  window.__bossPaneState = function() {
    const decode = window.__bossDecode || ((value) => String(value || ""));
    const activeWrap = document.querySelector(".job-card-wrap.active");
    const activeCard = activeWrap?.querySelector(".job-card-box")
      || document.querySelector(".job-card-box.active, .job-card-wrapper.active, li.active[class*='job']");
    const activeLink = activeCard?.querySelector('a[href*="job_detail"]');
    const activeJobId = (activeLink?.href?.match(/\/job_detail\/([^/?#]+)\.html/i) || [])[1] || "";
    let pageComponent = activeWrap?.__vue__ || activeCard?.__vue__ || null;
    for (let depth = 0; pageComponent && depth < 8; depth += 1) {
      if (String(pageComponent.$options?.name || "") === "PageJobs") break;
      pageComponent = pageComponent.$parent || null;
    }
    const componentCurrentJobId = String(pageComponent?.currentJob?.encryptJobId || "");
    const jobDetailLoading = typeof pageComponent?.jobDetailLoading === "boolean"
      ? pageComponent.jobDetailLoading
      : null;
    const root = document.querySelector(".job-detail-container")
      || document.querySelector(".job-detail")
      || document.querySelector(".detail-content")
      || document.querySelector(".job-detail-box");
    if (!root) {
      return {
        activeJobId,
        componentCurrentJobId,
        paneJobId: "",
        currentJobId: "",
        jobDetailLoading,
        title: "",
        description: "",
        bossActiveText: "",
        salary: "",
        experience: "",
        education: "",
        hasRoot: false
      };
    }
    const paneLink = root.querySelector('a[href*="job_detail"]');
    const paneJobId = (paneLink?.href?.match(/\/job_detail\/([^/?#]+)\.html/i) || [])[1] || "";
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
      activeJobId,
      componentCurrentJobId,
      paneJobId,
      currentJobId: paneJobId,
      jobDetailLoading,
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

  window.__bossCommunicationSnapshot = function() {
    const decode = window.__bossDecode || ((value) => String(value || "").replace(/\s+/g, " ").trim());
    const path = location.pathname;
    const isDetailPath = /^\/job_detail\/[^/?#]+\.html$/i.test(path);
    const bodyText = String(document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 3000);
    const hasVisibleLoginForm = Array.from(document.querySelectorAll(".sign-form, .login-register, [class*='login-form']")).some((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    });
    const risk = /\/web\/passport\/zp\/(?:verify|403)/i.test(path)
      || new URLSearchParams(location.search).get("code") === "32"
      || /\u5b89\u5168\u9a8c\u8bc1|\u8bbf\u95ee\u5f02\u5e38|\u884c\u4e3a\u9a8c\u8bc1|\u8bbf\u95ee\u53d7\u9650/.test(document.title || "")
      || /\u8d26\u6237\u5b58\u5728\u5f02\u5e38\u884c\u4e3a|\u6682\u65f6\u65e0\u6cd5\u8bbf\u95ee\u6b64\u9875\u9762|\u8bf7\u52ff\u9891\u7e41\u63d0\u4ea4\u5237\u65b0\u8bf7\u6c42/.test(bodyText);
    const login = /\/web\/user\//i.test(path)
      || hasVisibleLoginForm
      || /\u6ca1\u6709\u66f4\u591a\u804c\u4f4d.{0,20}\u767b\u5f55\u67e5\u770b\u5168\u90e8\u804c\u4f4d|\u767b\u5f55\u540e\u53ef\u67e5\u770b/.test(bodyText);
    const header = document.querySelector(".job-primary.detail-box")
      || document.querySelector(".job-primary")
      || document.querySelector(".job-banner");
    const actionRoot = header?.querySelector(".job-op") || header;
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0
        && style.display !== "none"
        && style.visibility !== "hidden"
        && style.opacity !== "0"
        && style.pointerEvents !== "none";
    };
    const isVisibleAndEnabled = (element) => {
      return isVisible(element)
        && !element.disabled
        && !element.matches(":disabled")
        && !element.classList.contains("disabled")
        && element.getAttribute("aria-disabled") !== "true";
    };
    const actions = Array.from(actionRoot?.querySelectorAll("a, button, [role='button']") || [])
      .filter(isVisibleAndEnabled)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        let redirectJobId = "";
        let hasChatIdentity = false;
        try {
          const redirect = new URL(element.getAttribute("redirect-url") || "", location.origin);
          redirectJobId = redirect.searchParams.get("jobId") || "";
          hasChatIdentity = Boolean(redirect.searchParams.get("id"));
        } catch {}
        return {
          label: decode(element.innerText || element.textContent || ""),
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          isFriend: element.getAttribute("data-isfriend") || "",
          redirectJobId,
          hasChatIdentity
        };
      })
      .filter((item) => item.label.includes("\u6c9f\u901a"));
    const text = (selector, root = document) => {
      const node = root?.querySelector(selector);
      return decode(node?.innerText || node?.textContent || "");
    };
    const successDialogRoot = document.querySelector(".greet-boss-pop, .greet-pop");
    const successDialog = {
      visible: Boolean(successDialogRoot && isVisible(successDialogRoot)),
      title: text(".dialog-title", successDialogRoot),
      footer: text(".dialog-footer", successDialogRoot)
    };
    const intermediateDialogRoot = Array.from(document.querySelectorAll(
      ".dialog-wrap:not(.startchat-dialog), .boss-dialog, .dialog-container"
    )).find((element) => isVisible(element)
      && element !== successDialogRoot
      && !element.matches(".greet-boss-pop, .greet-pop")
      && !element.querySelector(".greet-boss-pop, .greet-pop"));
    const intermediateDialog = {
      visible: Boolean(intermediateDialogRoot),
      category: intermediateDialogRoot ? "confirmation_dialog" : ""
    };
    const inlineChatSent = Array.from(document.querySelectorAll(".dialog-wrap.startchat-dialog .message-list .message-item .status.success"))
      .some((node) => isVisible(node) && decode(node.innerText || node.textContent || "") === "\u5df2\u53d1\u9001");
    return {
      url: location.href,
      jobId: (path.match(/^\/job_detail\/([^/?#]+)\.html$/i) || [])[1] || "",
      documentReadyState: document.readyState,
      risk,
      login,
      pageReady: Boolean(isDetailPath && header),
      jobStatus: text(".job-status"),
      title: text(".job-primary h1"),
      salary: text(".job-primary .salary"),
      company: text(".sider-company .company-info"),
      bossActiveText: text(".job-boss-info .boss-active-time"),
      actions,
      successDialog,
      intermediateDialog,
      inlineChatSent
    };
  };

  window.__bossRegisterCommunicationOutcomeObserver = function() {
    const existing = window.__bossCommunicationOutcomeObserver;
    if (existing && existing.closed !== true && typeof existing.result === "function") return existing;
    if (existing && typeof existing.close === "function") existing.close();
    const startedAt = Date.now();
    const events = [];
    let matchedRequests = 0;
    let inFlightRequests = 0;
    let settled = true;
    let closed = false;
    let sealed = false;
    let terminalResult = null;
    const endpointKind = (value) => {
      try {
        const path = new URL(String(value || ""), location.origin).pathname;
        if (path === "/wapi/zpchat/config/get") return "chat_config";
        if (path === "/wapi/zpgeek/friend/add.json") return "friend_add";
      } catch {}
      return "";
    };
    const businessCode = (value) => {
      const code = String(value === undefined || value === null ? "" : value).trim();
      return /^[A-Za-z0-9_-]{1,32}$/.test(code) ? code : "";
    };
    const responseCode = (text) => {
      try {
        const body = JSON.parse(String(text || ""));
        return businessCode(body?.code);
      } catch {
        return "";
      }
    };
    const record = ({ kind, status = null, code = "", category = "", elapsedMs = 0 }) => {
      if (closed || sealed || !kind) return;
      events.push({
        endpointKind: kind,
        ...(Number.isInteger(Number(status)) && Number(status) >= 100 && Number(status) <= 599 ? { httpStatus: Number(status) } : {}),
        ...(businessCode(code) ? { businessCode: businessCode(code) } : {}),
        businessCategory: category,
        elapsedMs: Math.max(0, Math.min(60_000, Math.floor(Number(elapsedMs) || 0)))
      });
    };
    const requestStarted = () => {
      matchedRequests += 1;
      inFlightRequests += 1;
      settled = false;
    };
    const requestFinished = () => {
      inFlightRequests = Math.max(0, inFlightRequests - 1);
      Promise.resolve().then(() => {
        if (!closed && !sealed && inFlightRequests === 0) settled = true;
      });
    };
    const classifyResponse = (kind, status, text, elapsedMs) => {
      if (Number(status) === 0) {
        record({ kind, category: "network_rejected", elapsedMs });
        return;
      }
      if (Number(status) < 200 || Number(status) >= 300) {
        record({ kind, status, category: "http_failure", elapsedMs });
        return;
      }
      const code = responseCode(text);
      record({
        kind,
        status,
        code,
        category: code === "0" ? "success" : code ? "business_rejected" : "response_unparsed",
        elapsedMs
      });
    };
    const originalFetch = window.fetch;
    let wrappedFetch = null;
    if (typeof originalFetch === "function") {
      wrappedFetch = function(input) {
        const kind = endpointKind(typeof input === "string" ? input : input?.url);
        if (!kind || closed) return originalFetch.apply(this, arguments);
        const requestStartedAt = Date.now();
        requestStarted();
        let request;
        try {
          request = originalFetch.apply(this, arguments);
        } catch (error) {
          record({ kind, category: "network_rejected", elapsedMs: Date.now() - requestStartedAt });
          requestFinished();
          throw error;
        }
        return Promise.resolve(request).then((response) => {
          const copy = typeof response?.clone === "function" ? response.clone() : null;
          Promise.resolve(copy?.text?.() || "").then((text) => {
            classifyResponse(kind, response?.status, text, Date.now() - requestStartedAt);
          }, () => {
            record({ kind, status: response?.status, category: "response_unparsed", elapsedMs: Date.now() - requestStartedAt });
          }).finally(requestFinished);
          return response;
        }, (error) => {
          record({ kind, category: "network_rejected", elapsedMs: Date.now() - requestStartedAt });
          requestFinished();
          throw error;
        });
      };
      window.fetch = wrappedFetch;
    }
    const OriginalXhr = window.XMLHttpRequest;
    let originalOpen = null;
    let originalSend = null;
    let wrappedOpen = null;
    let wrappedSend = null;
    if (typeof OriginalXhr === "function") {
      originalOpen = OriginalXhr.prototype.open;
      originalSend = OriginalXhr.prototype.send;
      wrappedOpen = function(method, url) {
        this.__bossCommunicationEndpointKind = endpointKind(url);
        return originalOpen.apply(this, arguments);
      };
      wrappedSend = function() {
        const kind = this.__bossCommunicationEndpointKind;
        if (!kind || closed) return originalSend.apply(this, arguments);
        const requestStartedAt = Date.now();
        requestStarted();
        let handled = false;
        const once = (category) => {
          if (handled) return;
          handled = true;
          if (category) record({ kind, category, elapsedMs: Date.now() - requestStartedAt });
          else classifyResponse(kind, this.status, this.responseText, Date.now() - requestStartedAt);
          requestFinished();
        };
        this.addEventListener("loadend", () => once(""), { once: true });
        this.addEventListener("error", () => once("network_rejected"), { once: true });
        this.addEventListener("timeout", () => once("network_timeout"), { once: true });
        this.addEventListener("abort", () => once("network_aborted"), { once: true });
        try {
          return originalSend.apply(this, arguments);
        } catch (error) {
          once("network_rejected");
          throw error;
        }
      };
      OriginalXhr.prototype.open = wrappedOpen;
      OriginalXhr.prototype.send = wrappedSend;
    }
    let observer;
    let resultFn;
    let closeFn;
    const restoreInterception = () => {
      if (window.fetch === wrappedFetch) window.fetch = originalFetch;
      if (typeof OriginalXhr === "function") {
        if (OriginalXhr.prototype.open === wrappedOpen) OriginalXhr.prototype.open = originalOpen;
        if (OriginalXhr.prototype.send === wrappedSend) OriginalXhr.prototype.send = originalSend;
      }
    };
    const seal = (result) => {
      if (terminalResult) return terminalResult;
      sealed = true;
      terminalResult = result;
      restoreInterception();
      return terminalResult;
    };
    const close = () => {
      if (closed) return;
      closed = true;
      sealed = true;
      restoreInterception();
      if (window.__bossCommunicationOutcomeObserver === observer) delete window.__bossCommunicationOutcomeObserver;
      if (window.__bossCommunicationOutcomeResult === resultFn) delete window.__bossCommunicationOutcomeResult;
      if (window.__bossCloseCommunicationOutcomeObserver === closeFn) delete window.__bossCloseCommunicationOutcomeObserver;
    };
    observer = {
      get closed() { return closed; },
      close,
      result(finalize = false) {
        if (terminalResult) return terminalResult;
        if (matchedRequests && Date.now() - startedAt >= 15_000) {
          return seal({ state: "timeout", evidence: { endpoints: events, pageState: "observer_timeout" } });
        }
        if (inFlightRequests > 0 || !settled) {
          return { state: "pending", evidence: { endpoints: events, pageState: "request_pending" } };
        }
        const transportFailed = events.some((event) => ["network_rejected", "network_timeout", "network_aborted"].includes(event.businessCategory));
        const platformRejected = events.some((event) => ["http_failure", "business_rejected"].includes(event.businessCategory));
        const accepted = events.some((event) => event.endpointKind === "friend_add" && event.businessCategory === "success");
        const unparsed = events.some((event) => event.businessCategory === "response_unparsed");
        if ([transportFailed, platformRejected, accepted].filter(Boolean).length > 1) {
          return seal({ state: "ambiguous", evidence: { endpoints: events, pageState: "request_conflict" } });
        }
        if (transportFailed) {
          return seal({ state: "transport_failed", evidence: { endpoints: events, pageState: "request_failed" } });
        }
        if (platformRejected) {
          return seal({ state: "platform_rejected", evidence: { endpoints: events, pageState: "request_rejected" } });
        }
        if (accepted) {
          return seal({ state: "accepted", evidence: { endpoints: events, pageState: "request_accepted" } });
        }
        if (unparsed) {
          return seal({ state: "ambiguous", evidence: { endpoints: events, pageState: "request_unparsed" } });
        }
        if (finalize) close();
        return { state: "pending", evidence: { endpoints: events, pageState: matchedRequests ? "request_pending" : "no_matching_request" } };
      }
    };
    window.__bossCommunicationOutcomeObserver = observer;
    resultFn = (finalize = false) => observer.result(finalize);
    closeFn = () => observer.close();
    window.__bossCommunicationOutcomeResult = resultFn;
    window.__bossCloseCommunicationOutcomeObserver = closeFn;
    return observer;
  };
  return true;
})()
`;

class BossSiteAdapter {
  constructor({ browser = null, logger = null, sleepFn = sleep, randomFn = Math.random, accessController = null } = {}) {
    this.browser = browser;
    this.logger = logger;
    this.sleep = sleepFn;
    this.random = randomFn;
    this.accessController = accessController;
    this.pageNavigations = 0;
    this.listNavigations = 0;
    this.pageBudget = SEARCH_PLAN_POLICY.broadScanDefaults.browserPageBudget;
    this.communicationTabId = null;
    this.communicationSearchTabId = null;
    this.communicationMessageTabId = null;
    this.communicationBinding = null;
    this.communicationTabsBound = false;
    this.communicationSearchRestored = false;
    this.communicationTabPreparationPromise = null;
    this.communicationOperationInFlight = "";
    this.communicationDispatchedJobIds = new Set();
    this.lastCommunicationDispatch = null;
    this.resetPacing();
  }

  beginCommunicationOperation(kind) {
    if (this.communicationOperationInFlight) {
      throw bossError("BOSS_COMMUNICATION_BUSY", `A BOSS communication ${this.communicationOperationInFlight} is already in progress.`);
    }
    this.communicationOperationInFlight = kind;
  }

  finishCommunicationOperation(kind) {
    if (this.communicationOperationInFlight === kind) this.communicationOperationInFlight = "";
  }

  async preflight({ tabId = null } = {}) {
    if (!this.browser) throw bossError("BOSS_BROWSER_REQUIRED", "BOSS 预检需要浏览器连接。");
    const tabs = (tabId || typeof this.browser.listTabs !== "function") ? [] : await this.browser.listTabs();
    const fallbackId = tabId || (!tabs.length ? await this.browser.activeTabId() : null);
    const candidates = (tabId
      ? [{ id: tabId, url: "", title: "" }]
      : tabs.filter((item) => /zhipin\.com/i.test(String(item.url || ""))).sort(compareBossTabs));
    if (!candidates.length && fallbackId) candidates.push({ id: fallbackId, url: "", title: "" });
    if (!candidates.length) throw bossError("BOSS_TAB_REQUIRED", "Edge 中没有可控制的 BOSS 直聘标签页。");

    const inspected = [];
    const healthy = [];
    const readErrors = [];
    for (const tab of candidates) {
      try {
        const state = await this.browser.evalValue(tab.id, `(() => {
          const url = location.href;
          const path = location.pathname;
          const bodyText = String(document.body?.innerText || "").replace(/\\s+/g, " ").slice(0, 3000);
          const isBoss = /(^|\\.)zhipin\\.com$/i.test(location.hostname);
          const hasVisibleLoginForm = [...document.querySelectorAll(".sign-form, .login-register, [class*='login-form']")].some((element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
          });
          const isLoginPage = /\\/web\\/user\\//i.test(path) || hasVisibleLoginForm
            || /没有更多职位.{0,20}登录查看全部职位|登录后可查看/.test(bodyText);
          const isRiskPage = /\\/web\\/passport\\/zp\\/(?:verify|403)/i.test(path)
            || new URLSearchParams(location.search).get("code") === "32"
            || /安全验证|访问异常|行为验证|访问受限/.test(document.title || "")
            || /账户存在异常行为|暂时无法访问此页面|请勿频繁提交刷新请求/.test(bodyText);
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
        readErrors.push(error);
        inspected.push({
          tabId: tab.id,
          url: tab.url || "",
          error: error.message || String(error),
          errorCode: error?.code || ""
        });
      }
    }
    if (inspected.some((item) => item.isRiskPage)) {
      throw bossError("BOSS_RISK_CONTROL", "BOSS 当前要求安全验证，请完成验证并稍后重试。");
    }
    const selected = healthy.find((item) => item.isSearchPage);
    const fallback = selected || healthy[0];
    if (fallback) {
      const safeLocation = bossLogLocation(fallback.url || fallback.tab.url);
      this.logger?.info("boss_browser_preflight_ok", {
        tabId: fallback.tabId,
        origin: safeLocation.origin,
        path: safeLocation.path,
        isSearchPage: fallback.isSearchPage,
        hasJobStructure: fallback.hasJobStructure,
        inspectedTabs: inspected.length
      });
      return fallback;
    }
    const successfullyInspected = inspected.filter((item) => !item.error);
    if (!successfullyInspected.length && readErrors.length) throw selectBossPreflightReadError(readErrors);
    if (successfullyInspected.some((item) => item.isBoss)) throw bossError("BOSS_LOGIN_REQUIRED", "已找到 BOSS 标签页，但未确认可用登录状态。请在搜索页完成登录后重试。");
    throw bossError("BOSS_TAB_REQUIRED", "Edge 中没有可用的 BOSS 直聘标签页。");
  }

  async inspectInheritedSearchPage({ tabId = null } = {}) {
    if (!this.browser) {
      throw bossError("BOSS_BROWSER_REQUIRED", "继承模式预检需要浏览器连接。");
    }
    const selectedTabId = tabId || await this.browser.activeTabId();
    await this.assertSearchPage(selectedTabId);
    const state = await this.browser.evalValue(selectedTabId, `(() => ({
      url: location.href,
      rawFields: Array.from(document.querySelectorAll(".condition-filter-select")).map((node) => ({
        label: (node.querySelector(".current-select .placeholder-text")?.textContent || "").replace(/\\s+/g, " ").trim(),
        options: Array.from(node.querySelectorAll("[ka*='sel-job-rec-']")).map((option) => ({
          ka: option.getAttribute("ka") || "",
          label: (option.textContent || "").replace(/\\s+/g, " ").trim()
        }))
      })),
      currentOptions: Array.from(document.querySelectorAll(".condition-filter-select")).flatMap((field) =>
        Array.from(field.querySelectorAll("[ka*='sel-job-rec-']")).flatMap((option) => {
          const match = String(option.getAttribute("ka") || "").match(/^sel-job-rec-([A-Za-z]+)-([^\\s]+)$/);
          const selected = option.matches?.(".active, .selected, [aria-selected='true'], [aria-current='true']")
            || option.getAttribute("aria-selected") === "true"
            || option.getAttribute("aria-current") === "true"
            || Boolean(option.closest?.("li.active, li.selected, .filter-option.active, .filter-option.selected, [aria-selected='true'], [aria-current='true']"));
          if (!match || !selected) return [];
          const param = match[1] === "exp" ? "experience" : match[1];
          const code = match[2].trim();
          const currentCodes = location.href
            ? new URL(location.href).searchParams.getAll(param)
              .flatMap((value) => String(value).split(",").map((item) => item.trim()))
            : [];
          const label = String(option.textContent || "").replace(/\\s+/g, " ").trim();
          return code && label && currentCodes.includes(code) ? [{ param, code, label }] : [];
        })
      ),
      urlOptions: Array.from(document.querySelectorAll('a[href*="/web/geek/jobs"]')).flatMap((node) => {
        try {
          const currentUrl = new URL(location.href);
          const optionUrl = new URL(node.href, location.href);
          if (optionUrl.origin !== location.origin || !/^\\/web\\/geek\\/jobs\\/?$/i.test(optionUrl.pathname)) return [];
          const label = String(node.textContent || "").replace(/\\s+/g, " ").trim();
          if (!label) return [];
          return [...optionUrl.searchParams.entries()]
            .filter(([param, code]) => param !== "query" && param !== "page" && code)
            .flatMap(([param, value]) => String(value).split(",")
              .map((code) => ({ param, code: code.trim(), label }))
              .filter((item) => item.code && !new Set(currentUrl.searchParams.getAll(param)
                .flatMap((currentValue) => String(currentValue).split(",").map((code) => code.trim()))).has(item.code)));
        } catch {
          return [];
        }
      })
    }))()`);
    const searchTemplate = canonicalizeBossSearchTemplate(state?.url);
    return {
      tabId: selectedTabId,
      url: String(state?.url || ""),
      searchTemplate,
      catalog: parseBossFilterCatalog(state?.rawFields || []),
      urlOptions: dedupeBossUrlOptions([
        ...(state?.urlOptions || []),
        ...(state?.currentOptions || [])
      ])
    };
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
    await this.navigateWithPacing(targetTabId, url, "catalog", { enforceBudget: true });
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

  async navigateWithPacing(tabId, url, kind, { enforceBudget = true, signal = null, assertTabBindings = null } = {}) {
    throwIfAborted(signal);
    await assertRuntimeTabBindings(assertTabBindings);
    if (enforceBudget && ["catalog", "list"].includes(kind) && this.listNavigations >= this.pageBudget) {
      const error = new Error(`BOSS 本批列表页面达到安全上限 ${this.pageBudget}，已停止继续搜索。`);
      error.code = "BOSS_PAGE_BUDGET_REACHED";
      throw error;
    }
    const accessAction = kind === "detail"
      ? "detail_open"
      : ["catalog", "list"].includes(kind) ? "list_navigation" : "";
    if (accessAction === "detail_open") {
      const jobId = (normalizeBossUrl(url).match(/\/job_detail\/([^/?#]+)\.html/i) || [])[1] || "";
      await this.reserveAccess(accessAction, { jobId });
    } else if (accessAction) {
      await this.reserveAccess(accessAction, { kind });
    }
    throwIfAborted(signal);
    await this.browser.navigate(tabId, url);
    this.pageNavigations += 1;
    if (["catalog", "list"].includes(kind)) this.listNavigations += 1;
    await this.waitWithPacing(kind, { signal, assertTabBindings });
  }

  async waitWithPacing(kind, { signal = null, assertTabBindings = null, onWait = null } = {}) {
    throwIfAborted(signal);
    await assertRuntimeTabBindings(assertTabBindings);
    const [min, max] = BOSS_PACING_POLICY.delayMs[kind] || BOSS_PACING_POLICY.delayMs.list;
    const delayMs = randomBetween(min, max, this.random);
    if (typeof onWait === "function") await onWait({ kind, durationMs: delayMs });
    await waitForAbortableSleep(this.sleep(delayMs), signal);
    throwIfAborted(signal);
    await assertRuntimeTabBindings(assertTabBindings);
    if (!["catalog", "list", "detail", "scroll", "card", "refresh", "target", "pane_detail_read"].includes(kind)) return;
    this.pacedActions += 1;
    if (this.pacedActions < this.nextPacingCooldownAt) return;
    const cooldownMs = randomBetween(...BOSS_PACING_POLICY.periodicDelayMs, this.random);
    this.logger?.info("boss_pacing_cooldown", { pacedActions: this.pacedActions, cooldownMs });
    if (typeof onWait === "function") await onWait({ kind: "periodic", durationMs: cooldownMs });
    await waitForAbortableSleep(this.sleep(cooldownMs), signal);
    this.nextPacingCooldownAt += randomBetween(...BOSS_PACING_POLICY.periodicEvery, this.random);
  }

  async reserveAccess(action, details = {}) {
    if (typeof this.accessController?.reserve !== "function") return null;
    return this.accessController.reserve(action, details);
  }

  resetPacing() {
    this.pacedActions = 0;
    this.nextPacingCooldownAt = randomBetween(...BOSS_PACING_POLICY.periodicEvery, this.random);
    this.detailActions = 0;
    this.nextDetailMicroCooldownAt = randomBetween(...BOSS_PACING_POLICY.detail.microEvery, this.random);
    this.nextDetailMacroCooldownAt = randomBetween(...BOSS_PACING_POLICY.detail.macroEvery, this.random);
  }

  pacingState() {
    return {
      pacedActions: this.pacedActions,
      nextPacingCooldownAt: this.nextPacingCooldownAt,
      detailActions: this.detailActions,
      nextDetailMicroCooldownAt: this.nextDetailMicroCooldownAt,
      nextDetailMacroCooldownAt: this.nextDetailMacroCooldownAt
    };
  }

  restorePacing(state) {
    if (!isSafePacingState(state)) {
      this.resetPacing();
      return;
    }
    for (const field of PACING_STATE_FIELDS) this[field] = state[field];
  }

  async waitForPendingDetailCooldown({ signal = null, assertTabBindings = null, onPacingCheckpoint = null, onWait = null } = {}) {
    throwIfAborted(signal);
    await assertRuntimeTabBindings(assertTabBindings);
    if (this.detailActions >= this.nextDetailMacroCooldownAt) {
      const cooldownMs = randomBetween(...BOSS_PACING_POLICY.detail.macroDelayMs, this.random);
      console.error(`[boss] 已读取 ${this.detailActions} 个右栏详情，阶段冷却 ${Math.ceil(cooldownMs / 1000)} 秒后继续`);
      this.logger?.info("boss_detail_macro_cooldown", { detailActions: this.detailActions, cooldownMs });
      if (typeof onWait === "function") await onWait({ kind: "detail_macro", durationMs: cooldownMs });
      await waitForAbortableSleep(this.sleep(cooldownMs), signal);
      this.nextDetailMacroCooldownAt += randomBetween(...BOSS_PACING_POLICY.detail.macroEvery, this.random);
      while (this.nextDetailMicroCooldownAt <= this.detailActions) {
        this.nextDetailMicroCooldownAt += randomBetween(...BOSS_PACING_POLICY.detail.microEvery, this.random);
      }
      if (typeof onPacingCheckpoint === "function") await onPacingCheckpoint(this.pacingState());
      return;
    }
    if (this.detailActions >= this.nextDetailMicroCooldownAt) {
      const cooldownMs = randomBetween(...BOSS_PACING_POLICY.detail.microDelayMs, this.random);
      this.logger?.info("boss_detail_micro_cooldown", { detailActions: this.detailActions, cooldownMs });
      if (typeof onWait === "function") await onWait({ kind: "detail_micro", durationMs: cooldownMs });
      await waitForAbortableSleep(this.sleep(cooldownMs), signal);
      this.nextDetailMicroCooldownAt += randomBetween(...BOSS_PACING_POLICY.detail.microEvery, this.random);
      if (typeof onPacingCheckpoint === "function") await onPacingCheckpoint(this.pacingState());
    }
  }

  async waitAfterDetailAction(options = {}) {
    this.detailActions += 1;
    if (typeof options.onPacingCheckpoint === "function") {
      await options.onPacingCheckpoint(this.pacingState());
    }
    await this.waitForPendingDetailCooldown(options);
  }

  async scanBrowser(options) {
    if (!this.browser) throw new Error("真实扫描需要 --browser edge。");
    throwIfAborted(options.signal);
    const detailMode = String(options.detailMode || "trusted_pane").trim().toLowerCase();
    if (!["trusted_pane", "search_page_api"].includes(detailMode)) {
      throw bossError("BOSS_DETAIL_MODE_INVALID", "BOSS detail mode must be trusted_pane or search_page_api.");
    }
    const detailSessionId = String(options.detailSessionId || "legacy").trim() || "legacy";
    const tabId = options.tabId || await this.browser.activeTabId();
    throwIfAborted(options.signal);
    const maxCards = normalizeCardLimit(options.maxCards);
    const maxDetailTotal = Math.min(
      SEARCH_PLAN_POLICY.scanBounds.maxDetailTotal[1],
      Math.max(0, Number(options.maxDetailTotal ?? SEARCH_PLAN_POLICY.broadScanDefaults.maxDetailTotal))
    );
    const allTargets = buildBossScanTargets({ ...options, maxCards });
    const hasTargetFilter = Array.isArray(options.targetKeys);
    const requestedTargetKeys = new Set(options.targetKeys || []);
    if (!allTargets.length) {
      throw bossError("BOSS_SCAN_NO_TARGETS", "本轮没有可执行的 BOSS 搜索目标，请检查关键词、城市和平台筛选配置。");
    }
    if (hasTargetFilter) {
      const availableTargetKeys = new Set(allTargets.map((target) => target.targetKey));
      const unknownTargetKeys = [...requestedTargetKeys].filter((targetKey) => !availableTargetKeys.has(targetKey));
      if (unknownTargetKeys.length) {
        throw bossError("BOSS_SCAN_TARGETS_NOT_FOUND", `恢复扫描的目标与当前执行快照不一致：${unknownTargetKeys.join(", ")}`);
      }
    }
    const scanTargets = hasTargetFilter
      ? allTargets.filter((target) => requestedTargetKeys.has(target.targetKey))
      : allTargets;
    this.pageNavigations = 0;
    this.listNavigations = 0;
    this.pageBudget = normalizePageBudget(options.browserPageBudget);
    this.restorePacing(options.pacingState);
    const candidates = new Map();
    const detailAttempts = new Set();
    let detailsRead = 0;
    let detailsReused = 0;
    let detailsFailed = 0;
    let successfulTargets = 0;
    let partialTargets = 0;
    let fatalError = null;
    const targetCount = scanTargets.length;
    let targetPosition = 0;

    if (!targetCount) {
      const emptySummary = { status: "completed", targetCount: 0, attemptedTargets: 0, successfulTargets: 0, partialTargets: 0, fatalErrorCode: "", fatalErrorMessage: "" };
      if (typeof options.onScanComplete === "function") await options.onScanComplete(emptySummary);
      return [];
    }

    scanTargetLoop: for (const target of scanTargets) {
          throwIfAborted(options.signal);
          await assertRuntimeTabBindings(options.assertTabBindings);
          const { cityOrder, city, item, keyword, cardLimit, lane, laneId, targetKey, detailLimitOverride } = target;
          targetPosition += 1;
          const frozenTargetPosition = allTargets.findIndex((entry) => entry.targetKey === targetKey) + 1;
          const frozenTargetTotal = allTargets.length;
          const startedAt = new Date().toISOString();
          let targetJobs = [];
          let targetEntries = [];
          let targetDiscovered = 0;
          let lastDetailPosition = 0;
          let detailTotal = 0;
          try {
            if (typeof options.onProgressCheckpoint === "function") {
              await options.onProgressCheckpoint({
                activity: "searching",
                targetKey,
                targetPosition: frozenTargetPosition,
                targetTotal: frozenTargetTotal,
                targetDiscovered,
                detailPosition: 0,
                detailTotal: 0,
                jobs: []
              });
            }
            const url = buildBossSearchUrl({ keyword, cityCode: city.cityCode, nativeFilters: lane, searchTemplate: options.searchTemplate });
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
            await this.navigateWithPacing(tabId, url, "list", {
              signal: options.signal,
              assertTabBindings: options.assertTabBindings
            });
            throwIfAborted(options.signal);
            await this.assertSearchPage(tabId);
            const collected = await this.collectCards(
              tabId,
              cardLimit,
              options.signal,
              options.assertTabBindings,
              async ({ cards: addedCards, total }) => {
                targetDiscovered = Number(total || 0);
                if (typeof options.onProgressCheckpoint !== "function") return;
                const jobs = addedCards.map((card) => {
                  const job = normalizeBossJob({ ...card, keyword, source: "boss", searchCity: city.city || "" });
                  job.detailRequired = typeof options.shouldReadDetail !== "function"
                    || options.shouldReadDetail(job) !== false;
                  return job;
                });
                await options.onProgressCheckpoint({
                  activity: "searching",
                  targetKey,
                  targetPosition: frozenTargetPosition,
                  targetTotal: frozenTargetTotal,
                  targetDiscovered,
                  detailPosition: 0,
                  detailTotal: 0,
                  jobs
                });
              }
            );
            throwIfAborted(options.signal);
            const collection = Array.isArray(collected)
              ? { cards: collected, status: "completed", stopReason: "external_collection", scrollRounds: 0, growthRounds: 0, quietWindows: 0 }
              : collected;
            const cards = Array.isArray(collection?.cards) ? collection.cards : [];
            targetDiscovered = cards.length;
            console.error(`[boss] ${city.city || city.cityCode} · ${keyword} 列表岗位：${cards.length}`);
            this.logger?.info("boss_cards_collected", {
              targetKey,
              keyword,
              city: city.city || "",
              cardCount: cards.length,
              cardLimit,
              collectionStatus: collection.status,
              stopReason: collection.stopReason,
              scrollRounds: collection.scrollRounds,
              growthRounds: collection.growthRounds,
              quietWindows: collection.quietWindows,
              nativeFilterLane: laneId
            });
            const entries = cards.map((card, index) => {
              const cardJob = normalizeBossJob({ ...card, keyword, source: "boss", searchCity: city.city || "" });
              const cachedDetail = typeof options.getReusableDetail === "function" ? options.getReusableDetail(cardJob) : null;
              const reusable = reusableDetailMatches(cardJob, cachedDetail) ? cachedDetail : null;
              const job = reusable?.description ? normalizeBossJob({
                ...reusable,
                ...cardJob,
                description: reusable.description,
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
            const configuredDetailLimit = detailLimitOverride !== null
              && detailLimitOverride !== undefined
              && Number.isFinite(Number(detailLimitOverride))
              ? Number(detailLimitOverride)
              : Number(options.detailLimits?.[item.priority]);
            const targetDetailQuota = Number.isFinite(configuredDetailLimit)
              ? Math.min(Math.max(0, configuredDetailLimit), remainingDetailBudget)
              : Math.ceil(remainingDetailBudget / remainingTargets);
            const detailEntries = eligibleDetailEntries.slice(0, targetDetailQuota);
            detailTotal = detailEntries.length;
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

            for (let detailIndex = 0; detailIndex < detailEntries.length; detailIndex += 1) {
              const entry = detailEntries[detailIndex];
              throwIfAborted(options.signal);
              await assertRuntimeTabBindings(options.assertTabBindings);
              lastDetailPosition = detailIndex + 1;
              if (typeof options.onProgressCheckpoint === "function") {
                await options.onProgressCheckpoint({
                  activity: "reading_detail",
                  targetKey,
                  targetPosition: frozenTargetPosition,
                  targetTotal: frozenTargetTotal,
                  targetDiscovered,
                  detailPosition: lastDetailPosition,
                  detailTotal,
                  jobs: []
                });
              }
              console.error(`[boss] 读详情：${keyword}（${item.priority}） ${entry.job.title}`);
              const useSearchPageApi = detailMode === "search_page_api";
              const accessMode = useSearchPageApi ? "search_page_api" : "visible_pane";
              let detailOutcome = {
                outcome: "succeeded",
                errorCode: "",
                accessMode
              };
              try {
                const detail = useSearchPageApi
                  ? await this.readSearchPageApiDetail(tabId, entry.job, options.signal, options.assertTabBindings, detailSessionId)
                  : await this.readVisiblePaneDetail(tabId, entry.job, options.signal, options.assertTabBindings);
                if (!detail) {
                  throw bossError(
                    useSearchPageApi ? "BOSS_DETAIL_API_TIMEOUT" : "BOSS_PANE_SWITCH_TIMEOUT",
                    useSearchPageApi
                      ? `BOSS search page API detail did not become complete for ${entry.job.sourceId || "unknown"}`
                      : `BOSS search pane did not become complete for ${entry.job.sourceId || "unknown"}`
                  );
                }
                throwIfAborted(options.signal);
                detailOutcome = { outcome: "succeeded", errorCode: "", accessMode };
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
                if (typeof options.onDetailCheckpoint === "function") {
                  await options.onDetailCheckpoint({
                    targetKey,
                    city: city.city || "",
                    cityCode: city.cityCode,
                    keyword,
                    laneId,
                    job: detailedJob
                  });
                }
                await this.waitAfterDetailAction({ signal: options.signal, assertTabBindings: options.assertTabBindings, onPacingCheckpoint: options.onPacingCheckpoint });
              } catch (error) {
                if (error?.code === "SCAN_ABORTED") throw error;
                if (isWorkflowControlError(error)) throw error;
                const accessPending = error?.code === "BOSS_ACCESS_BUDGET_EXHAUSTED";
                if (!accessPending) detailsFailed += 1;
                this.logger?.warn("boss_card_detail_read_failed", {
                  targetKey,
                  keyword,
                  jobId: entry.job.sourceId || entry.job.url || "",
                  errorCode: error?.code || "BOSS_DETAIL_LOAD_TIMEOUT",
                  errorMessage: useSearchPageApi ? "" : error?.message || String(error)
                });
                if (!accessPending) {
                  const failedJob = { ...entry.job, detailRequired: true, detailRead: false, detailErrorCode: error?.code || "BOSS_DETAIL_LOAD_TIMEOUT" };
                  mergeScanCandidate(candidates, { ...entry, job: failedJob });
                }
                const failedOutcome = { outcome: "failed", errorCode: error?.code || "BOSS_DETAIL_LOAD_TIMEOUT", accessMode };
                if (isFatalBrowserError(error)) {
                  try {
                    await emitDetailResult(options.onDetailResult, failedOutcome);
                  } catch {
                    // The audit sink must not replace the fatal browser/risk error.
                  }
                  throw error;
                }
                await this.waitAfterDetailAction({ signal: options.signal, assertTabBindings: options.assertTabBindings, onPacingCheckpoint: options.onPacingCheckpoint });
                detailOutcome = failedOutcome;
              }
              await emitDetailResult(options.onDetailResult, detailOutcome);
            }

            targetJobs = targetEntries.map((entry) => candidates.get(bossSourceId(entry.job))?.job || entry.job);
            if (typeof options.onTargetComplete === "function") {
              throwIfAborted(options.signal);
              await options.onTargetComplete({
                targetKey,
                city: city.city || "",
                cityCode: city.cityCode,
                keyword,
                laneId,
                status: collection.status === "partial" ? "partial" : "completed",
                jobs: targetJobs,
                jobCount: targetJobs.length,
                targetPosition: frozenTargetPosition,
                targetTotal: frozenTargetTotal,
                targetDiscovered,
                detailPosition: lastDetailPosition,
                detailTotal,
                details: {
                  cardLimit,
                  stopReason: collection.stopReason || "",
                  scrollRounds: Number(collection.scrollRounds || 0),
                  growthRounds: Number(collection.growthRounds || 0),
                  quietWindows: Number(collection.quietWindows || 0)
                },
                startedAt,
                finishedAt: new Date().toISOString()
              });
            }
            successfulTargets += 1;
            if (collection.status === "partial") partialTargets += 1;
            await this.waitWithPacing("target", { signal: options.signal, assertTabBindings: options.assertTabBindings });
          } catch (error) {
            if (["SCAN_CHECKPOINT_FAILED", "SCAN_LEASE_LOST", "SCAN_RUN_LEASE_MISMATCH"].includes(error?.code)) throw error;
            if (isWorkflowControlError(error)) throw error;
            const safeErrorMessage = options.detailMode === "search_page_api" ? "" : error?.message || String(error);
            this.logger?.warn("boss_scan_target_failed", {
              targetKey,
              keyword,
              city: city.city || "",
              cityCode: city.cityCode,
              laneId,
              errorCode: error?.code || "BOSS_SCAN_TARGET_FAILED",
              errorMessage: safeErrorMessage
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
                targetPosition: frozenTargetPosition,
                targetTotal: frozenTargetTotal,
                targetDiscovered,
                detailPosition: lastDetailPosition,
                detailTotal,
                errorCode: error?.code || "BOSS_SCAN_TARGET_FAILED",
                errorMessage: safeErrorMessage,
                startedAt,
                finishedAt: new Date().toISOString()
              });
            }
            if (isFatalBrowserError(error)) {
              fatalError = error;
              break scanTargetLoop;
            }
            await this.waitWithPacing("target", { signal: options.signal, assertTabBindings: options.assertTabBindings });
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
        errorMessage: options.detailMode === "search_page_api" ? "" : fatalError.message,
        detailsRead,
        detailsReused,
        candidates: resultJobs.length
      });
    }
    const scanSummary = {
      status: fatalError
        ? (successfulTargets ? "partial" : "failed")
        : successfulTargets === targetCount && partialTargets === 0 ? "completed" : "partial",
      targetCount,
      attemptedTargets: targetPosition,
      successfulTargets,
      partialTargets,
      fatalErrorCode: fatalError?.code || "",
      fatalErrorMessage: fatalError?.message || ""
    };
    if (typeof options.onScanComplete === "function") await options.onScanComplete(scanSummary);
    if (fatalError) throw fatalError;
    if (!successfulTargets) throw bossError("BOSS_SCAN_NO_TARGET_SUCCEEDED", "本轮所有 BOSS 搜索目标均失败，已保留逐目标错误记录。");
    return resultJobs;
  }

  async refreshDetails(jobs, { limit = REFRESH_LIMIT, tabId = null, onAttempt = null, signal = null, assertTabBindings = null } = {}) {
    if (!this.browser) throw new Error("补读岗位详情需要浏览器连接。");
    throwIfAborted(signal);
    const selectedTabId = tabId || await this.browser.activeTabId();
    const selected = (jobs || []).filter((job) => job?.url).slice(0, Math.min(REFRESH_LIMIT, Math.max(1, Number(limit) || REFRESH_LIMIT)));
    this.pageNavigations = 0;
    this.listNavigations = 0;
    this.resetPacing();
    const refreshed = [];
    for (const job of selected) {
      throwIfAborted(signal);
      await assertRuntimeTabBindings(assertTabBindings);
      console.error(`[boss] 补读详情：${job.title}`);
      let normalized;
      try {
        const detail = await this.readDetail(selectedTabId, job.url, signal, assertTabBindings);
        throwIfAborted(signal);
        if (!detail.description) throw new Error("岗位详情未加载完成");
        normalized = normalizeBossJob({
          ...job,
          description: detail.description,
          salary: detail.salary || job.salary || "",
          experience: detail.experience || job.experience || "",
          education: detail.education || job.education || "",
          bossActiveText: detail.bossActiveText || job.bossActiveText || "",
          detailRead: true
        });
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
        await this.waitWithPacing("refresh", { signal, assertTabBindings });
        continue;
      }
      refreshed.push(normalized);
      if (typeof onAttempt === "function") await onAttempt({ job, refreshedJob: normalized, result: "success" });
      await this.waitWithPacing("refresh", { signal, assertTabBindings });
    }
    return refreshed.map((job) => ({ ...job, detailRequired: true, detailRead: true }));
  }

  async probeActivities(jobs, { limit = REFRESH_LIMIT, tabId = null, onAttempt = null, signal = null, assertTabBindings = null } = {}) {
    if (!this.browser) throw new Error("更新招聘方活跃状态需要浏览器连接。");
    throwIfAborted(signal);
    const selectedTabId = tabId || await this.browser.activeTabId();
    const selected = (jobs || []).filter((job) => job?.url).slice(0, Math.min(REFRESH_LIMIT, Math.max(1, Number(limit) || REFRESH_LIMIT)));
    this.pageNavigations = 0;
    this.listNavigations = 0;
    this.resetPacing();
    const refreshed = [];
    for (const job of selected) {
      throwIfAborted(signal);
      await assertRuntimeTabBindings(assertTabBindings);
      console.error(`[boss] 更新活跃状态：${job.title}`);
      let normalized;
      try {
        const bossActiveText = await this.readActivity(selectedTabId, job.url, signal, assertTabBindings);
        throwIfAborted(signal);
        if (!bossActiveText) throw bossError("BOSS_ACTIVITY_UNAVAILABLE", "页面没有返回可识别的招聘方活跃状态");
        normalized = normalizeBossJob({ ...job, bossActiveText });
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
        await this.waitWithPacing("refresh", { signal, assertTabBindings });
        continue;
      }
      refreshed.push(normalized);
      if (typeof onAttempt === "function") await onAttempt({ job, refreshedJob: normalized, result: "success" });
      await this.waitWithPacing("refresh", { signal, assertTabBindings });
    }
    return refreshed;
  }

  async collectCards(tabId, maxCards, signal = null, assertTabBindings = null, onCards = null) {
    const found = new Map();
    let readinessAttempts = 0;
    while (!found.size && readinessAttempts < 10) {
      throwIfAborted(signal);
      await assertRuntimeTabBindings(assertTabBindings);
      await this.assertSearchPage(tabId);
      await this.browser.evalValue(tabId, PAGE_HELPERS);
      const initialCards = await this.browser.evalValue(tabId, `(() => window.__bossExtractCards(${maxCards}))()`);
      const added = mergeUniqueCards(found, initialCards);
      if (added.length && typeof onCards === "function") await onCards({ cards: added, total: found.size });
      if (found.size) break;
      readinessAttempts += 1;
      await this.waitWithPacing("list_ready", { signal, assertTabBindings });
    }
    if (readinessAttempts) {
      this.logger?.info("boss_list_content_waited", { attempts: readinessAttempts, cardCount: found.size });
    }
    let quietWindows = 0;
    let growthRounds = 0;
    let scrollRounds = 0;
    let confirmedEnd = false;
    const maxRounds = Math.max(20, normalizeCardLimit(maxCards));
    for (let round = 0; round < maxRounds && found.size < maxCards; round += 1) {
      throwIfAborted(signal);
      await assertRuntimeTabBindings(assertTabBindings);
      await this.assertSearchPage(tabId);
      await this.browser.evalValue(tabId, PAGE_HELPERS);
      const cards = await this.browser.evalValue(tabId, `(() => window.__bossExtractCards(${maxCards}))()`);
      const added = mergeUniqueCards(found, cards);
      if (added.length) {
        growthRounds += 1;
        if (typeof onCards === "function") await onCards({ cards: added, total: found.size });
      }
      if (found.size >= maxCards) break;
      const scroll = await this.scrollList(tabId, signal, assertTabBindings);
      scrollRounds += 1;
      if (scroll?.atBottom) {
        const growth = await this.waitForCardGrowth(tabId, maxCards, found, signal, assertTabBindings, onCards);
        if (growth.grew) {
          growthRounds += 1;
          quietWindows = 0;
          continue;
        }
        quietWindows += 1;
        if (quietWindows >= 2) {
          confirmedEnd = true;
          break;
        }
        continue;
      }
      quietWindows = 0;
      await this.waitWithPacing("scroll", { signal, assertTabBindings });
    }
    const reachedLimit = found.size >= maxCards;
    return {
      cards: [...found.values()].slice(0, maxCards),
      status: reachedLimit || confirmedEnd ? "completed" : "partial",
      stopReason: reachedLimit ? "card_limit_reached" : confirmedEnd ? "confirmed_end" : "scroll_safety_limit",
      scrollRounds,
      growthRounds,
      quietWindows
    };
  }

  async waitForCardGrowth(tabId, maxCards, found, signal = null, assertTabBindings = null, onCards = null) {
    const timeoutMs = randomBetween(2400, 3400, this.random);
    const pollMs = randomBetween(350, 650, this.random);
    const maxPolls = Math.max(4, Math.ceil(timeoutMs / pollMs));
    for (let poll = 0; poll < maxPolls; poll += 1) {
      throwIfAborted(signal);
      await assertRuntimeTabBindings(assertTabBindings);
      await waitForAbortableSleep(this.sleep(pollMs), signal);
      throwIfAborted(signal);
      await assertRuntimeTabBindings(assertTabBindings);
      await this.assertSearchPage(tabId);
      await this.browser.evalValue(tabId, PAGE_HELPERS);
      const cards = await this.browser.evalValue(tabId, `(() => window.__bossExtractCards(${maxCards}))()`);
      const added = mergeUniqueCards(found, cards);
      if (added.length && typeof onCards === "function") await onCards({ cards: added, total: found.size });
      if (added.length > 0 || found.size >= maxCards) return { grew: true, added: added.length, polls: poll + 1 };
    }
    return { grew: false, added: 0, polls: maxPolls };
  }

  async scrollList(tabId, signal = null, assertTabBindings = null) {
    throwIfAborted(signal);
    await assertRuntimeTabBindings(assertTabBindings);
    await this.assertSearchPage(tabId);
    await this.browser.evalValue(tabId, PAGE_HELPERS);
    await this.reserveAccess("list_scroll");
    const result = await this.browser.evalValue(tabId, "(() => window.__bossScrollList())()");
    this.logger?.info("boss_list_scrolled", result || {});
    return result || { moved: false, atBottom: false };
  }

  async readSearchPageApiDetail(tabId, job, signal = null, assertTabBindings = null, detailSessionId = "legacy") {
    const expectedJobId = (normalizeBossUrl(job?.url || "")
      .match(/\/job_detail\/([^/?#]+)\.html/i) || [])[1] || "";
    if (!expectedJobId) {
      throw bossError("BOSS_DETAIL_API_PARAMS_INVALID", "BOSS detail API requires a valid job URL.");
    }
    let started = false;
    try {
      throwIfAborted(signal);
      await assertRuntimeTabBindings(assertTabBindings);
      await this.assertSearchPage(tabId);
      await this.browser.evalValue(tabId, PAGE_HELPERS);
      await this.waitWithPacing("pane_detail_read", { signal, assertTabBindings });
      const eligibility = await this.browser.evalValue(
        tabId,
        `(() => window.__bossCanStartDetailFetch(${JSON.stringify(detailSessionId)}, ${JSON.stringify(expectedJobId)}))()`
      );
      if (eligibility?.state === "failed") throw bossError(eligibility.errorCode || "BOSS_DETAIL_API_RESPONSE_INVALID", "BOSS detail API request failed.");
      await this.reserveAccess("job_detail_fetch", { jobId: expectedJobId });
      throwIfAborted(signal);
      await assertRuntimeTabBindings(assertTabBindings);
      await this.assertSearchPage(tabId);
      await this.browser.cdp(tabId, "Page.setWebLifecycleState", { state: "active" });
      const start = await this.browser.evalValue(
        tabId,
        `(() => window.__bossStartDetailFetch(${JSON.stringify(detailSessionId)}, ${JSON.stringify(expectedJobId)}))()`
      );
      started = start?.state === "running";
      if (start?.state === "failed") throw bossError(start.errorCode || "BOSS_DETAIL_API_RESPONSE_INVALID", "BOSS detail API request failed.");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        throwIfAborted(signal);
        await assertRuntimeTabBindings(assertTabBindings);
        await this.assertSearchPage(tabId);
        const state = await this.browser.evalValue(
          tabId,
          `(() => window.__bossDetailFetchState(${JSON.stringify(detailSessionId)}, ${JSON.stringify(expectedJobId)}))()`
        );
        if (state?.state === "failed") {
          throw bossError(state.errorCode || "BOSS_DETAIL_API_RESPONSE_INVALID", "BOSS detail API request failed.");
        }
        if (state?.state === "succeeded") {
          const consumed = await this.browser.evalValue(
            tabId,
            `(() => window.__bossConsumeDetailFetch(${JSON.stringify(detailSessionId)}, ${JSON.stringify(expectedJobId)}))()`
          );
          const result = consumed?.result;
          if (!result || result.jobId !== expectedJobId || cleanDetailText(result.description).length < 120) {
            throw bossError("BOSS_DETAIL_API_RESPONSE_INVALID", "BOSS detail API returned an invalid sanitized result.");
          }
          return {
            description: cleanDetailText(result.description),
            bossActiveText: parseBossActivityText(result.bossActiveText),
            salary: result.salary || "",
            experience: result.experience || "",
            education: result.education || ""
          };
        }
        await waitForAbortableSleep(this.sleep(250), signal);
      }
      throw bossError("BOSS_DETAIL_API_TIMEOUT", "BOSS detail API request timed out.");
    } finally {
      if (started) {
        try {
          await this.browser.evalValue(tabId, `(() => window.__bossCancelDetailFetch(${JSON.stringify(detailSessionId)}, ${JSON.stringify(expectedJobId)}))()`);
        } catch {
          // Preserve the original stop, page, or API error.
        }
      }
    }
  }

  async readVisiblePaneDetail(tabId, job, signal = null, assertTabBindings = null) {
    throwIfAborted(signal);
    await assertRuntimeTabBindings(assertTabBindings);
    await this.assertSearchPage(tabId);
    await this.browser.evalValue(tabId, PAGE_HELPERS);
    const expectedJobId = (normalizeBossUrl(job?.url || "")
      .match(/\/job_detail\/([^/?#]+)\.html/i) || [])[1] || "";
    const expectedTitle = normalizedComparableText(job?.title);
    if (!expectedJobId || !expectedTitle) return null;
    await this.waitWithPacing("pane_detail_read", { signal, assertTabBindings });
    await this.reserveAccess("pane_detail_read", {
      jobId: expectedJobId
    });
    let activationAttempted = false;
    let scrolled = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      throwIfAborted(signal);
      await assertRuntimeTabBindings(assertTabBindings);
      await this.assertSearchPage(tabId);
      await this.browser.evalValue(tabId, PAGE_HELPERS);
      const detail = await this.browser.evalValue(tabId, "(() => window.__bossPaneState())()");
      const activeJobId = String(detail?.activeJobId || "");
      const componentCurrentJobId = String(detail?.componentCurrentJobId || "");
      const paneJobId = String(detail?.paneJobId || "");
      const observedIds = [activeJobId, componentCurrentJobId, paneJobId].filter(Boolean);
      const selectionHasTarget = observedIds.includes(expectedJobId);
      const hasIdentityMismatch = observedIds.some((value) => value !== expectedJobId);
      const hasSelectionMismatch = [activeJobId, componentCurrentJobId]
        .filter(Boolean)
        .some((value) => value !== expectedJobId);
      const selectionMatches = activeJobId === expectedJobId && componentCurrentJobId === expectedJobId;
      const stableOtherSelection = Boolean(activeJobId && componentCurrentJobId)
        && activeJobId === componentCurrentJobId
        && activeJobId !== expectedJobId;
      const paneIdentityMatches = selectionMatches && paneJobId === expectedJobId;
      if ((activationAttempted && hasSelectionMismatch)
        || (!activationAttempted && hasIdentityMismatch && selectionHasTarget)) {
        return null;
      }
      if (paneIdentityMatches) {
        const actualTitle = normalizedComparableText(detail?.title);
        if (!actualTitle || !actualTitle.includes(expectedTitle)) return null;
        const loadingSettled = detail?.jobDetailLoading === false
          || (!activationAttempted && detail?.jobDetailLoading === null);
        if (loadingSettled && detail?.description?.length >= 120) {
          await this.browser.evalValue(tabId, "(() => window.__bossScrollPane(true))()");
          return {
            description: cleanDetailText(detail.description),
            bossActiveText: parseBossActivityText(detail.bossActiveText),
            salary: detail.salary || "",
            experience: detail.experience || "",
            education: detail.education || ""
          };
        }
        if (!scrolled && detail?.canScroll) {
          scrolled = true;
          await this.browser.evalValue(tabId, "(() => window.__bossScrollPane(false))()");
        }
      } else if (stableOtherSelection && !activationAttempted) {
        if (typeof this.browser.cdp !== "function"
          || typeof this.browser.clickAt !== "function") {
          return null;
        }
        try {
          await this.browser.cdp(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
          await assertRuntimeTabBindings(assertTabBindings);
          await this.assertSearchPage(tabId);
          const activation = await this.browser.evalValue(
            tabId,
            `(() => window.__bossCardActivationPoint(${JSON.stringify(expectedJobId)}))()`
          );
          await assertRuntimeTabBindings(assertTabBindings);
          await this.assertSearchPage(tabId);
          const pointX = activation?.x;
          const pointY = activation?.y;
          if (!activation || activation.ready !== true || activation.jobId !== expectedJobId
            || typeof pointX !== "number" || typeof pointY !== "number"
            || !Number.isFinite(pointX) || !Number.isFinite(pointY)
            || pointX < 0 || pointY < 0) {
            return null;
          }
          await this.browser.clickAt(tabId, { x: pointX, y: pointY });
        } finally {
          await this.browser.cdp(tabId, "Emulation.setFocusEmulationEnabled", { enabled: false });
        }
        await assertRuntimeTabBindings(assertTabBindings);
        await this.assertSearchPage(tabId);
        activationAttempted = true;
      }
      await this.waitWithPacing("card_retry", { signal, assertTabBindings });
    }
    await this.browser.evalValue(tabId, "(() => window.__bossScrollPane(true))()");
    return null;
  }

  async assertSearchPage(tabId) {
    const state = await this.browser.evalValue(tabId, `(() => ({
      path: location.pathname,
      title: document.title || "",
      isRiskPage: /\\/web\\/passport\\/zp\\/(?:verify|403)/i.test(location.pathname)
        || new URLSearchParams(location.search).get("code") === "32"
        || /安全验证|访问异常|行为验证|访问受限/.test(document.title || "")
        || /账户存在异常行为|暂时无法访问此页面|请勿频繁提交刷新请求/.test(String(document.body?.innerText || "")),
      isLoginPage: /\\/web\\/user\\//i.test(location.pathname) || [...document.querySelectorAll(".sign-form, .login-register, [class*='login-form']")].some((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      }) || /没有更多职位.{0,20}登录查看全部职位|登录后可查看/.test(String(document.body?.innerText || "")),
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
      isRiskPage: /\\/web\\/passport\\/zp\\/(?:verify|403)/i.test(location.pathname)
        || new URLSearchParams(location.search).get("code") === "32"
        || /安全验证|访问异常|行为验证|访问受限/.test(document.title || "")
        || /账户存在异常行为|暂时无法访问此页面|请勿频繁提交刷新请求/.test(String(document.body?.innerText || "")),
      isLoginPage: /\\/web\\/user\\//i.test(location.pathname) || [...document.querySelectorAll(".sign-form, .login-register, [class*='login-form']")].some((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      }) || /没有更多职位.{0,20}登录查看全部职位|登录后可查看/.test(String(document.body?.innerText || "")),
      jobId: (location.pathname.match(/\\/job_detail\\/([^/?#]+)\\.html/i) || [])[1] || ""
    }))()`);
    if (state?.isRiskPage) throw bossError("BOSS_RISK_CONTROL", "BOSS 当前要求安全验证，已停止本轮页面访问。");
    if (state?.isLoginPage) throw bossError("BOSS_LOGIN_REQUIRED", "BOSS 登录状态已失效，已停止本轮页面访问。");
    if (!state?.jobId || (expectedJobId && state.jobId !== expectedJobId)) {
      throw bossError("BOSS_DETAIL_PAGE_LOST", `BOSS 详情页已离开：${state?.title || state?.path || "unknown"}`);
    }
    return state;
  }

  async readDetail(tabId, url, signal = null, assertTabBindings = null) {
    throwIfAborted(signal);
    await assertRuntimeTabBindings(assertTabBindings);
    const normalizedUrl = normalizeBossNavigationUrl(url);
    const expectedJobId = (normalizeBossUrl(normalizedUrl)
      .match(/\/job_detail\/([^/?#]+)\.html/i) || [])[1] || "";
    if (!normalizedUrl || !expectedJobId) {
      throw bossError("BOSS_DETAIL_URL_INVALID", "BOSS standalone detail URL is invalid.");
    }
    await this.navigateWithPacing(tabId, normalizedUrl, "detail", { signal, assertTabBindings });
    for (let i = 0; i < 8; i += 1) {
      throwIfAborted(signal);
      await assertRuntimeTabBindings(assertTabBindings);
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
      await this.waitWithPacing("retry", { signal, assertTabBindings });
    }
    throw bossError(
      "BOSS_DETAIL_LOAD_TIMEOUT",
      `BOSS standalone detail did not become complete for ${expectedJobId || "unknown"}`
    );
  }

  async readActivity(tabId, url, signal = null, assertTabBindings = null) {
    throwIfAborted(signal);
    await assertRuntimeTabBindings(assertTabBindings);
    const expectedJobId = (normalizeBossUrl(url).match(/\/job_detail\/([^/?#]+)\.html/i) || [])[1] || "";
    await this.navigateWithPacing(tabId, url, "detail", { signal, assertTabBindings });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      throwIfAborted(signal);
      await assertRuntimeTabBindings(assertTabBindings);
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
      await this.waitWithPacing("retry", { signal, assertTabBindings });
    }
    return "";
  }

  async prepareCommunicationTab(searchTabId = null) {
    if (!this.browser) throw bossError("BOSS_BROWSER_REQUIRED", "BOSS communication inspection requires a browser connection.");
    if (this.communicationTabPreparationPromise) return this.communicationTabPreparationPromise;
    const preparation = this.prepareCommunicationTabOnce(searchTabId);
    this.communicationTabPreparationPromise = preparation;
    try {
      return await preparation;
    } finally {
      if (this.communicationTabPreparationPromise === preparation) this.communicationTabPreparationPromise = null;
    }
  }

  bindCommunicationTabs(binding = {}) {
    const normalized = normalizeCommunicationTabBinding(binding);
    if (this.communicationBinding
      && JSON.stringify(this.communicationBinding) !== JSON.stringify(normalized)) {
      throw bossError("BOSS_OPERATOR_TABS_CHANGED", "The fixed BOSS operator tabs cannot be rebound during communication inspection.");
    }
    this.communicationBinding = normalized;
    this.communicationSearchTabId = normalized.searchTabId;
    this.communicationTabId = normalized.searchTabId;
    this.communicationMessageTabId = normalized.messageTabId;
    this.communicationTabsBound = true;
    this.communicationSearchRestored = false;
  }

  async beginCommunicationSession() {
    if (!this.communicationTabsBound) return this.prepareCommunicationTab();
    this.communicationSearchRestored = false;
    await this.assertBoundCommunicationTabs({ requireSearchPage: true });
    return this.communicationBinding.searchTabId;
  }

  async captureCommunicationSearchState(tabId) {
    if (!isBrowserTabId(tabId)) {
      throw bossError("BOSS_COMMUNICATION_BINDING_REQUIRED", "A valid fixed search tab ID is required.");
    }
    await this.assertSearchPage(tabId);
    const state = await this.browser.evalValue(tabId, `(() => ({
      url: location.href,
      scrollTop: Math.max(0, Math.floor(window.scrollY || document.documentElement.scrollTop || 0))
    }))()`);
    let url;
    try {
      url = new URL(String(state?.url || ""));
    } catch {
      throw bossError("BOSS_SEARCH_PAGE_LOST", "The fixed BOSS search page returned an invalid URL.");
    }
    const scrollTop = Number(state?.scrollTop);
    if (url.origin !== "https://www.zhipin.com"
      || url.pathname !== "/web/geek/jobs"
      || url.username
      || url.password
      || url.hash
      || !Number.isInteger(scrollTop)
      || scrollTop < 0) {
      throw bossError("BOSS_SEARCH_PAGE_LOST", "The fixed BOSS search page returned invalid restoration state.");
    }
    return { url: url.toString(), scrollTop };
  }

  async assertBoundCommunicationTabs({ requireSearchPage = false } = {}) {
    const binding = this.communicationBinding;
    if (!this.communicationTabsBound || !binding) {
      throw bossError("BOSS_COMMUNICATION_BINDING_REQUIRED", "A persisted fixed-tab binding is required.");
    }
    const tabs = await this.browser.listTabs();
    const searchTab = tabs.find((tab) => sameBrowserTabId(tab.id, binding.searchTabId));
    const messageTab = tabs.find((tab) => sameBrowserTabId(tab.id, binding.messageTabId));
    if (!searchTab || !messageTab) {
      throw bossError("BOSS_OPERATOR_TABS_CHANGED", "The fixed BOSS operator tabs changed.");
    }
    if (searchTab.windowId !== binding.windowId || messageTab.windowId !== binding.windowId) {
      throw bossError("BOSS_WINDOW_MISMATCH", "The fixed BOSS operator tabs moved to another window.");
    }
    if (bossTabPath(messageTab) !== "/web/geek/chat") {
      throw bossError("BOSS_COMMUNICATION_PAGE_LOST", "The fixed BOSS message tab left the chat page.");
    }
    const searchPath = bossTabPath(searchTab);
    const validSearchPath = searchPath === "/web/geek/jobs";
    const validDetailPath = /^\/job_detail\/[^/?#]+\.html$/i.test(searchPath);
    if ((requireSearchPage && !validSearchPath)
      || (!requireSearchPage && !validSearchPath && !validDetailPath)) {
      throw bossError("BOSS_SEARCH_PAGE_LOST", "The fixed BOSS search tab left its permitted page.");
    }
    return { searchTab, messageTab, windowId: binding.windowId };
  }

  async restoreCommunicationSearchPage() {
    if (!this.communicationTabsBound || this.communicationSearchRestored) return;
    this.communicationSearchRestored = true;
    const binding = this.communicationBinding;
    await this.assertBoundCommunicationTabs({ requireSearchPage: false });
    await this.browser.navigate(binding.searchTabId, binding.searchReturnUrl);
    await this.waitWithPacing("detail");
    await this.assertSearchPage(binding.searchTabId);
    await this.browser.evalValue(binding.searchTabId, `(() => {
      const requested = ${JSON.stringify(binding.searchScrollTop)};
      const maximum = Math.max(0, document.documentElement.scrollHeight - innerHeight);
      const applied = Math.min(maximum, Math.max(0, requested));
      scrollTo(0, applied);
      return { requested, applied };
    })()`);
    await this.assertBoundCommunicationTabs({ requireSearchPage: true });
  }

  async prepareCommunicationTabOnce(searchTabId = null) {
    if (this.communicationTabsBound) {
      if (searchTabId !== null && searchTabId !== undefined
        && !sameBrowserTabId(searchTabId, this.communicationBinding.searchTabId)) {
        throw bossError("BOSS_SEARCH_PAGE_LOST", "The fixed BOSS search tab cannot be rebound during communication inspection.");
      }
      await this.assertBoundCommunicationTabs({ requireSearchPage: false });
      return this.communicationBinding.searchTabId;
    }
    const hasCachedSearchTab = this.communicationSearchTabId !== null;
    const hasExplicitSearchTab = searchTabId !== null && searchTabId !== undefined;
    if (hasCachedSearchTab
      && hasExplicitSearchTab
      && String(searchTabId) !== String(this.communicationSearchTabId)) {
      throw bossError("BOSS_SEARCH_PAGE_LOST", "The fixed BOSS search tab cannot be rebound during communication inspection.");
    }
    const tabs = await this.browser.listTabs();
    const searchTab = searchTabId === null || searchTabId === undefined
      ? hasCachedSearchTab
        ? tabs.find((tab) => String(tab.id) === String(this.communicationSearchTabId))
        : tabs.filter(isBossSearchTab).sort(compareBossTabs)[0]
      : tabs.find((tab) => String(tab.id) === String(searchTabId));
    if (!searchTab || !isBossSearchTab(searchTab)) {
      throw bossError(
        hasCachedSearchTab ? "BOSS_SEARCH_PAGE_LOST" : "BOSS_TAB_REQUIRED",
        "A verified fixed BOSS search tab is required to prepare communication inspection."
      );
    }
    if (!hasKnownBossWindow(searchTab)) {
      throw bossError("BOSS_COMMUNICATION_TAB_WINDOW_UNKNOWN", "无法确认 RoleFlow 专用 Edge（推荐）标签页所属窗口。请关闭多余的 RoleFlow 专用 Edge（推荐）窗口后重新运行 Start.bat。");
    }
    await this.assertSearchPage(searchTab.id);
    this.communicationSearchTabId = searchTab.id;

    const reusableCandidates = tabs.filter(isReusableBossCommunicationTab);
    if (reusableCandidates.some((tab) => !hasKnownBossWindow(tab))) {
      throw bossError("BOSS_COMMUNICATION_TAB_WINDOW_UNKNOWN", "无法确认 RoleFlow 专用 Edge（推荐）标签页所属窗口。请关闭多余的 RoleFlow 专用 Edge（推荐）窗口后重新运行 Start.bat。");
    }

    const stored = this.communicationTabId === null
      ? null
      : tabs.find((tab) => String(tab.id) === String(this.communicationTabId));
    if (this.communicationTabsBound && !stored) {
      throw bossError("BOSS_OPERATOR_TABS_CHANGED", "The bound BOSS communication tab is no longer present.");
    }
    if (stored) {
      if (!sameBossWindow(searchTab, stored)) {
        if (this.communicationTabsBound) {
          throw bossError("BOSS_OPERATOR_TABS_CHANGED", "The bound BOSS communication tab is in a different browser window.");
        }
        throw bossError("BOSS_COMMUNICATION_TAB_WINDOW_MISMATCH", "The fixed BOSS communication tab is in a different browser window.");
      }
      if (!isCachedBossCommunicationTab(stored)) {
        if (this.communicationTabsBound) {
          throw bossError("BOSS_COMMUNICATION_PAGE_LOST", "The bound BOSS communication tab is no longer a chat or detail page.");
        }
        throw bossError("BOSS_DETAIL_PAGE_LOST", "The fixed BOSS communication tab is no longer a standalone detail or chat page.");
      }
      return stored.id;
    }
    this.communicationTabId = null;

    const reusable = reusableCandidates.filter((tab) => sameBossWindow(searchTab, tab)).sort(compareBossTabs)[0];
    if (reusable) {
      this.communicationTabId = reusable.id;
      return reusable.id;
    }

    const tabId = await this.browser.createTab(searchTab.id, "about:blank");
    this.communicationTabId = tabId;
    return tabId;
  }

  async inspectCommunicationJob(job, signal = null) {
    if (!this.browser) throw bossError("BOSS_BROWSER_REQUIRED", "BOSS communication inspection requires a browser connection.");
    this.beginCommunicationOperation("inspection");
    try {
      throwIfAborted(signal);
      const url = normalizeTrustedBossCommunicationUrl(job?.url);
      if (!url) {
        throw bossError("BOSS_COMMUNICATION_URL_INVALID", "BOSS communication inspection requires a trusted standalone detail URL.");
      }
      const tabId = await this.prepareCommunicationTab();
      await this.browser.navigate(tabId, url);
      await this.waitWithPacing("detail");
      if (this.communicationTabsBound) await this.assertBoundCommunicationTabs({ requireSearchPage: false });
      await this.browser.evalValue(tabId, PAGE_HELPERS);

      let inspection = { state: "action_unavailable" };
      let readySnapshots = 0;
      let settledUnavailableSnapshots = 0;
      for (let attempt = 0; attempt < COMMUNICATION_SNAPSHOT_ATTEMPTS; attempt += 1) {
        throwIfAborted(signal);
        if (this.communicationTabsBound) await this.assertBoundCommunicationTabs({ requireSearchPage: false });
        const snapshot = await this.browser.evalValue(tabId, "(() => window.__bossCommunicationSnapshot())()");
        inspection = classifyBossCommunicationSnapshot(snapshot, { ...job, url });
        if (inspection.state === "ready") {
          settledUnavailableSnapshots = 0;
          readySnapshots += 1;
          if (readySnapshots >= COMMUNICATION_READY_SNAPSHOTS) return inspection;
        } else {
          readySnapshots = 0;
          if (["already_communicated", "target_mismatch", "job_unavailable"].includes(inspection.state)) return inspection;
          if (inspection.state === "action_unavailable") {
            settledUnavailableSnapshots += 1;
            if (settledUnavailableSnapshots >= COMMUNICATION_SETTLED_UNAVAILABLE_SNAPSHOTS) return inspection;
          } else {
            settledUnavailableSnapshots = 0;
          }
        }
        if (attempt < COMMUNICATION_SNAPSHOT_ATTEMPTS - 1) await this.waitWithPacing("retry");
      }
      return inspection;
    } finally {
      this.finishCommunicationOperation("inspection");
    }
  }

  async dispatchCommunication(inspection, signal = null) {
    if (!this.browser) throw bossError("BOSS_BROWSER_REQUIRED", "BOSS communication dispatch requires a browser connection.");
    this.beginCommunicationOperation("dispatch");
    let tabId = null;
    let dispatched = false;
    let networkLogStarted = false;
    try {
      const expectedJob = communicationJobFromInspection(inspection);
      if (!expectedJob) {
        throw bossError("BOSS_COMMUNICATION_INSPECTION_INVALID", "A verified BOSS communication inspection is required before dispatch.");
      }
      if (this.communicationDispatchedJobIds.has(expectedJob.jobId)) {
        throw bossError("BOSS_COMMUNICATION_ALREADY_DISPATCHED", "This BOSS job already entered communication dispatch and cannot be clicked again.");
      }
      throwIfAborted(signal);
      tabId = await this.prepareCommunicationTab();
      if (this.communicationTabsBound) await this.assertBoundCommunicationTabs({ requireSearchPage: false });
      if (typeof this.browser.cdp !== "function"
        || typeof this.browser.clickAt !== "function") {
        throw bossError("BOSS_COMMUNICATION_TAB_NOT_ACTIVE", "The BOSS communication tab cannot be focused safely in the background.");
      }
      await this.browser.evalValue(tabId, PAGE_HELPERS);
      await this.waitForStableCommunicationDispatchReadiness(tabId, expectedJob, signal);
      throwIfAborted(signal);
      this.communicationDispatchedJobIds.add(expectedJob.jobId);
      await this.browser.startNetworkLog(tabId, {
        maxEntries: 12,
        maxBodies: 4,
        maxBodyBytes: 8192,
        resourceTypes: ["XHR", "Fetch"],
        bodyUrlIncludes: COMMUNICATION_NETWORK_URL_INCLUDES,
        urlIncludes: COMMUNICATION_NETWORK_URL_INCLUDES,
        captureBodies: true,
        clear: true
      });
      networkLogStarted = true;
      const mark = await this.browser.getNetworkLogMark(tabId);
      await this.browser.cdp(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
      try {
        if (this.communicationTabsBound) await this.assertBoundCommunicationTabs({ requireSearchPage: false });
        const clickTarget = await this.browser.evalValue(tabId, guardedBossCommunicationClickExpression(expectedJob));
        if (clickTarget?.ready !== true || clickTarget?.jobId !== expectedJob.jobId) {
          if (clickTarget?.reason === "risk_control") {
            throw bossError("BOSS_RISK_CONTROL", "BOSS requires security verification; communication dispatch has stopped.");
          }
          if (clickTarget?.reason === "login_required") {
            throw bossError("BOSS_LOGIN_REQUIRED", "BOSS login is no longer valid; communication dispatch has stopped.");
          }
          throw bossError("BOSS_COMMUNICATION_TARGET_CHANGED", "The guarded BOSS communication target changed before click dispatch.");
        }
        await this.browser.clickAt(tabId, clickTarget.clickPoint);
      } finally {
        await this.browser.cdp(tabId, "Emulation.setFocusEmulationEnabled", { enabled: false });
      }
      this.lastCommunicationDispatch = {
        jobId: expectedJob.jobId,
        tabId,
        expectedJob,
        networkSequence: Number(mark?.mark?.lastSequence || 0)
      };
      dispatched = true;
      return { state: "dispatched", jobId: expectedJob.jobId };
    } finally {
      if (!dispatched && tabId !== null) {
        if (networkLogStarted) await this.stopCommunicationNetworkLog(tabId);
        await this.closeCommunicationOutcomeObserver(tabId);
      }
      this.finishCommunicationOperation("dispatch");
    }
  }

  async closeCommunicationOutcomeObserver(tabId) {
    try {
      await this.browser.evalValue(tabId, "(() => window.__bossCloseCommunicationOutcomeObserver?.())()");
    } catch {}
  }

  async stopCommunicationNetworkLog(tabId) {
    try {
      await this.browser.stopNetworkLog(tabId, { clear: true, detachIfIdle: false });
    } catch (error) {
      this.logger?.warn("boss_communication_network_log_cleanup_failed", {
        errorCode: String(error?.code || "BROWSER_COMMAND_FAILED")
      });
    }
  }

  async waitForStableCommunicationDispatchReadiness(tabId, expectedJob, signal) {
    let readySnapshots = 0;
    for (let attempt = 0; attempt < COMMUNICATION_DISPATCH_READINESS_ATTEMPTS; attempt += 1) {
      throwIfAborted(signal);
      const snapshot = await this.browser.evalValue(tabId, "(() => window.__bossCommunicationSnapshot())()");
      const inspection = classifyBossCommunicationSnapshot(snapshot, expectedJob);
      if (inspection.state === "ready" && inspection.jobId === expectedJob.jobId) {
        readySnapshots += 1;
        if (readySnapshots >= COMMUNICATION_READY_SNAPSHOTS) return inspection;
      } else {
        if (["target_mismatch", "job_unavailable", "action_unavailable"].includes(inspection.state)) {
          throw bossError("BOSS_COMMUNICATION_TARGET_CHANGED", "The BOSS detail page changed before communication dispatch.");
        }
        readySnapshots = 0;
      }
      if (attempt < COMMUNICATION_DISPATCH_READINESS_ATTEMPTS - 1) await this.waitWithPacing("retry");
    }
    throw bossError("BOSS_COMMUNICATION_READINESS_TIMEOUT", "The fixed BOSS communication tab did not remain ready before click dispatch.");
  }

  async verifyCommunicationResult(job, signal = null) {
    if (!this.browser) throw bossError("BOSS_BROWSER_REQUIRED", "BOSS communication verification requires a browser connection.");
    this.beginCommunicationOperation("verification");
    let tabId = null;
    let dispatch = null;
    try {
      dispatch = this.lastCommunicationDispatch;
      const expectedJobId = communicationJobId(job?.url);
      if (!dispatch) {
        throw bossError("BOSS_COMMUNICATION_VERIFICATION_UNAVAILABLE", "No completed BOSS communication dispatch is available to verify.");
      }
      if (!expectedJobId
        || expectedJobId !== dispatch.jobId
        || !sameBossCommunicationTitle({ title: dispatch.expectedJob.title }, job)
        || !sameBossCommunicationCompany({ company: dispatch.expectedJob.company }, job)) {
        throw bossError("BOSS_COMMUNICATION_VERIFICATION_TARGET_MISMATCH", "The BOSS job being verified does not match the dispatched job.");
      }
      throwIfAborted(signal);
      tabId = await this.prepareCommunicationTab();
      if (tabId !== dispatch.tabId) {
        throw bossError("BOSS_COMMUNICATION_TARGET_CHANGED", "The fixed BOSS communication tab changed before result verification.");
      }
      if (this.communicationTabsBound) await this.assertBoundCommunicationTabs({ requireSearchPage: false });
      await this.waitWithPacing("detail");
      await this.browser.evalValue(tabId, PAGE_HELPERS);
      let network = { state: "no_matching_request", evidence: { endpoints: [] } };
      let page = { state: "ambiguous" };
      for (let attempt = 0; attempt < COMMUNICATION_SNAPSHOT_ATTEMPTS; attempt += 1) {
        throwIfAborted(signal);
        network = classifyBossCommunicationNetworkLog(await this.browser.readNetworkLog(tabId, {
          sinceSequence: dispatch.networkSequence,
          maxEntries: 12,
          includeBodies: true,
          resourceTypes: ["XHR", "Fetch"],
          urlIncludes: COMMUNICATION_NETWORK_URL_INCLUDES,
          consume: false
        }));
        const snapshot = await this.browser.evalValue(tabId, "(() => window.__bossCommunicationSnapshot())()");
        page = classifyBossCommunicationResultSnapshot(snapshot, dispatch.expectedJob);
        if (["target_mismatch", "job_unavailable"].includes(page.state)) return page;
        if (network.state === "accepted") {
          return {
            state: "succeeded",
            jobId: dispatch.jobId,
            evidence: communicationOutcomeEvidence(network, "succeeded")
          };
        }
        if (snapshot?.intermediateDialog?.visible === true) {
          return {
            state: "ambiguous",
            errorCode: "COMMUNICATION_USER_ACTION_REQUIRED",
            evidence: communicationOutcomeEvidence(network, "confirmation_dialog")
          };
        }
        if (page.state === "succeeded" && ["platform_rejected", "transport_failed", "ambiguous"].includes(network.state)) {
          return {
            state: "ambiguous",
            errorCode: "COMMUNICATION_RESULT_AMBIGUOUS",
            evidence: communicationOutcomeEvidence(network, "request_conflict")
          };
        }
        if (["platform_rejected", "transport_failed"].includes(network.state)) {
          return {
            ...network,
            evidence: communicationOutcomeEvidence(
              network,
              network.state === "platform_rejected" ? "request_rejected" : "request_failed"
            )
          };
        }
        if (network.state === "ambiguous") {
          return {
            state: "ambiguous",
            errorCode: "COMMUNICATION_RESULT_AMBIGUOUS",
            evidence: communicationOutcomeEvidence(network, "request_unparsed")
          };
        }
        if (attempt < COMMUNICATION_SNAPSHOT_ATTEMPTS - 1) await this.waitWithPacing("retry");
      }
      if (network.state === "no_matching_request" && page.state === "ambiguous") {
        return {
          state: "ambiguous",
          errorCode: "COMMUNICATION_ACTION_NOT_TRIGGERED",
          evidence: communicationOutcomeEvidence(network, "no_matching_request")
        };
      }
      return {
        state: "ambiguous",
        errorCode: "COMMUNICATION_RESULT_AMBIGUOUS",
        evidence: communicationOutcomeEvidence(network, "request_conflict")
      };
    } finally {
      if (dispatch?.tabId !== null && dispatch?.tabId !== undefined) {
        await this.stopCommunicationNetworkLog(dispatch.tabId);
        await this.closeCommunicationOutcomeObserver(dispatch.tabId);
      }
      this.finishCommunicationOperation("verification");
    }
  }
}

function isSafePacingState(state) {
  if (!state || Object.keys(state).some((field) => !PACING_STATE_FIELDS.includes(field))) return false;
  if (PACING_STATE_FIELDS.some((field) => !Number.isSafeInteger(state[field]) || state[field] < 0)) return false;
  return state.nextPacingCooldownAt <= state.pacedActions + Math.max(...BOSS_PACING_POLICY.periodicEvery)
    && state.nextDetailMicroCooldownAt <= state.detailActions + Math.max(...BOSS_PACING_POLICY.detail.microEvery)
    && state.nextDetailMacroCooldownAt <= state.detailActions + Math.max(...BOSS_PACING_POLICY.detail.macroEvery);
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

function dedupeBossUrlOptions(items = []) {
  const unique = new Map();
  for (const item of items) {
    const normalized = {
      param: String(item?.param || "").trim(),
      code: String(item?.code || "").trim(),
      label: String(item?.label || "").replace(/\s+/g, " ").trim()
    };
    if (!normalized.param || !normalized.code || !normalized.label) continue;
    unique.set(`${normalized.param}:${normalized.code}`, normalized);
  }
  return [...unique.values()].sort((left, right) =>
    left.param.localeCompare(right.param) || left.code.localeCompare(right.code)
  );
}

function normalizePriority(value) {
  return ["A", "B", "C"].includes(value) ? value : "B";
}

function buildBossSearchUrl({ keyword, cityCode, nativeFilters, searchTemplate } = {}) {
  const template = normalizeBossSearchTemplate(searchTemplate);
  if (template.mode === "inherited") {
    const url = new URL(template.url);
    if (keyword) url.searchParams.set("query", keyword);
    else url.searchParams.delete("query");
    url.searchParams.delete("page");
    url.hash = "";
    return url.toString();
  }
  const filters = normalizeNativeFilters(nativeFilters);
  const url = new URL("https://www.zhipin.com/web/geek/jobs");
  if (keyword) url.searchParams.set("query", keyword);
  if (cityCode) url.searchParams.set("city", cityCode);
  for (const [name, values] of Object.entries(filters.params)) {
    if (values.length) url.searchParams.set(name, values.join(","));
  }
  return url.toString();
}

function normalizeBossSearchTemplate(value) {
  const raw = typeof value === "string" ? value : value?.url;
  try {
    return canonicalizeBossSearchTemplate(raw);
  } catch {
    return { mode: "generated", url: "", cityCode: "" };
  }
}

function resolveBossSearchContext({ currentUrl = "", storedTemplate = null, cityScopes = [] } = {}) {
  const hasStoredTemplate = storedTemplate && typeof storedTemplate === "object" && Object.hasOwn(storedTemplate, "mode");
  const searchTemplate = normalizeBossSearchTemplate(hasStoredTemplate ? storedTemplate : currentUrl);
  const scopes = Array.isArray(cityScopes) ? cityScopes : [];
  if (searchTemplate.mode !== "inherited") return { searchTemplate, cityScopes: scopes };
  const matched = scopes.find((scope) => String(scope?.cityCode || "") === searchTemplate.cityCode);
  return {
    searchTemplate,
    cityScopes: [{
      city: matched?.city || "",
      cityCode: searchTemplate.cityCode || "platform-default"
    }]
  };
}

function normalizeNativeFilterLanes(value = {}) {
  const source = Array.isArray(value?.lanes) && value.lanes.length ? value.lanes : [value];
  return source.map((lane, index) => ({
    ...normalizeNativeFilters(lane),
    id: String(lane?.id || `lane-${index + 1}`),
    rank: Number.isFinite(Number(lane?.rank)) ? Number(lane.rank) : index
  }));
}

function buildBossScanTargets(options = {}) {
  const keywords = options.keywords?.length ? options.keywords : [];
  const keywordPlan = normalizeKeywordPlan(keywords, options.keywordPlan)
    .sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority) || left.order - right.order);
  const cityScopes = normalizeCityScopes(options);
  const nativeFilterLanes = normalizeNativeFilterLanes(options.nativeFilters);
  const maxCards = normalizeCardLimit(options.maxCards);
  const supplementalKeywordLimit = normalizeOptionalLimit(options.supplementalSalaryLaneKeywordLimit);
  const supplementalCardLimit = normalizeOptionalLimit(options.supplementalSalaryLaneCardLimit);
  const supplementalDetailLimit = normalizeOptionalLimit(options.supplementalSalaryLaneDetailLimit);
  const targets = [];
  for (const [cityOrder, city] of cityScopes.entries()) {
    const primaryLane = nativeFilterLanes[0];
    const supplementalLanes = nativeFilterLanes.slice(1);
    for (const item of keywordPlan) {
      const keyword = item.word;
      const cardLimit = weightedCardLimit(item.priority, maxCards);
      targets.push(bossScanTarget({ cityOrder, city, item, keyword, cardLimit, lane: primaryLane }));
    }
    const supplementalKeywords = supplementalKeywordLimit === null
      ? keywordPlan
      : keywordPlan.slice(0, supplementalKeywordLimit);
    for (const lane of supplementalLanes) {
      for (const item of supplementalKeywords) {
        const keyword = item.word;
        const weightedLimit = weightedCardLimit(item.priority, maxCards);
        const cardLimit = supplementalCardLimit === null ? weightedLimit : Math.min(weightedLimit, supplementalCardLimit);
        targets.push(bossScanTarget({
          cityOrder,
          city,
          item,
          keyword,
          cardLimit,
          lane,
          detailLimitOverride: supplementalDetailLimit
        }));
      }
    }
  }
  return targets;
}

function bossScanTarget({ cityOrder, city, item, keyword, cardLimit, lane, detailLimitOverride = null }) {
  const laneId = lane.id || "default";
  return {
    cityOrder,
    city,
    item,
    keyword,
    cardLimit,
    lane,
    laneId,
    detailLimitOverride,
    targetKey: [city.cityCode, keyword, laneId].join("|")
  };
}

function normalizeOptionalLimit(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : null;
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
  const ratio = SEARCH_PLAN_POLICY.priorityCardRatios[normalizePriority(priority)];
  return Math.max(SEARCH_PLAN_POLICY.minCardsPerTarget, Math.ceil(normalizeCardLimit(baseLimit) * ratio));
}

function normalizeCardLimit(value) {
  const [min, max] = SEARCH_PLAN_POLICY.scanBounds.maxCards;
  const limit = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(limit) ? limit : SEARCH_PLAN_POLICY.broadScanDefaults.maxCards));
}

function normalizePageBudget(value) {
  const [min, max] = SEARCH_PLAN_POLICY.scanBounds.browserPageBudget;
  const budget = Number(value);
  return Number.isFinite(budget)
    ? Math.max(min, Math.min(max, Math.floor(budget)))
    : SEARCH_PLAN_POLICY.broadScanDefaults.browserPageBudget;
}

function randomBetween(min, max, randomFn = Math.random) {
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  return Math.round(low + (high - low) * Math.max(0, Math.min(1, Number(randomFn()) || 0)));
}

function mergeUniqueCards(found, cards) {
  const added = [];
  for (const card of cards || []) {
    const key = bossSourceId(card) || `${card.company}|${card.title}|${card.salary}|${card.cardText}`;
    if (found.has(key)) continue;
    found.set(key, card);
    added.push(card);
  }
  return added;
}

function reusableDetailMatches(job, cached) {
  if (!cached?.description) return false;
  return ["title", "company", "location", "salary", "experience", "education"].every((field) => {
    const current = normalizedComparableText(job?.[field]);
    const previous = normalizedComparableText(cached?.[field]);
    return !current || !previous || current === previous;
  });
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

function normalizeBossUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  try {
    const parsed = new URL(value, "https://www.zhipin.com");
    if (parsed.protocol !== "https:" || !/(^|\.)zhipin\.com$/i.test(parsed.hostname)) return "";
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

function bossLogLocation(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ""));
    return {
      origin: url.origin,
      path: url.pathname
    };
  } catch {
    return { origin: "", path: "" };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function assertRuntimeTabBindings(assertTabBindings) {
  if (typeof assertTabBindings === "function") await assertTabBindings();
}

function waitForAbortableSleep(sleepPromise, signal = null) {
  if (!signal) return sleepPromise;
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(sleepPromise).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}

function bossError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function selectBossPreflightReadError(errors) {
  const priority = [
    "BROWSER_DISCONNECTED",
    "BROWSER_TIMEOUT",
    "BROWSER_COMMAND_FAILED",
    "BOSS_SEARCH_PAGE_LOST",
    "BOSS_DETAIL_PAGE_LOST"
  ];
  return priority.map((code) => errors.find((error) => error?.code === code)).find(Boolean)
    || errors[0];
}

function isFatalBrowserError(error) {
  return new Set([
    "BOSS_PAGE_BUDGET_REACHED",
    "BOSS_RISK_CONTROL",
    "BOSS_LOGIN_REQUIRED",
    "BOSS_DETAIL_API_BUSY",
    "BOSS_DETAIL_API_REPEAT_REQUEST",
    "BOSS_ACCESS_BUDGET_EXHAUSTED",
    "BOSS_TAB_REQUIRED",
    "BOSS_SEARCH_TAB_CHANGED",
    "BOSS_OPERATOR_TABS_CHANGED",
    "BOSS_COMMUNICATION_PAGE_LOST",
    "BOSS_WINDOW_MISMATCH",
    "BOSS_SEARCH_PAGE_LOST",
    "BOSS_DETAIL_PAGE_LOST",
    "BROWSER_TIMEOUT",
    "BROWSER_DISCONNECTED",
    "BROWSER_COMMAND_FAILED",
    "SCAN_ABORTED",
    "SCAN_CHECKPOINT_FAILED",
    "SCAN_LEASE_LOST"
  ]).has(String(error?.code || ""));
}

function isWorkflowControlError(error) {
  return ["WORKFLOW_PAUSE_REQUESTED", "WORKFLOW_STOP_REQUESTED"]
    .includes(String(error?.code || ""));
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("扫描已中止。");
  error.code = "SCAN_ABORTED";
  throw error;
}

async function emitDetailResult(callback, { outcome, errorCode = "", accessMode = "standalone_detail" } = {}) {
  if (typeof callback !== "function") return;
  const succeeded = outcome === "succeeded";
  await callback({
    outcome: succeeded ? "succeeded" : "failed",
    errorCode: succeeded ? "" : String(errorCode || "BOSS_DETAIL_LOAD_TIMEOUT"),
    accessMode
  });
}

function normalizedComparableText(value) {
  return String(value || "").toLowerCase().replace(/[\s·._()（）\-_/]/g, "");
}

function normalizeCommunicationText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s\u00b7._()\[\]{}<>\-_/\\,;:!?\u3000-\u303f\uff00-\uff65]/g, "");
}

const EXPLICITLY_UNAVAILABLE_BOSS_JOB_STATUSES = Object.freeze([
  "\u505c\u6b62\u62db\u8058",
  "\u5df2\u505c\u6b62\u62db\u8058",
  "\u804c\u4f4d\u5df2\u5173\u95ed",
  "\u804c\u4f4d\u5df2\u4e0b\u67b6",
  "\u5df2\u4e0b\u67b6"
]);
const NORMALIZED_UNAVAILABLE_BOSS_JOB_STATUSES = new Set(
  EXPLICITLY_UNAVAILABLE_BOSS_JOB_STATUSES.map(normalizeCommunicationText)
);
const COMMUNICATION_SNAPSHOT_ATTEMPTS = 40;
const COMMUNICATION_READY_SNAPSHOTS = 2;
const COMMUNICATION_SETTLED_UNAVAILABLE_SNAPSHOTS = 4;
const COMMUNICATION_DISPATCH_READINESS_ATTEMPTS = 4;
const COMMUNICATION_NETWORK_URL_INCLUDES = Object.freeze([
  "/wapi/zpchat/config/get",
  "/wapi/zpgeek/friend/add.json"
]);
const COMMUNICATION_OUTCOME_PAGE_STATES = new Set(["request_accepted", "request_rejected", "request_failed", "request_conflict", "request_unparsed", "observer_timeout", "no_matching_request", "request_pending", "succeeded", "page_unverified", "confirmation_dialog"]);
const COMMUNICATION_OUTCOME_CATEGORIES = new Set(["success", "http_failure", "business_rejected", "network_rejected", "network_timeout", "network_aborted", "response_unparsed"]);

function isExplicitlyUnavailableBossJobStatus(value) {
  return NORMALIZED_UNAVAILABLE_BOSS_JOB_STATUSES.has(normalizeCommunicationText(value));
}

function communicationJobId(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  try {
    const parsed = new URL(value);
    if (parsed.origin !== "https://www.zhipin.com" || parsed.username || parsed.password) return "";
    return (parsed.pathname.match(/^\/job_detail\/([^/?#]+)\.html$/i) || [])[1] || "";
  } catch {
    return "";
  }
}

function classifyBossCommunicationNetworkLog(log = {}) {
  const endpoints = (Array.isArray(log?.entries) ? log.entries : []).slice(0, 12).map((entry) => {
    const endpointKind = communicationEndpointKind(entry?.url);
    if (!endpointKind) return null;
    const httpStatus = Number(entry?.status);
    const businessCode = safeBossBusinessCode(parseBossResponseCode(entry?.content));
    const businessCategory = entry?.failed
      ? "network_rejected"
      : !Number.isInteger(httpStatus) || httpStatus < 200 || httpStatus >= 300
        ? "http_failure"
        : businessCode === "0"
          ? "success"
          : businessCode
            ? "business_rejected"
            : "response_unparsed";
    return {
      endpointKind,
      ...(Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {}),
      ...(businessCode ? { businessCode } : {}),
      businessCategory,
      elapsedMs: boundedCommunicationElapsedMs(entry?.startedAt, entry?.completedAt)
    };
  }).filter(Boolean);
  if (!endpoints.length) return { state: "no_matching_request", evidence: { endpoints: [] } };
  const transportFailed = endpoints.some((entry) => entry.businessCategory === "network_rejected");
  const platformRejected = endpoints.some((entry) => ["http_failure", "business_rejected"].includes(entry.businessCategory));
  const accepted = endpoints.some((entry) => entry.endpointKind === "friend_add" && entry.businessCategory === "success");
  const unparsed = endpoints.some((entry) => entry.businessCategory === "response_unparsed");
  if ([transportFailed, platformRejected, accepted].filter(Boolean).length > 1 || unparsed) {
    return { state: "ambiguous", evidence: { endpoints } };
  }
  if (transportFailed) return { state: "transport_failed", evidence: { endpoints } };
  if (platformRejected) return { state: "platform_rejected", evidence: { endpoints } };
  if (accepted) return { state: "accepted", evidence: { endpoints } };
  return { state: "ambiguous", evidence: { endpoints } };
}

function communicationEndpointKind(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.origin !== "https://www.zhipin.com") return "";
    if (url.pathname === "/wapi/zpchat/config/get") return "chat_config";
    if (url.pathname === "/wapi/zpgeek/friend/add.json") return "friend_add";
  } catch {}
  return "";
}

function parseBossResponseCode(content) {
  try {
    return JSON.parse(String(content || "")).code;
  } catch {
    return "";
  }
}

function safeBossBusinessCode(value) {
  const code = String(value === undefined || value === null ? "" : value).trim();
  return /^[A-Za-z0-9_-]{1,32}$/.test(code) ? code : "";
}

function boundedCommunicationElapsedMs(startedAt, completedAt) {
  const started = Date.parse(String(startedAt || ""));
  const completed = Date.parse(String(completedAt || ""));
  if (!Number.isFinite(started) || !Number.isFinite(completed)) return 0;
  return Math.max(0, Math.min(60_000, completed - started));
}

function communicationOutcomeEvidence(value = {}, pageState = "") {
  const source = value?.evidence || value || {};
  const endpoints = Array.isArray(source.endpoints) ? source.endpoints.slice(0, 12) : [];
  const sanitizedEndpoints = endpoints.map((endpoint) => {
    const endpointKind = String(endpoint?.endpointKind || "").trim();
    if (!["chat_config", "friend_add"].includes(endpointKind)) return null;
    const httpStatus = Number(endpoint?.httpStatus);
    const businessCode = String(endpoint?.businessCode || "").trim();
    const businessCategory = String(endpoint?.businessCategory || "").trim();
    const elapsedMs = Number(endpoint?.elapsedMs);
    return {
      endpointKind,
      ...(Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {}),
      ...(/^[A-Za-z0-9_-]{1,32}$/.test(businessCode) ? { businessCode } : {}),
      ...(COMMUNICATION_OUTCOME_CATEGORIES.has(businessCategory) ? { businessCategory } : {}),
      ...(Number.isFinite(elapsedMs) && elapsedMs >= 0 ? { elapsedMs: Math.min(60_000, Math.floor(elapsedMs)) } : {})
    };
  }).filter(Boolean);
  const observedPageState = String(pageState || source.pageState || "").trim();
  return {
    endpoints: sanitizedEndpoints,
    ...(COMMUNICATION_OUTCOME_PAGE_STATES.has(observedPageState) ? { pageState: observedPageState } : {})
  };
}

function normalizeTrustedBossCommunicationUrl(url) {
  const jobId = communicationJobId(url);
  if (!jobId) return "";
  try {
    const parsed = new URL(String(url));
    const securityId = parsed.searchParams.get("securityId");
    const canonical = `https://www.zhipin.com/job_detail/${jobId}.html`;
    return securityId ? `${canonical}?securityId=${encodeURIComponent(securityId)}` : canonical;
  } catch {
    return "";
  }
}

function sameBossCommunicationJob(snapshot, expectedJob) {
  const expectedJobId = communicationJobId(expectedJob?.url);
  const snapshotUrlJobId = communicationJobId(snapshot?.url);
  const snapshotJobId = String(snapshot?.jobId || "").trim();
  return Boolean(expectedJobId && snapshotUrlJobId && snapshotJobId)
    && expectedJobId === snapshotUrlJobId
    && snapshotUrlJobId === snapshotJobId;
}

function sameBossCommunicationTitle(snapshot, expectedJob) {
  const snapshotTitle = normalizeCommunicationText(snapshot?.title);
  const expectedTitle = normalizeCommunicationText(expectedJob?.title);
  return Boolean(snapshotTitle && expectedTitle) && snapshotTitle === expectedTitle;
}

function sameBossCommunicationCompany(snapshot, expectedJob) {
  const snapshotCompany = normalizeCommunicationText(snapshot?.company);
  const expectedCompany = normalizeCommunicationText(expectedJob?.company);
  if (!snapshotCompany || !expectedCompany) return false;
  if (snapshotCompany === expectedCompany) return true;
  return snapshotCompany.length >= 4
    && expectedCompany.length >= 4
    && (snapshotCompany.includes(expectedCompany) || expectedCompany.includes(snapshotCompany));
}

function communicationJobFromInspection(inspection = {}) {
  const jobId = String(inspection.jobId || "").trim();
  const title = String(inspection.title || "").trim();
  const company = String(inspection.company || "").trim();
  const point = inspection.clickPoint || {};
  const url = normalizeTrustedBossCommunicationUrl(`https://www.zhipin.com/job_detail/${jobId}.html`);
  if (inspection.state !== "ready"
    || inspection.actionLabel !== "\u7acb\u5373\u6c9f\u901a"
    || !url
    || !/^[A-Za-z0-9_-]+$/.test(jobId)
    || !title
    || !company
    || ![point.x, point.y].every((value) => Number.isFinite(Number(value)))) {
    return null;
  }
  return { jobId, url, title, company };
}

function guardedBossCommunicationClickExpression(expectedJob) {
  const expected = JSON.stringify({
    jobId: expectedJob.jobId,
    title: expectedJob.title,
    company: expectedJob.company
  });
  return `(() => {
    const operation = "__bossGuardedCommunicationClick";
    const expected = ${expected};
    const normalize = (value) => String(value || "").toLowerCase().replace(/[\\s\u00b7._()\uFF08\uFF09\\-_/]/g, "");
    const fail = (reason) => ({ clicked: false, reason, operation });
    if (typeof window.__bossCommunicationSnapshot !== "function") return fail("snapshot_helper_missing");
    const snapshot = window.__bossCommunicationSnapshot();
    if (snapshot.risk) return fail("risk_control");
    if (snapshot.login) return fail("login_required");
    const pathJobId = (location.pathname.match(/^\\/job_detail\\/([^/?#]+)\\.html$/i) || [])[1] || "";
    const snapshotCompany = normalize(snapshot.company);
    const expectedCompany = normalize(expected.company);
    const sameCompany = snapshotCompany === expectedCompany
      || (snapshotCompany.length >= 4 && expectedCompany.length >= 4
        && (snapshotCompany.includes(expectedCompany) || expectedCompany.includes(snapshotCompany)));
    const actions = Array.isArray(snapshot.actions) ? snapshot.actions : [];
    const action = actions.length === 1 ? actions[0] : null;
    const jobStatus = String(snapshot.jobStatus || "").trim();
    const unavailableStatuses = new Set(${JSON.stringify(EXPLICITLY_UNAVAILABLE_BOSS_JOB_STATUSES)}.map(normalize));
    const snapshotReady = snapshot.pageReady === true
      && snapshot.documentReadyState === "complete"
      && snapshot.jobId === expected.jobId
      && pathJobId === expected.jobId
      && normalize(snapshot.title) === normalize(expected.title)
      && sameCompany
      && jobStatus
      && !unavailableStatuses.has(normalize(jobStatus))
      && action
      && action.label === "\u7acb\u5373\u6c9f\u901a"
      && action.isFriend === "false"
      && action.redirectJobId === expected.jobId
      && action.hasChatIdentity === true
      && Number(action.width) > 0
      && Number(action.height) > 0;
    if (!snapshotReady) return fail("snapshot_changed");
    const header = document.querySelector(".job-primary.detail-box")
      || document.querySelector(".job-primary")
      || document.querySelector(".job-banner");
    const actionRoot = header?.querySelector(".job-op") || header;
    const candidates = Array.from(actionRoot?.querySelectorAll("a, button, [role='button']") || []).filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (rect.width <= 0 || rect.height <= 0
        || style.display === "none"
        || style.visibility === "hidden"
        || style.opacity === "0"
        || style.pointerEvents === "none"
        || element.disabled
        || element.matches(":disabled")
        || element.classList.contains("disabled")
        || element.getAttribute("aria-disabled") === "true"
        || String(element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim() !== "\u7acb\u5373\u6c9f\u901a"
        || element.getAttribute("data-isfriend") !== "false") return false;
      try {
        const redirect = new URL(element.getAttribute("redirect-url") || "", location.origin);
        return redirect.origin === location.origin
          && redirect.pathname === "/web/geek/chat"
          && redirect.searchParams.get("jobId") === expected.jobId
          && Boolean(redirect.searchParams.get("id"));
      } catch {
        return false;
      }
    });
    if (candidates.length !== 1) return fail("action_not_unique");
    const element = candidates[0];
    const rect = element.getBoundingClientRect();
    const clickPoint = {
      x: Number(rect.left ?? rect.x) + Number(rect.width) / 2,
      y: Number(rect.top ?? rect.y) + Number(rect.height) / 2
    };
    const pointElement = document.elementFromPoint(clickPoint.x, clickPoint.y);
    if (pointElement !== element && !element.contains(pointElement)) return fail("point_target_changed");
    return { ready: true, jobId: expected.jobId, clickPoint, operation };
  })()`;
}

function hasSafeCommunicationAction(action = {}) {
  action = action || {};
  return action.visible !== false
    && action.disabled !== true
    && [action.x, action.y, action.width, action.height].every((value) => Number.isFinite(Number(value)))
    && Number(action.width) > 0
    && Number(action.height) > 0;
}

function classifyBossCommunicationSnapshot(snapshot = {}, expectedJob = {}) {
  if (snapshot?.risk) {
    throw bossError("BOSS_RISK_CONTROL", "BOSS requires security verification; communication inspection has stopped.");
  }
  if (snapshot?.login) {
    throw bossError("BOSS_LOGIN_REQUIRED", "BOSS login is no longer valid; communication inspection has stopped.");
  }
  if (snapshot?.documentReadyState && snapshot.documentReadyState !== "complete") {
    return { state: "loading" };
  }
  if (!snapshot?.pageReady) return { state: "action_unavailable" };
  if (!sameBossCommunicationJob(snapshot, expectedJob)
    || !sameBossCommunicationTitle(snapshot, expectedJob)
    || !sameBossCommunicationCompany(snapshot, expectedJob)) {
    return { state: "target_mismatch" };
  }
  const jobStatus = String(snapshot?.jobStatus || "").trim();
  if (!jobStatus) return { state: "action_unavailable" };
  if (isExplicitlyUnavailableBossJobStatus(jobStatus)) {
    return { state: "job_unavailable", statusLabel: jobStatus };
  }
  const actions = Array.isArray(snapshot?.actions) ? snapshot.actions : [];
  if (actions.length !== 1) return { state: "action_unavailable" };
  const action = actions[0] || {};
  if (!hasSafeCommunicationAction(action)) return { state: "action_unavailable" };
  const expectedJobId = communicationJobId(expectedJob?.url);
  const hasTrustedChatTarget = action.redirectJobId === expectedJobId && action.hasChatIdentity === true;
  if (action.label === "\u7ee7\u7eed\u6c9f\u901a") {
    return hasTrustedChatTarget && action.isFriend === "true"
      ? { state: "already_communicated" }
      : { state: "action_unavailable" };
  }
  if (action.label !== "\u7acb\u5373\u6c9f\u901a") return { state: "action_unavailable" };
  if (!hasTrustedChatTarget || action.isFriend !== "false") return { state: "action_unavailable" };
  return {
    state: "ready",
    jobId: String(snapshot.jobId),
    title: snapshot.title,
    company: snapshot.company,
    salary: snapshot.salary || "",
    bossActiveText: snapshot.bossActiveText || "",
    actionLabel: action.label,
    clickPoint: {
      x: Number(action.x) + Number(action.width) / 2,
      y: Number(action.y) + Number(action.height) / 2
    }
  };
}

function classifyBossCommunicationResultSnapshot(snapshot = {}, expectedJob = {}) {
  if (snapshot?.risk) {
    throw bossError("BOSS_RISK_CONTROL", "BOSS requires security verification; communication verification has stopped.");
  }
  if (snapshot?.login) {
    throw bossError("BOSS_LOGIN_REQUIRED", "BOSS login is no longer valid; communication verification has stopped.");
  }
  if (hasExplicitBossCommunicationDrift(snapshot, expectedJob)) return { state: "target_mismatch" };
  const jobStatus = String(snapshot?.jobStatus || "").trim();
  if (sameBossCommunicationJob(snapshot, expectedJob)
    && isExplicitlyUnavailableBossJobStatus(jobStatus)) {
    return { state: "job_unavailable", statusLabel: jobStatus };
  }
  if (snapshot?.documentReadyState && snapshot.documentReadyState !== "complete") {
    return { state: "ambiguous" };
  }
  if (!snapshot?.pageReady) return { state: "ambiguous" };
  if (!sameBossCommunicationJob(snapshot, expectedJob)
    || !sameBossCommunicationTitle(snapshot, expectedJob)
    || !sameBossCommunicationCompany(snapshot, expectedJob)) {
    return { state: "target_mismatch" };
  }
  if (!jobStatus) return { state: "ambiguous" };
  if (isExplicitlyUnavailableBossJobStatus(jobStatus)) {
    return { state: "job_unavailable", statusLabel: jobStatus };
  }
  const actions = Array.isArray(snapshot?.actions) ? snapshot.actions : [];
  const action = actions.length === 1 ? actions[0] : null;
  const dialog = snapshot?.successDialog || {};
  const expectedJobId = communicationJobId(expectedJob?.url);
  const hasTrustedContinuedCommunication = hasSafeCommunicationAction(action)
    && action.label === "\u7ee7\u7eed\u6c9f\u901a"
    && action.isFriend === "true"
    && action.redirectJobId === expectedJobId
    && action.hasChatIdentity === true;
  const hasLegacySuccessDialog = dialog.visible === true
    && dialog.title === "\u5df2\u5411BOSS\u53d1\u9001\u6d88\u606f"
    && dialog.footer === "\u7559\u5728\u6b64\u9875\u7ee7\u7eed\u6c9f\u901a";
  const succeeded = hasTrustedContinuedCommunication
    && (hasLegacySuccessDialog || snapshot?.inlineChatSent === true);
  return succeeded ? { state: "succeeded", jobId: expectedJobId } : { state: "ambiguous" };
}

function hasExplicitBossCommunicationDrift(snapshot = {}, expectedJob = {}) {
  const expectedJobId = communicationJobId(expectedJob?.url);
  const snapshotUrlJobId = communicationJobId(snapshot?.url);
  const snapshotJobId = String(snapshot?.jobId || "").trim();
  const expectedTitle = normalizeCommunicationText(expectedJob?.title);
  const snapshotTitle = normalizeCommunicationText(snapshot?.title);
  const expectedCompany = normalizeCommunicationText(expectedJob?.company);
  const snapshotCompany = normalizeCommunicationText(snapshot?.company);
  return Boolean(
    (expectedJobId && snapshotUrlJobId && expectedJobId !== snapshotUrlJobId)
    || (expectedJobId && snapshotJobId && expectedJobId !== snapshotJobId)
    || (expectedTitle && snapshotTitle && expectedTitle !== snapshotTitle)
    || (expectedCompany && snapshotCompany && !sameBossCommunicationCompany(snapshot, expectedJob))
  );
}

function isBossSearchTab(tab) {
  return /^https:\/\/www\.zhipin\.com\/web\/geek\/jobs(?:[/?#]|$)/i.test(String(tab?.url || ""));
}

function normalizeCommunicationTabBinding(value = {}) {
  for (const field of ["windowId", "bindingGeneration"]) {
    if (!Number.isInteger(value[field]) || value[field] <= 0) {
      throw bossError("BOSS_COMMUNICATION_BINDING_REQUIRED", `${field} must be a positive integer.`);
    }
  }
  if (!["edge", "portable"].includes(value.mode)
    || !isBrowserTabId(value.searchTabId)
    || !isBrowserTabId(value.messageTabId)
    || sameBrowserTabId(value.searchTabId, value.messageTabId)
    || !Number.isInteger(value.searchScrollTop)
    || value.searchScrollTop < 0) {
    throw bossError("BOSS_COMMUNICATION_BINDING_REQUIRED", "A complete fixed-tab binding is required.");
  }
  let returnUrl;
  try {
    returnUrl = new URL(value.searchReturnUrl);
  } catch {
    throw bossError("BOSS_COMMUNICATION_BINDING_REQUIRED", "A trusted BOSS search return URL is required.");
  }
  if (returnUrl.origin !== "https://www.zhipin.com"
    || returnUrl.pathname !== "/web/geek/jobs"
    || returnUrl.username
    || returnUrl.password
    || returnUrl.hash) {
    throw bossError("BOSS_COMMUNICATION_BINDING_REQUIRED", "A trusted BOSS search return URL is required.");
  }
  return Object.freeze({
    mode: value.mode,
    windowId: value.windowId,
    searchTabId: value.searchTabId,
    messageTabId: value.messageTabId,
    searchReturnUrl: returnUrl.toString(),
    searchScrollTop: value.searchScrollTop,
    bindingGeneration: value.bindingGeneration
  });
}

function bossTabPath(tab) {
  try {
    const url = new URL(String(tab?.url || ""));
    return url.origin === "https://www.zhipin.com" ? url.pathname : "";
  } catch {
    return "";
  }
}

function isReusableBossCommunicationTab(tab) {
  const url = String(tab?.url || "");
  return /^https:\/\/www\.zhipin\.com\/job_detail\/[^/?#]+\.html(?:[?#]|$)/i.test(url)
    || /^https:\/\/www\.zhipin\.com\/web\/geek\/chat(?:[/?#]|$)/i.test(url);
}

function isCachedBossCommunicationTab(tab) {
  return /^about:blank$/i.test(String(tab?.url || "")) || isReusableBossCommunicationTab(tab);
}

function sameBossWindow(first, second) {
  if (!hasKnownBossWindow(first) || !hasKnownBossWindow(second)) return false;
  return String(first.windowId) === String(second.windowId);
}

function hasKnownBossWindow(tab) {
  return String(tab?.windowId ?? "").trim().length > 0;
}

module.exports = {
  PAGE_HELPERS,
  BossSiteAdapter,
  classifyBossCommunicationSnapshot,
  classifyBossCommunicationNetworkLog,
  normalizeBossJob,
  parseBossActivityText,
  normalizeBossUrl,
  normalizeBossNavigationUrl,
  bossSourceId,
  cleanDetailText,
  weightedCardLimit,
  mergeScanCandidate,
  buildBossScanTargets,
  buildBossSearchUrl,
  normalizeBossSearchTemplate,
  resolveBossSearchContext,
  normalizeNativeFilters,
  normalizeNativeFilterLanes,
  normalizePageBudget,
  randomBetween,
  parseBossFilterCatalog,
  BOSS_FILTER_FIELDS
};
