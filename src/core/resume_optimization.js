const MAX_SUGGESTIONS = 12;
const SUPPORTED_OPERATIONS = new Set(["replace", "remove", "insert_after"]);
const SUPPORTED_DECISIONS = new Set(["pending", "accepted", "edited", "ignored"]);
const STRONG_ROLE_MARKERS = ["主导", "牵头", "独立负责", "全权负责", "从零搭建", "第一负责人"];

function cleanText(value, maxLength, label, { required = true } = {}) {
  const text = String(value ?? "").trim();
  if (required && !text) throw new Error(`${label}不能为空`);
  if (text.length > maxLength) throw new Error(`${label}过长`);
  return text;
}

function addEvidence(items, prefix, kind, values, toText) {
  for (const value of Array.isArray(values) ? values : []) {
    const text = cleanText(toText(value), 20_000, "证据文字", { required: false });
    if (!text) continue;
    items.push({
      id: `${prefix}${items.filter((item) => item.kind === kind).length + 1}`,
      kind,
      text
    });
  }
}

function buildResumeEvidenceCatalog(input = {}) {
  const items = [];
  const sourceLines = String(input.sourceText ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  addEvidence(items, "R", "resume", sourceLines, (line) => line);
  addEvidence(items, "J", "job", input.jobs, (job = {}) => [job.title, job.company, job.description || job.jdText].filter(Boolean).join("｜"));
  addEvidence(items, "F", "fact", input.facts, (fact = {}) => [fact.key || fact.factKey, fact.value || fact.factValue].filter(Boolean).join("："));
  addEvidence(items, "A", "answer", input.answerMemories, (memory = {}) => [memory.questionClass, memory.finalText || memory.final_text].filter(Boolean).join("："));
  if (input.diagnosis) {
    addEvidence(items, "D", "diagnosis", [input.diagnosis], (diagnosis = {}) => {
      if (typeof diagnosis === "string") return diagnosis;
      return diagnosis.conclusion || diagnosis.summary || JSON.stringify(diagnosis);
    });
  }
  return items;
}

function exactRange(sourceText, originalText) {
  const start = sourceText.indexOf(originalText);
  if (start < 0) throw new Error(`建议原文不存在：${originalText}`);
  if (sourceText.indexOf(originalText, start + originalText.length) >= 0) {
    throw new Error(`建议原文不唯一：${originalText}`);
  }
  return { start, end: start + originalText.length };
}

function numericTokens(text) {
  return String(text ?? "").match(/\d+(?:\.\d+)?%?/g) || [];
}

function validateGrounding(suggestion, evidenceText) {
  const missingNumber = numericTokens(suggestion.proposedText).find((token) => !evidenceText.includes(token));
  if (missingNumber) throw new Error(`建议包含没有证据支持的数字：${missingNumber}`);

  const escalatedMarker = STRONG_ROLE_MARKERS.find((marker) => suggestion.proposedText.includes(marker) && !evidenceText.includes(marker));
  if (escalatedMarker) throw new Error(`建议扩大了候选人的职责边界：${escalatedMarker}`);
}

function validateResumeOptimizationDraft(raw, context = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("简历优化结果格式无效");
  const sourceText = cleanText(context.sourceText, 200_000, "源简历");
  const catalog = Array.isArray(context.evidenceCatalog) ? context.evidenceCatalog : [];
  const evidenceById = new Map();
  for (const item of catalog) {
    const id = cleanText(item?.id, 40, "证据 ID");
    if (evidenceById.has(id)) throw new Error(`证据 ID 重复：${id}`);
    evidenceById.set(id, cleanText(item?.text, 20_000, "证据文字"));
  }

  if (!Array.isArray(raw.suggestions) || raw.suggestions.length < 1 || raw.suggestions.length > MAX_SUGGESTIONS) {
    throw new Error(`修改建议必须为 1-${MAX_SUGGESTIONS} 条`);
  }

  const seenIds = new Set();
  const ranges = [];
  const suggestions = raw.suggestions.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("修改建议格式无效");
    const id = cleanText(value.id || `S${index + 1}`, 40, "建议 ID");
    if (!/^S[1-9]\d*$/.test(id)) throw new Error(`建议 ID 格式无效：${id}`);
    if (seenIds.has(id)) throw new Error(`建议 ID 重复：${id}`);
    seenIds.add(id);

    const operation = cleanText(value.operation, 30, "修改操作");
    if (!SUPPORTED_OPERATIONS.has(operation)) throw new Error(`不支持的修改操作：${operation}`);
    const originalText = cleanText(value.originalText, 10_000, "建议原文");
    const proposedText = cleanText(value.proposedText, 10_000, "建议文字", { required: operation === "remove" ? false : true });
    if (operation === "remove" && proposedText) throw new Error("删除操作不能同时提供替换文字");
    const reason = cleanText(value.reason, 1_000, "修改理由");
    if (!Array.isArray(value.evidenceIds) || value.evidenceIds.length < 1 || value.evidenceIds.length > 8) {
      throw new Error("每条建议必须引用 1-8 条证据");
    }
    const evidenceIds = [...new Set(value.evidenceIds.map((item) => cleanText(item, 40, "证据 ID")))];
    const citedText = evidenceIds.map((evidenceId) => {
      if (!evidenceById.has(evidenceId)) throw new Error(`建议引用了不存在的证据：${evidenceId}`);
      return evidenceById.get(evidenceId);
    }).join("\n");
    const range = exactRange(sourceText, originalText);
    ranges.push({ ...range, id });
    validateGrounding({ proposedText }, citedText);

    return { id, operation, originalText, proposedText, reason, evidenceIds, decision: "pending", userText: "" };
  });

  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].start < ranges[index - 1].end) {
      throw new Error(`修改建议原文重叠：${ranges[index - 1].id} / ${ranges[index].id}`);
    }
  }

  return {
    headline: cleanText(raw.headline, 300, "优化结论", { required: false }),
    suggestions
  };
}

