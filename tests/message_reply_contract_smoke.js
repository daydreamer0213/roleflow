const assert = require("node:assert");
const {
  validateMessageReply
} = require("../src/core/message_reply_contract");
const {
  createMessageReplyAnalyzer
} = require("../src/core/message_reply_analyzer");
const { MockModelAdapter } = require("../src/adapters/models/mock");

const NOW = "2026-08-01T08:00:00.000Z";
const validFacts = [
  { key: "employment_status", value: "在职", updatedAt: "2026-08-01T00:00:00.000Z" },
  { key: "availability_date", value: "2026-08-15", updatedAt: "2026-08-01T00:00:00.000Z" }
];

function safeReply(overrides = {}) {
  return {
    messageCategory: "availability",
    requiredFactKeys: ["employment_status", "availability_date"],
    usedFactKeys: ["employment_status", "availability_date"],
    responseItems: [
      { id: "employment_status", kind: "question", required: true },
      { id: "availability_date", kind: "question", required: true }
    ],
    coverage: [
      { responseItemId: "employment_status", covered: true },
      { responseItemId: "availability_date", covered: true }
    ],
    missingFact: null,
    progressUpdate: {
      stage: "reply_ready",
      nextAction: "ignored provider text"
    },
    messages: ["complete draft"],
    ...overrides
  };
}

