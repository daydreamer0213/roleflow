# 智联只读找岗与分析 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将智联岗位发现与完整 JD 分析接入现有今日任务及岗位列表，保持 BOSS 和所有平台外部写边界。

**Architecture:** 智联读取器承担原生页面差异；只在现有搜索快照、执行入口和结果展示处接入第二种真实来源。平台条件独立保存，本轮来源冻结，继续复用 SQLite、轮次控制和现有分析。

**Tech Stack:** Node.js CommonJS、原生 SQLite、现有浏览器适配器、服务端 HTML、现有本地 Playwright；不新增运行时依赖。

## Global Constraints

- 一轮只选一个平台；智联首版只读，不投递、不沟通、不读取消息、不增加漏斗样本。
- BOSS 既有功能和旧配置不变；智联结果不能进入 BOSS 沟通库存或发送清单。
- 全程后台，不激活标签或窗口，不调用 Page.bringToFront；风险、掉页、身份不符或停止请求时保存进度并停止当前操作。
- 兼职默认排除、薪资默认空白；不以缺失活跃度排除智联岗位，不降低完整 JD 覆盖和分析质量。
- 原生条件分别保存，运行来源和条件冻结；跨平台岗位不自动合并，不静默删除未知条件。
- 不改版本、推送、合并、打包或发布，不使用用户真实数据库做测试。
- 所有任务使用上述 spec；实现细节由主控决定，已确认产品方向不逐项重新询问。

## 执行环境与基线

工作树 `D:\DevData\RoleFlow-worktrees\zhaopin-readonly`，分支 `codex/zhaopin-readonly`，起点 `15dc54867921ab3f621aa14a1070f7df180a3954`。复用 D 盘现有依赖。测试日志放 `D:\DevData\RoleFlow-multiplatform-research-20260906`，不影响安装版。

严格本地测试环境：

```powershell
$env:NODE_PATH='C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
$env:ROLEFLOW_REQUIRE_PLAYWRIGHT='1'
$env:PATH='D:\hermes\node;'+$env:PATH
& D:/hermes/node/node.exe tests/run_all.js
```

### Task 1: 智联原生搜索与详情读取契约

**Files:**
- Create: `src/core/zhaopin_search_scope.js`
- Create: `src/adapters/sites/zhaopin.js`
- Create: `tests/zhaopin_readonly_smoke.js`
- Create: `tests/fixtures/zhaopin/search.html`
- Modify: `tests/run_all.js`（只注册实际行为检查）

**Interfaces:**
- `canonicalizeZhaopinSearchTemplate(rawUrl)` 返回 `{mode:'inherited', url, cityCode}`；仅接受智联 HTTPS 搜索页，拒绝凭据与未知敏感参数，移除关键词、翻页和已知跟踪参数，保留支持的原生筛选。
- `buildZhaopinSearchUrl({keyword, searchTemplate})` 只替换关键词并进入 search 模式。
- `zhaopinJobIdentity(url)` 返回 `{source:'zhaopin', sourceId, url}`，严格验证实际 `/jobdetail/<id>.htm` 链接并移除跟踪参数。
- `ZhaopinSiteAdapter({browser, logger, sleepFn, randomFn, accessController})`：`preflight({tabId})`、`inspectInheritedSearchPage({tabId})`、`readSearchState(tabId)`、`readVisiblePaneDetail(tabId, card, signal, assertTabBindings)`。显式传入标签并每次核对归属；不使用默认活动标签选择。
- `readSearchState` 返回 `{url, keyword, filterSummary, cards, selectedIndex, detail, loading, risk, loginRequired}`；卡片只带局部定位所需字段，真实 sourceId 只从当前详情得到；`detail` 包含独立 title/salary/company/clientCompany/location/experience/education/description/url。
- 浏览器传输仍仅依赖既有 `listTabs`、`evalValue`、`navigate`。原生 DOM helper 作为字符串导出，供本地浏览器执行 fixture 检查。

- [ ] 写行为测试：异站/公司 URL 不能当岗位；同名不同编号独立；关键词只变 kw；完整详情不混入其他卡片或 HR 区域；未切换详情链接时不能返回新岗位；空标题/掉页/风险/取消明确停止，不激活前台。fixture 使用合成名称正文，结构取自已获 DOM。

