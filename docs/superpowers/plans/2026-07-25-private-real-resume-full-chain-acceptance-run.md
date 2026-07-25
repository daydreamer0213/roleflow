# 私有真实简历完整链路受控验收 Run Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不触碰正式数据库和 8787 的前提下，使用真实招聘平台 PDF、新鲜真实 JD 和正式模型配置完成一次可审计的完整链路验收。

**Architecture:** 招聘平台只访问一次并冻结私有 JD 快照；基线和候选随后离线复用同一份已遮盖简历、确认画像、确认卡片、JD 和人工标签。所有 live 操作都有独立授权门，完整结果留在 `D:` 私有目录，Git 只保存非敏感汇总。

**Tech Stack:** 已通过离线验收的 private full-chain runner、Edge 固定标签页、现有 BOSS 只读适配边界、正式 OpenAI-compatible 模型配置、SQLite 临时库。

## Global Constraints

- 必须先完整执行并通过 `2026-07-25-private-real-resume-full-chain-tooling.md`。
- 私有根固定为 `D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725`。
- 原始 PDF 路径通过进程环境变量注入，不写入 Git、命令文档、日志或报告。
- 不修改 `D:\Guo\ZhiPing` 的代码，不读写其 `data/jobs.sqlite`，不启动或操作 8787。
- 正式模型配置只通过 `--model-settings-root D:\Guo\ZhiPing` 交给现有 loader 原地只读；不得复制设置、DPAPI 密钥或明文 Key。
- BOSS 只使用用户现有登录态和固定 `BOSS-SEARCH` 标签页；不得创建逐岗位标签页、第二窗口或第二登录会话。
- BOSS 全程只读，不点击沟通、投递、收藏，不读取招聘者聊天或消息正文。
- 所有浏览器操作串行、低频、随机节奏并带检查点；登录、验证码、风控、页面丢失或 jobId 不一致立即停止。
- 未获得对应的当次授权时，不得读取真实简历、访问招聘平台或调用真实模型。
- 人工标签在首次岗位 live 匹配前冻结；看过结果后修改标签必须提升私有数据包版本并双侧重跑。
- 任一门禁失败不得伪造、补写或手工编辑 live 结果为“通过”。

---

### Task 1: 固定候选与共享 runner 基线

**Files:**
- Candidate worktree: `D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix`
- Baseline worktree: `D:\DevData\RoleFlow-private-benchmark\baseline-worktree-v1`
- Private manifest: `D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725\run-manifest.json`

**Interfaces:**
- Consumes: tooling 计划 Task 3–5 的共享 runner/metrics 提交。
- Produces: `baselineEvaluatedCommit`、`candidateEvaluatedCommit`、`baselineProductCommit` 和共享 blob 清单。

- [ ] **Step 1: 验证候选检查点**

Run:

```powershell
$candidate='D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix'
git -C $candidate status --short
git -C $candidate rev-parse HEAD
Push-Location $candidate
try { npm.cmd test } finally { Pop-Location }
```

Expected: 工作树干净，全部 46 项离线检查通过，HEAD 已推送到 `origin/codex/claude-generic-evidence-matching-live-fix`。

- [ ] **Step 2: 固定最终 runner tooling**

从干净 candidate 的最终提交取得 `TOOLING_HEAD`；共享文件仅为：

```powershell
$TOOLING_HEAD=(git -C $candidate rev-parse HEAD).Trim()
$sharedFiles=@('scripts/private-full-chain-runner.js','scripts/lib/benchmark_metrics.js')
```

不要把 `resume_parser`、`pdf_text`、`resume_privacy` 或 candidate-only 产品 wiring 当作共享文件。若最终 tooling 与产品改动混在同一提交，必须从产品基线创建一个专用、可审计的 baseline-tooling 提交：仅从 `$TOOLING_HEAD` 复制上述 `$sharedFiles` 并提交；或 cherry-pick 一个只包含这些文件的最终 tooling 提交。不得使用未提交工作树内容，也不得把 Task 1/2 的 PDF 或隐私业务改动合入 baseline 产品行为。

- [ ] **Step 3: 创建隔离 baseline worktree**

