const { escapeHtml, escapeAttr } = require("../http/response");
const { renderDashboardFrame } = require("../ui/shell");

function renderTodayPage(vm) {
  const page = vm.page || {};
  const plan = vm.form?.plan || {};
  return renderDashboardFrame({ currentPath: page.todayPath, todayPath: page.todayPath, planId: page.planId, stage: "今日任务", brandHref: page.todayPath, content: `<main id="main-content" class="today-main">
  <section class="page-heading" aria-labelledby="today-title"><p class="eyebrow">${escapeHtml(vm.heading?.eyebrow || "")}</p><h1 id="today-title">${escapeHtml(vm.heading?.title || "今日任务")}</h1><p class="lede">${escapeHtml(vm.heading?.lede || "")}</p><div class="heading-meta"><span>${escapeHtml(vm.heading?.meta?.[0] || "")}</span><span>${escapeHtml(vm.heading?.meta?.[1] || "")}</span><span class="status ${vm.heading?.status === "方案可用" ? "good" : "waiting"}">${escapeHtml(vm.heading?.status || "")}</span></div></section>
  ${renderPrimaryPanel(vm)}
  ${renderMetrics(vm.metrics)}
  ${vm.confirmation ? `<p class="notice" role="status">${escapeHtml(vm.confirmation)}</p>` : ""}
  <div class="today-grid">
    <div class="stack">
      ${(vm.blockers || []).length ? renderBlockers(vm.blockers) : ""}
      ${renderPlanSummary(vm)}
    </div>
    <aside class="stack" aria-label="候选人摘要">${renderCandidateSummary(vm.profile || {})}</aside>
  </div>
  ${renderPlanSettings(vm)}
  ${renderAdvancedScan(vm)}
</main><p class="footer-note">本页只展示本地保存的任务状态。扫描仍遵守固定标签页、随机等待、预算和风控即停；不会自动沟通或投递。</p>` }) + renderClientScripts(vm.run?.state, vm.primary?.type === "form");
}

function renderPrimaryPanel(vm) {
  const primary = vm.primary || {};
  return `<section class="action-panel" aria-labelledby="next-action-title"><div><p class="section-label">现在做什么</p><h2 id="next-action-title">${escapeHtml(primary.status || "当前任务")}</h2><p class="muted">${escapeHtml(primary.detail || "")}</p></div><div class="button-row">${renderPrimaryAction(primary, vm.page || {}, vm.runtime || {})}<a class="button quiet" href="/queue?planId=${escapeAttr(vm.page?.planId)}">查看待处理岗位</a></div></section>`;
}

function renderPrimaryAction(primary, page, runtime) {
  if (primary.type === "link") return `<a class="button" data-today-primary="true" href="${escapeAttr(primary.href)}">${escapeHtml(primary.label)}</a>`;
  if (primary.type === "notice") return `<p class="primary-notice" role="status">${escapeHtml(primary.label)}</p>`;
  return `<form class="workflow-start" method="post" action="/api/workflow-run"><input type="hidden" name="planId" value="${escapeAttr(page.planId)}"><input type="hidden" name="browserMode" value="edge"><button class="button" data-today-primary="true" name="action" value="start" data-browser-readiness-button data-browser-base-disabled="${runtime.workflowStartDisabled ? "true" : "false"}" disabled>${escapeHtml(primary.label || "执行一轮")}</button></form><div id="browser-readiness-status" class="workflow-budget" role="status">正在检查当前已登录 Edge 与固定 BOSS 页面状态…</div>`;
}

function renderMetrics(metrics) {
  return `<section class="metric-grid" aria-label="今日工作指标"><div class="metric"><span class="metric-label">今日成功沟通</span><strong class="metric-value">${metrics.successfulToday || 0} <small>/ ${metrics.dailyTarget || 0}</small></strong><span class="metric-note">按已完成的本轮累计</span></div><div class="metric"><span class="metric-label">可用候选</span><strong class="metric-value">${metrics.inventoryCount || 0}</strong><span class="metric-note">可进入人工确认的岗位</span></div><div class="metric"><span class="metric-label">当前轮次</span><strong class="metric-value">${metrics.slotsUsed || 0} <small>/ ${metrics.maxRuns || 0}</small></strong><span class="metric-note">下一轮目标 ${metrics.targetSuccessCount || 0}</span></div></section>`;
}

