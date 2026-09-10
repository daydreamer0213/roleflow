const { createHash } = require('node:crypto');

const PLATFORMS = new Set(['boss', 'zhaopin']);
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const INTERVIEW_INTENT = 'interview_invitation';
const HISTORY_EVENT_TYPES = new Set([
  'resume_requested',
  'interview_invited',
  'interview_scheduled',
  'incoming_message_classified',
  'message_group_classified'
]);
const EXPLICIT_RESUME_REQUEST = /^(?:请|麻烦|方便|劳烦)(?:你|您)?(?:发|发送|提供|传)(?:一份|一|份|下|个)?(?:详细|完整)?的?简历(?:给我|过来|一下)?吗?[。！？?!]*$|^(?:请|麻烦|方便|劳烦)(?:你|您)?(?:把)?(?:一份|一|份|下|个)?(?:详细|完整)?的?简历(?:发|发送|提供|传)(?:给我|过来|一下)?吗?[。！？?!]*$/;

function listIncomingContacts(db, { profileId } = {}) {
  const profile = positiveInteger(profileId, 'profileId');
  const contacts = new Map();
  const add = input => addContact(contacts, input);

  for (const row of linkedContexts(db, profile)) {
    add({
      profileId: profile,
      platform: row.platform,
      conversationKey: row.conversation_key,
      cardId: row.card_id,
      jobId: row.job_id,
      title: row.title,
      company: row.company,
      observedAt: row.updated_at,
      inboundMessages: safeInboundMessages(row.display_json),
      resumeRequested: resumeAction(row.manual_actions_json),
      messageIntent: row.message_intent,
      sourceKind: 'context'
    });
  }

  for (const row of classifiedHistory(db, profile)) {
    const metadata = safeObject(row.metadata_json);
    const manualInterview = row.actor === 'user'
      && (row.type === 'interview_invited' || row.type === 'interview_scheduled');
    if (!manualInterview && (metadata.threadKey !== row.thread_key || metadata.platform !== row.platform)) continue;
    const interviewInvited = manualInterview || row.type === 'interview_invited'
      || row.type === 'interview_scheduled'
      || ([ 'incoming_message_classified', 'message_group_classified' ].includes(row.type)
        && metadata.messageIntent === INTERVIEW_INTENT);
    add({
      profileId: profile,
      platform: row.platform,
      conversationKey: row.thread_key,
      cardId: row.card_id,
      jobId: row.job_id,
      title: row.title,
      company: row.company,
      observedAt: row.occurred_at,
      resumeRequested: row.type === 'resume_requested',
      interviewInvited,
      messageIntent: metadata.messageIntent,
      sourceKind: 'classification'
    });
  }

  for (const row of unresolvedItems(db, profile)) {
    const inboundMessages = safeInboundMessages(row.inbound_json);
    if (!inboundMessages.length) continue;
    add({
      profileId: profile,
      platform: row.platform,
      conversationKey: row.conversation_key,
      title: row.position_title,
      company: row.company,
      observedAt: row.last_observed_at,
      inboundMessages,
      resumeRequested: hasResumeRequestCard(inboundMessages) || explicitResumeRequest(inboundMessages),
      messageIntent: 'manual_review',
      sourceKind: 'unresolved'
    });
  }

  return [...contacts.values()]
    .map(contact => ({
      key: incomingContactKey(profile, contact.platform, contact.conversationKey),
      platform: contact.platform,
      conversationKey: contact.conversationKey,
      cardId: contact.cardId,
      jobId: contact.jobId,
      title: contact.title,
      company: contact.company,
      observedAt: contact.observedAt,
      resumeRequested: contact.resumeRequested,
      interviewInvited: contact.interviewInvited,
      inboundMessages: contact.inboundMessages.sort((left, right) => messageOrder(left) - messageOrder(right)
        || left.text.localeCompare(right.text)),
      messageIntent: contact.messageIntent || 'manual_review',
      sourceKinds: [...contact.sourceKinds].sort()
    }))
    .sort((left, right) => String(right.observedAt).localeCompare(String(left.observedAt))
      || left.platform.localeCompare(right.platform)
      || left.key.localeCompare(right.key));
}

function linkedContexts(db, profileId) {
  return db.prepare(`SELECT contexts.*, cards.source AS platform, cards.job_id, jobs.title, jobs.company
    FROM message_inbound_contexts contexts
    JOIN candidate_progress_cards cards ON cards.id = contexts.card_id
      AND cards.profile_id = contexts.profile_id
    JOIN jobs ON jobs.id = cards.job_id
    WHERE contexts.profile_id = ?
      AND cards.source = jobs.source
    ORDER BY contexts.updated_at DESC, contexts.id DESC`).all(profileId)
    .filter(row => PLATFORMS.has(row.platform));
}

