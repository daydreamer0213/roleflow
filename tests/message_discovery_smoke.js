const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  openDb,
  createBatch,
  upsertJob,
  recordMessageReplyDrafts,
  completeMessageReplyDraft,
  getMessageReplyDraft,
  withdrawCandidateAnswerMemory
} = require("../src/core/storage");
const {
  ensureProgressCard,
  listMessageDiscoveryCandidates,
  listProgressEvents,
  getProgressCardForJob,
  transitionProgressCard,
  recordDiscoveredMessageGroupClassification
} = require("../src/core/candidate_progress");
const { safeDigest, messageKey } = require("../src/adapters/sites/boss_message_dom");
const {
  runBossMessageDiscovery,
  projectMessageDecisionCard
} = require("../src/core/message_discovery");
const { resolveInboundOpportunity } = require("../src/application/message_discovery/inbound");
const { factStatus } = require("../src/core/candidate_fact_policy");
const {
  listPreviewStates,
  commitProcessedPreview,
  listUnresolvedMessageDiscoveryItems,
  recordUnresolvedMessageDiscoveryItem
} = require("../src/core/message_preview_state");

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
  decisionCardProjectionSmoke();
  await uniqueCandidateAndPrivacySmoke();
  await answerMemoryRefreshSmoke();
  await unsafeModelPersistenceSmoke();
  await identityStopsSmoke();
  await threadAndContextResolutionSmoke();
  await unmatchedRetentionSmoke();
  inboundLocalActionsSmoke();
  await messageSelectionSmoke();
  await messageGroupBoundarySmoke();
  await previewChannelSmoke();
  await unsupportedPreviewSmoke();
  await classificationOutcomeSmoke();
  await readerStopSmoke();
  await terminalAfterProcessedSmoke();
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

function decisionCardProjectionSmoke() {
  const base = {
    title: "AI 应用开发工程师",
    company: "示例科技",
    salary: "15-25K·13薪",
    analysis: {
      roleSummary: "为企业知识库构建可追溯的智能问答系统",
      fitReasons: ["岗位方向与候选人的 RAG 项目经历一致"],
      roleGaps: ["生产环境运维经验仍需确认"],
      jobQuality: { level: "normal", concerns: [] }
    }
  };

  assert.deepStrictEqual(projectMessageDecisionCard({
    ...base,
    analysis: {
      ...base.analysis,
      businessScenario: "企业知识管理",
      industryContext: "企业软件",
      fitLevel: "A",
      recommendation: "apply"
    }
  }), {
    title: "AI 应用开发工程师",
    company: "示例科技",
    roleSummary: "为企业知识库构建可追溯的智能问答系统",
    companyBusiness: "JD 显示该岗位服务于企业知识管理。",
    fitLabel: "高",
    fitSummary: "岗位方向与候选人的 RAG 项目经历一致",
    salary: "15-25K·13薪",
    opportunityVerdict: "值得继续聊",
    opportunitySummary: "岗位方向与候选人的 RAG 项目经历一致"
  });

  const unknownCompany = projectMessageDecisionCard({
    ...base,
    salary: "",
    analysis: {
      ...base.analysis,
      businessScenario: "",
      industryContext: "未明确",
      fitLevel: "no_fit",
      recommendation: "not_recommended"
    }
  });
  assert.strictEqual(unknownCompany.companyBusiness, "JD 暂未说明公司的具体业务。");
  assert(!Object.hasOwn(unknownCompany, "companyScope"));
  assert.strictEqual(unknownCompany.fitLabel, "低");
  assert.strictEqual(unknownCompany.fitSummary, "生产环境运维经验仍需确认");
  assert.strictEqual(unknownCompany.salary, "");
  assert.strictEqual(unknownCompany.opportunityVerdict, "不建议优先投入时间");
  assert.strictEqual(unknownCompany.opportunitySummary, "生产环境运维经验仍需确认");

  const guarded = projectMessageDecisionCard({
    ...base,
    analysis: {
      ...base.analysis,
      fitLevel: "no_fit",
      recommendation: "not_recommended",
      ruleAdjusted: true,
      fitReasons: ["存在不可沟通的硬性缺口：必须具备行业资质", "具备一项次要技能"],
      hardBlockers: [{ requirement: "必须具备行业资质" }]
    }
  });
  assert.strictEqual(guarded.fitSummary, "存在不可沟通的硬性缺口：必须具备行业资质");
  assert.strictEqual(guarded.opportunitySummary, "存在不可沟通的硬性缺口：必须具备行业资质");

  const qualityRisk = projectMessageDecisionCard({
    ...base,
    analysis: {
      ...base.analysis,
      fitLevel: "C",
      recommendation: "caution",
      jobQuality: {
        level: "caution",
        concerns: [{ type: "responsibility_sprawl", evidence: "JD 同时要求研发、销售和全天候运维" }]
      }
    }
  });
  assert.strictEqual(qualityRisk.opportunitySummary, "JD 同时要求研发、销售和全天候运维");

  const longMedium = projectMessageDecisionCard({
    ...base,
    analysis: {
      ...base.analysis,
      fitLevel: "C",
      recommendation: "caution",
      fitReasons: [`主要匹配方向${"甲".repeat(100)}`],
      roleGaps: [`关键缺口${"乙".repeat(100)}`]
    }
  }).fitSummary;
  assert(longMedium.includes("主要匹配方向"));
  assert(longMedium.includes("关键缺口"));
  assert(longMedium.length <= 180);

  for (const [fitLevel, expected] of [
    ["fit", "高"], ["A", "高"],
    ["mostly_fit", "中"], ["partial_fit", "中"], ["B", "中"], ["C", "中"],
    ["no_fit", "低"], ["D", "低"],
    ["", "待确认"], ["unexpected", "待确认"]
  ]) {
    assert.strictEqual(projectMessageDecisionCard({
      ...base,
      analysis: { ...base.analysis, fitLevel, recommendation: "review" }
    }).fitLabel, expected);
  }

  for (const [recommendation, expected] of [
    ["primary", "值得继续聊"],
    ["apply", "值得继续聊"],
    ["caution", "可以了解，但要先确认关键问题"],
    ["not_recommended", "不建议优先投入时间"],
    ["analysis_pending", "信息不足，暂时无法判断"],
    ["unexpected", "信息不足，暂时无法判断"]
  ]) {
    assert.strictEqual(projectMessageDecisionCard({
      ...base,
      analysis: { ...base.analysis, fitLevel: "C", recommendation }
    }).opportunityVerdict, expected);
  }
}

