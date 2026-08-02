const assert = require("node:assert");
const modelAdapters = require("../src/adapters/models");

let createModelAdapterCalls = 0;
const realCreateModelAdapter = modelAdapters.createModelAdapter;
modelAdapters.createModelAdapter = (...args) => {
  createModelAdapterCalls += 1;
  return realCreateModelAdapter(...args);
};

(async () => {
  require("../src/core/profile_onboarding");
  require("../src/dashboard/server");

  assert.strictEqual(
    createModelAdapterCalls,
    0,
    "requiring production onboarding/dashboard paths must not construct a model adapter"
  );

  const analyzer = require("../src/core/llm_analyzer");
  for (const name of [
    "createLlmAnalyzer",
    "analyzeResume",
    "recommendSearchPlan",
    "understandJob",
    "matchJob",
    "draftCommunication",
    "buildCandidateMatchCard"
  ]) {
    assert.strictEqual(typeof analyzer[name], "function", `public export ${name} must remain available`);
  }

  await analyzer.analyzeResume({ resumeText: "项目经历：Example Project，技能：Python 和 RAG。" });
  assert.strictEqual(createModelAdapterCalls, 1, "the default adapter must be constructed lazily on first use");

  console.log("analyzer_initialization_smoke ok");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
