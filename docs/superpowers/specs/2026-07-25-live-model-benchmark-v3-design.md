# 通用证据匹配：真实模型验收 v3 设计

## 状态与边界

本文只定义下一轮真实模型验收应如何构造、比较和判定，不直接修改实现，也不授权任何真实模型调用。

设计与后续实施均在隔离 worktree 中完成，不修改正在使用的主项目 `D:\Guo\ZhiPing`。整个过程不得访问真实 BOSS 或其他招聘平台，不得读写主项目 `data/jobs.sqlite`，不得启动或操作 8787，不得读取真实简历、画像、Cookie 或把正式模型密钥复制进 worktree。

真实模型运行必须在实现、离线测试、fixture 人工复核都完成以后，再由用户针对那次运行明确授权。此前给予过的授权不自动沿用到 v3。

## 为什么 v2 结果不能直接作为产品结论

v2 双跑本身真实执行并正确拒绝了候选结果，但它没有为新匹配流程提供与生产路径等价的候选人输入：

- v2 harness 调用 `profileToRuntimeConfigs(base, candidateProfile, searchPlan)`，没有传入匹配偏好卡；
- 候选实现会把 `candidateMatchCard: configs.matchingCard || null` 交给岗位匹配模型，因此 v2 候选实际收到的是 `null`；
- 候选提示词明确限制：可迁移证据只能来自匹配偏好卡，未覆盖方向不能按强匹配处理；
- v2 脱敏画像缺少完整的教育和经历结构，技能仍主要是简单字符串，项目字段也不足以表达生产路径已有的证据边界；
- 基线旧实现没有匹配卡概念，而候选新实现依赖已确认卡。只给候选空卡，会把“输入缺失”与“新算法质量”混在一起。

所以，v2 的 `accepted:false` 仍然有效，能够证明当时的候选提交不能合并；但 15/31、6 个 failed 和 5 个 hardFalsePlacement 不能单独证明通用证据匹配方案本身失败。v2 结果只保留为历史诊断，不用于 v3 合并结论。

另有一处证据口径需要纠正：对 v2 基线模型缓存的只读复核显示，22 个 `understandJob` 结果中有 8 个出现 `"[object Object]"`，不是报告中的 10 个；缓存保存的是经过当前流程处理的结果，也不能称为模型“原始输出”。它仍能支持“模型曾返回对象数组，而旧兼容逻辑把对象转成字符串”的根因判断，但报告不得夸大证据。

## v3 要回答的唯一问题

在同一模型、同一 JD 样本、同一完整脱敏候选人画像、同一静态匹配偏好卡和同一 harness 下：

> 新的通用证据匹配实现，是否至少保持旧基线的推荐准确率和分桶准确率，同时既不增加“本该硬排除却被放过”，也不增加“本不该硬排除却被误杀”，并满足新契约的完整性要求？

v3 不同时测试“模型能否从简历生成一张好卡”。卡片生成与岗位匹配是两种不同能力：

- v3 使用固定、人工复核的静态卡，只测岗位理解和岗位匹配；
- 未来若要验收卡片生成，应另建独立 benchmark，单独定义卡片事实一致性、遗漏率和幻觉率；
- 不允许在 v3 每次运行前实时调用模型生成卡，否则两侧输入不同、结果不可复现，也无法判断回归来自卡片还是岗位匹配。

## 候选实现进入 v3 前必须完成的三项修复

### 1. 给 `understandJob` 明确的契约修复指令

当前 `matchJob` 提示词已明确说明如何处理 `contractRepair`，但 `understandJob` 没有对应指令。仅把校验错误写得更详细，不能保证真实模型会读取并修复指定字段。

`understandJob` 提示词必须补充：

- 输入含 `contractRepair` 时，读取 `contractRepair.invalidOutput`；
- 只修复 `contractRepair.reason` 指出的字段；
- 返回完整 JSON，而不是局部补丁；
- 不得改变已正确的事实，也不得为通过校验而编造 JD 内容；
- 仍只允许一次契约修复，失败后进入现有失败路径。

