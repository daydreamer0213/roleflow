"use strict";

function privacyError() {
  return Object.assign(new Error("Resume identity redaction verification failed."), {
    code: "RESUME_PRIVACY_REDACTION_FAILED"
  });
}

function normalized(value) {
  return String(value ?? "").normalize("NFKC");
}

function checkIdentityManifestShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = ["names", "phones", "emails"];
  return fields.every((field) => Array.isArray(value[field]) && value[field].every((item) => typeof item === "string"))
    && fields.some((field) => value[field].some((item) => item.trim()));
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertResumeIdentityRedacted(text, identity) {
  if (!checkIdentityManifestShape(identity)) throw privacyError();
  const body = normalized(text);
  const foldedBody = body.toLowerCase();
  const compactBody = foldedBody.replace(/\s+/g, "");
  const names = identity.names.map((value) => normalized(value).trim()).filter(Boolean);
  const phones = identity.phones.map((value) => normalized(value).replace(/\D/g, "")).filter(Boolean);
  const emails = identity.emails.map((value) => normalized(value).trim().toLowerCase()).filter(Boolean);
  const nameLeak = names.some((name) => /[a-z]/i.test(name)
    ? compactBody.includes(name.toLowerCase().replace(/\s+/g, ""))
    : body.includes(name));
  const phoneLeak = phones.some((phone) => new RegExp(phone.split("").map(escaped).join("[\\s().-]*")).test(body));
  const emailLeak = emails.some((email) => foldedBody.includes(email));
  const patternedLeak = /(?<![\dA-Za-z])(?:\+?86[\s().-]*)?1[3-9](?:[\s().-]*\d){9}(?!\d)/.test(body)
    || /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(body)
    || /(?<!\d)\d(?:[\s-]*\d){16}[\s-]*[\dXx](?![\dXx])/.test(body);
  const addressLeak = [...body.matchAll(/(?:^|\n)\s*(?:家庭住址|通讯地址|详细地址|现住址|住址|地址|Address)\s*[：:]\s*([^\r\n]+)/gi)]
    .some((match) => !/^\[(?:已隐藏|地址已隐藏)\]$/.test(match[1].trim()));
  if (nameLeak || phoneLeak || emailLeak || patternedLeak || addressLeak) throw privacyError();
}

module.exports = { checkIdentityManifestShape, assertResumeIdentityRedacted };