function renderBlockers(blockers) {
  return `<section class="card pad" aria-labelledby="blocker-title"><p class="section-label">检查站</p><h2 id="blocker-title">现在卡在哪里</h2><div class="list">${blockers.map((blocker) => `<div class="list-row"><div><strong>${escapeHtml(blocker.title)}</strong><p>${escapeHtml(blocker.detail)}</p>${blocker.action ? `<a class="inline-link" href="${escapeAttr(blocker.action.href)}">${escapeHtml(blocker.action.label)}</a>` : ""}</div><span class="status ${escapeAttr(blocker.tone || "neutral")}">${escapeHtml(statusText(blocker.tone))}</span></div>`).join("")}</div></section>`;
}

function renderPlanSummary(vm) {
  const plan = vm.form?.plan || {};
  const profile = vm.profile || {};
  const acquisition = vm.form?.acquisition || {};
  const modeLabel = acquisition.mode === "generated" ? "通用模式" : "继承模式";
  return `<section class="card" aria-labelledby="plan-summary-title"><div class="card-head"><div><p class="section-label">筛选方案</p><h2 id="plan-summary-title">${escapeHtml(plan.name || "未命名方案")}</h2></div><a class="button secondary" href="#plan-settings">调整方案</a></div><div class="card-body"><div class="plan-scope"><div><strong>${escapeHtml(modeLabel)}平台范围</strong><p>${escapeHtml(acquisitionDisplaySummary(acquisition, profile))}</p></div><div><strong>RoleFlow 本地精筛</strong><p>${escapeHtml(localFilterSummary(plan))}</p></div></div>${acquisition.activeSnapshot ? `<div class="alert acquisition-lock"><strong>当前任务条件已锁定</strong><p>${escapeHtml(acquisition.activeSnapshot.summary || "当前任务继续使用启动时的条件")}；本页修改会从下一次创建任务开始生效。</p></div>` : ""}<dl class="definition-grid"><div><dt>关键词</dt><dd>${escapeHtml((plan.keywords || []).map((item) => item.word || item).filter(Boolean).join("、") || "待确认")}</dd></div><div><dt>采集方式</dt><dd>${escapeHtml(modeLabel)}</dd></div><div><dt>薪资策略</dt><dd>${escapeHtml(`${plan.salary?.minK ?? ""}${plan.salary?.maxK ? `–${plan.salary.maxK}K` : ""}` || "仅排序，不硬排除")}</dd></div><div><dt>工作节奏</dt><dd>${escapeHtml(plan.workSchedulePreference === "no_preference" ? "不作为排序依据" : "优先双休，其他仍保留")}</dd></div></dl><details class="today-secondary"><summary>查看版本与反馈</summary>${renderVersionDiff(profile.versionDiff)}${renderFeedback(profile.feedback)}</details><div class="button-row"><a class="button quiet" href="/profile?profileId=${escapeAttr(profile.id)}">查看候选人画像</a><a class="button quiet" href="/resumes?profileId=${escapeAttr(profile.id)}">管理简历版本</a></div></div></section>`;
}

function renderCandidateSummary(profile) {
  return `<section class="card pad" aria-labelledby="candidate-title"><p class="section-label">候选人摘要</p><h2 id="candidate-title">${escapeHtml(profile.name || "候选人待确认")}</h2><p class="muted">${escapeHtml([profile.city, ...(profile.targetTitles || [])].filter(Boolean).join(" · "))}</p><div class="chip-row" aria-label="核心技能">${(profile.skills || []).slice(0, 8).map((skill) => `<span class="chip">${escapeHtml(skill)}</span>`).join("") || "<span class=\"chip\">待确认</span>"}</div><div class="alert good"><strong>画像已确认</strong><p>本轮匹配使用已保存的经历与项目证据；编辑仍在画像页面完成。</p></div><a class="button secondary" href="/profile?profileId=${escapeAttr(profile.id)}">检查画像</a></section>`;
}

