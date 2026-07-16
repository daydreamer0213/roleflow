const assert = require("assert");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { openDb, listReportJobs, getLatestBatchId } = require("../src/core/storage");
const { PRODUCT_POLICY_VERSION } = require("../src/core/product_policy");

const root = path.resolve(__dirname, "..");
const smokeDir = path.join(root, ".runtime", "smoke");
const dbPath = path.join(smokeDir, `flow-${Date.now()}.sqlite`);
let dashboard = null;
let success = false;
const generatedReports = [];
const dbHandles = [];

(async () => {
  fs.mkdirSync(smokeDir, { recursive: true });

  const scan = spawnSync(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    "src/cli.js",
    "scan",
    "--db",
    dbPath,
    "--input",
    path.join("data", "sample_jobs.json"),
    "--profile",
    path.join("profiles", "example_profile.json"),
    "--resume-versions",
    path.join("profiles", "example_resume_versions.json")
  ], { cwd: root, encoding: "utf8" });
  assert.strictEqual(scan.status, 0, scan.stderr || scan.stdout);
  collectGeneratedReports(scan.stdout);

  const db = trackDb(openDb(dbPath));
  const latestBatchId = getLatestBatchId(db);
  assert(latestBatchId, "scan did not create a batch");
  const batchSnapshot = JSON.parse(db.prepare("SELECT filter_snapshot_json FROM batches WHERE id = ?").get(latestBatchId).filter_snapshot_json);
  assert.match(batchSnapshot.runtimePolicyHash, /^[a-f0-9]{64}$/);
  assert.strictEqual(batchSnapshot.runtimePolicy.version, PRODUCT_POLICY_VERSION);
  const jobs = listReportJobs(db, { batch: "latest" });
  assert(jobs.length > 0, "scan did not import jobs");
  const firstJob = jobs[0];

  const port = await getFreePort();
  dashboard = spawn(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    "src/cli.js",
    "dashboard",
    "--db",
    dbPath,
    "--port",
    String(port)
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(`${baseUrl}/health`);

  const page = await fetch(`${baseUrl}/jobs?status=pending&batch=latest`);
  const html = await page.text();
  assert.strictEqual(page.status, 200);
  assert(html.includes("投递操作台"));
  assert(html.includes(firstJob.title));
  assert(html.includes(`#${latestBatchId}`), "dashboard did not identify the active batch");

  const note = `flow-smoke-${Date.now()}`;
  const post = await fetch(`${baseUrl}/api/mark?status=pending&batch=latest`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ jobId: String(firstJob.id), status: "skipped", note }),
    redirect: "manual"
  });
  assert.strictEqual(post.status, 303);

  const followNote = `HR回复-${Date.now()}`;
  const follow = await fetch(`${baseUrl}/api/follow-up?status=all&batch=latest`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", referer: `${baseUrl}/jobs?status=all&batch=latest` },
    body: new URLSearchParams({ jobId: String(firstJob.id), note: followNote }),
    redirect: "manual"
  });
  assert.strictEqual(follow.status, 303);

  const updatedPage = await fetch(`${baseUrl}/jobs?status=all&batch=latest`);
  const updatedHtml = await updatedPage.text();
  assert(updatedHtml.includes(note), "dashboard page did not show updated note");
  assert(updatedHtml.includes(followNote), "dashboard page did not show follow-up note");

  const verifyDb = trackDb(openDb(dbPath));
  const updatedJob = listReportJobs(verifyDb, { batch: "latest" }).find((job) => job.id === firstJob.id);
  assert.strictEqual(updatedJob.applicationStatus, "skipped");
  assert.strictEqual(updatedJob.applicationNote, note);
  assert.strictEqual(updatedJob.followUpNote, followNote);

  success = true;
  console.log("flow_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(async () => {
  if (dashboard) await stopChild(dashboard);
  for (const db of dbHandles) db.close();
  cleanup();
});

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  await new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
    child.once("close", finish);
    child.kill();
    timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      setTimeout(finish, 500);
    }, 2000);
  });
}

function collectGeneratedReports(stdout) {
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const match = line.match(/^(Markdown|HTML):\s*(.+)$/);
    if (match) generatedReports.push(match[2].trim());
  }
}

function cleanup() {
  for (const report of generatedReports) safeRm(report);
  for (const suffix of ["", "-shm", "-wal"]) safeRm(`${dbPath}${suffix}`);
}

function safeRm(target) {
  try {
    fs.rmSync(target, { force: true });
  } catch {
    // ponytail: temp files can remain if Windows releases SQLite handles late.
  }
}

function trackDb(db) {
  dbHandles.push(db);
  return db;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url) {
  const deadline = Date.now() + 5000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error("dashboard health check timed out");
}
