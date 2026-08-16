const { assertCompleteInheritedContext } = require("./inherited_search_scope");
const {
  buildScanExecutionSnapshot,
  assertScanSnapshotCompatible
} = require("./scan_snapshot");
const { resolveProductDetailMode } = require("./scan_execution");

const RESUMABLE_BATCH_STATUSES = new Set(["partial", "failed", "interrupted"]);

function validateResumeBatch({
  resumeBatchId,
  resumedBatch,
  site,
  planId
} = {}) {
  const normalizedBatchId = Number(resumeBatchId || resumedBatch?.id || 0);
  const normalizedSite = String(site || "").trim().toLowerCase();
  const normalizedPlanId = Number(planId || 0);
  if (!resumedBatch) {
    throw resumeError("SCAN_RESUME_BATCH_NOT_FOUND", `恢复批次 #${normalizedBatchId} 不存在。`);
  }
  if (resumedBatch.site !== normalizedSite || resumedBatch.searchPlanId !== normalizedPlanId) {
    throw resumeError(
      "SCAN_RESUME_BATCH_MISMATCH",
      `批次 #${normalizedBatchId} 不属于当前站点和 Search Plan。`
    );
  }
  if (!RESUMABLE_BATCH_STATUSES.has(resumedBatch.status)) {
    throw resumeError(
      "SCAN_RESUME_STATUS_INVALID",
      `批次 #${normalizedBatchId} 当前状态为 ${resumedBatch.status}，不能恢复。`
    );
  }
  const storedSnapshot = resumedBatch.filterSnapshot?.execution;
  if (!storedSnapshot) {
    throw resumeError(
      "SCAN_RESUME_SNAPSHOT_MISSING",
      `批次 #${normalizedBatchId} 没有执行快照，无法安全恢复。`
    );
  }
  try {
    assertScanSnapshotCompatible(storedSnapshot, storedSnapshot);
    resolveProductDetailMode(storedSnapshot.detailMode);
    if (storedSnapshot.site !== normalizedSite) {
      throw resumeError(
        "SCAN_RESUME_BATCH_MISMATCH",
        `批次 #${normalizedBatchId} 的执行快照不属于当前站点。`
      );
    }
    const acquisitionMode = String(storedSnapshot.searchTemplate?.mode || "").trim();
    if (!["generated", "inherited"].includes(acquisitionMode)) {
      throw resumeError(
        "SCAN_RESUME_ACQUISITION_MODE_INVALID",
        `批次 #${normalizedBatchId} 的采集模式无效。`
      );
    }
    if (acquisitionMode === "inherited") {
      assertCompleteInheritedContext(storedSnapshot, {
        code: "SCAN_RESUME_INHERITED_SNAPSHOT_INVALID",
        message: `批次 #${normalizedBatchId} 的继承模式快照不完整，无法安全恢复。`,
        planId: normalizedPlanId
      });
    }
    assertScanSnapshotCompatible(
      storedSnapshot,
      buildScanExecutionSnapshot(storedSnapshot)
    );
    return {
      resumeBatchId: normalizedBatchId,
      resumedBatch,
      storedSnapshot,
      acquisitionMode,
      runtime: optionalRuntimeSnapshot(resumedBatch.filterSnapshot?.runtime)
    };
  } catch (error) {
    if (!error.statusCode) error.statusCode = 409;
    throw error;
  }
}

function optionalRuntimeSnapshot(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function resumeError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 409;
  return error;
}

module.exports = {
  validateResumeBatch
};
