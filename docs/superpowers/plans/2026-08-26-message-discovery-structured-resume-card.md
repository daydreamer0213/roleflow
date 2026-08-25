# Structured Resume Message Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让消息发现严格识别已验证的简历请求与平台竞争卡片，并在混合消息中同时给出 BOSS 人工操作提示和纯文字回复草稿。

**Architecture:** 复用现有 `contentKind`、消息分组、一次语义模型调用、安全结果投影和服务端页面。DOM 层只新增两个已验证类型；核心层把文字、人工操作和平台通知分流；页面层只接收固定白名单人工操作。未知卡片继续停止，不新增模型任务、依赖、数据库迁移或浏览器写能力。

**Tech Stack:** Node.js 22 CommonJS、内置 `assert`/`vm`、SQLite、服务端 HTML、PowerShell/Inno Setup 6。

## Global Constraints

- BOSS 全程保持只读；不得点击“同意”“拒绝”、发送、上传、填写或调用 `Page.bringToFront`。
- 固定消息标签页、会话身份、登录/风控、随机节奏、冷却、访问额度和 checkpoint 规则不变。
- `trusted_pane` 仍是生产 JD 主线；不修、不验、不启用 `search_page_api`，不恢复 `standalone_detail`。
- 只实现真实证据支持的 `resume_request` 和岗位竞争 `platform_notice`；位置与面试卡片继续未知即停。
- 普通文字仍使用现有一次模型调用；卡片正文、平台提示和按钮文字不得进入模型。
- 人工操作展示文案只能由本地固定白名单产生，不长期保存原始消息、草稿、按钮目标或 DOM。
- 不增加依赖、微服务、ORM、依赖注入容器、通用卡片框架或前端框架。
- 测试只用缩减 DOM 夹具、假浏览器和临时数据库；不再访问真实 BOSS。
- 发布版本为 `1.1.0`；大型暂存和安装产物放在 `D:\DevData\RoleFlow-installer`。
- GitHub Release 只能使用最终验证通过、哈希已记录且对应远程最终提交的安装资产。

---

## File Map

- `tests/fixtures/boss_message_dom_fixture.js`：表达真实页面缩减后的文字、竞争卡和简历卡结构。
- `tests/boss_message_dom_smoke.js`：证明 Node 与浏览器表达式得到相同严格类型，未知卡不落入文字。
- `src/adapters/sites/boss_message_dom.js`：唯一 DOM 内容类型来源。
- `tests/boss_message_reader_smoke.js`：证明读取器接受新增有限枚举，拒绝任意类型。
- `src/adapters/sites/boss_message_reader.js`：校验浏览器快照的有限 `contentKind`。
- `tests/message_discovery_smoke.js`：证明混合分流、简历卡零模型调用、平台通知静默和幂等。
- `src/core/message_discovery.js`：消息组路由、固定人工操作、阶段合并和安全投影。
- `tests/dashboard_message_discovery_smoke.js`：证明控制器白名单和页面顺序。
- `src/dashboard/message_discovery_controller.js`：只接纳已批准的人工操作类型并生成固定文案。
- `src/dashboard/message_discovery_view.js`：在“下一步”中先显示人工操作，再显示草稿。
- `README.md`、`docs/PROJECT_HANDOFF.md`、`docs/NEXT_PHASE.md`、`docs/operations.md`、`docs/product_spec.md`、`docs/releases/v1.1.0.md`：更新当前能力、证据、限制、验证和发布说明。
- `package.json`、`package-lock.json`：把安装与发布版本更新到 `1.1.0`。

### Task 1: Strict DOM Content Kinds

**Files:**
- Modify: `tests/fixtures/boss_message_dom_fixture.js`
- Modify: `tests/boss_message_dom_smoke.js`
- Modify: `src/adapters/sites/boss_message_dom.js`

**Interfaces:**
- Consumes: `snapshotBossMessagePage(documentLike, href)` and `BOSS_MESSAGE_SNAPSHOT_EXPRESSION`.
- Produces: `message.contentKind` in `text | resume_request | platform_notice | voice | image | attachment | unknown`.

- [ ] **Step 1: Add the real-structure fixture and failing assertions**

Add fixture helpers whose selected message list contains:

```js
platformCard("123456789012350")
plainFriendText("123456789012351", "请问你的英语和粤语水平如何？")
resumeRequestCard("123456789012352")
```

