# v4.6 Half-known zero-gap promotion implementation plan

> Execute only in `codex/multi-track-recall-continuation`. Keep BOSS and the
> production database untouched.

**Goal:** Restore index 8 recall by aligning the existing zero-confirmed-duty-gap
promotion gate with the base one-half responsibility coverage floor, without
changing the user-confirmed matrix or weakening confirmed-gap safety.

**Design:** Preserve the v4.5 model prompt and structured responsibility states.
Change one deterministic policy parameter, add explicit half-coverage and
confirmed-gap regressions, replay the frozen 20-job evidence, then run fresh live
3-job and 20-job acceptance in new private directories.

## Task 1: Record the failing behavior

1. Update the decision-policy version expectations to
   `four-tier-weighted-v4.6`.
2. Change the policy expectation for
   `zeroDutyGapMinimumKnownCoverage` from `2 / 3` to `0.5`.
3. Require a partial role with 2 transferable and 2 unknown duties to promote
   through `zero_duty_gap`.
4. Preserve or add a paired regression proving that 2 transferable, 1 missing,
   and 1 unknown duties do not promote.
5. Run the focused decision and pipeline smoke tests and observe RED before
   production edits.

## Task 2: Implement the single policy change

1. Set `DECISION_POLICY.version` to `four-tier-weighted-v4.6`.
2. Set `zeroDutyGapMinimumKnownCoverage` to `0.5`.
3. Set `PIPELINE_VERSIONS.decisionRules` to
   `four-tier-weighted-v4.6`.
4. Keep `PIPELINE_VERSIONS.matchJob = match-decision-v41`.
5. Do not change the prompt, contract, matrix, weights, thresholds, provider, or
   model settings.

## Task 3: Verify deterministic behavior

1. Run the focused four-tier decision, pipeline, semantic pipeline, and adapter
   smoke tests.
2. Run the generic benchmark fixtures, private runner smoke test, and complete
   offline `npm.cmd test`.
3. Run `git diff --check`.
4. Replay all 20 frozen jobs from the approved private evidence into a new v4.6
   offline directory.
5. Require zero missed expected communication opportunities and zero
   caution/reject jobs admitted to default communication.

## Task 4: Independent review and evaluated checkpoint

1. Generate a private review package without resume, JD, title, company, model
   configuration, or secret content.
2. Obtain independent spec-compliance and code-quality reviews.
3. Fix any Important or Critical finding before proceeding.
4. Commit the reviewed product and docs, record the exact evaluated checkpoint,
   and push the continuation branch.
5. Verify that the product commit is a strict ancestor of the evaluated
   checkpoint.

## Task 5: Fresh live acceptance

1. Reverify the frozen jobs and labels SHA-256 values.
2. Create
   `D:\DevData\RoleFlow-private-benchmark\four-tier-weighted-v4-6-first-3-20260802`.
3. Run fresh indices `5,8,13` with a new cache.
4. Publish a beginner-readable Chinese stage report with English field
   annotations.
5. Stop before 20 jobs if any structural, bucket, empty-response, stale,
   pending, partial, evidence, or behavior gate fails.
6. After 3/3 passes, create
   `D:\DevData\RoleFlow-private-benchmark\four-tier-weighted-v4-6-full-20-20260802`
   and run all 20 with another fresh cache.
7. Require all expected `priority` and `apply` jobs to remain selected and no
   expected `caution` or `reject` job to enter default communication.

## Task 6: Finalize

1. Update the decision matrix and matching plans with observed v4.6 evidence.
2. Rerun the final offline regression suite.
3. Obtain final independent review.
4. Commit and push every accepted checkpoint to GitHub.
5. Restore the live worktree to
   `codex/claude-generic-evidence-matching-live-fix` at
   `1fc49dac3670a71c720bfcaed943fa29204d93c5` and confirm it is clean.

### 2026-08-02 v4.6 半覆盖零缺口 checkpoint

- v4.5 全新三条目录：`D:\DevData\RoleFlow-private-benchmark\four-tier-weighted-v4-5-first-3-20260802`。索引 `5,8,13` 技术门禁全部正常，行为通过 2/3；索引 8 仍为人工 `apply`、实际 `caution`，因此未运行 v4.5 全 20 条。
- 根因：索引 8 的职责结构已经稳定为 2 个 `transferable`、2 个 `unknown`、0 个 `missing`，但 v4.5 新增的 `2/3` 已知职责覆盖门槛高于实际 `2/4`。保护样本索引 13 保留 1 个 confirmed `missing`。
- v4.6 保持二维表、70/30 权重、模型提示词、温度、调用次数和 `matched_indispensable` 路线不变，只把 `zeroDutyGapMinimumKnownCoverage` 从 `2/3` 调整为基础值 `0.5`；至少 2 个正向职责、0 个 confirmed missing 及所有既有 ceiling 继续生效。
- RED 测试提交：`cce5df5b8374d92e5b42d17d64001167440bac5c`。产品提交：`e370b254125d9a838b3563ee39c75e9343868229`。复审说明修复提交：`3c8aa3ba3fcd34143dbda499c1d6dce705484043`。
- 版本：`decisionRules=four-tier-weighted-v4.6`；模型提示词缓存版本仍为 `matchJob=match-decision-v41`。
- 聚焦测试、31 个通用 fixture、私有 full-chain runner 冒烟测试、`npm.cmd test` 全部 50 项及 `git diff --check` 均通过。
- 冻结 20 条接受回放：`D:\DevData\RoleFlow-private-benchmark\four-tier-weighted-v4-6-offline-replay-v2-20260802`；应沟通 10、实际沟通 10、遗漏 0、误入 0、行为 20/20、四档 exact 13/20。未调用模型。
- 首次回放目录 `D:\DevData\RoleFlow-private-benchmark\four-tier-weighted-v4-6-offline-replay-20260802` 因一次性脚本把 `primary` 误写为 `priority` 而失败，已原样保留；产品和冻结证据无缺陷。
- 第一轮规范复审指出 v4.6 设计误写联合阈值约束；代码质量复审同时指出主说明和测试命名问题。修正文档契约与命名后，第二轮结论为 `Spec PASS` 和 `Code quality APPROVED`，无剩余 Critical、Important 或 Minor。
- 私有基线仍为 `c1d32641bca2ccd4c82128f48f3cfac996310dfb`，三项共享 runner blob 未变化，无需再次同步基线。
- 新真实目录固定为 `D:\DevData\RoleFlow-private-benchmark\four-tier-weighted-v4-6-first-3-20260802` 与 `D:\DevData\RoleFlow-private-benchmark\four-tier-weighted-v4-6-full-20-20260802`；必须先 3/3，再运行 20 条。
- 包含本记录的下一份 docs checkpoint 是被评估提交；`e370b254125d9a838b3563ee39c75e9343868229` 必须为其严格祖先。
### 2026-08-02 v4.6 精确 evaluated 绑定

- v4.6 产品提交：`e370b254125d9a838b3563ee39c75e9343868229`。
- 通过双重复审的 evaluated checkpoint：`e2a2366403b1a1052a96a5f0be4a6318329a0413`。
- 私有基线提交：`c1d32641bca2ccd4c82128f48f3cfac996310dfb`。
- `e370b254125d9a838b3563ee39c75e9343868229` 已验证为 `e2a2366403b1a1052a96a5f0be4a6318329a0413` 的严格祖先；v4.6 真实 3 条与 20 条固定使用 `e2a2366403b1a1052a96a5f0be4a6318329a0413`，不使用本次记录提交替代被评估提交。