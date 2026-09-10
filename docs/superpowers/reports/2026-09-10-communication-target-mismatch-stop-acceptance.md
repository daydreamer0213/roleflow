# 普通沟通错配中断：收口报告

日期：2026-09-10。分支 `codex/zhaopin-readonly`。完整门禁源码提交：`cb815b0af122b08b60d6819b929c09136f59fd9a`。

## 用户能看到的变化

普通沟通核对到岗位与确认清单不一致时，不向该岗位发起沟通，立即停止整批，保留剩余岗位。页面直接说明原因、未发送与下一步；不再只显示内部编号，也不误要求用户处理“发送结果不明”。用户主动继续时只处理剩余项，错配项仍待核对，不自动重试。

## 根因和修改

两个平台适配器均可能返回 `target_mismatch`。原共享执行器把它和下架/按钮不可用归入同一跳过分支，旧测试也认可继续下一项，违反已有整批立即停止约定。本次在原证据、待核对状态落库后，复用现有 `interruptAndThrow` 同步中断批次和本轮；早于单项检查点与下一次等待/访问。没有新增调度器、重试、状态、数据迁移、依赖或审批。

文件：

- `src/core/communication_executor.js`：共享执行器返回错配时中断。
- `src/dashboard/user_facing_errors.js`：两平台共用的明确提示。
- `tests/communication_executor_smoke.js`：批量/单项停止、主动恢复及普通不可用仍可跳过。
- `tests/zhaopin_communication_storage_smoke.js`：智联实际单项入口、额度隔离、零投递统计与剩余项恢复。
- `tests/dashboard_communication_batch_smoke.js`：页面原因、下一步、技术信息折叠及非不明确结果流程。
- `docs/PROJECT_HANDOFF.md`、`docs/NEXT_PHASE.md`、本次计划和报告：明确主线、旧安装基线及当前证据。

## 验证证据

1. 原有执行器检查先通过；替换错误旧预期并新增回归后，BOSS/智联两项都实际失败于“应中断却未中断”，页面回归失败于缺少具体原因。
2. 修复后 13 项定向通过：`communication_executor_smoke`、`zhaopin_communication_storage_smoke`、`dashboard_communication_batch_smoke`、`dashboard_zhaopin_communication_smoke`、`communication_application_smoke`、`communication_cli_authority_smoke`、`workflow_communication_smoke`、`workflow_end_to_end_smoke`、`communication_batch_storage_smoke`、`communication_store_contract_smoke`、`communication_runtime_smoke`、`zhaopin_communication_adapter_smoke`、`boss_communication_page_smoke`；两处生产文件语法检查通过。
3. 限定只读独立复核：Critical / Important / Minor 均无；复核者另外独立执行 BOSS 执行器和智联存储两项，均退出 0。
4. 冻结 `cb815b0af122b08b60d6819b929c09136f59fd9a` 后运行新鲜完整 `npm test`，**All 160 offline checks passed.**；严格要求浏览器测试，退出 0，开始/结束 SHA 相同且工作树干净。日志：`D:/DevData/RoleFlow-zhaopin-message-context-20260908/full-gate-cb815b0-20260910-100730.log`。不是先前 `6644c58` 的全测结果。
5. 最后仅补文档记录，不再改变已全测的产品和测试源码；最终文档 SHA 的定向复验及远端保存状态见仓库外 `D:/DevData/RoleFlow-zhaopin-message-context-20260908/communication-mismatch-save-receipt.json`。

## 环境与未验证前提

- 使用临时库、假浏览器和本地浏览器模拟；本轮没有读取真实招聘平台，没有真实投递/招呼/回复/简历同意或拒绝。新代码的实站表现仍待最终人工验收。
- 未重启或替换当前两套用户验收服务。核对时 8787 进程 27620、8788 进程 22628 均仍监听；后续请现场重新识别，不能复用旧 PID。
- 8787 安装于 `D:/Apps/RoleFlow-Acceptance-20260910`，仍为 `6644c58` 基线，包含本次修复之前的代码。已核对安装执行器与原打包目录哈希相同；不声称新代码已经安装。全新用户仍可先验模型设置、简历、找岗与只读消息，后续包纳入本修复后再扩大真实沟通验收。
- 当前主线是多平台最终验收：智联招呼仍为单岗位验收，自动回复尚未开放；普通启动不自动打开智联两个页面，搜索页由“准备智联搜索页”后台准备，消息页需事先打开并登录。
- 本轮未再次清理用户资料或安装副本；检查末段 D 盘剩余约 16.39 GiB。未更改版本 1.3.2，不合并、不打包、不发布。分支保存使用已有系统 SSH 的单次调用覆盖旧失效路径，不修改账户或仓库连接配置。

## 新本地验收包

随后从完全相同的产品/测试源码生成新的本地验收包，不重复执行完整门禁：

- 安装包：`D:/DevData/RoleFlow-local-acceptance-20260910-73ef134/packages/RoleFlow-Setup-1.3.2.exe`
- SHA-256：`27e29d36b8b45304208707c87e574cc4264218c86a6b04ee8cd6690f6b8d2b34`
- 大小：40,203,852 字节；版本 1.3.2。
- 构建脚本退出 0；2630 个 stage 文件中 585 个非运行时文件逐个与 `73ef1345ac8dbb44c5d3f10a8a0da87ed1432461` 源树相同；个人数据文件 0；对 stage 运行安装后自检返回 `SELF_CHECK_OK`。
- 证据：`D:/DevData/RoleFlow-local-acceptance-20260910-73ef134/package-verification.json`、`build-installer.log` 和 `stage-self-check.log`。

该安装包是本地验收物，不是公开发布。为避免与用户正在操作的 8787 抢占端口，本轮没有自动安装、覆盖快捷方式或更新 Windows 安装登记。

## 下一入口

保留并推送当前开发分支；用户结束当前 8787 后，用上方新包完成全新使用和再次打开两轮真实人工验收。此前磁盘清理、两版架构图及首次启动已交付，不重做；架构图是 `6644c58` 快照，当前错配缺口已由本报告所列源码修复关闭。