The resume card must contain `.message-card-wrap.boss-green`, `.dialog-icon.resume`, `.message-card-top-title.message-card-top-text`, `.message-card-buttons`, and exactly two `.card-btn` nodes with `拒绝` / `同意`. The platform card must contain `.message-card-wrap.blue`, one `.card-btn.one-btn` with `查看详细分析`, and a competition title.

Assert both Node and VM/browser snapshots return:

```js
["platform_notice", "text", "resume_request"]
```

Also mutate one required resume node and assert `unknown`, and add a plain text containing “同意附件简历” that remains `text`.

- [ ] **Step 2: Run the DOM test and verify RED**

Run: `node tests/boss_message_dom_smoke.js`

Expected: FAIL because card messages currently return `text`.

- [ ] **Step 3: Implement one mirrored strict classifier**

In both Node and browser helper code:

```js
if (item.matches(".item-voice")) return "voice";
if (item.matches(".item-image")) return "image";
if (item.matches(".item-attachment")) return "attachment";
const card = item.querySelector(".message-card-wrap");
if (!card) return "text";
if (matchesResumeRequestCard(card)) return "resume_request";
if (matchesCompetitionNoticeCard(card)) return "platform_notice";
return "unknown";
```

The resume matcher must require the green card, resume icon, expected title region/text, button region and exact normalized action set. The platform matcher must require the blue card, no resume icon, expected competition title, and one `one-btn` action with exact text. Do not export a generic matcher framework.

- [ ] **Step 4: Run the DOM test and verify GREEN**

Run: `node tests/boss_message_dom_smoke.js`

Expected: `boss_message_dom_smoke ok`.

- [ ] **Step 5: Commit the DOM slice**

```powershell
git add -- tests/fixtures/boss_message_dom_fixture.js tests/boss_message_dom_smoke.js src/adapters/sites/boss_message_dom.js
git commit -m "feat: recognize verified BOSS message cards"
```

### Task 2: Reader Snapshot Contract

**Files:**
- Modify: `tests/boss_message_reader_smoke.js`
- Modify: `src/adapters/sites/boss_message_reader.js`

**Interfaces:**
- Consumes: browser snapshot messages from Task 1.
- Produces: normalized selected snapshots retaining the two new exact content kinds.

- [ ] **Step 1: Add failing normalization coverage**

Feed `openQueuedConversation` a valid selected snapshot containing `platform_notice`, `text`, and `resume_request`; assert the returned `contentKind` values are unchanged. Feed a separate snapshot with `contentKind: "location_confirmation"` and assert `BOSS_MESSAGE_STRUCTURE_CHANGED`.

- [ ] **Step 2: Run the reader test and verify RED**

Run: `node tests/boss_message_reader_smoke.js`

Expected: FAIL because the normalizer rejects `resume_request` / `platform_notice`.

- [ ] **Step 3: Extend only the allowed set**

Change the message kind validator in `normalizeBrowserSnapshot` to allow:

```js
["text", "image", "voice", "attachment", "resume_request", "platform_notice", "unknown"]
```

Keep direction, 15-digit message ID, text length, page identity and write-target validation unchanged.

- [ ] **Step 4: Run the reader test and verify GREEN**

Run: `node tests/boss_message_reader_smoke.js`

Expected: `boss_message_reader_smoke ok`.

- [ ] **Step 5: Commit the reader slice**

```powershell
git add -- tests/boss_message_reader_smoke.js src/adapters/sites/boss_message_reader.js
git commit -m "feat: carry structured message kinds through reader"
```

### Task 3: Mixed Message Routing and Idempotency

**Files:**
- Modify: `tests/message_discovery_smoke.js`
- Modify: `src/core/message_discovery.js`

**Interfaces:**
- Consumes: selected messages with the Task 1 kinds.
- Produces: `incoming.messages` for model-safe text, `incoming.manualActions`, all supported `newMessageKeys`, and result `manualActions`.

- [ ] **Step 1: Add failing mixed-route tests**

Create one group after the last self message:

```js
message("friend", "...350", "岗位竞争情况", "platform_notice")
message("friend", "...351", "请问你的英语和粤语水平如何？", "text")
message("friend", "...352", "附件简历请求", "resume_request")
```

