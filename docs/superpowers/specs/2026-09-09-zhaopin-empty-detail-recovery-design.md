# 智联已选中空详情：后台单次恢复

## 已批准方向与证据

用户要求持续推进，途中意见不意味着暂停。完整详情直接读取，真正加载继续等待；确认请求已停止却为空时，后台正常点击同一岗位一次，再核验结果。这不是沟通/发送重试。

当前代码离线复现：已选中空卡片零点击、等待120秒超时；未选中相同输入会点击并读取。实站另有原生客户端3秒超时后 jobDetailLoading=false、jobDetail=null 的证据。用户手动点开的另一岗位可读，不证明原失败岗位未点击。现场证据：D:/DevData/RoleFlow-zhaopin-message-context-20260908/checkpoint-20260909-layout-review.md。

整页裁切已在清除诊断临时显示覆盖后由用户确认恢复。本任务不增加截图、显示覆盖或前台恢复。

## 最小设计

只延长等待不能恢复已停止的请求；无条件重复点击会干扰加载或变更后的目标。采用可验证站点状态和一次原生重激活，沿用随机节奏与额度。

从可靠 JobCard 对应 Vue store 仅读 selectedJobId、jobDetailLoading、jobDetail，要求选中编号等于卡片公开标题/公司验证后的 sourceId。新增 detailRequestState=loading/empty/ready/unknown。缺字段、不同编号或缺可靠卡片编号为 unknown。empty 要求原生 jobDetail 明确 null、loading 明确 false，且 DOM title/description/url 均空，无可见加载器。未知/部分/冲突内容绝不授权重激活。

scan 显式选择将搜索条件就绪与详情就绪分开：关键词、筛选、可靠选中卡片一致，已知原生 loading/empty 可交给120秒详情读取，不先误报3.6秒筛选恢复失败。其他调用默认契约不变。

readVisiblePaneDetail 增加可选第五参数 beforeEmptyRetry，scan 提供节奏回调，沟通调用不提供。未选中沿用正常激活；已选中完整则读取；真加载等待。确认目标仍为 empty 才至多一次重激活：结束前次尝试节奏记录，等待现有 pane_detail_read 间隔与冷却，重新核验，预留额外物理访问，再核验，调用内再核验后才 card.click()。迟到有效详情直接读取；新加载等待；目标/范围变化立即停。

一次重激活后留一个正常短采样间隔，让原生加载标记生效；仍停止且空则准确报告详情未加载、保留进度，不能再点。全调用真加载期限仍最多120000ms。失败尝试也计入物理额度与节奏检查点；逻辑岗位/JD预算不重复扣除。保留原有质量、覆盖和同批次去重。

## Global Constraints

- Work only in D:/DevData/RoleFlow-worktrees/zhaopin-readonly on codex/zhaopin-readonly; preserve unrelated edits.
- Background only: no Page.bringToFront, tab/window activation, page refresh, screenshot/viewport mutation, private API replay, reply send, resume consent/refusal, application, push, merge, release or version change.
- Recovery is scan-only and limited to one same-card reactivation per readVisiblePaneDetail call; existing communication preparation/dispatch gets no new retry.
- Retain exact current card/index/signature/source identity, keyword/filter scope, abort/risk/login/page/lease checks, physical access accounting, random pacing, detail cooldown/checkpoints and complete-JD quality/coverage.
- Keep the 120000ms maximum genuine-loading wait and fast non-loading identity rejection; unknown/partial/conflicting detail is never evidence permitting reactivation.
- Use existing Node/CommonJS, browser adapter, BossSiteAdapter pacing and tests; no new dependencies, generic retry framework, settings or UI.
- All worker validation is offline with synthetic fixtures, fake browser and temporary databases on D:; main alone owns live browser, service and final strict full gate.
- The user has approved the direction and delegated implementation details; continue without repeated user approval. Report genuine scope/authority problems to main.

## 验证

既有合成 DOM/helper 和 fake-browser 测试先 RED，再 GREEN：已选中空恢复、切卡请求失败恢复、一次后仍空停止、加载不重击、迟到有效/目标改变/暂停/额度拒绝不重击、首卡空不误报筛选失败、失败与成功尝试计费且逻辑岗位只一条。限定独立审查，之后主控冻结源码跑完整离线门禁、正常UI后台继续同一实站run。不重开已关闭历史审查；离线通过不等于实站全流程通过。

