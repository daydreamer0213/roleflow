const { escapeHtml, escapeAttr } = require("../http/response");
const { renderDashboardFrame } = require("../ui/shell");
const {
  DEFAULT_PRELIMINARY_SAMPLE_TARGET,
  DEFAULT_COMPARABLE_SAMPLE_TARGET,
  DEFAULT_FORMAL_SAMPLE_TARGET
} = require("../../core/funnel_maturity");

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
  const analysisSource = String(dashboard.analysisSource || (latest ? "latest_cohort" : "current_pool"));
  const currentIsActive = analysisSource === "current_pool";
  const activePolicy = currentIsActive ? policy : cohortPolicy(latest, policy);
  const diagnosticSample = currentIsActive
    ? Number(currentPool.mature || 0)
    : Number(latest?.sampleCount || 0);
  const strength = String((currentIsActive ? currentPool.strength : latest?.strength) || "facts");
  const unknown = Number((currentIsActive ? currentPool.unknown : latest?.unknown) || 0);
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
      ${renderThresholdRuler(activePolicy, diagnosticSample, strength)}
      ${renderSampleMetrics({
        diagnosticSample,
        currentMature: Number(currentPool.mature || 0),
        started,
        waiting,
        unknown,
        analysisSource,
        latest
      })}
      ${renderRollingPoolStatus(currentPool, policy, analysisSource)}
      ${renderEarlyPositive(currentPool.earlyPositive || {})}
      ${started || latest ? renderFunnelStages(dashboard.funnel || {}) : renderEmptyState()}
      ${renderComparisons(dashboard.comparisons || {}, policy, strength)}
      ${renderPreviousCohort(latest, analysisSource, policy)}
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
  const preliminary = positiveNumber(policy.preliminarySampleTarget, DEFAULT_PRELIMINARY_SAMPLE_TARGET);
  const comparable = positiveNumber(policy.comparableSampleTarget, DEFAULT_COMPARABLE_SAMPLE_TARGET);
  const formal = positiveNumber(policy.formalSampleTarget, DEFAULT_FORMAL_SAMPLE_TARGET);
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

function renderSampleMetrics({ diagnosticSample, currentMature, started, waiting, unknown, analysisSource, latest }) {
  const frozenActive = analysisSource === "latest_cohort" && latest;
  return `<section class="metric-grid funnel-metrics" aria-label="求职样本状态">
    <div class="metric"><span class="metric-label">当前诊断样本</span><strong class="metric-value">${diagnosticSample}</strong><span class="metric-note">${frozenActive ? "最新冻结批次" : "当前滚动样本池"}</span></div>
    <div class="metric"><span class="metric-label">${frozenActive ? "下一批已成熟" : "当前池已进入"}</span><strong class="metric-value">${frozenActive ? currentMature : started}</strong><span class="metric-note">${frozenActive ? `共进入 ${started} 个` : "含成熟与等待反馈"}</span></div>
    <div class="metric"><span class="metric-label">等待 48 小时</span><strong class="metric-value">${waiting}</strong><span class="metric-note">暂不作为失败</span></div>
    <div class="metric"><span class="metric-label">状态未知</span><strong class="metric-value">${unknown}</strong><span class="metric-note">不当作失败</span></div>
  </section>`;
}

function renderRollingPoolStatus(currentPool, policy, analysisSource) {
  if (analysisSource !== "latest_cohort") return "";
  const mature = Math.max(0, Number(currentPool.mature || 0));
  const waiting = Math.max(0, Number(currentPool.waiting || 0));
  const preliminary = positiveNumber(policy.preliminarySampleTarget, DEFAULT_PRELIMINARY_SAMPLE_TARGET);
  const remaining = Math.max(0, preliminary - mature);
  return `<section class="card pad funnel-rolling" aria-labelledby="funnel-rolling-title"><p class="section-label">下一批滚动样本</p><h2 id="funnel-rolling-title">已有 ${mature} 个成熟样本</h2><p>距离新的初步观察还差 ${remaining} 个；另有 ${waiting} 个仍在 48 小时反馈窗口内。达到当前设置的 ${preliminary} 个后，页面会切换到新一批结论。</p></section>`;
}

function renderEarlyPositive(counts) {
  const replied = Math.max(0, Number(counts.replied || 0));
  const resume = Math.max(0, Number(counts.resumeRequested || 0));
  const interview = Math.max(0, Number(counts.interviewInvited || 0));
  if (!replied && !resume && !interview) return "";
  const parts = [
    replied ? `${replied} 个已收到回复` : "",
    resume ? `${resume} 个已索要简历` : "",
    interview ? `${interview} 个已发出面试邀请` : ""
  ].filter(Boolean);
  return `<aside class="card pad funnel-early-positive"><strong>48 小时等待期内已有积极结果：</strong><span>${escapeHtml(parts.join("，"))}。这些结果立即显示，但样本仍要等窗口结束后才进入诊断分母。</span></aside>`;
}

