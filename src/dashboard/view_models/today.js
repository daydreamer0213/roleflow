const { formatNativeFilterSummary } = require("../../core/platform_filters");
const { feedbackReasonLabel } = require("../../core/feedback");
const { PRODUCT_POLICY } = require("../../core/product_policy");
const { acquisitionModeOf, generatedPlatformOf } = require("../../core/search_plan_schema");

function buildTodayViewModel(input = {}) {
  const profile = input.profile || {};
  const planRecord = input.planRecord || {};
  const plan = input.plan || {};
  const workflow = input.workflowState || {};
  const dependency = input.planDependency || {};
  const validation = input.validation || { valid: false, errors: [], warnings: [] };
  const activeRun = workflow.activeRun || null;
  const nextPlan = workflow.nextPlan || null;
  const runtimeBlock = input.bossRuntimeBlock || null;
  const scanBlocked = input.run?.state === "running" || !validation.valid || dependency.stale || dependency.matchingCardRequired || Boolean(runtimeBlock);
  const startBlocked = !validation.valid || dependency.stale || dependency.matchingCardRequired || Boolean(runtimeBlock)
    || Boolean(nextPlan?.scanNeeded && input.run?.state === "running");
  const profileId = Number(profile.id || planRecord.profileId || 0);
  const planId = Number(planRecord.id || 0);
  const candidate = profile.profile?.candidate || {};
  const remainingBudget = workflow.remainingBudget || { details: 0, pages: 0 };
  const mode = acquisitionModeOf(plan);
  const generated = generatedPlatformOf(plan);
  const activePlanner = activeRun?.planner || null;
  const runtime = input.runtime || {};
  const browserMode = String(runtime.browserMode || input.browserAuthority?.browserMode || "edge").trim().toLowerCase() === "portable"
    ? "portable"
    : "edge";
  const cdpPort = browserMode === "portable" ? 9222 : null;
  const acquisition = {
    mode,
    generated,
    inheritedPreview: {
      status: "idle",
      summary: "读取当前 BOSS 搜索页后显示",
      ...(input.inheritedPreview || {}),
      endpoint: `/api/acquisition-preview?planId=${encodeURIComponent(planId)}`
    },
    activeSnapshot: activePlanner ? {
      mode: activePlanner.acquisitionMode,
      planHash: activePlanner.planHash || "",
      summary: acquisitionSummary(activePlanner)
    } : null
  };

  return {
    page: { title: "今日任务", profileId, planId, todayPath: `/plan?profileId=${profileId}&planId=${planId}` },
    heading: {
      eyebrow: "今日工作台",
      title: "今天先把高质量机会推进到人工确认。",
      lede: "RoleFlow 会保留完整 JD 与匹配证据；只有你确认清单后才会进入沟通。",
      meta: [`本地筛选方案 #${planId}`, plan.name || "未命名方案"],
      status: dependency.stale || dependency.matchingCardRequired ? "方案待确认" : "方案可用"
    },
    primary: buildPrimaryAction({ activeRun, nextPlan, dependency, runtimeBlock, profileId, planId, startBlocked }),
    metrics: {
      successfulToday: Number(workflow.successfulToday || 0),
      dailyTarget: Number(workflow.dailyTarget || 0),
      inventoryCount: Array.isArray(workflow.inventory) ? workflow.inventory.length : Number(workflow.inventoryCount || 0),
      remainingDetails: Number(remainingBudget.details || 0),
      slotsUsed: Number(workflow.slotsUsed || 0),
      maxRuns: Number(workflow.maxRuns || 0),
      targetSuccessCount: Number(activeRun?.targetSuccessCount ?? nextPlan?.targetSuccessCount ?? 0),
      remainingPages: Number(remainingBudget.pages || 0)
    },
    blockers: buildBlockers({
      dependency,
      runtimeBlock,
      validation,
      profileId
    }),
    confirmation: String(input.confirmation || ""),
    run: {
      state: String(input.run?.state || "idle"),
      label: scanLabel(input.run, plan.bossActiveDays),
      error: String(input.run?.error || "")
    },
    scan: {
      disabled: Boolean(scanBlocked),
      resumableBatchId: input.resumableBatch?.id || null,
      daily: input.dailyScan || {},
      broad: input.broadScan || {},
      dailyBCardLimit: Number(input.dailyBCardLimit || 0)
    },
    form: {
      plan,
      acquisition,
      validation: { valid: Boolean(validation.valid), errors: [...(validation.errors || [])], warnings: [...(validation.warnings || [])] },
      options: { ...(input.options || {}), platformSalaryLanes: [...(input.bossSalaryOptions || [])] },
      selectedBossSalaryLanes: [...(input.selectedBossSalaryLanes || [])],
      scanBounds: input.scanBounds || {},
      scanDefaults: input.scanDefaults || {}
    },
    profile: {
      id: profileId,
      name: profile.displayName || candidate.name || "候选人待确认",
      city: candidate.city || "目标城市待确认",
      targetTitles: [...(candidate.targetTitles || [])],
      skills: (profile.profile?.skills || []).map((item) => item?.name || item).filter(Boolean),
      projects: (profile.profile?.projects || []).map((item) => item?.name || item).filter(Boolean),
      versionDiff: buildVersionDiff(input.versionDiff),
      feedback: buildFeedback(input.feedback),
      bossFilter: buildBossFilter(input.bossFilterPreview, input.bossCatalog),
      matchingCard: {
        summary: input.matchingContext?.matchingCard ? "已确认，将用于 JD 证据匹配" : "尚未确认",
        href: `/match-card?profileId=${profileId}`
      }
    },
    runtime: {
      workflowStartDisabled: Boolean(startBlocked),
      browserMode,
      cdpPort,
      browserLabel: browserMode === "portable"
        ? "RoleFlow 专用 Edge（推荐）"
        : "使用当前 Edge（高级，需要浏览器连接组件）"
    }
  };
}

