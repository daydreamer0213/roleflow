"use strict";

const assert = require("node:assert/strict");
const {
  OPENING_LENGTH,
  MIN_OPENING_LENGTH,
  TRIGRAM_SIMILARITY_THRESHOLD,
  normalizedMessageText,
  extractHighRiskClaims,
  assessMessageDraftQuality
} = require("../src/core/message_draft_quality");

assert.equal(OPENING_LENGTH, 18);
assert.equal(MIN_OPENING_LENGTH, 8);
assert.equal(TRIGRAM_SIMILARITY_THRESHOLD, 0.72);
assert.equal(normalizedMessageText(" 您好，ＡＩ 岗位！\n期待沟通。 "), "您好ai岗位期待沟通");

const repeated = assessMessageDraftQuality({
  text: "您好，我对贵司的内容运营岗位很感兴趣，期待沟通。",
  recentTexts: ["您好，我对贵司的用户运营岗位很感兴趣，期待沟通。"],
  evidenceTexts: []
});
assert.equal(repeated.valid, true);
assert.equal(repeated.warnings[0].code, "MESSAGE_DRAFT_RECENTLY_SIMILAR");
assert(repeated.matchedOpening);

const punctuationOnly = assessMessageDraftQuality({
  text: "您好！想进一步了解岗位职责；期待沟通。",
  recentTexts: ["您好，想进一步了解岗位职责，期待沟通"],
  evidenceTexts: []
});
assert.equal(punctuationOnly.warnings[0].code, "MESSAGE_DRAFT_RECENTLY_SIMILAR");

const generic = assessMessageDraftQuality({
  text: "您好，谢谢。",
  recentTexts: ["您好，谢谢"],
  evidenceTexts: []
});
assert.equal(generic.warnings.length, 0, "short generic phrases must not trigger similarity warnings");

const unrelated = assessMessageDraftQuality({
  text: "您好，想了解团队目前最关注的内容增长方向。",
  recentTexts: ["感谢回复，我会按约定时间准备并参加面试。"],
  evidenceTexts: []
});
assert.equal(unrelated.warnings.length, 0);

const invented = assessMessageDraftQuality({
  text: "我可以本周三到岗，期望薪资 25K，手机号 13800138000。",
  recentTexts: [],
  evidenceTexts: ["用户可在两周后到岗"]
});
assert.equal(invented.valid, false);
assert.deepEqual(invented.errors.map((item) => item.kind).sort(), ["arrival", "phone", "salary"]);

const supportedText = [
  "手机号 13800138000，邮箱 user@example.com，作品 https://example.com/work。",
  "期望薪资 25K，本周三可以到岗，周五下午可以面试。",
  "有 3 年经验，转化率提升 30%，累计服务 200 个客户。",
  "不接受加班，可以短期出差，不考虑异地搬迁。"
].join("");
const supported = assessMessageDraftQuality({
  text: supportedText,
  recentTexts: [],
  evidenceTexts: [supportedText]
});
assert.equal(supported.valid, true, JSON.stringify(supported.errors));
assert(supported.errors.length === 0);

const supportedAvailabilityParaphrase = assessMessageDraftQuality({
  text: "我本周三可以到岗。",
  recentTexts: [],
  evidenceTexts: ["本周三到岗"]
});
assert.equal(supportedAvailabilityParaphrase.valid, true,
  "the same explicit arrival date should not depend on filler wording");

const extractedKinds = new Set(extractHighRiskClaims(supportedText).map((item) => item.kind));
for (const kind of ["phone", "email", "url", "salary", "arrival", "interview_availability", "duration", "percentage", "numeric_achievement", "overtime", "travel", "relocation"]) {
  assert(extractedKinds.has(kind), `expected ${kind} claim`);
}

const wrongPreference = assessMessageDraftQuality({
  text: "我可以接受加班，也可以长期出差。",
  recentTexts: [],
  evidenceTexts: ["用户不接受加班，只接受短期出差"]
});
assert.equal(wrongPreference.valid, false);
assert.deepEqual(wrongPreference.errors.map((item) => item.kind).sort(), ["overtime", "travel"]);

console.log("message_draft_quality_smoke ok");
