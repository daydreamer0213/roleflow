const assert = require("node:assert");
const crypto = require("node:crypto");
const storage = require("../src/core/storage");

function profile(name) {
  return {
    candidate: { name, city: "广州", targetTitles: ["AI 应用工程师"] },
    skills: [{ name: "Node.js" }],
    projects: [{ name: "企业知识库" }]
  };
}

function document(hash, text) {
  return {
    originalFileName: "candidate-resume.txt",
    format: "text",
    contentHash: hash,
    text,
    diagnostics: { extractionMethod: "text", inputBytes: Buffer.byteLength(text) }
  };
}

const db = storage.openDb(":memory:");

try {
  const sourceText = "个人总结\n参与企业知识库开发\n技能：Node.js";
  const owner = storage.saveProfileAnalysis(db, {
    profile: profile("Owner"),
    document: document("source-hash", sourceText),
    searchPlan: null
  });
  const other = storage.saveProfileAnalysis(db, {
    profile: profile("Other"),
    document: document("other-hash", "另一份简历"),
    searchPlan: null
  });

  assert.throws(() => storage.createResumeOptimization(db, {
    profileId: owner.profileId,
    sourceResumeVersionId: other.resumeVersionId,
    targetJobIds: [8],
    evidenceCatalog: [{ id: "R1", kind: "resume", text: "另一份简历" }],
    suggestions: [],
    headline: "错误归属"
  }), /source resume|源简历|not found/i);

  const draft = storage.createResumeOptimization(db, {
    profileId: owner.profileId,
    sourceResumeVersionId: owner.resumeVersionId,
    targetJobIds: [12, 7, 12],
    evidenceCatalog: [{ id: "R1", kind: "resume", text: "参与企业知识库开发" }],
    suggestions: [{ id: "S1", operation: "replace", originalText: "参与企业知识库开发", proposedText: "参与 Node.js 企业知识库开发", decision: "pending" }],
    headline: "突出目标岗位相关经验",
    modelIdentity: { provider: "mock", model: "deterministic" },
    sourceText: "不得信任调用方传入的源文字",
    sourceContentHash: "tampered"
  });

  assert.strictEqual(draft.profileId, owner.profileId);
  assert.strictEqual(draft.sourceResumeVersionId, owner.resumeVersionId);
  assert.strictEqual(draft.sourceResumeDocumentId, owner.resumeDocumentId);
  assert.strictEqual(draft.sourceText, sourceText);
  assert.strictEqual(draft.sourceContentHash, "source-hash");
  assert.deepStrictEqual(draft.targetJobIds, [7, 12]);
  assert.strictEqual(draft.status, "draft");
  assert.strictEqual(storage.getResumeOptimization(db, { profileId: other.profileId, optimizationId: draft.id }), null);
  assert.deepStrictEqual(storage.listResumeOptimizations(db, other.profileId), []);
  assert.strictEqual(storage.listResumeOptimizations(db, owner.profileId).length, 1);

  assert.throws(() => storage.saveResumeOptimizationDraft(db, {
    profileId: other.profileId,
    optimizationId: draft.id,
    suggestions: draft.suggestions,
    finalText: "越权修改"
  }), /not found|不存在/i);

  const finalText = "个人总结\n参与 Node.js 企业知识库开发\n技能：Node.js";
  const saved = storage.saveResumeOptimizationDraft(db, {
    profileId: owner.profileId,
    optimizationId: draft.id,
    suggestions: [{ ...draft.suggestions[0], decision: "accepted" }],
    finalText,
    sourceText: "调用方不能覆盖冻结原文",
    sourceContentHash: "tampered-again"
  });
  assert.strictEqual(saved.finalText, finalText);
  assert.strictEqual(saved.sourceText, sourceText);
  assert.strictEqual(saved.sourceContentHash, "source-hash");

  const sourceDocumentBefore = db.prepare("SELECT * FROM resume_documents WHERE id = ?").get(owner.resumeDocumentId);
  const sourceVersionBefore = db.prepare("SELECT * FROM candidate_resume_versions WHERE id = ?").get(owner.resumeVersionId);
  const countsBefore = {
    documents: db.prepare("SELECT count(*) AS n FROM resume_documents").get().n,
    versions: db.prepare("SELECT count(*) AS n FROM candidate_resume_versions").get().n
  };

  const activated = storage.activateResumeOptimization(db, {
    profileId: owner.profileId,
    optimizationId: draft.id,
    version: {
      name: "AI 应用工程师定向版",
      targetRoles: ["AI 应用工程师"],
      keywords: ["Node.js", "知识库"],
      primaryProjects: ["企业知识库"],
      summary: "面向目标岗位的本地定向版本"
    }
  });
  assert.strictEqual(activated.status, "activated");
  assert(activated.resultResumeVersionId > 0);
  assert(activated.resultResumeDocumentId > 0);
  assert.notStrictEqual(activated.resultResumeVersionId, owner.resumeVersionId);
  assert.notStrictEqual(activated.resultResumeDocumentId, owner.resumeDocumentId);
  assert.strictEqual(db.prepare("SELECT resume_text FROM resume_documents WHERE id = ?").get(activated.resultResumeDocumentId).resume_text, finalText);
  assert.strictEqual(
    db.prepare("SELECT content_hash FROM resume_documents WHERE id = ?").get(activated.resultResumeDocumentId).content_hash,
    crypto.createHash("sha256").update(finalText).digest("hex")
  );
  assert.deepStrictEqual(db.prepare("SELECT * FROM resume_documents WHERE id = ?").get(owner.resumeDocumentId), sourceDocumentBefore);
  assert.deepStrictEqual(db.prepare("SELECT * FROM candidate_resume_versions WHERE id = ?").get(owner.resumeVersionId), sourceVersionBefore);

  const retried = storage.activateResumeOptimization(db, {
    profileId: owner.profileId,
    optimizationId: draft.id,
    version: { name: "重试不得产生新版本" }
  });
  assert.strictEqual(retried.resultResumeVersionId, activated.resultResumeVersionId);
  assert.strictEqual(retried.resultResumeDocumentId, activated.resultResumeDocumentId);
  assert.strictEqual(db.prepare("SELECT count(*) AS n FROM resume_documents").get().n, countsBefore.documents + 1);
  assert.strictEqual(db.prepare("SELECT count(*) AS n FROM candidate_resume_versions").get().n, countsBefore.versions + 1);

  assert.throws(() => storage.saveResumeOptimizationDraft(db, {
    profileId: owner.profileId,
    optimizationId: draft.id,
    suggestions: [],
    finalText: "迟到保存"
  }), (error) => error.code === "RESUME_OPTIMIZATION_CLOSED");

  const rollbackDraft = storage.createResumeOptimization(db, {
    profileId: owner.profileId,
    sourceResumeVersionId: owner.resumeVersionId,
    targetJobIds: [99],
    evidenceCatalog: [{ id: "R1", kind: "resume", text: sourceText }],
    suggestions: [{ id: "S1", operation: "replace", originalText: "参与企业知识库开发", proposedText: "参与知识库开发", decision: "accepted" }],
    headline: "回滚样本"
  });
  storage.saveResumeOptimizationDraft(db, {
    profileId: owner.profileId,
    optimizationId: rollbackDraft.id,
    suggestions: rollbackDraft.suggestions,
    finalText: "个人总结\n参与知识库开发\n技能：Node.js"
  });
  const rollbackCounts = {
    documents: db.prepare("SELECT count(*) AS n FROM resume_documents").get().n,
    versions: db.prepare("SELECT count(*) AS n FROM candidate_resume_versions").get().n
  };
  db.exec(`CREATE TRIGGER fail_resume_optimization_activation
    BEFORE INSERT ON candidate_resume_versions
    WHEN NEW.version_key = 'resume_optimization_${rollbackDraft.id}'
    BEGIN SELECT RAISE(ABORT, 'forced activation failure'); END;`);
  assert.throws(() => storage.activateResumeOptimization(db, {
    profileId: owner.profileId,
    optimizationId: rollbackDraft.id,
    version: { name: "必须回滚" }
  }), /forced activation failure/);
  db.exec("DROP TRIGGER fail_resume_optimization_activation");
  assert.strictEqual(storage.getResumeOptimization(db, { profileId: owner.profileId, optimizationId: rollbackDraft.id }).status, "draft");
  assert.strictEqual(db.prepare("SELECT count(*) AS n FROM resume_documents").get().n, rollbackCounts.documents);
  assert.strictEqual(db.prepare("SELECT count(*) AS n FROM candidate_resume_versions").get().n, rollbackCounts.versions);

  console.log("resume_optimization_store_smoke ok");
} finally {
  db.close();
}
