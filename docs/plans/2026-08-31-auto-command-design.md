# Autonomous `/auto` command design

## Purpose

Add a reusable `/auto <task>` command to pi-toolkit for tasks that should run end-to-end without interactive clarification. The command must make reasonable engineering decisions from repository context and disclose those decisions after completing the work. It must remain safe when the task is ambiguous and must not interpret autonomy as permission for unrelated or irreversible actions.

## Architecture

Implement `/auto` as a Pi prompt template in `prompts/auto.md` and expose that directory through `pi.prompts` in `package.json`. Prompt templates are the smallest suitable mechanism: Pi loads the package manifest entry, expands command arguments into the prompt, and lets the current agent use its normal project tools. A TypeScript extension would add lifecycle complexity without providing useful behavior for this workflow, while a skill would be less direct to invoke.

The template requires the agent to inspect the project, implement rather than merely plan, run available validation, and avoid all user-input tools. Ambiguities are resolved with the safest minimal reversible choice consistent with project conventions. Destructive actions, production releases, credential changes, force pushes, and paid operations require explicit authorization in the original task; otherwise the agent selects a safe alternative. External blockers are reported only after all feasible work is complete.

The final response always separates the result, validation, autonomous decisions with rationale, and remaining assumptions or limitations. An empty invocation performs no changes and reports that no task was supplied rather than asking for one.

## Validation

Add a package test that reads the bundled template and verifies its frontmatter, argument expansion, no-question policy, destructive-action boundary, and required decision report. Document the command in the README so installation and usage remain discoverable.
