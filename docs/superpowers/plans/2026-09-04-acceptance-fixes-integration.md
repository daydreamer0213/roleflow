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
- [x] 独立只读复审自动合并、共享服务端入口与打包边界；运行双方关键回归并完成本地合并提交。
- [x] 精确集成提交上设置 `ROLEFLOW_REQUIRE_PLAYWRIGHT=1` 和既有 Playwright 的 `NODE_PATH`，运行 `npm test`；记录实际总数、退出码与完整日志。通过前不合入 main 或打包。

## Task 2：安装包与交接

**Existing scripts:** `scripts/build-installer.ps1`、`scripts/installed-self-check.ps1`，无需修改。

- [x] 用 `git merge --ff-only codex/acceptance-fixes-20260904` 更新干净本地 main，不推送。
- [x] 同一精确代码树使用 `scripts/build-installer.ps1 -SkipTests -PortableNodeRoot D:\hermes\node -BuildRoot D:\DevData\RoleFlow-acceptance-fixes-20260904\build -OutputDir D:\DevData\RoleFlow-acceptance-fixes-20260904\output` 构建；这里 SkipTests 仅复用紧邻的同 SHA 完整门禁，不替代验证。
- [x] 检查暂存区无数据库、简历、密钥、登录资料和日志；源代码与暂存区逐文件哈希一致，安装器与 sidecar SHA-256 一致。
- [x] 对暂存区执行 `scripts/installed-self-check.ps1 -ProjectRoot <stage\1.3.0> -DataRoot D:\DevData\RoleFlow-acceptance-fixes-20260904\self-check-data`，不启动真实浏览器；检查 `SELF_CHECK_OK`。
- [x] 更新本计划、交接文档并提交文档回执，确认产品代码与已验证/打包提交无差异；`git diff --check`、干净状态及风险相关回归复验。
- [x] 给用户安装器路径及人工验收步骤，明确当前运行版尚未替换、真实批次尚未恢复。

## 实际验证回执

- 集成提交：`ae9d1805f7e6f8ff9e3545e48e8f6f51e18e4104`，本地 main 从 `7c7d67e` 快进到该提交。两个原始候选和隔离工作树保留，没有推送或改写历史。
- 13 项关键回归全部通过：筛选偏好、今日任务、沟通批次存储、两种搜索范围、语义/四档分析、CLI 沟通、工作流沟通、沟通页、工作流页、初始搜索与首次使用续接。
- 精确集成 SHA 新鲜严格 `npm test`：退出码 0，末行为 `All 143 offline checks passed.`；完整日志 `D:\DevData\RoleFlow-acceptance-fixes-20260904\verification\full-test.log`。本地 Edge 页面检查未跳过，产品树在完整门禁与打包期间未改变。
- 独立只读复审：Critical 0、Important 0；唯一 Minor 是 NEXT_PHASE 旧门禁可能误导，已在文档回执将集成结果置顶并标出历史边界。没有因集成添加产品代码或新依赖。
- 固定 Node v22.23.1、Inno Setup 6.7.3 构建成功，退出码 0。安装器 40,156,005 字节，SHA-256 `cebd5aab5d8e86e56d45c17644c4e5d80428af0ac063f3463b41eb66849f9e14` 与 sidecar 一致。完整构建日志在上述 verification 目录的 `build.log`。
- 暂存区 `D:\DevData\RoleFlow-acceptance-fixes-20260904\build\stage\1.3.0`：2,621 文件、175,969,892 字节；全部文件与源码/固定 Node 来源哈希匹配，禁入项 0。包含猴子图标与新增中断提示页面；结构化结果为 `stage-verification.json`、`installer-verification.json`。
- 暂存安装自检使用独立 `self-check-data` 和 `self-check-localappdata`，退出码 0、`SELF_CHECK_OK`；没有启动真实浏览器或使用真实数据。日志为 `verification\self-check.log`。
- 用户验收说明位于安装器同目录 `验收说明.md`。安装包内部版本沿用 1.3.0，仅供本地验收，不等于公开 v1.3.0 的原资产，也不能直接拿去替换公开资产。
- 未验证：真实覆盖安装、BOSS 当前页面、遗留沟通批次恢复及真实发送效果。没有访问 BOSS、调用真实模型、修改用户方案/数据库、安装或启动新包；这些仍由用户人工验收。
