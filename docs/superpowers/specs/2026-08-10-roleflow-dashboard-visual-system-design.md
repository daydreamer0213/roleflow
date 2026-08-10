# RoleFlow dashboard visual system and static prototypes

> Wave 1.1 design and implementation plan. This document is intentionally scoped to offline visual artifacts; it does not change RoleFlow runtime behavior.

## Goal

Give RoleFlow a production-ready visual direction for the three highest-frequency work surfaces: 今日任务 (Today), 本轮执行 (Workflow), and 当前岗位 (Queue). Each page should answer “where am I, what is blocked, and what do I do next?” within one glance while preserving the current `/plan`, `/workflow`, and `/queue` contracts.

## Context and non-goals

- Baseline: main commit `e36bee8`; current server-rendered pages live in `src/dashboard/server.js`.
- Static prototypes use realistic, fabricated Chinese values only. They never read SQLite, credentials, resumes, JDs, BOSS, or a browser session.
- No frontend framework, CDN, online font, icon package, or production dependency is introduced.
- No algorithm, scan budget, safety gate, communication action, or API capability changes in Wave 1.1.

## Design direction

**Product thesis:** RoleFlow is a local operations console for a high-stakes, human-confirmed job search. The visual language borrows from a calm dispatch board: a left signal rail, crisp work surfaces, and short operational labels. It should feel precise and trustworthy, not like a generic SaaS admin template.

**Signature:** a narrow orange “signal rail” marks the page’s current stage and the strongest action. Teal is reserved for safe progress and primary execution; orange marks attention; red marks a real stop. Flat surfaces, hairline rules, and small square index markers create a distinct control-room identity without decorative gradients or shadows.

**Token set:**

| Token | Value | Use |
| --- | --- | --- |
| `--rf-ink` | `#13252B` | primary text and headings |
| `--rf-ink-soft` | `#40545A` | supporting text |
| `--rf-canvas` | `#EEF2EF` | app background |
| `--rf-surface` | `#FFFFFF` | cards, forms, tables |
| `--rf-rule` | `#CBD7D3` | separators and borders |
| `--rf-teal` | `#006B5B` | primary action, healthy state |
| `--rf-teal-deep` | `#004A40` | pressed/hover action |
| `--rf-orange` | `#F07824` | signal rail, attention state |
| `--rf-blue` | `#2F6FDB` | informational state and links |
| `--rf-red` | `#B23A32` | blocked, failed, destructive state |
| `--rf-amber` | `#956B19` | waiting, needs review |
| `--rf-mist` | `#E6EFEC` | selected and healthy fills |
| `--rf-radius` | `10px` | cards and controls |

All normal text uses a dark token on a light surface and is sized at 14–16px with at least 1.5 line-height. The system font stack is `"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif`; it works offline and has no font fetch.

## Layout and density

- Mobile-first container: `max-width: 1220px`, horizontal padding 18px at small widths and 32px on desktop.
- Desktop layout: 72px signal rail + content grid. Today uses a 1.55fr / 0.9fr split; Workflow and Queue use a single reading column with dense evidence rows.
- Spacing scale: 4, 8, 12, 16, 24, 32px. Cards use 16–20px internal padding. Dense metadata never drops below 12px.
- No fixed-width tables. Queue rows switch to stacked cards below 760px. The only sticky action bar is the human confirmation bar, and it remains full-width and visible on mobile.
- One strongest action per page: Today = `开始一轮`; Workflow = `确认本轮清单`; Queue = `复核主投岗位`. Other links are quiet secondary actions.

## Shared interaction rules

