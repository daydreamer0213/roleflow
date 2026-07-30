# BOSS 消息只读发现设计

**日期：** 2026-07-30  
**状态：** 已确认  
**范围：** 第一阶段后台只读消息发现，接入现有求职进展卡和人工确认回复草稿  
**明确不包含：** 自动填写、自动发送、内部 API 重放、Cookie/localStorage 读取、日历写入

## 1. 目标

RoleFlow 在用户已经打开并登录的固定 BOSS 消息标签页中，后台发现带未读标记的会话，串行点开并读取最新 HR 消息。系统只在能可靠关联当前候选人的现有岗位进展卡时，才把消息正文临时交给现有分类和草稿流程。

最终用户流程是：

```text
用户打开固定 BOSS-COMMUNICATION 消息页
-> RoleFlow 扫描未读标记
-> 固化本轮只读队列
-> 串行点开并复核会话身份
-> 在内存中分类和生成最多两条草稿
-> 用户复制并手动发送
-> 用户点击“已手动发送”
```

“只读”指 RoleFlow 不修改聊天内容、不填写编辑器、不发送消息。为了读取不同会话，允许对左侧会话行执行一次受保护的后台点击。

## 2. 已确认的页面事实

本设计只依赖以下已脱敏确认的事实：

- 消息页路径为 `/web/geek/chat`。
- 会话行使用 `.friend-content-warp`。
- 当前选中会话带 `.selected` 或 `.friend-top`。
- 未读会话带 `.notice-badge`。
- 聊天顶部使用 `.top-info-content`。
- 岗位名称使用 `.chat-position-content .position-name`。
- 薪资使用 `.salary`。
- 城市使用 `.city`。
- 消息使用 `.message-item`。
- HR、本人和系统消息分别使用 `.item-friend`、`.item-myself`、`.item-system`。
- 每条消息有 15 位 `data-mid`。
- 编辑器 `.chat-input` 和发送按钮 `.btn-send` 必须永不触碰。
- 页面会请求 `getGeekFriendList.json`、`getBossData` 和 `historyMsg`。

本期不得重放这些内部请求，不得读取 Cookie 或 localStorage，也不得把完整请求 URL 写入日志或数据库。实现只使用页面 DOM 和现有 Edge Control 浏览器接口。

## 3. 产品边界

### 3.1 自动做什么

- 找到唯一一个已经打开的 `/web/geek/chat` 标签页。
- 只扫描带 `.notice-badge` 的会话行。
- 用首次快照生成不可变队列。
- 一次只处理一条会话。
- 点击前重新读取并校验行索引、未读状态和瞬时签名。
- 点击后立即复核选中行、招聘方顶部信息、岗位、线程摘要和消息 ID。
- 可靠关联后，在内存中调用现有 `draftCommunication({ mode: "hr_reply" })`。
- 持久化经过净化的分类、阶段、缺失事实键、时间和安全标识摘要。

### 3.2 永远不自动做什么

- 不创建新的 BOSS 标签页，不导航到其他页面，不把标签页带到前台。
- 不点击除目标会话行以外的页面元素。
- 不查询、聚焦、赋值或点击 `.chat-input`、`.btn-send`。
- 不重放 BOSS 内部 API。
- 不访问 Cookie、localStorage、截图或完整网络请求 URL。
- 不保存 HR 原话、完整聊天、模型草稿正文或敏感 URL。
- 不自动接受面试、不确认时间、不访问日历。
- 不自动填写、不自动发送。

### 3.3 人工兜底

现有“粘贴 HR 消息”流程必须保留。以下任一情况发生时，自动发现停止，用户仍可回到人工粘贴：

- 会话与岗位不能唯一关联。
- 同一会话出现多条无法确定边界的未处理 HR 消息。
- 页面结构变化。
- 登录失效、风控、页面丢失或标签页身份漂移。
- 线程摘要与进展卡已绑定摘要不一致。
- 模型缺少用户确认事实。

## 4. 架构

采用四层最小结构，不把消息发现塞进现有大型 BOSS 适配器：

```text
boss_message_dom.js
  纯 DOM 快照、净化、未读队列
          |
          v
boss_message_reader.js
  单标签页发现、页面内原子 guarded click、点击后独立复核
          |
          v
message_discovery.js
  串行执行、岗位关联、模型调用、停止策略
          |
          v
candidate_progress.js + dashboard/server.js
  幂等事件/阶段 + 启停/状态/人工复制
```

