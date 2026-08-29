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
        <p class="eyebrow">阶段四 · 简历通用训练优先</p>
        <h1 id="interview-title">模拟面试训练</h1>
        <p class="lede">无需面试邀请：默认直接基于当前简历练习每位面试官都可能追问的内容；有合适岗位时，也可以切换到岗位专项面试。追问会承接你的上一条回答，结束后再做具体到题号的复盘和重练。</p>
        <div class="heading-meta"><span>${escapeHtml(plan.name || "当前筛选方案")}</span><span>本地文字练习</span><span>不会写入候选人事实</span></div>
      </section>
      ${selected ? `<details class="interview-new-session"><summary>开始另一轮训练</summary>${renderStartPanel(dashboard, modelReady)}</details>` : renderStartPanel(dashboard, modelReady)}
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
    <div class="interview-section-head"><div><p class="section-label">开始一轮训练</p><h2 id="interview-start-title">选择训练范围、简历与设置</h2></div><span class="status ${modelReady ? "good" : "waiting"}">${modelReady ? "深度分析可用" : "模型待配置"}</span></div>
    ${modelReady ? "" : '<p class="alert">当前深度分析模型不可用。<a href="/settings">前往模型设置</a>完成连接后再开始。</p>'}
    <form class="interview-start-form" method="post" action="/api/interview/start" data-interview-submit data-interview-success-target="interview-active-step">
      <input type="hidden" name="planId" value="${escapeAttr(plan.id || "")}">
      <fieldset class="interview-mode-picker"><legend>训练范围</legend>
        <label><input type="radio" name="sessionKind" value="resume_general" checked><span><strong>简历通用面试</strong><small>推荐 · 不需要面试邀请，只围绕简历中的真实经历训练。</small></span></label>
        <label><input type="radio" name="sessionKind" value="job_specific"${jobs.length ? "" : " disabled"}><span><strong>岗位专项面试</strong><small>${jobs.length ? "可选 · 在简历训练上补充完整 JD 可能涉及的问题。" : "暂无资料完整的岗位，暂时不能选择。"}</small></span></label>
      </fieldset>
      <div class="interview-job-panel" data-interview-job-panel hidden><label>目标岗位<select name="jobId" disabled>${jobs.map((job) => `<option value="${escapeAttr(job.id)}">${escapeHtml(job.title || "未命名岗位")} · ${escapeHtml(job.company || "公司未记录")}</option>`).join("")}</select></label></div>
      <label>简历版本<select name="resumeVersionId" required>${resumes.map((resume) => `<option value="${escapeAttr(resume.id)}"${activeResume?.id === resume.id ? " selected" : ""}>${escapeHtml(resume.name || "简历版本")}${resume.isActive ? " · 当前使用" : ""}</option>`).join("")}</select></label>
      <label>题目侧重<select name="type"><option value="mixed">综合面试</option><option value="technical">技术 / 业务</option><option value="behavioral">行为问题</option><option value="general">自我介绍与沟通</option></select></label>
      <label>难度<select name="difficulty"><option value="standard">标准</option><option value="warmup">热身</option><option value="challenging">高压追问</option></select></label>
      <label>计划题数<select name="plannedQuestions"><option value="3">3 题 · 快速练习</option><option value="5" selected>5 题 · 推荐</option><option value="8">8 题 · 完整练习</option><option value="12">12 题 · 深入练习</option></select></label>
      <div class="button-row"><button${!modelReady || !resumes.length ? " disabled" : ""}>开始模拟面试</button><span class="hint">训练范围和简历会冻结在本轮记录中，后续更新不会悄悄切换上下文。</span></div>
      <p class="alert" data-interview-error role="alert"></p>
    </form>
  </section>`;
}

function renderEmptyState() {
  return `<section class="card pad interview-empty"><p class="section-label">还没有训练记录</p><h2>先从上方开始一轮</h2><p>通用训练的首题会直接使用当前简历；从第二题起，问题会继续承接你刚刚写下的回答。</p></section>`;
}

function renderSession(dashboard, session) {
  const completed = session.status === "completed";
  const general = sessionKind(session) === "resume_general";
  const title = general ? "简历通用面试" : session.context?.job?.title || "岗位专项面试";
  const subtitle = general
    ? `基于 ${session.context?.resume?.name || `简历版本 ${session.resumeVersionId}`} 的通用训练`
    : session.context?.job?.company || "公司未记录";
  const transcript = renderTranscript(dashboard, session);
  const history = renderHistory(dashboard, session);
  const pastAnswers = transcript && !completed
    ? `<details class="interview-past-answers"><summary>查看已答题目和即时复盘</summary>${transcript}</details>`
    : transcript;
  const pastSessions = history && !completed
    ? `<details class="interview-past-sessions"><summary>查看历史训练</summary>${history}</details>`
    : history;
  return `<section class="interview-workspace interview-workbench" aria-labelledby="interview-session-title">
    <div class="interview-session-head"><div><p class="section-label">${completed ? "本轮训练已完成" : "训练进行中"}</p><h2 id="interview-session-title">${escapeHtml(title)}</h2><p>${escapeHtml(subtitle)}</p></div><span class="status ${completed ? "good" : "waiting"}">${completed ? "可复盘和重练" : `第 ${(session.turns || []).length} / ${escapeHtml(session.settings?.plannedQuestions || "-")} 题`}</span></div>
    ${renderBinding(session)}
    ${completed ? renderReport(session) : renderCurrentQuestion(dashboard, session)}
    ${pastAnswers}
    ${pastSessions}
  </section>`;
}

function renderBinding(session) {
  const general = sessionKind(session) === "resume_general";
  const scope = general
    ? "通用训练 · 不绑定岗位"
    : `${session.context?.job?.title || "岗位"} · ${session.context?.job?.company || "公司未记录"}`;
  return `<dl class="interview-binding"><div><dt>${general ? "训练范围" : "冻结岗位"}</dt><dd>${escapeHtml(scope)}</dd></div><div><dt>冻结简历</dt><dd>${escapeHtml(session.context?.resume?.name || `简历版本 ${session.resumeVersionId}`)}</dd></div><div><dt>训练设置</dt><dd>${escapeHtml(`${typeLabel(session.settings?.type)} · ${difficultyLabel(session.settings?.difficulty)} · ${session.settings?.plannedQuestions || "-"} 题`)}</dd></div></dl>`;
}

function renderCurrentQuestion(dashboard, session) {
  const turns = session.turns || [];
  const current = turns[turns.length - 1];
  const planId = dashboard.plan?.id || "";
  if (!current) return `<section class="card pad alert"><strong>首题尚未生成</strong><p>请返回历史记录重新打开；当前冻结会话不会丢失。</p></section>`;
  if (current.answerText) {
    const canFinish = turns.length >= Number(session.settings?.plannedQuestions || 0);
    return canFinish ? `<section id="interview-active-step" class="card pad interview-finish"><p class="section-label">题目已完成</p><h3>生成本轮复盘</h3><p>复盘会引用具体题号，不会把训练分数包装成录用概率。</p><form method="post" action="/api/interview/finish" data-interview-submit data-interview-success-target="interview-report-title"><input type="hidden" name="planId" value="${escapeAttr(planId)}"><input type="hidden" name="sessionId" value="${escapeAttr(session.id)}"><button>结束并生成复盘</button><p class="alert" data-interview-error role="alert"></p></form></section>` : "";
  }
  return `<section id="interview-active-step" class="interview-current interview-current-question" aria-labelledby="interview-current-question">
    <div class="interview-question-number">Q${escapeHtml(current.turnNumber)}</div>
    <div><p class="section-label">当前问题 · ${escapeHtml(focusLabel(current.questionFocus))}</p><h3 id="interview-current-question">${escapeHtml(current.questionText)}</h3>${renderQuestionEvidence(session, current)}${current.basedOnTurnNumber ? `<p class="interview-followup">这是一道承接第 ${escapeHtml(current.basedOnTurnNumber)} 题回答的追问。</p>` : ""}
      <form method="post" action="/api/interview/answer" data-interview-submit data-interview-draft="answer" data-interview-success-target="interview-active-step"><input type="hidden" name="planId" value="${escapeAttr(planId)}"><input type="hidden" name="sessionId" value="${escapeAttr(session.id)}"><input type="hidden" name="turnNumber" value="${escapeAttr(current.turnNumber)}"><label>我的回答<textarea name="answerText" rows="8" maxlength="20000" required autofocus></textarea><small>按真实经历作答。提交后会直接保存并生成下一题，不会再二次确认。</small></label><button>提交回答并继续</button><p class="alert" data-interview-error role="alert"></p></form>
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
  const turns = (session.turns || []).filter((turn) => turn.answerText);
  const planId = dashboard.plan?.id || "";
  if (!turns.length) return "";
  return `<section class="interview-transcript" aria-labelledby="interview-transcript-title"><div class="interview-section-head"><div><p class="section-label">逐题记录</p><h3 id="interview-transcript-title">问题、原回答与复盘</h3></div><span>${turns.length} 题已答</span></div><div class="interview-turn-list">${turns.map((turn) => `<article id="interview-turn-${escapeAttr(turn.turnNumber)}" class="interview-turn"><header><span>Q${escapeHtml(turn.turnNumber)}</span><div><p>${escapeHtml(focusLabel(turn.questionFocus))}</p><h4>${escapeHtml(turn.questionText)}</h4>${renderQuestionEvidence(session, turn)}</div></header><div class="interview-answer"><strong>原回答</strong><p>${escapeHtml(turn.answerText)}</p></div>${renderAnswerReview(turn.answerReview)}${renderRetries(turn.retries)}${session.status === "completed" ? `<form class="interview-retry-form" method="post" action="/api/interview/retry" data-interview-submit data-interview-draft="retry" data-interview-success-target="interview-turn-${escapeAttr(turn.turnNumber)}"><input type="hidden" name="planId" value="${escapeAttr(planId)}"><input type="hidden" name="sessionId" value="${escapeAttr(session.id)}"><input type="hidden" name="turnNumber" value="${escapeAttr(turn.turnNumber)}"><label>重答这题<textarea name="answerText" rows="5" maxlength="20000" required></textarea><small>新回答会与原回答并列保存，不覆盖历史。</small></label><button class="secondary">保存重答并比较</button><p class="alert" data-interview-error role="alert"></p></form>` : ""}</article>`).join("")}</div></section>`;
}

