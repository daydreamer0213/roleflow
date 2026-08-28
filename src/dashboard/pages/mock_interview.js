const { escapeHtml, escapeAttr } = require("../http/response");
const { renderDashboardFrame } = require("../ui/shell");

function renderMockInterviewPage({ dashboard = {}, modelReady = true } = {}) {
  const plan = dashboard.plan || {};
  const planId = Number(plan.id || 0);
  const selected = dashboard.selectedSession || null;
  const currentPath = `/interview?planId=${encodeURIComponent(planId)}${selected ? `&sessionId=${encodeURIComponent(selected.id)}` : ""}`;
  const todayPath = `/plan?planId=${encodeURIComponent(planId)}`;
  return renderDashboardFrame({
    currentPath,
    todayPath,
    planId,
    stage: "模拟面试",
    brandHref: todayPath,
    content: `<main id="main-content" class="interview-main">
      <section class="page-heading interview-heading" aria-labelledby="interview-title">
        <p class="eyebrow">阶段四 · 岗位上下文训练</p>
        <h1 id="interview-title">模拟面试训练</h1>
        <p class="lede">无需面试邀请：选择一个资料完整的岗位和当前简历，逐题回答。追问会承接你的上一条回答，结束后再做具体到题号的复盘和重练。</p>
        <div class="heading-meta"><span>${escapeHtml(plan.name || "当前筛选方案")}</span><span>本地文字练习</span><span>不会写入候选人事实</span></div>
      </section>
      ${renderStartPanel(dashboard, modelReady)}
      ${selected ? renderSession(dashboard, selected) : renderEmptyState()}
    </main><p class="footer-note">本页只读写 RoleFlow 本地训练记录；不会访问 BOSS、不会投递、不会发送消息，也不会把练习回答自动变成候选人事实。</p>`
  });
}

function renderStartPanel(dashboard, modelReady) {
  const plan = dashboard.plan || {};
  const resumes = (dashboard.resumes || []).filter((resume) => resume.isActive);
  const jobs = dashboard.jobs || [];
  const activeResume = resumes.find((resume) => resume.isActive) || resumes[0] || null;
  return `<section class="card pad interview-start" aria-labelledby="interview-start-title">
    <div class="interview-section-head"><div><p class="section-label">开始一轮训练</p><h2 id="interview-start-title">冻结岗位、简历与训练设置</h2></div><span class="status ${modelReady ? "good" : "waiting"}">${modelReady ? "深度分析可用" : "模型待配置"}</span></div>
    ${modelReady ? "" : '<p class="alert">当前深度分析模型不可用。<a href="/settings">前往模型设置</a>完成连接后再开始。</p>'}
    <form class="interview-start-form" method="post" action="/api/interview/start" data-interview-submit>
      <input type="hidden" name="planId" value="${escapeAttr(plan.id || "")}">
      <label>目标岗位<select name="jobId" required>${jobs.map((job) => `<option value="${escapeAttr(job.id)}">${escapeHtml(job.title || "未命名岗位")} · ${escapeHtml(job.company || "公司未记录")}</option>`).join("")}</select></label>
      <label>简历版本<select name="resumeVersionId" required>${resumes.map((resume) => `<option value="${escapeAttr(resume.id)}"${activeResume?.id === resume.id ? " selected" : ""}>${escapeHtml(resume.name || "简历版本")}${resume.isActive ? " · 当前使用" : ""}</option>`).join("")}</select></label>
      <label>面试类型<select name="type"><option value="mixed">综合面试</option><option value="technical">技术 / 业务</option><option value="behavioral">行为问题</option><option value="general">通用沟通</option></select></label>
      <label>难度<select name="difficulty"><option value="standard">标准</option><option value="warmup">热身</option><option value="challenging">高压追问</option></select></label>
      <label>计划题数<select name="plannedQuestions"><option value="3">3 题 · 快速练习</option><option value="5" selected>5 题 · 推荐</option><option value="8">8 题 · 完整练习</option><option value="12">12 题 · 深入练习</option></select></label>
      <div class="button-row"><button${!modelReady || !jobs.length || !resumes.length ? " disabled" : ""}>开始模拟面试</button><span class="hint">岗位和简历会冻结在本轮记录中，后续更新不会悄悄切换上下文。</span></div>
    </form>
  </section>`;
}

function renderEmptyState() {
  return `<section class="card pad interview-empty"><p class="section-label">还没有训练记录</p><h2>先从上方开始一轮</h2><p>首题会使用当前岗位和简历；从第二题起，问题会继续承接你刚刚写下的回答。</p></section>`;
}

