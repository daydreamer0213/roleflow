const assert = require("assert");

const CANDIDATE_EXPORTS = [
  "saveProfileAnalysis",
  "attachResumeDocumentFile",
  "getResumeDocument",
  "saveSearchPlan",
  "getCandidateProfile",
  "listCandidateProfiles",
  "saveCandidateResumeVersion",
  "listCandidateResumeVersions",
  "listMatchingResumeVersions",
  "recordResumeParseAttempt",
  "listResumeParseAttempts",
  "updateCandidateProfile",
  "getSearchPlan",
  "getActiveSearchPlan",
  "listSearchPlans",
  "listProfileVersions",
  "getLatestProfileVersionId",
  "getSearchPlanDependency",
  "getMatchingCard",
  "getActiveMatchingCard",
  "listMatchingCards",
  "createMatchingCardDraft",
  "confirmMatchingCard",
  "saveMatchingCardDraftEdit",
  "saveConfirmedMatchingCardRevision",
  "getCandidateMatchingContext",
  "compareProfileVersions",
  "saveCandidateFact",
  "listCandidateFacts"
].sort();

const FACADE_EXPORTS = [
  "OUTCOME_STATUSES", "SCAN_RUN_STATUSES", "SCHEMA", "SCHEMA_VERSION", "WORKFLOW_RUN_STATUSES", "WORKFLOW_TIMEOUT_CIRCUIT_OPEN_CODE", "replaceWorkflowScanContext",
  "acquireSiteScanLease", "activateResumeOptimization", "addFollowUpNote", "answerMockInterviewTurn", "appendMockInterviewQuestion", "applyJobQualityGovernance", "archiveCandidateJob", "attachResumeDocumentFile", "attachWorkflowCommunication", "attachWorkflowScan", "attachWorkflowScanRun", "backfillHistoricalCommunicationOutcomes", "beginScanRun", "bindBatchToPlan", "buildBatchSummary", "buildFeedbackSummary", "checkpointScanProgress", "checkpointScanTarget", "claimScanRun", "claimWorkflowJobTaskRow", "clearSiteRuntimeState", "closeMessageReplyDrafts", "closeOpenMessageReplyDraftsByIntent", "compareProfileVersions", "completeMessageReplyDraft", "completeMockInterviewSession", "completeWorkflowJobTaskRow", "confirmMatchingCard", "countWorkflowJobTaskStatuses", "countWorkflowJobTasks", "createAndBindScanBatch", "createBatch", "createMatchingCardDraft", "createMessageReplySendBatch", "createMockInterviewSession", "createResumeOptimization", "createScanRun", "createWorkflowRun", "decisionBucket", "deleteCandidateFact", "deleteMessageInboundContext", "ensureActiveFunnelStrategyRound", "ensureFunnelEntry", "failWorkflowJobTaskRow", "finishJobAnalysisAttemptRow", "finishScanRun", "freezeReadyFunnelCohort", "getActiveFunnelStrategyRound", "getActiveMatchingCard", "getActiveSearchPlan", "getActiveWorkflowRun", "getBatch", "getCandidateMatchingContext", "getCandidateProfile", "getFunnelCohort", "getFunnelEntry", "getFunnelPolicy", "getFunnelStrategyRound", "getLatestBatchId", "getLatestJobRefreshAttempt", "getLatestMainScanBatchId", "getLatestProfileVersionId", "getLatestResumableBatch", "getLatestScanRun", "getMatchingCard", "getMessageInboundContext", "getMessageReplyDraft", "getMessageReplySendBatch", "getMockInterviewSession", "getModelCache", "getOutcomeAnalyticsSnapshot", "getPlatformFilterCatalog", "getResumeDocument", "getResumeOptimization", "getRunningJobAnalysisAttemptRow", "getScanRun", "getSearchPlan", "getSearchPlanDependency", "getSitePacingState", "getSiteRuntimeState", "getSiteScanLease", "getWorkflowHealthSnapshot", "getWorkflowJobTaskRow", "getWorkflowObservationJob", "getWorkflowRun", "getWorkflowRunByCommunicationBatch", "heartbeatScanRun", "immediateTransaction", "incrementWorkflowRunActivity", "incrementWorkflowTimeoutCounters", "insertJobAnalysisAttemptRow", "insertWorkflowJobTaskRow", "interruptOrphanedScanRuns", "isActivityProbeDue", "isCandidateJobArchived", "isJobAwaitingAction", "isWorkflowJobTaskObservationReady", "jobAnalysisAttemptRow", "listCandidateAnswerMemories", "listCandidateFactRevisions", "listCandidateFacts", "listCandidateJobEvents", "listCandidateProfiles", "listCandidateResumeVersions", "listDecisionPool", "listDecisionQueue", "listFunnelCohorts", "listFunnelEntries", "listFunnelProgressEvents", "listFunnelStrategyRounds", "listJobAnalysisAttemptRows", "listJobRefreshAttempts", "listLatestScanTargetResults", "listMatchingCards", "listMatchingResumeVersions", "listMessageInboundContexts", "listMessageReplySendItems", "listMockInterviewSessions", "listOpenMessageReplyDrafts", "listProfileVersions", "listReportJobs", "listResumeOptimizations", "listResumeParseAttempts", "listReusableJobDetails", "listScanTargetResults", "listSearchPlans", "listSiteAccessEvents", "listWorkflowJobTaskRows", "listWorkflowRuns", "markApplication", "markCandidateJob", "markWorkflowJobTasksStopped", "mergeBossPacingStates", "openDb", "reactivateWorkflowDetailRequiredTaskRow", "reassessBatchObservations", "recordCandidateJobEvent", "recordJobRefreshAttempt", "recordMessageReplyDrafts", "recordMockInterviewRetry", "recordRecommendationFeedback", "recordResumeParseAttempt", "recordScanRunProcessExit", "recordScanTargetResult", "recordSiteAccessEvent", "recordWorkflowPlatformAccess", "recordWorkflowScanWait", "releaseSiteScanLease", "renewSiteScanLease", "requestWorkflowRunConfigurationPause", "rescorePlanObservations", "restoreCandidateJob", "reviseCandidateAnswerMemory", "saveCandidateFact", "saveCandidateResumeVersion", "saveConfirmedMatchingCardRevision", "saveFunnelPolicy", "saveMatchingCardDraftEdit", "saveMessageInboundContext", "saveMessageReplyDraftEdit", "saveModelCache", "savePlatformFilterCatalog", "saveProfileAnalysis", "saveResumeOptimizationDraft", "saveSearchPlan", "selectClaimableWorkflowJobTaskRow", "selectEarliestRetryAvailableAt", "selectExpiredLeaseWorkflowJobTaskRows", "selectReadyWorkflowJobEntries", "setSitePacingState", "setSiteRuntimeState", "settleIncompleteWorkflowJobTaskRows", "sourceContentHash", "startFunnelStrategyRound", "stopPendingMessageReplySendItems", "summarizeScanTargets", "transitionMessageReplySendBatch", "transitionMessageReplySendItem", "transitionWorkflowRun", "updateCandidateProfile", "upsertJob", "upsertKeywordSource", "withdrawCandidateAnswerMemory", "workflowJobTaskRow"
].sort();

