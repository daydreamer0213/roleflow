const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDb } = require("../src/core/storage");
const {
  ensureProgressCard,
  listProgressEvents,
  transitionProgressCard
} = require("../src/core/candidate_progress");
const { safeDigest } = require("../src/adapters/sites/boss_message_dom");
const { runBossMessageDiscovery } = require("../src/core/message_discovery");
const { factStatus } = require("../src/core/candidate_fact_policy");

const PRIVATE_BODY = "PRIVATE_HR_BODY";
const PRIVATE_PREVIEW = "PRIVATE_CONVERSATION_PREVIEW";
const PRIVATE_RECRUITER = "PRIVATE_RECRUITER_NAME";
const PRIVATE_DRAFT = "PRIVATE_REPLY_DRAFT";
const NOW = "2026-07-30T01:00:00.000Z";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-message-discovery-"));
let db;

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  try { db?.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
});

async function main() {
  db = openDb(path.join(root, "message-discovery.sqlite"));
  factPolicySmoke();
  await uniqueCandidateAndPrivacySmoke();
  await unsafeModelPersistenceSmoke();
  await identityStopsSmoke();
  await messageSelectionSmoke();
  await messageGroupBoundarySmoke();
  await classificationOutcomeSmoke();
  await readerStopSmoke();
  await abortAfterClassificationSmoke();
  await pacingAndInterruptSmoke();
  console.log("message_discovery_smoke ok");
}

function factPolicySmoke() {
  assert.strictEqual(factStatus(NOW, fact("employment_status", 6)).status, "valid");
  assert.strictEqual(factStatus(NOW, fact("employment_status", 8)).status, "expired");
  assert.strictEqual(factStatus(NOW, fact("gap.2024-03_2024-08", 400)).status, "valid");
  assert.strictEqual(factStatus(NOW, fact("leaving_reason.company-17", 400)).status, "valid");
  assert.strictEqual(factStatus(NOW, fact("short_project.project-9", 400)).status, "valid");
}

async function uniqueCandidateAndPrivacySmoke() {
  const fixture = createFixture({ suffix: "unique", title: "Java Engineer" });
  const selected = selectedConversation({ title: fixture.title });
  const logs = [];
  let modelCalls = 0;
  const summary = await runBossMessageDiscovery({
    db,
    profileId: fixture.profileId,
    reader: fakeReader([selected]),
    classifyMessageGroup: async ({ card, job, messages }) => {
      modelCalls += 1;
      assert.strictEqual(card.id, fixture.card.id);
      assert.strictEqual(card.profileId, fixture.profileId);
      assert.strictEqual(job.title, "Java Engineer");
      assert.deepStrictEqual(messages.map((item) => item.text), [PRIVATE_BODY]);
      const result = classification({
        messageCategory: "qualification",
        stage: "reply_ready",
        messages: [PRIVATE_DRAFT]
      });
      result.progressUpdate.nextAction = `${PRIVATE_BODY} ${PRIVATE_RECRUITER} ${PRIVATE_DRAFT}`;
      return result;
    },
    logger: { info: (...args) => logs.push(args) },
    now: () => NOW,
    sleepFn: async () => {}
  });
  assert.strictEqual(modelCalls, 1);
  assert.strictEqual(summary.status, "completed");
  assert.strictEqual(summary.processed, 1);
  assert.deepStrictEqual(summary.results[0].messages, [PRIVATE_DRAFT]);
  assert.strictEqual(summary.results[0].stage, "reply_ready");
  assert.strictEqual(
    db.prepare("SELECT next_action FROM candidate_progress_cards WHERE id = ?").get(fixture.card.id).next_action,
    "Review draft before manual send"
  );

  const persisted = [
    allText(db, "candidate_progress_cards"),
    allText(db, "candidate_progress_events")
  ].join("\n");
  const logged = JSON.stringify(logs);
  for (const forbidden of [
    PRIVATE_BODY,
    PRIVATE_PREVIEW,
    PRIVATE_RECRUITER,
    PRIVATE_DRAFT,
    "123456789012345"
  ]) {
    assert(!persisted.includes(forbidden), `${forbidden} must not be persisted`);
    assert(!logged.includes(forbidden), `${forbidden} must not be logged`);
  }

  const repeat = await runBossMessageDiscovery({
    db,
    profileId: fixture.profileId,
    reader: fakeReader([selectedConversation({ title: fixture.title })]),
    classifyMessageGroup: async () => {
      throw new Error("an existing message must not call the model");
    },
    sleepFn: async () => {}
  });
  assert.strictEqual(repeat.status, "completed");
  assert.strictEqual(repeat.processed, 0);
  assert.strictEqual(
    listProgressEvents(db, fixture.card.id).length,
    2,
    "one message event plus one group event must remain idempotent"
  );
}

