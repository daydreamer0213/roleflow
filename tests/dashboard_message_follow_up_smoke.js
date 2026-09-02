"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  openDb,
  saveProfileAnalysis,
  createMatchingCardDraft,
  confirmMatchingCard,
  recordMessageReplyDrafts,
  saveMessageInboundContext
} = require("../src/core/storage");
const { matchingCardFromProfile } = require("../src/core/matching_card");
const { createDashboardServer } = require("../src/dashboard/server");
const { renderMessageFollowUpPage } = require("../src/dashboard/pages/message_follow_up");

const TOKEN = "follow-up-action-token";
const NOW = "2026-09-03T08:00:00.000Z";

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function main() {
  assert.equal(typeof renderMessageFollowUpPage, "function");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-follow-up-page-"));
  const dbPath = path.join(root, "dashboard.sqlite");
  const db = openDb(dbPath);
  let server = null;
  try {
    const fixture = createFixture(db);
    let prepared = false;
    const candidate = () => ({
      profileId: fixture.profileId,
      planId: fixture.planId,
      jobId: fixture.jobId,
      job: {
        id: fixture.jobId,
        sourceId: fixture.sourceJobId,
        title: "内容运营",
        company: "示例公司",
        decisionBucket: "primary",
        analysis: { recommendation: "primary" }
      },
      card: { id: fixture.cardId, threadKey: fixture.conversationKey },
      entry: { startedAt: "2026-08-25T07:00:00.000Z" },
      projection: { waitedHours: 72, waitingSince: "2026-08-25T08:00:00.000Z" },
      draft: prepared ? fixture.draft : null,
      context: prepared ? fixture.context : null,
      draftQualityWarnings: prepared ? ["MESSAGE_DRAFT_RECENTLY_SIMILAR"] : []
    });
    const followUpService = {
      listCandidates({ profileId, planId }) {
        assert.equal(Number(profileId), fixture.profileId);
        assert.equal(Number(planId), fixture.planId);
        return [candidate()];
      },
      requireCandidate() { return candidate(); },
      async savePreparedDraft() { return { draft: fixture.draft }; }
    };
    const prepareCalls = [];
    const followUpController = {
      async prepare(input) {
        prepareCalls.push(input);
        prepared = true;
        return { draft: fixture.draft };
      },
      async close() {}
    };
    server = createDashboardServer({
      db,
      root,
      dataRoot: root,
      dbPath,
      forceMock: true,
      browserAuthority: { browserMode: "portable", cdpPort: 9222, profilePath: path.join(root, "profile") },
      logger: quietLogger(),
      messageReplyActionToken: TOKEN,
      messageFollowUpService: followUpService,
      messageFollowUpController: followUpController
    });
    const base = await listen(server);

    const today = await request(base, `/plan?profileId=${fixture.profileId}&planId=${fixture.planId}`);
    assert.equal(today.status, 200);
    assert.match(today.body, /有 1 个岗位可以考虑跟进/);
    assert.match(today.body, new RegExp(`/follow-ups\\?profileId=${fixture.profileId}&amp;planId=${fixture.planId}`));

    let page = await request(base, `/follow-ups?profileId=${fixture.profileId}&planId=${fixture.planId}`);
    assert.equal(page.status, 200);
    assert.match(page.body, /无回复跟进/);
    assert.match(page.body, /已等待 72 小时/);
    assert.match(page.body, /准备跟进草稿/);
    assert.doesNotMatch(page.body, /data-draft-text/);

    let response = await postForm(base, "/api/message-follow-up/prepare", {
      profileId: fixture.profileId,
      planId: fixture.planId,
      jobId: fixture.jobId,
      previousOutboundText: "客户端不得提交的文字"
    });
    assert.equal(response.status, 400);
    assert.equal(prepareCalls.length, 0);

    response = await postForm(base, "/api/message-follow-up/prepare", {
      profileId: fixture.profileId,
      planId: fixture.planId,
      jobId: fixture.jobId
    });
    assert.equal(response.status, 303);
    assert.equal(prepareCalls.length, 1);
    assert.deepEqual(prepareCalls[0], {
      profileId: String(fixture.profileId),
      planId: String(fixture.planId),
      jobId: String(fixture.jobId)
    });

    page = await request(base, `/follow-ups?profileId=${fixture.profileId}&planId=${fixture.planId}`);
    assert.equal(page.status, 200);
    assert.match(page.body, /你上次发送/);
    assert.match(page.body, /您好，想了解这个岗位。/);
    assert.match(page.body, /data-draft-text/);
    assert.match(page.body, new RegExp(`data-draft-id="${fixture.draft.id}"`));
    assert.match(page.body, new RegExp(`data-send-single="${fixture.draft.id}"`));
    assert.match(page.body, /data-send-select="\d+" checked/);
    assert.match(page.body, /确认并串行发送 1 条/);
    assert.match(page.body, /这条草稿与近期消息的表达比较接近，你可以直接发送，也可以改得更具体。/);
    assert(page.body.includes(TOKEN));
    assert.match(page.body, /\/api\/message-reply-draft/);
    assert.match(page.body, /\/api\/message-reply-send-batch/);

    const messages = await request(base, `/messages?profileId=${fixture.profileId}`);
    assert.equal(messages.status, 200);
    assert.doesNotMatch(messages.body, /跟进草稿测试文本/, "follow-up drafts must not appear as an HR inbound reply");

    followUpService.listCandidates = () => [];
    const emptyToday = await request(base, `/plan?profileId=${fixture.profileId}&planId=${fixture.planId}`);
    assert.doesNotMatch(emptyToday.body, /可以考虑跟进/);
    const emptyPage = await request(base, `/follow-ups?profileId=${fixture.profileId}&planId=${fixture.planId}`);
    assert.match(emptyPage.body, /当前没有需要跟进的岗位/);

    console.log("dashboard_message_follow_up_smoke ok");
  } finally {
    if (server) await close(server);
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function createFixture(db) {
  const profile = {
    candidate: { name: "跟进测试候选人", city: "广州", targetTitles: ["内容运营"], expectedSalary: "10-15K" },
    education: [], experiences: [], skills: [{ name: "内容策划" }], projects: [{ name: "内容增长项目" }], credentials: [], strengths: []
  };
  const saved = saveProfileAnalysis(db, {
    profile,
    document: {
      originalFileName: "resume.txt",
      format: "text",
      contentHash: "follow-up-profile",
      text: "内容运营和内容策划经验。".repeat(20),
      diagnostics: {}
    },
    searchPlan: {
      name: "内容运营方案",
      cities: ["广州"],
      directions: ["内容运营"],
      keywords: [{ word: "内容运营", priority: "A", reason: "目标岗位" }],
      experience: ["1-3年"],
      jobTypes: ["全职"],
      degrees: [],
      salary: { minK: 10, maxK: 15 },
      bossActiveDays: 3,
      platform: { site: "boss" }
    }
  });
  const matchCard = createMatchingCardDraft(db, {
    profileId: saved.profileId,
    profileVersionId: saved.profileVersionId,
    resumeDocumentId: saved.resumeDocumentId,
    resumeContentHash: "follow-up-profile",
    card: matchingCardFromProfile(profile),
    source: "migration"
  });
  confirmMatchingCard(db, { profileId: saved.profileId, cardId: matchCard.id });
  const sourceJobId = "boss:follow-up-page-job";
  const jobId = Number(db.prepare(`INSERT INTO jobs(
    source, source_id, title, company, first_seen_at, last_seen_at
  ) VALUES ('boss', ?, '内容运营', '示例公司', ?, ?)`)
    .run(sourceJobId, NOW, NOW).lastInsertRowid);
  const conversationKey = digest("follow-up-page-conversation");
  const cardId = Number(db.prepare(`INSERT INTO candidate_progress_cards(
    profile_id, plan_id, job_id, source, thread_key, stage, next_action,
    last_event_at, created_at, updated_at
  ) VALUES (?, ?, ?, 'boss', ?, 'waiting_reply', '等待招聘方回复', ?, ?, ?)`)
    .run(saved.profileId, saved.planId, jobId, conversationKey, NOW, NOW, NOW).lastInsertRowid);
  const groupKey = digest("follow-up-page-group");
  const draft = recordMessageReplyDrafts(db, {
    profileId: saved.profileId,
    cardId,
    jobId,
    messageGroupKey: groupKey,
    questionSummary: "该岗位已等待回复，可以礼貌跟进。",
    messageIntent: "follow_up",
    messageCategory: "other",
    messages: ["跟进草稿测试文本"],
    createdAt: NOW
  })[0];
  const context = saveMessageInboundContext(db, {
    profileId: saved.profileId,
    cardId,
    messageGroupKey: groupKey,
    conversationKey,
    sourceJobId,
    lastMessageId: "378917037748760",
    messageIntent: "follow_up",
    messageCategory: "other",
    inboundMessages: [{ kind: "text", text: "您好，想了解这个岗位。" }],
    manualActions: [],
    createdAt: NOW,
    updatedAt: NOW
  });
  return { ...saved, jobId, cardId, sourceJobId, conversationKey, draft, context };
}

function quietLogger() {
  return { info() {}, warn() {}, error() {}, requestId() { return "follow-up-page-smoke"; }, listRecent() { return []; } };
}

async function postForm(base, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value)]))
  });
  return { status: response.status, body: await response.text(), location: response.headers.get("location") };
}

async function request(base, pathname) {
  const response = await fetch(`${base}${pathname}`);
  return { status: response.status, body: await response.text() };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value)).digest("hex")}`;
}
