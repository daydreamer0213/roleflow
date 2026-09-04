const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { CdpBrowserAdapter } = require("../src/adapters/browser/cdp");

main().then(() => console.log("cdp_focus_scope_smoke ok")).catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function main() {
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch (error) {
    if (process.env.ROLEFLOW_REQUIRE_PLAYWRIGHT === "1") throw error;
    console.log("cdp_focus_scope_smoke skipped: Playwright is unavailable");
    return;
  }
  const tempRoot = process.env.TEMP || process.env.TMP || os.tmpdir();
  const profilePath = fs.mkdtempSync(path.join(tempRoot, "roleflow-cdp-focus-"));
  const port = await freeLoopbackPort();
  const context = await chromium.launchPersistentContext(profilePath, {
    channel: "msedge",
    headless: true,
    args: [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${port}`]
  });
  try {
    const targetPage = await context.newPage();
    await targetPage.goto(dataPage("focus-target"));
    const foregroundPage = await context.newPage();
    await foregroundPage.goto(dataPage("focus-foreground"));
    await foregroundPage.bringToFront();

    await waitForCdp(port);
    const adapter = new CdpBrowserAdapter({ port, timeoutMs: 2_000 });
    const target = (await adapter.listTabs()).find((tab) => tab.title === "focus-target");
    assert(target, "target local page must be available through CDP");

    await adapter.cdp(target.id, "Emulation.setFocusEmulationEnabled", { enabled: true });
    await delay(150);
    assert.equal(await adapter.evalValue(target.id, "document.hasFocus()"), true);
    await adapter.clickAt(target.id, { x: 100, y: 35 });
    assert.equal(await targetPage.evaluate(() => window.clicks.length), 1);
    await adapter.cdp(target.id, "Emulation.setFocusEmulationEnabled", { enabled: false });
  } finally {
    await context.close();
    fs.rmSync(profilePath, { recursive: true, force: true });
  }
}

function dataPage(title) {
  return `data:text/html,${encodeURIComponent(`<!doctype html><title>${title}</title><button id="target" style="position:absolute;left:40px;top:10px;width:120px;height:50px">click</button><script>window.clicks=[];document.querySelector('#target').addEventListener('click',()=>window.clicks.push('click'))</script>`)}`;
}

function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForCdp(port) {
  let lastError = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
      lastError = new Error(`CDP endpoint returned ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw lastError || new Error("CDP endpoint did not become available.");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
