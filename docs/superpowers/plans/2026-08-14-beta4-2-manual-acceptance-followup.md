# RoleFlow beta.4.2 人工验收后续整改实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 beta.4.1 人工验收中已真实触发的模型设置引导、关键词展示、抓取进度和自动沟通证据链问题，并在不降低岗位召回和 BOSS 安全边界的前提下形成可再次人工验收的 beta.4.2 候选版本。

**Architecture:** 保留现有 CommonJS、本地设置文件、Windows 加密密钥、服务端 HTML 和固定双 Edge 标签架构。模型配置增加“参数保存”和“两项主模型原子验证”两个明确动作；工作流页面继续消费现有状态快照；沟通链路由页面 DOM `.click()` 改为“页面只核验坐标、Edge Control 发送一次真实鼠标事件、网络日志和页面状态共同判定结果”。

**Tech Stack:** Node.js 22+、CommonJS、原生 HTTP 服务端页面、SQLite、Edge Control bridge/CDP、现有无框架浏览器脚本、Node `assert` 离线 smoke tests。

## Global Constraints

- 当前岗位详情主线只能使用 `trusted_pane`；不得启用、传入、校准或验收 `search_page_api`。
- 不启用 `standalone_detail` 批量详情，不启动 Wave 5，不改写现有扫描架构。
- 不裁剪 Search Plan 的 14 个候选词，不修改 planner 每轮冻结 3 个关键词的现行策略，不降低 JD 覆盖、召回或匹配质量。
- 不增加运行时依赖、前端框架、第三个 BOSS 标签、新 Edge 窗口或第二个 BOSS 会话。
- BOSS 交互保持固定搜索标签和固定消息标签、串行、每岗位最多一次外部点击、登录/风控/目标错位/标签丢失立即停止。
- 当前中断的沟通批次 #1 保持原样；实现和离线验证不得自动恢复、解决或重放其中任何条目。
- 实现阶段不得抓取新岗位，不得发送沟通、消息或申请；任何真实沟通点击仍需用户针对一个不可变岗位再次明确授权。
- API Key 不得进入 HTML、日志、SQLite 或设置 JSON；网络证据持久化前必须移除原始 URL、请求身份字段和响应正文。
- 所有行为修改遵循测试先行；每项完成前运行聚焦回归，最终声明完成前运行完整离线套件和多视口 UI 验收。
- 执行时先用 `using-git-worktrees` 创建 `codex/` 前缀隔离分支；不要直接在当前 `main` 工作区实现。

---

## 文件职责与修改边界

- `src/core/model_settings.js`：模型参数持久化、主模型双配置原子连接验证和密钥回滚。
- `src/dashboard/server.js`：模型设置路由、表单结构、禁用引导和共享字段同步。
- `src/dashboard/view_models/workflow.js`：从不可变 workflow 读取本轮关键词，生成首层采集/JD 文案。
- `src/dashboard/pages/workflow.js`：渲染首层概览和候选词数量说明。
- `src/dashboard/assets/workflow.js`：轮询时更新新增的两个概览字段。
- `src/adapters/browser/edge_control.js`：对 Edge Control 现有网络日志命令做窄接口封装。
- `src/adapters/sites/boss.js`：沟通前最终坐标守卫、一次浏览器级点击、网络与页面证据分类和清理。
- `src/core/communication_executor.js`：把两种可诊断歧义码写入现有条目/批次状态，不改变状态机和数据库结构。
- `src/dashboard/status_labels.js`、`src/dashboard/pages/communication.js`、`src/dashboard/pages/workflow.js`：向用户显示中文处理说明，同时保留技术错误码。
- `tests/*.js`：覆盖原子保存、页面结构、轮询更新、网络命令、一次点击、脱敏和所有沟通结果分支。
- `docs/superpowers/reports/2026-08-13-beta4-manual-acceptance-remediation.md`：将沟通项从“离线已修复”改为本轮真实复现后的准确状态。

### Task 1: 主模型参数保存与双配置原子验证

**Files:**
- Modify: `src/core/model_settings.js:265-395`
- Modify: `src/core/model_settings.js:831-905`
- Modify: `src/core/model_settings.js:1145-1165`
- Test: `tests/model_task_profiles_smoke.js`
- Test: `tests/model_settings_smoke.js`

**Interfaces:**
- Consumes: 现有 `applyTaskProfileInput(settings, profileId, input)`、`effectiveTaskProfile(settings, profileId)`、`secretIdForSettings(settings, profileId)`、`writeSettings(root, settings)` 和 `restoreFile(file, content)`。
- Produces: `saveModelTaskProfileParameters({ root, taskProfile, input, fallbackModelConfig }): ModelSettingsState`。
- Produces: `saveVerifiedPrimaryModelProfiles({ root, input, fallbackModelConfig, connectionTester }): Promise<ModelSettingsState>`。
- `ModelSettingsState` 指现有 `loadModelSettings()` 返回对象，至少包含 `{ source, settings, keyConfigured, keyReadable, keyErrorCode }`，不新增运行时类型系统。
- `saveVerifiedPrimaryModelProfiles` 必须在两项探测都成功后才写共享密钥和设置文件；任何探测或写入失败都保留调用前的设置、密钥和连接状态。

- [ ] **Step 1: 为未验证参数保存和双配置验证写失败测试**

在 `tests/model_task_profiles_smoke.js` 的现有临时目录测试中导入两个新函数，并加入以下断言：

```js
const {
  saveModelTaskProfileParameters,
  saveVerifiedPrimaryModelProfiles
} = require("../src/core/model_settings");

const unverified = saveModelTaskProfileParameters({
  root,
  taskProfile: "batch_screening",
  fallbackModelConfig: fallback,
  input: {
    credentialRef: "shared",
    model: "deepseek-v4-flash",
    timeoutMs: 45000,
    thinkingMode: "disabled",
    reasoningEffort: "high",
    concurrency: 2
  }
});
assert.strictEqual(unverified.settings.taskProfiles.batch_screening.timeoutMs, 45000);
assert.strictEqual(unverified.settings.taskProfiles.batch_screening.connection.status, "unverified");

const probes = [];
const verified = await saveVerifiedPrimaryModelProfiles({
  root,
  fallbackModelConfig: fallback,
  input: { preset: "deepseek", apiKey: "shared-primary-key" },
  connectionTester: async ({ settings }) => {
    probes.push(settings.taskProfile);
    return {
      status: "verified",
      checkedAt: "2026-08-14T08:00:00.000Z",
      latencyMs: settings.taskProfile === "deep_analysis" ? 11 : 13,
      httpStatus: 200
    };
  }
});
assert.deepStrictEqual(probes, ["deep_analysis", "batch_screening"]);
assert.strictEqual(verified.settings.taskProfiles.deep_analysis.connection.status, "verified");
assert.strictEqual(verified.settings.taskProfiles.batch_screening.connection.status, "verified");
```

