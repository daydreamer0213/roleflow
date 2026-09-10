# 消息机会判断原因验收

## 用户变化与根因

消息页的“不建议优先投入时间”现在附上已保存的具体地点、薪资等筛选原因。简历匹配与工作安排分开；地点或薪资排除不再被显示为能力匹配低。没有具体依据时提示核对，不用当前方案反推历史门槛，也不编造简历事实。下线岗位继续优先说明已下线。

根因有三处：规则解释只映射应届/在校/实习/兼职，遗漏地点和薪资；消息投影优先取通用规则句，掩盖具体依据；可信岗位上下文和持久草稿恢复漏传风险理由。修复复用 `match_explainer`，未改筛选边界、二维表、推荐等级或模型调用。实际验收额外发现 `roleGaps` 的内部编号，不作为用户可读缺口，改用已保存的 `softGaps`。

改动为六个生产文件：`src/core/{match_explainer,job_analysis,message_discovery,candidate_progress}.js` 和 `src/dashboard/{message_discovery_controller,message_discovery_view}.js`；四个既有测试文件增加回归。无新依赖、数据库迁移或用户数据修改。

## 验证

- 新分析解释、旧泛化分析、BOSS 持久草稿恢复、同一可信观察记录风险传递，四处先实际失败再修复通过。
- 20 项关联离线检查通过：message_discovery、semantic_pipeline、dashboard_message_discovery、candidate_progress_storage、zhaopin_message_discovery、message_discovery_job_context、zhaopin_message_job_context、dashboard_unified_messages_journey、dashboard_message_reply_send、message_reply_learning、message_learning_store、matching_card、scoring_url、job_eligibility、screening_preferences、zhaopin_analysis、analysis_application、workflow_scan_analysis、incoming_contacts、funnel_message_linkage（除 journey 外均为 `_smoke`）。浏览器检查启用严格 Playwright，不允许静默跳过。
- 现有 8788 本地消息页：三条已有联系在 1440/390 宽度均通过，只允许 GET 本机请求。两条显示具体工作地点；另一条保留职位下线说明。没有内部缺口编号、页面错误或横向溢出，没有默认勾选发送。
- 草稿、进度事件、求职体检记录、发送项、回答记忆前后摘要一致。
- 最后两处复核修复后，20 项检查从头再次全通过；现有页面也重新验收通过。本地证据（包含私人岗位，不入库）：`D:/DevData/RoleFlow-zhaopin-message-context-20260908/opportunity-reason-visual/2026-09-10T08-47-38-658Z/receipt.json`。拥有的空闲 8788 服务更新为 PID 22628；后续需重新识别，不固定复用 PID。

本次尚未重跑完整 160 项门禁，旧全测不作为本增量的验证。薪资冲突以合成样本验证；当前对应真实旧岗位已下线，不能声称在真实页面看到了在招薪资冲突。无招聘平台访问、发送、简历操作；不合并、打包、发布或改版本。

## 独立复核

两项 Important 均已复现、补失败回归、修复并独立复验关闭：BOSS 后续失败分析不得覆盖草稿同计划的可信观察；历史 blocker 只有经现有 `decisionHardBlockers` 证实才展示为明确缺口。最终结论 Critical 0 / Important 0 / Minor 0。

最终提交和推送回执保存到仓库外 `D:/DevData/RoleFlow-zhaopin-message-context-20260908/opportunity-reason-push-receipt.json`，不在提交内自报自身 SHA。下一步用户刷新现有消息页验收表述；保持仅开发分支保存。
