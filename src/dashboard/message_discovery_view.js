const { listUnresolvedMessageDiscoveryItems } = require("../core/message_preview_state");

function renderMessageDiscoveryPage({ db, searchParams, controller, helpers }) {
  const {
    getCandidateProfile,
    renderErrorPage,
    renderFramedPage,
    escapeHtml,
    escapeAttr,
    progressStageLabel,
    newProgressRequestKey
  } = helpers;
  const profileIdValue = searchParams.get("profileId");
  let profileId = Number(profileIdValue);
  let plan = null;
  if ((!Number.isSafeInteger(profileId) || profileId <= 0) && searchParams.has("planId")) {
    const planId = Number(searchParams.get("planId"));
    if (Number.isSafeInteger(planId) && planId > 0) {
      plan = db.prepare("SELECT id, profile_id FROM search_plans WHERE id = ?").get(planId);
      profileId = Number(plan?.profile_id);
    }
  }
  if (!Number.isSafeInteger(profileId) || profileId <= 0) {
    return renderErrorPage("profileId 无效。", "/onboarding", { code: "MESSAGE_DISCOVERY_PROFILE_INVALID" });
  }
  const profile = getCandidateProfile(db, profileId);
  if (!profile) return renderErrorPage("候选人画像不存在。", "/onboarding", { code: "MESSAGE_DISCOVERY_PROFILE_NOT_FOUND" });
  const pageState = controller.pageState(profileId);
  const durableUnresolved = listUnresolvedMessageDiscoveryItems(db, { profileId });
  const status = durableUnresolved.length
    ? {
        ...pageState,
        status: pageState.status === "running" ? "running" : "needs_user_action",
        unresolved: durableUnresolved.length,
        reasonCode: durableUnresolved[0].reasonCode
      }
    : pageState;
  plan ||= db.prepare(`SELECT id FROM search_plans
    WHERE profile_id = ?
    ORDER BY is_active DESC, updated_at DESC, id DESC
    LIMIT 1`).get(profileId);
  const manualPath = plan?.id ? `/queue?planId=${plan.id}` : "/queue";
  const currentPath = profileIdValue
    ? `/messages?profileId=${encodeURIComponent(profileId)}`
    : `/messages?planId=${encodeURIComponent(plan?.id || "")}`;
  const statusLabel = {
    idle: "尚未开始",
    running: "正在只读发现",
    completed: "本次发现已完成",
    needs_user_action: "需要人工处理",
    stopped: "已安全停止",
    dismissed: "本次草稿已放弃"
  }[status.status] || "需要人工处理";
  const recoveryMessages = messageDiscoveryRecoveryMessages();
  const reason = messageDiscoveryReasonText(status.reasonCode);
  const phaseNotice = messageDiscoveryPhaseText(status);
  const resultSections = status.results.map((result, resultIndex) => {
    const job = result.job || {};
    const drafts = (result.messages || []).map((message, messageIndex) => {
      const id = `message-draft-${resultIndex}-${messageIndex}`;
      return `<div class="message-draft"><label for="${id}">草稿 ${messageIndex + 1}</label><textarea id="${id}" readonly>${escapeHtml(message)}</textarea><button type="button" data-copy-draft="${id}">复制到本机剪贴板</button></div>`;
    }).join("");
    const jobUnderstanding = `<div class="message-job-understanding"><h3>岗位理解</h3><p class="line">${escapeHtml(job.roleSummary || "暂未形成可靠的岗位摘要。")}</p>${renderResultList("匹配依据", job.fitReasons, escapeHtml)}${renderResultList("硬性阻断", job.hardBlockers, escapeHtml)}${renderResultList("待补信息", job.softGaps, escapeHtml)}${renderResultList("建议核实", job.questionsToVerify, escapeHtml)}</div>`;
    const draftSection = drafts
      ? `<h3>推荐回复草稿</h3>${drafts}`
      : `<p class="risk-text">${escapeHtml(messageDiscoveryManualActionText(result))}</p>`;
    const sentForm = drafts
      ? `<form method="post" action="/api/progress"><input type="hidden" name="cardId" value="${result.cardId}"><input type="hidden" name="idempotencyKey" value="${escapeAttr(newProgressRequestKey())}"><input type="hidden" name="action" value="reply_confirmed_sent"><button>已手动发送</button></form>`
      : "";
    const source = result.contextSource === "local_cache"
      ? "本地已有岗位资料"
      : result.contextSource === "message_discovery_detail"
        ? "本次后台只读岗位详情"
        : "岗位资料来源待确认";
    return `<section class="panel message-result"><h2>${escapeHtml(job.title || "岗位处理结果")}</h2><p class="line">${escapeHtml(job.company || "公司待确认")} · 阶段：${escapeHtml(progressStageLabel(result.stage))} · 分类：${escapeHtml(result.messageCategory || "待确认")}</p><p class="line">岗位资料来源：${escapeHtml(source)}</p>${jobUnderstanding}${draftSection}${sentForm}</section>`;
  }).join("");
  const controls = `<section class="message-controls" aria-label="消息发现操作">
    <form data-discovery-form method="post" action="/api/message-discovery"><input type="hidden" name="action" value="start"><input type="hidden" name="profileId" value="${profileId}"><button data-page-primary="true"${status.status === "running" ? " disabled" : ""}>开始只读发现</button></form>
    <form data-discovery-form method="post" action="/api/message-discovery"><input type="hidden" name="action" value="stop"><input type="hidden" name="profileId" value="${profileId}"><button class="secondary"${status.status === "running" ? "" : " disabled"}>安全停止</button></form>
    <form data-discovery-form method="post" action="/api/message-discovery"><input type="hidden" name="action" value="dismiss"><input type="hidden" name="profileId" value="${profileId}"><button class="secondary"${status.status !== "running" && status.results.some((item) => item.messages.length) ? "" : " disabled"}>放弃本次草稿</button></form>
  </section>`;
  const unresolvedSections = durableUnresolved.map((item) =>
    renderUnresolvedItem(db, item, { profileId, escapeHtml, escapeAttr })
  ).join("");
  const scriptState = JSON.stringify({ profileId, status: status.status, recoveryMessages });
  return renderFramedPage({
    title: "BOSS 消息只读发现",
    currentPath,
    todayPath: plan?.id ? `/plan?planId=${plan.id}` : "/onboarding",
    planId: plan?.id || "",
    stage: "消息",
    brandHref: plan?.id ? `/plan?planId=${plan.id}` : "/onboarding",
    content: `<main id="main-content" class="message-layout"><header class="page-heading"><p class="eyebrow">只读发现</p><h1>BOSS 消息只读发现</h1><p class="lede">只读取未读会话，在本机理解对应岗位并准备安全的推荐回复草稿。请复制草稿后到平台人工粘贴；本页不会填写、粘贴或发送平台消息。</p></header>${controls}<p class="message-feedback" data-discovery-feedback role="status" aria-live="polite" aria-busy="false"></p><section class="panel message-state"><h2>${escapeHtml(statusLabel)}</h2><p class="line">排队 ${status.queued} · 已处理 ${status.processed} · 未解决 ${Math.max(0, Number(status.unresolved) || 0)}</p>${phaseNotice ? `<p class="line">${escapeHtml(phaseNotice)}</p>` : ""}${reason ? `<p class="risk-text">${escapeHtml(reason)}</p>` : ""}</section>${unresolvedSections}${resultSections || (!unresolvedSections ? '<section class="panel"><p class="line">当前没有岗位处理结果。</p></section>' : "")}<p><a class="button-link secondary" href="${escapeAttr(manualPath)}">返回人工粘贴流程</a></p></main>`,
    scripts: [`<script>(function(){const initial=${scriptState};const feedback=document.querySelector("[data-discovery-feedback]");const forms=Array.from(document.querySelectorAll("[data-discovery-form]"));const postStatuses=["running","stopped","completed","needs_user_action","dismissed"];const pollStatuses=["idle","running","stopped","completed","needs_user_action","dismissed"];let actionPending=false;let actionVersion=0;let currentStatus=initial.status;let reloadPending=false;let pollPending=false;let pollTimer=null;const messageFor=(code)=>initial.recoveryMessages[String(code||"")]||initial.recoveryMessages.default;const show=(code)=>{if(reloadPending)return;feedback.textContent=messageFor(code);feedback.dataset.errorCode=String(code||"");};const requestReload=()=>{reloadPending=true;location.reload();};const setPending=(pending)=>{feedback.setAttribute("aria-busy",String(pending));if(pending)feedback.textContent="正在处理，请稍候。";for(const form of forms)for(const button of form.querySelectorAll("button")){if(!("discoveryBaseDisabled" in button.dataset))button.dataset.discoveryBaseDisabled=String(button.disabled);button.disabled=pending||button.dataset.discoveryBaseDisabled==="true";}};const read=async(response)=>{const text=await response.text();try{return {json:true,body:JSON.parse(text)}}catch{return {json:false,body:null}}};const accepted=(response,parsed,statuses)=>Boolean(response.ok&&parsed.json&&parsed.body&&typeof parsed.body==="object"&&!Array.isArray(parsed.body)&&!Object.prototype.hasOwnProperty.call(parsed.body,"errorCode")&&statuses.includes(parsed.body.status));const rejectedCode=(parsed)=>parsed.body?.errorCode||"MESSAGE_DISCOVERY_FAILED";const schedulePoll=()=>{if(!reloadPending&&!actionPending&&pollTimer===null)pollTimer=setTimeout(poll,2000);};for(const form of forms)form.addEventListener("submit",async(event)=>{event.preventDefault();if(actionPending||reloadPending)return;actionPending=true;actionVersion+=1;setPending(true);let succeeded=false;try{const response=await fetch(form.getAttribute("action"),{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams(new FormData(form))});const parsed=await read(response);if(accepted(response,parsed,postStatuses)){succeeded=true;requestReload();return;}show(rejectedCode(parsed));}catch{show("MESSAGE_DISCOVERY_BROWSER_UNAVAILABLE");}finally{actionPending=false;setPending(false);if(!reloadPending&&!succeeded&&currentStatus==="running")schedulePoll();}});for(const button of document.querySelectorAll("[data-copy-draft]"))button.addEventListener("click",async()=>{const field=document.getElementById(button.dataset.copyDraft);if(field)await navigator.clipboard.writeText(field.value);});const poll=async()=>{pollTimer=null;if(reloadPending||pollPending||actionPending)return;pollPending=true;const version=actionVersion;try{const response=await fetch("/api/message-discovery-status?profileId="+encodeURIComponent(initial.profileId));const parsed=await read(response);if(reloadPending||actionPending||version!==actionVersion)return;if(!accepted(response,parsed,pollStatuses)){show(rejectedCode(parsed));return;}currentStatus=parsed.body.status;if(currentStatus==="running")schedulePoll();else requestReload();}catch{if(!reloadPending&&!actionPending&&version===actionVersion)show("MESSAGE_DISCOVERY_BROWSER_UNAVAILABLE");}finally{pollPending=false;if(!reloadPending&&!actionPending&&version!==actionVersion&&currentStatus==="running")schedulePoll();}};if(currentStatus==="running")schedulePoll();}());</script>`]
  });
}

