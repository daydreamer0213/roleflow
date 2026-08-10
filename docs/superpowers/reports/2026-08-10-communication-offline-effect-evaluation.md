# RoleFlow 自动沟通模块离线端到端效果评测

日期：2026-08-10
基线：当前 `main`（`f7f640b`）
范围：只读代码追踪与离线 smoke；未访问真实 BOSS，未发送消息、投递或改变浏览器状态。

## 结论摘要

当前四类状态应分开记录：

| 状态 | 当前结论 | 证据边界 |
|---|---|---|
| implementation | `implemented` | dashboard、批次存储、executor、workflow 汇总/恢复和消息辅助链已接通；见代码与离线测试。 |
| calibration | `calibrated` | 技术执行门返回 `executionEnabled: true`；`communication_calibration_gate_smoke` 和 dashboard 状态断言通过。 |
| offline regression-safe | `pass`（相关 13 个 smoke） | 使用内存 SQLite、fake browser、脱敏/固定 fixture 和 HTTP 测试；不等于真实页面验收。 |
| human e2e acceptance | `e2e_pending` | 没有本轮真实 BOSS 人工验收记录；不得写成 `accepted`，也不得把 `executionEnabled` 或 `calibrated` 当成人工验收。 |

完整 `npm.cmd test` 在 124 秒达到超时，未取得全套通过结论；这不改变下述 13 个直接相关 smoke 的独立通过结果。

## 目标

验证从 dashboard 选择岗位开始，经 `POST /api/communication-batch` 创建不可变批次，经过额度与校准门、审阅、executor、结果/歧义处理，再回到 workflow 汇总和恢复的完整离线链；同时检查消息预览、发现、回复契约不会越过只读/身份/结果安全边界。

## 当前可证事实

### 代码链

1. Dashboard 在 `src/dashboard/server.js:4285` 和 `src/dashboard/server.js:4706` 渲染审阅/选择清单，提交入口为 `POST /api/communication-batch`（`src/dashboard/server.js:509`）。提交处理在 `src/dashboard/server.js:3015`，先取额度，再调用 `createCommunicationBatch`，并保存校准快照。
2. `createCommunicationBatch`（`src/core/communication_batches.js:35`）校验 workflow、plan、浏览器模式、岗位选择和决策池；在事务中检查额度（`:94-96`），写入岗位 URL、标题、公司等快照，并将 workflow 关联到批次和 review 阶段（`:125-129`）。已派发/歧义/成功/已沟通岗位不能被重复加入活动批次（`:102-105`）。
3. 批次和 item 有显式状态机（`src/core/communication_batches.js:15-31`）。`verified -> click_dispatched` 需要合法审计事件；`click_dispatched` 只能到 `succeeded`、`already_communicated`、`ambiguous` 或 `stopped`。歧义不能用普通 transition 越过 resolver（`:249-257`）。
4. Dashboard 控制入口为 `POST /api/communication-control`（`src/dashboard/server.js:510`，处理在 `:3037`）；开始/继续前调用 `assertCommunicationExecutionEnabled`（`:3046-3054`），只允许合法的 confirmed/paused/interrupted 状态。歧义批次在人工处理前恢复会返回 `COMMUNICATION_RESUME_REQUIRES_REVIEW`（`:3056`）。
5. `/api/communication-resolve`（`src/dashboard/server.js:511`、`:3152`）只接受歧义项的 `succeeded` 或 `stopped`，并要求人工 `evidenceNote`；审阅页对歧义项显示必填依据（`:4715`）。
6. executor 入口 `runCommunicationBatch`（`src/core/communication_executor.js:27`）逐项串行处理；页面检查失败分别落为 `job_unavailable`、`target_mismatch`、`action_unavailable`（`:123-125`），点击后无法唯一确认落为 `ambiguous`（`:380-385`），暂停/中断保留未完成项，禁止自动补点或隐式成功。
7. 中断恢复（`src/core/communication_batches.js:354`）只允许 interrupted 批次；`opening`/`verified` 且未点击的项回到 pending，`click_dispatched` 转为 ambiguous 并要求复核（`:364-376`）。resolver 完成后才允许继续。
8. executor 完成时以成功/已沟通结果更新 workflow 成功数和短缺信息（`src/core/communication_executor.js:307-321`）；workflow 侧将 communication batch、summary、successfulCount 和中断/恢复信息合并到 dashboard（`src/dashboard/server.js:4011-4057`、`4245-4247`；`src/core/workflow_run.js:409-511`）。
9. 校准状态由 `src/core/communication_calibration.js:4-18` 暴露为 `implementation`、`calibration`、`acceptance`、`executionEnabled` 四字段；当前技术门为 true，但 acceptance 明确是 `e2e_pending`。

