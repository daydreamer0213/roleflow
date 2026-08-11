const store = require("../storage/communication_store");

function communicationAmbiguityState(summary = {}, items = []) {
  const statusCounts = summary?.statusCounts;
  const hasSummaryCount = statusCounts != null
    && Object.prototype.hasOwnProperty.call(statusCounts, "ambiguous");
  const rawSummaryCount = hasSummaryCount ? statusCounts.ambiguous : 0;
  const validSummaryCount = !hasSummaryCount
    || (typeof rawSummaryCount === "number" && Number.isInteger(rawSummaryCount) && rawSummaryCount >= 0);
  const summaryCount = validSummaryCount ? rawSummaryCount : 0;
  const itemList = Array.isArray(items) ? items : [];
  const ambiguousItems = itemList.filter((item) => item?.status === "ambiguous");
  const itemsCount = ambiguousItems.length;
  const countsMismatch = !validSummaryCount
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
  db.exec("SAVEPOINT communication_ambiguity_read");
  try {
    const summary = store.communicationBatchSummary(db, batchId);
    const items = store.listCommunicationBatchItems(db, batchId);
    const state = communicationAmbiguityState(summary, items);
    db.exec("RELEASE SAVEPOINT communication_ambiguity_read");
    return state;
  } catch (error) {
    try { db.exec("ROLLBACK TO SAVEPOINT communication_ambiguity_read"); } catch {}
    try { db.exec("RELEASE SAVEPOINT communication_ambiguity_read"); } catch {}
    throw error;
  }
}

module.exports = {
  ...store,
  communicationAmbiguityState,
  communicationAmbiguityStateForBatch
};
