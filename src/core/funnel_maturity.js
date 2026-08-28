const DEFAULT_FORMAL_SAMPLE_TARGET = 50;
const MIN_FORMAL_SAMPLE_TARGET = 20;
const MAX_FORMAL_SAMPLE_TARGET = 500;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CHINA_OFFSET_MS = 8 * HOUR_MS;

const REPLY_EVENT_TYPES = new Set([
  "inbound_reply_observed",
  "incoming_message_classified",
  "message_group_classified",
  "resume_requested",
  "interview_invited",
  "interview_scheduled",
  "rejected",
  "opportunity_closed"
]);
const EFFECTIVE_MESSAGE_INTENTS = new Set([
  "interest_check",
  "information_request",
  "information_update",
  "interview_invitation"
]);

function normalizeFormalSampleTarget(value = DEFAULT_FORMAL_SAMPLE_TARGET) {
  const target = value === "" || value == null ? DEFAULT_FORMAL_SAMPLE_TARGET : Number(value);
  if (!Number.isInteger(target) || target < MIN_FORMAL_SAMPLE_TARGET || target > MAX_FORMAL_SAMPLE_TARGET) {
    throw new Error(`formal sample target must be between ${MIN_FORMAL_SAMPLE_TARGET} and ${MAX_FORMAL_SAMPLE_TARGET}`);
  }
  return target;
}

function feedbackMaturesAt(startedAt) {
  const deadline = timestamp(startedAt, "startedAt") + (48 * HOUR_MS);
  const chinaDay = new Date(deadline + CHINA_OFFSET_MS).getUTCDay();
  const weekendDays = chinaDay === 6 ? 2 : chinaDay === 0 ? 1 : 0;
  return new Date(deadline + (weekendDays * DAY_MS)).toISOString();
}

function readNoReplyMaturesAt(readObservedAt) {
  return feedbackMaturesAt(readObservedAt);
}

function diagnosisStrength(matureCount, formalSampleTarget = DEFAULT_FORMAL_SAMPLE_TARGET) {
  const count = Number(matureCount);
  if (!Number.isInteger(count) || count < 0) throw new Error("mature count must be a non-negative integer");
  const target = normalizeFormalSampleTarget(formalSampleTarget);
  if (count < MIN_FORMAL_SAMPLE_TARGET) return "facts";
  return count < target ? "preliminary" : "formal";
}

function projectFunnelEntry(entry = {}, rawEvents = [], { now = new Date().toISOString() } = {}) {
  const nowMs = timestamp(now, "now");
  const startedAt = new Date(timestamp(entry.startedAt, "entry.startedAt")).toISOString();
  const matureAt = entry.matureAt
    ? new Date(timestamp(entry.matureAt, "entry.matureAt")).toISOString()
    : feedbackMaturesAt(startedAt);
  const events = [...(Array.isArray(rawEvents) ? rawEvents : [])]
    .filter((item) => item && Number.isFinite(Date.parse(item.occurredAt)))
    .sort(compareEvents);
  const latestOutbound = lastEvent(events, (item) => [
    "outbound_read_observed",
    "outbound_delivered_observed"
  ].includes(item.type));
  const latestRead = lastEvent(events, (item) => item.type === "outbound_read_observed");
  const latestReply = lastEvent(events, (item) => REPLY_EVENT_TYPES.has(item.type));
  const latestEffective = lastEvent(events, isEffectiveEvent);
  const latestResume = lastEvent(events, (item) => item.type === "resume_requested");
  const latestInterviewInvite = lastEvent(events, isInterviewInvite);
  const latestInterviewConfirmed = lastEvent(events, (item) => item.type === "interview_scheduled");
  const latestRejected = lastEvent(events, (item) => item.type === "rejected");
  const latestClosed = lastEvent(events, (item) => ["closed", "opportunity_closed"].includes(item.type));

  const read = latestOutbound
    ? observedState(latestOutbound.type === "outbound_read_observed", latestOutbound)
    : unknownState();
  const replied = latestReply
    ? observedState(true, latestReply)
    : latestOutbound
      ? observedState(false, latestOutbound)
      : unknownState();
  const effectiveConversation = latestEffective
    ? observedState(true, latestEffective)
    : replied.value === false
      ? observedState(false, latestOutbound)
      : unknownState();

  const readDeadline = latestRead ? readNoReplyMaturesAt(latestRead.occurredAt) : null;
  const repliedAfterRead = latestRead && latestReply
    ? timestamp(latestReply.occurredAt, "event.occurredAt") > timestamp(latestRead.occurredAt, "event.occurredAt")
    : false;
  const terminalAfterRead = latestRead && (latestRejected || latestClosed)
    ? Math.max(
      latestRejected ? timestamp(latestRejected.occurredAt, "event.occurredAt") : 0,
      latestClosed ? timestamp(latestClosed.occurredAt, "event.occurredAt") : 0
    ) >= timestamp(latestRead.occurredAt, "event.occurredAt")
    : false;
  const mature = nowMs >= timestamp(matureAt, "entry.matureAt");
  const readNoReplyMature = Boolean(
    latestRead
    && !repliedAfterRead
    && !terminalAfterRead
    && nowMs >= timestamp(readDeadline, "readNoReplyMaturesAt")
  );
  const unknownFields = [
    ["read", read],
    ["replied", replied],
    ["effectiveConversation", effectiveConversation]
  ].filter(([, state]) => state.value === null).map(([name]) => name);

  return {
    id: Number(entry.id || 0) || null,
    startedAt,
    matureAt,
    started: true,
    read,
    replied,
    effectiveConversation,
    resumeRequested: presenceState(latestResume),
    interviewInvited: presenceState(latestInterviewInvite),
    interviewConfirmed: presenceState(latestInterviewConfirmed),
    rejected: presenceState(latestRejected),
    closed: presenceState(latestClosed),
    mature,
    readNoReplyMature,
    readNoReplyMaturesAt: readDeadline,
    waitingReason: !mature ? "feedback_window" : unknownFields.length === 3 ? "status_unknown" : "",
    unknownFields
  };
}

