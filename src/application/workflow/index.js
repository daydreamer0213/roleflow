async function startWorkflow({ db, input = {}, deps = {} }) {
  const {
    appError,
    getSearchPlan,
    getCandidateProfile,
    getCandidateMatchingContext,
    getSearchPlanDependency,
    assertSearchPlanReady,
    getActiveWorkflow,
    buildDashboardState,
    workflowBlockedMessage,
    resolveNewWorkflowBrowser,
    acquisitionContextResolver,
    assertAcquisitionContext,
    acquisitionModeOf,
    freezeWorkflowPlan,
    preparePlanForNewWorkflow,
    scanAvailability,
    workflowModelProfilesSnapshot,
    createWorkflowRun,
    transitionWorkflowRun,
    spawnScan,
    settleFailedWorkflowLaunch,
    logger
  } = deps;
  const planId = Number(input.planId || 0);
  const browserAuthority = resolveNewWorkflowBrowser(input);
  const plan = getSearchPlan(db, planId);
  if (!plan || !getCandidateProfile(db, plan.profileId)) {
    throw appError("WORKFLOW_PROFILE_NOT_FOUND", "筛选方案对应的候选人画像不存在。", { statusCode: 404 });
  }
  const matchingContext = getCandidateMatchingContext(db, plan.profileId);
  const frozenPlan = freezeWorkflowPlan(plan.plan);
  const activeWorkflow = getActiveWorkflow(db, plan);
  if (activeWorkflow) return { workflow: activeWorkflow, alreadyActive: true };
  assertSearchPlanReady(
    plan,
    matchingContext?.candidateProfile || {},
    getSearchPlanDependency(db, plan.id),
    { acquisitionMode: acquisitionModeOf(plan.plan) }
  );
  await preparePlanForNewWorkflow({ db, plan, matchingContext });
  const preliminaryState = buildDashboardState(db, plan);
  if (preliminaryState.activeRun) return { workflow: preliminaryState.activeRun, alreadyActive: true };
  if (preliminaryState.nextPlan?.errorCode) {
    throw appError(
      preliminaryState.nextPlan.errorCode,
      workflowBlockedMessage(preliminaryState.nextPlan.errorCode, preliminaryState.nextPlan),
      { statusCode: 409 }
    );
  }
  if (preliminaryState.nextPlan?.scanNeeded && !input.modelReady) {
    throw appError(
      "MODEL_CONFIGURATION_REQUIRED",
      "执行新一轮前，请先打开 /settings#model-profile-batch_screening 完成批量筛选模型连接测试。",
      { statusCode: 409 }
    );
  }
  const acquisition = await acquisitionContextResolver({
    db,
    plan,
    matchingContext,
    logger,
    browserMode: browserAuthority.browserMode,
    cdpPort: browserAuthority.cdpPort
  });
  try {
    assertAcquisitionContext(acquisition, { planId: plan.id });
  } catch (error) {
    throw appError(error.code, error.message, { statusCode: 409, cause: error });
  }
  const state = buildDashboardState(db, plan, new Date(), acquisition);
  if (state.activeRun) return { workflow: state.activeRun, alreadyActive: true };
  if (state.nextPlan?.errorCode) {
    throw appError(state.nextPlan.errorCode, workflowBlockedMessage(state.nextPlan.errorCode, state.nextPlan), { statusCode: 409 });
  }
  if (state.nextPlan.scanNeeded && !input.modelReady) {
    throw appError(
      "MODEL_CONFIGURATION_REQUIRED",
      "执行新一轮前，请先打开 /settings#model-profile-batch_screening 完成批量筛选模型连接测试。",
      { statusCode: 409 }
    );
  }
  if (state.nextPlan.scanNeeded) scanAvailability(db, input.scanRuns, plan.id, logger);
  const modelProfiles = workflowModelProfilesSnapshot(input.modelState, { backupRuntime: input.backupRuntime });
  let workflow = createWorkflowRun(db, {
    profileId: plan.profileId,
    planId: plan.id,
    localDay: state.localDay,
    sequence: state.runs.length + 1,
    targetSuccessCount: state.nextPlan.targetSuccessCount,
    inventoryCount: state.nextPlan.inventoryCount,
    candidateGap: state.nextPlan.candidateGap,
    scanNeeded: state.nextPlan.scanNeeded,
    keywords: state.nextPlan.selectedKeywords,
    budget: state.nextPlan.budget,
    modelConfigRevision: modelProfiles.batch_screening.revision,
    planner: {
      ...state.nextPlan,
      ...frozenPlan,
      browserMode: browserAuthority.browserMode,
      cdpPort: browserAuthority.cdpPort,
      acquisitionMode: acquisition.acquisitionMode,
      searchTemplate: acquisition.searchTemplate,
      searchScope: acquisition.searchScope || {},
      keywordSource: acquisition.keywordSource,
      platformPolicy: acquisition.platformPolicy || {},
      cityScopes: acquisition.cityScopes || [],
      nativeFilters: acquisition.nativeFilters || {},
      nativeFilterCatalogRevision: acquisition.nativeFilterCatalogRevision || "",
      modelProfiles
    },
    shortfallCode: state.nextPlan.shortfallReason || "",
    metrics: {
      planning: {
        inventory: state.nextPlan.inventoryCount,
        candidateGap: state.nextPlan.candidateGap,
        projectedNewCandidates: state.nextPlan.projectedNewCandidates
      }
    }
  });
  if (workflow.scanNeeded) {
    try {
      spawnScan(input.scanRuns, {
        db,
        root: input.root,
        dbPath: input.dbPath,
        planId: plan.id,
        cdpPort: browserAuthority.cdpPort,
        browserMode: browserAuthority.browserMode,
        scanKind: "daily",
        workflowRunId: workflow.id,
        logger,
        requestId: input.requestId,
        spawnProcess: input.spawnProcess
      });
    } catch (launchError) {
      settleFailedWorkflowLaunch(db, input.scanRuns, workflow, launchError);
      throw launchError;
    }
  } else {
    workflow = transitionWorkflowRun(db, {
      id: workflow.id,
      status: "review_required",
      inventoryCount: state.inventory.length,
      metrics: { ...workflow.metrics, planning: { ...workflow.metrics.planning, scanSkipped: true } }
    });
  }
  logger.info("workflow_run_started", {
    requestId: input.requestId,
    workflowRunId: workflow.id,
    planId: plan.id,
    sequence: workflow.sequence,
    targetSuccessCount: workflow.targetSuccessCount,
    scanNeeded: workflow.scanNeeded
  });
  return { workflow };
}