### 4.1 纯 DOM 快照

`src/adapters/sites/boss_message_dom.js` 负责：

- 从 DOM 提取页面路径、会话行、选中状态、未读状态、风险/登录信号和顶部岗位信息。
- 从消息区只提取方向、15 位 `data-mid` 和正文。
- 检测 `.chat-input` 与 `.btn-send` 是否存在，但不返回元素引用，不执行任何操作。
- 在 Node 侧用 `node:crypto` 生成瞬时签名和安全摘要。
- 根据首次快照生成深冻结的未读队列。

队列项仅在内存中保存：

```js
{
  rowIndex,
  transientSignature
}
```

招聘方名称和预览只用于当次点击前核验，不进入日志或数据库。由于本次校准没有确认更细的子选择器，瞬时签名由 `rowIndex`、`.friend-content-warp` 第一条非空可见文本、最后一条非空可见文本和未读状态组成。签名只停留在本轮内存和单次浏览器命令参数中，用于同步判断同一行是否漂移，不用于岗位持久关联。

### 4.2 线程与消息安全标识

本期不读取平台 Cookie、localStorage 或内部 API 参数。RoleFlow 线程摘要定义为：

```text
SHA-256("boss" + NUL + `.top-info-content` 第一条非空身份行 + NUL + 规范化岗位名称)
```

这个摘要不是 BOSS 的官方线程 ID，而是 RoleFlow 的安全关联摘要。只有同时满足以下条件时才可绑定：

- 当前 profile 下岗位标题能唯一匹配一张非终态进展卡。
- 页面可见薪资、城市与本地岗位证据不冲突；缺失字段不用于猜测。
- 招聘方顶部信息和岗位名称均非空。
- 如果进展卡已有 `thread_key`，必须与本次摘要完全一致。

消息安全标识定义为：

```text
SHA-256("boss" + NUL + threadKey + NUL + data-mid)
```

数据库保存摘要，不保存 HR 正文。原始 `data-mid` 可以停留在本次内存快照中；持久化默认使用消息安全摘要。

如果同名岗位产生多个候选进展卡，或可见证据冲突，执行器停止并返回 `needs_user_action`，不得任选一张卡。

### 4.3 后台 guarded click

`src/adapters/sites/boss_message_reader.js` 只依赖现有浏览器接口：

- `browser.listTabs()`
- `browser.evalValue(tabId, expression)`

它明确不得调用：

- `browser.clickAt`
- `browser.createTab`
- `browser.navigate`
- `browser.bringToFront`

每一条队列项按以下顺序处理：

1. Node 根据不可变队列项生成一次 `guardedExpression`。
2. 通过单次 `browser.evalValue(tabId, guardedExpression)` 在页面侧执行同步函数。
3. 该函数确认路径仍是 `/web/geek/chat`，且无风险提示、无登录丢失。
4. 该函数按 `rowIndex` 重新定位 `.friend-content-warp`。
5. 该函数从当前行可见文本和未读状态同步复算瞬时签名。
6. 该函数确认签名完全一致、`.notice-badge` 仍存在、行唯一且可见可点击。
7. 所有条件满足后，该函数只执行该会话行的 `.click()`，返回固定安全结果；否则返回固定失败原因且零点击。
8. `evalValue` 返回后，reader 使用独立的只读快照轮询，最多 3 次，每次间隔 250 毫秒。
9. 确认目标行进入 `.selected` 或 `.friend-top`。
10. 确认顶部招聘方、岗位和线程摘要存在。
11. 确认消息区能找到合法的 15 位 `data-mid`。

步骤 3 至 7 必须位于同一个不含 `await`、定时器或外部回调的页面侧同步函数中。这样 DOM 无法在校验与 `.click()` 之间插入重排。该函数沿用现有 `__bossGuardedCommunicationClick` 模式，操作名固定为 `__bossGuardedMessageConversationClick`，只能返回：

```js
{ clicked: true, operation: "__bossGuardedMessageConversationClick", rowIndex }
{ clicked: false, operation: "__bossGuardedMessageConversationClick", reason }
```

`reason` 只能是预定义代码，不得包含招聘方、预览、消息正文、URL 或 DOM 内容。表达式只能对经全部守卫确认的一个 `.friend-content-warp` 元素调用 `.click()`，不能查找或点击编辑器、发送按钮及其他元素。

