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
  },
  BOSS_COMMUNICATION_SCOPE_MISMATCH: {
    title: "上次沟通被搜索条件检查拦住",
    impact: "已确认的岗位清单仍然保留。",
    nextAction: "无需恢复旧搜索条件；确认 BOSS 工作区就绪后，点击继续沟通。"
  },
  COMMUNICATION_ACTION_NOT_TRIGGERED: {
    title: "未能确认本次沟通结果",
    impact: "尚未获得可确认的沟通结果，不代表发送失败；系统已停止，不会自动重试。",
    nextAction: "打开沟通明细，先核对该岗位在 BOSS 上的实际结果，再处理剩余岗位。"
  },
  COMMUNICATION_RESULT_AMBIGUOUS: {
    title: "沟通结果需要人工核对",
    impact: "系统已发出操作，但无法确认平台是否接受；这不代表发送失败。",
    nextAction: "在 BOSS 核对对应岗位的结果，再到沟通明细填写处理依据。"
  },
  COMMUNICATION_PROCESS_FAILED: {
    title: "沟通过程意外中断",
    impact: "已保存的岗位结果仍然保留。",
    nextAction: "先查看沟通明细；如有待确认结果，请先核对，再继续剩余岗位。"
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

function communicationStopError(batch = {}) {
  if (!["interrupted", "failed"].includes(batch.status)) return null;
  return userFacingError(batch.stopCode || "COMMUNICATION_PROCESS_FAILED", batch.stopMessage);
}

module.exports = { userFacingError, communicationStopError };
