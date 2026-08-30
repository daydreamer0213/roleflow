# 消息缺失事实闭环实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让消息发现中的“缺少用户事实”在运行过期或应用重启后仍然可见，并让用户直接填写真实情况后继续生成本地可编辑草稿。

**Architecture:** 复用现有 `message_inbound_contexts` 保存该消息组的本地上下文，复用 `candidate_progress_events` 表示待补事实的当前状态，不新增数据库表或迁移。新增一个聚焦的缺失事实解析服务：验证消息组与事实键、写入现有候选人事实修订链、重新调用消息回复分析器，并将草稿或下一项缺失事实持久化。Dashboard 只增加一个本地表单和窄接口，不触发 BOSS 写入。

**Tech Stack:** Node.js CommonJS、内置 SQLite、现有 Dashboard 服务端渲染、现有模型适配器与 smoke tests。

## Global Constraints

- BOSS 默认只读；本计划不填写、粘贴、发送、同意/拒绝简历、投递或申请。
- 原始 HR 内容只保存在用户本机 SQLite，不进入仓库、测试、日志、公共状态接口或文档。
- 用户填写事实本身就是确认，不增加二次确认。
- 不新增依赖、微服务、ORM、依赖注入容器或前端框架。
- 运行时过期、进程重启和相同请求重试都不得丢失或重复生成待办。

---

### Task 1: 持久化缺失事实消息上下文

**Files:**
- Modify: `src/core/message_discovery.js`
- Test: `tests/message_discovery_smoke.js`
- Test: `tests/message_reply_send_store_smoke.js`

**Interfaces:**
- Consumes: `saveMessageInboundContext(db, input)` 和已验证的消息目标身份。
- Produces: 每个 `missingFact.key` 消息组都有一条可按 `profileId + cardId + messageGroupKey` 找回的 `message_inbound_contexts` 记录。

- [ ] **Step 1: 写失败测试**

在缺失事实分类用例中断言没有草稿时仍保存上下文：

```js
assert.strictEqual(summary.results[0].missingFactKey, "project_status");
const contexts = listMessageInboundContexts(db, { profileId, cardId });
assert.strictEqual(contexts.length, 1);
assert.strictEqual(contexts[0].messageGroupKey, expectedGroupKey);
assert.deepStrictEqual(contexts[0].inboundMessages, [{ kind: "text", text: "请介绍该项目的实际状态" }]);
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node tests/message_discovery_smoke.js`

Expected: FAIL，因为当前实现只在存在开放草稿时保存消息上下文。

- [ ] **Step 3: 写最小实现**

把上下文保存条件限定为“存在开放草稿，或本轮存在缺失事实”：

```js
const shouldPersistContext = drafts.some((draft) => !draft.closedAt)
  || Boolean(classification.missingFact?.key);
if (shouldPersistContext && target.identityVerified === true) {
  saveMessageInboundContext(db, { /* 复用当前已验证字段 */ });
}
```

- [ ] **Step 4: 运行测试并确认通过**

Run: `node tests/message_discovery_smoke.js && node tests/message_reply_send_store_smoke.js`

Expected: 两项均输出 `ok`。

- [ ] **Step 5: 提交**

```bash
git add src/core/message_discovery.js tests/message_discovery_smoke.js tests/message_reply_send_store_smoke.js
git commit -m "fix: persist missing fact message context"
```

### Task 2: 从事件与上下文恢复待补事实卡片

**Files:**
- Create: `src/application/message_discovery/missing_fact.js`
- Modify: `src/dashboard/message_discovery_controller.js`
- Create: `tests/message_missing_fact_smoke.js`
- Modify: `tests/dashboard_message_discovery_smoke.js`
- Modify: `tests/run_all.js`

**Interfaces:**
- Produces: `listOpenMessageMissingFacts(db, { profileId }) -> Array<{ cardId, jobId, messageGroupKey, missingFactKey, messageIntent, messageCategory, inboundMessages, manualActions }>`。
- Consumes: `message_group_classified`、`message_missing_fact_advanced`、`message_missing_fact_resolved` 三类事件；每个消息组以最新事件为当前状态。

- [ ] **Step 1: 写失败测试**

建立一条缺失事实分类事件和一条已保存上下文，重新创建 controller 后断言页面状态仍含该结果：

```js
const restored = controller.pageState(profileId);
assert.strictEqual(restored.processed, 1);
assert.strictEqual(restored.results[0].messageGroupKey, messageGroupKey);
assert.strictEqual(restored.results[0].missingFactKey, "availability_date");
assert.deepStrictEqual(restored.results[0].drafts, []);
```

再记录 `message_missing_fact_resolved`，断言该待办不再恢复；记录 `message_missing_fact_advanced` 时断言恢复新的事实键。

- [ ] **Step 2: 运行测试并确认失败**

Run: `node tests/message_missing_fact_smoke.js && node tests/dashboard_message_discovery_smoke.js`

Expected: FAIL，因为 durable 状态目前只从开放草稿重建结果。

- [ ] **Step 3: 写最小实现**

在新模块中按消息组选择最新状态事件，只返回仍有 `missingFactKey` 且存在本地上下文的项目；在 `durableStatus()` 中把这些项目与开放草稿按 `cardId + messageGroupKey` 合并，公共 `/api/message-discovery-status` 仍不返回原文、草稿或事实值。

```js
function listOpenMessageMissingFacts(db, { profileId }) {
  // 读取本候选人的上下文与三类状态事件；按 occurred_at、id 选择每组最新项。
  // 仅投影安全键、岗位卡片 id 和本地显示上下文。
}
```

- [ ] **Step 4: 运行测试并确认通过**

