function renderWorkflowHealthPanel(report = {}) {
  const statusLabel = {
    healthy: "正常",
    attention: "需要处理",
    blocked: "存在关联异常"
  }[report.status] || "尚未检查";
  const summary = report.summary || {};
  const issues = Array.isArray(report.issues) ? report.issues : [];
  const recentEvents = Array.isArray(report.recentEvents) ? report.recentEvents : [];
  const truncated = report.truncated || {};
  const issueRows = issues.slice(0, 50).map((item) => `
    <tr>
      <td>${escapeHtml(severityLabel(item.severity))}</td>
      <td>${escapeHtml(item.title)}</td>
      <td>${escapeHtml(item.message)}</td>
      <td><a href="${escapeAttr(item.actionHref)}">查看</a></td>
    </tr>
  `).join("");
  const eventRows = recentEvents.slice(0, 20).map((event) => `
    <tr>
      <td>${escapeHtml(String(event.createdAt || "").replace("T", " ").slice(0, 19))}</td>
      <td>${escapeHtml(eventLabel(event.eventType))}</td>
      <td>${escapeHtml(`岗位 #${event.jobId || ""}`)}</td>
    </tr>
  `).join("");
  const truncatedNote = Object.values(truncated).some(Boolean)
    ? `<p class="hint">记录数量超过页面上限，本次只显示最近一部分；完整数据仍保留在本地数据库中。</p>`
    : "";

  return `<section class="panel workflow-health">
    <details${report.status === "blocked" ? " open" : ""}>
      <summary><strong>流程体检：${escapeHtml(statusLabel)}</strong>
        · 已检查岗位 ${Number(summary.jobsChecked || 0)}
        · 问题 ${Number(summary.issueCount || 0)}
      </summary>
      <p class="hint">这里只读取现有记录，不会自动修复、重新分析、扫描或沟通。</p>
      ${truncatedNote}
      <h2>需要关注</h2>
      <table class="diagnostics">
        <thead><tr><th>级别</th><th>问题</th><th>对象</th><th>操作</th></tr></thead>
        <tbody>${issueRows || "<tr><td colspan=\"4\">当前未发现流程数据问题</td></tr>"}</tbody>
      </table>
      <h2>最近状态变化</h2>
      <table class="diagnostics">
        <thead><tr><th>时间</th><th>状态</th><th>岗位</th></tr></thead>
        <tbody>${eventRows || "<tr><td colspan=\"3\">暂无状态变化记录</td></tr>"}</tbody>
      </table>
    </details>
  </section>`;
}

function severityLabel(value) {
  return {
    critical: "严重",
    warning: "注意",
    info: "提示"
  }[value] || "提示";
}

function eventLabel(value) {
  return {
    pending: "待处理",
    review: "待复核",
    later: "稍后处理",
    applied: "已投递",
    skipped: "已跳过",
    no_reply: "无回复",
    follow_up: "新增跟进",
    recommendation_feedback: "推荐反馈"
  }[value] || String(value || "未知状态");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value) {
  const text = String(value || "");
  if (!text.startsWith("/") || text.startsWith("//") || text.includes("\\")) return "#";
  return escapeHtml(text);
}

module.exports = { renderWorkflowHealthPanel };
