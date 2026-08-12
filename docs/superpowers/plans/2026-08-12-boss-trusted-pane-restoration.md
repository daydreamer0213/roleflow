# BOSS Trusted Pane Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 恢复已通过真实运行验证的 BOSS 可信右栏读取链路，并使用项目现有隐藏后台生命周期完成全新校准和全量验收。

**Architecture:** 代码只恢复 `bringToFront + clickAt` 的既有可信点击顺序，不接入接口直读或新增回退。运行层继续使用 Dashboard 的 `windowsHide` 子进程和 SQLite 生命周期；Codex 只做只读监控，不再创建前台守护任务。

**Tech Stack:** Node.js、`node:sqlite`、Edge Control、CDP、现有 smoke tests。

## Global Constraints

- 正式扫描主链路必须是固定 `BOSS-SEARCH` 标签上的 `Page.bringToFront`、精确坐标和一次 CDP 可信鼠标点击。
- 成功必须继续满足卡片、组件、右栏岗位 ID、标题、加载状态和完整 JD 校验。
- 同源详情接口只保留为未采用备选，不接入、不自动回退。
- 保留现有 8–14 秒随机详情间隔、访问额度、micro/macro cooldown、checkpoint/resume 和风险停止。
- 真实 BOSS 只读操作已授权；沟通、发送和投递未授权。
- 正式扫描只能由项目隐藏后台生命周期启动；不得创建 Codex 前台扫描守护任务。
- 真实校准和正式扫描必须使用不同的全新空操作表基线；历史和 interrupted 数据不得进入本轮质量样本。
- Wave 5 保持停止。

---

### Task 1: Restore trusted pane activation

**Files:**
- Modify: `tests/source_acquisition_smoke.js`
- Modify: `src/adapters/sites/boss.js`

**Interfaces:**
- Consumes: `EdgeControlAdapter.bringToFront(tabId)`、`EdgeControlAdapter.clickAt(tabId, point)`、现有 `readVisiblePaneDetail(...)`。
- Produces: 恢复后的 `readVisiblePaneDetail(...)`，公开签名和返回结构不变。

- [ ] **Step 1: Restore the failing regression contract**

在 `visiblePaneActivationWaitSmoke()` 中要求一次 `bringToFront`；在可信点击顺序测试中要求：

```text
bring_to_front
assert_bindings
assert_search
locate
assert_bindings
assert_search
click_at
assert_bindings
assert_search
```