async function unsafeModelPersistenceSmoke() {
  const fixture = createFixture({ suffix: "unsafe-model", title: "Unsafe Model Engineer" });
  const logs = [];
  await assert.rejects(
    () => runBossMessageDiscovery({
      db,
      profileId: fixture.profileId,
      reader: fakeReader([selectedConversation({
        title: fixture.title,
        messageId: "123456789012346"
      })]),
      classifyMessageGroup: async () => ({
        ...classification({ stage: "needs_user_action", messages: [] }),
        missingFact: {
          key: `${PRIVATE_BODY} ${PRIVATE_RECRUITER} ${PRIVATE_DRAFT}`,
          question: "redacted"
        },
        progressUpdate: {
          stage: "needs_user_action",
          nextAction: `${PRIVATE_BODY} ${PRIVATE_RECRUITER} ${PRIVATE_DRAFT}`,
          summary: "sanitized"
        }
      }),
      logger: { info: (...args) => logs.push(args) }
    }),
    (error) => error.code === "PROGRESS_MISSING_FACT_KEY_INVALID"
  );
  const card = db.prepare(`SELECT thread_key, stage, next_action
    FROM candidate_progress_cards WHERE id = ?`).get(fixture.card.id);
  assert.deepStrictEqual({ ...card }, {
    thread_key: "",
    stage: "contact_started",
    next_action: ""
  });
  assert.strictEqual(listProgressEvents(db, fixture.card.id).length, 0);
  const persisted = [
    allText(db, "candidate_progress_cards"),
    allText(db, "candidate_progress_events")
  ].join("\n");
  const logged = JSON.stringify(logs);
  for (const forbidden of [PRIVATE_BODY, PRIVATE_RECRUITER, PRIVATE_DRAFT]) {
    assert(!persisted.includes(forbidden), `${forbidden} must not be persisted`);
    assert(!logged.includes(forbidden), `${forbidden} must not be logged`);
  }
}

async function identityStopsSmoke() {
  let modelCalls = 0;
  const classifyMessageGroup = async () => {
    modelCalls += 1;
    return classification();
  };

  const noMatch = createFixture({ suffix: "no-match", title: "Backend Engineer" });
  let summary = await runBossMessageDiscovery({
    db,
    profileId: noMatch.profileId,
    reader: fakeReader([selectedConversation({ title: "Unknown Engineer" })]),
    classifyMessageGroup
  });
  assertStopped(summary, "BOSS_MESSAGE_CARD_NOT_FOUND");

  const ambiguous = createFixture({ suffix: "ambiguous-a", title: "Same Engineer" });
  createFixture({
    suffix: "ambiguous-b",
    title: "Same Engineer",
    profileId: ambiguous.profileId,
    planId: ambiguous.planId
  });
  summary = await runBossMessageDiscovery({
    db,
    profileId: ambiguous.profileId,
    reader: fakeReader([selectedConversation({ title: " same   engineer " })]),
    classifyMessageGroup
  });
  assertStopped(summary, "BOSS_MESSAGE_CARD_AMBIGUOUS");

  const salary = createFixture({ suffix: "salary", title: "Salary Engineer", salary: "20-30K" });
  summary = await runBossMessageDiscovery({
    db,
    profileId: salary.profileId,
    reader: fakeReader([selectedConversation({ title: salary.title, salary: "30-40K" })]),
    classifyMessageGroup
  });
  assertStopped(summary, "BOSS_MESSAGE_SALARY_MISMATCH");

  const city = createFixture({ suffix: "city", title: "City Engineer", city: "Guangzhou" });
  summary = await runBossMessageDiscovery({
    db,
    profileId: city.profileId,
    reader: fakeReader([selectedConversation({ title: city.title, city: "Shenzhen" })]),
    classifyMessageGroup
  });
  assertStopped(summary, "BOSS_MESSAGE_CITY_MISMATCH");

  const company = createFixture({ suffix: "company", title: "Company Engineer" });
  summary = await runBossMessageDiscovery({
    db,
    profileId: company.profileId,
    reader: fakeReader([selectedConversation({ title: company.title, companyName: "Different Company" })]),
    classifyMessageGroup
  });
  assertStopped(summary, "BOSS_MESSAGE_COMPANY_MISMATCH");

  const thread = createFixture({ suffix: "thread", title: "Thread Engineer" });
  db.prepare("UPDATE candidate_progress_cards SET thread_key = ? WHERE id = ?")
    .run(safeDigest(["boss", "another recruiter", thread.title]), thread.card.id);
  summary = await runBossMessageDiscovery({
    db,
    profileId: thread.profileId,
    reader: fakeReader([selectedConversation({ title: thread.title })]),
    classifyMessageGroup
  });
  assertStopped(summary, "BOSS_MESSAGE_THREAD_MISMATCH");
  assert.strictEqual(modelCalls, 0, "identity failures must not call the model");
}

