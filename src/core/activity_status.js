function parseBossActivityText(text) {
  const value = String(text || "");
  if (/(?:^|\s)在线(?:\s|$)|刚刚活跃|今日活跃|今天活跃/.test(value)) return "今日活跃";
  const readable = value.match(/昨日活跃|昨天活跃|近半年活跃|半年内活跃|近(?:\d+|一|二|三|四|五|六|七|八|九|十)个?月活跃|\d+\s*(?:日|周|月|年)内活跃|本周活跃|本月活跃/);
  return readable ? readable[0].replace(/\s+/g, "") : "";
}

module.exports = { parseBossActivityText };