Run: `node tests/message_missing_fact_smoke.js && node tests/dashboard_message_discovery_smoke.js`

Expected: 两项均输出 `ok`。

- [ ] **Step 5: 提交**

```bash
git add src/application/message_discovery/missing_fact.js src/dashboard/message_discovery_controller.js tests/message_missing_fact_smoke.js tests/dashboard_message_discovery_smoke.js tests/run_all.js
git commit -m "fix: restore missing fact message tasks"
```

### Task 3: 填写事实并继续生成草稿

**Files:**
- Modify: `src/application/message_discovery/missing_fact.js`
- Modify: `src/dashboard/message_discovery_controller.js`
- Modify: `src/dashboard/message_discovery_view.js`
- Modify: `src/dashboard/server.js`
- Test: `tests/message_missing_fact_smoke.js`
- Test: `tests/dashboard_message_discovery_smoke.js`

**Interfaces:**
- Produces: `createMessageMissingFactResolver(deps).resolve({ profileId, cardId, messageGroupKey, factKey, factValue })`。
- Produces: `POST /api/message-missing-fact`，成功后跳回 `/messages?profileId=<id>`。
- Consumes: 现有 `saveCandidateFact`、`createMessageReplyAnalyzer`、`recordMessageReplyDrafts`、`recordProgressEvent` 和 `transitionProgressCard`。

- [ ] **Step 1: 写失败测试**

覆盖四条行为：事实键必须与当前待办一致；用户值写入 `candidate_facts` 与修订历史；模型成功时生成开放草稿并记录 resolved 事件；模型提出下一项真实缺失事实时记录 advanced 事件且不生成猜测草稿。

```js
const result = await resolver.resolve({
  profileId,
  cardId,
  messageGroupKey,
  factKey: "availability_date",
  factValue: "两周内可以到岗"
});
assert.strictEqual(result.status, "reply_ready");
assert.strictEqual(listOpenMessageReplyDrafts(db, { profileId, cardId }).length, 2);
assert.strictEqual(listOpenMessageMissingFacts(db, { profileId }).length, 0);
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node tests/message_missing_fact_smoke.js`

Expected: FAIL，因为解析服务和接口尚不存在。

- [ ] **Step 3: 写最小服务实现**

解析器按以下顺序执行：验证本地上下文和当前事实键；保存用户事实；重新读取当前有效事实与回答记忆；用保存的消息上下文调用现有 analyzer；若仍缺事实则记录 advanced 事件；若生成草稿则记录草稿与 resolved 事件，并把 `needs_user_action` 迁移到 `reply_ready`。重复请求检测到现有开放草稿或 resolved 事件时直接返回现有结果。

- [ ] **Step 4: 增加页面表单和窄接口**

缺失事实结果显示用户语言标签，不显示内部事实键：

```html
<form method="post" action="/api/message-missing-fact">
  <input type="hidden" name="profileId" value="...">
  <input type="hidden" name="cardId" value="...">
  <input type="hidden" name="messageGroupKey" value="...">
  <input type="hidden" name="factKey" value="...">
  <label>你的真实情况<textarea name="factValue" required></textarea></label>
  <button>保存并生成回复</button>
</form>
```

- [ ] **Step 5: 运行测试并确认通过**

Run: `node tests/message_missing_fact_smoke.js && node tests/dashboard_message_discovery_smoke.js && node tests/message_reply_contract_smoke.js`

Expected: 三项均输出 `ok`。

- [ ] **Step 6: 提交**

```bash
git add src/application/message_discovery/missing_fact.js src/dashboard/message_discovery_controller.js src/dashboard/message_discovery_view.js src/dashboard/server.js tests/message_missing_fact_smoke.js tests/dashboard_message_discovery_smoke.js
git commit -m "feat: complete missing fact reply flow"
```

### Task 4: 当前真实待办恢复与最终验证

**Files:**
- Modify: `docs/NEXT_PHASE.md`
- Modify: `docs/PROJECT_HANDOFF.md`
- Modify: `docs/superpowers/reports/2026-08-30-real-user-e2e-acceptance.md`

**Interfaces:**
- Consumes: 前三项已经通过的代码、当前正式数据库备份和现有只读消息发现授权边界。
- Produces: 当前两条缺失事实消息重新形成持久上下文；不发送任何消息。

- [ ] **Step 1: 运行定向与完整离线门禁**

Run: `node tests/message_missing_fact_smoke.js && node tests/message_discovery_smoke.js && node tests/dashboard_message_discovery_smoke.js && node tests/message_learning_store_smoke.js && npm test`

Expected: 定向项均输出 `ok`；完整末行为 `All 132 offline checks passed.`（若测试清单实际新增数量不同，以新鲜输出为准，禁止硬猜）。

- [ ] **Step 2: 备份并精确恢复当前两条待办**

停止本地服务，备份主库、WAL、SHM；只在精确核对“2 个缺失事实组、没有对应草稿、没有对应上下文、0 发送批次”后，事务撤销这两个消息组的分类事件与对应预览基线。数量不符整体回滚。

- [ ] **Step 3: 重新执行一次真实只读消息发现**

保持 BOSS 固定页后台、串行和既有节奏；核对两条缺失事实任务已保存上下文，原有 12 份草稿不重复，发送批次仍为 0。不要点击保存事实或确认发送。

- [ ] **Step 4: 更新文档并提交**

记录用户可见变化、根因、真实平台边界、备份、实际测试总数和提交 SHA。

- [ ] **Step 5: 在最终精确 SHA 上复验**

Run: `git diff --check && npm test && git status --short --branch`

Expected: `git diff --check` 无输出；完整门禁退出码 0；工作树干净；分支只领先本地提交，未推送、未合并。
