# RoleFlow - 简历驱动岗位筛选与投递助手

## 日常启动

- 首次使用双击 `Install.bat`：检测 Node/Edge、安装项目内依赖、启动项目专用 Edge 和本地工作台。
- 日常使用双击 `Start.bat`：打开 `http://127.0.0.1:8787/`，按“上传简历 → 确认画像与 Search Plan → 扫描 → 今日决策队列”操作。
- 绿色包双击 `BuildRelease.bat` 生成 `dist\RoleFlow-portable.zip`；发布内容与隐私边界见 `docs\release_boundary.md`。
- 页面报错时记录错误编号，在工作台“诊断”页或 `docs\operations.md` 查看脱敏日志与排错步骤。

## 当前主流程：简历驱动筛选

启动操作台：

```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1 dashboard --port 8787
```

打开 `http://127.0.0.1:8787/` 后，先完成模型配置：选择预设厂商、模型并填写 API Key；随后上传 TXT / MD / DOCX / PDF 简历、确认系统生成的候选人画像与 Search Plan、启动已确认方案的 BOSS 扫描、在岗位操作台标记已投/跳过/跟进。扫描会先跨关键词汇总去重，再按 A/B/C 优先级分配列表与详情读取额度。

每个 Search Plan 都保存独立的城市、薪资、经验、BOSS 活跃度、关键词、排除项和扫描规模。岗位批次与投递状态会关联到对应方案，避免不同简历或方向混在一起。

首次打开会直接进入“配置模型”。选择 DeepSeek、通义千问或 OpenAI 预设后，基础地址与模型列表会自动带入，只需粘贴 API Key；未完成配置不能进入简历解析。离线 `mock` 仅保留给开发和演示。Key 使用 Windows 当前用户的 DPAPI 加密保存在 `.runtime`，不写入配置文件、日志或发布包；简历与投递数据仍保留在本地 SQLite。

命令行也可以直接创建画像：

```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1 profile-create --resume "D:\resume.docx"
powershell -ExecutionPolicy Bypass -File .\scripts\scan-portable.ps1 -PlanId 1
```

首次安装会把 PDF 解析依赖装入项目内的 `node_modules`，npm 缓存写入 `.runtime\npm-cache`，不会占用系统盘缓存。

## 本地投递操作台

启动：

```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1 dashboard --port 8787
```

打开 `http://127.0.0.1:8787/` 后，可以在浏览器里给岗位标记 `已投`、`跳过`、`无回复/待跟进`，并填写可选 note / reason。操作台只写本地 `data/jobs.sqlite` 的投递状态记录，不会自动点击 BOSS，不会自动投递，也不会自动发送招呼语。

静态 Markdown / HTML 报告仍然保留；操作按钮只在本地 dashboard 服务里可用。

## 产品方向

本项目的目标不是单纯搜索 AI 岗位，而是做“简历驱动的投递决策助手”：用 LLM 负责简历拆解、JD 语义理解、JD-简历匹配和沟通生成，规则层只负责城市、薪资、年限、活跃度、重复投递等硬边界。

权威设计文档：

- `docs/product_spec.md`：产品定位、分层架构、阶段计划。
- `docs/llm_contracts.md`：未来接入 OpenAI / DeepSeek / 通义 / 本地模型时的输入输出契约。

## 第 1 阶段：画像与匹配边界

当前阶段保留可运行的最小骨架：`profiles/example_profile.json` 是匿名候选人画像，`profiles/example_resume_versions.json` 是简历版本示例，`src/core/keyword_planner.js` 生成基础搜索词计划，`src/core/match_explainer.js` 预留 LLM 分析层的 rule/mock 边界。真实简历画像、简历版本和投递数据只保存在本地，不会进入 Git 仓库或绿色包。

产品架构上，规则层只负责硬边界：城市、薪资、经验年限、明显岗位类型排除、BOSS 活跃度、重复/已投/已跳过。通用投递筛选助手的核心能力应在 LLM 分析层：简历拆解、JD 语义理解、JD-简历匹配、风险追问、推荐简历版本、主推项目和沟通生成。

第 1 阶段不接 OpenAI / DeepSeek / 通义，不需要 API key，也不新增依赖。后续产品架构重新定义后，可以把 `match_explainer.js` 的 `rule-mock` 替换为真实模型 adapter。

## 第 2 阶段：模型 Adapter 与结构化 LLM 边界