async function messageSelectionSmoke() {
  const fixture = createFixture({ suffix: "group", title: "Group Engineer" });
  let modelCalls = 0;
  const summary = await runBossMessageDiscovery({
    db,
    profileId: fixture.profileId,
    reader: fakeReader([selectedConversation({
      title: fixture.title,
      messages: [
        message("friend", "123456789012340", "old question"),
        message("myself", "123456789012341", "old reply"),
        message("friend", "123456789012342", "question one"),
        message("friend", "123456789012343", "question two")
      ]
    })]),
    classifyMessageGroup: async ({ messages }) => {
      modelCalls += 1;
      assert.deepStrictEqual(messages.map((item) => item.text), ["question one", "question two"]);
      assert.match(messages[0].messageKey, /^sha256:[a-f0-9]{64}$/);
      return classification();
    }
  });
  assert.strictEqual(summary.status, "completed");
  assert.strictEqual(summary.processed, 1);
  assert.strictEqual(modelCalls, 1);
}

async function messageGroupBoundarySmoke() {
  const overLimit = createFixture({ suffix: "group-limit", title: "Group Limit Engineer" });
  const limitSummary = await runBossMessageDiscovery({
    db,
    profileId: overLimit.profileId,
    reader: fakeReader([selectedConversation({
      title: overLimit.title,
      messages: Array.from({ length: 6 }, (_, index) => message("friend", String(500000000000000 + index), `question ${index}`))
    })]),
    classifyMessageGroup: async () => {
      throw new Error("over-limit groups must not call the model");
    }
  });
  assertStopped(limitSummary, "BOSS_MESSAGE_GROUP_LIMIT");

  const unsupported = createFixture({ suffix: "group-unsupported", title: "Group Unsupported Engineer" });
  const unsupportedSummary = await runBossMessageDiscovery({
    db,
    profileId: unsupported.profileId,
    reader: fakeReader([selectedConversation({
      title: unsupported.title,
      messages: [{
        direction: "friend",
        messageId: "600000000000000",
        text: "voice",
        contentKind: "voice"
      }]
    })]),
    classifyMessageGroup: async () => {
      throw new Error("unsupported content must not call the model");
    }
  });
  assertStopped(unsupportedSummary, "BOSS_MESSAGE_CONTENT_UNSUPPORTED");

  const repeated = createFixture({ suffix: "group-repeated", title: "Group Repeated Engineer" });
  const firstSummary = await runBossMessageDiscovery({
    db,
    profileId: repeated.profileId,
    reader: fakeReader([selectedConversation({
      title: repeated.title,
      messageId: "700000000000000"
    })]),
    classifyMessageGroup: async () => classification(),
    sleepFn: async () => {}
  });
  assert.strictEqual(firstSummary.processed, 1);
  const repeatSummary = await runBossMessageDiscovery({
    db,
    profileId: repeated.profileId,
    reader: fakeReader([selectedConversation({
      title: repeated.title,
      messageId: "700000000000000"
    })]),
    classifyMessageGroup: async () => {
      throw new Error("processed messages must not call the model");
    },
    sleepFn: async () => {}
  });
  assert.strictEqual(repeatSummary.status, "completed");
  assert.strictEqual(repeatSummary.processed, 0);

  const mixed = createFixture({ suffix: "group-mixed", title: "Group Mixed Engineer" });
  let mixedModelTexts = null;
  const mixedSummary = await runBossMessageDiscovery({
    db,
    profileId: mixed.profileId,
    reader: fakeReader([selectedConversation({
      title: mixed.title,
      messages: [
        message("friend", "800000000000000", "old already processed"),
        message("friend", "800000000000001", "new follow-up")
      ]
    })]),
    classifyMessageGroup: async ({ messages }) => {
      mixedModelTexts = messages.map((item) => item.text);
      return classification();
    }
  });
  assert.strictEqual(mixedSummary.processed, 1);
  assert.deepStrictEqual(mixedModelTexts, ["old already processed", "new follow-up"]);

  const systemOnly = createFixture({ suffix: "group-system", title: "Group System Engineer" });
  const systemSummary = await runBossMessageDiscovery({
    db,
    profileId: systemOnly.profileId,
    reader: fakeReader([selectedConversation({
      title: systemOnly.title,
      messages: [message("system", "900000000000000", "对方已同意，您的附件简历已发送给对方")]
    })]),
    classifyMessageGroup: async () => {
      throw new Error("system notices must not become HR questions");
    }
  });
  assert.strictEqual(systemSummary.status, "completed");
  assert.strictEqual(systemSummary.processed, 0);
}