function buildFunnelSnapshot(entries = [], eventsByEntry = new Map(), {
  now = new Date().toISOString(),
  formalSampleTarget = DEFAULT_FORMAL_SAMPLE_TARGET
} = {}) {
  const target = normalizeFormalSampleTarget(formalSampleTarget);
  const projections = entries.map((entry) => projectFunnelEntry(
    entry,
    eventsForEntry(eventsByEntry, entry),
    { now }
  ));
  const matureEntries = projections.filter((item) => item.mature);
  const waiting = projections.length - matureEntries.length;
  const stages = {
    started: { numerator: projections.length, denominator: projections.length, unknown: 0, waiting: 0 },
    read: summarizeStage(matureEntries, "read", waiting),
    replied: summarizeStage(matureEntries, "replied", waiting),
    effectiveConversation: summarizeStage(matureEntries, "effectiveConversation", waiting),
    resumeRequested: summarizeStage(matureEntries, "resumeRequested", waiting),
    interviewInvited: summarizeStage(matureEntries, "interviewInvited", waiting),
    interviewConfirmed: summarizeStage(matureEntries, "interviewConfirmed", waiting)
  };
  return {
    started: projections.length,
    mature: matureEntries.length,
    waiting,
    unknown: matureEntries.filter((item) => item.waitingReason === "status_unknown").length,
    formalSampleTarget: target,
    strength: diagnosisStrength(matureEntries.length, target),
    stages,
    entries: projections
  };
}

function summarizeStage(projections, key, waiting) {
  const known = projections.filter((item) => item[key].value !== null);
  return {
    numerator: known.filter((item) => item[key].value === true).length,
    denominator: known.length,
    unknown: projections.length - known.length,
    waiting
  };
}

function eventsForEntry(eventsByEntry, entry) {
  if (eventsByEntry instanceof Map) return eventsByEntry.get(entry.id) || [];
  return eventsByEntry?.[entry.id] || [];
}

function isEffectiveEvent(event) {
  if (["resume_requested", "interview_invited", "interview_scheduled"].includes(event.type)) return true;
  if (!["incoming_message_classified", "message_group_classified"].includes(event.type)) return false;
  return EFFECTIVE_MESSAGE_INTENTS.has(String(event.metadata?.messageIntent || ""));
}

function isInterviewInvite(event) {
  return event.type === "interview_invited"
    || (["incoming_message_classified", "message_group_classified"].includes(event.type)
      && event.metadata?.messageIntent === "interview_invitation");
}

function lastEvent(events, predicate) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (predicate(events[index])) return events[index];
  }
  return null;
}

function compareEvents(left, right) {
  const time = timestamp(left.occurredAt, "event.occurredAt") - timestamp(right.occurredAt, "event.occurredAt");
  return time || Number(left.id || 0) - Number(right.id || 0);
}

function observedState(value, event) {
  return {
    value,
    source: eventSource(event),
    occurredAt: event.occurredAt
  };
}

function presenceState(event) {
  return event ? observedState(true, event) : unknownState();
}

function unknownState() {
  return { value: null, source: "unknown", occurredAt: null };
}

function eventSource(event) {
  const source = String(event?.metadata?.source || "").trim();
  if (["platform_observation", "user_record", "time_inference"].includes(source)) return source;
  if (event?.actor === "user") return "user_record";
  return "platform_observation";
}

function timestamp(value, name) {
  const parsed = Date.parse(String(value || ""));
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be ISO-compatible`);
  return parsed;
}

module.exports = {
  DEFAULT_FORMAL_SAMPLE_TARGET,
  MIN_FORMAL_SAMPLE_TARGET,
  MAX_FORMAL_SAMPLE_TARGET,
  normalizeFormalSampleTarget,
  feedbackMaturesAt,
  readNoReplyMaturesAt,
  diagnosisStrength,
  projectFunnelEntry,
  buildFunnelSnapshot
};
