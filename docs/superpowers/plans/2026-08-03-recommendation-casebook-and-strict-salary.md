# Recommendation Casebook and Strict Salary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a durable private recommendation-error casebook, record the confirmed Golang false positive, and make strict salary handling the default for new plans and the current saved plan.

**Architecture:** Real job and analysis evidence stays outside Git under `D:\DevData\RoleFlow-private-benchmark\recommendation-casebook`; the repository stores only a privacy-safe usage guide. Salary behavior remains plan-driven: normalization defaults missing values to `strict`, preserves explicit `wide`, and the current plan is migrated through the dashboard plan API so normal validation and rescoring still run.

**Tech Stack:** Node.js CommonJS, built-in SQLite, server-rendered dashboard HTTP API, Markdown, JSON, JSONL, PowerShell.

## Global Constraints

- Do not modify the language-matching or recommendation policy.
- Do not copy real job, company, URL, candidate, or resume content into Git.
- Do not store candidate names, contacts, full resume text, cookies, tokens, or secrets in the private casebook.
- Keep the confirmed communication batch #5 immutable: seven existing job IDs, status `confirmed`, and zero clicks.
- Do not navigate BOSS or start communication.
- Store private casebook data only under `D:\DevData\RoleFlow-private-benchmark\recommendation-casebook`.
- Change the current plan salary mode from `wide` to `strict`, but preserve an explicit `wide` choice for future users.
- Use `apply_patch` for file edits.

---

### Task 1: Create the private casebook and repository usage guide

**Files:**
- Create: `D:\DevData\RoleFlow-private-benchmark\recommendation-casebook\README.md`
- Create: `D:\DevData\RoleFlow-private-benchmark\recommendation-casebook\index.jsonl`
- Create: `D:\DevData\RoleFlow-private-benchmark\recommendation-casebook\cases\REC-20260803-001-golang-ai-backend.md`
- Create: `D:\DevData\RoleFlow-private-benchmark\recommendation-casebook\snapshots\REC-20260803-001.json`
- Create: `docs/recommendation_casebook.md`

**Interfaces:**
- Consumes: job ID `534` from `D:\Guo\ZhiPing\data\jobs.sqlite`, its stored `analysis_json`, and the approved design in `docs/superpowers/specs/2026-08-03-recommendation-casebook-and-strict-salary-design.md`.
- Produces: one JSONL index row with case ID `REC-20260803-001`, one readable diagnosis, one private structured snapshot, and a repository guide that future work can discover.

- [ ] **Step 1: Verify the private root and source case before writing**

Run:

```powershell
Test-Path -LiteralPath 'D:\DevData\RoleFlow-private-benchmark'
node -e "const {openDb}=require('./src/core/storage'); const db=openDb('D:/Guo/ZhiPing/data/jobs.sqlite'); const row=db.prepare('SELECT id,source_id,title,company,description,analysis_json FROM jobs WHERE id=?').get(534); if(!row||!row.description||!row.analysis_json) process.exit(1); console.log(JSON.stringify({id:row.id,hasSource:Boolean(row.source_id),hasTitle:Boolean(row.title),hasCompany:Boolean(row.company),jdLength:row.description.length,hasAnalysis:Boolean(row.analysis_json)})); db.close()"
```

Expected:

```text
True
{"id":534,"hasSource":true,"hasTitle":true,"hasCompany":true,"jdLength":470,"hasAnalysis":true}
```

Only lengths and booleans may be printed; do not print private text.

- [ ] **Step 2: Create the privacy-safe repository guide**

Create `docs/recommendation_casebook.md` with:

```markdown
# Recommendation error casebook

Human-confirmed recommendation errors are retained in the private local
casebook at:

`D:\DevData\RoleFlow-private-benchmark\recommendation-casebook`

Real jobs, URLs, companies, model outputs, and candidate evidence must not be
committed to this repository.

## When to add a case

Add a case only after the user explicitly confirms that a recommendation or
default selection is wrong. Search `index.jsonl` first and update an existing
case when the source hash and failure signature already exist.

## Required records

- one JSONL index row;
- one readable Markdown diagnosis under `cases`;
- one private JSON snapshot under `snapshots`;
- observed and expected tiers;
- the evidence-to-decision error chain;
- privacy-minimized candidate capability states;
- model, pipeline, and decision-policy versions;
- status `open`, `resolved`, or `converted_to_fixture`.

Private cases are optimization evidence, not production rules. A case may
become a committed regression fixture only after it has been separately
sanitized or replaced with synthetic data.
```