执行时先确定当前批准的产品基线提交 `$PRODUCT_BASELINE_HEAD`，并验证目标不存在或为空；不得硬编码历史提交链。

创建：

```text
branch: codex/generic-evidence-matching-private-full-chain-baseline-v1
path:   D:\DevData\RoleFlow-private-benchmark\baseline-worktree-v1
```

从 `$PRODUCT_BASELINE_HEAD` 建立 worktree，然后只应用 Step 2 的最终 shared tooling（cherry-pick 专用 tooling 提交，或只复制 `$sharedFiles` 后创建专用提交）。任何冲突立即停止并报告，不自行取整文件一侧。

- [ ] **Step 4: 验证共享代码逐字节一致**

运行：

```powershell
$sharedFiles=@(
  'scripts/private-full-chain-runner.js',
  'scripts/lib/benchmark_metrics.js'
)
foreach($file in $sharedFiles) {
  $candidateBlob=(git -C $candidate rev-parse "HEAD:$file").Trim()
  $baselineBlob=(git -C $baseline rev-parse "HEAD:$file").Trim()
  if($candidateBlob -ne $baselineBlob) { throw "SHARED_BLOB_MISMATCH: $file" }
}
```

baseline 不运行 `--prepare` 或 `--card-live`，runner 对 candidate-only 模块必须使用按 mode 的惰性加载。baseline 缺少匹配卡消费能力是产品行为差异，不能通过 cherry-pick Task 1/2 或候选匹配逻辑偷偷补齐。

结果继续记录并核验 `runManifestSha256`，使 baseline/candidate comparison 绑定同一 manifest。私有目录的本机管理员恶意修改不属于该流程的威胁模型；不增加同目录 HMAC。

- [ ] **Step 5: 运行 baseline 离线验证**

Run:

```powershell
$baseline='D:\DevData\RoleFlow-private-benchmark\baseline-worktree-v1'
node "$baseline\tests\job_match_benchmark.js"
Push-Location $baseline
try { npm.cmd test } finally { Pop-Location }
git -C $baseline diff --check
git -C $baseline status --short
```

Expected: v3 fixture 检查和 baseline 原有全量离线检查通过；diff-check 无输出，工作树干净。

- [ ] **Step 6: 写私有 run manifest**

Run from candidate worktree:

```powershell
$env:ROLEFLOW_PRIVATE_ROOT='D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725'
node scripts/private-full-chain-runner.js --init-manifest `
  --private-root "$env:ROLEFLOW_PRIVATE_ROOT" `
  --baseline-worktree 'D:\DevData\RoleFlow-private-benchmark\baseline-worktree-v1' `
  --candidate-worktree 'D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix' `
  --output "$env:ROLEFLOW_PRIVATE_ROOT\run-manifest.json"
```

Expected: runner 自行写入 `harnessVersion`、实际 `baselineProductCommit` / `candidateProductCommit`、以及 shared blob 清单；不接受操作者传入提交值，且目标 manifest 必须是新文件。

---

### Task 2: 本地准备真实 PDF

**Files:**
- Read-only: environment-provided original PDF
- Private: `input\identity.private.json`
- Private: `input\resume.redacted.txt`
- Private: `input\parse-report.json`

**Authorization:**

用户必须在本轮明确写出：

```text
ALLOW_PRIVATE_RESUME_BENCHMARK=YES
```

- [ ] **Step 1: 验证授权与路径**

设置：

```powershell
$env:ROLEFLOW_PRIVATE_ROOT='D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725'
if (-not $env:ROLEFLOW_PRIVATE_RESUME_PATH) { throw 'ROLEFLOW_PRIVATE_RESUME_PATH_REQUIRED' }
$env:ALLOW_PRIVATE_RESUME_BENCHMARK='YES'
```

`ROLEFLOW_PRIVATE_RESUME_PATH` 只在当前进程设置，不打印其值。

- [ ] **Step 2: 创建私有 identity manifest**

使用 `apply_patch` 在私有根创建 `input\identity.private.json`，只包含用户已授权用于遮盖的姓名、手机号和邮箱。创建后不得通过 `Get-Content`、日志或最终回复回显内容。

验证文件位于私有根，未被 Git 跟踪：

