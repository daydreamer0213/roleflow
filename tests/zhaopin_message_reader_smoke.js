const assert = require("node:assert/strict");
let chromium;
try { ({ chromium } = require("playwright")); }
catch (error) {
  if (process.env.ROLEFLOW_REQUIRE_PLAYWRIGHT === "1") throw error;
  console.log("zhaopin_message_reader_smoke SKIP: Playwright unavailable");
  process.exit(0);
}
const {
  createZhaopinMessageReader,
  ZHAOPIN_MESSAGE_SNAPSHOT_EXPRESSION
} = require("../src/adapters/sites/zhaopin_message_reader");

const IM_URL = "https://i.zhaopin.com/im";
const IM_TAB_ID = 202;
const WINDOW_ID = 7;
const JOB_A = "CCL1234567890J00123456789";
const JOB_B = "CZL1234567890J00987654321";

function session({ sessionId, jobNumber, peerPartnerId = 501, senderId = 501, userId = 900, text = "请问方便沟通吗", unreadCount = 1 } = {}) {
  return { sessionId, jobNumber, peerPartnerId, senderId, userId, sendTime: 1, text, lastSentenceType: "text", unreadCount };
}

function message({ idServer, flow = "in", fromMe = false, from = 501, type = "text", cardType = "", body = "你好", content = "", tip = false, nested = false, noFallback = false, sessionOverride = null } = {}) {
  return { idServer, id: `local-${idServer || "bad"}`, idClient: "", flow, fromMe, from, time: 1, type, cardType, body, content, tip, nested, noFallback, sessionOverride };
}

function fixtureHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
    <main class="im-side-panel"></main><button class="im-send-button">发送</button><textarea class="im-input"></textarea>
    <section class="im-main-panel"><header class="im-chat-header"><span class="im-chat-header__job-title"></span><span class="im-chat-header__salary"></span><span class="im-chat-header__city"></span></header><div class="im-timeline"></div></section>
    <script>
      window.fixture = {
        sessions: [], active: null, timeline: [], loading: false, timelineError: "", selectWrong: "", clicks: 0, resumeClicks: 0, senderClicks: 0,
        set(data) { this.sessions = data.sessions; this.active = data.active || data.sessions[0] || null; this.timeline = data.timeline || []; this.loading = Boolean(data.loading); this.timelineError = data.timelineError || ""; this.selectWrong = data.selectWrong || ""; this.render(); },
        render() {
          const side = document.querySelector('.im-side-panel'); side.replaceChildren();
          side.__vue__ = { $options: { name: 'SidePanelThreeColumns' }, listLoading: false, listError: '', sessions: this.sessions };
          for (const current of this.sessions) {
            const row = document.createElement('button'); row.className = 'im-session-item' + ((this.selectWrong || this.active?.sessionId) === current.sessionId ? ' is-active' : '');
            row.__vue__ = { $options: { name: 'ImSessionItem' }, $props: { session: current } };
            row.innerHTML = '<span class="im-session-item__name">同名招聘方</span><span class="im-session-item__company-name">合成公司</span><span class="im-session-item__job">合成职位</span><span class="im-session-item__salary">20-30K</span><span class="im-session-item__preview-text"></span><span class="im-session-item__badge"></span>';
            row.querySelector('.im-session-item__preview-text').textContent = current.text || '';
            row.querySelector('.im-session-item__badge').textContent = current.unreadCount ? String(current.unreadCount) : '';
            row.addEventListener('click', () => { this.clicks += 1; this.active = current; this.render(); }); side.append(row);
          }
          const main = document.querySelector('.im-main-panel'); main.__vue__ = { $options: { name: 'MainPanelThreeColumns' }, activeSessionId: this.active?.sessionId || '', activeSession: this.active, activeTimeline: this.timeline, timelineLoading: this.loading, timelineError: this.timelineError };
          const header = document.querySelector('.im-chat-header'); header.__vue__ = { $props: { session: this.active } }; header.querySelector('.im-chat-header__job-title').textContent = this.active ? '合成职位' : ''; header.querySelector('.im-chat-header__salary').textContent = this.active ? '20-30K' : ''; header.querySelector('.im-chat-header__city').textContent = this.active ? '深圳' : '';
          const timeline = document.querySelector('.im-timeline'); timeline.replaceChildren();
          for (const current of this.timeline) {
            const row = document.createElement('article'); row.className = 'im-message' + (current.tip ? ' im-message--tip' : '');
            row.__vue__ = { $options: { name: current.nested ? 'ImMessageRenderer' : 'ImMessageRow' }, $props: { msg: current, session: current.sessionOverride || this.active } };
            if (current.type === 'text') { const text = document.createElement('span'); text.className = 'im-msg-text'; text.textContent = current.body; row.append(text); }
            else if (String(current.cardType) === '131') { const rich = document.createElement('div'); rich.className = 'im-msg-rich'; rich.textContent = current.body; row.append(rich); }
            else if (String(current.cardType) === '11') { const card = document.createElement('div'); card.className = 'im-msg-11-wrap'; card.innerHTML = '<strong>邀请发送简历</strong><button class="im-msg-11__btn--refuse">拒绝</button><button class="im-msg-11__btn--agree">同意</button>'; row.append(card); }
            else if (String(current.cardType) === '255' && !current.noFallback) { const fallback = document.createElement('div'); fallback.className = 'im-msg-255-fallback'; fallback.textContent = current.body; row.append(fallback); }
            else { const card = document.createElement('div'); card.className = 'unknown-card'; card.textContent = current.body || '隐藏卡片'; row.append(card); }
            timeline.append(row);
          }
        }
      };
      document.addEventListener('click', event => { if(event.target.closest('.im-msg-11__btn--refuse,.im-msg-11__btn--agree'))window.fixture.resumeClicks++;if(event.target.closest('.im-send-button,.im-input'))window.fixture.senderClicks++; });
    </script>
  </body></html>`;
}

function tabs() {
  return [
    { id: 1, windowId: WINDOW_ID, active: true, url: "http://127.0.0.1:3000/messages" },
    { id: IM_TAB_ID, windowId: WINDOW_ID, active: false, url: IM_URL }
  ];
}

function fakeBrowser(page) {
  const calls = [];
  return {
    calls,
    async listTabs() { calls.push(["listTabs"]); return tabs(); },
    async setPageLifecycleActive(tabId) { calls.push(["setPageLifecycleActive", tabId]); return { state: "active" }; },
    async evalValue(tabId, expression) { calls.push(["evalValue", tabId]); assert.equal(tabId, IM_TAB_ID); return page.evaluate(expression); },
    async bringToFront() { calls.push(["bringToFront"]); throw new Error("must not focus"); },
    async navigate() { calls.push(["navigate"]); throw new Error("must not navigate"); },
    async createTab() { calls.push(["createTab"]); throw new Error("must not create tabs"); },
    async inputText() { calls.push(["inputText"]); throw new Error("must not send"); }
  };
}

async function setFixture(page, value) { await page.evaluate((next) => window.fixture.set(next), value); }

function readerFor(browser, options = {}) {
  let clock = 0;
  return createZhaopinMessageReader({
    browser,
    timeoutMs: options.timeoutMs || 30,
    pollIntervalMs: 1,
    nowFn: () => clock,
    sleepFn: async () => { clock += 5; if (options.onSleep) await options.onSleep(); }
  });
}

async function main() {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage();
    await page.route(IM_URL, (route) => route.fulfill({ status: 200, contentType: "text/html", body: fixtureHtml() }));
    await page.goto(IM_URL);
    await page.setContent(fixtureHtml());
    const first = session({ sessionId: "a".repeat(32), jobNumber: JOB_A });
    const second = session({ sessionId: "b".repeat(32), jobNumber: JOB_B, text: "第二个同名会话", unreadCount: 0 });
    const richTimeline = [
      message({ idServer: "101", body: "你好" }),
      message({ idServer: "102", type: "custom", cardType: "11", body: "简历" }),
      message({ idServer: "103", type: "custom", cardType: "131", body: "请发送简历" }),
      message({ idServer: "104", type: "custom", cardType: "255", body: "系统提示", tip: true, flow: "out", fromMe: true, from: 900 }),
      message({ idServer: "999", body: "不得重复", nested: true })
    ];
    await setFixture(page, { sessions: [first, second], active: first, timeline: richTimeline, loading: true });
    assert.equal((await page.evaluate(ZHAOPIN_MESSAGE_SNAPSHOT_EXPRESSION)).rows.length, 2, "exported snapshot expression must run against mounted DOM");
    const bridge = fakeBrowser(page);
    const reader = readerFor(bridge, { onSleep: () => setFixture(page, { sessions: [first, second], active: first, timeline: richTimeline, loading: false }) });
    const scanned = await reader.scanConversationRows();
    assert.equal(scanned.platform, "zhaopin");
    assert.equal(scanned.rows[0].lastMessageId, "");
    const selected = await reader.openQueuedConversation({ ...scanned.rows[0], tabId: scanned.tabId });
    assert.deepStrictEqual(selected.messages.map(m => [m.direction, m.contentKind]), [
      ["friend", "text"], ["friend", "resume_request"], ["friend", "text"], ["platform", "platform_notice"]
    ]);
    assert.strictEqual(selected.messages.filter(m => m.contentKind === "text").length, 2);
    assert.strictEqual(selected.sourceJobId, "zhaopin:CCL1234567890J00123456789");
    assert.equal(selected.lastMessageId, "104", "the detail reader returns a real final meaningful ID");
    assert.deepEqual(await page.evaluate(() => [window.fixture.resumeClicks,window.fixture.senderClicks]), [0,0]);
    for (const forbidden of ["bringToFront", "navigate", "createTab", "inputText"]) assert.equal(bridge.calls.some(([name]) => name === forbidden), false);

    await setFixture(page, { sessions: [first, second], active: first, timeline: richTimeline, loading: false });
    const sameTitleBridge = fakeBrowser(page);
    const sameTitleReader = readerFor(sameTitleBridge);
    const sameTitleScan = await sameTitleReader.scanConversationRows();
    const selectedSecond = await sameTitleReader.openQueuedConversation({ ...sameTitleScan.rows[1], tabId: IM_TAB_ID });
    assert.equal(selectedSecond.sourceJobId, `zhaopin:${JOB_B}`, "session identity, not the same visible title, selects the intended row");

    await setFixture(page, { sessions: [first, second], active: first, timeline: richTimeline, loading: false, selectWrong: first.sessionId });
    const selectedRowReader = readerFor(fakeBrowser(page), { timeoutMs: 10 });
    const selectedRowScan = await selectedRowReader.scanConversationRows();
    await assert.rejects(() => selectedRowReader.openQueuedConversation({ ...selectedRowScan.rows[1], tabId: IM_TAB_ID }), error => error.code === "ZHAOPIN_MESSAGE_TARGET_MISMATCH");

    await setFixture(page, { sessions: [first], active: first, timeline: richTimeline, loading: false });
    const driftBridge = fakeBrowser(page);
    const driftReader = readerFor(driftBridge);
    const driftScan = await driftReader.scanConversationRows();
    await page.evaluate(() => { window.fixture.sessions[0].text = "预览已变化"; window.fixture.render(); });
    const clicksBeforeDrift = await page.evaluate(() => window.fixture.clicks);
    await assert.rejects(() => driftReader.openQueuedConversation({ ...driftScan.rows[0], tabId: IM_TAB_ID }), error => error.code === "ZHAOPIN_MESSAGE_PREVIEW_DRIFTED");
    assert.equal(await page.evaluate(() => window.fixture.clicks), clicksBeforeDrift, "a changed preview must stop before another root row click");

    const absent = session({ sessionId: "f".repeat(32), jobNumber: JOB_A });
    delete absent.senderId; delete absent.peerPartnerId; delete absent.userId;
    await setFixture(page, { sessions: [absent], active: absent, timeline: [], loading: false });
    const absentScan = await readerFor(fakeBrowser(page)).scanConversationRows();
    assert.equal(absentScan.rows[0].lastMessageDirection, "unknown", "absent optional identity stays unknown");
    const uncertain = session({ sessionId: "c".repeat(32), jobNumber: JOB_A, senderId: "not-numeric", peerPartnerId: 501, text: "未知方向" });
    const malformedTimeline = [
      message({ idServer: "", body: "缺少服务端 ID" }),
      message({ idServer: "105", type: "custom", cardType: "99", body: "未知卡片" }),
      message({ idServer: "106", body: "未知方向", from: 777 }),
      message({ idServer: "107", type: "custom", cardType: "255", body: "缺失降级内容", tip: true, noFallback: true }),
      message({ idServer: "108", flow: "out", fromMe: true, from: 900, body: "我已回复" })
    ];
    await setFixture(page, { sessions: [uncertain], active: uncertain, timeline: malformedTimeline, loading: false });
    const malformedReader = readerFor(fakeBrowser(page));
    const malformedScan = await malformedReader.scanConversationRows();
    assert.equal(malformedScan.rows[0].lastMessageDirection, "unknown", "optional preview identity is never invented");
    const malformed = await malformedReader.openQueuedConversation({ ...malformedScan.rows[0], tabId: IM_TAB_ID });
    assert.deepStrictEqual(malformed.messages.map(item => item.contentKind), ["unsupported", "unsupported", "unsupported", "unsupported", "text"]);
    assert.equal(malformed.messages.at(-1).direction, "myself", "outbound identity must come from message data, not screen position");

    const wrongSession = session({ sessionId: "d".repeat(32), jobNumber: JOB_A });
    await setFixture(page, { sessions: [first], active: first, timeline: [message({ idServer: "109", body: "不属于当前会话", sessionOverride: wrongSession })], loading: false });
    const mismatchReader = readerFor(fakeBrowser(page));
    const mismatchScan = await mismatchReader.scanConversationRows();
    await assert.rejects(() => mismatchReader.openQueuedConversation({ ...mismatchScan.rows[0], tabId: IM_TAB_ID }), error => error.code === "ZHAOPIN_MESSAGE_TARGET_MISMATCH");

    await setFixture(page, { sessions: [first], active: first, timeline: [], loading: false });
    const pendingReader = readerFor(fakeBrowser(page), { timeoutMs: 10 });
    const pendingScan = await pendingReader.scanConversationRows();
    await assert.rejects(() => pendingReader.openQueuedConversation({ ...pendingScan.rows[0], tabId: IM_TAB_ID }), error => error.code === "ZHAOPIN_MESSAGE_CONTENT_PENDING");

    await setFixture(page, { sessions: [first], active: first, timeline: richTimeline, loading: false });
    const abortReader = readerFor(fakeBrowser(page));
    const abortScan = await abortReader.scanConversationRows();
    const controller = new AbortController(); controller.abort();
    await assert.rejects(() => abortReader.openQueuedConversation({ ...abortScan.rows[0], tabId: IM_TAB_ID }, controller.signal), error => error.code === "ZHAOPIN_MESSAGE_ABORTED");

    const preAbortedBridge = fakeBrowser(page);
    const preAbortedReader = readerFor(preAbortedBridge);
    const preAborted = new AbortController(); preAborted.abort();
    await assert.rejects(() => preAbortedReader.scanConversationRows(preAborted.signal), error => error.code === "ZHAOPIN_MESSAGE_ABORTED");
    assert.equal(preAbortedBridge.calls.length, 0, "a pre-aborted scan must not touch the browser");

    const midScanBridge = fakeBrowser(page);
    const midScanReader = readerFor(midScanBridge);
    const midScan = new AbortController();
    const listTabs = midScanBridge.listTabs;
    let listCount = 0;
    midScanBridge.listTabs = async () => {
      const result = await listTabs();
      if (++listCount === 1) midScan.abort();
      return result;
    };
    await assert.rejects(() => midScanReader.scanConversationRows(midScan.signal), error => error.code === "ZHAOPIN_MESSAGE_ABORTED");
    assert.equal(midScanBridge.calls.some(([name]) => name === "setPageLifecycleActive"), false, "a scan cancelled during listTabs must not wake the page");

    await setFixture(page, { sessions: [first], active: first, timeline: richTimeline, loading: false });
    const midOpenBridge = fakeBrowser(page);
    const midOpenReader = readerFor(midOpenBridge);
    const midOpenScan = await midOpenReader.scanConversationRows();
    const midOpen = new AbortController();
    const setPageLifecycleActive = midOpenBridge.setPageLifecycleActive;
    midOpenBridge.setPageLifecycleActive = async (tabId) => {
      const result = await setPageLifecycleActive(tabId);
      midOpen.abort();
      return result;
    };
    const clicksBeforeAbort = await page.evaluate(() => window.fixture.clicks);
    await assert.rejects(() => midOpenReader.openQueuedConversation({ ...midOpenScan.rows[0], tabId: IM_TAB_ID }, midOpen.signal), error => error.code === "ZHAOPIN_MESSAGE_ABORTED");
    assert.equal(await page.evaluate(() => window.fixture.clicks), clicksBeforeAbort, "an abort during lifecycle activation must stop before row.click()");

    const invalidJob = session({ sessionId: "e".repeat(32), jobNumber: "" });
    await setFixture(page, { sessions: [invalidJob], active: invalidJob, timeline: richTimeline, loading: false });
    const invalidJobBridge = fakeBrowser(page);
    const invalidJobReader = readerFor(invalidJobBridge);
    const invalidJobScan = await invalidJobReader.scanConversationRows();
    assert.equal(invalidJobScan.rows[0].sourceJobId, "");
    const clicksBeforeInvalidJob = await page.evaluate(() => window.fixture.clicks);
    await assert.rejects(() => invalidJobReader.openQueuedConversation({ ...invalidJobScan.rows[0], tabId: IM_TAB_ID }), error => error.code === "ZHAOPIN_MESSAGE_JOB_ID_INVALID");
    assert.equal(await page.evaluate(() => window.fixture.clicks), clicksBeforeInvalidJob, "an invalid job identity must stop before row.click()");
    assert.deepEqual(await page.evaluate(() => [window.fixture.resumeClicks,window.fixture.senderClicks]), [0,0]);
  } finally {
    await browser.close();
  }
  console.log("zhaopin_message_reader_smoke ok");
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