function renderPlanSettings(vm) {
  const form = vm.form || {};
  const plan = form.plan || {};
  const options = form.options || {};
  const bounds = form.scanBounds || {};
  const defaults = form.scanDefaults || {};
  const acquisition = form.acquisition || {};
  const generated = acquisition.generated || {};
  const inherited = acquisition.inheritedPreview || {};
  return `<details id="plan-settings" class="card today-details"><summary class="card-head"><strong>调整筛选条件</strong><span class="tiny">先选平台范围，再设本地精筛</span></summary><form id="plan-form" class="plan-form card-body" method="post" action="/api/plan"><input type="hidden" name="profileId" value="${escapeAttr(vm.profile?.id)}"><input type="hidden" name="planId" value="${escapeAttr(vm.page?.planId)}"><p class="wide plan-note"><strong>两种模式只改变平台岗位从哪里来。</strong>关键词、完整 JD 分析、匹配证据和推荐质量标准保持一致。</p><label class="wide">方案名称<input name="name" value="${escapeAttr(plan.name || "")}" required></label><fieldset class="mode-picker wide"><legend>平台采集方式</legend><label class="mode-choice"><input type="radio" name="acquisitionMode" value="inherited"${acquisition.mode === "generated" ? "" : " checked"}><span><strong>继承模式</strong><small>沿用当前 BOSS 搜索页范围，只替换关键词</small></span></label><label class="mode-choice"><input type="radio" name="acquisitionMode" value="generated"${acquisition.mode === "generated" ? " checked" : ""}><span><strong>通用模式</strong><small>按下面保存的城市和 BOSS 条件生成搜索</small></span></label></fieldset><section class="acquisition-panel wide" data-acquisition-panel="inherited"${acquisition.mode === "generated" ? " hidden aria-hidden=\"true\"" : " aria-hidden=\"false\""}><strong>当前 BOSS 搜索页范围</strong><p data-inherited-preview data-preview-url="${escapeAttr(inherited.endpoint || "")}">${escapeHtml(inherited.summary || "读取当前 BOSS 搜索页后显示")}</p></section><section class="acquisition-panel wide" data-acquisition-panel="generated"${acquisition.mode === "generated" ? " aria-hidden=\"false\"" : " hidden aria-hidden=\"true\""}>${renderChoices("城市", "cities", options.cities, generated.cities)}${renderChoices("BOSS 薪资档", "platformSalaryLanes", options.platformSalaryLanes, generated.salaryLanes)}${renderChoices("工作经验", "experience", options.experience, generated.experience)}${renderChoices("职位类型", "jobTypes", options.jobTypes, generated.jobTypes)}${renderChoices("学历", "degrees", options.degrees, generated.degrees)}</section><section class="shared-screening wide"><h3>关键词与扫描规模</h3><p>关键词既用于 BOSS 查询，也会作为本地匹配信号。</p><label class="wide">搜索关键词<textarea name="keywords" required>${escapeHtml(keywordLines(plan.keywords))}</textarea></label><details class="plan-advanced wide"><summary>广泛扫描预算</summary><div class="plan-advanced-body"><label>A类每词岗位数<input type="number" min="${escapeAttr(bounds.maxCards?.[0])}" max="${escapeAttr(bounds.maxCards?.[1])}" name="maxCards" value="${escapeAttr(plan.scan?.maxCards ?? defaults.maxCards ?? "")}"></label><label>右栏详情安全上限<input type="number" min="${escapeAttr(bounds.maxDetailTotal?.[0])}" max="${escapeAttr(bounds.maxDetailTotal?.[1])}" name="maxDetailTotal" value="${escapeAttr(plan.scan?.maxDetailTotal ?? defaults.maxDetailTotal ?? "")}"></label><label>搜索页面安全上限<input type="number" min="${escapeAttr(bounds.browserPageBudget?.[0])}" max="${escapeAttr(bounds.browserPageBudget?.[1])}" name="browserPageBudget" value="${escapeAttr(plan.scan?.browserPageBudget ?? defaults.browserPageBudget ?? "")}"></label></div></details></section>${renderLocalScreeningFields({ plan, profile: vm.profile || {} })}<div class="wide plan-save"><button class="button secondary">保存筛选方案</button><span id="plan-dirty-note" class="hint" hidden>条件有修改，请先保存再扫描。</span></div></form></details>`;
}

