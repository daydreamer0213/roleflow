const fs = require("fs");
const path = require("path");

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function renderReports(jobs, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const name = `boss_shortlist_${stamp()}`;
  const mdPath = path.join(outDir, `${name}.md`);
  const htmlPath = path.join(outDir, `${name}.html`);
  fs.writeFileSync(mdPath, renderMarkdown(jobs), "utf8");
  fs.writeFileSync(htmlPath, renderHtml(jobs), "utf8");
  return { mdPath, htmlPath };
}

function renderMarkdown(jobs) {
  const lines = ["# BOSS 岗位筛选报告", "", `生成时间：${new Date().toLocaleString("zh-CN")}`, ""];
  lines.push("|分数|级别|状态|出现|建议|岗位|公司|地点|薪资|推荐简历|风险|");
  lines.push("|---:|---|---|---|---|---|---|---|---|---|---|");
  for (const job of jobs) {
    const analysis = job.analysis || {};
    const title = job.url ? `[${escapeMd(job.title)}](${job.url})` : escapeMd(job.title);
    lines.push(`|${job.score}|${escapeMd(job.level)}|${escapeMd(statusLabel(job))}|${escapeMd(seenLabel(job))}|${escapeMd(analysis.recommendation || "")}|${title}|${escapeMd(job.company)}|${escapeMd(job.location)}|${escapeMd(job.salary)}|${escapeMd(analysis.recommendedResumeVersionName || analysis.recommendedResumeVersion || "")}|${escapeMd([...(job.risks || []), ...(job.qualityTags || [])].join("；"))}|`);
  }

  lines.push("");
  for (const job of jobs.slice(0, 30)) {
    const analysis = job.analysis || {};
    const feedbackText = feedbackLabel(job);
    lines.push(`## ${job.score}｜${job.level}｜${job.title}`);
    lines.push("");
    lines.push(`- 公司：${job.company || ""}`);
    lines.push(`- 地点/薪资：${job.location || ""} / ${job.salary || ""}`);
    lines.push(`- 工作节奏：${workScheduleLabel(analysis)}`);
    lines.push(`- 状态：${statusLabel(job)} / ${seenLabel(job)}`);
    lines.push(`- 反馈提示：${feedbackText}`);
    lines.push(`- 投递建议：${analysis.recommendation || "caution"} / ${analysis.fitLevel || "待确认"} / 置信度 ${formatConfidence(analysis.confidence)}`);
    lines.push(`- 推荐简历：${analysis.recommendedResumeVersionName || analysis.recommendedResumeVersion || "待确认"}`);
    lines.push(`- 主推项目：${(analysis.primaryProjects || []).join("、") || "待确认"}`);
    lines.push(`- 规则命中：${(job.matches || []).join("、") || "无"}`);
    lines.push(`- 质量标签：${(job.qualityTags || []).join("、") || "无"}`);
    lines.push(`- 模型理由：${(analysis.fitReasons || []).join("；") || "待补充"}`);
    lines.push(`- 风险：${(job.risks || []).join("、") || "无"}`);
    lines.push(`- 风险追问：${(analysis.riskQuestions || []).join("；") || "暂无"}`);
    lines.push(`- 沟通角度：${analysis.greetingAngle || "按岗位职责切入"}`);
    lines.push(`- 招呼语：${analysis.greeting || job.greeting || ""}`);
    lines.push("");
  }
  return lines.join("\n");
}

