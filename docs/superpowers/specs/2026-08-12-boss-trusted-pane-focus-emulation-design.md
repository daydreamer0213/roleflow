# BOSS trusted pane short-focus activation design

Date: 2026-08-12  
Status: approved for implementation

## Decision

`trusted_pane` remains RoleFlow's only current BOSS detail path for calibration,
Gate D, and normal product scans. When the fixed search tab must switch from
one job card to another, RoleFlow will:

1. enable CDP focus emulation on the existing `BOSS-SEARCH` tab;
2. recheck the fixed tab binding and search-page identity;
3. locate the exact card by job ID and validate its component identity,
   coordinates, viewport position, and hit target;
4. dispatch the existing single trusted CDP mouse click;
5. recheck the fixed tab binding and search-page identity;
6. disable focus emulation immediately after the click attempt in `finally`;
7. poll the right pane while the page is hidden and keep every existing job-ID,
   title, loading-state, and complete-JD check.

The page is not brought to the Windows foreground. `Page.bringToFront` remains
available for other explicit browser workflows, but `readVisiblePaneDetail()`
will no longer call it.

## Evidence

The current trusted click path calls `Page.bringToFront` before
`Input.dispatchMouseEvent`. In the current Edge bridge environment, that CDP
command activates Edge at the Windows level.

Three fresh, isolated read-only calibrations established the actual boundary:

- `trusted-pane-background-click-20260812-180738`: a hidden-page mouse click
  without either activation mechanism failed to change the pane.
- `trusted-pane-focus-emulation-20260812-181636`: focus emulation around the
  whole activation/read cycle succeeded for 3/3 non-current jobs without a
  foreground transition.
- `trusted-pane-focus-click-only-20260812-182647`: focus emulation limited to
  card location and the click succeeded for 3/3 non-current jobs. JD lengths
  were 689, 1242, and 788 characters; `Page.bringToFront` calls were 0; the
  foreground monitor observed only ChatGPT; the page was hidden after every
  click and after cleanup.

The final calibration database has `PRAGMA quick_check=ok`, zero foreign-key
violations, zero leases, and zero scan runs. It is calibration-only and is not
eligible for Gate D quality evaluation.

The evidence shows that the trusted CDP mouse event needs a page-level
focused/active state, not Windows foreground ownership. It does not justify
changing detail coverage, opening standalone detail pages, or using the
search-page API.

## Scope

Production behavior changes only in:

- `src/adapters/sites/boss.js`

Regression coverage changes only in:

- `tests/source_acquisition_smoke.js`

The existing browser adapters already expose `cdp(tabId, method, params)`.
Using that method directly is the smallest compatible change and avoids adding
a one-use abstraction.

## Failure behavior

The activation branch is fail-closed:

- both `browser.cdp` and `browser.clickAt` must exist before card location;
- enabling focus emulation, locating the card, clicking, and the post-click
  identity checks execute inside one `try`;
- disabling focus emulation executes in `finally`, including when location,
  click, abort, tab binding, login, risk-control, or page identity checks fail;
- a failed disable is fatal and cannot be reported as a successful detail;
- there is no fallback to `Page.bringToFront`, DOM/Vue synthetic clicks,
  `standalone_detail`, navigation, new tabs, or `search_page_api`.

Existing access reservation, random pacing, cooldowns, checkpointing, stop
signals, risk-control handling, and complete-JD requirements remain unchanged.

## Regression contract

The focused source-acquisition test must prove:

- a non-current card uses exactly one focus-emulation enable, one trusted click,
  and one focus-emulation disable;
- the disable occurs immediately after post-click tab/page checks and before
  right-pane polling continues;
- `bringToFront` and `navigate` are not called;
- an invalid activation point performs no click and still disables emulation;
- a click or post-click identity failure still disables emulation and
  propagates the original fatal browser error when cleanup succeeds;
- missing CDP or trusted-click capability fails before card location;
- a cleanup failure is fatal and cannot return detail success;
- slow right-pane loading retains the existing 60-poll window.

The full offline suite must pass before any new live calibration.

## Live acceptance sequence

After offline verification:

1. create a new empty calibration baseline that preserves only profile,
   resume, search-plan, and model settings;
2. run a small product-lifecycle scan using default `trusted_pane`, with no
   subtask messages and a Windows foreground monitor;
3. require successful complete-JD reads, fixed-tab integrity, no login or risk
   signal, no new tab/window, and no Edge foreground transition;
4. discard the calibration database from quality evaluation;
5. create a separate new empty formal baseline;
6. run the complete five-keyword daily Gate D with
   `maxDetailTotal=220`, serial pacing, and `trusted_pane`;
7. export the formal evaluation exactly once only after a real terminal state.

`search_page_api` remains frozen as a future extension. `standalone_detail`
remains rejected for this workflow. Wave 5 remains paused.