assert.strictEqual(CANDIDATE_EXPORTS.length, 29);
assert.strictEqual(FACADE_EXPORTS.length, 191);

const warnings = [];
const onWarning = (warning) => warnings.push(warning);
process.on("warning", onWarning);
const candidateStore = require("../src/storage/candidate_store");
const storage = require("../src/core/storage");
process.removeListener("warning", onWarning);

assert.deepStrictEqual(Object.keys(candidateStore).sort(), CANDIDATE_EXPORTS);
assert.deepStrictEqual(Object.keys(storage).sort(), FACADE_EXPORTS);
for (const name of CANDIDATE_EXPORTS) assert.strictEqual(storage[name], candidateStore[name], `${name} must be a direct facade reference`);
assert.strictEqual(warnings.filter((warning) => /circular/i.test(warning.message)).length, 0, "facade and direct store must load without circular-dependency warnings");

const db = storage.openDb(":memory:");

function observeTransaction(action) {
  const originalExec = db.exec.bind(db);
  const statements = [];
  db.exec = (sql) => {
    statements.push(String(sql));
    return originalExec(sql);
  };
  try {
    return { value: action(), statements };
  } finally {
    db.exec = originalExec;
  }
}

function profile(name, targetTitles = ["AI 产品经理"]) {
  return {
    candidate: { name, city: "广州", targetTitles, expectedSalary: "25k" },
    skills: [{ name: "JavaScript" }],
    projects: [{ name: "RoleFlow" }]
  };
}

