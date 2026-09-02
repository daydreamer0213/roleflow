"use strict";

const assert = require("node:assert/strict");
const { createMessageFollowUpController } = require("../src/dashboard/message_follow_up_controller");

const PROFILE_ID = 3;
const PLAN_ID = 7;
const JOB_ID = 11;
const TAB_ID = 102;
const CONVERSATION_KEY = `sha256:${"a".repeat(64)}`;
const SOURCE_JOB_ID = "boss:follow-up-job";
const LAST_MESSAGE_ID = "378917037748760";

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function main() {
  const calls = [];
  const browser = fakeBrowser(calls);
  const candidate = {
    profileId: PROFILE_ID,
    planId: PLAN_ID,
    jobId: JOB_ID,
    card: { id: 19, threadKey: CONVERSATION_KEY },
    job: { sourceId: SOURCE_JOB_ID }
  };
  const row = verifiedRow();
  const service = {
    requireCandidate(input) {
      calls.push(["requireCandidate", input]);
      return candidate;
    },
    async savePreparedDraft(input) {
      calls.push(["savePreparedDraft", input]);
      return { draft: { id: 23, messageIntent: "follow_up" } };
    }
  };
  const controller = createMessageFollowUpController({
    db: { marker: "test-db" },
    service,
    browserFactory: () => {
      calls.push(["browserFactory"]);
      return browser;
    },
    createReader: () => ({
      async scanConversationRows() {
        calls.push(["scanConversationRows"]);
        return { tabId: TAB_ID, rows: [row, { ...row, sourceJobId: "boss:another-job" }] };
      },
      async assertActiveBindings() {
        calls.push(["assertActiveBindings"]);
      },
      async openQueuedConversation(target) {
        calls.push(["openQueuedConversation", target]);
        return {
          rows: [{ ...row, selected: true }],
          messages: [{
            direction: "myself",
            messageId: LAST_MESSAGE_ID,
            text: "您好，想了解这个岗位。",
            contentKind: "text"
          }]
        };
      }
    }),
    acquireLease(db, input) {
      calls.push(["acquireLease", db, input]);
    },
    releaseLease(db, input) {
      calls.push(["releaseLease", db, input]);
    },
    createAccessController(input) {
      calls.push(["createAccessController", input]);
      return {
        async reserve(action, details) {
          calls.push(["reserve", action, details]);
        }
      };
    },
    randomUUID: () => "follow-up-owner"
  });

  const prepared = await controller.prepare({ profileId: PROFILE_ID, planId: PLAN_ID, jobId: JOB_ID });
  assert.equal(prepared.draft.id, 23);
  assert.deepEqual(calls.find(([name]) => name === "reserve").slice(1), ["communication_visit", { jobId: JOB_ID }]);
  const opened = calls.find(([name]) => name === "openQueuedConversation")[1];
  assert.equal(opened.operation, "follow_up");
  assert.equal(opened.tabId, TAB_ID);
  const saved = calls.find(([name]) => name === "savePreparedDraft")[1];
  assert.deepEqual(saved, {
    profileId: PROFILE_ID,
    planId: PLAN_ID,
    jobId: JOB_ID,
    snapshot: {
      conversationKey: CONVERSATION_KEY,
      sourceJobId: SOURCE_JOB_ID,
      lastMessageId: LAST_MESSAGE_ID,
      lastMessageDirection: "myself",
      previousOutboundText: "您好，想了解这个岗位。"
    }
  });
  assert.equal(calls.filter(([name]) => name === "acquireLease").length, 1);
  assert.equal(calls.filter(([name]) => name === "releaseLease").length, 1);
  assert.equal(calls.filter(([name]) => name === "disconnect").length, 1);
  assert(calls.filter(([name]) => name === "assertActiveBindings").length >= 2);
  assert.equal(calls.some(([name]) => ["bringToFront", "navigate", "createTab"].includes(name)), false);

  const changedCalls = [];
  const changedBrowser = fakeBrowser(changedCalls);
  const changedController = createMessageFollowUpController({
    db: { marker: "test-db" },
    service: {
      requireCandidate: () => candidate,
      savePreparedDraft: async () => {
        changedCalls.push(["savePreparedDraft"]);
        throw new Error("must not generate after an HR reply");
      }
    },
    browserFactory: () => changedBrowser,
    createReader: () => ({
      async scanConversationRows() {
        return { tabId: TAB_ID, rows: [{ ...row, lastMessageDirection: "friend", lastMessageStatus: "unknown" }] };
      },
      async assertActiveBindings() {},
      async openQueuedConversation() {
        changedCalls.push(["openQueuedConversation"]);
        throw new Error("must not open a row that now belongs to HR");
      }
    }),
    acquireLease() { changedCalls.push(["acquireLease"]); },
    releaseLease() { changedCalls.push(["releaseLease"]); },
    createAccessController: () => ({
      async reserve() { changedCalls.push(["reserve"]); }
    }),
    randomUUID: () => "changed-owner"
  });
  await assert.rejects(
    changedController.prepare({ profileId: PROFILE_ID, planId: PLAN_ID, jobId: JOB_ID }),
    (error) => error.code === "FOLLOW_UP_CONVERSATION_CHANGED"
  );
  assert.equal(changedCalls.some(([name]) => name === "savePreparedDraft"), false);
  assert.equal(changedCalls.some(([name]) => name === "reserve"), false);
  assert.equal(changedCalls.some(([name]) => name === "openQueuedConversation"), false);
  assert.equal(changedCalls.filter(([name]) => name === "disconnect").length, 1);
  assert.equal(changedCalls.filter(([name]) => name === "releaseLease").length, 1);

  await controller.close();
  await changedController.close();
  console.log("dashboard_message_follow_up_controller_smoke ok");
}

function verifiedRow() {
  return {
    rowIndex: 0,
    identityVerified: true,
    conversationKey: CONVERSATION_KEY,
    sourceJobId: SOURCE_JOB_ID,
    lastMessageId: LAST_MESSAGE_ID,
    lastMessageDirection: "myself",
    lastMessageStatus: "delivered",
    transientSignature: `sha256:${"b".repeat(64)}`,
    previewDigest: `sha256:${"c".repeat(64)}`,
    friendKey: `sha256:${"d".repeat(64)}`
  };
}

function fakeBrowser(calls) {
  return {
    async disconnect() { calls.push(["disconnect"]); },
    async bringToFront() { calls.push(["bringToFront"]); },
    async navigate() { calls.push(["navigate"]); },
    async createTab() { calls.push(["createTab"]); }
  };
}
