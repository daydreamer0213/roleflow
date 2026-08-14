# RoleFlow beta.4 全新用户人工验收问题台账

**日期：** 2026-08-14

**状态：** 验收进行中；当前只记录问题，不修改产品

## 问题 1：首次启动失败提示不适合普通用户

### 观察事实

- 用户从 `E:\RoleFlow` 启动 RoleFlow 后，程序没有进入工作台。
- 弹窗标题为“RoleFlow”，正文显示“RoleFlow 启动失败”。
- 弹窗直接暴露了 PowerShell 内部位置：
  - `E:\RoleFlow\scripts\start-workspace.ps1`
  - `E:\RoleFlow\scripts\start-edge-control.ps1:144 字符: 36`
- 用户可见提示只有“检查 Microsoft Edge 和浏览器连接组件，然后重试”，没有说明具体缺少什么、如何检查或从哪里安装。
- 弹窗给出的诊断日志为：
  `E:\RoleFlow\.runtime\logs\launcher.log`

### 当前影响

- 全新用户无法继续进入模型配置和后续引导流程。
- 错误信息包含内部脚本位置，但没有转换成普通用户能执行的解决步骤。

### 后续统一分析项

- 已读取实际日志 `E:\RoleFlow\.runtime\logs\launcher.log`。
- 已确认安装自检中的 Node、Edge 和隔离端口检查均成功。
- 已确认 Edge Control 配置文件存在，但桥接端口当前没有监听；这不是本次最先发生的失败。

### 根因分析

- `scripts\start-edge-control.ps1` 第 141 行在 PowerShell 双引号字符串内部使用了中文弯引号：

  ```powershell
  README 的“浏览器连接”步骤
  ```

- Windows PowerShell 会把弯引号也识别为字符串引号，导致脚本在加载阶段发生语法错误。弹窗显示的第 144 行只是解析器最终报错的位置，不是真正根因。
- 对已安装脚本运行 `-CheckOnly` 稳定复现同一解析错误。
- 只在内存中把弯引号替换为不参与 PowerShell 语法的书名号后，解析错误从 1 个降为 0；没有写回安装目录。
- 对仓库全部 PowerShell 脚本做只读解析，只有 `scripts\start-edge-control.ps1` 这一份文件失败。

### 阻塞判断

这是当前公开 beta.4 的真实启动阻塞缺陷。脚本在任何 Edge Control 检查或启动逻辑执行前就无法解析，因此即使浏览器连接组件已经正确安装，普通启动流程仍无法继续。

### 当前处理决定

用户已确认把该阻塞项作为例外立即修复。仓库中的启动脚本已完成最小修复并增加真实 PowerShell 解析回归检查；原 `E:\RoleFlow` 安装目录没有手工修改，`v0.1.0-beta.4.1` 安装包仍在验证和发布中。错误弹窗的信息层级与操作指引继续留待本轮完整验收后统一整改。
