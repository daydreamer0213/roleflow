# Workflow 页面最终效果评估

## 结论

`/workflow` 的页面层现在按 phase 明确渲染 primary 操作，不再对完整 HTML 做全局字符串替换。每个渲染状态恰有一个可见的 `data-workflow-primary="true"`：scanning 为暂停、paused 为继续、review 为确认清单，其他结束/沟通状态也各自只有一个恢复或查看操作。

scanning 与 paused 的真实 pause/resume 表单位于 workflow header 之后、scope/health/metric details 之前。review 的真实确认表单位于 header 后且在岗位列表之前；候选列表没有删减。客户端控件查询覆盖整个 workflow page，因此移动后的 pause/resume/stop-preview/cancel 与轮询 fail-closed 状态仍生效。

## 严格浏览器评估

最终 evaluator 位于 `scripts/evaluate-workflow-dashboard.js`，使用隔离 SQLite、`forceMock` readiness 和 headless Edge；不访问真实 BOSS、沟通、网络模型或外部平台。

- [baseline JSON](evidence/2026-08-11-workflow-dashboard/baseline/baseline.json) 由最终 evaluator 针对 detached `8fedac5b8dddfe5e647c771d9993ba8221f5e1a6` 生成。
- [current JSON](evidence/2026-08-11-workflow-dashboard/current/current.json) 由同一 evaluator 针对干净 code-fix `b49a43023f0f604f7bd622b0ce8515944cfa3044` 生成，启用 `--expect-primary`。
- 两个目录各含 16 张 PNG（scanning、paused、review_required、interrupted × 1440×900、1024×768、768×1024、375×812）和一份 JSON，没有混入旧 artifact。

current JSON 的 16/16 页面均记录：`visiblePrimaryCount=1`、primary 完整位于初始 viewport、键盘 focus 为真、outline style 为 `solid`、无水平溢出、reduced-motion 为真、console/page/request/external errors 均为空。截图和这些首屏审计在 stop/review 交互之前、`scrollTo(0, 0)` 之后完成；交互结果随后以结构化字段保存。

baseline 保留非严格对照结果：其 16 页没有新 primary marker。这是 `8fedac5` 的已测量旧行为，而不是 current 的验收依据。

## 验证

使用既有 `NODE_PATH`/worktree junction，未安装或更新依赖：

```powershell
$env:ROLEFLOW_REQUIRE_PLAYWRIGHT='1'
node tests/workflow_dashboard_smoke.js
node tests/workflow_progress_smoke.js
node tests/workflow_control_smoke.js
node tests/workflow_recovery_smoke.js
node tests/workflow_communication_smoke.js
node tests/dashboard_shell_smoke.js
node tests/workflow_page_migration_smoke.js
git diff --check
node tests/run_all.js
```

focused tests 均输出 `ok`；`workflow_page_migration_smoke` 实际执行严格 evaluator；完整离线套件输出 `All 80 offline checks passed.`。

## 边界

本次只改 workflow renderer、浏览器 asset、浏览器 smoke 和 evaluator。未改 core/storage/CLI/adapters/BOSS/communication executor/matching，也未执行真实 BOSS、沟通或应用操作。