async function resumeWorkflow({ db, input = {}, deps = {} }) {
  const {
    appError,
    getWorkflowRun,
    getBatch,
    workflowResumeNeedsBatchModel,
    assertCompleteInheritedContext,
    assertCompleteGeneratedContext,
    assertFrozenWorkflowPlan,
    resolveWorkflowResumeBrowserMode,
    normalizeCdpPort,
    portableCdpPort,
    validateResumeBatch,
    assertWorkflowAnalysisBatch,
    workflowResumeRequiresBrowser,
    browserReadinessProbe,
    publicBrowserReadinessSnapshot,
    assertWorkflowResumeBrowserReady,
    transitionWorkflowRun,
    scanAvailability,
    spawnScan,
    settleFailedWorkflowLaunch,
    logger
  } = deps;
  const workflowRunId = String(input.workflowRunId || input.runId || "").trim();
  const workflow = getWorkflowRun(db, workflowRunId);
  if (!workflow) throw appError("WORKFLOW_RUN_NOT_FOUND", "本轮任务不存在。", { statusCode: 404 });
  if (workflowResumeNeedsBatchModel(db, workflow) && !input.batchModelReady) {
    throw appError("MODEL_CONFIGURATION_REQUIRED", "继续本轮前，请先完成批量筛选模型连接测试。", { statusCode: 409 });
  }
  const acquisitionMode = String(workflow.planner?.acquisitionMode || "").trim();
  if (!["generated", "inherited"].includes(acquisitionMode)) {
    throw appError("WORKFLOW_ACQUISITION_MODE_INVALID", "本轮任务的采集模式无效，不能安全恢复。", { statusCode: 409 });
  }
  const hasFrozenPlan = workflow.planner?.planSnapshotVersion === 2;
  if (hasFrozenPlan) {
    try {
      assertFrozenWorkflowPlan(workflow.planner);
    } catch (error) {
      throw appError("WORKFLOW_PLAN_SNAPSHOT_INVALID", "本轮任务的筛选方案快照无效，不能安全恢复。", { statusCode: 409, cause: error });
    }
    if (workflow.planner?.browserMode !== "edge") {
      throw appError("WORKFLOW_BROWSER_AUTHORITY_INVALID", "新版本任务只允许使用创建时冻结的当前 Edge。", { statusCode: 409 });
    }
  }
  if (acquisitionMode === "inherited") {
    try {
      assertCompleteInheritedContext(workflow.planner, {
        code: "WORKFLOW_INHERITED_SNAPSHOT_INVALID",
        message: "本轮继承模式快照不完整，不能安全恢复。",
        planId: workflow.planId
      });
    } catch (error) {
      throw appError("WORKFLOW_INHERITED_SNAPSHOT_INVALID", "本轮继承模式快照不完整，不能安全恢复。", { statusCode: 409, cause: error });
    }
  } else if (hasFrozenPlan) {
    try {
      assertCompleteGeneratedContext(workflow.planner, { planId: workflow.planId });
    } catch (error) {
      throw appError("WORKFLOW_GENERATED_SNAPSHOT_INVALID", "本轮通用模式快照不完整，不能安全恢复。", { statusCode: 409, cause: error });
    }
  }
  const browserMode = resolveWorkflowResumeBrowserMode(workflow, input.browserMode);
  let cdpPort = null;
  if (browserMode === "portable") {
    const storedCdpPort = Number(workflow.planner?.cdpPort);
    if (acquisitionMode === "inherited" && (!Number.isInteger(storedCdpPort) || storedCdpPort !== portableCdpPort)) {
      throw appError("INHERITED_PORTABLE_PORT_REQUIRED", "项目专用 Edge 固定使用 9222 端口。", { statusCode: 409 });
    }
    cdpPort = acquisitionMode === "inherited"
      ? storedCdpPort
      : normalizeCdpPort(input.cdpPort || (Number.isInteger(storedCdpPort) ? storedCdpPort : portableCdpPort));
    if (cdpPort !== portableCdpPort) {
      throw appError("INHERITED_PORTABLE_PORT_REQUIRED", "项目专用 Edge 固定使用 9222 端口。", { statusCode: 409 });
    }
  }
  if (["completed", "failed", "stopped"].includes(workflow.status)) {
    throw appError("WORKFLOW_RUN_TERMINAL", "本轮任务已经结束，不能继续执行。", { statusCode: 409 });
  }
  const resumesAnalysis = workflow.status === "interrupted" && String(workflow.resumePhase || "") === "analyzing";
  if (acquisitionMode === "generated" && !hasFrozenPlan) {
    if (!workflow.scanBatchId) {
      throw appError("WORKFLOW_GENERATED_SNAPSHOT_INVALID", "历史通用模式任务缺少可验证的扫描快照，不能安全恢复。", { statusCode: 409 });
    }
    try {
      const validation = validateResumeBatch({
        resumeBatchId: workflow.scanBatchId,
        resumedBatch: getBatch(db, workflow.scanBatchId),
        site: "boss",
        planId: workflow.planId
      });
      if (validation.acquisitionMode !== "generated") throw new Error("historical generated snapshot mode mismatch");
    } catch (error) {
      throw appError("WORKFLOW_GENERATED_SNAPSHOT_INVALID", "历史通用模式任务的扫描快照无效，不能安全恢复。", { statusCode: 409, cause: error });
    }
  }
  if (resumesAnalysis) {
    assertWorkflowAnalysisBatch(db, workflow);
  } else if (workflow.scanNeeded && workflow.scanBatchId) {
    validateResumeBatch({ resumeBatchId: workflow.scanBatchId, resumedBatch: getBatch(db, workflow.scanBatchId), site: "boss", planId: workflow.planId });
  }
  const requiresBrowser = workflowResumeRequiresBrowser(db, workflow);
  if (requiresBrowser) {
    const readiness = publicBrowserReadinessSnapshot(await browserReadinessProbe({ browserMode, cdpPort }));
    assertWorkflowResumeBrowserReady(readiness);
  }
  let resumed = workflow;
  if (workflow.status === "created" || (workflow.status === "interrupted" && !workflow.communicationBatchId)) {
    try {
      if (resumesAnalysis) {
        resumed = transitionWorkflowRun(db, { id: workflow.id, status: "analyzing", resumePhase: null });
        spawnScan(input.scanRuns, { db, root: input.root, dbPath: input.dbPath, planId: workflow.planId, cdpPort, browserMode, scanKind: "daily", workflowRunId: workflow.id, logger, requestId: input.requestId, spawnProcess: input.spawnProcess });
      } else if (workflow.scanNeeded) {
        scanAvailability(db, input.scanRuns, workflow.planId, logger);
        spawnScan(input.scanRuns, { db, root: input.root, dbPath: input.dbPath, planId: workflow.planId, cdpPort, browserMode, scanKind: "daily", resumeBatchId: workflow.scanBatchId, workflowRunId: workflow.id, logger, requestId: input.requestId, spawnProcess: input.spawnProcess });
      } else {
        resumed = transitionWorkflowRun(db, { id: workflow.id, status: "review_required" });
      }
    } catch (launchError) {
      settleFailedWorkflowLaunch(db, input.scanRuns, workflow, launchError);
      throw launchError;
    }
  }
  return { workflow: resumed };
}