async function classificationOutcomeSmoke() {
  const missing = createFixture({ suffix: "missing", title: "Missing Engineer" });
  let summary = await runBossMessageDiscovery({
    db,
    profileId: missing.profileId,
    reader: fakeReader([selectedConversation({ title: missing.title, messageId: "123456789012350" })]),
    classifyMessageGroup: async () => ({
      ...classification({ stage: "needs_user_action", messages: [] }),
      missingFact: { key: "project_status", question: "Confirm project status" }
    })
  });
  assert.strictEqual(summary.results[0].stage, "needs_user_action");
  assert.strictEqual(summary.results[0].missingFactKey, "project_status");
  assert.deepStrictEqual(summary.results[0].messages, []);

  const interview = createFixture({ suffix: "interview", title: "Interview Engineer" });
  summary = await runBossMessageDiscovery({
    db,
    profileId: interview.profileId,
    reader: fakeReader([selectedConversation({ title: interview.title, messageId: "123456789012351" })]),
    classifyMessageGroup: async () => classification({
      messageCategory: "interview_invitation",
      stage: "interview_invited",
      messages: [PRIVATE_DRAFT]
    })
  });
  assert.strictEqual(summary.results[0].stage, "interview_invited");
  assert.deepStrictEqual(summary.results[0].messages, []);
}

async function readerStopSmoke() {
  const fixture = createFixture({ suffix: "reader-stop", title: "Reader Stop Engineer" });
  for (const code of [
    "BOSS_MESSAGE_RISK_CONTROL",
    "BOSS_MESSAGE_LOGIN_REQUIRED",
    "BOSS_MESSAGE_PAGE_LOST"
  ]) {
    const calls = [];
    const error = Object.assign(new Error("redacted reader stop"), { code });
    const reader = {
      async scanUnread() {
        return { queue: Object.freeze([{ index: 0 }, { index: 1 }]) };
      },
      async openQueuedConversation(target) {
        calls.push(target.index);
        throw error;
      }
    };
    const summary = await runBossMessageDiscovery({
      db,
      profileId: fixture.profileId,
      reader,
      classifyMessageGroup: async () => {
        throw new Error("reader failures must stop before model use");
      }
    });
    assertStopped(summary, code);
    assert.deepStrictEqual(calls, [0], "reader failure must stop the immutable queue");
  }
}

