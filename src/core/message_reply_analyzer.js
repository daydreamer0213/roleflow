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
    const input = {
      profile,
      job,
      messages: messages.map((message) => ({
        messageKey: message.messageKey,
        text: String(message.text || "")
      })),
      facts: normalizedFacts
    };
    try {
      const result = await adapter.draftMessageGroup(input);
      return validateMessageReply(result, { facts: input.facts, now });
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

module.exports = {
  createMessageReplyAnalyzer
};
