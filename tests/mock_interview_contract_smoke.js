const assert = require("node:assert");
const {
  normalizeInterviewSettings,
  validateInterviewStep,
  validateInterviewReport,
  validateRetryReview
} = require("../src/core/mock_interview");

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
  nextQuestion: { text: "请介绍自己", focus: "intro", basedOnTurnNumber: null },
  complete: false
}, { turns: [] }), /首题/);

const first = validateInterviewStep({
  answerReview: null,
  nextQuestion: { text: "请结合这个岗位介绍你自己。", focus: "intro", basedOnTurnNumber: null },
  complete: false
}, { turns: [] });
assert.strictEqual(first.nextQuestion.basedOnTurnNumber, null);

assert.throws(() => validateInterviewStep({
  answerReview: { conclusion: "回答直接", strengths: ["有项目"], improvements: ["补充个人贡献"], turnNumbers: [1] },
  nextQuestion: { text: "继续说说项目难点。", focus: "project", basedOnTurnNumber: null },
  complete: false
}, { turns: [{ turnNumber: 1, answer: "我参与了知识库项目。" }] }), /上一题|追问/);

const followUp = validateInterviewStep({
  answerReview: { conclusion: "回答直接", strengths: ["有项目"], improvements: ["补充个人贡献"], turnNumbers: [1] },
  nextQuestion: { text: "你刚提到知识库，请说说最难的技术取舍。", focus: "project", basedOnTurnNumber: 1 },
  complete: false
}, { turns: [{ turnNumber: 1, answer: "我参与了知识库项目。" }] });
assert.deepStrictEqual(followUp.answerReview.turnNumbers, [1]);

assert.throws(() => validateInterviewStep({
  answerReview: { conclusion: "完成", strengths: [], improvements: [], turnNumbers: [1] },
  nextQuestion: { text: "多余问题", focus: "extra", basedOnTurnNumber: 1 },
  complete: true
}, { turns: [{ turnNumber: 1, answer: "回答" }] }), /结束|下一题/);

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