function renderAnswerReview(review) {
  if (!review) return "";
  return `<div class="interview-turn-review"><strong>即时复盘</strong><p>${escapeHtml(review.conclusion || "")}</p><div><span>做得好</span>${renderTextList(review.strengths)}</div><div><span>下一步</span>${renderTextList(review.improvements)}</div></div>`;
}

function renderRetries(retries = []) {
  if (!retries.length) return "";
  return `<div class="interview-retries"><strong>重答对比</strong>${retries.map((retry) => `<section><span>第 ${escapeHtml(retry.retryIndex)} 次重答</span><p>${escapeHtml(retry.answerText)}</p><small>${escapeHtml(retry.review?.conclusion || "已保存重答")}</small>${renderTextList(retry.review?.remainingImprovements)}</section>`).join("")}</div>`;
}

function renderQuestionEvidence(session, turn) {
  const catalog = new Map((session.context?.resumeEvidenceCatalog || [])
    .map((item) => [String(item?.id || ""), item]));
  const evidence = (turn.resumeEvidenceIds || []).map((id) => catalog.get(String(id))).filter(Boolean);
  if (!evidence.length) return "";
  return `<div class="interview-question-evidence"><strong>这道题来自简历</strong><ul>${evidence.map((item) => `<li>${escapeHtml(compactEvidence(item.text))}</li>`).join("")}</ul></div>`;
}

