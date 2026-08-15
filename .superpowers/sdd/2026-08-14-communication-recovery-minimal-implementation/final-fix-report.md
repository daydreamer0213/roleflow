# Communication recovery final-fix report

## 范围

仅处理最终审查的两个 Important finding；未访问真实 Edge/BOSS，未安装、构建、tag、push 或发布。

## RED 证据

在实现前新增回归用例后执行：

- `node tests/dashboard_communication_batch_smoke.js`：失败。错误 `resume_one` 已触发四次 `listTabs`，断言要求在 `COMMUNICATION_SINGLE_ITEM_MISMATCH` 前没有重新绑定或进程启动。
- `node tests/boss_communication_page_smoke.js`：失败。accepted 网络结果加 loading 中的另一岗位页面返回 `succeeded`，断言要求 `target_mismatch`。

## GREEN 证据

实现后以下命令均以退出码 0 通过：

- `node tests/dashboard_communication_batch_smoke.js`
- `node tests/communication_application_smoke.js`
- `node tests/boss_communication_page_smoke.js`
- `node tests/communication_executor_smoke.js`
- `git diff --check`

## 修改文件

- `src/application/communication/index.js`：提取无副作用的完整控制校验，并由实际控制路径继续复用。
- `src/dashboard/server.js`：Edge 重新绑定前调用该校验；重新绑定后仍调用控制路径，重新校验当前状态。
- `src/adapters/sites/boss.js`：风险/登录之后、readiness 之前只识别明确身份漂移与同岗位明确不可用状态。
- `tests/dashboard_communication_batch_smoke.js`：覆盖错误 `resume_one` itemId 与 e2e_pending 普通 `resume`，均断言零 `listTabs`、generation 不变、零 spawn。
- `tests/boss_communication_page_smoke.js`：覆盖 accepted + loading 的另一岗位与同岗位不可用，均断言一次点击、零额外导航、零重试读取。

## 提交

实现提交：`c36d87a9b8872ee136b2e4ac00a11c719bc135a7`（`fix: guard communication recovery ordering`）。

## 关注点

- accepted + 无明确漂移的通用弹窗仍直接成功，不解析弹窗文案，也不额外复查。
- 缺失或无效的 URL/jobId/title/company 不会单独形成漂移；明确 unavailable 需要已确认 URL 与 jobId 属于同一岗位。
- 控制校验在重新绑定前后各执行一次，避免校验与状态改变之间的 TOCTOU 窗口。
