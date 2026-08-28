const { VOLATILE_FACT_MAX_AGE_DAYS, factStatus } = require("./candidate_fact_policy");

const MESSAGE_CATEGORIES = new Set([
  "project_fact",
  "qualification",
  "salary",
  "availability",
  "sensitive",
  "other",
  "identity_uncertain"
]);
const MESSAGE_INTENTS = new Set([
  "interview_invitation",
  "interest_check",
  "information_request",
  "information_update",
  "general_communication",
  "manual_review"
]);
const MANUAL_ONLY_CATEGORIES = new Set([
  "salary",
  "sensitive",
  "identity_uncertain"
]);
const STABLE_FACT_PREFIXES = ["gap.", "leaving_reason.", "short_project."];
const MAX_DRAFTS = 2;
const SAFE_INTERVIEW_DRAFT = "您好，感谢邀请，请问面试时间和形式如何安排？";

function validateMessageReply(value, context = {}) {
  const normalized = normalizeReply(value);
  const facts = Array.isArray(context.facts) ? context.facts : [];
  const validFacts = new Map(facts.map((fact) => [String(fact.key || ""), fact]));
  const answerMemories = Array.isArray(context.answerMemories) ? context.answerMemories : [];
  const validMemoryIds = new Set(answerMemories.map((memory) => Number(memory?.id)).filter((id) => Number.isSafeInteger(id) && id > 0));
  const now = String(context.now || new Date().toISOString());
  assertKnownFactKeys(normalized);
  assertCoverageComplete(normalized);
  assertDraftLimit(normalized.messages, MAX_DRAFTS);
  assertManualOnlyHasNoDraft(normalized);
  for (const key of normalized.usedFactKeys) {
    const fact = validFacts.get(key);
    if (!fact) {
      throw contractError("MESSAGE_REPLY_FACT_NOT_SUPPLIED", `used fact ${key} is not in the supplied valid fact set`);
    }
    if (isStableFactKey(key)
      && (!stableFactMatchesScope(key, fact) || !requestedSubjectMatches(key, context))) {
      throw contractError("MESSAGE_REPLY_FACT_UNVERIFIED", `used stable fact ${key} is outside the requested subject scope`);
    }
    if (factStatus(now, fact).status !== "valid") {
      throw contractError("MESSAGE_REPLY_FACT_UNVERIFIED", `used fact ${key} is missing, expired, or unverified`);
    }
  }
  const requiredStates = normalized.requiredFactKeys.map((key) => {
    const fact = validFacts.get(key);
    if (!fact) return { key, status: "missing" };
    if (isStableFactKey(key) && !stableFactMatchesScope(key, fact)) {
      return { key, status: "missing" };
    }
    if (isStableFactKey(key) && !requestedSubjectMatches(key, context)) {
      return { key, status: "missing" };
    }
    return { key, status: factStatus(now, fact).status };
  });
  const unverified = requiredStates.filter((item) => item.status !== "valid");
  if (unverified.length && normalized.messages.length) {
    throw contractError("MESSAGE_REPLY_FACT_UNVERIFIED", "cannot draft while a required fact is missing or expired");
  }
  for (const memoryId of normalized.usedMemoryIds) {
    if (!validMemoryIds.has(memoryId)) {
      throw contractError("MESSAGE_REPLY_MEMORY_NOT_SUPPLIED", `used answer memory ${memoryId} is not in the supplied active memory set`);
    }
  }
  const safeStage = safeReplyStage(normalized);
  const messages = MANUAL_ONLY_CATEGORIES.has(normalized.messageCategory)
    || normalized.messageIntent === "manual_review"
    ? []
    : normalized.messageIntent === "interview_invitation"
      ? [SAFE_INTERVIEW_DRAFT]
      : normalized.messages;
  return {
    ...normalized,
    messages,
    progressUpdate: {
      stage: safeStage,
      nextAction: safeReplyNextAction(safeStage)
    }
  };
}

function normalizeReply(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw contractError("MESSAGE_REPLY_INVALID", "message reply must be an object");
  }
  const messageIntent = String(value.messageIntent || "").trim();
  if (!MESSAGE_INTENTS.has(messageIntent)) {
    throw contractError("MESSAGE_REPLY_INTENT_INVALID", "message intent is invalid");
  }
  const messageCategory = String(value.messageCategory || "").trim();
  if (!MESSAGE_CATEGORIES.has(messageCategory)) {
    throw contractError("MESSAGE_REPLY_CATEGORY_INVALID", "message category is invalid");
  }
  const messageSummary = normalizedMessageSummary(value.messageSummary);
  const requiredFactKeys = stringArray(value.requiredFactKeys, "requiredFactKeys");
  const usedFactKeys = stringArray(value.usedFactKeys, "usedFactKeys");
  const usedMemoryIds = positiveIntegerArray(value.usedMemoryIds);
  const responseItems = arrayValue(value.responseItems, "responseItems").map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw contractError("MESSAGE_REPLY_INVALID", "response item must be an object");
    }
    const id = String(item.id || "").trim();
    const kind = String(item.kind || "").trim();
    if (!id || !["question", "statement"].includes(kind)) {
      throw contractError("MESSAGE_REPLY_INVALID", `response item ${index} is invalid`);
    }
    return { id, kind, required: Boolean(item.required) };
  });
  const coverage = arrayValue(value.coverage, "coverage").map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw contractError("MESSAGE_REPLY_INVALID", "coverage item must be an object");
    }
    return {
      responseItemId: String(item.responseItemId || "").trim(),
      covered: Boolean(item.covered)
    };
  });
  const messages = arrayValue(value.messages, "messages").map((item, index) => {
    const text = String(item == null ? "" : item).trim();
    if (!text) throw contractError("MESSAGE_REPLY_INVALID", `message ${index} is empty`);
    return text;
  });
  const missingFact = value.missingFact == null ? null : value.missingFact;
  if (missingFact && (!missingFact.key || !missingFact.question)) {
    throw contractError("MESSAGE_REPLY_INVALID", "missingFact must contain key and question");
  }
  return {
    messageIntent,
    messageCategory,
    messageSummary,
    requiredFactKeys,
    usedFactKeys,
    usedMemoryIds,
    responseItems,
    coverage,
    missingFact,
    messages
  };
}

