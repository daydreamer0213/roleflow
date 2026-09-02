"use strict";

const { randomUUID: cryptoRandomUUID } = require("node:crypto");
const { createBossMessageReader } = require("../adapters/sites/boss_message_reader");
const { createSiteAccessController } = require("../core/site_access_budget");
const { acquireSiteScanLease, releaseSiteScanLease } = require("../core/storage");

function createMessageFollowUpController(deps = {}) {
  const {
    db,
    service,
    browserFactory,
    createReader = ({ browser }) => createBossMessageReader({ browser }),
    acquireLease = acquireSiteScanLease,
    releaseLease = releaseSiteScanLease,
    createAccessController = createSiteAccessController,
    cleanupBrowser = disconnectBrowser,
    randomUUID = cryptoRandomUUID
  } = deps;
  if (!db) throw new TypeError("db is required");
  if (!service || typeof service.requireCandidate !== "function"
    || typeof service.savePreparedDraft !== "function") {
    throw new TypeError("message follow-up service is required");
  }
  if (typeof browserFactory !== "function") throw new TypeError("browserFactory is required");

  let closed = false;
  const active = new Set();

  async function prepare(input = {}) {
    if (closed) throw followUpError("FOLLOW_UP_CONTROLLER_CLOSED", "跟进服务已关闭");
    const operation = prepareFollowUp(input);
    active.add(operation);
    try {
      return await operation;
    } finally {
      active.delete(operation);
    }
  }

  async function prepareFollowUp({ profileId, planId, jobId } = {}) {
    const candidate = service.requireCandidate({ profileId, planId, jobId });
    const owner = randomUUID();
    let acquired = false;
    let browser = null;
    let result;
    let failure = null;
    try {
      acquireLease(db, {
        site: "boss",
        owner,
        command: "prepare-message-follow-up",
        planId: candidate.planId
      });
      acquired = true;
      browser = await browserFactory();
      const reader = createReader({ browser });
      const scan = await reader.scanConversationRows();
      await reader.assertActiveBindings();
      const matches = scan.rows.filter((row) => row.identityVerified === true
        && row.conversationKey === candidate.card.threadKey
        && row.sourceJobId === candidate.job.sourceId);
      if (matches.length !== 1) {
        throw followUpError("FOLLOW_UP_CONVERSATION_UNRESOLVED", "无法唯一定位该岗位的消息会话");
      }
      const row = matches[0];
      if (row.lastMessageDirection !== "myself") {
        throw followUpError("FOLLOW_UP_CONVERSATION_CHANGED", "招聘方已有新消息，请先运行消息发现");
      }
      const access = createAccessController({
        db,
        auditDb: db,
        site: "boss",
        runId: owner
      });
      await access.reserve("communication_visit", { jobId: candidate.jobId });
      await reader.assertActiveBindings();
      const selected = await reader.openQueuedConversation({
        ...row,
        tabId: scan.tabId,
        operation: "follow_up"
      });
      await reader.assertActiveBindings();
      const last = Array.isArray(selected?.messages) ? selected.messages.at(-1) : null;
      if (!last
        || last.direction !== "myself"
        || last.messageId !== row.lastMessageId
        || !String(last.text || "").trim()) {
        throw followUpError("FOLLOW_UP_CONVERSATION_CHANGED", "会话内容出现变化，请先重新读取消息");
      }
      result = await service.savePreparedDraft({
        profileId: candidate.profileId,
        planId: candidate.planId,
        jobId: candidate.jobId,
        snapshot: {
          conversationKey: row.conversationKey,
          sourceJobId: row.sourceJobId,
          lastMessageId: row.lastMessageId,
          lastMessageDirection: row.lastMessageDirection,
          previousOutboundText: last.text
        }
      });
    } catch (error) {
      failure = error;
    } finally {
      if (browser) {
        try {
          await cleanupBrowser(browser);
        } catch (error) {
          if (!failure) failure = error;
        }
      }
      if (acquired) {
        try {
          releaseLease(db, { site: "boss", owner });
        } catch (error) {
          if (!failure) failure = error;
        }
      }
    }
    if (failure) throw failure;
    return result;
  }

  async function close() {
    closed = true;
    await Promise.allSettled([...active]);
  }

  return { prepare, close };
}

async function disconnectBrowser(browser) {
  if (typeof browser?.disconnect === "function") await browser.disconnect();
  else if (typeof browser?.cleanup === "function") await browser.cleanup();
}

function followUpError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = { createMessageFollowUpController };
