const assert = require("node:assert");
const crypto = require("node:crypto");
const {
  openDb,
  recordMessageReplyDrafts,
  saveMessageInboundContext,
  createMessageReplySendBatch,
  stopPendingMessageReplySendItems
} = require("../src/core/storage");
const {
  loadReplySendBatch,
  transitionReplySendBatch,
  transitionReplySendItem
} = require("../src/core/message_reply_send_batches");
const { runMessageReplySendBatch } = require("../src/core/message_reply_send_executor");

const NOW = "2026-08-29T04:00:00.000Z";

(async () => {
  await successfulSerialBatchSmoke();
  await targetMismatchStopsLaterItemsSmoke();
  await preClickFailuresStopSafelySmoke();
  await userStopBeforeClickSmoke();
  await postClickOutcomesInterruptSmoke();
  await postClickExceptionInterruptsSmoke();
  await verifiedSuccessFailureInterruptsSmoke();
  await staleRunningBatchNeverReplaysSmoke();
  await abortedRunStopsBeforeClickSmoke();
  console.log("message_reply_send_executor_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function successfulSerialBatchSmoke() {
  const fixture = seedBatch(2);
  try {
    const calls = [];
    const reservations = [];
    const sleeps = [];
    const sender = fakeSender({
      db: fixture.db,
      calls,
      outcomes: ["succeeded", "succeeded"]
    });
    const result = await runMessageReplySendBatch({
      db: fixture.db,
      batchId: fixture.batch.id,
      sender,
      accessController: {
        async reserve(action, details) {
          reservations.push({ action, details });
          return { action };
        }
      },
      onVerifiedSuccess: verifiedSuccess(fixture.db),
      sleepFn: async (ms) => sleeps.push(ms),
      randomFn: () => 0,
      logger: quietLogger()
    });
    assert.equal(result.batch.status, "completed");
    assert(result.items.every((item) => item.status === "succeeded"));
    assert(!JSON.stringify(result).includes("确认回复"), "public result must not contain frozen reply text");
    assert.deepStrictEqual(calls, [
      ["inspect", fixture.items[0].id], ["fill", fixture.items[0].id],
      ["dispatch", fixture.items[0].id], ["verify", fixture.items[0].id],
      ["inspect", fixture.items[1].id], ["fill", fixture.items[1].id],
      ["dispatch", fixture.items[1].id], ["verify", fixture.items[1].id]
    ]);
    assert.deepStrictEqual(reservations, fixture.items.map((item) => ({
      action: "message_reply_send",
      details: { batchId: fixture.batch.id, itemId: item.id, jobId: item.jobId }
    })));
    assert.deepStrictEqual(sleeps, [15000], "only the inter-item communication delay should run");
  } finally {
    fixture.db.close();
  }
}

async function targetMismatchStopsLaterItemsSmoke() {
  const fixture = seedBatch(2);
  try {
    const calls = [];
    const sender = fakeSender({
      db: fixture.db,
      calls,
      inspectError: coded("BOSS_MESSAGE_REPLY_TARGET_MISMATCH")
    });
    const result = await run(fixture, sender);
    assert.equal(result.batch.status, "interrupted");
    assert.deepStrictEqual(result.items.map((item) => item.status), ["target_mismatch", "stopped"]);
    assert.deepStrictEqual(calls, [["inspect", fixture.items[0].id]]);
  } finally {
    fixture.db.close();
  }
}

async function preClickFailuresStopSafelySmoke() {
  for (const code of [
    "BOSS_MESSAGE_REPLY_EDITOR_NOT_EMPTY",
    "BOSS_RISK_CONTROL",
    "BOSS_LOGIN_REQUIRED",
    "BOSS_MESSAGE_PAGE_LOST",
    "BOSS_MESSAGE_STRUCTURE_CHANGED"
  ]) {
    const fixture = seedBatch(2);
    try {
      const calls = [];
      const sender = fakeSender({ db: fixture.db, calls, fillError: coded(code) });
      const result = await run(fixture, sender);
      assert.equal(result.batch.status, "interrupted", code);
      assert.deepStrictEqual(result.items.map((item) => item.status), ["stopped", "stopped"], code);
      assert.equal(calls.some(([name]) => name === "dispatch"), false, code);
    } finally {
      fixture.db.close();
    }
  }
}

async function userStopBeforeClickSmoke() {
  const fixture = seedBatch(2);
  try {
    const calls = [];
    const sender = fakeSender({
      db: fixture.db,
      calls,
      async afterInspect() {
        stopPendingMessageReplySendItems(fixture.db, {
          profileId: fixture.profileId,
          batchId: fixture.batch.id,
          errorCode: "MESSAGE_REPLY_SEND_STOPPED",
          errorMessage: "user stopped"
        });
        transitionReplySendBatch(fixture.db, {
          profileId: fixture.profileId,
          batchId: fixture.batch.id,
          expectedStatus: "running",
          status: "stopped",
          stopCode: "MESSAGE_REPLY_SEND_STOPPED"
        });
      }
    });
    const result = await run(fixture, sender);
    assert.equal(result.batch.status, "stopped");
    assert(result.items.every((item) => item.status === "stopped"));
    assert.deepStrictEqual(calls, [["inspect", fixture.items[0].id]]);
  } finally {
    fixture.db.close();
  }
}

async function postClickOutcomesInterruptSmoke() {
  for (const outcome of ["platform_rejected", "ambiguous", "target_mismatch"]) {
    const fixture = seedBatch(2);
    try {
      const calls = [];
      const sender = fakeSender({ db: fixture.db, calls, outcomes: [outcome] });
      const result = await run(fixture, sender);
      assert.equal(result.batch.status, "interrupted", outcome);
      assert.equal(result.items[0].status, outcome === "platform_rejected" ? "platform_rejected" : "ambiguous", outcome);
      assert.equal(result.items[0].clickCount, 1, outcome);
      assert.equal(result.items[1].status, "stopped", outcome);
      assert.equal(calls.filter(([name]) => name === "dispatch").length, 1, outcome);
    } finally {
      fixture.db.close();
    }
  }
}

async function verifiedSuccessFailureInterruptsSmoke() {
  const fixture = seedBatch(2);
  try {
    const sender = fakeSender({ db: fixture.db, calls: [], outcomes: ["succeeded"] });
    const result = await runMessageReplySendBatch({
      db: fixture.db,
      batchId: fixture.batch.id,
      sender,
      accessController: permitAll(),
      async onVerifiedSuccess() { throw coded("LOCAL_LEARNING_FAILED"); },
      sleepFn: async () => {},
      randomFn: () => 0,
      logger: quietLogger()
    });
    assert.equal(result.batch.status, "interrupted");
    assert.deepStrictEqual(result.items.map((item) => item.status), ["ambiguous", "stopped"]);
  } finally {
    fixture.db.close();
  }
}

async function postClickExceptionInterruptsSmoke() {
  for (const option of [
    { dispatchError: coded("BROWSER_COMMAND_FAILED") },
    { verifyError: coded("BOSS_MESSAGE_PAGE_LOST") }
  ]) {
    const fixture = seedBatch(2);
    try {
      const calls = [];
      const sender = fakeSender({ db: fixture.db, calls, ...option });
      const result = await run(fixture, sender);
      assert.equal(result.batch.status, "interrupted");
      assert.deepStrictEqual(result.items.map((item) => item.status), ["ambiguous", "stopped"]);
      assert.equal(result.items[0].clickCount, 1);
    } finally {
      fixture.db.close();
    }
  }
}

async function staleRunningBatchNeverReplaysSmoke() {
  const fixture = seedBatch(2);
  try {
    transitionReplySendBatch(fixture.db, {
      profileId: fixture.profileId,
      batchId: fixture.batch.id,
      expectedStatus: "confirmed",
      status: "running"
    });
    let current = transitionReplySendItem(fixture.db, {
      profileId: fixture.profileId, batchId: fixture.batch.id,
      itemId: fixture.items[0].id, expectedStatus: "pending", status: "selecting"
    });
    for (const status of ["verified", "filled", "click_dispatched"]) {
      current = transitionReplySendItem(fixture.db, {
        profileId: fixture.profileId,
        batchId: fixture.batch.id,
        itemId: current.id,
        expectedStatus: current.status,
        status,
        clickCount: status === "click_dispatched" ? 1 : 0
      });
    }
    const calls = [];
    const result = await run(fixture, fakeSender({ db: fixture.db, calls }));
    assert.equal(result.batch.status, "interrupted");
    assert.deepStrictEqual(result.items.map((item) => item.status), ["ambiguous", "stopped"]);
    assert.deepStrictEqual(calls, [], "stale batches must never replay a historical click");
  } finally {
    fixture.db.close();
  }
}

async function abortedRunStopsBeforeClickSmoke() {
  const fixture = seedBatch(2);
  try {
    const controller = new AbortController();
    const calls = [];
    const sender = fakeSender({
      db: fixture.db,
      calls,
      afterInspect() { controller.abort(coded("SERVER_CLOSING")); }
    });
    const result = await runMessageReplySendBatch({
      db: fixture.db,
      batchId: fixture.batch.id,
      sender,
      accessController: permitAll(),
      onVerifiedSuccess: verifiedSuccess(fixture.db),
      sleepFn: async () => {},
      signal: controller.signal,
      logger: quietLogger()
    });
    assert.equal(result.batch.status, "interrupted");
    assert(result.items.every((item) => item.status === "stopped"));
    assert.equal(calls.some(([name]) => name === "dispatch"), false);
  } finally {
    fixture.db.close();
  }
}

function seedBatch(count) {
  const db = openDb(":memory:");
  const profileId = Number(db.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES ('Executor fixture', '{}', NULL, ?, ?)`).run(NOW, NOW).lastInsertRowid);
  const planId = Number(db.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, 'Executor plan', '{}', NULL, 1, ?, ?)`).run(profileId, NOW, NOW).lastInsertRowid);
  const drafts = [];
  for (let index = 0; index < count; index += 1) {
    const suffix = index + 1;
    const jobId = Number(db.prepare(`INSERT INTO jobs(
      source, source_id, title, first_seen_at, last_seen_at
    ) VALUES ('boss', ?, ?, ?, ?)`).run(`boss:executor-job-${suffix}`, `岗位 ${suffix}`, NOW, NOW).lastInsertRowid);
    const cardId = Number(db.prepare(`INSERT INTO candidate_progress_cards(
      profile_id, plan_id, job_id, source, stage, next_action, last_event_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'boss', 'reply_ready', 'Review reply', ?, ?, ?)`)
      .run(profileId, planId, jobId, NOW, NOW, NOW).lastInsertRowid);
    const groupKey = digest(`executor-group-${suffix}`);
    const draft = recordMessageReplyDrafts(db, {
      profileId, cardId, jobId, messageGroupKey: groupKey,
      questionSummary: `问题 ${suffix}`,
      messageIntent: "information_request",
      messageCategory: "other",
      messages: [`确认回复 ${suffix}`],
      createdAt: NOW
    })[0];
    saveMessageInboundContext(db, {
      profileId, cardId, messageGroupKey: groupKey,
      conversationKey: digest(`executor-conversation-${suffix}`),
      sourceJobId: `boss:executor-job-${suffix}`,
      lastMessageId: `3789170377487${String(30 + suffix).padStart(2, "0")}`,
      messageIntent: "information_request",
      messageCategory: "other",
      inboundMessages: [{ kind: "text", text: `HR 消息 ${suffix}` }],
      manualActions: [], createdAt: NOW, updatedAt: NOW
    });
    drafts.push(draft);
  }
  const created = createMessageReplySendBatch(db, {
    profileId,
    items: drafts.map((draft) => ({ draftId: draft.id, revision: draft.revision })),
    createdAt: NOW
  });
  return { db, profileId, batch: created.batch, items: created.items };
}

function fakeSender({
  db, calls, outcomes = [], inspectError = null, fillError = null,
  dispatchError = null, verifyError = null, afterInspect = null
} = {}) {
  const inspections = new Map();
  const preparations = new Map();
  return {
    async inspectReplyTarget(item) {
      calls.push(["inspect", item.id]);
      if (inspectError) throw inspectError;
      const token = {};
      inspections.set(token, item);
      await afterInspect?.(item);
      return token;
    },
    async fillReply(inspection, text) {
      const item = inspections.get(inspection);
      calls.push(["fill", item.id]);
      assert.equal(text, item.replyText);
      if (fillError) throw fillError;
      const token = {};
      preparations.set(token, item);
      return token;
    },
    async dispatchReply(preparation) {
      const item = preparations.get(preparation);
      calls.push(["dispatch", item.id]);
      const stored = loadReplySendBatch(db, { profileId: batchOwner(db, item.batchId), batchId: item.batchId })
        .items.find((entry) => entry.id === item.id);
      assert.equal(stored.status, "click_dispatched", "click ownership must be durable before the browser click");
      assert.equal(stored.clickCount, 1);
      if (dispatchError) throw dispatchError;
      return preparation;
    },
    async verifyReplyResult(preparation) {
      const item = preparations.get(preparation);
      calls.push(["verify", item.id]);
      if (verifyError) throw verifyError;
      const state = outcomes.shift() || "succeeded";
      return { state, evidence: { verification: state, outgoingMessageId: "378917037748799" } };
    },
    async clearPreparedReply(preparation) {
      const item = preparations.get(preparation);
      calls.push(["clear", item.id]);
      return { cleared: true };
    }
  };
}

function verifiedSuccess(db) {
  return async ({ batchId, itemId }) => {
    const profileId = batchOwner(db, batchId);
    transitionReplySendItem(db, {
      profileId, batchId, itemId,
      expectedStatus: "click_dispatched",
      status: "succeeded",
      clickCount: 1
    });
  };
}

function run(fixture, sender) {
  return runMessageReplySendBatch({
    db: fixture.db,
    batchId: fixture.batch.id,
    sender,
    accessController: permitAll(),
    onVerifiedSuccess: verifiedSuccess(fixture.db),
    sleepFn: async () => {},
    randomFn: () => 0,
    logger: quietLogger()
  });
}

function permitAll() {
  return { async reserve() { return {}; } };
}

function batchOwner(db, batchId) {
  return Number(db.prepare("SELECT profile_id FROM message_reply_send_batches WHERE id = ?").get(batchId).profile_id);
}

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value)).digest("hex")}`;
}

function coded(code) {
  return Object.assign(new Error(code), { code });
}

function quietLogger() {
  return { info() {}, warn() {}, error() {} };
}
