const store = require("../storage/communication_store");

function communicationAmbiguityState(summary = {}, items = []) {
  const rawSummaryCount = Number(summary?.statusCounts?.ambiguous ?? 0);
  const summaryCount = Number.isInteger(rawSummaryCount) && rawSummaryCount >= 0 ? rawSummaryCount : 0;
  const itemList = Array.isArray(items) ? items : [];
  const ambiguousItems = itemList.filter((item) => item?.status === "ambiguous");
  const itemsCount = ambiguousItems.length;
  const countsMismatch = !Number.isInteger(rawSummaryCount)
    || rawSummaryCount < 0
    || !Array.isArray(items)
    || summaryCount !== itemsCount;
  return {
    blocked: summaryCount > 0 || itemsCount > 0 || countsMismatch,
    summaryCount,
    itemsCount,
    countsMismatch,
    firstItemId: ambiguousItems[0]?.id ?? null
  };
}

function communicationAmbiguityStateForBatch(db, batchId) {
  db.exec("BEGIN");
  try {
    const summary = store.communicationBatchSummary(db, batchId);
    const items = store.listCommunicationBatchItems(db, batchId);
    const state = communicationAmbiguityState(summary, items);
    db.exec("COMMIT");
    return state;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

module.exports = {
  ...store,
  communicationAmbiguityState,
  communicationAmbiguityStateForBatch
};