function renderSession(dashboard, session) {
  const completed = session.status === "completed";
  return `<section class="interview-workspace" aria-labelledby="interview-session-title">
    <div class="interview-session-head"><div><p class="section-label">${completed ? "本轮训练已完成" : "训练进行中"}</p><h2 id="interview-session-title">${escapeHtml(session.context?.job?.title || "模拟面试")}</h2><p>${escapeHtml(session.context?.job?.company || "公司未记录")}</p></div><span class="status ${completed ? "good" : "waiting"}">${completed ? "可复盘和重练" : `第 ${(session.turns || []).length} / ${escapeHtml(session.settings?.plannedQuestions || "-")} 题`}</span></div>
    ${renderBinding(session)}
    ${completed ? renderReport(session) : renderCurrentQuestion(dashboard, session)}
    ${renderTranscript(dashboard, session)}
    ${renderHistory(dashboard, session)}
  </section>`;
}

function renderBinding(session) {
  return `<dl class="interview-binding"><div><dt>冻结岗位</dt><dd>${escapeHtml(`${session.context?.job?.title || "岗位"} · ${session.context?.job?.company || "公司未记录"}`)}</dd></div><div><dt>冻结简历</dt><dd>${escapeHtml(session.context?.resume?.name || `简历版本 ${session.resumeVersionId}`)}</dd></div><div><dt>训练设置</dt><dd>${escapeHtml(`${typeLabel(session.settings?.type)} · ${difficultyLabel(session.settings?.difficulty)} · ${session.settings?.plannedQuestions || "-"} 题`)}</dd></div></dl>`;
}

function renderCurrentQuestion(dashboard, session) {
  const turns = session.turns || [];
  const current = turns[turns.length - 1];
  const planId = dashboard.plan?.id || "";
  if (!current) return `<section class="card pad alert"><strong>首题尚未生成</strong><p>请返回历史记录重新打开；当前冻结会话不会丢失。</p></section>`;
  if (current.answerText) {
    const canFinish = turns.length >= Number(session.settings?.plannedQuestions || 0);
    return canFinish ? `<section class="card pad interview-finish"><p class="section-label">题目已完成</p><h3>生成本轮复盘</h3><p>复盘会引用具体题号，不会把训练分数包装成录用概率。</p><form method="post" action="/api/interview/finish" data-interview-submit><input type="hidden" name="planId" value="${escapeAttr(planId)}"><input type="hidden" name="sessionId" value="${escapeAttr(session.id)}"><button>结束并生成复盘</button></form></section>` : "";
  }
  return `<section class="interview-current" aria-labelledby="interview-current-question">
    <div class="interview-question-number">Q${escapeHtml(current.turnNumber)}</div>
    <div><p class="section-label">当前问题 · ${escapeHtml(focusLabel(current.questionFocus))}</p><h3 id="interview-current-question">${escapeHtml(current.questionText)}</h3>${current.basedOnTurnNumber ? `<p class="interview-followup">这是一道承接第 ${escapeHtml(current.basedOnTurnNumber)} 题回答的追问。</p>` : ""}
      <form method="post" action="/api/interview/answer" data-interview-submit><input type="hidden" name="planId" value="${escapeAttr(planId)}"><input type="hidden" name="sessionId" value="${escapeAttr(session.id)}"><input type="hidden" name="turnNumber" value="${escapeAttr(current.turnNumber)}"><label>我的回答<textarea name="answerText" rows="8" maxlength="20000" required autofocus></textarea><small>按真实经历作答。提交后会直接保存并生成下一题，不会再二次确认。</small></label><button>提交回答并继续</button></form>
    </div>
  </section>`;
}

function renderReport(session) {
  const report = session.report || {};
  return `<section class="interview-report" aria-labelledby="interview-report-title">
    <div class="interview-report-lead"><p class="section-label">本轮结论</p><h3 id="interview-report-title">${escapeHtml(report.conclusion || "本轮复盘已生成")}</h3><p>这是训练复盘，不是录用概率。</p></div>
    <div class="interview-report-grid"><section><h4>当前最强</h4>${renderTextList(report.strengths)}</section><section><h4>优先改进</h4>${renderTextList(report.improvements)}</section></div>
    <div class="interview-report-details"><section><h4>容易被继续追问</h4>${renderTurnReasons(report.followUpRisks)}</section><section><h4>推荐重练</h4>${renderTurnReasons(report.retryRecommendations)}</section><section><h4>更好的回答结构</h4>${renderStructures(report.answerStructures)}</section></div>
  </section>`;
}

