const assert = require("node:assert/strict");
const { openDb } = require("../src/core/storage");
const { createDashboardServer } = require("../src/dashboard/server");

(async () => {
  const db = openDb(":memory:");
  const server = createDashboardServer({
    db,
    forceMock: true,
    logger: { info() {}, warn() {}, error() {}, requestId() { return "dashboard-asset-failure-smoke"; }, listRecent() { return []; } },
    assetReader() {
      const error = new Error("fixture asset read denied");
      error.code = "EACCES";
      throw error;
    }
  });
  await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/assets/roleflow.css`);
    const body = await response.text();
    assert.strictEqual(response.status, 500, "an unreadable allowlisted asset must return a complete 500 response");
    assert.match(response.headers.get("content-type") || "", /^text\/html(?:;|$)/);
    assert.match(body, /服务处理失败/);
  } finally {
    await close(server);
    db.close();
  }
  console.log("dashboard_asset_failure_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}