async function abortAfterClassificationSmoke() {
  for (const [suffix, code] of [
    ["classification-abort", "MESSAGE_DISCOVERY_STOPPED"],
    ["classification-lease", "MESSAGE_DISCOVERY_LEASE_LOST"]
  ]) {
    const fixture = createFixture({ suffix, title: `${suffix} Engineer` });
    const controller = new AbortController();
    const reason = Object.assign(new Error(code), { code });
    const statuses = [];
    let releaseClassification;
    let markClassificationStarted;
    const classificationStarted = new Promise((resolve) => {
      markClassificationStarted = resolve;
    });
    const pendingClassification = new Promise((resolve) => {
      releaseClassification = resolve;
    });
    const run = runBossMessageDiscovery({
      db,
      profileId: fixture.profileId,
      reader: fakeReader([selectedConversation({
        title: fixture.title,
        messageId: code === "MESSAGE_DISCOVERY_STOPPED"
          ? "123456789012370"
          : "123456789012371"
      })]),
      classifyMessageGroup: async () => {
        markClassificationStarted();
        return pendingClassification;
      },
      signal: controller.signal,
      onStatus: (status) => statuses.push(status)
    });
    const rejected = assert.rejects(run, (error) => error === reason);
    await classificationStarted;
    controller.abort(reason);
    releaseClassification(classification());
    await rejected;
    const card = db.prepare(`SELECT thread_key, stage, next_action
      FROM candidate_progress_cards WHERE id = ?`).get(fixture.card.id);
    assert.deepStrictEqual({ ...card }, {
      thread_key: "",
      stage: "contact_started",
      next_action: ""
    });
    assert.strictEqual(listProgressEvents(db, fixture.card.id).length, 0);
    assert(!statuses.some((status) => status.status === "completed"));
  }
}

async function pacingAndInterruptSmoke() {
  const pacing = createFixture({ suffix: "pacing", title: "Pacing Engineer" });
  const conversations = Array.from({ length: 11 }, (_, index) => selectedConversation({
    title: pacing.title,
    messageId: String(100000000000000 + index)
  }));
  const waits = [];
  const summary = await runBossMessageDiscovery({
    db,
    profileId: pacing.profileId,
    reader: fakeReader(conversations),
    classifyMessageGroup: async () => classification(),
    sleepFn: async (ms) => waits.push(ms),
    randomFn: () => 0
  });
  assert.strictEqual(summary.processed, 11);
  assert.deepStrictEqual(waits, [
    1500, 1500, 1500, 1500, 1500,
    1500, 1500, 1500, 1500, 1500,
    15000
  ]);

  const mixed = createFixture({ suffix: "mixed-pacing", title: "Mixed Pacing Engineer" });
  const duplicateId = "123456789012380";
  const mixedConversations = [
    selectedConversation({ title: mixed.title, messageId: duplicateId }),
    selectedConversation({ title: mixed.title, messageId: duplicateId }),
    { skipped: true, reasonCode: "BOSS_MESSAGE_NO_LONGER_UNREAD" },
    ...Array.from({ length: 8 }, (_, index) => selectedConversation({
      title: mixed.title,
      messageId: String(300000000000000 + index)
    }))
  ];
  const mixedWaits = [];
  let mixedModelCalls = 0;
  const mixedSummary = await runBossMessageDiscovery({
    db,
    profileId: mixed.profileId,
    reader: fakeReader(mixedConversations),
    classifyMessageGroup: async () => {
      mixedModelCalls += 1;
      return classification();
    },
    sleepFn: async (ms) => mixedWaits.push(ms),
    randomFn: () => 0
  });
  assert.strictEqual(mixedSummary.processed, 9);
  assert.strictEqual(mixedModelCalls, 9);
  assert.deepStrictEqual(mixedWaits, [
    1500, 1500, 1500, 1500, 1500,
    1500, 1500, 1500, 1500, 1500,
    15000
  ]);

  const abortFixture = createFixture({ suffix: "abort", title: "Abort Engineer" });
  const abortController = new AbortController();
  const abortReason = Object.assign(new Error("aborted during pacing"), { code: "MESSAGE_DISCOVERY_STOPPED" });
  await assert.rejects(
    () => runBossMessageDiscovery({
      db,
      profileId: abortFixture.profileId,
      reader: fakeReader([
        selectedConversation({ title: abortFixture.title, messageId: "123456789012360" }),
        selectedConversation({ title: abortFixture.title, messageId: "123456789012361" })
      ]),
      classifyMessageGroup: async () => classification(),
      signal: abortController.signal,
      sleepFn: async () => {
        abortController.abort(abortReason);
        throw abortReason;
      }
    }),
    (error) => error === abortReason
  );

  const leaseFixture = createFixture({ suffix: "lease", title: "Lease Engineer" });
  const leaseController = new AbortController();
  const leaseReason = Object.assign(new Error("lease lost"), { code: "MESSAGE_DISCOVERY_LEASE_LOST" });
  let randomWaits = 0;
  await assert.rejects(
    () => runBossMessageDiscovery({
      db,
      profileId: leaseFixture.profileId,
      reader: fakeReader(Array.from({ length: 11 }, (_, index) => selectedConversation({
        title: leaseFixture.title,
        messageId: String(200000000000000 + index)
      }))),
      classifyMessageGroup: async () => classification(),
      signal: leaseController.signal,
      randomFn: () => 0,
      sleepFn: async (ms) => {
        if (ms !== 15000) {
          randomWaits += 1;
          return;
        }
        leaseController.abort(leaseReason);
        throw leaseReason;
      }
    }),
    (error) => error === leaseReason
  );
  assert.strictEqual(randomWaits, 10);
}

