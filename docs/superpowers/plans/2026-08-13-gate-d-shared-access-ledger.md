# Gate D 共享访问账本与条件验收收口实施计划

> **执行范围：** 今天不再抓取岗位，不进行真实沟通或发送；只使用已有数据完成收口。

**目标：** 让真实 Gate D 的账号访问预算跨 operational baseline 连续累计，同时保持普通产品默认行为不变，并修复本轮确认的 Dashboard 内部参数泄漏。

**原则：** 复用现有 SQLite schema、访问预算控制器和风险持久化逻辑；仅增加一个显式账本入口和双写审计，不重构主链路。

---

## 任务 1：补充跨 baseline 失败用例

**文件：**

- 修改：`tests/site_access_budget_smoke.js`
- 修改：`tests/scan_cli_lifecycle_smoke.js`
- 修改：`tests/boss_safe_pacing_smoke.js`

**步骤：**

1. 增加两个 operational database 共用一个账本的预算测试。
2. 断言预留事件既进入共享账本，也进入当前 baseline 的审计记录。
3. 增加 CLI 显式 `--access-ledger-db` 的接线测试。
4. 增加风控事件双写测试。
5. 运行相关测试，确认它们在实现前按预期失败。

## 任务 2：实现显式共享访问账本

**文件：**

- 修改：`src/core/site_access_budget.js`
- 修改：`src/cli.js`

**步骤：**

1. 让访问控制器支持独立的安全账本数据库和 operational audit 数据库。
2. 在 scan CLI 生命周期最外层打开显式账本；未传参数时复用当前数据库。
3. 在创建浏览器前完成账本打开和 schema 初始化。
4. 把账本数据库传入 `trusted_pane` 现有访问控制器；不修改详情模式。
5. 风控事件和站点状态双写。
6. 在帮助文本中说明该参数按账号隔离。
7. 运行任务 1 的测试并确认通过。

## 任务 3：修复队列卡片内部参数展示

**文件：**

- 修改：`tests/dashboard_smoke.js` 或现有等价 Dashboard 集成测试
- 修改：`src/dashboard/server.js`

**步骤：**

1. 增加包含 `multiBusinessDistrict` 和其他风险的页面输出测试。
2. 确认测试先失败。
3. 在展示层过滤该参数；不改数据库、平台策略或岗位分析结果。
4. 确认页面不再显示该参数，同时仍显示其他风险。

## 任务 4：建立当前账号的验收共享账本

**产物：**

- `D:\DevData\RoleFlow-gate-d\account-safety\boss-access.sqlite`

**步骤：**

1. 只读取既有 Gate D 数据库中的 `site_access_events`。
2. 按事件时间、动作和 payload 去重，避免 baseline 复制品重复导入。
3. 导入当前账号的共享账本；不导入岗位、JD 或分析结果。
4. 核对导入后的动作分布、风险事件和最新风险状态。
5. 记录：更换账号时必须另建账本。

## 任务 5：形成条件验收报告

**文件：**

- 新增：`docs/superpowers/reports/2026-08-13-wave4-conditional-acceptance.md`

**步骤：**

1. 记录现有 50 个岗位的 JD 与模型分析分布。
2. 记录 2 个模型合同失败为可重试，不伪装为推荐。
3. 记录五个本地页面、桌面与移动视口、控制台错误结果。
4. 记录固定 BOSS 标签缺失，未创建新标签、未执行消息真实读取。
5. 明确本轮“有条件通过”和下一次全量 Gate D 的前置条件。

## 任务 6：验证、提交和推送

**步骤：**

1. 运行所有受影响模块的定向测试。
2. 运行完整离线回归；不得进行真实 BOSS 访问。
3. 检查 `git diff`，确认没有修改 `search_page_api` 主体或详情模式默认值。
4. 删除本轮临时脚本，只保留报告和可复核证据路径。
5. 提交到当前 `main`，推送到 `origin/main`。
6. 记录下一次验收待确认项：原账号冷却后继续，或新账号使用独立共享账本。
