# Communication Background Dispatch And Stable Polling Design

## Problem

The first continued batch item exposed three separate facts:

1. The executor dispatched one browser click, observed no matching BOSS request, persisted the item as `ambiguous`, interrupted the batch, and left all later items pending with zero clicks.
2. `dispatchCommunication()` explicitly calls `Page.bringToFront`, so RoleFlow itself moves the BOSS tab to the foreground before every communication click.
3. While the batch is running, the workflow page compares a server-rendered polling key containing `workflow.successfulCount` with an API key whose public workflow payload omits that field. Once the run already has successes, the keys can never match. The page then reloads immediately after every load; the observed run made 121 `/workflow` requests in about 36 seconds.

## Requirements

- Keep the current batch stopped. Never retry the ambiguous item automatically.
- Keep one browser-level click at most for each immutable item.
- Do not call `Page.bringToFront`, `focus_tab`, or a window-focus command from communication dispatch.
- Reuse the already calibrated `Emulation.setFocusEmulationEnabled` pattern: enable it only around target recheck and `Input.dispatchMouseEvent`, then always disable it.
- Preserve the current job identity, login, risk-control, network evidence, ambiguity, and fail-closed checks.
- Keep the workflow page polling every 2.5 seconds, but reload only when the communication key actually changes.
- Add no dependency, browser abstraction, retry path, or fallback click mechanism.
- Run focused and full offline verification before creating a commit. A real BOSS click remains separately user-authorized and is not implied by offline verification.

## Design

### Background communication click

`BossSiteAdapter.dispatchCommunication()` will require `browser.cdp` and `browser.clickAt`, but it will no longer activate the tab or require `tab.active === true`. After the existing immutable-target readiness checks and network-log mark, it will enable focus emulation, recheck the fixed tab binding, recalculate and validate the guarded click point, dispatch exactly one CDP mouse click without another asynchronous tab read in between, and disable focus emulation in `finally`.

The global browser `bringToFront()` primitive remains unchanged because other workspace flows may use it. Only the communication path stops calling it.

### Stable workflow polling

The server's public workflow status will include the already persisted numeric `successfulCount`. This makes the API-side key use the same fields and values as the server-rendered initial key without adding a second key algorithm or weakening change detection.

## Verification

- A communication adapter test must fail on the current implementation because a hidden bound tab is brought forward and no focus-emulation pair is used.
- The corrected test must prove zero `bringToFront` calls, one click, no tab-list read between the final DOM guard and the click, and exact focus states `[true, false]`, including cleanup when the guard or click throws.
- A dashboard server test must prove `/api/workflow-status` exposes the same non-zero `successfulCount` used by the rendered communication polling key.
- Focused communication and workflow dashboard checks must pass.
- The complete offline suite must pass before any commit.
- A later user-driven live acceptance must confirm no foreground jump, no reload loop, and an unambiguous platform outcome before the batch is allowed to continue.
