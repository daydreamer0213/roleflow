# 智联省略标题读取兼容

> For agentic workers: use subagent-driven-development for one bounded implementation and one incremental task review. Earlier company/district/short-JD reviews remain closed.

**Goal:** 长岗位名被卡片省略显示时，读取同一标题节点已经提供的完整无障碍名称，正常核对完整岗位身份。

**Architecture:** 在既有页面helper内增加一个小型 `cardTitle`，供卡片字段与签名共同使用；先单独查询 `.vue-clamp__text`，不存在才回退 `.job-card__title-main`，不能使用逗号选择器让外层容器抢先。有可见标题时优先同节点 `aria-label`，无完整名称则保留可见文字，无可见文字仍为空。不借用详情标题或组件payload补写标题，不做前缀/模糊匹配。原组件编号绑定与详情严格比较不变，注入版本升级。

**Tech Stack:** 现有 Node/CommonJS、Playwright合成页面和假浏览器，无依赖变化。

## 执行结果（2026-09-09 03:36 UTC）

- [x] 真实嵌套fixture先得完整标题/sourceId行为RED；初次版本号RED和提交后退化验证分别记录，不篡改证据。
- [x] 内层span优先、外层fallback，helper8，标题与签名共用；空可见标题/不一致/旧快照反例覆盖。
- [x] 2b345f0三项定向GREEN、两个语法及diff检查；唯一限定复审两finding关闭，无新问题。
- [x] 主控03:35在已经选中的原失败页面使用同一adapter只读验证通过，精确编号和完整标题一致，921字符JD；6标签/原活动页不变。
- [ ] 正常UI恢复同一run并完成后续采集/分析。
- [ ] 冻结最终SHA后新鲜完整npm test。普通招呼另需当前目标图与即时身份验证；截图缺口未解决，不执行。

以下保留原任务步骤和示例，执行状态以上列结果为准。

## Global Constraints

- Worktree `D:/DevData/RoleFlow-worktrees/zhaopin-readonly` / `codex/zhaopin-readonly`；非main，保护主控文档，不reset/amend/stage-all。只改下述两文件。真实浏览器、隔离服务、文档、最终完整门禁由主控独占。实施者不访问真实账号、真实简历或验收数据库，不推送/合并/打包/发布/改版本。
- 既有四编号、公司、薪资、地点、非loading检查不变；卡片编号仍必须与组件name/company绑定一致。120字符及质量标签门槛、目标覆盖、预算、节奏、检查点、真正异常停止不变。完整标题不得通过删除省略号做前缀匹配，不从详情或组件name兜底；空可见文字即使保留aria-label仍为空，避免加载/陈旧标签伪装可读。
- 使用 `D:/hermes/node/node.exe`；NODE_PATH=`C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules`，ROLEFLOW_REQUIRE_PLAYWRIGHT=1，TEMP=TMP=`D:/DevData/RoleFlow-tests`，PATH前置`D:/hermes/node`。实施者仅指定定向检查一次最终GREEN，主控唯一最终 `npm test`；保留并报告既有SQLite实验/CRLF提示。

## 已证实的问题与选型

同一run实际保存62岗位/61完整JD后中断。当前非loading，详情四编号完整确认；卡片显示含省略号的短标题，但同一 `.vue-clamp__text` 的 `aria-label` 与组件name、详情全文完全相同，其他身份字段一致。旧helper使用textContent，既导致card sourceId因name不等而丢失，又导致严格标题比较失败。不是网络慢、真实错岗或以前公司/新区问题复发。真实标题/公司/编号只保留仓库外，测试使用合成字段。

推荐使用页面已有完整无障碍名称：保留独立DOM事实且不改变身份契约。直接用组件name会绕过既有可见标题核对；允许截断前缀匹配会接受错误完整岗位，均不采用。无新业务方向或外部写权限需求，属于已批准真实验收的必要适配。

