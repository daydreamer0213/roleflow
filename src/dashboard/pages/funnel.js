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
  comparable: "可比较结论",
  formal: "正式诊断"
});

const CHANGE_LABELS = Object.freeze({
  initial: "初始策略",
  greeting: "招呼语",
  resume: "定向简历",
  strategy: "求职策略"
});

function renderFunnelPage({ plan = {}, dashboard = {} } = {}) {
  const planId = Number(plan.id || 0);
  const currentPath = `/funnel?planId=${encodeURIComponent(planId)}`;
  const todayPath = `/plan?planId=${encodeURIComponent(planId)}`;
  const policy = dashboard.policy || {};
  const currentRound = dashboard.currentRound || dashboard.currentPool || {};
  const activePolicy = strategyRoundPolicy(currentRound, policy);
  const diagnosticSample = Number(currentRound.mature || 0);
  const strength = String(currentRound.strength || "facts");
  const unknown = Number(currentRound.unknown || 0);
  const waiting = Number(currentRound.waiting || 0);
  const started = Number(currentRound.started || 0);

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
        <p class="lede">每次招呼语、简历或求职策略调整都单独验证。先等真实反馈成熟，再比较调整前后发生了什么。</p>
        <div class="heading-meta"><span>${escapeHtml(plan.name || "当前筛选方案")}</span><span class="status ${strengthTone(strength)}">${escapeHtml(STRENGTH_LABELS[strength] || STRENGTH_LABELS.facts)}</span></div>
      </section>
      ${renderCurrentRound(currentRound)}
      ${renderConclusion(dashboard, strength)}
      ${renderThresholdRuler(activePolicy, diagnosticSample, strength)}
      ${renderSampleMetrics({
        diagnosticSample,
        started,
        waiting,
        unknown
      })}
      ${renderEarlyPositive(currentRound.earlyPositive || {})}
      ${started ? renderFunnelStages(dashboard.funnel || {}) : renderEmptyState()}
      ${renderComparisons(dashboard.comparisons || {}, activePolicy, strength)}
      ${renderRoundComparison(dashboard.previousRound, dashboard.roundComparison)}
      ${renderStrategyBoundary(planId, currentRound)}
      ${renderEvidenceNotes(dashboard.evidenceNotes || [])}
    </main><p class="footer-note">本页只读取本地记录并更新本地策略轮次；不会访问 BOSS，不会填写、粘贴或发送，也不会替你修改外部招呼语或求职设置。</p>`
  });
}

function renderCurrentRound(round) {
  const sequence = Math.max(1, Number(round.sequenceNumber || 1));
  const labels = (Array.isArray(round.changeKinds) ? round.changeKinds : ["initial"])
    .map((kind) => CHANGE_LABELS[kind]).filter(Boolean);
  const changeNote = String(round.changeNote || "").trim();
  return `<section class="card pad funnel-round" aria-labelledby="funnel-round-title">
    <div class="funnel-round-mark" aria-hidden="true">${sequence}</div>
    <div><p class="section-label">当前策略轮次</p><h2 id="funnel-round-title">第 ${sequence} 轮</h2><p>${escapeHtml(changeNote || "继续验证当前招呼语、简历和求职策略。")}</p></div>
    <div class="funnel-round-change"><span>本轮从 ${escapeHtml(formatLocalTime(round.startedAt))} 开始</span><strong>${escapeHtml(labels.join(" + ") || "初始策略")}</strong></div>
  </section>`;
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
        <li style="--funnel-mark:${escapeAttr(((comparable / formal) * 100).toFixed(2))}%"><strong>${comparable} 个成熟样本 · 可比较结论</strong><span>可以比较方向、材料和前后轮次</span></li>
        <li style="--funnel-mark:100%"><strong>${formal} 个成熟样本 · 正式诊断</strong><span>结论强度充分，本轮仍继续积累</span></li>
      </ol>
    </div>
  </section>`;
}

function renderSampleMetrics({ diagnosticSample, started, waiting, unknown }) {
  return `<section class="metric-grid funnel-metrics" aria-label="求职样本状态">
    <div class="metric"><span class="metric-label">本轮成熟样本</span><strong class="metric-value">${diagnosticSample}</strong><span class="metric-note">只统计当前策略</span></div>
    <div class="metric"><span class="metric-label">本轮已进入</span><strong class="metric-value">${started}</strong><span class="metric-note">含成熟与等待反馈</span></div>
    <div class="metric"><span class="metric-label">等待反馈成熟</span><strong class="metric-value">${waiting}</strong><span class="metric-note">至少 48 小时；周末顺延</span></div>
    <div class="metric"><span class="metric-label">状态未知</span><strong class="metric-value">${unknown}</strong><span class="metric-note">不当作失败</span></div>
  </section>`;
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
  return `<section class="card pad funnel-empty" aria-labelledby="funnel-empty-title"><p class="section-label">开始积累</p><h2 id="funnel-empty-title">还没有可统计的求职动作</h2><p>确认已投、已验证发起沟通或确认已发送回复后，RoleFlow 才把岗位放进当前策略轮次；仅收藏、稍后处理或查看岗位不会计数。</p></section>`;
}

