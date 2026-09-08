# 智联消息公司资料待核对隔离 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** 同一明确岗位的公司展示名不能验证时，保留该会话待处理，不关联、不学习、不生成草稿，也不因此阻止其他有效会话。

**Architecture:** 复用现有逐会话 unresolved/continue 分支。把可信岗位链接编号和标题均匹配、但公司无法验证的情况区分为资料不足；编号/标题变更、读取后会话切换、登录/风控和清理失败仍是原终止错误。不是增加公司模糊匹配或放宽主动沟通。

**Tech Stack:** 现有 Node.js、SQLite、原生 Dashboard、Playwright 合成页；不新增依赖。

## Global Constraints

- 用户已批准主控持续完成消息/JD/草稿验收，停止于回复发送前；本任务是该实现缺陷的最小修复，不需要新增平台或用户架构决定。
- BOSS/智联真实平台串行、后台、现有节奏、额度、检查点和清理必须保留。真实岗位编号/标题不一致、会话变化、登录/风控、页面/清理失败仍停止，不把这些错误转成可继续。
- 不新增任何公司前缀/相似度关联；公司不能验证的项目不得落库为可信岗位、调用模型、关联卡片或生成/学习草稿。只是保留原文和原因后再处理其他会话。
- 不改 120 字详情完整度门槛、扫描数量/节奏、数据库结构、模型配置、账户、依赖、版本或外部写权限。普通招呼仍至多一个且须新完整门禁后；无回复/简历/投递。
- 主控独占文档、证据、隔离服务和真实浏览器；实施者不访问实站、不跑全门禁、不推送/合并/打包/发布。保护主控既存三个 dirty 文档。

## 现场证据与选择

`f6e83abbe76d930267999f78b6bf6c4af189f1e1` 的前一 DOM 修复已独立复核关闭，未重开旧全分支审查。主控普通 UI 开始一次消息发现：20条队列、已处理0，`ZHAOPIN_MESSAGE_DETAIL_TARGET_MISMATCH`。实际首个待处理是未读优先队列中的软件开发工程师，不是 DOM 首行。精确会话 `zhaopin:CCL1480117890J40879361105` 与详情 `/jobdetail/CCL1480117890J40879361105.htm` 的编号/标题均相同；会话公司“外企德科数字”、详情公司“外企德科数字技术有限公司”。现有 compatibleCompany 仅支持法定后缀，不能验证这组展示名。正文105字、loading=false，继续保持完整度不足，不下调门槛。

一次首行 Python 校验读到257字、编号/标题一致，公司仅差有限公司，现有 reader 成功；它不代表失败会话通过。随后精确失败目标的一次受控 reader/shared safety 探针复现上述不同公司名。所有临时页关闭，六页基线/前台1995703199保持。探针只输出公开岗位元数据，未发送/投递/处理简历。仓库外 `D:/DevData/RoleFlow-zhaopin-message-context-20260908/probe-detail-login.js --identity-only --source-id=CCL1480117890J40879361105` 和 live journal 留证。

推荐复用资料不足分支；不采用直接放宽公司匹配（可能错关联），也不让单个无法关联项目阻塞其他正常会话。保留原设计的“身份不能核对时保留原文并准确说明”，不伪造 JD 或模型结果。

### Task 1: 隔离公司待核对原因与准确提示

**Files / ownership:**
- Modify `src/adapters/sites/zhaopin_message_detail_reader.js`: 只拆分 assertSnapshotIdentity 的公司不能验证错误。
- Modify `src/core/message_discovery.js`: 只在 contextFailureReason 白名单保留新原因；不得扩展任何其他终止错误的继续条件。
- Modify `src/dashboard/message_discovery_view.js`: 在已有 messageDiscoveryRecoveryMessages 中增加准确原因提示。
- Test `tests/zhaopin_message_detail_reader_smoke.js`, `tests/zhaopin_message_discovery_smoke.js`, `tests/dashboard_message_discovery_smoke.js`；必要相邻验证 `tests/zhaopin_message_job_context_smoke.js`。仅在现有这些测试里添加合成用例，不使用真实公司/消息/简历。

**Interfaces:** 既有 reader 仍抛带 code 的 Error；新增代码 `ZHAOPIN_MESSAGE_DETAIL_COMPANY_UNVERIFIED` 经过现有 unresolved 保存和继续分支，不加入 CONTEXT_TERMINAL_CODES。`ZHAOPIN_MESSAGE_DETAIL_TARGET_MISMATCH` 的编号/标题/关闭后会话变化仍不变。

- [ ] RED：合成同ID同标题但公司“合成数字”/“合成数字技术有限公司”，真实详情表达式/reader 返回新待核对错误而不是 TARGET_MISMATCH；临时页必关闭。真实不同ID或标题仍 TARGET_MISMATCH，原法定后缀正例保持成功。
- [ ] RED：队列首项 resolver 抛上述新原因，第二项已有完整合成上下文。必须保存首项原文/原因、不为它关联/分析/草拟，但第二项得到真实现有草稿路径结果。覆盖同队列 TARGET_MISMATCH 时第二项不得调用；使用现有注入点和临时数据库，不用假的整个run成功代替代码。
- [ ] 实现最小分支：

```js
if (normalizedText(raw?.currentJobId) !== target.jobId
  || (title && !sameText(title, selected?.positionName))) {
  throw detailError("ZHAOPIN_MESSAGE_DETAIL_TARGET_MISMATCH", "zhaopin detail identity did not match the selected conversation");
}
if (company && !compatibleCompany(company, selected?.companyName)) {
  throw detailError("ZHAOPIN_MESSAGE_DETAIL_COMPANY_UNVERIFIED", "zhaopin company identity could not be verified");
}
```

在 contextFailureReason 原有三项白名单增加同一新代码，不修改终止集合。已有 sanitizeError 接受 ZHAOPIN_MESSAGE_ 前缀，不新增框架。

- [ ] UI 准确显示：新原因“会话与岗位详情的公司名称暂时无法核对。消息已保留，未关联岗位或生成草稿；你可以到智联原始会话核对。”；真正 TARGET_MISMATCH 显示“会话与岗位详情不一致，本次只读发现已停止。请核对智联当前会话后再重试。”；ZHAOPIN_MESSAGE_DETAIL_INCOMPLETE 显示“这份岗位详情还不完整，消息已保留，暂不生成草稿。可稍后重新只读发现。”。通过现有渲染行为检查，无文案源码存在性测试。
- [ ] GREEN：三个更改路径检查和 zhaopin_message_job_context_smoke；四个产品/测试模块实际覆盖如需增加文件先向主控说明原因。所有更改JS语法、git diff --check；仅暂存所有权文件并提交。
- [ ] 自查、完整报告 task-1-report.md 写清实际RED/GREEN命令、结果、文件、提交和疑点。不要运行全 npm test，主控负责。

## 主控后续

- [ ] 读取报告、不可变BASE..HEAD任务复核一次；不重开前一DOM/历史综合审查。
- [ ] 重启自己的隔离服务，用实际UI再次读取，确认目标待处理不会产生虚假关联，其他有效消息能走JD/模型/草稿并自动保存。
- [ ] 源码稳定后冻结并新鲜完整 npm test；只有通过后才至多一次普通初次招呼。保留真实结果和未验证项，不把部分成功当作所有历史会话通过。
