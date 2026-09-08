const { PRODUCT_POLICY } = require("./product_policy");
const { appError } = require("./observability");

function communicationCalibrationStatus(site = "boss") {
  const normalizedSite = communicationSite(site);
  const calibration = PRODUCT_POLICY.operations[normalizedSite === "zhaopin"
    ? "zhaopinCommunication"
    : "bossCommunication"].calibration;
  const status = {
    implementation: calibration.implementation,
    calibration: calibration.status,
    acceptance: calibration.acceptance,
    executionEnabled: calibration.executionEnabled
  };
  Object.defineProperty(status, "status", { value: status.calibration, enumerable: false });
  return status;
}

function assertCommunicationExecutionEnabled(site = "boss") {
  const normalizedSite = communicationSite(site);
  const status = communicationCalibrationStatus(normalizedSite);
  if (!status.executionEnabled) {
    const zhaopin = normalizedSite === "zhaopin";
    throw appError(
      zhaopin ? "ZHAOPIN_COMMUNICATION_CALIBRATION_REQUIRED" : "BOSS_COMMUNICATION_CALIBRATION_REQUIRED",
      zhaopin ? "智联沟通尚未完成单岗位验收，暂不能执行。" : "BOSS communication calibration is required before execution",
      { statusCode: 409 }
    );
  }
  return status;
}

function communicationSite(value) {
  const site = String(value || "").trim().toLowerCase();
  if (!["boss", "zhaopin"].includes(site)) {
    throw appError("COMMUNICATION_SITE_INVALID", "communication site must be boss or zhaopin", { statusCode: 400 });
  }
  return site;
}

module.exports = { communicationCalibrationStatus, assertCommunicationExecutionEnabled };
