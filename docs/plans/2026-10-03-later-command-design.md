# Later: delayed command execution

## Goal

Run any slash command or plain message after a user-specified delay, so workflows like `/later 30m /ralphex-exec plan.md` can be queued without keeping the user at the keyboard.

## Design

A new `extensions/later.ts` registers a single universal command:

- `/later <delay> <payload>` — schedules the payload. A payload starting with `/` is dispatched as a command; anything else is sent as a plain user message.
- `/later list` — shows pending tasks with ids and remaining time.
- `/later cancel <id|all>` — cancels one task or everything.

The delay is a concatenation of `h`, `m`, and `s` units (`90s`, `45m`, `1h30m`), capped at 24 hours to stay far from the `setTimeout` 32-bit overflow range.

At fire time the extension calls `pi.sendUserMessage(payload, { expandPromptTemplates: <payload starts with "/">, deliverAs: "followUp" })`. `expandPromptTemplates` dispatches extension commands, skill commands, and prompt templates instead of sending the text to the model. `deliverAs: "followUp"` is ignored while the agent is idle and queues the message behind active work otherwise, so one call covers both cases without holding a stale context.

State is in-memory only: a `LaterScheduler` keeps a `Map` of tasks with incrementing integer ids and real `setTimeout` timers. Timers are created inside the command handler, never in the extension factory. `session_shutdown` clears all timers; `session_before_switch` and `session_before_fork` cancel pending tasks with a notification, because delayed payloads usually reference the session they were created in. `/reload` replaces the extension runtime and therefore drops pending tasks; this is a documented limitation of the in-memory design.

Scheduling and firing report through `ctx.ui.notify`, and a `later: N pending` status line via `ctx.ui.setStatus` reflects the queue. UI calls at fire time use the most recently seen context and are guarded, since the context may have been replaced.

Parsing, formatting, and the scheduler are exported pure helpers so tests do not need timers longer than milliseconds.

## Validation

`tests/later.test.mjs` covers delay parsing (units, invalid tokens, cap), argument parsing branches (schedule, list, cancel, usage), scheduler behavior (fire, cancel, cancelAll, clear), and end-to-end command dispatch through a fake `pi`: command payloads carry `expandPromptTemplates: true`, plain messages do not, and session switches cancel pending tasks. `tests/package-load.test.mjs` gains the extension in its entry-point list and the `later` command in its once-only registry check. Run `npm test`.