任何一步失败都停止整轮，不继续点击下一条。这避免列表刷新、排序变化或页面漂移后点错人。

首次快照生成的队列不可变。处理过程中出现的新未读会话不加入本轮，下一轮重新扫描。

成功处理一条会话后等待 1.5 至 2.5 秒随机间隔；每完成 10 次会话点击再冷却 15 秒。停止信号和租约丢失必须能中断等待。测试注入假等待和固定随机数，不实际休眠。

### 4.4 消息选择规则

系统只处理选中会话中最新的 HR 消息，并要求它满足：

- 方向是 `.item-friend`。
- `data-mid` 是 15 位数字。
- 消息安全标识尚未在该进展卡事件中出现。
- 从上一次本人消息之后，仅有这一条未处理 HR 消息。

如果发现多条无法确定边界的未处理 HR 消息，系统不合并、不猜测，停止并提示人工处理。系统消息不会作为 HR 回复。

### 4.5 岗位关联

`src/core/message_discovery.js` 从当前 profile 的全局进展池读取候选卡，不按搜索方案隔离。候选卡必须：

- `source === "boss"`。
- 阶段不是 `rejected` 或 `closed`。
- 对应岗位仍存在。
- 岗位标题与页面岗位名称规范化后相等。
- 可见薪资和城市如双方都有值则不得冲突。

匹配结果必须恰好一张。零张或多张都停止，不生成草稿。

## 5. 分类和草稿数据流

可靠关联后的正文只存在于局部变量：

```text
DOM message text
-> runBossMessageDiscovery 局部变量
-> analyzer.draftCommunication({ mode: "hr_reply", hrMessage })
-> 立即释放 hrMessage 引用
```

模型仍使用现有 `validateCommunication` 合同。结果处理沿用现有规则：

- 有可靠事实：最多两条草稿，阶段 `reply_ready`。
- 缺少事实：不生成可发送答案，阶段 `needs_user_action`。
- 面试邀请：阶段 `interview_invited`，草稿必须为空。
- 身份不可靠：不调用模型，停止并提示人工处理。

回复草稿只保存在 dashboard 进程内存中，用于本地页面展示。以下情况立即清除：

- 用户点击“已手动发送”。
- 用户点击“放弃本次草稿”。
- 新一轮消息发现开始。
- 30 分钟到期。
- dashboard 进程退出。

HR 正文在模型调用返回后立即从运行状态删除，永不通过状态 API 返回。

## 6. 数据持久化与幂等

复用现有 `candidate_progress_cards` 和 `candidate_progress_events`，不新增聊天表。

进展卡允许更新：

- `thread_key`：只保存 `sha256:<64 hex>`。
- `updated_at`。

进展事件允许保存：

- `platform: "boss"`。
- `threadKey: "sha256:<64 hex>"`。
- `messageKey: "sha256:<64 hex>"`。
- `messageCategory`。
- `missingFactKey`。
- `stage`。
- 事件时间。
- 固定净化摘要。

事件幂等键使用内部固定格式：

```text
message:boss:<64 hex message digest>
```

同一进展卡与同一消息重复执行时返回已有事件，不重复分类、不重复迁移阶段。相同幂等键但分类意图不同，返回 `PROGRESS_IDEMPOTENCY_CONFLICT`。

线程首次绑定、事件写入和进展阶段迁移必须在同一 SQLite 事务中完成。任一步失败全部回滚。

不持久化：

- HR 原话或预览。
- 模型草稿。
- 招聘方原始名称。
- 完整聊天。
- 截图。
- Cookie/localStorage。
- 完整 URL 或内部 API 参数。

## 7. 运行控制和并发

消息发现与现有扫描、详情读取、批量沟通共用 BOSS 页面资源。启动时必须调用现有 `acquireSiteScanLease`：

```js
acquireSiteScanLease(db, {
  site: "boss",
  owner,
  command: "discover-messages",
  planId: null
})
```

运行中定时调用 `renewSiteScanLease`，`finally` 中调用 `releaseSiteScanLease`。

因此：

- 已有扫描或沟通租约时，消息发现返回 409，不打开或点击页面。
- 消息发现运行时，扫描和批量沟通也不能启动。
- 同时最多一个消息发现运行。
- 不复用 `prepareCommunicationTab`，因为它可能创建或导航标签页。
- 只接受一个已存在的 `/web/geek/chat` 标签页；零个或多个都停止。

