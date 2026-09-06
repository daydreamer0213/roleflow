# 智联只读找岗首版：实现与验收记录

状态：**开发中，尚未交付完整使用流程**。本文件逐段记录已获得的证据，未完成项不能由旧门禁推定通过。

## 范围与环境

- 用户已批准的设计：`../specs/2026-09-06-zhaopin-readonly-design.md`；实施顺序：`../plans/2026-09-06-zhaopin-readonly.md`。
- 工作树 `D:\DevData\RoleFlow-worktrees\zhaopin-readonly`，分支 `codex/zhaopin-readonly`，起点 `15dc54867921ab3f621aa14a1070f7df180a3954`。版本继续为 1.3.2，不替换安装版。
- 普通代码检查使用临时 SQLite、合成资料、假浏览器及本机 headless Edge；复用现有 D 盘依赖，没有新增运行时依赖。实际探查范围与限制在 `2026-09-06-multi-platform-discovery-research.md`。
- 没有推送、合并、打包、发布或真实投递/沟通授权；没有用用户真实数据库做开发验证。

## 开发前基线

初次完整检查停在 PDF 自检：新工作树没有可供 ESM 解析的依赖目录，单独设置 NODE_PATH 不解决 ESM 导入。将本工作树 node_modules 联接至已有 `D:\Guo\ZhiPing\node_modules` 后，直接导入和新鲜严格完整检查通过；没有修改产品或升级依赖。

在仅有设计文档改动的 `a8f93ee`，完整检查退出码 0，实际末行为 `All 144 offline checks passed.`。日志为 `D:\DevData\RoleFlow-multiplatform-research-20260906\baseline-offline-ready.log`；初次失败日志也保留。该证据不覆盖后续功能代码。

## 分段实现与复审

### 原生读取契约

`d6b5beb` 新增智联模板、岗位链接校验、同页卡片和完整 JD 读取器及脱敏 fixture。实际岗位编号取自当前详情链接，不用标题或临时卡片索引作永久身份；发布方与客户公司分列。

独立审查发现详情访问额度在点击之后申请。`a239abf` 改为动作前申请，并在等待结束后重新检查取消、标签和卡片签名；新增“额度拒绝”和“等待期间卡片变化”回归。`zhaopin_readonly_smoke`、`source_acquisition_smoke`、`inherited_search_scope_smoke` 通过；修复复审通过。

### 平台条件、数据与分析隔离

`3b74233` 实现按方案和平台分别保存原生条件；迁移 v29 为历史本轮回填 BOSS 来源，并以平台区分轮次唯一键；同一 SQLite 内 BOSS/智联浏览器租约互斥。智联继承范围和目标不经过 BOSS 城市或薪资分档映射，活跃度缺失不按 BOSS 未核实处理。可选客户公司字段参与新岗位内容与分析事实，没有该字段的旧 BOSS hash 和模型输入形状保留。

十项定向检查记录：`platform_search_context_smoke`、`zhaopin_analysis_smoke`、`zhaopin_readonly_smoke`、`inherited_search_scope_smoke`、`workflow_acquisition_smoke`、`scan_snapshot_smoke`、`scoring_url_smoke`、`screening_preferences_smoke`、`job_store_contract_smoke`、`storage_migration_smoke`。实现者报告均通过，退出码 0，只有现有 SQLite 实验性警告；独立复审结合 diff 核验，未将警告描述为无噪声输出。

复审及修复 `29fbc93`、`8ff6d01`：

- 年薪 `20-30万/年`、时薪 `150-200元/时` / `元/小时` 和天薪不再误当月薪。
- `1万-1.5万/月` 完整得到 10–15K；保留 `1.5-1.6万·13薪` 和 `10-20K·13薪`。
- 遮蔽金额不退化为部分确定值，覆盖 `10K-**K`、`**-15K`、`10K-20**K`。
- 新增实际 v28 父表结构及非空 workflow/task/analysis-attempt 的合成数据库，迁移后逐字段比较记录并检查外键；不拿历史空 attempts 场景代替数据保留验证。