Extend the local test `message()` helper with an optional `contentKind`. Assert the model receives only the language question; the result keeps its local draft, contains exactly one `manualActions` item with `kind: "resume_request"`, and returns `needs_user_action`. Query the progress events and assert all three message IDs are represented only as digests and no raw text/draft/button label is persisted.

Add a resume-only case asserting zero model calls and one manual action, a platform-only case asserting zero model calls/zero results with a committed preview baseline, and keep the existing voice/unknown-card stop case asserting no baseline commit.

- [ ] **Step 2: Run the discovery test and verify RED**

Run: `node tests/message_discovery_smoke.js`

Expected: FAIL at the first structured message with `BOSS_MESSAGE_CONTENT_UNSUPPORTED` or missing `manualActions`.

- [ ] **Step 3: Route supported kinds inside the existing group selector**

Represent candidates internally as:

```js
{ messageKey, text, contentKind, isNew }
```

Count all supported items against `BOSS_MESSAGE_GROUP_LIMIT`; count only `text` against `BOSS_MESSAGE_GROUP_TEXT_LIMIT`. Build model messages only from grouped `text`. Build manual actions only from unprocessed `resume_request` entries. Keep all supported keys in the group digest and `newMessageKeys`. Return a skipped platform-only result so the caller commits the preview baseline without invoking the model.

- [ ] **Step 4: Merge local actions with model classification**

For resume-only input, create this local classification without calling `classifyMessageGroup`:

```js
{
  messageIntent: "manual_review",
  messageCategory: "other",
  messageSummary: "招聘方请求附件简历，需要你在 BOSS 中确认。",
  missingFact: null,
  messages: [],
  progressUpdate: { stage: "needs_user_action" }
}
```

For text input, call the existing classifier once. After either route, attach the fixed action and override only the proposed stage to `needs_user_action`. Preserve model drafts and intent/category. Ensure the model-contract failure fallback still retains the fixed manual action.

- [ ] **Step 5: Add a safe result projection**

Return at most one approved object:

```js
manualActions: [{ kind: "resume_request" }]
```

Do not project DOM-provided title/instruction. Keep existing `manualActionReason` behavior for missing facts, sensitive topics and model validation failures.

- [ ] **Step 6: Run the discovery test and verify GREEN**

Run: `node tests/message_discovery_smoke.js`

Expected: `message_discovery_smoke ok`.

- [ ] **Step 7: Commit the core slice**

```powershell
git add -- tests/message_discovery_smoke.js src/core/message_discovery.js
git commit -m "feat: split resume actions from reply drafts"
```

### Task 4: Safe UI Projection and Mixed Next Step

**Files:**
- Modify: `tests/dashboard_message_discovery_smoke.js`
- Modify: `src/dashboard/message_discovery_controller.js`
- Modify: `src/dashboard/message_discovery_view.js`

**Interfaces:**
- Consumes: `result.manualActions: Array<{kind: string}>` from Task 3.
- Produces: fixed local title/instruction and HTML showing manual action before drafts.

- [ ] **Step 1: Add failing controller and page assertions**

Make a completed fake run return both a draft and:

```js
manualActions: [{
  kind: "resume_request",
  title: "ATTACKER TITLE",
  instruction: "ATTACKER INSTRUCTION"
}, { kind: "location_confirmation" }]
```

Assert the stored/page status keeps only `resume_request`, replaces attacker copy with the fixed local text, and drops the unapproved kind. In rendered HTML assert “需要在 BOSS 人工处理附件简历请求” appears before “推荐回复”, while both and the draft are present. Assert no `resume_request`, attacker copy or fake location action appears to the user.

- [ ] **Step 2: Run the dashboard test and verify RED**

Run: `node tests/dashboard_message_discovery_smoke.js`

Expected: FAIL because `manualActions` is currently discarded.

- [ ] **Step 3: Implement the controller whitelist**

Add a small local sanitizer that maps only `{kind: "resume_request"}` to:

```js
{
  kind: "resume_request",
  title: "需要在 BOSS 人工处理附件简历请求",
  instruction: "请在 BOSS 消息卡片中人工选择“同意”或“拒绝”。"
}
```

Cap it at one item and include it only in the internal page result; keep the public POST response thin and do not expose drafts there.

- [ ] **Step 4: Render actions and drafts independently**

