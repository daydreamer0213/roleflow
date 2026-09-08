# 智联当前详情面板的发布公司与客户公司

> **For agentic workers:** Use `subagent-driven-development` for the single bounded implementation task. Earlier scan/review tasks are closed; do not repeat them.

**Goal:** 真实检索遇到代招岗位时，正确区分发布公司与明确标注的客户公司，继续读取同一岗位完整详情。

**Architecture:** 复用 `ZhaopinSiteAdapter` 的既有 `company/clientCompany` 字段和旧布局语义，仅修当前面板字段来源。保留发布公司身份校验；无新依赖、数据库或关联系统。

## Global Constraints

- 工作目录 `D:/DevData/RoleFlow-worktrees/zhaopin-readonly`，分支 `codex/zhaopin-readonly`。主控独占文档、真实浏览器、隔离验收服务和完整测试。实施者只做离线测试，不访问真实平台/验收库。
- 保留精确岗位编号、标题、薪资、地点、发布公司校验及后台执行、节奏、检查点、暂停/异常即停；不放宽匹配、不改用户筛选条件、不降低 JD 完整性要求、不重放接口、不激活窗口。
- 不推送、合并、打包、发布或改版本。真实回复、简历同意/拒绝/上传、投递禁止；主控后续普通招呼至多一个已授权新扫描岗位，须最终完整门禁通过。
- 无其他源码任务并行；保护主控文档及已有代码，不 reset/amend/stage-all。仅提交本任务所有权文件。
- 定向测试使用 `D:/hermes/node/node.exe`，`NODE_PATH=C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules`、`ROLEFLOW_REQUIRE_PLAYWRIGHT=1`、`TEMP=TMP=D:/DevData/RoleFlow-tests`。完整测试由主控在只读验收稳定后运行。

## 已核验事实与设计选择

- `1bc7879` 上同一新智联 run 已保存 4 岗位/4 完整 JD，随后停于 `ZHAOPIN_DETAIL_IDENTITY_UNCONFIRMED`。新检查点与自动中断页面均已实际生效。
- 最小后台只读 probe 在 22:06 UTC 确认：当前面板 `.job-detail-summary__company-name` 为明确的 `客户公司：...`；同一面板 `.job-company-info__name` 为与选中卡完全一致的发布公司。所有岗位编号、标题、薪资及兼容地点均相同，页面无加载，前台及 6 个标签不变。真实证据仅保留 D: 仓库外日志，不把真实公司/JD 写入 fixture。
- 当前 `detailState` 将两个选择器合并取第一个并把 panel.clientCompany 固定为空；旧布局已解析 `客户公司：`。根因是新布局漏用字段语义，不是网络或真正岗位不一致。
- 修复应优先保留发布公司；显式客户公司另存 `clientCompany`。有发布公司时必须严格匹配，不能因为 `clientCompany` 非空而绕过发布公司冲突。无发布公司但明确客户标记时保持既有旧布局处理。普通雇主页面语义不变。
- 注入 helper 带版本缓存，更新版本使仍打开的旧页面获得新解析；不能只在全新 fixture 上通过。

## Task 1: 当前面板公司字段兼容

**Ownership:** `src/adapters/sites/zhaopin.js`，`tests/zhaopin_readonly_smoke.js`，必要合成 `tests/fixtures/zhaopin/search-vue2.html` / `search-current.html`。不修改其他源码、存储或沟通逻辑。主控维护本计划。

- [ ] 先用真实 helper + 合成 Vue2/current 面板复现 RED：卡片发布公司 A，summary 明确客户公司 B，同面板 publisher A；读取必须成功，company=A、clientCompany=B，现版本会失败。
- [ ] 最小解析修复：复用既有显式 `^客户公司[：:]` 语义；current panel summary 与 publisher 分开读取，正常页面保持兼容。更新 helper 版本；同页已注入旧 helper 后再次读取应获得新语义。
- [ ] 回归至少覆盖：显式客户公司且 publisher=A 成功；publisher=C 与卡片 A 不同仍失败；无客户标记的公司冲突仍失败；既有旧布局客户公司测试保持通过。现有编号不一致拒绝测试继续有效，不另写大规模矩阵或生产框架。
- [ ] GREEN：`zhaopin_readonly_smoke`、`zhaopin_workflow_smoke`、`zhaopin_communication_adapter_smoke`；改动 JS 语法、`git diff --check`。自审后提交仅所有权文件，报告 RED/GREEN 命令与关键输出、确切 SHA、文件及疑点。
- [ ] 主控生成独立 diff 包并做一次任务规格/质量审查；只对实际发现做定向修复，不重开历史整分支审查。

## 主控验收

- [ ] 重启自己的隔离服务；同一现有 run 通过正常“继续本轮”恢复，检验实际代招岗位字段及继续扫描/分析，不暗改任务或重试旧 BOSS。
- [ ] 只读流程稳定后冻结源码与文档，运行最终完整检查，记录精确 SHA 与实际数量；之后才可能进行单条已授权普通招呼。
- [ ] 更新真实验收记录，停在回复发送前，明确部分通过与仍缺的实际证据。
