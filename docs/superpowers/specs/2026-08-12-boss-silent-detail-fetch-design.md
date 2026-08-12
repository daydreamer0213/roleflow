# BOSS 静默详情直读设计

日期：2026-08-12  
状态：备选研究，暂停实施；正式主链路以 `2026-08-12-boss-trusted-pane-restoration-design.md` 为准

> 2026-08-12 纠偏：真实历史证据证明 `Page.bringToFront + 可信坐标点击` 的右栏读取稳定可用；近期失败来自删除标签激活后的变体，不能用于否定原链路。本设计保留两次同源只读探针及安全合同，供未来独立对照评测，但不再授权接入正式扫描、替换主链路或作为自动回退。

## 1. 结论

普通 BOSS 扫描不再通过 UI 切换岗位卡和右栏详情。唯一自动详情路径改为在固定 `BOSS-SEARCH` 页面上下文中发起同源只读请求：

```text
GET /wapi/zpgeek/job/detail.json
```

请求只使用精确卡片 Vue 数据中的 `securityId`、`lid` 和时间戳。安全参数仅存在于页面闭包，不得返回 Node.js、写入日志、数据库、错误消息或验收产物。

自动扫描不得回退到 `Page.bringToFront`、坐标点击、DOM/Vue 点击、独立详情页或新标签。

## 2. 实机证据

### 2.1 被否定的路径

在 `main@9550ed2` 的普通 Edge 固定搜索标签上：

- 后台 CDP 坐标点击 10 次：
  - 9 次 `BOSS_PANE_SWITCH_TIMEOUT`；
  - 1 次成功只是复用了页面当前已选详情；
  - 正式扫描已停止并标记为 `BACKGROUND_PANE_SWITCH_UNRELIABLE`，不得作为评测样本。
- 两次 `JodCard.clickJobCard()`：
  - 高亮卡片 ID 和 `PageJobs.currentJob.encryptJobId` 都切换到目标；
  - 没有完成新的详情加载；
  - `jobDetailLoading=true`、右栏 ID 为空、JD 长度 0；
  - 页面始终无风控，Edge 未成为 Windows 前台。

因此“隐藏标签中的 UI 切岗”不能作为可靠详情路径。

### 2.2 接口合同证据

当前页面资源记录确认详情请求为：

```text
GET https://www.zhipin.com/wapi/zpgeek/job/detail.json
query keys: securityId, lid, _
```

当前页面精确卡片同时提供：

- `encryptJobId`
- `securityId`
- `lid`

两次只读同源探针均在 Edge 不是 Windows 前台、页面 `visibility=hidden` 时完成：

1. 当前卡片：
   - HTTP 200；
   - 业务码 0；
   - 212ms；
   - `zpData.jobInfo.encryptId` 与卡片岗位 ID 一致；
   - `postDescription` 1382 字。
2. 非当前卡片：
   - HTTP 200；
   - 业务码 0；
   - 175ms；
   - 响应岗位 ID 与目标卡片 ID 一致；
   - `postDescription` 564 字；
   - 页面高亮卡片、父组件当前岗位和右栏岗位 ID 全部保持不变。

探针前后 Windows 前台进程都不是 Edge。

## 3. 身份与数据合同

详情请求前必须同时满足：

1. 固定搜索标签仍绑定到预期 tab/window；
2. 页面仍是 `https://www.zhipin.com/web/geek/jobs`；
3. 页面不是登录页、风控页或丢失页；
4. 冻结岗位 URL 能提取 `expectedJobId`；
5. 通过卡片链接精确找到同一 `expectedJobId`；
6. 卡片 Vue `data.encryptJobId === expectedJobId`；
7. 卡片 Vue 同时存在非空 `securityId` 和 `lid`。

响应必须满足：

```text
HTTP status = 200
body.code = 0
body.zpData.jobInfo.encryptId = expectedJobId
normalize(body.zpData.jobInfo.postDescription).length >= 120
```

Node 侧只接收以下净化结果：

```js
{
  jobId,
  description,
  salary,
  experience,
  education,
  bossActiveText
}
```

除 `jobId` 和 JD 正文外，其他字段仅从响应公开岗位字段中白名单读取；缺失时继续使用卡片已有值。不得返回原始响应、请求 URL、`securityId`、`lid`、Cookie、请求头或联系人信息。

## 4. 页面请求状态机

为避免浏览器命令的 15 秒传输超时，页面 helper 使用两阶段状态机：

```text
idle -> running -> succeeded | failed
```

### 4.1 启动

`window.__bossStartDetailFetch(expectedJobId)`：

- 精确定位卡片和 Vue 数据；
- 若该岗位已有 `running` 状态，不重复请求；
- 若已有未消费的终态结果，返回终态而不重复请求；
- 创建一次同源 `fetch`；
- 页面全局状态只保存：
  - 岗位 ID；
  - 状态；
  - 开始时间；
  - 净化结果或净化错误码；
  - AbortController。