当前默认模型配置在 `configs/model.json`，默认 `provider` 是 `mock`，因此 `check` 和离线 sample scan 不会联网，也不需要 API key。

模型边界位于：

- `src/adapters/models/mock.js`：离线稳定输出，字段对齐 `docs/llm_contracts.md`。
- `src/adapters/models/openai_compatible.js`：OpenAI-compatible `/chat/completions` 边界，使用 Node 22 内置 `fetch`，不引入依赖。
- `src/core/llm_analyzer.js`：统一暴露 `analyzeResume`、`understandJob`、`matchJob`、`draftCommunication`。

接入真实模型请使用网页“模型设置”：DeepSeek、通义千问和 OpenAI 已提供基础地址与常用模型预设，也可以选择自定义 OpenAI-compatible 接口。API Key 仅保存在当前 Windows 用户可解密的 `.runtime/secrets` 密文中；不写入 `configs/model.json`、日志或发布包。原有环境变量配置仍可作为兼容兜底。

本项目是一个本地岗位筛选工作流，用来降低每天刷 BOSS 岗位的心智消耗。

核心流程：

1. 按关键词打开 BOSS 广州岗位列表。
2. 读取岗位卡片，必要时滚动补充更多岗位。
3. 做本地评分、风险识别、去重和排序。
4. 读取少量高分岗位详情。
5. 生成 Markdown / HTML 报告，用户逐个打开链接后人工确认是否投递。

安全边界：

- 只读取岗位信息。
- 不自动点击“立即沟通”。
- 不自动发送招呼语。
- 不自动修改 BOSS 账号状态。
- 投递、跳过、HR 状态变更都由用户人工确认。

## 推荐：绿色便携模式

绿色模式不依赖 Codex，也不需要安装浏览器插件。它会启动一个项目专用 Edge profile：

```text
<项目目录>\.runtime\edge-profile
```

第一次使用时，在弹出的专用 Edge 窗口里登录一次 BOSS。之后登录态会保存在 `.runtime\edge-profile` 里。

### 普通用户安装

双击：

```text
Install.bat
```

它会自动完成：

- 检测 Node.js 22+。
- 如果没有 Node，则下载 Node 便携版到 `.runtime\node`。
- 检测 Microsoft Edge。
- 跑项目自检。
- 启动项目专用 Edge。

不会做的事：

- 不修改系统 PATH。
- 不安装浏览器插件。
- 不自动登录 BOSS。
- 不把大依赖放到 C 盘项目外目录。

如果想提前把 Node 打进绿色包：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -InstallPortableNode
```

这个命令会把 Node 下载到：

```text
<项目目录>\.runtime\node
```

发给另一台自己的电脑时，可以带 `.runtime\node`，不要带 `.runtime\edge-profile`。

### 日常使用

启动专用 Edge：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-portable-edge.ps1
```

扫描 BOSS：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\scan-portable.ps1 -Keywords "AI应用开发" -MaxCards 60 -DetailLimit 5
```

多个关键词：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\scan-portable.ps1 -Keywords "AI应用开发,RAG工程师,Python AI后端" -MaxCards 100 -DetailLimit 8 -MaxDetailTotal 200
```

绿色模式依赖：

- Windows。
- Microsoft Edge。
- Node.js 22+；没有的话 installer 会下载便携版到项目目录。
- 不需要 Codex。
- 不需要 Edge Control 插件。
- 不需要手动加载浏览器扩展。

注意：

- `.runtime\edge-profile` 包含浏览器登录态和 cookies，不要发给别人。
- 如果把整个项目搬到另一台自己的电脑，可以选择不带 `.runtime`，到新电脑重新登录 BOSS。
- 如果要把项目发给别人使用，建议删除 `.runtime\edge-profile`，保留或重新生成 `.runtime\node`。

## 兼容：Edge Control 模式

这个模式保留给当前 Codex 环境或需要控制现有 Edge 会话的情况。

浏览器控制来源：

- `plugin`：使用当前 Codex 插件目录 `D:\codex-plugins\edge-control`。
- `bundled`：使用本机已放入 `vendor\edge-control-bridge` 的 bridge（可选）。
- `auto`：优先找 `plugin`，找不到再用本机 `bundled` bridge。

配置文件：

```text
configs\browser.json
```

检查 bridge：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-edge-control.ps1 -CheckOnly
powershell -ExecutionPolicy Bypass -File .\scripts\start-edge-control.ps1 -Source bundled
```

扫描：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\scan-boss.ps1 -BridgeSource bundled -Keywords "AI应用开发" -MaxCards 60 -DetailLimit 5
```

