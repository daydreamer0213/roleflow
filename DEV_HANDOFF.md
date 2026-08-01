# RoleFlow continuation handoff (2026-08-01)

## 当前结论

- 活跃分支：`codex/multi-track-recall-continuation`
- 上一已审查产品提交：`175e9567fbfaedbfa4d3d92b55fcb5a4289c5a55`
- 基线 harness 提交：`2878acc694ce9b31ef90602f145dc5958bace4cf`
- 上一 checkpoint 独立复审：`Spec PASS`、`Code quality APPROVED`
- 当前规则修正尚未形成产品 checkpoint；提交前必须重新取得独立复审通过
- 当前规则修正离线回归：47/47；31 条 benchmark fixture 通过
- 基线离线回归：41/41；31 条 benchmark fixture 通过
- 三项共享 Git blob 已逐项确认候选/基线完全一致

## 本轮修正

1. 核心要求集合统一为 `foundation || central || indispensable`。
2. `matched=1`、`transferable=0.5`、`unknown=0`；全 unknown 为信息不足。
3. JD 未声明核心要求时返回 caution，不得直接主投。
4. `mostly_aligned + 符合` 按产品矩阵返回 apply。
5. 明确写成优先、加分项、非必须、可选的非核心 missing 不计数；
   “优先处理”“优先级”不会误判。普通非核心阈值为 5。
6. `foundation`、`central` 与 `indispensable` 相互独立。模型负责普通技能、
   行业和复杂同句语义；规则只校验跨岗位通用的明确 hard/soft 表达，不维护
   Java、PMP、AI 等领域词表。含糊语义有限度保留模型判断；模型布尔值可以
   参与核心排序，但核心 `skip` 必须再有 JD 明确硬边界和简历明确冲突。
   核心符合度 ≥ 80%、至少一条直接匹配有可核对双侧证据、且所有确认硬边界
   直接匹配时，不再被模型自评低置信度重复降级；无需每条重复双侧证据。
7. `misaligned + 部分符合` 保留为 review；核心得分为 0 或硬边界才 skip。
8. medium/high hidden risk 最高 review；缺任一侧总证据进入
   `model_evidence_gap`，矩阵 skip 也不得绕过。
9. 普通非核心缺口最低停在 review，不得单独制造 skip。
10. runtime bucket 继续作为展示与 workflow 安全上限，但 benchmark pass
   只比较 recommendation。
11. partial、indispensable-only 缺口、legacy/layered backup 和通用
   `decision_review` 都有明确回归；高薪备选保持原优先级。
12. 恢复了曾被 try/catch 吞掉、注释掉或放宽为字符串检查的测试。
13. private runner 固定候选路径恢复为
    `D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix`。

## 不可信旧结果

`D:\DevData\RoleFlow-private-benchmark\multi-track-recall-fullchain-v1-20260731`
只保留为历史诊断证据。其 result 与当前 manifest 不绑定，candidateProductCommit
和 shared file hashes 已过期，且辅助脚本会覆盖缓存/输出；不得把 11/20 声称为
正式验收，不得覆盖或删除该目录。

## 冻结输入

岗位池：`D:\DevData\RoleFlow-private-benchmark\confirmed-sample-pool-v1-20260730`

- jobs SHA-256：`612547b099d71f13fc5dd58e78a31756b4b56c7ad9375f7b3d182d73b5e0d35b`
- labels SHA-256：`97b4e5830fbf0fad8a694a3cfc1fcedfd5918b3e9723b811ebba09f1fb46da39`
- 两项已于本轮重新计算并匹配

已完成且必须保持不可变的首轮诊断目录：

- 3 条：`D:\DevData\RoleFlow-private-benchmark\multi-track-recall-decision-matrix-v2-first-3-20260801`
- 真实模型结构、安全和证据门禁通过，但推荐为 0/3 exact；该目录只作为根因证据，
  不得覆盖、删除或复用缓存

下一轮必须使用的新目录：

- 3 条：`D:\DevData\RoleFlow-private-benchmark\multi-track-recall-decision-matrix-v3-first-3-20260801`
- 20 条：`D:\DevData\RoleFlow-private-benchmark\multi-track-recall-decision-matrix-v3-full-20-20260801`

## 下一步顺序

1. 当前规则修正通过离线回归和独立复审后，先提交并推送新的产品 checkpoint。
   再提交 docs-only evaluated checkpoint，并用紧随其后的 docs-only binding
   记录精确 evaluated SHA；新产品提交必须是 evaluated commit 的严格祖先。
2. 用 fixed candidate worktree 创建临时评估分支，重建全新 manifest、v3 proof、
   profile/card confirmed envelope；禁止使用 `patch-artifacts.js` 伪造 Git 状态。
3. 先以零基索引 `4,9,10` 跑 3 条；结构、分档、空响应或安全门禁任一失败，
   只分析首个失败，不运行 20 条。
4. 3 条通过后，在全新 20 条目录与全新缓存运行完整验收；目标 exact 至少
   18/20，所有安全/召回门禁满足。18/19 需完整展示偏差；低于 18 从首个错误
   样本继续 TDD 修复，不直接改阈值。
5. 运行后恢复 fixed candidate 原分支
   `codex/claude-generic-evidence-matching-live-fix` 和原提交
   `1fc49dac3670a71c720bfcaed943fa29204d93c5`，确认工作树干净。
6. 最终回归、独立复审并推送 continuation；不合并 main。

## 安全边界

- 不访问真实 BOSS，不点击沟通，不读取 Cookie，不读写 `data/jobs.sqlite`，
  不启动或操作 8787。
- 不修改 `D:\Guo\ZhiPing`；真实模型配置只在 live runner 门禁通过后只读解析，
  不打印、不复制、不提交配置或密钥。
- 所有私有输入、缓存和输出只写 `D:\DevData\RoleFlow-private-benchmark`。
- 不复用 3 条缓存到 20 条，不覆盖任何旧结果目录。

### Decision-matrix continuation exact evaluated binding

- Candidate evaluated is exactly
  `e017a524b777675aa294be4935e35357ee094cea`. Candidate product
  `175e9567fbfaedbfa4d3d92b55fcb5a4289c5a55` is its strict ancestor.
- This immediate docs-only binding record does not replace candidate evaluated
  `e017a524b777675aa294be4935e35357ee094cea` in the manifest, v3 proof,
  temporary evaluation branch, or live verification.
- Baseline evaluated is exactly
  `2878acc694ce9b31ef90602f145dc5958bace4cf`; baseline product remains the
  user-approved `fb0168afce265cf351f03e80f66d9e0f24015887`.
