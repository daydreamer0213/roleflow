# RoleFlow 下一阶段主控索引

> 更新于 2026-08-23。当前工作对象是尚未发布的 stable dedicated Edge source candidate，不是已发布 v1.0.0 的补丁说明。

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

2026-08-23 在 HEAD `9fcd4c7ee423709632f581341bb0153a57bd396b` 加当前 Task 8 工作树上运行 `node tests/run_all.js`，退出码为 0，101/101 项通过，原始末行为 `All 101 offline checks passed.`。这不是尚未产生的 Task 8 提交 SHA，也不代表已经完成真实 Edge、BOSS、安装或卸载验收。

本阶段剩余步骤：

1. 在 `D:\DevData\RoleFlow-installer` 下新建唯一的 `offline-gate-*` 目录，运行 installer `StageOnly`；不得把大体积暂存数据写到 `C:`。
2. 运行暂存包禁入扫描、`git diff --check` 和 `git status --short`，确认只有预期修改。
3. 提交当前文档候选；Task 9 再基于干净工作树记录已提交 candidate source SHA。

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
