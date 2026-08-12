const { PRODUCT_POLICY } = require("./product_policy");

function resolveBossRiskWindow({ nowMs, requestedBlockedUntil } = {}) {
  const recoveryMs = PRODUCT_POLICY.operations.bossAccessBudget.recoveryHours * 60 * 60_000;
  const candidate = Number(nowMs);
  const validRawTime = typeof nowMs === "number" || (typeof nowMs === "string" && nowMs.trim() !== "");
  const observedAtMs = validRawTime && candidate >= 0 && Number.isFinite(new Date(candidate + recoveryMs).getTime())
    ? candidate
    : Date.now();
  const occurredAt = new Date(observedAtMs).toISOString();
  const blockedUntil = typeof requestedBlockedUntil === "string" && Number.isFinite(Date.parse(requestedBlockedUntil))
    ? requestedBlockedUntil
    : new Date(observedAtMs + recoveryMs).toISOString();
  return { observedAtMs, occurredAt, blockedUntil };
}

module.exports = { resolveBossRiskWindow };