async function uniqueCandidateAndPrivacySmoke() {
  const fixture = createFixture({
    suffix: "unique",
    title: "Java Engineer",
    analysis: {
      roleSummary: "负责企业 Java 服务交付",
      businessScenario: "企业交易系统交付",
      industryContext: "企业软件",
      fitLevel: "mostly_fit",
      recommendation: "caution",
      fitReasons: ["Spring 项目证据匹配"],
      roleGaps: ["生产值班经验待确认"],
      hardBlockers: [{
        requirement: "必须具备支付行业经验",
        jdEvidence: "JD evidence",
        resumeEvidence: PRIVATE_BODY
      }],
      softGaps: ["行业经验待确认"],
      questionsToVerify: ["确认团队技术栈"],
      recruiterPrivateText: PRIVATE_BODY,
      description: PRIVATE_BODY
    }
  });
  const selected = selectedConversation({ title: fixture.title });
  const previousDraft = recordMessageReplyDrafts(db, {
    profileId: fixture.profileId,
    cardId: fixture.card.id,
    jobId: fixture.jobId,
    messageGroupKey: safeDigest(["prior-learning-memory", fixture.profileId]),
    questionSummary: "对方询问候选人的沟通意向。",
    messageIntent: "interest_check",
    messageCategory: "other",
    messages: ["旧模型原稿"],
    createdAt: NOW
  })[0];
  completeMessageReplyDraft(db, {
    profileId: fixture.profileId,
    draftId: previousDraft.id,
    finalText: "这是用户改过并完成的回答。",
    changedText: "这是用户改过并完成的回答",
    completionKind: "sent",
    extractedFacts: [],
    completedAt: NOW
  });
  const logs = [];
  let modelCalls = 0;
  const summary = await runBossMessageDiscovery({
    db,
    profileId: fixture.profileId,
    reader: fakeReader([selected]),
    classifyMessageGroup: async ({ profile, card, job, messages, answerMemories }) => {
      modelCalls += 1;
      assert.deepStrictEqual(profile.candidate, {
        city: "Guangzhou",
        targetTitles: ["Java Engineer"],
        expectedSalary: "20-30K",
        adjustableSalary: []
      });
      assert.strictEqual(profile.candidate.name, undefined, "candidate name must not enter message drafting");
      assert.strictEqual(profile.riskMessaging, undefined, "risk messaging must not enter message drafting");
      assert.deepStrictEqual(profile.projects.map((project) => project.name), ["KnowledgeFlow"]);
      assert.strictEqual(card.id, fixture.card.id);
      assert.strictEqual(card.profileId, fixture.profileId);
      assert.strictEqual(job.title, "Java Engineer");
      assert.deepStrictEqual(messages.map((item) => item.text), [PRIVATE_BODY]);
      assert.deepStrictEqual(answerMemories.map((memory) => memory.finalText), ["这是用户改过并完成的回答。"]);
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
  assert.strictEqual(summary.results[0].drafts.length, 1);
  assert.strictEqual(summary.results[0].drafts[0].text, PRIVATE_DRAFT);
  const durableDraft = getMessageReplyDraft(db, {
    profileId: fixture.profileId,
    draftId: summary.results[0].drafts[0].id
  });
  assert.strictEqual(durableDraft.currentText, PRIVATE_DRAFT);
  assert.strictEqual(durableDraft.questionSummary, "对方正在确认候选人的任职资格。");
  assert.strictEqual(durableDraft.messageIntent, "information_request");
  assert.strictEqual(durableDraft.messageCategory, "qualification");
  const learningStorageText = JSON.stringify([
    ...db.prepare("SELECT * FROM message_reply_drafts WHERE profile_id = ?").all(fixture.profileId),
    ...db.prepare("SELECT * FROM candidate_answer_memories WHERE profile_id = ?").all(fixture.profileId)
  ]);
  assert(!learningStorageText.includes(PRIVATE_BODY), "raw HR message text must remain ephemeral");
  assert.strictEqual(summary.results[0].stage, "reply_ready");
  assert.deepStrictEqual(summary.results[0].job, {
    title: "Java Engineer",
    company: "Fixture Company",
    roleSummary: "负责企业 Java 服务交付",
    companyBusiness: "JD 显示该岗位服务于企业交易系统交付。",
    fitLabel: "中",
    fitSummary: "Spring 项目证据匹配；生产值班经验待确认",
    salary: "20-30K",
    opportunityVerdict: "可以了解，但要先确认关键问题",
    opportunitySummary: "Spring 项目证据匹配；生产值班经验待确认"
  });
  assert.strictEqual(summary.results[0].contextSource, "local_cache");
  assert.strictEqual(summary.results[0].contextComplete, true);
  assert.strictEqual(summary.results[0].manualActionReason, "");
  for (const privateField of [
    "fitReasons",
    "hardBlockers",
    "softGaps",
    "questionsToVerify",
    "description",
    "recruiterPrivateText"
  ]) assert.strictEqual(Object.hasOwn(summary.results[0].job, privateField), false);
  assert.strictEqual(JSON.stringify(summary.results[0].job).includes(PRIVATE_BODY), false);
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
  assert.deepStrictEqual(
    listProgressEvents(db, fixture.card.id).map((event) => event.type).sort(),
    ["inbound_reply_observed", "incoming_message_classified", "message_group_classified"].sort(),
    "the safe row observation, message event, and group event must remain idempotent"
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

async function threadAndContextResolutionSmoke() {
  const canonical = createFixture({ suffix: "canonical-thread", title: "Canonical Thread Engineer" });
  const canonicalThreadKey = safeDigest(["conversation", "0"]);
  db.prepare("UPDATE candidate_progress_cards SET thread_key = ? WHERE id = ?")
    .run(canonicalThreadKey, canonical.card.id);
  let classifiedJobId = 0;
  let summary = await runBossMessageDiscovery({
    db,
    profileId: canonical.profileId,
    reader: fakeReader([selectedConversation({ title: canonical.title, messageId: "123456789012401" })]),
    classifyMessageGroup: async ({ job }) => {
      classifiedJobId = job.id;
      assert.strictEqual(job.description.length >= 120, true);
      assert.strictEqual(job.analysis.semanticStatus, "complete");
      return classification();
    },
    now: () => NOW,
    sleepFn: async () => {}
  });
  assert.strictEqual(summary.status, "completed");
  assert.strictEqual(classifiedJobId, canonical.jobId);

  const verifiedComplete = createFixture({ suffix: "verified-complete", title: "Verified Complete Engineer" });
  const verifiedCandidate = listMessageDiscoveryCandidates(db, { profileId: verifiedComplete.profileId })
    .find((item) => item.jobId === verifiedComplete.jobId);
  let completeResolverCalls = 0;
  summary = await runBossMessageDiscovery({
    db,
    profileId: verifiedComplete.profileId,
    reader: fakeReader([selectedConversation({ title: verifiedComplete.title, messageId: "123456789012400" })]),
    resolveJobContext: async ({ target, candidate }) => {
      completeResolverCalls += 1;
      assert.strictEqual(candidate.jobId, verifiedComplete.jobId);
      assert.strictEqual(candidate.contextComplete, true);
      return resolvedContext(candidate, target.conversationKey);
    },
    classifyMessageGroup: async ({ job }) => {
      assert.strictEqual(job.sourceId, verifiedCandidate.sourceId);
      return classification();
    },
    now: () => NOW,
    sleepFn: async () => {}
  });
  assert.strictEqual(summary.status, "completed");
  assert.strictEqual(completeResolverCalls, 1, "a complete candidate still requires stable job ID verification");

  const legacy = createFixture({ suffix: "legacy-thread", title: "Legacy Thread Engineer" });
  const legacyThreadKey = safeDigest(["boss", PRIVATE_RECRUITER, legacy.title]);
  const legacyCanonicalKey = safeDigest(["conversation", "0"]);
  db.prepare("UPDATE candidate_progress_cards SET thread_key = ? WHERE id = ?")
    .run(legacyThreadKey, legacy.card.id);
  summary = await runBossMessageDiscovery({
    db,
    profileId: legacy.profileId,
    reader: fakeReader([selectedConversation({ title: legacy.title, messageId: "123456789012402" })]),
    classifyMessageGroup: async () => classification(),
    now: () => NOW,
    sleepFn: async () => {}
  });
  assert.strictEqual(summary.status, "completed");
  assert.strictEqual(
    db.prepare("SELECT thread_key FROM candidate_progress_cards WHERE id = ?").get(legacy.card.id).thread_key,
    legacyCanonicalKey,
    "a successfully classified legacy card must migrate to the canonical conversation key"
  );

  const ambiguous = createFixture({ suffix: "stable-ambiguous-a", title: "Stable Ambiguous Engineer" });
  const chosen = createFixture({
    suffix: "stable-ambiguous-b",
    title: "Stable Ambiguous Engineer",
    profileId: ambiguous.profileId,
    planId: ambiguous.planId
  });
  const chosenCandidate = listMessageDiscoveryCandidates(db, { profileId: ambiguous.profileId })
    .find((item) => item.jobId === chosen.jobId);
  let resolverCalls = 0;
  summary = await runBossMessageDiscovery({
    db,
    profileId: ambiguous.profileId,
    reader: fakeReader([selectedConversation({ title: ambiguous.title, messageId: "123456789012403" })]),
    resolveJobContext: async ({ target, candidate }) => {
      resolverCalls += 1;
      assert.strictEqual(candidate, null, "an ambiguous title must defer to the stable job target");
      return resolvedContext(chosenCandidate, target.conversationKey);
    },
    classifyMessageGroup: async ({ job }) => {
      assert.strictEqual(job.id, chosen.jobId);
      return classification();
    },
    now: () => NOW,
    sleepFn: async () => {}
  });
  assert.strictEqual(summary.status, "completed");
  assert.strictEqual(resolverCalls, 1);

  const failed = createFixture({ suffix: "context-failed", title: "Context Failed Engineer" });
  let modelCalls = 0;
  summary = await runBossMessageDiscovery({
    db,
    profileId: failed.profileId,
    reader: fakeReader([selectedConversation({ title: "Unknown Context Engineer", messageId: "123456789012404" })]),
    resolveJobContext: async () => {
      throw Object.assign(new Error("analysis incomplete"), { code: "MESSAGE_DISCOVERY_JOB_ANALYSIS_INCOMPLETE" });
    },
    classifyMessageGroup: async () => {
      modelCalls += 1;
      return classification();
    },
    now: () => NOW,
    sleepFn: async () => {}
  });
  assertStopped(summary, "MESSAGE_DISCOVERY_JOB_ANALYSIS_INCOMPLETE");
  assert.strictEqual(summary.unresolved, 1);
  assert.strictEqual(modelCalls, 0);
  assert.strictEqual(listPreviewStates(db, { profileId: failed.profileId }).length, 0);

  const unsafeBackground = createFixture({ suffix: "context-not-background", title: "Unsafe Background Engineer" });
  let unsafeResolverCalls = 0;
  summary = await runBossMessageDiscovery({
    db,
    profileId: unsafeBackground.profileId,
    reader: fakeReader([
      selectedConversation({ title: "Unknown Unsafe Background", messageId: "123456789012405" }),
      selectedConversation({ title: unsafeBackground.title, messageId: "123456789012406" })
    ]),
    resolveJobContext: async () => {
      unsafeResolverCalls += 1;
      throw Object.assign(new Error("background proof failed"), { code: "BOSS_MESSAGE_DETAIL_NOT_BACKGROUND" });
    },
    classifyMessageGroup: async () => {
      throw new Error("unsafe background failure must stop before classification");
    },
    now: () => NOW,
    sleepFn: async () => {}
  });
  assertStopped(summary, "BOSS_MESSAGE_DETAIL_NOT_BACKGROUND");
  assert.strictEqual(summary.unresolved, 1);
  assert.strictEqual(unsafeResolverCalls, 1, "background proof failure must stop the remaining queue immediately");

  const browserFailure = createFixture({ suffix: "context-browser-failed", title: "Browser Failed Engineer" });
  let browserFailureCalls = 0;
  summary = await runBossMessageDiscovery({
    db,
    profileId: browserFailure.profileId,
    reader: fakeReader([
      selectedConversation({ title: "Unknown Browser Failure", messageId: "123456789012407" }),
      selectedConversation({ title: browserFailure.title, messageId: "123456789012408" })
    ]),
    resolveJobContext: async () => {
      browserFailureCalls += 1;
      throw Object.assign(new Error("sanitized browser failure"), { code: "BOSS_MESSAGE_DETAIL_BROWSER_FAILED" });
    },
    classifyMessageGroup: async () => {
      throw new Error("browser uncertainty must stop before classification");
    },
    now: () => NOW,
    sleepFn: async () => {}
  });
  assertStopped(summary, "BOSS_MESSAGE_DETAIL_BROWSER_FAILED");
  assert.strictEqual(browserFailureCalls, 1, "a detail browser failure must stop the remaining queue immediately");

  const bindingFailure = createFixture({ suffix: "context-binding-failed", title: "Binding Failed Engineer" });
  let bindingFailureCalls = 0;
  summary = await runBossMessageDiscovery({
    db,
    profileId: bindingFailure.profileId,
    reader: fakeReader([
      selectedConversation({ title: "Unknown Binding Failure", messageId: "123456789012409" }),
      selectedConversation({ title: bindingFailure.title, messageId: "123456789012419" })
    ]),
    resolveJobContext: async () => {
      bindingFailureCalls += 1;
      throw Object.assign(new Error("fixed tabs changed"), { code: "BOSS_TAB_REQUIRED" });
    },
    classifyMessageGroup: async () => {
      throw new Error("fixed-tab binding failure must stop before classification");
    },
    now: () => NOW,
    sleepFn: async () => {}
  });
  assertStopped(summary, "BOSS_TAB_REQUIRED");
  assert.strictEqual(bindingFailureCalls, 1, "fixed-tab binding failure must stop the remaining queue immediately");
}

async function unmatchedRetentionSmoke() {
  const fixture = createFixture({ suffix: "unmatched-retention", title: "Retained Valid Engineer" });
  const unmatchedTitle = "Retained Missing Engineer";
  const unmatchedKey = safeDigest(["conversation", "retained-unmatched"]);
  const unmatchedPreview = safeDigest(["preview", "retained-unmatched"]);
  const validKey = safeDigest(["conversation", "retained-valid"]);
  const validPreview = safeDigest(["preview", "retained-valid"]);
  const opens = [];
  const logs = [];
  let modelCalls = 0;
  const firstReader = {
    async scanConversationRows() {
      return {
        tabId: "fake-tab",
        path: "/web/geek/chat",
        rows: Object.freeze([
          Object.freeze(messageRow(0, true, unmatchedKey, unmatchedPreview)),
          Object.freeze(messageRow(1, true, validKey, validPreview))
        ])
      };
    },
    async openQueuedConversation(target) {
      opens.push(target.rowIndex);
      return target.rowIndex === 0
        ? selectedConversation({ title: unmatchedTitle, messageId: "123456789012410" })
        : selectedConversation({ title: fixture.title, messageId: "123456789012411" });
    }
  };
  const first = await runBossMessageDiscovery({
    db,
    profileId: fixture.profileId,
    reader: firstReader,
    classifyMessageGroup: async () => {
      modelCalls += 1;
      return classification();
    },
    logger: { info: (...args) => logs.push(args) },
    now: () => NOW,
    sleepFn: async () => {}
  });
  assert.deepStrictEqual(opens, [0, 1], "an unmatched item must not block the next immutable queue item");
  assert.strictEqual(modelCalls, 1, "the unmatched item must not call the model");
  assert.strictEqual(first.status, "needs_user_action");
  assert.strictEqual(first.processed, 1);
  assert.strictEqual(first.unresolved, 1);
  assert.strictEqual(first.reasonCode, "BOSS_MESSAGE_CARD_NOT_FOUND");
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) AS n FROM candidate_progress_events WHERE card_id = ?").get(fixture.card.id).n,
    2,
    "only the valid item may create message-discovery progress events"
  );
  assert.strictEqual(listPreviewStates(db, { profileId: fixture.profileId }).some((item) => item.conversationKey === unmatchedKey), false);
  const unresolved = listUnresolvedMessageDiscoveryItems(db, { profileId: fixture.profileId });
  assert.strictEqual(unresolved.length, 1);
  assert.deepStrictEqual({
    positionTitle: unresolved[0].positionTitle,
    company: unresolved[0].company,
    salary: unresolved[0].salary,
    city: unresolved[0].city
  }, {
    positionTitle: unmatchedTitle,
    company: "Fixture Company",
    salary: "20-30K",
    city: "Guangzhou"
  });
  assert.match(unresolved[0].identityDigest, /^sha256:[a-f0-9]{64}$/);
  const retainedText = [
    allText(db, "message_discovery_unresolved_items"),
    JSON.stringify(logs)
  ].join("\n");
  for (const forbidden of [PRIVATE_BODY, PRIVATE_PREVIEW, PRIVATE_RECRUITER]) {
    assert(!retainedText.includes(forbidden), `${forbidden} must not enter unresolved storage or logs`);
  }

  const resolved = createFixture({
    suffix: "unmatched-retention-resolved",
    profileId: fixture.profileId,
    planId: fixture.planId,
    title: unmatchedTitle
  });
  const second = await runBossMessageDiscovery({
    db,
    profileId: fixture.profileId,
    reader: {
      async scanConversationRows() {
        return {
          tabId: "fake-tab",
          path: "/web/geek/chat",
          rows: Object.freeze([Object.freeze(messageRow(0, false, unmatchedKey, unmatchedPreview))])
        };
      },
      async openQueuedConversation(target) {
        assert.strictEqual(target.operation, "durable_unresolved", "a read conversation with a durable marker must be retried");
        return selectedConversation({ title: unmatchedTitle, messageId: "123456789012412" });
      }
    },
    classifyMessageGroup: async () => {
      modelCalls += 1;
      return classification();
    },
    now: () => NOW,
    sleepFn: async () => {}
  });
  assert.strictEqual(second.status, "completed");
  assert.strictEqual(second.processed, 1);
  assert.strictEqual(second.unresolved, 0);
  assert.strictEqual(modelCalls, 2);
  assert.strictEqual(listUnresolvedMessageDiscoveryItems(db, { profileId: fixture.profileId }).length, 0);
  assert.strictEqual(
    listPreviewStates(db, { profileId: fixture.profileId }).find((item) => item.conversationKey === unmatchedKey).previewDigest,
    unmatchedPreview,
    "successful resolution must commit the preview only after removing the durable marker"
  );
  assert.strictEqual(resolved.card.profileId, fixture.profileId);
}

function inboundLocalActionsSmoke() {
  const fixture = createFixture({ suffix: "inbound-local", title: "Inbound Engineer" });
  const createdKey = safeDigest(["conversation", "inbound-create"]);
  const createdPreview = safeDigest(["preview", "inbound-create"]);
  recordUnresolvedMessageDiscoveryItem(db, {
    profileId: fixture.profileId,
    platform: "boss",
    conversationKey: createdKey,
    previewDigest: createdPreview,
    previewKind: "possible_hr_reply",
    reasonCode: "BOSS_MESSAGE_CARD_NOT_FOUND",
    observedAt: NOW,
    identity: {
      positionTitle: "Inbound Created Engineer",
      company: "Inbound Company",
      salary: "15-25K",
      city: "Guangzhou"
    }
  });
  const created = resolveInboundOpportunity({
    db,
    input: {
      profileId: fixture.profileId,
      conversationKey: createdKey,
      previewDigest: createdPreview,
      action: "create"
    },
    now: () => NOW
  });
  assert.strictEqual(created.card.stage, "needs_user_action");
  assert.strictEqual(created.card.threadKey, createdKey);
  assert.strictEqual(created.job.source, "boss");
  assert.strictEqual(created.job.sourceId, `inbound:${createdKey.slice(7)}`);
  assert.strictEqual(created.job.batchId, null);
  assert.strictEqual(created.settled, false);
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) AS count FROM job_observations WHERE job_id = ?").get(created.job.id).count,
    0
  );
  assert.strictEqual(listUnresolvedMessageDiscoveryItems(db, { profileId: fixture.profileId })
    .some((item) => item.conversationKey === createdKey), true);
  assert.strictEqual(listPreviewStates(db, { profileId: fixture.profileId })
    .some((item) => item.conversationKey === createdKey), false);

  const linkKey = safeDigest(["conversation", "inbound-link"]);
  const linkPreview = safeDigest(["preview", "inbound-link"]);
  recordUnresolvedMessageDiscoveryItem(db, {
    profileId: fixture.profileId,
    platform: "boss",
    conversationKey: linkKey,
    previewDigest: linkPreview,
    previewKind: "possible_hr_reply",
    reasonCode: "BOSS_MESSAGE_CARD_NOT_FOUND",
    observedAt: NOW,
    identity: {
      positionTitle: fixture.title,
      company: fixture.company,
      salary: fixture.salary,
      city: fixture.city
    }
  });
  const linked = resolveInboundOpportunity({
    db,
    input: {
      profileId: fixture.profileId,
      conversationKey: linkKey,
      previewDigest: linkPreview,
      action: "link",
      jobId: fixture.jobId
    },
    now: () => NOW
  });
  assert.strictEqual(linked.job.id, fixture.jobId);
  assert.strictEqual(linked.card.threadKey, linkKey);
  assert.strictEqual(linked.card.stage, "needs_user_action");
  assert.strictEqual(linked.settled, false);
  assert.strictEqual(listUnresolvedMessageDiscoveryItems(db, { profileId: fixture.profileId })
    .some((item) => item.conversationKey === linkKey), true);
  assert.strictEqual(listPreviewStates(db, { profileId: fixture.profileId })
    .some((item) => item.conversationKey === linkKey), false);

  const ignoredKey = safeDigest(["conversation", "inbound-ignore"]);
  const ignoredPreview = safeDigest(["preview", "inbound-ignore"]);
  recordUnresolvedMessageDiscoveryItem(db, {
    profileId: fixture.profileId,
    platform: "boss",
    conversationKey: ignoredKey,
    previewDigest: ignoredPreview,
    previewKind: "possible_hr_reply",
    reasonCode: "BOSS_MESSAGE_CARD_NOT_FOUND",
    observedAt: NOW,
    identity: {
      positionTitle: "Ignored Engineer",
      company: "Ignored Company"
    }
  });
  const ignored = resolveInboundOpportunity({
    db,
    input: {
      profileId: fixture.profileId,
      conversationKey: ignoredKey,
      previewDigest: ignoredPreview,
      action: "ignore"
    },
    now: () => NOW
  });
  assert.strictEqual(ignored.action, "ignore");
  assert.strictEqual(ignored.settled, true);
  assert.strictEqual(listUnresolvedMessageDiscoveryItems(db, { profileId: fixture.profileId })
    .some((item) => item.conversationKey === ignoredKey), false);
  assert.strictEqual(listPreviewStates(db, { profileId: fixture.profileId })
    .find((item) => item.conversationKey === ignoredKey).previewDigest, ignoredPreview);

  const incompleteKey = safeDigest(["conversation", "inbound-incomplete"]);
  recordUnresolvedMessageDiscoveryItem(db, {
    profileId: fixture.profileId,
    platform: "boss",
    conversationKey: incompleteKey,
    previewDigest: createdPreview,
    previewKind: "possible_hr_reply",
    reasonCode: "BOSS_MESSAGE_CARD_NOT_FOUND",
    observedAt: NOW,
    identity: { positionTitle: "", company: "Incomplete Company" }
  });
  assert.throws(
    () => resolveInboundOpportunity({
      db,
      input: {
        profileId: fixture.profileId,
        conversationKey: incompleteKey,
        previewDigest: createdPreview,
        action: "create"
      },
      now: () => NOW
    }),
    (error) => error.code === "INBOUND_IDENTITY_INCOMPLETE"
  );

  const staleKey = safeDigest(["conversation", "inbound-stale"]);
  const stalePreview = safeDigest(["preview", "inbound-stale"]);
  recordUnresolvedMessageDiscoveryItem(db, {
    profileId: fixture.profileId,
    platform: "boss",
    conversationKey: staleKey,
    previewDigest: stalePreview,
    previewKind: "possible_hr_reply",
    reasonCode: "BOSS_MESSAGE_CARD_NOT_FOUND",
    observedAt: NOW,
    identity: { positionTitle: "Stale Engineer", company: "Stale Company" }
  });
  assert.throws(
    () => resolveInboundOpportunity({
      db,
      input: {
        profileId: fixture.profileId,
        conversationKey: staleKey,
        previewDigest: safeDigest(["preview", "stale-form"]),
        action: "ignore"
      },
      now: () => NOW
    }),
    (error) => error.code === "INBOUND_PREVIEW_CHANGED"
  );
  assert.strictEqual(listUnresolvedMessageDiscoveryItems(db, { profileId: fixture.profileId })
    .some((item) => item.conversationKey === staleKey), true);

  const inactive = createFixture({ suffix: "inbound-inactive", title: "Inactive Engineer" });
  db.prepare("UPDATE search_plans SET is_active = 0 WHERE id = ?").run(inactive.planId);
  const inactiveKey = safeDigest(["conversation", "inbound-inactive"]);
  recordUnresolvedMessageDiscoveryItem(db, {
    profileId: inactive.profileId,
    platform: "boss",
    conversationKey: inactiveKey,
    previewDigest: createdPreview,
    previewKind: "possible_hr_reply",
    reasonCode: "BOSS_MESSAGE_CARD_NOT_FOUND",
    observedAt: NOW,
    identity: { positionTitle: "Inactive Engineer", company: "Inactive Company" }
  });
  assert.throws(
    () => resolveInboundOpportunity({
      db,
      input: {
        profileId: inactive.profileId,
        conversationKey: inactiveKey,
        previewDigest: createdPreview,
        action: "create"
      },
      now: () => NOW
    }),
    (error) => error.code === "INBOUND_ACTIVE_PLAN_REQUIRED"
  );
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE source_id = ?")
    .get(`inbound:${inactiveKey.slice(7)}`).count, 0);

  const rollback = createFixture({ suffix: "inbound-rollback", title: "Rollback Engineer" });
  const rollbackKey = safeDigest(["conversation", "inbound-rollback"]);
  recordUnresolvedMessageDiscoveryItem(db, {
    profileId: rollback.profileId,
    platform: "boss",
    conversationKey: rollbackKey,
    previewDigest: createdPreview,
    previewKind: "possible_hr_reply",
    reasonCode: "BOSS_MESSAGE_CARD_NOT_FOUND",
    observedAt: NOW,
    identity: { positionTitle: "Rollback Engineer", company: "Rollback Company" }
  });
  db.exec(`CREATE TRIGGER fail_inbound_progress_event
    BEFORE INSERT ON candidate_progress_events
    WHEN NEW.type = 'inbound_opportunity_created'
    BEGIN
      SELECT RAISE(ABORT, 'forced inbound rollback');
    END`);
  assert.throws(
    () => resolveInboundOpportunity({
      db,
      input: {
        profileId: rollback.profileId,
        conversationKey: rollbackKey,
        previewDigest: createdPreview,
        action: "create"
      },
      now: () => NOW
    }),
    /forced inbound rollback/
  );
  db.exec("DROP TRIGGER fail_inbound_progress_event");
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE source_id = ?")
    .get(`inbound:${rollbackKey.slice(7)}`).count, 0);
  assert.strictEqual(listUnresolvedMessageDiscoveryItems(db, { profileId: rollback.profileId })
    .some((item) => item.conversationKey === rollbackKey), true);
  assert.strictEqual(listPreviewStates(db, { profileId: rollback.profileId })
    .some((item) => item.conversationKey === rollbackKey), false);

  const jobRollback = createFixture({ suffix: "inbound-job-rollback", title: "Job Rollback Engineer" });
  const jobRollbackKey = safeDigest(["conversation", "inbound-job-rollback"]);
  recordUnresolvedMessageDiscoveryItem(db, {
    profileId: jobRollback.profileId,
    platform: "boss",
    conversationKey: jobRollbackKey,
    previewDigest: createdPreview,
    previewKind: "possible_hr_reply",
    reasonCode: "BOSS_MESSAGE_CARD_NOT_FOUND",
    observedAt: NOW,
    identity: { positionTitle: "Job Rollback Engineer", company: "Job Rollback Company" }
  });
  db.exec(`CREATE TRIGGER fail_inbound_job
    BEFORE INSERT ON jobs
    WHEN NEW.source_id LIKE 'inbound:%'
    BEGIN
      SELECT RAISE(ABORT, 'forced inbound job rollback');
    END`);
  assert.throws(
    () => resolveInboundOpportunity({
      db,
      input: {
        profileId: jobRollback.profileId,
        conversationKey: jobRollbackKey,
        previewDigest: createdPreview,
        action: "create"
      },
      now: () => NOW
    }),
    /forced inbound job rollback/
  );
  db.exec("DROP TRIGGER fail_inbound_job");
  assert.strictEqual(listUnresolvedMessageDiscoveryItems(db, { profileId: jobRollback.profileId })
    .some((item) => item.conversationKey === jobRollbackKey), true);

  const baselineRollbackKey = safeDigest(["conversation", "inbound-baseline-rollback"]);
  const baselineRollbackPreview = safeDigest(["preview", "inbound-baseline-rollback"]);
  recordUnresolvedMessageDiscoveryItem(db, {
    profileId: fixture.profileId,
    platform: "boss",
    conversationKey: baselineRollbackKey,
    previewDigest: baselineRollbackPreview,
    previewKind: "possible_hr_reply",
    reasonCode: "BOSS_MESSAGE_CARD_NOT_FOUND",
    observedAt: NOW,
    identity: { positionTitle: "Baseline Rollback Engineer", company: "Baseline Rollback Company" }
  });
  db.exec(`CREATE TRIGGER fail_inbound_baseline
    BEFORE INSERT ON message_preview_states
    WHEN NEW.conversation_key = '${baselineRollbackKey}'
    BEGIN
      SELECT RAISE(ABORT, 'forced inbound baseline rollback');
    END`);
  assert.throws(
    () => resolveInboundOpportunity({
      db,
      input: {
        profileId: fixture.profileId,
        conversationKey: baselineRollbackKey,
        previewDigest: baselineRollbackPreview,
        action: "ignore"
      },
      now: () => NOW
    }),
    /forced inbound baseline rollback/
  );
  db.exec("DROP TRIGGER fail_inbound_baseline");
  assert.strictEqual(listUnresolvedMessageDiscoveryItems(db, { profileId: fixture.profileId })
    .some((item) => item.conversationKey === baselineRollbackKey), true);
  assert.strictEqual(listPreviewStates(db, { profileId: fixture.profileId })
    .some((item) => item.conversationKey === baselineRollbackKey), false);
  assert.strictEqual(db.prepare(`SELECT COUNT(*) AS count FROM events
    WHERE event_type = 'message_inbound_ignored'
      AND payload_json LIKE ?`).get(`%${baselineRollbackKey}%`).count, 0);
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
  assert.strictEqual(
    listPreviewStates(db, { profileId: unsupported.profileId }).length,
    0,
    "unsupported content must not commit the conversation preview"
  );

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

  const structured = createFixture({ suffix: "group-structured", title: "Group Structured Engineer" });
  const languageQuestion = "请问你的英语和粤语水平如何？";
  const structuredDraft = "您好，我的英语可以用于工作沟通，粤语目前能理解日常表达。";
  let structuredModelTexts = null;
  const structuredSummary = await runBossMessageDiscovery({
    db,
    profileId: structured.profileId,
    reader: fakeReader([selectedConversation({
      title: structured.title,
      messages: [
        message("friend", "810000000000000", "岗位竞争情况", "platform_notice"),
        message("friend", "810000000000001", languageQuestion, "text"),
        message("friend", "810000000000002", "附件简历请求", "resume_request")
      ]
    })]),
    classifyMessageGroup: async ({ messages }) => {
      structuredModelTexts = messages.map((item) => item.text);
      return classification({ messages: [structuredDraft] });
    },
    sleepFn: async () => {}
  });
  assert.strictEqual(structuredSummary.processed, 1);
  assert.deepStrictEqual(structuredModelTexts, [languageQuestion]);
  assert.strictEqual(structuredSummary.results[0].stage, "needs_user_action");
  assert.deepStrictEqual(structuredSummary.results[0].messages, [structuredDraft]);
  assert.deepStrictEqual(structuredSummary.results[0].manualActions, [{ kind: "resume_request" }]);
  assert.strictEqual(
    listProgressEvents(db, structured.card.id).filter((event) => event.type === "incoming_message_classified").length,
    3,
    "every supported incoming item in the mixed group must receive a message-level idempotency event"
  );
  const structuredPersisted = allText(db, "candidate_progress_events");
  for (const forbidden of [languageQuestion, structuredDraft, "岗位竞争情况", "附件简历请求", "同意", "拒绝"]) {
    assert(!structuredPersisted.includes(forbidden), `${forbidden} must not be persisted from a structured message group`);
  }

  const resumeOnly = createFixture({ suffix: "group-resume-only", title: "Group Resume Only Engineer" });
  let resumeOnlyModelCalls = 0;
  const resumeOnlySummary = await runBossMessageDiscovery({
    db,
    profileId: resumeOnly.profileId,
    reader: fakeReader([selectedConversation({
      title: resumeOnly.title,
      messages: [message("friend", "820000000000000", "附件简历请求", "resume_request")]
    })]),
    classifyMessageGroup: async () => {
      resumeOnlyModelCalls += 1;
      return classification();
    },
    sleepFn: async () => {}
  });
  assert.strictEqual(resumeOnlyModelCalls, 0, "a resume-only group must not call the text model");
  assert.strictEqual(resumeOnlySummary.processed, 1);
  assert.deepStrictEqual(resumeOnlySummary.results[0].messages, []);
  assert.deepStrictEqual(resumeOnlySummary.results[0].manualActions, [{ kind: "resume_request" }]);
  assert.strictEqual(resumeOnlySummary.results[0].stage, "needs_user_action");

  const platformOnly = createFixture({ suffix: "group-platform-only", title: "Group Platform Only Engineer" });
  let platformOnlyModelCalls = 0;
  const platformOnlySummary = await runBossMessageDiscovery({
    db,
    profileId: platformOnly.profileId,
    reader: fakeReader([selectedConversation({
      title: platformOnly.title,
      messages: [message("friend", "830000000000000", "岗位竞争情况", "platform_notice")]
    })]),
    classifyMessageGroup: async () => {
      platformOnlyModelCalls += 1;
      return classification();
    },
    sleepFn: async () => {}
  });
  assert.strictEqual(platformOnlyModelCalls, 0, "a platform-only group must not call the text model");
  assert.strictEqual(platformOnlySummary.processed, 0);
  assert.deepStrictEqual(platformOnlySummary.results, []);
  assert.strictEqual(
    listPreviewStates(db, { profileId: platformOnly.profileId }).length,
    1,
    "a platform-only group must commit its row preview so it is not rediscovered as HR communication"
  );

  const unknownCard = createFixture({ suffix: "group-unknown-card", title: "Group Unknown Card Engineer" });
  const unknownCardSummary = await runBossMessageDiscovery({
    db,
    profileId: unknownCard.profileId,
    reader: fakeReader([selectedConversation({
      title: unknownCard.title,
      messages: [message("friend", "840000000000000", "未知操作卡片", "unknown")]
    })]),
    classifyMessageGroup: async () => {
      throw new Error("an unknown card must not call the model");
    }
  });
  assertStopped(unknownCardSummary, "BOSS_MESSAGE_CONTENT_UNSUPPORTED");
  assert.strictEqual(listPreviewStates(db, { profileId: unknownCard.profileId }).length, 0);

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

  const incremental = createFixture({ suffix: "group-incremental", title: "Group Incremental Engineer" });
  const incrementalThreadKey = safeDigest(["boss", PRIVATE_RECRUITER, incremental.title]);
  const processedKeys = Array.from({ length: 5 }, (_, index) => messageKey({
    platform: "boss",
    threadKey: incrementalThreadKey,
    messageId: String(910000000000000 + index)
  }));
  recordDiscoveredMessageGroupClassification(db, {
    cardId: incremental.card.id,
    platform: "boss",
    threadKey: incrementalThreadKey,
    messageKeys: processedKeys,
    messageGroupKey: safeDigest(["message-group", incrementalThreadKey, ...processedKeys]),
    messageIntent: "information_request",
    messageCategory: "qualification",
    missingFactKey: "",
    progressUpdate: { stage: "reply_ready" },
    occurredAt: NOW
  });
  const incrementalSummary = await runBossMessageDiscovery({
    db,
    profileId: incremental.profileId,
    reader: fakeReader([selectedConversation({
      title: incremental.title,
      messages: [
        ...processedKeys.map((key, index) => message("friend", String(910000000000000 + index), `old ${index}`)),
        message("friend", "910000000000005", "new follow-up")
      ]
    })]),
    classifyMessageGroup: async () => {
      throw new Error("complete grouped context over the limit must not call the model");
    }
  });
  assertStopped(incrementalSummary, "BOSS_MESSAGE_GROUP_LIMIT");
}

