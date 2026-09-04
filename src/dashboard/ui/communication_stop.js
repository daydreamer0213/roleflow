"use strict";

const { escapeHtml } = require("../http/response");

function renderCommunicationStop(issue) {
  if (!issue) return "";
  return `<section class="alert" role="alert"><strong>${escapeHtml(issue.title)}</strong><p>${escapeHtml(issue.impact)}</p><p>${escapeHtml(issue.nextAction)}</p><details class="error-technical"><summary>技术信息</summary><p>错误编号：${escapeHtml(issue.code)}</p>${issue.technicalMessage ? `<p>${escapeHtml(issue.technicalMessage)}</p>` : ""}<a href="/diagnostics">查看运行诊断</a></details></section>`;
}

module.exports = { renderCommunicationStop };
