# 智联同岗位地点详略兼容

用户已要求按推荐方案持续修复、后台验收，不因已确定的实现细节再次停下确认。

## 事实与根因

2026-09-09 08:13 UTC，同一真实验收 run 在第 19 张卡片中断，已保存 94 岗位、93 完整 JD、1 旧短 JD。08:15 和 08:26 的最小只读 DOM 复核确认：已选中唯一卡片，详情请求 ready，271 字符正文，卡片/详情/链接编号一致；卡片地点为“郑州 石佛”，详情原生标签只写“郑州”，没有隐藏完整地点。不是未点击、仍加载或重复卡片。现场证据留在 D:/DevData/RoleFlow-zhaopin-message-context-20260908/city-only-detail-20260909.json，不提交真实 JD/简历。

sameLocation 已在编号完整确认时兼容区县后缀和商圈，但要求两侧至少都有城市、区县两段，因而把更简略的同城地点误判为冲突。

## 最小方案

保留原有严格比较和所有岗位身份检查。仅在既有 exactComponentIdentity 成立时，以现有分隔符解析非空城市并去末尾“市”：同城且任意一侧只有城市时视为详略不同；两侧都有区县时沿用原区县比较。返回的地点仍为详情原文，不从卡片补造字段。

继续严格字符串会重复误停；完全忽略地点会吞掉明确冲突；本方案只处理已证实的精度差异。无字典、新依赖、新重试、前台恢复或质量/覆盖缩减。

## 验证与范围

仅改 zhaopin.js 的 sameLocation 与现有 readonly 行为回归。先证明合成“城市＋商圈 / 城市”案例在旧实现失败，再验证双向同城成功、不同城市/明确区县冲突/空地点/编号缺失或冲突失败，且保留详情原文。定向只读、工作流、沟通 adapter 回归与限定复审后，由主控冻结干净 SHA 跑完整检查，恢复原 run，不新建或缩减目标。前一 SHA 1f6a8dd4c9ff43e48cdbe8f80c1fb70a17976df4 的严格 157/157、退出 0、起止一致且干净，只认证本次修复前代码。

## Binding Global Constraints

- Work only in D:/DevData/RoleFlow-worktrees/zhaopin-readonly on codex/zhaopin-readonly; you are not alone, preserve others' edits.
- No worker real browser/site/service/database/model access, no foreground, screenshots, viewport changes, platform refresh, communication, application or resume actions.
- Broader location compatibility requires existing exactComponentIdentity: fully confirmed detail IDs plus a supplied reliable current card ID equal to detail ID. Preserve every title/company/salary/URL/selected-card guard.
- Accept nonempty same-city city-only versus finer location, symmetrically, using existing separator and terminal 市 normalization. If both specify a district, keep existing district comparison; cross-city, explicit district conflict, empty location and unreliable/mismatched IDs remain rejected.
- Preserve original detail.location text, full JD quality/coverage, unique-job targets, physical access budgets, pacing/cooldowns, checkpoints and scan-only one empty-detail recovery. No new click or retry behavior.
- Reuse existing sameLocation and synthetic Vue2 fixture. No city dictionary, hardcoded real city/business area, new dependency, interface/UI/helper-protocol change, unrelated refactor, version change, push, merge, package, release or deletion.
- Main owns docs, live acceptance and final strict full gate; worker owns only source/test below and focused offline tests, with generated files on D:.
