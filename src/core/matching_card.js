const crypto = require("crypto");

const CARD_TEXT_LIMIT = 240;
const CARD_DIRECTION_LIMIT = 10;
const CARD_LIST_LIMIT = 12;
const CARD_SOURCES = new Set(["model", "user", "migration"]);

function matchingCardError(message) {
  const error = new Error(message);
  error.code = "MATCHING_CARD_INVALID";
  return error;
}

function cleanText(value, limit = CARD_TEXT_LIMIT) {
  return String(value ?? "").trim().slice(0, limit);
}

function cleanStringList(value, limit) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(list.map((item) => cleanText(item)).filter(Boolean))].slice(0, limit);
}

function cleanEvidenceEntries(value, kind) {
  const list = Array.isArray(value) ? value : [];
  if (list.length > CARD_LIST_LIMIT) throw matchingCardError(`${kind} 最多 ${CARD_LIST_LIMIT} 条。`);
  return list.map((item) => {
    const label = cleanText(item?.label);
    const evidence = cleanText(item?.evidence);
    if (!label || !evidence) throw matchingCardError(`${kind} 的每条证据必须同时包含非空 label 与 evidence。`);
    return { label, evidence };
  });
}

function cleanTransferableEntries(value) {
  const list = Array.isArray(value) ? value : [];
  if (list.length > CARD_LIST_LIMIT) throw matchingCardError(`transferableCapabilities 最多 ${CARD_LIST_LIMIT} 条。`);
  return list.map((item) => {
    const label = cleanText(item?.label);
    const evidence = cleanText(item?.evidence);
    if (!label || !evidence) throw matchingCardError("transferableCapabilities 的每条证据必须同时包含非空 label 与 evidence。");
    return { label, evidence, limitation: cleanText(item?.limitation) };
  });
}

function cleanTransitionEntries(value) {
  const list = Array.isArray(value) ? value : [];
  if (list.length > CARD_LIST_LIMIT) throw matchingCardError(`cautionTransitions 最多 ${CARD_LIST_LIMIT} 条。`);
  return list.map((item) => {
    const direction = cleanText(item?.direction);
    if (!direction) throw matchingCardError("cautionTransitions 的每条转向必须包含非空 direction。");
    return { direction, reason: cleanText(item?.reason) };
  });
}

function normalizeMatchingCard(input = {}, { source = "model", editedByUser = false } = {}) {
  const cardSource = editedByUser ? "user" : CARD_SOURCES.has(source) ? source : "model";
  return {
    targetDirections: cleanStringList(input?.targetDirections, CARD_DIRECTION_LIMIT),
    strongEvidence: cleanEvidenceEntries(input?.strongEvidence, "strongEvidence"),
    transferableCapabilities: cleanTransferableEntries(input?.transferableCapabilities),
    cautionTransitions: cleanTransitionEntries(input?.cautionTransitions),
    userNotes: cleanStringList(input?.userNotes, CARD_LIST_LIMIT),
    source: cardSource
  };
}

function matchingCardRevision(card) {
  const normalized = card && Array.isArray(card.targetDirections) ? card : normalizeMatchingCard(card || {});
  const canonical = JSON.stringify({
    targetDirections: normalized.targetDirections,
    strongEvidence: normalized.strongEvidence,
    transferableCapabilities: normalized.transferableCapabilities,
    cautionTransitions: normalized.cautionTransitions,
    userNotes: normalized.userNotes
  });
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

// 旧数据迁移与同哈希无卡上传共用的确定性映射：只摘录已保存的结构化画像字段，
// 不调用模型、不捏造经历；没有可用事实时保留空数组。
function matchingCardFromProfile(profile = {}) {
  const candidate = profile.candidate || {};
  const targetDirections = cleanStringList(
    candidate.targetTitles || candidate.targetRoles || candidate.directions || (candidate.targetTitle ? [candidate.targetTitle] : []),
    CARD_DIRECTION_LIMIT
  );
  const strongEvidence = (Array.isArray(profile.projects) ? profile.projects : []).slice(0, CARD_LIST_LIMIT).map((project) => {
    const name = cleanText(project?.name || project);
    const pitch = cleanText(project?.pitch || project?.summary);
    const tags = Array.isArray(project?.tags) ? project.tags.map((tag) => cleanText(tag)).filter(Boolean) : [];
    const detail = pitch || (tags.length ? `涉及 ${tags.join("、")}` : "");
    return { label: name, evidence: detail ? `简历项目：${name}，${detail}` : `简历项目：${name}` };
  }).filter((item) => item.label);
  const skillEvidence = (Array.isArray(profile.skills) ? profile.skills : [])
    .map((skill) => cleanText(skill?.name || skill))
    .filter(Boolean)
    .slice(0, CARD_LIST_LIMIT);
  if (skillEvidence.length) {
    strongEvidence.push({ label: "已确认技能", evidence: `简历技能：${skillEvidence.join("、")}` });
  }
  return {
    targetDirections,
    strongEvidence: strongEvidence.slice(0, CARD_LIST_LIMIT),
    transferableCapabilities: [],
    cautionTransitions: [],
    userNotes: []
  };
}

module.exports = {
  normalizeMatchingCard,
  matchingCardRevision,
  matchingCardFromProfile,
  CARD_TEXT_LIMIT,
  CARD_DIRECTION_LIMIT,
  CARD_LIST_LIMIT
};
