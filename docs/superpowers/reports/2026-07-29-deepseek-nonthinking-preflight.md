# DeepSeek Non-Thinking Job Understanding Preflight

## Scope

- Product commit:
  `c7e185234fa5e0ccc78931303d9df5ac256ce3c0`
- Changed production behavior: official `api.deepseek.com` requests using
  `deepseek-v4-pro` or `deepseek-v4-flash` add
  `thinking: {type: "disabled"}` only for the `understandJob` stage.
- Unchanged: `matchJob`, other models, custom endpoints, invalid endpoints,
  timeout, retry count, token limit, JSON fallback, contract repair, model
  settings and model-identity inputs.

## TDD Evidence

- Red: `node tests/model_adapter_smoke.js` failed because the official
  DeepSeek V4 Pro `understandJob` body had no `thinking` field.
- Green: the same test passed after the adapter-only conditional was added.
- The test observes the actual adapter request body through a temporary local
  fetch seam; it does not make a network request or export a test-only
  production helper.

## Offline Verification

The following commands passed:

- `node tests/model_adapter_smoke.js`
- `node tests/model_parser_resilience_smoke.js`
- `node tests/semantic_pipeline_smoke.js`
- `node tests/model_settings_smoke.js`
- `node tests/private_full_chain_runner_smoke.js`
- `npm.cmd test` — all 47 offline checks passed
- `git diff --check`

The full suite's BOSS-labelled output came from fake-browser and DOM-fixture
tests. No live recruitment platform was accessed.

## Safety Boundary

- No BOSS page or browser was accessed.
- No real communication or application action occurred.
- `D:\Guo\ZhiPing\data\jobs.sqlite` was not read or written.
- Port 8787 was not started or operated.
- Formal model settings, DPAPI material and model secrets were not read during
  this offline phase.
- No prompt, JD, resume or model response content was added to Git.
- No real model call has been made for this product commit yet.
