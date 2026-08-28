const assert = require("node:assert");
const crypto = require("node:crypto");
const storage = require("../src/core/storage");

function profile(name) {
  return {
    candidate: { name, city: "广州", targetTitles: ["AI 应用工程师"] },
    skills: [{ name: "Node.js" }],
    projects: [{ name: "企业知识库" }]
  };
}

function document(hash, name) {
  const text = `${name}\n参与企业知识库开发\n技能：Node.js`;
  return {
    originalFileName: `${name}.txt`, format: "text", contentHash: hash, text,
    diagnostics: { extractionMethod: "text", inputBytes: Buffer.byteLength(text) }
  };
}

function job(sourceId) {
  return {
    source: "boss", sourceId, keyword: "AI 应用工程师", title: "AI 应用工程师", company: "示例科技",
    location: "广州", salary: "15-25K", experience: "1-3年", education: "本科", bossActiveText: "今日活跃",
    bossActiveDays: 0, url: `https://www.zhipin.com/job_detail/${sourceId}.html`, tags: ["Node.js"],
    description: "负责 Node.js 企业知识库应用开发、检索评估和接口交付，要求具备完整项目经验。",
    score: 18, level: "可投", matches: ["Node.js"], risks: [], qualityTags: [],
    analysis: { provider: "mock", model: "offline", semanticStatus: "complete", recommendation: "apply" }
  };
}

const db = storage.openDb(":memory:");

