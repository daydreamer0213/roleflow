const crypto = require("node:crypto");
const { listUnresolvedMessageDiscoveryItems } = require("../core/message_preview_state");
const { listIncomingContacts } = require("../application/funnel_analysis");

function renderMessageDiscoveryPage({ db, searchParams, controller, replySendController = null, messageReplyActionToken = "", helpers }) {
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
  const initialReplySend = replySendController?.latest?.({ profileId }) || null;
  const pageState = controller.pageState(profileId);
  const durableUnresolved = listUnresolvedMessageDiscoveryItems(db, { profileId, platform: null });
  const status = durableUnresolved.length && !pageState.startedAt
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
  const originQuery = searchParams.get("workSite") === "zhaopin" ? "&workSite=zhaopin" : "";
  const todayPath = plan?.id ? `/plan?planId=${plan.id}${originQuery ? "&site=zhaopin" : ""}` : "/onboarding";
  const manualPath = plan?.id ? `/queue?planId=${plan.id}${originQuery ? "&site=zhaopin" : ""}` : "/queue";
  const currentPath = profileIdValue
    ? `/messages?profileId=${encodeURIComponent(profileId)}${originQuery}`
    : `/messages?planId=${encodeURIComponent(plan?.id || "")}${originQuery}`;
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
  const selectedSource = ["all", "boss", "zhaopin"].includes(searchParams.get("source"))
    ? searchParams.get("source") : "all";
  const selectedTask = ["pending", "all", "resume", "interview"].includes(searchParams.get("task"))
    ? searchParams.get("task") : "pending";
  const contactKey = String(searchParams.get("contact") || "").trim();
  const incomingContacts = listIncomingContacts(db, { profileId });
  const requestedContact = contactKey ? incomingContacts.find((item) => item.key === contactKey) : null;
  const contactMatchesScope = Boolean(requestedContact
    && (selectedSource === "all" || requestedContact.platform === selectedSource));
  const resultPending = (result) => Boolean((result.drafts || []).some((draft) => Number(draft?.id) > 0)
    || (result.manualActions || []).length || result.missingFactKey || result.messageIntent === "manual_review");
  const allResults = status.results.filter((result) => result?.messageIntent !== "follow_up");
  // Keep this collection complete. The browser applies the same source/task model
  // after first paint, so changing a filter can reveal a contact instead of requiring
  // a reload with a different server-side subset.
  const displayResults = allResults;
  const resultViews = displayResults.map((result, resultIndex) => {
    const viewKey = messageViewKey("result", [result.platform, result.cardId, result.conversationKey || result.messageGroupKey]);
    const job = result.job || {};
    const sendable = result.platform === "boss";
    const platformLabel = result.platform === "zhaopin" ? "智联" : sendable ? "BOSS" : "来源待确认";
    const manualActions = (result.manualActions || []).filter((item) => item?.kind === "resume_request");
    const matchingContact = incomingContacts.find((item) => item.platform === result.platform
      && Number(item.cardId) === Number(result.cardId)
      && item.conversationKey === result.conversationKey);
    const pending = resultPending(result);
    const resumeRequested = Boolean(matchingContact?.resumeRequested || manualActions.length);
    const interviewInvited = Boolean(matchingContact?.interviewInvited || result.messageIntent === "interview_invitation");
    const durableDrafts = Array.isArray(result.drafts) ? result.drafts.filter((draft) => Number(draft?.id) > 0) : [];
    const draftItems = durableDrafts.length
      ? durableDrafts
      : (result.messages || []).map((text) => ({ id: 0, text, revision: 0 }));
    const drafts = draftItems.map((draft, messageIndex) => {
      const id = draft.id > 0 ? `message-draft-${draft.id}` : `message-draft-${resultIndex}-${messageIndex}`;
      const editable = draft.id > 0;
      const sent = editable && sendable
        ? `<form method="post" action="/api/progress" data-sent-draft="${id}"><input type="hidden" name="cardId" value="${result.cardId}"><input type="hidden" name="draftId" value="${draft.id}"><input type="hidden" name="finalText" value=""><input type="hidden" name="idempotencyKey" value="${escapeAttr(newProgressRequestKey())}"><input type="hidden" name="action" value="reply_confirmed_sent"><button class="secondary">我已在 BOSS 手动发送</button></form>`
        : "";
      const alternativeSelector = draftItems.length > 1
        ? `<input type="radio" name="message-send-choice-${Number(result.cardId)}" data-send-select="${draft.id}">选择这版回复`
        : `<input type="checkbox" data-send-select="${draft.id}">加入本次发送`;
      const send = editable && sendable
        ? `<div class="message-draft-actions"><label class="message-send-choice">${alternativeSelector}</label><button type="button" data-send-single="${draft.id}">确认发送</button></div><p class="message-send-status" data-send-status="${draft.id}" role="status">等待确认</p>`
        : "";
      const saveStatus = editable
        ? `<p class="message-draft-save-status" data-draft-save-status="${draft.id}" role="status">已自动保存</p>`
        : "";
      const qualityNotice = Array.isArray(result.draftQualityWarnings)
        && result.draftQualityWarnings.includes("MESSAGE_DRAFT_RECENTLY_SIMILAR")
        ? '<p class="line message-draft-quality">这条草稿与近期消息的表达比较接近，你可以直接发送，也可以改得更具体。</p>'
        : "";
      const card = `<section class="message-draft" data-draft-card="${draft.id}"><label for="${id}">草稿 ${messageIndex + 1}</label>${qualityNotice}<textarea id="${id}"${editable ? ` data-draft-text data-draft-id="${draft.id}" data-revision="${draft.revision}" data-draft-revision="${draft.revision}"` : " readonly"}>${escapeHtml(draft.text)}</textarea>${saveStatus}<button type="button" data-copy-draft="${id}"${editable ? "" : " data-copy-only"}>复制到本机剪贴板</button>${send}${sent}</section>`;
      return messageIndex === 0 ? card : `<details class="message-draft-alternatives"><summary>查看其他回复版本</summary>${card}</details>`;
    }).join("");
    const inboundMessages = Array.isArray(result.inboundMessages) ? result.inboundMessages : [];
    const inboundSection = inboundMessages.length
      ? `<section class="message-inbound"><h3>HR 消息原文</h3>${inboundMessages.map((message) => `<p class="line">${escapeHtml(message.text)}</p>`).join("")}</section>`
      : "";
    const source = result.contextSource === "local_cache"
      ? "本地已有岗位资料"
      : result.contextSource === "message_discovery_detail"
        ? "本次后台只读岗位详情"
        : "岗位资料来源待确认";
    const decisionCard = `<section class="message-job-understanding">
      <p class="line"><strong>沟通类型：</strong>${escapeHtml(messageIntentLabel(result.messageIntent))}${manualActions.length ? " · HR 邀请你发送简历" : ""}</p>
      <p class="line"><strong>这份机会：</strong>${escapeHtml(job.availability === "offline" ? "职位已下线，以下资料用于理解这段沟通" : job.opportunityVerdict || "信息不足，暂时无法判断")}${job.availability !== "offline" && job.opportunitySummary ? ` · ${escapeHtml(job.opportunitySummary)}` : ""}</p>
      <p class="line"><strong>岗位主要做什么：</strong>${escapeHtml(job.roleSummary || "岗位职责分析尚未完成。")}</p>
      <p class="line"><strong>匹配与安排：</strong>${escapeHtml(job.fitLabel || "待确认")}${job.fitSummary ? ` · ${escapeHtml(job.fitSummary)}` : ""} · ${job.workSchedule && job.workSchedule !== "工作安排未确认"
        ? `工作安排：${escapeHtml(job.workSchedule)}`
        : "工作安排未确认"}</p>
      <details class="message-job-details"><summary>岗位与资料详情</summary>
        <p class="line"><strong>公司业务：</strong>${escapeHtml(job.companyBusiness || "JD 暂未说明公司的具体业务。")}</p>
        <p class="line"><strong>资料来源：</strong>${escapeHtml(source)}</p>
        <p class="line"><strong>薪资：</strong>${escapeHtml(job.salary || "薪资未说明")}</p>
      </details>
    </section>`;
    const manualSection = manualActions.map((action) => `<div class="message-manual-action"><h4>${escapeHtml(action.title)}</h4><p class="risk-text">${escapeHtml(action.instruction)}</p></div>`).join("");
    const replySection = drafts ? `<h3>回复草稿</h3><h4>推荐回复</h4>${drafts}` : "";
    const nextSection = `${manualSection}${replySection}`
      || `<p class="risk-text">${escapeHtml(messageDiscoveryManualActionText(result))}</p>`;
    const sentForm = sendable && drafts && !durableDrafts.length
      ? `<form method="post" action="/api/progress"><input type="hidden" name="cardId" value="${result.cardId}"><input type="hidden" name="idempotencyKey" value="${escapeAttr(newProgressRequestKey())}"><input type="hidden" name="action" value="reply_confirmed_sent"><button class="secondary">我已在 BOSS 手动发送</button></form>`
      : "";
    const viewId = `message-view-${viewKey}`;
    const title = job.title || "岗位处理结果";
    const company = job.company || "公司待确认";
    const preview = messagePreview(result);
    return {
      key: viewKey,
      contactKey: matchingContact?.key || "",
      list: `<label class="message-list-item" data-platform="${escapeAttr(result.platform || "")}" data-task="${pending ? "pending" : "history"}" data-pending="${pending}" data-resume="${resumeRequested}" data-interview="${interviewInvited}" for="${viewId}"><input id="${viewId}" type="radio" name="message-current" data-message-view="${viewKey}" aria-controls="message-detail-${viewKey}"><span><strong>${escapeHtml(title)}</strong><small class="message-source">${escapeHtml(platformLabel)} · ${escapeHtml(messageStatusLabel(result))}</small><small>${escapeHtml(company)}</small><em>${escapeHtml(preview)}</em></span></label>`,
      detail: `<section id="message-detail-${viewKey}" class="panel message-result" data-platform="${escapeAttr(result.platform || "")}" data-message-detail-panel="${viewKey}" hidden><button type="button" class="message-back" data-message-back>返回列表</button><h2>${escapeHtml(title)}</h2><p class="line"><span class="message-source">${escapeHtml(platformLabel)}</span> · ${escapeHtml(company)} · 阶段：${escapeHtml(progressStageLabel(result.stage))}</p>${inboundSection}${decisionCard}<h3>下一步</h3>${nextSection}${sentForm}</section>`
    };
  });
  const sendableDraftCount = displayResults.filter(result => result.platform === "boss").reduce((count, result) => count
    + (Array.isArray(result.drafts) ? result.drafts.filter((draft) => Number(draft?.id) > 0).length : 0), 0);
  const activeReplyBatch = initialReplySend?.batch && !["completed", "stopped", "interrupted"].includes(initialReplySend.batch.status);
  const controls = `<section class="message-controls" aria-label="消息发现操作">
    <form data-discovery-form method="post" action="/api/message-discovery"><input type="hidden" name="action" value="start"><input type="hidden" name="profileId" value="${profileId}"><button data-page-primary="true"${status.status === "running" ? " disabled" : ""}>读取新消息</button></form>
    ${status.status === "running" ? `<form data-discovery-form method="post" action="/api/message-discovery"><input type="hidden" name="action" value="stop"><input type="hidden" name="profileId" value="${profileId}"><button class="secondary">安全停止</button></form>` : ""}
    ${status.status !== "running" && status.results.length ? `<details class="message-result-actions"><summary>本次读取操作</summary><form data-discovery-form method="post" action="/api/message-discovery"><input type="hidden" name="action" value="dismiss"><input type="hidden" name="profileId" value="${profileId}"><button class="secondary">清除本次结果</button></form></details>` : ""}
    ${sendableDraftCount > 0 && !activeReplyBatch ? `<button type="button" class="secondary message-batch-entry" data-send-batch-enter>进入批量发送</button>` : ""}
  </section>`;
  const sendBatchPanel = activeReplyBatch || sendableDraftCount > 0 ? `<section class="message-send-batch" data-send-batch-panel data-state="idle" aria-label="确认发送">
    <div><strong data-send-batch-title>批量发送尚未开始</strong><span data-send-batch-status>单条确认不受影响；需要批量时再选择草稿。</span></div>
    <div class="button-row"><button type="button" data-send-batch hidden disabled>确认并串行发送 0 条</button><button type="button" data-send-batch-exit hidden>退出批量</button><button type="button" data-send-stop hidden disabled>停止后续发送</button></div>
  </section>` : "";
  const unresolvedViews = durableUnresolved.map((item, unresolvedIndex) => {
    const viewKey = messageViewKey("unresolved", [item.platform, item.conversationKey]);
    const viewId = `message-view-${viewKey}`;
    const platformLabel = item.platform === "zhaopin" ? "智联" : "BOSS";
    const title = item.positionTitle || "岗位名称待确认";
    const company = item.company || "公司待确认";
    const matchingContact = incomingContacts.find((contact) => contact.platform === item.platform
      && contact.conversationKey === item.conversationKey);
    return {
      key: viewKey,
      contactKey: matchingContact?.key || "",
      list: `<label class="message-list-item" data-platform="${escapeAttr(item.platform || "")}" data-task="pending" data-pending="true" data-resume="${Boolean(matchingContact?.resumeRequested)}" data-interview="${Boolean(matchingContact?.interviewInvited)}" for="${viewId}"><input id="${viewId}" type="radio" name="message-current" data-message-view="${viewKey}" aria-controls="message-detail-${viewKey}"><span><strong>${escapeHtml(title)}</strong><small class="message-source">${escapeHtml(platformLabel)} · 待补岗位资料</small><small>${escapeHtml(company)}</small><em>${escapeHtml(messagePreview(item, "待补岗位资料"))}</em></span></label>`,
      detail: renderUnresolvedItem(db, item, { profileId, viewKey, hidden: true, escapeHtml, escapeAttr })
    };
  });
  const resultIdentities = new Set(allResults.map((result) => `${result.platform}\0${result.conversationKey}`));
  const unresolvedIdentities = new Set(durableUnresolved.map((item) => `${item.platform}\0${item.conversationKey}`));
  const incomingViews = incomingContacts.filter((item) => !resultIdentities.has(`${item.platform}\0${item.conversationKey}`)
    && !unresolvedIdentities.has(`${item.platform}\0${item.conversationKey}`))
    .map((item) => renderIncomingContactView(item, { selected: false, pending: Boolean(item.pending), escapeHtml, escapeAttr }));
  const allViews = [...resultViews, ...unresolvedViews, ...incomingViews];
  const requestedView = contactMatchesScope ? allViews.find((view) => view.contactKey === requestedContact.key) : null;
  const selectionLocked = Boolean(contactKey && !requestedView);
  const views = requestedView ? [requestedView] : allViews;
  const messageWorkspace = views.length
    ? `<section class="message-workspace" aria-label="新消息与回复"><aside class="message-list" aria-label="联系消息"><h2>联系消息</h2>${views.map((view) => view.list).join("")}</aside><div class="message-detail">${views.map((view) => view.detail).join("")}</div></section>`
    : "";
  const retainedRecords = durableUnresolved.length
    ? `<p class="line">保留记录 ${durableUnresolved.length}</p>`
    : "";
  const counters = status.counters || {};
  const hasReadDetails = Boolean(status.startedAt || status.status === "running" || (status.platformRuns || []).length || Number(counters.visible) || Number(counters.newReplies));
  const platformNotices = hasReadDetails ? `<details class="message-read-details"><summary>读取详情</summary><p class="line">可见 ${Math.max(0, Number(counters.visible) || 0)} · 已分析回复 ${Math.max(0, Number(counters.newReplies) || 0)} · BOSS 已读 ${Math.max(0, Number(counters.currentRead) || 0)} · 送达 ${Math.max(0, Number(counters.currentDelivered) || 0)} · 未解决 ${Math.max(0, Number(status.unresolved) || 0)}</p>${retainedRecords}<p class="line">智联暂不提供已读/送达统计。</p>${(status.platformRuns || []).map(entry => `<p class="line">${entry.platform === "zhaopin" ? "智联" : "BOSS"}：${escapeHtml(entry.reasonCode === "MESSAGE_DISCOVERY_WAITING_TURN" ? "等待前一平台读取完成" : ({ not_connected: "未连接消息页，本次未检查", running: "正在加载并读取消息，可随时安全停止", completed: "本次读取完成", stopped: "已安全停止", needs_user_action: "需要处理后重试" })[entry.status] || "等待读取")}${entry.reasonCode && entry.reasonCode !== "MESSAGE_DISCOVERY_WAITING_TURN" ? ` · ${escapeHtml(messageDiscoveryReasonText(entry.reasonCode))}` : ""}</p>`).join("")}</details>` : "";
  const scriptState = JSON.stringify({
    profileId,
    status: status.status,
    selectedSource,
    selectedTask,
    initialSelectedKey: requestedView?.key || "",
    selectionLocked,
    directContact: Boolean(requestedView),
    sourceFromQuery: searchParams.has("source"),
    recoveryMessages,
    initialReplySend,
    messageReplyActionToken: String(messageReplyActionToken || "")
  });
  return renderFramedPage({
    title: "消息发现与回复",
    currentPath,
    todayPath,
    planId: plan?.id || "",
    stage: "消息",
    brandHref: todayPath,
    content: `<main id="main-content" class="message-layout"><header class="page-heading message-heading"><p class="eyebrow">消息工作台</p><h1>处理当前联系</h1><p class="lede">先看 HR 原话，再确认岗位判断和当前草稿。BOSS 可确认发送；智联请复制后回到原会话处理。</p></header>${controls}<p class="message-feedback" data-discovery-feedback role="status" aria-live="polite" aria-busy="false"></p>${status.status === "running" || (reason && !status.unresolved) ? `<section class="panel message-state"><h2>${escapeHtml(statusLabel)}</h2>${phaseNotice ? `<p class="line">${escapeHtml(phaseNotice)}</p>` : ""}${reason ? `<p class="risk-text">${escapeHtml(reason)}</p>` : ""}</section>` : ""}${platformNotices}<section class="message-filters"><label for="message-task-filter">要处理什么</label><select id="message-task-filter" data-task-filter><option value="pending">待处理</option><option value="all">全部联系</option><option value="resume">索要简历</option><option value="interview">面试邀请</option></select><label for="message-source-filter">消息来源</label><select id="message-source-filter" data-source-filter><option value="all">全部平台</option><option value="boss">BOSS</option><option value="zhaopin">智联</option></select></section>${selectionLocked ? '<section class="panel message-not-found"><h2>没有找到这条联系</h2><p>它可能已不存在，或不属于当前用户或所选平台。请从列表重新选择。</p></section>' : ''}<p data-source-empty hidden role="status">这个范围暂时没有消息。</p>${messageWorkspace || (!contactKey ? '<section class="panel"><p class="line">当前没有待处理联系。点击“读取新消息”开始检查。</p></section>' : '')}${sendBatchPanel}<p class="button-row"><a class="button-link secondary" data-flush-drafts href="/communication-profile?profileId=${encodeURIComponent(profileId)}">管理我的沟通资料</a><a class="button-link secondary" data-flush-drafts href="${escapeAttr(manualPath)}">返回人工粘贴流程</a></p></main>`,
    scripts: [messageDiscoveryClientScript(scriptState)]
  });
}