function renderFunnelStages(funnel) {
  const rows = STAGES.map(([key, label]) => renderStage(label, funnel[key] || {})).join("");
  return `<section class="card pad funnel-stages" aria-labelledby="funnel-stages-title"><div class="funnel-section-head"><div><p class="section-label">成熟样本漏斗</p><h2 id="funnel-stages-title">反馈走到了哪一步</h2></div><p class="muted">分母只使用已到达上一环节、且本环节状态明确的成熟样本；等待单列。</p></div><div class="funnel-stage-list">${rows}</div></section>`;
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

function renderComparisons(comparisons, policy, strength) {
  if (!["comparable", "formal"].includes(strength)) return "";
  const sections = [
    ["direction", "岗位方向", (item) => item.label || item.key],
    ["decisionBucket", "推荐档位", (item) => item.label || decisionLabel(item.key)],
    ["resumeVersion", "简历版本", (item, index) => item.label || `简历版本 ${index + 1}`],
    ["greeting", "招呼语版本", (item, index) => item.label || `招呼语版本 ${index + 1}`]
  ].map(([key, label, labelFor]) => renderComparisonGroup(label, comparisons[key] || [], labelFor)).filter(Boolean);
  if (!sections.length) return "";
  const minimum = Math.max(10, Math.floor(positiveNumber(policy.preliminarySampleTarget, DEFAULT_PRELIMINARY_SAMPLE_TARGET) / 2));
  return `<section class="card pad funnel-comparisons" aria-labelledby="funnel-comparisons-title"><div class="funnel-section-head"><div><p class="section-label">分组观察</p><h2 id="funnel-comparisons-title">哪些方向或材料值得优先检查</h2></div><p class="muted">每组至少 ${minimum} 个成熟样本才显示；差异用于排查，不代表因果。</p></div><div class="funnel-comparison-groups">${sections.join("")}</div></section>`;
}

function renderComparisonGroup(title, items, labelFor) {
  if (!items.length) return "";
  return `<section class="funnel-comparison-group" aria-label="${escapeAttr(title)}"><h3>${escapeHtml(title)}</h3><div class="funnel-comparison-grid">${items.map((item, index) => `<article><div class="funnel-comparison-title"><strong>${escapeHtml(labelFor(item, index) || `分组 ${index + 1}`)}</strong><span>${Number(item.sampleCount || 0)} 个成熟样本</span></div><dl>${renderMetricRows(item)}</dl></article>`).join("")}</div></section>`;
}

function renderMetricRows(item) {
  return [
    ["read", "已读"],
    ["replied", "回复"],
    ["effectiveConversation", "有效沟通"],
    ["interviewInvited", "面试邀请"]
  ].filter(([key]) => item[key] && Number(item[key].denominator || 0) > 0)
    .map(([key, label]) => `<div><dt>${label}</dt><dd>${metricText(item[key])}</dd></div>`)
    .join("");
}

function renderPreviousCohort(latest, analysisSource, policy) {
  if (!latest || analysisSource !== "current_pool") return "";
  const strength = String(latest.strength || "formal");
  const preliminary = positiveNumber(policy.preliminarySampleTarget, DEFAULT_PRELIMINARY_SAMPLE_TARGET);
  return `<section class="card pad funnel-previous" aria-labelledby="funnel-previous-title"><div><p class="section-label">上一批冻结结论 · ${escapeHtml(STRENGTH_LABELS[strength] || STRENGTH_LABELS.formal)}</p><h2 id="funnel-previous-title">${escapeHtml(latest.headline || "上一批结果已保留。")}</h2></div><p><strong>${Math.max(0, Number(latest.sampleCount || 0))}</strong> 个成熟样本；新一批达到当前设置的 ${preliminary} 个后已切换为当前诊断，上一批不会覆盖新反馈。</p></section>`;
}

function cohortPolicy(cohort, fallback) {
  return {
    preliminarySampleTarget: positiveNumber(
      cohort?.preliminarySampleTarget,
      positiveNumber(fallback.preliminarySampleTarget, DEFAULT_PRELIMINARY_SAMPLE_TARGET)
    ),
    comparableSampleTarget: positiveNumber(
      cohort?.comparableSampleTarget,
      positiveNumber(fallback.comparableSampleTarget, DEFAULT_COMPARABLE_SAMPLE_TARGET)
    ),
    formalSampleTarget: positiveNumber(
      cohort?.formalSampleTarget,
      positiveNumber(fallback.formalSampleTarget, DEFAULT_FORMAL_SAMPLE_TARGET)
    )
  };
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