再构造第二个临时 root：第一次探测成功、第二次抛出 `MODEL_AUTH_FAILED`，断言调用前后的 `model.json` 和共享密钥文件字节完全一致，两项连接状态都没有部分更新。

- [ ] **Step 2: 运行聚焦测试并确认新接口尚不存在**

Run:

```powershell
node tests/model_task_profiles_smoke.js
node tests/model_settings_smoke.js
```

Expected: `saveModelTaskProfileParameters is not a function` 或 `saveVerifiedPrimaryModelProfiles is not a function`。

- [ ] **Step 3: 实现只保存参数且使连接失效的核心动作**

在 `src/core/model_settings.js` 中复用现有规范化和原子写入方法：

```js
function saveModelTaskProfileParameters({ root, taskProfile, input, fallbackModelConfig }) {
  const profileId = normalizeTaskProfileId(taskProfile);
  const current = loadModelSettings({ root, fallbackModelConfig });
  const settings = applyTaskProfileInput(current.settings, profileId, input);
  const targetSecretId = secretIdForSettings(settings, profileId);
  const suppliedKey = settings.taskProfiles[profileId].credentialRef === "independent"
    ? String(input.apiKey || "").trim()
    : "";
  const settingsFile = settingsPath(root);
  const oldSettings = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile) : null;
  const targetFile = targetSecretId ? secretPath(root, targetSecretId) : "";
  const oldSecret = targetFile && fs.existsSync(targetFile) ? fs.readFileSync(targetFile) : null;
  try {
    if (targetSecretId && suppliedKey) saveSecret(root, targetSecretId, suppliedKey);
    writeSettings(root, settings);
  } catch (error) {
    restoreFile(settingsFile, oldSettings);
    if (targetFile) restoreFile(targetFile, oldSecret);
    throw appError("MODEL_SETTINGS_SAVE_FAILED", "模型参数保存失败；原配置已恢复，请重试。", {
      cause: error,
      statusCode: 500
    });
  }
  return loadModelSettings({ root, fallbackModelConfig });
}
```

共享模式下忽略任务卡传来的 `apiKey`；独立模式允许写入对应的 Windows 加密密钥。`applyTaskProfileInput` 已负责把被修改配置的连接状态改为 `unverified`。

- [ ] **Step 4: 实现两项主模型原子连接验证**

增加固定顺序常量和共享凭据应用函数：

```js
const PRIMARY_MODEL_TASK_PROFILES = Object.freeze(["deep_analysis", "batch_screening"]);

function sharedSecretIdForSettings(settings) {
  const normalized = normalizeSettings(settings);
  return secretIdForCredential("model-api-key-shared", normalized.sharedCredential);
}

function applySharedCredentialInput(settings, input = {}) {
  const result = normalizeSettings(settings);
  const presetId = normalizePresetId(input.preset || result.sharedCredential.preset);
  const preset = MODEL_PRESETS[presetId];
  result.sharedCredential = {
    preset: presetId,
    provider: preset.provider,
    baseUrl: presetId === "custom"
      ? normalizeBaseUrl(input.baseUrl || result.sharedCredential.baseUrl)
      : normalizeBaseUrl(preset.baseUrl)
  };
  for (const profileId of PRIMARY_MODEL_TASK_PROFILES) {
    const profile = result.taskProfiles[profileId];
    if (profile.credentialRef !== "shared") continue;
    profile.preset = result.sharedCredential.preset;
    profile.provider = result.sharedCredential.provider;
    profile.baseUrl = result.sharedCredential.baseUrl;
    profile.connection = {
      status: "unverified",
      checkedAt: "",
      latencyMs: null,
      httpStatus: null,
      fingerprint: ""
    };
    profile.revision = profileFingerprint(profile);
  }
  result.revision = settingsFingerprint(result);
  return normalizeSettings(result);
}
```

新增 `saveVerifiedPrimaryModelProfiles`，按以下顺序执行：

```js
async function saveVerifiedPrimaryModelProfiles({
  root,
  input,
  fallbackModelConfig,
  connectionTester = testModelConnection
}) {
  const current = loadModelSettings({ root, fallbackModelConfig });
  const proposed = applySharedCredentialInput(current.settings, input);
  const suppliedSharedKey = String(input.apiKey || "").trim();
  const sharedSecretId = sharedSecretIdForSettings(proposed);
  const sharedKey = suppliedSharedKey
    || (sharedSecretId && inspectSecret(root, sharedSecretId).configured
      ? loadSecret(root, sharedSecretId)
      : "");
  const verifications = {};

  for (const profileId of PRIMARY_MODEL_TASK_PROFILES) {
    const effective = effectiveTaskProfile(proposed, profileId);
    const secretId = secretIdForSettings(proposed, profileId);
    const apiKey = effective.provider === "mock"
      ? ""
      : effective.credentialRef === "shared"
        ? sharedKey
        : secretId && inspectSecret(root, secretId).configured
          ? loadSecret(root, secretId)
          : "";
    if (effective.provider !== "mock" && !apiKey) {
      throw appError("MODEL_KEY_REQUIRED", `${profileId} 缺少可用 API Key。`, { statusCode: 400 });
    }
    verifications[profileId] = effective.provider === "mock"
      ? { status: "verified", checkedAt: new Date().toISOString(), latencyMs: 0, httpStatus: 0 }
      : await connectionTester({ settings: { ...effective, taskProfile: profileId }, apiKey });
  }

  for (const profileId of PRIMARY_MODEL_TASK_PROFILES) {
    const effective = effectiveTaskProfile(proposed, profileId);
    proposed.taskProfiles[profileId].connection = {
      ...verifications[profileId],
      fingerprint: profileFingerprint(effective)
    };
  }
  proposed.revision = settingsFingerprint(proposed);
  const settings = normalizeSettings(proposed);
  const settingsFile = settingsPath(root);
  const oldSettings = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile) : null;
  const targetFile = sharedSecretId ? secretPath(root, sharedSecretId) : "";
  const oldSecret = targetFile && fs.existsSync(targetFile) ? fs.readFileSync(targetFile) : null;
  try {
    if (sharedSecretId && suppliedSharedKey) {
      saveSecret(root, sharedSecretId, suppliedSharedKey);
    }
    writeSettings(root, settings);
  } catch (error) {
    restoreFile(settingsFile, oldSettings);
    if (targetFile) restoreFile(targetFile, oldSecret);
    throw appError("MODEL_SETTINGS_SAVE_FAILED", "模型已验证，但本机配置保存失败；原配置已恢复，请重试。", {
      cause: error,
      statusCode: 500
    });
  }
  return loadModelSettings({ root, fallbackModelConfig });
}
```

导出两个新函数，保留旧导出供兼容测试和备用路径使用。