```js
assert.notStrictEqual(zhaopinJobIdentity('https://www.zhaopin.com/jobdetail/CC138117190J40877589505.htm').sourceId,
  zhaopinJobIdentity('https://www.zhaopin.com/jobdetail/CC138117190J40880916805.htm').sourceId);
assert.throws(() => zhaopinJobIdentity('https://www.zhaopin.com/companydetail/CZ123.htm'));
const target = new URL(buildZhaopinSearchUrl({keyword:'AI 应用', searchTemplate:{url:'https://www.zhaopin.com/jobs/?pageMode=search&jl=548'}}));
assert.equal(target.searchParams.get('jl'), '548');
assert.equal(target.searchParams.get('kw'), 'AI 应用');
```

- [ ] 执行 `node tests/zhaopin_readonly_smoke.js`，确认因缺少上述能力失败。
- [ ] 实现最小读取与条件规范化；同名卡片按当前索引及完整卡片签名临时定位，点击前重新检查，点击后依照选中卡片、详情字段和新岗位链接判断结果；不得把临时索引写作 sourceId。
- [ ] 执行新检查与 `source_acquisition_smoke.js`、`inherited_search_scope_smoke.js`，自审后提交 Task 1。

### Task 2: 平台条件、薪资与分析隔离

**Files:**
- Modify: `src/core/inherited_search_scope.js`, `src/core/workflow_acquisition.js`, `src/core/scan_snapshot.js`, `src/core/search_plan_schema.js`
- Modify: `src/core/scoring.js` 及实际共用金额/资格读取入口
- Create: `src/storage/platform_search_context_store.js`
- Modify: `src/core/storage.js`（必要的显式迁移）
- Modify: `src/storage/workflow_store.js`, `src/storage/scan_store.js`（实际轮次隔离与共用浏览器互斥）
- Modify: `src/storage/job_store.js`、`src/core/job_analysis.js` 中事实传递（仅保留实际客户公司字段，不引入通用元数据系统）
- Create: `tests/platform_search_context_smoke.js`, `tests/zhaopin_analysis_smoke.js`

**Interfaces:**
- `savePlatformSearchContext(db,{planId,site,searchTemplate,filterSummary})`、`getPlatformSearchContext(db,{planId,site})`；按方案与来源唯一保存。不得覆盖整份方案、简历或旧轮次。
- 使用专用 `search_plan_platform_contexts` 表，不将用户模板放进只有 site 主键的平台目录缓存。为 workflow 增加来源，旧记录回填 boss，轮次序号按候选人、日期、平台唯一；不能让智联找岗消耗 BOSS 沟通轮次。沿用单事务迁移与现有备份检查，核对既有外键。
- 在既有 `acquireSiteScanLease` 的事务内检查 boss/zhaopin 的活动租约，再写实际 site 行；继续按 site+owner 续约/释放。该互斥保证同一运营数据库内的浏览器任务串行，不宣称能锁住独立数据库或人工操作。
- 通用继承范围校验按显式 site 分派；无 site 的旧轮默认 BOSS。BOSS 规范化结果及历史快照哈希不变。
- 智联 context 使用 `searchScope.site='zhaopin'`，来源、模板、关键词来源、筛选摘要和策略 hash 一起冻结；目标按已保存原生范围及关键词生成，不调用 BOSS 城市/薪资 lane 映射。
- 金额读取保留原文字；月薪千/万/元可用于比较，小时/天/年及遮蔽不误判为月薪。BOSS 活跃度约束只作用 BOSS；来源不改变匹配模型与二维表。
- 发布方继续使用 `company`，客户公司单独使用可选 `clientCompany`；在岗位和观察记录增加必要字段，往返存储和分析事实均保留。客户公司变更参与新岗位内容 hash；没有该字段的旧 BOSS hash 保持不变。

- [ ] 先写并运行失败检查：同方案两平台独立；未知/跨方案输入拒绝；旧 BOSS 快照仍可恢复；智联完整岗位不出现 activity_unverified/inactive_boss；带薪资阈值时中文月薪正确比较、小时薪资仍能触发兼职筛选。

```js
assert.deepEqual(salaryRangeK('1.5-1.6万·13薪'), {min:15,max:16});
assert.deepEqual(salaryRangeK('8000-15000元'), {min:8,max:15});
assert.deepEqual(salaryRangeK('150-200元/小时'), {min:null,max:null});
assert.deepEqual(salaryRangeK('面议'), {min:null,max:null});
```

- [ ] 实现必要迁移和来源分派；只在新平台需要的契约处扩展，不改 BOSS 生成模式。
- [ ] 新检查、存储迁移、scoring_url、screening_preferences、scan_snapshot、workflow_acquisition 回归通过；审查后提交 Task 2。

### Task 3: 串行采集、检查点和恢复接入

