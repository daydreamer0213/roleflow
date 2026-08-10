# RoleFlow Wave 2.2 今日任务效果评估

## 结论

`/plan` 已迁移为“今日任务”页面，仍使用原 URL、原 API 和原工作流/扫描门禁。页面首屏提供当前阶段、数据安全说明、阻塞原因和唯一推荐动作；没有新增 BOSS、沟通、投递或模型调用。

## 基线与验证范围

- 基线提交：`82ab5ae`。
- 基线完整离线 runner 实测为 **78** 项，而不是任务描述中的 77 项；本次新增 `today_dashboard_smoke.js` 并注册后，预期完整 runner 为 **79** 项。没有删除或替换现有检查来迁就旧计数。
- RED：`node tests/today_dashboard_smoke.js` 在 `src/dashboard/view_models/today.js` 尚不存在时，按预期以 `MODULE_NOT_FOUND` 失败。
- GREEN：新增测试验证真实 HTTP `/plan` 的 ready、active、blocked 三态；单一 primary CTA、导航 current、无嵌套 document、完整 plan/scan 表单字段、advanced controls、HTML 转义，以及纯 renderer 不需要 SQLite 或浏览器。
- 聚焦检查：Today、dashboard shell、workflow dashboard、scan lifecycle、model settings UI 和 model settings 均通过。

## 效果对比

| 维度 | 迁移前 | Wave 2.2 后 |
| --- | --- | --- |
| 首屏信息 | “筛选方案”与编辑、扫描、执行信息并列 | 当前阶段、数据安全、阻塞说明与下一步集中在首屏 |
| 主操作 | workflow 启动区和多项扫描控件同层 | 只有一个 `data-today-primary`：继续本轮、执行一轮，或门禁恢复链接 |
| 门禁表达 | 已确认偏好卡缺失时是禁用启动按钮 | 显示“确认匹配偏好卡”恢复链接，不伪造可执行操作 |
| 响应式 | 旧共享基础样式 | signal rail、紧凑指标、移动端双列指标和可横向滚动导航 |
| 可访问性 | 原有焦点样式 | skip link、`h1`、current nav、44px 控件、橙色 focus、reduced motion |
| 职责 | `/plan` 查询、权限判断、HTML/CSS/JS 混在 `server.js` | server 采集状态；`view_models/today.js` 生成纯 display VM；`pages/today.js` 只渲染 HTML |

## 隔离浏览器验收

使用已安装的 Playwright 和 headless Edge，以临时 SQLite、`forceMock` dashboard server 运行；没有打开用户 Edge profile、没有登录或访问真实 BOSS。结构化结果保存于 `.runtime/today-dashboard-evaluation.json`，截图位于同目录。

- 状态：ready、blocked；视口：1440×900、1024×768、768×1024、375×812，共 8 页。
- 每页 `documentElement.scrollWidth` 与 `body.scrollWidth` 均等于 viewport width；主要容器和文本边界无横向溢出。
- 每页只有 1 个 primary CTA；ready 375px 的 CTA 位于 y=653–697，blocked 位于 y=601–645，均在首屏内。
- 焦点落在 primary CTA，outline 为 `solid`；reduced motion 下 transition duration 为 `0.01ms`。
- 所有 8 页 console errors、page/request failures、外部请求均为 0；无嵌套 `html`/`body`。
- 初次验收发现浏览器默认请求 `/favicon.ico` 导致一个本地 404 console error；已先添加失败测试，再让 dashboard server 返回 204，复跑后为 0。

## 契约与安全

- workflow form 保留 `/api/workflow-run`、`planId`、`cdpPort=9222`、`browserMode`、`action=start`，并保留 browser-readiness fail-closed 探测。
- plan form 保留原字段、选中值、范围和 dirty 后禁用 scan 行为。
- scan form 保留 `/api/scan`、`planId`、`cdpPort`、`browserMode`、四种 `scanKind` 与可恢复批次的 `resumeBatchId`。
- profile diff、feedback、BOSS native filter preview、validation、matching-card stale、risk-control notice 和 run error 均保留为页面 display data。
- 未修改 storage/core 策略、workflow 状态机、CLI、adapters/BOSS、通信执行、积分、依赖或数据。

## 剩余风险与下一步

- 本轮只迁移 `/plan`；workflow 详情页按范围未改，下一波应单独迁移且复用同一视觉 token。
- 浏览器验收使用隔离的假数据，证明布局和客户端门禁展示，不替代已登录 BOSS 的人工流程验收；后者仍需用户另行批准。
- 共享样式现在服务旧页面和 Today。后续页面迁移前应继续以现有 shell/route smoke tests 保护兼容性，避免把 Today 专属样式误扩展为全站行为。
