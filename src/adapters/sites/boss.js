const fs = require("fs");

const DEFAULT_CITY_CODE = "101280100";
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

  window.__bossActivity = function(value) {
    const text = window.__bossDecode(value || "");
    const readable = text.match(/刚刚活跃|今日活跃|今天活跃|昨日活跃|昨天活跃|近半年活跃|近(?:\d+|一|二|三|四|五|六|七|八|九|十)个?月活跃|\d+日内活跃|本周活跃|本月活跃/);
    if (readable) return readable[0].replace(/\s+/g, "");
    const online = text.match(/(?:^|\s)(?:[\u4e00-\u9fa5]{1,8}(?:先生|女士)|HR|hr)\s+(在线)(?=\s|$)/);
    return online ? online[1] : "";
  };

  window.__bossCards = function() {
    const selectors = [
      ".rec-job-list .job-card-box",
      ".job-card-box",
      ".job-card-wrapper",
      "li.job-card-wrapper",
      ".job-list-box li",
      ".search-job-result li",
      "li[class*='job']",
      "div[class*='job-card']",
      "a[href*='job_detail']"
    ];
    let cards = [];
    const looksLikeJob = (el) => {
      const text = window.__bossDecode(el.innerText || "");
      return text && /(K|面议|经验|本科|大专|硕士|博士|学历|广州|[\ue031-\ue03a])/.test(text);
    };
    for (const selector of selectors) {
      const found = Array.from(document.querySelectorAll(selector))
        .filter((el) => el && el.innerText && /(K|面议|[\ue031-\ue03a])/.test(el.innerText));
      if (found.length > cards.length) cards = found;
    }
    if (!cards.length) {
      cards = Array.from(document.querySelectorAll("li, a[href*='job_detail'], div[class*='job']"))
        .map((el) => el.closest("li, .job-card-box, .job-card-wrapper, [class*='job-card'], [class*='job']") || el)
        .filter((el) => el && el.innerText && looksLikeJob(el));
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
      const salary = window.__bossDecode((q(".salary") || q(".red") || {}).innerText || (flat.match(salaryRe) || [""])[0]);
      const companyNode = q(".company-name");
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
      return {
        index,
        title,
        company,
        salary,
        location: lines.find((line) => cityRe.test(line)) || "",
        tags: lines.filter((line) => expRe.test(line)).slice(0, 8),
        url: href,
        cardText: flat.slice(0, 500),
        bossActiveText: parseActivity(flat)
      };
    });

    function parseActivity(text) {
      return window.__bossActivity(text);
    }
  };
  return true;
})()
`;

class BossSiteAdapter {
  constructor({ browser = null, logger = null, sleepFn = sleep } = {}) {
    this.browser = browser;
    this.logger = logger;
    this.sleep = sleepFn;
  }

  async scan(options = {}) {
    const { input } = options;
    if (!input) {
      return this.scanBrowser(options);
    }
    const jobs = JSON.parse(fs.readFileSync(input, "utf8"));
    return jobs.map(normalizeBossJob);
  }

  async scanBrowser(options) {
    if (!this.browser) throw new Error("真实扫描需要 --browser edge。");
    const keywords = options.keywords?.length ? options.keywords : ["AI应用开发"];
    const keywordPlan = normalizeKeywordPlan(keywords, options.keywordPlan);
    const cityScopes = normalizeCityScopes(options);
    const scanTargets = cityScopes.flatMap((city, cityOrder) => keywordPlan.map((item) => ({ ...item, cityOrder, city: city.city })));
    const tabId = await this.browser.activeTabId();
    const maxCards = Number(options.maxCards || 60);
    const detailLimit = Number(options.detailLimit ?? 5);
    const maxDetailTotal = Number(options.maxDetailTotal || 150);
    const candidates = new Map();

    for (const [cityOrder, city] of cityScopes.entries()) {
      for (const item of keywordPlan) {
        const keyword = item.word;
        const cardLimit = weightedCardLimit(item.priority, maxCards);
        const url = `https://www.zhipin.com/web/geek/jobs?query=${encodeURIComponent(keyword)}&city=${city.cityCode}`;
        console.error(`[boss] 打开城市：${city.city || city.cityCode} · ${keyword}（${item.priority}，最多 ${cardLimit} 条）`);
        this.logger?.info("boss_keyword_opened", { keyword, priority: item.priority, city: city.city || "", cityCode: city.cityCode, cardLimit });
        await this.browser.navigate(tabId, url);
        await this.sleep(2200);
        const cards = await this.collectCards(tabId, cardLimit);
        console.error(`[boss] ${city.city || city.cityCode} · ${keyword} 列表岗位：${cards.length}`);
        this.logger?.info("boss_cards_collected", { keyword, city: city.city || "", cardCount: cards.length });
        const keywordJobs = cards.map((card) => normalizeBossJob({ ...card, keyword, source: "boss", searchCity: city.city || "" }));
        for (const [index, job] of keywordJobs.entries()) {
          mergeScanCandidate(candidates, {
            job,
            keyword,
            priority: item.priority,
            keywordOrder: item.order,
            cityOrder,
            index,
            quickScore: options.scoreQuick ? options.scoreQuick(job) : 0
          });
        }
      }
    }

    const detailCandidates = selectDetailCandidates([...candidates.values()], scanTargets, { detailLimit, maxDetailTotal });
    this.logger?.info("boss_detail_plan", {
      uniqueCandidates: candidates.size,
      selectedDetails: detailCandidates.length,
      detailLimit,
      maxDetailTotal,
      quotas: detailQuotas(scanTargets, detailLimit)
    });
    for (const item of detailCandidates) {
      console.error(`[boss] 读详情：${item.keyword}（${item.priority}） ${item.job.title}`);
      try {
        const detail = await this.readDetail(tabId, item.job.url);
        item.job.description = detail.description;
        item.job.detailRead = true;
        // 详情页的 HR 状态比列表卡片可靠，避免 JD 中的“在线客服”被误认成 HR 在线。
        item.job.bossActiveText = detail.bossActiveText || item.job.bossActiveText || parseBossActivityText(item.job.description);
      } catch (error) {
        this.logger?.warn("boss_detail_read_failed", { keyword: item.keyword, jobId: item.job.sourceId || item.job.url || "", errorCode: error?.code || "BOSS_DETAIL_READ_FAILED", errorMessage: error?.message || String(error) });
        item.job.detailRead = false;
        item.job.description = `${item.job.description || ""}\n详情读取失败：${error.message}`;
      }
    }
    return [...candidates.values()].map((item) => ({ ...item.job, detailRequired: true }));
  }

  async collectCards(tabId, maxCards) {
    const found = new Map();
    let lastSize = 0;
    let stale = 0;
    for (let round = 0; round < 14 && found.size < maxCards && stale < 3; round += 1) {
      await this.browser.evalValue(tabId, PAGE_HELPERS);
      const cards = await this.browser.evalValue(tabId, `(() => window.__bossExtractCards(${maxCards}))()`);
      for (const card of cards || []) {
        const key = bossSourceId(card) || `${card.company}|${card.title}|${card.salary}|${card.cardText}`;
        if (!found.has(key)) found.set(key, card);
      }
      stale = found.size === lastSize ? stale + 1 : 0;
      lastSize = found.size;
      if (found.size >= maxCards) break;
      await this.scrollList(tabId);
      await this.sleep(1000);
    }
    return [...found.values()].slice(0, maxCards);
  }

  async scrollList(tabId) {
    await this.browser.evalValue(tabId, `(() => {
      const list = document.querySelector(".job-list-container")
        || document.querySelector(".rec-job-list")
        || document.querySelector(".search-job-result")
        || document.querySelector(".job-list-box")
        || document.querySelector("[class*='job-list']")
        || document.body;
      list.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      list.dispatchEvent(new WheelEvent("wheel", { deltaY: 1800, bubbles: true, cancelable: true }));
      if (list !== document.body) {
        list.scrollTop = list.scrollTop + 1800;
        list.dispatchEvent(new Event("scroll", { bubbles: true }));
      } else {
        window.scrollBy(0, 1800);
        window.dispatchEvent(new Event("scroll"));
      }
      return true;
    })()`);
  }

  async readDetail(tabId, url) {
    await this.browser.navigate(tabId, url);
    await this.sleep(1800);
    for (let i = 0; i < 8; i += 1) {
      await this.browser.evalValue(tabId, PAGE_HELPERS);
      const detail = await this.browser.evalValue(tabId, `(() => {
        const decode = window.__bossDecode || ((x) => String(x || ""));
        const root = document.querySelector(".job-detail-container")
          || document.querySelector(".job-detail")
          || document.querySelector(".detail-content")
          || document.querySelector(".job-detail-box");
        if (!root) return { description: "", bossActiveText: "" };
        const description = root.querySelector(".job-sec-text")
          || root.querySelector(".job-detail-section .text")
          || root.querySelector("[class*='job-sec-text']")
          || root;
        const detailText = decode(description.innerText || "").replace(/\\s+/g, " ").slice(0, 3000);
        const activityText = decode(root.innerText || "");
        const bossActiveText = (window.__bossActivity || (() => ""))(activityText);
        return { description: detailText, bossActiveText };
      })()`);
      if (detail?.description && detail.description.length > 120) {
        return {
          description: cleanDetailText(detail.description),
          bossActiveText: parseBossActivityText(detail.bossActiveText)
        };
      }
      await this.sleep(600);
    }
    return { description: "", bossActiveText: "" };
  }
}

