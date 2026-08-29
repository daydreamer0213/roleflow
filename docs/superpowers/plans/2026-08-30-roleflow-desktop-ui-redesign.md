# RoleFlow Desktop UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 RoleFlow 现有服务端渲染 Dashboard 改造成桌面端优先、按用户行动组织的分组侧栏工作台，同时完整保留求职、消息学习、反馈轮次和外部动作安全语义。

**Architecture:** 继续使用现有 CommonJS 服务端渲染、原生 CSS 和原生 JavaScript。先替换共享外壳与导航，再按“今日/岗位、消息、体检、成长页面”分批迁移；每批只改变 HTML 信息层级与 CSS，不改变 view model、数据库或执行器接口。

**Tech Stack:** Node.js 22+、CommonJS、服务端 HTML 字符串、原生 CSS、原生 JavaScript、`node:assert` 离线 smoke tests

## Global Constraints

- 桌面端优先，但现有窄屏可用性、键盘焦点和可访问名称不得退化。
- 不引入 React、Vue、Tailwind、组件库、构建工具、图标包或新的运行时依赖。
- 不改变岗位匹配算法、二维表生产决策、反馈成熟时间、30/50/70 阈值或策略轮次数据模型。
- 不改变消息草稿自动保存、当前文字确认、批量串行发送、身份核对、停止和不确定结果处理语义。
- 不增加自动投递、自动申请或未经当前不可变目标确认的外部写入。
- 不访问真实 BOSS；浏览器验收只使用本地 fixture 和假浏览器。
- 用户主视图只突出行动、进展、结论和下一步；技术明细默认降级到详情或诊断入口。
- 复用现有 view model、页面渲染函数、表单端点和 CSS 文件，不创建新的前端框架层。

---

### Task 1: 分组侧栏与共享桌面外壳

**Files:**
- Create: `tests/dashboard_information_architecture_smoke.js`
- Modify: `tests/run_all.js`
- Modify: `src/dashboard/ui/navigation.js`
- Modify: `src/dashboard/ui/shell.js`
- Modify: `src/dashboard/assets/roleflow.css`
- Test: `tests/dashboard_information_architecture_smoke.js`
- Test: `tests/dashboard_shell_smoke.js`

**Interfaces:**
- Consumes: `renderNavigation({ currentPath, todayPath, planId })`、`renderDashboardFrame(...)`
- Produces: 保持相同导出签名；导航 HTML 新增 `.nav-group`、`.nav-group-label`、`.nav-item`，共享外壳新增 `.app-sidebar`、`.app-workspace`、`.sidebar-utility`

- [x] **Step 1: 写导航信息架构失败检查**

在 `tests/dashboard_information_architecture_smoke.js` 中直接调用 `renderNavigation`，验证分组、文案和上下文路由归属：

```js
const assert = require("node:assert/strict");
const { renderNavigation } = require("../src/dashboard/ui/navigation");

const plan = { todayPath: "/plan?planId=7", planId: 7 };
const workflow = renderNavigation({ ...plan, currentPath: "/workflow?runId=9" });
assert.match(workflow, /工作台/);
assert.match(workflow, /求职/);
assert.match(workflow, /沟通/);
assert.match(workflow, /成长/);
assert.match(workflow, /发现岗位/);
assert.match(workflow, /href="\/workflow\?runId=9"[^>]*aria-current="page"/);

const queue = renderNavigation({ ...plan, currentPath: "/queue?planId=7" });
assert.match(queue, /岗位记录/);
assert.match(queue, /href="\/queue\?planId=7"[^>]*aria-current="page"/);

const messages = renderNavigation({ ...plan, currentPath: "/messages?planId=7" });
assert.match(messages, /消息与回复/);
assert.doesNotMatch(messages, />消息发现</);
console.log("dashboard_information_architecture_smoke ok");
```

把该文件加入 `tests/run_all.js` 的 Dashboard 检查段。

- [x] **Step 2: 运行检查并确认因旧横向导航失败**

Run: `node tests/dashboard_information_architecture_smoke.js`
Expected: FAIL，缺少“工作台 / 求职 / 沟通 / 成长”分组或新文案。

