# Branch inventory — 2026-08-09

## 结论

- 盘点时共有 52 个本地分支、33 个 worktree。
- `main` 已包含 durable workflow progress v4 和消息发现联合集成，当前提交为 `038241c`。
- 计划删除 9 个已合并完成分支；删除前均要求提交已进入 `origin/main`、worktree 干净，并已有 main 历史或检查点标签可回溯。
- 保留基线、诊断、实测候选、模型 A/B、尚未合并的分叉分支，以及所有位于 `C:/Users/Administrator/.codex/worktrees` 的 Codex 管理 worktree。
- 历史未跟踪文档已归档到 `archive/2026-08-09/inherited-scope-completion-plan`。

## 决策说明

| 决策 | 含义 |
| --- | --- |
| `active-main` | 当前唯一开发主线。 |
| `archive-keep` | 只用于保存历史文档或恢复证据。 |
| `evidence-keep` | 基线、诊断、实测候选或模型对照，不能按普通已合并分支删除。 |
| `codex-worktree-keep` | 由 Codex 管理的 C 盘 worktree；本次不移除、不删本地分支。 |
| `diverged-keep` | 尚未成为 `origin/main` 祖先；保留供后续单独评估。 |
| `merged-delete` | 已成为 `origin/main` 祖先，且不属于证据/Codex 保留类别；本次安全删除。 |

## 全部分支

