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
  const profileId = Number(profileIdValue);
  if (!Number.isSafeInteger(profileId) || profileId <= 0) {
    return renderErrorPage("profileId 无效。", "/onboarding", { code: "MESSAGE_DISCOVERY_PROFILE_INVALID" });
  }
  const profile = getCandidateProfile(db, profileId);
  if (!profile) return renderErrorPage("候选人画像不存在。", "/onboarding", { code: "MESSAGE_DISCOVERY_PROFILE_NOT_FOUND" });
  const pageState = controller.pageState(profileId);
  const durableUnresolved = pageState.status === "dismissed"
    ? listUnresolvedMessageDiscoveryItems(db, { profileId })
    : [];
  const status = durableUnresolved.length
    ? { ...pageState, unresolved: durableUnresolved.length, reasonCode: durableUnresolved[0].reasonCode }
    : pageState;
  const plan = db.prepare(`SELECT id FROM search_plans
    WHERE profile_id = ?
    ORDER BY is_active DESC, updated_at DESC, id DESC
    LIMIT 1`).get(profileId);
  const manualPath = plan?.id ? `/queue?planId=${plan.id}` : "/queue";
  const currentPath = `/messages?profileId=${encodeURIComponent(profileId)}`;
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
  const resultSections = status.results.map((result, resultIndex) => {
    const drafts = result.messages.map((message, messageIndex) => {
      const id = `message-draft-${resultIndex}-${messageIndex}`;
      return `<div class="message-draft"><label for="${id}">草稿 ${messageIndex + 1}</label><textarea id="${id}" readonly>${escapeHtml(message)}</textarea><button type="button" data-copy-draft="${id}">复制到本机剪贴板</button></div>`;
    }).join("");
    if (!drafts) return "";
    return `<section class="panel message-result"><h2>本地草稿</h2><p class="line">阶段：${escapeHtml(progressStageLabel(result.stage))} · 分类：${escapeHtml(result.messageCategory || "待确认")}</p>${drafts}<form method="post" action="/api/progress"><input type="hidden" name="cardId" value="${result.cardId}"><input type="hidden" name="idempotencyKey" value="${escapeAttr(newProgressRequestKey())}"><input type="hidden" name="action" value="reply_confirmed_sent"><button>已手动发送</button></form></section>`;
  }).join("");
  const controls = `<section class="message-controls" aria-label="消息发现操作">
    <form data-discovery-form method="post" action="/api/message-discovery"><input type="hidden" name="action" value="start"><input type="hidden" name="profileId" value="${profileId}"><button data-page-primary="true"${status.status === "running" ? " disabled" : ""}>开始只读发现</button></form>
    <form data-discovery-form method="post" action="/api/message-discovery"><input type="hidden" name="action" value="stop"><input type="hidden" name="profileId" value="${profileId}"><button class="secondary"${status.status === "running" ? "" : " disabled"}>安全停止</button></form>
    <form data-discovery-form method="post" action="/api/message-discovery"><input type="hidden" name="action" value="dismiss"><input type="hidden" name="profileId" value="${profileId}"><button class="secondary"${status.status !== "running" && status.results.some((item) => item.messages.length) ? "" : " disabled"}>放弃本次草稿</button></form>
  </section>`;
  const scriptState = JSON.stringify({ profileId, status: status.status, recoveryMessages });
  return renderFramedPage({
    title: "BOSS 消息只读发现",
    currentPath,
    todayPath: plan?.id ? `/plan?planId=${plan.id}` : "/onboarding",
    planId: plan?.id || "",
    stage: "消息",
    brandHref: plan?.id ? `/plan?planId=${plan.id}` : "/onboarding",
    content: `<main id="main-content" class="message-layout"><header class="page-heading"><p class="eyebrow">只读发现</p><h1>BOSS 消息只读发现</h1><p class="lede">只读取未读会话并在本机生成草稿。请复制草稿后到平台人工粘贴；本页不会填写、粘贴或发送平台消息。</p></header>${controls}<p class="message-feedback" data-discovery-feedback role="status" aria-live="polite" aria-busy="false"></p><section class="panel message-state"><h2>${escapeHtml(statusLabel)}</h2><p class="line">排队 ${status.queued} · 已处理 ${status.processed} · 未解决 ${Math.max(0, Number(status.unresolved) || 0)}</p>${reason ? `<p class="risk-text">${escapeHtml(reason)}</p>` : ""}</section>${resultSections || '<section class="panel"><p class="line">当前没有可复制的草稿。</p></section>'}<p><a class="button-link secondary" href="${escapeAttr(manualPath)}">返回人工粘贴流程</a></p></main>`,
    scripts: [`<script>(function(){const initial=${scriptState};const feedback=document.querySelector("[data-discovery-feedback]");const forms=Array.from(document.querySelectorAll("[data-discovery-form]"));let actionPending=false;let pollPending=false;let pollTimer=null;const messageFor=(code)=>initial.recoveryMessages[String(code||"")]||initial.recoveryMessages.default;const show=(code)=>{feedback.textContent=messageFor(code);feedback.dataset.errorCode=String(code||"");};const setPending=(pending)=>{feedback.setAttribute("aria-busy",String(pending));if(pending)feedback.textContent="正在处理，请稍候。";for(const form of forms)for(const button of form.querySelectorAll("button")){if(!("discoveryBaseDisabled" in button.dataset))button.dataset.discoveryBaseDisabled=String(button.disabled);button.disabled=pending||button.dataset.discoveryBaseDisabled==="true";}};const read=async(response)=>{const text=await response.text();try{return {json:true,body:JSON.parse(text)}}catch{return {json:false,body:null}}};const accepted=(response,parsed)=>Boolean(response.ok&&parsed.json&&parsed.body&&typeof parsed.body==="object"&&!parsed.body.errorCode);for(const form of forms)form.addEventListener("submit",async(event)=>{event.preventDefault();if(actionPending)return;actionPending=true;setPending(true);try{const response=await fetch(form.action,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams(new FormData(form))});const parsed=await read(response);if(accepted(response,parsed)){location.reload();return;}show(parsed.body?.errorCode||"MESSAGE_DISCOVERY_FAILED");}catch{show("MESSAGE_DISCOVERY_BROWSER_UNAVAILABLE");}finally{actionPending=false;setPending(false);}});for(const button of document.querySelectorAll("[data-copy-draft]"))button.addEventListener("click",async()=>{const field=document.getElementById(button.dataset.copyDraft);if(field)await navigator.clipboard.writeText(field.value);});const schedulePoll=()=>{if(pollTimer===null)pollTimer=setTimeout(poll,2000);};const poll=async()=>{pollTimer=null;if(pollPending)return;pollPending=true;try{const response=await fetch("/api/message-discovery-status?profileId="+encodeURIComponent(initial.profileId));const parsed=await read(response);if(!accepted(response,parsed)){show(parsed.body?.errorCode||"MESSAGE_DISCOVERY_FAILED");return;}if(parsed.body.status==="running")schedulePoll();else location.reload();}catch{show("MESSAGE_DISCOVERY_BROWSER_UNAVAILABLE");}finally{pollPending=false;}};if(initial.status==="running")schedulePoll();}());</script>`]
  });
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
