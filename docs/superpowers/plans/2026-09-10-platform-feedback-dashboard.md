# Platform Feedback Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 求职体检以平台反馈为中心，当前方案与累计记录清晰切换，后台独立判断各平台效果。

**Architecture:** 复用现有策略快照和事件投影，以platformScope折叠物理修订，不迁移历史归属。应用服务输出平台行，页面只显示计数、回复比例和一条可靠建议。

**Tech Stack:** Node.js、现有SQLite、服务端HTML/CSS、Playwright离线验收；不新增依赖。

## Global Constraints

- 不访问真实招聘平台或发送；不合并、不发布、不改版本。
- 48小时、周末顺延、30/50/70继续使用现有逻辑。
- 当前范围为所选方案各平台有效策略；累计为当前候选人的本地历史记录。
- 保留未知证据，不把缺少状态视为失败；没有投递起点的HR消息不混入回复比例。

## Task 1: 分平台统计和策略边界

Files: `src/storage/funnel_store.js`, `src/application/funnel_analysis/index.js`, `src/application/resume_optimization/index.js`, `tests/funnel_platform_feedback_smoke.js`, `tests/run_all.js`。

Interfaces: `getDashboard({profileId,planId})`新增`platforms[]`，每项含`site,currentRound,previousRound,roundComparison,lifetime`；`activeRevisionId`供表单校验。`startStrategyRound`接受`platformScope`，缺省all。

- [ ] 增加真实SQLite回归并先运行观察失败：两个平台各20岗位不能合成40样本诊断；早回复计数立即出现；只改BOSS后智联旧20和新1合为21；共享调整各自重新计数，累计保留。
  ```js
  assert.equal(result.platforms.find(p => p.site === 'zhaopin').currentRound.started, 21);
  assert.equal(result.platforms.find(p => p.site === 'boss').currentRound.started, 1);
  assert.equal(result.platforms.find(p => p.site === 'boss').lifetime.started, 21);
  ```
- [ ] 在策略快照存储验证过的`platformScope`。历史查询`limit:null`不截断；entries带真实jobs.source。用各平台有效修订ID集合筛选当前/前一组，保留物理ID及原事件。
  ```js
  if (!['all', 'boss', 'zhaopin'].includes(platformScope)) throw storageError('FUNNEL_PLATFORM_INVALID', '请选择调整的平台。');
  const selected = entries.filter(e => e.site === site && revisionIds.has(e.strategyRoundId));
  ```
- [ ] 从各平台全龄投影构建计数；诊断分别使用原成熟规则，智联不推断阅读能力；简历优化保留分平台结论。补测跨方案/候选人累计隔离、旧快照、迟到反馈、无效范围和重复提交。
- [ ] 运行`node tests/funnel_platform_feedback_smoke.js`及既有funnel_diagnosis、strategy_round_store、message_linkage、zhaopin_communication_storage检查并提交。

## Task 2: 平台对照页面与交互

Files: `src/dashboard/pages/funnel.js`, `src/dashboard/assets/roleflow.css`, `src/dashboard/server.js`, `tests/dashboard_funnel_smoke.js`, `tests/funnel_message_linkage_smoke.js`。

Interfaces: 页面接受`view=current|lifetime`；链接保留planId；策略表单platformScope与activeRevisionId提交到现有接口。

- [ ] 替换旧展示断言并先运行失败，验证当前与累计不同数值、2/5=40%早回复、零分母横线、未核验消息不混计；HTTP范围/平台验证及表单并发不回归。
  ```js
  assert.match(currentHtml, /2.*40%/);
  assert.match(lifetimeHtml, /累计记录/);
  assert.equal(invalidScope.status, 400);
  ```
- [ ] 主页面改为范围切换+平台表+一条建议，其他消息简短入口，调整表单放details；删除旧轮次、证据尺和长说明对应渲染。只有reply显示百分比，所有文本转义。
- [ ] 新增局部CSS沿用现有tokens，表格窄屏可横向滚动但页面不溢出；键盘焦点及原生表单验证保留。
- [ ] 执行真实服务+合成SQLite浏览器旅程，覆盖切换、折叠/提交平台范围和390/1280布局；不在用户DB提交策略修改。提交。

## Task 3: 验收收口与分支保存

Files: 本设计/计划、`docs/PROJECT_HANDOFF.md`, `docs/NEXT_PHASE.md`, 新验收报告。

- [ ] 一次限定只读独立复审，检查统计范围、计数分母、策略继承和用户可见信息；修复实际问题并回归。
- [ ] 核验仅拥有的8788服务身份/无运行任务，隐藏重启，真实本地页面复查两种范围与窄屏；不动安装版或外部平台。
- [ ] 冻结源码提交，运行仓库外`run-frozen-gate.ps1`获得新鲜完整`npm test`实际总数和起止SHA；不在运行中改文件。
- [ ] 更新验收记录和入口，`git diff --check`、最终针对性验证、提交文档，推送当前分支；不合并发布。
