# Ralphex Live Checkbox Progress

## Goal

Show which checkbox `/ralphex-exec` is currently executing without marking plan work complete before validation succeeds.

## Design

Keep the Markdown plan transactional: the worker continues changing the current Task's `[ ]` checkboxes to `[x]` only after implementation and applicable validation pass. Live progress is communicated separately through structured assistant-text signals.

Before starting each checkbox, the task worker emits:

```text
<<<RALPHEX:PROGRESS>>>
{"stage":"checkbox","index":2,"total":4,"text":"Update error handling"}
<<<RALPHEX:END>>>
```

Before validation it emits the same envelope with `stage: "validation"` and a concise description of the command or validation activity. The Ralphex extension parses signals from worker assistant messages and retains the latest valid progress state for the running Task.

The existing widget displays the Task title on its first line. Its second line shows `Checkbox N/M · <text>` or `Validation · <text>`. Tool activity may be displayed alongside or after the selected checkbox context, but must not replace that context. If the worker emits no valid progress event, the current tool-activity display remains the fallback.

Malformed JSON, unsupported stages, invalid counters, and empty text are ignored. Progress reporting never determines task success, changes plan parsing, or affects retries. On retry, progress resets and is reconstructed from new worker signals. Questions, completion markers, validation, commit verification, and final checkbox handling retain their existing behavior.

## Testing

- Parse valid checkbox and validation progress envelopes.
- Reject malformed or semantically invalid progress payloads.
- Verify task prompts require progress before each checkbox and before validation.
- Verify widget text formatting while retaining current checkbox context during tool activity.
- Preserve existing task-completion and plan checkbox semantics.