async function previewChannelSmoke() {
  const fixture = createFixture({ suffix: "preview-channel", title: "Preview Channel Engineer" });
  const conversationKey = safeDigest(["conversation", "preview-channel"]);
  const firstDigest = safeDigest(["preview", "first"]);
  const changedDigest = safeDigest(["preview", "changed"]);
  const row = (previewDigest) => ({
    rowIndex: 0,
    unread: false,
    selected: false,
    recruiterKey: safeDigest(["recruiter", "preview"]),
    conversationKey,
    previewDigest,
    previewKind: "possible_hr_reply",
    transientSignature: safeDigest(["row", previewDigest])
  });
  let opens = 0;
  let scanCount = 0;
  const reader = {
    async scanConversationRows() {
      scanCount += 1;
      return { tabId: "fake-tab", path: "/web/geek/chat", rows: Object.freeze([Object.freeze(row(scanCount === 1 ? firstDigest : changedDigest))]) };
    },
    async openQueuedConversation(target) {
      opens += 1;
      assert.strictEqual(target.operation, "preview_changed");
      return selectedConversation({
        title: fixture.title,
        messageId: opens === 1 || opens === 2 ? "123456789012390" : "123456789012391"
      });
    }
  };
  let modelCalls = 0;
  const first = await runBossMessageDiscovery({
    db,
    profileId: fixture.profileId,
    reader,
    classifyMessageGroup: async () => {
      modelCalls += 1;
      return classification();
    },
    sleepFn: async () => {}
  });
  assert.strictEqual(first.status, "completed");
  assert.strictEqual(first.processed, 0);
  assert.strictEqual(modelCalls, 0);
  assert.strictEqual(opens, 0);
  assert.strictEqual(
    listPreviewStates(db, { profileId: fixture.profileId })[0].previewDigest,
    firstDigest,
    "first observation must only establish a baseline"
  );

  await assert.rejects(
    () => runBossMessageDiscovery({
      db,
      profileId: fixture.profileId,
      reader,
      classifyMessageGroup: async () => {
        throw new Error("model failed");
      },
      sleepFn: async () => {}
    }),
    /model failed/
  );
  assert.strictEqual(
    listPreviewStates(db, { profileId: fixture.profileId })[0].previewDigest,
    firstDigest,
    "a failed classification must not advance the preview baseline"
  );
  assert.strictEqual(opens, 1, "the failed run must open the conversation but must not commit it");

  const second = await runBossMessageDiscovery({
    db,
    profileId: fixture.profileId,
    reader,
    classifyMessageGroup: async () => {
      modelCalls += 1;
      return classification();
    },
    sleepFn: async () => {}
  });
  assert.strictEqual(second.status, "completed");
  assert.strictEqual(second.processed, 1);
  assert.strictEqual(modelCalls, 1);
  assert.strictEqual(opens, 2);
  assert.strictEqual(
    listPreviewStates(db, { profileId: fixture.profileId })[0].previewDigest,
    changedDigest,
    "processed preview change must advance the baseline"
  );
  commitProcessedPreview(db, {
    profileId: fixture.profileId,
    platform: "boss",
    conversationKey,
    previewDigest: firstDigest,
    previewKind: "possible_hr_reply",
    observedAt: NOW
  });
  const third = await runBossMessageDiscovery({
    db,
    profileId: fixture.profileId,
    reader,
    classifyMessageGroup: async () => {
      modelCalls += 1;
      return classification();
    },
    sleepFn: async () => {}
  });
  assert.strictEqual(third.status, "completed");
  assert.strictEqual(third.processed, 1, "a second preview change must be discovered again");
  assert.strictEqual(modelCalls, 2);
  assert.strictEqual(opens, 3);
}

