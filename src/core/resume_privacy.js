const path = require("node:path");

function privacyError(message) {
  const error = new Error(message);
  error.code = "RESUME_PRIVACY_REDACTION_FAILED";
  return error;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeUnicode(value) {
  return String(value == null ? "" : value).normalize("NFKC");
}

function identityPattern(value, { caseInsensitive = false, phone = false } = {}) {
  const normalized = normalizeUnicode(value).trim();
  if (phone) {
    const digits = normalized.replace(/\D/g, "").replace(/^(?:86)?(?=1[3-9]\d{9}$)/, "");
    if (/^1[3-9]\d{9}$/.test(digits)) {
      return new RegExp(`(?<![\\dA-Za-z])(?:\\+?\\s*86[\\s()\\-]*)?${digits.split("").map(escapeRegExp).join("[\\s()\\-]*")}(?!\\d)`, "g");
    }
  }
  return new RegExp(normalized.split(/[\s\u00A0]+/).map(escapeRegExp).join("[\\s\\u00A0]+"), caseInsensitive ? "gi" : "g");
}

function containsIdentityValue(text, value, options) {
  return identityPattern(value, options).test(normalizeUnicode(text));
}

function hasStandardPii(text) {
  const value = normalizeUnicode(text);
  return /(?<![\dA-Za-z])(?:\+?\s*86[\s()\-]*)?1[\s()\-]*[3-9](?:[\s()\-]*\d){9}(?!\d)/.test(value)
    || /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value)
    || /(?<!\d)\d{17}[\dXx](?!\d)/.test(value)
    || /(?:^|\n)\s*(?:\u5bb6\u5ead\u4f4f\u5740|\u901a\u8baf\u5730\u5740|\u8054\u7cfb\u5730\u5740|\u8be6\u7ec6\u5730\u5740|\u73b0\u4f4f\u5740|\u4f4f\u5740|\u5730\u5740)(?:\s*[\uff1a:]\s*|\s+)(?!\[[^\]\n]*\])\S+/i.test(value);
}

function normalizeIdentity(value) {
  if (value == null) return { names: [], phones: [], emails: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw privacyError("身份清单格式无效。");
  }
  const clean = (items) => [...new Set((Array.isArray(items) ? items : []).map((item) => normalizeUnicode(item).trim()).filter(Boolean))];
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

function inferCandidateDisplayName(text, originalFileName) {
  return inferCandidateNames(text, originalFileName)
    .find((name) => name
      && !/姓名已隐藏|姓名已遮盖|已隐藏|候选人/i.test(name)) || "候选人";
}

function mergeRedactionCounts(target, source) {
  for (const [name, count] of Object.entries(source || {})) {
    target[name] = (target[name] || 0) + Number(count || 0);
  }
}

function redactExactValues(text, values, label, replacement, redactions, options = {}) {
  let result = text;
  for (const value of values) {
    const pattern = identityPattern(value, options);
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
  replace(/(^|\n)(\s*(?:家庭住址|通讯地址|联系地址|详细地址|现住址|住址|地址)\s*[：:]?\s*)[^\n]+/gi, "address", (_match, line, prefix) => `${line}${prefix}[已隐藏]`);
  replace(/(?<![\dA-Za-z])(?:\+?\s*86[\s()\-]*)?1[\s()\-]*[3-9](?:[\s()\-]*\d){9}(?!\d)/g, "phone", "[手机号已隐藏]");
  replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "email", "[邮箱已隐藏]");
  replace(/(?<!\d)\d{17}[\dXx](?!\d)/g, "idCard", "[身份证号已隐藏]");
  return { text, redactions };
}

function maskResumeContacts(value) {
  return redactStandardFields(normalizeUnicode(value)).text;
}

function maskResumeFileName(value) {
  const extension = path.extname(normalizeUnicode(value)).toLowerCase();
  return `简历文件${/^\.[a-z0-9]{1,10}$/.test(extension) ? extension : ""}`;
}

function maskResumeDiagnostics(diagnostics = {}) {
  const value = diagnostics && typeof diagnostics === "object" ? diagnostics : {};
  const modelInput = value.modelInput && typeof value.modelInput === "object"
    ? { ...value.modelInput, preview: maskResumeContacts(value.modelInput.preview || "") }
    : value.modelInput;
  return {
    ...value,
    preview: maskResumeContacts(value.preview || ""),
    ...(modelInput ? { modelInput } : {})
  };
}

function assertResumeIdentityRedacted(text, identity) {
  const normalized = normalizeIdentity(identity);
  const explicitLeak = normalized.names.some((value) => containsIdentityValue(text, value, { caseInsensitive: true }))
    || normalized.phones.some((value) => containsIdentityValue(text, value, { phone: true }))
    || normalized.emails.some((value) => containsIdentityValue(text, value, { caseInsensitive: true }));
  if (explicitLeak || hasStandardPii(text)) {
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
  const standard = redactStandardFields(normalizeUnicode(value));
  let text = standard.text;
  mergeRedactionCounts(redactions, standard.redactions);
  text = redactExactValues(text, names, "name", "[姓名已隐藏]", redactions, { caseInsensitive: true });
  text = redactExactValues(text, explicit.phones, "phone", "[手机号已隐藏]", redactions, { phone: true });
  text = redactExactValues(text, explicit.emails, "email", "[邮箱已隐藏]", redactions, { caseInsensitive: true });
  assertResumeIdentityRedacted(text, { ...explicit, names });
  return { text, preview: text.slice(0, 1200), redactions };
}

module.exports = {
  prepareResumeTextForModel,
  assertResumeIdentityRedacted,
  inferCandidateDisplayName,
  maskResumeContacts,
  maskResumeFileName,
  maskResumeDiagnostics
};