## 8. Dashboard

新增本地页面 `/messages?profileId=<id>`，显示：

- 当前状态：空闲、扫描中、已停止、需要处理、完成、被中断。
- 首次固化的未读数量。
- 已处理数量。
- 当前安全阶段，不显示 HR 原话。
- 需要人工处理的固定原因。
- 可复制的内存草稿。
- “已手动发送”和“放弃本次草稿”按钮。
- “开始只读发现”和“安全停止”按钮。
- 人工粘贴入口。

API：

```text
POST /api/message-discovery
GET  /api/message-discovery-status?profileId=<id>
```

`POST` 只接受 `start`、`stop`、`dismiss`。状态 API 永不返回 HR 正文、会话预览、招聘方原名、完整 URL 或浏览器对象。

## 9. 停止条件

以下错误立即停止整轮：

- `BOSS_MESSAGE_TAB_MISSING`
- `BOSS_MESSAGE_TAB_AMBIGUOUS`
- `BOSS_MESSAGE_PAGE_LOST`
- `BOSS_MESSAGE_STRUCTURE_CHANGED`
- `BOSS_MESSAGE_ROW_DRIFTED`
- `BOSS_MESSAGE_TARGET_MISMATCH`
- `BOSS_MESSAGE_THREAD_MISMATCH`
- `BOSS_MESSAGE_MULTIPLE_UNPROCESSED`
- `BOSS_LOGIN_REQUIRED`
- `BOSS_RISK_CONTROL`
- `BROWSER_TIMEOUT`
- `BROWSER_DISCONNECTED`
- `MESSAGE_DISCOVERY_LEASE_LOST`

身份关联失败使用安全结果 `needs_user_action`。只有已经唯一定位进展卡时才更新该卡；无法唯一定位时只更新本轮内存状态，不猜测写入任意卡。

## 10. 日志与隐私

允许日志字段：

- `profileId`
- `cardId`
- `jobId`
- 队列数量和处理数量
- 固定错误码
- 安全摘要的前 12 位
- 阶段和分类

禁止日志字段：

- DOM 快照整体。
- HR 正文和会话预览。
- 草稿正文。
- 招聘方原名。
- 完整 URL、Cookie、localStorage、请求头。
- `getGeekFriendList.json`、`getBossData`、`historyMsg` 的参数。

错误对象在进入 logger 前必须转换为固定错误码和净化消息，不能直接序列化浏览器返回值。

## 11. 测试策略

所有自动测试只使用：

- 脱敏 DOM fixture。
- 假浏览器。
- 假模型。
- 临时 SQLite 数据库。

测试必须覆盖：

- 只扫描 `.notice-badge`。
- 不可变队列。
- 列表重排后不点击。
- 每个会话最多一次页面内原子 guarded click。
- `clickAt`、`navigate`、`createTab`、`bringToFront` 调用次数均为 0。
- guarded expression 在同一同步函数内完成路径、风险、登录、行索引、瞬时签名和 `.notice-badge` 重校验。
- DOM 漂移时 guarded expression 返回固定失败结果且点击次数为 0。
- 从不查询或触碰 `.chat-input`、`.btn-send` 的交互方法。
- 点击后身份复核。
- 唯一岗位关联。
- 模糊关联停止。
- 消息幂等和事务回滚。
- HR 正文、预览和草稿不进入数据库或日志。
- 面试邀请无草稿。
- 风控、登录、页面丢失和租约丢失立即停止。
- 现有人工粘贴流程继续可用。
- 现有安全校准门和批量沟通失败路径不回归。

本阶段不再访问真实消息页。已确认事实固化为脱敏 fixture 后，开发和验证全部离线完成。

## 12. 验收标准

- 用户无需逐条手动点开未读会话。
- 系统只在后台操作一个已存在的消息标签页。
- 每次点击都在页面内原子重校验后执行，并在返回后独立复核身份。
- 任何不可靠映射都不会生成可发送草稿。
- HR 正文和模型草稿不持久化、不写日志。
- 面试邀请不生成草稿。
- 用户仍然手动复制、手动发送并确认。
- 人工粘贴流程保留。
- 受影响测试和完整离线测试全部通过。
- 独立复审确认状态迁移、隐私、幂等、租约和“永不发送”边界。
