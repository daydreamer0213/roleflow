"use strict";

const assert = require("node:assert/strict");
const { encodeJobExportCsv, jobExportFileName } = require("../src/core/job_export");

const csv = encodeJobExportCsv([{
  id: 7,
  title: "=HYPERLINK(\"bad\")",
  company: "甲,乙公司",
  location: "广州",
  salary: "15-25K",
  experience: "1-3年",
  education: "本科",
  url: "https://example.test/job/7",
  firstSeenAt: "2026-09-01T08:00:00.000Z",
  lastSeenAt: "2026-09-03T08:00:00.000Z",
  archived: true,
  decisionBucket: "primary",
  analysis: {
    businessScenario: "第一行\n第二行",
    fitReasons: ["匹配 Python", "有 RAG 项目"],
    questionsToVerify: ["是否双休"]
  },
  applicationStatus: "applied",
  applicationUpdatedAt: "2026-09-03T07:00:00.000Z",
  messageStatus: "read",
  messageStatusAt: "2026-09-03T08:00:00.000Z"
}]);

assert.equal(csv.charCodeAt(0), 0xfeff);
assert.match(csv, /"'=HYPERLINK\(""bad""\)"/);
assert.match(csv, /"甲,乙公司"/);
assert.match(csv, /"第一行\r\n第二行"/);
assert.match(csv, /"匹配 Python；有 RAG 项目"/);
assert.match(csv, /"是"/);
assert(!csv.includes("undefined"));

const risky = encodeJobExportCsv([{ id: 8, title: "  +SUM(1,2)" }]);
assert.match(risky, /"'  \+SUM\(1,2\)"/);
assert.equal(jobExportFileName({ planName: "广州/AI:*?", date: "2026-09-03" }), "RoleFlow-广州_AI-2026-09-03.csv");

console.log("job_export_smoke ok");