- [ ] **Step 3: Create the private README and directory structure**

Create the three directories and a private `README.md` that defines:

```markdown
# RoleFlow private recommendation casebook

This directory stores real, human-confirmed recommendation errors outside Git.

## Files

- `index.jsonl`: one searchable metadata row per case.
- `cases/`: readable diagnoses.
- `snapshots/`: private structured job and analysis snapshots.

## Addition rule

Only add a case after explicit human confirmation. Deduplicate by
`sourceIdentityHash` and `failureSignature`. Never store candidate identity,
contacts, full resume text, cookies, tokens, or secrets.

## Lifecycle

Cases start as `open`. A production change may mark a case `resolved` only
after an independent design, regression test, and evaluation. A committed
fixture must be synthetic or separately sanitized.
```

Create the directories before using `apply_patch` to add the README:

```powershell
New-Item -ItemType Directory -Force -Path `
  'D:\DevData\RoleFlow-private-benchmark\recommendation-casebook\cases', `
  'D:\DevData\RoleFlow-private-benchmark\recommendation-casebook\snapshots' |
  Out-Null
```

- [ ] **Step 4: Create the private JSON snapshot**

Run this read-only generator to produce the exact private JSON content:

```powershell
@'
const crypto=require("node:crypto");
const {openDb,decisionBucket}=require("./src/core/storage");
const db=openDb("D:/Guo/ZhiPing/data/jobs.sqlite");
const job=db.prepare(`
  SELECT id,source,source_id,title,company,location,salary,experience,education,url,
         description,score,analysis_json,quality_tags_json,risks_json
  FROM jobs WHERE id=534
`).get();
const analysis=JSON.parse(job.analysis_json);
const languageRequirement=(analysis.requirementMatches||[]).find(
  item => /golang/i.test(`${item.requirement||""} ${item.jdEvidence||""}`)
);
const snapshot={
  schemaVersion:1,
  caseId:"REC-20260803-001",
  recordedAt:"2026-08-03T06:17:03.711Z",
  status:"open",
  source:{
    site:"boss",
    sourceIdentityHash:crypto.createHash("sha256").update(job.source_id).digest("hex")
  },
  job:{
    title:job.title,company:job.company,location:job.location,salary:job.salary,
    experience:job.experience,education:job.education,url:job.url,
    description:job.description
  },
  observed:{
    recommendation:analysis.recommendation,
    decisionBucket:decisionBucket({
      ...job,
      qualityTags:JSON.parse(job.quality_tags_json||"[]"),
      risks:JSON.parse(job.risks_json||"[]"),
      analysis
    }),
    defaultSelected:true,
    score:Number(job.score),
    selectedTrackLabel:analysis.selectedTrackLabel,
    roleAlignment:analysis.roleAlignment,
    fitBand:analysis.decisionMetrics.fitBand,
    combinedFit:analysis.decisionMetrics.combinedFit,
    combinedCoverage:analysis.decisionMetrics.combinedCoverage
  },
  expected:{recommendation:"caution",defaultSelected:false},
  error:{
    category:"primary_delivery_language_misclassified",
    failureSignature:"title_language_required_but_missing_requirement_weighted_as_supporting",
    summary:"The required Golang capability was correctly identified as missing but was not classified as foundation, central, or indispensable, so matched AI requirements outweighed it."
  },
  candidateEvidence:{
    directGolangEvidence:false,
    note:"No candidate identity, contact, or full resume text retained."
  },
  runtime:{
    model:analysis.model,
    semanticMatchingMode:analysis.revision.semanticMatchingMode,
    policyVersion:analysis.decisionMetrics.policyVersion,
    decisionPolicyHash:analysis.decisionPolicyHash,
    pipelineVersions:analysis.revision.pipelineVersions
  },
  analysisEvidence:{
    responsibilityEvidence:analysis.responsibilityEvidence,
    languageRequirement:{
      requirement:languageRequirement.requirement,
      state:languageRequirement.state,
      foundation:languageRequirement.foundation,
      central:languageRequirement.central,
      indispensable:languageRequirement.indispensable,
      jdEvidence:languageRequirement.jdEvidence
    },
    decisionMetrics:{
      core:analysis.decisionMetrics.core,
      supporting:analysis.decisionMetrics.supporting,
      combinedFit:analysis.decisionMetrics.combinedFit,
      combinedCoverage:analysis.decisionMetrics.combinedCoverage,
      matrixRecommendation:analysis.decisionMetrics.matrixRecommendation
    }
  }
};
console.log(JSON.stringify(snapshot,null,2));
db.close();
'@ | node
```