提示词测试必须断言该指令真实存在，并用注入模型覆盖一次失败、一次修复成功及修复后仍非法三条路径。

### 2. 提升分析管线版本，避免复用旧缓存

本轮已经实质修改了 `understandJob` 和 `matchJob` 的提示词与判定语义，但当前版本仍是：

- `job-understanding-v5`
- `match-decision-v12`

实施时必须分别升级到新的唯一版本，例如：

- `job-understanding-v6`
- `match-decision-v13`

版本号最终以实施分支当时的 HEAD 为准，不得与已有版本重复。测试必须证明旧分析会因管线版本变化变为 stale，旧模型缓存不会被新运行误用。

### 3. 收窄“硬性措辞”等于“不可替代核心要求”的规则

“必须、精通、掌握”等措辞是重要信号，但“要求熟悉”“需要理解”不能在所有上下文中自动得到 `indispensable=true`。例如“需要理解业务”常常只是工作背景或愿望清单，未必是该岗位唯一且不可替代的核心能力。

新的判断规则为：

- 措辞只能作为重要性信号，不能单独决定 `indispensable`；
- 只有该要求直接服务于岗位持续承担的核心工作，并且 JD 将其表达为不可替代条件时，才可标为 `indispensable=true`；
- 年限仍只进入 `senioritySignal`，不得仅凭年限形成硬阻断；
- 学历或资格信息缺失属于 `unknown/review`，只有候选人明确不满足且 JD 明确为资格门槛时才可形成 `eligibility` 阻断；
- 普通“需要理解业务”、工具罗列、平台偏好和“优先/加分”不得自动形成 `indispensable_core`。

至少增加以下回归样本：

1. “核心工作是独立开发 Java/Spring 服务，必须熟练 Java”可判不可替代核心要求；
2. “负责 AI 应用交付，需要理解客户业务”中的“理解业务”不得仅凭该短语变成硬阻断；
3. “要求熟悉某平台，优先有相关经验”不得自动升级为硬阻断；
4. 年限不足和学历信息缺失仍走软信号或待确认，不得直接 `skip`。

## v3 脱敏输入

### 完整脱敏画像

修改 `tests/fixtures/live_benchmark_profile.json`，让它保持完全虚构、无个人身份信息，同时具备与生产画像一致的结构：

- 稳定且明确为测试用途的 `id`；
- 目标方向与工作偏好；
- 结构化教育经历；
- 结构化工作或项目经历；
- 对象形式的技能信息；
- 项目名称、职责边界、使用技术、可公开陈述内容和结果；
- 明确区分“做过”“参与过”“了解”和“没有证据”；
- 与搜索计划、简历版本、静态卡中的事实完全一致。

不得为了让 31 个样本更容易通过而临时发明能力。画像只能把 v2 原本想表达、但结构不完整的脱敏事实补齐；若新增任何事实，必须在实现交接中逐项列出来源和理由，供用户在 live 运行前确认。

`tests/fixtures/live_benchmark_resume_versions.json` 仅在结构一致性确有需要时调整，继续保持完全脱敏，不放入真实简历正文。

### 静态、人工复核的匹配偏好卡

新增 `tests/fixtures/live_benchmark_matching_card.json`。为避免把 benchmark 身份元数据误送给模型，文件采用固定信封结构：

```json
{
  "id": "live_benchmark_sanitized_matching_card",
  "profileId": "live_benchmark_sanitized_profile",
  "resumeVersionIds": ["..."],
  "card": {
    "targetDirections": [],
    "strongEvidence": [],
    "transferableCapabilities": [],
    "cautionTransitions": [],
    "userNotes": [],
    "source": "user"
  }
}
```

harness 校验信封中的关联标识，只把 `card` 传入 `profileToRuntimeConfigs`。`card` 的字段、条数限制和文本限制必须通过现有匹配卡规范化契约，不能为 benchmark 发明第二套卡片结构。

卡片至少表达：

- 稳定测试 ID；
- `targetDirections`；
- `strongEvidence`；
- 带能力边界的 `transferableCapabilities`；
- `cautionTransitions`；
- `userNotes`，默认留空，除非有明确产品策略需要；
- 与画像和脱敏简历版本的关联标识。