function normalizeResumeSuggestionDecisions(suggestions, decisions = {}) {
  if (!Array.isArray(suggestions)) throw new Error("修改建议格式无效");
  return suggestions.map((suggestion) => {
    const input = decisions[suggestion.id] || {};
    const decision = cleanText(input.decision || suggestion.decision || "pending", 30, "处理结果");
    if (!SUPPORTED_DECISIONS.has(decision)) throw new Error(`不支持的处理结果：${decision}`);
    const userText = decision === "edited"
      ? cleanText(input.userText ?? suggestion.userText, 10_000, "编辑文字")
      : "";
    return { ...suggestion, decision, userText };
  });
}

function removalRange(sourceText, range) {
  const before = range.start > 0 ? sourceText[range.start - 1] : "";
  const after = sourceText[range.end] || "";
  if ((range.start === 0 || before === "\n") && (range.end === sourceText.length || after === "\n")) {
    if (after === "\n") return { start: range.start, end: range.end + 1 };
    if (before === "\n") return { start: range.start - 1, end: range.end };
  }
  return range;
}

function renderOptimizedResume(sourceText, suggestions) {
  let result = cleanText(sourceText, 200_000, "源简历");
  const operations = [];
  for (const suggestion of Array.isArray(suggestions) ? suggestions : []) {
    if (!suggestion || !["accepted", "edited"].includes(suggestion.decision)) continue;
    const range = exactRange(result, cleanText(suggestion.originalText, 10_000, "建议原文"));
    const content = suggestion.decision === "edited" ? suggestion.userText : suggestion.proposedText;
    const targetRange = suggestion.operation === "remove" && suggestion.decision === "accepted"
      ? removalRange(result, range)
      : range;
    const isWholeLineAnchor = (range.start === 0 || result[range.start - 1] === "\n")
      && (range.end === result.length || result[range.end] === "\n");
    const replacement = suggestion.operation === "insert_after"
      ? `${suggestion.originalText}${isWholeLineAnchor ? "\n" : ""}${content}`
      : content;
    operations.push({ ...targetRange, replacement });
  }

  operations.sort((left, right) => right.start - left.start);
  for (const operation of operations) {
    result = `${result.slice(0, operation.start)}${operation.replacement}${result.slice(operation.end)}`;
  }
  return result;
}

module.exports = {
  buildResumeEvidenceCatalog,
  validateResumeOptimizationDraft,
  normalizeResumeSuggestionDecisions,
  renderOptimizedResume
};