- [ ] **Step 5: 运行核心模型设置回归**

Run:

```powershell
node tests/model_task_profiles_smoke.js
node tests/model_settings_smoke.js
```

Expected: 两个脚本均输出 `ok`；失败探测用例确认没有部分设置或密钥写入。

- [ ] **Step 6: 提交核心模型设置改动**

```powershell
git add src/core/model_settings.js tests/model_task_profiles_smoke.js tests/model_settings_smoke.js
git commit -m "feat: verify primary model profiles atomically"
```

### Task 2: 顶部共享测试按钮与稳定的新用户引导

**Files:**
- Modify: `src/dashboard/server.js:110-125`
- Modify: `src/dashboard/server.js:515-523`
- Modify: `src/dashboard/server.js:990-1090`
- Modify: `src/dashboard/server.js:3503-3765`
- Test: `tests/model_settings_ui_smoke.js`

**Interfaces:**
- Consumes: Task 1 的 `saveModelTaskProfileParameters` 和 `saveVerifiedPrimaryModelProfiles`。
- Produces: POST `/api/settings/model` 的 `action=verify_primary` 与 `action=save_parameters`。
- Produces: `renderModelSettingsPage({ modelState, searchParams, primaryModelsReady })`；下一步入口始终存在，仅在两项主模型都验证后可点击。

- [ ] **Step 1: 把现有 UI smoke 改成新交互契约**

在 `tests/model_settings_ui_smoke.js` 中将旧的“未验证时不显示下一步”和分别保存深度/批量配置断言替换为：

```js
assert(settingsHtml.includes('name="taskProfile" value="primary_models"'));
assert(settingsHtml.includes('name="action" value="verify_primary"'));
assert(settingsHtml.includes("测试连接并保存"));
assert(settingsHtml.includes('class="settings-next disabled"'));
assert(settingsHtml.includes('aria-disabled="true"'));
assert(settingsHtml.includes('tabindex="-1"'));
assert(settingsHtml.includes("下一步：填写简历"));
assert.strictEqual(
  (settingsHtml.match(/>测试连接并保存<\/button>/g) || []).length,
  1
);
assert(!/model-profile-deep_analysis[\s\S]*value="verify_primary"/.test(settingsHtml));
assert(!/model-profile-batch_screening[\s\S]*value="verify_primary"/.test(settingsHtml));
assert(/model-profile-deep_analysis[\s\S]*value="save_parameters"[\s\S]*>保存模型参数<\/button>/.test(settingsHtml));
assert(/model-profile-batch_screening[\s\S]*value="save_parameters"[\s\S]*>保存模型参数<\/button>/.test(settingsHtml));
```

提交顶部表单一次，记录 `connectionTester` 收到的两个 `taskProfile`；断言重定向为 `/settings?profile=primary_models&modelConfigured=1`，随后页面下一步链接具有真实 `href="/onboarding"` 且没有 `aria-disabled`。

再增加失败用例：批量筛选探测抛错时响应非 303，刷新后两项状态仍是未验证，页面下一步仍禁用。

- [ ] **Step 2: 运行 UI smoke 并确认旧页面契约失败**

Run:

```powershell
node tests/model_settings_ui_smoke.js
```

Expected: 缺少 `verify_primary`、禁用下一步入口或仍存在两个任务卡测试按钮。

- [ ] **Step 3: 扩展模型设置路由动作**

在 `handleModelSettingsSave` 中先按动作分支，再执行单任务超时/并发校验：

```js
if (taskProfile === "primary_models" && action === "verify_primary") {
  const state = await saveVerifiedPrimaryModelProfiles({
    root,
    input: {
      preset: String(params.preset || ""),
      baseUrl: String(params.baseUrl || ""),
      apiKey: String(params.apiKey || "")
    },
    fallbackModelConfig,
    connectionTester
  });
  logger.info("primary_model_profiles_verified", {
    requestId,
    deepAnalysisStatus: state.settings.taskProfiles.deep_analysis.connection.status,
    batchScreeningStatus: state.settings.taskProfiles.batch_screening.connection.status
  });
  return redirect(res, "/settings?profile=primary_models&modelConfigured=1");
}
```

深度分析和批量筛选任务卡只接受 `action=save_parameters`，调用：

```js
const state = saveModelTaskProfileParameters({
  root,
  taskProfile,
  input,
  fallbackModelConfig
});
```

备用模型继续使用现有 `action=save` 和 `saveVerifiedBatchBackup`；恢复推荐值继续使用现有分支。

- [ ] **Step 4: 在共享模块内渲染唯一测试动作和始终存在的下一步**

把共享模块改为一个真实表单：

```js
<form class="settings-shared-form" method="post" action="/api/settings/model">
  <input type="hidden" name="taskProfile" value="primary_models">
  <input type="hidden" name="action" value="verify_primary">
  <div class="settings-grid">
    <label class="settings-field">共享模型厂商
      <select id="shared-model-preset" name="preset">${renderPresetOptions(presets, settings.sharedCredential?.preset || "deepseek")}</select>
    </label>
    <label class="settings-field">共享 API Key
      <input id="shared-model-api-key" name="apiKey" type="password" autocomplete="new-password" placeholder="${modelState.keyConfigured ? "已保存，留空保持不变" : "粘贴 API Key"}">
    </label>
  </div>
  <div class="settings-actions settings-shared-actions">
    <button type="submit">测试连接并保存</button>
    ${nextStep}
  </div>
</form>
```

下一步始终构造：

```js
const nextStep = primaryModelsReady
  ? `<a class="settings-next" href="/onboarding">下一步：填写简历</a>`
  : `<span class="settings-next disabled" aria-disabled="true" tabindex="-1">下一步：填写简历</span><small class="settings-next-hint">请先测试两项主模型连接。</small>`;
```

样式增加 `.settings-next.disabled` 的灰色、非交互外观，并保持文字提示；不要用脚本给禁用元素补导航行为。

- [ ] **Step 5: 把任务卡动作改为参数保存并同步共享字段**

将两个主任务卡按钮改成：

```html
<button name="action" value="save_parameters">保存模型参数</button>
```

保留“恢复推荐值”。在 `modelSettingsClientScript()` 中继续用现有共享厂商同步逻辑，使共享模式任务卡的厂商字段跟随顶部选择；任一主任务表单发生 `input` 或 `change` 时，只提示“保存参数后需重新测试连接”，不在前端伪造已验证状态。

- [ ] **Step 6: 计算两项主模型就绪状态并运行回归**

`/settings` 路由改为：

```js
const primaryModelsReady = modelReady("deep_analysis") && modelReady("batch_screening");
return sendHtml(res, renderModelSettingsPage({
  modelState: getPublicModelSettings(),
  searchParams: url.searchParams,
  primaryModelsReady
}));
```

