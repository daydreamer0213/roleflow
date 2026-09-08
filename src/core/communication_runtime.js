const { getSiteRuntimeState } = require("./storage");
const { appError } = require("./observability");
const { resolveAccessMode } = require("./site_access_budget");

function scanRuntimeBlock(db, { nowMs = Date.now(), site = "boss" } = {}) {
  const state = getSiteRuntimeState(db, site);
  if (!state || state.status !== "blocked") return null;
  const blockedUntil = state.details?.blockedUntil || null;
  const blockedUntilMs = Date.parse(blockedUntil || "");
  if (Number.isFinite(blockedUntilMs) && blockedUntilMs <= nowMs) return null;
  return { reasonCode: state.reasonCode || (site === "zhaopin" ? "ZHAOPIN_RUNTIME_BLOCKED" : "BOSS_RUNTIME_BLOCKED"), blockedUntil };
}

function communicationRuntimeBlock(db, { site = "boss", nowMs = Date.now() } = {}) {
  const normalizedSite = communicationSite(site);
  const state = getSiteRuntimeState(db, normalizedSite);
  if (!state || state.status !== "blocked") return null;
  const blockedUntil = state.details?.blockedUntil || null;
  const blockedUntilMs = Date.parse(blockedUntil || "");
  const accessMode = resolveAccessMode(db, { site: normalizedSite, nowMs });
  if (accessMode !== "recovery" && Number.isFinite(blockedUntilMs) && blockedUntilMs <= nowMs) return null;
  return {
    reasonCode: state.reasonCode || (normalizedSite === "zhaopin" ? "ZHAOPIN_RUNTIME_BLOCKED" : "BOSS_RUNTIME_BLOCKED"),
    blockedUntil
  };
}

function assertBossRuntimeAvailable(db, { site = "boss" } = {}) {
  const block = scanRuntimeBlock(db, { site });
  if (!block) return;
  throw appError(block.reasonCode, `${site === "zhaopin" ? "智联" : "BOSS"} 访问仍处于安全暂停期。`, { statusCode: 409 });
}

function assertCommunicationRuntimeAvailable(db, { site = "boss" } = {}) {
  const normalizedSite = communicationSite(site);
  const block = communicationRuntimeBlock(db, { site: normalizedSite });
  if (!block) return;
  throw appError(block.reasonCode, `${normalizedSite === "zhaopin" ? "智联" : "BOSS"} 访问仍处于安全暂停期。`, { statusCode: 409 });
}

function communicationSite(value) {
  const site = String(value || "").trim().toLowerCase();
  if (!["boss", "zhaopin"].includes(site)) {
    throw appError("COMMUNICATION_SITE_INVALID", "communication site must be boss or zhaopin", { statusCode: 400 });
  }
  return site;
}

module.exports = {
  scanRuntimeBlock,
  communicationRuntimeBlock,
  assertBossRuntimeAvailable,
  assertCommunicationRuntimeAvailable
};
