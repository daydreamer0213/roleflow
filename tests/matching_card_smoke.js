const assert = require("assert");
const { openDb, saveProfileAnalysis } = require("../src/core/storage");
const {
  createMatchingCardDraft,
  getMatchingCard,
  getActiveMatchingCard,
  getCandidateMatchingContext,
  saveMatchingCardDraftEdit,
  confirmMatchingCard,
  saveConfirmedMatchingCardRevision,
  listMatchingCards
} = require("../src/core/storage");
const { normalizeMatchingCard, matchingCardRevision } = require("../src/core/matching_card");

const db = openDb(":memory:");

function card(direction) {
  return {
    targetDirections: [direction],
    strongEvidence: [{ label: "店铺活动与 ROI 复盘", evidence: "简历：负责店铺活动复盘和投放 ROI 优化" }],
    transferableCapabilities: [{ label: "平台数据分析", evidence: "简历：按周复盘转化数据", limitation: "未证明直播投流经验" }],
    cautionTransitions: [{ direction: "直播操盘", reason: "简历未证明直播间统筹" }],
    userNotes: []
  };
}

function document(contentHash) {
  return { originalFileName: "resume.txt", format: "text", contentHash, text: "脱敏简历文本" };
}

function profile(name, titles) {
  return { candidate: { name, city: "广州", targetTitles: titles }, skills: [], projects: [] };
}

try {
  const firstSave = saveProfileAnalysis(db, {
    profile: profile("候选人", ["电商运营"]),
    document: document("resume-v1")
  });
  const profileId = firstSave.profileId;
  const firstProfileVersionId = firstSave.profileVersionId;
  const firstDocumentId = firstSave.resumeDocumentId;

  const first = createMatchingCardDraft(db, {
    profileId, profileVersionId: firstProfileVersionId, resumeDocumentId: firstDocumentId,
    resumeContentHash: "resume-v1", card: card("电商运营")
  });
  assert.strictEqual(first.status, "draft");
  assert.strictEqual(first.source, "model");
  assert.strictEqual(getCandidateMatchingContext(db, profileId), null, "首次草稿不得形成活动上下文");

  confirmMatchingCard(db, { profileId, cardId: first.id });
  const activeContext = getCandidateMatchingContext(db, profileId);
  assert.strictEqual(activeContext.profileVersionId, firstProfileVersionId);
  assert.strictEqual(activeContext.matchingCardId, first.id);
  assert.deepStrictEqual(activeContext.matchingCard.targetDirections, ["电商运营"]);
  assert.strictEqual(activeContext.candidateProfile.candidate.targetTitles[0], "电商运营");
  assert.strictEqual(activeContext.resumeDocumentId, firstDocumentId);
  assert.strictEqual(getActiveMatchingCard(db, profileId).id, first.id);

  const reused = createMatchingCardDraft(db, {
    profileId, profileVersionId: firstProfileVersionId, resumeDocumentId: firstDocumentId,
    resumeContentHash: "resume-v1", card: card("电商运营")
  });
  assert.strictEqual(reused.id, first.id, "同一 profileId + resumeContentHash 必须复用已有卡");
  assert.strictEqual(listMatchingCards(db, profileId).length, 1);

  const secondSave = saveProfileAnalysis(db, {
    profileId,
    profile: profile("候选人", ["用户运营"]),
    document: document("resume-v2")
  });
  const secondProfileVersionId = secondSave.profileVersionId;
  const secondDocumentId = secondSave.resumeDocumentId;

  const pending = createMatchingCardDraft(db, {
    profileId, profileVersionId: secondProfileVersionId, resumeDocumentId: secondDocumentId,
    resumeContentHash: "resume-v2", card: card("用户运营")
  });
  assert.strictEqual(getCandidateMatchingContext(db, profileId).profileVersionId, firstProfileVersionId, "新草稿不得改变活动上下文");
  assert.strictEqual(getMatchingCard(db, pending.id).status, "draft");

  const edited = saveMatchingCardDraftEdit(db, {
    profileId, cardId: pending.id, card: { ...card("用户运营"), userNotes: ["优先考虑会员增长方向"] }
  });
  assert.strictEqual(edited.status, "draft");
  assert.strictEqual(edited.source, "user");
  assert.deepStrictEqual(edited.card.userNotes, ["优先考虑会员增长方向"]);

  confirmMatchingCard(db, { profileId, cardId: pending.id });
  assert.strictEqual(getMatchingCard(db, first.id).status, "superseded", "确认新卡后旧卡必须 superseded");
  assert.strictEqual(getCandidateMatchingContext(db, profileId).profileVersionId, secondProfileVersionId);

  const revision = saveConfirmedMatchingCardRevision(db, {
    profileId, cardId: pending.id, card: { ...card("用户运营"), userNotes: ["排除纯销售方向"] }
  });
  assert.strictEqual(revision.status, "confirmed");
  assert.strictEqual(revision.source, "user");
  assert.notStrictEqual(revision.id, pending.id, "人工修订必须产生新的已确认记录");
  assert.strictEqual(getMatchingCard(db, pending.id).status, "superseded");
  assert.strictEqual(getActiveMatchingCard(db, profileId).id, revision.id);
  assert.deepStrictEqual(getCandidateMatchingContext(db, profileId).matchingCard.userNotes, ["排除纯销售方向"]);
  assert.strictEqual(listMatchingCards(db, profileId).length, 3, "历史卡版本必须全部保留");

  assert.throws(
    () => normalizeMatchingCard({ targetDirections: ["电商运营"], strongEvidence: [{ label: "虚构", evidence: "" }] }),
    (error) => error.code === "MATCHING_CARD_INVALID"
  );
  const normalized = normalizeMatchingCard({
    targetDirections: [" 电商运营 "],
    strongEvidence: [{ label: "活动复盘", evidence: " 简历：负责活动复盘 " }],
    userNotes: ["备注一", ""]
  }, { source: "user", editedByUser: true });
  assert.strictEqual(normalized.source, "user");
  assert.deepStrictEqual(normalized.targetDirections, ["电商运营"]);
  assert.deepStrictEqual(normalized.userNotes, ["备注一"]);
  assert.strictEqual(normalized.strongEvidence[0].evidence, "简历：负责活动复盘");
  assert.strictEqual(
    matchingCardRevision(card("电商运营")),
    matchingCardRevision(card("电商运营")),
    "相同卡内容必须产生相同修订指纹"
  );
  assert.notStrictEqual(
    matchingCardRevision(card("电商运营")),
    matchingCardRevision(card("用户运营")),
    "不同卡内容必须产生不同修订指纹"
  );

  console.log("matching_card_smoke ok");
} finally {
  db.close();
}
