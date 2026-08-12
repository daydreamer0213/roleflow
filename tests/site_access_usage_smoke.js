const assert = require("node:assert/strict");
const { isBossDetailAccessAction } = require("../src/core/site_access_usage");

assert.strictEqual(isBossDetailAccessAction("pane_detail_read"), true);
assert.strictEqual(isBossDetailAccessAction("job_detail_fetch"), true);
assert.strictEqual(isBossDetailAccessAction("detail_open"), true);
assert.strictEqual(isBossDetailAccessAction("pane_detail_result"), false);
assert.strictEqual(isBossDetailAccessAction("communication_visit"), false);
assert.strictEqual(isBossDetailAccessAction(""), false);

console.log("site_access_usage_smoke ok");
