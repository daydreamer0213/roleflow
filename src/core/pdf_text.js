const DEFAULT_TIMEOUT_MS = 30_000;

function timeoutError(code, timeoutMs) {
  const error = new Error(`${code} after ${timeoutMs}ms`);
  error.code = code;
  return error;
}

async function withTimeout(promise, timeoutMs, code) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeoutError(code, timeoutMs)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function defaultLoadDocument(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjs.getDocument({
    data: new Uint8Array(buffer),
    disableWorker: true,
    useSystemFonts: true
  });
}

function orderPageTextItems(items) {
  const positioned = (Array.isArray(items) ? items : [])
    .map((item, index) => ({
      str: typeof item?.str === "string" ? item.str.trim() : "",
      x: item?.transform?.[4],
      y: item?.transform?.[5],
      height: Number(item?.height) > 0 ? Number(item.height) : Math.abs(Number(item?.transform?.[3])),
      width: Number(item?.width) >= 0 ? Number(item.width) : 0,
      index
    }))
    .filter((item) => item.str && Number.isFinite(item.x) && Number.isFinite(item.y));
  if (!positioned.length) return "";

  const heights = positioned.map((item) => item.height).filter((height) => Number.isFinite(height) && height > 0).sort((a, b) => a - b);
  const medianHeight = heights.length
    ? (heights[Math.floor((heights.length - 1) / 2)] + heights[Math.ceil((heights.length - 1) / 2)]) / 2
    : 12;
  const lineTolerance = Math.max(2, Math.min(8, medianHeight / 2));
  positioned.sort((a, b) => b.y - a.y || a.x - b.x || a.index - b.index);

  const lines = [];
  for (const item of positioned) {
    const line = lines.at(-1);
    if (!line || Math.abs(line.y - item.y) > lineTolerance) {
      lines.push({ y: item.y, items: [item] });
    } else {
      line.items.push(item);
    }
  }

  return lines.map(({ items: lineItems }) => {
    lineItems.sort((a, b) => a.x - b.x || a.index - b.index);
    let line = "";
    let previous;
    for (const item of lineItems) {
      if (previous) {
        const gap = item.x - (previous.x + previous.width);
        if (gap > Math.max(2, medianHeight / 4)) line += " ";
      }
      line += item.str;
      previous = item;
    }
    return line;
  }).join("\n");
}

async function extractPdfTextInReadingOrder(
  buffer,
  { loadDocument = defaultLoadDocument, timeoutMs = DEFAULT_TIMEOUT_MS } = {}
) {
  const loadingTask = await loadDocument(buffer);
  let document;
  try {
    document = await withTimeout(loadingTask.promise, timeoutMs, "RESUME_PDF_TIMEOUT");
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        const content = await withTimeout(page.getTextContent(), timeoutMs, "RESUME_PDF_TIMEOUT");
        pages.push(orderPageTextItems(content.items));
      } finally {
        if (typeof page.cleanup === "function") page.cleanup();
      }
    }
    return pages.filter(Boolean).join("\n\n");
  } finally {
    if (typeof loadingTask?.destroy === "function") await loadingTask.destroy();
    else if (typeof document?.destroy === "function") await document.destroy();
  }
}

module.exports = { extractPdfTextInReadingOrder, orderPageTextItems };