function renderComparisons(comparisons, policy, strength) {
  if (!["comparable", "formal"].includes(strength)) return "";
  const sections = [
    ["direction", "岗位方向", (item) => item.label || item.key],
    ["decisionBucket", "推荐档位", (item) => item.label || decisionLabel(item.key)],
    ["resumeVersion", "简历版本", (item, index) => item.label || `简历版本 ${index + 1}`]
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

function strategyRoundPolicy(round, fallback) {
  const thresholds = round?.thresholds || {};
  return {
    preliminarySampleTarget: positiveNumber(
      thresholds.preliminary,
      positiveNumber(fallback.preliminarySampleTarget, DEFAULT_PRELIMINARY_SAMPLE_TARGET)
    ),
    comparableSampleTarget: positiveNumber(
      thresholds.comparable,
      positiveNumber(fallback.comparableSampleTarget, DEFAULT_COMPARABLE_SAMPLE_TARGET)
    ),
    formalSampleTarget: positiveNumber(
      thresholds.formal,
      positiveNumber(fallback.formalSampleTarget, DEFAULT_FORMAL_SAMPLE_TARGET)
    )
  };
}

function renderRoundComparison(previous, comparison = {}) {
  if (!previous || comparison.status === "none") return "";
  const previousNumber = Math.max(1, Number(previous.sequenceNumber || 1));
  const note = String(comparison.note || "前后轮次暂时不能比较。");
  const metrics = comparison.status === "ready"
    ? `<div class="funnel-round-comparison-grid">${[
      ["read", "招聘方已读"],
      ["replied", "招聘方回复"],
      ["effectiveConversation", "有效沟通"],
      ["interviewInvited", "面试邀请"]
    ].map(([key, label]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(metricText(comparison.before?.stages?.[key]))}</strong><i aria-hidden="true">→</i><strong>${escapeHtml(metricText(comparison.after?.stages?.[key]))}</strong></div>`).join("")}</div>`
    : "";
  return `<section class="card pad funnel-round-comparison" aria-labelledby="funnel-round-comparison-title">
    <div class="funnel-section-head"><div><p class="section-label">上一策略轮次 · 第 ${previousNumber} 轮</p><h2 id="funnel-round-comparison-title">调整前后对照</h2></div><p class="muted">${escapeHtml(note)}</p></div>
    ${metrics}
    ${comparison.status === "ready" ? '<p class="funnel-round-comparison-legend"><span>上一轮</span><span>当前轮</span></p>' : `<p>${escapeHtml(previous.headline || "上一轮结果已保留，迟到反馈仍会继续更新。")}</p>`}
  </section>`;
}

function renderStrategyBoundary(planId, currentRound) {
  const roundId = Number(currentRound.id || 0);
  if (!roundId) return "";
  return `<section class="card pad funnel-round-boundary" aria-labelledby="funnel-round-boundary-title">
    <div><p class="section-label">我已经完成外部调整</p><h2 id="funnel-round-boundary-title">从下一次求职动作开始验证新方案</h2><p>先在外部完成修改，再在这里记录边界。旧岗位继续留在第 ${Math.max(1, Number(currentRound.sequenceNumber || 1))} 轮，新岗位进入下一轮。</p></div>
    <form method="post" action="/api/funnel/strategy-round" data-funnel-strategy-form>
      <input type="hidden" name="planId" value="${escapeAttr(planId)}">
      <input type="hidden" name="fromRoundId" value="${escapeAttr(roundId)}">
      <fieldset><legend>这次调整了什么？</legend><label><input type="checkbox" name="changeKinds" value="greeting"> 招呼语</label><label><input type="checkbox" name="changeKinds" value="strategy"> 求职方向或投递策略</label></fieldset>
      <label>调整说明（可选）<textarea name="changeNote" maxlength="300" rows="3" placeholder="例如：缩短招呼语，突出 RAG 项目经验"></textarea></label>
      <button type="submit">修改完成，开始验证新方案</button>
      <p class="alert" data-funnel-strategy-error role="alert"></p>
    </form>
  </section>`;
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
  if (strength === "preliminary") return `距离可比较结论还差 ${Math.max(0, policy.comparable - mature)} 个。`;
  if (strength === "comparable") return `距离正式诊断还差 ${Math.max(0, policy.formal - mature)} 个。`;
  return "已达到正式诊断强度；本轮继续积累，直到策略发生变化。";
}

function formatLocalTime(value) {
  const timestamp = Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp)) return "本轮记录时";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp));
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

const FUNNEL_STRATEGY_SCRIPT = `<script>(()=>{const form=document.querySelector('[data-funnel-strategy-form]');if(!form)return;const choices=Array.from(form.querySelectorAll('input[name="changeKinds"]'));const error=form.querySelector('[data-funnel-strategy-error]');const clear=()=>{if(choices[0])choices[0].setCustomValidity('');if(error)error.textContent='';};for(const choice of choices)choice.addEventListener('change',clear);form.addEventListener('submit',(event)=>{clear();if(choices.some((choice)=>choice.checked))return;event.preventDefault();const message='请至少选择招呼语或求职方向 / 投递策略。';if(error)error.textContent=message;if(choices[0]){choices[0].setCustomValidity(message);choices[0].reportValidity();}});})();</script>`;

module.exports = { renderFunnelPage, FUNNEL_STRATEGY_SCRIPT };