try {
  const owner = storage.saveProfileAnalysis(db, {
    profile: profile("候选人甲"), document: document("interview-owner", "候选人甲"),
    searchPlan: { name: "Owner", cities: ["广州"], directions: ["AI 应用工程师"], keywords: [{ word: "知识库", priority: "A" }] }
  });
  const other = storage.saveProfileAnalysis(db, {
    profile: profile("候选人乙"), document: document("interview-other", "候选人乙"),
    searchPlan: { name: "Other", cities: ["深圳"], directions: ["后端"], keywords: [{ word: "后端", priority: "A" }] }
  });
  const batch = storage.createBatch(db, "boss", "知识库", "mock interview", {
    profileId: owner.profileId, searchPlanId: owner.planId
  });
  const jobId = storage.upsertJob(db, job("interview-owned"), batch);
  const now = "2026-08-29T08:00:00.000Z";
  const secondOwnerPlanId = Number(db.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, 'Owner second plan', '{}', NULL, 1, ?, ?)`).run(owner.profileId, now, now).lastInsertRowid);

  assert.throws(() => storage.createMockInterviewSession(db, {
    profileId: other.profileId,
    planId: other.planId,
    jobId,
    resumeVersionId: other.resumeVersionId,
    context: { job: { id: jobId }, resume: { text: "其他简历" } },
    settings: { type: "mixed", difficulty: "standard", plannedQuestions: 5 }
  }), /岗位|不属于|not found/i);

  const frozenContext = {
    job: { id: jobId, title: "AI 应用工程师", company: "示例科技", description: "完整冻结 JD" },
    resume: { versionId: owner.resumeVersionId, text: "冻结简历正文" },
    facts: [{ key: "availability", value: "两周到岗" }]
  };
  db.exec(`CREATE TRIGGER fail_initial_interview_question BEFORE INSERT ON mock_interview_turns
    WHEN NEW.question_text = 'forced initial failure'
    BEGIN SELECT RAISE(ABORT, 'forced initial question failure'); END;`);
  assert.throws(() => storage.createMockInterviewSession(db, {
    profileId: owner.profileId,
    planId: owner.planId,
    jobId,
    resumeVersionId: owner.resumeVersionId,
    context: frozenContext,
    settings: { type: "mixed", difficulty: "standard", plannedQuestions: 3 },
    initialQuestion: { text: "forced initial failure", focus: "intro", basedOnTurnNumber: null, answerEvidence: "" }
  }), /forced initial question failure/);
  db.exec("DROP TRIGGER fail_initial_interview_question");
  assert.strictEqual(db.prepare("SELECT count(*) AS n FROM mock_interview_sessions").get().n, 0,
    "failed initial question must roll back the session row");

  const session = storage.createMockInterviewSession(db, {
    profileId: owner.profileId,
    planId: owner.planId,
    jobId,
    resumeVersionId: owner.resumeVersionId,
    context: frozenContext,
    settings: { type: "mixed", difficulty: "standard", plannedQuestions: 3 },
    initialQuestion: { text: "请介绍你和该岗位最相关的经历。", focus: "intro", basedOnTurnNumber: null, answerEvidence: "" },
    modelIdentity: { provider: "mock", model: "deterministic" }
  });
  assert.strictEqual(session.status, "active");
  assert.strictEqual(session.planId, owner.planId);
  assert.strictEqual(session.turns.length, 1);
  assert.deepStrictEqual(session.context, frozenContext);
  assert.strictEqual(session.contextHash, crypto.createHash("sha256").update(JSON.stringify(frozenContext)).digest("hex"));
  assert.strictEqual(storage.getMockInterviewSession(db, {
    profileId: other.profileId, planId: other.planId, sessionId: session.id
  }), null);
  assert.strictEqual(storage.getMockInterviewSession(db, {
    profileId: owner.profileId, planId: secondOwnerPlanId, sessionId: session.id
  }), null, "same-profile plans must not share interview sessions");
  assert.strictEqual(storage.listMockInterviewSessions(db, { profileId: other.profileId, planId: other.planId }).length, 0);

  const first = session.turns[0];
  assert.strictEqual(first.turnNumber, 1);
  assert.throws(() => storage.appendMockInterviewQuestion(db, {
    profileId: owner.profileId, planId: owner.planId,
    sessionId: session.id,
    question: { text: "不能跳过未回答问题", focus: "invalid", basedOnTurnNumber: 1, answerEvidence: "" }
  }), /回答/);

  const nextQuestion = {
    text: "你刚才提到“知识库”，具体贡献是什么？",
    focus: "project",
    basedOnTurnNumber: 1,
    answerEvidence: "知识库"
  };
  db.exec(`CREATE TRIGGER fail_interview_next_question BEFORE INSERT ON mock_interview_turns
    WHEN NEW.session_id = ${session.id} AND NEW.turn_number = 2
    BEGIN SELECT RAISE(ABORT, 'forced next question failure'); END;`);
  assert.throws(() => storage.answerMockInterviewTurn(db, {
    profileId: owner.profileId, planId: owner.planId, sessionId: session.id, turnNumber: 1,
    answerText: "我参与了企业知识库开发。",
    answerReview: { conclusion: "相关", strengths: ["直接"], improvements: ["补充贡献"], turnNumbers: [1] },
    nextQuestion
  }), /forced next question failure/);
  db.exec("DROP TRIGGER fail_interview_next_question");
  let rolledBack = storage.getMockInterviewSession(db, {
    profileId: owner.profileId, planId: owner.planId, sessionId: session.id
  });
  assert.strictEqual(rolledBack.turns.length, 1);
  assert.strictEqual(rolledBack.turns[0].answerText, "", "failed next question must roll back the answer");

  const answered = storage.answerMockInterviewTurn(db, {
    profileId: owner.profileId, planId: owner.planId, sessionId: session.id, turnNumber: 1,
    answerText: "我参与了企业知识库开发。",
    answerReview: { conclusion: "相关", strengths: ["直接"], improvements: ["补充贡献"], turnNumbers: [1] },
    nextQuestion
  });
  assert.strictEqual(answered.answerText, "我参与了企业知识库开发。");
  assert.strictEqual(storage.answerMockInterviewTurn(db, {
    profileId: owner.profileId, planId: owner.planId, sessionId: session.id, turnNumber: 1,
    answerText: "我参与了企业知识库开发。",
    answerReview: answered.answerReview,
    nextQuestion
  }).id, answered.id);
  assert.throws(() => storage.answerMockInterviewTurn(db, {
    profileId: owner.profileId, planId: owner.planId, sessionId: session.id, turnNumber: 1,
    answerText: "迟到的不同回答", answerReview: answered.answerReview
  }), /已经回答/);

  const afterAdvance = storage.getMockInterviewSession(db, {
    profileId: owner.profileId, planId: owner.planId, sessionId: session.id
  });
  const second = afterAdvance.turns[1];
  assert.strictEqual(second.turnNumber, 2);
  assert.strictEqual(second.basedOnTurnNumber, 1);
  assert.strictEqual(second.answerEvidence, "知识库");
  storage.answerMockInterviewTurn(db, {
    profileId: owner.profileId, planId: owner.planId, sessionId: session.id, turnNumber: 2,
    answerText: "我负责接口联调。",
    answerReview: { conclusion: "清楚", strengths: ["边界明确"], improvements: [], turnNumbers: [2] }
  });

  const report = {
    conclusion: "项目相关性较好。", strengths: ["直接"], improvements: ["补充结果"],
    followUpRisks: [{ turnNumber: 2, reason: "结果不足" }],
    retryRecommendations: [{ turnNumber: 2, reason: "补充结果" }],
    answerStructures: [{ turnNumber: 2, outline: ["背景", "行动", "结果"] }]
  };
  db.exec(`CREATE TRIGGER fail_interview_report BEFORE UPDATE OF report_json ON mock_interview_sessions
    WHEN NEW.id = ${session.id} BEGIN SELECT RAISE(ABORT, 'forced report failure'); END;`);
  assert.throws(() => storage.completeMockInterviewSession(db, {
    profileId: owner.profileId, planId: owner.planId, sessionId: session.id, report
  }), /forced report failure/);
  db.exec("DROP TRIGGER fail_interview_report");
  assert.strictEqual(storage.getMockInterviewSession(db, {
    profileId: owner.profileId, planId: owner.planId, sessionId: session.id
  }).status, "active");

  const completed = storage.completeMockInterviewSession(db, {
    profileId: owner.profileId, planId: owner.planId, sessionId: session.id, report
  });
  assert.strictEqual(completed.status, "completed");
  assert.deepStrictEqual(completed.report, report);
  assert.strictEqual(storage.completeMockInterviewSession(db, {
    profileId: owner.profileId, planId: owner.planId, sessionId: session.id, report
  }).id, session.id);
  assert.throws(() => storage.appendMockInterviewQuestion(db, {
    profileId: owner.profileId, planId: owner.planId, sessionId: session.id,
    question: { text: "迟到问题", focus: "invalid", basedOnTurnNumber: 2, answerEvidence: "接口" }
  }), /结束/);

  assert.throws(() => storage.recordMockInterviewRetry(db, {
    profileId: other.profileId, planId: other.planId, sessionId: session.id, turnNumber: 2,
    answerText: "越权重答", review: { turnNumber: 2 }
  }), /不存在|not found/i);
  const retry = storage.recordMockInterviewRetry(db, {
    profileId: owner.profileId, planId: owner.planId, sessionId: session.id, turnNumber: 2,
    answerText: "我负责接口联调，并完成三个接口验收。",
    review: { turnNumber: 2, conclusion: "更具体", improved: true, strengths: ["有结果"], remainingImprovements: [] }
  });
  assert.strictEqual(retry.retryIndex, 1);
  const loaded = storage.getMockInterviewSession(db, {
    profileId: owner.profileId, planId: owner.planId, sessionId: session.id
  });
  assert.strictEqual(loaded.turns.length, 2);
  assert.strictEqual(loaded.turns[1].retries.length, 1);

  console.log("mock_interview_store_smoke ok");
} finally {
  db.close();
}