function renderLocalScreeningFields({ plan, profile }) {
  return `<section class="local-screening wide"><h3>RoleFlow 本地精筛</h3><div class="local-screening-fields"><label>最低薪资（K）<input type="number" min="0" max="100" name="salaryMinK" value="${escapeAttr(plan.salary?.minK || "")}"></label><label>最高薪资（K）<input type="number" min="0" max="100" name="salaryMaxK" value="${escapeAttr(plan.salary?.maxK || "")}"></label><label>薪资策略<select name="salaryMode"><option value="wide"${plan.salaryMode !== "strict" ? " selected" : ""}>宽松排序，范围外保留</option><option value="strict"${plan.salaryMode === "strict" ? " selected" : ""}>严格范围</option></select></label><label class="wide">目标方向<input name="directions" value="${escapeAttr((plan.directions || []).join("，"))}"></label><label>招聘方活跃天数<input type="number" min="1" max="30" name="bossActiveDays" value="${escapeAttr(plan.bossActiveDays || "")}"></label><label class="check-label"><input type="checkbox" name="allowExperienceStretch"${plan.allowExperienceStretch !== false ? " checked" : ""}><span>允许经验要求适度放宽</span></label><label>工作节奏<select name="workSchedulePreference"><option value="prefer_double_weekend"${plan.workSchedulePreference !== "no_preference" ? " selected" : ""}>优先双休</option><option value="no_preference"${plan.workSchedulePreference === "no_preference" ? " selected" : ""}>不作为排序依据</option></select></label><a class="matching-card-link wide" href="${escapeAttr(profile.matchingCard?.href || "#")}"><strong>匹配偏好卡</strong><span>${escapeHtml(profile.matchingCard?.summary || "检查匹配偏好卡")}</span></a><label class="wide">排除词<input name="excludeWords" value="${escapeAttr((plan.excludeWords || []).join("，"))}"></label><label class="wide">硬排除词<input name="hardExcludes" value="${escapeAttr((plan.hardExcludes || []).join("，"))}"></label></div></section>`;
}

function renderAdvancedScan(vm) {
  const scan = vm.scan || {};
  const daily = scan.daily || {};
  const broad = scan.broad || {};
  const activeDays = vm.form?.plan?.bossActiveDays || "";
  const resume = scan.resumableBatchId ? `<button data-scan-button name="resumeBatchId" value="${escapeAttr(scan.resumableBatchId)}"${scan.disabled ? " disabled" : ""}>继续未完成扫描 #${escapeHtml(scan.resumableBatchId)}</button>` : "";
  return `<details class="card today-details"><summary class="card-head"><strong>高级信息与维护</strong><span class="tiny">预算 · 维护扫描 · 历史队列</span></summary><section class="card-body scan-panel"><div class="alert"><strong>低频入口</strong><p>日常扫描 ${escapeHtml(daily.keywordPlan?.length || 0)} 个 A/B 关键词，广泛扫描 ${escapeHtml(broad.keywordPlan?.length || 0)} 个关键词；继续使用单标签串行、随机等待和风控即停。</p></div><p class="field-help">招聘方近 ${escapeHtml(activeDays)} 天活跃优先保留。详情读取预算剩余 ${escapeHtml(vm.metrics?.remainingDetails || 0)}，搜索页面预算剩余 ${escapeHtml(vm.metrics?.remainingPages || 0)}。日常扫描 A/B 主档每词最多 ${escapeHtml(daily.maxCards || 0)}/${escapeHtml(scan.dailyBCardLimit || 0)} 张卡片和 ${escapeHtml(daily.detailLimits?.A || 0)}/${escapeHtml(daily.detailLimits?.B || 0)} 个新详情，补充档最多 ${escapeHtml(daily.supplementalSalaryLaneCardLimit || 0)} 张卡片和 ${escapeHtml(daily.supplementalSalaryLaneDetailLimit || 0)} 个新详情；广泛扫描详情最多 ${escapeHtml(broad.maxDetailTotal || 0)} 个。</p><div><strong>扫描状态：</strong>${escapeHtml(vm.run?.label || "尚未运行")}</div>${vm.run?.error ? `<pre class="scan-error">${escapeHtml(vm.run.error)}</pre>` : ""}<form class="inline-form" method="post" action="/api/scan"><input type="hidden" name="planId" value="${escapeAttr(vm.page?.planId)}"><input type="hidden" name="browserMode" value="edge"><button data-scan-button name="scanKind" value="daily"${scan.disabled ? " disabled" : ""}>日常扫描</button><button data-scan-button name="scanKind" value="broad"${scan.disabled ? " disabled" : ""}>广泛扫描</button>${resume}<button data-scan-button name="scanKind" value="refresh"${scan.disabled ? " disabled" : ""}>补读缺失详情</button><button data-scan-button name="scanKind" value="activity"${scan.disabled ? " disabled" : ""}>更新过期活跃状态</button><a class="button secondary" href="/queue?planId=${escapeAttr(vm.page?.planId)}">待处理队列</a><a class="button secondary" href="/jobs?planId=${escapeAttr(vm.page?.planId)}&amp;batch=latest">查看岗位</a></form></section></details>`;
}

