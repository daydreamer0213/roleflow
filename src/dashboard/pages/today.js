const { escapeHtml, escapeAttr } = require("../http/response");
const { renderNavigation } = require("../ui/navigation");

function renderTodayPage(vm) {
  const page = vm.page || {};
  const plan = vm.form?.plan || {};
  const navigation = renderNavigation({ currentPath: page.todayPath, todayPath: page.todayPath, planId: page.planId });
  return `<a class="skip-link" href="#main-content">跳到主要内容</a>
<div class="app-shell"><aside class="signal-rail" aria-label="RoleFlow 阶段标记"><div class="rail-mark" aria-hidden="true">RF</div><div class="rail-label">今日任务</div><div class="rail-spacer"></div><span class="rail-dot attention" title="有待处理事项"></span></aside>
<div class="page today-page"><header class="topbar"><a class="brand" href="${escapeAttr(page.todayPath)}"><strong>RoleFlow</strong><span>本地岗位工作台</span></a><nav class="primary-nav" aria-label="主导航">${navigation}</nav><span class="nav-scroll-hint" aria-hidden="true">左右滑动查看更多</span></header>
<main id="main-content" class="today-main">
  <section class="page-heading" aria-labelledby="today-title"><p class="eyebrow">${escapeHtml(vm.heading?.eyebrow || "")}</p><h1 id="today-title">${escapeHtml(vm.heading?.title || "今日任务")}</h1><p class="lede">${escapeHtml(vm.heading?.lede || "")}</p><div class="heading-meta"><span>${escapeHtml(vm.heading?.meta?.[0] || "")}</span><span>${escapeHtml(vm.heading?.meta?.[1] || "")}</span><span class="status ${vm.heading?.status === "方案可用" ? "good" : "waiting"}">${escapeHtml(vm.heading?.status || "")}</span></div></section>
  ${renderPrimaryPanel(vm)}
  ${renderMetrics(vm.metrics)}
  ${vm.confirmation ? `<p class="notice" role="status">${escapeHtml(vm.confirmation)}</p>` : ""}
  <div class="today-grid">
    <div class="stack">
      ${renderBlockers(vm.blockers || [])}
      ${renderPlanSummary(vm)}
    </div>
    <aside class="stack" aria-label="候选人摘要">${renderCandidateSummary(vm.profile || {})}${renderQualityGuard(vm.metrics || {})}</aside>
  </div>
  ${renderPlanSettings(vm)}
  ${renderAdvancedScan(vm)}
</main>
<p class="footer-note">本页只展示本地保存的任务状态。扫描仍遵守固定标签页、随机等待、预算和风控即停；不会自动沟通或投递。</p>
</div></div>${renderClientScripts(vm.run?.state, vm.primary?.type === "form")}`;
}

function renderPrimaryPanel(vm) {
  const primary = vm.primary || {};
  const metrics = vm.metrics || {};
  return `<section class="action-panel" aria-labelledby="next-action-title"><div><p class="section-label">现在做什么</p><h2 id="next-action-title">${escapeHtml(primary.status || "当前任务")}</h2><p class="muted">${escapeHtml(primary.detail || "")}</p></div><div class="action-meta" aria-label="本轮摘要"><span>今日进度 <strong>${metrics.successfulToday || 0} / ${metrics.dailyTarget || 0}</strong></span><span>可用候选 <strong>${metrics.inventoryCount || 0}</strong></span><span>已用轮次 <strong>${metrics.slotsUsed || 0} / ${metrics.maxRuns || 0}</strong></span></div><div class="button-row">${renderPrimaryAction(primary, vm.page || {}, vm.runtime || {})}<a class="button quiet" href="/queue?planId=${escapeAttr(vm.page?.planId)}">查看待处理岗位</a></div></section>`;
}

function renderPrimaryAction(primary, page, runtime) {
  if (primary.type === "link") return `<a class="button" data-today-primary="true" href="${escapeAttr(primary.href)}">${escapeHtml(primary.label)}</a>`;
  if (primary.type === "notice") return `<p class="primary-notice" role="status">${escapeHtml(primary.label)}</p>`;
  return `<form class="workflow-start" method="post" action="/api/workflow-run"><input type="hidden" name="planId" value="${escapeAttr(page.planId)}"><input type="hidden" name="cdpPort" value="9222"><label class="sr-only" for="today-browser-mode">浏览器模式</label><select id="today-browser-mode" name="browserMode"><option value="edge" selected>当前已登录 Edge（推荐）</option><option value="portable">项目专用 Edge（手动备用，需要独立登录）</option></select><button class="button" data-today-primary="true" name="action" value="start" data-browser-readiness-button data-browser-base-disabled="${runtime.workflowStartDisabled ? "true" : "false"}" disabled>${escapeHtml(primary.label || "执行一轮")}</button></form><div id="browser-readiness-status" class="workflow-budget" role="status">正在检查当前已登录 Edge 与固定 BOSS 页面状态…</div>`;
}

