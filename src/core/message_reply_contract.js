const { VOLATILE_FACT_MAX_AGE_DAYS, factStatus } = require("./candidate_fact_policy");

const MESSAGE_CATEGORIES = new Set([
  "project_fact",
  "qualification",
  "salary",
  "availability",
  "interview_invitation",
  "other",
  "identity_uncertain"
]);
const STABLE_FACT_PREFIXES = ["gap.", "leaving_reason.", "short_project."];
const MAX_DRAFTS = 2;

function validateMessageReply(value, context = {}) {
  const normalized = normalizeReply(value);
  const facts = Array.isArray(context.facts) ? context.facts : [];
  const validFacts = new Map(facts.map((fact) => [String(fact.key || ""), fact]));
  const now = String(context.now || new Date().toISOString());
  assertKnownFactKeys(normalized);
  assertCoverageComplete(normalized);
  assertDraftLimit(normalized.messages, MAX_DRAFTS);
  assertInterviewHasNoDraft(normalized);
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
  const safeStage = safeReplyStage(normalized);
  return {
    ...normalized,
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
  const messageCategory = String(value.messageCategory || "").trim();
  if (!MESSAGE_CATEGORIES.has(messageCategory)) {
    throw contractError("MESSAGE_REPLY_CATEGORY_INVALID", "message category is invalid");
  }
  const requiredFactKeys = stringArray(value.requiredFactKeys, "requiredFactKeys");
  const usedFactKeys = stringArray(value.usedFactKeys, "usedFactKeys");
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
    messageCategory,
    requiredFactKeys,
    usedFactKeys,
    responseItems,
    coverage,
    missingFact,
    messages
  };
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

function assertInterviewHasNoDraft(normalized) {
  if (normalized.messageCategory === "interview_invitation" && normalized.messages.length) {
    throw contractError("MESSAGE_REPLY_INTERVIEW_NO_DRAFT", "interview invitations must not generate drafts");
  }
}

function safeReplyStage(normalized) {
  if (normalized.messageCategory === "interview_invitation") return "interview_invited";
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

function contractError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = {
  MESSAGE_CATEGORIES,
  MAX_DRAFTS,
  validateMessageReply
};