Build `manualSection` and `draftSection` separately. Append them in that order under “下一步”. Only show the generic `messageDiscoveryManualActionText` when there are neither approved actions nor drafts. Keep “已手动发送” only when drafts exist.

- [ ] **Step 5: Run the dashboard test and verify GREEN**

Run: `node tests/dashboard_message_discovery_smoke.js`

Expected: `dashboard_message_discovery_smoke ok`.

- [ ] **Step 6: Commit the UI slice**

```powershell
git add -- tests/dashboard_message_discovery_smoke.js src/dashboard/message_discovery_controller.js src/dashboard/message_discovery_view.js
git commit -m "feat: show resume actions beside local drafts"
```

### Task 5: Documentation, Version, and Release Notes

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Modify: `docs/PROJECT_HANDOFF.md`
- Modify: `docs/NEXT_PHASE.md`
- Modify: `docs/operations.md`
- Modify: `docs/product_spec.md`
- Create: `docs/releases/v1.1.0.md`

**Interfaces:**
- Consumes: verified implementation and exact test evidence from Tasks 1-4.
- Produces: authoritative `1.1.0` package version and user/maintainer documentation matching current behavior.

- [ ] **Step 1: Update authoritative version fields**

Set the root package and root lockfile package versions to `1.1.0`. Do not change dependency versions. Verify:

```powershell
node -e "const p=require('./package.json');const l=require('./package-lock.json');if(p.version!=='1.1.0'||l.version!=='1.1.0'||l.packages[''].version!=='1.1.0')process.exit(1)"
```

- [ ] **Step 2: Update user-facing and authority documents**

README and product/operations docs must describe:

- strict structured-card routing and mixed draft/manual-action behavior;
- real BOSS access was read-only, with no card click or send;
- production matching remains the two-dimensional matrix while scalar scoring remains shadow-only;
- current offline check count from the fresh run, not historical 101/107/108 counts;
- installer filename `RoleFlow-Setup-1.1.0.exe`, unsigned limitation and release link.

`PROJECT_HANDOFF.md` and `NEXT_PHASE.md` must replace stale “DOM unverified / release not authorized” statements with exact current evidence and remaining limits, while retaining historical failure evidence and the scalar comparison result.

- [ ] **Step 3: Add v1.1.0 release notes**

Create `docs/releases/v1.1.0.md` with user-visible message discovery, job analysis, dedicated Edge/safety improvements, installer assets, verification evidence, unsigned installer warning, and explicit “no real communication was sent” boundary.

- [ ] **Step 4: Check and commit docs/version**

Run: `git diff --check`

Expected: exit 0.

```powershell
git add -- package.json package-lock.json README.md docs/PROJECT_HANDOFF.md docs/NEXT_PHASE.md docs/operations.md docs/product_spec.md docs/releases/v1.1.0.md
git commit -m "docs: prepare RoleFlow 1.1.0 release"
```

### Task 6: Full Verification and Simulated Manual Acceptance

**Files:**
- Modify only if a verification failure proves a product defect; start a new RED test before fixes.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: fresh evidence for the exact candidate SHA.

- [ ] **Step 1: Run focused checks together**

```powershell
node tests/boss_message_dom_smoke.js
node tests/boss_message_reader_smoke.js
node tests/message_discovery_smoke.js
node tests/dashboard_message_discovery_smoke.js
```

Expected: all four print their `ok` line.

- [ ] **Step 2: Run the complete offline gate**

Run: `npm test`

Expected: every registered offline check passes. Record the final count exactly.

- [ ] **Step 3: Run the hazardous-fixture source gate**

Confirm no test creates, compiles, renames or executes a fake `msedge.exe`, and no release stage contains tests, profiles, databases, keys, `.env`, reports, logs or Edge Control bridge. Use source inspection plus Task 7 `StageOnly`; do not start Edge or probe real port 9222.

- [ ] **Step 4: Simulate the user flow offline**

Use the exact reduced DOM fixture to run the reader/core path and the local Dashboard page. Verify the visible order is job conclusion, resume manual action, reply draft; copy button remains local; no send/approve/reject control exists. Capture a local Dashboard screenshot if the existing test harness supports it. Do not revisit or click real BOSS.

- [ ] **Step 5: Run repository hygiene gates**

```powershell
git diff --check
git status --short --branch
```

Expected: no whitespace errors and only intentional changes before the final evidence commit.

