const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { openDb } = require("../src/core/storage");
const { createDashboardServer } = require("../src/dashboard/server");
const response = require("../src/dashboard/http/response");
const { renderPage } = require("../src/dashboard/ui/shell");
const { renderNavigation } = require("../src/dashboard/ui/navigation");

const root = path.join(__dirname, "..");
const smokeDir = path.join(root, ".runtime", "smoke");
const dbPath = path.join(smokeDir, `dashboard-shell-${Date.now()}.sqlite`);
const logger = { info() {}, warn() {}, error() {}, requestId() { return "dashboard-shell-smoke"; }, listRecent() { return []; } };

(async () => {
  assert.strictEqual(typeof response.escapeHtml, "function", "the response utility must expose HTML escaping");
  assert.strictEqual(typeof response.escapeAttr, "function", "the response utility must expose attribute escaping");
  assert.strictEqual(response.escapeHtml(`<&>\"'`), "&lt;&amp;&gt;&quot;&#39;");
  assert.strictEqual(response.escapeAttr(`<&>\"'`), "&lt;&amp;&gt;&quot;&#39;");

  assert.strictEqual(typeof renderNavigation, "function", "the navigation renderer must be available");
  const navigation = renderNavigation({ currentPath: "/plan?planId=17", planId: 17 });
  assert.match(navigation, /href="\/queue\?planId=17"/);
  assert.match(navigation, /href="\/plan\?planId=17" aria-current="page"/);

  assert.strictEqual(typeof renderPage, "function", "the page shell renderer must be available");
  const page = renderPage({ title: `<title>`, body: "<main>body</main>", scripts: ["<script>window.roleflowShellTest=true</script>"] });
  assert.match(page, /<title>&lt;title&gt;<\/title>/);
  assert.match(page, /<link rel="stylesheet" href="\/assets\/roleflow\.css">/);
  assert.match(page, /<script>window\.roleflowShellTest=true<\/script>/);

  fs.mkdirSync(smokeDir, { recursive: true });
  const db = openDb(dbPath);
  const server = createDashboardServer({ db, root, dbPath, forceMock: true, logger });
  const baseUrl = await listen(server);
  try {
    const stylesheet = await getText(baseUrl, "/assets/roleflow.css");
    assert.strictEqual(stylesheet.status, 200, "the fixed dashboard stylesheet must be served");
    assert.match(stylesheet.contentType, /^text\/css(?:;|$)/);
    assert.match(stylesheet.body, /:root/);

    const unknownAsset = await getText(baseUrl, "/assets/%2e%2e%2fpackage.json");
    assert.strictEqual(unknownAsset.status, 404, "unknown asset paths must not reach the filesystem");
    assert.strictEqual(unknownAsset.body, "Not found");
    assert.doesNotMatch(unknownAsset.body, /roleflow/);

    const health = await getJson(baseUrl, "/health");
    assert.strictEqual(health.status, 200, "existing JSON API responses must remain available");
    assert.match(health.contentType, /^application\/json(?:;|$)/);
    assert.strictEqual(health.body.ok, true);

    for (const pathname of ["/onboarding", "/settings", "/plan", "/workflow", "/queue", "/communication/new"]) {
      const page = await getText(baseUrl, pathname);
      assert.strictEqual(page.status, 200, `${pathname} must keep its HTML response`);
      assert.match(page.contentType, /^text\/html(?:;|$)/);
      assert.match(page.body, /<link rel="stylesheet" href="\/assets\/roleflow\.css">/);
    }
  } finally {
    await close(server);
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
  console.log("dashboard_shell_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function getText(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  return { status: response.status, contentType: response.headers.get("content-type") || "", body: await response.text() };
}

async function getJson(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  return { status: response.status, contentType: response.headers.get("content-type") || "", body: await response.json() };
}
