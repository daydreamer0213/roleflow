const assert = require("node:assert/strict");
const { evaluateJobEligibility } = require("../src/core/job_eligibility");

const fullTimeTarget = ["全职"];
const graduated2024 = {
  education: [{ school: "测试大学", endDate: "2024-06", status: "已毕业" }]
};

function evaluate(job, candidateProfile = graduated2024, targetJobTypes = fullTimeTarget) {
  return evaluateJobEligibility({
    title: "AI 应用开发工程师",
    description: "负责 Python、RAG 与 Agent 应用开发。",
    tags: [],
    ...job
  }, { candidateProfile, targetJobTypes });
}

for (const [label, job] of [
  ["标题明确实习", { title: "RAG 开发实习生" }],
  ["JD 明确实习周期", { description: "岗位职责：开发 AI 应用。实习周期 4-6 个月，每周到岗 5 天。" }],
  ["JD 明确实习时长", { description: "参与大模型应用研发，实习时长不少于 4 个月。" }],
  ["JD 明确实习生岗位", { description: "这是面向研发方向的实习生岗位，负责 RAG 应用开发。" }],
  ["JD 只接受实习生", { description: "负责知识库数据处理，本岗位只接受实习生。" }]
]) {
  const result = evaluate(job);
  assert.strictEqual(result.status, "blocked", label);
  assert.strictEqual(result.employmentType, "internship", label);
  assert.strictEqual(result.reasonCode, "internship_role", label);
  assert(result.qualityTags.includes("internship_role"), label);
  assert(result.evidence.job.length > 0, label);
}

for (const [label, job] of [
  ["实习经验只是偏好", { description: "全职岗位，负责 AI 应用开发；有互联网实习经验优先。" }],
  ["日薪不能单独证明实习", { salary: "300-500元/天", description: "负责企业知识库与 Agent 平台开发。" }]
]) {
  const result = evaluate(job);
  assert.notStrictEqual(result.status, "blocked", label);
  assert(!result.qualityTags.includes("internship_role"), label);
}

const acceptsIntern = evaluate({
  description: "负责 Python 与 RAG 应用开发，可接受实习生。"
});
assert.notStrictEqual(acceptsIntern.status, "blocked");
assert(["mixed", "unknown"].includes(acceptsIntern.employmentType));

const cohortMismatch = evaluate({
  description: "岗位职责：负责大模型应用开发。任职要求：26/27届毕业生，熟悉 Python。"
});
assert.strictEqual(cohortMismatch.status, "blocked");
assert.strictEqual(cohortMismatch.reasonCode, "cohort_mismatch");
assert(cohortMismatch.qualityTags.includes("cohort_mismatch"));
assert(cohortMismatch.evidence.job.some((item) => /26\/27届/.test(item)));
assert(cohortMismatch.evidence.candidate.some((item) => /2024/.test(item)));

const exclusiveCohortMismatch = evaluate({
  description: "任职要求：只接受 2026 届毕业生，熟悉 Python。"
});
assert.strictEqual(exclusiveCohortMismatch.status, "blocked");
assert.strictEqual(exclusiveCohortMismatch.reasonCode, "cohort_mismatch");

const oneAcceptedEducation = evaluate({
  description: "任职要求：26/27届毕业生，熟悉 Python。"
}, {
  education: [
    { school: "本科院校", endDate: "2024-06", status: "已毕业" },
    { school: "硕士院校", endDate: "2027-06", status: "在读" }
  ]
});
assert.strictEqual(oneAcceptedEducation.status, "eligible");

for (const [label, description] of [
  ["届别优先是软条件", "任职要求：2027届毕业生优先，熟悉 Python。"],
  ["面向届别但明确优先仍是软条件", "任职要求：面向2027届毕业生优先，熟悉 Python。"],
  ["可接受应届生是放宽", "任职要求：有项目经验，可接受应届生。"]
]) {
  const result = evaluate({ description });
  assert.strictEqual(result.status, "eligible", label);
  assert(!result.qualityTags.includes("cohort_mismatch"), label);
}

const studentMismatch = evaluate({
  description: "任职要求：仅面向在校生，能连续参与项目。"
});
assert.strictEqual(studentMismatch.status, "blocked");
assert.strictEqual(studentMismatch.reasonCode, "student_status_mismatch");

const exclusiveStudentMismatch = evaluate({
  description: "任职要求：只接受在校生，能连续参与项目。"
});
assert.strictEqual(exclusiveStudentMismatch.status, "blocked");
assert.strictEqual(exclusiveStudentMismatch.reasonCode, "student_status_mismatch");

const unknownCandidate = evaluate({
  description: "任职要求：26/27届毕业生，熟悉 Python。"
}, { education: [] });
assert.strictEqual(unknownCandidate.status, "review");
assert.strictEqual(unknownCandidate.reasonCode, "eligibility_review");
assert(unknownCandidate.qualityTags.includes("eligibility_review"));

const blockedDominatesReview = evaluate({
  title: "RAG 开发实习生",
  description: "任职要求：26/27届毕业生，熟悉 Python。"
}, { education: [] });
assert.strictEqual(blockedDominatesReview.status, "blocked");
assert.strictEqual(blockedDominatesReview.reasonCode, "internship_role");
assert(!blockedDominatesReview.qualityTags.includes("eligibility_review"));

const internshipTarget = evaluate({ title: "RAG 开发实习生" }, graduated2024, ["实习"]);
assert.strictEqual(internshipTarget.status, "eligible");
assert.strictEqual(internshipTarget.employmentType, "internship");

for (const snippet of [...cohortMismatch.evidence.job, ...cohortMismatch.evidence.candidate]) {
  assert(snippet.length <= 160, "eligibility evidence must remain short");
}
assert.strictEqual(new Set(cohortMismatch.evidence.job).size, cohortMismatch.evidence.job.length);
assert.strictEqual(new Set(cohortMismatch.evidence.candidate).size, cohortMismatch.evidence.candidate.length);

console.log("job_eligibility_smoke ok");
