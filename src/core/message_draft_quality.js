"use strict";

const OPENING_LENGTH = 18;
const MIN_OPENING_LENGTH = 8;
const MIN_TRIGRAM_TEXT_LENGTH = 16;
const TRIGRAM_SIMILARITY_THRESHOLD = 0.72;

const CLAIM_PATTERNS = Object.freeze({
  phone: /(?<!\d)1[3-9]\d{9}(?!\d)/g,
  email: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
  url: /https?:\/\/[^\s，。；]+/gi,
  salary: /(?:期望|薪资|月薪|年薪)[^，。；\n]{0,12}(?:\d+(?:\.\d+)?\s*[KkWw万千]?)/g,
  percentage: /[^，。；\n]{0,12}\d+(?:\.\d+)?%[^，。；\n]{0,12}/g,
  duration: /[^，。；\n]{0,12}\d+(?:\.\d+)?\s*(?:年|个月|月|天)[^，。；\n]{0,12}/g,
  numeric_achievement: /[^，。；\n]{0,12}\d+(?:\.\d+)?\s*(?:个|人|位|名|家|次|万|千|项|篇|条|单|场)[^，。；\n]{0,12}/g,
  arrival: /(?:本周|下周|这周|今天|明天|后天|周[一二三四五六日天]|随时|立即|一周内|两周后|两周内|一个月内|\d+天后|\d+周后)[^，。；\n]{0,8}(?:到岗|入职)/g,
  interview_availability: /(?:本周|下周|今天|明天|后天|周[一二三四五六日天])[^，。；\n]{0,10}(?:可以|可|方便|有空)?[^，。；\n]{0,4}(?:面试|沟通)/g,
  overtime: /(?:不接受|不考虑|不能|无法|拒绝|可以接受|可以|接受|愿意)[^，。；\n]{0,4}(?:加班|大小周|单休)/g,
  travel: /(?:不接受|不考虑|不能|无法|拒绝|可以接受|可以|接受|愿意)[^，。；\n]{0,8}(?:出差)/g,
  relocation: /(?:不接受|不考虑|不能|无法|拒绝|可以接受|可以|接受|愿意)[^，。；\n]{0,8}(?:异地|搬迁|调动)/g
});

