function renderMessageDiscoveryPage({ db, searchParams, controller, helpers }) {
  const {
    getCandidateProfile,
    renderErrorPage,
    renderPage,
    navLinks,
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
  const status = controller.pageState(profileId);
  const plan = db.prepare(`SELECT id FROM search_plans
    WHERE profile_id = ?
    ORDER BY is_active DESC, updated_at DESC, id DESC
    LIMIT 1`).get(profileId);
  const manualPath = plan?.id ? `/queue?planId=${plan.id}` : "/queue";
  const statusLabel = {
    idle: "尚未开始",
    running: "正在只读发现",
    completed: "本次发现已完成",
    needs_user_action: "需要人工处理",
    stopped: "已安全停止",
    dismissed: "本次草稿已放弃"
  }[status.status] || "需要人工处理";
  const reason = messageDiscoveryReasonText(status.reasonCode);
  const resultSections = status.results.map((result, resultIndex) => {
    const drafts = result.messages.map((message, messageIndex) => {
      const id = `message-draft-${resultIndex}-${messageIndex}`;
      return `<div class="message-draft"><label for="${id}">草稿 ${messageIndex + 1}</label><textarea id="${id}" readonly>${escapeHtml(message)}</textarea><button type="button" data-copy-draft="${id}">复制到本机剪贴板</button></div>`;
    }).join("");
    if (!drafts) return "";
    return `<section class="panel message-result"><h2>本地草稿</h2><p class="line">阶段：${escapeHtml(progressStageLabel(result.stage))} · 分类：${escapeHtml(result.messageCategory || "待确认")}</p>${drafts}<form method="post" action="/api/progress"><input type="hidden" name="cardId" value="${result.cardId}"><input type="hidden" name="idempotencyKey" value="${escapeAttr(newProgressRequestKey())}"><input type="hidden" name="action" value="reply_confirmed_sent"><button>已手动发送</button></form></section>`;
  }).join("");
  const controls = `<div class="message-controls">
    <form data-discovery-form method="post" action="/api/message-discovery"><input type="hidden" name="action" value="start"><input type="hidden" name="profileId" value="${profileId}"><button${status.status === "running" ? " disabled" : ""}>开始只读发现</button></form>
    <form data-discovery-form method="post" action="/api/message-discovery"><input type="hidden" name="action" value="stop"><input type="hidden" name="profileId" value="${profileId}"><button${status.status === "running" ? "" : " disabled"}>安全停止</button></form>
    <form data-discovery-form method="post" action="/api/message-discovery"><input type="hidden" name="action" value="dismiss"><input type="hidden" name="profileId" value="${profileId}"><button${status.status !== "running" && status.results.some((item) => item.messages.length) ? "" : " disabled"}>放弃本次草稿</button></form>
  </div>`;
  const scriptStatus = JSON.stringify({ profileId, status: status.status });
  return renderPage("BOSS 消息只读发现", `<style>
    .message-layout{max-width:820px}.message-controls{display:flex;flex-wrap:wrap;gap:10px;margin:16px 0}.message-controls form{margin:0}.message-state{border-left:4px solid #317166}.message-draft{display:grid;gap:7px;margin:12px 0}.message-draft textarea{width:100%;box-sizing:border-box;background:#f7faf9}.message-result form{margin-top:14px}@media(max-width:760px){.message-controls{display:grid}.message-controls button{width:100%}}
  </style><main class="message-layout"><nav>${navLinks(plan?.id ? `/plan?planId=${plan.id}` : "/onboarding")}</nav><h1>BOSS 消息只读发现</h1><p class="hint">只读取未读会话并在本机生成草稿。请复制草稿后到平台人工粘贴；本页不填写平台输入框。</p>${controls}<section class="panel message-state"><h2>${escapeHtml(statusLabel)}</h2><p class="line">排队 ${status.queued} · 已处理 ${status.processed}</p>${reason ? `<p class="risk-text">${escapeHtml(reason)}</p>` : ""}</section>${resultSections || '<section class="panel"><p class="line">当前没有可复制的草稿。</p></section>'}<p><a href="${escapeAttr(manualPath)}">返回人工粘贴流程</a></p></main><script>(function(){const initial=${scriptStatus};for(const form of document.querySelectorAll("[data-discovery-form]"))form.addEventListener("submit",async(event)=>{event.preventDefault();const body=new URLSearchParams(new FormData(form));await fetch(form.action,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body});location.reload()});for(const button of document.querySelectorAll("[data-copy-draft]"))button.addEventListener("click",async()=>{const field=document.getElementById(button.dataset.copyDraft);await navigator.clipboard.writeText(field.value)});if(initial.status!=="running")return;const poll=async()=>{const response=await fetch("/api/message-discovery-status?profileId="+encodeURIComponent(initial.profileId));const value=await response.json();if(value.status==="running")setTimeout(poll,2000);else location.reload()};setTimeout(poll,2000)}());</script>`);
}

function messageDiscoveryReasonText(code) {
  return {
    MESSAGE_DISCOVERY_STOPPED: "已按你的操作安全停止。",
    MESSAGE_DISCOVERY_LEASE_LOST: "BOSS 任务租约已丢失，本次发现已停止。",
    BOSS_MESSAGE_TAB_MISSING: "请保留一个已登录的 BOSS 消息页。",
    BOSS_MESSAGE_TAB_AMBIGUOUS: "检测到多个 BOSS 消息页，请只保留一个。",
    BOSS_RISK_CONTROL: "检测到平台安全验证，本次发现已停止。",
    BOSS_LOGIN_REQUIRED: "BOSS 登录状态不可用，本次发现已停止。",
    BOSS_MESSAGE_PAGE_LOST: "BOSS 消息页已离开，本次发现已停止。",
    BOSS_MESSAGE_CARD_NOT_FOUND: "未找到唯一匹配的本地岗位进展卡。",
    BOSS_MESSAGE_CARD_AMBIGUOUS: "找到多个同名岗位，请先人工确认。",
    BOSS_MESSAGE_GROUP_LIMIT: "同一会话连续消息过多，请改用人工粘贴。",
    BOSS_MESSAGE_GROUP_TEXT_LIMIT: "连续消息文本过长，请改用人工粘贴。",
    BOSS_MESSAGE_CONTENT_UNSUPPORTED: "会话包含语音、图片或附件，请改用人工粘贴。"
  }[String(code || "")] || (code ? "本次发现已停止，请查看本地进展后再继续。" : "");
}

module.exports = {
  renderMessageDiscoveryPage,
  messageDiscoveryReasonText
};
