const { escapeHtml, escapeAttr } = require("../http/response");
const { renderDashboardFrame } = require("../ui/shell");

const STAGES = Object.freeze([
  ["started", "发起求职动作"],
  ["read", "招聘方已读"],
  ["replied", "招聘方回复"],
  ["effectiveConversation", "有效沟通"],
  ["resumeRequested", "索要简历"],
  ["interviewInvited", "发出面试邀请"],
  ["interviewConfirmed", "确认面试或后续"]
]);

const STRENGTH_LABELS = Object.freeze({
  facts: "样本不足",
  preliminary: "初步观察",
  comparable: "阶段诊断",
  formal: "正式诊断"
});

function renderFunnelPage({ plan = {}, dashboard = {} } = {}) {
  const planId = Number(plan.id || 0);
  const currentPath = `/funnel?planId=${encodeURIComponent(planId)}`;
  const todayPath = `/plan?planId=${encodeURIComponent(planId)}`;
  const policy = dashboard.policy || {};
  const latest = dashboard.latestCohort || null;
  const currentPool = dashboard.currentPool || {};
  const diagnosticSample = latest ? Number(latest.sampleCount || 0) : Number(currentPool.mature || 0);
  const strength = String(latest?.strength || currentPool.strength || "facts");
  const unknown = Number(latest?.unknown ?? currentPool.unknown ?? 0);
  const waiting = Number(currentPool.waiting || 0);
  const started = Number(currentPool.started || 0);

  return renderDashboardFrame({
    currentPath,
    todayPath,
    planId,
    stage: "求职体检",
    brandHref: todayPath,
    content: `<main id="main-content" class="funnel-main">
      <section class="page-heading" aria-labelledby="funnel-title">
        <p class="eyebrow">阶段二 · 本地结果分析</p>
        <h1 id="funnel-title">求职体检</h1>
        <p class="lede">把真实求职动作按 48 小时反馈窗口滚动积累，先判断证据够不够，再看当前最值得检查的环节。</p>
        <div class="heading-meta"><span>${escapeHtml(plan.name || "当前筛选方案")}</span><span class="status ${strengthTone(strength)}">${escapeHtml(STRENGTH_LABELS[strength] || STRENGTH_LABELS.facts)}</span></div>
      </section>
      ${renderConclusion(dashboard, strength)}
      ${renderThresholdRuler(policy, diagnosticSample, strength)}
      ${renderSampleMetrics({ diagnosticSample, started, waiting, unknown, latest })}
      ${started || latest ? renderFunnelStages(dashboard.funnel || {}) : renderEmptyState()}
      ${renderComparisons(dashboard.comparisons || {}, policy)}
      ${renderEvidenceNotes(dashboard.evidenceNotes || [])}
    </main><p class="footer-note">本页只读取本地记录并更新本地样本批次，不访问 BOSS、不填写、不粘贴、不发送，也不自动调整岗位筛选或材料。</p>`
  });
}

function renderConclusion(dashboard, strength) {
  return `<section class="funnel-conclusion" aria-labelledby="funnel-conclusion-title">
    <div><p class="section-label">当前结论 · ${escapeHtml(STRENGTH_LABELS[strength] || STRENGTH_LABELS.facts)}</p><h2 id="funnel-conclusion-title">${escapeHtml(dashboard.headline || "当前证据还不足以形成诊断。")}</h2></div>
    <div class="funnel-priority"><span>优先检查</span><strong>${escapeHtml(dashboard.priorityCheck || "继续积累真实结果。")}</strong></div>
  </section>`;
}

