# Message Discovery Decision Card Content Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the message-discovery result card's analysis-process lists with five concise, evidence-bounded decisions: job purpose, company/business context, candidate fit, salary, and whether the opportunity is worth continuing.

**Architecture:** Keep the existing message discovery, browser, model, storage, and safety flows unchanged. Convert the already-complete job analysis into a small safe decision-card projection in `src/core/message_discovery.js`, then render only that projection in `src/dashboard/message_discovery_view.js`; detailed analysis remains available in the existing job library.

**Tech Stack:** Node.js CommonJS, built-in `node:assert` smoke tests, existing server-rendered HTML, SQLite-backed existing job context.

## Global Constraints

- Work on the existing `codex/first-principles-audit` integration branch; do not create or rebuild another branch.
- Do not add BOSS navigation, tabs, detail reads, company-page reads, public-web research, model calls, prompts, database migrations, dependencies, or external actions.
- Keep ordinary JD acquisition on `trusted_pane`; do not enable, repair, validate, optimize, or delete `search_page_api` and do not add general-purpose `standalone_detail`.
- Do not call `Page.bringToFront`, activate BOSS tabs, or add focus recovery. The existing user-invoked workspace startup exception remains unchanged.
- Preserve message identity verification, shared pacing and access budgets, same-observation job context, message-body clearing, `securityId` secrecy, manual-only categories, and the two-draft maximum.
- Do not infer company facts from the company name or from common knowledge. `businessScenario` and `industryContext` may describe only the JD's stated business context, never the whole company.
- Show the original trusted salary text; do not infer annual salary, bonus, equity, benefits, or net income.
- Keep detailed matching evidence in the job library, but do not render it in the message result card.
- Do not run `tests/startup_scripts_smoke.js`; its unsigned `msedge.exe` test stub is blocked by 360 protection.
- Verify locally before committing. Do not push, merge, release, or perform any BOSS write.

---

### Task 1: Project the Existing Analysis Into a Safe Decision Card

**Files:**
- Modify: `src/core/message_discovery.js:518-545`
- Modify: `src/core/message_discovery.js:708-728`
- Test: `tests/message_discovery_smoke.js:61-142`

**Interfaces:**
- Consumes: `projectMessageDecisionCard(job: object)` receives the same complete `resolvedJob` object currently passed to `safeJobUnderstanding()`.
- Produces: `result.job` with exactly these user-facing fields: `title`, `company`, `roleSummary`, `companyBusiness`, `companyScope`, `fitLabel`, `fitSummary`, `salary`, `opportunityVerdict`, and `opportunitySummary`.
- Preserves: `safeResult()` continues to return the existing card IDs, status, message category, context source, completeness flag, manual-action reason, and at most two drafts.

- [ ] **Step 1: Write failing projection-contract tests**

In `tests/message_discovery_smoke.js`, import the production projection with the existing discovery function:

```js
const {
  runBossMessageDiscovery,
  projectMessageDecisionCard
} = require("../src/core/message_discovery");
```

Add a pure table-driven smoke before `uniqueCandidateAndPrivacySmoke()`:

```js
function decisionCardProjectionSmoke() {
  const base = {
    title: "AI 应用开发工程师",
    company: "示例科技",
    salary: "15-25K·13薪",
    analysis: {
      roleSummary: "为企业知识库构建可追溯的智能问答系统",
      fitReasons: ["岗位方向与候选人的 RAG 项目经历一致"],
      roleGaps: ["生产环境运维经验仍需确认"],
      jobQuality: { level: "normal", concerns: [] }
    }
  };

  assert.deepStrictEqual(projectMessageDecisionCard({
    ...base,
    analysis: {
      ...base.analysis,
      businessScenario: "企业知识管理",
      industryContext: "企业软件",
      fitLevel: "A",
      recommendation: "apply"
    }
  }), {
    title: "AI 应用开发工程师",
    company: "示例科技",
    roleSummary: "为企业知识库构建可追溯的智能问答系统",
    companyBusiness: "JD 显示该岗位服务于企业知识管理。",
    companyScope: "以上信息只代表 JD 中的岗位业务场景，不能代表公司整体经营情况。",
    fitLabel: "高",
    fitSummary: "岗位方向与候选人的 RAG 项目经历一致",
    salary: "15-25K·13薪",
    opportunityVerdict: "值得继续聊",
    opportunitySummary: "岗位方向与候选人的 RAG 项目经历一致"
  });

  const unknownCompany = projectMessageDecisionCard({
    ...base,
    salary: "",
    analysis: {
      ...base.analysis,
      businessScenario: "",
      industryContext: "未明确",
      fitLevel: "no_fit",
      recommendation: "not_recommended"
    }
  });
  assert.strictEqual(unknownCompany.companyBusiness, "JD 未说明公司具体业务，建议面试时确认业务线、产品和盈利模式。");
  assert.strictEqual(unknownCompany.companyScope, "公司资料不足，当前结论只针对这份岗位机会，不能评价公司本身是否值得加入。");
  assert.strictEqual(unknownCompany.fitLabel, "低");
  assert.strictEqual(unknownCompany.salary, "");
  assert.strictEqual(unknownCompany.opportunityVerdict, "不建议优先投入时间");

  for (const [fitLevel, expected] of [
    ["fit", "高"], ["A", "高"],
    ["mostly_fit", "中"], ["partial_fit", "中"], ["B", "中"], ["C", "中"],
    ["no_fit", "低"], ["D", "低"],
    ["", "待确认"], ["unexpected", "待确认"]
  ]) {
    assert.strictEqual(projectMessageDecisionCard({
      ...base,
      analysis: { ...base.analysis, fitLevel, recommendation: "review" }
    }).fitLabel, expected);
  }

  for (const [recommendation, expected] of [
    ["primary", "值得继续聊"],
    ["apply", "值得继续聊"],
    ["caution", "可以了解，但要先确认关键问题"],
    ["not_recommended", "不建议优先投入时间"],
    ["analysis_pending", "信息不足，暂时无法判断"],
    ["unexpected", "信息不足，暂时无法判断"]
  ]) {
    assert.strictEqual(projectMessageDecisionCard({
      ...base,
      analysis: { ...base.analysis, fitLevel: "C", recommendation }
    }).opportunityVerdict, expected);
  }
}
```

Call `decisionCardProjectionSmoke()` from `main()` immediately after `factPolicySmoke()`.

Update the existing `summary.results[0].job` expectation in `uniqueCandidateAndPrivacySmoke()` so it expects the ten decision-card fields and explicitly asserts that `fitReasons`, `hardBlockers`, `softGaps`, `questionsToVerify`, `description`, and private fixture strings are absent.

- [ ] **Step 2: Run the core smoke test and verify it fails**

Run:

```powershell
node tests/message_discovery_smoke.js
```

Expected: FAIL because `projectMessageDecisionCard` is not exported and the old projection still returns the four evidence lists.

- [ ] **Step 3: Implement the minimal pure projection**

In `src/core/message_discovery.js`, replace `safeJobUnderstanding()` with `projectMessageDecisionCard()` and keep it in the same file:

```js
function projectMessageDecisionCard(job = {}) {
  const analysis = job.analysis && typeof job.analysis === "object" && !Array.isArray(job.analysis)
    ? job.analysis
    : {};
  const fitLabel = decisionFitLabel(analysis.fitLevel);
  const fitSummary = decisionFitSummary(analysis, fitLabel);
  return {
    title: safeProjectionText(job.title, 160),
    company: safeProjectionText(job.company, 160),
    roleSummary: safeProjectionText(analysis.roleSummary, 300),
    ...companyDecisionSummary(analysis),
    fitLabel,
    fitSummary,
    salary: safeProjectionText(job.salary, 80),
    opportunityVerdict: opportunityVerdict(analysis.recommendation),
    opportunitySummary: fitSummary
  };
}
```

