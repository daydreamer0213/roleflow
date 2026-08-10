# Wave 2.1 Dashboard Foundation 效果评测

评测对象：`2346722`（baseline）到已合并 `82ab5ae`（merge，包含 `51d5b90` 与 `d50cd75`）。本报告是只读架构与效果评测；没有访问真实 BOSS、网络或凭据，也没有修改 `src/`、`tests/`、`data/`、`package*`、`node_modules/` 或 `browser/`。

## 结论

Wave 2.1 达成了“foundation”目标，但没有完成完整 UI 美化或完整页面模块化。response、shell、navigation 和本地 CSS/asset allowlist 已形成清晰的低层依赖方向；现有业务页面仍主要集中在 `server.js`，因此更准确的结论是“公共基础设施已抽出并被真实页面消费”，不是“dashboard 已完成重构”。

建议继续 Wave 2.2，但应把它定义为 Today/Workflow 的边界迁移与回归巩固，不能以继续搬运 CSS 或再加一层 shell 作为完成标准。

## 1. 目标与依赖方向

当前方向如下：

```text
server.js（路由、业务 handler、页面组合）
    ├── ui/navigation.js ──┐
    ├── ui/shell.js        ├── http/response.js
    └── assets allowlist ──┘
                              └── assets/roleflow.css
```

- `http/response.js` 负责 `sendHtml`、`sendJson`、`escapeHtml`、`escapeAttr`；它没有反向依赖 dashboard 业务。
- `ui/shell.js` 只依赖 response 的 HTML 转义，并输出唯一 HTML 文档壳和固定 `/assets/roleflow.css` 引用。
- `ui/navigation.js` 只依赖 response 的转义，集中生成导航链接与 `aria-current="page"`。
- `DASHBOARD_ASSETS` 是冻结的路径到文件映射；请求只有命中 `/assets/roleflow.css` 才能进入 asset reader，未知 asset 不会按用户路径访问文件系统。
- `server.js` 依赖这些基础模块，保留路由、数据库、workflow、communication、页面业务组装，依赖方向没有倒置。

`server.js` 从 baseline 的约 4,793 行变化到合并 blob 约 4,792 行；工作区当前读取为 5,020 行（行尾/工作区读取口径不同，不能把这个差值当成效果指标）。合并 diff 是 `+309/-41`，其中新增了 19 行 response、49 行 navigation、7 行 shell、10 行 CSS 与两条 smoke；这是职责迁移，不是单纯减行。

公共职责已减少：原先内联的 HTML response/escape 实现和公共壳 CSS 已移出，导航也从字符串拼接集中到独立 renderer。仍集中在 `server.js` 的职责包括：全部 HTTP 路由分派、绝大多数页面 renderer、workflow/scan/communication handler、错误页，以及页面专属 inline CSS。当前 `server.js` 仍有约 212 个顶层函数；这说明 Wave 2.1 是基础层抽取，不是业务页面拆分。

## 2. 51d5b90 的 3 个 P1 与 d50cd75 的关闭情况

以下按初版审查发现的高影响问题记录，并以最终代码与新增回归断言为证据：

1. **导航 active 状态错误且无法覆盖真实页面类型。** 初版在存在 `planId` 时无条件把当前链接标成“今日任务”，workflow、queue、communication、settings、diagnostics 等页面会得到错误的 active 语义。`d50cd75` 增加 route/path 解析、`todayPath` 过渡参数，并按八类页面验证：plan、workflow、queue、communication/new、communication、settings、diagnostics、onboarding。最终每种页面最多有对应的 `aria-current="page"`。
2. **真实非空 Queue 的 shell 边界没有被锁定。** 初版 smoke 只检查若干空页面和资产引用，不能证明 `/queue?planId=...` 在有岗位时不会重复文档壳或导航。`d50cd75` 加入 SQLite queue fixture，并断言标题、pool tabs、唯一 `<!doctype html>`、唯一 `<body>`、唯一全局 `<nav>`，从而把实际页面组合路径纳入门槛。
3. **asset allowlist 的失败语义缺少可注入、可重复的回归门槛。** 初版可读资产路径与 unknown path 有覆盖，但 asset read 失败未作为独立契约锁定，后续错误处理容易被误改成半响应或未处理异常。`d50cd75` 注入 `assetReader`，新增 `dashboard_asset_failure_smoke`，明确要求 allowlisted asset 读取失败返回完整 HTTP 500、HTML content type 和公共错误页。

因此，质量门槛实际抓到的不是抽象的“模块存在”，而是三个用户可见/运维可见的回归面：导航语义、非空 Queue 文档结构、资产读取失败响应。

## 3. 行为评测

我的离线运行结果如下，均为独立命令运行并返回 `ok`：

