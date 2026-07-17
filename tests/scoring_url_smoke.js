const assert = require("node:assert/strict");
const { isBossJobUrl } = require("../src/core/scoring");

assert.strictEqual(isBossJobUrl("https://www.zhipin.com/job_detail/abc123.html"), true);
assert.strictEqual(isBossJobUrl("https://www.zhipin.com/job_detail/abc123.html?ka=search"), true);
assert.strictEqual(isBossJobUrl("http://www.zhipin.com/job_detail/abc123.html"), false);
assert.strictEqual(isBossJobUrl("https://zhipin.com/job_detail/abc123.html"), false);
assert.strictEqual(isBossJobUrl("https://evil.example/job_detail/abc123.html?next=https://www.zhipin.com/job_detail/abc123.html"), false);
assert.strictEqual(isBossJobUrl("https://www.zhipin.com/job_detail/abc123.html/extra"), false);
assert.strictEqual(isBossJobUrl("https://www.zhipin.com/job_detail/.html"), false);

console.log("scoring_url_smoke ok");