Run:

```powershell
node tests/model_settings_ui_smoke.js
node tests/model_task_profiles_smoke.js
node tests/onboarding_smoke.js
```

Expected: 三个脚本均输出 `ok`，Key 不出现在 HTML、日志、SQLite 或设置 JSON。

- [ ] **Step 7: 提交模型设置页面改动**

```powershell
git add src/dashboard/server.js tests/model_settings_ui_smoke.js
git commit -m "feat: streamline primary model setup"
```

### Task 3: 本轮实际关键词与首层抓取进度

**Files:**
- Modify: `src/dashboard/view_models/workflow.js:6-110`
- Modify: `src/dashboard/pages/workflow.js:25-65`
- Modify: `src/dashboard/assets/workflow.js:35-85`
- Test: `tests/workflow_page_migration_smoke.js`
- Test: `tests/workflow_dashboard_smoke.js`

**Interfaces:**
- Consumes: `workflow.keywords`、`planner.keywordSource.keywords`、现有 `progress.scanTargets` 和 `progress.details`。
- Produces: `scope.actualKeywords: string[]`、`scope.candidateKeywordCount: number`。
- Produces: `overview.acquisitionProgress: string`、`overview.jdProgress: string`。
- Produces: DOM 更新钩子 `[data-overview-acquisition]` 和 `[data-overview-jd]`。

- [ ] **Step 1: 为 3 个实际词、14 个候选词和首层进度写失败测试**

在 `tests/workflow_page_migration_smoke.js` 的 fixture 中设置：

```js
workflow: {
  id: "workflow-migration-fixture",
  status: "scanning",
  keywords: ["AI应用开发", "RAG", "Agent开发"],
  planner: {
    acquisitionMode: "inherited",
    keywordSource: {
      searchPlanId: 1,
      keywords: Array.from({ length: 14 }, (_, index) => ({ word: `候选词${index + 1}` }))
    },
    platformPolicy: { filterSummary: [], unresolvedParams: [] },
    searchScope: { key: "boss:fixture" }
  }
},
progressSnapshot: {
  progress: {
    scanTargets: { total: 3, completed: 2, pending: 1 },
    details: { collected: 45, read: 38, pending: 7 }
  }
}
```

断言：

```js
assert.deepStrictEqual(vm.scope.actualKeywords, ["AI应用开发", "RAG", "Agent开发"]);
assert.strictEqual(vm.scope.candidateKeywordCount, 14);
assert.strictEqual(vm.overview.acquisitionProgress, "搜索目标 2 / 3 · 已获取 45 个岗位");
assert.strictEqual(vm.overview.jdProgress, "已读取 38 / 45 · 待补 7");
assert(html.includes("本轮实际关键词：AI应用开发、RAG、Agent开发"));
assert(html.includes("方案候选词：14 个"));
assert(!html.includes("候选词1、候选词2"));
assert(html.includes("data-overview-acquisition"));
assert(html.includes("data-overview-jd"));
```

在 `tests/workflow_dashboard_smoke.js` 的轮询脚本测试中把 snapshot 更新为 `completed=3`、`collected=53`、`read=53`、`pending=0`，断言两个首层 DOM 文本同步变为最新值，即使 workflow 状态仍为 `scanning`。

- [ ] **Step 2: 运行工作流页面测试并确认显示来源错误**

Run:

```powershell
node tests/workflow_page_migration_smoke.js
node tests/workflow_dashboard_smoke.js
```

Expected: `actualKeywords`、`candidateKeywordCount` 或两个概览钩子缺失。

- [ ] **Step 3: 修正 view model 数据来源**

将调用改为 `scopeView(planner, workflow)`，并返回两个明确字段：

```js
function scopeView(planner, workflow) {
  if (planner?.acquisitionMode !== "inherited") {
    return { visible: false, filters: [], actualKeywords: [], candidateKeywordCount: 0, unresolved: [] };
  }
  const policy = planner.platformPolicy || {};
  const source = planner.keywordSource || {};
  const region = workRegionLabel(policy);
  return {
    visible: true,
    scopeKey: scopeShortId(planner.searchScope?.key) || "未记录",
    sourcePlanId: String(source.searchPlanId || ""),
    filters: [
      region,
      ...(policy.filterSummary || [])
        .map(String)
        .filter((item) => !item.includes("未解析参数"))
    ].filter(Boolean).filter((item, index, values) => values.indexOf(item) === index),
    actualKeywords: (workflow?.keywords || []).map(String).filter(Boolean),
    candidateKeywordCount: (source.keywords || []).length,
    unresolved: (policy.unresolvedParams || [])
      .map((item) => String(item?.param || ""))
      .filter(Boolean)
  };
}
```

这段代码继续复用文件内现有 `workRegionLabel()` 和 `scopeShortId()`，不新建第二套筛选格式化逻辑。

- [ ] **Step 4: 生成并渲染两个首层进度字段**

在 `overviewView` 中加入：

```js
const scan = progress?.scanTargets || {};
const details = progress?.details || {};
const acquisitionProgress = `搜索目标 ${number(scan.completed)} / ${number(scan.total)} · 已获取 ${number(details.collected)} 个岗位`;
const jdProgress = `已读取 ${number(details.read)} / ${number(details.collected)} · 待补 ${number(details.pending)}`;
```

把两个值放入返回对象。`renderPrimary` 在“整体进度”和“剩余工作”之间渲染：

```js
${primaryField("采集进度", overview.acquisitionProgress, false, "acquisition")}
${primaryField("完整 JD", overview.jdProgress, false, "jd")}
```

`renderScope` 使用：

```js
<p>本轮实际关键词：${escapeHtml((scope.actualKeywords || []).join("、") || "无")}</p>
<p class="hint">方案候选词：${number(scope.candidateKeywordCount)} 个；本轮只展示已冻结执行的关键词。</p>
```

- [ ] **Step 5: 让现有轮询更新新增字段**

在 `src/dashboard/assets/workflow.js` 的 `applySnapshot` 中加入：

```js
const scanTargets = snapshot.progress.scanTargets || {};
const details = snapshot.progress.details || {
  collected: snapshot.progress.detailsCollected,
  read: snapshot.progress.detailsRead,
  pending: snapshot.progress.detailsPending
};
setText(
  "[data-overview-acquisition]",
  "搜索目标 " + number(scanTargets.completed) + " / " + number(scanTargets.total)
    + " · 已获取 " + number(details.collected) + " 个岗位"
);
setText(
  "[data-overview-jd]",
  "已读取 " + number(details.read) + " / " + number(details.collected)
    + " · 待补 " + number(details.pending)
);
```

复用同一函数后面的 `scanTargets` 和 `details` 变量，避免重复声明。

- [ ] **Step 6: 运行工作流回归并提交**

Run:

