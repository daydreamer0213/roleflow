const { validateMessageReply } = require("./message_reply_contract");

function createMessageReplyAnalyzer({ adapter, logger = null } = {}) {
  if (!adapter || typeof adapter.draftMessageGroup !== "function") {
    throw new Error("message reply analyzer requires adapter.draftMessageGroup");
  }
  return async function analyzeMessageGroup({ profile, job, messages = [], facts = [], now } = {}) {
    const normalizedFacts = (facts || []).map((fact) => ({
      key: String(fact.key || fact.factKey || ""),
      value: fact.value !== undefined ? fact.value : fact.factValue,
      subjectKey: fact.subjectKey || "",
      updatedAt: fact.updatedAt || fact.confirmedAt || ""
    }));
    const requestedSubjectKeys = deriveRequestedSubjectKeys(messages, normalizedFacts);
    const scopedFacts = normalizedFacts.filter((fact) => factMatchesRequestedScope(fact, requestedSubjectKeys));
    const input = {
      profile,
      job,
      messages: messages.map((message) => ({
        messageKey: message.messageKey,
        text: String(message.text || "")
      })),
      facts: scopedFacts,
      requestedSubjectKeys
    };
    try {
      const result = await adapter.draftMessageGroup(input);
      return validateMessageReply(result, {
        facts: input.facts,
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
    }
  };
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
