# 私有验收岗位池迁移证明设计

## 背景与根因

多分支匹配的离线实现已经完成，下一步需要用用户确认的真实候选人证据和新确认的 20 条岗位池做真实模型验收。现有 `confirmed-evidence-portability.v1/v2` 把两类事实错误地绑在一起：候选人证据是否仍是同一份，以及本轮岗位池与人工预期是否独立确认并冻结。

现场 SHA-256 证明，旧 v1 私有包和本轮目标包的 `confirmed-profile.private.json`、`confirmed-card.private.json`、`resume.redacted.txt`、`identity.private.json` 四份候选人证据逐字节相同；变化的是用户重新确认的 `jobs.private.json` 与 `jobs.reviewed.json`。旧证明强制岗位文件也相同，因此拒绝了合法的新岗位池。

旧证明还要求 `src/core/llm_analyzer.js` 在源提交和目标产品提交中 Git blob 相同。但目标提交恰好修复了 `matchJob` 使用 `jobUnderstanding` 进行契约校验的生产接线；它属于被评估的匹配代码，不是候选人证据生成代码。

## 目标与非目标

目标：

- 保留已确认候选人证据的逐字节身份，不重新生成画像或匹配卡；
- 允许使用一套不同但已确认、冻结并哈希绑定的新岗位池和标签；
- 在读取模型设置、初始化 provider、打开 SQLite 或调用模型之前完成全部校验；
- 旧 v1/v2 证明继续按原规则验证；
- 证明只保存哈希、版本、提交和确认标识，不保存私有正文。

非目标：不修改岗位提示词、评分、分桶或召回规则；不访问 BOSS、主数据库或 8787；不重新解析 PDF；不复用旧模型输出缓存。

## 采用方案：`confirmed-evidence-portability.v3`

v3 把“候选人证据身份”和“目标岗位夹具身份”分开证明。重新生成画像会引入新的模型输出和重复人工确认；手工改 manifest 缺少机器校验；继续绑定 `llm_analyzer.js` 则无法评估匹配接线变化，因此均不采用。

### 必须逐字节相同的候选人证据

源包与目标包的以下原始文件字节必须完全相同：

- `input/confirmed-profile.private.json`
- `input/confirmed-card.private.json`
- `input/resume.redacted.txt`
- `input/identity.private.json`

同时继续验证画像确认链、匹配卡确认链、简历和身份清单哈希、模型身份哈希、确认 ID、确认时间及源产品提交。

### 可以变化但必须独立确认的岗位夹具

源岗位与源标签按自身文件解析；目标岗位与目标标签必须另行解析，不能用源岗位对象验证目标标签。目标夹具必须通过现有 `privateJobsAndLabels` 全部校验，并满足：

- `labelsVersion === "private-real-jd-labels.v2"`；
- `evaluationPolicy === "recall-first.v1"`；
- `userConfirmed === true` 且 `confirmedAt` 是有效时间；
- 岗位 ID 与标签 ID 唯一且集合完全一致；
- 每条岗位的冻结结构、JD 长度和 `sourceContentHash` 合法；
- 标签的 `jobsSha256` 精确绑定目标岗位数组。

v3 只迁移候选人证据，不把源岗位池误当成目标岗位池的来源。证明记录 `targetJobsFileSha256`、`targetLabelsFileSha256`、`targetFixtureTotal`、`targetLabelsVersion`、`targetEvaluationPolicy` 和 `targetLabelsConfirmedAt`。目标岗位和标签的原始文件哈希负责冻结准确字节，标签内的 `jobsSha256` 继续负责绑定规范化岗位数组。证明生成后，目标岗位或标签的任一字节变化都必须在模型初始化前失败。

### 代码来源绑定

v3 只绑定真正决定候选人证据含义的三个文件：

- `src/core/profile_onboarding.js`：画像生成与确认结构；
- `src/core/matching_card.js`：匹配卡生成与确认结构；
- `src/core/search_plan.js`：把确认画像和匹配卡转换为运行时匹配输入。

`src/core/llm_analyzer.js` 不再作为 v3 的不可变证据文件，因为它负责模型输出的契约校验，正属于被评估的匹配管线。真实运行仍由 manifest、产品提交、评估提交、共享 runner blob 和结果身份字段绑定实际执行版本。

旧 v1/v2 继续使用原来的四字段 `consumerCodeBlobs`；只有 v3 使用三字段结构。

## 结构、兼容与失败顺序

验证器按 `proofVersion` 使用精确字段集合：v1 表示同岗位同标签；v2 表示同岗位从 v1 标签迁移到已确认的 recall-first v2 标签；v3 表示同候选人证据迁移到独立确认的 recall-first v2 岗位夹具。未知字段、缺字段、未知版本或 `proofSha256` 不一致一律拒绝。

创建 v3 必须显式传入 `--proof-version confirmed-evidence-portability.v3`。未传参数时维持现有 v1/v2 自动判定；旧证明因岗位或代码 blob 不一致而失败时，绝不能自动回退到 v3。

执行顺序为：参数与空输出检查；源/目标 manifest 和提交绑定；四份候选人证据字节比较；源/目标夹具独立验证；候选人确认链和 v3 三个代码 blob 验证；写入无正文证明。`match-live` 在设置、provider、SQLite 和模型访问前重复验证证明、目标文件与提交。失败统一返回 `PRIVATE_FULL_CHAIN_PORTABILITY_INVALID`，不创建 live 结果。

校验器只能读取每个目标文件一次，并从刚刚计算哈希的原始字节解析画像、匹配卡、岗位和标签；`runPrivateFullChain` 必须直接使用校验器返回的 `profileInput`、`cardInput` 和 `fixture`。不得先解析一份对象、随后哈希第二次读取的字节、最后又把第一份对象交给模型，以免文件在检查与使用之间被替换。

## 离线测试

测试必须证明：

- 旧 v1/v2 创建和验证不回退；
- 相同候选人证据加不同但已确认的目标岗位/标签可生成 v3；
- 未显式指定 v3 时，不得因旧证明失败而自动放宽；
- 未确认标签、错误 policy、错误 `jobsSha256`、岗位/标签 ID 不一致均失败；
- 画像、卡、简历或身份清单任一变化均失败；
- 三个 v3 证据代码 blob 任一变化均失败；
- 只有 `llm_analyzer.js` blob 不同仍可生成 v3；
- 证明生成后篡改目标岗位、目标标签、提交或自哈希均在模型初始化前失败；
- 实际运行使用的画像、匹配卡和岗位夹具必须来自同一批已哈希字节，覆盖检查后替换文件的竞态；
- 证明 JSON 不包含姓名、电话、邮箱、简历正文、JD 正文或标签理由。

## 后续真实验收

保留已经失败的 `multi-track-recall-first-3-20260730` 目录作为诊断证据，不覆盖或删除。升级 runner 并镜像基线后，使用新的私有根目录重新初始化并生成 v3 证明。先运行岗位 4、9、10；确认多分支选择、普通岗位不误拆、无失败/待处理且仍为每条两次模型调用后，再从空缓存运行完整 20 条。
