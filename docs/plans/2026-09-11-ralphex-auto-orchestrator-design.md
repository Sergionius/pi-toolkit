# Ralphex autonomous plan-and-exec design

## Purpose

Add `/ralphex-auto <task>` for a fully autonomous Ralphex workflow that creates an implementation plan and immediately executes it without Claude review, release, push, or manual plan acceptance. Planning and execution use independently configurable models. Every material autonomous choice, rationale, alternative, assumption, and side effect must remain available in the plan and final report.

Example:

```text
/ralphex-auto --plan-model openai/gpt-5.6-sol --exec-model zai/glm-5.3-flash добавь сепараторы на странице localhost:3000/claims/list
```

## Architecture

Implement the workflow in the existing Ralphex extension as a dedicated orchestrator:

```text
request → planning worker → validated plan file → existing exec workflow → final report
```

The planning worker runs in a fresh Pi process with the selected planning model. It reads project guidance and relevant repository context, creates a decision-complete Ralphex plan, and does not modify implementation files. It resolves ordinary ambiguity with the safest minimal reversible choice consistent with project conventions. It must not ask the user questions. Credentials, destructive operations, scope expansion, contradictory requirements, or unsupported incompatible behavior produce a blocked result rather than a guess.

The worker returns the plan in a strict output envelope. Ralphex validates required sections, sequential `### Task N:` headings, executable checkboxes, Validation, Acceptance Criteria, and Execution Notes. Invalid output is retried once in a fresh context with diagnostics. No plan is written if both attempts fail. A valid plan is saved without overwrite to `docs/plans/YYYYMMDD-<slug>.md`.

Ralphex then invokes the existing `executePlan()` path in unattended mode. `executePlan()` gains an explicit model override so every task worker uses the configured execution model rather than the current session model. The current checkbox, validation, clean-worktree, task-commit, retry, and resume guarantees remain unchanged. The workflow intentionally does not call Claude review, move the plan to `completed/`, run CDT, push, or release.

## Model configuration

Model resolution uses this precedence:

```text
command flags → trusted project config → global config
```

Files:

- global: `~/.pi/agent/ralphex.json`;
- project: `.pi/ralphex.json`.

Each file may contain either or both fields:

```json
{
  "planModel": "openai/gpt-5.6-sol",
  "execModel": "zai/glm-5.3-flash"
}
```

Project settings may partially override global defaults. Configuration stores model identifiers only and never credentials. Project configuration is read only for a trusted project.

Add `/ralphex-models` with an interactive flow for scope, planning model, and execution model. Choices come from Pi's effective available model catalogue. Cancellation leaves the existing file unchanged. Save the complete result atomically and display the effective models after success. Also support non-interactive configuration:

```text
/ralphex-models --global --plan openai/gpt-5.6-sol --exec zai/glm-5.3-flash
/ralphex-models --project --exec zai/glm-5.3-flash
```

`/ralphex-auto` supports one-run overrides through `--plan-model` and `--exec-model`. Both effective models are required. Before any planning or mutation, resolve each model through Pi's registry and verify provider authentication. Missing, unknown, or unauthenticated models stop the workflow with a precise error; there is no fallback to the current session model.

For direct recovery and reuse, `/ralphex-exec` also accepts `--model provider/model`, equivalent to its execution-model override.

## Autonomous decisions and reporting

The generated plan includes `## Execution Notes`. Planning decisions use a consistent representation containing:

- `Decision` — the selected behavior;
- `Alternatives` — meaningful options that were not selected;
- `Reason` — why the chosen option is safest or best aligned with the project;
- `Side effects` — observable consequences or `none`;
- assumptions and limitations where applicable.

Task workers continue appending material execution decisions and non-regression evidence. They also return a concise machine-readable task summary envelope. A malformed optional summary does not invalidate otherwise successful execution: closed checkboxes, a new task commit, and a clean worktree remain the authoritative completion checks. The final report falls back to the plan's Execution Notes.

A successful report includes:

- planning and execution models;
- saved plan path;
- completed task and commit counts;
- validation result;
- what was implemented;
- autonomous decisions, alternatives, and rationale;
- side effects;
- assumptions and limitations.

The completed plan remains in `docs/plans/` because the review/completion workflow is deliberately skipped.

On planning failure, no plan or implementation changes remain. On execution failure, the plan and completed task commits remain intact. The blocked report identifies the phase and reason and prints a resumable command using the same execution model:

```text
/ralphex-exec --auto --model provider/model docs/plans/<plan>.md
```

## Commands

```text
/ralphex-auto [--plan-model provider/model] [--exec-model provider/model] <task>
/ralphex-models [--global|--project] [--plan provider/model] [--exec provider/model]
/ralphex-exec --auto [--model provider/model] <plan>
```

An empty `/ralphex-auto` invocation performs no work and reports that a task is required rather than opening an interactive question. This preserves the command's unattended contract.

## Validation

Extend the Ralphex tests to cover:

- argument parsing with natural-language tasks and model flags;
- flag, project, and global precedence with partial overrides;
- atomic global and project configuration updates;
- interactive selection and cancellation without partial writes;
- project trust enforcement;
- unknown and unauthenticated model rejection before mutation;
- separate planning and execution model propagation;
- strict generated-plan parsing, validation, retry, and collision-safe save;
- autonomous decision and side-effect persistence;
- task execution through the existing exec invariants;
- absence of Claude review, release, push, and completed-plan movement;
- successful and blocked final reports;
- recovery through `/ralphex-exec --auto --model`.

Update the package README with setup and invocation examples. Run the existing package test suite and TypeScript checks used by the repository.