function normalizedMessageText(text) {
  return String(text || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

function extractHighRiskClaims(text) {
  const source = String(text || "").slice(0, 10000);
  const claims = [];
  const seen = new Set();
  for (const [kind, pattern] of Object.entries(CLAIM_PATTERNS)) {
    for (const match of source.matchAll(pattern)) {
      const value = String(match[0] || "").trim().slice(0, 160);
      const key = `${kind}:${claimSignature({ kind, value })}`;
      if (!value || seen.has(key)) continue;
      seen.add(key);
      claims.push({ kind, value });
    }
  }
  return claims;
}

function assessMessageDraftQuality({ text, recentTexts = [], evidenceTexts = [] } = {}) {
  const normalized = normalizedMessageText(text);
  const similarity = similarRecentText(normalized, recentTexts);
  const warnings = similarity.similar
    ? [{ code: "MESSAGE_DRAFT_RECENTLY_SIMILAR", matchedOpening: similarity.matchedOpening }]
    : [];
  const evidenceClaims = (Array.isArray(evidenceTexts) ? evidenceTexts : [])
    .flatMap((value) => extractHighRiskClaims(value));
  const evidenceKeys = new Set(evidenceClaims.map((claim) => `${claim.kind}:${claimSignature(claim)}`));
  const errors = extractHighRiskClaims(text)
    .filter((claim) => !evidenceKeys.has(`${claim.kind}:${claimSignature(claim)}`))
    .map((claim) => ({ code: "MESSAGE_DRAFT_FACT_UNSUPPORTED", ...claim }));
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    matchedOpening: similarity.matchedOpening
  };
}

function similarRecentText(normalized, recentTexts) {
  if (!normalized) return { similar: false, matchedOpening: "" };
  let matchedOpening = "";
  for (const recent of Array.isArray(recentTexts) ? recentTexts.slice(0, 20) : []) {
    const candidate = normalizedMessageText(recent);
    if (!candidate) continue;
    const opening = commonOpening(normalized, candidate);
    if (opening.length > matchedOpening.length) matchedOpening = opening;
    if (opening.length >= MIN_OPENING_LENGTH) return { similar: true, matchedOpening: opening };
    if (normalized.length >= MIN_TRIGRAM_TEXT_LENGTH && candidate.length >= MIN_TRIGRAM_TEXT_LENGTH
      && (trigramJaccard(normalized, candidate) >= TRIGRAM_SIMILARITY_THRESHOLD
        || (opening.length >= 6 && trigramDice(normalized, candidate) >= TRIGRAM_SIMILARITY_THRESHOLD))) {
      return { similar: true, matchedOpening };
    }
  }
  return { similar: false, matchedOpening: "" };
}

function commonOpening(left, right) {
  const limit = Math.min(OPENING_LENGTH, left.length, right.length);
  let length = 0;
  while (length < limit && left[length] === right[length]) length += 1;
  return left.slice(0, length);
}

function trigramJaccard(left, right) {
  const leftSet = trigrams(left);
  const rightSet = trigrams(right);
  let intersection = 0;
  for (const value of leftSet) if (rightSet.has(value)) intersection += 1;
  const union = leftSet.size + rightSet.size - intersection;
  return union ? intersection / union : 0;
}

function trigramDice(left, right) {
  const leftSet = trigrams(left);
  const rightSet = trigrams(right);
  let intersection = 0;
  for (const value of leftSet) if (rightSet.has(value)) intersection += 1;
  return leftSet.size + rightSet.size ? (2 * intersection) / (leftSet.size + rightSet.size) : 0;
}

function trigrams(text) {
  const values = new Set();
  for (let index = 0; index <= text.length - 3; index += 1) values.add(text.slice(index, index + 3));
  return values;
}

function claimSignature({ kind, value }) {
  const normalized = normalizedMessageText(value);
  if (["phone", "email", "url"].includes(kind)) return normalized;
  if (kind === "salary") return numericToken(value);
  if (["percentage", "duration", "numeric_achievement"].includes(kind)) {
    return `${numericToken(value)}:${semanticToken(kind, value)}`;
  }
  if (["arrival", "interview_availability"].includes(kind)) return scheduleToken(value);
  if (["overtime", "travel", "relocation"].includes(kind)) {
    const polarity = /不接受|不考虑|不能|无法|拒绝/.test(value) ? "negative" : "positive";
    const qualifier = kind === "travel" ? (/长期/.test(value) ? "long" : /短期/.test(value) ? "short" : "") : "";
    return `${polarity}:${qualifier}`;
  }
  return normalized;
}

function scheduleToken(value) {
  const match = String(value || "").match(
    /本周[一二三四五六日天]?|下周[一二三四五六日天]?|这周[一二三四五六日天]?|今天|明天|后天|周[一二三四五六日天]|随时|立即|一周内|两周后|两周内|一个月内|\d+天后|\d+周后/
  );
  return normalizedMessageText(match?.[0] || value);
}

function numericToken(value) {
  const tokens = String(value || "").normalize("NFKC").toLowerCase()
    .match(/\d+(?:\.\d+)?\s*(?:k|w|万|千|%|年|个月|月|天|个|人|位|名|家|次|项|篇|条|单|场)?/g);
  return (tokens || []).map((token) => token.replace(/\s+/g, "")
    .replace(/(?:个|人|位|名|家|次|项|篇|条|单|场)$/, "count")).join("|");
}

function semanticToken(kind, value) {
  const text = normalizedMessageText(value);
  const groups = kind === "duration"
    ? [
        ["software", /软件|开发|研发|编程|代码|程序|前端|后端|全栈|测试/],
        ["sales", /销售|售前|商务|成交|签单|拓客/],
        ["operations", /运营|内容|社群|投放|活动/],
        ["product", /产品|需求|用户研究/],
        ["design", /设计|视觉|交互/],
        ["management", /管理|带队|负责人/]
      ]
    : [
        ["request", /请求|调用|工单/],
        ["project", /项目|课题/],
        ["customer", /客户/],
        ["user", /用户/],
        ["company", /公司|企业|商家|门店|店铺/],
        ["content", /文章|内容|视频|帖子/],
        ["order", /订单|合同/],
        ["conversion", /转化/],
        ["retention", /留存/],
        ["revenue", /营收|收入|销售额/],
        ["efficiency", /效率|耗时|时长|延迟/],
        ["quality", /准确率|正确率|质量/],
        ["cost", /成本|费用/]
      ];
  const matched = groups.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  if (matched.length) return matched.join("+");
  const lexical = text
    .replace(/\d+(?:\.\d+)?/g, "")
    .replace(/累计|具备|拥有|相关|经验|以上|以内|左右|提升|增长|降低|减少|服务|处理|覆盖|完成|负责/g, "")
    .replace(/个月|年|月|天|个|人|家|次|万|千|项|篇|条|%/g, "");
  return lexical || "general";
}

module.exports = {
  OPENING_LENGTH,
  MIN_OPENING_LENGTH,
  MIN_TRIGRAM_TEXT_LENGTH,
  TRIGRAM_SIMILARITY_THRESHOLD,
  CLAIM_PATTERNS,
  normalizedMessageText,
  extractHighRiskClaims,
  assessMessageDraftQuality
};