function renderChoices(label, name, options = [], selected = []) {
  const chosen = new Set(selected || []);
  const values = [...new Set([...(options || []), ...(selected || [])])];
  return `<div class="choice-section"><strong>${escapeHtml(label)}</strong><div class="choice-list">${values.map((value) => `<label class="choice-item"><input type="checkbox" name="${escapeAttr(name)}" value="${escapeAttr(value)}"${chosen.has(value) ? " checked" : ""}><span>${escapeHtml(value)}</span></label>`).join("")}</div></div>`;
}

function renderVersionDiff(diff) {
  if (!diff) return "";
  const changes = diff.changes || [];
  const details = changes.map((change) => `<li>${escapeHtml(change.label)}：${escapeHtml(change.added?.length || change.removed?.length ? [change.added?.length ? `新增：${change.added.join("、")}` : "", change.removed?.length ? `移除：${change.removed.join("、")}` : ""].filter(Boolean).join("；") : `${change.before || "未填写"} → ${change.after || "未填写"}`)}</li>`).join("");
  return `<div class="line profile-diff"><strong>简历版本：</strong>${escapeHtml(diff.current)}${details ? `<ul>${details}</ul>` : "（与上一版画像无关键差异）"}</div>`;
}

function renderFeedback(feedback = {}) {
  const sections = [feedback.reasons?.length ? `高频跳过原因：${feedback.reasons.join("；")}` : "", feedback.keywords?.length ? `待排查的关键词：${feedback.keywords.join("、")}` : ""].filter(Boolean);
  return sections.length ? `<div class="line profile-diff"><strong>历史反馈：</strong>${escapeHtml(sections.join("。"))}。仅用于诊断，不自动调整筛选或排序。</div>` : "";
}

function localFilterSummary(plan = {}) {
  const salary = plan.salary?.minK || plan.salary?.maxK
    ? `${plan.salary?.minK || 0}–${plan.salary?.maxK || "不限"}K`
    : "薪资不硬限制";
  const schedule = plan.workSchedulePreference === "no_preference" ? "节奏不限制" : "优先双休";
  return `${salary} · ${schedule} · ${(plan.keywords || []).length} 个关键词 · JD 匹配与风险判断`;
}

function acquisitionDisplaySummary(acquisition = {}, profile = {}) {
  if (acquisition.mode === "generated") {
    const generated = acquisition.generated || {};
    const values = [
      ...(generated.cities || []),
      ...(generated.salaryLanes || []),
      ...(generated.experience || []),
      ...(generated.jobTypes || []),
      ...(generated.degrees || [])
    ];
    return values.join(" · ") || "未额外限制平台条件";
  }
  return acquisition.inheritedPreview?.summary || profile.bossFilter?.summary || "读取当前 BOSS 搜索页后显示";
}

function statusText(tone) { return { good: "已检查", waiting: "待处理", danger: "需恢复" }[tone] || "提示"; }
function keywordLines(keywords = []) { return keywords.map((item) => `${item.word || item} | ${item.priority || "B"} | ${item.reason || "用户确认的搜索关键词"}`).join("\n"); }