function messagePreview(result, fallback = "") {
  const messages = Array.isArray(result.inboundMessages) ? result.inboundMessages : [];
  const resumeRequested = messages.some(message => message.kind === "resume_request")
    || (result.manualActions || []).some(action => action.kind === "resume_request");
  const text = messages.filter(message => message.kind !== "resume_request")
    .map(message => String(message.text || "").replace(/\s+/gu, " ").trim())
    .filter(Boolean).slice(-2).reverse().join("；");
  const parts = [resumeRequested ? "HR 邀请你发送简历" : "", text].filter(Boolean);
  const preview = parts.join(" · ") || fallback || result.messageSummary || messageIntentLabel(result.messageIntent);
  const characters = Array.from(preview);
  return characters.length > 140 ? `${characters.slice(0, 140).join("")}…` : preview;
}

function messageStatusLabel(result) {
  if ((result.manualActions || []).some((item) => item?.kind === "resume_request")) return "索要简历";
  if (result.messageIntent === "interview_invitation") return "面试邀请";
  if ((result.drafts || []).some((draft) => Number(draft?.id) > 0)) return "待回复";
  return "待人工判断";
}

function renderIncomingContactView(item, { selected, pending, escapeHtml, escapeAttr }) {
  const key = messageViewKey("incoming", [item.key]);
  const inputId = `message-view-${key}`;
  const platform = item.platform === "zhaopin" ? "智联" : "BOSS";
  const status = item.resumeRequested ? "索要简历" : item.interviewInvited ? "面试邀请" : "已记录联系";
  const original = (item.inboundMessages || []).map((message) => message.text).filter(Boolean);
  return {
    key,
    contactKey: item.key,
    list: `<label class="message-list-item" data-platform="${escapeAttr(item.platform)}" data-task="${pending ? "pending" : "history"}" data-pending="${pending}" data-resume="${Boolean(item.resumeRequested)}" data-interview="${Boolean(item.interviewInvited)}" for="${inputId}"><input id="${inputId}" type="radio" name="message-current" data-message-view="${key}" aria-controls="message-detail-${key}"${selected ? " checked" : ""}><span><strong>${escapeHtml(item.title || "未关联岗位")}</strong><small class="message-source">${escapeHtml(platform)} · ${escapeHtml(status)}</small><small>${escapeHtml(item.company || "公司待确认")}</small><em>${escapeHtml(messagePreview(item, "已记录这次联系，原文暂不可查看"))}</em></span></label>`,
    detail: `<section id="message-detail-${key}" class="panel message-result message-history" data-platform="${escapeAttr(item.platform)}" data-message-detail-panel="${key}"${selected ? "" : " hidden"}><button type="button" class="message-back" data-message-back>返回列表</button><h2>${escapeHtml(item.title || "未关联岗位")}</h2><p class="line"><span class="message-source">${escapeHtml(platform)}</span> · ${escapeHtml(item.company || "公司待确认")} · ${escapeHtml(status)}</p><section class="message-inbound"><h3>HR 消息原文</h3>${original.length ? original.map((text) => `<p class="line">${escapeHtml(text)}</p>`).join("") : '<p class="line">已记录这次联系，原文暂不可查看。</p>'}</section><p class="line">这条联系目前没有可编辑草稿；请在原会话核对后处理。</p></section>`
  };
}

