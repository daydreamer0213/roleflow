const FACT_LABELS = Object.freeze({
  employment_status: "当前求职状态",
  availability_date: "到岗时间",
  current_city: "当前所在城市",
  expected_salary: "期望薪资",
  accepts_travel: "能否接受出差",
  accepts_relocation: "能否接受异地工作",
  accepts_overtime: "对加班的态度"
});

function renderCommunicationProfilePage({ db, searchParams, service, helpers }) {
  const {
    getCandidateProfile,
    renderErrorPage,
    renderFramedPage,
    escapeHtml,
    escapeAttr
  } = helpers;
  const profileId = Number(searchParams.get("profileId"));
  if (!Number.isSafeInteger(profileId) || profileId <= 0) {
    return renderErrorPage("profileId 无效。", "/onboarding", { code: "COMMUNICATION_PROFILE_INVALID" });
  }
  const profile = getCandidateProfile(db, profileId);
  if (!profile) return renderErrorPage("候选人画像不存在。", "/onboarding", { code: "COMMUNICATION_PROFILE_NOT_FOUND" });
  const plan = db.prepare(`SELECT id FROM search_plans WHERE profile_id = ?
    ORDER BY is_active DESC, updated_at DESC, id DESC LIMIT 1`).get(profileId);
  const data = service.listCommunicationProfile({ profileId });
  const facts = data.facts.map((fact) => renderFact(fact, { profileId, escapeHtml, escapeAttr })).join("")
    || '<p class="line">目前还没有额外记录。你改写回复后，RoleFlow 会把明确的新信息补到这里。</p>';
  const answers = data.answers.map((answer) => renderAnswer(answer, { profileId, escapeHtml, escapeAttr })).join("")
    || '<p class="line">目前还没有你改过并采用的回答。</p>';
  const history = data.revisions.map((revision) => {
    const action = revision.operation === "delete" ? "已删除" : "更新为";
    const value = revision.operation === "delete" ? "" : `：${escapeHtml(revision.factValue)}`;
    return `<li><strong>${escapeHtml(factLabel(revision.factKey))}</strong> ${action}${value}<span class="line"> · ${escapeHtml(formatTime(revision.createdAt))}</span></li>`;
  }).join("") || "<li>还没有历史修改。</li>";
  const messagesPath = `/messages?profileId=${encodeURIComponent(profileId)}`;
  return renderFramedPage({
    title: "我的沟通资料",
    currentPath: `/communication-profile?profileId=${encodeURIComponent(profileId)}`,
    todayPath: plan?.id ? `/plan?planId=${plan.id}` : "/onboarding",
    planId: plan?.id || "",
    stage: "消息",
    brandHref: plan?.id ? `/plan?planId=${plan.id}` : "/onboarding",
    content: `<main id="main-content" class="message-layout"><header class="page-heading"><p class="eyebrow">越用越懂你</p><h1>我的沟通资料</h1><p class="lede">这里保存你亲自修改过的回答和明确资料。以后遇到同类问题，RoleFlow 会优先参考你确认过的说法。</p></header><section class="panel"><h2>我目前使用的沟通资料</h2>${facts}</section><section class="panel"><h2>我改过并让 RoleFlow 记住的回答</h2>${answers}</section><details class="panel"><summary>历史修改</summary><ul>${history}</ul></details><p><a class="button-link secondary" href="${escapeAttr(messagesPath)}">返回消息发现</a></p></main>`
  });
}

function renderFact(fact, { profileId, escapeHtml, escapeAttr }) {
  const key = String(fact.factKey || "");
  return `<article class="message-draft"><h3>${escapeHtml(factLabel(key))}</h3><form class="form-stack" method="post" action="/api/communication-profile"><input type="hidden" name="action" value="save_fact"><input type="hidden" name="profileId" value="${profileId}"><input type="hidden" name="factKey" value="${escapeAttr(key)}"><label>当前说法<input name="factValue" value="${escapeAttr(fact.factValue)}" required></label><button>保存修改</button></form><form method="post" action="/api/communication-profile"><input type="hidden" name="action" value="delete_fact"><input type="hidden" name="profileId" value="${profileId}"><input type="hidden" name="factKey" value="${escapeAttr(key)}"><button class="secondary">删除这条资料</button></form></article>`;
}

function renderAnswer(answer, { profileId, escapeHtml, escapeAttr }) {
  return `<article class="message-draft"><h3>${escapeHtml(answer.questionSummary || "我确认过的一次回答")}</h3><p class="line">适用于：${escapeHtml(scopeDescription(answer.scope))} · 更新于 ${escapeHtml(formatTime(answer.updatedAt))}</p><form class="form-stack" method="post" action="/api/communication-profile"><input type="hidden" name="action" value="revise_memory"><input type="hidden" name="profileId" value="${profileId}"><input type="hidden" name="memoryId" value="${answer.id}"><label>我希望以后使用的说法<textarea name="finalText" required>${escapeHtml(answer.finalText)}</textarea></label><button>保存修改</button></form><form method="post" action="/api/communication-profile"><input type="hidden" name="action" value="withdraw_memory"><input type="hidden" name="profileId" value="${profileId}"><input type="hidden" name="memoryId" value="${answer.id}"><button class="secondary">不再使用这条回答</button></form></article>`;
}

function factLabel(key) {
  if (FACT_LABELS[key]) return FACT_LABELS[key];
  if (String(key).startsWith("gap.")) return "经历空档说明";
  if (String(key).startsWith("leaving_reason.")) return "离职原因说明";
  if (String(key).startsWith("short_project.")) return "短期项目说明";
  return "补充沟通资料";
}

function scopeDescription(scope = {}) {
  return {
    global: "所有合适的同类沟通",
    job: "当前岗位的同类问题",
    company: "这家公司的同类问题",
    experience: "这段经历的同类问题"
  }[scope.kind] || "同类沟通";
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : "时间待确认";
}

module.exports = {
  renderCommunicationProfilePage,
  factLabel
};
