# 2026-08-09 分支清单与合并处置

## 当前结论

审计基线：

- `main@109d6acd5f10ea27a139ee9a4d4fd6d0c79f15c1`
- `origin/main@74d3bafa8eeaabb22c1c826261aab11c413b5412`
- 当前修复分支：`codex/boss-pane-switch-repair@52a49b1`
- 本地分支：45 个
- `origin` 远端分支：10 个，不含 `origin/HEAD` 符号引用
- Git 登记工作树：27 个
- 当前脏工作树：0 个

`main` 比 `origin/main` 多 1 个已验证文档提交：

```text
109d6ac docs: archive inherited scope completion plan
```

该提交在合并前建立了
`checkpoint/pre-merge-phase-1-docs-20260809`，合并后完整离线测试通过 74/74。
当前尚未推送。

除正在开发的 BOSS 详情修复外，没有遗留分支适合整分支合并。旧产品修复已经被主线包含或
补丁等价吸收；私有 benchmark、模型 A/B 和消息发现源分支均应保留为历史证据，不得覆盖
当前主线。

## 分类规则

### 可归档

分支提交已经是 `main` 的祖先，或全部独有补丁已在 `main` 找到等价实现。这里的“可归档”
只表示不再需要合并，不授权删除分支、标签或工作树。

### 历史实验

分支用于私有基准、一次性诊断或模型试验。它们需要固定提交和外部样本才能复现，不是产品
合并候选。

### 历史产品来源

分支曾提供产品实现来源，但当前主线已经完成职责迁移和后续加固。直接合并会回退新代码或
制造无意义冲突。

### 当前活动

仍在执行已批准设计和计划的分支。在离线验证、代码审查和真实只读验收完成前不得合入
`main`。

## 当前活动分支

| 分支 | HEAD | 处置 |
|---|---|---|
| `main` | `109d6ac` | 唯一产品整合基线；当前比远端多 1 个文档提交 |
| `codex/boss-pane-switch-repair` | `52a49b1` | 当前活动；已提交设计与执行计划，等待按 TDD 实现 |

`codex/boss-pane-switch-repair` 当前只比 `main` 多两份文档：

```text
75d373c docs: design standalone BOSS detail reads
52a49b1 docs: plan standalone BOSS detail repair
```

## 已被 main 完整包含

以下 19 个分支相对当前 `main` 的 `ahead=0`，没有独有提交，不需要再次合并：

1. `codex/claude-generic-evidence-matching-live-fix`
2. `codex/deepseek-match-nonthinking-ab`
3. `codex/deepseek-v4-flash-nonthinking-v19-live-eval`
4. `codex/deepseek-v4-flash-thinking-live-eval`
5. `codex/durable-workflow-progress-v4`
6. `codex/generic-evidence-matching-design`
7. `codex/multi-track-recall-contract-diagnostic-v1`
8. `codex/multi-track-recall-first-live-eval`
9. `codex/multi-track-recall-first-live-eval-6152d70`
10. `codex/multi-track-recall-first-live-eval-97b64b4`
11. `codex/multi-track-recall-first-live-eval-cebe59f`
12. `codex/multi-track-recall-full20-index4-diagnostic-v1`
13. `codex/multi-track-recall-full20-index4-diagnostic-v2`
14. `codex/role-direction-weight-live-candidate`
15. `codex/role-direction-weight-live-candidate-20`
16. `codex/role-direction-weight-live-candidate-r2`
17. `codex/role-industry-boundary-live-candidate`
18. `codex/role-industry-boundary-live-candidate-r2`
19. `codex/role-industry-boundary-live-candidate-r3`

已确认的重复引用：

- `codex/multi-track-recall-full20-index4-diagnostic-v1`
- `codex/multi-track-recall-full20-index4-diagnostic-v2`

二者指向同一提交 `5d8d456`。

## 补丁已等价吸收

以下分支不是当前 `main` 的祖先，但 `git cherry main <branch>` 没有正补丁，不应直接 merge：