- Use sentence-case Chinese verbs: “开始一轮”, “继续本轮”, “确认本轮清单”, “复核岗位”. The action label remains stable from button to result message.
- Every page has a skip link, a visible current navigation item, an `h1`, and a compact page eyebrow that names the stage.
- Focus uses a 3px `--rf-orange` outline with 2px offset. Interactive targets are at least 44px tall. Hover changes color or underline; no hover-only information.
- Errors use `role="alert"`, explain what happened, whether local data is safe, and the next recovery action. Empty states include a next action, not only “暂无数据”.
- Motion is limited to a 180ms color/transform feedback. `prefers-reduced-motion: reduce` disables transitions and animations.
- Color is never the only status channel: each badge includes a Chinese label and, where needed, a square marker.

## Exact prototype-to-runtime mapping

| Prototype | Current route | Prototype section | Current source/data contract | Capability boundary |
| --- | --- | --- | --- | --- |
| Today | `/plan?profileId=&planId=` | stage header + metrics | `buildWorkflowDashboardState`: `activeRun`, `nextPlan`, `successfulToday`, `dailyTarget`, `inventory.length`, `slotsUsed`, `maxRuns`, `remainingBudget` | display only; primary action remains the existing workflow start/resume form |
| Today | `/plan?profileId=&planId=` | blockers | `planDependency.stale`, `matchingCardRequired`, `bossRuntimeBlock`, `validateSearchPlan` | no new blocker resolution; links point to existing `/match-card`, `/profile`, `/diagnostics` paths |
| Today | `/plan?profileId=&planId=` | candidate brief | `profile.profile.candidate`, `profile.profile.skills`, `profile.profile.projects`, `versionDiff`, `feedback` | summary only; editing stays on existing profile/resume pages |
| Today | `/plan?profileId=&planId=` | scan controls | `scanStatus`, `getLatestResumableBatch`, `resolveScanPolicy`, `bossFilterPreview` | advanced daily/broad/refresh/activity actions remain secondary; no new scan kind |
| Workflow | `/workflow?runId=` | run header | `workflow.sequence`, `localDay`, `status`, `targetSuccessCount`, `successfulCount`, `inventoryCount`, `daily` | status is rendered from current workflow state labels |
| Workflow | `/workflow?runId=` | live progress | `getWorkflowProgressSnapshot`: `progress.stageIndex`, `stageCount`, `analysis`, `model`, `recentActivity`, `scanWait` | polling can be added later; prototype shows a frozen snapshot |
| Workflow | `/workflow?runId=` | frozen scope | `renderInheritedScopeSummary`: `planner.searchScope`, `keywordSource`, `platformPolicy.filterSummary`, `unresolvedParams` | preserves “BOSS 当前页面” source language; never invents filter values |
| Workflow | `/workflow?runId=` | review / confirmation | `listWorkflowReviewCandidates`, `communicationQuota`, `communicationRuntimeBlock`, `communication.calibration` | confirmation remains human-controlled and immutable; no send/apply control is added |
| Queue | `/queue?planId=&pool=&scope=&page=` | pool switcher | `queue.counts`, `queue.scopeCounts`, `queue.pool`, `queue.scope`, `latestMainBatchId` | links map to existing `queueHref` query params |
| Queue | `/queue?planId=&pool=&scope=&page=` | job evidence | `listDecisionPool` rows: `title`, `company`, `salary`, `experience`, `analysis.fitReasons`, `risks`, `qualityTags`, `decisionBucket`, `applicationStatus` | labels are display-only; state mutations remain existing `/api/mark`, `/api/follow-up`, `/api/analyze-job` forms |
| Queue | `/queue?planId=` | outcome summary | `renderOutcomeAnalyticsPanel`: tier rows, keyword rows, `diagnostics`, `unclassified` | read-only analytics; no tuning control is implied |

## Page compositions

### Today

Open with “今天先把 35 个高质量机会推进到人工确认” and a compact status line. The primary action sits in the first viewport beside today’s progress. A four-cell metric strip shows progress, candidates, budget and rounds. The next block is “现在卡在哪里” with the current safe-data note. The right column is the candidate brief and search plan summary. Advanced scan controls stay below a divider, visibly secondary.

