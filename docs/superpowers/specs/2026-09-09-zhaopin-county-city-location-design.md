# 智联县级市地点后缀兼容

2026-09-09 的真实原轮在第42张卡片中断，已保存110岗位/108完整/2短JD待补。当前唯一选中卡片与详情编号、标题、公司、薪资完全一致，正文790字符且ready；卡片“苏州 昆山 花桥”，详情原生“苏州·昆山市”。只读证据在 D:/DevData/RoleFlow-zhaopin-message-context-20260908/county-city-location-20260909.json，未刷新/点击/切换前台。

根因：已有 sameLocation 对第二层行政区名称去“新区、区、县”，遗漏县级市的“市”，导致同岗位同地点误停。最小修复只补第二层名称的“市”后缀，不做城市字典，不硬编码真实地名，不改变编号门槛或读取流程。直接忽略地点会吞掉真实冲突，保持现状会误停，故补齐同一类后缀规则。

既有城市级详略任务已关闭；79c2f047239364a630230a3487520e7944d7b33f 严格157/157、退出0、起止一致且干净只认证此前源码。本增量先用现有合成fixture得到实际行为RED，再补单一后缀、定向GREEN和限定复审，主控真实原岗位只读验证及继续原轮。用户已要求持续按推荐细节推进，不另设方向确认。

## Binding Constraints

- Work only in D:/DevData/RoleFlow-worktrees/zhaopin-readonly on codex/zhaopin-readonly. You are not alone; preserve others' edits.
- Worker owns only src/adapters/sites/zhaopin.js (district suffix in sameLocation) and tests/zhaopin_readonly_smoke.js (existing synthetic Vue2 behavior). No other product files.
- Preserve existing exactComponentIdentity gate and every title/company/salary/URL/selected-card check, same-city/different-district rejection, raw detail location, JD quality/coverage, unique-job targets, budgets, pacing/cooldowns, checkpoints and scan-only recovery.
- No worker real browser/site/service/database/model access; no foreground, new retry/action, dependencies, helper/protocol/UI refactor, version change, push, merge, package, release or deletion. Main owns docs/live/final gate.
- Use existing fixtures and installed Node D:/hermes/node/node.exe; NODE_PATH=C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules; ROLEFLOW_REQUIRE_PLAYWRIGHT=1; TEMP=TMP=D:/DevData/RoleFlow-tests. No full npm test by worker.
