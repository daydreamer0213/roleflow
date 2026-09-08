const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const storage = require("../src/core/storage");
const { createCommunicationBatch } = require("../src/application/communication");
const { listCommunicationBatchItems, setCommunicationBatchStatus } = require("../src/core/communication_batches");
const { savePlatformSearchContext } = require("../src/storage/platform_search_context_store");
const { createDashboardServer } = require("../src/dashboard/server");
const { userFacingError } = require("../src/dashboard/user_facing_errors");
const { communicationErrorLabel } = require("../src/dashboard/status_labels");
const { communicate } = require("../src/cli");

const root = path.resolve(__dirname, "..");
const NOW = "2030-01-02T08:00:00.000Z";
const SEARCH_URL = "https://www.zhaopin.com/jobs/?pageMode=search&jl=548&kw=AI+Agent";
const logger = { info() {}, warn() {}, error() {}, child() { return this; }, requestId() { return "zhaopin-communication-smoke"; }, listRecent() { return []; } };

async function main() {
  assert.match(userFacingError("ZHAOPIN_RISK_CONTROL").title, /智联搜索页/);
  assert.match(userFacingError("ZHAOPIN_MESSAGE_RISK_CONTROL").title, /智联沟通页/);
  assert.match(communicationErrorLabel("ZHAOPIN_MESSAGE_LOGIN_REQUIRED"), /智联沟通登录/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-zhaopin-communication-"));
  const dbPath = path.join(dir, "fixture.sqlite");
  let db = storage.openDb(dbPath);
  let server = null;
  let base = "";
  let releaseChild;
  const childGate = new Promise((resolve) => { releaseChild = resolve; });
  const childRuns = [];
  const spawnCalls = [];
  const adapterFactoryCalls = [];
  try {
    const owner = seedOwner(db, "合成候选人", "合成智联方案");
    const other = seedOwner(db, "其他候选人", "其他智联方案");
    const zlJobId = addJob(db, owner, "ZLMAIN1", "合成智联岗位");
    const linkedJobId = addJob(db, owner, "ZLLINK1", "合成智联历史岗位");
    const bossJobId = addJob(db, owner, "BOSS1", "合成 BOSS 岗位", { source: "boss" });
    const otherJobId = addJob(db, other, "ZLOTHER1", "其他画像智联岗位");

    const workflow = storage.createWorkflowRun(db, {
      site: "zhaopin", profileId: owner.profileId, planId: owner.planId,
      localDay: "2030-01-01", sequence: 1, targetSuccessCount: 1, candidateGap: 1,
      scanNeeded: false, keywords: [{ word: "AI Agent", priority: "A" }],
      planner: { browserMode: "portable", cdpPort: 9222, acquisitionMode: "inherited" }
    });
    storage.transitionWorkflowRun(db, { id: workflow.id, status: "scanning" });
    storage.transitionWorkflowRun(db, { id: workflow.id, status: "analyzing" });
    storage.transitionWorkflowRun(db, { id: workflow.id, status: "review_required" });
    const linked = createCommunicationBatch({
      db,
      input: { site: "zhaopin", workflowRunId: workflow.id, planId: owner.planId, jobIds: [linkedJobId], browserMode: "portable" }
    }).batch;
    setCommunicationBatchStatus(db, { batchId: linked.id, status: "stopped" });

    const fakeBrowser = communicationBrowser(() => base);
    const fakeAdapter = communicationAdapter();
    const spawnProcess = (_exe, args) => {
      spawnCalls.push(args);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      const work = childGate.then(async () => {
        const cliArgs = parseArgs(args);
        try {
          await communicate(db, cliArgs, {
            createBrowserFn: () => fakeBrowser,
            createSiteAdapterFn: (site, context) => {
              adapterFactoryCalls.push({ site, operation: context.operation });
              return fakeAdapter;
            }
          });
          child.emit("close", 0, null);
        } catch (error) {
          child.emit("close", 1, null);
          throw error;
        }
      });
      childRuns.push(work);
      return child;
    };
    const startServer = async () => {
      server = createDashboardServer({
        db, root, dataRoot: dir, dbPath, logger, spawnProcess,
        browserAuthority: { browserMode: "portable", cdpPort: 9222, profilePath: path.join(dir, "edge") },
        forceMock: true, allowOfflineMock: true
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      base = `http://127.0.0.1:${server.address().port}`;
      return base;
    };
    await startServer();

    const builder = await getText(`${base}/communication/new?planId=${owner.planId}&site=zhaopin`);
    assert.match(builder, /合成智联岗位/);
    assert.doesNotMatch(builder, /合成 BOSS 岗位|今日额度|补扫|凑满/);
    assert.match(builder, /name="site" value="zhaopin"/);
    assert.match(builder, /当前可选 2 个岗位/);

    let response = await postJson(`${base}/api/communication-batch`, {
      site: "zhaopin", planId: owner.planId, jobIds: [bossJobId], browserMode: "portable"
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.errorCode, "COMMUNICATION_SOURCE_MISMATCH");
    response = await postJson(`${base}/api/communication-batch`, {
      site: "zhaopin", planId: owner.planId, jobIds: [otherJobId], browserMode: "portable"
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.errorCode, "COMMUNICATION_JOB_INELIGIBLE");

    const created = await postJson(`${base}/api/communication-batch`, {
      site: "zhaopin", planId: owner.planId, jobIds: [zlJobId], browserMode: "portable"
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.batch.site, "zhaopin");
    db.prepare("UPDATE jobs SET title = ?, company = ?, url = ? WHERE id = ?")
      .run("变更后的岗位标题", "变更后的公司", "https://example.test/changed", zlJobId);
    const item = listCommunicationBatchItems(db, created.body.batch.id)[0];
    const start = await postJson(`${base}/api/communication-control`, {
      batchId: created.body.batch.id, itemId: item.id, action: "start_one"
    });
    assert.equal(start.status, 200, JSON.stringify(start.body));
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].includes("--site"), false);

    await getText(`${base}/plan?planId=${owner.planId}&site=boss`);
    releaseChild();
    await Promise.all(childRuns);
    assert.deepEqual(adapterFactoryCalls, [{ site: "zhaopin", operation: "communication" }]);
    const progress = await (await fetch(`${base}/api/communication-status?batchId=${created.body.batch.id}`)).json();
    assert.equal(progress.batch.site, "zhaopin");
    assert.equal(progress.batch.status, "interrupted", JSON.stringify(progress.batch));
    assert.equal(progress.items[0].status, "succeeded");
    assert.equal(progress.items[0].clickCount, 1);

    await new Promise((resolve) => server.close(resolve));
    server = null;
    db.close();
    db = storage.openDb(dbPath);
    await startServer();
    const plan = await getText(`${base}/plan?planId=${owner.planId}&site=zhaopin`);
    const navigationHref = `/communication?planId=${owner.planId}&amp;site=zhaopin`;
    assert.match(plan, new RegExp(navigationHref.replace(/[?]/g, "\\?")));
    const restored = await getText(`${base}/communication?planId=${owner.planId}&site=zhaopin`);
    assert.equal(restored.includes("合成智联岗位"), true);
    assert.doesNotMatch(restored, /变更后的岗位标题|变更后的公司|example\.test/);
    assert.match(restored, new RegExp(`批次 #${linked.id}`));
    assert.equal((restored.match(new RegExp(`批次 #${linked.id}`, "g")) || []).length, 1);
    assert.doesNotMatch(restored, /合成 BOSS 岗位/);
    assert.match(restored, /智联/);
    assert.match(restored, /页面已核对，正在进行单岗位验收/);
    assert.match(restored, /href="https:\/\/www\.zhaopin\.com\/jobdetail\/ZLMAIN1\.htm"/);

    const conflictingSite = await getText(`${base}/communication?batchId=${created.body.batch.id}&site=boss`);
    assert.match(conflictingSite, /batch_site_mismatch/);
    const conflictingOwner = await getText(`${base}/communication?batchId=${created.body.batch.id}&profileId=${other.profileId}`);
    assert.match(conflictingOwner, /batch_profile_mismatch/);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM candidate_funnel_entries").get().count), 0);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM message_reply_send_batches").get().count), 0);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM message_reply_send_items").get().count), 0);
    console.log("dashboard_zhaopin_communication_smoke ok");
  } finally {
    releaseChild?.();
    await Promise.allSettled(childRuns);
    if (server) await new Promise((resolve) => server.close(resolve));
    db?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function seedOwner(db, profileName, planName) {
  const profileId = Number(db.prepare("INSERT INTO candidate_profiles(display_name, profile_json, created_at, updated_at) VALUES (?, '{}', ?, ?)")
    .run(profileName, NOW, NOW).lastInsertRowid);
  const planId = Number(db.prepare("INSERT INTO search_plans(profile_id, name, plan_json, created_at, updated_at) VALUES (?, ?, '{}', ?, ?)")
    .run(profileId, planName, NOW, NOW).lastInsertRowid);
  savePlatformSearchContext(db, {
    planId, site: "zhaopin",
    searchTemplate: { mode: "inherited", url: "https://www.zhaopin.com/jobs/?pageMode=search&jl=548" },
    filterSummary: ["广州"]
  });
  return { profileId, planId };
}

function addJob(db, owner, sourceId, title, { source = "zhaopin" } = {}) {
  const batchId = storage.createBatch(db, source, "AI Agent", "synthetic", {
    profileId: owner.profileId, searchPlanId: owner.planId
  });
  return storage.upsertJob(db, {
    source, sourceId, keyword: "AI Agent", title, company: "合成招聘方", location: "广州", salary: "20-30K",
    url: source === "zhaopin" ? `https://www.zhaopin.com/jobdetail/${sourceId}.htm` : `https://www.zhipin.com/job_detail/${sourceId}.html`,
    description: "完整合成岗位职责、任职要求、交付边界和可核验技术背景。".repeat(8),
    score: 90, level: "优先", decisionBucket: "primary", qualityTags: [],
    analysis: { semanticStatus: "complete", recommendation: "primary", recommendationSchemaVersion: 2, fitLevel: "fit", confidence: 0.9, hardBlockers: [], fitReasons: ["合成匹配证据"], evidence: { jd: ["岗位证据"], resume: ["简历证据"] } }
  }, batchId);
}

function communicationBrowser(baseReader) {
  const methods = { async navigate() {}, async cdp() {}, async evalValue() {}, async clickAt() {}, async startNetworkLog() {}, async getNetworkLogMark() { return 0; }, async readNetworkLog() { return []; }, async stopNetworkLog() {} };
  return {
    ...methods,
    async listTabs() {
      return [
        { id: 10, windowId: 7, active: true, url: `${baseReader()}/plan` },
        { id: 20, windowId: 7, active: false, url: SEARCH_URL }
      ];
    }
  };
}

function communicationAdapter() {
  return {
    async preflight() { return { isSearchPage: true }; },
    async captureCommunicationSearchState() { return { url: SEARCH_URL, scrollTop: 42 }; },
    bindCommunicationTabs() {},
    async beginCommunicationSession() {},
    async restoreCommunicationSearchPage() {},
    async inspectCommunicationJob() { return { state: "ready" }; },
    async prepareCommunicationDispatch() { return { async cancel() {} }; },
    async dispatchCommunication() {},
    async verifyCommunicationResult() { return { state: "succeeded", evidence: { endpoints: [], pageState: "succeeded" } }; }
  };
}

function parseArgs(args) {
  const parsed = {};
  for (let index = args.indexOf("communicate") + 1; index < args.length; index += 1) {
    if (!String(args[index]).startsWith("--")) continue;
    const key = args[index].slice(2);
    parsed[key] = !args[index + 1] || String(args[index + 1]).startsWith("--") ? true : args[++index];
  }
  return parsed;
}

async function getText(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200, await response.clone().text());
  return response.text();
}

async function postJson(url, body) {
  const response = await fetch(url, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
