# pi-toolkit

[Pi](https://pi.dev) package containing reusable extensions, prompt templates, skills, and the VS Code bridge used by the Flutter auto-refresh workflow.

## Included

### Extensions

- `plan/` — conversational plan mode and `/ralphex-plan` implementation-plan creation.
- `codex-status.ts` — Codex usage and reset-credit commands.
- `codex-accounts.ts` — local multi-account manager for OpenAI/Codex OAuth profiles.
- `commit.ts` — global `/commit` command: stages all changes and creates a local commit using the model configured by `PI_COMMIT_MODEL`, without pushing.
- `figma-context.ts` — `figma_get_screen_context` tool.
- `flutter-refresh.ts` — automatic Flutter refresh after successful edits: model changes, added class fields/constructor parameters, and Dart file rewrites trigger hot restart; ordinary UI edits use hot reload.
- `toolkit.ts` — toolkit diagnostics and VS Code bridge synchronization.

### Prompt templates

- `/auto <task>` — execute a task autonomously without questions and report every material decision made without user approval.

### Skills

- `figma-to-css` — workflow for implementing screens from Figma.
- `ask-claude` — read-only second opinion from Claude Code for debugging, investigation, architecture, and adversarial review.

### Bundled integrations

- `scripts/flutter_refresh.sh` — confirmed request/response handshake with VS Code.
- `vscode/bundled-flutter-refresh-bridge/` — bundled Dart-Code reload/restart bridge snapshot. The independently maintained `vscode/pi-flutter-refresh-bridge/` checkout is ignored by this repository.

The optional Tax push/reply extension is maintained separately in the public [`Sergionius/tax`](https://github.com/Sergionius/tax) package.

## Install

Install from the public GitHub repository (no npm publication or GitHub SSH access required):

```bash
pi install git:github.com/Sergionius/pi-toolkit
```

Pi, Node.js 22.19 or newer, and Git are required. Individual integrations have additional requirements: VS Code with Dart-Code and a running Flutter debug session for auto-refresh; `FIGMA_TOKEN` for Figma; Claude Code CLI for `ask-claude` and Ralphex review; and CDT with a configured `cdt.yaml` for optional test releases. OpenAI/Codex account commands require an existing Pi OAuth login. Only use a package whose source you trust: installing a Pi package executes its extension code.

Reload Pi after installation:

```text
/reload
```

Install or update the bundled VS Code bridge:

```text
/pi-toolkit-sync-vscode
```

Then run `Developer: Reload Window` in VS Code.

Check the installation:

```text
/pi-toolkit-doctor
```

Create a local commit from any Git repository:

```text
/commit
```

The command runs `git add .` from the repository root, asks a separate ephemeral Pi process using the required `PI_COMMIT_MODEL` environment variable with low reasoning for a validated Conventional Commit message, and runs `git commit`. It never pushes. For example: `export PI_COMMIT_MODEL="zai/glm-5.3-flash"`.

## Update

```bash
pi update --extensions
```

After an update that changes the bundled VS Code bridge, run `/reload`, `/pi-toolkit-sync-vscode`, and `Developer: Reload Window` again. Updating the separate bridge repository does not automatically update this package's bundled snapshot.

## Environment

Features are enabled by environment variables; values are never stored in this repository:

- `FIGMA_TOKEN` — Figma API access.
- `PI_COMMIT_MODEL` — required model for `/commit`, for example `zai/glm-5.3-flash`.
- `TAX_API_KEY` and `TAX_SERVER` — consumed by the separate Tax package.
- `PI_FLUTTER_REFRESH_DISABLED=1` — disables automatic Flutter refresh.
- `PI_FLUTTER_REFRESH_TIMEOUT_SECONDS` — bridge response timeout, default `10`.
- `PI_TOOLKIT_VSCODE_EXTENSIONS_DIR` — optional VS Code extension directory override, primarily for tests.
- `ASK_CLAUDE_MODEL` — model used by the `ask-claude` skill, default `opus`.
- `ASK_CLAUDE_EFFORT` — Claude reasoning effort, default `high`.

`config/settings.example.json` contains sanitized defaults. It is documentation only and is never copied over the active Pi settings automatically.

## Autonomous execution

Run a task end-to-end without clarification or confirmation prompts:

```text
/auto fix the failing tests and verify the build
```

The agent investigates the project, resolves ambiguity using safe and reversible choices, performs the work, and runs available validation. It does not perform destructive or irreversible actions unless they were explicitly requested in the original task. The final report lists the result, checks, assumptions, limitations, and all material decisions made without consulting the user.

Invoking `/auto` without a task makes no changes and reports the missing task instead of asking for input.

## Ralphex plan

`/ralphex-plan` creates an implementation plan through a conversational workflow in the current Pi session:

```text
/ralphex-plan add response caching to the API client
```

Pi first inspects the relevant project files directly, summarizes the current implementation, and asks only material questions that cannot be answered from the repository. If the implementation has a meaningful architectural choice, it presents alternatives and recommends one. It then shows a complete Markdown draft with a **Save plan / Continue editing / Cancel** menu.

Choosing **Save plan** creates `docs/plans/yyyy-MM-dd-<slug>.md` directly without another model turn. An exact existing plan is reused, while filename collisions with different content receive a numeric suffix. Plans use sequential `### Task N:` sections and executable checkboxes inside those sections. Validation steps are included only when the project already has relevant checks or the user requested them; the workflow does not invent test infrastructure or coverage requirements.

The command does not use subagents, review the plan, implement it, create commits or branches, or start another workflow. If invoked without a description, it prompts for one:

```text
/ralphex-plan
```

For unattended plan-only use, add `--auto`. This uses the same read-only autonomous planning worker as `/ralphex-auto`, records selected options, alternatives, reasons, side effects, assumptions, and limitations in `## Execution Notes`, but does not execute the plan:

```text
/ralphex-plan --auto --model openai-codex/gpt-5.6-sol add response caching
```

Scripts can request one stable JSON result and use its `status` field as authoritative:

```bash
pi -p '/ralphex-plan --auto --json --model openai-codex/gpt-5.6-sol add response caching' > plan-result.json
PLAN=$(jq -r 'select(.status == "planned") | .plan' plan-result.json)
pi -p "/ralphex-exec --auto --model zai/glm-5.3-flash $PLAN"
```

The JSON includes `plan`, `model`, `decisions`, `alternatives`, `reason`, `sideEffects`, `assumptions`, and `limitations`. Blocked planning returns `{"status":"blocked","phase":"planning","reason":"..."}` and creates no plan.

## Autonomous Ralphex planning and execution

Configure separate default models for autonomous planning and execution:

```text
/ralphex-models
```

The command selects global or current-project scope and then chooses both models from Pi's authenticated model catalogue. Global defaults are stored without credentials in `${PI_CODING_AGENT_DIR:-~/.pi/agent}/ralphex.json`; trusted-project overrides are stored in `.pi/ralphex.json`. Non-interactive configuration is also supported:

```text
/ralphex-models --global --plan openai-codex/gpt-5.6-sol --exec zai/glm-5.3-flash
/ralphex-models --project --exec zai/glm-5.3-flash
```

Create a plan and execute it immediately without questions, manual acceptance, Claude review, release, or push:

```text
/ralphex-auto добавь сепараторы на странице localhost:3000/claims/list
```

One-run model overrides take precedence over project and global settings:

```text
/ralphex-auto --plan-model openai-codex/gpt-5.6-sol --exec-model zai/glm-5.3-flash добавь сепараторы
```

The planning worker inspects the repository, chooses safe minimal reversible answers to ordinary ambiguity, records decisions, alternatives, rationale, and side effects under `## Execution Notes`, and saves a validated plan in `docs/plans/`. The existing task-by-task exec workflow then runs with the execution model. Missing or unauthenticated models stop before planning and never fall back silently. The final report lists the models, implementation, validation, autonomous decisions, side effects, assumptions, and limitations. The checked plan remains in `docs/plans/` because review and completed-plan movement are intentionally skipped.

If execution is interrupted, resume with the reported command:

```text
/ralphex-exec --auto --model zai/glm-5.3-flash docs/plans/yyyy-MM-dd-feature.md
```

## Ralphex execution and review

Execute an accepted plan task by task:

```text
/ralphex-exec docs/plans/yyyy-MM-dd-feature.md
/ralphex-exec --auto docs/plans/yyyy-MM-dd-feature.md
/ralphex-exec --auto --model zai/glm-5.3-flash docs/plans/yyyy-MM-dd-feature.md
```

Each Task runs in a fresh Pi process. The worker completes exactly one `### Task N:` section, runs the plan's validation (or the project's cheapest existing compile/analyze/typecheck/build check), marks its checkboxes, and creates one `feat: ...` commit containing code plus the updated plan. One fresh retry is allowed. Existing uncommitted changes other than the plan stop execution. On `main`, `master`, or `trunk`, interactive execution offers to continue directly, cancel, or create/switch to a `ralphex/<plan-name>` branch; an existing generated branch is reused for resume. `--auto` treats the explicit unattended invocation as approval to create task commits on the current branch. Interactive mode surfaces material questions, while `--auto` resolves safe engineering decisions from project conventions and records them under `## Execution Notes`. Final success and failure reports include total elapsed time; `/ralphex-auto` reports planning and execution together.

The first execution stores the pre-task HEAD in an invisible `ralphex-base` comment in the plan. Review uses that exact baseline even when execution happened on the current default branch:

```text
/ralphex-review docs/plans/yyyy-MM-dd-feature.md
```

Review is autonomous: the existing read-only `ask-claude` wrapper reviews the complete diff, a fresh Pi fixer validates every finding and fixes confirmed issues, and Claude reviews again. All severities are considered. There are three normal fix iterations and one final critical/high-only attempt. Fix iterations commit as `fix: address code review findings`. On approval, the plan moves to `docs/plans/completed/` in a `move completed plan: <filename>` commit.

`/ralphex-review` inherits `ASK_CLAUDE_MODEL` and `ASK_CLAUDE_EFFORT` behavior from the existing wrapper. Neither command creates or switches branches, rebases, pushes, or merges.

Run both phases as one resumable workflow with:

```text
/ralphex-loop yyyy-MM-dd-feature.md
/ralphex-loop --auto yyyy-MM-dd-feature.md
```

The loop resumes from plan state: it executes remaining Task sections, or skips directly to review when all tasks are checked. With no argument it selects active plans from `docs/plans/`. Internal exec/review completion messages are suppressed; the loop emits one final report after the whole workflow succeeds. A failure stops the current phase, preserves the working state, and reports the exact resume command. The final report includes task/review counts, validation status, completed plan path, and recorded Execution Notes when present.

### Optional CDT test release

After successful review, `/ralphex-review` and `/ralphex-loop` can run a non-production CDT pipeline:

```text
/ralphex-review --release test yyyy-MM-dd-feature.md
/ralphex-review --release test --id BTL-123 yyyy-MM-dd-feature.md
/ralphex-loop --auto --release test --id BTL-123 yyyy-MM-dd-feature.md
```

`--id` is optional and repeatable. Ralphex verifies `cdt.yaml`, runs CDT pipeline inspect/plan/preflight, rejects every production-like pipeline, starts `cdt agent-release` detached, and waits for its exact run ID for up to 90 minutes. Release failure or timeout does not undo or fail an already completed plan; the final report includes the reason, run ID, status command, and log path.

After a successful release, Ralphex commits non-ignored release changes with `chore: release <version> [for IDs]` (or a pipeline-based fallback message), then pushes the current branch. A push failure is reported as a warning but does not change the completed result. Release is intentionally unsupported by `/ralphex-exec`, because code must pass Claude review before distribution.

## Ask Claude

The `ask-claude` skill invokes Claude Code as a read-only consultant when the user explicitly asks for a Claude opinion/review or when an investigation is stuck after multiple failed attempts.

Requirements:

```bash
claude --version
claude auth status
```

Force-load the skill with:

```text
/skill:ask-claude
```

The bundled wrapper uses `claude -p`, `--permission-mode plan`, disables session persistence, Chrome, and external MCP configuration, and returns only Claude's result. It never applies recommendations automatically; Pi presents and evaluates the answer, then asks for approval.

Defaults and optional overrides:

```bash
export ASK_CLAUDE_MODEL=opus   # or sonnet
export ASK_CLAUDE_EFFORT=high  # low, medium, high, xhigh, max
```

## Multiple Codex accounts

Pi stores one `openai-codex` credential at a time. The toolkit can keep multiple local profiles and atomically switch the active credential without putting tokens in Git.

Initial setup:

```text
/codex-account-save primary
/logout
/login
/codex-account-save secondary
```

Available commands:

```text
/codex-account-save <name>
/codex-account-list
/codex-account-current
/codex-account-switch [name]
/codex-account-remove <name>
```

`/codex-account-switch` first saves a refreshed active credential when its account ID still matches, backs up `auth.json`, replaces only the `openai-codex` entry, and exits Pi. Resume the same project/session with:

```bash
pi -c
```

Profiles are stored locally in `${PI_CODING_AGENT_DIR:-~/.pi/agent}/codex-accounts.json` with mode `0600`; the directory uses mode `0700`. `auth.json.codex-switch.bak` contains the most recent pre-switch auth state and is also mode `0600`. Neither file is part of this repository.

Recovery after an interrupted or incorrect switch:

```bash
cp "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/auth.json.codex-switch.bak" \
   "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/auth.json"
chmod 600 "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/auth.json"
```

Restart Pi after recovery. Profile names may contain only letters, digits, `_`, and `-`.

## Flutter refresh

The workflow is:

```text
Pi edit/write
→ agent_settled
→ scripts/flutter_refresh.sh
→ atomic request with ID
→ VS Code checks the active Dart session/workspace
→ Dart-Code reload/restart
→ atomic response
→ confirmed Pi result
```

The Flutter application must be running through the same VS Code workspace. Use `Pi Flutter Bridge: Diagnose` in the VS Code Command Palette if the bridge reports a timeout or missing debug session.

Manual test from a Flutter project root:

```bash
/path/to/pi-toolkit/scripts/flutter_refresh.sh reload
```

## Development

```bash
npm ci
npm test
npm audit --omit=dev
```

Tests load every extension, check command registration, exercise local commit behavior, exercise the Flutter handshake, verify the Claude wrapper with a mock CLI, and verify idempotent VS Code bridge synchronization in temporary directories.

## Migration from global files

After the Git package is installed and verified, archive old top-level resources to avoid duplicate command registrations:

```text
~/.pi/agent/migrated-backup/<timestamp>/
```

Archive only the extensions, skill, and `flutter_refresh.sh` that now belong to this package. Do not move `auth.json`, sessions, goals, trust, model state, or unrelated binaries.

## Rollback

```bash
pi remove git:github.com/Sergionius/pi-toolkit
```

Restore archived resources to `~/.pi/agent/`, run `/reload`, and restore the previous VS Code bridge directory if required.

## Security boundaries

Never commit:

- `auth.json`, `codex-accounts.json`, account-switch backups, or provider tokens;
- Pi sessions, goals, trust decisions, or model state;
- `.env` files;
- Tax queues/logs;
- generated Figma cache;
- machine-specific backup files.