function renderMetrics(metrics) {
  return `<section class="metric-grid" aria-label="今日工作指标"><div class="metric"><span class="metric-label">今日成功沟通</span><strong class="metric-value">${metrics.successfulToday || 0} <small>/ ${metrics.dailyTarget || 0}</small></strong><span class="metric-note">进度由已完成的本轮记录累计</span></div><div class="metric"><span class="metric-label">可用候选</span><strong class="metric-value">${metrics.inventoryCount || 0}</strong><span class="metric-note">仅计入可进入本轮的岗位</span></div><div class="metric"><span class="metric-label">剩余详情读取预算</span><strong class="metric-value">${metrics.remainingDetails || 0}</strong><span class="metric-note">剩余搜索页 ${metrics.remainingPages || 0}</span></div><div class="metric"><span class="metric-label">今日已用轮次</span><strong class="metric-value">${metrics.slotsUsed || 0} <small>/ ${metrics.maxRuns || 0}</small></strong><span class="metric-note">下一轮目标 ${metrics.targetSuccessCount || 0}</span></div></section>`;
}

function renderBlockers(blockers) {
  return `<section class="card pad" aria-labelledby="blocker-title"><p class="section-label">检查站</p><h2 id="blocker-title">现在卡在哪里</h2><div class="list">${blockers.map((blocker) => `<div class="list-row"><div><strong>${escapeHtml(blocker.title)}</strong><p>${escapeHtml(blocker.detail)}</p>${blocker.action ? `<a class="inline-link" href="${escapeAttr(blocker.action.href)}">${escapeHtml(blocker.action.label)}</a>` : ""}</div><span class="status ${escapeAttr(blocker.tone || "neutral")}">${escapeHtml(statusText(blocker.tone))}</span></div>`).join("")}</div></section>`;
}

function renderPlanSummary(vm) {
  const plan = vm.form?.plan || {};
  const profile = vm.profile || {};
  return `<section class="card" aria-labelledby="plan-summary-title"><div class="card-head"><div><p class="section-label">当前方案</p><h2 id="plan-summary-title">${escapeHtml([plan.name, ...(plan.cities || [])].filter(Boolean).join(" · ") || "筛选方案")}</h2></div><a class="button secondary" href="#plan-settings">调整方案</a></div><div class="card-body"><dl class="definition-grid"><div><dt>关键词</dt><dd>${escapeHtml((plan.keywords || []).map((item) => item.word || item).filter(Boolean).join("、") || "待确认")}</dd></div><div><dt>工作经验</dt><dd>${escapeHtml((plan.experience || []).join("、") || "待确认")}</dd></div><div><dt>薪资策略</dt><dd>${escapeHtml(`${plan.salary?.minK ?? ""}${plan.salary?.maxK ? `–${plan.salary.maxK}K` : ""}` || "待确认")}</dd></div><div><dt>工作节奏</dt><dd>${escapeHtml(plan.workSchedulePreference === "no_preference" ? "不作为排序依据" : "优先双休，其他仍保留")}</dd></div></dl>${renderVersionDiff(profile.versionDiff)}${renderFeedback(profile.feedback)}${renderBossFilter(profile.bossFilter)}<div class="button-row"><a class="button quiet" href="/profile?profileId=${escapeAttr(profile.id)}">查看候选人画像</a><a class="button quiet" href="/resumes?profileId=${escapeAttr(profile.id)}">管理简历版本</a></div></div></section>`;
}

function renderCandidateSummary(profile) {
  return `<section class="card pad" aria-labelledby="candidate-title"><p class="section-label">候选人摘要</p><h2 id="candidate-title">${escapeHtml(profile.name || "候选人待确认")}</h2><p class="muted">${escapeHtml([profile.city, ...(profile.targetTitles || [])].filter(Boolean).join(" · "))}</p><div class="chip-row" aria-label="核心技能">${(profile.skills || []).slice(0, 8).map((skill) => `<span class="chip">${escapeHtml(skill)}</span>`).join("") || "<span class=\"chip\">待确认</span>"}</div><div class="alert good"><strong>画像已确认</strong><p>本轮匹配使用已保存的经历与项目证据；编辑仍在画像页面完成。</p></div><a class="button secondary" href="/profile?profileId=${escapeAttr(profile.id)}">检查画像</a></section>`;
}

