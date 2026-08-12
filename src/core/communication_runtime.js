const { getSiteRuntimeState } = require("./storage");
const { appError } = require("./observability");
const { resolveAccessMode } = require("./site_access_budget");

function communicationRuntimeBlock(db) {
  const state = getSiteRuntimeState(db, "boss");
  if (!state || state.status !== "blocked") return null;
  const blockedUntil = state.details?.blockedUntil || null;
  const blockedUntilMs = Date.parse(blockedUntil || "");
  const nowMs = Date.now();
  const accessMode = resolveAccessMode(db, { site: "boss", nowMs });
  if (accessMode !== "recovery" && Number.isFinite(blockedUntilMs) && blockedUntilMs <= nowMs) return null;
  return { reasonCode: state.reasonCode || "BOSS_RUNTIME_BLOCKED", blockedUntil };
}

function assertBossRuntimeAvailable(db) {
  const block = communicationRuntimeBlock(db);
  if (!block) return;
  throw appError(block.reasonCode, "BOSS 访问仍处于安全暂停期。", { statusCode: 409 });
}

module.exports = { communicationRuntimeBlock, assertBossRuntimeAvailable };
