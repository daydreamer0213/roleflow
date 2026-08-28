const DEFAULT_PRELIMINARY_SAMPLE_TARGET = 30;
const DEFAULT_COMPARABLE_SAMPLE_TARGET = 50;
const DEFAULT_FORMAL_SAMPLE_TARGET = 70;
const MIN_SAMPLE_TARGET = 10;
const MAX_SAMPLE_TARGET = 500;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CHINA_OFFSET_MS = 8 * HOUR_MS;

const REPLY_EVENT_TYPES = new Set([
  "inbound_reply_observed",
  "incoming_message_classified",
  "message_group_classified",
  "resume_requested",
  "interview_invited",
  "interview_scheduled"
]);
const EFFECTIVE_MESSAGE_INTENTS = new Set([
  "interest_check",
  "information_request",
  "information_update",
  "interview_invitation"
]);

function normalizeFunnelSamplePolicy(value = {}) {
  const input = value && typeof value === "object" ? value : {};
  const policy = {
    preliminarySampleTarget: sampleTarget(input.preliminarySampleTarget, DEFAULT_PRELIMINARY_SAMPLE_TARGET),
    comparableSampleTarget: sampleTarget(input.comparableSampleTarget, DEFAULT_COMPARABLE_SAMPLE_TARGET),
    formalSampleTarget: sampleTarget(input.formalSampleTarget, DEFAULT_FORMAL_SAMPLE_TARGET)
  };
  if (!(policy.preliminarySampleTarget < policy.comparableSampleTarget
    && policy.comparableSampleTarget < policy.formalSampleTarget)) {
    throw new Error("funnel sample targets must strictly increase");
  }
  return policy;
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

function diagnosisStrength(matureCount, samplePolicy = {}) {
  const count = Number(matureCount);
  if (!Number.isInteger(count) || count < 0) throw new Error("mature count must be a non-negative integer");
  const policy = normalizeFunnelSamplePolicy(samplePolicy);
  if (count < policy.preliminarySampleTarget) return "facts";
  if (count < policy.comparableSampleTarget) return "preliminary";
  if (count < policy.formalSampleTarget) return "comparable";
  return "formal";
}

function projectFunnelEntry(entry = {}, rawEvents = [], { now = new Date().toISOString() } = {}) {
  const nowMs = timestamp(now, "now");
  const startedAt = new Date(timestamp(entry.startedAt, "entry.startedAt")).toISOString();
  const matureAt = entry.matureAt
    ? new Date(timestamp(entry.matureAt, "entry.matureAt")).toISOString()
    : feedbackMaturesAt(startedAt);
  const events = [...(Array.isArray(rawEvents) ? rawEvents : [])]
    .filter((item) => item && Number.isFinite(Date.parse(item.occurredAt)))
    .filter((item) => timestamp(item.occurredAt, "event.occurredAt") >= timestamp(startedAt, "entry.startedAt"))
    .sort(compareEvents);
  const mature = nowMs >= timestamp(matureAt, "entry.matureAt");
  const latestOutbound = lastEvent(events, (item) => [
    "outbound_read_observed",
    "outbound_delivered_observed"
  ].includes(item.type));
  const latestRead = latestOutbound?.type === "outbound_read_observed" ? latestOutbound : null;
  const anyRead = lastEvent(events, (item) => item.type === "outbound_read_observed");
  const latestReply = lastEvent(events, (item) => REPLY_EVENT_TYPES.has(item.type));
  const latestEffective = lastEvent(events, isEffectiveEvent);
  const latestClassifiedReply = lastEvent(events, (item) => [
    "incoming_message_classified",
    "message_group_classified"
  ].includes(item.type));
  const latestResume = lastEvent(events, (item) => item.type === "resume_requested");
  const current = authoritativeCurrentState(events);
  const terminalCurrent = Boolean(
    current.rejected?.value === true || current.closed?.value === true
  );
  const terminalWithoutReply = Boolean(
    terminalCurrent && !latestReply
  );

  const read = anyRead
    ? observedState(true, anyRead)
    : latestReply
      ? inferredPositiveState(latestReply)
      : mature && latestOutbound?.type === "outbound_delivered_observed"
        ? observedState(false, latestOutbound)
        : unknownState();
  const readDeadline = latestRead ? readNoReplyMaturesAt(latestRead.occurredAt) : null;
  const replyAfterLatestRead = Boolean(latestRead && latestReply
    && timestamp(latestReply.occurredAt, "event.occurredAt")
      >= timestamp(latestRead.occurredAt, "event.occurredAt"));
  const readNoReplyMature = Boolean(
    latestRead
    && !terminalCurrent
    && !replyAfterLatestRead
    && nowMs >= timestamp(readDeadline, "readNoReplyMaturesAt")
  );
  const replyWindowWaiting = Boolean(
    mature
    && latestRead
    && !terminalCurrent
    && !replyAfterLatestRead
    && nowMs < timestamp(readDeadline, "readNoReplyMaturesAt")
  );
  const replied = latestReply
    ? observedState(true, latestReply)
    : readNoReplyMature
      ? inferredNegativeState(readDeadline)
      : mature && latestOutbound?.type === "outbound_delivered_observed"
        ? inferredNegativeState(matureAt)
        : unknownState();
  const effectiveConversation = latestEffective
    ? observedState(true, latestEffective)
    : replied.value === false
      ? observedState(false, latestOutbound)
      : mature && replied.value === true && latestClassifiedReply && latestReply
        && timestamp(latestClassifiedReply.occurredAt, "event.occurredAt")
          >= timestamp(latestReply.occurredAt, "event.occurredAt")
        ? inferredNegativeState(matureAt)
        : unknownState();
  const resumeRequested = latestResume
    ? presenceState(latestResume)
    : mature && effectiveConversation.value === true
      ? inferredNegativeState(matureAt)
      : unknownState();
  const interviewInvited = current.interviewInvited
    || (mature && effectiveConversation.value === true
      ? inferredNegativeState(matureAt)
      : unknownState());
  const interviewConfirmed = current.interviewConfirmed
    || (mature && interviewInvited.value === true
      ? inferredNegativeState(matureAt)
      : unknownState());
  const unknownFields = terminalWithoutReply ? [] : [
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
    resumeRequested,
    interviewInvited,
    interviewConfirmed,
    rejected: current.rejected || unknownState(),
    closed: current.closed || unknownState(),
    mature,
    readNoReplyMature,
    replyWindowWaiting,
    terminalCurrent,
    terminalWithoutReply,
    readNoReplyMaturesAt: readDeadline,
    waitingReason: !mature
      ? "feedback_window"
      : replyWindowWaiting
        ? "reply_window"
        : unknownFields.length
          ? "status_unknown"
          : "",
    unknownFields
  };
}

function buildFunnelSnapshot(entries = [], eventsByEntry = new Map(), {
  now = new Date().toISOString(),
  samplePolicy = {}
} = {}) {
  const policy = normalizeFunnelSamplePolicy(samplePolicy);
  const projections = entries.map((entry) => projectFunnelEntry(
    entry,
    eventsForEntry(eventsByEntry, entry),
    { now }
  ));
  const matureEntries = projections.filter((item) => item.mature);
  const feedbackWaiting = projections.length - matureEntries.length;
  const replyWaiting = matureEntries.filter((item) => item.replyWindowWaiting).length;
  const waiting = feedbackWaiting + replyWaiting;
  const stages = {
    started: { numerator: projections.length, denominator: projections.length, unknown: 0, waiting: 0 },
    read: summarizeStage(
      matureEntries,
      "read",
      feedbackWaiting,
      (item) => !item.terminalWithoutReply || item.read.value === true
    ),
    replied: summarizeStage(
      matureEntries,
      "replied",
      feedbackWaiting,
      (item) => item.read.value === true && !item.terminalWithoutReply,
      (item) => item.replyWindowWaiting
    ),
    effectiveConversation: summarizeStage(matureEntries, "effectiveConversation", feedbackWaiting, (item) => item.replied.value === true),
    resumeRequested: summarizeStage(matureEntries, "resumeRequested", feedbackWaiting, (item) => item.effectiveConversation.value === true),
    interviewInvited: summarizeStage(matureEntries, "interviewInvited", feedbackWaiting, (item) => item.effectiveConversation.value === true),
    interviewConfirmed: summarizeStage(matureEntries, "interviewConfirmed", feedbackWaiting, (item) => item.interviewInvited.value === true)
  };
  return {
    started: projections.length,
    mature: matureEntries.length,
    waiting,
    unknown: matureEntries.filter((item) => item.unknownFields.length > 0).length,
    policy,
    strength: diagnosisStrength(matureEntries.length, policy),
    stages,
    immediatePositive: positiveCounts(projections),
    earlyPositive: positiveCounts(projections.filter((item) => !item.mature)),
    entries: projections
  };
}

function summarizeStage(projections, key, waiting, eligible = () => true, stageWaiting = () => false) {
  const eligibleRows = projections.filter(eligible);
  const waitingRows = eligibleRows.filter(stageWaiting);
  const settledRows = eligibleRows.filter((item) => !stageWaiting(item));
  const known = settledRows.filter((item) => item[key].value !== null);
  return {
    numerator: known.filter((item) => item[key].value === true).length,
    denominator: known.length,
    unknown: settledRows.length - known.length,
    waiting: waiting + waitingRows.length
  };
}

function positiveCounts(projections) {
  return Object.fromEntries([
    "read",
    "replied",
    "effectiveConversation",
    "resumeRequested",
    "interviewInvited",
    "interviewConfirmed"
  ].map((key) => [key, projections.filter((item) => item[key].value === true).length]));
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

function authoritativeCurrentState(events) {
  const terminalEvent = lastEvent(events, (item) => [
    "rejected",
    "closed",
    "opportunity_closed"
  ].includes(item.type) || (isUserAuthority(item) && [
    "opportunity_reopened",
    "manual_correction"
  ].includes(item.type)));
  const interviewEvent = lastEvent(events, (item) => isInterviewInvite(item)
    || item.type === "interview_scheduled"
    || (isUserAuthority(item) && item.type === "manual_correction"));
  return {
    ...terminalState(terminalEvent),
    ...interviewState(interviewEvent)
  };
}

function terminalState(event) {
  if (!event) return { rejected: null, closed: null };
  const stage = event.type === "manual_correction" ? String(event.metadata?.toStage || "") : "";
  if (event.type === "rejected" || stage === "rejected") {
    return { rejected: observedState(true, event), closed: observedState(false, event) };
  }
  if (["closed", "opportunity_closed"].includes(event.type) || stage === "closed") {
    return { rejected: observedState(false, event), closed: observedState(true, event) };
  }
  return { rejected: observedState(false, event), closed: observedState(false, event) };
}

function interviewState(event) {
  if (!event) return { interviewInvited: null, interviewConfirmed: null };
  const stage = event.type === "manual_correction" ? String(event.metadata?.toStage || "") : "";
  if (event.type === "interview_scheduled" || stage === "interview_scheduled") {
    return {
      interviewInvited: observedState(true, event),
      interviewConfirmed: observedState(true, event)
    };
  }
  if (isInterviewInvite(event) || stage === "interview_invited") {
    return {
      interviewInvited: observedState(true, event),
      interviewConfirmed: observedState(false, event)
    };
  }
  return {
    interviewInvited: observedState(false, event),
    interviewConfirmed: observedState(false, event)
  };
}

function isUserAuthority(event) {
  return event?.actor === "user" || event?.metadata?.source === "user_record";
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

function inferredNegativeState(occurredAt) {
  return { value: false, source: "time_inference", occurredAt };
}

function inferredPositiveState(event) {
  return { value: true, source: "time_inference", occurredAt: event.occurredAt };
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

function sampleTarget(value, fallback) {
  const target = value === "" || value == null ? fallback : Number(value);
  if (!Number.isInteger(target) || target < MIN_SAMPLE_TARGET || target > MAX_SAMPLE_TARGET) {
    throw new Error(`funnel sample targets must be between ${MIN_SAMPLE_TARGET} and ${MAX_SAMPLE_TARGET}`);
  }
  return target;
}

module.exports = {
  DEFAULT_PRELIMINARY_SAMPLE_TARGET,
  DEFAULT_COMPARABLE_SAMPLE_TARGET,
  DEFAULT_FORMAL_SAMPLE_TARGET,
  MIN_SAMPLE_TARGET,
  MAX_SAMPLE_TARGET,
  normalizeFunnelSamplePolicy,
  feedbackMaturesAt,
  readNoReplyMaturesAt,
  diagnosisStrength,
  projectFunnelEntry,
  buildFunnelSnapshot
};