async function controlWorkflow({ db, input = {}, deps = {} }) {
  const {
    appError,
    getWorkflowRun,
    exactActiveWorkflowRun,
    exactPersistedWorkflowRunIsRunning,
    requestWorkflowPause,
    requestWorkflowStop,
    finalizeWorkflowControl,
    scheduleExactWorkflowControlFallback,
    workflowResumeNeedsBatchModel,
    resolveWorkflowControlBrowserAuthority,
    browserReadinessProbe,
    publicBrowserReadinessSnapshot,
    assertWorkflowResumeBrowserReady,
    sameWorkflowControlSnapshot,
    getBatch,
    validateResumeBatch,
    scanAvailability,
    assertWorkflowAnalysisBatch,
    workflowBatchResumeEvidence,
    getBatchModelState,
    batchModelReady,
    resumeWorkflowRun,
    spawnScan,
    settleFailedWorkflowLaunch,
    transitionWorkflowRun,
    portableCdpPort,
    logger
  } = deps;
  const workflowRunId = String(input.workflowRunId || input.runId || "").trim();
  const action = String(input.action || "").trim().toLowerCase();
  if (!["pause", "resume", "stop"].includes(action)) {
    throw appError("WORKFLOW_CONTROL_ACTION_INVALID", "工作流操作必须是 pause、resume 或 stop。", { statusCode: 409 });
  }
  let workflow = getWorkflowRun(db, workflowRunId);
  if (!workflow) throw appError("WORKFLOW_CONTROL_TARGET_MISMATCH", "指定的工作流不存在。", { statusCode: 409 });
  const now = new Date().toISOString();
  let activeRun = exactActiveWorkflowRun(input.scanRuns, workflow);
  const persistedExecutionRunning = exactPersistedWorkflowRunIsRunning(db, workflow);
  if (action === "pause") {
    if (workflow.status !== "paused") {
      requestWorkflowPause(db, { workflowRunId, now });
      if (activeRun) {
        scheduleExactWorkflowControlFallback({ db, scanRuns: input.scanRuns, workflowRunId, expectedRun: activeRun, expectedControlState: "pause_requested", schedule: input.schedule, graceMs: input.controlGraceMs, logger });
      } else if (!persistedExecutionRunning) {
        finalizeWorkflowControl(db, { workflowRunId, now: new Date().toISOString() });
      }
    }
    logger.info("workflow_control_applied", { requestId: input.requestId, workflowRunId, action });
    return { workflowRunId, action, workflow };
  }
  if (action === "stop") {
    requestWorkflowStop(db, { workflowRunId, confirmStop: String(input.confirmStop || "") === "1", now });
    if (activeRun) {
      scheduleExactWorkflowControlFallback({ db, scanRuns: input.scanRuns, workflowRunId, expectedRun: activeRun, expectedControlState: "stop_requested", schedule: input.schedule, graceMs: input.controlGraceMs, logger });
    } else if (!persistedExecutionRunning) {
      finalizeWorkflowControl(db, { workflowRunId, now: new Date().toISOString() });
    }
    logger.info("workflow_control_applied", { requestId: input.requestId, workflowRunId, action });
    return { workflowRunId, action, workflow };
  }
  if (workflow.status === "paused" && activeRun) {
    throw appError("WORKFLOW_CONTROL_SETTLING", "上一执行进程仍在完成暂停，请稍后再继续本轮。", { statusCode: 409 });
  }
  if (activeRun && ["scanning", "analyzing"].includes(workflow.status) && workflow.controlState === "none") {
    logger.info("workflow_control_idempotent", { requestId: input.requestId, workflowRunId, action });
    return { workflowRunId, action, workflow, idempotent: true };
  }
  const shouldLaunch = !activeRun;
  const targetPhase = workflow.status === "paused" ? String(workflow.resumePhase || "analyzing") : String(workflow.status || "");
  const readyForResume = batchModelReady();
  if (shouldLaunch && workflowResumeNeedsBatchModel(db, workflow) && !readyForResume) {
    throw appError("MODEL_CONFIGURATION_REQUIRED", "继续本轮前，请先测试批量筛选模型连接。", { statusCode: 409 });
  }
  const requiresBrowser = shouldLaunch && targetPhase === "scanning";
  let authority = null;
  if (requiresBrowser) {
    authority = resolveWorkflowControlBrowserAuthority(workflow, input);
    const readiness = publicBrowserReadinessSnapshot(await browserReadinessProbe(authority));
    assertWorkflowResumeBrowserReady(readiness);
    const refreshed = getWorkflowRun(db, workflowRunId);
    activeRun = exactActiveWorkflowRun(input.scanRuns, refreshed);
    if (activeRun && ["scanning", "analyzing"].includes(refreshed?.status) && refreshed.controlState === "none") {
      logger.info("workflow_control_idempotent", { requestId: input.requestId, workflowRunId, action });
      return { workflowRunId, action, workflow: refreshed, idempotent: true };
    }
    if (!sameWorkflowControlSnapshot(workflow, refreshed)) {
      throw appError("WORKFLOW_CONTROL_STATE_CHANGED", "工作流状态在浏览器检查期间发生变化，请刷新后重试。", { statusCode: 409 });
    }
    if (workflow.scanNeeded && workflow.scanBatchId) {
      validateResumeBatch({ resumeBatchId: workflow.scanBatchId, resumedBatch: getBatch(db, workflow.scanBatchId), site: "boss", planId: workflow.planId });
    }
    scanAvailability(db, input.scanRuns, workflow.planId, logger);
  } else if (shouldLaunch && targetPhase === "analyzing") {
    assertWorkflowAnalysisBatch(db, workflow);
  }
  const modelEvidence = workflowBatchResumeEvidence(getBatchModelState(), { ready: readyForResume });
  workflow = resumeWorkflowRun(db, { workflowRunId, ...modelEvidence, now });
  if (shouldLaunch) {
    if (workflow.scanNeeded) {
      const launchAuthority = requiresBrowser ? authority : { browserMode: "portable", cdpPort: portableCdpPort };
      try {
        spawnScan(input.scanRuns, { db, root: input.root, dbPath: input.dbPath, planId: workflow.planId, cdpPort: launchAuthority.cdpPort, browserMode: launchAuthority.browserMode, scanKind: "daily", resumeBatchId: workflow.scanBatchId, workflowRunId: workflow.id, logger, requestId: input.requestId, spawnProcess: input.spawnProcess });
      } catch (launchError) {
        settleFailedWorkflowLaunch(db, input.scanRuns, workflow, launchError);
        throw launchError;
      }
    } else if (workflow.status !== "review_required") {
      workflow = transitionWorkflowRun(db, { id: workflow.id, status: "review_required" });
    }
  }
  logger.info("workflow_control_applied", { requestId: input.requestId, workflowRunId, action, resumedPhase: workflow.status });
  return { workflowRunId, action, workflow };
}

