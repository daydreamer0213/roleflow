const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { PDFParse } = require("pdf-parse");
const { appError } = require("./observability");

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_RESUME_CHARS = 60000;
const TEXT_EXTENSIONS = new Set([".txt", ".md"]);
const SUPPORTED_EXTENSIONS = new Set([...TEXT_EXTENSIONS, ".docx", ".pdf"]);

async function parseResumeUpload({ fileName, buffer, root }) {
  const name = safeFileName(fileName);
  const extension = path.extname(name).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) throw appError("RESUME_UNSUPPORTED_FORMAT", "仅支持 TXT、MD、DOCX、PDF 简历文件。", { details: { extension } });
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw appError("RESUME_EMPTY_FILE", "简历文件为空。");
  if (buffer.length > MAX_UPLOAD_BYTES) throw appError("RESUME_FILE_TOO_LARGE", "简历文件不能超过 5MB。", { details: { bytes: buffer.length } });

  let text = "";
  let extractionMethod = "";
  let ocr = { status: "not_required", available: false };
  if (TEXT_EXTENSIONS.has(extension)) {
    const decoded = decodeText(buffer);
    text = decoded.text;
    extractionMethod = decoded.method;
  }
  if (extension === ".docx") {
    extractionMethod = "docx_powershell";
    try {
      text = extractDocxText(buffer, name, root);
    } catch (error) {
      throw appError("RESUME_DOCX_PARSE_FAILED", "DOCX 无法读取，请重新导出为 DOCX、PDF，或直接粘贴简历文本。", {
        cause: error,
        details: { diagnostics: parseDiagnostics({ buffer, extractionMethod, text: "" }) }
      });
    }
  }
  if (extension === ".pdf") {
    extractionMethod = "pdf_text";
    ocr = localOcrStatus();
    try {
      text = await extractPdfText(buffer);
    } catch (error) {
      throw appError("RESUME_PDF_PARSE_FAILED", "PDF 无法读取或可能是扫描件，请直接粘贴简历文本继续。", {
        cause: error,
        details: { diagnostics: parseDiagnostics({ buffer, extractionMethod, text: "", ocr: { ...ocr, status: "suggested" } }) }
      });
    }
  }

  return createResumeDocument({ name, format: extension.slice(1), text, content: buffer, extractionMethod, ocr });
}

function parseResumeText({ text, fileName = "pasted_resume.txt" } = {}) {
  const name = safeFileName(fileName);
  const raw = String(text || "");
  return createResumeDocument({
    name,
    format: "text",
    text: raw,
    content: Buffer.from(raw, "utf8"),
    extractionMethod: "pasted_text"
  });
}

function createResumeDocument({ name, format, text, content, extractionMethod = "unknown", ocr = { status: "not_required", available: false } }) {
  const normalized = normalizeText(text);
  const diagnostics = parseDiagnostics({
    buffer: content,
    extractionMethod,
    text: normalized.text,
    ocr,
    textTruncated: normalized.truncated
  });
  if (normalized.text.length < 80) {
    const isPdf = format === "pdf";
    throw appError(
      "RESUME_TEXT_TOO_SHORT",
      isPdf
        ? "PDF 只提取到很少文字，可能是扫描件。请直接粘贴简历文本继续。"
        : "未能读到足够的简历文字，请检查文件内容或直接粘贴简历文本。",
      { details: { charCount: normalized.text.length, diagnostics: { ...diagnostics, ocr: isPdf ? { ...ocr, status: "suggested" } : ocr } } }
    );
  }
  if (diagnostics.quality?.status === "poor") {
    throw appError("RESUME_CONTENT_UNUSABLE", "提取结果疑似乱码、重复字符或非简历正文，请换一个文件，或直接粘贴简历文本。", { details: { charCount: normalized.text.length, diagnostics } });
  }
  return {
    originalFileName: name,
    format,
    contentHash: crypto.createHash("sha256").update(content).digest("hex"),
    text: normalized.text,
    textTruncated: normalized.truncated,
    charCount: normalized.text.length,
    diagnostics
  };
}

function parseDiagnostics({ buffer, extractionMethod, text, ocr = { status: "not_required", available: false }, textTruncated = false }) {
  const normalized = String(text || "");
  return {
    inputBytes: Buffer.isBuffer(buffer) ? buffer.length : Buffer.byteLength(normalized, "utf8"),
    extractionMethod,
    charCount: normalized.length,
    preview: normalized.slice(0, 360),
    textTruncated: Boolean(textTruncated),
    quality: assessResumeText(normalized),
    ocr
  };
}

function localOcrStatus() {
  return {
    status: "paste_fallback",
    available: false,
    engine: "",
    message: "项目不自动执行 OCR；扫描件请直接粘贴简历文本。"
  };
}

function assessResumeText(value) {
  const text = String(value || "");
  const compact = text.replace(/\s/g, "");
  const signals = [];
  const sections = [
    ["education", /教育|学校|大学|学院|学历|本科|硕士|博士|education/i],
    ["experience", /工作经历|实习经历|任职|公司|岗位|experience|employment/i],
    ["project", /项目经历|项目名称|项目背景|项目职责|project/i],
    ["skills", /专业技能|技能|技术栈|skill/i],
    ["strengths", /个人优势|自我评价|求职意向|objective|summary/i]
  ].filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  const replacementRatio = (text.match(/�/g) || []).length / Math.max(1, text.length);
  const controlRatio = (text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length / Math.max(1, text.length);
  const uniqueRatio = new Set(compact).size / Math.max(1, compact.length);
  if (replacementRatio > 0.005) signals.push("replacement_characters");
  if (controlRatio > 0.005) signals.push("control_characters");
  if (/(.)\1{19,}/s.test(compact)) signals.push("repeated_characters");
  if (compact.length > 200 && uniqueRatio < 0.04) signals.push("low_character_variety");
  const missingSections = ["education", "experience", "project", "skills"].filter((name) => !sections.includes(name));
  return {
    status: signals.length ? "poor" : sections.length >= 3 ? "good" : "warning",
    signals,
    detectedSections: sections,
    missingSections
  };
}

function extractDocxText(buffer, fileName, root) {
  const tempDir = path.join(root, ".runtime", "resume-parse");
  fs.mkdirSync(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, crypto.randomUUID() + "-" + fileName);
  fs.writeFileSync(tempPath, buffer);
  try {
    const script = path.join(root, "scripts", "extract-docx.ps1");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Path", tempPath], {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true
    });
    if (result.status !== 0) throw new Error((result.stderr || result.stdout || "DOCX parse failed").trim());
    return result.stdout || "";
  } finally {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* temporary upload cleanup */ }
  }
}

async function extractPdfText(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text || "";
  } finally {
    await parser.destroy();
  }
}

function decodeText(buffer) {
  const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
  if (text.includes("�")) return { text: buffer.toString("utf16le").replace(/^\uFEFF/, ""), method: "text_utf16le" };
  return { text, method: "text_utf8" };
}

function normalizeText(value) {
  let text = String(value || "")
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const truncated = text.length > MAX_RESUME_CHARS;
  if (truncated) text = text.slice(0, MAX_RESUME_CHARS);
  return { text, truncated };
}

function safeFileName(value) {
  const name = path.basename(String(value || "resume"));
  return name.replace(/[^\w.\-\u4e00-\u9fff()（） ]/g, "_") || "resume";
}

module.exports = { parseResumeUpload, parseResumeText, normalizeText, assessResumeText, localOcrStatus, MAX_UPLOAD_BYTES, MAX_RESUME_CHARS };
