const assert = require("node:assert/strict");
const { openDb, setSiteRuntimeState } = require("../src/core/storage");
const { persistBossRiskControl } = require("../src/cli");
const { resolveAccessMode } = require("../src/core/site_access_budget");
const {
  scanRuntimeBlock,
  communicationRuntimeBlock,
  assertBossRuntimeAvailable,
  assertCommunicationRuntimeAvailable
} = require("../src/core/communication_runtime");

const HOUR_MS = 60 * 60_000;
const RISK_AT_MS = Date.UTC(2026, 7, 12, 0, 0, 0);

function withFrozenNow(nowMs, fn) {
  const originalNow = Date.now;
  Date.now = () => nowMs;
  try {
    return fn();
  } finally {
    Date.now = originalNow;
  }
}

function persistRisk(db, platformBlockedUntilMs) {
  persistBossRiskControl(db, {
    site: "boss",
    runId: "communication-runtime-smoke",
    error: Object.assign(new Error("BOSS risk control"), {
      code: "BOSS_RISK_CONTROL",
      blockedUntil: new Date(platformBlockedUntilMs).toISOString()
    }),
    nowMs: RISK_AT_MS
  });
}

function riskRecoveryFloorSmoke() {
  const db = openDb(":memory:");
  try {
    const blockedUntil = new Date(RISK_AT_MS + HOUR_MS).toISOString();
    persistRisk(db, RISK_AT_MS + HOUR_MS);

    assert.strictEqual(resolveAccessMode(db, { site: "boss", nowMs: RISK_AT_MS + 47 * HOUR_MS }), "recovery");
    assert.strictEqual(scanRuntimeBlock(db, { nowMs: RISK_AT_MS + 47 * HOUR_MS }), null);
    withFrozenNow(RISK_AT_MS + 47 * HOUR_MS, () => {
      assert.doesNotThrow(() => assertBossRuntimeAvailable(db));
      assert.deepStrictEqual(communicationRuntimeBlock(db), {
        reasonCode: "BOSS_RISK_CONTROL",
        blockedUntil
      });
      assert.throws(
        () => assertCommunicationRuntimeAvailable(db),
        (error) => error.code === "BOSS_RISK_CONTROL" && error.statusCode === 409
      );
    });

    assert.strictEqual(resolveAccessMode(db, { site: "boss", nowMs: RISK_AT_MS + 49 * HOUR_MS }), "normal");
    withFrozenNow(RISK_AT_MS + 49 * HOUR_MS, () => {
      assert.strictEqual(scanRuntimeBlock(db), null);
      assert.strictEqual(communicationRuntimeBlock(db), null);
      assert.doesNotThrow(() => assertBossRuntimeAvailable(db));
      assert.doesNotThrow(() => assertCommunicationRuntimeAvailable(db));
    });
  } finally {
    db.close();
  }
}

function laterPlatformDeadlineSmoke() {
  const db = openDb(":memory:");
  try {
    const blockedUntil = new Date(RISK_AT_MS + 72 * HOUR_MS).toISOString();
    persistRisk(db, RISK_AT_MS + 72 * HOUR_MS);

    assert.strictEqual(resolveAccessMode(db, { site: "boss", nowMs: RISK_AT_MS + 71 * HOUR_MS }), "recovery");
    assert.deepStrictEqual(scanRuntimeBlock(db, { nowMs: RISK_AT_MS + 71 * HOUR_MS }), {
      reasonCode: "BOSS_RISK_CONTROL",
      blockedUntil
    });
    assert.deepStrictEqual(communicationRuntimeBlock(db, { nowMs: RISK_AT_MS + 71 * HOUR_MS }), {
      reasonCode: "BOSS_RISK_CONTROL",
      blockedUntil
    });

    assert.strictEqual(resolveAccessMode(db, { site: "boss", nowMs: RISK_AT_MS + 73 * HOUR_MS }), "normal");
    withFrozenNow(RISK_AT_MS + 73 * HOUR_MS, () => {
      assert.strictEqual(communicationRuntimeBlock(db), null);
    });
  } finally {
    db.close();
  }
}

function genericBlockedStateSmoke() {
  const db = openDb(":memory:");
  try {
    const futureDeadline = new Date(RISK_AT_MS + HOUR_MS).toISOString();
    setSiteRuntimeState(db, "boss", {
      status: "blocked",
      reasonCode: "BOSS_RUNTIME_BLOCKED",
      details: { blockedUntil: futureDeadline }
    });
    withFrozenNow(RISK_AT_MS, () => {
      assert.deepStrictEqual(scanRuntimeBlock(db), {
        reasonCode: "BOSS_RUNTIME_BLOCKED",
        blockedUntil: futureDeadline
      });
      assert.deepStrictEqual(communicationRuntimeBlock(db), {
        reasonCode: "BOSS_RUNTIME_BLOCKED",
        blockedUntil: futureDeadline
      });
    });
    withFrozenNow(RISK_AT_MS + 2 * HOUR_MS, () => {
      assert.strictEqual(scanRuntimeBlock(db), null);
      assert.strictEqual(communicationRuntimeBlock(db), null);
    });
  } finally {
    db.close();
  }
}

riskRecoveryFloorSmoke();
laterPlatformDeadlineSmoke();
genericBlockedStateSmoke();
console.log("communication_runtime_smoke ok");