Use `apply_patch` to place that exact output in
`snapshots\REC-20260803-001.json`. Do not add `source_id`, candidate profile,
candidate name, resume evidence text, or contact data.

- [ ] **Step 5: Create the readable private case**

Run this read-only generator to produce the exact Markdown content:

```powershell
@'
const {openDb}=require("./src/core/storage");
const db=openDb("D:/Guo/ZhiPing/data/jobs.sqlite");
const job=db.prepare(`
  SELECT title,company,location,salary,experience,url,description
  FROM jobs WHERE id=534
`).get();
const lines=[
  "# REC-20260803-001 — Golang AI backend default-selection false positive",
  "",
  "- Status: open",
  "- Category: primary_delivery_language_misclassified",
  "- Observed: apply, default selected",
  "- Expected: caution, not default selected",
  "",
  "## Job snapshot",
  "",
  `- Title: ${job.title}`,
  `- Company: ${job.company}`,
  `- Location: ${job.location}`,
  `- Salary: ${job.salary}`,
  `- Experience: ${job.experience}`,
  `- URL: ${job.url}`,
  "",
  "### Complete JD",
  "",
  job.description,
  "",
  "## Evidence-to-decision chain",
  "",
  "1. The title and JD explicitly require Golang.",
  "2. The candidate has no direct Golang evidence.",
  "3. The analysis correctly recorded the Golang requirement as missing.",
  "4. The requirement was marked foundation=false, central=false, and indispensable=false.",
  "5. Four AI Agent requirements were placed in the 70% core group and matched.",
  "6. The matrix retained combinedFit=0.70 and returned apply.",
  "7. Workflow default selection automatically checked apply.",
  "",
  "## Root cause",
  "",
  "The understanding contract discourages programming-language requirements from",
  "being central, but no deterministic rule promotes a primary delivery language",
  "to foundation. The weighted decision therefore treats a missing language as a",
  "supporting gap even when the title and JD make it central to implementation.",
  "",
  "## Similar cases to collect",
  "",
  "- Java AI backend roles with no Java evidence.",
  "- C++ or Golang RAG platform roles whose AI concepts are secondary.",
  "- Mixed Agent roles where a named implementation language is mandatory.",
  "- Counterexamples where a language is only preferred or one accepted alternative.",
  "",
  "## Future optimization directions",
  "",
  "Accumulate more confirmed cases before choosing between prompt refinement,",
  "structured delivery-language metadata, or a local caution cap. Do not implement",
  "a production guard from this single case.",
  ""
];
console.log(lines.join("\n"));
db.close();
'@ | node
```

Use `apply_patch` to place that exact output in
`cases\REC-20260803-001-golang-ai-backend.md`.

- [ ] **Step 6: Validate both private case files before indexing**

Run:

```powershell
@'
const fs=require("node:fs");
const path=require("node:path");
const {openDb,getCandidateProfile}=require("./src/core/storage");
const root="D:/DevData/RoleFlow-private-benchmark/recommendation-casebook";
const snapshot=JSON.parse(fs.readFileSync(path.join(root,"snapshots/REC-20260803-001.json"),"utf8"));
const diagnosis=fs.readFileSync(path.join(root,"cases/REC-20260803-001-golang-ai-backend.md"),"utf8");
if(snapshot.caseId!=="REC-20260803-001") throw new Error("snapshot case id mismatch");
if(snapshot.source.sourceIdentityHash!=="1ce0c94adb7b847727943d5bbf44c3876b4d99352786b113d939eab06a2f7eb3") throw new Error("source identity mismatch");
if(snapshot.observed.recommendation!=="apply"||snapshot.expected.recommendation!=="caution") throw new Error("recommendation evidence mismatch");
if(snapshot.candidateEvidence.directGolangEvidence!==false) throw new Error("candidate capability state mismatch");
for(const heading of ["## Evidence-to-decision chain","## Root cause","## Similar cases to collect","## Future optimization directions"]){
  if(!diagnosis.includes(heading)) throw new Error(`missing diagnosis section: ${heading}`);
}
const db=openDb("D:/Guo/ZhiPing/data/jobs.sqlite");
const candidateName=String(getCandidateProfile(db,1)?.profile?.candidate?.name||"").trim();
db.close();
const all=diagnosis+JSON.stringify(snapshot);
for(const forbidden of [candidateName,"手机号","身份证"]){
  if(forbidden&&all.includes(forbidden)) throw new Error("private identity or contact data retained");
}
const forbiddenKeys=new Set(["candidateprofile","resumetext","cookie","accesstoken","refreshtoken","phone","email","idcard","secret"]);
const visit=value=>{
  if(!value||typeof value!=="object") return;
  for(const [key,child] of Object.entries(value)){
    if(forbiddenKeys.has(key.toLowerCase())) throw new Error(`private data key violation: ${key}`);
    visit(child);
  }
};
visit(snapshot);
console.log("private case files valid");
'@ | node
```

