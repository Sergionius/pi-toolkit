# `/zai-usage` command design

## Goal

Show Z.ai (GLM) Coding Plan quota the same way `/codex-usage` shows Codex usage: one Pi command, a short Russian notification card. Compact scope only: both quota windows and their reset times. No model-usage statistics and no reset-pack consumption.

## Architecture and flow

`extensions/zai-status.ts` registers a single `zai-usage` command. A `fetchQuota` function calls the undocumented but widely used Z.ai monitor endpoint `GET https://api.z.ai/api/monitor/usage/quota/limit` with `Authorization: Bearer <key>` and a 15-second timeout. The key is read from `auth.json` in the Pi agent dir (`PI_CODING_AGENT_DIR` or `~/.pi/agent`), field `zai.key` — the same credential Pi itself uses, so there is no second configuration source. The key is never logged and is stripped from error messages.

`parseQuota` maps `data.limits[]` entries by `unit`: `3` is the 5-hour window, `6` is the weekly window. For each window it keeps `percentage`, `currentValue`/`usage`, and `nextResetTime` (epoch milliseconds). Unknown units are skipped silently so API additions do not break the command. `data.level` becomes the plan name.

`formatQuota` renders the Russian card, mirroring the Codex one:

```
z.ai: доступен · план lite
5ч лимит: осталось 53% (940/2000), сброс через 2 ч 05 мин (14:35)
Недельный лимит: осталось 63% (3746/10000), сброс через 2 д 18 ч
```

A window is "reached" when `remaining` is zero or `percentage` is 100; any reached window switches the first line to «лимит достигнут». Errors (missing key, non-200 HTTP, `success: false`, invalid JSON) surface through `ctx.ui.notify` as errors without the key.

## Validation

`tests/zai-status.test.mjs` (jiti, like the Codex tests) covers: exact card formatting on a fake payload, skipping unknown units, the Bearer header passing the key through a fake fetch, key redaction in failures, and `readZaiKey` against a temporary agent dir. The package-selection test gains the new entry point, and the README documents the command and its opt-in path. Tests stay offline: no real key, no network.
