# Unified Message Workspace Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 HR 新招呼/待处理消息和已分析草稿统一为现有左列表、右详情工作台。

**Architecture:** 仅组合现有页面的 result/unresolved 视图，使用稳定且带类型的本地选择键。复用原文、草稿自动保存、来源筛选及原有处理动作，不改存储与外部浏览器行为。

**Tech Stack:** Node.js CommonJS、服务端 HTML、原生页面脚本、现有 CSS、Playwright 离线浏览器测试。

## Global Constraints

- 待处理消息与已分析消息使用同一个左侧紧凑列表、右侧单条详情布局，不在工作台上方堆叠独立大卡片。
- 消息来源筛选只改变显示；切换消息、来源和页面前保存当前草稿，保存失败保留当前内容，不丢失编辑。
- 保留 BOSS 已有人工关联、保存主动机会、忽略操作和回复发送能力；智联本轮不新增回复发送按钮。
- 优先复用现有存储、模型、分析、任务及界面，不新增依赖、组件库、全局平台框架或虚构岗位缓存。
- 不推送、合并、打包、发布或更改版本；现有安装版、备份和生产资料不变。

## Task 1: 一个消息列表与单条详情

本任务代码 `622e0ce`，保存竞态修复 `767c22b`、`e975a92`。独立复核关闭所有重要发现；主控在 `17cc3d4` 重新运行严格统一浏览器旅程，退出码 0。1440/390 合成页面检查通过，不代表真实消息至模型草稿全链已经验收；该部分属于后续子计划。

**Files:**
- Modify: `src/dashboard/message_discovery_view.js`
- Modify if needed: `src/dashboard/assets/roleflow.css`
- Test: `tests/dashboard_unified_messages_journey.js`
- Test: `tests/dashboard_message_discovery_smoke.js`

**Interfaces:**
- Consumes: `controller.pageState(profileId).results` 与 `listUnresolvedMessageDiscoveryItems(db, { profileId, platform: null })`，数据源不变。
- Produces: 每一显示项恰好一个 `.message-list-item[data-platform]` 与一个 `[data-message-detail-panel]`。待处理详情保留 `.message-unresolved`；草稿详情保留 `.message-result`，草稿字段和动作原合同不变。
- Selection: `data-message-view` 与 `data-message-detail-panel` 使用同一个安全稳定键。待处理键由 `platform + conversationKey` 派生，结果键由 `platform + cardId + messageGroupKey` 派生并包含类型前缀；可用内置 crypto 摘要转换为安全 HTML id。不使用数组位置作为持久选择标识。

- [x] **Step 1: 为混合列表和仅待处理页面加入失败行为测试。** 在已有临时数据库旅程种子中加入一条有原文的智联 pending，保留已有 BOSS pending、BOSS/智联 result 与草稿。新断言示例（使用测试实际 locator）:

```js
assert.equal(await page.locator('.message-workspace').count(), 1);
assert.equal(await page.locator('.message-unresolved:not(.message-workspace *)').count(), 0);
assert.equal(await page.locator('[data-message-detail-panel]:visible').count(), 1);
await page.locator('.message-list-item[data-platform="zhaopin"]').filter({hasText:'待补岗位资料'}).click();
assert.match(await page.locator('[data-message-detail-panel]:visible').innerText(), /合成待处理原文/);
```

覆盖从草稿切入待处理前保存、保存失败仍留在草稿，快速切换不出现列表勾选与详情错位；来源改变或刷新后保持同一有效选择，否则选该来源首条。只有待处理时仍可选择并保留 BOSS 原操作；空来源不能显示其他平台详情。重新渲染新增一条记录不应使仍有效的选中键指向别条。修改现有“所有 pending 都可见”断言为选择对应行再验证，不删掉其历史记录保留、来源隔离与安全停止含义。

- [x] **Step 2: 运行失败测试并记录真实失败。**

```powershell
$env:NODE_PATH='C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
$env:ROLEFLOW_REQUIRE_PLAYWRIGHT='1'
$env:TEMP='D:/DevData/RoleFlow-tests'
$env:TMP=$env:TEMP
D:/hermes/node/node.exe tests/dashboard_unified_messages_journey.js
```

预期新行为断言失败（当前 pending 在 workspace 外），不是依赖缺失或语法失败。

- [x] **Step 3: 最小组合视图并统一选择。** `renderUnresolvedItem` 保留已有正文/表单内容，外壳进入与 result 相同的 view model。已分析列表原顺序优先，pending 接在其后；左侧 pending 用简短状态而非完整原文。右侧不为普通“待补资料”额外新建红色巨幅外壳。

```js
const views = [...resultViews, ...unresolvedViews];
// Each view owns { key, platform, list, detail }; all details are in one workspace.
```

脚本只通过一个选中键决定可见详情；删除旧的“显示全部同来源 unresolved”分支。现有自动保存写队列保持串行；消息/来源切换遵循最后一次有效操作，并在失败时保留原项及未保存文字。不为并发修复引入框架。只在本机存储该用户来源与选中键，不存原文。`[hidden]` 规则不被 CSS 覆盖。

- [x] **Step 4: 运行覆盖回归并做合成视觉检查。**

```powershell
D:/hermes/node/node.exe --check src/dashboard/message_discovery_view.js
D:/hermes/node/node.exe tests/dashboard_message_discovery_smoke.js
D:/hermes/node/node.exe tests/dashboard_unified_messages_journey.js
D:/hermes/node/node.exe tests/dashboard_message_reply_send_smoke.js
git diff --check
```

预期全部退出码 0，1440/390 视口无横向溢出，同一时刻一个详情。现有 SQLite ExperimentalWarning 是已知基线，不掩盖或修改无关运行时。截图使用合成资料写 D 盘，不提交真实原文截图。控制器在全部新增子计划完成后统一运行严格完整门禁，本任务不要重复整库门禁。

- [x] **Step 5: 提交、独立复核并记录结果。** 仅暂存本任务拥有的实现和测试文件，报告 RED/GREEN、SHA、UI 变化与未验证前提；不改其他在途文件。由控制器更新本计划复选框和阶段交接。