- `securityId/lid` 只存在于异步闭包和 URL 局部变量。

### 4.2 轮询

`window.__bossDetailFetchState(expectedJobId)` 只返回净化状态。Node 每次轮询前后继续检查：

- 停止信号；
- 固定标签绑定；
- 搜索页身份；
- 登录/风控/page-loss。

### 4.3 消费与清理

`window.__bossConsumeDetailFetch(expectedJobId)` 只在终态时返回净化结果并删除页面状态。

扫描中止、超时或身份漂移时调用 `window.__bossCancelDetailFetch(expectedJobId)`，中止请求并删除状态。不得自动发起第二次请求。

## 5. 错误合同

单岗位失败并保留待续：

- `BOSS_DETAIL_API_PARAMS_INVALID`
- `BOSS_DETAIL_API_HTTP_FAILED`
- `BOSS_DETAIL_API_RESPONSE_INVALID`
- `BOSS_DETAIL_API_ID_MISMATCH`
- `BOSS_DETAIL_API_DESCRIPTION_INCOMPLETE`
- `BOSS_DETAIL_API_TIMEOUT`

立即停止整个扫描：

- 登录丢失；
- 风控页或 HTTP 401/403；
- 搜索页丢失；
- 固定标签身份漂移；
- Edge bridge 断连/超时；
- 检查点或租约失败；
- 访问额度耗尽。

业务响应未知或无法证明身份时失败关闭，不猜字段、不采用页面旧右栏内容。

## 6. 访问预算与节奏

新增访问动作：

```text
job_detail_fetch
```

新增结果模式：

```text
search_page_api
```

规则：

- `job_detail_fetch` 使用与当前 `pane_detail_read` 相同的 normal/recovery 各时间窗额度；
- 每次请求前继续执行现有 `pane_detail_read` 的 8–14 秒随机详情间隔；
- 每个岗位只预留和发送一次；
- 成功或失败后继续执行现有 micro/macro cooldown 和 pacing checkpoint；
- `job_detail_fetch` 纳入详情访问用量，但不与旧 `pane_detail_read` 同时执行；
- 旧历史事件保留用于审计，不删除、不迁移；
- 普通扫描成功结果的 `accessMode` 为 `search_page_api`。

## 7. 扫描集成

`scanBrowser()` 的详情循环保持现有：

- 公平分配详情额度；
- detail attempt 去重；
- 成功后 normalize、checkpoint、候选合并；
- 失败后保留岗位及精确错误码；
- target checkpoint/resume；
- 风控/浏览器/租约致命停止。

只把调用从：

```js
readVisiblePaneDetail(...)
```

替换为：

```js
readSearchPageApiDetail(...)
```

删除自动扫描对 `bringToFront()`、`clickAt()` 和右栏切岗 helper 的依赖。独立详情页能力继续仅供既有人工补读/沟通检查使用。

## 8. 隐私

以下值不得越过页面执行上下文：

- `securityId`
- `lid`
- Cookie
- 完整请求 URL
- 请求头
- 原始 JSON 响应

日志和审计只允许：

- 岗位内部 ID 或现有 sourceId；
- outcome；
- errorCode；
- accessMode；
- HTTP 状态类别（可选，不含 URL）；
- JD 长度（可选）。

## 9. 验收

### 离线

- 精确卡片 ID、Vue ID、响应 ID 四重一致；
- 0 次 `bringToFront/clickAt/navigate/createTab`；
- token 不出现在 helper 返回值、日志、事件、错误和快照；
- 每岗位最多 1 次 fetch；
- running 不重复启动；
- timeout/abort 会清理；
- HTTP/业务码/ID/JD 合同失败关闭；
- login/risk/page-loss/bridge/lease/checkpoint 保持致命；
- `job_detail_fetch` 限额、恢复模式、checkpoint/resume 全覆盖；
- 全量离线套件通过。

### 真实 Edge

先创建新的空操作表基线，不能复用：

- 2026-08-12 后台坐标点击失败库；
- 单目标校准库；
- 任何 interrupted 库。

先跑 1 个关键词、最多 3 个详情的静默校准：

- 3/3 API 身份与 JD 完整性通过；
- Edge 不是 Windows 前台；
- 页面当前/右栏岗位不变；
- 无新标签/窗口；
- 无登录/风控/page-loss；
- 无 token 落盘。

通过后才运行完整 daily Gate D 扫描和固定导出。

## 10. 非目标

- 不修改评分、推荐阈值、模型提示词或岗位覆盖目标。
- 不修改沟通、发送、投递权限。
- 不直接通过 Node HTTP 客户端复制 Cookie。
- 不保留自动 UI 点击或独立详情页回退。
- 不启动 Wave 5。
