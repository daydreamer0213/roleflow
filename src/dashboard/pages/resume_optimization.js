const { escapeHtml, escapeAttr } = require("../http/response");
const { renderDashboardFrame } = require("../ui/shell");

function renderResumeOptimizationPage({ dashboard = {}, modelReady = true } = {}) {
  const plan = dashboard.plan || {};
  const planId = Number(plan.id || 0);
  const selected = dashboard.selectedDraft || null;
  const currentPath = `/resume-optimization?planId=${encodeURIComponent(planId)}${selected ? `&draftId=${encodeURIComponent(selected.id)}` : ""}`;
  const todayPath = `/plan?planId=${encodeURIComponent(planId)}`;
  return renderDashboardFrame({
    currentPath,
    todayPath,
    planId,
    stage: "定向简历",
    brandHref: todayPath,
    content: `<main id="main-content" class="resume-opt-main">
      <section class="page-heading" aria-labelledby="resume-opt-title">
        <p class="eyebrow">阶段三 · 本地材料优化</p>
        <h1 id="resume-opt-title">定向简历优化</h1>
        <p class="lede">选择一份现有简历和资料完整的目标岗位。每条建议都带原文锚点与证据，只有你的选择和编辑才会进入新版本。</p>
        <div class="heading-meta"><span>${escapeHtml(plan.name || "当前筛选方案")}</span><span>源简历永不覆盖</span></div>
      </section>
      ${renderCreatePanel(dashboard, modelReady)}
      ${selected ? renderSelectedDraft(dashboard, selected) : renderEmptyState()}
    </main><p class="footer-note">本页只读写 RoleFlow 本地数据；不会访问 BOSS、不会投递、不会填写或发送任何外部内容。</p>`,
  });
}

function renderCreatePanel(dashboard, modelReady) {
  const plan = dashboard.plan || {};
  const resumes = dashboard.resumes || [];
  const jobs = dashboard.jobs || [];
  const activeResume = resumes.find((resume) => resume.isActive) || resumes[0] || null;
  return `<section class="card pad resume-opt-create" aria-labelledby="resume-opt-create-title">
    <div class="resume-opt-section-head"><div><p class="section-label">开始一次优化</p><h2 id="resume-opt-create-title">冻结源简历与目标岗位</h2></div><span class="status ${modelReady ? "good" : "waiting"}">${modelReady ? "深度分析可用" : "模型待配置"}</span></div>
    ${modelReady ? "" : '<p class="alert">当前深度分析模型不可用。<a href="/settings">前往模型设置</a>完成连接后再生成草稿。</p>'}
    <form class="resume-opt-create-form" method="post" action="/api/resume-optimization">
      <input type="hidden" name="planId" value="${escapeAttr(plan.id || "")}">
      <label>源简历版本<select name="sourceResumeVersionId" required>${resumes.map((resume) => `<option value="${escapeAttr(resume.id)}"${activeResume?.id === resume.id ? " selected" : ""}>${escapeHtml(resume.name || "简历版本")}${resume.isActive ? " · 当前使用" : ""}</option>`).join("")}</select></label>
      <fieldset><legend>目标岗位 <span>首选 1 个；明确相似时最多 5 个</span></legend><div class="resume-opt-job-list">${jobs.length ? jobs.map((job, index) => `<label class="resume-opt-job"><input type="checkbox" name="jobIds" value="${escapeAttr(job.id)}"${index === 0 ? " checked" : ""}><span><strong>${escapeHtml(job.title || "未命名岗位")}</strong><small>${escapeHtml(job.company || "公司未记录")}</small></span></label>`).join("") : '<p class="muted">当前方案还没有同时具备完整 JD 和岗位分析的岗位。</p>'}</div></fieldset>
      <div class="button-row"><button${!modelReady || !resumes.length || !jobs.length ? " disabled" : ""}>生成证据草稿</button><span class="hint">生成失败不会创建半成品，也不会修改任何简历版本。</span></div>
    </form>
  </section>`;
}

