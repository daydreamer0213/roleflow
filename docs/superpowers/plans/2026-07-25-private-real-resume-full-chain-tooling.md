# 私有真实简历完整链路工具 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复招聘平台 PDF 的阅读顺序，并提供一个默认离线、显式授权、只读正式模型配置的私有完整链路执行器。

**Architecture:** PDF 解析和隐私遮盖放在生产共享入口，工作台、CLI 与验收工具使用同一行为。私有 runner 只负责编排，复用现有画像、匹配卡、岗位分析和模型配置函数；真实材料与输出全部位于仓库外，Git 只保存代码和脱敏测试。

**Tech Stack:** Node.js 22.5+、CommonJS、`pdfjs-dist`、SQLite、现有 OpenAI-compatible 模型适配器、assert-based smoke tests。

## Global Constraints

- 实施 worktree 固定为 `D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix`，分支固定为 `codex/claude-generic-evidence-matching-live-fix`。
- 不修改 `D:\Guo\ZhiPing` 的代码，不读写其 `data/jobs.sqlite`，不启动或操作 8787。
- 离线实现阶段不得访问 BOSS 或其他招聘平台，不得读取正式模型设置内容，不得调用真实模型。
- 原始 PDF、身份清单、已遮盖正文、真实 JD、真实公司名、URL 和完整模型输出不得进入 Git。
- 生成的私有文件必须位于 `D:\DevData\RoleFlow-private-benchmark\`；原始 PDF 只允许使用用户显式提供的绝对路径。
- 任何模型调用前必须完成路径、提交、工作树、授权、身份遮盖和 provider 门禁；失败时 provider 解析次数必须为 0。
- 生产路径不新增 Python、Poppler、OCR 服务或操作系统级安装要求。
- 保留现有 5MB、60,000 字符、30 秒解析超时、扫描件提示和内容质量检查。
- 先写失败测试，再写最小实现；每个任务独立提交，不 amend 既有提交。
- `tests/run_all.js` 只在最终集成任务统一修改，避免并行子任务冲突。
- 本计划完成并全量离线测试通过前，不得执行受控验收运行计划。

---

### Task 1: 按页面坐标恢复 PDF 阅读顺序

**Files:**
- Create: `src/core/pdf_text.js`
- Create: `tests/resume_parser_pdf_order_smoke.js`
- Modify: `src/core/resume_parser.js`
- Modify: `tests/model_parser_resilience_smoke.js`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `Buffer` 形式的文字型 PDF。
- Produces: `extractPdfTextInReadingOrder(buffer, { loadDocument, timeoutMs } = {}) -> Promise<string>`。
- Produces: `orderPageTextItems(items) -> string`，只用于模块内部和脱敏测试。
- Keeps: `parseResumeUpload({ fileName, buffer, root })` 的公开契约不变。

- [ ] **Step 1: 写坐标乱序 PDF 的失败回归**

在 `tests/resume_parser_pdf_order_smoke.js` 中创建一个完全脱敏的两页 ASCII PDF。内容流故意先写低处文字、再写高处文字，但坐标表达正确视觉顺序：

```js
const expectedOrder = [
  "Sanitized Candidate",
  "Summary",
  "Skills",
  "Experience",
  "Example Company",
  "Project",
  "Project Alpha",
  "Alpha body",
  "Project Beta",
  "Beta body",
  "Education",
  "Certificate"
];

const parsed = await parseResumeUpload({
  fileName: "sanitized-platform-resume.pdf",
  buffer: makeTwoPageOutOfOrderPdf(),
  root
});

let cursor = -1;
for (const marker of expectedOrder) {
  const next = parsed.text.indexOf(marker);
  assert(next > cursor, `${marker} 必须按视觉顺序出现`);
  cursor = next;
}
assert.strictEqual(parsed.diagnostics.extractionMethod, "pdf_text_ordered");
assert.strictEqual(parsed.textTruncated, false);
```

`makeTwoPageOutOfOrderPdf()` 使用现有 smoke 中的最小 PDF/xref 写法，第一页内容流按 `Example Company -> Sanitized Candidate -> Experience -> Skills -> Summary` 写入，第二页按 `Education -> Project Beta -> Alpha body -> Project Alpha -> Beta body -> Certificate` 写入；各段的 `Tm`/`Td` 纵坐标则表达上面的 `expectedOrder`。

- [ ] **Step 2: 运行测试证明旧解析器失败**

Run:

```powershell
node tests/resume_parser_pdf_order_smoke.js
```

Expected: 非零退出，失败信息至少包含 `Sanitized Candidate 必须按视觉顺序出现` 或后续顺序断言；不得因短文本、乱码或 PDF 无效失败。

- [ ] **Step 3: 用直接依赖替换无坐标排序的封装**

将 `package.json` 中：

```json
"pdf-parse": "2.4.5"
```

替换为：

```json
"pdfjs-dist": "5.4.296"
```

使用项目在 `D:` 上的 npm 缓存更新 lockfile：

```powershell
$env:NPM_CONFIG_CACHE='D:\DevData\npm-cache'
npm.cmd install --package-lock-only --ignore-scripts --offline
```

Expected: `package-lock.json` 的根依赖为 `pdfjs-dist: 5.4.296`，不再把 `pdf-parse` 作为根依赖。

- [ ] **Step 4: 实现坐标排序**

在 `src/core/pdf_text.js` 中实现：

```js
const DEFAULT_TIMEOUT_MS = 30_000;