function createFixture({
  suffix,
  profileId = null,
  planId = null,
  title,
  salary = "20-30K",
  city = "Guangzhou",
  company = "Fixture Company"
}) {
  if (!profileId) {
    profileId = Number(db.prepare(`INSERT INTO candidate_profiles(
      display_name, profile_json, source_hash, created_at, updated_at
    ) VALUES (?, '{}', NULL, ?, ?)`).run(`Candidate ${suffix}`, NOW, NOW).lastInsertRowid);
  }
  if (!planId) {
    planId = Number(db.prepare(`INSERT INTO search_plans(
      profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
    ) VALUES (?, ?, '{}', NULL, 1, ?, ?)`).run(profileId, `Plan ${suffix}`, NOW, NOW).lastInsertRowid);
  }
  const jobId = Number(db.prepare(`INSERT INTO jobs(
    source, source_id, title, company, location, salary, first_seen_at, last_seen_at
  ) VALUES ('boss', ?, ?, ?, ?, ?, ?, ?)`)
    .run(`job-${suffix}`, title, company, city, salary, NOW, NOW).lastInsertRowid);
  const card = ensureProgressCard(db, { profileId, planId, jobId, source: "boss", now: NOW });
  return { profileId, planId, jobId, card, title, salary, city, company };
}

function selectedConversation({
  title,
  salary = "20-30K",
  city = "Guangzhou",
  companyName = "Fixture Company",
  messageId = "123456789012345",
  messages = null
}) {
  return {
    skipped: false,
    path: "/web/geek/chat",
    headerText: PRIVATE_RECRUITER,
    positionName: title,
    salary,
    city,
    companyName,
    risk: false,
    login: false,
    rows: [{
      rowIndex: 0,
      unread: true,
      selected: true,
      recruiterLabel: PRIVATE_RECRUITER,
      previewText: PRIVATE_PREVIEW
    }],
    messages: messages || [message("friend", messageId, PRIVATE_BODY)]
  };
}

function message(direction, messageId, text) {
  return { direction, messageId, text };
}

function fact(key, daysAgo) {
  const at = new Date(Date.parse(NOW) - daysAgo * 86_400_000).toISOString();
  return { key, value: "confirmed", source: "user_provided", updatedAt: at };
}

function fakeReader(conversations) {
  let active = 0;
  let maxActive = 0;
  return {
    async scanUnread() {
      return {
        queue: Object.freeze(conversations.map((_, index) => Object.freeze({ index })))
      };
    },
    async openQueuedConversation(target) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      assert.strictEqual(maxActive, 1, "message discovery must remain serial");
      const selected = conversations[target.index];
      active -= 1;
      return selected;
    }
  };
}

function classification({
  messageCategory = "qualification",
  stage = "reply_ready",
  messages = ["safe draft"]
} = {}) {
  return {
    kind: "hr_reply",
    messageCategory,
    missingFact: null,
    progressUpdate: { stage, nextAction: "Review before manual send", summary: "sanitized" },
    messages
  };
}

function assertStopped(summary, reasonCode) {
  assert.strictEqual(summary.status, "needs_user_action");
  assert.strictEqual(summary.reasonCode, reasonCode);
  assert.strictEqual(summary.processed, 0);
}

function allText(database, table) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all()
    .filter((column) => String(column.type).toUpperCase().includes("TEXT"))
    .map((column) => `"${column.name}"`);
  return JSON.stringify(database.prepare(`SELECT ${columns.join(", ")} FROM ${table}`).all());
}