function getWorkflowStatus({ db, workflowRunId, deps = {} }) {
  const { recover, progressSnapshot, getWorkflowRun, communicationBatchSummary, publicCommunicationStatus, publicWorkflow, logger } = deps;
  const recovery = recover(db, { workflowRunId, orphanTimeoutMs: deps.orphanTimeoutMs });
  if ((recovery.scanRunsInterrupted || recovery.workflowRunsInterrupted || recovery.workflowRunsCompleted) && logger) {
    logger.warn("workflow_status_reconciled", { workflowRunId, ...recovery });
  }
  const workflow = getWorkflowRun(db, workflowRunId);
  if (!workflow) return { statusCode: 404, body: { error: "本轮任务不存在。", errorCode: "WORKFLOW_RUN_NOT_FOUND" } };
  let summary = null;
  if (workflow.communicationBatchId) {
    try {
      summary = communicationBatchSummary(db, workflow.communicationBatchId);
    } catch (error) {
      if (error?.code === "COMMUNICATION_BATCH_NOT_FOUND") {
        return {
          statusCode: 404,
          body: { error: "本轮沟通批次不存在。", errorCode: "COMMUNICATION_BATCH_NOT_FOUND" }
        };
      }
      throw error;
    }
  }
  const snapshot = progressSnapshot(db, { workflowRunId, communicationSummary: summary });
  if (!snapshot) return { statusCode: 404, body: { error: "本轮任务不存在。", errorCode: "WORKFLOW_RUN_NOT_FOUND" } };
  const communication = summary ? publicCommunicationStatus({
    batch: { id: summary.batchId, status: summary.batchStatus },
    summary
  }) : null;
  return {
    statusCode: 200,
    body: {
      workflow: publicWorkflow({ ...snapshot.workflow, successfulCount: workflow.successfulCount, errorCode: workflow.errorCode }),
      progress: snapshot.progress,
      controls: snapshot.controls,
      recentActivity: snapshot.recentActivity,
      communication
    }
  };
}

module.exports = { startWorkflow, resumeWorkflow, controlWorkflow, getWorkflowStatus };
