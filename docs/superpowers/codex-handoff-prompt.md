# Codex 交接提示词

> 从 Claude Code 会话接续，直接粘贴到 Codex 对话中即可。

---

请阅读以下交接文档了解当前项目状态：

- `D:/Guo/ZhiPing/DEV_HANDOFF.md`
- `D:/Guo/ZhiPing/docs/roleflow-decision-matrix.md`
- `D:/Guo/ZhiPing/docs/roleflow-terminology.md`
- `D:/Guo/ZhiPing/docs/superpowers/specs/2026-08-01-decision-matrix-v2-design.md`
- `D:/Guo/ZhiPing/docs/superpowers/plans/2026-08-01-decision-matrix-v2-plan.md`

## 工作树位置

活跃开发在 worktree：`C:\Users\Administrator\.codex\worktrees\e843\ZhiPing`
分支：`codex/multi-track-recall-continuation`
当前 HEAD：`3baf931`

## 下轮优先事项

1. **修正代码与文档不一致**：`src/core/model_contract.js` 第 1508 行，`mostly_aligned + 符合 → apply`（文档一致），但代码写成了 `return "caution"`，改成 `return "apply"`。同步更新测试。
2. **非核心降级优化**：`countNonCentralMissing` 排除含"优先"/"加分"/"经验优先"/"熟悉优先"等词的非核心条目；阈值从 3 提到 5。
3. **同步 manifest 并重跑 `run-step4-only.ps1`** 验证，预期通过率 15-16/20。

## 基准目录

`D:\DevData\RoleFlow-private-benchmark\multi-track-recall-fullchain-v1-20260731\`

## 注意事项

- manifest 的 `candidateEvaluatedCommit` 和 `sharedFileBlobs` 需随代码变更同步更新
- profile/card 信封用 `patch-artifacts.js` 重算
- npm test 应在 worktree 中全绿（当前仅 2 个预存失败不影响工作）