**Files:**
- Modify: `src/adapters/sites/zhaopin.js`
- Create: `src/adapters/sites/index.js`（两个真实读取器的轻量选择入口）
- Modify: `src/cli.js`, `src/core/scan_execution.js`, `src/application/workflow/index.js`, `src/core/job_analysis.js`
- Modify: `src/dashboard/server.js` 中实际扫描启动/快照/浏览器检查入口
- Create: `tests/zhaopin_workflow_smoke.js`

**Interfaces:**
- 智联 `scan(options)` 消费与现有扫描相同的关键词、预算、目标键、signal、绑定校验、逐岗位/逐目标/终态回调；返回统一岗位数组。分页/连续加载操作只使用补证后的真实 DOM。
- `buildScanCliArgs` 增加 `site`，默认 boss，恢复时来源取自已冻结 workflow，不取当前 UI 选择。
- `createSiteAdapter(site,context)` 仅支持 boss、zhaopin；未知站点报错。BOSS 沟通入口保持只创建 BOSS 适配器。
- `planner.site` / `searchScope.site` 冻结本轮来源；扫描批次、运行和详情落库来源一致。使用同一浏览器任务互斥，访问账本按实际站点归属。
- 智联分析后进入只读结果状态，允许结束/下一轮；BOSS `workflowEligibility` 不放宽，智联不以 BOSS 沟通库存决定是否扫描。
- 恢复时 orphan scan 查询、批次归属与分析状态转换均使用冻结来源；智联分析完成的合法终态在存储与页面一起支持，不残留“继续沟通”要求。

- [ ] 在最小后台实站补证搜索结果加载机制和非默认筛选后，保存脱敏结构证据；未证实的路径不能靠猜测上线。
- [ ] 写失败检查：冻结智联来源传到 CLI；同编号跨来源不串数据；逐岗结果先落库；暂停/结束/风险不再读下一岗；恢复保留原范围；未读尽/预算耗尽标部分完成而非全部完成；并发浏览器任务被拒绝。

```js
const args=buildScanCliArgs({site:'zhaopin',kind:'daily',dbPath:'fixture.sqlite',planId:1,browserMode:'edge',runId:'fixture'});
assert.equal(args[args.indexOf('--site')+1], 'zhaopin');
// 用真实 SQLite 和假浏览器执行开始→检查点→暂停→重启恢复→分析→结束，
// 断言两来源岗位各自存在、已读岗位不丢、未执行目标仍待继续、沟通批次为 0。
```

- [ ] 实现最小接入，不复制整个工作流；每次页面动作前核对停止/身份，动作后核对真实结果；已保存条件无法恢复时给出具体重设提示。
- [ ] 新检查与 workflow_end_to_end、workflow_control、workflow_recovery、scan_end_to_end_recovery、communication_cli_authority 回归通过；审查后提交 Task 3。

### Task 4: 今日任务入口、来源结果与无写能力边界

**Files:**
- Modify: `src/dashboard/server.js`、现有今日任务/结果渲染与脚本模块
- Modify: `src/core/communication_batches.js` 或实际公共批次创建资格入口（仅在当前可达路径缺少来源校验时补）
- Create: `tests/dashboard_zhaopin_smoke.js`
- Modify: `docs/PROJECT_HANDOFF.md`, `docs/NEXT_PHASE.md`, 本计划

**Interfaces:**
- 今日任务平台选择控制本次打开/保存原生条件/开始请求，结果页来源筛选只过滤展示，不改岗位或历史统计。
- 智联工作区按需准备同窗后台搜索页；先使用已有匹配页，只有不存在时创建。首次 URL 带方案首个关键词，不强设示例地区。保留默认 portable 与显式 edge 两条传输，不自动切换登录身份。
- 未启用写能力的平台既无操作按钮，也由服务端拒绝进入 BOSS 批次；不靠隐藏按钮作为唯一保护。

- [ ] 写 HTTP/本地浏览器失败检查：BOSS 默认为旧路径；选择智联打开带词页；保存和刷新后条件保留；启动请求携带来源；结果可见来源；无智联发送按钮；伪造批次请求被拒绝。
- [ ] 沿用现有视觉样式和原生 select，不重做布局、不增加大面积说明；新增错误显示发生位置及下一操作，不只显示编号。
- [ ] 本地页面完成一次合成数据完整流程与暂停恢复验证，检查桌面无溢出/页面错误/外部请求；记录真实平台未验收项。
- [ ] 运行新鲜完整 `npm test`、危险夹具扫描、`git diff --check`；审查整个分支并修复当前可达问题。
- [ ] 提交功能与最终文档，精确最终 SHA 再跑风险相关回归，交付分支和验证结果。不上线、不发布，后续由用户验收页面并单独授权集成。
