const { escapeHtml, escapeAttr } = require('../http/response');
const { renderDashboardFrame } = require('../ui/shell');
const SITE_LABELS = { boss: 'BOSS', zhaopin: '智联' };

function renderFunnelPage({ plan = {}, dashboard = {}, view = 'current' } = {}) {
  const planId = Number(plan.id || 0);
  const path = `/funnel?planId=${encodeURIComponent(planId)}`;
  const lifetime = view === 'lifetime';
  const platforms = dashboard.platforms || [];
  const started = platforms.reduce((sum, item) => sum + count(lifetime ? item.lifetime?.started : item.currentRound?.started), 0);
  return renderDashboardFrame({ currentPath: path, todayPath: `/plan?planId=${planId}`, planId,
    stage: '求职体检', brandHref: `/plan?planId=${planId}`,
    content: `<main id="main-content" class="funnel-main feedback-main">
      <header class="page-heading"><h1>求职体检</h1><p class="lede">${escapeHtml(plan.name || '当前求职方案')}</p></header>
      <section class="feedback-overview" aria-label="投递反馈">
        <div class="feedback-toolbar"><nav aria-label="统计范围">
          <a href="${path}"${!lifetime ? ' aria-current="true"' : ''}>当前方案</a>
          <a href="${path}&amp;view=lifetime"${lifetime ? ' aria-current="true"' : ''}>累计记录</a>
        </nav><a class="feedback-message-link" href="/messages?planId=${planId}">查看消息</a></div>
        <p class="feedback-scope">${lifetime ? '所有方案的本地记录' : '当前方案的联系与反馈'}</p>
        <div class="feedback-table-scroll" role="region" aria-label="平台反馈对照" tabindex="0">
          <table aria-label="${lifetime ? '累计记录' : '当前方案'}投递反馈"><thead><tr>
            <th scope="col">平台</th><th scope="col">已联系岗位</th><th scope="col">已回复</th><th scope="col">索要简历</th><th scope="col">面试邀请</th>
          </tr></thead><tbody>${platforms.map(item => renderPlatform(item, lifetime)).join('')}</tbody></table>
        </div>
        <p class="feedback-footnote">已联系包含确认投递或沟通的岗位；回复比例占本行已联系岗位，按已读取消息更新。</p>
        ${!started ? `<p class="feedback-empty">${lifetime ? '还没有联系岗位。' : '当前方案还没有联系岗位。'}<a href="/plan?planId=${planId}">去发现岗位</a></p>` : ''}
      </section>
      ${renderOtherMessages(lifetime ? dashboard.lifetimeUntrackedFeedback : dashboard.untrackedFeedback, planId)}
      ${!lifetime && started ? renderAdvice(dashboard, planId) : ''}
      ${!lifetime ? renderComparison(platforms) : ''}
      ${renderAdjustment(planId, dashboard.activeRevisionId)}
    </main>` });
}

function renderPlatform(item, lifetime) {
  const round = item.currentRound || {};
  const values = lifetime ? item.lifetime || {} : { started: round.started, ...round.immediatePositive };
  const started = count(values.started), replied = count(values.replied);
  const changed = !lifetime && round.changeKinds?.some(kind => kind !== 'initial');
  return `<tr data-feedback-platform="${escapeAttr(item.site)}"><th scope="row">${escapeHtml(SITE_LABELS[item.site] || item.site)}
    ${changed ? `<small>${escapeHtml(localDate(round.startedAt))}调整后</small>` : ''}</th>
    <td><strong>${started}</strong></td><td><strong>${replied}</strong><span class="feedback-reply-share">${started ? percent(replied, started) : '—'}</span></td>
    <td>${count(values.resumeRequested)}</td><td>${count(values.interviewInvited)}</td></tr>`;
}

