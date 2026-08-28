const assert = require("node:assert/strict");
const { openDb } = require("../src/core/storage");
const { createDashboardServer } = require("../src/dashboard/server");
const { renderFunnelPage } = require("../src/dashboard/pages/funnel");

const logger = {
  info() {}, warn() {}, error() {},
  requestId() { return "dashboard-funnel-smoke"; },
  listRecent() { return []; }
};

(async () => {
  const db = openDb(":memory:");
  const owner = createOwner(db);
  const refreshCalls = [];
  const funnelAnalysisService = {
    refresh(input) {
      refreshCalls.push(input);
      return dashboardFixture();
    }
  };
  const server = createDashboardServer({
    db,
    forceMock: true,
    allowOfflineMock: true,
    logger,
    browserAuthority: { browserMode: "edge", cdpPort: null, profilePath: "" },
    funnelAnalysisService
  });
  const baseUrl = await listen(server);
  try {
    const response = await getText(baseUrl, `/funnel?planId=${owner.planId}`);
    assert.equal(response.status, 200);
    assert.match(response.contentType, /^text\/html(?:;|$)/);
    assert.match(response.body, /<title>求职体检<\/title>/);
    assert.match(response.body, /<h1[^>]*>求职体检<\/h1>/);
    assert.match(response.body, /aria-current="page">求职体检<\/a>/);
    assert.match(response.body, />诊断<\/a>/, "technical diagnostics remains a separate destination");
    assert.deepEqual(refreshCalls, [{ profileId: owner.profileId }], "the requested plan owns the analyzed profile");

    assert.match(response.body, /30 个[^<]*初步观察/);
    assert.match(response.body, /50 个[^<]*阶段诊断/);
    assert.match(response.body, /70 个[^<]*正式诊断/);
    assert.match(response.body, /当前 35 个成熟样本/);
    assert.match(response.body, /初步观察/);
    assert.match(response.body, /距离阶段诊断还差 15 个/);
    assert.match(response.body, /每个岗位至少经过 48 小时/);
    assert.match(response.body, /跨周末顺延到周一/);
    assert.match(response.body, /等待和未知状态不进入失败分母/);

    for (const label of ["发起求职动作", "招聘方已读", "招聘方回复", "有效沟通", "索要简历", "发出面试邀请", "确认面试或后续"]) {
      assert.match(response.body, new RegExp(label), `funnel stage is visible: ${label}`);
    }
    assert.match(response.body, /AI &lt;应用&gt;/, "user-owned comparison labels are escaped");
    assert.doesNotMatch(response.body, /AI <应用>/);
    assert.match(response.body, /Java 后端/);
    assert.doesNotMatch(response.body, /sha256:|resume:77/, "internal material identifiers never reach the page");
    assert.doesNotMatch(response.body, /证明|导致|准确率/);
    assert.doesNotMatch(response.body, /<form|method="post"|自动投递|自动发送/, "the checkup is read-only and local");
    assert.strictEqual((response.body.match(/class="app-shell"/g) || []).length, 1);
    assert.strictEqual((response.body.match(/<main(?:\s|>)/g) || []).length, 1);

    const missing = await getText(baseUrl, "/funnel?planId=999999");
    assert.equal(missing.status, 200);
    assert.match(missing.body, /找不到这份筛选方案/);
    assert.equal(refreshCalls.length, 1, "an unknown plan cannot fall through to another candidate");
  } finally {
    await close(server);
    db.close();
  }

  const empty = renderFunnelPage({
    plan: { id: 9, name: "空样本方案", profileId: 5 },
    dashboard: {
      policy: { preliminarySampleTarget: 30, comparableSampleTarget: 50, formalSampleTarget: 70 },
      currentPool: { started: 0, mature: 0, waiting: 0, unknown: 0, strength: "facts", nextTarget: 30 },
      latestCohort: null,
      funnel: emptyFunnel(),
      comparisons: { direction: [], decisionBucket: [], resumeVersion: [], greeting: [] },
      headline: "当前还没有进入统计的求职动作。",
      priorityCheck: "确认已投、已发起沟通或已发送回复后，RoleFlow 会自动开始等待反馈。",
      evidenceNotes: []
    }
  });
  assert.match(empty, /还没有可统计的求职动作/);
  assert.match(empty, /确认已投、已验证发起沟通或确认已发送回复/);

  console.log("dashboard_funnel_smoke: ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

function createOwner(db) {
  const now = "2026-08-28T02:00:00.000Z";
  const profileId = Number(db.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES ('Funnel Candidate', '{}', NULL, ?, ?)`).run(now, now).lastInsertRowid);
  const planId = Number(db.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, '阶段二方案', '{}', NULL, 1, ?, ?)`).run(profileId, now, now).lastInsertRowid);
  return { profileId, planId };
}

function dashboardFixture() {
  return {
    policy: { preliminarySampleTarget: 30, comparableSampleTarget: 50, formalSampleTarget: 70 },
    currentPool: { started: 38, mature: 35, waiting: 3, unknown: 3, strength: "preliminary", nextTarget: 50 },
    latestCohort: null,
    funnel: {
      started: stage(38, 38, 0, 0),
      read: stage(25, 32, 3, 3),
      replied: stage(12, 32, 3, 3),
      effectiveConversation: stage(8, 20, 15, 3),
      resumeRequested: stage(5, 35, 0, 3),
      interviewInvited: stage(3, 35, 0, 3),
      interviewConfirmed: stage(1, 35, 0, 3)
    },
    comparisons: {
      direction: [
        comparison("AI <应用>", 20, 10, 18),
        comparison("Java 后端", 15, 2, 14)
      ],
      decisionBucket: [],
      resumeVersion: [comparison("resume:77", 18, 7, 17)],
      greeting: [comparison("sha256:private-digest", 20, 8, 19)]
    },
    headline: "初步观察：当前主要卡在“已读到回复”。",
    priorityCheck: "优先检查岗位匹配和开场表达，不必立即重写简历。",
    evidenceNotes: [
      "仅统计用户确认已投、已验证发起沟通或确认已发送回复的岗位。",
      "每个岗位至少经过 48 小时；跨周末顺延到周一。",
      "等待和未知状态不进入失败分母，观察关系不代表因果。"
    ]
  };
}

function comparison(key, sampleCount, replies, known) {
  return {
    key,
    sampleCount,
    read: { numerator: known, denominator: sampleCount, unknown: sampleCount - known, rate: known / sampleCount },
    replied: { numerator: replies, denominator: known, unknown: sampleCount - known, rate: replies / known },
    effectiveConversation: { numerator: Math.min(replies, 5), denominator: replies, unknown: sampleCount - replies, rate: replies ? Math.min(replies, 5) / replies : null },
    interviewInvited: { numerator: Math.min(replies, 2), denominator: sampleCount, unknown: 0, rate: Math.min(replies, 2) / sampleCount }
  };
}

function stage(numerator, denominator, unknown, waiting) {
  return { numerator, denominator, unknown, waiting };
}

function emptyFunnel() {
  return Object.fromEntries([
    "started", "read", "replied", "effectiveConversation",
    "resumeRequested", "interviewInvited", "interviewConfirmed"
  ].map((key) => [key, stage(0, 0, 0, 0)]));
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function getText(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  return {
    status: response.status,
    contentType: response.headers.get("content-type") || "",
    body: await response.text()
  };
}
