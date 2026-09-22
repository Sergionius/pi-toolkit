# Ralphex direct plan save and workflow duration design

## Goal

Save an accepted interactive `/ralphex-plan` draft without another model turn, and report total elapsed time for both successful and failed `/ralphex-exec` and `/ralphex-auto` runs.

## Direct interactive plan save

The interactive planning prompt will require each complete draft to be wrapped in a single `<ralphex_plan>` block. The plan extension will extract that block at `agent_end` and present three explicit UI actions: save the plan, continue editing, or cancel.

Saving is performed by the extension itself. It creates `docs/plans/yyyy-MM-dd-<slug>.md` with exclusive file creation, so existing files are never overwritten. Before creating a file, it scans existing Markdown plans and compares normalized plan content. An exact match returns the existing path without creating a duplicate. A filename collision with different content uses the first free numeric suffix.

Saving and cancellation stop the interactive Ralphex planning workflow. Continuing editing performs no model call and leaves the conversation ready for user feedback. A later complete draft replaces the previous candidate. The normal Codex-style `/plan` workflow remains independent.

## Workflow duration

`/ralphex-exec` measures the whole command, including preflight, workers, retries, validation, and commits. `/ralphex-auto` measures autonomous planning and execution together; its nested exec phase does not print a second duration.

Elapsed time uses a monotonic clock and is formatted as seconds, minutes and seconds, or hours, minutes and seconds. Successful final reports include a `Время:` line. Failures and user-stopped runs include the same line in the surfaced error report.

## Validation

Tests will cover Ralphex draft extraction, explicit menu behavior, direct saving without another user message, exact duplicate reuse, collision suffixes, duration formatting, and elapsed-time output on success and failure. README documentation will describe direct confirmation and duration reporting.
