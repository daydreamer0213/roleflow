const { PRODUCT_POLICY } = require("./product_policy");
const { recordSiteAccessEvent, listSiteAccessEvents } = require("./storage");

const DEFAULT_POLICY = Object.freeze({
  ...PRODUCT_POLICY.operations.bossAccessBudget,
  combinedUsage: PRODUCT_POLICY.operations.bossCommunication.combinedUsage
});
const DAY_MS = 24 * 60 * 60_000;
const CHINA_OFFSET_MS = 8 * 60 * 60_000;

function createSiteAccessController({
  db,
  site = "boss",
  runId = "",
  logger = null,
  policy = DEFAULT_POLICY,
  nowFn = Date.now,
  sleepFn = null,
  signal = null,
  randomFn = Math.random
}) {
  if (!db) throw new Error("访问预算控制器需要数据库连接。");

  return {
    async reserve(action, details = {}) {
      const normalizedAction = String(action || "").trim().toLowerCase();
      let waitedMs = 0;
      while (true) {
        throwIfAborted(signal);
        const nowMs = Number(nowFn());
        let transactionOpen = false;
        let decision;
        try {
          db.exec("BEGIN IMMEDIATE");
          transactionOpen = true;
          const mode = resolveAccessMode(db, { site, nowMs, policy });
          const limits = policy.modes[mode]?.[normalizedAction] || {};
          const usage = readUsage(db, { site, action: normalizedAction, nowMs, policy });
          const existing = normalizedAction === "communication_visit"
            ? existingCommunicationReservation(db, { site, details, nowMs, policy })
            : null;
          if (existing) {
            db.exec("COMMIT");
            transactionOpen = false;
            logger?.info("site_access_reservation_reused", {
              site,
              action: normalizedAction,
              mode,
              eventId: existing.id,
              usage,
              limits,
              batchId: details.batchId,
              itemId: details.itemId
            });
            return { site, action: normalizedAction, mode, waitedMs, usage, limits, reused: true, eventId: existing.id };
          }
          const blockers = Object.entries(limits)
            .filter(([window]) => usage[window] >= limits[window])
            .map(([window, limit]) => ({ window, limit, retryAtMs: nextAvailableAt(db, { site, action: normalizedAction, window, nowMs, policy }) }));

          if (!blockers.length) {
            recordSiteAccessEvent(db, {
              site,
              action: normalizedAction,
              runId,
              details,
              createdAt: new Date(nowMs).toISOString()
            });
            const nextUsage = Object.fromEntries(Object.entries(usage).map(([window, count]) => [window, count + 1]));
            db.exec("COMMIT");
            transactionOpen = false;
            logger?.info("site_access_reserved", { site, action: normalizedAction, mode, waitedMs, usage: nextUsage, limits });
            return { site, action: normalizedAction, mode, waitedMs, usage: nextUsage, limits, reused: false };
          }
          decision = { mode, limits, usage, blockers };
          db.exec("COMMIT");
          transactionOpen = false;
        } catch (error) {
          if (transactionOpen) {
            try { db.exec("ROLLBACK"); } catch {}
          }
          throw error;
        }

        const { mode, limits, usage, blockers } = decision;

        const daily = blockers.find((item) => item.window === "24h");
        if (daily) throw accessBudgetError({ site, action: normalizedAction, mode, usage, ...daily });

        const retryAtMs = Math.max(...blockers.map((item) => item.retryAtMs));
        const jitterMs = randomBetween(...policy.waitJitterMs, randomFn);
        const delayMs = Math.max(1000, retryAtMs - nowMs + jitterMs);
        logger?.warn("site_access_window_wait", {
          site,
          action: normalizedAction,
          mode,
          delayMs,
          usage,
          limits,
          windows: blockers.map((item) => item.window)
        });
        console.error(`[${site}] 访问额度进入冷却，约 ${Math.ceil(delayMs / 60_000)} 分钟后自动继续；当前进度已保留。`);
        if (sleepFn) await sleepFn(delayMs);
        else await sleep(delayMs, signal);
        throwIfAborted(signal);
        waitedMs += delayMs;
      }
    }
  };
}

function existingCommunicationReservation(db, { site, details, nowMs, policy }) {
  const batchId = Number(details?.batchId);
  const itemId = Number(details?.itemId);
  if (!Number.isInteger(batchId) || batchId <= 0 || !Number.isInteger(itemId) || itemId <= 0) return null;
  const windowMs = Number(policy.windowsMs?.["24h"] || 24 * 60 * 60_000);
  return db.prepare(`SELECT id, created_at FROM events
    WHERE event_type = 'site_access'
      AND created_at > ?
      AND json_extract(payload_json, '$.site') = ?
      AND json_extract(payload_json, '$.action') = 'communication_visit'
      AND json_extract(payload_json, '$.batchId') = ?
      AND json_extract(payload_json, '$.itemId') = ?
    ORDER BY created_at DESC, id DESC LIMIT 1`)
    .get(new Date(nowMs - windowMs).toISOString(), String(site), batchId, itemId) || null;
}