function renderUnresolvedItem(db, item, { profileId, escapeHtml, escapeAttr }) {
  const complete = Boolean(String(item.positionTitle || "").trim() && String(item.company || "").trim());
  const matches = complete ? exactIdentityCandidates(db, profileId, item) : [];
  const hidden = `<input type="hidden" name="profileId" value="${profileId}"><input type="hidden" name="conversationKey" value="${escapeAttr(item.conversationKey)}"><input type="hidden" name="previewDigest" value="${escapeAttr(item.previewDigest)}">`;
  const candidateChoices = matches.map((job) =>
    `<label><input type="radio" name="jobId" value="${job.id}"${matches.length === 1 ? " checked" : ""}>${escapeHtml(job.title)} · ${escapeHtml(job.company || "")}</label>`
  ).join("");
  const link = complete && matches.length
    ? `<form method="post" action="/api/message-discovery-unresolved">${hidden}<input type="hidden" name="action" value="link"><fieldset><legend>关联现有岗位</legend>${candidateChoices}</fieldset><button class="secondary">关联现有岗位</button></form>`
    : `<button class="secondary" disabled>关联现有岗位</button>`;
  const create = `<form method="post" action="/api/message-discovery-unresolved">${hidden}<button name="action" value="create"${complete ? "" : " disabled"}>保存为 HR 主动机会</button></form>`;
  const ignore = `<form method="post" action="/api/message-discovery-unresolved">${hidden}<button class="secondary" name="action" value="ignore">不纳入 RoleFlow</button></form>`;
  const incomplete = complete ? "" : `<p class="risk-text">岗位身份仍不完整，请下次只读发现后再处理。</p>`;
  return `<section class="panel message-unresolved"><h2>${escapeHtml(item.positionTitle || "岗位名称待确认")}</h2><p class="line">${escapeHtml(item.company || "公司待确认")} · ${escapeHtml(item.salary || "薪资待确认")} · ${escapeHtml(item.city || "地点待确认")}</p>${incomplete}<p class="line">以上仅为岗位身份字段；没有保存招聘方姓名或消息正文。</p><div class="message-controls">${link}${create}${ignore}</div></section>`;
}