Expected:

```text
private case files valid
```

If this command fails, fix or remove the invalid case files and do not create
`index.jsonl`.

- [ ] **Step 7: Append the JSONL index row**

After both private case files exist, write exactly one compact JSON object plus
a newline to `index.jsonl`:

```json
{"schemaVersion":1,"caseId":"REC-20260803-001","recordedAt":"2026-08-03T06:17:03.711Z","status":"open","category":"primary_delivery_language_misclassified","title":"Golang AI backend default-selection false positive","sourceSite":"boss","sourceIdentityHash":"1ce0c94adb7b847727943d5bbf44c3876b4d99352786b113d939eab06a2f7eb3","failureSignature":"title_language_required_but_missing_requirement_weighted_as_supporting","observedTier":"apply","expectedTier":"caution","defaultSelected":true,"model":"deepseek-v4-pro","policyVersion":"four-tier-weighted-v4.7","casePath":"cases/REC-20260803-001-golang-ai-backend.md","snapshotPath":"snapshots/REC-20260803-001.json","tags":["golang","primary-delivery-language","false-positive","default-selection"]}
```

- [ ] **Step 8: Validate the indexed casebook and Git boundary**

Run:

```powershell
@'
const fs = require("node:fs");
const path = require("node:path");
const root = "D:/DevData/RoleFlow-private-benchmark/recommendation-casebook";
const rows = fs.readFileSync(path.join(root, "index.jsonl"), "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
if (rows.length !== 1 || rows[0].caseId !== "REC-20260803-001") throw new Error("casebook index mismatch");
for (const key of ["casePath", "snapshotPath"]) {
  if (!fs.existsSync(path.join(root, rows[0][key]))) throw new Error(`missing ${key}`);
}
const snapshot = JSON.parse(fs.readFileSync(path.join(root, rows[0].snapshotPath), "utf8"));
if (snapshot.caseId !== rows[0].caseId) throw new Error("snapshot case id mismatch");
console.log("recommendation casebook ok (1 case)");
'@ | node
git status --short
```

Expected:

```text
recommendation casebook ok (1 case)
?? docs/recommendation_casebook.md
```

No file below `D:\DevData\RoleFlow-private-benchmark` may appear in Git status.

- [ ] **Step 9: Commit the repository guide**

```powershell
git add -- docs/recommendation_casebook.md
git commit -m "docs: document private recommendation casebook"
```

Expected: one commit containing only `docs/recommendation_casebook.md`.

### Task 2: Make strict salary the product default

**Files:**
- Modify: `tests/profile_quality_smoke.js`
- Modify: `src/core/product_policy.js`
- Modify: `src/core/profile_schema.js`

**Interfaces:**
- Consumes: `normalizeSearchPlan(input, candidateProfile)` and `PRODUCT_POLICY.searchPlan.defaultSalaryMode`.
- Produces: missing or invalid salary mode normalizes to `strict`; explicit `strict` remains `strict`; explicit `wide` remains `wide`.

- [ ] **Step 1: Add the failing default-and-explicit-mode assertions**

Add after the existing `plan` assertions in `tests/profile_quality_smoke.js`:

```js
const defaultSalaryModePlan = normalizeSearchPlan({}, profile);
assert.strictEqual(defaultSalaryModePlan.salaryMode, "strict");
assert.strictEqual(normalizeSearchPlan({ salaryMode: "invalid" }, profile).salaryMode, "strict");
assert.strictEqual(normalizeSearchPlan({ salaryMode: "wide" }, profile).salaryMode, "wide");
assert.strictEqual(normalizeSearchPlan({ salaryMode: "strict" }, profile).salaryMode, "strict");
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node tests/profile_quality_smoke.js
```

