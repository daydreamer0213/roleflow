# 智联详情慢加载等待与明确中断提示

> For agentic workers: use subagent-driven-development for this one bounded task and a scoped review. Previously closed title/company/district/short-JD reviews remain closed.

**Goal:** 真正等待同一已点击岗位的详情，不把短暂空白误报为身份问题；长期空白明确说明详情未加载，保留本轮进度。

**Architecture:** 只调整既有详情等待循环，沿用智联消息路径的120秒期限与500ms轮询方式。无需共享等待框架或新依赖；非加载身份不匹配保持既有短窗口，风险/页面丢失/暂停即时退出。只读一次点击后持续观察，不重点击、刷新或重发网络请求。

**Tech Stack:** 现有Node/CommonJS、假浏览器和合成DOM、可注入时钟。

## 执行结果（2026-09-09 04:16 UTC）

- [x] 5秒慢加载实际行为RED；最小deadline实现；4项指定GREEN、3语法和diff检查。
- [x] c6399c4限定复审PASS/APPROVED，无Critical/Important/Minor；主控已核对未改动的身份/质量/覆盖/预算边界。
- [x] 正常UI“继续本轮”只点击一次，真实同一run恢复scanning，6标签/原活动页不变。
- [ ] 验证真实详情恢复、后续扫描/分析及最终冻结SHA完整npm test；不以当前恢复动作代替完整通过。

以下为已执行的原任务步骤；状态以上列结果为准。

## Global Constraints

- Worktree `D:/DevData/RoleFlow-worktrees/zhaopin-readonly`，分支 `codex/zhaopin-readonly`；保护他人改动。主控唯一拥有真实浏览器/服务/验收数据库/最终全测/文档；实施者不访问真实账号、简历或站点。不推送、合并、打包、发布、改版本。
- 四编号/标题/公司/薪资/地点核对、120字符质量门槛、短JD待补、覆盖、预算、计费、随机节奏、checkpoint、风险/身份/页面丢失即停不变。不得自动重点击或重发请求；迟到旧详情不得成为当前岗位。外部招呼/回复/简历/申请均不属于本修复。
- 使用 `D:/hermes/node/node.exe`；NODE_PATH=`C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules`，ROLEFLOW_REQUIRE_PLAYWRIGHT=1，TEMP=TMP=`D:/DevData/RoleFlow-tests`，PATH前置`D:/hermes/node`。测试假时钟，不实际等待120秒。保留SQLite/CRLF既有提示。

## 证据与取舍

03:39正常UI恢复同一run后第二卡详情始终空白，约3.35秒即中断。当前六次采样、五次120ms等待仅600ms显式等待；所有DOM/绑定往返增加耗时。搜索render scope覆盖整个目标，无提早释放证据。03:41、03:42只读仍空；03:43现有scope内额外20秒仅读仍空。页面无可见loader，helper把缺标题/正文/链接也视作loading；不得宣称HTTP状态0证明网络错误，也不得保证延长等待修复本次平台空白。

推荐只延长加载/空白等待并区分超时原因；维持当前六次会误停慢网，自动刷新/重点击则扩大外部访问且并不保证成功。用户已委托本阶段实现细节，不存在新增业务选择。旧全测1690622由主控在新缺陷确认后Ctrl-C取消，退出1、不完整、非断言失败；最终完整门禁在新修复与只读验证稳定后重跑。

## Task 1: 有期限的详情等待

**Ownership:** `src/adapters/sites/zhaopin.js`、`tests/zhaopin_readonly_smoke.js`、`tests/zhaopin_workflow_smoke.js` only。你不是唯一开发者；不得覆盖主控文档或其他变更。

**Interfaces:** `readVisiblePaneDetail(tabId, card, signal, assertTabBindings)`接口不变，可信完整详情返回值不变。构造器新增`nowFn = Date.now`，保存为独立的`detailNow`（避免沟通子类自有this.now耦合）；120000ms为本等待固定上限。`waitWithChecks(signal, assertTabBindings, delayMs = 120)`复用检查/可取消睡眠，原搜索恢复调用行为不变。不新增公开配置界面。

- [ ] RED：在既有合成浏览器/假clock覆盖第二卡需要超过原6次读取才就绪。使用`nowFn: () => clock`，`sleepFn: async ms => { clock += ms; ...在clock >= 5000后安装该卡原本应有的完整详情... }`；修改前应返回null/抛旧身份错误，而非测试语法或时钟配置失败。确认第一次卡片checkpoint仍保存、第二卡只激活/计费一次。
- [ ] 最小实现：点击前现有检查不动；点击后建立deadline，加载期间按最多500ms观察，非loading失败仍用原120ms且最多6次连续未确认采样。完整字段必须通过原detailMatches及URL变化检查；不因等待放松身份。

```js
const deadline = this.detailNow() + 120000;
let unconfirmedSamples = 0;
while (true) {
  // existing abort/binding/read-state checks and full matching success branch
  if (state.loading) unconfirmedSamples = 0;
  else if (++unconfirmedSamples >= 6) return null;
  const remaining = deadline - this.detailNow();
  if (remaining <= 0) {
    if (state.loading) throw zhaopinError('ZHAOPIN_DETAIL_LOAD_TIMEOUT',
      '智联岗位详情未加载完成，本轮进度已保留。请稍后确认智联详情能正常显示，再点击“继续本轮”。');
    return null;
  }
  await this.waitWithChecks(signal, assertTabBindings, Math.min(state.loading ? 500 : 120, remaining));
}
```

- [ ] 增加最小反例：长期空白至120秒返回上述明确错误、partial保留第一岗且不进入第三岗；已加载但真实身份冲突仍快速拒绝；等待期间暂停/风险/绑定丢失均立即退出并由现有finally释放scope，不重复点击或计费。更新原“永远loading/取消”旧假睡眠，避免测试真实空转120秒。真实字段不进入fixture。只验证行为，不增加文案/源文本测试。
- [ ] 一次最终GREEN：`zhaopin_readonly_smoke`、`zhaopin_workflow_smoke`、`zhaopin_communication_adapter_smoke`、`workflow_scan_analysis_smoke`；修改JS语法及diff检查。逐步失败即停。仅提交拥有文件，不重复提交后同套GREEN、不跑完整npm test。
- [ ] 报告task-1-report.md含实际RED/GREEN命令/关键输出、SHA、文件、自审疑点。主控唯一限定规格/质量复核后，只读验证与最终完整门禁；不以单测代替真实整轮或平台加载成功。
