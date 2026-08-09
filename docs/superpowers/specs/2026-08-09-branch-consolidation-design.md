# RoleFlow 分支收敛与分阶段合并设计

**日期：** 2026-08-09
**状态：** 用户已批准执行
**目标：** 在不丢失历史、基准和回滚能力的前提下，把耐久工作流与消息发现两条产品线依次合入 `main`，再整理已合并分支和冗余 worktree。

## 已确认现状

- `main@3e0ee8c` 比 `origin/main` 多 2 个设计/计划提交。
- `codex/durable-workflow-progress-v4@e20ed02` 是 `main` 的直系后续，包含 45 个提交，已与远端同步。
- `codex/durable-workflow-progress@25f6875` 是 v4 的祖先，单独运行 `communication_smoke` 会失败，不得单独合并。
- `codex/integrate-candidate-progress-message-flow@da2a2cf` 从 `c013140` 分叉，包含 16 个待整合提交，已与远端同步。
- v4 与消息分支有 12 个重叠文件、10 处文本冲突；数据库迁移都占用了 v6。
- v4 与消息分支分别通过 67 项离线检查；两者测试集合并集为 74 项。
- 仓库包含私有基准、诊断、真实模型对照和历史设计分支。这些分支不是待发布功能，不得批量合入 `main`。

## 方案比较

### 方案一：两阶段合并并保留独立集成分支（采用）

先把 v4 收口并合入 `main`，再从新 `main` 创建 `codex/integrate-durable-and-message-flow`，按原顺序移植消息分支的 16 个提交。每次合并前后创建并推送带说明的检查点 tag。

优点：

- v4 是直系历史，第一阶段可以快进，风险最小。
- 消息分支保持原样，集成冲突集中在新分支解决，不需要强推。
- 数据库迁移重排、页面冲突和联合测试可以单独审查。
- 任一阶段都可通过 tag 回到精确提交。

缺点：

- 需要两轮完整测试和两轮独立审查。
- 消息分支的 16 个提交在新基线上可能多次产生冲突。

### 方案二：一次性把两条分支都合入 main（不采用）

优点是步骤少；缺点是数据库迁移、工作流和消息页面冲突会混在一次主线操作中，失败后难以定位和回滚。

### 方案三：改写消息分支历史后强推（不采用）

优点是提交图更线性；缺点是破坏已推送分支的稳定引用，也会削弱现有实测和审查记录的可追溯性。

## 合并架构

### 第一阶段：耐久工作流

1. 修复 v4 的文档格式门禁。
2. 运行 `git diff --check`、67 项离线检查和独立整分支审查。
3. 创建并推送：
   - `checkpoint/2026-08-09-pre-durable-v4-main`
   - `checkpoint/2026-08-09-durable-v4-tip`
4. 把 `main` 快进到通过验证的 v4 tip。
5. 在合并结果上重新运行完整离线检查。
6. 推送 `main`，再创建并推送 `checkpoint/2026-08-09-post-durable-v4-main`。

### 第二阶段：消息发现

1. 从新 `main` 创建 `codex/integrate-durable-and-message-flow` 和独立 worktree。
2. 创建并推送：
   - `checkpoint/2026-08-09-pre-message-integration-main`
   - `checkpoint/2026-08-09-message-source-tip`
3. 按 `c013140..da2a2cf` 的原顺序移植 16 个提交，不改写原消息分支。
4. 保留 v4 的迁移 v6，把消息迁移固定为：
   - v7 `candidate_progress_v1`
   - v8 `candidate_progress_event_idempotency`
   - v9 `message_preview_states_v1`
5. 人工审查全部 12 个重叠文件，不只处理 Git 标出的 4 个冲突文件。
6. 运行 74 项联合检查、`git diff --check` 和独立整分支审查。
7. 将集成分支合入 `main`，在合并结果上重新运行完整检查后推送。
8. 创建并推送 `checkpoint/2026-08-09-post-message-integration-main`。

## 检查点与回滚

- 检查点使用 annotated tag，记录分支、提交、测试结果和合并目的。
- tag 必须在对应合并前推送到 `origin`，不能只保留在本地。
- 回滚优先创建恢复分支指向检查点，不直接对共享 `main` 执行强制重置或强推。
- 合并失败时保留集成 worktree 和冲突状态；修复验证前不更新 `main`。

## 数据和安全边界

- 自动化验证只使用临时 SQLite、fixture 和 fake/mock 适配器。
- 不访问真实 BOSS、真实模型、Cookie、浏览器凭据或真实 `data/jobs.sqlite`。
- 不降低 JD 读取覆盖率、匹配质量、扫描恢复能力、人工确认或 BOSS 身份核验。
- 不把工具点击成功等同于沟通成功。
- 涉及真实 BOSS 的后续验收仍需保持只读、串行和既有固定标签页边界。

## 分支整理规则

### 可删除

- 已确认是 `origin/main` 祖先的本地或远端功能分支。
- clean 且只服务于已合并分支的 D 盘 worktree。
- 已被 v4 取代的旧耐久分支，但必须先保存未跟踪计划文档。

### 只归档、不合并

- `private-baseline`、`live-eval`、`diagnostic`、`model-ab` 类分支。
- 仍承载基准复现、真实模型对照或审查证据的分支。
- 任何不是 `origin/main` 祖先、又没有明确替代关系的分支。

### 不自动删除

- Codex App 管理的 `C:\Users\Administrator\.codex\worktrees\...`。
- dirty worktree。
- detached 且提交没有其他分支或 tag 引用的 worktree。
- 真实基准目录和其中的数据文件。

## 验收标准

- `main` 先包含 v4，再包含消息发现集成，不出现一次性混合合并。
- 每次 `main` 更新前后都有已推送检查点。
- 联合集成后的 `tests/run_all.js` 包含 74 个不重复测试文件。
- 迁移版本连续为 1..9，旧数据库升级测试覆盖 v5→v6→v9。
- `git diff --check` 无输出。
- 完整离线检查退出码为 0。
- 独立审查无 Critical/Important 遗留项。
- 分支整理清单记录“删除、保留、归档”的精确提交。