function renderAdvice(dashboard, planId) {
  const advice = dashboard.advice;
  if (!advice) {
    const rounds = (dashboard.platforms || []).map(item => item.currentRound).filter(item => item?.started);
    const waiting = rounds.some(round => round.waiting > 0);
    const enough = rounds.some(round => round.strength !== 'facts' && round.unknown < Math.ceil(round.mature / 2));
    return `<p class="feedback-status">${waiting ? '最近联系的部分岗位还需等待反馈。' : enough
      ? '目前没有足够依据建议调整投递方式。' : '现有反馈还不足以判断是否需要调整。'}</p>`;
  }
  const n = count(advice.numerator), d = count(advice.denominator);
  const reasons = {
    read: `${d} 个已获取阅读状态的岗位中，${n} 个已读。`,
    replied: `${d} 个已读岗位中，${n} 个有回复。`,
    effectiveConversation: `${d} 个已确认回复内容的岗位中，${n} 个进入进一步沟通。`,
    interviewInvited: `${d} 个已进入进一步沟通且反馈明确的岗位中，${n} 个邀请面试。`,
    interviewConfirmed: `${d} 个已收到面试邀请且反馈明确的岗位中，${n} 个已确认安排或后续进展。`
  };
  const destination = advice.stage === 'interviewInvited'
    ? [`/resume-optimization?planId=${planId}`, '打开简历工作室']
    : advice.stage === 'effectiveConversation' ? [`/messages?planId=${planId}`, '查看消息与回复']
      : advice.stage === 'interviewConfirmed' ? [`/queue?planId=${planId}&site=${encodeURIComponent(advice.site)}&pool=interview`, '查看面试进展']
        : [`/queue?planId=${planId}&site=${encodeURIComponent(advice.site)}&pool=waiting_reply`, '查看等待回复的岗位'];
  return `<section class="feedback-advice" aria-label="优先建议"><div><p class="section-label">${escapeHtml(SITE_LABELS[advice.site])} · 优先建议</p>
    <h2>${escapeHtml(advice.title)}</h2><p>${escapeHtml(reasons[advice.stage] || '')}可以先检查这一环节。</p></div>
    <a href="${escapeAttr(destination[0])}">${destination[1]}</a></section>`;
}

function renderComparison(platforms) {
  const ready = platforms.filter(item => item.roundComparison?.status === 'ready');
  if (!ready.length) return '';
  return `<section class="feedback-comparison" aria-label="调整前后"><h2>调整前后</h2>${ready.map(item => {
    const { before, after } = item.roundComparison;
    return `<p><strong>${escapeHtml(SITE_LABELS[item.site])}</strong> · 可比较记录的回复比例：${percent(before.replied.numerator, before.replied.denominator)} → ${percent(after.replied.numerator, after.replied.denominator)}</p>`;
  }).join('')}<p class="feedback-footnote">只比较已等待充分时间且回复状态明确的岗位；变化不一定由这次调整造成。</p></section>`;
}

function renderOtherMessages(counts = {}, planId) {
  const invite = count(counts.interviewInvited), resume = count(counts.resumeRequested), replied = count(counts.replied);
  if (!invite && !resume && !replied) return '';
  const text = invite ? `${invite} 个岗位邀请面试` : resume ? `${resume} 个岗位索要简历` : `${replied} 个岗位有 HR 消息`;
  return `<p class="feedback-other">其他消息中还有 ${text}。<a href="/messages?planId=${planId}">查看这些消息</a></p>`;
}

function renderAdjustment(planId, revisionId) {
  if (!revisionId) return '';
  return `<details class="feedback-adjustment"><summary>记录方案调整</summary>
    <p>已在招聘平台改好招呼语或投递方式？记下这次调整，之后就能查看效果变化。</p>
    <form method="post" action="/api/funnel/strategy-round" data-funnel-strategy-form>
      <input type="hidden" name="planId" value="${escapeAttr(planId)}"><input type="hidden" name="fromRoundId" value="${escapeAttr(revisionId)}">
      <div class="feedback-field"><label for="feedback-platform">调整的平台</label><select id="feedback-platform" name="platformScope"><option value="all">BOSS 和智联</option><option value="boss">仅 BOSS</option><option value="zhaopin">仅智联</option></select></div>
      <fieldset><legend>调整了什么？</legend><label><input type="checkbox" name="changeKinds" value="greeting"> 招呼语</label><label><input type="checkbox" name="changeKinds" value="strategy"> 求职方向或投递方式</label></fieldset>
      <label>调整说明（可选）<textarea name="changeNote" maxlength="300" rows="2" placeholder="例如：招呼语增加相关项目经历"></textarea></label>
      <button type="submit">保存调整记录</button><p class="alert" data-funnel-strategy-error role="alert"></p>
    </form></details>`;
}
function count(value) { return Math.max(0, Number(value) || 0); }
function percent(numerator, denominator) {
  return denominator ? `${Number((100 * numerator / denominator).toFixed(1))}%` : '—';
}
function localDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' }).format(date) : '';
}
const FUNNEL_STRATEGY_SCRIPT = `<script>(()=>{const form=document.querySelector('[data-funnel-strategy-form]');if(!form)return;const choices=Array.from(form.querySelectorAll('input[name="changeKinds"]'));const error=form.querySelector('[data-funnel-strategy-error]');const clear=()=>{if(choices[0])choices[0].setCustomValidity('');if(error)error.textContent='';};for(const choice of choices)choice.addEventListener('change',clear);form.addEventListener('submit',(event)=>{clear();if(choices.some((choice)=>choice.checked))return;event.preventDefault();const message='请选择本次调整的内容。';if(error)error.textContent=message;if(choices[0]){choices[0].setCustomValidity(message);choices[0].reportValidity();}});})();</script>`;
module.exports = { renderFunnelPage, FUNNEL_STRATEGY_SCRIPT };