### Task 7: Build and Verify Installer 1.1.0

**Files:**
- Generated outside repository: `D:\DevData\RoleFlow-installer\release-<sha>\...`

**Interfaces:**
- Consumes: `package.json@1.1.0`, pinned Node from `installer/node-version.txt`, and `scripts/build-installer.ps1`.
- Produces: `RoleFlow-Setup-1.1.0.exe` and `.sha256`.

- [ ] **Step 1: Build a clean installer stage**

Resolve the candidate short SHA and run:

```powershell
$releaseSha = (git rev-parse --short=12 HEAD).Trim()
$releaseRoot = "D:\DevData\RoleFlow-installer\release-$releaseSha"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-installer.ps1 -BuildRoot $releaseRoot -OutputDir "$releaseRoot\output" -PortableNodeRoot D:\hermes\node -StageOnly
```

Expected: full offline gate passes again and the final line names `...\stage\1.1.0`.

- [ ] **Step 2: Inspect the stage allowlist**

Enumerate the exact stage under `$releaseRoot\stage\1.1.0`; fail if it contains `tests`, `data`, `profiles`, `BrowserProfile`, `edge-profile`, `.runtime`, `reports`, `logs`, `vendor\edge-control-bridge`, SQLite/WAL/SHM, `.key`, `.env` or secrets directories. Confirm packaged `package.json` says `1.1.0`.

- [ ] **Step 3: Build the installer**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-installer.ps1 -BuildRoot $releaseRoot -OutputDir "$releaseRoot\output" -PortableNodeRoot D:\hermes\node -SkipTests
```

Expected assets:

```text
RoleFlow-Setup-1.1.0.exe
RoleFlow-Setup-1.1.0.exe.sha256
```

- [ ] **Step 4: Verify asset identity**

Compare `Get-FileHash -Algorithm SHA256` with the `.sha256` file, record exact bytes, hash, candidate full SHA and unsigned status. Run existing installer smoke checks that do not mutate a real user installation. Do not claim real install/upgrade acceptance unless an isolated installer acceptance run actually completes.

### Task 8: Final Commit, Main Merge, Push, Release, and Remote Verification

**Files:**
- Modify: authority docs only if Task 6/7 evidence values must be recorded.

**Interfaces:**
- Consumes: clean, verified feature branch and verified assets.
- Produces: remote feature branch, merged `main`, tag/Release `v1.1.0`, and completed CI evidence.

- [ ] **Step 1: Record final evidence and commit**

Update authority/release docs with exact test count, installer path/hash/bytes, simulated acceptance scope, real BOSS read-only evidence and screenshot limitation. Run `git diff --check`, commit, rerun `npm test`, and require a clean worktree.

- [ ] **Step 2: Push the feature branch safely**

```powershell
git push origin codex/message-discovery-job-analysis
```

Do not force. Verify the remote branch points to the local candidate SHA.

- [ ] **Step 3: Fast-forward main**

Use `git worktree list --porcelain` to locate ownership of `main`. Fetch without overwriting local work, verify `main` has not diverged from the recorded base, then fast-forward `main` to the verified feature SHA. If fast-forward is impossible, stop rather than fabricate a merge result. Run the full gate on the resulting exact main SHA.

- [ ] **Step 4: Push main and verify CI**

```powershell
git push origin main
```

Monitor the workflows triggered by the exact pushed SHA until completed. A failed or cancelled workflow blocks Release creation until the cause is fixed and the exact replacement SHA is reverified.

- [ ] **Step 5: Create the GitHub Release**

Create annotated tag `v1.1.0` at the verified final main SHA if it does not exist, push it, then create the GitHub Release using `docs/releases/v1.1.0.md` and upload exactly:

```text
RoleFlow-Setup-1.1.0.exe
RoleFlow-Setup-1.1.0.exe.sha256
```

Verify the public Release tag, target SHA, asset names, sizes and downloadable hashes. Do not upload stale `1.0.0` assets or GitHub source archives as installer substitutes.

- [ ] **Step 6: Final status check**

Verify local `main`, `origin/main`, tag `v1.1.0`, Release target and CI all identify the same full SHA; worktree is clean. Report no real BOSS write, the one read-only DOM sample, unverified real card-click behavior, unsigned installer status, and whether real install/upgrade was simulated or actually exercised.
