# 智联行政区后缀格式兼容

> Use subagent-driven-development for one mechanical task; prior company/scan tasks are closed.

**Goal:** 同一精确岗位在卡片使用区名简称、详情使用“新区”全称时正常读取；不得把不同城市或不同区当成相同。

**Architecture:** 只扩充现有 `sameLocation` 的行政区后缀归一。现有四编号完全一致时才允许商圈/区名格式差异的前置条件不变。不新增别名字典、模糊匹配、浏览器操作或存储字段。

## Global Constraints

- Worktree `D:/DevData/RoleFlow-worktrees/zhaopin-readonly`, branch `codex/zhaopin-readonly`. 主控拥有文档、真实平台/隔离服务、完整测试；实施者只改下面两个文件、只运行离线定向测试。保护其他改动，不 reset/amend/stage-all。
- 精确编号、公司、可见标题、薪资和城市校验不变；无完整编号时的精确地点比较不变；后台执行、节奏、访问额度、完整JD、用户条件、暂停/检查点均不动。无推送/合并/打包/发布/版本改动或真实外部操作。
- Tests use `D:/hermes/node/node.exe`; NODE_PATH=`C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules`, ROLEFLOW_REQUIRE_PLAYWRIGHT=1, TEMP=TMP=`D:/DevData/RoleFlow-tests`. 主控负责最终完整测试，实施者不重复全测。

## 当前证据

- `04359e7` 实际恢复保存26岗位/26完整JD，包括之前失败的代招岗位（公司与客户公司正确分列），滚动20→40也已正常通过；22:47UTC同一run停在下一条地点格式差异。
- 最小后台只读当前DOM在22:48UTC证实：卡片“上海 浦东 周浦”、详情“上海·浦东新区”，四编号完全一致、公司/标题/薪资一致、JD2315字、非加载；6标签/前台不变。实际公司与编号仅保留仓库外验收日志，不进合成测试。
- 现有 district 仅去掉末尾一个“区/县”，把“浦东新区”变成“浦东新”，与“浦东”不等。处理行政区后缀应优先整个“新区”，其余逻辑不动。不是公司任务复发、网络问题或真实岗位错位。

## Task 1: 补齐新区后缀

**Ownership:** `src/adapters/sites/zhaopin.js`, `tests/zhaopin_readonly_smoke.js` only. 主控维护文档。

- [x] 在既有真实helper/合成Vue2浏览器测试中先写RED：四ID一致、公司/标题/薪资不变，卡片“合成市 甲 商圈”、详情“合成市·甲新区”，readVisiblePaneDetail应成功。当前正则会拒绝。
- [x] 最小实现仅把现有 district 尾缀 `/[区县]$/` 改为 `/(?:新区|区|县)$/`，仍只移除结尾一次，保留exactComponentIdentity前置条件。host函数变化不需要改注入helper版本；不改选择器/字段/城市规则。
- [x] 保留/补足最小行为回归：同城不同区仍拒绝、不同城市仍拒绝、缺少完整ID时这类非完全相同地点仍拒绝；原公司/编号冲突测试继续通过。不写大规模新矩阵。
- [x] GREEN：readonly、workflow、communication_adapter三项既有套件，两个JS语法、owned diff检查；自审、仅提交两个拥有文件，写task-1-report.md含RED/GREEN命令关键输出、SHA及疑点。原SQLite实验警告记录但不扩大修复范围。
- [x] 主控独立规格/质量复核关闭；正常继续同一真实run，保留26结果。01:55UTC实际已推进32岗位/32完整JD，原新区岗位再次经过产品路径仍待核对。
- [ ] 最终全测与真实扫描/分析由主控继续；当前执行顺序及未完成项以 `2026-09-09-zhaopin-short-jd-isolation.md` 为准。之后至多一条已授权普通招呼，停在回复发送前；新区原失败岗位仍需实际重访证明，不因其他岗位推进而勾选通过。
