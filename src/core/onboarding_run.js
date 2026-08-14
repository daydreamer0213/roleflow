const {
  saveProfileAnalysis,
  getCandidateProfile,
  getActiveMatchingCard,
  getActiveSearchPlan,
  saveSearchPlan,
  createMatchingCardDraft
} = require("../storage/candidate_store");
const {
  getOnboardingRun,
  getOnboardingRunContext,
  claimOnboardingRun,
  checkpointOnboardingRun,
  heartbeatOnboardingRun,
  failOnboardingRun
} = require("../storage/onboarding_store");
const {
  analyzeResumeProfile,
  buildCandidateMatchCard,
  recommendPlanForProfile
} = require("./profile_onboarding");
const { prepareResumeTextForModel, maskResumeContacts } = require("./resume_privacy");
const { matchingCardFromProfile } = require("./matching_card");

async function processOnboardingRun({
  db,
  runId,
  modelConfig,
  logger,
  analyzeResume = analyzeResumeProfile,
  buildMatchingCard = buildCandidateMatchCard,
  recommendPlan = recommendPlanForProfile,
  heartbeatIntervalMs = 30_000
}) {
  let run = getOnboardingRun(db, runId);
  if (!run) throw new Error("onboarding run not found");
  if (run.status === "completed" && (!run.errorCode || run.searchPlanId)) return run;
  if (run.status !== "queued") return run;
  const claimed = claimOnboardingRun(db, run.id);
  if (!claimed.claimed) return claimed.run;
  run = claimed.run;

  const heartbeat = setInterval(
    () => heartbeatOnboardingRun(db, run.id),
    Math.max(1_000, Number(heartbeatIntervalMs) || 30_000)
  );
  heartbeat.unref?.();
  try {
    let context = getOnboardingRunContext(db, run.id);
    let profile = context.run.profileVersionId
      ? getCandidateProfile(db, context.run.profileId)?.profile
      : null;

    if (!context.run.profileVersionId) {
      checkpointOnboardingRun(db, {
        id: run.id,
        status: "running",
        stage: "analyzing_profile",
        errorCode: "",
        errorMessage: ""
      });
      const prepared = prepareResumeTextForModel(context.document.text, {
        originalFileName: context.document.originalFileName
      });
      profile = modelSafeProfile(await analyzeResume({
        modelConfig,
        resume: { ...context.document, text: prepared.text },
        preparedModelInput: prepared,
        logger
      }));
      const saved = saveProfileAnalysis(db, {
        profileId: context.run.profileId,
        profile,
        document: context.document,
        resumeDocumentId: context.run.resumeDocumentId,
        displayName: context.displayName,
        searchPlan: null
      });
      run = checkpointOnboardingRun(db, {
        id: run.id,
        status: "running",
        stage: "building_match_card",
        profileVersionId: saved.profileVersionId
      });
      logger?.info?.("onboarding_profile_ready", {
        runId: run.id,
        profileId: run.profileId,
        profileVersionId: run.profileVersionId
      });
    }

    context = getOnboardingRunContext(db, run.id);
    profile = modelSafeProfile(profile || getCandidateProfile(db, context.run.profileId)?.profile || {});
    if (!context.run.matchingCardId) {
      let card;
      try {
        card = await buildMatchingCard({ modelConfig, profile, logger });
      } catch (error) {
        logger?.warn?.("onboarding_matching_card_fallback", {
          runId: run.id,
          profileId: context.run.profileId,
          errorCode: String(error?.code || "MATCHING_CARD_BUILD_FAILED")
        });
        card = matchingCardFromProfile(profile);
      }
      const draft = createMatchingCardDraft(db, {
        profileId: context.run.profileId,
        profileVersionId: context.run.profileVersionId,
        resumeDocumentId: context.run.resumeDocumentId,
        resumeContentHash: context.document.contentHash,
        card,
        source: "model"
      });
      run = checkpointOnboardingRun(db, {
        id: run.id,
        status: "running",
        stage: "building_plan",
        matchingCardId: draft.id
      });
      logger?.info?.("onboarding_matching_card_ready", {
        runId: run.id,
        profileId: run.profileId,
        matchingCardId: run.matchingCardId
      });
    }

    context = getOnboardingRunContext(db, run.id);
    if (!context.run.searchPlanId) {
      const activeCard = getActiveMatchingCard(db, context.run.profileId);
      const activePlan = getActiveSearchPlan(db, context.run.profileId);
      if (activeCard && activePlan) {
        run = checkpointOnboardingRun(db, {
          id: run.id,
          status: "completed",
          stage: "ready",
          searchPlanId: activePlan.id,
          errorCode: "",
          errorMessage: "",
          finished: true
        });
      } else {
        try {
          const plan = await recommendPlan({ modelConfig, profile, logger });
          const planId = saveSearchPlan(db, {
            profileId: context.run.profileId,
            profileVersionId: context.run.profileVersionId,
            plan
          });
          run = checkpointOnboardingRun(db, {
            id: run.id,
            status: "completed",
            stage: "ready",
            searchPlanId: planId,
            errorCode: "",
            errorMessage: "",
            finished: true
          });
        } catch (error) {
          logger?.warn?.("onboarding_plan_failed", {
            runId: run.id,
            profileId: context.run.profileId,
            errorCode: String(error?.code || "SEARCH_PLAN_RECOMMEND_FAILED")
          });
          run = checkpointOnboardingRun(db, {
            id: run.id,
            status: "completed",
            stage: "ready",
            errorCode: String(error?.code || "SEARCH_PLAN_RECOMMEND_FAILED"),
            errorMessage: String(error?.message || "筛选方案生成失败，可单独重试。"),
            finished: true
          });
        }
      }
    }
    return run;
  } catch (error) {
    logger?.error?.("onboarding_run_failed", {
      runId: run.id,
      errorCode: String(error?.code || "ONBOARDING_RUN_FAILED")
    });
    return failOnboardingRun(db, run.id, {
      code: error?.code,
      message: maskResumeContacts(error?.message || "简历处理失败。")
    });
  } finally {
    clearInterval(heartbeat);
  }
}

function modelSafeProfile(value = {}) {
  return {
    ...value,
    candidate: {
      ...(value.candidate || {}),
      name: "候选人"
    }
  };
}

module.exports = { processOnboardingRun, modelSafeProfile };
