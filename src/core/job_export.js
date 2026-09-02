"use strict";

const COLUMNS = Object.freeze([
  ["岗位编号", (job) => job.id],
  ["岗位名称", (job) => job.title],
  ["公司", (job) => job.company],
  ["城市", (job) => job.location],
  ["薪资", (job) => job.salary],
  ["经验", (job) => job.experience],
  ["学历", (job) => job.education],
  ["岗位链接", (job) => job.url],
  ["首次发现", (job) => job.firstSeenAt],
  ["最近发现", (job) => job.lastSeenAt],
  ["是否归档", (job) => job.archived ? "是" : "否"],
  ["推荐结论", (job) => job.decisionBucket],
  ["岗位摘要", (job) => job.analysis?.businessScenario],
  ["匹配依据", (job) => (job.analysis?.fitReasons || []).join("；")],
  ["需要确认", (job) => (job.analysis?.questionsToVerify || []).join("；")],
  ["求职状态", (job) => job.applicationStatus],
  ["状态时间", (job) => job.applicationUpdatedAt],
  ["HR 状态", (job) => job.messageStatus],
  ["HR 状态时间", (job) => job.messageStatusAt]
]);

function encodeJobExportCsv(jobs = []) {
  if (!Array.isArray(jobs)) throw new TypeError("jobs must be an array");
  const rows = [
    COLUMNS.map(([label]) => csvCell(label)),
    ...jobs.map((job) => COLUMNS.map(([, read]) => csvCell(read(job || {}))))
  ];
  return `\ufeff${rows.map((row) => row.join(",")).join("\r\n")}\r\n`;
}

function csvCell(value) {
  let text = value === undefined || value === null ? "" : String(value);
  text = text.replace(/\r\n?|\n/g, "\r\n");
  if (/^[=+\-@]/.test(text.trimStart())) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function jobExportFileName({ planName, date = new Date() } = {}) {
  const safePlan = String(planName || "岗位")
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_")
    .replace(/\s+/g, "-")
    .replace(/[._-]+$/g, "")
    .slice(0, 60) || "岗位";
  const safeDate = exportDate(date);
  return `RoleFlow-${safePlan}-${safeDate}.csv`;
}

function exportDate(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError("date must be valid");
  return parsed.toISOString().slice(0, 10);
}

module.exports = { COLUMNS, encodeJobExportCsv, jobExportFileName };
