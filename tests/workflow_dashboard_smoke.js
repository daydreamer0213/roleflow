const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const {
  openDb,
  saveProfileAnalysis,
  createMatchingCardDraft,
  confirmMatchingCard,
  createWorkflowRun,
  listWorkflowRuns,
  getWorkflowRun,
  getLatestScanRun,
  createScanRun,
  finishScanRun,
  attachWorkflowScan,
  transitionWorkflowRun,
  createBatch,
  upsertJob,
  recordSiteAccessEvent
} = require("../src/core/storage");
const { matchingCardFromProfile } = require("../src/core/matching_card");
const { listWorkflowReviewCandidates } = require("../src/core/workflow_inventory");
const { buildScanExecutionSnapshot } = require("../src/core/scan_snapshot");
const { createDashboardServer } = require("../src/dashboard/server");

const root = path.join(__dirname, "..");
const smokeDir = path.join(root, ".runtime", "smoke");
const dbPath = path.join(smokeDir, `workflow-dashboard-${Date.now()}.sqlite`);
const logger = {
  info() {}, warn() {}, error() {},
  requestId() { return "workflow-dashboard-smoke"; },
  listRecent() { return []; }
};

let db;
let server;

(async () => {
  fs.mkdirSync(smokeDir, { recursive: true });
  db = openDb(dbPath);
  const saved = seedProfile(db);
  const spawns = [];
  let inheritedFailureCode = "";
  let inheritedResolutionCount = 0;
  const inheritedContextResolver = async ({ plan, matchingContext }) => {
    inheritedResolutionCount += 1;
    if (inheritedFailureCode) {
      throw Object.assign(new Error(`blocked by ${inheritedFailureCode}`), {
        code: inheritedFailureCode,
        statusCode: 409
      });
    }
    const context = {
      acquisitionMode: "inherited",
      searchTemplate: {
        mode: "inherited",
        url: "https://www.zhipin.com/web/geek/jobs?city=100010000&salary=405",
        cityCode: "100010000"
      },
      searchScope: {
        key: `boss:${plan.profileId}:fixture-scope`,
        site: "boss",
        templateHash: "fixture-scope",
        templateUrl: "https://www.zhipin.com/web/geek/jobs?city=100010000&salary=405",
        filterParams: { city: ["100010000"], salary: ["405"] }
      },
      keywordSource: {
        searchPlanId: plan.id,
        profileVersionId: plan.profileVersionId,
        matchingCardRevision: "fixture-card",
        catalogHash: "fixture-catalog",
        keywords: [
          ...plan.plan.keywords.map(({ word, priority, reason = "" }) => ({ word, priority, reason })),
          { word: "Agent工程师", priority: "B", reason: "测试继承关键词展示" }
        ]
      },
      platformPolicy: {
        hash: "fixture-policy",
        site: "boss",
        templateHash: "fixture-scope",
        filters: {
          location: { mode: "nationwide", codes: ["100010000"], cities: [], districts: [] },
          salary: { codes: ["405"], labels: ["10-20K"], ranges: [{ minK: 10, maxK: 20 }] },
          experience: { codes: [], labels: [] },
          degree: { codes: [], labels: [] },
          jobType: { codes: [], labels: [] },
          acquisitionOnly: {}
        },
        unresolvedParams: [],
        filterSummary: ["地点：全国", "薪资：10-20K"]
      },
      matchingContext
    };
    return context;
  };
  server = createDashboardServer({
    db,
    root,
    dbPath,
    forceMock: true,
    allowOfflineMock: true,
    logger,
    inheritedContextResolver,
    spawnProcess(file, args, options) {
      const child = new EventEmitter();
      child.pid = 6100 + spawns.length;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      spawns.push({ file, args, options, child });
      return child;
    }
  });
  const baseUrl = await listen(server);

  const planBefore = await getText(baseUrl, `/plan?planId=${saved.planId}`);
  assert.match(planBefore.body, /今日进度<\/span><strong>0\s*\/\s*70/);
  assert.match(planBefore.body, /下一轮目标<\/span><strong>35/);
  assert.strictEqual((planBefore.body.match(/name="action" value="start"/g) || []).length, 1);
  assert.match(
    planBefore.body,
    /<button class="workflow-primary" name="action" value="start">执行一轮<\/button>/
  );
  assert.match(planBefore.body, /data-scan-button name="scanKind" value="daily" disabled/);
  assert.match(planBefore.body, /BOSS 暂不支持这些城市：测试未映射城市/);
  assert.doesNotMatch(planBefore.body, /上午|下午/);
  assert.match(planBefore.body, /高级扫描与维护/);

  for (const code of [
    "BOSS_RISK_CONTROL",
    "BOSS_LOGIN_REQUIRED",
    "BOSS_SEARCH_PAGE_INVALID"
  ]) {
    inheritedFailureCode = code;
    const rejected = await postForm(baseUrl, "/api/workflow-run", {
      planId: saved.planId,
      browserMode: "edge",
      action: "start"
    });
    assert.strictEqual(rejected.status, 409);
    assert.strictEqual(listWorkflowRuns(db, { planId: saved.planId }).length, 0);
    assert.strictEqual(spawns.length, 0);
  }
  inheritedFailureCode = "";

  const portableStart = await postForm(baseUrl, "/api/workflow-run", {
    planId: saved.planId,
    browserMode: "portable",
    action: "start"
  });
  assert.strictEqual(portableStart.status, 409);
  assert.match(portableStart.body, /INHERITED_EDGE_REQUIRED/);

  const started = await postForm(baseUrl, "/api/workflow-run", {
    planId: saved.planId,
    browserMode: "edge",
    action: "start"
  });
  assert.strictEqual(started.status, 303);
  assert.match(started.location, /^\/workflow\?runId=/);
  const workflow = listWorkflowRuns(db, { planId: saved.planId })[0];
  assert.strictEqual(workflow.status, "scanning");
  assert.strictEqual(workflow.targetSuccessCount, 35);
  assert.strictEqual(workflow.planner.acquisitionMode, "inherited");
  assert.strictEqual(workflow.planner.searchScope.key, `boss:${saved.profileId}:fixture-scope`);
  assert.strictEqual(workflow.planner.platformPolicy.hash, "fixture-policy");
  assert.deepStrictEqual(
    workflow.keywords.map((item) => item.word),
    ["AI应用开发工程师", "大模型应用开发工程师", "Agent开发工程师"]
  );
  assert.strictEqual(spawns.length, 1);
  assert(spawns[0].args.includes("--workflow-run"));
  assert(spawns[0].args.includes(workflow.id));

  const scanningPage = await getText(baseUrl, started.location);
  assert.match(scanningPage.body, /正在筛选岗位/);
  assert.match(scanningPage.body, /本轮目标\s*<strong>35/);
  assert.doesNotMatch(scanningPage.body, /上午|下午/);
  for (const text of [
    "筛选来源：BOSS 当前页面",
    "地点：全国",
    "薪资：10-20K",
    "范围：fixture-sc",
    "关键词来源：Search Plan",
    "AI应用开发工程师",
    "RAG工程师",
    "Agent工程师",
    "修改 BOSS 筛选会创建新的统计范围"
  ]) {
    assert.match(scanningPage.body, new RegExp(text));
  }
  assert.doesNotMatch(scanningPage.body, /广州 AI.*目标城市/);
  assert.doesNotMatch(scanningPage.body, /https:\/\/www\.zhipin\.com\/web\/geek\/jobs\?/);

  const unresolvedPlanner = {
    ...workflow.planner,
    platformPolicy: {
      ...workflow.planner.platformPolicy,
      unresolvedParams: [{ param: "industry", codes: ["100020"] }]
    },
    browserState: {
      cookie: "raw-authenticated-browser-state"
    }
  };
  db.prepare("UPDATE workflow_runs SET planner_json = ? WHERE id = ?")
    .run(JSON.stringify(unresolvedPlanner), workflow.id);
  const unresolvedPage = await getText(baseUrl, started.location);
  assert.match(unresolvedPage.body, /未解析平台筛选：industry/);
  assert.doesNotMatch(unresolvedPage.body, /100020/);
  assert.doesNotMatch(unresolvedPage.body, /raw-authenticated-browser-state/);
  db.prepare("UPDATE workflow_runs SET planner_json = ? WHERE id = ?")
    .run(JSON.stringify(workflow.planner), workflow.id);

  spawns[0].child.emit("error", new Error("spawn failed"));
  const interruptedWorkflow = getWorkflowRun(db, workflow.id);
  assert.strictEqual(interruptedWorkflow.status, "interrupted");
  assert.strictEqual(interruptedWorkflow.sequence, 1);
  assert.strictEqual(interruptedWorkflow.errorCode, "SCAN_PROCESS_ERROR");
  const inheritedInterruptedPage = await getText(baseUrl, started.location);
  assert.match(inheritedInterruptedPage.body, /<input type="hidden" name="browserMode" value="edge">/);
  assert.doesNotMatch(inheritedInterruptedPage.body, /<select name="browserMode">/);

  const spawnCountBeforePortableResume = spawns.length;
  const portableResume = await postForm(baseUrl, "/api/workflow-run/resume", {
    workflowRunId: workflow.id,
    browserMode: "portable"
  });
  assert.strictEqual(portableResume.status, 409);
  assert.match(portableResume.body, /INHERITED_EDGE_REQUIRED/);
  assert.strictEqual(spawns.length, spawnCountBeforePortableResume);

  const frozenPlanner = workflow.planner;
  const resolutionCountBeforeMalformedResume = inheritedResolutionCount;
  for (const acquisitionMode of [undefined, "future-mode"]) {
    const malformedPlanner = { ...frozenPlanner };
    if (acquisitionMode === undefined) delete malformedPlanner.acquisitionMode;
    else malformedPlanner.acquisitionMode = acquisitionMode;
    db.prepare("UPDATE workflow_runs SET planner_json = ? WHERE id = ?")
      .run(JSON.stringify(malformedPlanner), workflow.id);
    const spawnCountBeforeMalformedResume = spawns.length;
    const malformedResume = await postForm(baseUrl, "/api/workflow-run/resume", {
      workflowRunId: workflow.id,
      browserMode: "edge"
    });
    assert.strictEqual(malformedResume.status, 409);
    assert.match(malformedResume.body, /WORKFLOW_ACQUISITION_MODE_INVALID/);
    assert.strictEqual(spawns.length, spawnCountBeforeMalformedResume);
    assert.strictEqual(inheritedResolutionCount, resolutionCountBeforeMalformedResume);
  }
  db.prepare("UPDATE workflow_runs SET planner_json = ? WHERE id = ?")
    .run(JSON.stringify(frozenPlanner), workflow.id);

  for (const plannerPatch of [
    { searchScope: {} },
    { keywordSource: {} },
    { platformPolicy: {} }
  ]) {
    db.prepare("UPDATE workflow_runs SET planner_json = ? WHERE id = ?")
      .run(JSON.stringify({ ...frozenPlanner, ...plannerPatch }), workflow.id);
    const spawnCountBeforeCorruptInheritedResume = spawns.length;
    const corruptInheritedResume = await postForm(baseUrl, "/api/workflow-run/resume", {
      workflowRunId: workflow.id,
      browserMode: "edge"
    });
    assert.strictEqual(corruptInheritedResume.status, 409);
    assert.match(corruptInheritedResume.body, /WORKFLOW_INHERITED_SNAPSHOT_INVALID/);
    assert.strictEqual(spawns.length, spawnCountBeforeCorruptInheritedResume);
    assert.strictEqual(inheritedResolutionCount, resolutionCountBeforeMalformedResume);
    assert.strictEqual(getWorkflowRun(db, workflow.id).status, "interrupted");
  }
  db.prepare("UPDATE workflow_runs SET planner_json = ? WHERE id = ?")
    .run(JSON.stringify(frozenPlanner), workflow.id);

  const validInheritedResumeSnapshot = buildScanExecutionSnapshot({
    site: "boss",
    scanKind: "daily",
    runtimePolicyHash: "fixture-inherited-runtime",
    searchTemplate: frozenPlanner.searchTemplate,
    searchScope: frozenPlanner.searchScope,
    keywordSource: frozenPlanner.keywordSource,
    platformPolicy: frozenPlanner.platformPolicy,
    cityScopes: [{ city: "", cityCode: "100010000" }],
    keywordPlan: workflow.keywords,
    nativeFilters: { site: "boss", params: {}, lanes: [] },
    limits: {
      maxCards: Math.max(...workflow.keywords.map((item) => Number(item.maxCards) || 0)),
      maxDetailTotal: workflow.budget.maxDetailTotal,
      browserPageBudget: workflow.budget.browserPageBudget,
      detailLimits: { A: 40, B: 30, C: 20 }
    }
  });
  const invalidAttachedBatches = [
    {
      expectedCode: "SCAN_RESUME_SNAPSHOT_MISSING",
      filterSnapshot: {}
    },
    {
      expectedCode: "SCAN_SNAPSHOT_MISMATCH",
      filterSnapshot: {
        execution: {
          ...validInheritedResumeSnapshot,
          runtimePolicyHash: "tampered-without-rehash"
        }
      }
    }
  ];
  const attachInterruptedScanBatch = (scanBatchId, label) => {
    db.prepare("UPDATE workflow_runs SET scan_run_id = NULL, scan_batch_id = NULL WHERE id = ?")
      .run(workflow.id);
    const scan = createScanRun(db, {
      runId: `workflow-invalid-resume-${label}`,
      site: "boss",
      command: "daily",
      planId: saved.planId,
      batchId: scanBatchId
    });
    attachWorkflowScan(db, {
      id: workflow.id,
      scanRunId: scan.id,
      scanBatchId
    });
    finishScanRun(db, {
      runId: scan.id,
      status: "interrupted",
      stopCode: "INJECTED_RESUME_FIXTURE"
    });
  };
  let invalidBatchIndex = 0;
  for (const invalid of invalidAttachedBatches) {
    invalidBatchIndex += 1;
    const invalidBatchId = createBatch(db, "boss", "invalid-resume", "invalid attached resume", {
      profileId: saved.profileId,
      searchPlanId: saved.planId,
      status: "interrupted",
      filterSnapshot: invalid.filterSnapshot
    });
    attachInterruptedScanBatch(invalidBatchId, invalidBatchIndex);
    const workflowRowBefore = db.prepare(
      "SELECT status, updated_at, scan_run_id, scan_batch_id FROM workflow_runs WHERE id = ?"
    ).get(workflow.id);
    const scanRunCountBefore = Number(db.prepare("SELECT COUNT(*) AS count FROM scan_runs").get().count);
    const spawnCountBeforeInvalidBatchResume = spawns.length;
    const invalidBatchResume = await postForm(baseUrl, "/api/workflow-run/resume", {
      workflowRunId: workflow.id,
      browserMode: "edge"
    });
    assert.strictEqual(invalidBatchResume.status, 409);
    assert.match(invalidBatchResume.body, new RegExp(invalid.expectedCode));
    assert.strictEqual(spawns.length, spawnCountBeforeInvalidBatchResume);
    assert.strictEqual(Number(db.prepare("SELECT COUNT(*) AS count FROM scan_runs").get().count), scanRunCountBefore);
    assert.deepStrictEqual(
      db.prepare("SELECT status, updated_at, scan_run_id, scan_batch_id FROM workflow_runs WHERE id = ?").get(workflow.id),
      workflowRowBefore
    );
  }

  const validInheritedResumeBatchId = createBatch(db, "boss", "valid-resume", "valid attached resume", {
    profileId: saved.profileId,
    searchPlanId: saved.planId,
    status: "interrupted",
    filterSnapshot: { execution: validInheritedResumeSnapshot }
  });
  attachInterruptedScanBatch(validInheritedResumeBatchId, "valid");
  const resumed = await postForm(baseUrl, "/api/workflow-run/resume", {
    workflowRunId: workflow.id,
    browserMode: "edge"
  });
  assert.strictEqual(resumed.status, 303);
  assert.strictEqual(resumed.location, `/workflow?runId=${workflow.id}`);
  assert.strictEqual(spawns.length, 2);
  assert.strictEqual(getWorkflowRun(db, workflow.id).status, "scanning");
  const resumedScan = getLatestScanRun(db, { planId: saved.planId, site: "boss" });

  const batchId = validInheritedResumeBatchId;
  attachWorkflowScan(db, { id: workflow.id, scanRunId: resumedScan.id, scanBatchId: batchId });
  for (let index = 0; index < 6; index += 1) upsertJob(db, index === 0 ? layeredTalkJob() : job(index + 1), batchId);
  upsertJob(db, lowRiskBackupJob(), batchId);
  upsertJob(db, layeredBackupJob(), batchId);
  transitionWorkflowRun(db, { id: workflow.id, status: "analyzing" });
  transitionWorkflowRun(db, { id: workflow.id, status: "review_required", inventoryCount: 1 });

  const reviewPage = await getText(baseUrl, started.location);
  assert.match(reviewPage.body, /确认本轮沟通清单/);
  assert.match(reviewPage.body, new RegExp(`name="workflowRunId" value="${workflow.id}"`));
  assert.strictEqual((reviewPage.body.match(/<input[^>]*name="jobIds"[^>]*checked/g) || []).length >= 6, true);
  assert.match(reviewPage.body, /本轮成功目标\s*35/);
  assert.match(reviewPage.body, /有效候选\s*<strong>/);
  assert.strictEqual(getWorkflowRun(db, workflow.id).inventoryCount >= 6, true);
  for (const label of ["匹配分支", "大模型应用开发", "岗位主体", "主体匹配", "基本一致", "已覆盖根基", "待确认根基"]) {
    assert.match(reviewPage.body, new RegExp(label));
  }
  assert.match(reviewPage.body, /硬性限制：岗位方向需谨慎/);
  assert.match(reviewPage.body, /workflow-tier/);
  for (const tier of ["主投", "可投", "慎投"]) assert.match(reviewPage.body, new RegExp(tier));
  const jobsPage = await getText(baseUrl, `/jobs?planId=${saved.planId}&batch=latest`);
  for (const label of ["匹配分支", "大模型应用开发", "岗位主体", "主体匹配", "基本一致", "已覆盖根基", "待确认根基"]) {
    assert.match(jobsPage.body, new RegExp(label));
  }
  assert.doesNotMatch(jobsPage.body, /简历：完成 RAG 应用交付/);

  const selectedIds = listWorkflowReviewCandidates(db, workflow.id)
    .filter((candidate) => candidate.defaultChecked)
    .map((candidate) => candidate.id);
  const confirmed = await postForm(baseUrl, "/api/communication-batch", {
    workflowRunId: workflow.id,
    planId: saved.planId,
    browserMode: "edge",
    jobIds: selectedIds
  });
  assert.strictEqual(confirmed.status, 303);
  assert.strictEqual(confirmed.location, `/workflow?runId=${workflow.id}`);

  const confirmedPage = await getText(baseUrl, confirmed.location);
  assert.match(confirmedPage.body, /清单已确认/);
  assert.match(confirmedPage.body, /name="action" value="start"/);
  assert.match(confirmedPage.body, /开始沟通/);

  transitionWorkflowRun(db, { id: workflow.id, status: "communicating" });
  transitionWorkflowRun(db, { id: workflow.id, status: "completed", successfulCount: 30, shortfallCode: "WORKFLOW_SUPPLY_EXHAUSTED" });
  for (const action of ["list_navigation", "list_navigation", "pane_detail_read", "pane_detail_read", "pane_detail_read", "pane_detail_read"]) {
    recordSiteAccessEvent(db, { site: "boss", action, runId: resumedScan.id });
  }
  const completedPage = await getText(baseUrl, confirmed.location);
  assert.match(completedPage.body, /本轮已完成/);
  assert.match(completedPage.body, /今日进度\s*<strong>30\s*\/\s*70/);
  assert.match(completedPage.body, /本轮成功\s*<strong>30/);

  const planAfter = await getText(baseUrl, `/plan?planId=${saved.planId}`);
  assert.match(planAfter.body, /今日进度<\/span><strong>30\s*\/\s*70/);
  assert.match(planAfter.body, /下一轮目标<\/span><strong>40/);
  assert.match(planAfter.body, /剩余详情读取预算 356 · 剩余搜索页预算 58/);
  assert.strictEqual((planAfter.body.match(/name="action" value="start"/g) || []).length, 0);
  assert.match(planAfter.body, /两轮扫描至少间隔 2 小时/);

  const rejectedWhileScanExists = await postForm(baseUrl, "/api/workflow-run", {
    planId: saved.planId,
    browserMode: "edge",
    action: "start"
  });
  assert.strictEqual(rejectedWhileScanExists.status, 409);
  assert.strictEqual(listWorkflowRuns(db, { planId: saved.planId }).length, 1);

  spawns[1].child.emit("close", 0, null);
  const generatedWorkflow = createWorkflowRun(db, {
    id: "workflow-generated-portable-resume",
    profileId: saved.profileId,
    planId: saved.planId,
    localDay: "2099-01-01",
    sequence: 1,
    targetSuccessCount: 5,
    candidateGap: 5,
    scanNeeded: true,
    keywords: [{ word: "AI应用开发工程师", priority: "A", maxCards: 20 }],
    budget: { maxDetailTotal: 20, browserPageBudget: 5 },
    planner: {
      acquisitionMode: "generated",
      browserMode: "portable"
    }
  });
  transitionWorkflowRun(db, { id: generatedWorkflow.id, status: "scanning" });
  transitionWorkflowRun(db, {
    id: generatedWorkflow.id,
    status: "interrupted",
    errorCode: "INJECTED_GENERATED_INTERRUPTION",
    errorMessage: "generated portable resume fixture"
  });
  const generatedInterruptedPage = await getText(baseUrl, `/workflow?runId=${generatedWorkflow.id}`);
  assert.match(generatedInterruptedPage.body, /<select name="browserMode">/);
  assert.match(generatedInterruptedPage.body, /<option value="edge">当前已登录 Edge<\/option>/);
  assert.match(generatedInterruptedPage.body, /<option value="portable" selected>项目专用 Edge<\/option>/);
  assert.doesNotMatch(generatedInterruptedPage.body, /<input type="hidden" name="browserMode" value="edge">/);

  const generatedBeforeInvalidMode = getWorkflowRun(db, generatedWorkflow.id);
  const spawnCountBeforeInvalidGeneratedMode = spawns.length;
  const invalidGeneratedMode = await postForm(baseUrl, "/api/workflow-run/resume", {
    workflowRunId: generatedWorkflow.id,
    browserMode: "chromium",
    cdpPort: 9333
  });
  assert.strictEqual(invalidGeneratedMode.status, 409);
  assert.match(invalidGeneratedMode.body, /WORKFLOW_BROWSER_MODE_INVALID/);
  assert.strictEqual(spawns.length, spawnCountBeforeInvalidGeneratedMode);
  assert.deepStrictEqual(getWorkflowRun(db, generatedWorkflow.id), generatedBeforeInvalidMode);

  const generatedPortableResume = await postForm(baseUrl, "/api/workflow-run/resume", {
    workflowRunId: generatedWorkflow.id,
    browserMode: "portable",
    cdpPort: 9333
  });
  assert.strictEqual(generatedPortableResume.status, 303);
  assert.strictEqual(generatedPortableResume.location, `/workflow?runId=${generatedWorkflow.id}`);
  assert.strictEqual(spawns.length, spawnCountBeforeInvalidGeneratedMode + 1);
  assert.deepStrictEqual(
    spawns.at(-1).args.slice(spawns.at(-1).args.indexOf("--browser"), spawns.at(-1).args.indexOf("--browser") + 4),
    ["--browser", "portable", "--cdp-port", "9333"]
  );
  assert.strictEqual(getWorkflowRun(db, generatedWorkflow.id).status, "scanning");

  console.log("workflow_dashboard_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (db) db.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.rmSync(`${dbPath}${suffix}`, { force: true }); } catch {}
  }
});

