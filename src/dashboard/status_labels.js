"use strict";

const COMMUNICATION_STATUS_LABELS = Object.freeze({
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
  transport_failed: "传输失败",
  confirmed: "等待确认",
  running: "执行中",
  stopping: "正在停止",
  paused: "已暂停",
  interrupted: "等待处理",
  completed: "已完成",
  failed: "未完成"
});

function communicationStatusLabel(value) {
  return COMMUNICATION_STATUS_LABELS[String(value || "")] || "状态待确认";
}

module.exports = { communicationStatusLabel };