### 真实页面风险边界

代码/fixture 能证明 fail-closed 规则和历史脱敏证据约束，但不能证明 2026-08-10 的真实 BOSS DOM、账号状态、当前 host/URL、页面文案、聊天身份参数或风险控制状态。历史文档中的一次校准点击不是本次人工 E2E 验收，也不扩展为当前页面事实。

## 测试清单及本轮新鲜结果

以下 13 个测试均在本轮逐个以 `node tests/<name>` 运行，结果全部为 exit 0：

| Smoke | 覆盖重点 | 结果 |
|---|---|---|
| `communication_cli_authority_smoke.js` | CLI authority、离线批次执行入口 | PASS |
| `workflow_communication_smoke.js` | workflow review → batch → executor → 汇总/成功数/审计 | PASS |
| `communication_batch_storage_smoke.js` | 批次/item 状态机、额度、事务、中断恢复、歧义 | PASS |
| `communication_executor_smoke.js` | 串行 executor、岗位不可用、身份不一致、暂停/停止/歧义 | PASS |
| `dashboard_communication_batch_smoke.js` | dashboard 页面/API、审阅、开始/恢复、人工 resolve、额度/运行时阻断 | PASS |
| `communication_calibration_gate_smoke.js` | 校准状态、execution gate、API 入口 | PASS |
| `boss_communication_page_smoke.js` | fake 页面 ready/already/unavailable、身份与点击后结果判定 | PASS |
| `message_preview_state_smoke.js` | 消息预览状态契约 | PASS |
| `message_discovery_smoke.js` | 消息发现、稳定身份/歧义处理 | PASS |
| `message_reply_contract_smoke.js` | 回复生成/发送契约边界 | PASS |
| `boss_message_dom_smoke.js` | 消息列表 DOM、预览分类和摘要 | PASS |
| `boss_message_reader_smoke.js` | fake browser 消息读取、预览漂移保护 | PASS |
| `dashboard_message_discovery_smoke.js` | dashboard 消息发现 API/展示/阻断 | PASS |

统一 runner `tests/run_all.js` 也把这些测试列为 offline checks。尝试运行 `npm.cmd test` 时 124 秒超时，未输出完整 runner 结论；因此本报告不声称全仓离线测试通过。PowerShell 直接执行 `npm test` 只因脚本执行策略被拦截，随后已用 `npm.cmd test` 重试。

## 覆盖矩阵

| 场景 | 离线证据 | 当前判定 |
|---|---|---|
| 正常 ready → 成功 | `boss_communication_page_smoke`、`communication_executor_smoke`、`workflow_communication_smoke` | 已有离线覆盖；真实页面未验收 |
| 已沟通 | `boss_communication_page_smoke` 的 continuing-communication fixture；item 状态机 | 已有离线覆盖；只读，不重复点击 |
| 不可用 | `job_unavailable`、`action_unavailable` fixture 与 executor 分支 | 已有离线覆盖，失败关闭 |
| 身份不一致 | job ID、URL、标题、公司、redirect/chat identity 不匹配 fixture | 已有离线覆盖；真实 DOM/账号身份未证 |
| 结果不明 | 点击后缺成功证据、浏览器中断、`click_dispatched -> ambiguous` | 已有离线覆盖；必须人工 resolve |
| 暂停/恢复 | batch 状态转移、executor pause、中断恢复、恢复前 review gate | 已有离线覆盖；真实浏览器暂停时序未证 |
| 额度 | daily quota、预留额度、超额 `COMMUNICATION_QUOTA_EXHAUSTED` | 已有离线覆盖；并发真实运行压力未证 |
| 校准 | `calibration: calibrated`、`executionEnabled: true`、门禁断言 | 技术校准已证，不是人工验收 |
| 人工确认 | dashboard 审阅、歧义 `evidenceNote`、resolve 后恢复 | 离线 UI/API 契约已证；真实用户操作尚未完成 |

## 尚未被离线测试证明的真实页面风险

