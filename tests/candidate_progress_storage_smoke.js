const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDb } = require("../src/core/storage");
const {
  ensureProgressCard,
  recordDiscoveredMessageClassification,
  recordDiscoveredMessageGroupClassification,
  getProgressCardForJob,
  listProgressEvents
} = require("../src/core/candidate_progress");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-candidate-progress-"));
let db;

try {
  db = openDb(path.join(root, "progress.sqlite"));
  const now = "2026-07-23T08:00:00.000Z";
  const fixture = createFixture(db, "progress", now);

  const first = ensureProgressCard(db, {
    profileId: fixture.profileId,
    planId: fixture.planId,
    jobId: fixture.jobId,
    source: "boss",
    now
  });
  const second = ensureProgressCard(db, {
    profileId: fixture.profileId,
    planId: fixture.planId,
    jobId: fixture.jobId,
    source: "boss",
    now
  });
  assert.strictEqual(first.id, second.id);
  assert.strictEqual(first.stage, "contact_started");

  const recorded = recordDiscoveredMessageClassification(db, {
    cardId: first.id,
    platform: "boss",
    threadKey: digest("thread"),
    messageKey: digest("message"),
    messageCategory: "availability",
    missingFactKey: "",
    progressUpdate: {
      stage: "reply_ready",
      nextAction: "untrusted model text"
    },
    occurredAt: now
  });
  assert.strictEqual(recorded.stage, "reply_ready");
  assert.strictEqual(recorded.nextAction, "Review draft before manual send");
  assert.strictEqual(listProgressEvents(db, first.id).length, 1);

  const repeated = recordDiscoveredMessageClassification(db, {
    cardId: first.id,
    platform: "boss",
    threadKey: digest("thread"),
    messageKey: digest("message"),
    messageCategory: "availability",
    missingFactKey: "",
    progressUpdate: {
      stage: "reply_ready",
      nextAction: "different untrusted text"
    },
    occurredAt: now
  });
  assert.strictEqual(repeated.id, recorded.id);
  assert.strictEqual(listProgressEvents(db, first.id).length, 1);

  const rollbackFixture = createFixture(db, "rollback", now);
  const rollbackCard = ensureProgressCard(db, {
    ...rollbackFixture,
    source: "boss",
    now
  });
  assert.throws(
    () => recordDiscoveredMessageClassification(db, {
      cardId: rollbackCard.id,
      platform: "boss",
      threadKey: digest("rollback-thread"),
      messageKey: digest("rollback-message"),
      messageCategory: "availability",
      missingFactKey: "",
      progressUpdate: {
        stage: "interview_scheduled",
        nextAction: ""
      },
      occurredAt: "2026-07-23T08:01:00.000Z"
    }),
    (error) => error.code === "PROGRESS_STAGE_TRANSITION_INVALID"
  );
  assert.strictEqual(getProgressCardForJob(db, {
    profileId: rollbackFixture.profileId,
    jobId: rollbackFixture.jobId
  }).threadKey, "");
  assert.strictEqual(listProgressEvents(db, rollbackCard.id).length, 0);

  const groupFixture = createFixture(db, "group", now);
  const groupCard = ensureProgressCard(db, {
    ...groupFixture,
    source: "boss",
    now
  });
  const groupInput = {
    cardId: groupCard.id,
    platform: "boss",
    threadKey: digest("group-thread"),
    messageKeys: [digest("group-msg-1"), digest("group-msg-2")],
    messageGroupKey: digest("group"),
    messageCategory: "availability",
    missingFactKey: "",
    progressUpdate: {
      stage: "reply_ready",
      nextAction: "untrusted model text"
    },
    occurredAt: "2026-07-23T08:02:00.000Z"
  };
  const groupRecorded = recordDiscoveredMessageGroupClassification(db, groupInput);
  assert.strictEqual(groupRecorded.stage, "reply_ready");
  assert.strictEqual(groupRecorded.nextAction, "Review draft before manual send");
  assert.strictEqual(
    listProgressEvents(db, groupCard.id).length,
    3,
    "two message events plus one group event"
  );
  assert.strictEqual(recordDiscoveredMessageGroupClassification(db, groupInput).id, groupCard.id);
  assert.strictEqual(
    listProgressEvents(db, groupCard.id).length,
    3,
    "group retry must not duplicate events"
  );
  const groupRollbackFixture = createFixture(db, "group-rollback", now);
  const groupRollbackCard = ensureProgressCard(db, {
    ...groupRollbackFixture,
    source: "boss",
    now
  });
  assert.throws(
    () => recordDiscoveredMessageGroupClassification(db, {
      cardId: groupRollbackCard.id,
      platform: "boss",
      threadKey: digest("group-rollback-thread"),
      messageKeys: [digest("group-rollback-msg")],
      messageGroupKey: digest("group-rollback"),
      messageCategory: "availability",
      missingFactKey: "",
      progressUpdate: {
        stage: "interview_scheduled",
        nextAction: ""
      },
      occurredAt: "2026-07-23T08:03:00.000Z"
    }),
    (error) => error.code === "PROGRESS_STAGE_TRANSITION_INVALID"
  );
  assert.strictEqual(getProgressCardForJob(db, {
    profileId: groupRollbackFixture.profileId,
    jobId: groupRollbackFixture.jobId
  }).threadKey, "");
  assert.strictEqual(listProgressEvents(db, groupRollbackCard.id).length, 0);

  console.log("candidate_progress_storage_smoke ok");
} finally {
  try { db?.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}

function createFixture(database, suffix, now) {
  const profileId = Number(database.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES (?, '{}', NULL, ?, ?)`).run(`Candidate ${suffix}`, now, now).lastInsertRowid);
  const planId = Number(database.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, ?, '{}', NULL, 1, ?, ?)`).run(profileId, `Plan ${suffix}`, now, now).lastInsertRowid);
  const jobId = Number(database.prepare(`INSERT INTO jobs(
    source, source_id, title, first_seen_at, last_seen_at
  ) VALUES ('boss', ?, ?, ?, ?)`).run(`job-${suffix}`, `Job ${suffix}`, now, now).lastInsertRowid);
  return { profileId, planId, jobId };
}

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}