Add small same-file helpers with no new module or dependency:

```js
function companyDecisionSummary(analysis) {
  const scenario = meaningfulAnalysisText(analysis.businessScenario, 180);
  if (scenario) return {
    companyBusiness: `JD 显示该岗位服务于${scenario}。`,
    companyScope: "以上信息只代表 JD 中的岗位业务场景，不能代表公司整体经营情况。"
  };
  const industry = meaningfulAnalysisText(analysis.industryContext, 120);
  if (industry) return {
    companyBusiness: `JD 显示该岗位属于${industry}相关业务场景。`,
    companyScope: "以上信息只代表 JD 中的岗位业务场景，不能代表公司整体经营情况。"
  };
  return {
    companyBusiness: "JD 未说明公司具体业务，建议面试时确认业务线、产品和盈利模式。",
    companyScope: "公司资料不足，当前结论只针对这份岗位机会，不能评价公司本身是否值得加入。"
  };
}

function meaningfulAnalysisText(value, limit) {
  const text = safeProjectionText(value, limit);
  return ["", "未明确", "未知", "无", "暂无", "不明确"].includes(text) ? "" : text;
}

function decisionFitLabel(value) {
  const level = String(value || "").trim();
  if (["fit", "A"].includes(level)) return "高";
  if (["mostly_fit", "partial_fit", "B", "C"].includes(level)) return "中";
  if (["no_fit", "D"].includes(level)) return "低";
  return "待确认";
}

function decisionFitSummary(analysis, fitLabel) {
  const positive = safeProjectionList(analysis.fitReasons, 1, 180)[0] || "";
  const gap = safeProjectionList(analysis.roleGaps?.length ? analysis.roleGaps : analysis.softGaps, 1, 180)[0] || "";
  const blocker = safeProjectionList(analysis.hardBlockers, 1, 180, (item) => item?.requirement ?? item)[0] || "";
  if (fitLabel === "高") return positive;
  if (fitLabel === "中") return [positive, gap].filter(Boolean).join("；");
  if (fitLabel === "低") return positive || blocker || gap;
  return "";
}

function opportunityVerdict(value) {
  return {
    primary: "值得继续聊",
    apply: "值得继续聊",
    caution: "可以了解，但要先确认关键问题",
    not_recommended: "不建议优先投入时间"
  }[String(value || "")] || "信息不足，暂时无法判断";
}
```

Change `safeResult()` to call `projectMessageDecisionCard(resolvedJob)`. Export `projectMessageDecisionCard` beside `runBossMessageDiscovery`; do not export the small formatting helpers.

- [ ] **Step 4: Run the core smoke test and verify it passes**

Run:

```powershell
node tests/message_discovery_smoke.js
```

Expected: `message_discovery_smoke ok`.

- [ ] **Step 5: Commit the safe projection**

```powershell
git add -- src/core/message_discovery.js tests/message_discovery_smoke.js
git commit -m "feat: project message decision summaries"
```

---

### Task 2: Render the Five Decision Sections and Chinese Message Labels

**Files:**
- Modify: `src/dashboard/message_discovery_view.js:54-76`
- Modify: `src/dashboard/message_discovery_view.js:134-151`
- Test: `tests/dashboard_message_discovery_smoke.js:368-399`
- Test fixture: `tests/dashboard_message_discovery_smoke.js:1227-1286`

**Interfaces:**
- Consumes: the ten `result.job` fields produced by Task 1.
- Produces: server-rendered HTML with headings `这个岗位是做什么的`, `公司及业务`, `你的匹配度`, `薪资范围`, `这份机会值不值得继续聊`, and `消息与下一步`.
- Preserves: existing result ordering, context-source label, draft rendering, manual-action copy, local progress form, escaping, and private-data exclusions.

