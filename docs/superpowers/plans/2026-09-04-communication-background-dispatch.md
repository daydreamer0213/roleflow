# 后台沟通点击收口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 后台焦点覆盖唯一一次点击，并保留足够且脱敏的失败证据。

**Architecture:** 现有浏览器适配器只在焦点模拟期间保留连接；站点最终守卫观察点击回执，执行器过滤并保存诊断。复用现有 outcome JSON，不改变成功标准。

**Tech Stack:** Node.js、原生 WebSocket、SQLite、现有 Playwright/本地 Edge。

## Global Constraints

- 不新增依赖、不激活前台、不补点、不修改真实数据或历史授权。
- 不改节奏或选择器；用户明确授权后才允许真实外部写。
- 源码分支 `codex/communication-background-dispatch`，复用 D 盘现有隔离目录。

## Task 1: 焦点模拟生命周期

**Files:** `src/adapters/browser/cdp.js`、`tests/cdp_focus_scope_smoke.js`、`tests/browser_transport_smoke.js`、`tests/run_all.js`。

**Interfaces:** 消费并保持 `cdp(tabId, method, params)` / `clickAt(tabId, point)`；只改变内部连接存活时间。

- [x] 基线 browser_transport、boss_communication_page、communication_executor 通过。
- [ ] 新增双本地页回归，先看到焦点断言失败：

```js
await adapter.cdp(targetId, 'Emulation.setFocusEmulationEnabled', { enabled: true });
await new Promise(resolve => setTimeout(resolve, 150));
assert.equal(await adapter.evalValue(targetId, 'document.hasFocus()'), true);
await adapter.clickAt(targetId, { x: 100, y: 35 });
assert.equal(await page.evaluate(() => window.clicks.length), 1);
await adapter.cdp(targetId, 'Emulation.setFocusEmulationEnabled', { enabled: false });
```

- [ ] 最小实现：启用时保留连接，作用域内复用；关闭/错误释放，禁止断开重发。
- [ ] 测试关闭、异常和断开；运行 browser_transport、cdp_focus_scope、source_acquisition、boss_message_reply_sender、boss_communication_page。
- [ ] 检查差异后提交实现与测试。

## Task 2: 脱敏诊断与准确提示

**Files:** `src/adapters/sites/boss.js`、`src/core/communication_executor.js`、`src/dashboard/user_facing_errors.js`、`src/dashboard/status_labels.js`，及相关 communication/page/dashboard smoke。

**Interfaces:** 原有 `{state,errorCode,evidence:{endpoints,pageState}}` 增加可选 `diagnostics`；旧记录缺失时兼容。固定字段，不透传页面任意内容。

补充代码取证：`CdpNetworkLog.read` 过滤掉未结束请求，导致“在途”与“没有请求”不可区分。`src/adapters/browser/cdp_network_log.js` 只追加 `meta.pendingRequests` 计数；Task 1 的 transport 检查负责验证开始为 1、完成为 0，Task 2 验证其落库及无元数据兼容。计数不改变沟通判定。

- [ ] 先写失败测试：真实守卫注册的监听器收到目标点击后产生布尔回执；无回执不推断成功。
- [ ] 执行器回归注入额外私密字段，验证最终数据库仅保存已列出的布尔值和枚举；后续岗位仍为 pending、零点击。
- [ ] 最小实现回执清理、最终按钮/文档/弹层状态和白名单保存；沿现有界面改提示。
- [ ] 跑 boss_communication_page、communication_executor、dashboard_communication_batch、workflow_page_migration。

## Task 3: 最终验证与交接

- [ ] 独立只读复审当前差异，修复可达的问题。
- [ ] 在严格 Playwright 环境跑新鲜完整 npm test，记录实际总数。
- [ ] 更新 NEXT_PHASE / PROJECT_HANDOFF 和本计划结果，不改写过去的真实验收结论。
- [ ] git diff --check，提交，精确 SHA 聚焦复验；保持本地分支，不推送或安装。