- [x] **Step 3: 最小实现分组导航和共享外壳**

在 `navigation.js` 内保留 `renderNavigation` 公共签名，增加内部 `navigationGroup(label, links)`；将路由映射为：

```js
const groups = [
  ["工作台", [[todayPath, "今日任务", currentRoute === "/plan"]]],
  ["求职", [
    [workflowHref, "发现岗位", currentRoute === "/workflow"],
    [queueHref, "岗位记录", ["/queue", "/jobs"].includes(currentRoute)],
    [funnelHref, "求职体检", currentRoute === "/funnel"]
  ]],
  ["沟通", [
    [messagesHref, "消息与回复", currentRoute === "/messages"],
    [communicationHref, "发送记录", ["/communication", "/communication/new"].includes(currentRoute)]
  ]],
  ["成长", [
    [resumeHref, "简历工作室", ["/resume-optimization", "/profile", "/resumes", "/onboarding"].includes(currentRoute)],
    [interviewHref, "面试训练", currentRoute === "/interview"]
  ]]
];
```

`/workflow` 当前运行时链接使用当前 URL；没有活动运行时“发现岗位”回到今日任务的开始入口。`shell.js` 将 `.signal-rail + .topbar` 改为固定 `.app-sidebar`，保留 skip link、runtime status、brandHref、脚本加载和页面内容原样。

- [x] **Step 4: 添加共享视觉令牌和侧栏样式**

在 `roleflow.css` 末尾增加一个清晰标注的 v2 区段，复用现有变量并覆盖：纸灰背景、墨绿文字、翡翠主色、198px 侧栏、最大内容宽度、焦点样式、按钮、表单、状态带和窄屏折叠。不要删除尚未迁移页面使用的旧规则。

- [x] **Step 5: 运行共享外壳检查**

Run: `node tests/dashboard_information_architecture_smoke.js`
Expected: PASS
Run: `node tests/dashboard_shell_smoke.js`
Expected: PASS，skip link、runtime status、导航和资产引用仍存在。

- [x] **Step 6: 提交共享外壳**

```bash
git add tests/dashboard_information_architecture_smoke.js tests/run_all.js src/dashboard/ui/navigation.js src/dashboard/ui/shell.js src/dashboard/assets/roleflow.css
git commit -m "feat: add grouped desktop dashboard shell"
```

### Task 2: 今日任务双循环与用户行动层级

**Files:**
- Modify: `tests/today_dashboard_smoke.js`
- Modify: `src/dashboard/pages/today.js`
- Modify: `src/dashboard/view_models/today.js`
- Modify: `src/dashboard/assets/roleflow.css`
- Test: `tests/today_dashboard_smoke.js`

**Interfaces:**
- Consumes: 现有 `buildTodayViewModel` 输出的 `primary`、`metrics`、`run`、`blockers`、`form`、`profile`
- Produces: `renderTodayPage(vm)` 公共签名不变；主结构新增 `.today-priority`、`.today-cycle`、`.today-feedback-summary`，现有表单名称和端点不变

- [x] **Step 1: 增加首页结构失败断言**

在现有 fixture 渲染断言中增加：

```js
assert.match(html, /class="[^"]*today-priority/);
assert.match(html, /class="[^"]*today-cycle/);
assert.match(html, /今日岗位/);
assert.match(html, /当前轮次|本轮/);
assert.doesNotMatch(html, /不阻塞继续投递/);
```

同时保留现有 `data-today-primary`、`/api/workflow-run`、浏览器就绪状态和计划表单断言。

- [x] **Step 2: 运行首页检查并确认新结构缺失**

Run: `node tests/today_dashboard_smoke.js`
Expected: FAIL at `.today-priority` or `.today-cycle`.

- [x] **Step 3: 调整 view model 的用户文案**

只重命名主视图文案，不改变状态判断：活动运行显示“继续本轮”，新消息或阻塞项仍由现有优先级决定；把“本轮已经建立，继续在本轮执行页查看进度与恢复状态”缩短为用户动作说明。保留错误码到 blocker 详情。

- [x] **Step 4: 重排首页 HTML**