- 新增 smoke：`dashboard_shell_smoke.js`、`dashboard_asset_failure_smoke.js`
- dashboard/workflow：`workflow_dashboard_smoke.js`、`dashboard_scan_lifecycle_smoke.js`、`workflow_communication_smoke.js`
- queue/dashboard extensions：`outcome_analytics_dashboard_smoke.js`、`dashboard_communication_batch_smoke.js`、`dashboard_message_discovery_smoke.js`
- communication/settings/onboarding：`communication_smoke.js`、`model_settings_ui_smoke.js`、`onboarding_smoke.js`

主控证据另有记录：主控已在 `main` 运行完整 runner 的 77 项。本段只引用为主控证据，不把它伪装成我的运行；我的直接证据是上面 11 条 smoke。

行为结论：

- **固定 asset allowlist：通过。** `/assets/roleflow.css` 返回 CSS；映射是固定对象，不接受任意文件名。
- **未知路径：通过。** `/%2e%2e%2fpackage.json` 这类未知 asset 返回 404 `Not found`，没有读取目标文件。
- **asset read 500：通过。** 注入 reader 抛错时，返回 500 HTML 公共错误页，而不是未完成响应。
- **八类 `aria-current`：通过。** 新 smoke 覆盖并验证了八种页面情形，且 route 判断不会把 query string 误当作 route。
- **真实非空 Queue 单一 shell：通过。** fixture queue 返回正常标题和 tabs，只有一个 doctype、一个 body、一个全局 nav。
- **URL/form/API：未见 Wave 2.1 改变既有契约。** diff 中路由分派与表单 action/API path 保持原值；变化主要是导航调用参数从位置参数改为对象参数，以及新增 CSS GET。现有 workflow、communication、settings、onboarding smoke 通过，支持此结论；这里的“未见改变”是代码与离线 smoke 证据，不是线上 BOSS 验证。

## 4. 边界缺口与风险

按影响排序：

1. **Today/Workflow 迁移风险最高。** `currentPath`、`todayPath` 仍是过渡接口，调用方要同时理解“当前页面”和“今日任务目标”；继续迁移时容易出现 active 错误或丢失 `planId`。Wave 2.2 应先定义稳定的导航上下文/route contract，并保留上述八类回归。
2. **`server.js` 仍承载页面层。** `renderOnboarding`、settings、workflow、communication、error 等 renderer 和大量业务 handler 都在同一文件。基础抽取虽然有效，但文件内耦合仍高；优先迁移 Today/Workflow 的页面组合，不要先做无行为收益的全量拆分。
3. **`renderCompactDashboard` 仍含专属 inline CSS。** 公共 CSS 已本地化，但 dashboard/queue 的大量页面专属样式仍以内联 `<style>` 存在；因此“local CSS”目标只完成公共层，不能宣称样式系统完成。
4. **asset read 仍同步。** `sendDashboardAsset` 默认使用同步 `fs.readFileSync`。单个小 CSS 对当前本地 dashboard 风险有限，但请求处理会被文件读取阻塞；若未来增加资产或部署到并发环境，应改为异步 reader，并保持 500 契约。
5. **错误页导航仍是降级导航。** `renderErrorPage` 用空上下文生成导航，错误页没有保留来源页面/`planId`；用户可能回到根路径而不是回到当前 workflow/queue。可在不泄露错误细节的前提下传递安全的 back/context。
6. **后续页面迁移要防止壳重复。** Queue 的真实非空 fixture 已证明当前组合是一层壳，但新增 Today/Workflow renderer 时必须继续复用 `renderPage`，不得让页面 renderer 自己输出第二个 document shell。

## 5. 下一步与 Wave 2.2 决策

建议继续 Wave 2.2，优先级为：

1. 固化 navigation context/route contract，完成 Today 与 Workflow 的调用方迁移，并保留八类 active、URL/form/API、不重复 shell 的 smoke。
2. 把 `renderCompactDashboard` 的公共/页面专属 CSS 边界写清楚；只迁移可复用规则，避免为了“CSS 全部外置”制造大范围视觉回归。
3. 迁移 Today/Workflow 页面组合到独立 view 模块，handler 仍可暂留 server；每次迁移增加一个真实非空 fixture，而不是只测导出函数。
4. 评估异步 asset read 的收益与复杂度；若暂不改，至少保留当前注入 reader 的 500 回归。
5. 改善错误页导航上下文并补 smoke，再考虑低影响的 server.js 进一步拆分。

Wave 2.2 的验收应称为“页面边界迁移与行为稳定性”，而不是“完成 UI 美化”。当前 foundation 已足以支持下一轮，但仍存在明确的页面职责集中和过渡接口风险。

## 验证记录

- `git diff --stat 2346722..82ab5ae`：8 个文件，`309 insertions(+), 41 deletions(-)`。
- `git diff --check 2346722..82ab5ae`：无输出，退出码 0。
- 未运行完整 runner；完整 77 项是主控在 `main` 上的证据，不是本次代理运行结果。
