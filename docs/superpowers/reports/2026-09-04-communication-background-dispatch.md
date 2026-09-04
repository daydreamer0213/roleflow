# 后台沟通生命周期与诊断收口

## 当前结论

用户在 v1.3.1 再次遇到沟通中断。本次先核对实际批次、安装版代码和浏览器状态，再在隔离分支 `codex/communication-background-dispatch` 修复已复现的焦点模拟生命周期问题，并补齐脱敏诊断。代码实现提交为 `14e2a887aec63ed1a8628e3f78a6a537f469df13`，独立复审和该代码的新鲜严格完整门禁 **144/144** 均通过。没有替换安装版或重试真实沟通；真实 BOSS 中断的唯一原因及修复后的真实效果仍未确认。

## 事实与因果边界

- 本次批次共 9 项：1 项有平台成功证据，下一项未确认，后续 7 项未点击。原记录只有 `no_matching_request`，不足以证明平台没有收到操作。
- 本次与同日上午点击前的搜索条件范围不符属于不同环节。此前 8 月 30 日的 17/17、8 月 25 日的 5/5 成功仍是有效历史证据，但不能覆盖所有浏览器时序。
- 当前安装版的四个相关核心文件与 main 在统一换行后相同，且 v1.3.0 到 v1.3.1 没有修改这四个文件；没有证据将本次归因于新版本回退。
- 两个本地页面的对照证实：旧实现启用焦点模拟后立即关闭其连接，150 ms 后模拟不再有效；保留连接则有效，断开后消失，5 次对照一致。单页面自然有焦点、普通按钮仍可能成功，因此这一缺陷不是本次 BOSS 中断的已证实唯一原因。
- 未证明网络慢、休眠、封控或用户操作导致本次失败。事发页面已恢复为搜索页，不能用事后页面代替点击瞬间证据。

## 修改

- `src/adapters/browser/cdp.js`：仅在启用焦点模拟期间保留连接；关闭和异常释放。普通命令仍为短连接，不激活前台、不补点。
- 断线或命令失败后保留已关闭作用域的错误，后续守卫或点击直接返回原错误；显式关闭才清除标记，不以新短连接继续执行。
- `src/adapters/browser/cdp_network_log.js`：按既有白名单、序号和容量，另计仍未结束的请求，区分“在途”和“未观察到”。不延长等待或更改成功标准。
- `src/adapters/sites/boss.js`：最终守卫观察目标点击，记录布尔回执与有限页面状态，成功和未确认结果均保留诊断；结束时清理监听器。回执不能代替平台成功证据。
- `src/adapters/sites/boss.js`、`src/adapters/sites/boss_message_reply_sender.js`：把焦点启用放入现有清理范围；启用失败也执行关闭，保留原错误且不会点击或填入回复，不会遗留失败状态挡住同一适配器的后续操作。
- `src/core/communication_executor.js`：落库只接受指定布尔值、枚举和受限计数，拒绝任意正文或 URL；沿用已有 JSON 字段，无数据库迁移。
- `src/dashboard/status_labels.js`、`src/dashboard/user_facing_errors.js`：提示改为“未能确认本次沟通结果”，明确不等于发送失败，并沿用核对实际结果的入口。
- 相关 transport、站点、执行器与页面回归；新增 `tests/cdp_focus_scope_smoke.js`，接入完整门禁。

## 验证记录

- 焦点实际浏览器回归先 RED：150 ms 后 `document.hasFocus()` 为 false；实现后 GREEN，唯一点击次数为 1。使用隔离 headless Edge、独立临时资料和两个 `data:` 页面。
- 点击回执、请求在途计数和脱敏落库分别获得 RED/GREEN；没有回执或回执属于其他岗位时保持未知，未确认结果仍中断，后续岗位零点击。
- Task 2 独立复审发现成功路径遗漏诊断，已用 `c44e723` 补齐并通过复核；成功结果及持久化隐私过滤均有回归。
- Task 1 独立复审发现空闲断线后会丢失焦点保护却继续普通命令，`216238c` 补齐失败作用域保留及 CDP 错误路径回归后通过复核。
- 第一轮新鲜严格 `npm test` 在代码提交 `216238c5494fa34d18e2603c21143716b20c1d0f` 退出码 0，末行为 `All 144 offline checks passed.`。日志 `D:\DevData\RoleFlow-communication-background-20260904\verification\npm-test-216238c.log`。当时只有交接文档草稿未提交；测试期间代码不变。
- 最终整分支复审仅发现一项 Important：沟通与回复填入/发送的焦点启用位于清理 try/finally 之前，启用失败会跳过关闭并阻止同一适配器的后续读取。`14e2a88` 将启用移进现有清理范围；两项调用者回归先 RED（缺少 `enabled:false`），修复后 communication/page、reply/sender 和 browser/transport 三项 GREEN，验证原错误、零点击/零填入、观察器清理和已准备回复仍可清理。
- 最后一次修复范围复核通过：无剩余 Critical、Important 或 Minor。没有为修复增加重试、前台激活、公共接口或依赖。
- 最终代码 `14e2a887aec63ed1a8628e3f78a6a537f469df13` 的新鲜严格 `npm test` 退出码 0，末行为 `All 144 offline checks passed.`，没有 Playwright 跳过提示。日志 `D:\DevData\RoleFlow-communication-background-20260904\verification\npm-test-14e2a88.log`；与第一轮分开保存。环境为 Node 22.23.1、已安装 Playwright、`ROLEFLOW_REQUIRE_PLAYWRIGHT=1`，TEMP/TMP 及 npm 缓存均在 D:。
- 两次完整测试均有既有 Git fixture 的初始化/换行提示及 Git 诊断输出，最终 runner 明确返回成功；不将这些输出说成生产故障，也不声称日志完全无提示。
- 交接文件和本轮临时审查文件整理不修改上述实现与测试。最终交接提交后的风险复验使用同一严格环境，日志保留在上述 verification 目录，以日志对应的精确提交为准。

## 平台、数据与下一入口

前一诊断步骤仅只读查看了现有固定标签及消息列表可见记录，没有导航、选择会话、填写或沟通点击。实现及测试只使用本地 fixture、假浏览器、临时数据库和独立本地 Edge；没有读取真实简历用于测试、没有修改真实批次或登录资料。

本地分支不推送、不合并、不改版本、不打包、不发布，当前安装版不变。后续先交付验证结果；安装与新的真实沟通必须按用户当时的授权执行，历史未确认项不能自动重试。详细原始诊断保留在仓库外 `D:\DevData\RoleFlow-release-v1.3.1\verification\2026-09-04-communication-interruption-diagnosis.md`，不把真实岗位或招聘方正文带入仓库。
