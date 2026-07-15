function extractJobMetadata(value = "") {
  const text = Array.isArray(value) ? value.filter(Boolean).join("\n") : String(value || "");
  const normalized = text.replace(/\s+/g, " ").trim();
  const salary = normalized.match(/\d+\s*[-~—]\s*\d+\s*[kK](?:\s*[·.]\s*\d+\s*薪)?|\d+\s*[kK](?:\s*[·.]\s*\d+\s*薪)?|面议/)?.[0] || "";
  const experience = findExperience(normalized);
  const education = normalized.match(/学历不限|大专(?:及以上)?|本科(?:及以上)?|硕士(?:及以上)?|博士(?:及以上)?/)?.[0] || "";
  return { salary: clean(salary), experience: clean(experience), education: clean(education) };
}

function mergeJobMetadata(job = {}, ...sources) {
  const metadata = extractJobMetadata([
    job.salary,
    job.experience,
    job.education,
    ...(job.tags || []),
    job.cardText,
    ...sources
  ]);
  return {
    salary: clean(job.salary) || metadata.salary,
    experience: clean(job.experience) || metadata.experience,
    education: clean(job.education) || metadata.education
  };
}

function findExperience(text) {
  const strong = text.match(/(?:工作|开发|相关)?经验\s*(?:不限|无|[0-9]+\s*[-~—]\s*[0-9]+\s*年|[0-9]+\s*年以上)|(?:经验不限|无经验|应届(?:生)?|在校生?)/)?.[0];
  if (strong) return strong.replace(/^(?:工作|开发|相关)?经验\s*/, "");
  return text.match(/\b[0-9]+\s*[-~—]\s*[0-9]+\s*年(?:工作|开发|相关)?(?:经验)?|\b[0-9]+\s*年以上(?:工作|开发|相关)?(?:经验)?/)?.[0] || "";
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

module.exports = { extractJobMetadata, mergeJobMetadata };