将 `renderPrimaryPanel` 改为紧凑 `.today-priority`；把三个等重指标合并进 `.today-cycle` 的今日进度、当前轮次和历史摘要；计划与候选人资料移入折叠的“求职方向与资料”。没有现成反馈摘要数据时只提供“查看求职体检”入口，不伪造结论。

- [x] **Step 5: 增加首页专用 CSS 并回归**

Run: `node tests/today_dashboard_smoke.js`
Expected: PASS
Run: `node tests/dashboard_shell_smoke.js`
Expected: PASS

- [x] **Step 6: 提交首页改造**

```bash
git add tests/today_dashboard_smoke.js src/dashboard/pages/today.js src/dashboard/view_models/today.js src/dashboard/assets/roleflow.css
git commit -m "feat: reshape today dashboard around daily cycles"
```

### Task 3: 发现岗位与岗位记录结果优先布局

**Files:**
- Modify: `tests/workflow_dashboard_smoke.js`
- Modify: `tests/workflow_page_migration_smoke.js`
- Modify: `src/dashboard/pages/workflow.js`
- Modify: `src/dashboard/view_models/workflow.js`
- Modify: `src/dashboard/server.js`
- Modify: `src/dashboard/assets/roleflow.css`
- Test: `tests/workflow_dashboard_smoke.js`
- Test: `tests/workflow_page_migration_smoke.js`
- Test: `tests/dashboard_communication_batch_smoke.js`

**Interfaces:**
- Consumes: 现有 `workflow` view model、queue/jobs 数据和沟通清单表单
- Produces: 现有端点、checkbox 名称、`data-workflow-*` 轮询钩子不变；新增 `.workflow-focus`、`.workflow-result-list`、`.job-ledger`

- [x] **Step 1: 写结果优先失败断言**

在 workflow smoke 的 active fixture 中增加：

```js
assert.match(html, /class="[^"]*workflow-focus/);
assert.match(html, /class="[^"]*workflow-result-list/);
assert.match(html, />运行详情</);
assert.match(html, /data-workflow-panel/);
```

在 queue/jobs fixture 中增加 `.job-ledger`，并保留 `jobIds`、状态操作、沟通清单入口和唯一岗位记录断言。

- [x] **Step 2: 运行两项检查确认旧仪表盘布局失败**

Run: `node tests/workflow_dashboard_smoke.js`
Expected: FAIL at `.workflow-focus`
Run: `node tests/dashboard_communication_batch_smoke.js`
Expected: FAIL at `.job-ledger`.

- [x] **Step 3: 收敛 workflow 主视图**

保留轮询 DOM 钩子，将“本轮概览、统计、逐项进度、采集明细”重排为：

```html
<section class="workflow-focus">当前阶段 + 总体进度 + 暂停/继续</section>
<section class="workflow-result-list">已完成分析的岗位或确认清单</section>
<details class="workflow-technical"><summary>运行详情</summary>原有逐项进度和诊断</details>
```

不删除恢复、暂停、结束确认、访问预算或错误信息，只改变默认展开层级。

- [x] **Step 4: 把 queue/jobs 卡片改为岗位台账列表**

在 `server.js` 现有渲染函数内复用数据，把岗位行组织为身份、评价、进展、最近变化和行动；将过滤器命名收敛为“需要处理、进行中、已结束”或现有数据能可靠支持的最接近分组。不能从现有状态可靠推导时，保留原筛选项，不制造新状态。

- [x] **Step 5: 运行岗位相关回归**

Run: `node tests/workflow_dashboard_smoke.js`
Expected: PASS
Run: `node tests/workflow_page_migration_smoke.js`
Expected: PASS
Run: `node tests/dashboard_communication_batch_smoke.js`
Expected: PASS

- [x] **Step 6: 提交岗位页面改造**

```bash
git add tests/workflow_dashboard_smoke.js tests/workflow_page_migration_smoke.js src/dashboard/pages/workflow.js src/dashboard/view_models/workflow.js src/dashboard/server.js src/dashboard/assets/roleflow.css
git commit -m "feat: make job discovery results first"
```

### Task 4: 消息列表与单条回复工作区