说明：

- Git 仓库和绿色包均不附带该 bridge 上游源码；绿色便携模式不依赖它。
- 如本机已存在 `vendor\edge-control-bridge`，可按其 `VENDORED_FROM.txt` 追溯来源；上游未提供 `LICENSE`，因此不随本项目分发。
- 首次使用 `bundled` 会安装依赖到 `vendor\edge-control-bridge\scripts\node_modules`。

## 快速检查

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -CheckOnly
powershell -ExecutionPolicy Bypass -File .\run.ps1 check
powershell -ExecutionPolicy Bypass -File .\run.ps1 flow-smoke
powershell -ExecutionPolicy Bypass -File .\scripts\start-portable-edge.ps1 -CheckOnly
```

离线测试可以继续用 JSON 输入，不依赖浏览器：

```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1 scan --input data\sample_jobs.json
```

## CLI

```powershell
.\run.ps1 init-db
.\run.ps1 scan --site boss --input data\sample_jobs.json
.\run.ps1 scan --site boss --browser portable --cdp-port 9222 --keywords "AI应用开发"
.\run.ps1 scan --site boss --browser edge --keywords "AI应用开发"
.\run.ps1 rebuild-report
.\run.ps1 dashboard --port 8787
.\run.ps1 batch-summary --batch latest
.\run.ps1 mark-applied --job-id <id> --note "人工确认已沟通"
.\run.ps1 mark-skipped --job-id <id> --reason "地点或风险不合适"
```

## 筛选口径

优先保留：

- AI 应用开发、大模型应用、RAG、Agent、Python AI 后端。
- JD 提到知识库、智能客服、企业 AI 助手、LLM 应用、LangChain、LangGraph、FastAPI、向量数据库、工具调用。
- 0-3 年、1-3 年、经验不限、初中级岗位。
- 3-5 年但薪资明显偏初中级的岗位会降低风险，不直接排除。
- BOSS 近期活跃，优先 3 日内活跃。
- 广州岗位优先。

谨慎或降权：

- 讲师、培训、课程顾问、销售、运营、纯测试、纯 Java、纯前端、纯算法训练。
- 外包驻场描述模糊。
- 长期无偿试岗、培训贷、收费。
- HR 或 BOSS 长期不活跃。
- 地点不在广州或广州周边。

## 目录结构

```text
configs/                    个人画像、关键词、评分配置、浏览器来源配置
data/                       SQLite、样例输入、扫描数据
reports/                    生成的 HTML / Markdown 报告
scripts/                    启动和扫描脚本
src/adapters/browser/       Edge Control / CDP 浏览器适配器
src/adapters/sites/         站点适配器，当前主要是 BOSS
src/core/                   scoring / storage / llm
src/reports/                报告生成
tests/self_check.js         最小自检
vendor/edge-control-bridge/ 本机可选的 Edge Control bridge（不随源码分发）
```

## 已知事项

- 绿色模式使用 Edge CDP，不是 BOSS 官方 API。页面结构变化时，可能需要维护 `src/adapters/sites/boss.js`。
- Edge Control `bundled` 首次安装依赖时，npm 当前会报告上游依赖漏洞；它不影响岗位评分逻辑。
- 如果同时存在 plugin bridge 和 bundled bridge，它们默认共用 `%APPDATA%\CodexEdgeControl\config.json` 和 `127.0.0.1:47173`。

## 后续可补

- 增加一键打包 zip，自动排除 `.runtime\edge-profile`。
- 增加“今日新增 / 昨日已出现 / 已投 / 已跳过”的报告分区。
- 增加关键词批次策略，按 A/B/C 关键词组轮换扫描。
- 增加导出 CSV，方便长期投递记录统计。

## 阶段 3：分析结果进入报告

当前扫描流程已经把结构化分析接进主链路：

1. `src/cli.js` 在规则评分后调用 `src/core/job_analysis.js`。
2. `job_analysis` 优先使用网页“模型设置”的运行时配置；默认仍是离线 `mock`，不需要 API Key。
3. 分析结果会写入 SQLite 的 `jobs.analysis_json` 字段。
4. Markdown / HTML 报告会展示投递建议、推荐简历版本、主推项目、模型理由、风险追问和可复制招呼语。
5. 规则评分仍然是硬护栏：分数过低或风险明显时，模型不能把岗位强行判成可投。

验证命令：

```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1 check
powershell -ExecutionPolicy Bypass -File .\run.ps1 scan --input data\sample_jobs.json
```

## 阶段 4：本批次报告与反馈状态

扫描完成后，报告默认只展示本批次出现的岗位，避免把历史库里的岗位全部混进当天 shortlist。

报告会额外展示：

- `状态`：未处理 / 已投 / 已跳过。
- `出现`：本次新增 / 重复出现。
- `建议`：模型与规则护栏合并后的 apply / caution / skip。

人工反馈命令仍然走本地 SQLite：

```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1 mark-applied --job-id <id> --note "已人工投递"
powershell -ExecutionPolicy Bypass -File .\run.ps1 mark-skipped --job-id <id> --reason "地点或风险不合适"
```

后续重新生成全量报告时，已投和已跳过岗位会显示最近一次状态，并排在未处理岗位后面。

## 阶段 5：反馈反向影响筛选

人工反馈现在不只是记录状态，还会反向影响后续筛选：

1. `src/core/storage.js` 会从 SQLite 统计反馈摘要：已投、已跳过、无回复，以及公司/关键词/风险/简历版本的历史表现。
2. `src/core/keyword_planner.js` 会根据历史反馈调整关键词优先级：多次跳过且没有投递的关键词会降权，历史有效关键词会保留靠前。
3. `listReportJobs` 会把反馈提示挂到岗位上，并在同级别内部把历史低效公司、低效关键词、高频跳过风险往后排。
4. 报告会展示 `反馈提示`，例如公司历史跳过、关键词历史低效、关键词历史无回复偏多。

反馈命令：

```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1 mark-applied --job-id <id> --note "已人工投递"
powershell -ExecutionPolicy Bypass -File .\run.ps1 mark-skipped --job-id <id> --reason "地点或风险不合适"
powershell -ExecutionPolicy Bypass -File .\run.ps1 mark-no-reply --job-id <id> --note "已投递，暂未回复"
powershell -ExecutionPolicy Bypass -File .\run.ps1 feedback-summary
powershell -ExecutionPolicy Bypass -File .\run.ps1 batch-summary --batch latest
```

当前策略偏保守：明确跳过的反馈降权更明显，无回复只做轻微降权，避免因为 HR 暂时没回就误伤岗位方向。

## 用户真实 BOSS 实测清单

1. 启动专用 Edge：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-portable-edge.ps1
```