function messageDiscoveryClientScript(scriptState) {
  return `<script>(function(){
    const initial=${scriptState};
    const feedback=document.querySelector("[data-discovery-feedback]");
    const forms=Array.from(document.querySelectorAll("[data-discovery-form]"));
    const postStatuses=["running","stopped","completed","needs_user_action","dismissed"];
    const pollStatuses=["idle","running","stopped","completed","needs_user_action","dismissed"];
    let actionPending=false;
    let actionVersion=0;
    let currentStatus=initial.status;
    let reloadPending=false;
    let pollPending=false;
    let pollTimer=null;
    const draftTimers=new Map();
    const draftWrites=new Map();
    const messageFor=(code)=>initial.recoveryMessages[String(code||"")]||initial.recoveryMessages.default;
    const show=(code)=>{if(reloadPending)return;feedback.textContent=messageFor(code);feedback.dataset.errorCode=String(code||"");};
    const requestReload=()=>{reloadPending=true;location.reload();};
    const setPending=(pending)=>{feedback.setAttribute("aria-busy",String(pending));if(pending)feedback.textContent="正在处理，请稍候。";for(const form of forms)for(const button of form.querySelectorAll("button")){if(!("discoveryBaseDisabled" in button.dataset))button.dataset.discoveryBaseDisabled=String(button.disabled);button.disabled=pending||button.dataset.discoveryBaseDisabled==="true";}};
    const read=async(response)=>{const text=await response.text();try{return {json:true,body:JSON.parse(text)}}catch{return {json:false,body:null}}};
    const accepted=(response,parsed,statuses)=>Boolean(response.ok&&parsed.json&&parsed.body&&typeof parsed.body==="object"&&!Array.isArray(parsed.body)&&!Object.prototype.hasOwnProperty.call(parsed.body,"errorCode")&&statuses.includes(parsed.body.status));
    const rejectedCode=(parsed)=>parsed.body?.errorCode||"MESSAGE_DISCOVERY_FAILED";
    const schedulePoll=()=>{if(!reloadPending&&!actionPending&&pollTimer===null)pollTimer=setTimeout(poll,2000);};
    for(const form of forms)form.addEventListener("submit",async(event)=>{event.preventDefault();if(actionPending||reloadPending)return;actionPending=true;actionVersion+=1;setPending(true);let succeeded=false;try{const response=await fetch(form.getAttribute("action"),{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams(new FormData(form))});const parsed=await read(response);if(accepted(response,parsed,postStatuses)){succeeded=true;requestReload();return;}show(rejectedCode(parsed));}catch{show("MESSAGE_DISCOVERY_BROWSER_UNAVAILABLE");}finally{actionPending=false;setPending(false);if(!reloadPending&&!succeeded&&currentStatus==="running")schedulePoll();}});
    const cancelDraftSave=(field)=>{const timer=draftTimers.get(field);if(timer!==undefined){clearTimeout(timer);draftTimers.delete(field);}};
    const postDraft=async(field,text,action,completionKind="")=>{const response=await fetch("/api/message-reply-draft",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action,profileId:initial.profileId,draftId:Number(field.dataset.draftId),text,completionKind})});const parsed=await read(response);if(!response.ok||!parsed.json||!parsed.body?.ok)throw new Error(rejectedCode(parsed));return parsed.body;};
    const draftSaveStatus=(field)=>field.closest("[data-draft-card]")?.querySelector("[data-draft-save-status]");
    const setDraftSaveStatus=(field,text)=>{const status=draftSaveStatus(field);if(status)status.textContent=text;};
    const queueDraftWrite=(field,action,completionKind="",text=field.value)=>{const previous=draftWrites.get(field)||Promise.resolve();const pending=previous.catch(()=>undefined).then(()=>{setDraftSaveStatus(field,"正在保存…");return postDraft(field,text,action,completionKind);});draftWrites.set(field,pending);const clear=()=>{if(draftWrites.get(field)===pending)draftWrites.delete(field);};pending.then((result)=>{const revision=Number(result?.revision);if(Number.isSafeInteger(revision)&&revision>=0){field.dataset.revision=String(revision);field.dataset.draftRevision=String(revision);}setDraftSaveStatus(field,field.value===text?"已自动保存":"有修改待保存");clear();},()=>{setDraftSaveStatus(field,field.value===text?"保存失败，请重试":"有修改待保存");clear();});return pending;};
    const saveDraft=async(field)=>{cancelDraftSave(field);return queueDraftWrite(field,"save");};
    const saveStableDrafts=async(fields)=>{for(;;){const texts=fields.map(field=>field.value);await Promise.all(fields.map(saveDraft));if(fields.every((field,index)=>field.value===texts[index]))return;}};
    for(const field of document.querySelectorAll("[data-draft-text]"))field.addEventListener("input",()=>{setDraftSaveStatus(field,"有修改待保存");cancelDraftSave(field);draftTimers.set(field,setTimeout(async()=>{draftTimers.delete(field);try{await queueDraftWrite(field,"save");}catch{feedback.textContent="本次修改还没有保存，请稍后重试。";}},600));});
    for(const button of document.querySelectorAll("[data-copy-draft]"))button.addEventListener("click",async()=>{const field=document.getElementById(button.dataset.copyDraft);if(!field)return;const text=field.value;try{await navigator.clipboard.writeText(text);}catch{feedback.textContent="复制失败，请重试。";return;}if("copyOnly" in button.dataset){feedback.textContent="草稿已复制。";return;}cancelDraftSave(field);try{const result=await queueDraftWrite(field,"complete","copied",text);feedback.textContent=result.changed?"已记住你这次修改的回答":"草稿已复制。";}catch{feedback.textContent="已复制；这次修改暂未保存，请稍后重试";}});
    for(const form of document.querySelectorAll("[data-sent-draft]"))form.addEventListener("submit",()=>{const field=document.getElementById(form.dataset.sentDraft);if(!field)return;cancelDraftSave(field);const hidden=form.querySelector('[name="finalText"]');if(hidden)hidden.value=field.value;});
    const sendPanel=document.querySelector("[data-send-batch-panel]");
    const sendBatchEnterButton=document.querySelector("[data-send-batch-enter]");
    const sendBatchButton=document.querySelector("[data-send-batch]");
    const sendBatchExitButton=document.querySelector("[data-send-batch-exit]");
    const sendStopButton=document.querySelector("[data-send-stop]");
    const sendBatchTitle=document.querySelector("[data-send-batch-title]");
    const sendBatchStatus=document.querySelector("[data-send-batch-status]");
    const sendChoices=Array.from(document.querySelectorAll("[data-send-select]"));
    const sourceFilter=document.querySelector("[data-source-filter]");
    const taskFilter=document.querySelector("[data-task-filter]");
    const messageChoices=Array.from(document.querySelectorAll("[data-message-view]"));
    const messagePanels=Array.from(document.querySelectorAll("[data-message-detail-panel]"));
    const workspace=document.querySelector(".message-workspace");
    let selectedSource=initial.selectedSource;
    if(!initial.sourceFromQuery)try{const saved=localStorage.getItem("message-source-"+initial.profileId);if(["all","boss","zhaopin"].includes(saved))selectedSource=saved;}catch{}
    let selectedTask=initial.selectedTask;
    const selectedKeyStorage="message-selection-"+initial.profileId;
    let selectedKey=initial.initialSelectedKey||"";
    let selectionLocked=Boolean(initial.selectionLocked);
    if(!selectedKey&&!selectionLocked)try{selectedKey=localStorage.getItem(selectedKeyStorage)||"";}catch{}
    const terminalBatchStatuses=new Set(["completed","stopped","interrupted"]);
    let activeBatchId=0;
    let sendPending=false;
    let batchMode=false;
    let sendPollTimer=null;
    const ownedDraftCards=new WeakSet();
    const sendMessage=(code)=>({
      MESSAGE_REPLY_SEND_PROFILE_BUSY:"已有一批消息正在发送，请等待完成或停止后续发送。",
      MESSAGE_REPLY_SEND_LEASE_BUSY:"BOSS 正在执行另一项任务，请等待完成后再发送。",
      MESSAGE_REPLY_SEND_REVISION_CONFLICT:"草稿刚刚发生变化，请刷新页面后重新确认。",
      MESSAGE_REPLY_SEND_DRAFT_BUSY:"这条草稿已经属于另一批发送任务。",
      MESSAGE_REPLY_SEND_CONVERSATION_DUPLICATE:"同一条 HR 会话只能选择一个回复版本。",
      MESSAGE_REPLY_SEND_CONTEXT_REQUIRED:"这条草稿缺少可验证的 HR 消息上下文，未发送。",
      MESSAGE_DRAFT_FACT_UNSUPPORTED:"草稿里有系统找不到依据的个人信息，请修改后再发送。",
      MESSAGE_REPLY_SEND_ACTION_REQUIRED:"请从当前消息页面重新点击确认发送。"
    }[String(code||"")]||"发送没有开始，请刷新页面后重试。");
    const fieldForDraft=(draftId)=>document.querySelector('[data-draft-text][data-draft-id="'+Number(draftId)+'"]');
    const selectedFields=()=>sendChoices.filter((choice)=>batchMode&&choice.checked&&!choice.disabled&&(selectedSource==="all"||selectedSource==="boss")).map((choice)=>fieldForDraft(choice.dataset.sendSelect)).filter(Boolean);
    const clearBatchSelection=()=>{for(const choice of sendChoices)choice.checked=false;};
    const updateSelection=()=>{if(!sendBatchButton)return;const count=selectedFields().length;const batchVisible=batchMode&&selectedSource!=="zhaopin";sendBatchButton.hidden=!batchVisible;sendBatchButton.disabled=sendPending||count===0||activeBatchId>0;sendBatchButton.textContent="确认并串行发送 "+count+" 条";if(sendBatchEnterButton)sendBatchEnterButton.hidden=batchMode||activeBatchId>0||selectedSource==="zhaopin";if(sendBatchExitButton)sendBatchExitButton.hidden=!batchMode||activeBatchId>0;if(sendPanel)sendPanel.hidden=!batchMode&&!activeBatchId&&!sendPending;if(sendBatchTitle&&!activeBatchId)sendBatchTitle.textContent=batchMode?"已选择 "+count+" 条草稿":"批量发送尚未开始";};
    const setDiscoveryLocked=(locked)=>{for(const form of forms)for(const button of form.querySelectorAll("button")){if(!("sendBaseDisabled" in button.dataset))button.dataset.sendBaseDisabled=String(button.disabled);button.disabled=locked||button.dataset.sendBaseDisabled==="true";}};
    const setDraftPending=(fields,locked)=>{for(const field of fields){const card=field.closest("[data-draft-card]");if(!card||ownedDraftCards.has(card))continue;for(const control of card.querySelectorAll("button,input,textarea")){if(!("sendPendingBaseDisabled" in control.dataset))control.dataset.sendPendingBaseDisabled=String(control.disabled);control.disabled=locked||control.dataset.sendPendingBaseDisabled==="true";}}};
    const setOwned=(fields)=>{for(const field of fields){field.disabled=true;const card=field.closest("[data-draft-card]");if(!card)continue;ownedDraftCards.add(card);for(const control of card.querySelectorAll("button,input,textarea")){if(!("sendPendingBaseDisabled" in control.dataset))control.dataset.sendPendingBaseDisabled=String(control.disabled);control.disabled=true;}}};
    const releaseOwned=(field)=>{const card=field?.closest("[data-draft-card]");if(!card)return;ownedDraftCards.delete(card);for(const control of card.querySelectorAll("button,input,textarea"))control.disabled=control.dataset.sendPendingBaseDisabled==="true";};
    const sendStatusLabel=(status)=>({pending:"等待发送",selecting:"正在核对会话",verified:"目标已核对",filled:"草稿已填入",click_dispatched:"正在确认发送结果",succeeded:"已发送并记住本次修改",target_mismatch:"岗位或会话已变化，未发送",platform_rejected:"平台未接受本次发送",ambiguous:"发送结果不确定，请到 BOSS 消息页核对",stopped:"已停止，未发送"}[status]||"等待处理");
    const applySendState=(state)=>{if(!state?.batch||!Array.isArray(state.items))return;activeBatchId=Number(state.batch.id)||activeBatchId;const terminal=terminalBatchStatuses.has(state.batch.status);let finished=0;for(const item of state.items){const node=document.querySelector('[data-send-status="'+Number(item.draftId)+'"]');if(node){node.textContent=sendStatusLabel(item.status);node.dataset.state=item.status;}const field=fieldForDraft(item.draftId);if(field&&terminal&&["target_mismatch","platform_rejected","stopped"].includes(item.status))releaseOwned(field);else if(field)setOwned([field]);if(["succeeded","target_mismatch","platform_rejected","ambiguous","stopped"].includes(item.status))finished+=1;}if(sendPanel)sendPanel.dataset.state=state.batch.status;if(sendBatchTitle)sendBatchTitle.textContent="发送进度 "+finished+" / "+state.items.length;if(sendBatchStatus)sendBatchStatus.textContent=terminal?(state.batch.status==="completed"?"本批次已全部发送":"本批次已停止，未继续发送后续消息"):"正在后台逐条核对并发送，请不要关闭 RoleFlow";if(sendStopButton){sendStopButton.hidden=terminal;sendStopButton.disabled=terminal;}setDiscoveryLocked(!terminal);if(terminal){activeBatchId=0;sendPending=false;if(sendPollTimer!==null)clearTimeout(sendPollTimer);sendPollTimer=null;}else scheduleSendPoll();updateSelection();};
    const readSendResponse=async(response)=>{const parsed=await read(response);if(!response.ok||!parsed.json||!parsed.body?.batch)throw new Error(parsed.body?.errorCode||"MESSAGE_REPLY_SEND_FAILED");return parsed.body;};
    const postSendBatch=async(items)=>readSendResponse(await fetch("/api/message-reply-send-batch",{method:"POST",headers:{"content-type":"application/json","x-roleflow-action":initial.messageReplyActionToken},body:JSON.stringify({profileId:initial.profileId,items})}));
    const scheduleSendPoll=()=>{if(activeBatchId>0&&sendPollTimer===null)sendPollTimer=setTimeout(pollSend,1200);};
    const pollSend=async()=>{sendPollTimer=null;if(!activeBatchId)return;try{const state=await readSendResponse(await fetch("/api/message-reply-send-status?profileId="+encodeURIComponent(initial.profileId)+"&batchId="+encodeURIComponent(activeBatchId)));applySendState(state);}catch(error){feedback.textContent=sendMessage(error.message);}};
    const startSend=async(fields)=>{if(sendPending||activeBatchId||!fields.length)return;sendPending=true;setDraftPending(fields,true);setDiscoveryLocked(true);updateSelection();feedback.textContent="正在保存你确认的草稿。";try{const saved=await Promise.all(fields.map(saveDraft));const items=saved.map((result)=>({draftId:Number(result.draftId),revision:Number(result.revision)}));const state=await postSendBatch(items);setOwned(fields);applySendState(state);feedback.textContent="已确认，正在后台串行发送。";}catch(error){sendPending=false;setDraftPending(fields,false);setDiscoveryLocked(false);feedback.textContent=sendMessage(error.message);updateSelection();}};
    for(const choice of sendChoices)choice.addEventListener("change",updateSelection);
    for(const button of document.querySelectorAll("[data-send-single]"))button.addEventListener("click",()=>{const field=fieldForDraft(button.dataset.sendSingle);if(field)startSend([field]);});
    sendBatchButton?.addEventListener("click",()=>startSend(selectedFields()));
    sendBatchEnterButton?.addEventListener("click",()=>{batchMode=true;clearBatchSelection();updateSelection();});
    sendBatchExitButton?.addEventListener("click",()=>{batchMode=false;clearBatchSelection();updateSelection();});
    sendStopButton?.addEventListener("click",async()=>{if(!activeBatchId||sendStopButton.disabled)return;sendStopButton.disabled=true;try{const state=await readSendResponse(await fetch("/api/message-reply-send-control",{method:"POST",headers:{"content-type":"application/json","x-roleflow-action":initial.messageReplyActionToken},body:JSON.stringify({profileId:initial.profileId,batchId:activeBatchId,action:"stop"})}));applySendState(state);feedback.textContent="已停止后续发送。";}catch(error){sendStopButton.disabled=false;feedback.textContent=sendMessage(error.message);}});
    updateSelection();
    if(initial.initialReplySend)applySendState(initial.initialReplySend);
    const applySourceFilter=(preferredKey=selectedKey,persist=true)=>{
      if(!sourceFilter)return;
      sourceFilter.value=selectedSource;if(taskFilter)taskFilter.value=selectedTask;
      const rows=Array.from(document.querySelectorAll(".message-list-item[data-platform]"));
      for(const row of rows){const matchesTask=selectedTask==="all"||(selectedTask==="pending"&&row.dataset.pending==="true")||(selectedTask==="resume"&&row.dataset.resume==="true")||(selectedTask==="interview"&&row.dataset.interview==="true");row.hidden=(selectedSource!=="all"&&row.dataset.platform!==selectedSource)||!matchesTask;}
      const visibleChoices=messageChoices.filter(choice=>!choice.closest(".message-list-item")?.hidden);
      const next=selectionLocked?null:(visibleChoices.find(choice=>choice.dataset.messageView===preferredKey)||visibleChoices.find(choice=>choice.dataset.messageView===selectedKey)||visibleChoices[0]||null);
      selectedKey=next?.dataset.messageView||"";
      for(const choice of messageChoices)choice.checked=choice===next;
      for(const panel of messagePanels)panel.hidden=panel.dataset.messageDetailPanel!==selectedKey;
      const empty=document.querySelector("[data-source-empty]");if(empty)empty.hidden=Boolean(next);
      if(persist)try{if(selectedKey)localStorage.setItem(selectedKeyStorage,selectedKey);else localStorage.removeItem(selectedKeyStorage);}catch{}
      updateSelection();
    };
    let pendingTransition=null;
    let transitionRunning=false;
    const requestTransition=(transition)=>{pendingTransition=transition;applySourceFilter(selectedKey,false);runTransitions();};
    const runTransitions=async()=>{if(transitionRunning)return;transitionRunning=true;if(sourceFilter)sourceFilter.disabled=true;if(taskFilter)taskFilter.disabled=true;while(pendingTransition){let next=pendingTransition;pendingTransition=null;const current=messagePanels.find(panel=>panel.dataset.messageDetailPanel===selectedKey);const fields=Array.from(current?.querySelectorAll("[data-draft-text]")||[]).filter(field=>!field.disabled);try{await saveStableDrafts(fields);}catch{pendingTransition=null;feedback.textContent="当前草稿未能保存，已保留当前消息，请稍后重试。";applySourceFilter(selectedKey,false);if(next.back)fields[0]?.focus();break;}if(pendingTransition){next=pendingTransition;pendingTransition=null;}if(next.source){selectedSource=next.source;clearBatchSelection();try{localStorage.setItem("message-source-"+initial.profileId,selectedSource);}catch{}}if(next.task){selectedTask=next.task;clearBatchSelection();}applySourceFilter(next.key||selectedKey);if(next.back&&mobileList()&&workspace){workspace.dataset.mobileList="true";const selected=messageChoices.find(choice=>choice.dataset.messageView===selectedKey);selected?.focus();}}transitionRunning=false;if(sourceFilter)sourceFilter.disabled=false;if(taskFilter)taskFilter.disabled=false;if(pendingTransition)runTransitions();};
    const mobileList=()=>Boolean(typeof window!=="undefined"&&window.matchMedia&&window.matchMedia("(max-width: 760px)").matches);
    let wasMobile=mobileList();
    let detailChosen=Boolean(initial.directContact);
    if(wasMobile&&workspace&&!initial.directContact)workspace.dataset.mobileList="true";
    if(typeof window!=="undefined")window.addEventListener("resize",()=>{const nowMobile=mobileList();if(!nowMobile&&workspace)delete workspace.dataset.mobileList;if(nowMobile&&!wasMobile&&workspace&&!detailChosen)workspace.dataset.mobileList="true";wasMobile=nowMobile;});
    for(const choice of messageChoices)choice.addEventListener("change",()=>{if(choice.checked){detailChosen=true;selectionLocked=false;if(workspace)delete workspace.dataset.mobileList;requestTransition({key:choice.dataset.messageView});}});
    for(const button of document.querySelectorAll("[data-message-back]"))button.addEventListener("click",()=>{if(mobileList())requestTransition({back:true});});
    sourceFilter?.addEventListener("change",()=>{const source=["all","boss","zhaopin"].includes(sourceFilter.value)?sourceFilter.value:"all";requestTransition({source});});
    taskFilter?.addEventListener("change",()=>{const task=["pending","all","resume","interview"].includes(taskFilter.value)?taskFilter.value:"pending";requestTransition({task});});
    applySourceFilter();
    for(const link of document.querySelectorAll("[data-flush-drafts], .primary-nav a"))link.addEventListener("click",async(event)=>{const fields=Array.from(document.querySelectorAll("[data-draft-text]")).filter(field=>!field.disabled);if(!fields.length)return;event.preventDefault();try{await saveStableDrafts(fields);location.href=link.href;}catch{feedback.textContent="当前草稿未能保存，请稍后重试。";}});
    const poll=async()=>{pollTimer=null;if(reloadPending||pollPending||actionPending)return;pollPending=true;const version=actionVersion;try{const response=await fetch("/api/message-discovery-status?profileId="+encodeURIComponent(initial.profileId));const parsed=await read(response);if(reloadPending||actionPending||version!==actionVersion)return;if(!accepted(response,parsed,pollStatuses)){show(rejectedCode(parsed));return;}currentStatus=parsed.body.status;if(currentStatus==="running")schedulePoll();else requestReload();}catch{if(!reloadPending&&!actionPending&&version===actionVersion)show("MESSAGE_DISCOVERY_BROWSER_UNAVAILABLE");}finally{pollPending=false;if(!reloadPending&&!actionPending&&version!==actionVersion&&currentStatus==="running")schedulePoll();}};
    if(currentStatus==="running")schedulePoll();
  }());</script>`;
}

