const { PRODUCT_POLICY } = require("./product_policy");
const { appError } = require("./observability");

function communicationCalibrationStatus() {
  const calibration = PRODUCT_POLICY.operations.bossCommunication.calibration;
  const status = {
    implementation: calibration.implementation,
    calibration: calibration.status,
    acceptance: calibration.acceptance,
    executionEnabled: calibration.executionEnabled
  };
  Object.defineProperty(status, "status", { value: status.calibration, enumerable: false });
  return status;
}

function assertCommunicationExecutionEnabled() {
  const status = communicationCalibrationStatus();
  if (!status.executionEnabled) {
    throw appError("BOSS_COMMUNICATION_CALIBRATION_REQUIRED", "BOSS communication calibration is required before execution", { statusCode: 409 });
  }
  return status;
}

module.exports = { communicationCalibrationStatus, assertCommunicationExecutionEnabled };
