const { createHash } = require("node:crypto");
const { isKnownFactKey } = require("./message_reply_contract");

const VALID_SCOPE_KINDS = new Set(["global", "job", "company", "experience"]);

function normalizeReplyDraftText(value) {
  return String(value == null ? "" : value)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 4000);
}

function replyDraftDigest(value) {
  return `sha256:${createHash("sha256").update(normalizeReplyDraftText(value)).digest("hex")}`;
}

function replyDraftWasEdited(originalText, finalText) {
  return comparableText(originalText) !== comparableText(finalText);
}

function deriveUserChangedText(originalText, finalText) {
  const original = Array.from(normalizeReplyDraftText(originalText));
  const final = Array.from(normalizeReplyDraftText(finalText));
  if (comparableText(original.join("")) === comparableText(final.join(""))) return "";
  let prefix = 0;
  while (prefix < original.length && prefix < final.length && original[prefix] === final[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < original.length - prefix
    && suffix < final.length - prefix
    && original[original.length - 1 - suffix] === final[final.length - 1 - suffix]
  ) suffix += 1;
  return final.slice(prefix, final.length - suffix || final.length).join("").slice(0, 2000);
}

function validateReplyEditFactExtraction(value, { changedText = "" } = {}) {
  const extraction = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const evidenceSource = String(changedText || "");
  const scopeValue = extraction.scope && typeof extraction.scope === "object" && !Array.isArray(extraction.scope)
    ? extraction.scope
    : {};
  const scope = {
    kind: VALID_SCOPE_KINDS.has(scopeValue.kind) ? scopeValue.kind : "global",
    key: String(scopeValue.key || "").replace(/\s+/g, " ").trim().slice(0, 160)
  };
  const byKey = new Map();
  for (const item of Array.isArray(extraction.facts) ? extraction.facts : []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const factKey = String(item.factKey || "").trim().replace(/[^a-z0-9_.-]/gi, "_").slice(0, 80);
    const factValue = String(item.factValue || "").trim().slice(0, 2000);
    const evidenceText = String(item.evidenceText || "").trim().slice(0, 2000);
    if (!factKey || !isKnownFactKey(factKey) || !factValue || !evidenceText) continue;
    if (!evidenceSource.includes(evidenceText)) continue;
    byKey.set(factKey, { factKey, factValue, evidenceText });
  }
  return { scope, facts: [...byKey.values()] };
}

function comparableText(value) {
  return normalizeReplyDraftText(value).replace(/\s+/g, " ").trim();
}

module.exports = {
  normalizeReplyDraftText,
  replyDraftDigest,
  replyDraftWasEdited,
  deriveUserChangedText,
  validateReplyEditFactExtraction
};