function resolveAccessMode(db, { site, nowMs, policy = DEFAULT_POLICY }) {
  const lookbackMs = (policy.recoveryHours + 24) * 60 * 60_000;
  const risks = listSiteAccessEvents(db, {
    site,
    action: "risk_control",
    since: new Date(nowMs - lookbackMs).toISOString(),
    limit: 100
  });
  const latest = risks.at(-1);
  if (!latest) return "normal";
  const riskAt = Date.parse(latest.createdAt);
  const blockedUntil = Date.parse(latest.details.blockedUntil || "");
  const anchor = Math.max(Number.isFinite(riskAt) ? riskAt : 0, Number.isFinite(blockedUntil) ? blockedUntil : 0);
  return nowMs < anchor + policy.recoveryHours * 60 * 60_000 ? "recovery" : "normal";
}

function readUsage(db, { site, action, nowMs, policy = DEFAULT_POLICY }) {
  const starts = Object.fromEntries(Object.entries(policy.windowsMs).map(([window, windowMs]) => [
    window,
    window === "24h" ? chinaDayStartMs(nowMs) : nowMs - windowMs
  ]));
  const events = listSiteAccessEvents(db, {
    site,
    since: new Date(Math.min(...Object.values(starts))).toISOString()
  });
  return Object.fromEntries(Object.entries(policy.windowsMs).map(([window]) => {
    const afterStart = window === "24h"
      ? (eventMs) => eventMs >= starts[window]
      : (eventMs) => eventMs > starts[window];
    return [
      window,
      events.filter((event) => {
        const eventMs = Date.parse(event.createdAt);
        return actionsForWindow(action, window, policy).includes(event.action)
          && afterStart(eventMs)
          && eventMs <= nowMs;
      }).length
    ];
  }));
}

function nextAvailableAt(db, { site, action, window, nowMs, policy = DEFAULT_POLICY }) {
  if (window === "24h") return chinaDayStartMs(nowMs) + DAY_MS;
  const windowMs = policy.windowsMs[window];
  const events = listSiteAccessEvents(db, {
    site,
    since: new Date(nowMs - windowMs).toISOString()
  }).filter((event) => actionsForWindow(action, window, policy).includes(event.action)
    && Date.parse(event.createdAt) > nowMs - windowMs);
  const oldestMs = Date.parse(events[0]?.createdAt || "");
  return (Number.isFinite(oldestMs) ? oldestMs : nowMs) + windowMs;
}

function chinaDayStartMs(value) {
  const nowMs = Number(value);
  if (!Number.isFinite(nowMs)) throw new Error("访问预算时间无效。");
  return Math.floor((nowMs + CHINA_OFFSET_MS) / DAY_MS) * DAY_MS - CHINA_OFFSET_MS;
}

function actionsForWindow(action, window, policy) {
  if (action !== "communication_visit") return [action];
  return policy.combinedUsage?.[window] || [action];
}

function accessBudgetError({ site, action, mode, window, limit, retryAtMs, usage }) {
  const label = action === "communication_visit"
    ? "岗位沟通"
    : { pane_detail_read: "右栏详情", detail_open: "岗位详情", list_navigation: "搜索页", list_scroll: "列表滚动" }[action] || action;
  const retryAt = new Date(retryAtMs).toISOString();
  const period = window === "24h" ? "今日" : `过去 ${window}`;
  const error = new Error(`${site.toUpperCase()} ${period}的${label}访问已达到安全额度 ${limit} 次；未完成岗位已保留，请在 ${retryAt} 后恢复批次。`);
  error.code = "BOSS_ACCESS_BUDGET_EXHAUSTED";
  error.site = site;
  error.action = action;
  error.mode = mode;
  error.window = window;
  error.limit = limit;
  error.usage = usage;
  error.retryAt = retryAt;
  return error;
}

function randomBetween(min, max, randomFn) {
  const low = Math.min(Number(min), Number(max));
  const high = Math.max(Number(min), Number(max));
  return Math.round(low + (high - low) * Math.max(0, Math.min(1, Number(randomFn()) || 0)));
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError(signal));
    };
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return Object.assign(new Error("扫描已中止。"), { code: "SCAN_ABORTED" });
}

module.exports = {
  createSiteAccessController,
  resolveAccessMode,
  readUsage,
  chinaDayStartMs
};