function renderThresholdRuler(policy, mature, strength) {
  const preliminary = positiveNumber(policy.preliminarySampleTarget, 30);
  const comparable = positiveNumber(policy.comparableSampleTarget, 50);
  const formal = positiveNumber(policy.formalSampleTarget, 70);
  const capped = Math.max(0, Math.min(100, (mature / formal) * 100));
  return `<section class="card pad funnel-evidence" aria-labelledby="evidence-strength-title">
    <div class="funnel-section-head"><div><p class="section-label">证据强度</p><h2 id="evidence-strength-title">当前 ${mature} 个成熟样本</h2></div><p class="muted">${escapeHtml(distanceToNext(mature, strength, { preliminary, comparable, formal }))}</p></div>
    <div class="funnel-ruler" style="--funnel-progress:${escapeAttr(capped.toFixed(2))}%" role="img" aria-label="当前 ${mature} 个成熟样本；初步观察 ${preliminary} 个，阶段诊断 ${comparable} 个，正式诊断 ${formal} 个">
      <span class="funnel-ruler-fill" aria-hidden="true"></span>
      <ol>
        <li style="--funnel-mark:${escapeAttr(((preliminary / formal) * 100).toFixed(2))}%"><strong>${preliminary} 个成熟样本 · 初步观察</strong><span>可以提出待验证的主要卡点</span></li>
        <li style="--funnel-mark:${escapeAttr(((comparable / formal) * 100).toFixed(2))}%"><strong>${comparable} 个成熟样本 · 阶段诊断</strong><span>可以比较方向和材料分组</span></li>
        <li style="--funnel-mark:100%"><strong>${formal} 个成熟样本 · 正式诊断</strong><span>冻结本批全部成熟样本</span></li>
      </ol>
    </div>
  </section>`;
}

function renderSampleMetrics({ diagnosticSample, started, waiting, unknown, latest }) {
  return `<section class="metric-grid funnel-metrics" aria-label="求职样本状态">
    <div class="metric"><span class="metric-label">当前诊断样本</span><strong class="metric-value">${diagnosticSample}</strong><span class="metric-note">${latest ? `已冻结第 ${Number(latest.id || 0)} 批` : "滚动样本池"}</span></div>
    <div class="metric"><span class="metric-label">${latest ? "下一批已进入" : "当前池已进入"}</span><strong class="metric-value">${started}</strong><span class="metric-note">含成熟与等待反馈</span></div>
    <div class="metric"><span class="metric-label">等待 48 小时</span><strong class="metric-value">${waiting}</strong><span class="metric-note">暂不计入诊断</span></div>
    <div class="metric"><span class="metric-label">状态未知</span><strong class="metric-value">${unknown}</strong><span class="metric-note">不当作失败</span></div>
  </section>`;
}

function renderFunnelStages(funnel) {
  const rows = STAGES.map(([key, label]) => renderStage(label, funnel[key] || {})).join("");
  return `<section class="card pad funnel-stages" aria-labelledby="funnel-stages-title"><div class="funnel-section-head"><div><p class="section-label">成熟样本漏斗</p><h2 id="funnel-stages-title">反馈走到了哪一步</h2></div><p class="muted">分母只使用这一环节已有明确状态的成熟样本。</p></div><div class="funnel-stage-list">${rows}</div></section>`;
}

function renderStage(label, value) {
  const numerator = Math.max(0, Number(value.numerator || 0));
  const denominator = Math.max(0, Number(value.denominator || 0));
  const unknown = Math.max(0, Number(value.unknown || 0));
  const waiting = Math.max(0, Number(value.waiting || 0));
  const percentage = denominator ? Math.min(100, (numerator / denominator) * 100) : 0;
  const summary = denominator ? `${numerator} / ${denominator}（${formatPercent(numerator / denominator)}）` : "暂无明确状态";
  return `<div class="funnel-stage-row"><div class="funnel-stage-copy"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(summary)}</span></div><div class="funnel-stage-track" role="progressbar" aria-label="${escapeAttr(label)} ${escapeAttr(summary)}" aria-valuemin="0" aria-valuemax="${denominator || 1}" aria-valuenow="${numerator}"><span style="width:${escapeAttr(percentage.toFixed(2))}%"></span></div><small>未知 ${unknown} · 等待 ${waiting}</small></div>`;
}

