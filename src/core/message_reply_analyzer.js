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
      const manualCategory = manualCategoryForMessages(input.messages);
      return validateMessageReply(manualCategory ? manualOnlyReply(manualCategory) : result, {
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

function manualCategoryForMessages(messages) {
  const text = (messages || []).map((message) => String(message?.text || "")).join(" ");
  if (/身份证|证件|隐私|账号|账户|家庭|婚育|住址|private|identity card/i.test(text)) return "sensitive";
  if (/面试|邀约|interview/i.test(text)) return "interview_invitation";
  if (/薪资|薪酬|工资|月薪|年薪|salary|compensation/i.test(text)) return "salary";
  if (/哪个岗位|什么岗位|哪个职位|什么职位|岗位不清楚|identity uncertain/i.test(text)) return "identity_uncertain";
  return "";
}

function manualOnlyReply(messageCategory) {
  return {
    messageCategory,
    requiredFactKeys: [],
    usedFactKeys: [],
    responseItems: [],
    coverage: [],
    missingFact: null,
    messages: []
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