```powershell
node tests/workflow_page_migration_smoke.js
node tests/workflow_dashboard_smoke.js
node tests/workflow_planner_smoke.js
```

Expected: 三个脚本均输出 `ok`；planner 的每轮 3 个关键词断言保持不变。

```powershell
git add src/dashboard/view_models/workflow.js src/dashboard/pages/workflow.js src/dashboard/assets/workflow.js tests/workflow_page_migration_smoke.js tests/workflow_dashboard_smoke.js
git commit -m "fix: show actual workflow scope and progress"
```

### Task 4: Edge Control 网络日志窄接口

**Files:**
- Modify: `src/adapters/browser/edge_control.js:100-150`
- Test: `tests/browser_transport_smoke.js`

**Interfaces:**
- Produces: `startNetworkLog(tabId, options)`。
- Produces: `readNetworkLog(tabId, options)`。
- Produces: `getNetworkLogMark(tabId)`。
- Produces: `stopNetworkLog(tabId, options)`。
- 四个方法必须把原始数值 `tabId` 原样传给 bridge，不得强制转成字符串。

- [ ] **Step 1: 为四个 bridge 命令和数值 tabId 写失败测试**

在 `tests/browser_transport_smoke.js` 的 Edge adapter 成功路径加入：

```js
const numericTabId = 1995686980;
await edge.startNetworkLog(numericTabId, {
  maxEntries: 12,
  maxBodies: 4,
  maxBodyBytes: 8192,
  resourceTypes: ["XHR", "Fetch"],
  bodyUrlIncludes: ["/wapi/zpgeek/friend/add.json"],
  urlIncludes: ["/wapi/zpchat/config/get", "/wapi/zpgeek/friend/add.json"],
  captureBodies: true,
  clear: true
});
await edge.getNetworkLogMark(numericTabId);
await edge.readNetworkLog(numericTabId, {
  sinceSequence: 7,
  maxEntries: 12,
  includeBodies: true,
  resourceTypes: ["XHR", "Fetch"],
  urlIncludes: ["/wapi/zpchat/config/get", "/wapi/zpgeek/friend/add.json"],
  consume: false
});
await edge.stopNetworkLog(numericTabId, { clear: true, detachIfIdle: false });

const networkRequests = state.edgeRequests.slice(-4);
assert.deepStrictEqual(
  networkRequests.map((request) => request.command),
  ["start_network_log", "get_network_log_mark", "read_network_log", "stop_network_log"]
);
assert(networkRequests.every((request) => request.args.tabId === numericTabId));
```

- [ ] **Step 2: 运行 transport smoke 并确认方法尚不存在**

Run:

```powershell
node tests/browser_transport_smoke.js
```

Expected: `edge.startNetworkLog is not a function`。

- [ ] **Step 3: 实现显式参数白名单封装**

在 `EdgeControlAdapter` 中加入：

```js
async startNetworkLog(tabId, {
  maxEntries,
  maxBodies,
  maxBodyBytes,
  resourceTypes,
  bodyUrlIncludes,
  urlIncludes,
  captureBodies = true,
  clear = true
} = {}) {
  return this.command("start_network_log", compactArgs({
    tabId, maxEntries, maxBodies, maxBodyBytes, resourceTypes,
    bodyUrlIncludes, urlIncludes, captureBodies, clear
  }));
}

async readNetworkLog(tabId, {
  sinceSequence,
  maxEntries,
  includeBodies = true,
  resourceTypes,
  urlIncludes,
  consume = false
} = {}) {
  return this.command("read_network_log", compactArgs({
    tabId, sinceSequence, maxEntries, includeBodies, resourceTypes, urlIncludes, consume
  }));
}

async getNetworkLogMark(tabId) {
  return this.command("get_network_log_mark", { tabId });
}

async stopNetworkLog(tabId, { clear = true, detachIfIdle = false } = {}) {
  return this.command("stop_network_log", { tabId, clear, detachIfIdle });
}
```

文件内新增：

```js
function compactArgs(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
```

该 helper 只删除 `undefined`，不得序列化或转换 `tabId`。

- [ ] **Step 4: 运行 transport 回归并提交**

Run:

```powershell
node tests/browser_transport_smoke.js
```

Expected: `browser_transport_smoke ok`。

```powershell
git add src/adapters/browser/edge_control.js tests/browser_transport_smoke.js
git commit -m "feat: expose bounded Edge network logging"
```

### Task 5: 一次浏览器级沟通点击与可诊断证据链

**Files:**
- Modify: `src/adapters/sites/boss.js:480-735`
- Modify: `src/adapters/sites/boss.js:2115-2240`
- Modify: `src/adapters/sites/boss.js:2891-3065`
- Modify: `src/core/communication_executor.js:230-303`
- Modify: `src/dashboard/status_labels.js`
- Modify: `src/dashboard/pages/communication.js:40-55`
- Modify: `src/dashboard/pages/workflow.js:60-72`
- Test: `tests/boss_communication_page_smoke.js`
- Test: `tests/communication_executor_smoke.js`
- Test: `tests/dashboard_communication_batch_smoke.js`
- Test: `tests/workflow_communication_smoke.js`

**Interfaces:**
- Consumes: Task 4 的四个 Edge 网络日志方法和现有 `browser.clickAt(tabId, point)`。
- Produces: 页面最终守卫结果 `{ ready: true, jobId: string, clickPoint: {x:number,y:number} }`，不执行 DOM `.click()`。
- Produces: `classifyBossCommunicationNetworkLog(log): { state, evidence }`，只返回脱敏 endpoint、HTTP 状态、业务码类别和耗时。
- Produces: 歧义结果可携带 `errorCode`：`COMMUNICATION_ACTION_NOT_TRIGGERED`、`COMMUNICATION_USER_ACTION_REQUIRED` 或 `COMMUNICATION_RESULT_AMBIGUOUS`。
- 不改变 communication item 状态枚举、批次状态机、一次点击账本或数据库 schema。

- [ ] **Step 1: 扩展 fake browser 并写一次真实鼠标点击顺序测试**

在 `tests/boss_communication_page_smoke.js` 的 `fakeBrowser()` 中增加调用记录和实现：

```js
const calls = {
  listTabs: 0,
  createTab: [],
  bringToFront: [],
  navigate: [],
  evalValue: [],
  clickAt: [],
  startNetworkLog: [],
  getNetworkLogMark: [],
  readNetworkLog: [],
  stopNetworkLog: [],
  restoreScroll: []
};

async startNetworkLog(tabId, options) {
  calls.startNetworkLog.push([tabId, options]);
  return { tabId, entries: [], meta: { enabled: true } };
},
async getNetworkLogMark(tabId) {
  calls.getNetworkLogMark.push(tabId);
  return { tabId, mark: { lastSequence: 7, nextSequence: 8 } };
},
async readNetworkLog(tabId, options) {
  calls.readNetworkLog.push([tabId, options]);
  return queuedNetworkLogs.shift() || { tabId, entries: [], meta: { enabled: true } };
},
async stopNetworkLog(tabId, options) {
  calls.stopNetworkLog.push([tabId, options]);
  return { tabId, stopped: true };
},
async clickAt(tabId, point) {
  calls.clickAt.push([tabId, point]);
  transport?.onAction?.(contexts.get(tabId));
}
```

