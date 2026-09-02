"use strict";

const assert = require("node:assert/strict");
const { generateQualityCheckedDraft } = require("../src/application/message_draft_quality");

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function main() {
  const calls = [];
  const output = await generateQualityCheckedDraft({
    generate: async (input) => {
      calls.push(input);
      return calls.length === 1
        ? { messages: ["您好，我对贵司岗位很感兴趣，期待沟通。"] }
        : { messages: ["想结合岗位职责进一步了解团队目前的重点。"] };
    },
    input: { messageIntent: "follow_up" },
    recentTexts: ["您好，我对贵司岗位很感兴趣，期待沟通。"],
    evidenceTexts: []
  });
  assert.equal(output.attempts, 2);
  assert.equal(output.sendable, true);
  assert.equal(output.result.messages[0], "想结合岗位职责进一步了解团队目前的重点。");
  assert.equal(calls[1].draftQualityRevision.reasonCodes[0], "MESSAGE_DRAFT_RECENTLY_SIMILAR");

  const unsupported = await runSequence(
    [{ messages: ["我的期望薪资是 25K。"] }, { messages: ["方便的话，想进一步了解岗位职责。"] }],
    { evidenceTexts: [] }
  );
  assert.equal(unsupported.output.attempts, 2);
  assert.equal(unsupported.output.sendable, true);
  assert.deepEqual(unsupported.calls[1].draftQualityRevision.unsupportedClaims, [{ kind: "salary", value: "期望薪资是 25K" }]);

  const stillSimilar = await runSequence(
    [{ messages: ["您好，想了解岗位情况，期待沟通。"] }, { messages: ["您好，想了解岗位情况，期待进一步沟通。"] }],
    { recentTexts: ["您好，想了解岗位情况，期待沟通。"] }
  );
  assert.equal(stillSimilar.output.attempts, 2);
  assert.equal(stillSimilar.output.sendable, true);
  assert.equal(stillSimilar.output.assessment.warnings[0].code, "MESSAGE_DRAFT_RECENTLY_SIMILAR");

  const stillInvalid = await runSequence(
    [{ messages: ["手机号 13800138000。"] }, { messages: ["请联系 13900139000。"] }]
  );
  assert.equal(stillInvalid.output.attempts, 2);
  assert.equal(stillInvalid.output.sendable, false);
  assert.equal(stillInvalid.output.assessment.errors[0].kind, "phone");

  let failedCalls = 0;
  const failedRevision = await generateQualityCheckedDraft({
    generate: async () => {
      failedCalls += 1;
      if (failedCalls === 2) throw new Error("revision unavailable");
      return { messages: ["手机号 13800138000。"] };
    },
    input: {}, recentTexts: [], evidenceTexts: []
  });
  assert.equal(failedRevision.attempts, 1);
  assert.equal(failedRevision.sendable, false);
  assert.equal(failedRevision.result.messages[0], "手机号 13800138000。");
  assert.equal(failedRevision.revisionError.message, "revision unavailable");

  const empty = await runSequence([{ messages: [] }, { messages: [] }]);
  assert.equal(empty.output.attempts, 2);
  assert.equal(empty.output.sendable, false);
  assert.equal(empty.output.assessment.errors[0].code, "MESSAGE_DRAFT_EMPTY");

  let manualCalls = 0;
  const manual = await generateQualityCheckedDraft({
    generate: async () => {
      manualCalls += 1;
      return { messages: [], missingFact: { key: "availability_date" } };
    },
    shouldAssess: (result) => !result.missingFact,
    recentTexts: [],
    evidenceTexts: []
  });
  assert.equal(manualCalls, 1, "a deliberate manual result must not be rewritten as an empty draft");
  assert.equal(manual.sendable, true);
  assert.equal(manual.assessment.skipped, true);

  const mixed = await runSequence([
    { messages: ["您好，想了解团队重点。", "我的手机号是 13800138000。"] },
    { messages: ["您好，想了解团队重点。", "也想了解这个岗位的协作方式。"] }
  ]);
  assert.equal(mixed.output.sendable, true);
  assert.equal(mixed.calls.length, 2);

  console.log("message_draft_quality_service_smoke ok");
}

async function runSequence(results, options = {}) {
  const calls = [];
  const output = await generateQualityCheckedDraft({
    generate: async (input) => {
      calls.push(input);
      return results[Math.min(calls.length - 1, results.length - 1)];
    },
    input: {},
    recentTexts: options.recentTexts || [],
    evidenceTexts: options.evidenceTexts || []
  });
  return { calls, output };
}
