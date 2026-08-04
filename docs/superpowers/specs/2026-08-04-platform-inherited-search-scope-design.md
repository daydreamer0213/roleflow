# Platform-inherited search scope design

Date: 2026-08-04
Status: approved design
Branch: `codex/strict-transferable-evidence`

## 1. Goal

Make inherited mode treat the current recruitment-platform filters as an
independent search plan while continuing to rotate a profile-derived keyword
pool.

The change must:

- inherit the current BOSS search page's city, district, salary, experience,
  degree, job type, industry, and other stable search filters;
- treat those platform filters as authoritative during both acquisition and
  local hard-boundary screening;
- keep the page's current `query` mutable so one run can rotate several
  keywords;
- copy only the confirmed keyword catalog from the active project Search Plan;
- isolate keyword usage and yield by platform-filter scope;
- create a new scope automatically when the platform filters change;
- preserve a frozen execution snapshot for resume safety;
- leave generated mode unchanged;
- remain profession-neutral in production code.

## 2. Problem statement

The current inherited mode removes the page query and preserves the remaining
URL, but it still plans keywords and local screening from the active project
Search Plan.

That mixes two different sources of authority:

- the user configures the actual acquisition plan on BOSS;
- the project Search Plan supplies a second city, salary, experience, and
  keyword policy.

The mismatch was visible in batch 46. The live BOSS page inherited
`city=100010000` (nationwide), while the active project Search Plan required
Guangzhou. BOSS returned valid AI and RAG jobs nationwide, then local screening
rejected eleven RAG jobs for being outside Guangzhou.

The same run also demonstrated keyword-history contamination:

- the broad `Python AI后端` keyword had accumulated apparently useful yield
  from generic backend jobs;
- the scheduler selected it over a direct AI-application keyword with an
  insufficient historical sample;
- all nine `primary` or `apply` jobs came from that broad keyword.

Inherited mode therefore needs an acquisition scope independent from the
project Search Plan's filters and history.

## 3. Confirmed product semantics

Inherited mode is a search plan configured on the recruitment platform rather
than in RoleFlow.

The responsibilities are split as follows:

| Concern | Authority in inherited mode |
| --- | --- |
| City, district, salary, experience, degree, job type, industry | Current BOSS page |
| Current page query | Not fixed; replaced by the run keyword |
| Keyword catalog | Copied from the confirmed project Search Plan |
| Keyword usage and yield | Independent platform-filter scope |
| Candidate facts and resume evidence | Confirmed candidate profile and matching card |
| Role direction | Confirmed target directions and keyword catalog |
| Communication safety | Existing workflow and BOSS safety rules |

The project Search Plan's city, salary, experience, degree, job type, and
industry must not validate, fill, or override inherited platform filters.

## 4. Considered approaches

### 4.1 Filter-hash execution scope

Selected.

Normalize the live platform URL, derive a stable scope key, and persist the
scope inside workflow and batch execution snapshots. Scope-specific keyword
history is derived from observations belonging to batches with that key.

Advantages:

- no new plan-management lifecycle;
- no schema migration solely for an inherited-plan table;
- filter changes naturally produce a new scope;
- existing workflow snapshots and batch observations remain the audit trail;
- generated mode remains structurally separate.

### 4.2 Dedicated inherited-plan table

Rejected for this change.

An `inherited_search_plans` table would make plans directly manageable, but it
would also require create, update, archive, synchronization, and UI lifecycle
rules that are not needed for the current goal.

### 4.3 Thin overlay on the active Search Plan

Rejected.

Ignoring only the active plan's city and salary would leave global keyword
history shared. It would not satisfy the confirmed isolation requirement.

## 5. Search-scope identity

### 5.1 Canonical platform template

Start from the actual logged-in BOSS search-page URL.

Canonicalization must:

1. require `https://www.zhipin.com/web/geek/jobs`;
2. remove `query` and `page`;
3. remove the initial navigation/tracking denylist: `ka`, `source`, `from`,
   `src`, `trackId`, `lid`, `_`, `timestamp`, and keys prefixed with `utm_`;
4. retain every remaining known or unknown platform filter;
5. sort parameter names and repeated values deterministically;
6. remove the URL fragment.

Unknown parameters are retained by default. This prevents a new BOSS filter
from being silently discarded before RoleFlow knows how to interpret it.
Changing the denylist requires a fixture proving that the parameter does not
alter platform search semantics.

### 5.2 Scope key

The scope key is:

```text
boss:<profile-id>:<sha256(canonical-platform-template)>
```

The page query is deliberately absent. Keyword rotation must not create a new
scope.

The profile ID prevents two candidates from sharing keyword yield even when
they use the same platform filters.

### 5.3 Scope changes

- The same candidate and canonical filters reuse the same scope.
- Any stable filter change creates a new scope.
- A query or page-number change does not create a new scope.
- Legacy batches without a scope key are excluded from inherited-scope yield.

Excluding legacy history establishes the fresh baseline required after this
behavior change.

## 6. Keyword catalog and scheduling

### 6.1 Catalog source

