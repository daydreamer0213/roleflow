const fs = require("node:fs");
const path = require("node:path");

const ALLOWED_EXTENSIONS = new Set([".txt", ".md", ".docx", ".pdf"]);

function storeResumeSourceFile({ root, documentId, fileName, buffer }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return "";
  const id = Number(documentId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("resume document id is required");
  const requested = path.extname(String(fileName || "")).toLowerCase();
  const extension = ALLOWED_EXTENSIONS.has(requested) ? requested : ".bin";
  const directory = path.join(root, ".runtime", "resumes");
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `${id}${extension}`);
  fs.writeFileSync(target, buffer);
  return path.relative(root, target);
}

function resolveResumeSourceFile(root, storedPath) {
  const base = path.resolve(root, ".runtime", "resumes");
  const target = path.resolve(root, String(storedPath || ""));
  if (target !== base && !target.startsWith(base + path.sep)) return "";
  return fs.existsSync(target) && fs.statSync(target).isFile() ? target : "";
}

module.exports = { storeResumeSourceFile, resolveResumeSourceFile };