async function unsupportedPreviewSmoke() {
  const fixture = createFixture({ suffix: "preview-unsupported", title: "Preview Unsupported Engineer" });
  const conversationKey = safeDigest(["conversation", "preview-unsupported"]);
  commitProcessedPreview(db, {
    profileId: fixture.profileId,
    platform: "boss",
    conversationKey,
    previewDigest: safeDigest(["preview", "text"]),
    previewKind: "possible_hr_reply",
    observedAt: NOW
  });
  let opens = 0;
  const reader = {
    async scanConversationRows() {
      return {
        tabId: "fake-tab",
        path: "/web/geek/chat",
        rows: Object.freeze([Object.freeze({
          rowIndex: 0,
          unread: false,
          selected: false,
          conversationKey,
          previewDigest: safeDigest(["preview", "voice"]),
          previewKind: "unsupported",
          transientSignature: safeDigest(["row", "unsupported"])
        })])
      };
    },
    async openQueuedConversation() {
      opens += 1;
      throw new Error("unsupported preview must stop before clicking");
    }
  };
  const summary = await runBossMessageDiscovery({
    db,
    profileId: fixture.profileId,
    reader,
    classifyMessageGroup: async () => {
      throw new Error("unsupported preview must not call the model");
    },
    sleepFn: async () => {}
  });
  assertStopped(summary, "BOSS_MESSAGE_CONTENT_UNSUPPORTED");
  assert.strictEqual(opens, 0);
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

  const interviewMention = createFixture({ suffix: "interview-mention", title: "Interview System Engineer" });
  summary = await runBossMessageDiscovery({
    db,
    profileId: interviewMention.profileId,
    reader: fakeReader([selectedConversation({ title: interviewMention.title, messageId: "123456789012351" })]),
    classifyMessageGroup: async () => classification({
      messageIntent: "information_update",
      messageCategory: "other",
      messageSummary: "对方在介绍岗位涉及的面试安排系统。",
      stage: "reply_ready",
      messages: ["了解了，谢谢你补充岗位信息。"]
    })
  });
  assert.strictEqual(summary.results[0].messageIntent, "information_update");
  assert.strictEqual(summary.results[0].stage, "reply_ready");
  assert.notStrictEqual(summary.results[0].stage, "interview_invited");

  const interview = createFixture({ suffix: "interview", title: "Interview Engineer" });
  summary = await runBossMessageDiscovery({
    db,
    profileId: interview.profileId,
    reader: fakeReader([selectedConversation({ title: interview.title, messageId: "123456789012352" })]),
    classifyMessageGroup: async () => classification({
      messageIntent: "interview_invitation",
      messageCategory: "other",
      messageSummary: "对方正式邀请候选人参加面试。",
      stage: "interview_invited",
      messages: ["您好，感谢邀请，请问面试时间和形式如何安排？"]
    })
  });
  assert.strictEqual(summary.results[0].stage, "interview_invited");
  assert.strictEqual(summary.results[0].messageIntent, "interview_invitation");
  assert.strictEqual(summary.results[0].messageSummary, "对方正式邀请候选人参加面试。");
  assert.deepStrictEqual(summary.results[0].messages, ["您好，感谢邀请，请问面试时间和形式如何安排？"]);
  assert.strictEqual(summary.results[0].manualActionReason, "");

  for (const [suffix, existingStage, messageId] of [
    ["after-interview-invited", "interview_invited", "123456789012356"],
    ["after-interview-scheduled", "interview_scheduled", "123456789012357"]
  ]) {
    const followUp = createFixture({ suffix, title: `${suffix} Engineer` });
    transitionProgressCard(db, {
      cardId: followUp.card.id,
      expectedStage: "contact_started",
      stage: "interview_invited",
      nextAction: "KEEP_INVITED_NEXT_ACTION",
      now: NOW
    });
    if (existingStage === "interview_scheduled") {
      transitionProgressCard(db, {
        cardId: followUp.card.id,
        expectedStage: "interview_invited",
        stage: "interview_scheduled",
        nextAction: "KEEP_SCHEDULED_NEXT_ACTION",
        scheduledAt: "2026-08-20T07:00:00.000Z",
        now: NOW
      });
    }
    const followUpSummary = await runBossMessageDiscovery({
      db,
      profileId: followUp.profileId,
      reader: fakeReader([selectedConversation({ title: followUp.title, messageId })]),
      classifyMessageGroup: async () => classification({
        messageCategory: "availability",
        messageSummary: "对方正在确认候选人的到岗时间。",
        stage: "reply_ready",
        messages: ["您好，我可以在确认安排后尽快回复到岗时间。"]
      }),
      now: () => NOW,
      sleepFn: async () => {}
    });
    assert.strictEqual(followUpSummary.status, "completed");
    assert.strictEqual(followUpSummary.processed, 1);
    assert.strictEqual(followUpSummary.results[0].stage, existingStage);
    assert.deepStrictEqual(followUpSummary.results[0].messages, ["您好，我可以在确认安排后尽快回复到岗时间。"]);
    const preservedCard = getProgressCardForJob(db, {
      profileId: followUp.profileId,
      jobId: followUp.jobId
    });
    assert.strictEqual(
      preservedCard.nextAction,
      existingStage === "interview_scheduled" ? "KEEP_SCHEDULED_NEXT_ACTION" : "KEEP_INVITED_NEXT_ACTION"
    );
    assert.strictEqual(
      preservedCard.scheduledAt,
      existingStage === "interview_scheduled" ? "2026-08-20T07:00:00.000Z" : null
    );
    const classificationEvent = listProgressEvents(db, followUp.card.id)
      .find((event) => event.type === "message_group_classified");
    assert(classificationEvent, "a follow-up message result must persist without downgrading the opportunity stage");
    assert.strictEqual(classificationEvent.metadata.messageCategory, "availability");
    assert.strictEqual(classificationEvent.metadata.stage, "reply_ready",
      "the message outcome must remain distinct from the preserved opportunity stage");
  }

  for (const [suffix, messageCategory, reason] of [
    ["salary-manual", "salary", "薪资问题需要人工确认口径"],
    ["sensitive-manual", "sensitive", "消息涉及敏感信息，需要人工处理"],
    ["identity-manual", "identity_uncertain", "岗位或会话身份仍需人工核对"]
  ]) {
    const manual = createFixture({ suffix, title: `${suffix} Engineer` });
    const manualSummary = await runBossMessageDiscovery({
      db,
      profileId: manual.profileId,
      reader: fakeReader([selectedConversation({
        title: manual.title,
        messageId: suffix === "salary-manual" ? "123456789012352"
          : suffix === "sensitive-manual" ? "123456789012353"
            : "123456789012354"
      })]),
      classifyMessageGroup: async () => classification({
        messageCategory,
        stage: "needs_user_action",
        messages: ["must not escape"]
      }),
      now: () => NOW,
      sleepFn: async () => {}
    });
    assert.deepStrictEqual(manualSummary.results[0].messages, []);
    assert.strictEqual(manualSummary.results[0].manualActionReason, reason);
    assert.strictEqual(manualSummary.results[0].contextComplete, true);
    assert(Object.hasOwn(manualSummary.results[0], "job"), "manual-only result must retain safe job context");
  }

  for (const [index, code] of [
    "MESSAGE_REPLY_INVALID",
    "MODEL_EMPTY_RESPONSE",
    "MODEL_INVALID_RESPONSE",
    "MODEL_OUTPUT_TRUNCATED",
    "MODEL_INVALID_JSON"
  ].entries()) {
    const invalidModel = createFixture({ suffix: `invalid-model-${index}`, title: `Invalid Model ${index} Engineer` });
    const invalidSummary = await runBossMessageDiscovery({
      db,
      profileId: invalidModel.profileId,
      reader: fakeReader([selectedConversation({
        title: invalidModel.title,
        messageId: String(123456789012360 + index)
      })]),
      classifyMessageGroup: async () => {
        throw Object.assign(new Error(`invalid provider output ${PRIVATE_BODY}`), { code });
      },
      now: () => NOW,
      sleepFn: async () => {}
    });
    assert.strictEqual(invalidSummary.status, "completed");
    assert.strictEqual(invalidSummary.processed, 1);
    assert.strictEqual(invalidSummary.results[0].messageIntent, "manual_review");
    assert.strictEqual(invalidSummary.results[0].messageCategory, "other");
    assert.strictEqual(invalidSummary.results[0].stage, "needs_user_action");
    assert.strictEqual(
      invalidSummary.results[0].manualActionReason,
      "模型结果未通过安全校验，需要人工处理"
    );
    assert.deepStrictEqual(invalidSummary.results[0].messages, []);
    assert(!JSON.stringify(invalidSummary).includes(PRIVATE_BODY));
  }

  for (const [index, code] of ["MODEL_AUTH_FAILED", "MODEL_TIMEOUT"].entries()) {
    const infrastructureFailure = createFixture({
      suffix: `model-infrastructure-${index}`,
      title: `Model Infrastructure ${index} Engineer`
    });
    await assert.rejects(
      () => runBossMessageDiscovery({
        db,
        profileId: infrastructureFailure.profileId,
        reader: fakeReader([selectedConversation({
          title: infrastructureFailure.title,
          messageId: String(123456789012370 + index)
        })]),
        classifyMessageGroup: async () => {
          throw Object.assign(new Error("model infrastructure failed"), { code });
        },
        now: () => NOW,
        sleepFn: async () => {}
      }),
      (error) => error.code === code,
      `${code} must stop instead of being downgraded to a result card`
    );
  }
}

