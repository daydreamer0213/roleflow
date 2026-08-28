const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const {
  openDb,
  recordMessageReplyDrafts,
  getMessageReplyDraft,
  listCandidateAnswerMemories,
  listCandidateFacts,
  listOpenMessageReplyDrafts
} = require("../src/core/storage");
const { createMessageReplyLearningService } = require("../src/application/message_learning");
const { createDashboardServer } = require("../src/dashboard/server");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-communication-profile-"));
const db = openDb(path.join(root, "communication-profile.sqlite"));
let server;

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function main() {
  const fixture = createFixture();
  let browserCalls = 0;
  const learning = createMessageReplyLearningService({
    db,
    adapter: {
      async extractReplyEditFacts(input) {
        return {
          scope: { kind: "global", key: "" },
          facts: input.changedText.includes("广州")
            ? [{ factKey: "current_city", factValue: "广州", evidenceText: "广州" }]
            : []
        };
      }
    }
  });
  server = createDashboardServer({
    db,
    browserAuthority: { browserMode: "portable", cdpPort: 9222, profilePath: path.join(root, "edge-profile") },
    root,
    dataRoot: root,
    dbPath: path.join(root, "communication-profile.sqlite"),
    forceMock: true,
    messageReplyLearningService: learning,
    browserFactory() {
      browserCalls += 1;
      throw new Error("local learning must not create a browser");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const page = await getText(base, `/messages?profileId=${fixture.profileId}`);
  assert.strictEqual(page.status, 200);
  assert.match(page.body, new RegExp(`data-draft-id="${fixture.draft.id}"`));
  assert.doesNotMatch(page.body, new RegExp(`<textarea[^>]*data-draft-id="${fixture.draft.id}"[^>]*readonly`));
  assert.match(page.body, new RegExp(`/communication-profile\\?profileId=${fixture.profileId}`));
  await editableDraftClientSmoke(page.body, fixture.draft.id);

  let response = await postJson(base, "/api/message-reply-draft", {
    action: "save",
    profileId: fixture.profileId,
    draftId: fixture.draft.id,
    text: "我目前在广州，可以一周内到岗。"
  });
  assert.strictEqual(response.status, 200);
  assert.deepStrictEqual(Object.keys(response.body).sort(), ["draftId", "ok", "revision"]);
  assert(!JSON.stringify(response.body).includes("广州"));
  assert.strictEqual(getMessageReplyDraft(db, { profileId: fixture.profileId, draftId: fixture.draft.id }).currentText, "我目前在广州，可以一周内到岗。");

  response = await postJson(base, "/api/message-reply-draft", {
    action: "save",
    profileId: fixture.otherProfileId,
    draftId: fixture.draft.id,
    text: "不得越权修改"
  });
  assert.strictEqual(response.status, 404);
  assert.strictEqual(getMessageReplyDraft(db, { profileId: fixture.profileId, draftId: fixture.draft.id }).currentText, "我目前在广州，可以一周内到岗。");

  response = await postJson(base, "/api/message-reply-draft", {
    action: "complete",
    profileId: fixture.profileId,
    draftId: fixture.draft.id,
    text: "我目前在广州，可以一周内到岗。",
    completionKind: "copied"
  });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.body.changed, true);
  assert.strictEqual(response.body.learnedFactCount, 1);
  assert(!Object.hasOwn(response.body, "finalText"));
  assert.strictEqual(listOpenMessageReplyDrafts(db, { profileId: fixture.profileId }).length, 1, "copy keeps the draft visible for manual sending");

  let profilePage = await getText(base, `/communication-profile?profileId=${fixture.profileId}`);
  assert.strictEqual(profilePage.status, 200);
  for (const visible of ["我目前使用的沟通资料", "当前所在城市", "广州", "我改过并让 RoleFlow 记住的回答", "我目前在广州，可以一周内到岗。", "历史修改"]) {
    assert(profilePage.body.includes(visible), `missing communication profile content: ${visible}`);
  }
  for (const hidden of ["current_city", "finalDigest", "confidence", "scope_json", "evidenceText"]) {
    assert(!visibleText(profilePage.body).includes(hidden), `communication profile must not show internal field: ${hidden}`);
  }

  const memory = listCandidateAnswerMemories(db, { profileId: fixture.profileId, source: "user_edited_reply" })[0];
  response = await postForm(base, "/api/communication-profile", {
    action: "revise_memory",
    profileId: fixture.otherProfileId,
    memoryId: memory.id,
    finalText: "不得越权修改回答"
  });
  assert.strictEqual(response.status, 404);
  assert.strictEqual(listCandidateAnswerMemories(db, { profileId: fixture.profileId, source: "user_edited_reply" })[0].finalText, "我目前在广州，可以一周内到岗。");

  response = await postForm(base, "/api/communication-profile", {
    action: "revise_memory",
    profileId: fixture.profileId,
    memoryId: memory.id,
    finalText: "我目前在广州，最快下周一到岗。"
  });
  assert.strictEqual(response.status, 303);
  assert.strictEqual(listCandidateAnswerMemories(db, { profileId: fixture.profileId, source: "user_edited_reply" })[0].finalText, "我目前在广州，最快下周一到岗。");

  response = await postForm(base, "/api/communication-profile", {
    action: "save_fact",
    profileId: fixture.profileId,
    factKey: "expected_salary",
    factValue: "18-22K"
  });
  assert.strictEqual(response.status, 303);
  assert(listCandidateFacts(db, fixture.profileId).some((fact) => fact.factKey === "expected_salary" && fact.factValue === "18-22K"));

  response = await postForm(base, "/api/communication-profile", {
    action: "delete_fact",
    profileId: fixture.profileId,
    factKey: "expected_salary"
  });
  assert.strictEqual(response.status, 303);
  assert(!listCandidateFacts(db, fixture.profileId).some((fact) => fact.factKey === "expected_salary"));

  response = await postForm(base, "/api/communication-profile", {
    action: "withdraw_memory",
    profileId: fixture.profileId,
    memoryId: listCandidateAnswerMemories(db, { profileId: fixture.profileId, source: "user_edited_reply" })[0].id
  });
  assert.strictEqual(response.status, 303);
  assert.strictEqual(listCandidateAnswerMemories(db, { profileId: fixture.profileId, source: "user_edited_reply" }).length, 0);
  profilePage = await getText(base, `/communication-profile?profileId=${fixture.profileId}`);
  assert(!profilePage.body.includes("我目前在广州，最快下周一到岗。"));

  const sentDraft = recordMessageReplyDrafts(db, {
    profileId: fixture.profileId,
    cardId: fixture.cardId,
    jobId: fixture.jobId,
    messageGroupKey: `sha256:${"e".repeat(64)}`,
    questionSummary: "对方询问到岗时间。",
    messageIntent: "information_request",
    messageCategory: "availability",
    messages: ["我可以尽快到岗。"]
  })[0];
  const progressKey = "progress:00000000-0000-4000-8000-000000000001";
  response = await postForm(base, "/api/progress", {
    action: "reply_confirmed_sent",
    cardId: fixture.cardId,
    draftId: sentDraft.id,
    finalText: "我可以下周一到岗。",
    idempotencyKey: progressKey
  });
  assert.strictEqual(response.status, 303);
  assert.strictEqual(getMessageReplyDraft(db, { profileId: fixture.profileId, draftId: sentDraft.id }).closedAt.length > 0, true);
  const eventCount = db.prepare("SELECT COUNT(*) AS count FROM candidate_progress_events WHERE card_id = ? AND idempotency_key = ?")
    .get(fixture.cardId, progressKey).count;
  assert.strictEqual(eventCount, 1);

  response = await postForm(base, "/api/progress", {
    action: "reply_confirmed_sent",
    cardId: fixture.cardId,
    draftId: sentDraft.id,
    finalText: "我可以下周一到岗。",
    idempotencyKey: progressKey
  });
  assert.strictEqual(response.status, 303);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS count FROM candidate_progress_events WHERE card_id = ? AND idempotency_key = ?")
    .get(fixture.cardId, progressKey).count, 1);

  const publicStatus = await getJson(base, `/api/message-discovery-status?profileId=${fixture.profileId}`);
  assert.strictEqual(publicStatus.status, 200);
  assert(!JSON.stringify(publicStatus.body).includes("一周内到岗"));
  assert.strictEqual(browserCalls, 0, "draft learning and profile management must stay local");
  console.log("dashboard_communication_profile_smoke ok");
}

function createFixture() {
  const now = "2026-08-28T06:00:00.000Z";
  const profileId = Number(db.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES ('测试候选人', '{}', NULL, ?, ?)`).run(now, now).lastInsertRowid);
  const otherProfileId = Number(db.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES ('另一候选人', '{}', NULL, ?, ?)`).run(now, now).lastInsertRowid);
  const planId = Number(db.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, '测试方案', '{}', NULL, 1, ?, ?)`).run(profileId, now, now).lastInsertRowid);
  const jobId = Number(db.prepare(`INSERT INTO jobs(
    source, source_id, title, company, salary, description, first_seen_at, last_seen_at
  ) VALUES ('boss', 'learning-job', 'AI 应用专员', '测试公司', '15-25K', '负责 AI 应用落地。', ?, ?)`)
    .run(now, now).lastInsertRowid);
  const cardId = Number(db.prepare(`INSERT INTO candidate_progress_cards(
    profile_id, plan_id, job_id, source, stage, next_action, last_event_at, created_at, updated_at
  ) VALUES (?, ?, ?, 'boss', 'reply_ready', 'Review draft', ?, ?, ?)`)
    .run(profileId, planId, jobId, now, now, now).lastInsertRowid);
  const draft = recordMessageReplyDrafts(db, {
    profileId,
    cardId,
    jobId,
    messageGroupKey: `sha256:${"d".repeat(64)}`,
    questionSummary: "对方询问当前城市和到岗时间。",
    messageIntent: "information_request",
    messageCategory: "availability",
    messages: ["我可以尽快到岗。"],
    createdAt: now
  })[0];
  return { profileId, otherProfileId, planId, jobId, cardId, draft };
}

async function editableDraftClientSmoke(markup, draftId) {
  const scripts = [...markup.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const script = scripts.find((value) => value.includes("data-draft-text"));
  assert(script, "editable draft client behavior is required");
  const fieldHandlers = new Map();
  const copyHandlers = new Map();
  const sentHandlers = new Map();
  const field = {
    value: "第一次修改",
    dataset: { draftId: String(draftId) },
    addEventListener(type, handler) { fieldHandlers.set(type, handler); }
  };
  const copyButton = {
    dataset: { copyDraft: "editable-draft" },
    addEventListener(type, handler) { copyHandlers.set(type, handler); }
  };
  const hiddenText = { value: "" };
  const sentForm = {
    dataset: { sentDraft: "editable-draft" },
    querySelector(selector) { return selector === '[name="finalText"]' ? hiddenText : null; },
    addEventListener(type, handler) { sentHandlers.set(type, handler); }
  };
  const feedback = { textContent: "", dataset: {}, setAttribute() {} };
  const requests = [];
  const order = [];
  const timers = new Map();
  let nextTimer = 1;
  let completeFailure = false;
  const document = {
    querySelector(selector) { return selector === "[data-discovery-feedback]" ? feedback : null; },
    querySelectorAll(selector) {
      if (selector === "[data-discovery-form]") return [];
      if (selector === "[data-draft-text]") return [field];
      if (selector === "[data-copy-draft]") return [copyButton];
      if (selector === "[data-sent-draft]") return [sentForm];
      return [];
    },
    getElementById(id) { return id === "editable-draft" ? field : null; }
  };
  const context = {
    document,
    URLSearchParams,
    FormData: class FormData {},
    encodeURIComponent,
    navigator: { clipboard: { async writeText(value) { order.push(["clipboard", value]); } } },
    location: { reload() {} },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, body });
      order.push(["fetch", body.action]);
      if (completeFailure && body.action === "complete") throw new Error("offline");
      return jsonResponse(200, body.action === "complete"
        ? { ok: true, draftId, revision: 2, changed: true, learnedFactCount: 1, extractionStatus: "succeeded" }
        : { ok: true, draftId, revision: 1 });
    },
    setTimeout(callback, delay) { const id = nextTimer++; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    console
  };
  vm.runInNewContext(script, context);

  fieldHandlers.get("input")();
  field.value = "最后一次修改";
  fieldHandlers.get("input")();
  assert.strictEqual(timers.size, 1, "rapid edits keep one pending save");
  const pending = [...timers.values()][0];
  assert.strictEqual(pending.delay, 600);
  await pending.callback();
  assert.strictEqual(requests.filter((item) => item.body.action === "save").length, 1);
  assert.strictEqual(requests.at(-1).body.text, "最后一次修改");

  await copyHandlers.get("click")();
  assert.deepStrictEqual(order.slice(-2), [["clipboard", "最后一次修改"], ["fetch", "complete"]], "copy must finish before local completion starts");
  assert.match(feedback.textContent, /已记住你这次修改的回答/);

  completeFailure = true;
  await copyHandlers.get("click")();
  assert.deepStrictEqual(order.slice(-2), [["clipboard", "最后一次修改"], ["fetch", "complete"]]);
  assert.match(feedback.textContent, /已复制；这次修改暂未保存，请稍后重试/);

  field.value = "提交前最终文字";
  sentHandlers.get("submit")();
  assert.strictEqual(hiddenText.value, "提交前最终文字", "manual sent submits the latest textarea value without another confirmation");
}

async function getText(base, route) {
  const response = await fetch(base + route);
  return { status: response.status, body: await response.text() };
}

async function getJson(base, route) {
  const response = await fetch(base + route);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function postJson(base, route, body) {
  const response = await fetch(base + route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "manual"
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function postForm(base, route, body) {
  const response = await fetch(base + route, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value)])).toString(),
    redirect: "manual"
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body); }
  };
}

function visibleText(markup) {
  return String(markup).replace(/<input[^>]*type="hidden"[^>]*>/g, "").replace(/<[^>]+>/g, " ");
}
