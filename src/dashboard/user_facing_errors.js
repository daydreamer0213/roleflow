"use strict";

const ERROR_GUIDANCE = Object.freeze({
  INTERNAL_ERROR: {
    title: "操作没有完成",
    impact: "当前进度已保留，RoleFlow 不会自动执行下一步。",
    nextAction: "返回当前页面查看状态；若再次发生，请复制技术信息到运行诊断。"
  },
  SCAN_CHECKPOINT_FAILED: {
    title: "采集进度没有继续保存",
    impact: "已经保存的岗位仍然保留，本轮已停止继续读取。",
    nextAction: "返回本轮检查状态；确认页面正常后再继续。"
  },
  BOSS_SEARCH_SCOPE_CHANGED: {
    title: "搜索条件已经变化",
    impact: "本轮已停止，旧结果不会与新结果混合。",
    nextAction: "选择按新条件重新开始本轮，或继续开始时的条件。"
  },
  BROWSER_TIMEOUT: {
    title: "BOSS 页面响应较慢",
    impact: "本次检查已经停止，RoleFlow 不会在后台自动重试。",
    nextAction: "等 BOSS 页面加载完成后，回到这里重新检查。"
  },
  BOSS_WORKSPACE_NOT_READY: {
    title: "BOSS 页面还没有准备好",
    impact: "需要浏览器的操作没有开始，当前本地进度不受影响。",
    nextAction: "检查固定的搜索页和消息页，再重新检查 BOSS 工作区。"
  },
  MODEL_CONFIGURATION_REQUIRED: {
    title: "批量筛选模型还没有准备好",
    impact: "本轮没有继续分析，已保存进度仍然保留。",
    nextAction: "前往“模型与设置”完成连接测试后再继续。"
  },
  BOSS_LOGIN_REQUIRED: {
    title: "BOSS 登录已经失效",
    impact: "RoleFlow 已停止访问页面，当前进度仍然保留。",
    nextAction: "在固定 BOSS 页面重新登录，然后回到这里继续。"
  },
  BOSS_RISK_CONTROL: {
    title: "BOSS 要求安全验证",
    impact: "RoleFlow 已立即停止页面访问，不会自动重试。",
    nextAction: "请先人工完成安全验证，再重新检查工作区。"
  }
});

function userFacingError(code, technicalMessage = "") {
  const normalizedCode = String(code || "INTERNAL_ERROR").trim() || "INTERNAL_ERROR";
  const known = ERROR_GUIDANCE[normalizedCode];
  if (known) return { code: normalizedCode, ...known, technicalMessage: String(technicalMessage || "") };
  const readable = String(technicalMessage || "").trim();
  return {
    code: normalizedCode,
    title: "操作没有完成",
    impact: /[\u3400-\u9fff]/.test(readable)
      ? readable
      : "当前进度已保留，RoleFlow 不会自动执行下一步。",
    nextAction: "返回本轮查看状态；若再次发生，请复制技术信息到运行诊断。",
    technicalMessage: readable
  };
}

module.exports = { userFacingError };
