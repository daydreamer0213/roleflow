const BOSS_DETAIL_ACCESS_ACTIONS = new Set([
  "pane_detail_read",
  "detail_open"
]);

function isBossDetailAccessAction(action) {
  return BOSS_DETAIL_ACCESS_ACTIONS.has(String(action || ""));
}

module.exports = {
  isBossDetailAccessAction
};