function seedProfile(database) {
  const profile = {
    candidate: { name: "Workflow Candidate", city: "广州", targetTitles: ["AI应用开发工程师"], expectedSalary: "10-20K" },
    education: [{ school: "Test University", degree: "本科", major: "电子信息工程" }],
    experiences: [],
    skills: [{ name: "Python", evidence: ["KnowledgeFlow"] }, { name: "RAG", evidence: ["KnowledgeFlow"] }],
    projects: [{ name: "KnowledgeFlow", roleBoundary: "独立项目", canSay: ["LangGraph workflow"] }],
    credentials: [],
    strengths: []
  };
  const saved = saveProfileAnalysis(database, {
    profile,
    document: {
      originalFileName: "workflow-resume.txt",
      format: "text",
      contentHash: "workflow-dashboard-resume",
      text: "Python RAG LangGraph project experience. ".repeat(10),
      diagnostics: {}
    },
    searchPlan: {
      name: "Inherited platform-default AI",
      cities: ["测试未映射城市"],
      directions: ["AI应用开发"],
      keywords: [
        { word: "AI应用开发工程师", priority: "A", reason: "主方向" },
        { word: "大模型应用开发工程师", priority: "A", reason: "主方向" },
        { word: "Agent开发工程师", priority: "A", reason: "主方向" },
        { word: "RAG工程师", priority: "B", reason: "补充方向" },
        { word: "AI知识库开发", priority: "B", reason: "补充方向" }
      ],
      salary: { minK: 10, maxK: 20 },
      experience: ["经验不限", "1-3年"],
      jobTypes: ["全职"],
      degrees: [],
      bossActiveDays: 3,
      platform: { site: "boss" }
    }
  });
  // 工作流启动以已确认匹配偏好卡为前提；离线种子用确定性映射直接确认。
  const draft = createMatchingCardDraft(database, {
    profileId: saved.profileId,
    profileVersionId: saved.profileVersionId,
    resumeDocumentId: saved.resumeDocumentId,
    resumeContentHash: "workflow-dashboard-resume",
    card: matchingCardFromProfile(profile),
    source: "migration"
  });
  confirmMatchingCard(database, { profileId: saved.profileId, cardId: draft.id });
  return saved;
}