function renderQualityGuard(metrics) {
  const total = Number(metrics.remainingDetails || 0) + 1;
  const usedPercent = Math.max(0, Math.min(100, Math.round((1 - Number(metrics.remainingDetails || 0) / total) * 100)));
  return `<section class="card pad" aria-labelledby="quality-title"><p class="section-label">质量护栏</p><h2 id="quality-title">保留覆盖，不用弱岗位凑数</h2><p class="muted">预算只限制本轮窗口，不降低逻辑上的 JD 读取目标；候选不足会保留恢复路径。</p><div class="progress-row"><div class="progress" aria-label="详情读取预算剩余 ${escapeAttr(metrics.remainingDetails || 0)}"><span style="width:${usedPercent}%"></span></div><strong>${usedPercent}%</strong></div></section>`;
}

function renderPlanSettings(vm) {
  const form = vm.form || {};
  const plan = form.plan || {};
  const options = form.options || {};
  const bounds = form.scanBounds || {};
  const defaults = form.scanDefaults || {};
  return `<details id="plan-settings" class="card today-details"><summary class="card-head"><strong>调整筛选条件</strong><span class="tiny">保存后才会重新启用扫描</span></summary><form id="plan-form" class="plan-form card-body" method="post" action="/api/plan"><input type="hidden" name="profileId" value="${escapeAttr(vm.profile?.id)}"><input type="hidden" name="planId" value="${escapeAttr(vm.page?.planId)}"><label class="wide">方案名称<input name="name" value="${escapeAttr(plan.name || "")}" required></label>${renderChoices("城市", "cities", options.cities, plan.cities)}${renderChoices("工作经验", "experience", options.experience, plan.experience)}${renderChoices("求职类型", "jobTypes", options.jobTypes, plan.jobTypes)}${renderChoices("学历筛选（可选，不选则不限制）", "degrees", options.degrees, plan.degrees)}<label>最低薪资（K）<input type="number" min="0" max="100" name="salaryMinK" value="${escapeAttr(plan.salary?.minK || "")}"></label><label>最高薪资（K）<input type="number" min="0" max="100" name="salaryMaxK" value="${escapeAttr(plan.salary?.maxK || "")}"></label>${options.platformSalaryLanes?.length ? renderChoices("BOSS 薪资抓取档位", "platformSalaryLanes", options.platformSalaryLanes, form.selectedBossSalaryLanes) : ""}<label>薪资策略<select name="salaryMode"><option value="wide"${plan.salaryMode !== "strict" ? " selected" : ""}>宽松排序，范围外保留</option><option value="strict"${plan.salaryMode === "strict" ? " selected" : ""}>严格范围，低于下限不推荐</option></select></label><label>工作节奏<select name="workSchedulePreference"><option value="prefer_double_weekend"${plan.workSchedulePreference !== "no_preference" ? " selected" : ""}>优先双休，其他仍保留</option><option value="no_preference"${plan.workSchedulePreference === "no_preference" ? " selected" : ""}>不作为排序依据</option></select></label><label class="wide">目标方向<input name="directions" value="${escapeAttr((plan.directions || []).join("，"))}"></label><label class="wide">搜索关键词<textarea name="keywords" required>${escapeHtml(keywordLines(plan.keywords))}</textarea></label><details class="plan-advanced wide"><summary>广泛扫描预算</summary><div class="plan-advanced-body"><label class="wide">排除词<input name="excludeWords" value="${escapeAttr((plan.excludeWords || []).join("，"))}"></label><label class="wide">硬排除词<input name="hardExcludes" value="${escapeAttr((plan.hardExcludes || []).join("，"))}"></label><label>A类每词岗位数<input type="number" min="${escapeAttr(bounds.maxCards?.[0])}" max="${escapeAttr(bounds.maxCards?.[1])}" name="maxCards" value="${escapeAttr(plan.scan?.maxCards ?? defaults.maxCards ?? "")}"></label><label>右栏详情安全上限<input type="number" min="${escapeAttr(bounds.maxDetailTotal?.[0])}" max="${escapeAttr(bounds.maxDetailTotal?.[1])}" name="maxDetailTotal" value="${escapeAttr(plan.scan?.maxDetailTotal ?? defaults.maxDetailTotal ?? "")}"></label><label>搜索页面安全上限<input type="number" min="${escapeAttr(bounds.browserPageBudget?.[0])}" max="${escapeAttr(bounds.browserPageBudget?.[1])}" name="browserPageBudget" value="${escapeAttr(plan.scan?.browserPageBudget ?? defaults.browserPageBudget ?? "")}"></label></div></details><div class="wide"><button class="button secondary">保存筛选方案</button><span id="plan-dirty-note" class="hint" hidden>条件有修改，请先保存再扫描。</span></div></form></details>`;
}

