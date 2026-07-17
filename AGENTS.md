# RoleFlow working rules

## Evidence before conclusions

- Before making claims about an external platform, inspect the current live page and the actual code path first.
- For browser behavior, use the user's existing logged-in tab and verify both DOM fields and the resulting UI state after an action.
- Separate observed facts, code evidence, and inference. Never present an unverified inference as current behavior.
- A tool reporting that a click or navigation succeeded is not enough; verify that the expected job ID, title, pane, or URL actually changed.
- Before changing selectors, fields, timing, or risk-control behavior, run the smallest read-only live probe that can confirm the premise.

## BOSS safety boundary

- Keep BOSS access read-only unless the user explicitly approves communication or application actions.
- Use one logged-in Edge profile with exactly two operator-labeled fixed tabs: `BOSS-SEARCH` for scanning and read-only detail inspection, and `BOSS-COMMUNICATION` for future communication-page inspection. Never create a per-job tab, a second window, or a second BOSS session.
- All work is serial: finish the current read-only operation and checkpoint its result before switching fixed tabs or starting the next job. The search tab locates the saved job URL; the communication tab inspects that one URL; return to search only after the item reaches a terminal state or is explicitly stopped.
- Preserve random pacing, periodic cooldowns, checkpointing, and immediate stop on login/risk-control/page-loss signals.
- No real communication or application click may occur without a separate, explicit user approval for that single click. A batch confirmation is not click approval.
- An inferred DOM selector, text guess, stale fixture, or tool-reported click success must never enable execution. A page-dependent conclusion requires redacted screenshots and DOM evidence from the actual logged-in page, followed by an immediate identity recheck before any click.
- Never trade account safety for test speed. Prefer saved DOM fixtures and fake-browser tests after a minimal live sample establishes the real page structure.

## Product quality decision boundary

- Treat JD coverage, recall, and recommendation accuracy as product quality, not disposable performance costs.
- Prefer slower pacing, random delays, staged execution, cooldown windows, cached-detail reuse, and resumable checkpoints before reducing card or detail coverage.
- Before applying any change that can materially reduce recall, JD coverage, matching accuracy, or recommendation quality, quantify the tradeoff and ask the user to decide.
- A safety cap may limit one browser window or session, but it must not silently lower the run's logical quality target. Preserve pending work and resume it later.

## Data baseline

- Do not use pre-baseline job history to validate current recall, precision, activity, runtime, or recommendation quality after screening rules change materially.
- Establish a fresh empty operational baseline before comparing a redesigned scan. Archived databases are recovery evidence only, not evaluation samples.
- Preserve candidate profiles, resumes, search plans, and model settings when resetting job history unless the user explicitly asks to remove them.