| 分支 | Tip | Upstream | 已进 `origin/main` | 决策 | Worktree（盘点时） |
| --- | --- | --- | --- | --- | --- |
| `codex/archive-inherited-scope-completion-plan` | `255fd1d` | — | 否 | `archive-keep` | `D:/Guo/ZhiPing` |
| `codex/candidate-progress-manual-reply` | `07e8f31` | `origin/codex/candidate-progress-manual-reply` | 否 | `diverged-keep` | — |
| `codex/claude-generic-evidence-matching` | `ebdcb11` | `origin/codex/claude-generic-evidence-matching` | 是 | `merged-delete` | `D:/DevData/RoleFlow-worktrees/claude-generic-evidence-matching` |
| `codex/claude-generic-evidence-matching-impl` | `cdd6274` | `origin/codex/claude-generic-evidence-matching-impl` | 是 | `merged-delete` | `D:/DevData/RoleFlow-worktrees/claude-generic-evidence-matching-impl` |
| `codex/claude-generic-evidence-matching-live-fix` | `1fc49da` | `origin/codex/claude-generic-evidence-matching-live-fix` | 是 | `merged-delete` | `D:/DevData/RoleFlow-worktrees/claude-generic-evidence-matching-live-fix` |
| `codex/deepseek-match-nonthinking-ab` | `71885b9` | `origin/codex/deepseek-match-nonthinking-ab` | 是 | `evidence-keep` | `D:/DevData/RoleFlow-worktrees/deepseek-match-nonthinking-ab` |
| `codex/deepseek-v4-flash-nonthinking-v19-live-eval` | `ea53ff7` | — | 是 | `evidence-keep` | — |
| `codex/deepseek-v4-flash-thinking-live-eval` | `47b807d` | — | 是 | `evidence-keep` | — |
| `codex/deepseek-v4-pro-flash-ab` | `9196d3b` | — | 否 | `evidence-keep` | `D:/DevData/RoleFlow-worktrees/deepseek-v4-pro-flash-ab` |
| `codex/durable-workflow-progress-v4` | `077e154` | `origin/codex/durable-workflow-progress-v4` | 是 | `codex-worktree-keep` | `C:/Users/Administrator/.codex/worktrees/a9d9/ZhiPing` |
| `codex/empty-response-private-baseline-v1` | `86679ca` | — | 否 | `evidence-keep` | `D:/DevData/RoleFlow-private-benchmark/baseline-worktree-empty-response-v1` |
| `codex/generic-evidence-matching-design` | `ecae619` | `origin/codex/generic-evidence-matching-design` | 是 | `codex-worktree-keep` | `C:/Users/Administrator/.codex/worktrees/d5d4/ZhiPing` |
| `codex/generic-evidence-matching-private-full-chain-baseline-v1` | `8e5c3ba` | — | 否 | `evidence-keep` | — |
| `codex/generic-evidence-matching-private-full-chain-baseline-v2` | `3212449` | — | 否 | `evidence-keep` | — |
| `codex/generic-evidence-matching-private-full-chain-baseline-v3` | `2c11cd6` | — | 否 | `evidence-keep` | `D:/DevData/RoleFlow-private-benchmark/baseline-worktree-v1` |
| `codex/generic-evidence-matching-private-full-chain-baseline-v4` | `f9a91af` | — | 否 | `evidence-keep` | `D:/DevData/RoleFlow-private-benchmark/baseline-worktree-v4` |
| `codex/generic-evidence-matching-private-full-chain-baseline-v4r2` | `9bd9fa3` | — | 否 | `evidence-keep` | `D:/DevData/RoleFlow-private-benchmark/baseline-worktree-v4r2` |
| `codex/generic-evidence-matching-private-full-chain-baseline-v4r3` | `35c6a2b` | — | 否 | `evidence-keep` | `D:/DevData/RoleFlow-private-benchmark/baseline-worktree-v4r3` |
| `codex/generic-evidence-matching-private-full-chain-baseline-v4r4` | `7ce8cff` | — | 否 | `evidence-keep` | `D:/DevData/RoleFlow-private-benchmark/baseline-worktree-v4r4` |
| `codex/generic-evidence-matching-private-full-chain-baseline-v4r4diag` | `7bbd7bc` | — | 否 | `evidence-keep` | `D:/DevData/RoleFlow-private-benchmark/baseline-worktree-v4r4diag` |
| `codex/generic-evidence-matching-private-full-chain-baseline-v4r4diag3` | `48a4d19` | — | 否 | `evidence-keep` | `D:/DevData/RoleFlow-private-benchmark/baseline-worktree-v4r4diag3` |
| `codex/generic-evidence-matching-private-paired-overlap-baseline` | `7472578` | — | 否 | `evidence-keep` | — |
| `codex/generic-evidence-matching-private-recall-v2-baseline` | `a2ff151` | — | 否 | `evidence-keep` | `D:/DevData/RoleFlow-private-benchmark/baseline-worktree-v6-recall-v2` |
| `codex/generic-evidence-matching-private-recall-v2-baseline-r2` | `1c9fcb0` | — | 否 | `evidence-keep` | `D:/DevData/RoleFlow-private-benchmark/baseline-worktree-v7-recall-v2` |
| `codex/generic-evidence-matching-private-recall-v2-baseline-r3` | `3a1192d` | — | 否 | `evidence-keep` | `D:/DevData/RoleFlow-private-benchmark/baseline-worktree-v9-envelope-diag` |
| `codex/generic-evidence-matching-private-recall-v2-baseline-v12` | `e626227` | — | 否 | `evidence-keep` | `D:/DevData/RoleFlow-private-benchmark/baseline-worktree-v12-explicit-gate` |
| `codex/generic-evidence-matching-role-central-20-baseline` | `9e10500` | `origin/codex/generic-evidence-matching-role-central-20-baseline` | 否 | `evidence-keep` | `D:/DevData/RoleFlow-private-benchmark/baseline-worktree-paired-overlap` |
| `codex/integrate-candidate-progress-message-flow` | `da2a2cf` | `origin/codex/integrate-candidate-progress-message-flow` | 否 | `diverged-keep` | `D:/DevData/RoleFlow-worktrees/candidate-progress-message-integration` |
| `codex/integrate-durable-and-message-flow` | `2e16b91` | `origin/codex/integrate-durable-and-message-flow` | 是 | `merged-delete` | `D:/DevData/RoleFlow-worktrees/durable-message-integration` |
| `codex/multi-track-recall-continuation` | `49c9f43` | `origin/codex/multi-track-recall-continuation` | 是 | `merged-delete` | — |
| `codex/multi-track-recall-contract-diagnostic-v1` | `02ef98a` | — | 是 | `evidence-keep` | — |
| `codex/multi-track-recall-first-live-eval` | `c2dd469` | — | 是 | `evidence-keep` | — |
| `codex/multi-track-recall-first-live-eval-6152d70` | `6152d70` | — | 是 | `evidence-keep` | — |
| `codex/multi-track-recall-first-live-eval-97b64b4` | `97b64b4` | — | 是 | `evidence-keep` | — |
| `codex/multi-track-recall-first-live-eval-cebe59f` | `cebe59f` | — | 是 | `evidence-keep` | — |
| `codex/multi-track-recall-full20-index4-diagnostic-v1` | `5d8d456` | — | 是 | `evidence-keep` | — |
| `codex/multi-track-recall-full20-index4-diagnostic-v2` | `5d8d456` | — | 是 | `evidence-keep` | — |
| `codex/multi-track-recall-integration` | `5457a63` | `origin/codex/multi-track-recall-integration` | 是 | `merged-delete` | — |
| `codex/multi-track-recall-private-baseline-v1` | `52ca494` | `origin/codex/multi-track-recall-private-baseline-v1` | 否 | `evidence-keep` | `D:/DevData/RoleFlow-private-benchmark/baseline-worktree-multi-track-recall-v1` |
| `codex/review-fix-privacy` | `f81d0ce` | — | 否 | `diverged-keep` | `D:/DevData/RoleFlow-worktrees/review-fix-privacy` |
| `codex/review-fix-runner` | `a3c4ba9` | — | 否 | `diverged-keep` | `D:/DevData/RoleFlow-worktrees/review-fix-runner` |
| `codex/role-direction-private-baseline-v1` | `334595b` | — | 否 | `evidence-keep` | `D:/DevData/RoleFlow-private-benchmark/baseline-worktree-role-direction-v1` |
| `codex/role-direction-weight-live-candidate` | `f8d007d` | — | 是 | `evidence-keep` | — |
| `codex/role-direction-weight-live-candidate-20` | `3e2ddff` | — | 是 | `evidence-keep` | — |
| `codex/role-direction-weight-live-candidate-r2` | `ee486fe` | — | 是 | `evidence-keep` | — |
| `codex/role-industry-boundary-live-candidate` | `b794d03` | — | 是 | `evidence-keep` | — |
| `codex/role-industry-boundary-live-candidate-r2` | `edfdcb3` | — | 是 | `evidence-keep` | — |
| `codex/role-industry-boundary-live-candidate-r3` | `5ab118f` | — | 是 | `evidence-keep` | — |
| `feat/boss-batch-communication` | `25395b4` | — | 是 | `merged-delete` | `D:/DevData/rfcomm` |
| `feat/boss-detail-inspection` | `36cb76b` | — | 是 | `merged-delete` | `D:/DevData/rfdetail` |
| `feat/two-run-workflow` | `5ce78e2` | `origin/feat/two-run-workflow` | 是 | `merged-delete` | `D:/DevData/rfworkflow` |
| `main` | `038241c` | `origin/main` | 是 | `active-main` | `D:/DevData/RoleFlow-worktrees/main-integration` |