卡片可以表达画像已证明的 Python、FastAPI、RAG、Agent、工作流编排、质量复核等证据，但不得把没有明确事实支撑的模型评估体系、异常降级、复杂生产运维或某行业经验写成已有能力。可迁移项必须同时写清相似点和限制。

实现完成后，先向用户展示画像和卡片的人类可读摘要。用户确认 fixture 没有夸大能力后，才可请求真实模型运行授权。

## harness v3

### 版本与白名单

`tests/job_match_benchmark.js` 升级为：

```text
sanitized-live-harness.v3
```

真实运行只允许读取仓库内固定白名单中的：

- `tests/fixtures/live_benchmark_profile.json`
- `tests/fixtures/live_benchmark_resume_versions.json`
- `tests/fixtures/live_benchmark_matching_card.json`
- 现有固定 JD benchmark fixture

仍须拒绝真实画像、真实简历、主数据库、招聘网站 URL、仓库内输出目录、用户目录和系统临时目录。模型 provider 的解析必须保持在全部授权与路径门禁之后。

### 运行时接线

harness 加载静态卡后，用同一个调用形态运行两侧：

```js
profileToRuntimeConfigs(
  base,
  candidateProfile,
  searchPlan,
  null,
  matchingCard
)
```

旧基线函数只有四个形参，JavaScript 会安全忽略第五个参数；候选实现会使用第五个参数。两侧仍读取完全相同的画像、卡片和 JD fixture。这是在相同输入下比较“旧流程”与“新增已确认卡流程”的预期差异，不是给候选单独换样本。

### 结果身份

每份 live 结果必须记录：

- `runMode: "live"`；
- `authorizationGatePassed: true`；
- `benchmarkHarnessVersion`；
- `evaluatedCommit`；
- `baselineBehaviorCommit`；
- `fixtureProfileId`；
- `fixtureProfileSha256`；
- `fixtureResumeVersionsSha256`；
- `fixtureMatchingCardId`；
- `fixtureMatchingCardSha256`；
- JD fixture 集合的稳定摘要；
- 当前模型配置的非敏感身份，例如 provider、模型名和参数摘要，不记录密钥；
- 原有完整性、准确率和硬误杀指标。

`fixtureMatchingCardSha256` 直接按匹配卡 fixture 的原始文件字节计算 SHA-256，使旧基线也能使用相同算法验证输入；不得依赖仅存在于候选分支的业务模块。

### 比较器身份门禁

离线比较器在计算准确率前，必须拒绝以下任一情况：

- 两侧不是 `runMode=live` 或授权记录不完整；
- harness 版本不同；
- `evaluatedCommit` 相同；
- candidate 没有正确引用 baseline 的行为提交；
- profile ID、profile SHA-256 或 resume versions SHA-256 不同；
- matching card ID 或 SHA-256 不同；
- JD fixture 集合不同；
- 任一关键指标缺失；
- 任一工作树在运行时不干净。

只要 harness、画像、卡片或 JD fixture 任一内容发生变化，旧 live 结果立即失效，必须两侧重跑；不得拿 v2 结果与 v3 结果直接比较。

## 基线与候选分支拓扑

v3 必须生成两个新的、可审计的运行提交：

1. **v3 基线**：从已推送的 v2 基线提交
   `e9689627540d1cbc419a7a06853ffea986115ff0`
   建立，只加入 v3 harness 和三份脱敏输入，不带候选算法修复；
2. **v3 候选**：从当前 live-fix 分支继续，完成三项前置修复和 v3 harness/fixture 接线。

两侧以下文件必须是逐字节相同的 Git blob：

- `tests/job_match_benchmark.js`
- `tests/fixtures/live_benchmark_profile.json`
- `tests/fixtures/live_benchmark_resume_versions.json`
- `tests/fixtures/live_benchmark_matching_card.json`
- benchmark 使用的 JD fixture