async function readerStopSmoke() {
  const fixture = createFixture({ suffix: "reader-stop", title: "Reader Stop Engineer" });
  for (const code of [
    "BOSS_MESSAGE_LOGIN_REQUIRED",
    "BOSS_MESSAGE_PAGE_LOST"
  ]) {
    const calls = [];
    const error = Object.assign(new Error("redacted reader stop"), { code });
    const reader = {
      async scanConversationRows() {
        return {
          tabId: "fake-tab",
          path: "/web/geek/chat",
          rows: Object.freeze([0, 1].map((index) => Object.freeze({
            rowIndex: index,
            unread: true,
            selected: false,
            conversationKey: safeDigest(["conversation", String(index)]),
            previewDigest: safeDigest(["preview", String(index)]),
            previewKind: "possible_hr_reply",
            transientSignature: safeDigest(["row", String(index)])
          })))
        };
      },
      async openQueuedConversation(target) {
        calls.push(target.rowIndex);
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
  const riskCalls = [];
  const riskError = Object.assign(new Error("redacted risk control"), { code: "BOSS_RISK_CONTROL" });
  await assert.rejects(
    () => runBossMessageDiscovery({
      db,
      profileId: fixture.profileId,
      reader: {
        async scanConversationRows() {
          return {
            tabId: "fake-tab",
            path: "/web/geek/chat",
            rows: Object.freeze([Object.freeze({
              rowIndex: 0,
              unread: true,
              selected: false,
              conversationKey: safeDigest(["conversation", "risk"]),
              previewDigest: safeDigest(["preview", "risk"]),
              previewKind: "possible_hr_reply",
              transientSignature: safeDigest(["row", "risk"])
            })])
          };
        },
        async openQueuedConversation(target) {
          riskCalls.push(target.rowIndex);
          throw riskError;
        }
      },
      classifyMessageGroup: async () => {
        throw new Error("risk control must stop before model use");
      }
    }),
    (error) => error === riskError
  );
  assert.deepStrictEqual(riskCalls, [0], "risk control must stop the immutable queue");
}

async function terminalAfterProcessedSmoke() {
  for (const [suffix, code] of [
    ["page-lost", "BOSS_MESSAGE_PAGE_LOST"],
    ["login-required", "BOSS_MESSAGE_LOGIN_REQUIRED"],
    ["reader-error", "MESSAGE_DISCOVERY_READER_ERROR"]
  ]) {
    const fixture = createFixture({ suffix: `terminal-after-${suffix}`, title: `Terminal ${suffix} Engineer` });
    const terminal = Object.assign(new Error("redacted terminal"), { code });
    let modelCalls = 0;
    const summary = await runBossMessageDiscovery({
      db,
      profileId: fixture.profileId,
      reader: {
        async scanConversationRows() {
          return {
            tabId: "fake-tab",
            path: "/web/geek/chat",
            rows: Object.freeze([
              Object.freeze(messageRow(0, true, safeDigest(["conversation", `${suffix}-first`]), safeDigest(["preview", `${suffix}-first`]))),
              Object.freeze(messageRow(1, true, safeDigest(["conversation", `${suffix}-second`]), safeDigest(["preview", `${suffix}-second`])))
            ])
          };
        },
        async openQueuedConversation(target) {
          if (target.rowIndex === 1) throw terminal;
          return selectedConversation({ title: fixture.title, messageId: "123456789012510" });
        }
      },
      classifyMessageGroup: async () => {
        modelCalls += 1;
        return classification();
      },
      sleepFn: async () => {}
    });
    assert.strictEqual(summary.status, "needs_user_action");
    assert.strictEqual(summary.reasonCode, code);
    assert.strictEqual(summary.processed, 1, "a later terminal failure must preserve earlier successful processing");
    assert.strictEqual(summary.results.length, 1, "terminal summary results must match its processed count");
    assert.strictEqual(modelCalls, 1);
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
  const pacing = createFixture({ suffix: "pacing", title: "Pacing Engineer 0" });
  const pacingFixtures = [pacing, ...Array.from({ length: 10 }, (_, index) => createFixture({
    suffix: `pacing-${index + 1}`,
    title: `Pacing Engineer ${index + 1}`,
    profileId: pacing.profileId,
    planId: pacing.planId
  }))];
  const conversations = pacingFixtures.map((fixture, index) => selectedConversation({
    title: fixture.title,
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

  const mixed = createFixture({ suffix: "mixed-pacing", title: "Mixed Pacing Engineer 0" });
  const mixedFixtures = [mixed, ...Array.from({ length: 9 }, (_, index) => createFixture({
    suffix: `mixed-pacing-${index + 1}`,
    title: `Mixed Pacing Engineer ${index + 1}`,
    profileId: mixed.profileId,
    planId: mixed.planId
  }))];
  const duplicateId = "123456789012380";
  const mixedConversations = [
    selectedConversation({ title: mixedFixtures[0].title, messageId: duplicateId }),
    selectedConversation({ title: mixedFixtures[1].title, messageId: duplicateId }),
    { skipped: true, reasonCode: "BOSS_MESSAGE_NO_LONGER_UNREAD" },
    ...Array.from({ length: 8 }, (_, index) => selectedConversation({
      title: mixedFixtures[index + 2].title,
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
  assert.strictEqual(mixedSummary.processed, 10);
  assert.strictEqual(mixedModelCalls, 10);
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

  const leaseFixture = createFixture({ suffix: "lease", title: "Lease Engineer 0" });
  const leaseFixtures = [leaseFixture, ...Array.from({ length: 10 }, (_, index) => createFixture({
    suffix: `lease-${index + 1}`,
    title: `Lease Engineer ${index + 1}`,
    profileId: leaseFixture.profileId,
    planId: leaseFixture.planId
  }))];
  const leaseController = new AbortController();
  const leaseReason = Object.assign(new Error("lease lost"), { code: "MESSAGE_DISCOVERY_LEASE_LOST" });
  let randomWaits = 0;
  await assert.rejects(
    () => runBossMessageDiscovery({
      db,
      profileId: leaseFixture.profileId,
      reader: fakeReader(leaseFixtures.map((fixture, index) => selectedConversation({
        title: fixture.title,
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
  company = "Fixture Company",
  analysis = {}
}) {
  if (!profileId) {
    const profile = {
      candidate: {
        name: `Candidate ${suffix}`,
        city,
        targetTitles: [title],
        expectedSalary: salary,
        adjustableSalary: []
      },
      education: [{ degree: "Bachelor", major: "Computer Science", status: "completed" }],
      experiences: [],
      skills: [{ name: "Java", level: "resume", evidence: ["KnowledgeFlow"] }],
      projects: [{ name: "KnowledgeFlow", roleBoundary: "individual contributor", canSay: ["built retrieval"], technologies: ["Java"], results: [] }],
      credentials: [],
      strengths: ["reliable delivery"],
      riskMessaging: { gap: "PRIVATE_PROFILE_RISK" },
      source: { provider: "private" }
    };
    profileId = Number(db.prepare(`INSERT INTO candidate_profiles(
      display_name, profile_json, source_hash, created_at, updated_at
    ) VALUES (?, ?, NULL, ?, ?)`).run(`Candidate ${suffix}`, JSON.stringify(profile), NOW, NOW).lastInsertRowid);
  }
  if (!planId) {
    planId = Number(db.prepare(`INSERT INTO search_plans(
      profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
    ) VALUES (?, ?, '{}', NULL, 1, ?, ?)`).run(profileId, `Plan ${suffix}`, NOW, NOW).lastInsertRowid);
  }
  const batchId = createBatch(db, "boss", "message-discovery-fixture", "complete message discovery context", {
    profileId,
    searchPlanId: planId
  });
  const jobId = upsertJob(db, {
    source: "boss",
    sourceId: `job-${suffix}`,
    keyword: "message-discovery-fixture",
    title,
    company,
    location: city,
    salary,
    experience: "3-5年",
    education: "本科",
    bossActiveText: "今日活跃",
    url: `https://www.zhipin.com/job_detail/job-${suffix}.html`,
    tags: ["Java"],
    description: "Deliver reliable backend systems with clear ownership, production diagnostics, testing, observability, collaboration, and measurable engineering outcomes. ".repeat(2),
    qualityTags: [],
    analysis: { semanticStatus: "complete", recommendation: "primary", marker: suffix, ...analysis }
  }, batchId);
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

function message(direction, messageId, text, contentKind = "text") {
  return { direction, messageId, text, contentKind };
}

async function answerMemoryRefreshSmoke() {
  const first = createFixture({ suffix: "memory-refresh-a", title: "Memory Refresh A" });
  const second = createFixture({
    suffix: "memory-refresh-b",
    title: "Memory Refresh B",
    profileId: first.profileId,
    planId: first.planId
  });
  const seed = recordMessageReplyDrafts(db, {
    profileId: first.profileId,
    cardId: first.card.id,
    jobId: first.jobId,
    messageGroupKey: safeDigest(["memory-refresh-seed"]),
    questionSummary: "对方询问沟通意向。",
    messageIntent: "interest_check",
    messageCategory: "other",
    messages: ["模型原稿"],
    createdAt: NOW
  })[0];
  const memory = completeMessageReplyDraft(db, {
    profileId: first.profileId,
    draftId: seed.id,
    finalText: "这是需要撤回的用户回答。",
    changedText: "这是需要撤回的用户回答",
    completionKind: "copied",
    extractedFacts: [],
    completedAt: NOW
  });
  let call = 0;
  const summary = await runBossMessageDiscovery({
    db,
    profileId: first.profileId,
    reader: fakeReader([
      selectedConversation({ title: first.title, messageId: "123456789012811" }),
      selectedConversation({ title: second.title, messageId: "123456789012812" })
    ]),
    classifyMessageGroup: async ({ answerMemories }) => {
      call += 1;
      if (call === 1) {
        assert.deepStrictEqual(answerMemories.map((item) => item.id), [memory.id]);
        withdrawCandidateAnswerMemory(db, {
          profileId: first.profileId,
          memoryId: memory.id,
          withdrawnAt: "2026-07-30T01:00:01.000Z"
        });
      } else {
        assert.deepStrictEqual(answerMemories, [], "each conversation must reload current active answer memories");
      }
      return classification({ messages: ["本轮草稿"] });
    },
    now: () => NOW,
    sleepFn: async () => {}
  });
  assert.strictEqual(summary.processed, 2);
}

function fact(key, daysAgo) {
  const at = new Date(Date.parse(NOW) - daysAgo * 86_400_000).toISOString();
  return { key, value: "confirmed", source: "user_provided", updatedAt: at };
}

function fakeReader(conversations) {
  let active = 0;
  let maxActive = 0;
  return {
    async scanConversationRows() {
      return {
        tabId: "fake-tab",
        path: "/web/geek/chat",
        rows: Object.freeze(conversations.map((conversation, index) => Object.freeze({
          rowIndex: index,
          unread: true,
          selected: false,
          recruiterLabel: "recruiter",
          previewText: `preview-${index}`,
          recruiterKey: safeDigest(["recruiter", `recruiter-${index}`]),
          conversationKey: safeDigest(["conversation", String(index)]),
          previewDigest: safeDigest(["preview", `preview-${index}`]),
          previewKind: "possible_hr_reply",
          transientSignature: safeDigest(["row", String(index)])
        })))
      };
    },
    async openQueuedConversation(target) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      assert.strictEqual(maxActive, 1, "message discovery must remain serial");
      const selected = conversations[target.rowIndex];
      active -= 1;
      return selected;
    }
  };
}

function messageRow(rowIndex, unread, conversationKey, previewDigest) {
  return {
    rowIndex,
    unread,
    selected: false,
    conversationKey,
    previewDigest,
    previewKind: "possible_hr_reply",
    transientSignature: safeDigest(["row", String(rowIndex)])
  };
}

function classification({
  messageIntent = "information_request",
  messageCategory = "qualification",
  messageSummary = "对方正在确认候选人的任职资格。",
  stage = "reply_ready",
  messages = ["safe draft"]
} = {}) {
  return {
    kind: "hr_reply",
    messageIntent,
    messageCategory,
    messageSummary,
    missingFact: null,
    progressUpdate: { stage, nextAction: "Review before manual send", summary: "sanitized" },
    messages
  };
}

function resolvedContext(candidate, threadKey) {
  return {
    cardId: candidate.cardId,
    card: {
      id: candidate.cardId,
      profileId: candidate.profileId,
      planId: candidate.planId,
      jobId: candidate.jobId,
      source: candidate.source,
      stage: candidate.stage,
      threadKey: candidate.threadKey
    },
    job: {
      id: candidate.jobId,
      source: candidate.source,
      sourceId: candidate.sourceId,
      title: candidate.title,
      company: candidate.company,
      salary: candidate.salary,
      location: candidate.city,
      description: candidate.description,
      analysis: candidate.analysis
    },
    threadKey,
    contextSource: "local_cache"
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