```powershell
git -C 'D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix' status --short
```

Expected: 工作树仍干净。

- [ ] **Step 3: 执行 prepare**

Run:

```powershell
node scripts/private-full-chain-runner.js --prepare `
  --private-root "$env:ROLEFLOW_PRIVATE_ROOT" `
  --pdf "$env:ROLEFLOW_PRIVATE_RESUME_PATH" `
  --identity "$env:ROLEFLOW_PRIVATE_ROOT\input\identity.private.json" `
  --output "$env:ROLEFLOW_PRIVATE_ROOT\input"
```

Expected: 只产生 `resume.redacted.txt` 与 `parse-report.json`，不调用模型。

- [ ] **Step 4: 验证顺序与隐私**

使用 runner 的只读 `--verify-private-bundle` 检查：

```powershell
node scripts/private-full-chain-runner.js --verify-private-bundle `
  --private-root "$env:ROLEFLOW_PRIVATE_ROOT" `
  --resume-text "$env:ROLEFLOW_PRIVATE_ROOT\input\resume.redacted.txt" `
  --identity "$env:ROLEFLOW_PRIVATE_ROOT\input\identity.private.json" `
  --parse-report "$env:ROLEFLOW_PRIVATE_ROOT\input\parse-report.json"
```

Expected:

- 姓名、求职意向、个人优势、技能、实习、各项目、教育、证书顺序正确；
- 实习标题和项目正文不串线；
- 姓名、手机号、邮箱残留数为 0；
- 公司、项目、技能和时间保留；
- providerCalls 为 0。

任何失败立即停止，不进入模型阶段。

---

### Task 3: 生成并确认真实画像与匹配卡

**Files:**
- Private: `runs\baseline\profile.json`
- Private: `runs\candidate\profile.json`
- Private: `runs\candidate\matching-card-draft.json`
- Private: `input\confirmed-profile.private.json`
- Private: `input\confirmed-card.private.json`

**Authorization:**

用户必须在本轮明确写出：

```text
ALLOW_LIVE_MODEL_BENCHMARK=YES
```

- [ ] **Step 1: 验证两侧身份与正式配置门禁**

两侧必须：

- 工作树干净；
- 使用相同的 `resume.redacted.txt` 和 identity hash；
- 使用同一正式模型 provider、模型名和参数；
- 通过 `--model-settings-root D:\Guo\ZhiPing` 只读加载；
- 不打印设置路径、endpoint、密钥或原始简历。

- [ ] **Step 2: 串行生成 baseline profile**

Run from baseline worktree:

```powershell
$env:ALLOW_PRIVATE_RESUME_BENCHMARK='YES'
$env:ALLOW_LIVE_MODEL_BENCHMARK='YES'
node scripts/private-full-chain-runner.js --profile-live `
  --side baseline `
  --private-root "$env:ROLEFLOW_PRIVATE_ROOT" `
  --resume-text "$env:ROLEFLOW_PRIVATE_ROOT\input\resume.redacted.txt" `
  --identity "$env:ROLEFLOW_PRIVATE_ROOT\input\identity.private.json" `
  --model-settings-root 'D:\Guo\ZhiPing' `
  --output "$env:ROLEFLOW_PRIVATE_ROOT\runs\baseline"
```

等待完成并检查终态后才能运行 candidate。

- [ ] **Step 3: 串行生成 candidate profile**

在 candidate worktree 运行相同命令，只将 `--side` 和输出改为 `candidate`。两侧不得并行调用模型。

- [ ] **Step 4: 生成 candidate 匹配卡草稿**

Run from candidate worktree:

```powershell
node scripts/private-full-chain-runner.js --card-live `
  --side candidate `
  --private-root "$env:ROLEFLOW_PRIVATE_ROOT" `
  --profile "$env:ROLEFLOW_PRIVATE_ROOT\runs\candidate\profile.json" `
  --model-settings-root 'D:\Guo\ZhiPing' `
  --output "$env:ROLEFLOW_PRIVATE_ROOT\runs\candidate"