运行元数据必须保存两个提交哈希和这些 blob/hash 身份。两侧使用同一个正式模型配置、同一模型参数，并按串行顺序分别运行。

## 离线测试与失败模式

真实模型调用前，至少完成：

- 匹配卡 fixture 缺失、路径错误、ID 缺失时安全失败；
- 匹配卡路径指向白名单外或真实文件时安全失败；
- profile/card/JD 身份或 hash 不一致时比较失败；
- 同一提交伪装双跑时比较失败；
- harness 版本不一致时比较失败；
- 未授权、mock provider、缺输出目录、危险输出目录时在模型初始化前失败；
- `understandJob` 的 `contractRepair` 指令与单次修复行为回归；
- 管线版本升级与 stale/cache 回归；
- “需要理解业务”不是自动硬阻断的回归；
- 现有通用证据匹配、模型契约、工作流和 benchmark smoke 全部通过；
- `npm.cmd test` 全量离线检查通过；
- `git diff --check` 通过，两个运行 worktree 均干净。

这些离线检查不得读取正式模型配置，不得尝试真实网络调用。

## v3 真实运行与验收

输出目录使用新的外部路径，例如：

```text
D:\DevData\RoleFlow-benchmark\live-v3-<run-id>\
```

在 fixture 人工确认、离线测试通过和用户重新明确授权后：

1. 串行运行 v3 baseline；
2. 串行运行 v3 candidate；
3. 每侧都保存 JSON、Markdown、非敏感运行元数据和独立模型缓存；
4. 最后只用离线比较器生成比较报告。

正式模型配置只在获准运行时只读使用。harness 通过显式 `--model-settings-root` 指向获准的正式项目根目录，由现有 `resolveRuntimeModelConfig` 原地读取设置与 DPAPI 密钥；不得把设置文件、加密密钥文件或明文密钥复制进两个 benchmark worktree。该路径不写入结果和日志，只记录去密钥后的模型身份。DPAPI 解密后的密钥只保留在进程内存中，不写入 worktree、结果目录、日志或 Git。

### 必须全部满足的验收条件

- `failed === 0`
- `stale === 0`
- `pending === 0`
- 不存在 `partial -> primary`
- `primaryWithoutEvidence === 0`
- recommendation accuracy 不低于 v3 baseline
- bucket accuracy 不低于 v3 baseline
- `hardFalsePlacement` 不高于 v3 baseline；该兼容字段专指 expectedBucket 为 `not_recommended`、实际却被放入其他桶的“硬排除漏拦”
- candidate 不得新增 baseline 中不存在的 hard-false-placement 样本 ID；不能用“修好一个、漏放另一个”维持相同计数
- 新增 `falseHardExclusion` 指标，专指 expectedBucket 不是 `not_recommended`、实际却进入 `not_recommended` 的“错误硬排除”；其计数不得高于 baseline，也不得新增 baseline 中不存在的样本 ID
- 比较器的身份门禁全部通过

聚合指标通过不等于可以忽略单个严重回归。报告还必须列出逐样本变化，尤其是新增 `skip/not_recommended`、从正确变错误的样本和任何硬阻断变化，供最终人工复核。

三份候选人输入、JD fixture、预期 recommendation/bucket 标签必须在第一次 v3 live 调用前随 harness 一起冻结为提交。看到真实模型结果后不得修改输入或标签并继续沿用同一个 v3 结论；任何修改都要提升 harness 版本并让 baseline/candidate 重新双跑。

## 交付顺序

1. 本设计文档先单独提交并由用户确认；
2. 确认后再编写逐任务实施计划；
3. 完成三项前置修复、v3 fixture 和 harness；
4. 运行全部离线测试并提交；
5. 展示完整脱敏画像与静态卡摘要，等待用户确认；
6. 单独请求 v3 baseline 和 candidate 的真实模型运行授权；
7. 双跑、离线比较并提交最终验收报告；
8. 只有比较器与人工复核都通过后，才讨论是否合并或推送为正式优化版本。

在第 7 步完成前，不得声称真实模型验收已通过；在第 8 步经用户决定前，不得合并到正在使用的主项目。