function renderEmptyState() {
  return `<section class="card pad funnel-empty" aria-labelledby="funnel-empty-title"><p class="section-label">开始积累</p><h2 id="funnel-empty-title">还没有可统计的求职动作</h2><p>确认已投、已验证发起沟通或确认已发送回复后，RoleFlow 才把岗位放进滚动样本池；仅收藏、稍后处理或查看岗位不会计数。</p></section>`;
}

function renderComparisons(comparisons, policy) {
  const sections = [
    ["direction", "岗位方向", (item) => item.key],
    ["decisionBucket", "推荐档位", (item) => decisionLabel(item.key)],
    ["resumeVersion", "简历版本", (_item, index) => `简历版本 ${index + 1}`],
    ["greeting", "招呼语版本", (_item, index) => `招呼语版本 ${index + 1}`]
  ].map(([key, label, labelFor]) => renderComparisonGroup(label, comparisons[key] || [], labelFor)).filter(Boolean);
  if (!sections.length) return "";
  const minimum = Math.max(10, Math.floor(positiveNumber(policy.preliminarySampleTarget, 30) / 2));
  return `<section class="card pad funnel-comparisons" aria-labelledby="funnel-comparisons-title"><div class="funnel-section-head"><div><p class="section-label">分组观察</p><h2 id="funnel-comparisons-title">哪些方向或材料值得优先检查</h2></div><p class="muted">每组至少 ${minimum} 个成熟样本才显示；差异用于排查，不代表因果。</p></div><div class="funnel-comparison-groups">${sections.join("")}</div></section>`;
}

function renderComparisonGroup(title, items, labelFor) {
  if (!items.length) return "";
  return `<section class="funnel-comparison-group" aria-label="${escapeAttr(title)}"><h3>${escapeHtml(title)}</h3><div class="funnel-comparison-grid">${items.map((item, index) => `<article><div class="funnel-comparison-title"><strong>${escapeHtml(labelFor(item, index) || `分组 ${index + 1}`)}</strong><span>${Number(item.sampleCount || 0)} 个成熟样本</span></div><dl><div><dt>已读</dt><dd>${metricText(item.read)}</dd></div><div><dt>回复</dt><dd>${metricText(item.replied)}</dd></div><div><dt>有效沟通</dt><dd>${metricText(item.effectiveConversation)}</dd></div><div><dt>面试邀请</dt><dd>${metricText(item.interviewInvited)}</dd></div></dl></article>`).join("")}</div></section>`;
}

function renderEvidenceNotes(notes) {
  if (!notes.length) return "";
  return `<aside class="funnel-notes" aria-labelledby="funnel-notes-title"><h2 id="funnel-notes-title">这份体检如何计算</h2><ul>${notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul></aside>`;
}

function metricText(metric = {}) {
  const numerator = Math.max(0, Number(metric.numerator || 0));
  const denominator = Math.max(0, Number(metric.denominator || 0));
  return denominator ? `${numerator} / ${denominator}（${formatPercent(numerator / denominator)}）` : "状态不足";
}

function formatPercent(rate) {
  return `${(Math.max(0, Math.min(1, Number(rate) || 0)) * 100).toFixed(1)}%`;
}

function distanceToNext(mature, strength, policy) {
  if (strength === "facts") return `距离初步观察还差 ${Math.max(0, policy.preliminary - mature)} 个。`;
  if (strength === "preliminary") return `距离阶段诊断还差 ${Math.max(0, policy.comparable - mature)} 个。`;
  if (strength === "comparable") return `距离正式诊断还差 ${Math.max(0, policy.formal - mature)} 个。`;
  return "已达到正式诊断强度；新动作进入下一批滚动样本。";
}

function strengthTone(strength) {
  if (strength === "formal") return "good";
  if (strength === "facts") return "waiting";
  return "neutral";
}

function decisionLabel(value) {
  return { primary: "主投", apply: "可投", caution: "慎投", not_recommended: "不推荐" }[String(value || "")] || "其他已记录档位";
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

module.exports = { renderFunnelPage };