function renderClientScripts(runState, includeBrowserReadiness) {
  const readiness = includeBrowserReadiness ? `<script>
    (function(){
      const statusNode = document.getElementById('browser-readiness-status');
      const button = document.querySelector('[data-browser-readiness-button]');
      const browserMode = document.querySelector('[name=browserMode]');
      if (!statusNode || !button) return;
      const baseDisabled = button.dataset.browserBaseDisabled === 'true';
      let readinessInFlight = false;
      let queuedRefresh = false;
      let selectionVersion = 0;
      function readinessUrl() {
        const mode = browserMode?.value === 'portable' ? 'portable' : 'edge';
        const params = new URLSearchParams({browserMode:mode});
        if (mode === 'portable') params.set('cdpPort','9222');
        return '/api/browser-readiness?'+params.toString();
      }
      async function refreshReadiness({queueIfBusy=false}={}) {
        if (readinessInFlight) {
          if (queueIfBusy) queuedRefresh = true;
          return;
        }
        const requestVersion = selectionVersion;
        const requestUrl = readinessUrl();
        readinessInFlight = true;
        button.disabled = true;
        try {
          const response = await fetch(requestUrl, {cache:'no-store'});
          if (!response.ok) throw new Error('readiness request failed');
          const state = await response.json();
          if (requestVersion !== selectionVersion || requestUrl !== readinessUrl()) return;
          statusNode.textContent = state.message || '浏览器状态未知。';
          statusNode.dataset.status = state.status || 'unknown';
          button.disabled = baseDisabled || state.status !== 'ready';
        } catch {
          if (requestVersion !== selectionVersion || requestUrl !== readinessUrl()) return;
          statusNode.textContent = '无法确认当前已登录 Edge 状态，请检查本地服务。';
          statusNode.dataset.status = 'browser_unavailable';
          button.disabled = true;
        } finally {
          readinessInFlight = false;
          if (queuedRefresh || requestVersion !== selectionVersion || requestUrl !== readinessUrl()) {
            queuedRefresh = false;
            void refreshReadiness();
          }
        }
      }
      refreshReadiness();
      browserMode?.addEventListener('change', function(){selectionVersion+=1;void refreshReadiness({queueIfBusy:true})});
      setInterval(refreshReadiness, 5000);
    })();
    </script>` : "";
  return `${readiness}<script>(function(){const form=document.getElementById('plan-form');const note=document.getElementById('plan-dirty-note');if(!form)return;let previewInFlight=false;async function refreshInheritedPreview(){const node=form.querySelector('[data-inherited-preview]');const mode=form.querySelector('input[name=acquisitionMode]:checked')?.value||'inherited';if(!node||mode!=='inherited'||!node.dataset.previewUrl||previewInFlight)return;previewInFlight=true;node.textContent='正在只读检查当前 BOSS 搜索页…';try{const response=await fetch(node.dataset.previewUrl,{cache:'no-store'});const value=await response.json();node.textContent=response.ok?(value.summary||'当前 BOSS 搜索页未识别到额外筛选条件'):(value.error||'暂时无法读取当前 BOSS 搜索范围。')}catch{node.textContent='暂时无法读取当前 BOSS 搜索范围。'}finally{previewInFlight=false}}function syncAcquisitionPanels(refreshPreview){const mode=form.querySelector('input[name=acquisitionMode]:checked')?.value||'inherited';form.querySelectorAll('[data-acquisition-panel]').forEach(function(panel){const visible=panel.dataset.acquisitionPanel===mode;panel.hidden=!visible;panel.setAttribute('aria-hidden',visible?'false':'true')});if(refreshPreview&&mode==='inherited')void refreshInheritedPreview()}syncAcquisitionPanels(true);form.querySelectorAll('input[name=acquisitionMode]').forEach(function(input){input.addEventListener('change',function(){syncAcquisitionPanels(true)})});form.addEventListener('input',function(){document.querySelectorAll('[data-scan-button]').forEach(function(button){button.disabled=true});if(note)note.hidden=false});}());</script>${runState === "running" ? `<script>setTimeout(()=>location.reload(),2500)</script>` : ""}`;
}

module.exports = { renderTodayPage };
