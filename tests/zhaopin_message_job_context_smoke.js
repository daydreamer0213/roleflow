const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  openDb,
  saveProfileAnalysis,
  createMatchingCardDraft,
  confirmMatchingCard,
  createBatch,
  upsertJob,
  listReportJobs
} = require("../src/core/storage");
const { listOpenMessageReplyDrafts } = require("../src/core/storage");
const { matchingCardFromProfile } = require("../src/core/matching_card");
const { createZhaopinMessageJobContextResolver } = require("../src/application/message_discovery/zhaopin_job_context");
const { runBossMessageDiscovery } = require("../src/core/message_discovery");
const { safeDigest } = require("../src/adapters/sites/boss_message_dom");

const JOB_ID = "CCSYNTH001J00000000001";
const NOW = "2026-09-08T08:00:00.000Z";
const DESCRIPTION = "负责合成系统的设计、开发、测试、上线与稳定性治理，参与需求分析和技术方案评审，持续改善工程质量、监控告警、故障诊断与跨团队交付效率。".repeat(3);
const root = path.resolve(__dirname, "..");
const tempRoot = fs.mkdtempSync(path.join("D:\\DevData\\RoleFlow-tests", "zhaopin-job-context-"));
const db = openDb(path.join(tempRoot, "context.sqlite"));