function buildPrimaryAction({ activeRun, nextPlan, dependency, runtimeBlock, profileId, planId, startBlocked }) {
  if (activeRun) return { type: "link", label: "继续本轮", href: `/workflow?runId=${encodeURIComponent(activeRun.id)}`, status: workflowStatusLabel(activeRun.status), detail: "继续查看本轮进度和已完成岗位。" };
  if (dependency.matchingCardRequired) return { type: "link", label: "确认匹配偏好卡", href: `/match-card?profileId=${profileId}${dependency.draftCardId ? `&cardId=${dependency.draftCardId}` : ""}`, status: "扫描前需要确认", detail: "确认当前草稿后，才会启用扫描和岗位匹配。" };
  if (dependency.stale) return { type: "link", label: "重新确认筛选条件", href: `/plan?profileId=${profileId}&planId=${planId}#plan-settings`, status: "方案需要重新确认", detail: "画像已更新；保存现有条件即可重新绑定，不会覆盖人工设置。" };
  if (runtimeBlock) return { type: "link", label: "查看恢复说明", href: "/diagnostics", status: "BOSS 安全暂停中", detail: `已采集的数据安全保留。${runtimeBlock.blockedUntil ? `恢复时间 ${runtimeBlock.blockedUntil}` : "请等待风控恢复。"}` };
  if (nextPlan?.errorCode === "WORKFLOW_SCAN_INTERVAL") return {
    type: "cooldown_override",
    label: "提前开始下一轮",
    status: nextPlan.nextRunAt
      ? `建议等待至 ${new Date(nextPlan.nextRunAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`
      : "建议稍后再开始下一轮",
    detail: "如果本轮结果不足，可以提前开始。"
  };
  if (nextPlan?.errorCode) return { type: "notice", label: "今日任务暂不能继续", status: workflowBlockedMessage(nextPlan.errorCode, nextPlan), detail: workflowShortfallLabel(nextPlan.shortfallReason || nextPlan.errorCode) };
  return { type: "form", label: "开始一轮岗位发现", status: startBlocked ? "等待前置条件恢复" : "可以开始新一轮", detail: "使用已保存条件发现一批岗位。", disabled: Boolean(startBlocked) };
}

function buildBlockers({ dependency, runtimeBlock, validation, nextPlan, profileId }) {
  const blockers = [];
  if (dependency.stale) blockers.push({ tone: "danger", title: "方案需要重新确认", detail: "画像已更新，当前方案仍基于旧画像。保存一次即可重新绑定，人工条件不会被覆盖。", action: { label: "调整筛选条件", href: "#plan-settings" } });
  if (dependency.matchingCardRequired) blockers.push({ tone: "danger", title: "尚未确认匹配偏好卡", detail: "扫描和岗位匹配只会使用已确认的偏好卡。", action: { label: "检查匹配偏好卡", href: `/match-card?profileId=${profileId}${dependency.draftCardId ? `&cardId=${dependency.draftCardId}` : ""}` } });
  if (runtimeBlock) blockers.push({ tone: "danger", title: "BOSS 扫描因安全验证暂停", detail: `限制到期前不会创建扫描进程；此前已采集的岗位和详情不会丢失。${runtimeBlock.reasonCode ? ` ${runtimeBlock.reasonCode}` : ""}`, action: { label: "查看诊断", href: "/diagnostics" } });
  for (const error of validation.errors || []) blockers.push({ tone: "waiting", title: "扫描前需要修正", detail: String(error), action: { label: "调整筛选条件", href: "#plan-settings" } });
  return blockers;
}