- [ ] **Step 1: Replace the old view assertions with failing decision-card assertions**

Change `jobUnderstandingCompletedRun()` so its `job` fixture matches the Task 1 contract:

```js
const job = {
  title: "AI 应用开发工程师",
  company: "示例科技",
  roleSummary: "把企业知识转成可追溯的智能问答能力",
  companyBusiness: "JD 显示该岗位服务于企业知识管理。",
  companyScope: "以上信息只代表 JD 中的岗位业务场景，不能代表公司整体经营情况。",
  fitLabel: "中",
  fitSummary: "候选人有 RAG 项目经验；生产运维经验仍需确认",
  salary: "15-25K·13薪",
  opportunityVerdict: "可以了解，但要先确认关键问题",
  opportunitySummary: "候选人有 RAG 项目经验；生产运维经验仍需确认"
};
```

Replace the old visible-list assertions with:

```js
for (const expected of [
  "这个岗位是做什么的",
  "把企业知识转成可追溯的智能问答能力",
  "公司及业务",
  "JD 显示该岗位服务于企业知识管理。",
  "你的匹配度",
  "中",
  "薪资范围",
  "15-25K·13薪",
  "这份机会值不值得继续聊",
  "可以了解，但要先确认关键问题",
  "消息与下一步",
  "任职资格确认",
  "面试邀请",
  "信息待补"
]) assert(understoodPage.body.includes(expected), `missing decision-card content: ${expected}`);

for (const removed of ["匹配依据", "硬性阻断", "待补信息", "建议核实", "interview_invitation"]) {
  assert(!understoodPage.body.includes(removed), `message result must not render analysis/internal label: ${removed}`);
}
```

Keep the existing draft-count, `reply_confirmed_sent`, raw-analysis, navigation-URL, and private-data assertions unchanged. Add one result fixture with `salary: ""` and assert the page displays `薪资未说明`.

- [ ] **Step 2: Run the dashboard smoke test and verify it fails**

Run:

```powershell
node tests/dashboard_message_discovery_smoke.js
```

Expected: FAIL because the page still renders `岗位理解` and the four evidence lists.

- [ ] **Step 3: Render the minimal decision-card HTML**

In `src/dashboard/message_discovery_view.js`, replace `jobUnderstanding` with a fixed five-section block:

```js
const decisionCard = `<div class="message-job-understanding">
  <h3>这个岗位是做什么的</h3>
  <p class="line">${escapeHtml(job.roleSummary || "岗位职责分析尚未完成。")}</p>
  <h3>公司及业务</h3>
  <p class="line">${escapeHtml(job.companyBusiness || "JD 未说明公司具体业务，建议面试时确认业务线、产品和盈利模式。")}</p>
  <p class="line">${escapeHtml(job.companyScope || "公司资料不足，当前结论只针对这份岗位机会，不能评价公司本身是否值得加入。")}</p>
  <h3>你的匹配度</h3>
  <p class="line"><strong>${escapeHtml(job.fitLabel || "待确认")}</strong>${job.fitSummary ? ` · ${escapeHtml(job.fitSummary)}` : ""}</p>
  <h3>薪资范围</h3>
  <p class="line">${escapeHtml(job.salary || "薪资未说明")}</p>
  <h3>这份机会值不值得继续聊</h3>
  <p class="line"><strong>${escapeHtml(job.opportunityVerdict || "信息不足，暂时无法判断")}</strong>${job.opportunitySummary ? ` · ${escapeHtml(job.opportunitySummary)}` : ""}</p>
</div>`;
```

Render the metadata line with a Chinese category label rather than the internal enum:

```js
<p class="line">${escapeHtml(job.company || "公司待确认")} · 阶段：${escapeHtml(progressStageLabel(result.stage))} · 消息：${escapeHtml(messageCategoryLabel(result.messageCategory))}</p>
```

