const crypto = require("node:crypto");
const { nowIso, parseJson, immediateTransaction, storageError } = require("./storage_shared");

function sha256(text) {
  return crypto.createHash("sha256").update(String(text ?? "")).digest("hex");
}

function positiveId(value, label) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new TypeError(`${label} must be a positive integer`);
  return id;
}

function requiredText(value, label, maxLength = 20_000) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label}不能为空`);
  if (text.length > maxLength) throw new Error(`${label}过长`);
  return text;
}

function questionInput(value = {}) {
  const basedOn = value.basedOnTurnNumber;
  return {
    text: requiredText(value.text, "问题", 4_000),
    focus: requiredText(value.focus, "问题重点", 120),
    basedOnTurnNumber: basedOn == null || basedOn === "" ? null : Number(basedOn),
    answerEvidence: String(value.answerEvidence || "").trim().slice(0, 300)
  };
}

function retryRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    sessionId: Number(row.session_id),
    turnId: Number(row.turn_id),
    turnNumber: Number(row.turn_number),
    retryIndex: Number(row.retry_index),
    answerText: row.answer_text,
    review: parseJson(row.review_json, {}),
    createdAt: row.created_at
  };
}

function turnRow(row, retries = []) {
  if (!row) return null;
  return {
    id: Number(row.id),
    sessionId: Number(row.session_id),
    turnNumber: Number(row.turn_number),
    questionText: row.question_text,
    questionFocus: row.question_focus,
    basedOnTurnNumber: row.based_on_turn_number == null ? null : Number(row.based_on_turn_number),
    answerEvidence: row.answer_evidence || "",
    answerText: row.answer_text || "",
    answerReview: parseJson(row.answer_review_json, null),
    answeredAt: row.answered_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    retries
  };
}

function sessionRow(db, row) {
  if (!row) return null;
  const rawTurns = db.prepare("SELECT * FROM mock_interview_turns WHERE session_id = ? ORDER BY turn_number, id")
    .all(Number(row.id));
  const rawRetries = db.prepare(`SELECT r.*, t.turn_number
    FROM mock_interview_retries r JOIN mock_interview_turns t ON t.id = r.turn_id
    WHERE r.session_id = ? ORDER BY t.turn_number, r.retry_index, r.id`).all(Number(row.id));
  const retriesByTurnId = new Map();
  for (const retry of rawRetries) {
    const items = retriesByTurnId.get(Number(retry.turn_id)) || [];
    items.push(retryRow(retry));
    retriesByTurnId.set(Number(retry.turn_id), items);
  }
  return {
    id: Number(row.id),
    profileId: Number(row.profile_id),
    planId: Number(row.plan_id),
    jobId: Number(row.job_id),
    resumeVersionId: Number(row.resume_version_id),
    contextHash: row.context_hash,
    context: parseJson(row.context_json, {}),
    settings: parseJson(row.settings_json, {}),
    status: row.status,
    report: parseJson(row.report_json, null),
    modelIdentity: parseJson(row.model_identity_json, {}),
    completedAt: row.completed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    turns: rawTurns.map((turn) => turnRow(turn, retriesByTurnId.get(Number(turn.id)) || []))
  };
}

function ownedSessionRow(db, profileId, planId, sessionId) {
  return db.prepare("SELECT * FROM mock_interview_sessions WHERE id = ? AND profile_id = ? AND plan_id = ?")
    .get(
      positiveId(sessionId, "sessionId"),
      positiveId(profileId, "profileId"),
      positiveId(planId, "planId")
    );
}

function createMockInterviewSession(db, input = {}) {
  const profileId = positiveId(input.profileId, "profileId");
  const planId = positiveId(input.planId, "planId");
  const jobId = positiveId(input.jobId, "jobId");
  const resumeVersionId = positiveId(input.resumeVersionId, "resumeVersionId");
  const ownedPlan = db.prepare("SELECT id FROM search_plans WHERE id = ? AND profile_id = ?").get(planId, profileId);
  if (!ownedPlan) throw storageError("MOCK_INTERVIEW_PLAN_NOT_FOUND", "筛选方案不存在或不属于当前候选人");
  const ownedJob = db.prepare(`SELECT jobs.id FROM jobs
    WHERE jobs.id = ? AND EXISTS (
      SELECT 1 FROM job_observations o JOIN batches b ON b.id = o.batch_id
      WHERE o.job_id = jobs.id AND b.profile_id = ? AND b.search_plan_id = ?
    )`).get(jobId, profileId, planId);
  if (!ownedJob) throw storageError("MOCK_INTERVIEW_JOB_NOT_FOUND", "岗位不存在或不属于当前筛选方案");
  const ownedResume = db.prepare("SELECT id FROM candidate_resume_versions WHERE id = ? AND profile_id = ? AND is_active = 1")
    .get(resumeVersionId, profileId);
  if (!ownedResume) throw storageError("MOCK_INTERVIEW_RESUME_NOT_FOUND", "启用中的简历不存在或不属于当前候选人");
  if (!input.context || typeof input.context !== "object" || Array.isArray(input.context)) throw new Error("冻结面试上下文格式无效");
  if (!input.settings || typeof input.settings !== "object" || Array.isArray(input.settings)) throw new Error("面试设置格式无效");
  const initialQuestion = questionInput(input.initialQuestion);
  if (initialQuestion.basedOnTurnNumber !== null || initialQuestion.answerEvidence) throw new Error("首题不能引用上一回答");
  const contextJson = JSON.stringify(input.context);
  return immediateTransaction(db, () => {
    const now = nowIso();
    const result = db.prepare(`INSERT INTO mock_interview_sessions(
      profile_id, plan_id, job_id, resume_version_id, context_hash, context_json, settings_json,
      status, report_json, model_identity_json, completed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, NULL, ?, ?)`).run(
      profileId,
      planId,
      jobId,
      resumeVersionId,
      sha256(contextJson),
      contextJson,
      JSON.stringify(input.settings),
      JSON.stringify(input.modelIdentity || {}),
      now,
      now
    );
    const sessionId = Number(result.lastInsertRowid);
    insertQuestionRow(db, sessionId, initialQuestion, now);
    return sessionRow(db, db.prepare("SELECT * FROM mock_interview_sessions WHERE id = ?").get(sessionId));
  });
}

function getMockInterviewSession(db, { profileId, planId, sessionId }) {
  return sessionRow(db, ownedSessionRow(db, profileId, planId, sessionId));
}

function listMockInterviewSessions(db, input = {}) {
  const boundedLimit = Math.max(1, Math.min(100, Number(input.limit) || 30));
  return db.prepare(`SELECT * FROM mock_interview_sessions
    WHERE profile_id = ? AND plan_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?`)
    .all(positiveId(input.profileId, "profileId"), positiveId(input.planId, "planId"), boundedLimit)
    .map((row) => sessionRow(db, row));
}

function insertQuestionRow(db, sessionId, question, now = nowIso()) {
  const previous = db.prepare(`SELECT * FROM mock_interview_turns
    WHERE session_id = ? ORDER BY turn_number DESC, id DESC LIMIT 1`).get(sessionId);
  if (previous && !String(previous.answer_text || "").trim()) throw new Error("请先回答当前问题");
  const turnNumber = previous ? Number(previous.turn_number) + 1 : 1;
  const session = db.prepare("SELECT settings_json FROM mock_interview_sessions WHERE id = ?").get(sessionId);
  const plannedQuestions = Number(parseJson(session?.settings_json, {})?.plannedQuestions);
  if (!Number.isInteger(plannedQuestions) || turnNumber > plannedQuestions) {
    throw new Error("问题数量不能超过本轮计划题数");
  }
  const expectedBasedOn = previous ? Number(previous.turn_number) : null;
  if (question.basedOnTurnNumber !== expectedBasedOn) throw new Error("下一题必须承接上一题");
  if (previous && (!question.answerEvidence
    || !String(previous.answer_text).includes(question.answerEvidence)
    || !question.text.includes(question.answerEvidence))) {
    throw new Error("下一题必须包含上一回答的真实片段");
  }
  if (!previous && question.answerEvidence) throw new Error("首题不能包含上一回答片段");
  const result = db.prepare(`INSERT INTO mock_interview_turns(
    session_id, turn_number, question_text, question_focus, based_on_turn_number, answer_evidence,
    answer_text, answer_review_json, answered_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, '', NULL, NULL, ?, ?)`).run(
    sessionId,
    turnNumber,
    question.text,
    question.focus,
    question.basedOnTurnNumber,
    question.answerEvidence,
    now,
    now
  );
  db.prepare("UPDATE mock_interview_sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
  return turnRow(db.prepare("SELECT * FROM mock_interview_turns WHERE id = ?").get(Number(result.lastInsertRowid)));
}

function appendMockInterviewQuestion(db, input = {}) {
  const profileId = positiveId(input.profileId, "profileId");
  const planId = positiveId(input.planId, "planId");
  const sessionId = positiveId(input.sessionId, "sessionId");
  const question = questionInput(input.question);
  return immediateTransaction(db, () => {
    const session = ownedSessionRow(db, profileId, planId, sessionId);
    if (!session) throw storageError("MOCK_INTERVIEW_NOT_FOUND", "面试会话不存在");
    if (session.status !== "active") throw storageError("MOCK_INTERVIEW_COMPLETED", "面试已经结束");
    return insertQuestionRow(db, sessionId, question);
  });
}

function answerMockInterviewTurn(db, input = {}) {
  const profileId = positiveId(input.profileId, "profileId");
  const planId = positiveId(input.planId, "planId");
  const sessionId = positiveId(input.sessionId, "sessionId");
  const turnNumber = positiveId(input.turnNumber, "turnNumber");
  const answerText = requiredText(input.answerText, "回答", 20_000);
  if (!input.answerReview || typeof input.answerReview !== "object") throw new Error("回答复盘格式无效");
  const nextQuestion = input.nextQuestion == null ? null : questionInput(input.nextQuestion);
  return immediateTransaction(db, () => {
    const session = ownedSessionRow(db, profileId, planId, sessionId);
    if (!session) throw storageError("MOCK_INTERVIEW_NOT_FOUND", "面试会话不存在");
    if (session.status !== "active") throw storageError("MOCK_INTERVIEW_COMPLETED", "面试已经结束");
    const row = db.prepare("SELECT * FROM mock_interview_turns WHERE session_id = ? AND turn_number = ?")
      .get(sessionId, turnNumber);
    if (!row) throw storageError("MOCK_INTERVIEW_TURN_NOT_FOUND", "面试题不存在");
    if (String(row.answer_text || "").trim()) {
      if (row.answer_text === answerText) return turnRow(row);
      throw storageError("MOCK_INTERVIEW_TURN_ALREADY_ANSWERED", "当前问题已经回答");
    }
    const now = nowIso();
    db.prepare(`UPDATE mock_interview_turns SET answer_text = ?, answer_review_json = ?, answered_at = ?, updated_at = ?
      WHERE id = ?`).run(answerText, JSON.stringify(input.answerReview), now, now, Number(row.id));
    db.prepare("UPDATE mock_interview_sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
    if (nextQuestion) insertQuestionRow(db, sessionId, nextQuestion, now);
    return turnRow(db.prepare("SELECT * FROM mock_interview_turns WHERE id = ?").get(Number(row.id)));
  });
}

function completeMockInterviewSession(db, input = {}) {
  const profileId = positiveId(input.profileId, "profileId");
  const planId = positiveId(input.planId, "planId");
  const sessionId = positiveId(input.sessionId, "sessionId");
  if (!input.report || typeof input.report !== "object" || Array.isArray(input.report)) throw new Error("面试复盘格式无效");
  const reportJson = JSON.stringify(input.report);
  return immediateTransaction(db, () => {
    const row = ownedSessionRow(db, profileId, planId, sessionId);
    if (!row) throw storageError("MOCK_INTERVIEW_NOT_FOUND", "面试会话不存在");
    if (row.status === "completed") {
      return sessionRow(db, row);
    }
    const counts = db.prepare(`SELECT count(*) AS total,
      sum(CASE WHEN trim(answer_text) = '' THEN 1 ELSE 0 END) AS unanswered
      FROM mock_interview_turns WHERE session_id = ?`).get(sessionId);
    if (!Number(counts.total)) throw new Error("面试还没有题目");
    if (Number(counts.unanswered)) throw new Error("请先回答当前问题");
    const plannedQuestions = Number(parseJson(row.settings_json, {})?.plannedQuestions);
    if (!Number.isInteger(plannedQuestions) || Number(counts.total) !== plannedQuestions) {
      throw new Error("已回答题数必须等于本轮计划题数");
    }
    const now = nowIso();
    db.prepare(`UPDATE mock_interview_sessions SET status = 'completed', report_json = ?,
      completed_at = ?, updated_at = ? WHERE id = ? AND profile_id = ? AND status = 'active'`)
      .run(reportJson, now, now, sessionId, profileId);
    return sessionRow(db, db.prepare("SELECT * FROM mock_interview_sessions WHERE id = ?").get(sessionId));
  });
}

function recordMockInterviewRetry(db, input = {}) {
  const profileId = positiveId(input.profileId, "profileId");
  const planId = positiveId(input.planId, "planId");
  const sessionId = positiveId(input.sessionId, "sessionId");
  const turnNumber = positiveId(input.turnNumber, "turnNumber");
  const answerText = requiredText(input.answerText, "重答", 20_000);
  if (!input.review || typeof input.review !== "object" || Array.isArray(input.review)) throw new Error("重答复盘格式无效");
  return immediateTransaction(db, () => {
    const session = ownedSessionRow(db, profileId, planId, sessionId);
    if (!session) throw storageError("MOCK_INTERVIEW_NOT_FOUND", "面试会话不存在");
    if (session.status !== "completed") throw new Error("面试结束后才能重练");
    const turn = db.prepare(`SELECT * FROM mock_interview_turns
      WHERE session_id = ? AND turn_number = ? AND trim(answer_text) <> ''`).get(sessionId, turnNumber);
    if (!turn) throw storageError("MOCK_INTERVIEW_TURN_NOT_FOUND", "已回答的面试题不存在");
    const previous = db.prepare(`SELECT r.*, t.turn_number FROM mock_interview_retries r
      JOIN mock_interview_turns t ON t.id = r.turn_id
      WHERE r.session_id = ? AND r.turn_id = ? ORDER BY r.retry_index DESC, r.id DESC LIMIT 1`)
      .get(sessionId, Number(turn.id));
    if (previous && previous.answer_text === answerText) return retryRow(previous);
    const retryIndex = previous ? Number(previous.retry_index) + 1 : 1;
    const now = nowIso();
    const result = db.prepare(`INSERT INTO mock_interview_retries(
      session_id, turn_id, retry_index, answer_text, review_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`).run(
      sessionId, Number(turn.id), retryIndex, answerText, JSON.stringify(input.review), now
    );
    db.prepare("UPDATE mock_interview_sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
    const row = db.prepare(`SELECT r.*, t.turn_number FROM mock_interview_retries r
      JOIN mock_interview_turns t ON t.id = r.turn_id WHERE r.id = ?`).get(Number(result.lastInsertRowid));
    return retryRow(row);
  });
}

module.exports = {
  createMockInterviewSession,
  getMockInterviewSession,
  listMockInterviewSessions,
  appendMockInterviewQuestion,
  answerMockInterviewTurn,
  completeMockInterviewSession,
  recordMockInterviewRetry
};