function exactIdentityCandidates(db, profileId, item) {
  return db.prepare(`SELECT DISTINCT jobs.id, jobs.title, jobs.company
    FROM jobs
    LEFT JOIN candidate_progress_cards cards
      ON cards.job_id = jobs.id AND cards.profile_id = ?
    LEFT JOIN job_observations observations ON observations.job_id = jobs.id
    LEFT JOIN batches ON batches.id = observations.batch_id
    WHERE lower(trim(jobs.title)) = lower(trim(?))
      AND lower(trim(COALESCE(jobs.company, ''))) = lower(trim(?))
      AND (
        cards.id IS NOT NULL
        OR batches.profile_id = ?
      )
      AND COALESCE(cards.stage, '') NOT IN ('rejected', 'closed')
    ORDER BY jobs.last_seen_at DESC, jobs.id DESC
    LIMIT 20`)
    .all(profileId, item.positionTitle, item.company, profileId)
    .map((row) => ({ id: Number(row.id), title: row.title, company: row.company || "" }));
}

function renderResultList(label, items, escapeHtml) {
  const values = Array.isArray(items) ? items.filter(Boolean) : [];
  if (values.length === 0) return "";
  return `<h4>${escapeHtml(label)}</h4><ul>${values.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function messageDiscoveryManualActionText(result) {
  if (result?.missingFactKey) return "缺少事实，暂不生成草稿。请先人工确认后再回复。";
  const category = String(result?.messageCategory || "");
  if (category.includes("interview")) return "面试安排需人工处理，请核对时间、形式和地点后再回复。";
  if (category === "salary") return "薪资沟通需人工处理，请确认你的口径后再回复。";
  if (category === "sensitive") return "消息涉及敏感信息，需要人工判断后再回复。";
  if (category === "identity_uncertain") return "岗位或会话身份仍需人工核对，暂不生成草稿。";
  return result?.manualActionReason || "当前结果需要人工处理，暂不生成草稿。";
}

function messageDiscoveryPhaseText(status) {
  if (status?.phase === "cooldown") {
    const remainingSeconds = Math.max(1, Math.ceil((Date.parse(status.waitUntil) - Date.now()) / 1000));
    return Number.isFinite(remainingSeconds)
      ? `正在按安全节奏冷却，约 ${remainingSeconds} 秒后继续。`
      : "正在按安全节奏冷却，稍后继续。";
  }
  if (status?.phase === "reading_detail") return "正在后台读取当前岗位详情，不会抢占前台。";
  if (status?.phase === "starting") return "正在准备只读消息检查。";
  return "";
}

function messageDiscoveryReasonText(code) {
  return messageDiscoveryRecoveryMessages()[String(code || "")] || (code ? messageDiscoveryRecoveryMessages().default : "");
}

function messageDiscoveryRecoveryMessages() {
  const browserUnavailable = "无法连接 Edge 或读取消息页。请确认 Edge 和本地浏览器控制可用后重试。";
  const verifyIdentity = "无法确认本地岗位与会话是否一致。请在人工粘贴流程中核对后处理。";
  return {
    MESSAGE_DISCOVERY_STOPPED: "已按你的操作安全停止。需要继续时重新开始只读发现。",
    MESSAGE_DISCOVERY_ALREADY_RUNNING: "消息发现正在运行。请等待完成或使用安全停止。",
    MESSAGE_DISCOVERY_RUNNING: "消息发现正在运行。请先安全停止，再放弃草稿。",
    MESSAGE_DISCOVERY_NOT_RUNNING: "消息发现当前未运行。请重新加载页面后重试。",
    MESSAGE_DISCOVERY_BROWSER_UNAVAILABLE: browserUnavailable,
    BOSS_BROWSER_DISCONNECTED: browserUnavailable,
    BOSS_BROWSER_TIMEOUT: browserUnavailable,
    BOSS_COMMAND_UNAVAILABLE: browserUnavailable,
    BOSS_MESSAGE_TAB_MISSING: browserUnavailable,
    BOSS_MESSAGE_TAB_AMBIGUOUS: browserUnavailable,
    BOSS_MESSAGE_PAGE_LOST: browserUnavailable,
    BOSS_LOGIN_REQUIRED: "BOSS 登录已失效。请在固定 BOSS 消息页重新登录后重试。",
    BOSS_RISK_CONTROL: "浏览器需要完成安全检查。请完成检查，解除前不要继续本地操作。",
    BOSS_RUNTIME_BLOCKED: "浏览器操作当前被安全限制。请完成安全检查，解除前不要继续本地操作。",
    MESSAGE_DISCOVERY_LEASE_BUSY: "BOSS 正被另一项任务使用。请等待或停止冲突任务后重试。",
    MESSAGE_DISCOVERY_LEASE_LOST: "BOSS 任务控制权已丢失。请等待或停止冲突任务后重试。",
    MESSAGE_DISCOVERY_MODEL_NOT_READY: "深度分析模型尚未就绪。请到模型设置测试深度分析模型。",
    BOSS_MESSAGE_CARD_NOT_FOUND: verifyIdentity,
    BOSS_MESSAGE_CARD_AMBIGUOUS: verifyIdentity,
    BOSS_MESSAGE_SALARY_MISMATCH: verifyIdentity,
    BOSS_MESSAGE_CITY_MISMATCH: verifyIdentity,
    BOSS_MESSAGE_COMPANY_MISMATCH: verifyIdentity,
    BOSS_MESSAGE_THREAD_MISMATCH: verifyIdentity,
    BOSS_MESSAGE_JOB_TARGET_UNAVAILABLE: "无法确认当前会话对应的岗位入口。该会话已保留，未打开详情，也未生成草稿。",
    BOSS_MESSAGE_DETAIL_NOT_BACKGROUND: "岗位详情未能在后台安全打开。临时页会被关闭，本次只读发现已停止。",
    BOSS_MESSAGE_DETAIL_TARGET_MISMATCH: "后台打开的岗位与当前会话不一致。临时页会被关闭，该会话已保留待处理。",
    BOSS_MESSAGE_DETAIL_BASELINE_NOT_RESTORED: "岗位详情读取后未能确认浏览器已恢复安全状态。本次只读发现已停止，请检查 BOSS 标签页。",
    MESSAGE_DISCOVERY_JOB_ANALYSIS_INCOMPLETE: "岗位详情已读取，但本地分析还不完整。该会话已保留，请稍后重新开始只读发现。",
    BOSS_MESSAGE_GROUP_LIMIT: "会话内容不适合自动整理。请改用人工粘贴流程处理。",
    BOSS_MESSAGE_GROUP_TEXT_LIMIT: "会话内容过长，无法安全整理。请改用人工粘贴流程处理。",
    BOSS_MESSAGE_CONTENT_UNSUPPORTED: "会话包含无法安全读取的内容。请改用人工粘贴流程处理。",
    default: "消息读取、模型分析或本地服务响应失败，未发送任何消息。请确认本地服务并打开诊断查看详情。"
  };
}

module.exports = {
  renderMessageDiscoveryPage,
  messageDiscoveryReasonText
};
