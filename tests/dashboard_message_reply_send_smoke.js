const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const {
  openDb,
  recordMessageReplyDrafts,
  saveMessageInboundContext,
  createMessageReplySendBatch,
  acquireSiteScanLease,
  releaseSiteScanLease
} = require("../src/core/storage");
const {
  loadReplySendBatch,
  transitionReplySendBatch,
  transitionReplySendItem
} = require("../src/core/message_reply_send_batches");
const { createDashboardServer } = require("../src/dashboard/server");
const { createMessageReplySendController } = require("../src/dashboard/message_reply_send_controller");

const TOKEN = "message-reply-action-fixture";
const NOW = "2026-08-29T06:00:00.000Z";

(async () => {
  await historicalBatchDoesNotAutoResumeSmoke();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-dashboard-reply-send-"));
  const db = openDb(path.join(root, "dashboard.sqlite"));
  let server = null;
  try {
    const fixture = seedDrafts(db, 2);
    let startedResolve;
    const started = new Promise((resolve) => { startedResolve = resolve; });
    const browsers = [];
    server = createDashboardServer({
      db,
      root,
      dataRoot: root,
      dbPath: path.join(root, "dashboard.sqlite"),
      browserAuthority: { browserMode: "portable", cdpPort: 9222, profilePath: path.join(root, "profile") },
      forceMock: true,
      messageReplyActionToken: TOKEN,
      logger: quietLogger(),
      browserFactory() {
        const browser = { disconnected: false, async disconnect() { this.disconnected = true; } };
        browsers.push(browser);
        return browser;
      },
      messageReplySendDependencies: {
        createReader: () => ({}),
        createSender: () => ({}),
        createAccessController: () => ({ async reserve() { return {}; } }),
        async runBatch({ db: runtimeDb, batchId, signal }) {
          const profileId = Number(runtimeDb.prepare("SELECT profile_id FROM message_reply_send_batches WHERE id = ?")
            .get(batchId).profile_id);
          transitionReplySendBatch(runtimeDb, {
            profileId, batchId, expectedStatus: "confirmed", status: "running"
          });
          startedResolve();
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
          return loadReplySendBatch(runtimeDb, { profileId, batchId });
        }
      }
    });
    await listen(server);
    const base = `http://127.0.0.1:${server.address().port}`;

    const page = await request(base, `/messages?profileId=${fixture.profileId}`);
    assert.equal(page.status, 200);
    assert.match(page.body, /BOSS 消息发现与回复/);
    assert.match(page.body, /class="[^"]*message-workspace/);
    assert.match(page.body, /class="[^"]*message-list/);
    assert.match(page.body, /class="[^"]*message-detail/);
    assert.match(page.body, /data-send-single="\d+"/);
    assert.equal((page.body.match(/data-send-select="\d+" checked/g) || []).length, 2);
    assert.match(page.body, /<button type="button" data-send-batch>确认并串行发送 2 条<\/button>/);
    assert.match(page.body, /data-send-stop hidden disabled/);
    assert.match(page.body, /已读 0 · 送达 0/);
    assert(page.body.includes(TOKEN), "the local action token must be scoped to the rendered message page");

    let response = await postJson(base, "/api/message-reply-send-batch", {
      profileId: fixture.profileId,
      items: fixture.drafts.map((draft) => ({ draftId: draft.id, revision: draft.revision }))
    });
    assert.equal(response.status, 403);

    response = await postJson(base, "/api/message-reply-send-batch", {
      profileId: fixture.profileId,
      items: [{
        draftId: fixture.drafts[0].id,
        revision: fixture.drafts[0].revision,
        replyText: "client-controlled text"
      }]
    }, TOKEN);
    assert.equal(response.status, 400);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM message_reply_send_batches").get().n, 0);

    response = await postJson(base, "/api/message-reply-send-batch", {
      profileId: fixture.profileId,
      items: fixture.drafts.map((draft) => ({ draftId: draft.id, revision: draft.revision }))
    }, TOKEN);
    assert.equal(response.status, 202);
    assert.equal(response.body.batch.status, "confirmed");
    assert(!JSON.stringify(response.body).includes("确认回复"));
    assert(!JSON.stringify(response.body).includes("HR 原文"));
    const batchId = response.body.batch.id;
    await started;

    response = await getJson(base, `/api/message-reply-send-status?profileId=${fixture.profileId}&batchId=${batchId}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.batch.status, "running");
    assert(!JSON.stringify(response.body).includes("确认回复"));
    assert(!JSON.stringify(response.body).includes("executor-job"));
    const refreshedPage = await request(base, `/messages?profileId=${fixture.profileId}`);
    assert.match(refreshedPage.body, new RegExp(`"initialReplySend":\\{"batch":\\{"id":${batchId},`),
      "a refreshed message page must recover the active local batch status");
    assert.match(refreshedPage.body, /"status":"running"/);

    const second = await postJson(base, "/api/message-reply-send-batch", {
      profileId: fixture.profileId,
      items: [{ draftId: fixture.drafts[0].id, revision: fixture.drafts[0].revision }]
    }, TOKEN);
    assert.equal(second.status, 409);
    assert.equal(second.body.errorCode, "MESSAGE_REPLY_SEND_PROFILE_BUSY");

    response = await postJson(base, "/api/message-reply-send-control", {
      profileId: fixture.profileId,
      batchId,
      action: "stop"
    }, TOKEN);
    assert.equal(response.status, 200);
    assert.equal(response.body.batch.status, "stopped");
    assert(response.body.items.every((item) => item.status === "stopped"));

    await eventually(() => browsers.length === 1 && browsers[0].disconnected === true);
    acquireSiteScanLease(db, { site: "boss", owner: "external-task", command: "scan", planId: fixture.planId });
    response = await postJson(base, "/api/message-reply-send-batch", {
      profileId: fixture.profileId,
      items: [{ draftId: fixture.drafts[0].id, revision: fixture.drafts[0].revision }]
    }, TOKEN);
    assert.equal(response.status, 409);
    assert.equal(response.body.errorCode, "MESSAGE_REPLY_SEND_LEASE_BUSY");
    releaseSiteScanLease(db, { site: "boss", owner: "external-task" });
    await clientSavesBeforeConfirmSmoke(page.body, fixture.drafts);
  } finally {
    if (server) await close(server);
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log("dashboard_message_reply_send_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function historicalBatchDoesNotAutoResumeSmoke() {
  const db = openDb(":memory:");
  try {
    const fixture = seedDrafts(db, 1);
    const created = createMessageReplySendBatch(db, {
      profileId: fixture.profileId,
      items: [{ draftId: fixture.drafts[0].id, revision: fixture.drafts[0].revision }],
      createdAt: NOW
    });
    transitionReplySendBatch(db, {
      profileId: fixture.profileId,
      batchId: created.batch.id,
      expectedStatus: "confirmed",
      status: "running"
    });
    let item = transitionReplySendItem(db, {
      profileId: fixture.profileId, batchId: created.batch.id, itemId: created.items[0].id,
      expectedStatus: "pending", status: "selecting"
    });
    for (const status of ["verified", "filled", "click_dispatched"]) {
      item = transitionReplySendItem(db, {
        profileId: fixture.profileId, batchId: created.batch.id, itemId: item.id,
        expectedStatus: item.status, status, clickCount: status === "click_dispatched" ? 1 : 0
      });
    }
    const pendingFixture = seedDrafts(db, 1, "pending-reply");
    const pending = createMessageReplySendBatch(db, {
      profileId: pendingFixture.profileId,
      items: [{ draftId: pendingFixture.drafts[0].id, revision: pendingFixture.drafts[0].revision }],
      createdAt: NOW
    });
    let browserCreations = 0;
    const controller = createMessageReplySendController({
      db,
      browserFactory() { browserCreations += 1; return {}; },
      learningService: { async completeDraft() {} }
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(browserCreations, 0, "historical click-dispatched batches must never auto-resume");
    const clickedState = controller.status({ profileId: fixture.profileId, batchId: created.batch.id });
    assert.equal(clickedState.batch.status, "interrupted");
    assert.equal(clickedState.items[0].status, "ambiguous",
      "a historical durable click must require manual review without replay");
    const pendingState = controller.status({ profileId: pendingFixture.profileId, batchId: pending.batch.id });
    assert.equal(pendingState.batch.status, "interrupted");
    assert.equal(pendingState.items[0].status, "stopped",
      "a historical pre-click item must be stopped without opening a browser");
    assert.equal(controller.latest({ profileId: fixture.profileId }).batch.id, created.batch.id);
    await controller.close();
  } finally {
    db.close();
  }
}

async function clientSavesBeforeConfirmSmoke(html, drafts) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const source = scripts.find((value) => value.includes("messageReplyActionToken") && value.includes("data-send-batch"));
  assert(source, "message reply client script must be present");
  const calls = [];
  const controls = [];
  const fields = drafts.map((draft, index) => element({
    value: `用户修改后的回复 ${index + 1}`,
    dataset: { draftId: String(draft.id), revision: String(draft.revision), draftRevision: String(draft.revision) }
  }));
  const choices = drafts.map((draft) => element({
    checked: true,
    dataset: { sendSelect: String(draft.id) }
  }));
  const singleButtons = drafts.map((draft) => element({ dataset: { sendSingle: String(draft.id) } }));
  const statuses = drafts.map((draft) => element({ dataset: { sendStatus: String(draft.id) } }));
  const draftSaveStatuses = drafts.map((draft) => element({ dataset: { draftSaveStatus: String(draft.id) } }));
  const batchButton = element();
  const stopButton = element({ hidden: true, disabled: true });
  const batchPanel = element({ dataset: { state: "idle" } });
  const batchTitle = element();
  const batchStatus = element();
  const feedback = element();
  const cards = fields.map((field) => {
    const index = fields.indexOf(field);
    return {
      querySelector(selector) { return selector === "[data-draft-save-status]" ? draftSaveStatuses[index] : null; },
      querySelectorAll() { return [field, choices[index], singleButtons[index]]; }
    };
  });
  fields.forEach((field, index) => { field.closest = () => cards[index]; });
  controls.push(...fields, ...choices, ...singleButtons, ...statuses, ...draftSaveStatuses, batchButton, stopButton);
  const document = {
    querySelector(selector) {
      if (selector === "[data-discovery-feedback]") return feedback;
      if (selector === "[data-send-batch-panel]") return batchPanel;
      if (selector === "[data-send-batch]") return batchButton;
      if (selector === "[data-send-stop]") return stopButton;
      if (selector === "[data-send-batch-title]") return batchTitle;
      if (selector === "[data-send-batch-status]") return batchStatus;
      let match = selector.match(/data-draft-id="(\d+)"/);
      if (match) return fields.find((field) => field.dataset.draftId === match[1]) || null;
      match = selector.match(/data-send-status="(\d+)"/);
      if (match) return statuses.find((node) => node.dataset.sendStatus === match[1]) || null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "[data-discovery-form]" || selector === "[data-sent-draft]" || selector === "[data-flush-drafts]" || selector === "[data-copy-draft]") return [];
      if (selector === "[data-draft-text]") return fields;
      if (selector === "[data-send-select]") return choices;
      if (selector === "[data-send-single]") return singleButtons;
      return [];
    },
    getElementById() { return null; }
  };
  let revision = 10;
  const fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : {};
    if (url === "/api/message-reply-draft") {
      calls.push(["save", body.draftId, body.text]);
      return jsonResponse(200, { ok: true, draftId: body.draftId, revision: revision++ });
    }
    if (url === "/api/message-reply-send-batch") {
      calls.push(["confirm", body.items]);
      assert.equal(calls.filter(([name]) => name === "save").length, 2);
      assert.deepStrictEqual(body.items.map((item) => item.revision), [10, 11]);
      assert.equal(options.headers["x-roleflow-action"], TOKEN);
      return jsonResponse(202, {
        batch: { id: 88, status: "confirmed" },
        items: body.items.map((item, index) => ({
          id: index + 1, draftId: item.draftId, status: "pending"
        }))
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const timers = [];
  vm.runInNewContext(source, {
    document,
    fetch,
    navigator: { clipboard: { async writeText() {} } },
    location: { reload() {}, href: "" },
    URLSearchParams,
    FormData: class {},
    setTimeout(callback) { timers.push(callback); return timers.length; },
    clearTimeout() {},
    console
  });
  await batchButton.listeners.click();
  await eventually(() => calls.some(([name]) => name === "confirm"));
  assert.deepStrictEqual(calls.map(([name]) => name), ["save", "save", "confirm"]);
  assert(fields.every((field) => field.disabled), "confirmed editors must be disabled");
}

function seedDrafts(db, count, prefix = "dashboard-reply") {
  const profileId = Number(db.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES ('Dashboard reply fixture', '{}', NULL, ?, ?)`).run(NOW, NOW).lastInsertRowid);
  const planId = Number(db.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, 'Dashboard reply plan', '{}', NULL, 1, ?, ?)`).run(profileId, NOW, NOW).lastInsertRowid);
  const drafts = [];
  for (let index = 0; index < count; index += 1) {
    const suffix = index + 1;
    const jobId = Number(db.prepare(`INSERT INTO jobs(
      source, source_id, title, company, salary, first_seen_at, last_seen_at
    ) VALUES ('boss', ?, ?, '示例公司', '15-20K', ?, ?)`).run(
      `boss:${prefix}-${suffix}`, `内容运营 ${suffix}`, NOW, NOW
    ).lastInsertRowid);
    const cardId = Number(db.prepare(`INSERT INTO candidate_progress_cards(
      profile_id, plan_id, job_id, source, stage, next_action, last_event_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'boss', 'reply_ready', 'Review reply', ?, ?, ?)`)
      .run(profileId, planId, jobId, NOW, NOW, NOW).lastInsertRowid);
    const groupKey = digest(`${prefix}-group-${suffix}`);
    const draft = recordMessageReplyDrafts(db, {
      profileId, cardId, jobId, messageGroupKey: groupKey,
      questionSummary: `问题 ${suffix}`,
      messageIntent: "information_request",
      messageCategory: "other",
      messages: [`确认回复 ${suffix}`],
      createdAt: NOW
    })[0];
    saveMessageInboundContext(db, {
      profileId, cardId, messageGroupKey: groupKey,
      conversationKey: digest(`${prefix}-conversation-${suffix}`),
      sourceJobId: `boss:${prefix}-${suffix}`,
      lastMessageId: `3789170377487${String(40 + suffix).padStart(2, "0")}`,
      messageIntent: "information_request",
      messageCategory: "other",
      inboundMessages: [{ kind: "text", text: `HR 原文 ${suffix}` }],
      manualActions: [], createdAt: NOW, updatedAt: NOW
    });
    drafts.push(draft);
  }
  return { profileId, planId, drafts };
}

function element(overrides = {}) {
  const listeners = {};
  return {
    dataset: {}, disabled: false, hidden: false, checked: false, value: "", textContent: "",
    listeners,
    addEventListener(name, listener) { listeners[name] = listener; },
    querySelectorAll() { return []; },
    setAttribute() {},
    closest() { return null; },
    ...overrides
  };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(body); } };
}

async function postJson(base, pathname, body, token = "") {
  const response = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { "x-roleflow-action": token } : {}) },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function getJson(base, pathname) {
  const response = await fetch(`${base}${pathname}`);
  return { status: response.status, body: await response.json() };
}

async function request(base, pathname) {
  const response = await fetch(`${base}${pathname}`);
  return { status: response.status, body: await response.text() };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function eventually(predicate, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not reached");
}

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value)).digest("hex")}`;
}

function quietLogger() {
  return { info() {}, warn() {}, error() {}, requestId() { return "reply-send-smoke"; }, listRecent() { return []; } };
}