`ac5647edb03e9ed35e269fa2ab796f8b934accda` 刚完成新鲜严格全测157/157、退出0、起止SHA相同且树干净；不覆盖本计划后续代码。隔离8788主控核验后已停止，真实扫描/lease已结束，桥接保留。最终全测和真实完整分析/至多一条普通招呼仍待完成；当前后台截图失败已记录，不得抢前台或替换成旧岗位图片。

## Task 1: 同一标题节点的完整名称参与读取与签名

**Ownership:** `src/adapters/sites/zhaopin.js`、`tests/zhaopin_readonly_smoke.js` only。你不是唯一开发者；主控正在维护文档，不得覆盖其改动。

**Interfaces:** 既有 `ZHAOPIN_PAGE_HELPERS_EXPRESSION`、`__zhaopinReadSearchState`、`__zhaopinActivateCard` 对外接口不变。共享title字符串用于卡片sourceId绑定及签名。`detailMatches` 严格比较不改。

- [ ] RED：在既有Vue2合成页面覆盖带省略号可见文字与完整aria-label；组件name与详情标题设为相同合成完整名称。真实helper/readVisiblePaneDetail应输出完整title、可信card sourceId并读出详情。旧代码应在完整title/sourceId断言失败。测试只修改合成DOM，不新增真实站点fixture。

```js
title.textContent = '合成智能应用工程师（Python…';
title.setAttribute('aria-label', '合成智能应用工程师（Python与视觉方向）');
// Set the existing synthetic card component name and detail title to the same full value.
assert.equal(state.cards[0].title, '合成智能应用工程师（Python与视觉方向）');
assert.equal(state.cards[0].sourceId, 'CCSYNTHV2A1J00000000001');
assert.ok(await adapter.readVisiblePaneDetail('ZHAOPIN-SEARCH', state.cards[0]));
```

- [ ] 最小实现：两个原title读取点复用下列helper。初次实现1c46a71使用逗号选择器且版本7；实际原页复验因外层容器优先仍失败。修正单独查询次序，并将注入缓存版本7→8（定义及stamp），对应旧helper升级回归改为7→8。原签名的其他字段保留。

```js
const cardTitle = (card) => {
  const node = card.querySelector('.vue-clamp__text') || card.querySelector('.job-card__title-main');
  const displayed = clean(node?.textContent);
  return displayed ? clean(node?.getAttribute('aria-label')) || displayed : '';
};
```

- [ ] 最小反例：无aria-label的普通完整文字仍沿用现有通过样例；空可见标题但残留完整aria-label必须拒绝；aria-label完整标题与组件/详情不符仍拒绝；保持显示短字不变、只改完整aria-label会使签名改变，旧card快照不能继续操作。用现有调用记录确认拒绝发生在点击前。原编号/公司/地点冲突与加载回归保留，不扩展大矩阵。
- [ ] 现场层级回归：合成DOM必须按实际结构将 `.vue-clamp__text[aria-label]` 放在 `.job-card__title-main` 内。先只增加这一嵌套结构、仍保持版本7断言，运行readonly，确认RED在完整标题/sourceId而非版本号；再改选择次序与版本8及对应升级断言，运行GREEN。最初“6 !== 7”的失败只是版本验证，提交后退化检查另有记录，不改写为早期行为TDD。
- [ ] GREEN：一次最终 `zhaopin_readonly_smoke`、`zhaopin_workflow_smoke`、`zhaopin_communication_adapter_smoke`，两个JS语法和 `git diff --check`。仅提交拥有文件。完整报告写task-1-report.md，包含实际RED/GREEN命令/关键输出、最终SHA、文件、自审/疑点。勿重复提交后同一套检查或跑全套。
- [ ] 主控增量规格/质量复核后，在当前原失败页面只读验证同一adapter读出正确完整标题/精确编号，再用正常UI继续同一run。最终SHA重新验证后才考虑已授权至多一条普通招呼；本计划不授权回复、简历或投递。