缺少 `bringToFront` 能力时不得定位或点击；定位失败和身份漂移场景都必须记录一次激活、零次或一次可信点击。

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node tests/source_acquisition_smoke.js
```

Expected: FAIL because current `readVisiblePaneDetail()` never calls `bringToFront()`.

- [ ] **Step 3: Restore the minimum production behavior**

在稳定的其他岗位选择分支中恢复：

```js
if (typeof this.browser.bringToFront !== "function"
  || typeof this.browser.clickAt !== "function") {
  return null;
}
await this.browser.bringToFront(tabId);
await assertRuntimeTabBindings(assertTabBindings);
await this.assertSearchPage(tabId);
```

之后保留当前定位、点击和全部身份校验。不得修改其他生产文件。

- [ ] **Step 4: Run focused regression and nearby transport tests**

Run:

```powershell
node tests/source_acquisition_smoke.js
node tests/browser_transport_smoke.js
node tests/boss_safe_pacing_smoke.js
```

Expected: all PASS.

- [ ] **Step 5: Self-review and commit**

确认 diff 仅包含恢复行为及测试，不包含接口直读、评分、沟通或额外抽象。

```powershell
git add src/adapters/sites/boss.js tests/source_acquisition_smoke.js
git commit -m "fix: restore trusted BOSS pane activation"
```

### Task 2: Independent review and full offline verification

**Files:**
- Review only: Task 1 diff and its test report.
- No production changes unless review finds a concrete defect.

**Interfaces:**
- Consumes: Task 1 commit.
- Produces: task-level spec/quality verdict and whole-branch verdict.

- [ ] **Step 1: Generate a complete review package**

Package the exact base-to-head diff with plan, task brief and implementer report.

- [ ] **Step 2: Run independent task review**

Reviewer checks:

- exact activation order;
- capability failure closes before locate/click;
- binding/search checks surround the action;
- existing identity and risk guards remain intact;
- no scope expansion.

Expected: spec compliance PASS and code quality PASS, or enter the bounded fix/re-review loop.

- [ ] **Step 3: Run full offline suite**

Stop only the exact Dashboard PID if port `8787` conflicts, then run:

```powershell
npm test
```

Expected: exit 0 with the suite’s complete PASS count.

- [ ] **Step 4: Run whole-branch review**

The final reviewer inspects the base-to-head package and all deferred findings. Any Critical or Important issue must be fixed and re-reviewed before merge.

- [ ] **Step 5: Merge and verify main**

Merge the reviewed commit into `main`, then run the same full offline suite on merged main. Restore Dashboard with a hidden process after verification.

### Task 3: Fresh live calibration

**Files:**
- Runtime artifacts only under `D:\DevData\RoleFlow-gate-d`.
- No source changes unless a separately diagnosed defect is approved by the existing plan.

**Interfaces:**
- Consumes: reviewed merged main, preserved candidate profile/search plan/model settings, fixed Edge tabs.
- Produces: a calibration-only SQLite database and redacted acceptance evidence.

- [ ] **Step 1: Verify live preconditions read-only**

Confirm:

- no existing `src/cli.js scan`;
- exactly one fixed `BOSS-SEARCH` and one fixed `BOSS-COMMUNICATION` tab in one Edge window;
- search page logged in, no risk/page-loss;
- Dashboard uses merged main;
- no Codex scan-guardian task will be created.

- [ ] **Step 2: Create a fresh calibration baseline**

Use the existing Gate D baseline tool to preserve profiles, resumes, search plans and model settings while emptying operational job history. The path must be new and calibration-only.

- [ ] **Step 3: Start the minimum two-keyword, max-three-detail scan through project lifecycle**

Use the existing Dashboard/start-scan lifecycle so the Node child has:

```js
windowsHide: true
stdio: ["ignore", "pipe", "pipe"]
```

Record Windows foreground process before launch. During execution, monitor only process state and SQLite; do not touch Edge and do not message another Codex task.

- [ ] **Step 4: Evaluate calibration**

Require:

- 3/3 `pane_detail_result=succeeded`;
- exact identities and complete JD;
- no login/risk/page-loss/tab mismatch;
- no new tab/window;
- no visible terminal;
- no abnormal Windows foreground transition.

Failure stops the plan before formal scan.

### Task 4: Fresh full Gate D acceptance

**Files:**
- Runtime and evaluation artifacts only under `D:\DevData\RoleFlow-gate-d`.
- Final issue/acceptance report under `docs/superpowers/reports/`.

**Interfaces:**
- Consumes: passed Task 3 calibration, current candidate profile/search plan, existing Gate D exporter and scorecard tools.
- Produces: one terminal full scan, one fixed export, evaluation results and the Wave 0–4 closeout recommendation.

- [ ] **Step 1: Create a separate fresh formal baseline**

Do not reuse calibration, prior formal attempts or interrupted databases.

- [ ] **Step 2: Start complete daily scan through project hidden lifecycle**

Start once, serially. Monitor only exact PID and SQLite heartbeats/checkpoints. Do not operate Edge during the scan and do not launch a second process.

- [ ] **Step 3: Wait for a real terminal state**

Collect:

- run/batch/target terminal states;
- raw and unique jobs;
- complete JD count;
- `pane_detail_result` success/failure codes;
- technical and analysis distributions;
- risk/login/page-loss evidence;
- process exit status.

- [ ] **Step 4: Export and evaluate once**

Only after a complete formal scan, run the fixed Gate D export exactly once and compare the formal matrix with the shadow scorecard. If human labels remain incomplete, state that precision/recall and threshold calibration are not established.

- [ ] **Step 5: Support final Edge acceptance**

Use Edge for the user-visible pass over:

- Dashboard result/progress/blocked/next-action presentation;
- corrected vertical side label and compact workflow health;
- hidden `multiBusinessDistrict` warning;
- automatic communication entry/status/history;
- message read-only page.

No new real communication, send or apply action is permitted.

- [ ] **Step 6: Publish closeout report**

Write the final Wave 0–4 report with:

- passed and failed gates;
- measured scan and analysis results;
- known limitations;
- deferred module optimizations;
- whether the project is ready for first-stage closeout.

Wave 5 remains stopped.