function job(index) {
  return {
    source: "boss",
    sourceId: `workflow-dashboard-${index}`,
    keyword: "AI应用开发工程师",
    title: `AI应用开发工程师 ${index}`,
    company: `Company ${index}`,
    location: "广州",
    salary: "10-15K",
    experience: "1-3年",
    education: "本科",
    bossActiveText: "今日活跃",
    bossActiveDays: 0,
    url: `https://www.zhipin.com/job_detail/workflow-dashboard-${index}.html`,
    tags: ["Python", "RAG"],
    description: "负责 Python RAG 应用开发、检索优化、接口联调、测试与线上问题排查。".repeat(6),
    score: 28 - index,
    level: "优先",
    matches: ["Python", "RAG"],
    risks: [],
    qualityTags: ["salary_target_core"],
    analysis: {
      provider: "openai_compatible",
      semanticStatus: "complete",
      recommendation: "primary",
      recommendationSchemaVersion: 2,
      fitLevel: "fit",
      confidence: 0.9,
      evidence: { jd: ["Python RAG"], resume: ["Python RAG"] },
      hardBlockers: []
    }
  };
}

function layeredBackupJob() {
  return {
    ...job("layered-backup"),
    analysis: {
      ...job("layered-backup").analysis,
      recommendation: "caution",
      fitLevel: "mostly_fit",
      roleSummary: "负责 RAG 应用交付与持续优化",
      responsibilityEvidence: ["JD：负责 RAG 应用交付"],
      roleAlignment: "misaligned",
      roleResumeEvidence: ["简历：完成 RAG 应用交付"],
      roleGaps: ["生产环境部署经验待确认"],
      hardBlockers: ["岗位方向需谨慎"],
      requirementMatches: [
        { requirement: "RAG 应用交付", foundation: true, state: "matched" },
        { requirement: "生产环境部署", foundation: true, state: "unknown" }
      ]
    }
  };
}