function classifiedHistory(db, profileId) {
  const placeholders = [...HISTORY_EVENT_TYPES].map(() => '?').join(',');
  return db.prepare(`SELECT events.*, cards.source AS platform, cards.thread_key, cards.job_id, jobs.title, jobs.company
    FROM candidate_progress_events events
    JOIN candidate_progress_cards cards ON cards.id = events.card_id
    JOIN jobs ON jobs.id = cards.job_id
    WHERE cards.profile_id = ?
      AND cards.thread_key <> ''
      AND cards.source = jobs.source
      AND events.type IN (${placeholders})
    ORDER BY events.occurred_at DESC, events.id DESC`).all(profileId, ...HISTORY_EVENT_TYPES)
    .filter(row => PLATFORMS.has(row.platform));
}

function unresolvedItems(db, profileId) {
  return db.prepare(`SELECT * FROM message_discovery_unresolved_items
    WHERE profile_id = ?
    ORDER BY last_observed_at DESC, conversation_key ASC`).all(profileId)
    .filter(row => PLATFORMS.has(row.platform));
}

function addContact(contacts, input) {
  const platform = String(input.platform || '').trim();
  const conversationKey = String(input.conversationKey || '').trim().toLowerCase();
  if (!PLATFORMS.has(platform) || !DIGEST.test(conversationKey)) return;
  const identity = `${platform}\0${conversationKey}`;
  const observedAt = validTime(input.observedAt) ? input.observedAt : '';
  let contact = contacts.get(identity);
  if (!contact) {
    contact = {
      platform,
      conversationKey,
      cardId: null,
      jobId: null,
      title: '',
      company: '',
      observedAt,
      resumeRequested: false,
      interviewInvited: false,
      inboundMessages: [],
      messageIntent: '',
      intentObservedAt: '',
      sourceKinds: new Set()
    };
    contacts.set(identity, contact);
  }
  contact.sourceKinds.add(input.sourceKind);
  if (input.cardId !== null && input.cardId !== undefined) contact.cardId = positiveId(input.cardId);
  if (input.jobId !== null && input.jobId !== undefined) contact.jobId = positiveId(input.jobId);
  if (!contact.title && safeText(input.title, 400)) contact.title = safeText(input.title, 400);
  if (!contact.company && safeText(input.company, 400)) contact.company = safeText(input.company, 400);
  if (observedAt > contact.observedAt) contact.observedAt = observedAt;
  contact.resumeRequested ||= input.resumeRequested === true || hasResumeRequestCard(input.inboundMessages || [])
    || explicitResumeRequest(input.inboundMessages || []);
  contact.interviewInvited ||= input.interviewInvited === true;
  if (observedAt > contact.intentObservedAt && safeText(input.messageIntent, 80)) {
    contact.messageIntent = safeText(input.messageIntent, 80);
    contact.intentObservedAt = observedAt;
  }
  for (const message of input.inboundMessages || []) {
    if (!contact.inboundMessages.some(item => item.kind === message.kind && item.text === message.text)) {
      contact.inboundMessages.push(message);
    }
  }
}

function safeInboundMessages(value) {
  const entries = Array.isArray(value) ? value : safeArray(value);
  return entries.flatMap(item => {
    const kind = String(item?.kind || '');
    const text = safeMessageText(item?.text);
    if (kind === 'text' && text) return [{ kind, text }];
    if (kind === 'resume_request' && text === 'HR 邀请你发送简历') return [{ kind, text }];
    return [];
  });
}

function resumeAction(value) {
  return safeArray(value).some(item => item?.kind === 'resume_request');
}

function hasResumeRequestCard(messages) {
  return messages.some(item => item.kind === 'resume_request');
}

function explicitResumeRequest(messages) {
  return messages.some(item => item.kind === 'text'
    && resumeRequestClauses(item.text).some(clause => EXPLICIT_RESUME_REQUEST.test(clause)));
}

function safeArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeObject(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function incomingContactKey(profileId, platform, conversationKey) {
  return `sha256:${createHash('sha256')
    .update(['incoming-contact-v1', profileId, platform, conversationKey].join('\0'))
    .digest('hex')}`;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`${name} must be a positive integer`);
  return number;
}

function positiveId(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function validTime(value) {
  return Number.isFinite(Date.parse(String(value || '')));
}

function safeText(value, limit) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function safeMessageText(value) {
  return String(value || '').replace(/\r\n?/g, '\n').trim().slice(0, 4000);
}

function compactText(value) {
  return String(value || '').replace(/\s+/g, '');
}

function resumeRequestClauses(value) {
  return compactText(value).split(/[，,。！？?!；;]+/).filter(Boolean);
}

function messageOrder(message) {
  return message.kind === 'text' ? 0 : 1;
}

module.exports = { listIncomingContacts, incomingContactKey };