function renderHtml(jobs) {
  const rows = jobs.map((job) => `
    <article class="job">
      ${renderAnalysisBand(job)}
      <div class="top">
        <strong>${escapeHtml(job.score)}｜${escapeHtml(job.level)}｜<a href="${escapeAttr(job.url || "#")}" target="_blank">${escapeHtml(job.title)}</a></strong>
        <span>${escapeHtml(job.company || "")}</span>
      </div>
      <div class="meta">${escapeHtml(job.location || "")} · ${escapeHtml(job.salary || "")} · ${escapeHtml(job.experience || "")} · ${escapeHtml(job.bossActiveText || "")}</div>
      <div class="meta">工作节奏：${escapeHtml(workScheduleLabel(job.analysis || {}))}</div>
      <div class="meta">状态：${escapeHtml(statusLabel(job))} · 出现：${escapeHtml(seenLabel(job))}</div>
      <div class="meta">反馈提示：${escapeHtml(feedbackLabel(job))}</div>
      <div class="chips">${chips(job.matches, "ok")}${chips(job.risks, "risk")}${chips(job.qualityTags, "tag")}</div>
      ${renderAnalysis(job)}
      <p>${escapeHtml(job.description || "").slice(0, 260)}</p>
      <textarea readonly>${escapeHtml(job.analysis?.greeting || job.greeting || "")}</textarea>
      <button onclick="navigator.clipboard.writeText(this.previousElementSibling.value)">复制招呼语</button>
    </article>`).join("\n");
  return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<title>BOSS 岗位筛选报告</title>
<style>
body{font-family:Segoe UI,Microsoft YaHei,sans-serif;margin:0;background:#f6f7f9;color:#1f2328}
main{max-width:1100px;margin:0 auto;padding:24px}
h1{font-size:24px}
.job{background:#fff;border:1px solid #d8dee4;border-radius:8px;padding:16px;margin:12px 0}
.top{display:flex;justify-content:space-between;gap:16px}
.meta{color:#57606a;margin:8px 0}
.decision{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}
.pill{background:#eef2ff;border:1px solid #c7d2fe;border-radius:999px;padding:3px 8px;font-size:12px}
.section{margin-top:8px;color:#3b434d;font-size:14px}
.chip{display:inline-block;border-radius:999px;padding:3px 8px;margin:2px;font-size:12px}
.ok{background:#dafbe1}.risk{background:#ffebe9}.tag{background:#f6f8fa;border:1px solid #d8dee4}
textarea{width:100%;height:58px;box-sizing:border-box;margin-top:8px}
button{margin-top:8px;padding:6px 10px}
</style>
<main>
<h1>BOSS 岗位筛选报告</h1>
<p>生成时间：${escapeHtml(new Date().toLocaleString("zh-CN"))}。工具只读取岗位信息，投递需要人工确认。</p>
${rows}
</main>
</html>`;
}

function renderAnalysisBand(job) {
  const analysis = job.analysis || {};
  if (!Object.keys(analysis).length) return "";
  return `<div class="decision">
    <span class="pill">建议：${escapeHtml(analysis.recommendation || "caution")}</span>
    <span class="pill">匹配：${escapeHtml(analysis.fitLevel || "待确认")}</span>
    <span class="pill">简历：${escapeHtml(analysis.recommendedResumeVersionName || analysis.recommendedResumeVersion || "待确认")}</span>
    <span class="pill">模型：${escapeHtml(analysis.provider || "mock")}</span>
  </div>`;
}

function renderAnalysis(job) {
  const analysis = job.analysis || {};
  if (!Object.keys(analysis).length) return "";
  const projects = (analysis.primaryProjects || []).join("、") || "待确认";
  const reasons = (analysis.fitReasons || []).slice(0, 3).join("；") || "待补充";
  const risks = (analysis.riskQuestions || []).slice(0, 3).join("；") || "暂无";
  return `<div class="section"><strong>主推项目：</strong>${escapeHtml(projects)}</div>
  <div class="section"><strong>模型理由：</strong>${escapeHtml(reasons)}</div>
  <div class="section"><strong>风险追问：</strong>${escapeHtml(risks)}</div>
  <div class="section"><strong>沟通角度：</strong>${escapeHtml(analysis.greetingAngle || "按岗位职责切入")}</div>`;
}

function workScheduleLabel(analysis = {}) {
  const label = {
    double_weekend: "双休",
    alternating_weekend: "大小周/单双休",
    single_weekend: "单休",
    unknown: "未说明"
  }[analysis.workSchedule || "unknown"];
  return analysis.workScheduleEvidence ? `${label}（${analysis.workScheduleEvidence}）` : label;
}

function chips(values = [], cls) {
  return values.map((x) => `<span class="chip ${cls}">${escapeHtml(x)}</span>`).join("");
}

function formatConfidence(value) {
  return typeof value === "number" ? `${Math.round(value * 100)}%` : "待确认";
}

function statusLabel(job) {
  if (job.applicationStatus === "applied") return "已投";
  if (job.applicationStatus === "skipped") return `已跳过${job.applicationNote ? `：${job.applicationNote}` : ""}`;
  if (job.applicationStatus === "no_reply") return `无回复/待跟进${job.applicationNote ? `：${job.applicationNote}` : ""}`;
  return "未处理";
}

function seenLabel(job) {
  if (!job.firstSeenAt || !job.lastSeenAt) return "未知";
  return job.firstSeenAt === job.lastSeenAt ? "本次新增" : "重复出现";
}

function feedbackLabel(job) {
  const feedback = job.feedback || {};
  if ((feedback.notes || []).length) return feedback.notes.join("；");
  if (feedback.bonus > 0) return "历史反馈略加权";
  if (feedback.penalty > 0) return "历史反馈略降权";
  return "暂无";
}

function escapeMd(value) {
  return String(value || "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch]));
}

function escapeAttr(value) {
  return escapeHtml(value);
}

module.exports = { renderReports, renderMarkdown, renderHtml };