把成功派发断言改为：

```js
assert.strictEqual(executionBrowser.calls.startNetworkLog.length, 1);
assert.strictEqual(executionBrowser.calls.getNetworkLogMark.length, 1);
assert.strictEqual(executionBrowser.calls.clickAt.length, 1);
assert.strictEqual(executionBrowser.calls.guardedClick.length, 1);
assert.strictEqual(executionBrowser.calls.stopNetworkLog.length, 0);
assert(
  executionBrowser.calls.guardedClick[0][1].includes("elementFromPoint"),
  "the final guard must recheck the exact element under the click point"
);
assert(
  !executionBrowser.calls.guardedClick[0][1].includes("candidates[0].click()"),
  "the page guard must not dispatch a DOM click"
);
```

结果核验完成后断言 `stopNetworkLog` 恰好一次且参数为 `{clear:true, detachIfIdle:false}`。

- [ ] **Step 2: 为六种沟通结果和证据脱敏写失败测试**

使用 `queuedNetworkLogs` 分别返回：

```js
const acceptedLog = {
  entries: [{
    sequence: 8,
    url: "https://www.zhipin.com/wapi/zpgeek/friend/add.json?securityId=secret&chatId=private",
    resourceType: "XHR",
    status: 200,
    startedAt: "2026-08-14T08:00:00.000Z",
    completedAt: "2026-08-14T08:00:00.291Z",
    failed: false,
    content: JSON.stringify({ code: 0, zpData: { securityId: "secret" } })
  }]
};
const rejectedLog = {
  entries: [{
    sequence: 8,
    url: "https://www.zhipin.com/wapi/zpgeek/friend/add.json",
    resourceType: "XHR",
    status: 200,
    failed: false,
    content: JSON.stringify({ code: 10003, message: "private platform message" })
  }]
};
const failedLog = {
  entries: [{
    sequence: 8,
    url: "https://www.zhipin.com/wapi/zpgeek/friend/add.json",
    resourceType: "XHR",
    failed: true,
    errorText: "net::ERR_CONNECTION_RESET"
  }]
};
```

覆盖并断言：

- accepted 网络日志 + “继续沟通”页面证据 => `succeeded`；
- rejected 网络日志 => `platform_rejected`；
- failed 网络日志 => `transport_failed`；
- 空日志 + 页面无变化 => `ambiguous` 和 `COMMUNICATION_ACTION_NOT_TRIGGERED`；
- 空日志 + 脱敏中间弹层类别 => `ambiguous` 和 `COMMUNICATION_USER_ACTION_REQUIRED`；
- accepted 网络日志 + 页面明确不一致 => `ambiguous` 和 `COMMUNICATION_RESULT_AMBIGUOUS`。

每种结果都断言序列化后的 evidence 不含 `securityId`、`chatId`、原始 URL、响应正文和网络错误原文；每个 adapter 实例的 `clickAt` 计数始终为 1。

- [ ] **Step 3: 运行 BOSS 页面测试并确认旧 DOM 点击契约失败**

Run:

```powershell
node tests/boss_communication_page_smoke.js
```

Expected: 旧实现没有启动网络日志、`clickAt` 计数为 0，并且守卫表达式仍含 `.click()`。

- [ ] **Step 4: 把最终页面守卫改为只返回可信坐标**

将 `guardedBossCommunicationClickExpression` 的结尾改为：

```js
if (candidates.length !== 1) return fail("action_not_unique");
const element = candidates[0];
const rect = element.getBoundingClientRect();
const clickPoint = {
  x: rect.left + rect.width / 2,
  y: rect.top + rect.height / 2
};
const pointElement = document.elementFromPoint(clickPoint.x, clickPoint.y);
if (pointElement !== element && !element.contains(pointElement)) {
  return fail("point_target_changed");
}
return {
  ready: true,
  jobId: expected.jobId,
  clickPoint,
  operation
};
```

删除该表达式中的 `window.__bossRegisterCommunicationOutcomeObserver()` 和 `candidates[0].click()` 调用；保留所有 URL、岗位 ID、标题、公司、状态、唯一按钮和聊天身份核验。

- [ ] **Step 5: 在页面快照中只记录脱敏的中间弹层类别**

在 `PAGE_HELPERS` 生成 communication snapshot 时，保留现有成功弹层和 inline chat 字段，并增加：

```js
const intermediateDialogRoot = Array.from(document.querySelectorAll(
  ".dialog-wrap:not(.startchat-dialog), .boss-dialog, .dialog-container"
)).find((element) => isVisible(element)
  && element !== successDialogRoot
  && !element.matches(".greet-boss-pop, .greet-pop")
  && !element.querySelector(".greet-boss-pop, .greet-pop"));
const intermediateDialog = {
  visible: Boolean(intermediateDialogRoot),
  category: intermediateDialogRoot ? "confirmation_dialog" : ""
};
```

把 `intermediateDialog` 放入 snapshot。不得保存弹层全文、按钮携带的聊天身份或任何隐藏字段；已识别的成功弹层仍只走成功证据分支。

- [ ] **Step 6: 在浏览器级点击前启动有界网络日志**

在 `dispatchCommunication` 的最终守卫前调用：

```js
await this.browser.startNetworkLog(tabId, {
  maxEntries: 12,
  maxBodies: 4,
  maxBodyBytes: 8192,
  resourceTypes: ["XHR", "Fetch"],
  bodyUrlIncludes: ["/wapi/zpchat/config/get", "/wapi/zpgeek/friend/add.json"],
  urlIncludes: ["/wapi/zpchat/config/get", "/wapi/zpgeek/friend/add.json"],
  captureBodies: true,
  clear: true
});
const markResult = await this.browser.getNetworkLogMark(tabId);
const guard = await this.browser.evalValue(
  tabId,
  guardedBossCommunicationClickExpression(expectedJob)
);
if (guard?.ready !== true || guard?.jobId !== expectedJob.jobId) {
  throw bossError("BOSS_COMMUNICATION_TARGET_CHANGED", "The guarded BOSS communication target changed before click dispatch.");
}
await this.browser.clickAt(tabId, guard.clickPoint);
this.lastCommunicationDispatch = {
  jobId: expectedJob.jobId,
  tabId,
  expectedJob,
  networkSequence: Number(markResult?.mark?.lastSequence || 0)
};
```