```

Expected: `matching-card-draft.json` 的 `status=draft`、`userConfirmed=false`。

- [ ] **Step 5: 向用户展示脱敏核对页**

只展示结构化摘要，不展示手机号、邮箱或未遮盖原文。核对：

- 目标方向；
- 实习、项目、技能、教育；
- 公司/职位/项目/时间；
- “参与”“独立”“了解”边界；
- 强证据、可迁移能力、谨慎转向和排除偏好；
- baseline/candidate profile 的重大差异。

- [ ] **Step 6: 用户确认并冻结 canonical 输入**

用户明确确认后：

- 以 candidate profile 为基础保存 `confirmed-profile.private.json`；
- 只应用用户明确提出的事实纠错；
- 将 card envelope 改为 `status=confirmed`、`userConfirmed=true`；
- 记录 profile/card SHA-256 和确认时间；
- 不自动确认，也不把 baseline profile 作为生产画像。

若存在虚构、项目串线、时间错误或重大遗漏，停止并回到离线修复；不得继续采集岗位掩盖问题。

---

### Task 4: 一次性采集新鲜真实 JD

**Files:**
- Private: `input\jobs.private.json`
- Private: `input\job-capture-checkpoint.json`

**Authorization:**

用户必须在本轮明确写出：

```text
ALLOW_BOSS_READONLY_BENCHMARK_SCAN=YES
```

- [ ] **Step 1: 用户手动准备搜索页**

用户在现有已登录 Edge 中：

- 打开固定 `BOSS-SEARCH` 标签页；
- 设置广州及真实薪资、经验、学历等筛选条件；
- 保持页面停留在搜索结果；
- 不点击岗位或沟通。

操作方执行前必须完整读取 `edge-browser-ops` skill，先核对当前 tab 标识、URL、登录态和搜索页身份，不创建新 tab。

- [ ] **Step 2: 记录搜索模板**

只读记录搜索页 URL 中非账号相关的筛选模板；继承全部原生筛选，仅替换关键词：

```text
AI应用开发
RAG
Agent
Python AI 后端
```

- [ ] **Step 3: 串行采集**

使用 Edge Control 的 DOM 只读能力，一次处理一个岗位：

1. 在搜索页定位岗位；
2. 记录 jobId、标题、公司、地点、薪资和详情 URL；
3. 在同一固定 tab/pane 打开详情；
4. 再次核对 jobId、标题、公司和 URL；
5. 读取完整 JD；
6. 写检查点；
7. 返回搜索列表后再处理下一个。

每个关键词最多约 6 个不重复岗位，总目标 20–24 个。不得读取聊天、招聘者资料或消息正文。

- [ ] **Step 4: 风险与终止检查**

每个岗位后检查：

- 登录/验证码/风控；
- 页面或 tab 丢失；
- jobId 与 URL 不一致；
- JD 缺失；
- 重复岗位；
- 随机节奏和冷却是否满足。

任一风险立即停止并保留 pending，不切换窗口、不重试写动作。

- [ ] **Step 5: 冻结 JD 快照**

`jobs.private.json` 每行只保存：

```js
{
  id,
  sourceId,
  keyword,
  title,
  company,
  location,
  salary,
  url,
  description,
  sourceContentHash,
  capturedAt
}
```

不得保存 recruiter、聊天、Cookie、页面账户信息或 DOM 全量快照。runner 验证 ID 唯一、description 达到分析长度、hash 与内容一致。

---

### Task 5: 集中确认真实岗位标签

**Files:**
- Private: `labels\jobs.reviewed.json`
- Private: `reports\job-label-review.md`

- [ ] **Step 1: 生成不含模型结论的标签表**

只根据 JD 和已确认画像生成：

```text
ID | 岗位标题 | 核心职责 | 明确硬要求 | 软条件 | 建议 recommendation/bucket | 理由
```

不要展示 candidate 先前扫描分析结果，避免反向调整人工标准。

- [ ] **Step 2: 按统一语义提出标签**

- `apply/primary`：核心工作有直接证据，无待确认风险；
- `caution/talk`：方向相关，但年限、外包、实施、驻场或职责比例需确认；
- `review/talk`：JD 信息不足；
- `skip/not_recommended`：明确资格不符、不可替代核心能力缺失或安全风险。

“优先”“加分”“最好具备”和可放宽年限不得单独形成硬阻断。

- [ ] **Step 3: 用户一次性确认**

用户集中修改/确认全部 20–24 条。每条必须有非空 rationale。确认后写：

```js
{
  labelsVersion: "private-real-jd-labels.v1",
  userConfirmed: true,
  confirmedAt,
  jobsSha256,
  rows
}
```

- [ ] **Step 4: 冻结**

runner 计算 labels SHA-256 并写入 run manifest。此后看到模型结果再修改任何标签，都必须创建 `v2` 私有包并重跑两侧。

---

### Task 6: 串行岗位双跑与离线比较

**Files:**
- Private: `runs\baseline\match-result.json`
- Private: `runs\candidate\match-result.json`
- Private: `reports\full-chain-compare.json`
- Private: `reports\full-chain-compare.md`

**Authorization:**

如果 Task 3 的 live 授权不在同一连续执行窗口内，用户必须重新写出：

```text
ALLOW_LIVE_MODEL_BENCHMARK=YES
```

- [ ] **Step 1: 再次核对输入身份**

两侧必须具有完全相同的：

- confirmed profile hash；
- confirmed card hash；
- jobs hash 与 ID 集合；
- labels hash；
- model identity；
- shared harness blob；
- `private-full-chain-harness.v1`。

- [ ] **Step 2: 串行运行 baseline match**

Run from baseline worktree:

```powershell
node scripts/private-full-chain-runner.js --match-live `
  --side baseline `
  --private-root "$env:ROLEFLOW_PRIVATE_ROOT" `
  --profile "$env:ROLEFLOW_PRIVATE_ROOT\input\confirmed-profile.private.json" `
  --matching-card "$env:ROLEFLOW_PRIVATE_ROOT\input\confirmed-card.private.json" `
  --jobs "$env:ROLEFLOW_PRIVATE_ROOT\input\jobs.private.json" `
  --labels "$env:ROLEFLOW_PRIVATE_ROOT\labels\jobs.reviewed.json" `
  --model-settings-root 'D:\Guo\ZhiPing' `
  --output "$env:ROLEFLOW_PRIVATE_ROOT\runs\baseline"
