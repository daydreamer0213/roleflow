const assert = require("node:assert");
const {
  normalizeInterviewSettings,
  buildResumeInterviewEvidenceCatalog,
  validateInterviewStep,
  validateInterviewReport,
  validateRetryReview
} = require("../src/core/mock_interview");

const resumeEvidenceCatalog = buildResumeInterviewEvidenceCatalog("个人总结\n参与知识库开发\n技能：Node.js");
assert.deepStrictEqual(resumeEvidenceCatalog.map((item) => item.id), ["R1", "R2", "R3"]);
assert.throws(() => buildResumeInterviewEvidenceCatalog(" \n "), /简历证据/);
const stepContext = { resumeEvidenceCatalog, sessionKind: "resume_general" };

assert.deepStrictEqual(normalizeInterviewSettings({
  type: "technical",
  difficulty: "challenging",
  plannedQuestions: "7"
}), { type: "technical", difficulty: "challenging", plannedQuestions: 7 });

for (const invalid of [
  { type: "sales", difficulty: "standard", plannedQuestions: 5 },
  { type: "mixed", difficulty: "easy", plannedQuestions: 5 },
  { type: "mixed", difficulty: "standard", plannedQuestions: 2 },
  { type: "mixed", difficulty: "standard", plannedQuestions: 13 }
]) {
  assert.throws(() => normalizeInterviewSettings(invalid), /面试类型|难度|题数/);
}

assert.throws(() => validateInterviewStep({
  answerReview: { conclusion: "尚可", strengths: [], improvements: [], turnNumbers: [1] },
  nextQuestion: { text: "请介绍自己", focus: "intro", resumeEvidenceIds: ["R2"], basedOnTurnNumber: null },
  complete: false
}, { ...stepContext, turns: [] }), /首题/);

const first = validateInterviewStep({
  answerReview: null,
  nextQuestion: { text: "简历中写到知识库，请介绍这段经历。", focus: "intro", resumeEvidenceIds: ["R2"], basedOnTurnNumber: null },
  complete: false
}, { ...stepContext, turns: [] });
assert.strictEqual(first.nextQuestion.basedOnTurnNumber, null);
assert.deepStrictEqual(first.nextQuestion.resumeEvidenceIds, ["R2"]);

for (const resumeEvidenceIds of [[], ["UNKNOWN"], ["R1", "R2", "R3", "R4", "R5"]]) {
  assert.throws(() => validateInterviewStep({
    answerReview: null,
    nextQuestion: { text: "请介绍简历经历。", focus: "intro", resumeEvidenceIds, basedOnTurnNumber: null },
    complete: false
  }, { ...stepContext, turns: [] }), /简历证据/);
}

assert.throws(() => validateInterviewStep({
  answerReview: null,
  nextQuestion: { text: "首题不应引用回答", focus: "intro", resumeEvidenceIds: ["R2"], basedOnTurnNumber: null, answerEvidence: "回答" },
  complete: false
}, { ...stepContext, turns: [] }), /首题/);

assert.throws(() => validateInterviewStep({
  answerReview: { conclusion: "回答直接", strengths: ["有项目"], improvements: ["补充个人贡献"], turnNumbers: [1] },
  nextQuestion: { text: "继续说说项目难点。", focus: "project", resumeEvidenceIds: ["R2"], basedOnTurnNumber: null },
  complete: false
}, { ...stepContext, turns: [{ turnNumber: 1, answer: "我参与了知识库项目。" }] }), /上一题|追问/);

const followUp = validateInterviewStep({
  answerReview: { conclusion: "回答直接", strengths: ["有项目"], improvements: ["补充个人贡献"], turnNumbers: [1] },
  nextQuestion: { text: "你刚才提到“接口联调”，结合简历中的知识库项目说明你具体做了什么。", focus: "contribution", resumeEvidenceIds: ["R2"], basedOnTurnNumber: 1, answerEvidence: "接口联调" },
  complete: false
}, { ...stepContext, turns: [{ turnNumber: 1, answer: "我参与了知识库项目并完成接口联调。" }] });
assert.deepStrictEqual(followUp.answerReview.turnNumbers, [1]);