function compactEvidence(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > 360 ? `${text.slice(0, 357)}…` : text;
}

function sessionKind(session) {
  return session.sessionKind || session.context?.sessionKind || "job_specific";
}

function renderHistory(dashboard, selected) {
  const planId = dashboard.plan?.id || "";
  const history = (dashboard.sessions || []).filter((session) => Number(session.id) !== Number(selected.id));
  if (!history.length) return "";
  return `<section class="card pad interview-history"><p class="section-label">历史训练</p><h3>继续或复盘以前的会话</h3><ul>${history.map((session) => `<li><a href="/interview?planId=${escapeAttr(planId)}&amp;sessionId=${escapeAttr(session.id)}">${escapeHtml(sessionKind(session) === "resume_general" ? "简历通用面试" : session.context?.job?.title || `岗位专项面试 ${session.id}`)}</a><span>${session.status === "completed" ? "已完成" : "进行中"}</span></li>`).join("")}</ul></section>`;
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
  return { mixed: "综合面试", technical: "技术 / 业务", behavioral: "行为问题", general: "自我介绍与沟通" }[value] || "综合面试";
}

function difficultyLabel(value) {
  return { warmup: "热身", standard: "标准", challenging: "高压追问" }[value] || "标准";
}

function focusLabel(value) {
  return { intro: "自我介绍", motivation: "岗位动机", project: "项目深挖", technical: "技术 / 业务", behavioral: "行为问题", pressure: "压力追问", questions: "反问" }[value] || value || "岗位问题";
}

