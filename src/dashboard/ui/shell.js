const { escapeHtml } = require("../http/response");

function renderPage({ title = "", body = "", scripts = [] } = {}) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/assets/roleflow.css"></head><body>${body}${scripts.join("")}</body></html>`;
}

module.exports = { renderPage };
