const assert = require("node:assert");
const path = require("node:path");
const { parseResumeUpload } = require("../src/core/resume_parser");
const { orderPageTextItems } = require("../src/core/pdf_text");

const root = path.resolve(__dirname, "..");

async function main() {
  testPageItemOrdering();

  const expectedOrder = [
    "Sanitized Candidate",
    "Summary",
    "Skills",
    "Experience",
    "Example Company",
    "Project",
    "Project Alpha",
    "Alpha body",
    "Project Beta",
    "Beta body",
    "Education",
    "Certificate"
  ];

  const parsed = await parseResumeUpload({
    fileName: "sanitized-platform-resume.pdf",
    buffer: makeTwoPageOutOfOrderPdf(),
    root
  });

  let cursor = -1;
  for (const marker of expectedOrder) {
    const next = parsed.text.indexOf(marker);
    assert(next > cursor, `${marker} 必须按视觉顺序出现`);
    cursor = next;
  }
  assert.strictEqual(parsed.diagnostics.extractionMethod, "pdf_text_ordered");
  assert.strictEqual(parsed.textTruncated, false);
  console.log("resume_parser_pdf_order_smoke ok");
}

function testPageItemOrdering() {
  assert.strictEqual(orderPageTextItems([
    pageItem("Right", 160, 700, 12, 30),
    pageItem("Left", 72, 700, 12, 20)
  ]), "Left Right");

  assert.strictEqual(orderPageTextItems([
    pageItem("Second", 100, 698.5, 1, 35),
    pageItem("First", 72, 700, 1, 20)
  ]), "First Second");

  assert.strictEqual(orderPageTextItems([
    pageItem("Lower", 72, 691, 40, 30),
    pageItem("Upper", 72, 700, 40, 30)
  ]), "Upper\nLower");

  assert.strictEqual(orderPageTextItems([
    pageItem("Gamma", 150, 700, 12, 40),
    pageItem("Beta", 102, 700, 12, 24),
    pageItem("Alpha", 72, 700, 12, 30)
  ]), "AlphaBeta Gamma");
}

function pageItem(str, x, y, height, width) {
  return { str, transform: [1, 0, 0, height, x, y], height, width };
}

function makeTwoPageOutOfOrderPdf() {
  const pageOne = [
    textAt("Example Company", 72, 520),
    textAt("Sanitized Candidate", 72, 700),
    textAt("Experience", 72, 560),
    textAt("Skills", 72, 600),
    textAt("Summary", 72, 640)
  ].join("\n");
  const pageTwo = [
    textAt("Education", 72, 500),
    textAt("Project Beta", 72, 580),
    textAt("Alpha body", 72, 620),
    textAt("Project Alpha", 72, 660),
    textAt("Beta body", 72, 540),
    textAt("Certificate", 72, 460),
    textAt("Project", 72, 700)
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>",
    streamObject(pageOne),
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
    streamObject(pageTwo),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(output, "ascii"));
    output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output, "ascii");
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, "ascii");
}

function textAt(text, x, y) {
  return `BT /F1 12 Tf 1 0 0 1 ${x} ${y} Tm (${text}) Tj ET`;
}

function streamObject(content) {
  return `<< /Length ${Buffer.byteLength(content, "ascii")} >>\nstream\n${content}\nendstream`;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
