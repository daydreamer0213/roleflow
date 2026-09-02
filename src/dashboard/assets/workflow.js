"use strict";

(() => {
  const page = document.querySelector("[data-workflow-page]");
  if (!page) return;
  const panel = page.querySelector("[data-workflow-panel]");
  const pollKind = page.dataset.pollingKind || "none";
  const pollEnabled = (pollKind === "progress" && Boolean(panel)) || pollKind === "communication";
  const runId = page.dataset.workflowRunId || "";
  const interval = Math.max(2500, Number(page.dataset.pollingInterval) || 2500);
  const terminal = new Set((page.dataset.terminalStates || "").split(",").filter(Boolean));
  let pollInFlight = false;
  let timer = null;
  let cooldownTimer = null;
  let lastKey = page.dataset.pollingKey || "";
  let lastActivityKey = "";
  let reloadRequested = false;

  const node = (selector) => page.querySelector(selector);
  const nodes = (selector) => [...page.querySelectorAll(selector)];
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const setText = (selector, value) => { const target = node(selector); if (target) target.textContent = String(value); };
  const controls = (disabled) => nodes("[data-workflow-control]").forEach((button) => { button.disabled = Boolean(disabled); });
  const duration = (seconds) => { const value = Math.max(0, Math.ceil(number(seconds))); if (value < 60) return String(value) + " 秒"; if (value < 3600) return String(Math.ceil(value / 60)) + " 分钟"; const hours = Math.floor(value / 3600); const minutes = Math.ceil((value % 3600) / 60); return minutes ? String(hours) + " 小时 " + String(minutes) + " 分钟" : String(hours) + " 小时"; };
  const etaText = (eta = {}) => eta.status === "available" ? "预计剩余 " + duration(eta.minSeconds) + "～" + duration(eta.maxSeconds) + "（基于最近 " + number(eta.sampleSize) + " 个完成岗位估算）" : eta.status === "paused" ? (eta.minSeconds == null || eta.maxSeconds == null ? "已暂停；样本不足，正在估算" : "已暂停；剩余区间冻结为 " + duration(eta.minSeconds) + "～" + duration(eta.maxSeconds) + "（" + number(eta.sampleSize) + " 个样本）") : eta.status === "estimating" ? "正在估算" : "当前阶段不估算剩余时间";
  const cooldownReasonText = (action) => ({ detail_open: "正在读取岗位详情", pane_detail_read: "正在读取岗位详情", job_detail_fetch: "正在读取岗位详情", list_navigation: "正在切换岗位列表" }[String(action || "")] || "平台访问正在安全冷却");
  const activityText = (activity = {}) => { const action = { analysis_started: "开始分析", analysis_succeeded: "已成功保存", analysis_failed: "分析失败", analysis_skipped: "已按本地规则处理", waiting_lease_expiry: "正在等待安全收尾", control_requested: "正在执行控制请求" }[activity.type] || "状态已更新"; return ["任务 #", number(activity.taskId), " ", action, activity.attempt ? "，第 " + number(activity.attempt) + " 次尝试" : "", activity.modelRole === "backup" ? "，备用模型" : "", activity.errorCode ? "，" + String(activity.errorCode) : ""].join(""); };
  const validSnapshot = (snapshot) => Boolean(snapshot && snapshot.workflow && snapshot.progress && snapshot.progress.analysis && snapshot.progress.eta && snapshot.controls && Array.isArray(snapshot.recentActivity));
  const showError = (message = "无法读取任务状态") => { const error = node("[data-workflow-error]"); if (error) { error.textContent = message; error.hidden = false; } controls(true); };
  const clearError = () => { const error = node("[data-workflow-error]"); if (error) error.hidden = true; };
  const scanWaitText = (scanWait) => { const retryAt = Date.parse(scanWait?.retryAt || ""); if (!Number.isFinite(retryAt) || retryAt <= Date.now()) return ""; return "安全冷却中，预计 " + Math.max(1, Math.ceil((retryAt - Date.now()) / 60000)) + " 分钟后继续（" + new Date(retryAt).toLocaleTimeString("zh-CN", { hour12: false }) + "）"; };

  function stopCooldownTimer() {
    if (cooldownTimer) clearInterval(cooldownTimer);
    cooldownTimer = null;
  }

  function renderCooldown(scanWait) {
    const countdown = node("[data-cooldown-countdown]");
    const container = node("[data-cooldown]");
    if (!countdown) return;
    const retryValue = scanWait === undefined ? countdown.dataset.retryAt : scanWait?.retryAt;
    const retryAt = Date.parse(retryValue || "");
    if (!Number.isFinite(retryAt)) {
      countdown.textContent = "";
      if (container) container.hidden = true;
      stopCooldownTimer();
      return;
    }
    const seconds = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
    countdown.textContent = seconds >= 86400 ? String(Math.ceil(seconds / 86400)) + " 天" : duration(seconds);
    if (container) container.hidden = false;
    if (seconds <= 0) stopCooldownTimer();
    else if (!cooldownTimer) cooldownTimer = setInterval(() => renderCooldown(), 1000);
  }

  const renderScanWait = (scanWait) => {
    const wait = node("[data-scan-wait]");
    if (!wait) return;
    const label = scanWaitText(scanWait);
    wait.hidden = !label;
    if (label) wait.textContent = label;
  };

  const renderOverview = (snapshot) => {
    const scanWait = snapshot.progress.scanWait;
    const retryAt = Date.parse(scanWait?.retryAt || "");
    const cooldown = node("[data-cooldown]");
    const stable = node("[data-overview-blocker-stable]");
    const countdown = node("[data-cooldown-countdown]");
    setText("[data-overview-progress]", "第 " + number(snapshot.progress.stageIndex) + " / " + number(snapshot.progress.stageCount) + " 阶段");
    const scanTargets = snapshot.progress.scanTargets || {};
    const details = snapshot.progress.details || {};
    setText("[data-overview-acquisition]", "搜索目标 " + number(scanTargets.processed) + " / " + number(scanTargets.total) + " · 已获取 " + number(details.collected) + " 个岗位");
    setText("[data-overview-jd]", "已读取 " + number(details.read) + " / " + number(details.required) + " · 待补 " + number(details.pending));
    setText("[data-overview-remaining]", snapshot.progress.remainingWorkLabel || "本轮状态正在更新");
    setText("[data-overview-eta]", Number.isFinite(retryAt) && retryAt > Date.now() ? "安全冷却至 " + new Date(retryAt).toLocaleString("zh-CN", { hour12: false }) : etaText(snapshot.progress.eta));
    if (Number.isFinite(retryAt) && retryAt > Date.now()) {
      if (stable) stable.hidden = true;
      if (cooldown) { cooldown.hidden = false; cooldown.dataset.retryAt = scanWait.retryAt; }
      if (countdown) countdown.dataset.retryAt = scanWait.retryAt;
      setText("[data-cooldown-reason]", cooldownReasonText(scanWait.action));
      const retry = node("[data-cooldown-retry-time]");
      if (retry) { retry.dateTime = scanWait.retryAt; retry.textContent = new Date(retryAt).toLocaleString("zh-CN", { hour12: false }); }
    } else {
      if (stable) stable.hidden = false;
      if (cooldown) { cooldown.hidden = true; cooldown.dataset.retryAt = ""; }
      if (countdown) countdown.dataset.retryAt = "";
    }
    renderCooldown(scanWait);
  };

  const renderTrack = (name, track = {}) => {
    setText(`[data-track-fraction="${name}"]`, number(track.value) + " / " + number(track.max));
    const meter = node(`[data-track-meter="${name}"]`);
    if (!meter) return;
    meter.max = Math.max(1, number(track.max));
    if (track.indeterminate) meter.removeAttribute("value");
    else meter.value = Math.min(meter.max, number(track.value));
  };

  const analysisStatusText = (task = {}) => {
    if (task.lastErrorCode === "DETAIL_REQUIRED") return "详情待补";
    if (task.status === "failed" && task.resolvedAfterFailure) return "首次失败，后续已解决";
    return ({ pending: "等待分析", running: "分析中", retry_pending: "等待重试", succeeded: "已完成", skipped: "已按本地规则处理", failed: "分析失败", stopped: "已停止" })[String(task.status || "")] || "状态待确认";
  };

  const renderAnalysisTasks = (tasks = []) => {
    for (const task of tasks) {
      const row = node(`[data-analysis-task-id="${number(task.id)}"]`);
      if (!row) continue;
      const status = row.querySelector("[data-analysis-task-status]");
      if (status) status.textContent = analysisStatusText(task);
      if (task.status === "running") row.setAttribute("aria-current", "step");
      else row.removeAttribute("aria-current");
    }
  };

  const scanActivityText = (scan) => {
    if (!scan) return "";
    const target = String(scan.targetLabel || "当前目标") + "（目标 " + number(scan.targetPosition) + " / " + number(scan.targetTotal) + "）";
    if (scan.activity === "reading_detail") return "正在读取 " + target + " 的岗位详情 " + number(scan.detailPosition) + " / " + number(scan.detailTotal);
    if (scan.activity === "target_complete") return target + " 已处理完成";
    return "正在扫描 " + target + "，已发现 " + number(scan.targetDiscovered) + " 个岗位";
  };

  const renderCurrentActivity = (scan) => {
    if (!scan) return;
    const key = [scan.activity, scan.targetKey, scan.targetPosition, scan.detailPosition].join("|");
    if (key === lastActivityKey) return;
    lastActivityKey = key;
    setText("[data-current-activity]", scanActivityText(scan));
  };

  const renderStale = (workflow) => { const warning = node("[data-workflow-stale]"); if (!warning) return; const at = Date.parse(workflow.lastActivityAt || ""); const active = ["created", "scanning", "analyzing"].includes(workflow.status); warning.hidden = !(active && Number.isFinite(at) && Date.now() - at > 30000); };

  const renderProgress = (snapshot) => {
    const analysis = snapshot.progress.analysis || {};
    const scanTargets = snapshot.progress.scanTargets || {};
    const details = snapshot.progress.details || {};
    const detailRequired = number(analysis.detailRequired);
    const historicalFailed = Object.prototype.hasOwnProperty.call(analysis, "historicalFailed") ? number(analysis.historicalFailed) : number(analysis.failed);
    const resolvedAfterFailure = number(analysis.resolvedAfterFailure);
    const unresolvedFailed = Object.prototype.hasOwnProperty.call(analysis, "unresolvedFailed") ? number(analysis.unresolvedFailed) : Math.max(0, historicalFailed - resolvedAfterFailure);
    const analyzed = number(analysis.succeeded) + resolvedAfterFailure + Math.max(0, number(analysis.skipped) - detailRequired);
    const remaining = number(analysis.pending) + number(analysis.running) + number(analysis.retryPending);
    setText("[data-stage-label]", "第 " + number(snapshot.progress.stageIndex) + " 阶段 / 共 " + number(snapshot.progress.stageCount) + " 阶段");
    setText("[data-stage-name]", snapshot.progress.stage || "");
    for (const [selector, value] of [["[data-scan-target-total]", scanTargets.total], ["[data-scan-target-completed]", scanTargets.completed], ["[data-scan-target-pending]", scanTargets.pending], ["[data-detail-collected]", details.collected], ["[data-analysis-total]", analysis.total], ["[data-analysis-succeeded]", analysis.succeeded], ["[data-analysis-direct-succeeded]", analysis.succeeded], ["[data-analysis-historical-failed]", historicalFailed], ["[data-analysis-resolved-after-failure]", resolvedAfterFailure], ["[data-analysis-unresolved-failed]", unresolvedFailed], ["[data-analysis-running]", analysis.running], ["[data-analysis-retry-pending]", analysis.retryPending], ["[data-analysis-detail-required]", detailRequired], ["[data-detail-read]", details.read], ["[data-detail-pending]", details.pending], ["[data-analysis-failed]", historicalFailed], ["[data-analysis-remaining]", remaining], ["[data-stop-collected]", details.collected], ["[data-stop-analyzed]", analyzed], ["[data-stop-failed]", unresolvedFailed], ["[data-stop-unfinished]", remaining]]) setText(selector, number(value));
    setText("[data-analysis-timeouts]", "当前恢复周期最终超时 " + number(analysis.circuitTimeoutJobs) + " / " + number(analysis.timeoutPauseThreshold || 10) + " · 本轮累计超时 " + number(analysis.lifetimeTimeoutJobs));
    setText("[data-eta]", etaText(snapshot.progress.eta));
    setText("[data-recent-activity]", snapshot.recentActivity.length ? snapshot.recentActivity.map(activityText).join("；") : "还没有新的分析活动。");
    setText("[data-stop-slot]", snapshot.controls.stopConsumesRunSlot ? "会占用今天一轮" : "不会占用今天一轮");
    for (const name of ["scan", "jd", "analysis", "communication"]) renderTrack(name, snapshot.progress.tracks?.[name]);
    renderAnalysisTasks(analysis.tasks);
    renderCurrentActivity(snapshot.progress.scan);
    if (panel) panel.dataset.progressRevision = String(number(snapshot.workflow.progressRevision));
  };

  const renderControls = (snapshot) => {
    const status = snapshot.workflow.status;
    const running = ["created", "scanning", "analyzing"].includes(status);
    const paused = status === "paused";
    const pauseRequested = running && snapshot.workflow.controlState === "pause_requested";
    const runningGroup = node('[data-control-group="running"]'); if (runningGroup) runningGroup.hidden = !running || pauseRequested;
    const pauseRequestedGroup = node('[data-control-group="pause-requested"]'); if (pauseRequestedGroup) pauseRequestedGroup.hidden = !pauseRequested;
    const pausedGroup = node('[data-control-group="paused"]'); if (pausedGroup) pausedGroup.hidden = !paused;
    const pause = node('[data-action="pause"]'); if (pause) pause.disabled = !snapshot.controls.canPause;
    const resume = node('[data-action="resume"]'); if (resume) resume.disabled = !snapshot.controls.canResume;
    nodes('[data-workflow-primary="true"]').forEach((button) => button.removeAttribute("data-workflow-primary"));
    if (paused && resume) resume.dataset.workflowPrimary = "true";
    nodes('[data-action="stop-preview"]').forEach((button) => { button.disabled = !snapshot.controls.canStop; });
    const stopConfirm = node('[data-action="stop-confirm"]'); if (stopConfirm) stopConfirm.disabled = !snapshot.controls.canStop;
    if (paused) setText("[data-pause-reason]", snapshot.workflow.errorCode || "本轮已安全暂停");
    page.dataset.workflowStatus = status;
    page.dataset.workflowControlState = snapshot.workflow.controlState || "none";
  };

  function stopTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function requestReload() {
    if (reloadRequested) return;
    reloadRequested = true;
    stopTimer();
    stopCooldownTimer();
    location.reload();
  }

  const structureChanged = (snapshot) => String(snapshot.progress.phaseKey || "") !== String(page.dataset.workflowPhaseKey || "");

  const pollProgress = async () => {
    if (pollInFlight || !runId) return;
    pollInFlight = true;
    try {
      const response = await fetch("/api/workflow-status?runId=" + encodeURIComponent(runId), { cache: "no-store" });
      if (!response.ok) throw new Error("status response");
      const snapshot = await response.json();
      if (!validSnapshot(snapshot)) throw new Error("status payload");
      if (structureChanged(snapshot)) { requestReload(); return; }
      clearError();
      renderControls(snapshot);
      renderScanWait(snapshot.progress.scanWait);
      renderOverview(snapshot);
      renderStale(snapshot.workflow);
      renderProgress(snapshot);
      lastKey = [number(snapshot.workflow.progressRevision), snapshot.workflow.status || "", snapshot.workflow.controlState || ""].join("|");
    } catch {
      showError();
    } finally {
      pollInFlight = false;
    }
  };

  const pollCommunication = async () => {
    if (pollInFlight || !runId) return;
    pollInFlight = true;
    try {
      const response = await fetch("/api/workflow-status?runId=" + encodeURIComponent(runId), { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      const counts = data.communication?.summary?.statusCounts || {};
      const key = [data.workflow?.status || "", data.communication?.batch?.status || "", number(data.workflow?.successfulCount), number(counts.succeeded), number(counts.already_communicated), number(data.communication?.summary?.terminal)].join("|");
      if (key !== lastKey) requestReload();
    } catch {} finally {
      pollInFlight = false;
    }
  };

  const poll = pollKind === "progress" ? pollProgress : pollCommunication;

  function schedule(delay = interval) {
    stopTimer();
    if (!pollEnabled || reloadRequested || document.hidden || terminal.has(page.dataset.workflowStatus) || !runId) return;
    timer = setTimeout(async () => {
      timer = null;
      await poll();
      schedule(interval);
    }, delay);
  }

  nodes("[data-workflow-control-form]").forEach((form) => form.addEventListener("submit", () => controls(true)));
  nodes('[data-action="stop-preview"]').forEach((button) => button.addEventListener("click", () => { const confirmation = node("[data-stop-confirmation]"); if (confirmation) confirmation.hidden = false; }));
  node('[data-action="stop-cancel"]')?.addEventListener("click", () => { const confirmation = node("[data-stop-confirmation]"); if (confirmation) confirmation.hidden = true; });
  const review = document.getElementById("workflow-review-form");
  if (review) {
    const output = document.getElementById("workflow-selected-count");
    const confirm = document.getElementById("workflow-confirm");
    const limit = number(review.dataset.reviewLimit);
    const blocked = review.dataset.reviewBlocked === "true";
    const update = () => { const count = review.querySelectorAll('input[name="jobIds"]:checked').length; if (output) output.value = String(count); if (confirm) confirm.disabled = blocked || count === 0 || count > limit; };
    review.addEventListener("change", update);
    update();
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopTimer();
    else schedule(0);
  });
  window.addEventListener("pagehide", () => { stopTimer(); stopCooldownTimer(); });
  window.addEventListener("pageshow", () => { renderCooldown(); schedule(0); });
  renderCooldown();
  if (pollEnabled) schedule(0);
})();
