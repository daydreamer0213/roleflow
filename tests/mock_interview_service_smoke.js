const assert = require("node:assert");
const storage = require("../src/core/storage");
const { createMockInterviewService } = require("../src/application/mock_interview");

function profile(name) {
  return {
    candidate: { name, city: "广州", targetTitles: ["AI 应用工程师"] },
    skills: [{ name: "Node.js" }],
    projects: [{ name: "企业知识库", canSay: ["参与知识库开发"] }]
  };
}

function document(hash) {
  const text = "个人总结\n参与企业知识库开发\n技能：Node.js";
  return {
    originalFileName: "candidate.txt", format: "text", contentHash: hash, text,
    diagnostics: { extractionMethod: "text", inputBytes: Buffer.byteLength(text) }
  };
}

function job(sourceId) {
  return {
    source: "boss", sourceId, keyword: "AI 应用工程师", title: "AI 应用工程师", company: "示例科技",
    location: "广州", salary: "15-25K", experience: "1-3年", education: "本科", bossActiveText: "今日活跃",
    bossActiveDays: 0, url: `https://www.zhipin.com/job_detail/${sourceId}.html`, tags: ["Node.js", "知识库"],
    description: "负责 Node.js 企业知识库应用开发、检索评估和接口交付，要求具备完整项目经验。",
    score: 18, level: "可投", matches: ["Node.js"], risks: [], qualityTags: [],
    analysis: { provider: "mock", model: "offline", semanticStatus: "complete", recommendation: "apply" }
  };
}

const db = storage.openDb(":memory:");

