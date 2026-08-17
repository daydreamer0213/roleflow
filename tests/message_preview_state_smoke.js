const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDb } = require("../src/core/storage");
const {
  listPreviewStates,
  recordPreviewState,
  planMessageDiscoveryQueue,
  commitProcessedPreview,
  listUnresolvedMessageDiscoveryItems,
  recordUnresolvedMessageDiscoveryItem,
  clearUnresolvedMessageDiscoveryItem,
  getMessageDiscoveryRuntimeState,
  saveMessageDiscoveryRuntimeState
} = require("../src/core/message_preview_state");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-preview-state-"));
let db;

try {
  db = openDb(path.join(root, "preview.sqlite"));
  const now = "2026-08-01T08:00:00.000Z";
  const profileId = Number(db.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES ('Preview Candidate', '{}', NULL, ?, ?)`).run(now, now).lastInsertRowid);
  const secondProfileId = Number(db.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES ('Second Preview Candidate', '{}', NULL, ?, ?)`).run(now, now).lastInsertRowid);
  const platform = "boss";
  const pacing = {
    pacedActions: 19,
    nextPacingCooldownAt: 24,
    detailActions: 7,
    nextDetailMicroCooldownAt: 13,
    nextDetailMacroCooldownAt: 18
  };
  assert.deepStrictEqual(
    getMessageDiscoveryRuntimeState(db, { profileId, platform }),
    { profileId, platform, pacing: null, updatedAt: "" }
  );
  saveMessageDiscoveryRuntimeState(db, {
    profileId,
    platform,
    pacing: { ...pacing, securityId: "must-not-persist" },
    updatedAt: now
  });
  assert.deepStrictEqual(getMessageDiscoveryRuntimeState(db, { profileId, platform }), {
    profileId,
    platform,
    pacing,
    updatedAt: now
  });
  assert.deepStrictEqual(getMessageDiscoveryRuntimeState(db, { profileId: secondProfileId, platform }), {
    profileId: secondProfileId,
    platform,
    pacing,
    updatedAt: now
  }, "BOSS pacing must be shared across candidate profiles");
  assert.doesNotMatch(
    db.prepare("SELECT pacing_json FROM message_discovery_runtime_states WHERE platform = ?").get(platform).pacing_json,
    /securityId|must-not-persist/
  );
  saveMessageDiscoveryRuntimeState(db, {
    profileId,
    platform,
    pacing: { ...pacing, detailActions: -1 },
    updatedAt: "2026-08-01T08:00:01.000Z"
  });
  assert.strictEqual(getMessageDiscoveryRuntimeState(db, { profileId, platform }).pacing, null);
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) AS n FROM message_discovery_runtime_states WHERE platform = ?").get(platform).n,
    1,
    "runtime checkpoints must upsert one row per platform"
  );
  db.prepare("UPDATE message_discovery_runtime_states SET pacing_json = '{broken'").run();
  assert.strictEqual(getMessageDiscoveryRuntimeState(db, { profileId, platform }).pacing, null);

  let planned = planMessageDiscoveryQueue({
    rows: [readRow(digest("conversation-a"), digest("first"))],
    baselines: new Map()
  });
  assert.deepStrictEqual(planned.queue, []);
  assert.strictEqual(planned.baselineWrites.length, 1);
  recordPreviewState(db, {
    profileId,
    platform,
    conversationKey: digest("conversation-a"),
    previewDigest: digest("first"),
    previewKind: "possible_hr_reply",
    observedAt: now
  });
  assert.strictEqual(listPreviewStates(db, { profileId }).length, 1);

  planned = planMessageDiscoveryQueue({
    rows: [readRow(digest("conversation-a"), digest("changed"))],
    baselines: new Map([[digest("conversation-a"), {
      previewDigest: digest("first"),
      previewKind: "possible_hr_reply"
    }]])
  });
  assert.strictEqual(planned.queue[0].operation, "preview_changed");
  assert.strictEqual(planned.queue[0].previewDigest, digest("changed"));
  assert.deepStrictEqual(planned.baselineWrites, []);
  assert.strictEqual(
    listPreviewStates(db, { profileId })[0].previewDigest,
    digest("first"),
    "a changed HR preview must not become the baseline until processed"
  );
  commitProcessedPreview(db, {
    profileId,
    platform,
    conversationKey: digest("conversation-a"),
    previewDigest: digest("changed"),
    previewKind: "possible_hr_reply",
    observedAt: "2026-08-01T08:01:00.000Z"
  });
  assert.strictEqual(
    listPreviewStates(db, { profileId })[0].previewDigest,
    digest("changed")
  );

  planned = planMessageDiscoveryQueue({
    rows: [readRow(digest("conversation-a"), digest("read"), "self_read")],
    baselines: new Map([[digest("conversation-a"), {
      previewDigest: digest("delivered"),
      previewKind: "self_delivered"
    }]])
  });
  assert.deepStrictEqual(planned.queue, []);
  assert.strictEqual(planned.baselineWrites[0].previewDigest, digest("read"));

  planned = planMessageDiscoveryQueue({
    rows: [unreadRow(digest("conversation-b"), digest("new"))],
    baselines: new Map()
  });
  assert.strictEqual(planned.queue[0].operation, "unread");
  assert.strictEqual(planned.queue[0].conversationKey, digest("conversation-b"));

  recordUnresolvedMessageDiscoveryItem(db, {
    profileId,
    platform,
    conversationKey: digest("conversation-c"),
    previewDigest: digest("unmatched"),
    previewKind: "possible_hr_reply",
    reasonCode: "BOSS_MESSAGE_CARD_NOT_FOUND",
    observedAt: now,
    identity: {
      positionTitle: "RAG 应用工程师",
      company: "示例科技",
      salary: "15-25K",
      city: "广州",
      recruiterLabel: "禁止保存的招聘方",
      messageText: "禁止保存的消息正文"
    }
  });
  const unresolved = listUnresolvedMessageDiscoveryItems(db, { profileId });
  assert.deepStrictEqual(unresolved, [{
    profileId,
    platform,
    conversationKey: digest("conversation-c"),
    previewDigest: digest("unmatched"),
    previewKind: "possible_hr_reply",
    reasonCode: "BOSS_MESSAGE_CARD_NOT_FOUND",
    positionTitle: "RAG 应用工程师",
    company: "示例科技",
    salary: "15-25K",
    city: "广州",
    identityDigest: unresolved[0].identityDigest,
    firstObservedAt: now,
    lastObservedAt: now
  }]);
  assert.match(unresolved[0].identityDigest, /^sha256:[a-f0-9]{64}$/);
  const unresolvedText = JSON.stringify(db.prepare("SELECT * FROM message_discovery_unresolved_items").all());
  assert.doesNotMatch(unresolvedText, /禁止保存的招聘方|禁止保存的消息正文/);
  planned = planMessageDiscoveryQueue({
    rows: [
      readRow(digest("conversation-a"), digest("changed-again")),
      readRow(digest("conversation-c"), digest("still-unmatched")),
      unreadRow(digest("conversation-b"), digest("newer"))
    ],
    baselines: new Map([[digest("conversation-a"), {
      previewDigest: digest("changed"),
      previewKind: "possible_hr_reply"
    }]]),
    unresolved: new Map(unresolved.map((item) => [item.conversationKey, item]))
  });
  assert.deepStrictEqual(
    planned.queue.map((item) => item.operation),
    ["unread", "durable_unresolved", "preview_changed"],
    "unread rows must outrank retained unresolved rows, which outrank preview changes"
  );
  assert.strictEqual(planned.baselineWrites.length, 0, "a retained unresolved row must never become a read-history baseline");
  planned = planMessageDiscoveryQueue({
    rows: [
      { ...unreadRow(digest("conversation-b"), digest("duplicate-unread-a")), rowIndex: 1 },
      { ...unreadRow(digest("conversation-b"), digest("duplicate-unread-b")), rowIndex: 2 },
      { ...readRow(digest("conversation-b"), digest("duplicate-unread-c")), rowIndex: 3 },
      { ...readRow(digest("conversation-c"), digest("durable-unresolved")), rowIndex: 4 },
      { ...readRow(digest("conversation-a"), digest("changed-again")), rowIndex: 5 },
      { ...unreadRow("", digest("invalid-unread")), rowIndex: 6 }
    ],
    baselines: new Map([[digest("conversation-a"), {
      previewDigest: digest("changed"),
      previewKind: "possible_hr_reply"
    }]]),
    unresolved: new Map([
      [digest("conversation-b"), { reasonCode: "BOSS_MESSAGE_CARD_NOT_FOUND" }],
      [digest("conversation-c"), unresolved[0]]
    ])
  });
  assert.deepStrictEqual(
    planned.queue.map((item) => [item.operation, item.conversationKey]),
    [
      ["unread", digest("conversation-b")],
      ["durable_unresolved", digest("conversation-c")],
      ["preview_changed", digest("conversation-a")]
    ],
    "queue targets must deduplicate by conversation digest while retaining unread, unresolved, preview priority"
  );
  clearUnresolvedMessageDiscoveryItem(db, {
    profileId,
    platform,
    conversationKey: digest("conversation-c")
  });
  assert.deepStrictEqual(listUnresolvedMessageDiscoveryItems(db, { profileId }), []);

  planned = planMessageDiscoveryQueue({
    rows: [readRow(digest("conversation-a"), digest("voice"), "unsupported")],
    baselines: new Map([[digest("conversation-a"), {
      previewDigest: digest("text"),
      previewKind: "possible_hr_reply"
    }]])
  });
  assert.strictEqual(
    planned.queue[0].operation,
    "preview_changed",
    "unsupported preview changes must queue for manual handling"
  );
  assert.strictEqual(planned.queue[0].previewKind, "unsupported");

  const withoutKey = planMessageDiscoveryQueue({
    rows: [{ ...readRow("", digest("orphan")), conversationKey: "" }],
    baselines: new Map()
  });
  assert.deepStrictEqual(withoutKey.queue, []);
  assert.deepStrictEqual(withoutKey.baselineWrites, []);

  console.log("message_preview_state_smoke ok");
} finally {
  try { db?.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}

function readRow(conversationKey, previewDigest, previewKind = "possible_hr_reply") {
  return {
    rowIndex: 0,
    unread: false,
    selected: false,
    recruiterKey: digest("recruiter"),
    conversationKey,
    previewDigest,
    previewKind,
    transientSignature: digest("transient")
  };
}

function unreadRow(conversationKey, previewDigest, previewKind = "possible_hr_reply") {
  return { ...readRow(conversationKey, previewDigest, previewKind), unread: true };
}

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}