最后一轮修复的三项薪资/资格相关检查通过；主控随后也实际重跑 `zhaopin_analysis_smoke`、`scoring_url_smoke`、`screening_preferences_smoke`，退出码 0。两轮 scoped 复审后没有剩余重要问题。运行链路中的调用方平台隔离、严格条件保存和不进入沟通/漏斗仍需在后续集成验收中验证。

### 实际运行与页面

`9048a7c` 已接入现有工作流、CLI、扫描检查点、恢复及分析；经 `d97f4f0` 修复后独立复审通过，尚不能当作完整产品交付。运行来源和原生条件随本轮冻结，扫描与分析使用同一实际来源；智联不使用 BOSS 沟通库存或成功数量规划，只读目标全部完成且分析队列清空后结束。尚有未完成目标时，即使当前分析队列为空，也保留继续入口。

同一小详情额度的恢复曾实际复现重复前缀，保存数量仍为 1 而不是预期的 2。修复复用既有完整详情缓存：现场核对真实岗位编号和完整内容后，未变化的结果记录为复用；新岗位或 JD/客户公司变化消耗新的 JD 额度。每次实际核验仍在动作前申请站点访问额度并计入节奏，达到新 JD 额度后不再访问下一岗。真实文件 SQLite 关闭重开、相同冻结额度的回归已得到保存数量 1→2→3，并验证复用访问次数；没有新建签名到岗位编号的猜测表。

同时补齐方案重检查保留客户公司、不同来源原生条件不串用、查询先按来源筛选再限制数量、智联自己的风险冷却，以及 BOSS 库存不回写智联运行。旧 Dashboard 回归曾发现 BOSS 启动就绪检查顺序改变；恢复实际调用顺序后原测试通过，没有更改旧预期。

实现者在该代码上报告十项最终定向检查退出码 0：`zhaopin_workflow_smoke`、`communication_runtime_smoke`、`workflow_inventory_smoke`、`workflow_control_smoke`、`workflow_recovery_smoke`、`dashboard_runtime_smoke`、`workflow_acquisition_smoke`、`workflow_end_to_end_smoke`、`scan_end_to_end_recovery_smoke`、`communication_cli_authority_smoke`。新检查走真实 CLI/HTTP/SQLite、假平台和测试模型；这不是实站或真实模型端到端证明。主控早先实际运行过新工作流检查，但那次运行不覆盖最后几处修复，不替代最终门禁。

运行链路独立复审发现一项重要缺口：CLI 已按智联读取共享节奏，但 `checkpointSharedPacing` 仍只保存 BOSS，因此同批次恢复正常，新一轮却丢失累计节奏。`d97f4f0` 补齐明确支持站点的实际来源写入。新增真实 SQLite/CLI 回归先保存 15 次累计状态，再启动独立新批次读取 3 岗，验证累计为 18，在第 16 次请求既有 90 秒阶段冷却（测试替身不实际等待），下一阈值为 32，BOSS 状态及时间戳不变；修复前实际失败是 `3 !== 18`。

修复后的 `zhaopin_workflow_smoke`、`boss_safe_pacing_smoke`、`site_access_usage_smoke`、`scan_store_contract_smoke` 均退出 0；限定修复范围的独立复审确认已解决且无新重要问题。沿用旧节奏实现的控制台日志前缀仍是 `[boss]`，实际访问和存储来源为智联；这不是 BOSS 外部访问证据。

待完成：今日任务平台入口、条件保存、来源结果、共享状态栏、本地报告来源及服务端沟通/漏斗边界；完整本地页面用户流程验收。

## 最终门禁与未验证前提

- 最终完整 `npm test`：尚未运行。
- 新平台本地用户流程与桌面截图：尚未完成。
- 全分支审查与精确最终 SHA 验证：尚未完成。
- 真实智联产品端到端、真实模型质量、长期平台稳定性和真实投递/消息：未验证；实时 DOM 探查不能替代这些结果。
- 未访问真实 BOSS；没有向招聘方发送、投递、同意或拒绝简历操作。临时探查页已按证据回执关闭，用户原有页保留。