```

等待终态并关闭 baseline SQLite 后再运行 candidate。

- [ ] **Step 3: 串行运行 candidate match**

在 candidate worktree 运行相同命令，只将 `--side` 和输出改为 `candidate`。不得共享 SQLite 或未关闭的模型缓存。

- [ ] **Step 4: 离线比较**

清除 live 授权变量后运行：

```powershell
Remove-Item Env:ALLOW_LIVE_MODEL_BENCHMARK -ErrorAction SilentlyContinue
node scripts/private-full-chain-runner.js --compare `
  --baseline "$env:ROLEFLOW_PRIVATE_ROOT\runs\baseline\match-result.json" `
  --candidate "$env:ROLEFLOW_PRIVATE_ROOT\runs\candidate\match-result.json" `
  --report "$env:ROLEFLOW_PRIVATE_ROOT\reports\full-chain-compare.json"
```

Expected: compare 模式不解析 provider、不调用网络。

- [ ] **Step 5: 验收**

必须全部满足：

- `failed/stale/pending === 0`；
- 无 `partial -> primary`；
- `primaryWithoutEvidence === 0`；
- recommendation/bucket accuracy 不低于 baseline；
- hardFalsePlacement/falseHardExclusion 不增加计数或新 ID；
- 无不可接受的逐岗位严重回归；
- 用户已确认 profile/card；
- 身份门禁全部通过。

未通过时保留 `accepted:false` 报告并停止，不进入合并。

---

### Task 7: 候选工作台离线复核

