# Autonomous script-friendly Ralphex plan design

## Purpose

Extend `/ralphex-plan` with an unattended plan-only mode for scripts. It must use the same autonomous planning engine and decision policy as `/ralphex-auto`, save a validated plan without executing it, and report every selected option, rejected alternative, reason, side effect, assumption, and limitation.

## Interface

Keep the current command unchanged by default:

```text
/ralphex-plan <task>
```

Add:

```text
/ralphex-plan --auto [--model provider/model] [--json] <task>
```

Model precedence is:

```text
--model → trusted project planModel → global planModel
```

Missing, unknown, or unauthenticated models stop before planning without falling back to the current session model. Empty autonomous requests stop without opening an input dialog.

## Workflow

Reuse the planning worker, prompt, strict envelope parser, validation, one fresh retry, collision-safe filename generation, and read-only tool allowlist used by `/ralphex-auto`. Extract or expose the shared planning operation rather than introducing a second prompt or decision policy.

The worker inspects project guidance and relevant files, resolves ordinary ambiguity using minimal safe reversible choices, and records material decisions under `## Execution Notes` in the existing structured form:

```text
- Decision: <choice>; Alternatives: <options>; Reason: <reason>; Side effects: <effects or none>
```

It may also record `Assumption:` and `Limitation:` entries. Credentials, destructive actions, contradictory requirements, scope expansion, and unsupported incompatible behavior produce a blocked result. The command writes only the generated plan under `docs/plans/`; it does not execute tasks, review, commit, release, or push.

## Output

Without `--json`, emit a human-readable report containing status, model, plan path, decisions, alternatives, reasons, side effects, assumptions, and limitations.

With `--json`, emit one stable JSON result suitable for `jq`:

```json
{
  "status": "planned",
  "plan": "docs/plans/20260911-feature.md",
  "model": "openai-codex/gpt-5.6-sol",
  "decisions": [
    {
      "decision": "selected option",
      "alternatives": ["other option"],
      "reason": "project-aligned rationale",
      "sideEffects": ["observable consequence"]
    }
  ],
  "assumptions": [],
  "limitations": []
}
```

Blocked JSON uses `status: "blocked"` and includes `phase` and `reason`. Human and JSON reports are derived from the saved plan's Execution Notes, not reconstructed from memory. Because Pi owns process exit behavior for slash commands, consumers must treat the JSON `status` field as authoritative; the extension must not promise a nonzero process exit code that the command API cannot guarantee.

## Validation

Tests cover argument parsing, preservation of the existing interactive path, model precedence, no prompt on empty autonomous input, shared planner use, structured decision parsing, human output, JSON output, blocked output, and absence of execution/review side effects. README examples document shell use and chaining the returned `plan` into `/ralphex-exec`.
