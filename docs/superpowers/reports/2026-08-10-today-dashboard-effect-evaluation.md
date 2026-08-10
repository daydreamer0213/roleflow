# RoleFlow Wave 2.2 今日任务效果评估

## 结论与状态

Task 2.2 已完成本地 dashboard 范围的实现、离线回归和固定 fixture 浏览器评估。这里的 accepted 只表示本地 Today 页面满足 Task 2.2 验收，不表示真实 BOSS、人工继续或沟通全链路已验收。

| 状态 | 结果 | 证据边界 |
| --- | --- | --- |
| implemented | yes | `5b4d140` 完成 Today 页面、view model、样式和 server 接线 |
| regression-safe | yes | 主控长时运行 `node tests/run_all.js`：`All 79 offline checks passed.` |
| evaluated | yes | 同一固定 fixture 的 baseline/current JSON 与 16 张精确视口截图已提交 |
| accepted | yes，限 Task 2.2 本地 dashboard | 真实 BOSS 登录态、人工继续和沟通仍为 pending，须另行批准和验收 |

## 基线关系

- `82ab5ae` 是最后一个行为基线。
- `f943400` 是本任务的 review base；`git diff --name-status 82ab5ae f943400` 只有 `docs/superpowers/reports/2026-08-10-dashboard-foundation-effect-evaluation.md`，没有生产代码差异。
- 为对齐独立审查，浏览器比较实际运行 `f943400` detached worktree 与 current。current JSON 记录的生产目标是 `5b4d140`；fix round 只新增评估脚本、证据、文档和轻量测试，没有修改生产 UI 或业务逻辑。
- 两侧均由同一脚本创建 `today-dashboard-v1` 固定 seed：Ready/Blocked 两个候选人、相同城市、方向、关键词、薪资和 mock browser-readiness。

## 可复跑方法

评估入口：[scripts/evaluate-today-dashboard.js](../../../scripts/evaluate-today-dashboard.js)。

```powershell
$env:NODE_PATH = "<existing-workspace-node-packages>"
node scripts/evaluate-today-dashboard.js `
  --target-root "<f943400-detached-worktree>" `
  --label baseline `
  --output-dir "docs/superpowers/reports/evidence/2026-08-10-today-dashboard"

node scripts/evaluate-today-dashboard.js `
  --target-root "." `
  --label current `
  --output-dir "docs/superpowers/reports/evidence/2026-08-10-today-dashboard"
```

脚本使用普通 `require("playwright")`，不包含 pnpm hash 或浏览器可执行文件的硬编码路径。按 webapp-testing skill 先运行了 `.agents/skills/webapp-testing/scripts/with_server.py --help`；workspace Python 能运行 helper，但 `import playwright` 返回 `ModuleNotFoundError`，因此按技术裁定使用已验证的 Node Playwright，并通过 `NODE_PATH` 指向已有 workspace Node packages，没有安装依赖。

## 结构化证据

- [baseline.json](evidence/2026-08-10-today-dashboard/baseline.json)
- [current.json](evidence/2026-08-10-today-dashboard/current.json)

两个 JSON 各有 8 个页面样本、`errors=[]`，截图字段均为文件名，不含机器绝对路径。每张 PNG 的实际尺寸与记录的 viewport 完全一致。

| 状态与视口 | baseline | current |
| --- | --- | --- |
| ready 1440×900 | [PNG](evidence/2026-08-10-today-dashboard/baseline-ready-1440x900.png) | [PNG](evidence/2026-08-10-today-dashboard/current-ready-1440x900.png) |
| ready 1024×768 | [PNG](evidence/2026-08-10-today-dashboard/baseline-ready-1024x768.png) | [PNG](evidence/2026-08-10-today-dashboard/current-ready-1024x768.png) |
| ready 768×1024 | [PNG](evidence/2026-08-10-today-dashboard/baseline-ready-768x1024.png) | [PNG](evidence/2026-08-10-today-dashboard/current-ready-768x1024.png) |
| ready 375×812 | [PNG](evidence/2026-08-10-today-dashboard/baseline-ready-375x812.png) | [PNG](evidence/2026-08-10-today-dashboard/current-ready-375x812.png) |
| blocked 1440×900 | [PNG](evidence/2026-08-10-today-dashboard/baseline-blocked-1440x900.png) | [PNG](evidence/2026-08-10-today-dashboard/current-blocked-1440x900.png) |
| blocked 1024×768 | [PNG](evidence/2026-08-10-today-dashboard/baseline-blocked-1024x768.png) | [PNG](evidence/2026-08-10-today-dashboard/current-blocked-1024x768.png) |
| blocked 768×1024 | [PNG](evidence/2026-08-10-today-dashboard/baseline-blocked-768x1024.png) | [PNG](evidence/2026-08-10-today-dashboard/current-blocked-768x1024.png) |
| blocked 375×812 | [PNG](evidence/2026-08-10-today-dashboard/baseline-blocked-375x812.png) | [PNG](evidence/2026-08-10-today-dashboard/current-blocked-375x812.png) |