const MOCK_INTERVIEW_SCRIPT = `<script>(()=>{const reveal=()=>{const target=location.hash&&document.getElementById(location.hash.slice(1));if(target)setTimeout(()=>target.scrollIntoView({block:'start'}),0);};if(document.readyState==='complete')reveal();else addEventListener('load',reveal,{once:true});const start=document.querySelector('.interview-start-form');if(start){const panel=start.querySelector('[data-interview-job-panel]');const job=panel&&panel.querySelector('select[name="jobId"]');const sync=()=>{const selected=start.querySelector('input[name="sessionKind"]:checked');const specific=selected&&selected.value==='job_specific';if(panel)panel.hidden=!specific;if(job){job.disabled=!specific;job.required=!!specific;}};for(const radio of start.querySelectorAll('input[name="sessionKind"]'))radio.addEventListener('change',sync);sync();}const storage={get:(key)=>{try{return localStorage.getItem(key)}catch{return null}},set:(key,value)=>{try{localStorage.setItem(key,value)}catch{}},remove:(key)=>{try{localStorage.removeItem(key)}catch{}}};const navigate=(url,target)=>{const base=String(url||'').split('#')[0];const destination=base+(target?'#'+target:'');if(location.href.split('#')[0]===base){location.hash=target;location.reload();}else location.assign(destination);};for(const form of document.querySelectorAll('[data-interview-submit]')){const field=form.querySelector('textarea[name="answerText"]');const kind=form.dataset.interviewDraft||'';const sessionId=form.elements.sessionId?.value||'';const turnNumber=form.elements.turnNumber?.value||'';const key=field&&kind&&sessionId&&turnNumber?'roleflow:interview-draft:'+sessionId+':'+turnNumber+':'+kind:'';if(key&&!field.value){const saved=storage.get(key);if(saved!==null)field.value=saved;}if(key)field.addEventListener('input',()=>storage.set(key,field.value));form.addEventListener('submit',async(event)=>{event.preventDefault();const button=event.submitter||form.querySelector('button');const label=button?.textContent||'';const error=form.querySelector('[data-interview-error]');if(error)error.textContent='';if(button){button.disabled=true;button.textContent='处理中…';}try{const response=await fetch(form.action,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(new FormData(form))});if(!response.ok){const text=await response.text();let message='操作失败，请稍后重试。';try{message=JSON.parse(text).error||message}catch{}throw new Error(message);}if(key)storage.remove(key);navigate(response.url||form.action,form.dataset.interviewSuccessTarget||'');}catch(failure){if(error)error.textContent=failure.message||'操作失败，请稍后重试。';if(button){button.disabled=false;button.textContent=label;}}});}})();</script>`;

module.exports = { renderMockInterviewPage, MOCK_INTERVIEW_SCRIPT };