function timeoutError(code, timeoutMs) {
  const error = new Error(`${code} after ${timeoutMs}ms`);
  error.code = code;
  return error;
}

async function withTimeout(promise, timeoutMs, code) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeoutError(code, timeoutMs)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function defaultLoadDocument(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjs.getDocument({
    data: new Uint8Array(buffer),
    disableWorker: true,
    useSystemFonts: true
  });
}

async function extractPdfTextInReadingOrder(
  buffer,
  { loadDocument = defaultLoadDocument, timeoutMs = DEFAULT_TIMEOUT_MS } = {}
) {
  const loadingTask = await loadDocument(buffer);
  let document;
  try {
    document = await withTimeout(loadingTask.promise, timeoutMs, "RESUME_PDF_TIMEOUT");
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await withTimeout(page.getTextContent(), timeoutMs, "RESUME_PDF_TIMEOUT");
      pages.push(orderPageTextItems(content.items));
      page.cleanup();
    }
    return pages.filter(Boolean).join("\n\n");
  } finally {
    if (typeof loadingTask?.destroy === "function") await loadingTask.destroy();
    else if (typeof document?.destroy === "function") await document.destroy();
  }
}
```

`orderPageTextItems(items)` 必须：

1. 丢弃没有非空 `str` 或没有有效坐标的项；
2. 将 `transform[4]` 作为 `x`、`transform[5]` 作为 `y`；
3. 使用该页文字高度中位数计算行容差，最小 2pt，最大 8pt；
4. 按 `y` 从大到小确定视觉行；
5. 同一行按 `x` 从小到大排列；
6. 相邻项有明显横向间隔时插入一个空格；
7. 行之间使用 `\n`，页面之间使用 `\n\n`；
8. 不生成 `-- 1 of 2 --` 一类页码标记。

在 `src/core/resume_parser.js` 中删除 `PDFParse` 依赖，将内部 `extractPdfText()` 委托给 `extractPdfTextInReadingOrder()`，并将 `extractionMethod` 改为 `pdf_text_ordered`。原有错误码、超时映射、OCR 提示和 `createResumeDocument()` 保持不变。

- [ ] **Step 5: 更新超时与资源释放测试**

在 `tests/model_parser_resilience_smoke.js` 中不再 mock `pdf-parse`。改为直接测试 `extractPdfTextInReadingOrder()` 的可注入 `loadDocument`：

```js
let destroyed = 0;
const loadDocument = async () => ({
  promise: new Promise(() => {}),
  destroy: async () => { destroyed += 1; }
});

await assert.rejects(
  () => extractPdfTextInReadingOrder(Buffer.from("pdf"), { loadDocument, timeoutMs: 5 }),
  (error) => error.code === "RESUME_PDF_TIMEOUT"
);
assert.strictEqual(destroyed, 1);
```

另加一个两页 fake document，断言 `getPage(1)`、`getPage(2)`、每页 `cleanup()` 和最终 `destroy()` 恰好调用一次。

- [ ] **Step 6: 运行目标测试**

Run:

```powershell
node tests/resume_parser_pdf_order_smoke.js
node tests/model_parser_resilience_smoke.js
node tests/self_check.js
node tests/onboarding_smoke.js
```

Expected: 四条命令均为 exit 0；第一条输出 `resume_parser_pdf_order_smoke ok`，现有 PDF、DOCX、短 PDF 和上传测试继续通过。

- [ ] **Step 7: 提交**

```powershell
git add package.json package-lock.json src/core/pdf_text.js src/core/resume_parser.js tests/resume_parser_pdf_order_smoke.js tests/model_parser_resilience_smoke.js
git commit -m "fix: preserve visual reading order in platform PDFs"
```

---

### Task 2: 在模型边界严格遮盖真实身份

**Files:**
- Create: `src/core/resume_privacy.js`
- Create: `tests/resume_privacy_smoke.js`
- Modify: `src/core/profile_onboarding.js`
- Modify: `src/dashboard/server.js`
- Modify: `tests/profile_quality_smoke.js`
- Modify: `tests/onboarding_smoke.js`

**Interfaces:**
- Produces: `prepareResumeTextForModel(value, { originalFileName, identity, strict } = {})`。
- Produces: `assertResumeIdentityRedacted(text, identity) -> void`。
- Changes: `analyzeResumeProfile({ modelConfig, resume, logger, identity, strictPrivacy, analyzerFactory })`，新增参数均可选。
- Keeps: `profile_onboarding.js` 继续导出 `prepareResumeTextForModel`，现有调用方不破坏。

- [ ] **Step 1: 写姓名与严格门禁失败测试**

在 `tests/resume_privacy_smoke.js` 中覆盖：

```js
const input = [
  "测试候选人",
  "男 | 年龄：26岁 | 13800138000 | candidate@example.com",
  "求职意向：AI应用开发",
  "项目经历",
  "Example Project"
].join("\n");