function renderUnresolvedItem(db, item, { profileId, viewKey, hidden, escapeHtml, escapeAttr }) {
  const attributes = `id="message-detail-${viewKey}" class="panel message-unresolved" data-platform="${escapeAttr(item.platform || "")}" data-message-detail-panel="${viewKey}"${hidden ? " hidden" : ""}`;
  if (item.platform === "zhaopin") return `<section ${attributes}><button type="button" class="message-back" data-message-back>返回列表</button><h2>${escapeHtml(item.positionTitle || "待处理消息")}</h2><p class="message-source">智联</p>${(item.inboundMessages || []).map(message => `<p class="line">${escapeHtml(message.text)}</p>`).join("")}<p class="risk-text">${escapeHtml(messageDiscoveryReasonText(item.reasonCode))}</p><p class="line">岗位分析尚未完成。可重新开始只读发现，或自行到智联原始会话处理。</p></section>`;
  const complete = Boolean(String(item.positionTitle || "").trim() && String(item.company || "").trim());
  const matches = complete ? exactIdentityCandidates(db, profileId, item) : [];
  const hiddenInputs = `<input type="hidden" name="profileId" value="${profileId}"><input type="hidden" name="conversationKey" value="${escapeAttr(item.conversationKey)}"><input type="hidden" name="previewDigest" value="${escapeAttr(item.previewDigest)}">`;
  const candidateChoices = matches.map((job) =>
    `<label><input type="radio" name="jobId" value="${job.id}"${matches.length === 1 ? " checked" : ""}>${escapeHtml(job.title)} · ${escapeHtml(job.company || "")}</label>`
  ).join("");
  const link = complete && matches.length
    ? `<form method="post" action="/api/message-discovery-unresolved">${hiddenInputs}<input type="hidden" name="action" value="link"><fieldset><legend>关联现有岗位</legend>${candidateChoices}</fieldset><button class="secondary">关联现有岗位</button></form>`
    : `<button class="secondary" disabled>关联现有岗位</button>`;
  const create = `<form method="post" action="/api/message-discovery-unresolved">${hiddenInputs}<button name="action" value="create"${complete ? "" : " disabled"}>保存为 HR 主动机会</button></form>`;
  const ignore = `<form method="post" action="/api/message-discovery-unresolved">${hiddenInputs}<button class="secondary" name="action" value="ignore">不纳入 RoleFlow</button></form>`;
  const incomplete = complete ? "" : `<p class="risk-text">岗位身份仍不完整，请下次只读发现后再处理。</p>`;
  return `<section ${attributes}><button type="button" class="message-back" data-message-back>返回列表</button><h2>${escapeHtml(item.positionTitle || "岗位名称待确认")}</h2><p class="message-source">BOSS</p><p class="line">${escapeHtml(item.company || "公司待确认")} · ${escapeHtml(item.salary || "薪资待确认")} · ${escapeHtml(item.city || "地点待确认")}</p>${incomplete}<p class="risk-text">${escapeHtml(messageDiscoveryReasonText(item.reasonCode))}</p><p class="line">以上仅为岗位身份字段；没有保存招聘方姓名或消息正文。</p><div class="message-controls">${link}${create}${ignore}</div></section>`;
}

