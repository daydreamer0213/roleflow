# Task 1 report: 智联只读搜索与详情契约

## RED

```powershell
$env:NODE_PATH='C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
$env:ROLEFLOW_REQUIRE_PLAYWRIGHT='1'
& D:\hermes\node\node.exe tests\zhaopin_readonly_smoke.js
```

预期失败已观察到：先是 `MODULE_NOT_FOUND`（两个 Task 1 模块尚不存在）；新增已证 `sl`、`el` 参数行为后，旧实现以 `ZHAOPIN_SEARCH_PARAM_UNSUPPORTED` 拒绝 `sl`；搜索页模式用例也曾显示推荐页会被错误当作搜索页。上述失败均在对应最小实现前发生。

## GREEN

使用同一环境运行：

```powershell
foreach ($file in @('tests/zhaopin_readonly_smoke.js', 'tests/source_acquisition_smoke.js', 'tests/inherited_search_scope_smoke.js')) { & D:\hermes\node\node.exe $file; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
```

结果：`zhaopin_readonly_smoke ok`、`source_acquisition_smoke ok`、`inherited_search_scope_smoke ok`，退出码 `0`。`source_acquisition_smoke` 输出 Node 自带 SQLite 实验性警告，未影响通过结果。

## 改动

- 新增智联搜索模板的严格规范化：只接受已证的 HTTPS `/jobs/?pageMode=search`，保留 `jl`、`sl`、`el`，只替换 `kw`，拒绝未知非追踪参数并指出参数名。
- 新增严格的岗位详情链接身份：仅 `/jobdetail/<id>.htm` 可成为 `zhaopin` 来源身份，跟踪参数移除。
- 新增显式标签绑定、风险/登录/掉页/取消停机、合成真实 DOM helper、同名卡片签名与索引复核、DOM 选卡后的详情链接及字段核验；没有前台激活、鼠标 CDP、导航到详情或扫描循环。
- 新增本地 Playwright 合成 DOM 行为检查，并在 `tests/run_all.js` 注册该实际行为检查。

## 未验证点

- 没有运行真实招聘平台或真实浏览器操作；本任务仅使用已提供的脱敏结构证据和本地拦截页面。
- 复杂原生条件仍默认拒绝，后续仅可在新证据出现后把对应参数加入白名单。
- 列表连续加载的滚动/终止态由 Task 3 实现；Task 1 不触发滚动。