const prepared = prepareResumeTextForModel(input, {
  originalFileName: "测试候选人-AI应用开发.pdf",
  identity: {
    names: ["测试候选人"],
    phones: ["13800138000"],
    emails: ["candidate@example.com"]
  },
  strict: true
});

assert(!prepared.text.includes("测试候选人"));
assert(!prepared.text.includes("13800138000"));
assert(!prepared.text.includes("candidate@example.com"));
assert(prepared.text.includes("Example Project"));
assert.strictEqual(prepared.redactions.name, 1);
```

另覆盖：

- `姓名：测试候选人` 格式；
- 第一非空行是 2–6 个中文字符且下一行包含年龄/电话/邮箱；
- 文件名为 `测试候选人-AI应用开发 (1).pdf`；
- `identity` 不是对象、`strict=true` 且没有姓名、或遮盖后仍有明确值时抛 `RESUME_PRIVACY_REDACTION_FAILED`；
- 错误对象、日志字段和返回值均不包含原身份值；
- 普通项目名、公司名、技能和时间不被遮盖。

- [ ] **Step 2: 运行测试证明当前实现失败**

Run:

```powershell
node tests/resume_privacy_smoke.js
```

Expected: 非零退出，原因是姓名仍存在、严格身份接口不存在或 `prepareResumeTextForModel` 不接受 options。

- [ ] **Step 3: 抽出共享隐私模块**

在 `src/core/resume_privacy.js` 中迁移现有电话、邮箱、地址、身份证遮盖逻辑，并增加：

```js
const path = require("node:path");