function renderEmptyState() {
  return `<section class="card pad resume-opt-empty"><p class="section-label">尚未选择草稿</p><h2>先从上方选择简历和岗位</h2><p>RoleFlow 会先冻结这次使用的源材料，再生成最多 12 条可逐项处理的建议。</p></section>`;
}

function renderSelectedDraft(dashboard, draft) {
  const evidence = new Map((draft.evidenceCatalog || []).map((item) => [String(item.id), item]));
  const resume = (dashboard.resumes || []).find((item) => Number(item.id) === Number(draft.sourceResumeVersionId));
  const jobs = (dashboard.jobs || []).filter((item) => (draft.targetJobIds || []).includes(Number(item.id)));
  const activated = draft.status === "activated";
  return `<section class="resume-opt-workspace" aria-labelledby="resume-opt-draft-title">
    <div class="resume-opt-conclusion"><div><p class="section-label">当前优化结论</p><h2 id="resume-opt-draft-title">${escapeHtml(draft.headline || "逐条核对后再启用新版本")}</h2></div><span class="status ${activated ? "good" : "waiting"}">${activated ? "已启用新版本" : "等待你的处理"}</span></div>
    <dl class="resume-opt-binding"><div><dt>冻结源简历</dt><dd>${escapeHtml(resume?.name || `简历版本 ${draft.sourceResumeVersionId}`)}</dd></div><div><dt>目标岗位</dt><dd>${jobs.length ? jobs.map((job) => escapeHtml(`${job.title || "岗位"} · ${job.company || "公司未记录"}`)).join("<br>") : "已冻结岗位"}</dd></div><div><dt>模型来源</dt><dd>${escapeHtml([draft.modelIdentity?.provider, draft.modelIdentity?.model].filter(Boolean).join(" · ") || "本地记录")}</dd></div></dl>
    ${activated ? renderActivatedNotice(dashboard, draft) : renderSuggestionForm(dashboard, draft, evidence)}
    ${renderFinalText(dashboard, draft)}
    ${renderHistory(dashboard, draft)}
  </section>`;
}

function renderSuggestionForm(dashboard, draft, evidence) {
  const planId = dashboard.plan?.id || "";
  return `<form class="resume-opt-suggestions" method="post" action="/api/resume-optimization/save" data-resume-suggestions>
    <input type="hidden" name="planId" value="${escapeAttr(planId)}"><input type="hidden" name="draftId" value="${escapeAttr(draft.id)}">
    <div class="resume-opt-list">${(draft.suggestions || []).map((suggestion, index) => renderSuggestion(suggestion, index, evidence)).join("")}</div>
    <div class="resume-opt-savebar"><span>用户编辑会直接成为本地确认文字，不再二次询问。</span><button>保存选择并更新全文</button></div>
  </form>`;
}

function renderSuggestion(suggestion, index, evidence) {
  const id = String(suggestion.id || `S${index + 1}`);
  const selected = String(suggestion.decision || "pending");
  const editText = suggestion.userText || suggestion.proposedText || "";
  const cited = (suggestion.evidenceIds || []).map((evidenceId) => evidence.get(String(evidenceId))).filter(Boolean);
  return `<article class="resume-opt-suggestion" aria-labelledby="resume-suggestion-${escapeAttr(id)}">
    <div class="resume-opt-index" aria-hidden="true">${escapeHtml(id)}</div>
    <div class="resume-opt-suggestion-body"><div class="resume-opt-suggestion-head"><div><p class="section-label">${escapeHtml(operationLabel(suggestion.operation))}</p><h3 id="resume-suggestion-${escapeAttr(id)}">${escapeHtml(suggestion.reason || "核对这条修改")}</h3></div><details><summary>查看 ${cited.length} 条证据</summary><ul>${cited.map((item) => `<li><strong>${escapeHtml(item.id)}</strong><span>${escapeHtml(item.text)}</span></li>`).join("")}</ul></details></div>
      <div class="resume-opt-compare"><div><span>原文</span><p>${escapeHtml(suggestion.originalText || "")}</p></div><div><span>建议</span><p>${escapeHtml(suggestion.proposedText || "删除这段文字")}</p></div></div>
      <fieldset class="resume-opt-decision"><legend>这条怎么处理</legend><label><input type="radio" name="decision_${escapeAttr(id)}" value="accepted"${selected === "accepted" ? " checked" : ""} required>采用建议</label><label><input type="radio" name="decision_${escapeAttr(id)}" value="edited"${selected === "edited" ? " checked" : ""}>采用我的编辑</label><label><input type="radio" name="decision_${escapeAttr(id)}" value="ignored"${selected === "ignored" ? " checked" : ""}>保留原文</label></fieldset>
      <label class="resume-opt-edit">我的版本<textarea name="userText_${escapeAttr(id)}" data-resume-edit="${escapeAttr(id)}" rows="3">${escapeHtml(editText)}</textarea><small>只要修改这里，页面会自动选择“采用我的编辑”。</small></label>
    </div>
  </article>`;
}

