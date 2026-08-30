const { validateMessageReply } = require("./message_reply_contract");

function createMessageReplyAnalyzer({ adapter, logger = null } = {}) {
  if (!adapter || typeof adapter.draftMessageGroup !== "function") {
    throw new Error("message reply analyzer requires adapter.draftMessageGroup");
  }
  return async function analyzeMessageGroup(
    { profile, job, messages = [], facts = [], answerMemories = [], now } = {},
    { signal = null } = {}
  ) {
    const normalizedFacts = (facts || []).map((fact) => ({
      key: String(fact.key || fact.factKey || ""),
      value: fact.value !== undefined ? fact.value : fact.factValue,
      subjectKey: fact.subjectKey || "",
      updatedAt: fact.updatedAt || fact.confirmedAt || ""
    }));
    const requestedSubjectKeys = deriveRequestedSubjectKeys(messages, normalizedFacts);
    const scopedFacts = normalizedFacts.filter((fact) => factMatchesRequestedScope(fact, requestedSubjectKeys));
    const activeMemories = normalizeAnswerMemories(answerMemories)
      .filter((memory) => memoryMatchesContext(memory, job, requestedSubjectKeys));
    const input = {
      profile,
      job,
      messages: messages.map((message) => ({
        messageKey: message.messageKey,
        text: String(message.text || "")
      })),
      facts: scopedFacts,
      answerMemories: activeMemories,
      requestedSubjectKeys
    };
    try {
      const result = await adapter.draftMessageGroup(input, { signal });
      return validateMessageReply(result, {
        facts: input.facts,
        answerMemories: input.answerMemories,
        now,
        requestedSubjectKeys: input.requestedSubjectKeys
      });
    } catch (error) {
      if (typeof logger?.warn === "function") {
        logger.warn("message_reply_analyzer_failed", { code: String(error?.code || "MESSAGE_REPLY_FAILED") });
      }
      throw error;
    } finally {
      for (const message of messages || []) message.text = "";
      for (const memory of activeMemories) memory.finalAnswer = "";
    }
  };
}

function normalizeAnswerMemories(value) {
  const memories = [];
  let remaining = 8000;
  for (const item of Array.isArray(value) ? value : []) {
    if (memories.length >= 12 || remaining <= 0) break;
    const id = Number(item?.id);
    const source = String(item?.source || "");
    const withdrawnAt = String(item?.withdrawnAt || "");
    if (!Number.isSafeInteger(id) || id <= 0 || source !== "user_edited_reply" || withdrawnAt) continue;
    const finalAnswer = String(item?.finalAnswer ?? item?.finalText ?? "").trim().slice(0, remaining);
    if (!finalAnswer) continue;
    remaining -= finalAnswer.length;
    memories.push({
      id,
      questionSummary: String(item?.questionSummary || "").replace(/\s+/g, " ").trim().slice(0, 160),
      messageIntent: String(item?.messageIntent || "").slice(0, 80),
      messageCategory: String(item?.messageCategory || "").slice(0, 80),
      finalAnswer,
      scope: normalizeMemoryScope(item?.scope),
      updatedAt: String(item?.updatedAt || "").slice(0, 40)
    });
  }
  return memories;
}

function normalizeMemoryScope(value) {
  const scope = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const kind = ["global", "job", "company", "experience"].includes(scope.kind) ? scope.kind : "global";
  return { kind, key: String(scope.key || "").replace(/\s+/g, " ").trim().slice(0, 160) };
}

function memoryMatchesContext(memory, job = {}, requestedSubjectKeys = []) {
  const scope = memory?.scope || { kind: "global", key: "" };
  if (scope.kind === "global") return true;
  if (scope.kind === "job") {
    return [job?.id, job?.sourceId].map((value) => String(value || "").trim())
      .filter(Boolean).includes(scope.key);
  }
  if (scope.kind === "company") return scopeText(scope.key) === scopeText(job?.company);
  if (scope.kind === "experience") return requestedSubjectKeys.includes(scope.key);
  return false;
}

function deriveRequestedSubjectKeys(messages, facts) {
  const messageText = scopeText((messages || []).map((message) => message?.text).join(" "));
  if (!messageText) return [];
  return [...new Set((facts || []).map((fact) => stableFactSubject(fact)).filter((subject) => {
    const normalizedSubject = scopeText(subject);
    return normalizedSubject && messageText.includes(normalizedSubject);
  }))];
}

function stableFactSubject(fact = {}) {
  const key = String(fact.key || "");
  if (!["gap.", "leaving_reason.", "short_project."].some((prefix) => key.startsWith(prefix))) return "";
  return String(fact.subjectKey || key.split(".").slice(1).join(".")).trim();
}

function factMatchesRequestedScope(fact, requestedSubjectKeys) {
  const subject = stableFactSubject(fact);
  if (!subject) return true;
  return requestedSubjectKeys.includes(subject);
}

function scopeText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

module.exports = {
  createMessageReplyAnalyzer
};