assert.throws(() => validateInterviewStep({
  answerReview: { conclusion: "引用错题", strengths: [], improvements: [], turnNumbers: [1] },
  nextQuestion: { text: "继续追问“第二题”。", focus: "project", resumeEvidenceIds: ["R2"], basedOnTurnNumber: 2, answerEvidence: "第二题" },
  complete: false
}, { ...stepContext, turns: [{ turnNumber: 1, answer: "第一题" }, { turnNumber: 2, answer: "第二题" }] }), /刚回答|上一题.*复盘/);

assert.throws(() => validateInterviewStep({
  answerReview: { conclusion: "题号正确", strengths: [], improvements: [], turnNumbers: [2] },
  nextQuestion: { text: "请再介绍一个项目。", focus: "project", resumeEvidenceIds: ["R2"], basedOnTurnNumber: 2, answerEvidence: "第二题" },
  complete: false
}, { ...stepContext, turns: [{ turnNumber: 1, answer: "第一题" }, { turnNumber: 2, answer: "第二题回答" }] }), /回答片段|承接/);

assert.throws(() => validateInterviewStep({
  answerReview: { conclusion: "复盘", strengths: [], improvements: [], turnNumbers: [1] },
  nextQuestion: { text: "你提到接口联调，请继续。", focus: "project", resumeEvidenceIds: [], basedOnTurnNumber: 1, answerEvidence: "接口联调" },
  complete: false
}, { ...stepContext, turns: [{ turnNumber: 1, answer: "我做了接口联调" }] }), /简历证据/);

assert.throws(() => validateInterviewStep({
  answerReview: { conclusion: "完成", strengths: [], improvements: [], turnNumbers: [1] },
  nextQuestion: { text: "多余问题", focus: "extra", resumeEvidenceIds: ["R2"], basedOnTurnNumber: 1 },
  complete: true
}, { ...stepContext, turns: [{ turnNumber: 1, answer: "回答" }] }), /结束|下一题/);

const turns = [{ turnNumber: 1 }, { turnNumber: 2 }];
const report = validateInterviewReport({
  conclusion: "岗位动机清楚，但项目贡献还需要更具体。",
  strengths: ["回答直接", "岗位动机明确"],
  improvements: ["补充个人贡献", "说明技术取舍"],
  followUpRisks: [{ turnNumber: 2, reason: "贡献边界不够清楚" }],
  retryRecommendations: [{ turnNumber: 2, reason: "用具体行动重答" }],
  answerStructures: [{ turnNumber: 2, outline: ["背景", "个人行动", "结果"] }]
}, { turns });
assert.strictEqual(report.retryRecommendations[0].turnNumber, 2);

assert.throws(() => validateInterviewReport({
  conclusion: "复盘",
  strengths: [],
  improvements: [],
  followUpRisks: [{ turnNumber: 9, reason: "不存在" }],
  retryRecommendations: [],
  answerStructures: []
}, { turns }), /题号/);

assert.throws(() => validateInterviewReport({
  conclusion: "复盘",
  offerProbability: 0.8,
  strengths: [],
  improvements: [],
  followUpRisks: [],
  retryRecommendations: [],
  answerStructures: []
}, { turns }), /录用概率/);

const retry = validateRetryReview({
  turnNumber: 2,
  conclusion: "比第一次更清楚",
  improved: true,
  strengths: ["补充了个人行动"],
  remainingImprovements: ["结果仍可量化"]
}, { turnNumber: 2 });
assert.strictEqual(retry.improved, true);
assert.throws(() => validateRetryReview({ ...retry, turnNumber: 1 }, { turnNumber: 2 }), /题号/);

console.log("mock_interview_contract_smoke ok");