(async () => {
  try {
    const owner = storage.saveProfileAnalysis(db, {
      profile: profile("候选人甲"), document: document("interview-service-resume"),
      searchPlan: { name: "Owner", cities: ["广州"], directions: ["AI 应用工程师"], keywords: [{ word: "知识库", priority: "A" }] }
    });
    const batch = storage.createBatch(db, "boss", "知识库", "mock interview service", {
      profileId: owner.profileId, searchPlanId: owner.planId
    });
    const jobId = storage.upsertJob(db, job("interview-service-owned"), batch);
    storage.saveCandidateFact(db, {
      profileId: owner.profileId, factKey: "availability", factValue: "两周到岗", source: "user_provided"
    });
    const factCount = db.prepare("SELECT count(*) AS n FROM candidate_facts WHERE profile_id = ?").get(owner.profileId).n;
    const memoryCount = db.prepare("SELECT count(*) AS n FROM candidate_answer_memories WHERE profile_id = ?").get(owner.profileId).n;

    const calls = [];
    let invalidStep = false;
    let failReport = false;
    const adapter = {
      provider: "scripted",
      model: "interview-service-test",
      async generateMockInterviewStep(input) {
        calls.push({ kind: "step", input: JSON.parse(JSON.stringify(input)) });
        const turns = input.turns || [];
        if (!turns.length) {
          return {
            answerReview: null,
            nextQuestion: { text: "请结合这个岗位介绍你自己。", focus: "intro", basedOnTurnNumber: null },
            complete: false
          };
        }
        const last = turns[turns.length - 1];
        if (invalidStep) {
          return {
            answerReview: { conclusion: "收到", strengths: [], improvements: [], turnNumbers: [last.turnNumber] },
            nextQuestion: { text: "错误追问", focus: "invalid", basedOnTurnNumber: null },
            complete: false
          };
        }
        return {
          answerReview: {
            conclusion: `已复盘第 ${last.turnNumber} 题`,
            strengths: ["回答直接"], improvements: ["补充结果"], turnNumbers: [last.turnNumber]
          },
          nextQuestion: turns.length >= input.settings.plannedQuestions ? null : {
            text: `你刚才回答“${last.answer}”，请继续说明个人贡献。`,
            focus: "project",
            basedOnTurnNumber: last.turnNumber
          },
          complete: turns.length >= input.settings.plannedQuestions
        };
      },
      async reviewMockInterview(input) {
        calls.push({ kind: "report", input: JSON.parse(JSON.stringify(input)) });
        if (failReport) throw new Error("forced report failure");
        return {
          conclusion: "岗位动机清楚，项目贡献需要更具体。",
          strengths: ["回答直接", "岗位相关"], improvements: ["补充结果"],
          followUpRisks: [{ turnNumber: 2, reason: "结果不够具体" }],
          retryRecommendations: [{ turnNumber: 2, reason: "使用行动和结果重答" }],
          answerStructures: [{ turnNumber: 2, outline: ["背景", "行动", "结果"] }]
        };
      },
      async reviewMockInterviewRetry(input) {
        calls.push({ kind: "retry", input: JSON.parse(JSON.stringify(input)) });
        return {
          turnNumber: input.turn.turnNumber,
          conclusion: "新回答更具体。", improved: true,
          strengths: ["补充了行动"], remainingImprovements: ["结果可再明确"]
        };
      }
    };
    const service = createMockInterviewService({ db, adapter });
    const session = await service.startSession({
      profileId: owner.profileId,
      planId: owner.planId,
      jobId,
      resumeVersionId: owner.resumeVersionId,
      settings: { type: "mixed", difficulty: "standard", plannedQuestions: 3 }
    });
    assert.strictEqual(session.turns.length, 1);
    assert(calls[0].input.context.job.description.includes("Node.js 企业知识库"));
    assert(calls[0].input.context.resume.text.includes("参与企业知识库开发"));
    assert.strictEqual(calls[0].input.context.job.id, jobId);

    const firstAnswer = "我参与了企业知识库开发，负责接口联调。";
    const afterFirst = await service.answerTurn({
      profileId: owner.profileId, sessionId: session.id, turnNumber: 1, answerText: firstAnswer
    });
    assert.strictEqual(afterFirst.turns.length, 2);
    const secondStepCall = calls.filter((call) => call.kind === "step")[1];
    assert.strictEqual(secondStepCall.input.turns.at(-1).answer, firstAnswer);
    assert(secondStepCall.input.context.job.description.includes("检索评估"));
    const stepCallsBeforeReplay = calls.filter((call) => call.kind === "step").length;
    const replayedFirst = await service.answerTurn({
      profileId: owner.profileId, sessionId: session.id, turnNumber: 1, answerText: firstAnswer
    });
    assert.strictEqual(replayedFirst.turns.length, 2, "identical answer replay must be idempotent");
    assert.strictEqual(calls.filter((call) => call.kind === "step").length, stepCallsBeforeReplay,
      "identical answer replay must not call the model again");

    invalidStep = true;
    await assert.rejects(() => service.answerTurn({
      profileId: owner.profileId, sessionId: session.id, turnNumber: 2, answerText: "第二题回答"
    }), /上一题|追问/);
    let loaded = service.getSession({ profileId: owner.profileId, sessionId: session.id });
    assert.strictEqual(loaded.turns.length, 2, "invalid model output must not advance the session");
    assert.strictEqual(loaded.turns[1].answerText, "", "invalid model output must not partially save the current answer");
    assert.strictEqual(loaded.turns[0].answerText, firstAnswer, "prior completed answers must remain saved");

    invalidStep = false;
    await service.answerTurn({ profileId: owner.profileId, sessionId: session.id, turnNumber: 2, answerText: "第二题回答" });
    await service.answerTurn({ profileId: owner.profileId, sessionId: session.id, turnNumber: 3, answerText: "第三题回答" });
    failReport = true;
    await assert.rejects(() => service.finishSession({ profileId: owner.profileId, sessionId: session.id }), /forced report failure/);
    loaded = service.getSession({ profileId: owner.profileId, sessionId: session.id });
    assert.strictEqual(loaded.status, "active");
    assert.strictEqual(loaded.turns.filter((turn) => turn.answerText).length, 3);

    failReport = false;
    const completed = await service.finishSession({ profileId: owner.profileId, sessionId: session.id });
    assert.strictEqual(completed.status, "completed");
    assert.strictEqual(completed.report.retryRecommendations[0].turnNumber, 2);
    const retried = await service.retryTurn({
      profileId: owner.profileId, sessionId: session.id, turnNumber: 2,
      answerText: "第二题重答：我负责接口联调并完成验收。"
    });
    assert.strictEqual(retried.review.improved, true);

    assert.strictEqual(db.prepare("SELECT count(*) AS n FROM candidate_facts WHERE profile_id = ?").get(owner.profileId).n, factCount);
    assert.strictEqual(db.prepare("SELECT count(*) AS n FROM candidate_answer_memories WHERE profile_id = ?").get(owner.profileId).n, memoryCount);
    assert.strictEqual(service.listSessions({ profileId: owner.profileId }).length, 1);

    console.log("mock_interview_service_smoke ok");
  } finally {
    db.close();
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
