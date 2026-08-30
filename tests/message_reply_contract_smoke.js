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
    messageIntent: "information_request",
    messageCategory: "availability",
    messageSummary: "对方正在确认候选人的到岗时间。",
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
  assert.strictEqual(validated.messageIntent, "information_request");
  assert.deepStrictEqual(validated.progressUpdate, {
    stage: "reply_ready",
    nextAction: "Review draft before manual send"
  });
  assert.deepStrictEqual(validated.messages, ["complete draft"]);
  const rawSummary = "请问你什么时候可以到岗？";
  const sanitizedSummary = validateMessageReply(safeReply({ messageSummary: rawSummary }), { facts: validFacts, now: NOW });
  assert.strictEqual(sanitizedSummary.messageSummary, "对方正在确认候选人的到岗时间。");
  assert.notStrictEqual(sanitizedSummary.messageSummary, rawSummary, "raw recruiter text must never become the durable message summary");
  const memoryContext = [{
    id: 7,
    questionSummary: "对方正在确认候选人的到岗时间。",
    messageIntent: "information_request",
    messageCategory: "availability",
    finalAnswer: "我已经离职，下周可以到岗。",
    scope: { kind: "global", key: "" },
    source: "user_edited_reply",
    withdrawnAt: ""
  }];
  assert.deepStrictEqual(
    validateMessageReply(safeReply({ usedMemoryIds: [7] }), {
      facts: validFacts,
      answerMemories: memoryContext,
      now: NOW
    }).usedMemoryIds,
    [7]
  );
  assert.throws(
    () => validateMessageReply(safeReply({ usedMemoryIds: [8] }), {
      facts: validFacts,
      answerMemories: memoryContext,
      now: NOW
    }),
    (error) => error.code === "MESSAGE_REPLY_MEMORY_NOT_SUPPLIED",
    "a model must not claim an answer memory that was not supplied"
  );
  assert.throws(
    () => validateMessageReply(safeReply({ messageIntent: "keyword_interview" }), { facts: validFacts, now: NOW }),
    (error) => error.code === "MESSAGE_REPLY_INTENT_INVALID"
  );

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
  const interview = validateMessageReply(safeReply({
    messageIntent: "interview_invitation",
    messageCategory: "other",
    messageSummary: "对方正式邀请候选人参加面试。",
    requiredFactKeys: [],
    usedFactKeys: [],
    responseItems: [],
    coverage: [],
    messages: ["您好，我确认明天下午三点参加视频面试。"]
  }), { facts: validFacts, now: NOW });
  assert.deepStrictEqual(interview.messages, ["您好，感谢邀请，请问面试时间和形式如何安排？"]);
  assert.strictEqual(interview.progressUpdate.stage, "interview_invited");
  const interviewWithoutProviderDraft = validateMessageReply(safeReply({
    messageIntent: "interview_invitation",
    messageCategory: "other",
    messageSummary: "对方正式邀请候选人参加面试。",
    requiredFactKeys: [],
    usedFactKeys: [],
    responseItems: [],
    coverage: [],
    messages: []
  }), { facts: validFacts, now: NOW });
  assert.deepStrictEqual(
    interviewWithoutProviderDraft.messages,
    ["您好，感谢邀请，请问面试时间和形式如何安排？"],
    "a valid interview result must always receive the deterministic local non-committal draft"
  );
  const interviewWithSalary = validateMessageReply(safeReply({
    messageIntent: "interview_invitation",
    messageCategory: "salary",
    messageSummary: "对方邀请候选人参加面试，同时询问薪资口径。",
    requiredFactKeys: [],
    usedFactKeys: [],
    responseItems: [],
    coverage: [],
    messages: []
  }), { facts: [], now: NOW });
  assert.strictEqual(interviewWithSalary.progressUpdate.stage, "interview_invited");
  assert.deepStrictEqual(
    interviewWithSalary.messages,
    [],
    "a manual-only topic must suppress the local interview draft without erasing the invitation stage"
  );
  const interviewMention = validateMessageReply(safeReply({
    messageIntent: "information_update",
    messageCategory: "other",
    messageSummary: "对方在介绍岗位涉及的面试安排系统。",
    requiredFactKeys: [],
    usedFactKeys: [],
    responseItems: [],
    coverage: [],
    messages: ["了解了，谢谢你补充岗位信息。"]
  }), { facts: [], now: NOW });
  assert.strictEqual(interviewMention.messageIntent, "information_update");
  assert.strictEqual(interviewMention.progressUpdate.stage, "reply_ready");
  assert.deepStrictEqual(interviewMention.messages, ["了解了，谢谢你补充岗位信息。"]);
  for (const messageIntent of [
    "interest_check",
    "information_request",
    "information_update",
    "general_communication"
  ]) {
    const result = validateMessageReply(safeReply({
      messageIntent,
      messageCategory: "other",
      requiredFactKeys: [],
      usedFactKeys: [],
      responseItems: [],
      coverage: [],
      messages: ["安全草稿"]
    }), { facts: [], now: NOW });
    assert.strictEqual(result.messageIntent, messageIntent);
    assert.strictEqual(result.progressUpdate.stage, "reply_ready");
  }
  const manualReview = validateMessageReply(safeReply({
    messageIntent: "manual_review",
    messageCategory: "other",
    messageSummary: "这条消息暂时无法可靠判断，需要人工确认。",
    requiredFactKeys: [],
    usedFactKeys: [],
    responseItems: [],
    coverage: [],
    messages: []
  }), { facts: [], now: NOW });
  assert.strictEqual(manualReview.messageIntent, "manual_review");
  assert.strictEqual(manualReview.progressUpdate.stage, "needs_user_action");
  assert.deepStrictEqual(manualReview.messages, []);
  assert.throws(
    () => validateMessageReply(safeReply({
      messageIntent: "manual_review",
      messageCategory: "other",
      requiredFactKeys: [],
      usedFactKeys: [],
      responseItems: [],
      coverage: [],
      messages: ["must not escape"]
    }), { facts: [], now: NOW }),
    (error) => error.code === "MESSAGE_REPLY_MANUAL_ONLY"
  );
  for (const messageSummary of [undefined, "", " ", "x".repeat(161), 42]) {
    assert.throws(
      () => validateMessageReply(safeReply({ messageSummary }), { facts: validFacts, now: NOW }),
      (error) => error.code === "MESSAGE_REPLY_SUMMARY_INVALID"
    );
  }
  for (const messageCategory of ["salary", "sensitive", "identity_uncertain"]) {
    assert.throws(
      () => validateMessageReply(safeReply({ messageCategory, messages: ["must not escape"] }), { facts: validFacts, now: NOW }),
      (error) => error.code === "MESSAGE_REPLY_MANUAL_ONLY"
    );
  }

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
    messageIntent: "information_request",
    messageCategory: "qualification",
    messageSummary: "对方正在确认候选人的任职资格。",
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
      messageIntent: "information_request",
      messageCategory: "qualification",
      messageSummary: "对方正在确认候选人的任职资格。",
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
      messageIntent: "information_request",
      messageCategory: "qualification",
      messageSummary: "对方正在确认候选人的任职资格。",
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
      messageIntent: "information_request",
      messageCategory: "qualification",
      messageSummary: "对方正在确认候选人的任职资格。",
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
      messageIntent: "information_request",
      messageCategory: "qualification",
      messageSummary: "对方正在确认候选人的任职资格。",
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

  const semanticAnalyzer = createMessageReplyAnalyzer({
    adapter: {
      async draftMessageGroup() {
        return {
          messageIntent: "information_update",
          messageCategory: "other",
          messageSummary: "对方在介绍项目提供的线上面试和简历管理能力。",
          requiredFactKeys: [],
          usedFactKeys: [],
          responseItems: [],
          coverage: [],
          missingFact: null,
          messages: ["了解了，这部分业务与我的项目方向有一定关联。"]
        };
      }
    }
  });
  const semanticMessages = [{
    messageKey: "sha256:" + "9".repeat(64),
    text: "项目提供线上面试与简历管理能力。"
  }];
  const semantic = await semanticAnalyzer({
    profile: { id: 1 },
    job: { id: 2, title: "Java Engineer" },
    messages: semanticMessages,
    facts: [],
    now: NOW
  });
  assert.strictEqual(semantic.messageCategory, "other");
  assert.strictEqual(semantic.messageIntent, "information_update");
  assert.strictEqual(semantic.messageSummary, "对方正在补充当前岗位、项目或流程信息。");
  assert(!semantic.messageSummary.includes("线上面试与简历管理能力"), "model-provided recruiter wording must not become durable summary text");
  assert.deepStrictEqual(semantic.messages, ["了解了，这部分业务与我的项目方向有一定关联。"]);
  assert.strictEqual(semanticMessages[0].text, "");

  for (const [text, messageCategory] of [
    ["薪资还可以再谈吗？", "salary"],
    ["请提供身份证和家庭情况", "sensitive"],
    ["这是哪个岗位？", "identity_uncertain"]
  ]) {
    const manual = await analyzer({
      profile: { id: 1 },
      job: { id: 2, title: "Java Engineer" },
      messages: [{ messageKey: "sha256:" + "b".repeat(64), text }],
      facts: validFacts,
      now: NOW
    });
    assert.strictEqual(manual.messageCategory, messageCategory);
    assert.deepStrictEqual(manual.messages, []);
    assert.strictEqual(manual.progressUpdate.stage, "needs_user_action");
  }

  const mixedSalary = await analyzer({
    profile: { id: 1 },
    job: { id: 2, title: "Java Engineer" },
    messages: [{
      messageKey: "sha256:" + "f".repeat(64),
      text: "薪资范围是多少，什么时候可以到岗？"
    }],
    facts: validFacts,
    now: NOW
  });
  assert.strictEqual(mixedSalary.messageCategory, "salary", "any salary question must keep the whole group manual-only");
  assert.deepStrictEqual(mixedSalary.messages, []);
  assert.strictEqual(mixedSalary.progressUpdate.stage, "needs_user_action");

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
  let stableAdapterSignal;
  const stableAdapter = {
    async draftMessageGroup(input, options = {}) {
      stableAdapterInput = input;
      stableAdapterSignal = options.signal;
      return {
        messageIntent: "information_request",
        messageCategory: "qualification",
        messageSummary: "对方正在确认候选人的任职资格。",
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
  const scopedController = new AbortController();
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
  }, { signal: scopedController.signal });
  assert.strictEqual(stableAdapterSignal, scopedController.signal);
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

  let memoryAdapterInput;
  const memoryAnalyzer = createMessageReplyAnalyzer({
    adapter: {
      async draftMessageGroup(input) {
        memoryAdapterInput = input;
        return {
          messageIntent: "general_communication",
          messageCategory: "other",
          messageSummary: "对方正在继续沟通当前岗位。",
          requiredFactKeys: [],
          usedFactKeys: [],
          usedMemoryIds: [7],
          responseItems: [],
          coverage: [],
          missingFact: null,
          messages: ["我愿意继续沟通。"]
        };
      }
    }
  });
  const suppliedMemories = [
    { ...memoryContext[0], finalText: memoryContext[0].finalAnswer, updatedAt: NOW },
    { id: 8, source: "draft_adopted", finalText: "模型原稿", withdrawnAt: "", updatedAt: NOW },
    { id: 9, source: "user_edited_reply", finalText: "已撤回答案", withdrawnAt: NOW, updatedAt: NOW }
  ];
  const memoryMessages = [{ messageKey: "sha256:" + "8".repeat(64), text: "还愿意继续沟通吗？" }];
  const memoryResult = await memoryAnalyzer({
    profile: { id: 1 },
    job: { id: 2, title: "Java Engineer" },
    messages: memoryMessages,
    facts: [],
    answerMemories: suppliedMemories,
    now: NOW
  });
  assert.deepStrictEqual(memoryResult.usedMemoryIds, [7]);
  assert.deepStrictEqual(memoryAdapterInput.answerMemories.map((memory) => memory.id), [7]);
  assert.strictEqual(memoryAdapterInput.answerMemories[0].finalAnswer, "", "temporary memory answer text must be cleared after the model call");
  assert.strictEqual(suppliedMemories[0].finalText, memoryContext[0].finalAnswer, "analyzer cleanup must not mutate durable memory objects");
  assert.strictEqual(memoryMessages[0].text, "");

  let scopedMemoryAdapterInput;
  const scopedMemoryAnalyzer = createMessageReplyAnalyzer({
    adapter: {
      async draftMessageGroup(input) {
        scopedMemoryAdapterInput = input;
        return {
          messageIntent: "general_communication",
          messageCategory: "other",
          messageSummary: "请继续沟通。",
          requiredFactKeys: [],
          usedFactKeys: [],
          usedMemoryIds: input.answerMemories.map((memory) => memory.id),
          responseItems: [],
          coverage: [],
          missingFact: null,
          messages: ["继续沟通。"]
        };
      }
    }
  });
  const scopedMemoryMessages = [{ messageKey: "sha256:" + "7".repeat(64), text: "继续聊聊这个岗位吧。" }];
  const scopedMemoryResult = await scopedMemoryAnalyzer({
    profile: { id: 1 },
    job: { id: 2, sourceId: "boss-job-2", title: "Java Engineer", company: "示例公司" },
    messages: scopedMemoryMessages,
    facts: [],
    answerMemories: [
      { id: 20, source: "user_edited_reply", finalText: "全局回答", scope: { kind: "global", key: "" } },
      { id: 21, source: "user_edited_reply", finalText: "当前岗位回答", scope: { kind: "job", key: "2" } },
      { id: 22, source: "user_edited_reply", finalText: "其他岗位回答", scope: { kind: "job", key: "99" } },
      { id: 23, source: "user_edited_reply", finalText: "当前公司回答", scope: { kind: "company", key: "示例公司" } },
      { id: 24, source: "user_edited_reply", finalText: "其他公司回答", scope: { kind: "company", key: "别家公司" } }
    ],
    now: NOW
  });
  assert.deepStrictEqual(scopedMemoryResult.usedMemoryIds, [20, 21, 23]);
  assert.deepStrictEqual(scopedMemoryAdapterInput.answerMemories.map((memory) => memory.id), [20, 21, 23], "answer memories must stay inside their saved scope");

  console.log("message_reply_contract_smoke ok");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
