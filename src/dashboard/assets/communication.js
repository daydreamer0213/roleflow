"use strict";

(() => {
  const page = document.querySelector("[data-communication-page]");
  if (!page) return;

  const number = (value) => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
  const batchId = number(page.dataset.communicationBatchId);
  if (!batchId) return;

  const interval = Math.max(2500, number(page.dataset.communicationPollingInterval) || 2500);
  const initialItemIds = String(page.dataset.communicationItemIds || "").split(",").filter(Boolean)
    .map(number).sort((left, right) => left - right).join(",");
  const active = new Set(["opening", "verified", "click_dispatched"]);
  const terminalBatches = new Set(["completed", "stopped", "interrupted", "failed"]);
  const statusLabels = Object.freeze({
    pending: "待执行",
    opening: "正在核对",
    verified: "身份已核验",
    click_dispatched: "已发出操作",
    succeeded: "已核验成功",
    already_communicated: "已确认已沟通",
    ambiguous: "结果待人工确认",
    stopped: "已停止",
    job_unavailable: "岗位不可用",
    target_mismatch: "目标不匹配",
    action_unavailable: "操作不可用",
    platform_rejected: "平台拒绝",
    transport_failed: "传输失败"
  });
  let timer = null;
  let pollInFlight = false;
  let reloadRequested = false;

  const node = (selector) => page.querySelector(selector);
  const nodes = (selector) => [...page.querySelectorAll(selector)];
  const controls = (disabled) => nodes("[data-communication-control]").forEach((control) => { control.disabled = Boolean(disabled); });
  const sameItems = (items) => items.map((item) => number(item.id))
    .sort((left, right) => left - right).join(",") === initialItemIds;
  const validSnapshot = (data) => Boolean(data && data.batch && data.summary && Array.isArray(data.items)
    && number(data.batch.id) && typeof data.batch.status === "string");

  function stopTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function requestReload() {
    if (reloadRequested) return;
    reloadRequested = true;
    stopTimer();
    location.reload();
  }

  function showError() {
    const error = node("[data-communication-error]");
    if (error) error.hidden = false;
    controls(true);
  }

  function clearError() {
    const error = node("[data-communication-error]");
    if (error) error.hidden = true;
  }

  function render(data) {
    const summary = data.summary || {};
    const counts = summary.statusCounts || {};
    const terminal = number(summary.terminal);
    const total = number(summary.total);
    const succeeded = number(counts.succeeded) + number(counts.already_communicated);
    const terminalNode = node("[data-communication-terminal]");
    const successNode = node("[data-communication-success]");
    const remainingNode = node("[data-communication-remaining]");
    const meter = node("[data-communication-meter]");
    if (terminalNode) terminalNode.textContent = String(terminal);
    if (successNode) successNode.textContent = String(succeeded);
    if (remainingNode) remainingNode.textContent = String(number(summary.remaining));
    if (meter) { meter.max = Math.max(1, total); meter.value = Math.min(meter.max, terminal); }
    for (const item of data.items) {
      const row = node(`[data-communication-item-id="${number(item.id)}"]`);
      if (!row) continue;
      const status = row.querySelector("[data-communication-item-status]");
      if (status) status.textContent = statusLabels[String(item.status || "")] || "状态待确认";
      if (active.has(String(item.status || ""))) row.setAttribute("aria-current", "step");
      else row.removeAttribute("aria-current");
    }
    page.dataset.communicationBatchStatus = String(data.batch.status || "");
  }

  async function poll() {
    if (pollInFlight || reloadRequested) return;
    pollInFlight = true;
    try {
      const response = await fetch("/api/communication-status?batchId=" + encodeURIComponent(batchId), { cache: "no-store" });
      if (!response.ok) throw new Error("status response");
      const data = await response.json();
      if (!validSnapshot(data)) throw new Error("status payload");
      const counts = data.summary.statusCounts || {};
      const ambiguous = number(counts.ambiguous) > 0 || data.items.some((item) => item.status === "ambiguous");
      if (ambiguous
        || terminalBatches.has(data.batch.status)
        || number(data.batch.id) !== batchId
        || !sameItems(data.items)) {
        requestReload();
        return;
      }
      clearError();
      render(data);
    } catch {
      showError();
    } finally {
      pollInFlight = false;
    }
  }

  function schedule(delay = interval) {
    stopTimer();
    if (reloadRequested || document.hidden) return;
    timer = setTimeout(async () => {
      timer = null;
      await poll();
      schedule(interval);
    }, delay);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopTimer();
    else schedule(0);
  });
  window.addEventListener("pagehide", stopTimer);
  window.addEventListener("pageshow", () => schedule(0));
  schedule(0);
})();