`communicationDispatchedJobIds.add()` 和数据库侧 `click_dispatched` 仍在外部动作前完成。派发失败时在 `finally` 中调用 `stopNetworkLog(tabId, {clear:true, detachIfIdle:false})`；成功派发时由核验阶段清理。

- [ ] **Step 7: 分类网络日志并只产生脱敏证据**

在 `boss.js` 增加纯函数：

```js
function classifyBossCommunicationNetworkLog(log = {}) {
  const endpoints = (log.entries || []).map((entry) => {
    const endpointKind = communicationEndpointKind(entry.url);
    if (!endpointKind) return null;
    const httpStatus = Number(entry.status);
    const businessCode = safeBossBusinessCode(parseBossResponseCode(entry.content));
    const elapsedMs = boundedElapsedMs(entry.startedAt, entry.completedAt);
    const businessCategory = entry.failed
      ? "network_rejected"
      : !Number.isInteger(httpStatus) || httpStatus < 200 || httpStatus >= 300
        ? "http_failure"
        : businessCode === "0"
          ? "success"
          : businessCode
            ? "business_rejected"
            : "response_unparsed";
    return {
      endpointKind,
      ...(Number.isInteger(httpStatus) ? { httpStatus } : {}),
      ...(businessCode ? { businessCode } : {}),
      businessCategory,
      elapsedMs
    };
  }).filter(Boolean);
  if (!endpoints.length) return { state: "no_matching_request", evidence: { endpoints: [] } };
  if (endpoints.some((entry) => entry.businessCategory.startsWith("network_"))) {
    return { state: "transport_failed", evidence: { endpoints } };
  }
  if (endpoints.some((entry) => ["http_failure", "business_rejected"].includes(entry.businessCategory))) {
    return { state: "platform_rejected", evidence: { endpoints } };
  }
  if (endpoints.some((entry) => entry.endpointKind === "friend_add" && entry.businessCategory === "success")) {
    return { state: "accepted", evidence: { endpoints } };
  }
  return { state: "ambiguous", evidence: { endpoints } };
}
```

配套 helper 使用以下实现：

```js
function communicationEndpointKind(value) {
  try {
    const path = new URL(String(value || ""), "https://www.zhipin.com").pathname;
    if (path === "/wapi/zpchat/config/get") return "chat_config";
    if (path === "/wapi/zpgeek/friend/add.json") return "friend_add";
  } catch {}
  return "";
}

function parseBossResponseCode(content) {
  try {
    return JSON.parse(String(content || "")).code;
  } catch {
    return "";
  }
}

function safeBossBusinessCode(value) {
  const code = String(value === undefined || value === null ? "" : value).trim();
  return /^[A-Za-z0-9_-]{1,32}$/.test(code) ? code : "";
}

function boundedElapsedMs(startedAt, completedAt) {
  const started = Date.parse(String(startedAt || ""));
  const completed = Date.parse(String(completedAt || ""));
  if (!Number.isFinite(started) || !Number.isFinite(completed)) return 0;
  return Math.max(0, Math.min(60_000, completed - started));
}
```

返回值不得包含 `entry.url`、`entry.content`、`entry.errorText` 或请求 ID。

- [ ] **Step 8: 合并网络与页面证据并可靠清理**

`verifyCommunicationResult` 每轮读取：

```js
const network = classifyBossCommunicationNetworkLog(await this.browser.readNetworkLog(tabId, {
  sinceSequence: dispatch.networkSequence,
  maxEntries: 12,
  includeBodies: true,
  resourceTypes: ["XHR", "Fetch"],
  urlIncludes: ["/wapi/zpchat/config/get", "/wapi/zpgeek/friend/add.json"],
  consume: false
}));
const snapshot = await this.browser.evalValue(tabId, "(() => window.__bossCommunicationSnapshot())()");
const page = classifyBossCommunicationResultSnapshot(snapshot, dispatch.expectedJob);
```

按设计表组合：

```js
if (network.state === "accepted" && page.state === "succeeded") {
  return { ...page, evidence: { ...network.evidence, pageState: "succeeded" } };
}
if (["platform_rejected", "transport_failed"].includes(network.state) && page.state !== "succeeded") {
  return { ...network, evidence: { ...network.evidence, pageState: page.state } };
}
if (snapshot?.intermediateDialog?.visible === true) {
  return {
    state: "ambiguous",
    errorCode: "COMMUNICATION_USER_ACTION_REQUIRED",
    evidence: { ...network.evidence, pageState: snapshot.intermediateDialog.category }
  };
}
```

轮询结束后：

```js
if (network.state === "no_matching_request" && page.state === "ambiguous") {
  return {
    state: "ambiguous",
    errorCode: "COMMUNICATION_ACTION_NOT_TRIGGERED",
    evidence: { endpoints: [], pageState: "no_matching_request" }
  };
}
return {
  state: "ambiguous",
  errorCode: "COMMUNICATION_RESULT_AMBIGUOUS",
  evidence: { ...network.evidence, pageState: "evidence_conflict" }
};
```

`finally` 必须调用 `stopNetworkLog(tabId, {clear:true, detachIfIdle:false})` 并清理页面观察器；清理失败只记录本地诊断，不得触发第二次点击。

- [ ] **Step 9: 将具体歧义码写入现有安全中断状态**

在 `communication_executor.js` 把固定错误码替换为：

```js
const ambiguityCode = [
  "COMMUNICATION_ACTION_NOT_TRIGGERED",
  "COMMUNICATION_USER_ACTION_REQUIRED",
  "COMMUNICATION_RESULT_AMBIGUOUS"
].includes(String(result?.errorCode || ""))
  ? String(result.errorCode)
  : "COMMUNICATION_RESULT_AMBIGUOUS";
return ambiguousAndThrow(
  db,
  batchId,
  item,
  codedError(ambiguityCode, "communication result could not be verified"),
  logger,
  communicationOutcomeEvidence(result)
);
```

在 `tests/communication_executor_smoke.js` 分别返回两个新错误码，断言条目、批次和 workflow 均中断并保存相同错误码，`dispatchCommunication` 只调用一次，后续 pending 条目未执行。

- [ ] **Step 10: 增加中文用户说明但保留技术码**

在 `src/dashboard/status_labels.js` 导出：

```js
function communicationErrorLabel(code) {
  return {
    COMMUNICATION_ACTION_NOT_TRIGGERED: "平台没有响应本次点击，RoleFlow 已停止且不会自动重试。",
    COMMUNICATION_USER_ACTION_REQUIRED: "平台出现需要人工处理的提示，RoleFlow 已停止。",
    COMMUNICATION_RESULT_AMBIGUOUS: "平台请求与页面状态不一致，结果无法确认，RoleFlow 已停止。"
  }[String(code || "")] || "沟通执行已安全停止，请查看处理信息。";
}
```