function normalizeBossJob(job) {
  const description = cleanDetailText(job.description || job.detail || job.cardText || "");
  const url = normalizeBossUrl(job.url || "");
  return {
    source: job.source || "boss",
    sourceId: job.sourceId || bossSourceId({ ...job, url }),
    keyword: job.keyword || "",
    title: job.title || job.name || "",
    company: job.company || "",
    location: job.location || "",
    salary: job.salary || "",
    experience: job.experience || "",
    education: job.education || "",
    bossActiveText: job.bossActiveText || job.active || parseBossActivityText(description),
    url,
    tags: job.tags || [],
    description,
    detailRead: Boolean(job.detailRead)
  };
}

function parseBossActivityText(text) {
  const readable = String(text || "").match(/刚刚活跃|今日活跃|今天活跃|昨日活跃|昨天活跃|近半年活跃|近(?:\d+|一|二|三|四|五|六|七|八|九|十)个?月活跃|\d+\s*日内活跃|本周活跃|本月活跃/);
  if (readable) return readable[0].replace(/\s+/g, "");
  const online = String(text || "").match(/(?:^|\s)(?:[\u4e00-\u9fa5]{1,8}(?:先生|女士)|HR|hr)\s+(在线)(?=\s|$)/);
  return online ? online[1] : "";
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

function normalizePriority(value) {
  return ["A", "B", "C"].includes(value) ? value : "B";
}

function priorityRank(priority) {
  return { A: 0, B: 1, C: 2 }[normalizePriority(priority)] ?? 9;
}

function weightedCardLimit(priority, baseLimit) {
  const base = Math.max(10, Number(baseLimit) || 60);
  const ratio = { A: 1, B: 0.65, C: 0.4 }[normalizePriority(priority)];
  return Math.max(10, Math.ceil(base * ratio));
}

function detailQuotas(keywordPlan, detailLimit) {
  const perKeyword = Math.max(1, Number(detailLimit) || 5);
  const counts = { A: 0, B: 0, C: 0 };
  for (const item of keywordPlan) counts[normalizePriority(item.priority)] += 1;
  return {
    A: counts.A * perKeyword,
    B: counts.B * Math.max(1, Math.ceil(perKeyword * 0.55)),
    C: counts.C * Math.max(1, Math.ceil(perKeyword * 0.25))
  };
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
  const incomingBetter = priorityRank(candidate.priority) < priorityRank(existing.priority)
    || (priorityRank(candidate.priority) === priorityRank(existing.priority) && candidate.quickScore > existing.quickScore);
  if (incomingBetter) {
    target.set(key, { ...candidate, keywords: existing.keywords });
  }
}

function selectDetailCandidates(candidates, keywordPlan, { detailLimit, maxDetailTotal } = {}) {
  const quotas = detailQuotas(keywordPlan, detailLimit);
  const selectedByPriority = { A: 0, B: 0, C: 0 };
  const total = Math.max(1, Number(maxDetailTotal) || 150);
  return [...candidates]
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || b.quickScore - a.quickScore || a.cityOrder - b.cityOrder || a.keywordOrder - b.keywordOrder || a.index - b.index)
    .filter((candidate) => {
      const priority = normalizePriority(candidate.priority);
      if (selectedByPriority[priority] >= quotas[priority]) return false;
      if (Object.values(selectedByPriority).reduce((sum, value) => sum + value, 0) >= total) return false;
      selectedByPriority[priority] += 1;
      return true;
    });
}

function dedupeJobs(jobs) {
  const byKey = new Map();
  for (const job of jobs) {
    const key = bossSourceId(job);
    const old = byKey.get(key);
    if (!old || (job.detailRead && !old.detailRead) || (job.description || "").length > (old.description || "").length) {
      byKey.set(key, { ...job, sourceId: key, url: normalizeBossUrl(job.url) });
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

function bossSourceId(job) {
  const url = normalizeBossUrl(job.url || "");
  const id = url.match(/\/job_detail\/([^/?#]+)\.html/i);
  if (id) return `boss:${id[1]}`;
  return `boss:${[job.company, job.title, job.location, job.salary].map((x) => String(x || "").trim()).join("|").toLowerCase()}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  BossSiteAdapter,
  normalizeBossJob,
  parseBossActivityText,
  normalizeBossUrl,
  bossSourceId,
  cleanDetailText,
  weightedCardLimit,
  detailQuotas,
  mergeScanCandidate,
  selectDetailCandidates
};