**Files:**
- Private temp DB under: `temp\dashboard\`

- [ ] **Step 1: 启动隔离工作台**

使用随机空闲端口、私有临时数据库和 `--force-mock`，不得使用 8787：

```powershell
$listener=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0)
$listener.Start()
$port=([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()
if($port -eq 8787) { throw 'RANDOM_PORT_COLLIDED_WITH_8787' }
$dashboardProcess=Start-Process -FilePath node `
  -ArgumentList @(
    'src/cli.js','dashboard',
    '--db',"$env:ROLEFLOW_PRIVATE_ROOT\temp\dashboard\jobs.sqlite",
    '--port',"$port",
    '--allow-offline-mock',
    '--force-mock'
  ) `
  -WorkingDirectory 'D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix' `
  -WindowStyle Hidden `
  -PassThru
```

端口通过绑定 `0` 获取，不手填固定端口。启动后必须请求 `http://127.0.0.1:$port/health` 并确认 200，再打开工作台。

- [ ] **Step 2: 上传同一真实 PDF**

在本地工作台上传原始 PDF，检查：

- 页面解析诊断为 `pdf_text_ordered`；
- 章节顺序正确；
- 发送预览不存在姓名、手机号或邮箱；
- 草稿卡出现且未自动确认；
- 未确认卡时扫描被 `MATCHING_CARD_CONFIRMATION_REQUIRED` 阻止；
- 确认后计划依赖更新正常。

此步骤只使用 mock，不访问正式模型或 BOSS。

- [ ] **Step 3: 清理**

关闭随机端口工作台并确认退出：

```powershell
if(-not $dashboardProcess.HasExited) {
  Stop-Process -Id $dashboardProcess.Id
  $dashboardProcess.WaitForExit()
}
if(Get-Process -Id $dashboardProcess.Id -ErrorAction SilentlyContinue) {
  throw 'DASHBOARD_PROCESS_STILL_RUNNING'
}
```

解析并验证删除目标都位于 `$env:ROLEFLOW_PRIVATE_ROOT\temp\dashboard` 后，删除本任务创建的临时 SQLite、WAL/SHM 和页面渲染临时文件；保留正式私有结果和报告。

---

### Task 8: 最终报告、提交与推送

**Files:**
- Create: `docs/superpowers/reports/2026-07-25-private-full-chain-acceptance-summary.md`

- [ ] **Step 1: 写非敏感摘要**

只记录：

- baseline/candidate/runner 提交；
- 模型 provider 与模型名，不记录 endpoint 或 Key；
- 样本总数；
- 聚合指标和 accepted 结论；
- profile/card 已由用户确认；
- PDF 顺序、隐私门、工作台复核结果；
- 未触碰主数据库、8787 和招聘平台写操作的边界确认；
- 私有完整报告所在目录，不记录原始文件名、公司、岗位 URL 或逐岗位正文。

- [ ] **Step 2: 最终离线验证**

Run:

```powershell
npm.cmd test
git diff --check
git status --short
```

Expected: 46 项全过，diff-check 无输出；提交前仅新增非敏感摘要。

- [ ] **Step 3: 提交并推送**

```powershell
git add docs/superpowers/reports/2026-07-25-private-full-chain-acceptance-summary.md
git commit -m "docs: record private full-chain acceptance"
git push
```

Expected: GitHub 只得到代码、脱敏测试和非敏感摘要；私有根未被 Git 跟踪。

- [ ] **Step 4: 合并决策**

只有 compare `accepted:true`、用户确认画像/卡片且工作台复核通过后，才使用 `finishing-a-development-branch` skill 向用户给出保留分支、PR 或合并选项。不得自动合并到 `D:\Guo\ZhiPing`。

## 子任务与模型分配建议

- Task 1 baseline 拓扑/共享 blob：`gpt-5.6-terra`，medium；只读/机械 Git 核对，冲突即停。
- Task 2 本地 prepare：主会话执行；涉及私有资料，不委派。
- Task 3 profile/card live：主会话执行；涉及正式模型和用户确认，不委派。
- Task 4 BOSS 只读采集：主会话执行；涉及登录态和账号安全，不委派。
- Task 5 标签建议可交 `gpt-5.6-sol`，medium，但只接收已遮盖画像和私有 JD；主会话逐条复核后再展示用户。
- Task 6 双跑与比较：主会话串行执行，不委派并发模型调用。
- Task 7 离线工作台复核可交 `gpt-5.6-terra`，medium；不得访问 BOSS 或正式模型。
- Task 8 报告初稿可交 `gpt-5.6-terra`，low；主会话负责隐私检查、测试、提交和推送。
