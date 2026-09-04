# 验收修复集成与本地安装包 Implementation Plan

> **For agentic workers:** Use executing-plans; only the independent read-only integration review is delegated.

**Goal:** 将已验收的兼职/空薪资与沟通续接修复一起交付为本地人工验收安装包。

**Architecture:** 在本地 main `7c7d67e` 的隔离集成分支合并两个现有候选，保留各自代码与证据，只解决交接文档冲突。复用现有安装构建和自检脚本，不新增发布体系或运行时行为。

**Tech Stack:** Node.js 22.23.1、PowerShell、Inno Setup、现有离线 smoke checks。

## 约束

- 用户已批准集成打包；本次不推送、不公开发布、不创建标签或改正式版本号。
- 产物使用独立的 `D:\DevData\RoleFlow-acceptance-fixes-20260904`，版本仍为 1.3.0；不得覆盖旧发布资产。
- 不替换运行中的安装版，不访问真实 BOSS、不运行真实沟通、不修改真实数据库；自检使用独立 D: 数据与 mock。
- 不新增产品行为或依赖。此前修复的设计和独立门禁保留，不能当作集成后的最终证据。

## Task 1：集成与完整验证

**Sources:** `codex/part-time-salary-policy` @ `8725f3a78c7683f17920a0dfed72b524c474a2cf`、`codex/communication-resume-recovery` @ `6e790265f0071fd1aef3a2fcea1c793880856878`。

**Files:** 合并候选现有差异；仅人工修改 `docs/PROJECT_HANDOFF.md`、`docs/NEXT_PHASE.md` 和本计划。

- [x] 核对干净 main 与候选、共同基线，创建 D: 隔离分支并合入两候选；仅交接文档冲突。
- [ ] 独立只读复审自动合并、共享服务端入口与打包边界；运行双方关键回归并完成本地合并提交。
- [ ] 精确集成提交上设置 `ROLEFLOW_REQUIRE_PLAYWRIGHT=1` 和既有 Playwright 的 `NODE_PATH`，运行 `npm test`；记录实际总数、退出码与完整日志。通过前不合入 main 或打包。

## Task 2：安装包与交接

**Existing scripts:** `scripts/build-installer.ps1`、`scripts/installed-self-check.ps1`，无需修改。

- [ ] 用 `git merge --ff-only codex/acceptance-fixes-20260904` 更新干净本地 main，不推送。
- [ ] 同一精确代码树使用 `scripts/build-installer.ps1 -SkipTests -PortableNodeRoot D:\hermes\node -BuildRoot D:\DevData\RoleFlow-acceptance-fixes-20260904\build -OutputDir D:\DevData\RoleFlow-acceptance-fixes-20260904\output` 构建；这里 SkipTests 仅复用紧邻的同 SHA 完整门禁，不替代验证。
- [ ] 检查暂存区无数据库、简历、密钥、登录资料和日志；源代码与暂存区逐文件哈希一致，安装器与 sidecar SHA-256 一致。
- [ ] 对暂存区执行 `scripts/installed-self-check.ps1 -ProjectRoot <stage\1.3.0> -DataRoot D:\DevData\RoleFlow-acceptance-fixes-20260904\self-check-data`，不启动真实浏览器；检查 `SELF_CHECK_OK`。
- [ ] 更新本计划、交接文档并提交文档回执，确认产品代码与已验证/打包提交无差异；`git diff --check`、干净状态及风险相关回归复验。
- [ ] 给用户安装器路径及人工验收步骤，明确当前运行版尚未替换、真实批次尚未恢复。