function messageViewKey(type, parts) {
  return `${type}-${crypto.createHash("sha256").update(JSON.stringify(parts.map((part) => String(part || "")))).digest("hex")}`;
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

function messageIntentLabel(value) {
  return {
    interview_invitation: "正式面试邀约",
    interest_check: "询问是否有意向",
    information_request: "需要你补充信息",
    information_update: "对方补充了信息",
    general_communication: "普通沟通",
    manual_review: "需要人工判断"
  }[String(value || "")] || "需要人工判断";
}

function messageDiscoveryManualActionText(result) {
  if (result?.missingFactKey) return "缺少事实，暂不生成草稿。请先人工确认后再回复。";
  if (result?.messageIntent === "manual_review") {
    return result?.manualActionReason || "当前消息需要人工判断，暂不生成草稿。";
  }
  const category = String(result?.messageCategory || "");
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
  if (status?.phase === "reading_messages") return "正在加载并读取消息，可随时安全停止。";
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
    ZHAOPIN_MESSAGE_CONTENT_PENDING: "这条会话的消息还没有加载完成，已保留待重试。稍后可重新开始只读发现。",
    ZHAOPIN_MESSAGE_CONTENT_UNSUPPORTED: "这条消息包含暂时无法读取的内容，已保留。请自行到智联原始会话查看。",
    ZHAOPIN_MESSAGE_STRUCTURE_CHANGED: "智联消息页面暂时无法可靠读取，已保留待重试。",
    ZHAOPIN_MESSAGE_TIMELINE_FAILED: "智联会话内容暂时未能加载，已保留待重试。",
    ZHAOPIN_MESSAGE_TAB_AMBIGUOUS: "连接了多个智联消息页，请只保留一个后重试。",
    ZHAOPIN_MESSAGE_LOGIN_REQUIRED: "智联登录已失效，请登录后重试。",
    ZHAOPIN_MESSAGE_RISK_CONTROL: "智联需要完成安全检查，请处理后重试。",
    ZHAOPIN_MESSAGE_PAGE_LOST: "智联消息页已变化，请恢复消息页后重试。",
    ZHAOPIN_MESSAGE_DETAIL_COMPANY_UNVERIFIED: "会话与岗位详情的公司名称暂时无法核对。消息已保留，未关联岗位或生成草稿；你可以到智联原始会话核对。",
    ZHAOPIN_MESSAGE_DETAIL_TARGET_MISMATCH: "会话与岗位详情不一致，本次只读发现已停止。请核对智联当前会话后再重试。",
    ZHAOPIN_MESSAGE_DETAIL_INCOMPLETE: "这份岗位详情还不完整，消息已保留，暂不生成草稿。可稍后重新只读发现。",
    MESSAGE_DISCOVERY_JOB_CONTEXT_UNAVAILABLE: "本地还没有这份智联岗位的完整分析。请先在智联今日任务中完成岗位发现和分析，再重新读取消息。",
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
    BOSS_MESSAGE_DETAIL_BROWSER_FAILED: "后台岗位详情读取遇到浏览器异常。该会话已保留，本次只读发现已安全停止。",
    BOSS_MESSAGE_DETAIL_NOT_BACKGROUND: "岗位详情未能保持后台安全打开；若临时页已创建，系统会先关闭它。该会话已保留，本次只读发现已停止，请保持专用 Edge 的固定标签页不变后重试。",
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
  messageDiscoveryClientScript,
  messageDiscoveryReasonText,
  messageIntentLabel
};
