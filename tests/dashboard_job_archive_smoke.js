"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDb, createBatch, upsertJob } = require("../src/core/storage");
const { createDashboardServer } = require("../src/dashboard/server");

const NOW = "2026-09-03T08:00:00.000Z";

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-dashboard-archive-"));
  const db = openDb(path.join(root, "archive.sqlite"));
  let server;
  try {
    const fixture = seed(db);
    server = createDashboardServer({
      db,
      root,
      dataRoot: root,
      dbPath: path.join(root, "archive.sqlite"),
      forceMock: true,
      browserAuthority: { browserMode: "portable", cdpPort: 9222, profilePath: path.join(root, "profile") },
      logger: quietLogger()
    });
    await listen(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    const activeUrl = `/jobs?planId=${fixture.planId}&batch=all&outcome=all`;
    let page = await request(base, activeUrl);
    assert.match(page.body, /归档测试岗位/);
    assert.match(page.body, /name="action" value="archive"/);

    let response = await postForm(base, "/api/job-archive", fixture, activeUrl);
    assert.equal(response.status, 303);
    page = await request(base, activeUrl);
    assert.doesNotMatch(page.body, /归档测试岗位/);
    page = await request(base, `${activeUrl}&archive=only`);
    assert.match(page.body, /归档测试岗位/);
    assert.match(page.body, /name="action" value="restore"/);

    response = await postForm(base, "/api/job-archive", { ...fixture, action: "restore" }, `${activeUrl}&archive=only`);
    assert.equal(response.status, 303);
    page = await request(base, activeUrl);
    assert.match(page.body, /归档测试岗位/);

    const batchId = Number(db.prepare(`INSERT INTO communication_batches(
      site, profile_id, plan_id, browser_mode, status, policy_json,
      confirmed_at, created_at, updated_at
    ) VALUES ('boss', ?, ?, 'portable', 'confirmed', '{}', ?, ?, ?)`)
      .run(fixture.profileId, fixture.planId, NOW, NOW, NOW).lastInsertRowid);
    db.prepare(`INSERT INTO communication_batch_items(
      batch_id, job_id, position, job_url, title_snapshot, company_snapshot, status, updated_at
    ) VALUES (?, ?, 1, 'https://example.test/archive', '归档测试岗位', '示例公司', 'pending', ?)`)
      .run(batchId, fixture.jobId, NOW);
    response = await postForm(base, "/api/job-archive", fixture, activeUrl);
    assert.equal(response.status, 409);
    assert.match(response.body, /完成或停止后才能归档/);

    console.log("dashboard_job_archive_smoke ok");
  } finally {
    if (server) await close(server);
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function seed(db) {
  const profileId = Number(db.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, created_at, updated_at
  ) VALUES ('Archive dashboard', '{}', ?, ?)`)
    .run(NOW, NOW).lastInsertRowid);
  const planId = Number(db.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, is_active, created_at, updated_at
  ) VALUES (?, 'Archive plan', '{}', 1, ?, ?)`)
    .run(profileId, NOW, NOW).lastInsertRowid);
  const scanBatch = createBatch(db, "boss", "archive", "archive page", {
    profileId, searchPlanId: planId, startedAt: NOW, filterSnapshot: { execution: {} }
  });
  const jobId = upsertJob(db, {
    source: "boss", sourceId: "boss:archive-dashboard", keyword: "archive",
    title: "归档测试岗位", company: "示例公司", location: "广州", url: "https://example.test/archive",
    description: "负责内容运营、增长实验和复盘。".repeat(10),
    analysis: { semanticStatus: "complete", recommendation: "primary", recommendationSchemaVersion: 2 }
  }, scanBatch);
  return { profileId, planId, jobId, action: "archive" };
}

async function postForm(base, pathname, values, referer) {
  const response = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", referer: `${base}${referer}` },
    body: new URLSearchParams(values),
    redirect: "manual"
  });
  return { status: response.status, body: await response.text() };
}

async function request(base, pathname) {
  const response = await fetch(`${base}${pathname}`);
  return { status: response.status, body: await response.text() };
}

function listen(server) { return new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); }
function close(server) { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
function quietLogger() { return { info() {}, warn() {}, error() {}, requestId() { return "archive-smoke"; }, listRecent() { return []; } }; }
