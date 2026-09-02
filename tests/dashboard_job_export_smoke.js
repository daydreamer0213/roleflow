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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roleflow-dashboard-export-"));
  const dbPath = path.join(root, "export.sqlite");
  const db = openDb(dbPath);
  let server;
  try {
    const own = seedScope(db, "own", [
      { sourceId: "export-primary", title: "=HYPERLINK(\"bad\")", recommendation: "primary" },
      { sourceId: "export-apply", title: "普通可投岗位", recommendation: "apply" }
    ]);
    const foreign = seedScope(db, "foreign", [
      { sourceId: "export-foreign", title: "其他候选人的岗位", recommendation: "primary" }
    ]);
    server = createDashboardServer({
      db,
      root,
      dataRoot: root,
      dbPath,
      forceMock: true,
      browserAuthority: { browserMode: "portable", cdpPort: 9222, profilePath: path.join(root, "profile") },
      logger: quietLogger()
    });
    await listen(server);
    const base = `http://127.0.0.1:${server.address().port}`;

    const page = await fetch(`${base}/jobs?planId=${own.planId}&batch=all&outcome=all`).then((response) => response.text());
    assert.match(page, /导出当前结果/);
    assert.match(page, /导出已选岗位/);
    assert.match(page, /name="jobIds"/);

    let response = await fetch(`${base}/jobs/export.csv?profileId=${own.profileId}&planId=${own.planId}&batch=all&outcome=all&archive=active&decision=primary`);
    let body = await response.text();
    assert.equal(response.status, 200, body);
    assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
    assert.match(response.headers.get("content-disposition"), /attachment/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(csvIds(body), [own.jobIds[0]]);
    assert.match(body, /"'=HYPERLINK\(""bad""\)"/);

    response = await postSelected(base, { profileId: own.profileId, planId: own.planId, jobIds: own.jobIds });
    body = await response.text();
    assert.equal(response.status, 200, body);
    assert.deepEqual(csvIds(body).sort((a, b) => a - b), [...own.jobIds].sort((a, b) => a - b));

    await assertRejected(base, { profileId: own.profileId, planId: own.planId, jobIds: [999999] });
    await assertRejected(base, { profileId: own.profileId, planId: own.planId, jobIds: [foreign.jobIds[0]] });
    await assertRejected(base, { profileId: own.profileId, planId: own.planId, jobIds: [own.jobIds[0], own.jobIds[0]] });
    await assertRejected(base, { profileId: own.profileId, planId: own.planId, jobIds: Array.from({ length: 501 }, (_, index) => index + 1) });

    response = await fetch(`${base}/jobs/export.csv?profileId=${foreign.profileId}&planId=${own.planId}&batch=all&outcome=all`);
    assert.notEqual(response.status, 200);

    console.log("dashboard_job_export_smoke ok");
  } finally {
    if (server) await close(server);
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function seedScope(db, suffix, definitions) {
  const profileId = Number(db.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, created_at, updated_at
  ) VALUES (?, '{}', ?, ?)`)
    .run(`Export ${suffix}`, NOW, NOW).lastInsertRowid);
  const planId = Number(db.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, is_active, created_at, updated_at
  ) VALUES (?, ?, '{}', 1, ?, ?)`)
    .run(profileId, `Plan ${suffix}`, NOW, NOW).lastInsertRowid);
  const batchId = createBatch(db, "boss", suffix, "export fixture", {
    profileId,
    searchPlanId: planId,
    startedAt: NOW,
    filterSnapshot: { execution: {} }
  });
  const jobIds = definitions.map((definition) => upsertJob(db, {
    source: "boss",
    sourceId: `boss:${definition.sourceId}`,
    keyword: suffix,
    title: definition.title,
    company: `示例公司 ${suffix}`,
    location: "广州",
    salary: "15-25K",
    experience: "1-3年",
    education: "本科",
    url: `https://example.test/${definition.sourceId}`,
    description: "负责内容运营、增长实验和复盘。".repeat(10),
    analysis: {
      semanticStatus: "complete",
      recommendation: definition.recommendation,
      recommendationSchemaVersion: 2,
      businessScenario: "内容增长",
      fitReasons: ["经历匹配"]
    }
  }, batchId));
  return { profileId, planId, jobIds };
}

async function postSelected(base, { profileId, planId, jobIds }) {
  const params = new URLSearchParams({ profileId: String(profileId), planId: String(planId) });
  for (const jobId of jobIds) params.append("jobIds", String(jobId));
  return fetch(`${base}/api/jobs/export`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params,
    redirect: "manual"
  });
}

async function assertRejected(base, values) {
  const response = await postSelected(base, values);
  const body = await response.text();
  assert(response.status >= 400 && response.status < 500, body);
  assert.doesNotMatch(response.headers.get("content-type") || "", /^text\/csv/);
}

function csvIds(csv) {
  return csv.replace(/^\ufeff/, "").trimEnd().split("\r\n").slice(1)
    .map((line) => Number(/^"(\d+)"/.exec(line)?.[1]))
    .filter(Number.isFinite);
}

function listen(server) { return new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); }
function close(server) { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
function quietLogger() { return { info() {}, warn() {}, error() {}, requestId() { return "export-smoke"; }, listRecent() { return []; } }; }
