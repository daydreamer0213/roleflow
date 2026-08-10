const { getSiteRuntimeState } = require("./storage");
const { appError } = require("./observability");

function communicationRuntimeBlock(db) {
  const state = getSiteRuntimeState(db, "boss");
  if (!state || state.status !== "blocked") return null;
  const blockedUntil = state.details?.blockedUntil || null;
  const blockedUntilMs = Date.parse(blockedUntil || "");
  if (Number.isFinite(blockedUntilMs) && blockedUntilMs <= Date.now()) return null;
  return { reasonCode: state.reasonCode || "BOSS_RUNTIME_BLOCKED", blockedUntil };
}

function assertBossRuntimeAvailable(db) {
  const block = communicationRuntimeBlock(db);
  if (!block) return;
  throw appError(block.reasonCode, "BOSS 访问仍处于安全暂停期。", { statusCode: 409 });
}

module.exports = { communicationRuntimeBlock, assertBossRuntimeAvailable };