Expected: FAIL because `defaultSalaryModePlan.salaryMode` is currently `wide`.

- [ ] **Step 3: Implement the minimal strict default**

In `src/core/product_policy.js`:

```js
const PRODUCT_POLICY_VERSION = "2026-08-03.1";
```

and:

```js
defaultSalaryMode: "strict",
```

In `src/core/profile_schema.js`, replace the salary mode expression with:

```js
salaryMode: ["wide", "strict"].includes(input.salaryMode)
  ? input.salaryMode
  : policy.defaultSalaryMode,
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
node tests/profile_quality_smoke.js
```

Expected:

```text
profile_quality_smoke ok
```

- [ ] **Step 5: Run related salary and dashboard tests**

Run:

```powershell
node tests/screening_quality_smoke.js
node tests/onboarding_smoke.js
node tests/workflow_dashboard_smoke.js
```

Expected: all three commands exit `0`.

- [ ] **Step 6: Commit the strict-default change**

```powershell
git add -- tests/profile_quality_smoke.js src/core/product_policy.js src/core/profile_schema.js
git commit -m "feat: default search plans to strict salary"
```

Expected: one commit containing only the focused test and two production files.

### Task 3: Migrate the current plan and verify immutable communication state

**Files:**
- Modify operational data only: `data/jobs.sqlite`
- No Git-tracked file changes.

**Interfaces:**
- Consumes: dashboard `POST /api/plan`, active plan ID `1`, profile ID `1`, and the currently persisted plan fields.
- Produces: plan ID `1` with `salaryMode: strict`, normal plan rescoring, and unchanged communication batch #5.

- [ ] **Step 1: Capture the pre-migration communication invariant**

Run:

```powershell
@'
const crypto=require("node:crypto");
const {openDb,getSearchPlan}=require("./src/core/storage");
const {getCommunicationBatch,listCommunicationBatchItems}=require("./src/core/communication_batches");
const db=openDb("D:/Guo/ZhiPing/data/jobs.sqlite");
const plan=getSearchPlan(db,1);
const batch=getCommunicationBatch(db,5);
const items=listCommunicationBatchItems(db,5);
const {salaryMode,...planWithoutMode}=plan.plan;
console.log(JSON.stringify({
  planMode:plan.plan.salaryMode,
  planFingerprint:crypto.createHash("sha256").update(JSON.stringify(planWithoutMode)).digest("hex"),
  batchStatus:batch.status,
  startedAt:batch.startedAt,
  jobIds:items.map(x=>x.jobId),
  statuses:items.map(x=>x.status),
  clicks:items.map(x=>x.clickCount)
}));
db.close();
'@ | node
```

Expected:

```json
{"planMode":"wide","planFingerprint":"59459a1857a5485b6e82e1d74d0ac75789c6ea502af8cb5f7a3eaafdd1bb7f80","batchStatus":"confirmed","startedAt":null,"jobIds":[527,500,454,444,447,488,451],"statuses":["pending","pending","pending","pending","pending","pending","pending"],"clicks":[0,0,0,0,0,0,0]}
```

- [ ] **Step 2: Save plan #1 through the normal dashboard API**

Load the complete current plan from SQLite, submit it without printing its
private fields, and change only `salaryMode`:

```powershell
@'
(async()=>{
const {openDb,getSearchPlan}=require("./src/core/storage");
const db=openDb("D:/Guo/ZhiPing/data/jobs.sqlite");
const saved=getSearchPlan(db,1);
if(!saved) throw new Error("search plan 1 not found");
const plan=saved.plan;
const params=new URLSearchParams({
  profileId:String(saved.profileId),
  planId:String(saved.id),
  name:plan.name,
  cities:(plan.cities||[]).join("\n"),
  salaryMinK:String(plan.salary?.minK??""),
  salaryMaxK:String(plan.salary?.maxK??""),
  salaryMode:"strict",
  platformSalaryLanes:(plan.platform?.salaryLanes||[]).join("\n"),
  experience:(plan.experience||[]).join("\n"),
  jobTypes:(plan.jobTypes||[]).join("\n"),
  degrees:(plan.degrees||[]).join("\n"),
  workSchedulePreference:plan.workSchedulePreference||"",
  directions:(plan.directions||[]).join("\n"),
  keywords:(plan.keywords||[]).map(
    item=>`${item.word}|${item.priority}|${item.reason}`
  ).join("\n"),
  excludeWords:(plan.excludeWords||[]).join("\n"),
  hardExcludes:(plan.hardExcludes||[]).join("\n"),
  maxCards:String(plan.scan?.maxCards??""),
  maxDetailTotal:String(plan.scan?.maxDetailTotal??""),
  browserPageBudget:String(plan.scan?.browserPageBudget??"")
});
db.close();
const response=await fetch("http://127.0.0.1:8787/api/plan",{
  method:"POST",
  redirect:"manual",
  headers:{"content-type":"application/x-www-form-urlencoded"},
  body:params.toString()
});
if(![302,303].includes(response.status)){
  throw new Error(`plan save failed: ${response.status} ${await response.text()}`);
}
console.log(response.headers.get("location"));
})().catch(error=>{
  console.error(error);
  process.exitCode=1;
});
'@ | node
```

Expected:

```text
/plan?profileId=1&planId=1&saved=1
```

- [ ] **Step 3: Verify the current plan and batch after migration**

Run:

```powershell
@'
const crypto=require("node:crypto");
const {openDb,getSearchPlan}=require("./src/core/storage");
const {getCommunicationBatch,listCommunicationBatchItems}=require("./src/core/communication_batches");
const db=openDb("D:/Guo/ZhiPing/data/jobs.sqlite");
const plan=getSearchPlan(db,1);
const batch=getCommunicationBatch(db,5);
const items=listCommunicationBatchItems(db,5);
const {salaryMode,...planWithoutMode}=plan.plan;
if(plan.plan.salaryMode!=="strict") throw new Error("plan salary mode was not migrated");
if(crypto.createHash("sha256").update(JSON.stringify(planWithoutMode)).digest("hex")!=="59459a1857a5485b6e82e1d74d0ac75789c6ea502af8cb5f7a3eaafdd1bb7f80") throw new Error("plan fields other than salaryMode changed");
if(batch.status!=="confirmed"||batch.startedAt!==null) throw new Error("communication batch changed");
if(JSON.stringify(items.map(x=>x.jobId))!==JSON.stringify([527,500,454,444,447,488,451])) throw new Error("communication job snapshot changed");
if(!items.every(x=>x.status==="pending"&&x.clickCount===0)) throw new Error("communication item state changed");
console.log("strict current plan and immutable batch ok");
db.close();
'@ | node
```

Expected:

```text
strict current plan and immutable batch ok
```

- [ ] **Step 4: Verify the dashboard renders strict mode as selected**

Run:

```powershell
@'
(async()=>{
const response=await fetch("http://127.0.0.1:8787/plan?profileId=1&planId=1");
if(!response.ok) throw new Error(`plan page failed: ${response.status}`);
const html=await response.text();
if(!/<option value="strict" selected>/.test(html)) throw new Error("strict option is not selected");
console.log("dashboard strict selection ok");
})().catch(error=>{
  console.error(error);
  process.exitCode=1;
});
'@ | node
```

Expected:

```text
dashboard strict selection ok
```

- [ ] **Step 5: Run database integrity checks**

Run:

```powershell
@'
const {openDb}=require("./src/core/storage");
const db=openDb("D:/Guo/ZhiPing/data/jobs.sqlite");
const quick=db.prepare("PRAGMA quick_check").all();
const fk=db.prepare("PRAGMA foreign_key_check").all();
if(quick.length!==1||quick[0].quick_check!=="ok"||fk.length) throw new Error(JSON.stringify({quick,fk}));
console.log("database integrity ok");
db.close();
'@ | node
```

Expected:

```text
database integrity ok
```

- [ ] **Step 6: Run the full offline test suite**

Run:

```powershell
npm test
```

Expected: exit code `0`; do not claim completion if any smoke test fails.

- [ ] **Step 7: Confirm the worktree contains no private case data**

Run:

```powershell
git status --short
git ls-files | Select-String -Pattern 'REC-20260803-001|recommendation[-_]casebook'
```

Expected: clean worktree after the two implementation commits. `git ls-files`
may show only `docs/recommendation_casebook.md` and the approved design/plan
documents; it must not show private case Markdown, JSON, or JSONL.
