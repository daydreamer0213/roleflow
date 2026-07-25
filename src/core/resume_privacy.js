const path = require("node:path");

function privacyError(message) {
  const error = new Error(message);
  error.code = "RESUME_PRIVACY_REDACTION_FAILED";
  return error;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeIdentity(value) {
  if (value == null) return { names: [], phones: [], emails: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw privacyError("身份清单格式无效。");
  }
  const clean = (items) => [...new Set((Array.isArray(items) ? items : []).map((item) => String(item || "").trim()).filter(Boolean))];
  return { names: clean(value.names), phones: clean(value.phones), emails: clean(value.emails) };
}

function inferCandidateNames(text, originalFileName) {
  const names = [];
  const labeled = String(text).match(/(?:^|\n)\s*(?:姓名|Name)\s*[：:]\s*([^\n|]{2,20})/i)?.[1]?.trim();
  if (labeled) names.push(labeled);
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (/^[\p{Script=Han}]{2,6}$/u.test(lines[0] || "")
    && /年龄|男|女|1[3-9]\d{9}|@/.test(lines[1] || "")) {
    names.push(lines[0]);
  }
  const stem = path.parse(String(originalFileName || "")).name.replace(/\s*\(\d+\)\s*$/, "");
  const fileHead = stem.split(/[-_—\s]/)[0];
  if (/^[\p{Script=Han}]{2,6}$/u.test(fileHead)) names.push(fileHead);
  return [...new Set(names)];
}

function mergeRedactionCounts(target, source) {
  for (const [name, count] of Object.entries(source || {})) {
    target[name] = (target[name] || 0) + Number(count || 0);
  }
}

function redactExactValues(text, values, label, replacement, redactions) {
  let result = text;
  for (const value of values) {
    const pattern = new RegExp(escapeRegExp(value), "g");
    result = result.replace(pattern, () => {
      redactions[label] = (redactions[label] || 0) + 1;
      return replacement;
    });
  }
  return result;
}

function redactStandardFields(value) {
  let text = value;
  const redactions = {};
  const replace = (pattern, label, replacer) => {
    text = text.replace(pattern, (...args) => {
      redactions[label] = (redactions[label] || 0) + 1;
      return typeof replacer === "function" ? replacer(...args) : replacer;
    });
  };
  replace(/(^|\n)(\s*(?:手机|电话|联系电话|联系方式)\s*[：:]?\s*)[^\n]+/gi, "phone", (_match, line, prefix) => `${line}${prefix}[已隐藏]`);
  replace(/(^|\n)(\s*(?:家庭住址|通讯地址|详细地址|现住址|住址|地址)\s*[：:]?\s*)[^\n]+/gi, "address", (_match, line, prefix) => `${line}${prefix}[已隐藏]`);
  replace(/(?<![\dA-Za-z])(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g, "phone", "[手机号已隐藏]");
  replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "email", "[邮箱已隐藏]");
  replace(/(?<!\d)\d{17}[\dXx](?!\d)/g, "idCard", "[身份证号已隐藏]");
  return { text, redactions };
}

function assertResumeIdentityRedacted(text, identity) {
  const normalized = normalizeIdentity(identity);
  const exactLeak = [...normalized.names, ...normalized.phones, ...normalized.emails]
    .some((value) => String(text).includes(value));
  const patternedLeak = /(?<![\dA-Za-z])(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/.test(text)
    || /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text);
  if (exactLeak || patternedLeak) {
    throw privacyError("简历身份遮盖校验失败。");
  }
}

function prepareResumeTextForModel(
  value,
  { originalFileName = "", identity = null, strict = false } = {}
) {
  const explicit = normalizeIdentity(identity);
  const inferredNames = inferCandidateNames(String(value || ""), originalFileName);
  const names = [...new Set([...explicit.names, ...inferredNames])];
  if (strict && !names.length) {
    throw privacyError("严格隐私模式必须提供或识别候选人姓名。");
  }

  const redactions = {};
  const standard = redactStandardFields(String(value || ""));
  let text = standard.text;
  mergeRedactionCounts(redactions, standard.redactions);
  text = redactExactValues(text, names, "name", "[姓名已隐藏]", redactions);
  text = redactExactValues(text, explicit.phones, "phone", "[手机号已隐藏]", redactions);
  text = redactExactValues(text, explicit.emails, "email", "[邮箱已隐藏]", redactions);
  assertResumeIdentityRedacted(text, { ...explicit, names });
  return { text, preview: text.slice(0, 1200), redactions };
}

module.exports = { prepareResumeTextForModel, assertResumeIdentityRedacted };