**Files:**
- Modify: `tests/dashboard_message_discovery_smoke.js`
- Modify: `tests/dashboard_message_reply_send_smoke.js`
- Modify: `src/dashboard/message_discovery_view.js`
- Modify: `src/dashboard/assets/roleflow.css`
- Test: `tests/dashboard_message_discovery_smoke.js`
- Test: `tests/dashboard_message_reply_send_smoke.js`
- Test: `tests/message_reply_learning_smoke.js`

**Interfaces:**
- Consumes: `status.results[]`、durable drafts、`data-draft-*`、`data-send-*`、`/api/message-discovery`、`/api/message-reply-draft`、`/api/progress`
- Produces: 同一表单与数据钩子；新增 `.message-workspace`、`.message-list`、`.message-detail`，每个结果使用原生 radio/checkbox 控制当前详情

- [x] **Step 1: 写消息主从结构失败断言**

在现有成功发现 fixture 后增加：

```js
assert.match(html, /class="[^"]*message-workspace/);
assert.match(html, /class="[^"]*message-list/);
assert.match(html, /class="[^"]*message-detail/);
assert.match(html, /HR 消息原文/);
assert.match(html, /已读 \d+ · 送达 \d+/);
assert.doesNotMatch(html, /已读[^<]*<\/h2>|送达[^<]*<\/h2>/);
```

保留所有草稿 ID、revision、自动保存、当前文字、单条发送、批量发送和手动发送断言。

- [x] **Step 2: 运行检查确认旧连续卡片布局失败**

Run: `node tests/dashboard_message_discovery_smoke.js`
Expected: FAIL at `.message-workspace`.

- [x] **Step 3: 生成消息列表和详情面板**

把每个 `status.results` 渲染为左侧消息选择项与右侧详情。第一条默认显示；切换只改变本地可见面板，不重新请求、不修改草稿。详情固定顺序为岗位判断、`HR 消息原文`、草稿编辑和操作。邀请卡片继续使用现有安全摘要，不恢复原始敏感文本。

- [x] **Step 4: 复用现有草稿和发送脚本**

现有 `data-draft-text`、`data-draft-id`、`data-send-select`、`data-send-single`、`data-copy-draft`、`data-sent-draft` 保持不变。只增加选择面板的最小事件处理；切换前调用现有草稿保存 flush，防止隐藏时丢失输入。

- [x] **Step 5: 运行消息学习与发送回归**

Run: `node tests/dashboard_message_discovery_smoke.js`
Expected: PASS
Run: `node tests/dashboard_message_reply_send_smoke.js`
Expected: PASS
Run: `node tests/message_reply_learning_smoke.js`
Expected: PASS

- [x] **Step 6: 提交消息页面改造**

```bash
git add tests/dashboard_message_discovery_smoke.js tests/dashboard_message_reply_send_smoke.js src/dashboard/message_discovery_view.js src/dashboard/assets/roleflow.css
git commit -m "feat: add focused message reply workspace"
```

### Task 5: 求职体检结论优先布局

**Files:**
- Modify: `tests/dashboard_funnel_smoke.js`
- Modify: `src/dashboard/pages/funnel.js`
- Modify: `src/dashboard/assets/roleflow.css`
- Test: `tests/dashboard_funnel_smoke.js`
- Test: `tests/funnel_threshold_policy_smoke.js`
- Test: `tests/funnel_strategy_round_store_smoke.js`

**Interfaces:**
- Consumes: `dashboard.currentRound`、`dashboard.funnel`、`dashboard.previousRound`、`dashboard.roundComparison` 和策略轮次表单
- Produces: 现有统计值、表单字段和端点不变；新增 `.funnel-focus`、`.funnel-flow`、`.funnel-round-compare`

- [x] **Step 1: 写结论优先失败断言**

```js
assert.match(html, /class="[^"]*funnel-focus/);
assert.match(html, /class="[^"]*funnel-flow/);
assert.match(html, /30[^<]*初步/);
assert.match(html, /50[^<]*(可比较|较稳)/);
assert.match(html, /70[^<]*(正式|充分)/);
assert.match(html, /调整前后/);
```

