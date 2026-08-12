# BOSS 显式双详情模式设计

日期：2026-08-12  
状态：已批准实施

## 1. 结论

RoleFlow 保留已经实机验证稳定的右栏详情链路，同时增加一个只能显式启用的后台静默详情模式：

| 模式 | 用途 | 行为 |
|---|---|---|
| `trusted_pane` | 默认、有人值守或允许 Edge 到前台的扫描 | 继续使用 `Page.bringToFront -> 可信坐标 clickAt -> 右栏多重身份校验` |
| `search_page_api` | 后台静默扫描和本轮 Gate D 对照验收 | 在固定 `BOSS-SEARCH` 页面上下文中发起同源只读详情 GET，不点击、不激活、不导航详情页 |

默认值始终是 `trusted_pane`。普通 Dashboard 表单不新增实验开关；`search_page_api` 只能由显式运行参数或受控验收请求启用。

两条路径之间绝不自动回退。岗位读取失败、扫描恢复、Dashboard 重启或参数缺失都不能把本轮从一种模式切换到另一种模式。

## 2. 本次实机结论

受控校准运行 `8a6621cf-7119-4292-a363-8b7a94d101b0` 获得：

- 53 个唯一岗位；
- 3/3 次右栏详情读取成功；
- 3 份完整 JD；
- Windows 前台在第二次详情读取时从 `ChatGPT` 切换为 `msedge`。

因此：

1. 右栏链路的数据能力仍然有效，不能删除；
2. `Page.bringToFront` 在当前 Windows/Edge 环境不满足后台静默要求；
3. 正式后台全量验收不能继续使用 `trusted_pane`；
4. 已有两次同源详情 GET 探针证明 `search_page_api` 具备进入独立对照校准的基础，但尚未证明可替代右栏模式。

失败校准数据库永久排除，不进入 Gate D 质量样本。

## 3. 显式模式与恢复合同

新增运行参数：

```text
--detail-mode trusted_pane|search_page_api
```

规则：

- 新扫描未传参数时使用 `trusted_pane`；
- Dashboard 普通启动继续使用 `trusted_pane`；
- 受控验收可以显式传入 `search_page_api`；
- 模式写入扫描执行快照并参与快照哈希；
- 恢复扫描必须沿用快照中的模式；
- 显式恢复参数与快照不一致时失败关闭；
- 旧版、不含详情模式的中断快照不允许恢复；
- `refresh-details` 和沟通检查继续使用既有独立详情页能力，不属于本模式开关。

`search_page_api` 的任何失败只记录本模式错误，不调用：

- `readVisiblePaneDetail()`；
- `bringToFront()`；
- `clickAt()`；
- DOM/Vue 合成点击；
- 独立详情页；
- 新标签或新窗口。

## 4. 静默详情页面状态机

页面 helper 提供：

```text
__bossStartDetailFetch(jobId)
__bossDetailFetchState(jobId)
__bossConsumeDetailFetch(jobId)
__bossCancelDetailFetch(jobId)
```

状态：

```text
idle -> running -> succeeded | failed
```

约束：

- 全局最多一个详情请求处于 `running`；
- 每个岗位最多启动一次；
- 同岗位重复 start 只返回已有状态；
- 不同岗位并发 start 以 `BOSS_DETAIL_API_BUSY` 失败关闭；
- consume 只返回净化终态并清理；
- timeout、abort、页面丢失和标签漂移均尝试 abort 并清理；
- 清理失败不能覆盖原始致命错误。

页面闭包内请求：

```text
GET /wapi/zpgeek/job/detail.json
query keys: securityId, lid, _
```

`securityId`、`lid`、完整 URL、Cookie、请求头和原始响应只存在于页面闭包与局部变量。Node 只能收到：

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

本次不修改既有岗位 URL 保存和沟通 URL 合同，避免破坏已验证沟通链路；新 API helper 不得把新的敏感参数带入返回值、日志、访问事件、错误、检查点或验收产物。

## 5. 身份、完整性与停止规则

请求前必须同时通过：

