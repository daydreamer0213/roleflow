const { listUnresolvedMessageDiscoveryItems } = require("../core/message_preview_state");

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
    const manualActions = (result.manualActions || []).filter((item) => item?.kind === "resume_request");
    const durableDrafts = Array.isArray(result.drafts) ? result.drafts.filter((draft) => Number(draft?.id) > 0) : [];
    const draftItems = durableDrafts.length
      ? durableDrafts
      : (result.messages || []).map((text) => ({ id: 0, text, revision: 0 }));
    const drafts = draftItems.map((draft, messageIndex) => {
      const id = draft.id > 0 ? `message-draft-${draft.id}` : `message-draft-${resultIndex}-${messageIndex}`;
      const editable = draft.id > 0;
      const sent = editable
        ? `<form method="post" action="/api/progress" data-sent-draft="${id}"><input type="hidden" name="cardId" value="${result.cardId}"><input type="hidden" name="draftId" value="${draft.id}"><input type="hidden" name="finalText" value=""><input type="hidden" name="idempotencyKey" value="${escapeAttr(newProgressRequestKey())}"><input type="hidden" name="action" value="reply_confirmed_sent"><button class="secondary">我已在 BOSS 手动发送</button></form>`
        : "";
      const alternativeSelector = draftItems.length > 1
        ? `<input type="radio" name="message-send-choice-${Number(result.cardId)}" data-send-select="${draft.id}"${messageIndex === 0 ? " checked" : ""}>选择这版回复`
        : `<input type="checkbox" data-send-select="${draft.id}" checked>加入本次发送`;
      const send = editable
        ? `<div class="message-draft-actions"><label class="message-send-choice">${alternativeSelector}</label><button type="button" data-send-single="${draft.id}">确认发送</button></div><p class="message-send-status" data-send-status="${draft.id}" role="status">等待确认</p>`
        : "";
      const saveStatus = editable
        ? `<p class="message-draft-save-status" data-draft-save-status="${draft.id}" role="status">已自动保存</p>`
        : "";
      return `<section class="message-draft" data-draft-card="${draft.id}"><label for="${id}">草稿 ${messageIndex + 1}</label><textarea id="${id}"${editable ? ` data-draft-text data-draft-id="${draft.id}" data-revision="${draft.revision}" data-draft-revision="${draft.revision}"` : " readonly"}>${escapeHtml(draft.text)}</textarea>${saveStatus}<button type="button" data-copy-draft="${id}"${editable ? "" : " data-copy-only"}>复制到本机剪贴板</button>${send}${sent}</section>`;
    }).join("");
    const inboundMessages = Array.isArray(result.inboundMessages) ? result.inboundMessages : [];
    const inboundSection = inboundMessages.length
      ? `<section class="message-inbound"><h3>HR 消息</h3>${inboundMessages.map((message) => `<p class="line">${escapeHtml(message.text)}</p>`).join("")}</section>`
      : "";
    const source = result.contextSource === "local_cache"
      ? "本地已有岗位资料"
      : result.contextSource === "message_discovery_detail"
        ? "本次后台只读岗位详情"
        : "岗位资料来源待确认";
    const decisionCard = `<section class="message-job-understanding">
      <p class="line"><strong>沟通结论：</strong>${escapeHtml(messageIntentLabel(result.messageIntent))}${result.messageSummary ? ` · ${escapeHtml(result.messageSummary)}` : ""}</p>
      <p class="line"><strong>这份机会：</strong>${escapeHtml(job.opportunityVerdict || "信息不足，暂时无法判断")}${job.opportunitySummary ? ` · ${escapeHtml(job.opportunitySummary)}` : ""}</p>
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
    const sentForm = drafts && !durableDrafts.length
      ? `<form method="post" action="/api/progress"><input type="hidden" name="cardId" value="${result.cardId}"><input type="hidden" name="idempotencyKey" value="${escapeAttr(newProgressRequestKey())}"><input type="hidden" name="action" value="reply_confirmed_sent"><button class="secondary">我已在 BOSS 手动发送</button></form>`
      : "";
    return `<section class="panel message-result"><h2>${escapeHtml(job.title || "岗位处理结果")}</h2><p class="line">${escapeHtml(job.company || "公司待确认")} · 阶段：${escapeHtml(progressStageLabel(result.stage))}</p>${inboundSection}${decisionCard}<h3>下一步</h3>${nextSection}${sentForm}</section>`;
  }).join("");
  const controls = `<section class="message-controls" aria-label="消息发现操作">
    <form data-discovery-form method="post" action="/api/message-discovery"><input type="hidden" name="action" value="start"><input type="hidden" name="profileId" value="${profileId}"><button data-page-primary="true"${status.status === "running" ? " disabled" : ""}>开始只读发现</button></form>
    <form data-discovery-form method="post" action="/api/message-discovery"><input type="hidden" name="action" value="stop"><input type="hidden" name="profileId" value="${profileId}"><button class="secondary"${status.status === "running" ? "" : " disabled"}>安全停止</button></form>
    <form data-discovery-form method="post" action="/api/message-discovery"><input type="hidden" name="action" value="dismiss"><input type="hidden" name="profileId" value="${profileId}"><button class="secondary"${status.status !== "running" && status.results.length ? "" : " disabled"}>清除本次结果</button></form>
  </section>`;
  const sendableDraftCount = status.results.reduce((count, result) => count
    + (Array.isArray(result.drafts) ? result.drafts.filter((draft) => Number(draft?.id) > 0).length : 0), 0);
  const selectedDraftCount = status.results.reduce((count, result) => count
    + (Array.isArray(result.drafts) && result.drafts.some((draft) => Number(draft?.id) > 0) ? 1 : 0), 0);
  const sendBatchPanel = sendableDraftCount > 0 ? `<section class="message-send-batch" data-send-batch-panel data-state="idle" aria-label="确认发送">
    <div><strong data-send-batch-title>已选择 ${selectedDraftCount} 条草稿</strong><span data-send-batch-status>逐条确认目标后在后台串行发送</span></div>
    <div class="button-row"><button type="button" data-send-batch>确认并串行发送 ${selectedDraftCount} 条</button><button type="button" class="secondary" data-send-stop hidden disabled>停止后续发送</button></div>
  </section>` : "";
  const unresolvedSections = durableUnresolved.map((item) =>
    renderUnresolvedItem(db, item, { profileId, escapeHtml, escapeAttr })
  ).join("");
  const counters = status.counters || {};
  const scriptState = JSON.stringify({
    profileId,
    status: status.status,
    recoveryMessages,
    initialReplySend,
    messageReplyActionToken: String(messageReplyActionToken || "")
  });
  return renderFramedPage({
    title: "BOSS 消息发现与回复",
    currentPath,
    todayPath: plan?.id ? `/plan?planId=${plan.id}` : "/onboarding",
    planId: plan?.id || "",
    stage: "消息",
    brandHref: plan?.id ? `/plan?planId=${plan.id}` : "/onboarding",
    content: `<main id="main-content" class="message-layout"><header class="page-heading"><p class="eyebrow">消息工作台</p><h1>BOSS 消息发现与回复</h1><p class="lede">先在后台只读发现 HR 新消息并准备草稿。你修改后点击“确认发送”，系统才会在固定消息页逐条核对、填入并发送；也可以继续复制后人工处理。</p></header>${controls}<p class="message-feedback" data-discovery-feedback role="status" aria-live="polite" aria-busy="false"></p><section class="panel message-state"><h2>${escapeHtml(statusLabel)}</h2><p class="line">可见 ${Math.max(0, Number(counters.visible) || 0)} · HR 新回复 ${Math.max(0, Number(counters.newReplies) || 0)} · 已读 ${Math.max(0, Number(counters.currentRead) || 0)} · 送达 ${Math.max(0, Number(counters.currentDelivered) || 0)}</p><p class="line">排队 ${status.queued} · 已处理 ${status.processed} · 未解决 ${Math.max(0, Number(status.unresolved) || 0)}</p>${phaseNotice ? `<p class="line">${escapeHtml(phaseNotice)}</p>` : ""}${reason ? `<p class="risk-text">${escapeHtml(reason)}</p>` : ""}</section>${unresolvedSections}${resultSections || (!unresolvedSections ? '<section class="panel"><p class="line">当前没有岗位处理结果。</p></section>' : "")}${sendBatchPanel}<p class="button-row"><a class="button-link secondary" data-flush-drafts href="/communication-profile?profileId=${encodeURIComponent(profileId)}">管理我的沟通资料</a><a class="button-link secondary" data-flush-drafts href="${escapeAttr(manualPath)}">返回人工粘贴流程</a></p></main>`,
    scripts: [messageDiscoveryClientScript(scriptState)]
  });
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
    for(const field of document.querySelectorAll("[data-draft-text]"))field.addEventListener("input",()=>{setDraftSaveStatus(field,"有修改待保存");cancelDraftSave(field);draftTimers.set(field,setTimeout(async()=>{draftTimers.delete(field);try{await queueDraftWrite(field,"save");}catch{feedback.textContent="本次修改还没有保存，请稍后重试。";}},600));});
    for(const button of document.querySelectorAll("[data-copy-draft]"))button.addEventListener("click",async()=>{const field=document.getElementById(button.dataset.copyDraft);if(!field)return;const text=field.value;try{await navigator.clipboard.writeText(text);}catch{feedback.textContent="复制失败，请重试。";return;}if("copyOnly" in button.dataset){feedback.textContent="草稿已复制。";return;}cancelDraftSave(field);try{const result=await queueDraftWrite(field,"complete","copied",text);feedback.textContent=result.changed?"已记住你这次修改的回答":"草稿已复制。";}catch{feedback.textContent="已复制；这次修改暂未保存，请稍后重试";}});
    for(const form of document.querySelectorAll("[data-sent-draft]"))form.addEventListener("submit",()=>{const field=document.getElementById(form.dataset.sentDraft);if(!field)return;cancelDraftSave(field);const hidden=form.querySelector('[name="finalText"]');if(hidden)hidden.value=field.value;});
    const sendPanel=document.querySelector("[data-send-batch-panel]");
    const sendBatchButton=document.querySelector("[data-send-batch]");
    const sendStopButton=document.querySelector("[data-send-stop]");
    const sendBatchTitle=document.querySelector("[data-send-batch-title]");
    const sendBatchStatus=document.querySelector("[data-send-batch-status]");
    const sendChoices=Array.from(document.querySelectorAll("[data-send-select]"));
    const terminalBatchStatuses=new Set(["completed","stopped","interrupted"]);
    let activeBatchId=0;
    let sendPending=false;
    let sendPollTimer=null;
    const ownedDraftCards=new WeakSet();
    const sendMessage=(code)=>({
      MESSAGE_REPLY_SEND_PROFILE_BUSY:"已有一批消息正在发送，请等待完成或停止后续发送。",
      MESSAGE_REPLY_SEND_LEASE_BUSY:"BOSS 正在执行另一项任务，请等待完成后再发送。",
      MESSAGE_REPLY_SEND_REVISION_CONFLICT:"草稿刚刚发生变化，请刷新页面后重新确认。",
      MESSAGE_REPLY_SEND_DRAFT_BUSY:"这条草稿已经属于另一批发送任务。",
      MESSAGE_REPLY_SEND_CONVERSATION_DUPLICATE:"同一条 HR 会话只能选择一个回复版本。",
      MESSAGE_REPLY_SEND_CONTEXT_REQUIRED:"这条草稿缺少可验证的 HR 消息上下文，未发送。",
      MESSAGE_REPLY_SEND_ACTION_REQUIRED:"请从当前消息页面重新点击确认发送。"
    }[String(code||"")]||"发送没有开始，请刷新页面后重试。");
    const fieldForDraft=(draftId)=>document.querySelector('[data-draft-text][data-draft-id="'+Number(draftId)+'"]');
    const selectedFields=()=>sendChoices.filter((choice)=>choice.checked&&!choice.disabled).map((choice)=>fieldForDraft(choice.dataset.sendSelect)).filter(Boolean);
    const updateSelection=()=>{if(!sendBatchButton)return;const count=selectedFields().length;sendBatchButton.disabled=sendPending||count===0||activeBatchId>0;sendBatchButton.textContent="确认并串行发送 "+count+" 条";if(sendBatchTitle&&!activeBatchId)sendBatchTitle.textContent="已选择 "+count+" 条草稿";};
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
    sendStopButton?.addEventListener("click",async()=>{if(!activeBatchId||sendStopButton.disabled)return;sendStopButton.disabled=true;try{const state=await readSendResponse(await fetch("/api/message-reply-send-control",{method:"POST",headers:{"content-type":"application/json","x-roleflow-action":initial.messageReplyActionToken},body:JSON.stringify({profileId:initial.profileId,batchId:activeBatchId,action:"stop"})}));applySendState(state);feedback.textContent="已停止后续发送。";}catch(error){sendStopButton.disabled=false;feedback.textContent=sendMessage(error.message);}});
    updateSelection();
    if(initial.initialReplySend)applySendState(initial.initialReplySend);
    for(const link of document.querySelectorAll("[data-flush-drafts]"))link.addEventListener("click",async(event)=>{const fields=Array.from(document.querySelectorAll("[data-draft-text]"));if(!fields.length)return;event.preventDefault();await Promise.allSettled(fields.map(saveDraft));location.href=link.href;});
    const poll=async()=>{pollTimer=null;if(reloadPending||pollPending||actionPending)return;pollPending=true;const version=actionVersion;try{const response=await fetch("/api/message-discovery-status?profileId="+encodeURIComponent(initial.profileId));const parsed=await read(response);if(reloadPending||actionPending||version!==actionVersion)return;if(!accepted(response,parsed,pollStatuses)){show(rejectedCode(parsed));return;}currentStatus=parsed.body.status;if(currentStatus==="running")schedulePoll();else requestReload();}catch{if(!reloadPending&&!actionPending&&version===actionVersion)show("MESSAGE_DISCOVERY_BROWSER_UNAVAILABLE");}finally{pollPending=false;if(!reloadPending&&!actionPending&&version!==actionVersion&&currentStatus==="running")schedulePoll();}};
    if(currentStatus==="running")schedulePoll();
  }());</script>`;
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
    BOSS_MESSAGE_DETAIL_BROWSER_FAILED: "后台岗位详情读取遇到浏览器异常。该会话已保留，本次只读发现已安全停止。",
    BOSS_MESSAGE_DETAIL_NOT_BACKGROUND: "岗位详情未能在后台安全打开。请还原 RoleFlow 专用 Edge（推荐）窗口后重试；若临时页已打开，系统会先关闭它。该会话已保留，本次只读发现已停止。",
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
  messageDiscoveryReasonText,
  messageIntentLabel
};