继续断言 `changeKinds`、`changeNote`、`fromRoundId` 和 `/api/funnel/strategy-round`。

- [x] **Step 2: 运行体检检查确认旧结构失败**

Run: `node tests/dashboard_funnel_smoke.js`
Expected: FAIL at `.funnel-focus` or `.funnel-flow`.

- [x] **Step 3: 重排体检 HTML**

将现有 `renderConclusion` 和证据尺组合为 `.funnel-focus`；把七阶段行改成能在桌面横向扫描、窄屏纵向显示的 `.funnel-flow`。最大流失环节只在现有诊断已给出 `priorityCheck` 时突出，不在模板中自行推断。

- [x] **Step 4: 压缩前后轮次和次要数据**

当前轮次与上一轮继续使用各自成熟样本；把 sample metrics、等待、未知、分组比较和计算说明放入右侧摘要或 `<details>`。策略边界表单保持直接操作，不增加二次确认。

- [x] **Step 5: 运行体检数据回归**

Run: `node tests/dashboard_funnel_smoke.js`
Expected: PASS
Run: `node tests/funnel_threshold_policy_smoke.js`
Expected: PASS
Run: `node tests/funnel_strategy_round_store_smoke.js`
Expected: PASS

- [x] **Step 6: 提交体检页面改造**

```bash
git add tests/dashboard_funnel_smoke.js src/dashboard/pages/funnel.js src/dashboard/assets/roleflow.css
git commit -m "feat: prioritize funnel conclusions and actions"
```

### Task 6: 简历工作室与面试训练工作面

**Files:**
- Modify: `tests/dashboard_resume_optimization_smoke.js`
- Modify: `tests/dashboard_mock_interview_smoke.js`
- Modify: `src/dashboard/pages/resume_optimization.js`
- Modify: `src/dashboard/pages/mock_interview.js`
- Modify: `src/dashboard/assets/roleflow.css`
- Test: `tests/dashboard_resume_optimization_smoke.js`
- Test: `tests/dashboard_mock_interview_smoke.js`

**Interfaces:**
- Consumes: 现有简历草稿、修改依据、面试 session、turn、review 和表单字段
- Produces: 端点和字段不变；新增 `.resume-workbench`、`.resume-change-ledger`、`.interview-workbench`、`.interview-current-question`

- [x] **Step 1: 写成长页面工作面失败断言**

```js
assert.match(resumeHtml, /class="[^"]*resume-workbench/);
assert.match(resumeHtml, /class="[^"]*resume-change-ledger/);
assert.match(interviewHtml, /class="[^"]*interview-workbench/);
assert.match(interviewHtml, /class="[^"]*interview-current-question/);
```

保留完整稿编辑、保存、采用、修改依据、面试模式、当前题、回答、重答和复盘断言。

- [x] **Step 2: 运行两项检查确认新工作面缺失**

Run: `node tests/dashboard_resume_optimization_smoke.js`
Expected: FAIL at `.resume-workbench`
Run: `node tests/dashboard_mock_interview_smoke.js`
Expected: FAIL at `.interview-workbench`.

- [x] **Step 3: 重排简历工作室**

完整优化稿编辑器作为主列，修改清单与岗位依据作为次列或折叠区；保留“一次生成完整版本、直接采用或继续编辑”的现有逻辑，不恢复逐条审批。

- [x] **Step 4: 重排面试训练**

当前题目与回答输入作为唯一主焦点；题目依据轻量展示；历史题目、重答记录和最终复盘在答题时折叠，结束后再展开。通用简历训练默认优先，岗位定向训练保留现有次级入口。

- [x] **Step 5: 运行成长功能回归**

Run: `node tests/dashboard_resume_optimization_smoke.js`
Expected: PASS
Run: `node tests/dashboard_mock_interview_smoke.js`
Expected: PASS
Run: `node tests/resume_optimization_contract_smoke.js`
Expected: PASS
Run: `node tests/mock_interview_contract_smoke.js`
Expected: PASS

- [x] **Step 6: 提交成长页面改造**

```bash
git add tests/dashboard_resume_optimization_smoke.js tests/dashboard_mock_interview_smoke.js src/dashboard/pages/resume_optimization.js src/dashboard/pages/mock_interview.js src/dashboard/assets/roleflow.css
git commit -m "feat: focus resume and interview workspaces"
```

