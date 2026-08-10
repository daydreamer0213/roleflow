"use strict";

(() => {
  const page = document.querySelector("[data-workflow-page]");
  if (!page) return;
  const panel = page.querySelector("[data-workflow-panel]");
  const pollKind = page.dataset.pollingKind || "none";
  const runId = page.dataset.workflowRunId || "";
  const interval = Math.max(2500, Number(page.dataset.pollingInterval) || 2500);
  const terminal = new Set((page.dataset.terminalStates || "").split(",").filter(Boolean));
  let pollInFlight = false;
  let timer = null;
  let lastKey = page.dataset.pollingKey || "";

  const node = (selector) => page.querySelector(selector);
  const nodes = (selector) => [...page.querySelectorAll(selector)];
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const setText = (selector, value) => { const target = node(selector); if (target) target.textContent = String(value); };
  const controls = (disabled) => nodes("[data-workflow-control]").forEach((button) => { button.disabled = Boolean(disabled); });
  const duration = (seconds) => { const value = Math.max(0, Math.ceil(number(seconds))); if (value < 60) return String(value) + " 秒"; if (value < 3600) return String(Math.ceil(value / 60)) + " 分钟"; const hours = Math.floor(value / 3600); const minutes = Math.ceil((value % 3600) / 60); return minutes ? String(hours) + " 小时 " + String(minutes) + " 分钟" : String(hours) + " 小时"; };
  const etaText = (eta = {}) => eta.status === "available" ? "预计剩余 " + duration(eta.minSeconds) + "～" + duration(eta.maxSeconds) + "（基于最近 " + number(eta.sampleSize) + " 个完成岗位估算）" : eta.status === "paused" ? (eta.minSeconds == null || eta.maxSeconds == null ? "已暂停；样本不足，正在估算" : "已暂停；剩余区间冻结为 " + duration(eta.minSeconds) + "～" + duration(eta.maxSeconds) + "（" + number(eta.sampleSize) + " 个样本）") : eta.status === "estimating" ? "正在估算" : "当前阶段不估算剩余时间";
  const activityText = (activity = {}) => { const action = { analysis_started: "开始分析", analysis_succeeded: "已成功保存", analysis_failed: "分析失败", analysis_skipped: "已按本地规则处理", waiting_lease_expiry: "正在等待安全收尾", control_requested: "正在执行控制请求" }[activity.type] || "状态已更新"; return ["任务 #", number(activity.taskId), " ", action, activity.attempt ? "，第 " + number(activity.attempt) + " 次尝试" : "", activity.modelRole === "backup" ? "，备用模型" : "", activity.errorCode ? "，" + String(activity.errorCode) : ""].join(""); };
  const validSnapshot = (snapshot) => Boolean(snapshot && snapshot.workflow && snapshot.progress && snapshot.progress.analysis && snapshot.progress.eta && snapshot.controls && Array.isArray(snapshot.recentActivity));
  const showError = (message = "无法读取任务状态") => { const error = node("[data-workflow-error]"); if (error) { error.textContent = message; error.hidden = false; } controls(true); };
  const clearError = () => { const error = node("[data-workflow-error]"); if (error) error.hidden = true; };
  const scanWaitText = (scanWait) => { const retryAt = Date.parse(scanWait?.retryAt || ""); if (!Number.isFinite(retryAt) || retryAt <= Date.now()) return ""; return "安全冷却中，预计 " + Math.max(1, Math.ceil((retryAt - Date.now()) / 60000)) + " 分钟后继续（" + new Date(retryAt).toLocaleTimeString("zh-CN", { hour12: false }) + "）"; };
  const renderScanWait = (scanWait) => { const wait = node("[data-scan-wait]"); if (!wait) return; const label = scanWaitText(scanWait); wait.hidden = !label; if (label) wait.textContent = label; };
  const renderStale = (workflow) => { const warning = node("[data-workflow-stale]"); if (!warning) return; const at = Date.parse(workflow.lastActivityAt || ""); const active = ["created", "scanning", "analyzing"].includes(workflow.status); warning.hidden = !(active && Number.isFinite(at) && Date.now() - at > 30000); };
  const renderProgress = (snapshot) => {
    const analysis = snapshot.progress.analysis || {};
    const detailRequired = number(analysis.detailRequired);
    const analyzed = number(analysis.succeeded) + Math.max(0, number(analysis.skipped) - detailRequired);
    const completed = analyzed + detailRequired + number(analysis.failed) + number(analysis.stopped);
    const remaining = number(analysis.pending) + number(analysis.running) + number(analysis.retryPending);
    setText("[data-stage-label]", "第 " + number(snapshot.progress.stageIndex) + " 阶段 / 共 " + number(snapshot.progress.stageCount) + " 阶段");
    setText("[data-stage-name]", snapshot.progress.stage || "");
    for (const [selector, value] of [["[data-analysis-total]", analysis.total], ["[data-analysis-succeeded]", analysis.succeeded], ["[data-analysis-running]", analysis.running], ["[data-analysis-retry-pending]", analysis.retryPending], ["[data-analysis-detail-required]", detailRequired], ["[data-detail-read]", snapshot.progress.detailsRead], ["[data-detail-pending]", snapshot.progress.detailsPending], ["[data-analysis-failed]", analysis.failed], ["[data-analysis-remaining]", remaining], ["[data-stop-collected]", snapshot.progress.collected ?? analysis.total], ["[data-stop-analyzed]", analyzed], ["[data-stop-failed]", analysis.failed], ["[data-stop-unfinished]", remaining]]) setText(selector, number(value));
    setText("[data-analysis-timeouts]", "当前恢复周期最终超时 " + number(analysis.circuitTimeoutJobs) + " / " + number(analysis.timeoutPauseThreshold || 10) + " · 本轮累计超时 " + number(analysis.lifetimeTimeoutJobs));
    setText("[data-eta]", etaText(snapshot.progress.eta));
    setText("[data-recent-activity]", snapshot.recentActivity.length ? snapshot.recentActivity.map(activityText).join("；") : "还没有新的分析活动。");
    setText("[data-stop-slot]", snapshot.controls.stopConsumesRunSlot ? "会占用今天一轮" : "不会占用今天一轮");
    const meter = node("[data-analysis-progress]"); if (meter) { meter.max = Math.max(1, number(analysis.total)); meter.value = completed; }
    if (panel) panel.dataset.progressRevision = String(number(snapshot.workflow.progressRevision));
  };
  const renderControls = (snapshot) => {
    const status = snapshot.workflow.status;
    const running = ["created", "scanning", "analyzing"].includes(status);
    const paused = status === "paused";
    const runningGroup = node('[data-control-group="running"]'); if (runningGroup) runningGroup.hidden = !running;
    const pausedGroup = node('[data-control-group="paused"]'); if (pausedGroup) pausedGroup.hidden = !paused;
    const pause = node('[data-action="pause"]'); if (pause) pause.disabled = !snapshot.controls.canPause;
    const resume = node('[data-action="resume"]'); if (resume) resume.disabled = !snapshot.controls.canResume;
    nodes('[data-action="stop-preview"]').forEach((button) => { button.disabled = !snapshot.controls.canStop; });
    const stopConfirm = node('[data-action="stop-confirm"]'); if (stopConfirm) stopConfirm.disabled = !snapshot.controls.canStop;
    if (paused) setText("[data-pause-reason]", snapshot.workflow.errorCode || "本轮已安全暂停");
    if (terminal.has(status)) { controls(true); if (timer) { clearInterval(timer); timer = null; } }
  };
  const pollProgress = async () => {
    if (pollInFlight || !runId) return;
    pollInFlight = true;
    try {
      const response = await fetch("/api/workflow-status?runId=" + encodeURIComponent(runId), { cache: "no-store" });
      if (!response.ok) throw new Error("status response");
      const snapshot = await response.json();
      if (!validSnapshot(snapshot)) throw new Error("status payload");
      clearError(); renderControls(snapshot); renderScanWait(snapshot.progress.scanWait); renderStale(snapshot.workflow);
      const nextKey = [number(snapshot.workflow.progressRevision), snapshot.workflow.status || "", snapshot.workflow.controlState || ""].join("|");
      if (nextKey !== lastKey) { lastKey = nextKey; renderProgress(snapshot); }
    } catch { showError(); } finally { pollInFlight = false; }
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
      if (key !== lastKey) { if (timer) clearInterval(timer); location.reload(); }
    } catch {} finally { pollInFlight = false; }
  };

  nodes("[data-workflow-control-form]").forEach((form) => form.addEventListener("submit", () => controls(true)));
  nodes('[data-action="stop-preview"]').forEach((button) => button.addEventListener("click", () => { const confirmation = node("[data-stop-confirmation]"); if (confirmation) { confirmation.hidden = false; node('[data-action="stop-confirm"]')?.focus(); } }));
  node('[data-action="stop-cancel"]')?.addEventListener("click", () => { const confirmation = node("[data-stop-confirmation]"); if (confirmation) confirmation.hidden = true; });
  const review = document.getElementById("workflow-review-form");
  if (review) {
    const output = document.getElementById("workflow-selected-count");
    const confirm = document.getElementById("workflow-confirm");
    const limit = number(review.dataset.reviewLimit);
    const blocked = review.dataset.reviewBlocked === "true";
    const update = () => { const count = review.querySelectorAll('input[name="jobIds"]:checked').length; if (output) output.value = String(count); if (confirm) confirm.disabled = blocked || count === 0 || count > limit; };
    review.addEventListener("change", update); update();
  }
  if (pollKind === "progress" && panel) timer = setInterval(pollProgress, interval);
  if (pollKind === "communication") timer = setInterval(pollCommunication, interval);
})();