2. 在弹出的 Edge 里登录 BOSS，确认城市为广州。

3. 先用少量关键词试跑，建议每个词 60-100 张卡，详情读取 5-8 个：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\scan-portable.ps1 -Keywords "AI应用开发,RAG工程师,Python AI后端" -MaxCards 80 -DetailLimit 6 -MaxDetailTotal 180
```

4. 打开操作台：

```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1 dashboard --port 8787
```

浏览器打开 `http://127.0.0.1:8787/`，默认只看最新批次。建议顺序：

- `status=pending` 先处理未处理岗位。
- `level=优先/可投/可冲` 分级看，不要从谨慎开始消耗心力。
- `fresh=new` 看本批新增，`fresh=repeated` 看重复出现但可能值得补投的岗位。
- 只投你人工确认过的岗位；工具不会自动点击“立即沟通”。

5. 每个岗位处理完就标记：

- `已投`：已经人工发起沟通。
- `跳过`：地点、方向、外包、过期、明显低价值。
- `无回复/待跟进`：已经投过但暂时没回应。
- `HR 回复/跟进备注`：记录 HR 问题、约面、薪资口径或后续动作。

6. 扫描后复盘本批质量：

```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1 batch-summary --batch latest
powershell -ExecutionPolicy Bypass -File .\run.ps1 feedback-summary
```

7. 你实测后重点反馈这些字段：非广州误判、活跃度误判、3-5 年可冲是否合理、哪些关键词低价值、哪些岗位明明好却排太后、招呼语哪里需要微调。

## 换候选人使用

仓库提供匿名示例：

```text
profiles\example_profile.json
profiles\example_resume_versions.json
```

如果要给其他候选人使用，不需要改代码，上传简历后由本地数据库保存画像；也可以复制示例文件后在扫描时指定：

```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1 scan --profile profiles\someone.json --resume-versions profiles\someone_resume_versions.json --input data\sample_jobs.json
```

画像文件负责候选人方向、技能、项目、风险口径；简历版本文件负责不同投递方向下的主推项目和关键词。