function normalizedMessageSummary(value) {
  if (typeof value !== "string") {
    throw contractError("MESSAGE_REPLY_SUMMARY_INVALID", "messageSummary must be a string");
  }
  const summary = value.replace(/\s+/g, " ").trim();
  if (!summary || summary.length > 160) {
    throw contractError("MESSAGE_REPLY_SUMMARY_INVALID", "messageSummary must contain 1 to 160 characters");
  }
  return summary;
}

function assertKnownFactKeys(normalized) {
  const ids = [
    ...normalized.requiredFactKeys,
    ...normalized.usedFactKeys,
    ...normalized.responseItems.map((item) => item.id)
  ];
  for (const id of ids) {
    if (!isKnownFactKey(id)) {
      throw contractError("MESSAGE_REPLY_UNKNOWN_FACT", `unknown fact key ${id}`);
    }
  }
}

function assertCoverageComplete(normalized) {
  const responseIds = new Set(normalized.responseItems.map((item) => item.id));
  for (const entry of normalized.coverage) {
    if (!responseIds.has(entry.responseItemId)) {
      throw contractError("MESSAGE_REPLY_COVERAGE_INVALID", "coverage references an unknown response item");
    }
  }
  for (const item of normalized.responseItems) {
    const entry = normalized.coverage.find((candidate) => candidate.responseItemId === item.id);
    if (!entry) throw contractError("MESSAGE_REPLY_COVERAGE_INVALID", `response item ${item.id} has no coverage`);
    if (item.required && !entry.covered && normalized.messages.length) {
      throw contractError("MESSAGE_REPLY_COVERAGE_INCOMPLETE", "required response item is not covered");
    }
  }
}

function assertDraftLimit(messages, limit) {
  if (messages.length > limit) {
    throw contractError("MESSAGE_REPLY_DRAFT_LIMIT", `at most ${limit} drafts are allowed`);
  }
}

function assertManualOnlyHasNoDraft(normalized) {
  const manualOnly = MANUAL_ONLY_CATEGORIES.has(normalized.messageCategory)
    || normalized.messageIntent === "manual_review";
  if (!manualOnly || !normalized.messages.length) return;
  throw contractError("MESSAGE_REPLY_MANUAL_ONLY", "this message category requires manual handling");
}

function safeReplyStage(normalized) {
  if (normalized.messageIntent === "interview_invitation") return "interview_invited";
  if (normalized.messageIntent === "manual_review") return "needs_user_action";
  return normalized.messages.length ? "reply_ready" : "needs_user_action";
}

function safeReplyNextAction(stage) {
  return {
    contact_started: "Review communication status",
    waiting_reply: "Wait for recruiter reply",
    needs_user_action: "Provide required information",
    reply_ready: "Review draft before manual send",
    interview_invited: "Review interview invitation",
    interview_scheduled: "Review interview schedule",
    resume_submitted: "Wait for recruiter reply",
    rejected: "Opportunity rejected",
    closed: "Opportunity closed"
  }[stage] || "Review next step";
}

function isKnownFactKey(key) {
  return Object.hasOwn(VOLATILE_FACT_MAX_AGE_DAYS, key) || isStableFactKey(key);
}

function isStableFactKey(key) {
  return STABLE_FACT_PREFIXES.some((prefix) => String(key || "").startsWith(prefix));
}

function stableFactMatchesScope(key, fact) {
  const subject = stableSubjectFromKey(key);
  return String(fact.key || "") === key
    || String(fact.subjectKey || "") === subject;
}

function requestedSubjectMatches(key, context) {
  const requestedSubjects = Array.isArray(context.requestedSubjectKeys)
    ? context.requestedSubjectKeys
    : [];
  if (!requestedSubjects.length) return false;
  return requestedSubjects.some((subject) => String(subject) === stableSubjectFromKey(key));
}

function stableSubjectFromKey(key) {
  return String(key || "").split(".").slice(1).join(".");
}

function stringArray(value, name) {
  if (!Array.isArray(value)) throw contractError("MESSAGE_REPLY_INVALID", `${name} must be an array`);
  return value.map((item) => String(item == null ? "" : item).trim()).filter(Boolean);
}

function arrayValue(value, name) {
  if (!Array.isArray(value)) throw contractError("MESSAGE_REPLY_INVALID", `${name} must be an array`);
  return value;
}

function positiveIntegerArray(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw contractError("MESSAGE_REPLY_INVALID", "usedMemoryIds must be an array");
  const result = [];
  const seen = new Set();
  for (const item of value) {
    const id = Number(item);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw contractError("MESSAGE_REPLY_INVALID", "usedMemoryIds must contain positive integers");
    }
    if (!seen.has(id)) result.push(id);
    seen.add(id);
  }
  return result;
}

function contractError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = {
  MESSAGE_CATEGORIES,
  MESSAGE_INTENTS,
  MANUAL_ONLY_CATEGORIES,
  MAX_DRAFTS,
  isKnownFactKey,
  validateMessageReply
};
