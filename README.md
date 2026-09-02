# RoleFlow

[![Release: v1.2.2](https://img.shields.io/badge/release-v1.2.2-2563eb)](https://github.com/daydreamer0213/roleflow/releases/tag/v1.2.2)
[![CI](https://github.com/daydreamer0213/roleflow/actions/workflows/ci.yml/badge.svg)](https://github.com/daydreamer0213/roleflow/actions/workflows/ci.yml)
[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-0f766e)](LICENSE)

RoleFlow 是一个本地运行的、简历驱动的岗位筛选与沟通工作台。它负责解析简历、生成候选人画像和搜索方案、只读采集 BOSS 岗位、用大模型理解完整 JD，并把结果整理为用户确认的沟通清单。

RoleFlow 的筛选规则由搜索关键词、城市、薪资和经验范围驱动，同一套采集、分析、去重和排序流程可以用于不同求职方向。

[查看作品集中的流程与成果展示](https://daydreamer0213.github.io/ai-application-portfolio/#roleflow)

## 发布状态

`v1.2.2` 是当前正式版；普通用户应从 [v1.2.2 下载页](https://github.com/daydreamer0213/roleflow/releases/tag/v1.2.2) 获取安装器，并以该版本的发布说明为准。安装器尚未代码签名，Windows 可能显示信誉或 SmartScreen 提示。

v1.2.2 默认使用“RoleFlow 专用 Edge（推荐）”，登录资料固定保存在 `%LOCALAPPDATA%\RoleFlow\BrowserProfile`。本版收口暂停后的筛选条件变化：暂停真正生效后，用户可以继续原条件，或在同一轮中按当前新条件重新开始；岗位卡片不会越过冻结上限，错误页面也会优先告诉用户发生了什么和下一步怎么做。

## 核心能力

- 从 TXT、Markdown、DOCX 或 PDF 简历生成结构化候选人画像和搜索方案。
- 复用已登录的 Edge，只读采集岗位列表与完整 JD，并保存稳定来源 ID 和历史详情。
- 结合岗位职责、技术要求、薪资、活跃度和风险信号给出分层建议。
- 将主投、先聊确认、备选和待复核岗位整理为本地工作清单。
- 只读发现 HR 新回复，生成可编辑且自动保存的回复草稿，并学习用户最终复制、手动发送或确认发送的文字。
- 按 48 小时和周末顺延规则分析 30/50/70 档求职反馈；策略改变后开启新轮，不混用修改前后的投递数据。
- 基于原简历和目标方向生成整份可编辑定向简历，并提供基于简历证据的通用模拟面试。
- 沟通前必须由用户确认清单；登录失效、页面漂移或结果不明确时停止操作。
- v1.2.2 发布线注册 132 项离线检查；标签发布已在精确版本提交上重新执行全部检查。测试不访问真实 BOSS，也不会创建假的 `msedge.exe`。

RoleFlow 每天最多由用户手动启动三轮任务，前两轮是主要工作轮次，第三轮只在候选库存明显不足时追加。每轮都要经过清单确认才会串行点击沟通；不会后台定时运行，也不会绕过用户确认直接执行。

## 快速开始

Windows 普通用户：

> **请前往 [v1.2.2 下载页](https://github.com/daydreamer0213/roleflow/releases/tag/v1.2.2)，下载 `RoleFlow-Setup-1.2.2.exe`。**
>
> 同页的 `RoleFlow-Setup-1.2.2.exe.sha256` 用于核对文件完整性；GitHub 自动生成的 Source code 压缩包不是安装程序。

安装后的日常路径如下：

1. 在当前源码或候选暂存目录运行 `Install.bat`，再双击 `Start.bat`。默认会启动“RoleFlow 专用 Edge（推荐）”，不需要 Edge Control 或浏览器连接组件。
2. 第一次在“RoleFlow 专用 Edge（推荐）”中登录 BOSS。登录资料保存在 `%LOCALAPPDATA%\RoleFlow\BrowserProfile`，覆盖升级或更换安装目录后仍会复用；不要把这个目录放进发布包或提交到 Git。
3. 在同一个“RoleFlow 专用 Edge（推荐）”窗口保留一个 `BOSS-SEARCH` 搜索页和一个 `BOSS-COMMUNICATION` 沟通页。启动助手可在就绪检查后引导一次前台；此后的扫描、JD 读取、分析、消息发现和沟通都保持后台。
4. 在“模型设置”选择 DeepSeek、通义千问、OpenAI 或自定义兼容接口，填写 Key，并执行“测试连接并保存”。
5. 上传 TXT、MD、DOCX、PDF 简历，检查候选人画像和搜索方案，手工选择求职城市并保存方案。
6. RoleFlow 会只读检查登录、风控、窗口归属和页面身份；失败时停止并给出处理建议，不会自动切换浏览器。消息发现优先复用本地完整 JD；只有新会话缺少完整可信 JD 时，才允许串行打开一个同窗口、`active: false` 的后台临时详情页，检查并保存后立即关闭。
7. 只有明确要复用日常 Edge 时，才显式运行高级模式：

   ```text
   Start.bat -BrowserMode edge
   ```

   “使用当前 Edge（高级，需要浏览器连接组件）”要求现有 Edge Control 扩展与桥接健康；“RoleFlow 专用 Edge（推荐）”失败时绝不会自动回退到该模式。
8. 登录成功不会自动扫描；扫描完成后仍需用户确认清单并再次明确点击“开始沟通”。本阶段不自动沟通、不发送或投递，也不放宽首次校准点击和批次确认门禁。

模型不可用时，历史岗位和投递记录仍可查看；简历解析和语义匹配会明确显示为待处理，不会伪装成模型结论。

### 浏览器连接

当前版本默认使用“RoleFlow 专用 Edge（推荐）”，不依赖 Edge Control。Edge Control 扩展和桥接只服务于“使用当前 Edge（高级，需要浏览器连接组件）”，不进入普通安装包，也不会自动下载；高级模式缺少组件时会停止，不会切换浏览器 authority（浏览器控制权）。

卸载时 RoleFlow 会先核对 8787 端口、`/health` 返回的安装目录和监听进程，只停止属于当前安装目录的工作台。普通卸载和静默卸载都保留 `%LOCALAPPDATA%\RoleFlow\BrowserProfile`；交互卸载只有在独立确认“删除专用浏览器登录资料”后才删除它。岗位数据库、简历、模型设置、日志和报告仍位于各自安装目录，不会因为浏览器登录资料稳定就悄悄迁移到新的安装目录。

仓库源码和便携 ZIP 仍保留 `Install.bat` / `Start.bat`，用于开发、便携使用和故障恢复。`Install.bat` 不是标准 Windows 安装器，也不再把完整开发回归测试作为用户安装步骤。

## 运行逻辑

```text
简历文件/文本
  -> 本地文本提取与质量诊断
  -> 模型生成结构化 CandidateProfile
  -> 模型推荐关键词、薪资和经验范围
  -> 用户选择城市并确认 Search Plan
  -> 选择日常扫描或广泛扫描
  -> 继承当前 BOSS 搜索页条件，或从 Search Plan 生成原生筛选参数
  -> 左侧岗位卡片采集与去重
  -> 按需点击卡片，读取右侧完整详情
  -> 模型理解真实岗位职责与核心技术栈
  -> 模型结合简历版本做证据化匹配
  -> 本地硬边界、活跃度和风险守卫
  -> 主投 / 先聊确认 / 备选 / 待分析 / 待刷新 / 不建议
  -> 用户确认本轮沟通清单
  -> 串行沟通并核验结果
  -> 保存已投、失效、待复核和未访问替补状态
```

同一岗位使用稳定的来源 ID 保存。再次扫描只增加观测记录并更新详情快照，不会删除历史未投岗位，也不会覆盖已投或跳过状态。

每天成功沟通目标为 70，最多创建三轮，单轮目标不超过 40。第一轮通常目标 35；后续目标根据当天已成功数量动态计算。前两轮是主要轮次；第三轮只有在可用候选少于 30，或本轮候选缺口至少为 8 时才追加扫描。两次扫描至少间隔 2 小时。

工作流每天共享 360 个右栏详情和 60 次搜索页导航预算，每轮上限为 120/20。已结束扫描按实际访问量结算，执行中的轮次才预占完整计划预算。每轮最多选择 3 个关键词，并优先使用当天尚未使用且历史有效率更高的关键词。高级入口的独立“日常扫描”仍使用单次 240/40 预算，不与主工作流口径混用。

高级操作仍保留日常扫描、广泛扫描、详情补读和活跃探针，但它们不是主要使用路径。

## 模型使用边界

模型用于：

- 把简历文本解析为结构化画像、技能、经历和项目。
- 推荐初始关键词、薪资和经验范围；城市由用户选择，除非简历明确写出。
- 理解 JD 的真实角色、核心技术栈、职责和隐藏风险。
- 结合指定简历版本给出匹配建议，并分别提供 JD 与简历证据。
- 仅在强推荐岗位上按需生成定制招呼语；按需生成 HR 回复或一次跟进文案。

模型不会：

- 从简历猜测 GAP、离职原因、到岗时间或短期项目口径。
- 在缺少事实时生成可直接发送的回答；页面会先要求用户补一条事实。
- 在扫描阶段为每个岗位批量生成招呼语。
- 越过明确异地、过期、非技术岗位、实习岗位等已确认硬边界。

岗位分析结果按模型、契约版本、简历画像、简历版本和 JD 内容缓存。任一关键输入变化后会重新分析。

## BOSS 安全策略

默认只读、串行、带随机扰动：

- 当前可见卡片批量读取，不按每张卡逐条等待；列表滚动和右栏切换均带随机间隔。
- 当前 Edge 位于有效 BOSS 搜索页时，继承城市、区域、薪资、经验、学历、行业等条件，只替换搜索关键词；否则从 Search Plan 生成搜索 URL。
- 外部页面操作保持串行；关键词切换、详情读取和周期冷却使用不同节奏。
- 每随机 18–26 次外部页面动作额外冷却约 4–7 秒。
- 左栏明确硬排除后的唯一岗位按关键词优先级读取右栏；A/B 每词最多读取约 45/30 个详情，一轮还受 120 个详情的工作流上限约束。达到上限或读取失败的岗位保留为待读详情。详情补读和活跃探针默认最多各 8 个。
- 发现登录失效、验证页、异常重定向或页面结构失配时立即停止，不自动重试硬闯。

不要同时启动多个 BOSS 扫描。并行只用于岗位信息已经落地后的本地模型分析，不并发操作网页。

## 队列与沟通

- `主投`：完整 JD、模型高置信度、JD 与简历双证据齐全，且无阻断风险。
- `先聊确认`：方向可投，但年限、职责偏移、工作制或其他风险需要先问清。
- `备选`：价值较低或匹配一般，保留但不优先投入精力。
- `待语义分析`：模型不可用、契约失败或输入已变化。
- `待刷新`：详情或招聘方活跃信息不足；原来 3 日内活跃但快照已过期的岗位可单独探测。
- `不建议`：明确硬边界不满足。

普通岗位使用 BOSS 自带通用招呼语。只有证据完整的主投岗位显示“生成定制招呼语”。批量流程使用用户确认后的岗位快照逐个打开、核验并点击沟通，不会把生成文案自动发送给未确认岗位。

“推荐反馈”和“投递状态”相互独立。反馈仅用于定位推荐异常和后续人工优化，不会自动改写排序权重，避免把系统越调越偏。

## 数据与隐私

- API Key 使用 Windows 当前用户 DPAPI 加密，保存在 `.runtime\secrets`；不会写入源码、配置、日志或发布包。
- 简历原文、岗位详情、投递状态和模型缓存保存在本机 `data\jobs.sqlite`。
- 日志位于 `.runtime\logs`，会脱敏 Key、Cookie、Token、简历和 JD 内容；诊断页只展示最近的脱敏事件与模型调用指标。
- 调用云模型时，提取后的简历文本或岗位信息会发送给用户选择的模型提供商。页面会在上传前明确提示。
- `.gitignore` 排除本地数据库、运行时密钥、浏览器 profile、报告和真实个人画像。

## 便携交付

双击 `BuildRelease.bat` 生成 `dist\RoleFlow-portable.zip`。发布包可以包含便携 Node，另一台 Windows 电脑解压后运行 `Install.bat` / `Start.bat`；当前版本默认使用“RoleFlow 专用 Edge（推荐）”，不依赖 Codex 或 Edge Control。Edge Control 不内置在发布 zip 中，只用于显式高级模式。

维护者双击 `BuildInstaller.bat` 可生成标准安装器和同名 `.sha256` 校验文件。构建会先运行一次完整离线回归，再在 `D:\DevData\RoleFlow-installer` 创建不含数据库、简历、密钥、日志、报告、浏览器 profile、测试源码或 Edge Control 的干净暂存目录，然后调用固定的 Inno Setup 6 编译器。构建机需要把编译器放在 `D:\DevData\InnoSetup`，或设置 `ROLEFLOW_ISCC`。

“RoleFlow 专用 Edge（推荐）”的默认登录资料位于 `%LOCALAPPDATA%\RoleFlow\BrowserProfile`，不属于安装目录。它会跨覆盖升级和安装目录变化保留；更换电脑时不要直接复制浏览器登录资料，应在新电脑重新登录 BOSS。

从旧版安装目录内的 `.runtime\edge-profile` 迁移时，先关闭使用源目录或目标目录的 Edge，再明确执行只复制迁移：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\migrate-browser-profile.ps1 -SourceProfileDir "旧目录\.runtime\edge-profile" -ConfirmMigration
```

迁移会复制并核对文件后写入稳定目录，不移动或删除源目录；目标目录已存在时会停止，由用户决定保留哪一份。

默认入口直接运行：

```text
Start.bat -BrowserMode portable
```

命令中的内部模式名仍为 `portable`，但普通产品名称统一为“RoleFlow 专用 Edge（推荐）”。端口 `9222` 和 CDP 属于开发诊断细节，不需要普通用户配置。

“使用当前 Edge（高级，需要浏览器连接组件）”的显式扫描命令：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\scan-boss.ps1 -PlanId 1 -BridgeSource plugin
```

“RoleFlow 专用 Edge（推荐）”的源码扫描命令仍沿用内部脚本名：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\scan-portable.ps1 -PlanId 1
```

低频广泛扫描：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\scan-portable.ps1 -PlanId 1 -ScanMode broad
```

日常使用优先在网页中启动扫描，避免手工传错方案。

## 开发与验证

```powershell
npm.cmd test
node src/cli.js --help
node tests/job_match_benchmark.js --live
```

`npm.cmd test` 运行完整离线回归，不访问 BOSS，也不需要真实模型。`--live` 标注集会调用当前配置的真实模型，当前包含 31 条人工标注 JD。

关键文档：

- `docs/README.md`：中文文档导航，区分当前产品文档与历史记录。
- `docs/daily_workflow.md`：当前三轮上限、预算、模型调用和批量沟通逻辑。
- `docs/runtime_flow_review.md`：逐环节运行复盘和问题台账。
- `docs/remediation_plan.md`：本轮整改项、验收标准和状态。
- `docs/llm_contracts.md`：模型输入输出契约。
- `docs/operations.md`：日志、错误码和排错流程。
- `docs/release_boundary.md`：绿色包与隐私边界。
- `docs/two-run-workflow-validation.md`：历史双轮方案，仅作为旧版验收记录。

## 主要目录

```text
src/adapters/browser/   Edge Control 与便携 CDP 浏览器适配器
src/adapters/sites/     BOSS 页面读取与原生筛选
src/adapters/models/    Mock 与 OpenAI-compatible 模型适配器
src/core/               画像、方案、评分、语义分析、存储、日志
src/dashboard/          本地工作台
tests/                  离线回归与人工标注集
scripts/                安装、启动、扫描和发布脚本
data/                   本地 SQLite（真实文件不进 Git）
```

## BOSS 沟通当前边界

沟通批次保存不可变的岗位、公司和链接快照。执行前必须由用户确认清单；执行器逐个打开岗位并校验身份，只有岗位一致且“立即沟通”状态明确时才允许单次点击。成功、已沟通、岗位失效、身份不符、按钮不可用和结果不明确会分别记录，不会混成成功。

沟通操作串行执行，默认间隔 15–20 秒，10 分钟最多 30 个、30 分钟最多 60 个、24 小时最多 150 个。达到本轮成功目标后，未访问替补会以零点击停止。登录失效、风控、页面漂移或歧义结果会立即中断，恢复必须再次由用户操作。

当前代码和离线回归已启用校准后的沟通执行路径，但真实页面仍应按 [每日筛选与沟通工作流](docs/daily_workflow.md) 从可控数量开始使用。离线测试不会访问 BOSS，也不能替代真实页面验收。


## BOSS 消息只读发现（手动一轮）

消息发现是独立的一轮手动操作，不是持续监控，也不会自动回复。

- 打开页面：队列右上角“消息发现”，或 `/messages?profileId=候选人ID`。
- 前置条件：RoleFlow 专用 Edge（推荐）正在运行，并且固定基线中存在唯一一个已登录的 `BOSS-COMMUNICATION` 消息页。
- 点击“开始只读发现”后，系统只读取未读会话和预览变化；不会填写输入框、不会点击发送。
- HR 连续发送的纯文字会作为一组处理（最多 5 条）；含语音、图片、普通附件、未知卡片或超长文本时会停止并提示人工粘贴。
- 已验证的附件简历请求卡片会显示为 BOSS 人工待办，不会自动点击“同意”或“拒绝”。同一轮既有文字问题又有简历请求时，页面会同时显示人工待办和本地回复草稿。
- BOSS 的岗位竞争情况卡片不会冒充 HR 文字，也不会进入模型。
- 生成结果最多 2 条草稿，只保存在本机内存，30 分钟、新运行、放弃、已手动发送或关闭工作台后都会清空。
- 只有明确邀请参加、确认或选择一场面试才标记为正式面试邀约；正文只是提到“面试”不会误判。系统可以生成不承诺具体时间的本地草稿，但不会替你确认安排。
- 复制草稿后在 BOSS 手动发送，然后回到页面点击“已手动发送”更新进展卡。

## 开源许可

RoleFlow 的自有代码与文档采用 [GNU Affero General Public License v3.0 only](LICENSE)（`AGPL-3.0-only`）。

AGPL 不是“禁止商用”许可证。你可以学习、修改和商业使用，但分发修改版，或通过网络向用户提供修改后的程序服务时，需要按许可证向对应用户提供完整源代码，并保留相同许可证。第三方组件继续适用其各自许可证，详见 [NOTICE](NOTICE)。

AGPL 不授予 RoleFlow 名称、标识或其他商标权。真实简历、账号凭据、岗位数据库、运行日志和模型密钥不属于本仓库发布内容。

提交改动前请阅读 [贡献指南](CONTRIBUTING.md)。安全问题请按 [安全策略](SECURITY.md) 私下报告。
