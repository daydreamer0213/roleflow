function isBrowserTabId(value) {
  return (Number.isInteger(value) && value > 0)
    || (typeof value === "string" && value.trim().length > 0);
}

function sameBrowserTabId(left, right) {
  return isBrowserTabId(left) && isBrowserTabId(right)
    && typeof left === typeof right && left === right;
}

function sortedBrowserTabIds(values = []) {
  return [...values].filter(isBrowserTabId).sort((left, right) => {
    if (typeof left !== typeof right) return typeof left === "number" ? -1 : 1;
    if (typeof left === "number") return left - right;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

module.exports = { isBrowserTabId, sameBrowserTabId, sortedBrowserTabIds };
