const { escapeHtml, escapeAttr } = require("../http/response");
const { renderDashboardFrame } = require("../ui/shell");

const PRINCIPLE_LABELS = {
  relevance_order: "相关内容排序",
  contribution_clarity: "贡献边界清晰",
  result_visibility: "结果更易看见",
  jd_vocabulary: "岗位用词对齐",
  concision: "表达精简",
  structure: "结构调整"
};

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
        <p class="lede">选择源简历和目标投递方向，RoleFlow 会从该方向自动选择代表岗位，直接生成一份可以继续修改的完整草稿。</p>
        <div class="heading-meta"><span>${escapeHtml(plan.name || "当前筛选方案")}</span><span>原简历永不覆盖</span></div>
      </section>
      ${renderCreatePanel(dashboard, modelReady)}
      ${selected ? renderSelectedDraft(dashboard, selected) : renderEmptyState()}
    </main><p class="footer-note">本页只读写 RoleFlow 本地数据；不会访问 BOSS、不会投递、不会填写或发送任何外部内容。</p>`
  });
}

function renderCreatePanel(dashboard, modelReady) {
  const plan = dashboard.plan || {};
  const resumes = dashboard.resumes || [];
  const jobs = dashboard.jobs || [];
  const directions = dashboard.directions || [];
  const activeResume = resumes.find((resume) => resume.isActive) || resumes[0] || null;
  const ready = modelReady && resumes.length > 0 && jobs.length > 0 && directions.length > 0;
  return `<section class="card pad resume-opt-create" aria-labelledby="resume-opt-create-title">
    <div class="resume-opt-section-head"><div><p class="section-label">开始一次优化</p><h2 id="resume-opt-create-title">选择简历与投递方向</h2></div><span class="status ${modelReady ? "good" : "waiting"}">${modelReady ? "深度分析可用" : "模型待配置"}</span></div>
    ${modelReady ? "" : '<p class="alert">当前深度分析模型不可用。<a href="/settings">前往模型设置</a>完成连接后再生成草稿。</p>'}
    <form class="resume-opt-create-form" method="post" action="/api/resume-optimization" data-resume-submit>
      <input type="hidden" name="planId" value="${escapeAttr(plan.id || "")}">
      <label>源简历版本<select name="sourceResumeVersionId" required>${resumes.map((resume) => `<option value="${escapeAttr(resume.id)}"${activeResume?.id === resume.id ? " selected" : ""}>${escapeHtml(resume.name || "简历版本")}${resume.isActive ? " · 当前使用" : ""}</option>`).join("")}</select></label>
      <label>目标投递方向<select name="targetDirection" required><option value="">请选择方向</option>${directions.map((direction) => `<option value="${escapeAttr(direction)}">${escapeHtml(direction)}</option>`).join("")}</select><small>系统会自动挑选 3–5 个资料完整、公司尽量不同的代表岗位。</small></label>
      ${jobs.length ? "" : '<p class="muted resume-opt-create-note">当前方案还没有可信的完整 JD，暂时不能生成定向版本。</p>'}
      <div class="button-row"><button${ready ? "" : " disabled"}>生成完整草稿</button><span class="hint">所有修改通过证据校验后才会保存；失败不会留下半成品。</span></div>
      <p class="alert" data-resume-error role="alert"></p>
    </form>
  </section>`;
}

function renderEmptyState() {
  return `<section class="card pad resume-opt-empty"><p class="section-label">尚未生成草稿</p><h2>先选择简历和方向</h2><p>RoleFlow 会生成一份完整版本，你可以直接在全文上继续修改，不需要逐条确认建议。</p></section>`;
}

function renderSelectedDraft(dashboard, draft) {
  const evidence = new Map((draft.evidenceCatalog || []).map((item) => [String(item.id), item]));
  const resume = (dashboard.resumes || []).find((item) => Number(item.id) === Number(draft.sourceResumeVersionId));
  const jobs = dashboard.selectedJobs || [];
  const activated = draft.status === "activated";
  return `<section class="resume-opt-workspace" aria-labelledby="resume-opt-draft-title">
    <div class="resume-opt-conclusion"><div><p class="section-label">当前优化结论</p><h2 id="resume-opt-draft-title">${escapeHtml(draft.headline || "完整定向简历草稿")}</h2></div><span class="status ${activated ? "good" : "waiting"}">${activated ? "已启用新版本" : "可以继续编辑"}</span></div>
    <dl class="resume-opt-binding"><div><dt>冻结源简历</dt><dd>${escapeHtml(resume?.name || `简历版本 ${draft.sourceResumeVersionId}`)}</dd></div><div><dt>目标投递方向</dt><dd>${escapeHtml(draft.targetDirection || "历史草稿未记录")}</dd></div><div><dt>模型来源</dt><dd>${escapeHtml([draft.modelIdentity?.provider, draft.modelIdentity?.model].filter(Boolean).join(" · ") || "本地记录")}</dd></div></dl>
    ${renderSelectedJobs(jobs)}
    ${draft.draftFormat === "whole_draft" ? renderWholeDraft(dashboard, draft, evidence) : renderLegacyDraft(draft, evidence)}
    ${activated ? renderActivatedNotice(dashboard, draft) : ""}
    ${renderHistory(dashboard, draft)}
  </section>`;
}

function renderSelectedJobs(jobs) {
  return `<section class="card pad resume-opt-jobs" aria-labelledby="resume-opt-jobs-title"><p class="section-label">本次参考岗位</p><h2 id="resume-opt-jobs-title">系统自动选择的代表样本</h2><div class="resume-opt-selected-jobs">${jobs.length ? jobs.map((job) => `<article><strong>${escapeHtml(job.title || "未命名岗位")}</strong><span>${escapeHtml(job.company || "公司未记录")}</span></article>`).join("") : '<p class="muted">历史草稿的岗位记录仍保留在本地。</p>'}</div></section>`;
}

function renderWholeDraft(dashboard, draft, evidence) {
  const planId = dashboard.plan?.id || "";
  const activated = draft.status === "activated";
  return `<form class="card pad resume-opt-editor" method="post" action="/api/resume-optimization/save" data-resume-editor data-resume-submit>
    <input type="hidden" name="planId" value="${escapeAttr(planId)}"><input type="hidden" name="draftId" value="${escapeAttr(draft.id)}">
    <div class="resume-opt-section-head"><div><p class="section-label">完整简历草稿</p><h2>${draft.userEditedAt ? "用户已修改" : "系统生成版本"}</h2></div><button class="secondary" type="button" data-copy-resume>复制当前全文</button></div>
    <label class="resume-opt-full-editor" for="resume-opt-final-text">当前全文<textarea id="resume-opt-final-text" name="finalText" rows="22"${activated ? " readonly" : ""}>${escapeHtml(draft.finalText || draft.generatedText || "")}</textarea></label>
    ${activated ? `<p class="notice">已创建新的简历版本 #${escapeHtml(draft.resultResumeVersionId || "")}；源简历仍保持原样。</p>` : `<div class="resume-opt-savebar"><span data-resume-save-status aria-live="polite">修改后会在 600 毫秒内自动保存。</span><div class="button-row"><button class="secondary" type="submit">保存草稿</button><button type="submit" formaction="/api/resume-optimization/activate">启用为新版本</button></div></div>`}
  </form>${renderChangeLedger(draft.changeLedger || draft.suggestions || [], evidence, Boolean(draft.userEditedAt))}`;
}

function renderChangeLedger(changes, evidence, userEdited) {
  return `<section class="card pad resume-opt-ledger" aria-labelledby="resume-opt-ledger-title"><p class="section-label">修改了什么</p><h2 id="resume-opt-ledger-title">系统生成基线的只读修改说明</h2>${userEdited ? '<p class="hint">你后续对全文的修改以当前文字为准；下方说明只对应系统最初生成的版本。</p>' : ""}<div class="resume-opt-list">${changes.map((change, index) => renderLedgerItem(change, index, evidence)).join("")}</div></section>`;
}

function renderLedgerItem(change, index, evidence) {
  const cited = (change.evidenceIds || []).map((id) => evidence.get(String(id))).filter(Boolean);
  return `<article class="resume-opt-ledger-item"><div class="resume-opt-index" aria-hidden="true">${escapeHtml(change.id || `S${index + 1}`)}</div><div><div class="resume-opt-ledger-head"><span>${escapeHtml(PRINCIPLE_LABELS[change.editingPrinciple] || "结构化修改")}</span><strong>${escapeHtml(change.reason || "让相关经历更清楚")}</strong></div><div class="resume-opt-compare"><div><span>原文</span><p>${escapeHtml(change.originalText || "")}</p></div><div><span>系统生成</span><p>${escapeHtml(change.proposedText || "删除这段文字")}</p></div></div><details><summary>查看 ${cited.length} 条依据</summary><ul>${cited.map((item) => `<li><strong>${escapeHtml(item.id)}</strong><span>${escapeHtml(item.text)}</span></li>`).join("")}</ul></details></div></article>`;
}

function renderLegacyDraft(draft, evidence) {
  return `<section class="card pad resume-opt-legacy"><p class="section-label">历史逐条建议</p><h2>旧版草稿只读保留</h2><p class="hint">这份记录来自旧流程，不再要求逐条接受或忽略。</p>${renderChangeLedger(draft.changeLedger || draft.suggestions || [], evidence, false)}${draft.finalText ? `<label class="resume-opt-full-editor">历史最终文字<textarea readonly rows="18">${escapeHtml(draft.finalText)}</textarea></label>` : ""}</section>`;
}

function renderActivatedNotice(dashboard, draft) {
  return `<section id="resume-opt-activated" class="alert good"><strong>这份草稿已经启用</strong><p>新版本已进入 RoleFlow 的简历版本列表；重复提交同一全文不会再创建另一份。</p><a href="/resumes?profileId=${escapeAttr(dashboard.profile?.id || draft.profileId)}">查看全部简历版本</a></section>`;
}

function renderHistory(dashboard, selected) {
  const planId = dashboard.plan?.id || "";
  const history = (dashboard.drafts || []).filter((draft) => Number(draft.id) !== Number(selected.id));
  if (!history.length) return "";
  return `<section class="card pad resume-opt-history"><p class="section-label">历史草稿</p><h2>保留每次源材料与处理结果</h2><ul>${history.map((draft) => `<li><a href="/resume-optimization?planId=${escapeAttr(planId)}&amp;draftId=${escapeAttr(draft.id)}">${escapeHtml(draft.headline || `定向简历草稿 ${draft.id}`)}</a><span>${draft.status === "activated" ? "已启用" : "草稿"}</span></li>`).join("")}</ul></section>`;
}

const RESUME_OPTIMIZATION_SCRIPT = `<script>(()=>{const form=document.querySelector('[data-resume-editor]');const editor=document.getElementById('resume-opt-final-text');const copy=document.querySelector('[data-copy-resume]');if(copy&&editor)copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(editor.value);copy.textContent='已复制';}catch{copy.textContent='复制失败';}});const status=form?.querySelector('[data-resume-save-status]');const planId=form?.elements.planId?.value||'';const draftId=form?.elements.draftId?.value||'';let timer=0;let chain=Promise.resolve();let version=0;const setStatus=(text)=>{if(status)status.textContent=text;};const enqueue=(text,revision)=>{chain=chain.catch(()=>{}).then(async()=>{setStatus('正在保存…');const response=await fetch('/api/resume-optimization/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({planId,draftId,finalText:text})});if(!response.ok)throw new Error('save failed');if(revision===version)setStatus('已自动保存');else setStatus('有更新待保存');}).catch(()=>{if(revision===version)setStatus('自动保存失败，请点击“保存草稿”重试。');});return chain;};if(form&&editor&&!editor.readOnly)editor.addEventListener('input',()=>{version+=1;const revision=version;const text=editor.value;setStatus('有修改待保存');clearTimeout(timer);timer=setTimeout(()=>enqueue(text,revision),600);});for(const submitForm of document.querySelectorAll('[data-resume-submit]'))submitForm.addEventListener('submit',async(event)=>{event.preventDefault();const button=event.submitter||submitForm.querySelector('button');const label=button?.textContent||'';const error=submitForm.querySelector('[data-resume-error]')||submitForm.querySelector('[data-resume-save-status]');if(error)error.textContent='';if(button){button.disabled=true;button.textContent='处理中…';}if(submitForm===form)clearTimeout(timer);const action=button?.formAction||submitForm.action;const body=new URLSearchParams(new FormData(submitForm));const send=async()=>{const response=await fetch(action,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});if(!response.ok){const text=await response.text();let message='操作失败，请稍后重试。';try{message=JSON.parse(text).error||message}catch{}throw new Error(message);}location.assign(response.url||action);};try{if(submitForm===form)await chain.catch(()=>{}).then(send);else await send();}catch(failure){if(error)error.textContent=failure.message||'操作失败，请稍后重试。';if(button){button.disabled=false;button.textContent=label;}}});})();</script>`;

module.exports = { renderResumeOptimizationPage, RESUME_OPTIMIZATION_SCRIPT };