function renderFinalText(dashboard, draft) {
  const planId = dashboard.plan?.id || "";
  const text = draft.finalText || draft.sourceText || "";
  return `<section class="card pad resume-opt-final" aria-labelledby="resume-opt-final-title"><div class="resume-opt-section-head"><div><p class="section-label">当前完整版本</p><h2 id="resume-opt-final-title">可复制全文</h2></div><button class="secondary" type="button" data-copy-resume>复制当前全文</button></div><textarea id="resume-opt-final-text" readonly rows="18">${escapeHtml(text)}</textarea>${draft.status === "draft" ? `<form method="post" action="/api/resume-optimization/activate"><input type="hidden" name="planId" value="${escapeAttr(planId)}"><input type="hidden" name="draftId" value="${escapeAttr(draft.id)}"><button${!draft.finalText ? " disabled" : ""}>启用为新版本</button>${!draft.finalText ? '<span class="hint">先保存上面的选择，生成最终全文后即可启用。</span>' : ""}</form>` : `<p class="notice">已创建新的简历版本 #${escapeHtml(draft.resultResumeVersionId || "")}; 源简历仍保持原样。</p>`}</section>`;
}

function renderActivatedNotice(dashboard, draft) {
  return `<section class="alert good"><strong>这份草稿已经启用</strong><p>新版本已进入 RoleFlow 的简历版本列表；重复点击或刷新不会再创建另一份。</p><a href="/resumes?profileId=${escapeAttr(dashboard.profile?.id || draft.profileId)}">查看全部简历版本</a></section>`;
}

function renderHistory(dashboard, selected) {
  const planId = dashboard.plan?.id || "";
  const history = (dashboard.drafts || []).filter((draft) => Number(draft.id) !== Number(selected.id));
  if (!history.length) return "";
  return `<section class="card pad resume-opt-history"><p class="section-label">历史草稿</p><h2>保留每次源材料与处理结果</h2><ul>${history.map((draft) => `<li><a href="/resume-optimization?planId=${escapeAttr(planId)}&amp;draftId=${escapeAttr(draft.id)}">${escapeHtml(draft.headline || `定向简历草稿 ${draft.id}`)}</a><span>${draft.status === "activated" ? "已启用" : "草稿"}</span></li>`).join("")}</ul></section>`;
}

function operationLabel(operation) {
  return { replace: "替换原文", remove: "删除原文", insert_after: "在原文后补充" }[operation] || "修改建议";
}

const RESUME_OPTIMIZATION_SCRIPT = `<script>(()=>{for(const textarea of document.querySelectorAll('[data-resume-edit]')){textarea.addEventListener('input',()=>{const id=textarea.getAttribute('data-resume-edit');const radio=document.querySelector('input[name="decision_'+CSS.escape(id)+'"][value="edited"]');if(radio)radio.checked=true;});}const copy=document.querySelector('[data-copy-resume]');if(copy)copy.addEventListener('click',async()=>{const text=document.getElementById('resume-opt-final-text');if(!text)return;await navigator.clipboard.writeText(text.value);copy.textContent='已复制';});})();</script>`;

module.exports = { renderResumeOptimizationPage, RESUME_OPTIMIZATION_SCRIPT };