Inherited mode copies only these fields from the active, confirmed Search Plan:

- `word`;
- `priority`;
- `reason`.

It must not copy acquisition filters.

The copied catalog is frozen in each workflow execution snapshot along with a
source revision containing the Search Plan ID, profile version, matching-card
revision, and a hash of the copied keyword catalog.

Changing the confirmed keyword catalog affects future runs. Existing and
resumed runs keep their frozen copy.

### 6.2 Current profile data correction

Remove `Python AI后端` from the current user-confirmed keyword catalog as a
versioned data edit. Do not add a production-code exception for this phrase.

The remaining current catalog is:

1. `AI应用开发工程师` — A;
2. `大模型应用开发工程师` — A;
3. `Agent开发工程师` — A;
4. `RAG开发工程师` — B;
5. `AI知识库开发` — B.

This is candidate-specific data, not a global prompt or product rule.

### 6.3 Scope-specific history

Keyword scheduling in inherited mode must calculate sample size, eligible
count, measured yield, and same-day use only from batches whose scope key
matches the current scope.

Within that scope, statistics use the latest observation for each
`site + source_job_id + keyword` tuple. Repeated page visits or resumed scans
must not inflate the sample. A job observed through two different keywords may
contribute once to each keyword because keyword effectiveness is the quantity
being measured. Eligibility is evaluated from the recorded screening result
and must not depend on later communication or application state.

The existing scheduling policy remains:

- prefer unused keywords for the local day;
- use measured yield only after the minimum sample size;
- then sort by priority and configured order;
- respect the existing per-run keyword and access budgets.

On a new scope, every keyword has no measured history. The first run therefore
uses priority and configured order. For the current catalog, that selects the
three direct A-priority keywords.

Generated mode continues to use its existing Search Plan history.

## 7. Platform runtime policy

Inherited acquisition and inherited local screening must use the same compiled
platform policy.

### 7.1 Fields

The compiler consumes the canonical template plus the current platform filter
catalog and produces:

- location mode and recognized city/district labels;
- salary lanes;
- experience lanes;
- degree filters;
- job-type filters;
- industry and other acquisition-only filters;
- unresolved platform filter codes.

### 7.2 Authority rules

- A nationwide platform city produces no local city hard boundary.
- A recognized specific platform city becomes the local city boundary.
- Recognized salary, experience, degree, and job-type filters become the
  corresponding local boundaries.
- An unset platform field remains unset. The project Search Plan must not fill
  it.
- Candidate profile facts remain available for semantic matching but do not
  override explicit inherited acquisition boundaries.
- Directions, resume evidence, and matching-card evidence remain profile
  inputs rather than acquisition filters.

### 7.3 Unresolved filters

If a stable platform parameter cannot yet be decoded:

- preserve it in the acquisition URL;
- record `platform_filter_unresolved` with privacy-safe parameter names and
  codes;
- do not guess a value from the project Search Plan;
- do not exclude a job solely because the local decoder is missing.

This preserves platform behavior without inventing a conflicting local rule.

## 8. Workflow data flow

### 8.1 Start

Before inherited keyword planning, the workflow start path performs a read-only
preflight against the existing logged-in Edge tab:

1. verify the BOSS tab, login state, search-page identity, and absence of risk
   control;
2. read the actual URL and selected platform filter state;
3. canonicalize the template and compute the scope key;
4. compile the platform runtime policy;
5. load scope-specific keyword statistics;
6. copy and select keywords;
7. create the workflow and immutable execution snapshot.

Tool-reported navigation or click success is not involved in this preflight.

### 8.2 Scan

For each selected keyword:

1. start from the frozen canonical template;
2. set only the `query` parameter;
3. remove page state;
4. navigate serially in the existing BOSS search tab;
5. verify page identity before collection;
6. preserve the existing pacing, cooldown, lease, checkpoint, and risk-control
   behavior.

### 8.3 Resume

Resume uses the frozen scope, platform policy, keyword catalog, and target
snapshot. It must not adopt changes made to the live tab after the workflow was
created.

Snapshot compatibility includes the scope key and platform-policy hash.

### 8.4 Analysis

Candidate profile and matching-card evidence continue to drive semantic
matching. The inherited platform policy replaces project Search Plan
acquisition boundaries when scoring jobs from that inherited run.

Generated scans keep the existing runtime configuration path.

## 9. Persistence and querying

No dedicated inherited-plan table is added.

Persist the following privacy-safe structure in workflow planning data and
batch execution snapshots:

```json
{
  "acquisitionMode": "inherited",
  "searchScope": {
    "key": "boss:1:<hash>",
    "site": "boss",
    "templateHash": "<hash>",
    "templateUrl": "https://www.zhipin.com/web/geek/jobs?...",
    "filterSummary": ["..."],
    "unresolvedParams": []
  },
  "keywordSource": {
    "searchPlanId": 1,
    "profileVersionId": 2,
    "matchingCardRevision": "<revision>",
    "catalogHash": "<hash>",
    "keywords": []
  },
  "platformPolicy": {
    "hash": "<hash>",
    "filters": {}
  }
}
```