| 分支 | 证据 | 处置 |
|---|---|---|
| `codex/archive-inherited-scope-completion-plan` | 唯一文档补丁已挑选为 `main@109d6ac` | 可归档 |
| `codex/review-fix-privacy` | 隐私修复补丁已被主线等价吸收；直接合并会产生旧测试冲突 | 可归档 |
| `codex/review-fix-runner` | 12 个历史独有提交均为主线等价补丁；直接合并会冲突并回退 runner | 可归档 |

## 历史产品来源，不再合并

| 分支 | 当前判断 |
|---|---|
| `codex/candidate-progress-manual-reply` | 早期候选进度与消息发现源分支；主线已有完整迁移和后续安全加固 |
| `codex/integrate-candidate-progress-message-flow` | 职责整合来源；核心文件已进入主线，剩余差异落后于主线 |

这两条分支不包含需要再次挑选的产品代码。尤其不得用其中的旧版
`src/dashboard/server.js`、`src/core/storage.js`、`src/core/llm_analyzer.js` 或
`src/core/model_contract.js` 覆盖主线。

消息发现读取器可能点击一次会话行并改变已读状态。若未来重新做真实消息校准，首次真实会话
行点击仍需单独明确批准；本次分支整理和详情修复不执行该动作。

## 私有 benchmark 与历史实验

以下 18 个分支保留为历史实验，不进入产品主线：

1. `codex/empty-response-private-baseline-v1`
2. `codex/generic-evidence-matching-private-full-chain-baseline-v1`
3. `codex/generic-evidence-matching-private-full-chain-baseline-v2`
4. `codex/generic-evidence-matching-private-full-chain-baseline-v3`
5. `codex/generic-evidence-matching-private-full-chain-baseline-v4`
6. `codex/generic-evidence-matching-private-full-chain-baseline-v4r2`
7. `codex/generic-evidence-matching-private-full-chain-baseline-v4r3`
8. `codex/generic-evidence-matching-private-full-chain-baseline-v4r4`
9. `codex/generic-evidence-matching-private-full-chain-baseline-v4r4diag`
10. `codex/generic-evidence-matching-private-full-chain-baseline-v4r4diag3`
11. `codex/generic-evidence-matching-private-paired-overlap-baseline`
12. `codex/generic-evidence-matching-private-recall-v2-baseline`
13. `codex/generic-evidence-matching-private-recall-v2-baseline-r2`
14. `codex/generic-evidence-matching-private-recall-v2-baseline-r3`
15. `codex/generic-evidence-matching-private-recall-v2-baseline-v12`
16. `codex/generic-evidence-matching-role-central-20-baseline`
17. `codex/multi-track-recall-private-baseline-v1`
18. `codex/role-direction-private-baseline-v1`

重复实验树：

- `codex/generic-evidence-matching-private-full-chain-baseline-v4r2`
- `codex/generic-evidence-matching-private-full-chain-baseline-v4r3`

二者提交不同，但当前文件树相同。仍不在本轮删除，避免破坏外部 benchmark 回溯引用。

## 模型 A/B 分支

`codex/deepseek-v4-pro-flash-ab` 不整分支合并。

其中 `440598e` 新增的指标模块表面上可复用，但实际硬编码了：

- DeepSeek V4 Pro/Flash 模型对；
- 官方 DeepSeek 地址；
- 固定价格；
- 固定诊断样本索引；
- 20 条正式样本；
- 20% 延迟与 50% 成本门槛。

后续提交又把它与私有输入和私有 runner 绑定。若未来需要通用模型评估，应从当前主线另建
新分支，先设计可配置模型、价格版本、匿名样本契约和通用质量门槛；不得直接挑选旧实验树。

## 远端分支

`origin` 当前有 10 个真实分支：

| 远端分支 | 处置 |
|---|---|
| `origin/main` | 当前落后本地 `main` 1 个文档提交 |
| `origin/codex/candidate-progress-manual-reply` | 历史产品来源，不合并 |
| `origin/codex/claude-generic-evidence-matching-live-fix` | 已被主线包含 |
| `origin/codex/deepseek-match-nonthinking-ab` | 已被主线包含 |
| `origin/codex/durable-workflow-progress-v4` | 已被主线包含 |
| `origin/codex/generic-evidence-matching-benchmark-v2-baseline` | 仅远端历史 benchmark；主线已有更新版 sanitized-live harness |
| `origin/codex/generic-evidence-matching-design` | 已被主线包含 |
| `origin/codex/generic-evidence-matching-role-central-20-baseline` | 私有历史实验 |
| `origin/codex/integrate-candidate-progress-message-flow` | 历史产品来源，不合并 |
| `origin/codex/multi-track-recall-private-baseline-v1` | 私有历史实验 |