function lowRiskBackupJob() {
  return {
    ...job("low-risk-backup"),
    analysis: {
      ...job("low-risk-backup").analysis,
      recommendation: "caution",
      fitLevel: "mostly_fit"
    },
    qualityTags: ["salary_target_core", "experience_salary_overlap"]
  };
}

function layeredTalkJob() {
  return {
    ...job("layered-talk"),
    analysis: {
      ...job("layered-talk").analysis,
      recommendation: "apply",
      fitLevel: "mostly_fit",
      selectedTrackId: "T1",
      selectedTrackLabel: "大模型应用开发",
      roleSummary: "负责 RAG 应用交付与持续优化",
      responsibilityEvidence: ["JD：负责 RAG 应用交付"],
      roleAlignment: "mostly_aligned",
      roleResumeEvidence: ["简历：完成 RAG 应用交付"],
      roleGaps: ["生产环境部署经验待确认"],
      requirementMatches: [
        { requirement: "RAG 应用交付", foundation: true, state: "matched" },
        { requirement: "生产环境部署", foundation: true, state: "unknown" }
      ]
    }
  };
}

async function listen(target) {
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${target.address().port}`;
}

async function getText(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  return { status: response.status, body: await response.text() };
}

async function postForm(baseUrl, pathname, body) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, String(item));
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params,
    redirect: "manual"
  });
  return { status: response.status, location: response.headers.get("location"), body: await response.text() };
}