function buildVersionDiff(diff = {}) {
  if (!diff.current) return null;
  return { current: `${diff.current.fileName || "当前简历"} · ${String(diff.current.createdAt || "").slice(0, 10)}`, changes: (diff.changes || []).map((change) => ({ label: String(change.label || ""), before: String(change.before || ""), after: String(change.after || ""), added: [...(change.added || [])], removed: [...(change.removed || [])] })) };
}

function buildFeedback(feedback = {}) {
  const reasons = Object.entries(feedback.reasonCounts || {}).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([reason, count]) => `${feedbackReasonLabel(reason)} ${count} 次`);
  const keywords = Object.entries(feedback.keywordReasons || {}).map(([keyword, entries]) => [keyword, Object.values(entries).reduce((sum, count) => sum + count, 0)]).filter(([, count]) => count >= 2).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([keyword, count]) => `${keyword}（反馈 ${count}）`);
  return { reasons, keywords };
}

function buildBossFilter(snapshot, catalog) {
  if (!catalog) return { known: false, summary: "BOSS 站内预筛条件会在首次扫描时自动预读，之后按本方案的薪资与经验条件组装 URL。" };
  return { known: true, summary: formatNativeFilterSummary(snapshot) || "未命中可用的 BOSS 预筛档位", discoveredAt: String(catalog.discoveredAt || "").replace("T", " ").slice(0, 16) };
}

function acquisitionSummary(planner = {}) {
  if (planner.acquisitionMode === "generated") {
    const cities = (planner.cityScopes || []).map((item) => item.city || item.cityCode).filter(Boolean);
    const filters = Object.values(planner.nativeFilters?.labels || {}).flat();
    return ["通用模式", ...cities, ...filters].join(" · ");
  }
  const filters = (planner.platformPolicy?.filterSummary || []).filter(Boolean);
  return ["继承模式", ...filters].join(" · ");
}

function scanLabel(run = {}, bossActiveDays = PRODUCT_POLICY.searchPlan.defaultBossActiveDays) {
  if (run.state === "running" && run.kind === "daily") return "正在执行日常扫描";
  if (run.state === "completed" && run.kind === "daily") return "日常扫描已完成";
  if (run.state === "running" && run.kind === "broad") return "正在执行广泛扫描";
  if (run.state === "completed" && run.kind === "broad") return "广泛扫描已完成";
  if (run.state === "running" && run.kind === "refresh") return "正在补读待刷新岗位";
  if (run.state === "completed" && run.kind === "refresh") return "待刷新岗位补读完成";
  if (run.state === "running" && run.kind === "activity") return `正在更新超过 ${bossActiveDays} 天有效期的招聘方活跃状态`;
  if (run.state === "completed" && run.kind === "activity") return "招聘方活跃状态更新完成";
  return {
    idle: "尚未运行",
    running: "扫描中",
    completed: "本次扫描已完成",
    partial: "本次扫描部分完成，可查看诊断后继续",
    failed: "扫描失败，请查看错误",
    interrupted: "扫描已中断，可重新启动"
  }[run.state] || "尚未运行";
}

function workflowStatusLabel(status) {
  return { created: "本轮已建立", scanning: "正在筛选岗位", analyzing: "正在分析岗位", paused: "本轮已暂停", review_required: "等待确认本轮清单", communicating: "正在沟通", interrupted: "本轮已中断，等待继续", completed: "本轮已完成", failed: "本轮未完成", stopped: "本轮已停止" }[status] || "本轮进行中";
}

function workflowShortfallLabel(code) {
  return { WORKFLOW_PROJECTED_SUPPLY_SHORTFALL: "预计候选可能不足，不会用明显弱岗位凑数", WORKFLOW_SCAN_BUDGET_EMPTY: "今日安全预算不足", WORKFLOW_NO_KEYWORDS: "没有可用搜索关键词" }[code] || "候选可能不足";
}

function workflowBlockedMessage(code, plan = {}) {
  return { WORKFLOW_DAILY_RUN_LIMIT: "今天的三轮任务都已创建。", WORKFLOW_DAILY_TARGET_REACHED: "今天的目标已完成，无需再创建新一轮。", WORKFLOW_THIRD_SCAN_NOT_NEEDED: "当前候选库存已足够，不需要追加第三轮扫描。", WORKFLOW_SCAN_INTERVAL: plan.nextRunAt ? `两轮扫描至少间隔 2 小时，下次可在 ${new Date(plan.nextRunAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} 开始。` : "两轮扫描至少间隔 2 小时。" }[code] || "当前不能创建新一轮。";
}

module.exports = { buildTodayViewModel, acquisitionSummary, workflowStatusLabel, workflowShortfallLabel, scanLabel };
