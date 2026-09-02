"use strict";

const { escapeHtml, escapeAttr } = require("../http/response");
const { messageDiscoveryClientScript } = require("../message_discovery_view");

function renderMessageFollowUpPage({
  searchParams,
  service,
  replySendController = null,
  messageReplyActionToken = "",
  helpers
}) {
  const profileId = positiveInteger(searchParams.get("profileId"));
  const planId = positiveInteger(searchParams.get("planId"));
  if (!profileId || !planId) {
    return helpers.renderErrorPage("候选人或求职方案无效。", "/onboarding", { code: "FOLLOW_UP_SCOPE_INVALID" });
  }
  let candidates;
  try {
    candidates = service.listCandidates({ profileId, planId });
  } catch (error) {
    return helpers.renderErrorPage("无法读取当前可跟进岗位。", `/plan?profileId=${profileId}&planId=${planId}`, {
      code: String(error?.code || "FOLLOW_UP_LIST_FAILED")
    });
  }
  const prepared = candidates.filter((candidate) => Number(candidate?.draft?.id) > 0);
  const cards = candidates.map((candidate) => renderCandidate(candidate, { profileId, planId })).join("");
  const selectedCount = prepared.length;
  const sendPanel = selectedCount ? `<section class="message-send-batch" data-send-batch-panel data-state="idle" aria-label="确认发送">
    <div><strong data-send-batch-title>已选择 ${selectedCount} 条草稿</strong><span data-send-batch-status>后台逐条核对后串行发送</span></div>
    <div class="button-row"><button type="button" data-send-batch>确认并串行发送 ${selectedCount} 条</button><button type="button" class="secondary" data-send-stop hidden disabled>停止后续发送</button></div>
  </section>` : "";
  const initialReplySend = replySendController?.latest?.({ profileId }) || null;
  const scriptState = JSON.stringify({
    profileId,
    status: "completed",
    recoveryMessages: { default: "操作没有完成，请稍后重试。" },
    initialReplySend,
    messageReplyActionToken: String(messageReplyActionToken || "")
  });
  return helpers.renderFramedPage({
    title: "无回复跟进",
    currentPath: `/follow-ups?profileId=${encodeURIComponent(profileId)}&planId=${encodeURIComponent(planId)}`,
    todayPath: `/plan?profileId=${encodeURIComponent(profileId)}&planId=${encodeURIComponent(planId)}`,
    planId,
    stage: "跟进",
    brandHref: `/plan?profileId=${encodeURIComponent(profileId)}&planId=${encodeURIComponent(planId)}`,
    content: `<main id="main-content" class="message-layout follow-up-main"><header class="page-heading"><p class="eyebrow">沟通节奏</p><h1>无回复跟进</h1><p class="lede">这里只列出已过观察期、仍在等待回复的岗位。先准备草稿，确认文字后再发送。</p></header><p class="message-feedback" data-discovery-feedback role="status" aria-live="polite" aria-busy="false"></p>${cards || '<section class="panel follow-up-empty"><h2>当前没有需要跟进的岗位</h2><p class="line">收到新回复或岗位状态变化后，系统会自动重新判断。</p></section>'}${sendPanel}<p class="button-row"><a class="button-link secondary" data-flush-drafts href="/plan?profileId=${profileId}&amp;planId=${planId}">返回今日任务</a></p></main>`,
    scripts: prepared.length ? [messageDiscoveryClientScript(scriptState)] : []
  });
}

function renderCandidate(candidate, { profileId, planId }) {
  const job = candidate.job || {};
  const hours = Math.max(0, Math.floor(Number(candidate.projection?.waitedHours) || 0));
  const prior = candidate.context?.inboundMessages?.[0]?.text || "";
  const draft = candidate.draft;
  const body = draft
    ? `${prior ? `<div class="follow-up-prior"><strong>你上次发送</strong><p>${escapeHtml(prior)}</p></div>` : ""}${renderDraft(draft)}`
    : `<form method="post" action="/api/message-follow-up/prepare"><input type="hidden" name="profileId" value="${profileId}"><input type="hidden" name="planId" value="${planId}"><input type="hidden" name="jobId" value="${escapeAttr(candidate.jobId)}"><button>准备跟进草稿</button></form>`;
  return `<article class="panel follow-up-card"><header><div><h2>${escapeHtml(job.title || "岗位待确认")}</h2><p class="line">${escapeHtml(job.company || "公司待确认")}</p></div><span class="status waiting">已等待 ${hours} 小时</span></header>${body}</article>`;
}

function renderDraft(draft) {
  const id = `follow-up-draft-${Number(draft.id)}`;
  const text = draft.currentText ?? draft.text ?? "";
  const revision = Math.max(0, Number(draft.revision) || 0);
  return `<section class="message-draft" data-draft-card="${Number(draft.id)}"><label for="${id}">跟进草稿</label><textarea id="${id}" data-draft-text data-draft-id="${Number(draft.id)}" data-revision="${revision}" data-draft-revision="${revision}">${escapeHtml(text)}</textarea><p class="message-draft-save-status" data-draft-save-status="${Number(draft.id)}" role="status">已自动保存</p><button type="button" data-copy-draft="${id}">复制到本机剪贴板</button><div class="message-draft-actions"><label class="message-send-choice"><input type="checkbox" data-send-select="${Number(draft.id)}" checked>加入本次发送</label><button type="button" data-send-single="${Number(draft.id)}">确认发送</button></div><p class="message-send-status" data-send-status="${Number(draft.id)}" role="status">等待确认</p></section>`;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

module.exports = { renderMessageFollowUpPage };