function renderTranscript(dashboard, session) {
  const turns = session.turns || [];
  const planId = dashboard.plan?.id || "";
  if (!turns.length) return "";
  return `<section class="interview-transcript" aria-labelledby="interview-transcript-title"><div class="interview-section-head"><div><p class="section-label">逐题记录</p><h3 id="interview-transcript-title">问题、原回答与复盘</h3></div><span>${turns.filter((turn) => turn.answerText).length} 题已答</span></div><div class="interview-turn-list">${turns.map((turn) => `<article class="interview-turn"><header><span>Q${escapeHtml(turn.turnNumber)}</span><div><p>${escapeHtml(focusLabel(turn.questionFocus))}</p><h4>${escapeHtml(turn.questionText)}</h4></div></header>${turn.answerText ? `<div class="interview-answer"><strong>原回答</strong><p>${escapeHtml(turn.answerText)}</p></div>${renderAnswerReview(turn.answerReview)}` : '<p class="muted">等待回答</p>'}${renderRetries(turn.retries)}${session.status === "completed" && turn.answerText ? `<form class="interview-retry-form" method="post" action="/api/interview/retry" data-interview-submit><input type="hidden" name="planId" value="${escapeAttr(planId)}"><input type="hidden" name="sessionId" value="${escapeAttr(session.id)}"><input type="hidden" name="turnNumber" value="${escapeAttr(turn.turnNumber)}"><label>重答这题<textarea name="answerText" rows="5" maxlength="20000" required></textarea><small>新回答会与原回答并列保存，不覆盖历史。</small></label><button class="secondary">保存重答并比较</button></form>` : ""}</article>`).join("")}</div></section>`;
}

function renderAnswerReview(review) {
  if (!review) return "";
  return `<div class="interview-turn-review"><strong>即时复盘</strong><p>${escapeHtml(review.conclusion || "")}</p><div><span>做得好</span>${renderTextList(review.strengths)}</div><div><span>下一步</span>${renderTextList(review.improvements)}</div></div>`;
}

function renderRetries(retries = []) {
  if (!retries.length) return "";
  return `<div class="interview-retries"><strong>重答对比</strong>${retries.map((retry) => `<section><span>第 ${escapeHtml(retry.retryIndex)} 次重答</span><p>${escapeHtml(retry.answerText)}</p><small>${escapeHtml(retry.review?.conclusion || "已保存重答")}</small>${renderTextList(retry.review?.remainingImprovements)}</section>`).join("")}</div>`;
}

function renderHistory(dashboard, selected) {
  const planId = dashboard.plan?.id || "";
  const history = (dashboard.sessions || []).filter((session) => Number(session.id) !== Number(selected.id));
  if (!history.length) return "";
  return `<section class="card pad interview-history"><p class="section-label">历史训练</p><h3>继续或复盘以前的会话</h3><ul>${history.map((session) => `<li><a href="/interview?planId=${escapeAttr(planId)}&amp;sessionId=${escapeAttr(session.id)}">${escapeHtml(session.context?.job?.title || `模拟面试 ${session.id}`)}</a><span>${session.status === "completed" ? "已完成" : "进行中"}</span></li>`).join("")}</ul></section>`;
}

function renderTextList(items = []) {
  return items.length ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : '<p class="muted">本轮没有单独记录</p>';
}

function renderTurnReasons(items = []) {
  return items.length ? `<ul>${items.map((item) => `<li><strong>第 ${escapeHtml(item.turnNumber)} 题</strong><span>${escapeHtml(item.reason)}</span></li>`).join("")}</ul>` : '<p class="muted">本轮没有单独记录</p>';
}

function renderStructures(items = []) {
  return items.length ? `<ul>${items.map((item) => `<li><strong>第 ${escapeHtml(item.turnNumber)} 题</strong><span>${(item.outline || []).map(escapeHtml).join(" → ")}</span></li>`).join("")}</ul>` : '<p class="muted">本轮没有单独记录</p>';
}

function typeLabel(value) {
  return { mixed: "综合面试", technical: "技术 / 业务", behavioral: "行为问题", general: "通用沟通" }[value] || "综合面试";
}

function difficultyLabel(value) {
  return { warmup: "热身", standard: "标准", challenging: "高压追问" }[value] || "标准";
}

function focusLabel(value) {
  return { intro: "自我介绍", motivation: "岗位动机", project: "项目深挖", technical: "技术 / 业务", behavioral: "行为问题", pressure: "压力追问", questions: "反问" }[value] || value || "岗位问题";
}

const MOCK_INTERVIEW_SCRIPT = `<script>(()=>{for(const form of document.querySelectorAll('[data-interview-submit]')){form.addEventListener('submit',()=>{const button=form.querySelector('button');if(button){button.disabled=true;button.textContent='处理中…';}});}})();</script>`;

module.exports = { renderMockInterviewPage, MOCK_INTERVIEW_SCRIPT };
