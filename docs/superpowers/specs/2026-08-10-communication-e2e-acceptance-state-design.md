# Communication E2E Acceptance State Design

日期：2026-08-10

## 目标

把 BOSS 沟通的技术校准状态与用户端到端验收状态分开，明确表达当前状态：

```js
{
  implementation: "implemented",
  calibration: "calibrated",
  acceptance: "e2e_pending",
  executionEnabled: true
}
```

`executionEnabled` 仍是现有技术执行门，只表示执行路径已通过技术校准；它不表示用户已经完成端到端验收，也不改变批次、执行、错误码、锁、额度或节奏行为。

## 设计

`PRODUCT_POLICY.operations.bossCommunication.calibration` 保存四个状态来源：实现状态、技术校准状态、人工验收状态和既有执行门。`communicationCalibrationStatus()` 返回上述四字段，供批次快照、dashboard 状态响应和执行断言继续共同使用。

为保持未迁移的 dashboard 页面读取兼容，返回对象保留一个非枚举的 `status` 别名，值等于 `calibration`。因此 JSON/API 公共状态只暴露新四字段，旧的 `calibration.status` 读取仍显示技术校准状态；执行断言只检查 `executionEnabled`。

## 当前证据边界

历史记录支持“完成了简单技术校准”和“一次受控沟通点击”，但没有记录用户完成完整端到端工作流验收。因此当前 `acceptance` 必须是 `e2e_pending`，不能写成 `accepted`。文档只陈述这些已记录证据，不把历史记录扩展为当前外部页面行为。

## 验证

- 聚焦校准门测试先断言新状态并在旧实现上失败，再验证通过。
- 执行器和 dashboard 批次测试继续验证 `executionEnabled: true`、原有启动行为和错误码。
- 全部自动化检查保持离线；不访问真实 BOSS、浏览器、数据库或私有数据。
- 提交前运行 `git diff --check` 并确认只包含本任务分配的文件。