### Workflow

Open with round number, stage/status, target, and a 0–100 progress meter. The live evidence strip distinguishes total/success/failed/pending. A scope block freezes the source and unresolved platform parameters. The review state uses evidence-rich rows with checkboxes and a sticky confirmation bar; it explicitly shows quota and runtime safety. A stopped or failed state uses the same layout with a recovery action and `role="alert"`.

### Queue

Open with “需要你处理的岗位” and a short explanation of the current scope. A segmented scope bar (“全部 / 本轮新增 / 本轮重复 / 历史未处理”) precedes the decision pool chips. The first job is visually emphasized with recommendation, evidence, risk and a single “复核主投岗位” action. Secondary job actions live in a details disclosure. Empty and pending states distinguish “待读详情”, “待语义分析”, “活跃待核验”, and “暂无待处理岗位”.

## Focused implementation plan

1. Add one shared offline stylesheet with tokens, typography, signal rail, cards, badges, form controls, table/card responsive behavior, focus, reduced motion, error and empty states.
2. Add three self-contained static HTML prototypes that import the shared stylesheet and use only existing RoleFlow route names and data-shaped examples.
3. Use the installed local Edge executable through Playwright; call `page.setViewportSize({ width, height })` before loading each page, then render each page at 1440×900, 1024×768, 768×1024, and 375×812. Inspect every mobile screenshot and check the root plus each major visible text/container boundary in that same page context.
4. Record the screenshot evidence in the task report and commit only the assigned prototype/spec/screenshot files.

## Mobile validation correction

The first prototype verification compared only `document.documentElement.scrollWidth` with the viewport width. That check passed while screenshots still showed right-edge text cropping, because it did not inspect intermediate flex/grid children, text paint ranges, or the allowed overflow container itself. The corrected offline gate must, for every page and viewport:

- assert `document.documentElement.scrollWidth === innerWidth` and `body.scrollWidth === innerWidth`;
- assert every major heading, lede, action-panel text block, metric grid, job filter group, and heading metadata container has `min-width: 0`, `overflow-wrap: anywhere`, and no right edge beyond its parent or viewport;
- inspect `Range.getClientRects()` for visible text and reject any painted line whose right edge exceeds its text container or viewport;
- keep the mobile primary navigation inside the viewport with `flex-wrap: nowrap`, `overflow-x: auto`, and a visible “左右滑动查看更多” cue; this is the only intentional local horizontal scroll region;
- assert the page’s primary action is fully inside the first viewport, keyboard focus is visible, reduced motion is honored, contrast meets AA, and no external URL/font is loaded.

The previous “12/12 无横向溢出” conclusion is superseded: it proved only root document width in a different renderer. Direct CDP inspection of the old Edge CLI command showed `window.innerWidth=496`, `clientWidth=496`, `innerHeight=719`, `outerWidth=522` while the PNG header was `375×812`; the image was therefore a 375px crop of a wider layout. The repaired prototypes must use one Playwright viewport context for both metrics and PNG output, then be visually checked before this wave is accepted.

## Production migration sequence

1. Extract shared `renderPage` styles and `navLinks` into the token vocabulary, preserving route URLs and form actions.
2. Migrate `/plan` first because it is the default entry and already owns the workflow launch decision; keep advanced operations behind the existing disclosure.
3. Migrate `/workflow` second, reusing existing polling, progress controls, immutable review, and runtime safety gates without changing their predicates.
4. Migrate `/queue` third, keeping the current query-param pool/scope links and existing mark/follow-up/analyze endpoints.
5. Add focused offline assertions for route labels, primary action presence, status vocabulary, and mobile overflow only after the production render functions adopt the system.

## Open product decision

The exact Today headline remains a copy choice: this prototype uses a target-oriented sentence rather than a numeric KPI hero. Production should confirm that wording with the product owner while keeping the single-action and data mapping unchanged.