(async () => {
  try {
    const fixture = seedPlan("fresh");
    const calls = [];
    const selected = Object.freeze({ positionName: "合成软件工程师", companyName: "合成科技有限公司" });
    const target = { tabId: 202, conversationKey: digest("fresh-thread"), sourceJobId: `zhaopin:${JOB_ID}` };
    const resolver = createZhaopinMessageJobContextResolver({
      db,
      profileId: fixture.profileId,
      messageReader: messageReader(calls, selected, "offline"),
      detailReader: {
        async readSelectedJobDetail(input) {
          calls.push("detail");
          assert.equal(input.selected, selected);
          assert.equal(input.communicationTabId, 202);
          return detail("offline");
        }
      },
      modelConfig: { provider: "mock", providers: { mock: { model: "offline" } } },
      analysisDeps: { createJobAnalysisRunner: () => async () => analysis() },
      root,
      now: () => NOW
    });
    const result = await resolver({ target, selected });
    assert.equal(result.contextSource, "message_discovery_detail");
    assert.equal(result.job.source, "zhaopin");
    assert.equal(result.job.sourceId, JOB_ID);
    assert.equal(result.job.analysis.semanticStatus, "complete");
    assert.equal(result.job.analysis.sourceAvailability, "offline");
    assert.equal(result.job.availability, "offline");
    assert.equal(result.card.threadKey, target.conversationKey);
    assert.equal(calls.filter((item) => item === "detail").length, 1);
    assert(calls.filter((item) => item === "target").length >= 2, "selection is revalidated before persistence/binding");

    const stored = listReportJobs(db, { planId: fixture.planId, site: "zhaopin", batch: "all", limit: 20 })
      .find((job) => job.sourceId === JOB_ID && job.analysis.semanticStatus === "complete");
    assert.equal(stored.analysis.sourceAvailability, "offline", "existing analysis write preserves source evidence, not model output");

    const cacheCalls = [];
    const cache = createZhaopinMessageJobContextResolver({
      db,
      profileId: fixture.profileId,
      messageReader: messageReader(cacheCalls, selected, "unknown"),
      detailReader: { async readSelectedJobDetail() { throw new Error("cache hit must not open detail"); } },
      analyzeJob: async () => { throw new Error("cache hit must not analyze"); },
      now: () => NOW
    });
    const cached = await cache({ target, selected });
    assert.equal(cached.contextSource, "local_cache");
    assert.equal(cached.job.availability, "unknown");
    assert.equal(cached.job.analysis.sourceAvailability, "unknown");
    assert.equal(cached.job.analysis.semanticStatus, "complete");
    assert.equal(cacheCalls.includes("detail"), false);

    const restored = await createZhaopinMessageJobContextResolver({ db, profileId: fixture.profileId, now: () => NOW })({ target });
    assert.equal(restored.contextSource, "local_cache", "cache-only injected operation remains available after restart");
    assert.equal(restored.job.availability, "unknown");

    const other = seedPlan("other-user");
    const unavailable = createZhaopinMessageJobContextResolver({ db, profileId: other.profileId, now: () => NOW });
    await assert.rejects(() => unavailable({ target }), (error) => error.code === "MESSAGE_DISCOVERY_JOB_CONTEXT_UNAVAILABLE");

    const cancelled = seedPlan("cancelled");
    const controller = new AbortController();
    const cancelledResolver = createZhaopinMessageJobContextResolver({
      db,
      profileId: cancelled.profileId,
      messageReader: messageReader([], selected, "unknown"),
      detailReader: { async readSelectedJobDetail() { controller.abort(Object.assign(new Error("stopped"), { code: "MESSAGE_DISCOVERY_STOPPED" })); return detail(); } },
      analyzeJob: async () => { throw new Error("cancelled detail must not analyze"); },
      modelConfig: { provider: "fixture" }
    });
    await assert.rejects(() => cancelledResolver({ target, selected, signal: controller.signal }), (error) => error.code === "MESSAGE_DISCOVERY_STOPPED");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM batches WHERE profile_id = ?").get(cancelled.profileId).n, 0);

    const switched = seedPlan("switched");
    const switchedTarget = { ...target, conversationKey: digest("switched-thread") };
    const switchedResolver = createZhaopinMessageJobContextResolver({
      db,
      profileId: switched.profileId,
      messageReader: messageReader([], selected, "unknown"),
      detailReader: { async readSelectedJobDetail() { return detail(); } },
      analyzeJob: async ({ input }) => {
        persistAnalysis(switched, input.jobId, analysis());
        db.prepare("UPDATE search_plans SET is_active = 0 WHERE profile_id = ?").run(switched.profileId);
        db.prepare(`INSERT INTO search_plans(profile_id, name, plan_json, is_active, created_at, updated_at)
          VALUES (?, 'replacement', '{}', 1, ?, ?)`).run(switched.profileId, NOW, NOW);
      },
      modelConfig: { provider: "fixture" }
    });
    await assert.rejects(() => switchedResolver({ target: switchedTarget, selected }), (error) => error.code === "MESSAGE_DISCOVERY_ACTIVE_PLAN_CHANGED");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM candidate_progress_cards WHERE profile_id = ? AND thread_key <> ''").get(switched.profileId).n, 0);

    const pipeline = seedPlan("pipeline");
    const pipelineConversation = digest("pipeline-thread");
    const pipelineSelected = Object.freeze({
      sourceJobId: `zhaopin:${JOB_ID}`,
      lastMessageId: "990001",
      positionName: "合成软件工程师",
      companyName: "合成科技有限公司",
      salary: "20-30K",
      city: "北京",
      messages: Object.freeze([Object.freeze({ direction: "friend", messageId: "990001", contentKind: "text", text: "请介绍相关项目经验。" })])
    });
    const pipelineReader = {
      async scanConversationRows() {
        return { tabId: 202, rows: [{ rowIndex: 0, unread: true, identityVerified: true,
          conversationKey: pipelineConversation, previewDigest: safeDigest(["zhaopin", "pipeline-preview"]),
          previewKind: "possible_hr_reply", sourceJobId: `zhaopin:${JOB_ID}`, lastMessageId: "990001", lastMessageDirection: "friend" }] };
      },
      async openQueuedConversation() { return pipelineSelected; },
      async readSelectedJobTarget(value) {
        assert.equal(value, pipelineSelected, "resolver must receive the reader-owned selected result, not a caller-made clone");
        return { jobId: JOB_ID, navigationUrl: `https://www.zhaopin.com/jobdetail/${JOB_ID}.html`, canonicalUrl: `https://www.zhaopin.com/jobdetail/${JOB_ID}.htm`, availability: "unknown" };
      },
      async assertActiveBindings() {}
    };
    const pipelineResolver = createZhaopinMessageJobContextResolver({
      db, profileId: pipeline.profileId, messageReader: pipelineReader,
      detailReader: { async readSelectedJobDetail() { return detail(); } },
      modelConfig: { provider: "mock", providers: { mock: { model: "offline" } } },
      analysisDeps: { createJobAnalysisRunner: () => async () => analysis() }, root, now: () => NOW
    });
    const pipelineSummary = await runBossMessageDiscovery({
      db, profileId: pipeline.profileId, platform: "zhaopin", reader: pipelineReader, resolveJobContext: pipelineResolver,
      classifyMessageGroup: async () => ({ messageIntent: "information_request", messageCategory: "other",
        messageSummary: "项目经验确认", missingFact: null, messages: ["我可以介绍相关项目经验。"], progressUpdate: { stage: "reply_ready" } }),
      now: () => NOW, sleepFn: async () => {}
    });
    assert.equal(pipelineSummary.processed, 1, JSON.stringify(pipelineSummary));
    assert.equal(pipelineSummary.results[0].contextSource, "message_discovery_detail");
    assert.equal(pipelineSummary.results[0].job.opportunityVerdict, "值得继续聊");
    assert.equal(listOpenMessageReplyDrafts(db, { profileId: pipeline.profileId }).length, 1);

    console.log("zhaopin_message_job_context_smoke ok");
  } finally {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

function seedPlan(label) {
  const profile = {
    candidate: { name: `Candidate ${label}`, city: "北京", targetTitles: ["软件工程师"], expectedSalary: "20-30K" },
    education: [{ school: "合成大学", degree: "本科", major: "计算机" }],
    experiences: [], skills: [{ name: "Node.js", evidence: ["project"] }],
    projects: [{ name: "合成项目", roleBoundary: "owner", canSay: ["系统开发"] }], credentials: [], strengths: []
  };
  const saved = saveProfileAnalysis(db, {
    profile,
    document: { originalFileName: `${label}.txt`, format: "text", contentHash: `${label}-resume`, text: "Node.js 软件系统研发与交付经验 ".repeat(12), diagnostics: {} },
    searchPlan: { name: `Plan ${label}`, cities: ["北京"], directions: ["软件工程师"], keywords: [{ word: "软件工程师", priority: "A" }], experience: ["3-5年"], jobTypes: ["全职"] }
  });
  const card = createMatchingCardDraft(db, {
    profileId: saved.profileId, profileVersionId: saved.profileVersionId, resumeDocumentId: saved.resumeDocumentId,
    resumeContentHash: `${label}-resume`, card: matchingCardFromProfile(profile), source: "migration"
  });
  confirmMatchingCard(db, { profileId: saved.profileId, cardId: card.id });
  return saved;
}

function messageReader(calls, selected, availability) {
  return {
    async readSelectedJobTarget(value) {
      calls.push("target");
      assert.equal(value, selected);
      return { jobId: JOB_ID, navigationUrl: `https://www.zhaopin.com/jobdetail/${JOB_ID}.html`, canonicalUrl: `https://www.zhaopin.com/jobdetail/${JOB_ID}.htm`, availability };
    },
    async assertActiveBindings() { calls.push("binding"); }
  };
}

function detail(availability = "unknown") {
  return {
    source: "zhaopin", sourceId: JOB_ID, canonicalUrl: `https://www.zhaopin.com/jobdetail/${JOB_ID}.htm`,
    title: "合成软件工程师", company: "合成科技有限公司", location: "北京", salary: "20-30K",
    experience: "3-5年", education: "本科", tags: ["Node.js"], description: DESCRIPTION, availability
  };
}

function analysis() {
  return {
    provider: "fixture", model: "offline", semanticStatus: "complete", decisionStatus: "ready",
    recommendation: "apply", fitLevel: "A", fitReasons: ["技能匹配"], roleSummary: "负责软件系统研发与交付",
    evidence: { jd: ["合成岗位说明"], resume: ["合成履历证据"] }
  };
}

function persistAnalysis(fixture, jobId, value) {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
  const batchId = createBatch(db, "zhaopin", "analysis-retry", "fixture", { profileId: fixture.profileId, searchPlanId: fixture.planId });
  upsertJob(db, {
    source: row.source, sourceId: row.source_id, keyword: row.keyword, title: row.title, company: row.company,
    location: row.location, salary: row.salary, experience: row.experience, education: row.education,
    url: row.url, tags: JSON.parse(row.tags_json), description: row.description,
    qualityTags: JSON.parse(row.quality_tags_json), analysis: value
  }, batchId);
}

function digest(value) {
  return `sha256:${require("node:crypto").createHash("sha256").update(value).digest("hex")}`;
}