The exact stored shape may use existing snapshot nesting, but these concepts
and hashes must remain explicit.

Add one focused storage/query boundary that returns keyword statistics for a
scope. Callers must not reproduce JSON filtering or batch joins themselves.

## 10. Dashboard behavior

The workflow page distinguishes acquisition filters from matching inputs.

Inherited mode displays:

- `筛选来源：BOSS 当前页面`;
- recognized filter summary;
- a short, non-secret scope identifier;
- the selected keywords;
- the keyword-catalog source revision;
- unresolved-filter warnings, if any;
- a note that changing platform filters creates a new statistics scope.

It must not display project Search Plan filter labels as inherited runtime
filters.

Generated mode retains its current display.

## 11. Error handling

Inherited workflow creation stops before any navigation when:

- the Edge bridge or extension is unavailable;
- there is no usable BOSS search tab;
- login is not confirmed;
- risk control is detected;
- the current URL is not a valid BOSS search page;
- the candidate profile, matching card, or confirmed keyword catalog is
  unavailable;
- canonicalization or snapshot creation fails.

A missing platform filter is not an error. It means the platform default is
authoritative.

Changing the tab after workflow creation is not an error because the frozen
snapshot remains authoritative for that run.

## 12. Observability

Add privacy-safe events for:

- inherited scope resolved;
- scope key reused or first seen;
- recognized and unresolved filter counts;
- keyword source revision;
- per-keyword scoped sample and eligible counts;
- acquisition mode at workflow, batch, and scan boundaries.

Do not log candidate identity, raw resume text, job descriptions, API keys, or
full authenticated browser state.

## 13. Tests

### 13.1 URL and scope tests

- query changes do not alter the canonical template or scope key;
- page changes do not alter the scope key;
- filter parameter ordering does not alter the scope key;
- city, salary, experience, degree, or unknown filter changes do alter it;
- unknown stable filters remain in the canonical URL;
- known tracking parameters are excluded.

### 13.2 Runtime-policy tests

- nationwide BOSS scope does not inherit a Guangzhou hard boundary;
- a Guangzhou BOSS scope applies Guangzhou even when the project Search Plan
  says another city;
- platform salary, experience, and degree override project-plan values;
- unset platform fields remain unset;
- unresolved codes produce warnings and no guessed hard boundary.

### 13.3 Keyword tests

- inherited mode copies only keyword fields;
- `Python AI后端` is removed through the current plan data edit, not a generic
  code filter;
- legacy and different-scope batches do not contribute yield;
- same-scope batches do contribute yield;
- a new scope selects keywords by priority and configured order;
- same-day usage is isolated by scope;
- generated-mode keyword planning remains unchanged.

### 13.4 Workflow and resume tests

- workflow start captures the live scope before planning keywords;
- execution snapshots contain scope, keyword-source, and platform-policy
  hashes;
- scanning replaces only query and page state;
- resume uses the stored snapshot after the live tab changes;
- a scope mismatch cannot silently resume into another filter plan.

### 13.5 Safety tests

- invalid page, logged-out state, and risk-control state stop before
  navigation;
- inherited planning is read-only;
- no communication or application path is added or changed.

## 14. Rollout and verification

1. Update the current confirmed keyword catalog to remove the broad keyword.
2. Run focused unit and smoke tests.
3. Verify generated mode against its existing fixtures.
4. Start one fresh inherited run from a controlled saved DOM fixture.
5. Perform one minimal read-only live preflight to confirm the platform-policy
   decoder against the actual logged-in page.
6. Run one inherited scan with a fresh scope and inspect:
   - frozen filter summary;
   - selected direct keywords;
   - scope-specific statistics;
   - nationwide or city-boundary behavior;
   - detail coverage and risk signals.
7. Do not communicate or apply without the existing separate approval flow.

Legacy inherited batches remain recovery evidence only and do not seed the new
scope statistics.

## 15. Non-goals

This change does not:

- implement the strict transferable-evidence automatic-selection gate;
- change the model prompt or recommendation matrix;
- add profession-specific keyword rules;
- generate a new keyword catalog on every run;
- create a general inherited-plan management UI;
- alter BOSS communication or application behavior;
- relax pacing, cooldown, checkpoint, or risk-control rules.

The strict direct-evidence gate remains owned by its separate design and
implementation workflow.

## 16. Acceptance criteria

The change is accepted when:

1. inherited acquisition and local hard boundaries agree with the current
   BOSS filters;
2. project Search Plan acquisition filters cannot override inherited filters;
3. keyword query remains rotatable;
4. keyword history is isolated by candidate and platform-filter scope;
5. changing a stable platform filter creates a fresh scope;
6. changing only query or page reuses the scope;
7. current inherited history without a scope key is excluded;
8. the current broad keyword is removed as data rather than hard-coded logic;
9. generated mode passes unchanged behavior tests;
10. resume remains deterministic from the frozen snapshot;
11. the dashboard makes inherited filter authority visible;
12. all existing browser safety boundaries remain intact.