function renderAdvancedScan(vm) {
  const scan = vm.scan || {};
  const daily = scan.daily || {};
  const broad = scan.broad || {};
  const activeDays = vm.form?.plan?.bossActiveDays || "";
  const resume = scan.resumableBatchId ? `<button data-scan-button name="resumeBatchId" value="${escapeAttr(scan.resumableBatchId)}"${scan.disabled ? " disabled" : ""}>继续未完成扫描 #${escapeHtml(scan.resumableBatchId)}</button>` : "";
  return `<details class="card today-details"><summary class="card-head"><strong>高级扫描与维护</strong><span class="tiny">日常扫描 · 广泛扫描 · 补读详情 · 更新活跃状态</span></summary><section class="card-body scan-panel"><div class="alert"><strong>低频入口</strong><p>日常扫描 ${escapeHtml(daily.keywordPlan?.length || 0)} 个 A/B 关键词，广泛扫描 ${escapeHtml(broad.keywordPlan?.length || 0)} 个关键词；继续使用单标签串行、随机等待和风控即停。</p></div><p class="field-help">招聘方近 ${escapeHtml(activeDays)} 天活跃优先保留。日常扫描 A/B 主档每词最多 ${escapeHtml(daily.maxCards || 0)}/${escapeHtml(scan.dailyBCardLimit || 0)} 张卡片和 ${escapeHtml(daily.detailLimits?.A || 0)}/${escapeHtml(daily.detailLimits?.B || 0)} 个新详情，补充档最多 ${escapeHtml(daily.supplementalSalaryLaneCardLimit || 0)} 张卡片和 ${escapeHtml(daily.supplementalSalaryLaneDetailLimit || 0)} 个新详情；广泛扫描详情最多 ${escapeHtml(broad.maxDetailTotal || 0)} 个。</p><div><strong>扫描状态：</strong>${escapeHtml(vm.run?.label || "尚未运行")}</div>${vm.run?.error ? `<pre class="scan-error">${escapeHtml(vm.run.error)}</pre>` : ""}<form class="inline-form" method="post" action="/api/scan"><input type="hidden" name="planId" value="${escapeAttr(vm.page?.planId)}"><input type="hidden" name="cdpPort" value="9222"><select name="browserMode" title="浏览器模式"><option value="edge" selected>当前已登录 Edge（推荐）</option><option value="portable">项目专用 Edge（手动备用，需要独立登录）</option></select><button data-scan-button name="scanKind" value="daily"${scan.disabled ? " disabled" : ""}>日常扫描</button><button data-scan-button name="scanKind" value="broad"${scan.disabled ? " disabled" : ""}>广泛扫描</button>${resume}<button data-scan-button name="scanKind" value="refresh"${scan.disabled ? " disabled" : ""}>补读缺失详情</button><button data-scan-button name="scanKind" value="activity"${scan.disabled ? " disabled" : ""}>更新过期活跃状态</button><a class="button secondary" href="/queue?planId=${escapeAttr(vm.page?.planId)}">待处理队列</a><a class="button secondary" href="/jobs?planId=${escapeAttr(vm.page?.planId)}&amp;batch=latest">查看岗位</a></form></section></details>`;
}

function renderChoices(label, name, options = [], selected = []) {
  const chosen = new Set(selected || []);
  return `<div class="choice-section"><strong>${escapeHtml(label)}</strong><div class="choice-list">${(options || []).map((value) => `<label class="choice-item"><input type="checkbox" name="${escapeAttr(name)}" value="${escapeAttr(value)}"${chosen.has(value) ? " checked" : ""}><span>${escapeHtml(value)}</span></label>`).join("")}</div></div>`;
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

function renderBossFilter(filter = {}) {
  return `<p class="plan-note">BOSS 站内预筛：${escapeHtml(filter.summary || "待预读")}${filter.discoveredAt ? `。规则读取于 ${escapeHtml(filter.discoveredAt)}` : ""}；扫描时仍保留 JD 匹配、活跃度和岗位风险判断。</p>`;
}

function statusText(tone) { return { good: "已检查", waiting: "待处理", danger: "需恢复" }[tone] || "提示"; }
function keywordLines(keywords = []) { return keywords.map((item) => `${item.word || item} | ${item.priority || "B"} | ${item.reason || "用户确认的搜索关键词"}`).join("\n"); }

function renderClientScripts(runState, includeBrowserReadiness) {
  const readiness = includeBrowserReadiness ? `<script>
    (function(){
      const statusNode = document.getElementById('browser-readiness-status');
      const button = document.querySelector('[data-browser-readiness-button]');
      const browserMode = document.querySelector('select[name=browserMode]');
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
  return `${readiness}<script>(function(){const form=document.getElementById('plan-form');const note=document.getElementById('plan-dirty-note');if(!form)return;form.addEventListener('input',function(){document.querySelectorAll('[data-scan-button]').forEach(function(button){button.disabled=true});if(note)note.hidden=false});}());</script>${runState === "running" ? `<script>setTimeout(()=>location.reload(),2500)</script>` : ""}`;
}

module.exports = { renderTodayPage };
