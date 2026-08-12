const { getSiteRuntimeState } = require("./storage");
const { appError } = require("./observability");
const { resolveAccessMode } = require("./site_access_budget");

function scanRuntimeBlock(db, { nowMs = Date.now() } = {}) {
  const state = getSiteRuntimeState(db, "boss");
  if (!state || state.status !== "blocked") return null;
  const blockedUntil = state.details?.blockedUntil || null;
  const blockedUntilMs = Date.parse(blockedUntil || "");
  if (Number.isFinite(blockedUntilMs) && blockedUntilMs <= nowMs) return null;
  return { reasonCode: state.reasonCode || "BOSS_RUNTIME_BLOCKED", blockedUntil };
}

function communicationRuntimeBlock(db, { nowMs = Date.now() } = {}) {
  const state = getSiteRuntimeState(db, "boss");
  if (!state || state.status !== "blocked") return null;
  const blockedUntil = state.details?.blockedUntil || null;
  const blockedUntilMs = Date.parse(blockedUntil || "");
  const accessMode = resolveAccessMode(db, { site: "boss", nowMs });
  if (accessMode !== "recovery" && Number.isFinite(blockedUntilMs) && blockedUntilMs <= nowMs) return null;
  return { reasonCode: state.reasonCode || "BOSS_RUNTIME_BLOCKED", blockedUntil };
}

function assertBossRuntimeAvailable(db) {
  const block = scanRuntimeBlock(db);
  if (!block) return;
  throw appError(block.reasonCode, "BOSS 访问仍处于安全暂停期。", { statusCode: 409 });
}

function assertCommunicationRuntimeAvailable(db) {
  const block = communicationRuntimeBlock(db);
  if (!block) return;
  throw appError(block.reasonCode, "BOSS 访问仍处于安全暂停期。", { statusCode: 409 });
}

module.exports = {
  scanRuntimeBlock,
  communicationRuntimeBlock,
  assertBossRuntimeAvailable,
  assertCommunicationRuntimeAvailable
};
