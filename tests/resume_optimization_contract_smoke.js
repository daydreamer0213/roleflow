const assert = require("node:assert");
const {
  buildResumeEvidenceCatalog,
  validateResumeOptimizationDraft,
  normalizeResumeSuggestionDecisions,
  renderOptimizedResume
} = require("../src/core/resume_optimization");

const sourceText = [
  "个人总结",
  "参与知识库开发",
  "项目经历",
  "负责接口联调",
  "技能：Node.js"
].join("\n");

const evidenceCatalog = buildResumeEvidenceCatalog({
  sourceText,
  jobs: [{ id: 7, title: "AI 应用工程师", company: "示例科技", description: "需要 Node.js 与知识库项目经验" }],
  facts: [{ key: "work_style", value: "不接受长期出差", source: "message_reply" }],
  answerMemories: [{ id: 9, questionClass: "availability", finalText: "可在两周内到岗", scopeType: "global" }],
  diagnosis: { conclusion: "项目证据应靠前" }
});

assert.deepStrictEqual(
  evidenceCatalog.map((item) => item.id),
  ["R1", "R2", "R3", "R4", "R5", "J1", "F1", "A1", "D1"]
);
assert(evidenceCatalog.every((item) => item.text && item.kind));

const context = { sourceText, evidenceCatalog };

assert.throws(() => validateResumeOptimizationDraft({ suggestions: [{
  id: "S1",
  operation: "replace",
  originalText: "不存在的原文",
  proposedText: "改写",
  reason: "对齐岗位",
  evidenceIds: ["R1"],
  editingPrinciple: "jd_vocabulary"
}] }, context), /原文/);

assert.throws(() => validateResumeOptimizationDraft({ suggestions: [{
  id: "S1",
  operation: "replace",
  originalText: "参与知识库开发",
  proposedText: "主导知识库开发，提升 80%",
  reason: "强化贡献",
  evidenceIds: ["R2"],
  editingPrinciple: "contribution_clarity"
}] }, context), /职责边界|数字/);

assert.throws(() => validateResumeOptimizationDraft({ suggestions: [{
  id: "S1",
  operation: "replace",
  originalText: "参与知识库开发",
  proposedText: "独立负责知识库开发",
  reason: "强化贡献",
  evidenceIds: ["R2"],
  editingPrinciple: "contribution_clarity"
}] }, context), /职责边界/);

assert.throws(() => validateResumeOptimizationDraft({ suggestions: [{
  id: "S1",
  operation: "replace",
  originalText: "知识库开发",
  proposedText: "知识库研发",
  reason: "精简",
  evidenceIds: ["R2"],
  editingPrinciple: "concision"
}, {
  id: "S2",
  operation: "replace",
  originalText: "参与知识库开发",
  proposedText: "参与知识库研发",
  reason: "精简",
  evidenceIds: ["R2"],
  editingPrinciple: "concision"
}] }, context), /重叠/);

assert.throws(() => validateResumeOptimizationDraft({ suggestions: [{
  id: "S1",
  operation: "replace",
  originalText: "参与知识库开发",
  proposedText: "参与知识库研发",
  reason: "对齐岗位",
  evidenceIds: ["UNKNOWN"],
  editingPrinciple: "jd_vocabulary"
}] }, context), /证据/);

assert.throws(() => validateResumeOptimizationDraft({ suggestions: [{
  id: "S1_非法",
  operation: "replace",
  originalText: "参与知识库开发",
  proposedText: "参与知识库研发",
  reason: "非法表单标识",
  evidenceIds: ["R2"],
  editingPrinciple: "concision"
}] }, context), /建议 ID/);

assert.throws(() => validateResumeOptimizationDraft({ suggestions: [{
  id: "S1",
  operation: "replace",
  originalText: "参与知识库开发",
  proposedText: "参与知识库研发",
  reason: "使用未批准的修改原则",
  evidenceIds: ["R2"],
  editingPrinciple: "creative_rewrite"
}] }, context), /修改原则/);

const validated = validateResumeOptimizationDraft({
  headline: "突出与目标岗位直接相关的项目经验",
  suggestions: [{
    id: "S1",
    operation: "replace",
    originalText: "参与知识库开发",
    proposedText: "参与 Node.js 知识库开发",
    reason: "补充已证实的技术栈",
    evidenceIds: ["R2", "R5", "J1"],
    editingPrinciple: "jd_vocabulary"
  }, {
    id: "S2",
    operation: "remove",
    originalText: "负责接口联调",
    proposedText: "",
    reason: "与目标岗位关联较弱",
    evidenceIds: ["R4", "J1"],
    editingPrinciple: "relevance_order"
  }, {
    id: "S3",
    operation: "insert_after",
    originalText: "项目经历",
    proposedText: "\n目标方向：AI 应用工程",
    reason: "让阅读顺序更清楚",
    evidenceIds: ["R3", "J1"],
    editingPrinciple: "structure"
  }]
}, context);

assert.strictEqual(validated.suggestions.length, 3);
assert.strictEqual(validated.suggestions[0].decision, "accepted");
assert.strictEqual(validated.suggestions[0].editingPrinciple, "jd_vocabulary");
assert.match(renderOptimizedResume(sourceText, validated.suggestions), /Node\.js 知识库开发/);

const decided = normalizeResumeSuggestionDecisions(validated.suggestions, {
  S1: { decision: "accepted" },
  S2: { decision: "ignored" },
  S3: { decision: "edited", userText: "\n目标方向：企业知识库" }
});

assert.strictEqual(decided[0].decision, "accepted");
assert.strictEqual(decided[1].decision, "ignored");
assert.strictEqual(decided[2].decision, "edited");
assert.strictEqual(decided[2].userText, "目标方向：企业知识库");

assert.strictEqual(renderOptimizedResume(sourceText, decided), [
  "个人总结",
  "参与 Node.js 知识库开发",
  "项目经历",
  "目标方向：企业知识库",
  "负责接口联调",
  "技能：Node.js"
].join("\n"));

const allAccepted = normalizeResumeSuggestionDecisions(validated.suggestions, {
  S1: { decision: "accepted" },
  S2: { decision: "accepted" },
  S3: { decision: "ignored" }
});
assert.strictEqual(renderOptimizedResume(sourceText, allAccepted), [
  "个人总结",
  "参与 Node.js 知识库开发",
  "项目经历",
  "技能：Node.js"
].join("\n"));

assert.throws(() => normalizeResumeSuggestionDecisions(validated.suggestions, {
  S1: { decision: "edited", userText: "" }
}), /编辑文字/);

console.log("resume_optimization_contract_smoke ok");