### Task 7: 辅助页面一致性与桌面端用户验收

**Files:**
- Modify: `tests/dashboard_shell_smoke.js`
- Modify: `tests/dashboard_wave2_acceptance_smoke.js`
- Modify: `src/dashboard/assets/roleflow.css`
- Modify: `docs/PROJECT_HANDOFF.md`
- Modify: `docs/NEXT_PHASE.md`
- Create: `docs/superpowers/plans/2026-08-30-roleflow-desktop-ui-redesign-acceptance.md`
- Test: `tests/dashboard_shell_smoke.js`
- Test: `tests/dashboard_wave2_acceptance_smoke.js`

**Interfaces:**
- Consumes: 所有已迁移页面、现有本地 fixture 和 Dashboard 启动方式
- Produces: 不新增业务接口；记录桌面验收结果、未验证前提和剩余用户决策

- [x] **Step 1: 增加共享可访问性失败检查**

在现有 shell/acceptance 检查中验证每页只有一个主标题、skip link 指向 `#main-content`、当前导航使用 `aria-current="page"`、交互控件存在可访问名称、宽度 1280 和 1440 时无横向溢出。

- [x] **Step 2: 运行检查确认尚未覆盖的新外壳状态**

Run: `node tests/dashboard_wave2_acceptance_smoke.js`
Expected: 在缺少新页面 fixture 或新外壳断言处 FAIL；如果运行环境缺少 Playwright，纯 DOM 严格门仍必须执行并说明跳过原因。

- [x] **Step 3: 统一未单独重排页面的共享样式**

用共享标题、表单、列表、详情、空状态和错误状态样式覆盖 onboarding、profile、resumes、settings、diagnostics、communication pages。只修改 CSS 和必要的容器类，不改业务服务。

- [x] **Step 4: 本地启动并走用户流程**

使用临时数据库和 fixture 启动本地 Dashboard，依次检查：今日任务 → 发现岗位 → 岗位记录 → 消息与回复 → 求职体检 → 简历工作室 → 面试训练。记录每页主焦点、下一步、无横向溢出、控制台错误和不可验证前提。

- [x] **Step 5: 运行完整离线门禁**

Run: `npm test`
Expected: 输出实际离线检查总数且 0 failures
Run: `git diff --check`
Expected: no output
Run: `git status --short --branch`
Expected: 只包含本计划内文件，或提交后工作树干净。

- [x] **Step 6: 更新文档与验收记录**

`PROJECT_HANDOFF.md` 记录用户可见变化、修改文件、测试、未访问真实 BOSS、提交 SHA 和下一入口；`NEXT_PHASE.md` 保持生产继续使用二维表的冻结结论，不把积分比较重新列为近期待办。验收文档逐页记录实际截图与问题，不写未执行的结论。

- [x] **Step 7: 提交最终一致性与文档**

```bash
git add tests/dashboard_shell_smoke.js tests/dashboard_wave2_acceptance_smoke.js src/dashboard/assets/roleflow.css docs/PROJECT_HANDOFF.md docs/NEXT_PHASE.md docs/superpowers/plans/2026-08-30-roleflow-desktop-ui-redesign-acceptance.md
git commit -m "docs: close desktop dashboard redesign"
```

## 自审结果

- **规范覆盖：** 导航、首页双循环、岗位、消息、反馈、简历、面试、辅助页面、可访问性和验证均有对应任务。
- **边界覆盖：** 所有任务都保留现有数据口径、外部动作确认和 BOSS 安全边界；没有计划修改存储或执行器。
- **依赖检查：** 不新增依赖，图标和图表均使用文本、CSS 或现有 HTML 表达。
- **占位检查：** 无 TBD、TODO 或未定义接口；页面细节在现有数据不能支持时明确保留原行为，不进行推断。
- **执行方式：** 用户已授权在当前会话按推荐方案持续推进，因此直接内联执行，并在每个可独立验证的提交后继续下一任务；需要用户决定的阻塞项只记录，不中断其他任务。
