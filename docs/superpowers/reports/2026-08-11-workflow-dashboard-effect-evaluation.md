# Workflow 页面迁移效果评估

## 结论

- implemented：`/workflow` 现在由 server 收集既有事实、纯 `buildWorkflowViewModel` 组装展示数据、纯 `renderWorkflowPage` 输出 HTML，浏览器行为迁入 allowlist 资产 `/assets/workflow.js`。
- regression-safe：现有 workflow API、恢复、控制、进度、沟通和 dashboard shell 聚焦 smoke 均通过；没有改动 core、storage、BOSS 或沟通执行代码。
- evaluated：使用隔离临时 SQLite、`forceMock` readiness 与 headless Edge，对 scanning、paused、review_required、interrupted 各 4 个视口生成 32 张 PNG 和 2 份 JSON。
- accepted：仅接受本地 Workflow 页面迁移；这不代表真实 BOSS、人工沟通或投递操作验收。

## 比较与证据

基线是只读 `D:\Guo\ZhiPing`，HEAD 为 `8fedac5b8dddfe5e647c771d9993ba8221f5e1a6`。当前 worktree 的 HEAD 相同但带本任务未提交 diff；两次评估均标记了该 SHA，差异由 artifact label（`baseline-8fedac5` / `current`）与生成目录区分。

- [baseline JSON](evidence/2026-08-11-workflow-dashboard/baseline-8fedac5/baseline-8fedac5.json)：16 页、0 evaluation error、0 横向溢出、0 console error。
- [current JSON](evidence/2026-08-11-workflow-dashboard/current/current.json)：16 页、0 evaluation error、0 横向溢出、0 console error。
- 各目录含 1440x900、1024x768、768x1024、375x812 的精确 viewport PNG；scanning 记录 scanWait 和 detail counters，且执行 stop-preview/cancel；paused 记录轮询；review_required 检查 review UI；interrupted 记录恢复安全边界。所有 context 启用 reduced-motion 并记录 focus、request/page/external error。

## 实测行为与安全契约

- 新 smoke 先 RED（缺少 Workflow VM），GREEN 后在实际 HTTP + headless Edge 中验证：2500ms 串行 polling、无效 payload fail-closed、终态停止 timer、stop 二次确认、review checkbox quota/count。
- `/workflow` 仍在读页时执行 recover/reconcile；所有 POST/API 路径、字段、错误码、303/400/404/409 和服务端门禁保持在 `server.js`。
- review 链接使用保存的岗位 URL；页面只展示 immutable snapshot，未移动 communication batch/executor 校验。

## 弱点与下一步

- 默认 `NODE_PATH=D:\Guo\ZhiPing\node_modules` 没有 Playwright；全量 smoke 因而只跳过新增 smoke 的浏览器子段。浏览器 smoke 和本报告使用了另一个已存在 workspace 的无哈希 `node_modules\.pnpm\node_modules` 路径，未安装依赖。
- 评估 review fixture 的候选清单为空，因此视觉评估未实际切换 checkbox；该交互已由新增 HTTP + Edge smoke 覆盖。
- `server.js` 中的旧 renderer helper 仍是未调用死代码；新 route 已无调用路径。后续专门清理可在独立小任务中删除它，避免在本迁移中扩大差异。