async function main() {
  const validated = validateMessageReply(safeReply(), { facts: validFacts, now: NOW });
  assert.deepStrictEqual(validated.progressUpdate, {
    stage: "reply_ready",
    nextAction: "Review draft before manual send"
  });
  assert.deepStrictEqual(validated.messages, ["complete draft"]);

  assert.throws(
    () => validateMessageReply(safeReply({ responseItems: [{ id: "PRIVATE_HR_RAW_TEXT", kind: "question", required: true }] }), { facts: validFacts, now: NOW }),
    (error) => error.code === "MESSAGE_REPLY_UNKNOWN_FACT"
  );
  assert.throws(
    () => validateMessageReply(safeReply({ coverage: [{ responseItemId: "missing-item", covered: true }] }), { facts: validFacts, now: NOW }),
    (error) => error.code === "MESSAGE_REPLY_COVERAGE_INVALID"
  );
  assert.throws(
    () => validateMessageReply(safeReply({ coverage: [
      { responseItemId: "employment_status", covered: false },
      { responseItemId: "availability_date", covered: true }
    ] }), { facts: validFacts, now: NOW }),
    (error) => error.code === "MESSAGE_REPLY_COVERAGE_INCOMPLETE"
  );
  assert.throws(
    () => validateMessageReply(safeReply({ usedFactKeys: ["expected_salary"] }), { facts: validFacts, now: NOW }),
    (error) => error.code === "MESSAGE_REPLY_FACT_NOT_SUPPLIED"
  );
  assert.throws(
    () => validateMessageReply(safeReply({ messages: ["one", "two", "three"] }), { facts: validFacts, now: NOW }),
    (error) => error.code === "MESSAGE_REPLY_DRAFT_LIMIT"
  );
  assert.throws(
    () => validateMessageReply(safeReply({ messageCategory: "interview_invitation", messages: ["draft"] }), { facts: validFacts, now: NOW }),
    (error) => error.code === "MESSAGE_REPLY_INTERVIEW_NO_DRAFT"
  );

  const expired = [
    { key: "employment_status", value: "在职", updatedAt: "2026-07-01T00:00:00.000Z" },
    { key: "availability_date", value: "2026-08-15", updatedAt: "2026-08-01T00:00:00.000Z" }
  ];
  assert.throws(
    () => validateMessageReply(safeReply(), { facts: expired, now: NOW }),
    (error) => error.code === "MESSAGE_REPLY_FACT_UNVERIFIED"
  );
  const withoutDate = validateMessageReply(safeReply({
    usedFactKeys: [],
    responseItems: [{ id: "employment_status", kind: "question", required: true }],
    coverage: [{ responseItemId: "employment_status", covered: true }],
    messages: []
  }), { facts: [expired[0]], now: NOW });
  assert.strictEqual(withoutDate.progressUpdate.stage, "needs_user_action");

  const stableFacts = [
    { key: "gap.2024-03_2024-08", value: "自主探索", subjectKey: "2024-03_2024-08", updatedAt: "2026-07-01T00:00:00.000Z" }
  ];
  const stablePass = validateMessageReply({
    messageCategory: "qualification",
    requiredFactKeys: ["gap.2024-03_2024-08"],
    usedFactKeys: ["gap.2024-03_2024-08"],
    responseItems: [{ id: "gap.2024-03_2024-08", kind: "statement", required: true }],
    coverage: [{ responseItemId: "gap.2024-03_2024-08", covered: true }],
    missingFact: null,
    messages: ["stable scoped draft"]
  }, { facts: stableFacts, now: NOW, requestedSubjectKeys: ["2024-03_2024-08"] });
  assert.strictEqual(stablePass.progressUpdate.stage, "reply_ready");
  assert.throws(
    () => validateMessageReply({
      messageCategory: "qualification",
      requiredFactKeys: [],
      usedFactKeys: ["gap.2024-03_2024-08"],
      responseItems: [],
      coverage: [],
      missingFact: null,
      messages: ["stable scoped draft"]
    }, {
      facts: stableFacts,
      now: NOW,
      requestedSubjectKeys: ["2025-01_2025-06"]
    }),
    (error) => error.code === "MESSAGE_REPLY_FACT_UNVERIFIED",
    "used stable facts must be scope-checked even when the provider omits them from requiredFactKeys"
  );
  assert.throws(
    () => validateMessageReply({
      messageCategory: "qualification",
      requiredFactKeys: ["gap.2024-03_2024-08"],
      usedFactKeys: ["gap.2024-03_2024-08"],
      responseItems: [{ id: "gap.2024-03_2024-08", kind: "statement", required: true }],
      coverage: [{ responseItemId: "gap.2024-03_2024-08", covered: true }],
      missingFact: null,
      messages: ["stable scoped draft"]
    }, { facts: stableFacts, now: NOW }),
    (error) => error.code === "MESSAGE_REPLY_FACT_UNVERIFIED",
    "stable facts must fail closed when the requested subject scope is unknown"
  );
  assert.throws(
    () => validateMessageReply({
      messageCategory: "qualification",
      requiredFactKeys: ["gap.2024-03_2024-08"],
      usedFactKeys: ["gap.2024-03_2024-08"],
      responseItems: [{ id: "gap.2024-03_2024-08", kind: "statement", required: true }],
      coverage: [{ responseItemId: "gap.2024-03_2024-08", covered: true }],
      missingFact: null,
      messages: ["stable scoped draft"]
    }, { facts: stableFacts, now: NOW, requestedSubjectKeys: ["2025-01_2025-06"] }),
    (error) => error.code === "MESSAGE_REPLY_FACT_UNVERIFIED"
  );
  assert.throws(
    () => validateMessageReply({
      messageCategory: "qualification",
      requiredFactKeys: ["gap.2025-01_2025-06"],
      usedFactKeys: ["gap.2025-01_2025-06"],
      responseItems: [{ id: "gap.2025-01_2025-06", kind: "statement", required: true }],
      coverage: [{ responseItemId: "gap.2025-01_2025-06", covered: true }],
      missingFact: null,
      messages: ["wrong scoped draft"]
    }, { facts: stableFacts, now: NOW }),
    (error) => error.code === "MESSAGE_REPLY_FACT_NOT_SUPPLIED",
    "a required stable scoped key must not reuse a fact from a different subject period"
  );

  const analyzer = createMessageReplyAnalyzer({ adapter: new MockModelAdapter() });
  const messages = [{ messageKey: "sha256:" + "a".repeat(64), text: "什么时候可以到岗？" }];
  const analyzed = await analyzer({
    profile: { id: 1 },
    job: { id: 2, title: "Java Engineer" },
    messages,
    facts: validFacts,
    now: NOW
  });
  assert.strictEqual(analyzed.messageCategory, "availability");
  assert.strictEqual(analyzed.progressUpdate.stage, "reply_ready");
  assert.strictEqual(messages[0].text, "", "analyzer must clear ephemeral message text");

  const storedShapeAnalyzer = createMessageReplyAnalyzer({ adapter: new MockModelAdapter() });
  const storedMessages = [{ messageKey: "sha256:" + "c".repeat(64), text: "什么时候可以到岗？" }];
  const storedShapeAnalyzed = await storedShapeAnalyzer({
    profile: { id: 1 },
    job: { id: 2, title: "Java Engineer" },
    messages: storedMessages,
    facts: [
      { factKey: "employment_status", factValue: "在职", source: "user_provided", updatedAt: "2026-08-01T00:00:00.000Z" },
      { factKey: "availability_date", factValue: "2026-08-15", source: "user_provided", updatedAt: "2026-08-01T00:00:00.000Z" }
    ],
    now: NOW
  });
  assert.strictEqual(
    storedShapeAnalyzed.progressUpdate.stage,
    "reply_ready",
    "storage-shaped facts must be normalized before the reply contract"
  );

  let stableAdapterInput;
  const stableAdapter = {
    async draftMessageGroup(input) {
      stableAdapterInput = input;
      return {
        messageCategory: "qualification",
        requiredFactKeys: ["gap.2024-03_2024-08"],
        usedFactKeys: ["gap.2024-03_2024-08"],
        responseItems: [{ id: "gap.2024-03_2024-08", kind: "statement", required: true }],
        coverage: [{ responseItemId: "gap.2024-03_2024-08", covered: true }],
        missingFact: null,
        messages: ["stable scoped draft"]
      };
    }
  };
  const scopedAnalyzer = createMessageReplyAnalyzer({ adapter: stableAdapter });
  const scopedMessages = [{
    messageKey: "sha256:" + "d".repeat(64),
    text: "Please explain gap 2024-03_2024-08."
  }];
  const scopedResult = await scopedAnalyzer({
    profile: { candidate: { targetTitles: ["Java Engineer"] } },
    job: { id: 2, title: "Java Engineer" },
    messages: scopedMessages,
    facts: [
      ...stableFacts,
      { key: "gap.2025-01_2025-06", value: "unrelated", subjectKey: "2025-01_2025-06", updatedAt: "2026-07-01T00:00:00.000Z" },
      { key: "employment_status", value: "available", updatedAt: "2026-08-01T00:00:00.000Z" }
    ],
    now: NOW
  });
  assert.strictEqual(scopedResult.progressUpdate.stage, "reply_ready");
  assert.deepStrictEqual(
    stableAdapterInput.facts.map((fact) => fact.key),
    ["gap.2024-03_2024-08", "employment_status"],
    "out-of-scope stable facts must be removed before the model call"
  );
  await assert.rejects(
    () => scopedAnalyzer({
      profile: { candidate: { targetTitles: ["Java Engineer"] } },
      job: { id: 2, title: "Java Engineer" },
      messages: [{
        messageKey: "sha256:" + "e".repeat(64),
        text: "Please explain the employment gap."
      }],
      facts: stableFacts,
      now: NOW
    }),
    (error) => error.code === "MESSAGE_REPLY_FACT_NOT_SUPPLIED",
    "analyzer must not use a stable fact when the recruiter message does not establish its subject"
  );

  console.log("message_reply_contract_smoke ok");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
