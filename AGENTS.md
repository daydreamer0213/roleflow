# RoleFlow working rules

## Evidence before conclusions

- Before making claims about an external platform, inspect the current live page and the actual code path first.
- For browser behavior, use the user's existing logged-in tab and verify both DOM fields and the resulting UI state after an action.
- Separate observed facts, code evidence, and inference. Never present an unverified inference as current behavior.
- A tool reporting that a click or navigation succeeded is not enough; verify that the expected job ID, title, pane, or URL actually changed.
- Before changing selectors, fields, timing, or risk-control behavior, run the smallest read-only live probe that can confirm the premise.

## Skill routing and proportionality

- Project rules and explicit user requirements take precedence over reusable Skill workflows.
- Use `systematic-debugging` for bugs, failures, and unexpected behavior. Use `verification-before-completion` before claiming that work is fixed or complete.
- Use brainstorming, written plans, worktrees, and formal review for behavior changes, multi-file work, architecture decisions, or high-risk external actions. Handle summaries, documentation, and clearly scoped small edits directly with a short intent statement.
- For non-trivial behavior, keep the smallest regression check that would fail if the behavior broke. Do not add tests for prose, comments, trivial forwarding, framework behavior, source-text presence, or speculative edge cases.
- Apply Ponytail to implementation scope: understand the real flow first, reuse existing code, prefer native capabilities and installed dependencies, avoid speculative abstractions, and change the fewest files that solve the root cause.
- Ponytail must not simplify away account safety, input validation, data-loss prevention, error handling, accessibility, JD coverage, matching quality, or any explicitly requested requirement.
- Use subagents only for genuinely independent work with separately verifiable outputs.

## BOSS safety boundary

- Keep BOSS access read-only unless the user explicitly approves communication or application actions.
- Use one logged-in Edge profile with two operator-labeled fixed baseline tabs: `BOSS-SEARCH` for scanning and read-only detail inspection, and `BOSS-COMMUNICATION` for message-page inspection. Message discovery may add at most one same-window transient detail tab only when a newly discovered conversation has no complete trusted local JD. That exception must open with `active: false`, remain fully background, run serially, and close after the guarded read and checkpoint. Never create parallel per-job tabs, a second window, or a second BOSS session.
- Resolve the current fixed-tab IDs from the active browser binding before every browser run. Keep numeric tab IDs numeric; never reuse a historical ID or coerce one to a string.
- All work is serial: finish the current read-only operation and checkpoint its result before switching fixed tabs or starting the next job. For message discovery, reuse a complete cached JD first; otherwise derive the trusted detail URL from the selected conversation without clicking, open one background transient detail tab, verify its job identity, read and checkpoint it, and close it before continuing. If a background open cannot be proved or the visible/active tab changes, close the transient tab, keep the item pending, and stop that operation.
- Browser work must remain in the background: never call `Page.bringToFront`, activate a BOSS tab/window, or add foreground-focus recovery during scanning, JD reading, analysis, message discovery, communication, polling, retry, or recovery. The sole exception is the user-invoked workspace startup helper: when `start-workspace.ps1` runs without `-NoOpen`, `workspace-tabs` may call `Page.bringToFront` once after readiness inspection to guide the user to the Dashboard when ready or to BOSS when login is required. Do not reuse this exception anywhere else. If the foreground changes, distinguish this explicit startup guidance, application/tool focus, and product behavior before changing browser code.
- Preserve random pacing, periodic cooldowns, checkpointing, and immediate stop on login/risk-control/page-loss signals. Message-discovery detail reads share the existing BOSS detail pacing state and access budgets; cached local reads consume no browser budget, while every issued transient-detail attempt counts even when it fails or becomes ambiguous.
- BOSS communication is technically and manually accepted in `v1.0.0`, but acceptance is not standing permission for a new external write. Confirming a communication batch authorizes only the checked jobs in that immutable batch snapshot; execute them serially with per-job identity/result verification, and stop immediately on risk-control, page loss, target mismatch, or ambiguous outcome. Never automatically retry an uncertain result or replay a historical batch.
- An inferred DOM selector, text guess, stale fixture, or tool-reported click success must never enable execution. A page-dependent conclusion requires redacted screenshots and DOM evidence from the actual logged-in page, followed by an immediate identity recheck before any click.
- Never trade account safety for test speed. Prefer saved DOM fixtures and fake-browser tests after a minimal live sample establishes the real page structure.

## BOSS implementation boundary

- The current production job-detail path is `trusted_pane` only. Do not enable or pass `search_page_api` through calibration, scanning, Gate D, or product workflows.
- Keep `search_page_api` and its failure evidence for later research. Do not repair, validate, optimize, or delete it as part of current work.
- Do not use or reintroduce `standalone_detail` for scanning, calibration, Gate D, or general product fallback. The only standalone page exception is the approved low-volume `message_discovery_detail` path: one trusted same-window background tab for a newly discovered conversation, guarded by shared pacing, access budgets, identity verification, and guaranteed cleanup.
- Do not start Wave 5 or a whole-project rewrite. Change only code paths required by an approved current task.

## Product quality decision boundary

- Treat JD coverage, recall, and recommendation accuracy as product quality, not disposable performance costs.
- Prefer slower pacing, random delays, staged execution, cooldown windows, cached-detail reuse, and resumable checkpoints before reducing card or detail coverage.
- Before applying any change that can materially reduce recall, JD coverage, matching accuracy, or recommendation quality, quantify the tradeoff and ask the user to decide.
- A safety cap may limit one browser window or session, but it must not silently lower the run's logical quality target. Preserve pending work and resume it later.

## Data baseline

- Do not use pre-baseline job history to validate current recall, precision, activity, runtime, or recommendation quality after screening rules change materially.
- Establish a fresh empty operational baseline before comparing a redesigned scan. Archived databases are recovery evidence only, not evaluation samples.
- Preserve candidate profiles, resumes, search plans, and model settings when resetting job history unless the user explicitly asks to remove them.
