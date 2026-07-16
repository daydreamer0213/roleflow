const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { parseBossActivityText } = require("../src/core/activity_status");
const boss = require("../src/adapters/sites/boss");

const cases = [
  ["HR 今日活跃，欢迎沟通", "今日活跃"],
  ["HR 今天活跃", "今日活跃"],
  ["HR 昨日活跃", "昨日活跃"],
  ["HR 昨天活跃", "昨天活跃"],
  ["符先生 2周内活跃", "2周内活跃"],
  ["符先生 本周活跃", "本周活跃"],
  ["张先生 2 月内活跃", "2月内活跃"],
  ["张先生 本月活跃", "本月活跃"],
  ["梁子其 近半年活跃", "近半年活跃"],
  ["负责在线客服系统集成", ""],
  ["在线客服", ""]
];

for (const [input, expected] of cases) {
  assert.strictEqual(parseBossActivityText(input), expected, input);
}

assert.strictEqual(boss.parseBossActivityText, parseBossActivityText);

const storageSource = fs.readFileSync(path.join(__dirname, "..", "src", "core", "storage.js"), "utf8");
assert.doesNotMatch(storageSource, /adapters[\\/]sites[\\/]boss/);

console.log("activity_status_smoke ok");