沟通页和 workflow 中断卡先显示中文说明，再在可展开技术信息中保留原始 `errorCode`。更新 `tests/dashboard_communication_batch_smoke.js` 和 `tests/workflow_communication_smoke.js`，断言中文说明可见且错误码仍存在。

- [ ] **Step 11: 运行沟通聚焦回归并提交**

Run:

```powershell
node tests/browser_transport_smoke.js
node tests/boss_communication_page_smoke.js
node tests/communication_executor_smoke.js
node tests/dashboard_communication_batch_smoke.js
node tests/workflow_communication_smoke.js
```

Expected: 五个脚本均输出 `ok`；所有测试均使用 fake browser，不访问真实 BOSS，不执行真实沟通。

```powershell
git add src/adapters/sites/boss.js src/core/communication_executor.js src/dashboard/status_labels.js src/dashboard/pages/communication.js src/dashboard/pages/workflow.js tests/boss_communication_page_smoke.js tests/communication_executor_smoke.js tests/dashboard_communication_batch_smoke.js tests/workflow_communication_smoke.js
git commit -m "fix: verify BOSS communication dispatch evidence"
```

### Task 6: 报告校正、完整离线门和多视口验收

**Files:**
- Modify: `docs/superpowers/reports/2026-08-13-beta4-manual-acceptance-remediation.md`
- Create: `docs/superpowers/reports/2026-08-14-beta4-2-implementation-verification.md`
- Verify: all files modified by Tasks 1-5

**Interfaces:**
- Consumes: Tasks 1-5 的聚焦测试和最终分支状态。
- Produces: 可审计的 beta.4.2 实现验证报告；不发布 release，不触碰当前真实沟通批次。

- [ ] **Step 1: 校正旧报告对自动沟通的表述**

将 2026-08-13 报告中“歧义处理已修复”的结论改为以下事实：

```markdown
- 离线状态机已能在结果不明确时安全中断，但 2026-08-14 人工验收再次真实出现
  `COMMUNICATION_RESULT_AMBIGUOUS`。
- 条目已记录一次点击，页面观察器未捕获匹配请求；固定消息标签没有目标岗位会话。
- 因此旧结论只能证明“不会自动重复点击”，不能证明真实派发稳定。
- beta.4.2 通过浏览器级点击和 Edge 网络日志补齐证据链；真实单岗位端到端仍需用户另行授权。
```

- [ ] **Step 2: 运行完整离线套件**

Run:

```powershell
npm test
```

Expected: `All 97 offline checks passed.`；若测试数量因本分支现有 `run_all.js` 不同，以命令实际输出的全部检查数量为准并原样记录，不得沿用旧日志数字。

- [ ] **Step 3: 用 webapp-testing 做多视口只读验收**

启动隔离 worktree 的本地 dashboard，使用 mock/fixture 数据，不连接真实 BOSS；检查：

```text
/settings
  1440x900：共享测试按钮无需滚动即可看到；两张任务卡左右布局；下一步禁用/启用状态清楚。
  768x1024：表单无横向溢出；按钮和禁用说明可读。
  390x844：共享模块、按钮和下一步按纵向排列；键盘焦点不进入禁用下一步。

/workflow?runId=<fixture>
  1440x900：本轮概览直接看到采集进度和完整 JD；技术明细保留。
  390x844：两个新增字段不横向溢出；本轮实际关键词与候选词数量不混淆。

/communication?batchId=<fixture>
  1440x900 和 390x844：中文中断说明可见；技术错误码仍可查看；页面没有自动执行按钮。
```

检查浏览器控制台无新增错误，保存每个页面至少一个桌面截图和一个窄屏截图到 `D:\DevData\RoleFlow-beta4-2\verification\ui\`，不写入 `C:`。

- [ ] **Step 4: 复核安全和范围不变量**

Run:

```powershell
git diff origin/main...HEAD -- src scripts tests
git diff --unified=0 origin/main...HEAD -- src scripts tests | rg "^\+.*(search_page_api|standalone_detail)"
rg -n "candidates\\[0\\]\\.click\\(\\)" src/adapters/sites/boss.js
git status --short --branch
```

Expected:

- 新增行扫描无输出、命令退出码为 1，证明 diff 中没有启用或传入 `search_page_api`，也没有新增 `standalone_detail` 主流程调用；
- 最终沟通守卫中不存在 `candidates[0].click()`；
- 没有第三个 BOSS 标签/窗口逻辑；
- 工作区只包含本计划内已提交改动。

- [ ] **Step 5: 写实现验证报告**

`docs/superpowers/reports/2026-08-14-beta4-2-implementation-verification.md` 必须记录：

```markdown
# RoleFlow beta.4.2 实现验证

## 实现结果
- 模型设置：
- 关键词与进度：
- 自动沟通：

## 验证证据
- 聚焦测试：
- 完整离线套件：
- 多视口截图目录：
- Git 提交：

## 明确未执行
- 未抓取新岗位。
- 未恢复或修改当前沟通批次 #1。
- 未点击真实“立即沟通”，未发送消息，未申请岗位。
- 未启用 `search_page_api`、`standalone_detail` 或 Wave 5。

## 下一次人工验收前置条件
- 用户重新确认一个不可变的单岗位沟通样本后，才允许执行一次真实点击。
- 首次真实点击后立即核对脱敏网络结果、按钮状态和消息会话；任何不一致立即停止。
```

用真实测试输出、截图路径和提交哈希填入各项，不写尚未发生的成功结论。

- [ ] **Step 6: 提交报告并进行最终代码审查**

```powershell
git add docs/superpowers/reports/2026-08-13-beta4-manual-acceptance-remediation.md docs/superpowers/reports/2026-08-14-beta4-2-implementation-verification.md
git commit -m "docs: record beta4.2 implementation verification"
git log --oneline --decorate -8
git status --short --branch
```

随后使用 `requesting-code-review` 检查计划要求、真实缺陷范围、一次点击安全账本、网络证据脱敏和无降质约束。审查发现的问题先按 `receiving-code-review` 核验证据，再做最小修正并重新运行受影响测试与 `npm test`。

## 计划自检结果

- **规格覆盖：** 模型设置两项、关键词显示、首层采集/JD 进度、沟通点击与证据链、当前批次处置、中文说明、完整离线和多视口验收均有对应任务。
- **非目标覆盖：** `trusted_pane`、候选词库、每轮 3 词、固定双标签、一次点击、当前批次不恢复、无真实发送、无新依赖和 Wave 5 暂停均列为全局约束并在最终门复核。
- **接口一致性：** Task 2 使用 Task 1 的两个新导出；Task 5 使用 Task 4 的四个网络日志方法；歧义结果统一通过 `result.errorCode` 传到现有 executor。
- **占位符检查：** 计划不包含未定义的实施占位项；报告模板中的字段要求用执行时真实证据填写。