1. 固定搜索标签和固定沟通标签仍绑定在同一预期窗口；
2. 页面仍是 `https://www.zhipin.com/web/geek/jobs`；
3. 页面不是登录页、风控页或丢失页；
4. 冻结岗位 URL 能提取 `expectedJobId`；
5. 卡片链接 ID 等于 `expectedJobId`；
6. 卡片 Vue `data.encryptJobId` 等于 `expectedJobId`；
7. 卡片 Vue 提供非空 `securityId` 和 `lid`。

成功响应必须满足：

```text
HTTP 200
body.code = 0
body.zpData.jobInfo.encryptId = expectedJobId
cleanDetailText(postDescription).length >= 120
```

HTTP 401 映射为 `BOSS_LOGIN_REQUIRED`，HTTP 403 映射为 `BOSS_RISK_CONTROL`，并立即停止扫描。标签/窗口漂移、搜索页丢失、bridge 断连、检查点失败、租约失败、预算耗尽和 `BOSS_DETAIL_API_BUSY` 同样立即停止。

其他单岗位错误保留岗位并记录精确错误码，不采用旧右栏内容：

- `BOSS_DETAIL_API_PARAMS_INVALID`
- `BOSS_DETAIL_API_HTTP_FAILED`
- `BOSS_DETAIL_API_RESPONSE_INVALID`
- `BOSS_DETAIL_API_ID_MISMATCH`
- `BOSS_DETAIL_API_DESCRIPTION_INCOMPLETE`
- `BOSS_DETAIL_API_TIMEOUT`

## 6. 访问预算、节奏和审计

新增访问动作：

```text
job_detail_fetch
```

它必须：

- 在 normal/recovery 的每个时间窗逐项复制 `pane_detail_read` 的额度；
- 预留事件只允许 `{ jobId }`；
- 纳入详情访问用量；
- 使用现有 `pane_detail_read` 的 8–14 秒随机等待；
- 复用现有 periodic、micro、macro cooldown；
- 复用 pacing checkpoint/resume；
- 每个岗位只预留一次并只发起一次 GET。

详情结果继续使用 `pane_detail_result` 审计事件，`accessMode` 新增白名单值：

```text
search_page_api
```

未知 `accessMode` 不得被当作成功模式。

## 7. 离线验收

至少覆盖：

- 默认模式仍是 `trusted_pane`，既有右栏顺序和测试不变；
- 显式 `search_page_api` 只调用 API 读取器；
- API 失败不会调用右栏读取器；
- 详情子路径 0 次 `bringToFront/clickAt/navigate/createTab`；
- 列表搜索导航仍正常允许；
- 卡片 ID、Vue ID、响应 ID 和完整 JD 全部通过才成功；
- HTTP、业务码、ID、JD、timeout、abort、busy 均失败关闭；
- 同岗位运行去重，不同岗位并发拒绝；
- 敏感 sentinel 不出现在 helper 返回、日志、事件、错误和回调；
- 新动作的 normal/recovery 额度与旧动作完全一致；
- 恢复快照绑定 `detailMode`，不同模式拒绝恢复；
- 完整离线测试通过，独立代码审查无 Critical/Important。

## 8. 真实 Edge 校准与正式 Gate D

先创建全新校准基线，显式使用 `search_page_api`：

- 最少 2 个关键词、最多 3 个详情；
- 3/3 身份和 JD 完整性通过；
- 当前高亮岗位、PageJobs 当前岗位和右栏岗位在请求前后不变；
- 无 Edge 前台激活；
- 无新标签、窗口或可见终端；
- 无登录、风控、页面丢失、标签漂移；
- 日志、SQLite 和产物无新增敏感 token。

校准失败立即停止，不运行正式全量。

校准通过后创建另一份全新正式基线，显式使用 `search_page_api` 跑完整 daily Gate D。正式结果必须与右栏历史能力基线比较：

- 岗位覆盖；
- 完整 JD 比例；
- 详情成功/失败码；
- 技术筛选和分析状态；
- 模型影子积分卡分布；
- 运行时间和风险信号。

只有正式全量达到既定 Gate D 且 Dashboard、自动沟通入口和消息只读页完成人工 Edge 验收后，Wave 0–4 才可进入第一阶段收口。Wave 5 保持停止。

