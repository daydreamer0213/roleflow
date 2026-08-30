"use strict";

function canonicalBossJobSourceId(value) {
  const text = String(value || "").trim();
  if (/^boss:[A-Za-z0-9_-]{6,160}$/.test(text)) return text;
  return /^[A-Za-z0-9_-]{6,160}$/.test(text) ? `boss:${text}` : "";
}

function bossLocationConflicts(left, right) {
  const local = baseCity(left);
  const remote = baseCity(right);
  return Boolean(local && remote && local !== remote);
}

function baseCity(value) {
  return String(value || "").trim().toLowerCase().split(/[·\s]+/, 1)[0];
}

module.exports = { canonicalBossJobSourceId, bossLocationConflicts };