- 当前 BOSS 页面是否仍使用已记录的 host、岗位详情 URL、招聘状态、按钮精确文案和聊天身份字段。
- 登录失效、验证码、风控页、异常重定向、页面断连时，Edge 固定双 tab 和 window identity 是否仍满足实际环境。
- dashboard 在真实浏览器中从岗位复核队列提交后，批次快照展示、岗位身份和实际页面身份是否逐项一致。
- 真实点击后成功弹窗、继续沟通状态、聊天页岗位/招聘方身份和结果时序是否可唯一确认。
- 真实暂停、浏览器进程退出、恢复后对 `click_dispatched` 的审阅是否不会重复派发。
- 多进程/多窗口同时创建批次时，额度预留与页面显示是否仍符合产品期望；当前 smoke 只证明离线事务路径。
- 消息列表的当前 DOM、预览文本漂移、对方回复分类和真实回复页面控件未做 live probe。

## 人工 E2E 验收步骤与停止条件

验收必须由用户明确启动，只使用一个已登录 Edge profile，并保持两个固定 tab：`BOSS-SEARCH` 与 `BOSS-COMMUNICATION`；不新建每岗位 tab、不并行操作。

1. 在 dashboard 的待复核队列选择少量岗位，核对脱敏后的岗位 ID、标题、公司、URL、决策 bucket 和今日剩余额度；确认批次列表后提交 `确认清单`。
2. 在批量沟通审阅页核对不可变岗位快照、浏览器模式、额度、校准状态和批次数量；确认后只启动小批次。
3. 每个岗位串行执行：从 `BOSS-SEARCH` 取得保存的 canonical URL，切到固定 `BOSS-COMMUNICATION`，先只读核对 URL/岗位 ID/标题/公司/招聘状态/唯一可见按钮和账号状态。
4. 逐项记录并核对 `succeeded`、`already_communicated`、`job_unavailable`、`target_mismatch`、`action_unavailable`；任何点击后无法唯一证明的项必须保持 `ambiguous`，在 dashboard 输入证据后选择“确认已沟通”或“标记停止”。
5. 在中途执行一次安全暂停/停止，再确认批次为 paused/interrupted；有 ambiguous 时先人工 resolve，再点击继续；检查 workflow 汇总的成功数、短缺、剩余项和审计记录。
6. 验收结束核对没有额外 tab、并行 BOSS 操作、重复点击、未授权投递或风险信号。

立即停止当前岗位及整个批次的条件：登录失效、验证码/风控/频控、异常重定向、host 或岗位 URL 改变、岗位 ID/标题/公司不一致、按钮缺失/重复/文案不精确、聊天身份无法确认、成功结果不唯一、浏览器断连、固定 tab/window identity 丢失、出现未预期写入或任何无法解释的状态。不得刷新重试、换账号、换 tab 绕过、自动补点或把工具返回成功当页面成功。

## 效果评价

离线工程效果为“链路可回归、风险状态可落库、失败默认收敛到人工处理”：选择、额度、不可变快照、技术校准门、串行 executor、身份校验、歧义保留、暂停恢复和 workflow 汇总均有直接 smoke 证据。岗位级状态分类和消息辅助链也有 fake DOM/reader/HTTP 契约覆盖。

但产品效果仍不能给出真实沟通成功率、页面识别召回率、误点击率、风控触发率或人工验收通过率。原因不是离线测试失败，而是本轮明确禁止访问真实 BOSS 和改变浏览器状态；因此最终 acceptance 只能是 `e2e_pending`。

## 按影响排序的改进项

1. **高：完成一次用户批准的、最小批量真实 E2E 验收。** 覆盖成功、已沟通、不可用、身份不一致和结果不明，并保存脱敏截图/DOM/时间线；这是解除 `e2e_pending` 前的首要证据缺口。
2. **高：增加真实页面变化的可重复脱敏 fixture。** 当 host、URL、按钮文案或结果弹窗变化时，先更新证据哈希和 offline regression，再决定是否恢复技术校准。
3. **中：补充并发额度与重复提交测试。** 覆盖两个 dashboard 请求同时创建批次、进程恢复和预留释放，确认不会超额或重复沟通。
4. **中：把真实浏览器断连/暂停/恢复时序纳入受控验收记录。** 特别确认 `click_dispatched` 永不自动重试，ambiguous 必须显式 resolve。
5. **低：改善 offline runner 的可观测性与超时分层。** 当前 `npm.cmd test` 在 124 秒超时且输出不足；可为每个测试保留单独耗时/最后测试名，但不应通过降低覆盖范围来“修复”超时。

## 缺陷记录

本轮未发现已由相关离线 smoke 证明的生产代码缺陷，因此没有修改代码、测试或数据。全套 runner 超时属于本轮验证限制，不足以归因于某个生产代码文件；应作为测试运行可观测性问题单独调查。