function document(hash, text = "resume text") {
  return {
    originalFileName: "candidate-resume.txt",
    format: "text",
    contentHash: hash,
    text,
    diagnostics: { extractionMethod: "text", inputBytes: text.length }
  };
}

function plan(name = "candidate plan") {
  return { name, cities: ["广州"], keywords: ["AI"] };
}

function card(direction = "AI 产品经理") {
  return {
    targetDirections: [direction],
    strongEvidence: [{ label: "产品交付", evidence: "负责 AI 产品交付" }],
    transferableCapabilities: [{ label: "数据分析", evidence: "持续复盘数据", limitation: "缺少行业经验" }],
    cautionTransitions: [],
    userNotes: []
  };
}

try {
  const initialSave = observeTransaction(() => storage.saveProfileAnalysis(db, {
    profile: profile("Candidate One"),
    document: document("resume-v1", "A".repeat(6100)),
    searchPlan: plan()
  }));
  assert.deepStrictEqual(initialSave.statements, ["BEGIN", "COMMIT"]);
  const saved = initialSave.value;
  assert(saved.profileId > 0 && saved.profileVersionId > 0 && saved.resumeVersionId > 0 && saved.resumeDocumentId > 0 && saved.planId > 0);
  assert.strictEqual(storage.getCandidateProfile(db, saved.profileId).displayName, "Candidate One");
  assert.strictEqual(storage.listCandidateProfiles(db)[0].activePlanId, saved.planId);
  assert.strictEqual(storage.getSearchPlan(db, saved.planId).profileVersionId, saved.profileVersionId);
  assert.strictEqual(storage.getSearchPlan(db, saved.planId).plan.schemaVersion, 2);
  assert.deepStrictEqual(storage.getSearchPlan(db, saved.planId).plan.platform.generated.cities, ["广州"]);
  const rawSavedPlan = JSON.parse(db.prepare("SELECT plan_json FROM search_plans WHERE id = ?").get(saved.planId).plan_json);
  assert.strictEqual(Object.hasOwn(rawSavedPlan, "cities"), false);
  assert.strictEqual(Object.hasOwn(rawSavedPlan.platform, "salaryLanes"), false);
  assert.strictEqual(storage.getActiveSearchPlan(db, saved.profileId).id, saved.planId);
  assert.strictEqual(storage.listSearchPlans(db, saved.profileId).length, 1);
  assert.strictEqual(storage.listProfileVersions(db, saved.profileId)[0].resumeDocumentId, saved.resumeDocumentId);
  assert.strictEqual(storage.getLatestProfileVersionId(db, saved.profileId), saved.profileVersionId);
  assert.strictEqual(storage.getSearchPlanDependency(db, saved.planId).matchingCardRequired, true);

  storage.attachResumeDocumentFile(db, saved.resumeDocumentId, "D:/candidate-resume.txt");
  const storedDocument = storage.getResumeDocument(db, saved.resumeDocumentId);
  assert.deepStrictEqual(storedDocument, {
    id: saved.resumeDocumentId,
    profileId: saved.profileId,
    originalFileName: "candidate-resume.txt",
    format: "text",
    contentHash: "resume-v1",
    storedFilePath: "D:/candidate-resume.txt",
    createdAt: storedDocument.createdAt
  });
  assert(!Object.hasOwn(storedDocument, "text"));

  const firstVersion = storage.listCandidateResumeVersions(db, saved.profileId)[0];
  assert.strictEqual(firstVersion.versionKey, `resume_${saved.resumeDocumentId}`);
  assert.strictEqual(firstVersion.resumeTextExcerpt.length, 6000);

  const privateFileName = "13912345678-contact_example.com-联系地址上海市浦东新区隐私路88号.txt";
  const privateFileSecrets = ["13912345678", "上海市浦东新区隐私路88号"];
  const privateSave = storage.saveProfileAnalysis(db, {
    profile: profile("Private Candidate"),
    document: { ...document("private-resume"), originalFileName: privateFileName },
    searchPlan: null
  });
  const privateDocument = storage.getResumeDocument(db, privateSave.resumeDocumentId);
  assert.strictEqual(privateDocument.originalFileName, privateFileName, "explicit source-file metadata must preserve the original filename");
  const privateProfileVersion = storage.listProfileVersions(db, privateSave.profileId)[0];
  assert.strictEqual(privateProfileVersion.fileName, "简历文件.txt");
  for (const secret of privateFileSecrets) {
    assert(!JSON.stringify(privateProfileVersion).includes(secret), `profile-version DTO must mask filename contact: ${secret}`);
  }
  const privateVersion = storage.listCandidateResumeVersions(db, privateSave.profileId)[0];
  assert.strictEqual(privateVersion.name, "基础简历");
  assert.strictEqual(privateVersion.fileName, "简历文件.txt");
  for (const secret of privateFileSecrets) {
    assert(!JSON.stringify(privateVersion).includes(secret), `candidate version DTO must mask filename contact: ${secret}`);
    assert(!String(db.prepare("SELECT name FROM candidate_resume_versions WHERE id = ?").get(privateVersion.id).name).includes(secret), `persisted default version name must mask filename contact: ${secret}`);
  }

  db.prepare("UPDATE candidate_resume_versions SET target_roles_json = 'not json', analysis_json = 'not json' WHERE id = ?").run(firstVersion.id);
  const fallbackVersion = storage.listCandidateResumeVersions(db, saved.profileId)[0];
  assert.deepStrictEqual(fallbackVersion.targetRoles, []);
  assert.deepStrictEqual(fallbackVersion.analysis, {});

  const editedVersionSave = observeTransaction(() => storage.saveCandidateResumeVersion(db, {
    profileId: saved.profileId,
    versionId: firstVersion.id,
    version: { name: "edited", targetRoles: ["AI 产品经理"], keywords: ["JavaScript"], primaryProjects: ["RoleFlow"], summary: "edited" }
  }));
  assert.deepStrictEqual(editedVersionSave.statements, ["BEGIN", "COMMIT"]);
  const editedVersion = editedVersionSave.value;
  assert.strictEqual(editedVersion.versionId, firstVersion.id);
  const manualVersionSave = observeTransaction(() => storage.saveCandidateResumeVersion(db, {
    profileId: saved.profileId,
    version: { name: "manual", targetRoles: ["产品经理"], keywords: ["沟通"], primaryProjects: [], summary: "manual" }
  }));
  assert.deepStrictEqual(manualVersionSave.statements, ["BEGIN", "COMMIT"]);
  const manualVersion = manualVersionSave.value;
  assert(/^resume_manual_[0-9a-f-]+$/.test(storage.listCandidateResumeVersions(db, saved.profileId).find((item) => item.id === manualVersion.versionId).versionKey));

  storage.recordResumeParseAttempt(db, { profileId: saved.profileId, document: document("attempt", "parsed") });
  storage.recordResumeParseAttempt(db, { profileId: saved.profileId, error: Object.assign(new Error("parse failed"), { code: "PARSE_FAILED" }) });
  assert.deepStrictEqual(storage.listResumeParseAttempts(db, saved.profileId, 50).map((item) => item.status).sort(), ["failed", "succeeded"]);

  const attemptPhone = "13712345678";
  const attemptEmail = "parse-attempt@example.com";
  const attemptAddress = "上海市浦东新区解析路 99 号";
  const attemptError = Object.assign(new Error([
    "简历解析失败",
    `联系地址：\n${attemptAddress}`,
    `邮箱：${attemptEmail}`
  ].join("\n")), {
    code: "PRIVATE_PARSE_FAILED",
    details: {
      diagnostics: {
        extractionMethod: "text_utf8",
        inputBytes: 321,
        charCount: 120,
        preview: `手机：${attemptPhone}\n联系地址：\n${attemptAddress}\n项目经历：KnowledgeFlow`,
        quality: { status: "warning", detectedSections: ["project"] }
      }
    }
  });
  storage.recordResumeParseAttempt(db, {
    profileId: privateSave.profileId,
    fileName: privateFileName,
    format: "txt",
    inputBytes: 321,
    error: attemptError
  });
  const writtenAttempt = db.prepare("SELECT * FROM resume_parse_attempts WHERE profile_id = ? ORDER BY id DESC LIMIT 1").get(privateSave.profileId);
  for (const secret of [...privateFileSecrets, attemptPhone, attemptEmail, attemptAddress]) {
    assert(!JSON.stringify(writtenAttempt).includes(secret), `parse-attempt write must mask contact: ${secret}`);
  }

  const historicalPhone = "13612345678";
  const historicalEmail = "historical-attempt@example.com";
  const historicalAddress = "上海市浦东新区历史路 77 号";
  const historicalPreview = `手机：${historicalPhone}\n联系地址：\n${historicalAddress}\n项目经历：KnowledgeFlow`;
  const historicalAttemptId = Number(db.prepare(`INSERT INTO resume_parse_attempts(
    profile_id, original_file_name, format, input_bytes, extraction_method, char_count, preview,
    diagnostics_json, status, error_code, error_message, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    privateSave.profileId,
    `历史-${historicalPhone}-${historicalAddress}.txt`,
    "txt",
    456,
    "text_utf8",
    historicalPreview.length,
    historicalPreview,
    JSON.stringify({
      extractionMethod: "text_utf8",
      preview: historicalPreview,
      quality: { status: "warning", detectedSections: ["project"] }
    }),
    "failed",
    "HISTORICAL_PARSE_FAILED",
    `邮箱：${historicalEmail}\n联系地址：\n${historicalAddress}`,
    new Date().toISOString()
  ).lastInsertRowid);
  const historicalAttempt = storage.listResumeParseAttempts(db, privateSave.profileId, 50)
    .find((item) => item.id === historicalAttemptId);
  for (const secret of [historicalPhone, historicalEmail, historicalAddress]) {
    assert(!JSON.stringify(historicalAttempt).includes(secret), `historical parse-attempt DTO must mask contact: ${secret}`);
  }
  assert.deepStrictEqual(historicalAttempt.diagnostics.quality, { status: "warning", detectedSections: ["project"] });

  const draft = storage.createMatchingCardDraft(db, {
    profileId: saved.profileId,
    profileVersionId: saved.profileVersionId,
    resumeDocumentId: saved.resumeDocumentId,
    resumeContentHash: "resume-v1",
    card: card()
  });
  assert.strictEqual(storage.createMatchingCardDraft(db, {
    profileId: saved.profileId, profileVersionId: saved.profileVersionId, resumeDocumentId: saved.resumeDocumentId,
    resumeContentHash: "resume-v1", card: card()
  }).id, draft.id);
  assert(!storage.listMatchingResumeVersions(db, saved.profileId).some((item) => item.resumeDocumentId === saved.resumeDocumentId));
  const editedDraft = storage.saveMatchingCardDraftEdit(db, { profileId: saved.profileId, cardId: draft.id, card: { ...card(), userNotes: ["prefer product"] } });
  assert.deepStrictEqual(editedDraft.card.userNotes, ["prefer product"]);
  const confirmedSave = observeTransaction(() => storage.confirmMatchingCard(db, { profileId: saved.profileId, cardId: draft.id }));
  assert.deepStrictEqual(confirmedSave.statements, ["BEGIN IMMEDIATE", "COMMIT"]);
  const confirmed = confirmedSave.value;
  const idempotentConfirm = observeTransaction(() => storage.confirmMatchingCard(db, { profileId: saved.profileId, cardId: draft.id }));
  assert.deepStrictEqual(idempotentConfirm.statements, ["BEGIN IMMEDIATE", "COMMIT"]);
  assert.strictEqual(idempotentConfirm.value.id, confirmed.id);
  assert.strictEqual(storage.getActiveMatchingCard(db, saved.profileId).id, confirmed.id);
  assert.strictEqual(storage.getMatchingCard(db, confirmed.id).status, "confirmed");
  assert.strictEqual(storage.getCandidateMatchingContext(db, saved.profileId).matchingCardId, confirmed.id);
  assert(storage.listMatchingResumeVersions(db, saved.profileId).some((item) => item.resumeDocumentId === saved.resumeDocumentId));

  const revisionSave = observeTransaction(() => storage.saveConfirmedMatchingCardRevision(db, { profileId: saved.profileId, cardId: confirmed.id, card: { ...card(), userNotes: ["revised"] } }));
  assert.deepStrictEqual(revisionSave.statements, ["BEGIN IMMEDIATE", "COMMIT"]);
  const revised = revisionSave.value;
  assert.notStrictEqual(revised.id, confirmed.id);
  assert.strictEqual(storage.getMatchingCard(db, confirmed.id).status, "superseded");
  assert.strictEqual(storage.listMatchingCards(db, saved.profileId).length, 2);
  assert.strictEqual(storage.getSearchPlanDependency(db, saved.planId).matchingCardId, revised.id);

  const updateSave = observeTransaction(() => storage.updateCandidateProfile(db, { profileId: saved.profileId, profile: profile("Candidate One Updated", ["增长产品经理"]) }));
  assert.deepStrictEqual(updateSave.statements, ["BEGIN", "COMMIT"]);
  const updated = updateSave.value;
  assert.strictEqual(updated.displayName, "Candidate One Updated");
  assert(storage.compareProfileVersions(db, saved.profileId).changes.length > 0);

  const longValue = "x".repeat(2001);
  assert.deepStrictEqual(storage.saveCandidateFact(db, { profileId: saved.profileId, factKey: "contact preference!", factValue: longValue }), {
    factKey: "contact_preference_", factValue: "x".repeat(2000), source: "user_provided"
  });
  storage.saveCandidateFact(db, { profileId: saved.profileId, factKey: "contact preference!", factValue: "email", source: "user" });
  assert.deepStrictEqual(storage.listCandidateFacts(db, saved.profileId).map(({ factKey, factValue, source }) => ({ factKey, factValue, source })), [{ factKey: "contact_preference_", factValue: "email", source: "user" }]);

  assert.strictEqual(storage.getOutcomeAnalyticsSnapshot(db, { planId: saved.planId }).context.planName, "candidate plan");
  assert.strictEqual(storage.getWorkflowHealthSnapshot(db, { planId: saved.planId }).profileId, saved.profileId);

  const countsBeforeRollback = ["candidate_profiles", "resume_documents", "profile_versions", "candidate_resume_versions", "search_plans"]
    .map((table) => db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count);
  db.exec("CREATE TRIGGER fail_late_profile_save BEFORE INSERT ON search_plans WHEN NEW.name = 'rollback' BEGIN SELECT RAISE(ABORT, 'forced rollback'); END");
  const rollback = observeTransaction(() => assert.throws(() => storage.saveProfileAnalysis(db, { profile: profile("Rollback Candidate"), document: document("rollback"), searchPlan: plan("rollback") }), /forced rollback/));
  assert.deepStrictEqual(rollback.statements, ["BEGIN", "ROLLBACK"]);
  assert.deepStrictEqual(["candidate_profiles", "resume_documents", "profile_versions", "candidate_resume_versions", "search_plans"]
    .map((table) => db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count), countsBeforeRollback);

  const activePlanBeforePartialFailure = storage.getActiveSearchPlan(db, saved.profileId).id;
  const circularPlan = plan("partial failure");
  circularPlan.salary = {};
  circularPlan.salary.self = circularPlan.salary;
  assert.throws(() => storage.saveSearchPlan(db, { profileId: saved.profileId, plan: circularPlan }), /circular/i);
  assert.strictEqual(storage.getActiveSearchPlan(db, saved.profileId).id, activePlanBeforePartialFailure, "invalid plan serialization must fail before changing the active plan");
  assert.strictEqual(storage.getSearchPlan(db, activePlanBeforePartialFailure).isActive, true);

  console.log("candidate_store_contract_smoke ok");
} finally {
  db.close();
}
