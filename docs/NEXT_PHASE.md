# RoleFlow 下一阶段主控索引

> 更新于 2026-08-24。当前工作对象是尚未发布的 stable dedicated Edge source candidate，不是已发布 v1.0.0 的补丁说明。

## 当前结论

- 默认路径已定义为“RoleFlow 专用 Edge（推荐）”，不需要 Edge Control。
- `%LOCALAPPDATA%\RoleFlow\BrowserProfile` 只保存并稳定复用浏览器登录资料；数据库等安装目录数据不会自动跨目录迁移。
- “使用当前 Edge（高级，需要浏览器连接组件）”只允许显式选择，且不会成为默认路径的自动 fallback。
- 两个固定 BOSS 页仍是基线；消息发现只有一个受控后台临时详情页例外。
- 用户启动工作区时可以有一次前台引导，之后所有产品工作都保持后台。
- 迁移显式、只复制并保留源；普通/静默卸载保留 profile，删除需要独立确认。
- 启动测试不再创建假的 `msedge.exe`；Edge Control 不进入普通安装包。

## 当前门禁

状态：**已通过**。

2026-08-24 在 HEAD `f384896227948926f9e3af515804ce8df9e04ab3` 加 Task 8 fix round 2 工作树上运行 `node tests/run_all.js`，退出码为 0，101/101 项通过，原始末行为 `All 101 offline checks passed.`。这不是尚未产生的修正提交 SHA，也不代表已经完成真实 Edge、BOSS、安装或卸载验收。

## Task 8 已完成记录

- Installer `StageOnly` 已在 `D:\DevData\RoleFlow-installer\offline-gate-5e2587006b1a43d0832fa3d3dd75b695\stage\1.0.0` 完成。
- 独立禁入扫描检查了 3,145 个暂存条目，没有发现 profile、测试、SQLite、Key、`.env`、secrets、运行目录、报告/日志或 Edge Control bridge。
- `git diff --check` 已通过；提交前 `git status --short` 只包含获批的 Task 8 文档、用户文案和既有测试夹具迁移。
- Task 8 candidate commit 已生成：`e5916ce56eb4d0f88fbbcdf1a1fa8494f68d5da2`。

`e5916ce56eb4d0f88fbbcdf1a1fa8494f68d5da2` 只是进入本轮修正文案前的 Task 8 candidate commit，不是最终 candidate source SHA。Task 9 将在所有修正提交完成后，从干净工作树的实际 HEAD 读取并记录真实 candidate source SHA。

## 本阶段不做

- 不运行安装或卸载。
- 不启动 Edge，不探测真实 `8787`/`9222`，不访问 BOSS。
- 不发送消息、不沟通、不投递、不申请任何岗位。
- 不把历史真实验收写成当前候选已验收。
- 不推送、合并或发布。

## 发布前仍需用户决定

离线候选完成不等于允许发布。后续若要安装、真实页面验收、签名、推送、合并或发布，必须分别明确授权，并继续遵守以下边界：

- 真实浏览器检查保持串行、低频、后台和失败即停。
- 任何外部写仅限用户确认的不可变批次；不自动重试歧义结果。
- 不以减少 JD 覆盖、召回或推荐质量换取速度。
- Edge Control 仍只属于显式高级路径，不进入普通交付包。