Insert `<h3>消息与下一步</h3>` immediately before the existing draft or manual-action section. Add the same-file helper:

```js
function messageCategoryLabel(value) {
  return {
    project_fact: "项目经历确认",
    qualification: "任职资格确认",
    salary: "薪资沟通",
    availability: "到岗时间确认",
    interview_invitation: "面试邀请",
    interview: "面试邀请",
    sensitive: "敏感信息",
    identity_uncertain: "岗位身份待核对",
    missing_fact: "信息待补",
    other: "其他沟通"
  }[String(value || "")] || "待确认";
}
```

Delete `renderResultList()` after confirming it has no remaining callers. Do not change the drafts, local progress form, unresolved-item UI, polling script, or recovery messages.

- [ ] **Step 4: Run the focused UI and contract tests**

Run:

```powershell
node tests/dashboard_message_discovery_smoke.js
node tests/message_discovery_smoke.js
node tests/message_reply_contract_smoke.js
```

Expected:

```text
dashboard_message_discovery_smoke ok
message_discovery_smoke ok
message_reply_contract_smoke ok
```

- [ ] **Step 5: Commit the decision-card rendering**

```powershell
git add -- src/dashboard/message_discovery_view.js tests/dashboard_message_discovery_smoke.js
git commit -m "feat: render message decision cards"
```

---

### Task 3: Verify Safety, Replay the Real Sample, and Update Authority Documents

**Files:**
- Modify: `docs/superpowers/specs/2026-08-17-message-discovery-decision-card-content-design.md`
- Modify: `docs/PROJECT_HANDOFF.md`
- Modify: `docs/NEXT_PHASE.md`
- Modify: `docs/superpowers/reports/2026-08-17-message-discovery-job-understanding-reply-drafts-acceptance.md`

**Interfaces:**
- Consumes: committed Task 1 and Task 2 behavior.
- Produces: fresh focused tests, the 100-test safe offline result, one isolated real-message UI acceptance result, and authoritative documentation that records the final commit hashes and boundaries.

- [ ] **Step 1: Run static safety checks on the final source tree**

Run:

```powershell
git diff --check HEAD~2..HEAD
rg -n "Page\.bringToFront|bringToFront|focus_tab|active\s*:\s*true|search_page_api|standalone_detail" src/core/message_discovery.js src/dashboard/message_discovery_view.js
rg -n "securityId|PRIVATE_|message\.text|description" src/dashboard/message_discovery_view.js
```

Expected: `git diff --check` exits 0; source searches return no new browser/focus path, secret field, raw message, private fixture, or full JD rendering. Any test-only assertion hits must be reviewed rather than treated as production calls.

- [ ] **Step 2: Run all 100 permitted offline checks without the blocked startup test**

Run this exact PowerShell loop from the repository root:

```powershell
$testFiles = Select-String -LiteralPath tests/run_all.js -Pattern '^\s+"([^"]+\.js)",?$' |
  ForEach-Object { $_.Matches[0].Groups[1].Value } |
  Where-Object { $_ -ne 'startup_scripts_smoke.js' }
if ($testFiles.Count -ne 100) { throw "Expected 100 safe tests, found $($testFiles.Count)" }
foreach ($testFile in $testFiles) {
  Write-Host "> $testFile"
  & node (Join-Path tests $testFile)
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
Write-Host "All 100 safe offline checks passed; startup_scripts_smoke.js was excluded."
```

Expected: all 100 permitted tests pass. Do not run `npm test`, `npm run check`, or `tests/run_all.js` directly because each includes the blocked startup test.

- [ ] **Step 3: Prepare an isolated replay database without touching production or prior evidence**

Stop only the current acceptance Dashboard process, not Edge. Create a new explicit file under `D:\DevData`:

```powershell
$sourceAccepted = 'D:\DevData\RoleFlow-message-discovery-acceptance\topic2-accepted-20260817.sqlite'
$sourcePending = 'D:\DevData\RoleFlow-message-discovery-acceptance\topic2-ancestry-diagnostic-20260817.sqlite'
$decisionDb = 'D:\DevData\RoleFlow-message-discovery-acceptance\topic2-decision-card-20260817.sqlite'
if (Test-Path -LiteralPath $decisionDb) { throw "Acceptance DB already exists: $decisionDb" }
Copy-Item -LiteralPath $sourceAccepted -Destination $decisionDb
node -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1]);db.exec("attach database "+JSON.stringify(process.argv[2])+" as pending");db.exec("begin immediate");db.prepare("delete from candidate_progress_events where type in (?,?)").run("incoming_message_classified","message_group_classified");db.exec("insert or replace into main.message_discovery_unresolved_items select profile_id,platform,conversation_key,preview_digest,preview_kind,reason_code,first_observed_at,last_observed_at,position_title,company,salary,city,identity_digest from pending.message_discovery_unresolved_items");db.exec("commit");db.exec("detach database pending");db.close()' $decisionDb $sourcePending
```

Expected: a new isolated database exists. `D:\Guo\ZhiPing\data\jobs.sqlite`, the accepted evidence database, and model settings remain unchanged.

- [ ] **Step 4: Start the current-branch Dashboard against the isolated database**

Run the already inspected acceptance helper without diagnostic wrapping:

```powershell
$env:ROLEFLOW_ACCEPT_DB='D:\DevData\RoleFlow-message-discovery-acceptance\topic2-decision-card-20260817.sqlite'
$env:ROLEFLOW_MODEL_ROOT='D:\Guo\ZhiPing'
$env:ROLEFLOW_ACCEPT_PORT='8791'
node .runtime/start-topic2-acceptance-dashboard.js
```

Expected: `Topic 2 acceptance dashboard ready on port 8791`. Reuse the current logged-in Edge window and existing Dashboard tab; do not launch `msedge.exe`, create a new Edge profile/window, or bring a BOSS tab forward.

- [ ] **Step 5: Perform one real read-only message replay and inspect the visible result**

From the active Dashboard at `http://127.0.0.1:8791/messages?planId=1`, start `开始只读发现` once. Verify after completion:

- status is `本次发现已完成` with queued 1, processed 1, unresolved 0;
- one result card visibly contains the five decision sections;
- company data is explicitly bounded and does not claim knowledge the JD lacks;
- salary shows the trusted original range;
- matching is a single `高/中/低/待确认` conclusion with at most one short summary;
- opportunity verdict is one of the four approved Chinese conclusions;
- the internal category enum and the four old evidence-list headings are absent;
- the interview invitation remains manual-only with zero draft textareas and zero copy buttons;
- Dashboard remains the active tab, the two fixed BOSS tabs remain unchanged, and BOSS detail-tab count remains zero because the accepted job cache is reused;
- no message, communication, application, or other external write occurs.

If any identity, login, risk-control, foreground, tab-count, or result ambiguity appears, stop the acceptance instead of retrying.

- [ ] **Step 6: Update the authoritative documents with observed facts only**

Record the final code commits, focused test output, 100-test result, real replay result, zero-detail-access evidence, production-database protection, and no-external-write result. Change the design status to `已实现并完成自动回归与真实只读验收`. Do not paste recruiter messages, job IDs, URLs, company-sensitive text, `securityId`, or raw model output into documentation.

- [ ] **Step 7: Check and commit the acceptance documentation**

```powershell
git diff --check
git add -- docs/PROJECT_HANDOFF.md docs/NEXT_PHASE.md docs/superpowers/specs/2026-08-17-message-discovery-decision-card-content-design.md docs/superpowers/reports/2026-08-17-message-discovery-job-understanding-reply-drafts-acceptance.md
git commit -m "docs: accept message decision cards"
git status --short
git log --oneline -5
```

Expected: the documentation commit succeeds and the final `git status --short` output is empty. Do not push, merge, or release.