## 检查点

- `checkpoint/2026-08-09-pre-durable-v4-main`
- `checkpoint/2026-08-09-durable-v4-tip`
- `checkpoint/2026-08-09-post-durable-v4-main`
- `checkpoint/2026-08-09-pre-message-integration-main`
- `checkpoint/2026-08-09-message-source-tip`
- `checkpoint/2026-08-09-durable-message-integration-tip`
- `checkpoint/2026-08-09-post-message-integration-main`
- `archive/2026-08-09/inherited-scope-completion-plan`

## 清理后目标

- 本地分支：43 个。
- 远端实际分支：9 个（不计 `origin/HEAD`）。
- worktree：25 个。
- 根工作区最终切换到 `main`；临时 `main-integration` worktree 删除。

## 执行结果

- 已使用 `git branch -d` 删除 9 个 `merged-delete` 本地分支，没有使用强制删除。
- 已删除其中 7 个同名远端完成分支；另外 2 个 `feat/*` 分支原本没有远端。
- 已移除 7 个干净的 D 盘完成 worktree；没有移除任何 C 盘 Codex 管理 worktree，也没有移除私有基线、诊断、实测或模型对照 worktree。
- 主 worktree 交接前复核结果：43 个本地分支、9 个远端实际分支、26 个 worktree。移除临时 `main-integration` worktree 后为 25 个。