function privacyError(message) {
  const error = new Error(message);
  error.code = "RESUME_PRIVACY_REDACTION_FAILED";
  return error;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeIdentity(value) {
  if (value == null) return { names: [], phones: [], emails: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw privacyError("身份清单格式无效。");
  }
  const clean = (items) => [...new Set((Array.isArray(items) ? items : []).map((item) => String(item || "").trim()).filter(Boolean))];
  return { names: clean(value.names), phones: clean(value.phones), emails: clean(value.emails) };
}

function inferCandidateNames(text, originalFileName) {
  const names = [];
  const labeled = String(text).match(/(?:^|\n)\s*(?:姓名|Name)\s*[：:]\s*([^\n|]{2,20})/i)?.[1]?.trim();
  if (labeled) names.push(labeled);
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (/^[\p{Script=Han}]{2,6}$/u.test(lines[0] || "")
    && /年龄|男|女|1[3-9]\d{9}|@/.test(lines[1] || "")) {
    names.push(lines[0]);
  }
  const stem = path.parse(String(originalFileName || "")).name.replace(/\s*\(\d+\)\s*$/, "");
  const fileHead = stem.split(/[-_—\s]/)[0];
  if (/^[\p{Script=Han}]{2,6}$/u.test(fileHead)) names.push(fileHead);
  return [...new Set(names)];
}

function mergeRedactionCounts(target, source) {
  for (const [name, count] of Object.entries(source || {})) {
    target[name] = (target[name] || 0) + Number(count || 0);
  }
}

function redactExactValues(text, values, label, replacement, redactions) {
  let result = text;
  for (const value of values) {
    const pattern = new RegExp(escapeRegExp(value), "g");
    result = result.replace(pattern, () => {
      redactions[label] = (redactions[label] || 0) + 1;
      return replacement;
    });
  }
  return result;
}

function redactStandardFields(value) {
  let text = value;
  const redactions = {};
  const replace = (pattern, label, replacer) => {
    text = text.replace(pattern, (...args) => {
      redactions[label] = (redactions[label] || 0) + 1;
      return typeof replacer === "function" ? replacer(...args) : replacer;
    });
  };
  replace(/(^|\n)(\s*(?:手机|电话|联系电话|联系方式)\s*[：:]?\s*)[^\n]+/gi, "phone", (_match, line, prefix) => `${line}${prefix}[已隐藏]`);
  replace(/(^|\n)(\s*(?:家庭住址|通讯地址|详细地址|现住址|住址|地址)\s*[：:]?\s*)[^\n]+/gi, "address", (_match, line, prefix) => `${line}${prefix}[已隐藏]`);
  replace(/(?<![\dA-Za-z])(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g, "phone", "[手机号已隐藏]");
  replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "email", "[邮箱已隐藏]");
  replace(/(?<!\d)\d{17}[\dXx](?!\d)/g, "idCard", "[身份证号已隐藏]");
  return { text, redactions };
}

function assertResumeIdentityRedacted(text, identity) {
  const normalized = normalizeIdentity(identity);
  const exactLeak = [...normalized.names, ...normalized.phones, ...normalized.emails]
    .some((value) => String(text).includes(value));
  const patternedLeak = /(?<![\dA-Za-z])(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/.test(text)
    || /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text);
  if (exactLeak || patternedLeak) {
    throw privacyError("简历身份遮盖校验失败。");
  }
}

function prepareResumeTextForModel(
  value,
  { originalFileName = "", identity = null, strict = false } = {}
) {
  const explicit = normalizeIdentity(identity);
  const inferredNames = inferCandidateNames(String(value || ""), originalFileName);
  const names = [...new Set([...explicit.names, ...inferredNames])];
  if (strict && !names.length) {
    throw privacyError("严格隐私模式必须提供或识别候选人姓名。");
  }

  const redactions = {};
  const standard = redactStandardFields(String(value || ""));
  let text = standard.text;
  mergeRedactionCounts(redactions, standard.redactions);
  text = redactExactValues(text, names, "name", "[姓名已隐藏]", redactions);
  text = redactExactValues(text, explicit.phones, "phone", "[手机号已隐藏]", redactions);
  text = redactExactValues(text, explicit.emails, "email", "[邮箱已隐藏]", redactions);
  assertResumeIdentityRedacted(text, { ...explicit, names });
  return { text, preview: text.slice(0, 1200), redactions };
}
```

安全规则：

- 精确身份值先 `trim()`、去重，空值拒绝；
- 使用转义后的字面量正则，不把身份值当作正则表达式；
- `assertResumeIdentityRedacted` 检查显式身份值、手机号模式和邮箱模式；
- 错误消息只包含字段类型和命中数量；
- 不返回或记录原身份值及其可逆变体。

`inferCandidateNames()` 只使用明确的 `姓名:` 行、招聘平台式第一页首行和文件名首段；不得从项目、学校或公司段落猜名字。

- [ ] **Step 4: 调整模型初始化顺序**

在 `src/core/profile_onboarding.js` 中：

```js
async function analyzeResumeProfile({
  modelConfig,
  resume,
  logger = null,
  identity = null,
  strictPrivacy = false,
  analyzerFactory = createLlmAnalyzer
}) {
  const modelInput = prepareResumeTextForModel(resume.text, {
    originalFileName: resume.originalFileName,
    identity,
    strict: strictPrivacy
  });
  const analyzer = analyzerFactory({ modelConfig, logger });
  // 只有通过隐私门后才允许创建适配器和调用模型。
  const rawProfile = await analyzer.analyzeResume({ resumeText: modelInput.text, profileHints: {} });
  // 保留现有 normalizeCandidateProfile 与 diagnostics 行为。
}
```

`analyzeResumeToPlan()` 把同样的 `identity`、`strictPrivacy` 继续传给 `analyzeResumeProfile()`。`profile_onboarding.js` 从新模块导入并继续 re-export `prepareResumeTextForModel`，保持现有测试和工作台接口兼容。

- [ ] **Step 5: 工作台预览和上传使用文件名推断**

在 `src/dashboard/server.js` 的简历预览调用中改为：

```js
const prepared = prepareResumeTextForModel(resume.text, {
  originalFileName: resume.originalFileName
});
```

画像上传和重新解析仍走 `analyzeResumeProfile()`，由生产共享入口执行相同遮盖。页面说明增加“姓名、手机号、邮箱、住址和身份证号会在本地遮盖后再发送模型”，不得声称真实经历、公司和项目也会被删除。

- [ ] **Step 6: 证明隐私失败先于 analyzer 初始化**

在 `tests/resume_privacy_smoke.js` 中使用：

```js
let analyzerFactoryCalls = 0;
await assert.rejects(
  () => analyzeResumeProfile({
    modelConfig: { provider: "openai_compatible" },
    resume: { text: "项目经历足够长但没有可识别姓名。".repeat(10), originalFileName: "resume.pdf" },
    strictPrivacy: true,
    identity: { names: [] },
    analyzerFactory() {
      analyzerFactoryCalls += 1;
      throw new Error("不得到达模型初始化");
    }
  }),
  (error) => error.code === "RESUME_PRIVACY_REDACTION_FAILED"
);
assert.strictEqual(analyzerFactoryCalls, 0);
```

- [ ] **Step 7: 运行目标测试**

Run:

```powershell
node tests/resume_privacy_smoke.js
node tests/profile_quality_smoke.js
node tests/onboarding_smoke.js
node tests/observability_smoke.js
```

Expected: 四条命令均为 exit 0；日志和工作台响应不包含测试手机号、邮箱或姓名。

- [ ] **Step 8: 提交**

```powershell
git add src/core/resume_privacy.js src/core/profile_onboarding.js src/dashboard/server.js tests/resume_privacy_smoke.js tests/profile_quality_smoke.js tests/onboarding_smoke.js
git commit -m "fix: redact resume identity before model initialization"
```

---

### Task 3: 提取可复用的逐行指标与比较门禁

**Files:**
- Create: `scripts/lib/benchmark_metrics.js`
- Modify: `tests/job_match_benchmark.js`
- Modify: `tests/generic_evidence_matching_smoke.js`

**Interfaces:**
- Produces: `deriveBenchmarkMetrics(rows) -> { ok, code?, message?, metrics? }`。
- Produces: `compareBenchmarkResults(baseline, candidate) -> { ok, code?, message?, report? }`。
- Keeps: `require("./job_match_benchmark").compareBenchmarkResults` 的兼容 re-export。
- Keeps: 现有 `sanitized-live-harness.v3` 输入、身份、错误码和验收语义不变。

- [ ] **Step 1: 写“抽取前后结果逐字一致”测试**

在 `tests/generic_evidence_matching_smoke.js` 中保存现有正常对、汇总伪造、rows 截断、非法枚举、标签篡改和 `accepted:false` 用例的完整快照断言，至少核对：

```js
assert.deepStrictEqual(
  Object.keys(result.report).sort(),
  expectedReportKeys.sort()
);
assert.strictEqual(result.report.accepted, false);
assert.deepStrictEqual(result.report.failureReasons, expectedFailureReasons);
```

先让测试引用尚不存在的 `scripts/lib/benchmark_metrics.js`，证明新模块未实现。

- [ ] **Step 2: 运行测试证明失败原因只是不含新模块**

Run:

```powershell
node tests/generic_evidence_matching_smoke.js
```

Expected: 非零退出，包含 `Cannot find module '../scripts/lib/benchmark_metrics'`；不得出现 fixture 业务样本失败。

- [ ] **Step 3: 机械移动比较逻辑**

将以下内容从 `tests/job_match_benchmark.js` 移到 `scripts/lib/benchmark_metrics.js`：

- recommendation/bucket 枚举；
- `deriveBenchmarkMetrics`；
- 行结构检查；
- fixture 集合与冻结标签检查；
- 汇总一致性检查；
- `compareBenchmarkResults`；
- acceptance failure 计算；
- 比较报告对象构建。

新模块不得读取文件、环境变量、Git、模型或网络。`tests/job_match_benchmark.js` 只负责 fixture、live gate、运行与 Markdown/CLI，并从新模块导入后继续：

```js
module.exports = {
  BENCHMARK_HARNESS_VERSION,
  compareBenchmarkResults,
  deriveBenchmarkMetrics
};
```

不得顺便改动任何指标、错误码、校验顺序、浮点比较或 acceptance 规则。

- [ ] **Step 4: 运行回归**

Run:

```powershell
node tests/generic_evidence_matching_smoke.js
node tests/job_match_benchmark.js
```

Expected:

```text
generic_evidence_matching_smoke ok (6 samples)
job_match_benchmark fixtures ok (31)
```

- [ ] **Step 5: 提交**

```powershell
git add scripts/lib/benchmark_metrics.js tests/job_match_benchmark.js tests/generic_evidence_matching_smoke.js
git commit -m "refactor: share benchmark row integrity checks"
```

---

### Task 4: 建立默认离线的私有完整链路 runner

**Files:**
- Create: `scripts/private-full-chain-runner.js`
- Create: `tests/private_full_chain_runner_smoke.js`

**Interfaces:**
- Produces CLI modes: `--init-manifest`、`--prepare`、`--verify-private-bundle`、`--profile-live`、`--card-live`、`--match-live`、`--compare`。
- Produces: `validatePrivateFullChainRequest(options, env, providerResolver)`。
- Produces: `preparePrivateResume(options)`。
- Produces: `comparePrivateFullChainResults(baseline, candidate)`。
- Consumes: `scripts/lib/benchmark_metrics.js`。
- Consumes private identity schema: `{ names: string[], phones: string[], emails: string[] }`。

- [ ] **Step 1: 写纯门禁失败测试**

在 `tests/private_full_chain_runner_smoke.js` 中注入合成 options、env 和 provider，覆盖以下错误码：

```text
PRIVATE_FULL_CHAIN_MODE_REQUIRED
PRIVATE_FULL_CHAIN_PRIVATE_ROOT_REQUIRED
PRIVATE_FULL_CHAIN_PRIVATE_ROOT_FORBIDDEN
PRIVATE_FULL_CHAIN_RESUME_REQUIRED
PRIVATE_FULL_CHAIN_IDENTITY_REQUIRED
PRIVATE_FULL_CHAIN_OUTPUT_REQUIRED
PRIVATE_FULL_CHAIN_NOT_AUTHORIZED
PRIVATE_FULL_CHAIN_MODEL_NOT_AUTHORIZED
PRIVATE_FULL_CHAIN_MODEL_SETTINGS_ROOT_REQUIRED
PRIVATE_FULL_CHAIN_MODEL_SETTINGS_ROOT_FORBIDDEN
PRIVATE_FULL_CHAIN_WORKTREE_DIRTY
PRIVATE_FULL_CHAIN_REAL_MODEL_REQUIRED
PRIVATE_FULL_CHAIN_INPUT_IDENTITY
```

并断言：

```js
assert.strictEqual(providerCalls, 0, "路径、授权或工作树失败时不得解析 provider");
```

允许的私有根固定在规范化后的 `D:\DevData\RoleFlow-private-benchmark\` 下；仓库、主项目 `data`、`.runtime`、用户目录、系统 temp、SQLite 主库和招聘网站 URL 全部拒绝。原始 PDF 是唯一允许来自私有根外的输入，且必须为显式绝对本地文件路径。

- [ ] **Step 2: 运行红灯**

Run:

```powershell
node tests/private_full_chain_runner_smoke.js
```

Expected: 非零退出，原因是 runner 或门禁函数不存在；不得读取真实路径或启动 provider。

- [ ] **Step 3: 实现参数解析和纯门禁**

CLI 约定：

```text
--init-manifest
  --private-root D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725
  --baseline-worktree D:\DevData\RoleFlow-private-benchmark\baseline-worktree-v1
  --candidate-worktree D:\DevData\RoleFlow-worktrees\claude-generic-evidence-matching-live-fix
  --baseline-product-commit <approved-baseline-product-commit>
  --candidate-product-commit <recorded-candidate-product-commit>
  --output D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725\run-manifest.json

--prepare
  --private-root D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725
  --pdf $env:ROLEFLOW_PRIVATE_RESUME_PATH
  --identity D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725\input\identity.private.json
  --output D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725\input

--verify-private-bundle
  --private-root D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725
  --resume-text D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725\input\resume.redacted.txt
  --identity D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725\input\identity.private.json
  --parse-report D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725\input\parse-report.json

--profile-live
  --side baseline|candidate
  --private-root D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725
  --resume-text D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725\input\resume.redacted.txt
  --identity D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725\input\identity.private.json
  --model-settings-root D:\Guo\ZhiPing
  --output D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725\runs\baseline

--card-live
  --side candidate
  --private-root D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725
  --profile D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725\runs\candidate\profile.json
  --model-settings-root D:\Guo\ZhiPing
  --output D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725\runs\candidate

--match-live
  --side baseline|candidate
  --private-root D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725
  --profile D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725\input\confirmed-profile.private.json
  --matching-card D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725\input\confirmed-card.private.json
  --jobs D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725\input\jobs.private.json
  --labels D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725\labels\jobs.reviewed.json
  --model-settings-root D:\Guo\ZhiPing
  --output D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725\runs\baseline

--compare
  --baseline D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725\runs\baseline\match-result.json
  --candidate D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725\runs\candidate\match-result.json
  --report D:\DevData\RoleFlow-private-benchmark\full-chain-v1-20260725\reports\full-chain-compare.json
```

上面用 baseline 展示完整命令形态；candidate 运行只允许把 `--side baseline` 与末尾 `runs\baseline` 同时改为 `candidate`。解析器拒绝其他 side 字符串，也拒绝 side 与输出目录不一致。

授权变量：

```text
ALLOW_PRIVATE_RESUME_BENCHMARK=YES
ALLOW_LIVE_MODEL_BENCHMARK=YES
```

`--prepare` 只要求第一项；三个 `*-live` 同时要求两项；`--init-manifest`、`--verify-private-bundle` 和 `--compare` 不要求模型授权且不得解析 provider。

路径检查、Git HEAD、工作树状态和授权必须先于 `fs.readFileSync(identity)`、模型设置读取、SQLite 创建和 provider 初始化。门禁失败不得创建目录。

runner 顶层不得 require Task 1/2 的 candidate-only 模块。共享 `scripts/lib/private_resume_privacy.js` 只负责 identity schema 与残留 PII 断言，并随 runner/metrics 复制到旧 baseline；`parseResumeUpload`、candidate 产品 `src/core/resume_privacy.js` 和 `buildCandidateMatchCard` 必须在对应 mode 门禁通过后惰性加载，使同一 runner blob 可以在旧 baseline 上执行 `--init-manifest`、`--profile-live`、`--match-live` 和 `--compare`。

- [ ] **Step 4: 实现本地 prepare 模式**

`preparePrivateResume()`：

1. 读取原始 PDF；
2. 调用 `parseResumeUpload()`；
3. 调用 `prepareResumeTextForModel(..., { identity, strict: true })`；
4. 再次调用 `assertResumeIdentityRedacted()`；
5. 只写 `resume.redacted.txt` 和 `parse-report.json`；
6. 不写未遮盖正文、PDF 副本或 PNG。

`parse-report.json` 只包含：

```js
{
  runMode: "private-prepare",
  authorizationGatePassed: true,
  extractionMethod,
  charCount,
  detectedSections,
  missingSections,
  textTruncated,
  redactions,
  resumeContentSha256,
  identityManifestSha256,
  evaluatedCommit
}
```

报告不得包含 preview、原文件名、原始路径、身份值或模型设置路径。

同一任务还实现两个无网络 mode：

- `--init-manifest` 从两个实际 worktree 读取 HEAD、工作树状态和共享文件 blob，并用 Git 分别验证显式 baseline/candidate 产品提交是各自 evaluated HEAD 的真实祖先；任何不一致均失败；
- `--verify-private-bundle` 重新核对已遮盖正文、identity、parse report 的 hash、章节顺序和零敏感值残留，不读取模型配置。

- [ ] **Step 5: 运行 prepare 离线测试**

测试只使用 Task 1 的脱敏坐标乱序 PDF 和合成 identity；断言：

- 输出文本顺序正确；
- 输出不存在合成姓名、电话和邮箱；
- 输出仍包含公司、两个项目和时间；
- 输出只生成两个允许文件；
- providerCalls 为 0；
- identity、PDF 或输出路径失败时无目录产生。

Run:

```powershell
node tests/private_full_chain_runner_smoke.js
```

Expected: `private_full_chain_runner_smoke offline gates ok`，exit 0，无网络。

- [ ] **Step 6: 提交**

```powershell
git add scripts/private-full-chain-runner.js tests/private_full_chain_runner_smoke.js
git commit -m "feat: add private full-chain resume preparation gate"
```

---

### Task 5: 接通画像、匹配卡、岗位分析和比较

**Files:**
- Modify: `scripts/private-full-chain-runner.js`
- Modify: `tests/private_full_chain_runner_smoke.js`

**Interfaces:**
- Consumes production exports: `analyzeResumeProfile`、`buildCandidateMatchCard`、`profileToRuntimeConfigs`、`createJobAnalysisRunner`、`scoreJob`、`decisionState`、`decisionBucket`、`openDb`、`mapWithConcurrency`、`resolveRuntimeModelConfig`。
- Produces private run schema version: `private-full-chain-harness.v1`。
- Produces: `profile.json`、`matching-card-draft.json`、`match-result.json`、`full-chain-compare.json/.md`。

- [ ] **Step 1: 写注入 adapter 的完整离线流程测试**

使用纯合成已遮盖文本、画像、卡片和 4 条 JD，注入 adapter 捕获每次输入：

```js
assert.strictEqual(captured.resumeText.includes("测试候选人"), false);
assert.deepStrictEqual(capturedMatch.candidateProfile, confirmedProfile);
assert.deepStrictEqual(capturedMatch.candidateMatchCard, confirmedCard);
assert.deepStrictEqual(new Set(result.rows.map((row) => row.id)), new Set(labels.map((row) => row.id)));
```

覆盖：

- baseline 与 candidate 的 `resumeContentSha256`、profile、card、JD 集合、labels 和 model identity hash 相同；
- baseline 旧实现可记录 `matchingCardConsumed: false`，candidate 记录 `true`；
- 两侧都通过相同第五参数接收 card，不允许 runner 只给候选侧传卡；
- baseline 缺少 `buildCandidateMatchCard` 时，`--card-live --side baseline` 明确失败 `PRIVATE_FULL_CHAIN_CARD_UNSUPPORTED`；
- `--match-live` 的每个 side 使用独立 SQLite；
- 汇总从 rows 重新派生，伪造汇总、重复 ID、标签篡改和截断 rows 安全失败；
- compare 的身份不同则不生成 accepted 报告；
- 业务门禁不通过时生成 `accepted:false` 诊断报告并以非零退出结束。

- [ ] **Step 2: 运行红灯**

Run:

```powershell
node tests/private_full_chain_runner_smoke.js
```

Expected: 非零退出，原因是 live phase 或 private compare 尚未实现；不得尝试真实网络。

- [ ] **Step 3: 实现 profile-live**

读取 `resume.redacted.txt` 后构造：

```js
const resume = {
  originalFileName: "private-resume.redacted.txt",
  format: "text",
  text: redactedText,
  contentHash: sha256(redactedText),
  diagnostics: { extractionMethod: "private_redacted_text" }
};
```

门禁放行后才调用：

```js
const profile = await analyzeResumeProfile({
  modelConfig,
  resume,
  identity,
  strictPrivacy: true
});
```

结果记录 `side`、提交、模型非敏感身份、已遮盖文本 hash、identity hash 和 profile hash。完整 profile 仅写私有目录。

- [ ] **Step 4: 实现 card-live**

仅 candidate side 调用：

```js
const card = await buildCandidateMatchCard({ modelConfig, profile });
const normalized = normalizeMatchingCard(card, { source: "model" });
```

输出明确为草稿：

```js
{
  status: "draft",
  userConfirmed: false,
  profileSha256,
  card: normalized
}
```

runner 不得自动把草稿改为 confirmed。后续 `--match-live` 只接受私有 envelope 中 `status: "confirmed"`、`userConfirmed: true` 且 profile hash 一致的卡。

- [ ] **Step 5: 实现 match-live**

读取用户确认后的 canonical profile、confirmed card、真实 JD 和冻结 labels。先验证 job ID 集合完全相同，再为每个 side 创建独立 `model-cache.sqlite`。

通过：

```js
const configs = profileToRuntimeConfigs(
  base,
  confirmedProfile,
  searchPlan,
  null,
  confirmedCard
);
```

调用现有 scoring、`decisionState`、`createJobAnalysisRunner` 和 `decisionBucket`。每行只保存岗位 ID、人工标签、推荐、分桶、证据完整性、非敏感解释、状态和错误码；报告不复制完整 JD。

旧基线不消费 matching card 属于被测产品差异。runner 必须记录 `matchingCardProvided: true` 和按 side 探测的 `matchingCardConsumed`，报告不得声称两侧 prompt 完全相同。

- [ ] **Step 6: 实现 private compare**

`comparePrivateFullChainResults()` 先验证：

- 两侧 `runMode=live` 且授权记录为真；
- harness、模型、已遮盖文本、identity、profile、card、JD 集合和 labels hash 相同；
- evaluatedCommit 不同；
- candidate 正确引用 baseline evaluatedCommit；
- 两侧工作树干净；
- rows 可由 `deriveBenchmarkMetrics()` 重算。

再复用现有 acceptance 条件，并额外输出：

- profile side-by-side hash 和人工复核状态；
- card provided/consumed 状态；
- 所有回退、改善、进入/退出 `not_recommended`、进入 `primary` 和 hard blocker 变化的岗位 ID。

- [ ] **Step 7: 运行目标测试**

Run:

```powershell
node tests/private_full_chain_runner_smoke.js
node tests/generic_evidence_matching_smoke.js
node tests/job_match_benchmark.js
node tests/semantic_pipeline_smoke.js
node tests/model_adapter_smoke.js
```

Expected: 五条命令均 exit 0；所有 runner live 流程均使用注入 adapter，正式 provider 解析次数为 0。

- [ ] **Step 8: 提交**

```powershell
git add scripts/private-full-chain-runner.js tests/private_full_chain_runner_smoke.js
git commit -m "feat: run private full-chain model comparisons"
```

---

### Task 6: 登记离线回归、全量验证并推送检查点

**Files:**
- Modify: `tests/run_all.js`
- Modify: `docs/product_spec.md`
- Modify: `docs/daily_workflow.md`

**Interfaces:**
- Adds offline checks: `resume_parser_pdf_order_smoke.js`、`resume_privacy_smoke.js`、`private_full_chain_runner_smoke.js`。
- Keeps: 无参数 `npm.cmd test` 永不读取私有文件、正式模型设置或网络。

- [ ] **Step 1: 登记三条离线 smoke**

在 `tests/run_all.js` 的相关位置加入：

```js
"resume_parser_pdf_order_smoke.js",
"resume_privacy_smoke.js",
"private_full_chain_runner_smoke.js",
```

三条测试必须无参数可运行、使用合成数据并在 120 秒内结束。

- [ ] **Step 2: 更新产品与日常流程文档**

文档只说明：

- 文字型 PDF 按视觉顺序提取；
- 扫描件仍需粘贴文本；
- 模型前本地遮盖姓名和联系方式；
- 匹配卡必须由用户确认；
- 私有完整链路 benchmark 是合并门禁，不是日常扫描命令；
- 真实输入和输出不进入 Git。

不得写真实路径、身份、公司、项目、JD 或模型密钥。

- [ ] **Step 3: 运行目标回归**

Run:

```powershell
node tests/resume_parser_pdf_order_smoke.js
node tests/model_parser_resilience_smoke.js
node tests/resume_privacy_smoke.js
node tests/profile_quality_smoke.js
node tests/onboarding_smoke.js
node tests/private_full_chain_runner_smoke.js
node tests/generic_evidence_matching_smoke.js
node tests/job_match_benchmark.js
```

Expected: 八条均 exit 0。

- [ ] **Step 4: 运行全量离线检查**

Run:

```powershell
npm.cmd test
git diff --check
git status --short
```

Expected:

```text
All 46 offline checks passed.
```

`git diff --check` 无输出；提交前 `git status --short` 只包含 Task 6 的三个文档/登记文件。

- [ ] **Step 5: 提交**

```powershell
git add tests/run_all.js docs/product_spec.md docs/daily_workflow.md
git commit -m "docs: explain private full-chain acceptance workflow"
```

- [ ] **Step 6: 提交后复验**

Run:

```powershell
npm.cmd test
git diff HEAD^ --check
git status --short
git log --oneline -8
```

Expected: 46 项全部通过，diff-check 无输出，工作树干净，Task 1–6 均为普通提交。

- [ ] **Step 7: 推送隔离分支检查点**

Run:

```powershell
git push -u origin codex/claude-generic-evidence-matching-live-fix
```

Expected: 远端分支更新到当前 HEAD，upstream 建立；不推送任何私有输入或输出。

## 并行与模型分配建议

- Task 1（PDF 排序）：`gpt-5.6-sol`，high；涉及 PDF 坐标、超时和资源释放。
- Task 2（隐私门）：`gpt-5.6-sol`，high；涉及模型前信任边界。
- Task 1 与 Task 2 可由不同子任务并行，但都不得修改 `tests/run_all.js`。
- Task 3（机械抽取比较器）：`gpt-5.6-terra`，medium；必须以快照测试证明行为不变。
- Task 4 与 Task 5：同一 runner 文件，必须串行；Task 5 使用 `gpt-5.6-sol`，high。
- Task 6（文档、登记和全量测试）：`gpt-5.6-terra`，low；由主会话最终集成。
- 每个实现任务完成后先做 spec compliance review，再做代码质量 review；主会话独立运行目标测试，不直接相信子任务报告。