## 同输入观测结果

| 维度 | baseline `f943400` | current `5b4d140` |
| --- | --- | --- |
| primary 标记 | 8/8 页面均为 0；旧页没有 `[data-today-primary]`，如实记录 | 8/8 页面均为 1 |
| 可见 action 总数 | ready 20，blocked 21 | ready 16，blocked 17；高级操作仍为次级 action |
| 推荐动作 | ready 为“执行一轮”；blocked 仍显示不可聚焦的禁用按钮 | ready 为“执行一轮”；blocked 为可聚焦的“确认匹配偏好卡”恢复链接 |
| primary 位置 | 不适用 | 四个视口的 ready/blocked primary 均完全位于首屏；375×812 为 ready `653.09–697.09`、blocked `601.09–645.09` |
| 宽度与 overflow | 8/8 的 document/body width 等于 viewport，无 document 级横向溢出 | 同样为 8/8；375px 下有两个导航链接超出可视区，但都位于允许横向滚动的 `.primary-nav` 容器内 |
| focus | ready action 8/8 可聚焦；blocked 禁用按钮不可聚焦 | primary 8/8 可聚焦，均有 3px solid outline |
| reduced motion | media query 8/8 命中，transition `0s` | media query 8/8 命中，transition `0.00001s` |
| 导航与 document | 8/8 当前导航为“今日任务”，nested document 为 0 | 相同 |
| console/page errors | 首个 baseline context 记录 1 次 favicon 404；page error 为 0 | console error 和 page error 均为 0 |
| network | request failure 0，external request 0 | request failure 0，external request 0 |

## API POST 与 fail-closed 证据

Today smoke 负责页面结构、纯 renderer、表单字段和评估脚本失败提示；真实 POST 兼容性由既有集成 smoke 覆盖，避免重复测试：

- `tests/onboarding_smoke.js:332-340` 与 `:556-563` 真实 POST `/api/plan`，断言 303、方案保存和 matching-card 绑定状态。
- `tests/workflow_dashboard_smoke.js:369-377` 真实 POST `/api/scan`，断言非法 portable port 返回 409 且没有 spawn。
- `tests/workflow_dashboard_smoke.js:381-394` 验证模型门禁在 BOSS 检查前以 409 阻断；`:396-410` 验证三类 BOSS readiness 失败均为 409、无 workflow、无 spawn；`:414-425` 验证成功 POST `/api/workflow-run` 返回 303 并创建正确 workflow 状态。
- `tests/workflow_dashboard_smoke.js:729-734` 还验证错误 workflow/scan 绑定返回 400 且不 spawn。
- readiness 页面断言位于 `tests/workflow_dashboard_smoke.js:295-310`；fail-closed、响应失败、慢请求串行化和模式切换竞态的可执行检查位于 `:2084-2275`。

实际通过命令包括 `node tests/onboarding_smoke.js`、`node tests/workflow_dashboard_smoke.js`、`node tests/today_dashboard_smoke.js`、`node tests/dashboard_shell_smoke.js`，以及主控长时完整 runner 的 79/79 离线检查。

## 观测弱点与下一步

- 评估使用 headless Edge、临时 SQLite、固定 mock readiness；它证明本地页面布局、DOM、焦点、reduced-motion 和本地网络边界，不证明真实 BOSS 登录态、人工继续或沟通执行。
- broad action count 只表示可见交互元素数量，不等同可用性评分；Task 2.2 的验收指标是唯一 primary 与次级高级控件。
- baseline 的 favicon 404 只在首个 context 记录一次，受浏览器缓存影响；current 的 8 个页面均无 console/page error。
- `roleflow.css` 为共享样式。旧页面的视觉连带风险按裁定留到 Task 2.4/Workflow 合并后的统一截图验收，本轮不回滚或强行收窄全局视觉系统。