本轮不删除远端分支、不强推、不重写提交历史。

## 工作树

当前 27 个 Git 登记工作树全部干净，没有 `locked` 或 `prunable` 证据。干净只表示没有
未提交修改，不表示可以删除：

- 所有附着分支仍由对应工作树占用；
- 私有 benchmark 工作树是实验回溯点；
- detached 工作树是提交级检查点；
- `C:\Users\Administrator\.codex\worktrees` 下的工作树由 Codex 管理，不在本轮移动或清理；
- 大型生成数据继续优先保留在 `D:\DevData` 或项目所在的 `D:` 盘。

当前可用于详情修复的隔离工作树：

```text
D:\DevData\RoleFlow-readonly-scan-20260809-v1
```

主工作树：

```text
D:\Guo\ZhiPing
```

正式数据库仅位于主工作树，修复和验收不得读取或修改：

```text
D:\Guo\ZhiPing\data\jobs.sqlite*
```

## 检查点策略

仓库当前保留 10 个 `checkpoint/*` 标签，包括：

- durable workflow 合并前后；
- message integration 来源、候选和合并前后；
- branch consolidation 完成状态；
- `checkpoint/pre-merge-phase-1-docs-20260809`。

第二阶段 BOSS 详情修复按已批准计划新增：

1. 实现完成、真实只读验收前的修复分支标签；
2. 合并详情修复前的 `main` 标签；
3. 合并后完整离线测试证据。

标签应保留到整个目标完成。任何标签、分支或工作树删除都属于单独的破坏性清理，不由“准备
合并”自动授权。

## 推荐执行顺序

### 第一阶段：低风险文档

状态：已完成。

- 挑选 `codex/archive-inherited-scope-completion-plan` 的唯一文档补丁；
- 合并前建立检查点；
- 合并后 74/74 离线测试通过。

### 第二阶段：详情质量阻塞

状态：执行计划已提交，等待 TDD 实现。

- 分支：`codex/boss-pane-switch-repair`
- 设计：`docs/superpowers/specs/2026-08-09-boss-standalone-detail-read-and-tab-group-design.md`
- 计划：`docs/superpowers/plans/2026-08-09-boss-standalone-detail-read.md`
- 目标：冻结岗位 URL，在固定 `BOSS-SEARCH` 内串行读取独立详情；
- 安全：不沟通、不投递、不创建逐岗位标签页、不提高访问额度；
- 门槛：失败测试、最小实现、全量离线测试、独立代码审查、真实只读小批验收、合并前检查点。

### 第三阶段：后续新能力

不从旧分支直接合并。分别另建新设计和新分支：

1. 项目标签组：通过受支持的可选浏览器能力整理工作台和两个固定 BOSS 标签页；标签组不作为
   安全身份。
2. 通用模型 A/B：重新设计可配置模型、价格版本、匿名样本契约和质量门槛。
3. 分支清理：只有用户明确要求删除后，才逐项解除工作树占用并删除已归档引用。

## 最终处置摘要

| 类别 | 数量 | 合并建议 |
|---|---:|---|
| 产品主线 | 1 | 继续作为唯一整合基线 |
| 当前修复 | 1 | 完成第二阶段门槛后合并 |
| 已被 main 完整包含 | 19 | 不再合并，可归档 |
| 补丁等价吸收 | 3 | 不再合并，可归档 |
| 历史产品来源 | 2 | 不合并，保留证据 |
| 私有 benchmark / 历史实验 | 18 | 不合并，保留隔离 |
| 模型 A/B 实验 | 1 | 不合并，未来重新设计 |
| 合计本地分支 | 45 | 已全部归类 |
