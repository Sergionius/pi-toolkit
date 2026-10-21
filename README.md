# pi-toolkit

[Pi](https://pi.dev) package containing reusable extensions, prompt templates, and skills. The optional Flutter integration lives in [VS-Code-Flutter-bridge](https://github.com/Sergionius/VS-Code-Flutter-bridge).

## Included

### Extensions

- `plan/` — conversational plan mode and `/ralphex-plan` implementation-plan creation. Plan Mode state lives in a lock-protected `~/.pi/agent/plan-state.json` (atomic writes, 30-day pruning of inactive sessions) and survives concurrent Pi processes; if the state file is corrupt, commands fail loudly instead of silently leaving Plan Mode. The Plan Mode bash guard is a conservative heuristic over command structure (word-based, quote-aware), not a shell sandbox: it blocks common write patterns (installs, `sed -i`, output redirects, `tee`, `git rm/clean`, command substitution) but cannot guarantee to catch every mutating form.
- `backlog-choice.ts` — interactive choice menu for the backlog skill outside Plan Mode.
- `codex-status.ts` — Codex usage and reset-credit commands. The ChatGPT bridge user agent defaults to the pinned Codex CLI version and can be overridden with `PI_CODEX_USER_AGENT`; a reset-credit request is never retried automatically because a timeout may still have consumed the credit.
- `codex-accounts.ts` — local multi-account manager for OpenAI/Codex OAuth profiles.
- `commit.ts` — global `/commit` command: stages all changes and creates a local commit using the model configured by `PI_COMMIT_MODEL`, without pushing. Untracked files that will be included are listed in a warning before staging.
- `figma-context.ts` — `figma_get_screen_context` tool. Caches exports in the private toolkit directory (`~/.pi/agent/cache/figma/`, or `PI_CODING_AGENT_DIR`), never in the working repository; the last good generation stays readable if a refresh fails.
- `later.ts` — `/later <delay> <command or message>` schedules loaded extension/skill/prompt commands or plain messages (`/later 30m /ralphex-exec plan.md`, `/later 1h30m check the build`). Delays use `h`/`m`/`s`, up to 24h. Waits for the agent to be idle; overdue tasks remain cancellable with `/later cancel <id|all>` and visible in `/later list`. `/compact [instructions]` is supported explicitly; other built-in and unknown commands are rejected. Countdown updates every second. In-memory only: switching/forking sessions, shutdown, or `/reload` clears tasks.
- `toolkit.ts` — toolkit integration diagnostics.

### Prompt templates

- `/auto <task>` — execute a task autonomously without questions and report every material decision made without user approval.
- `/duo <task>` — Pi implements and Claude reviews through Orca; `/duo parallel <task>` compares independent read-only analyses; `/duo discuss <task>` adds a bounded argument exchange.

### Skills

- `figma-to-css` — workflow for implementing screens from Figma.
- `ask-claude` — read-only second opinion from Claude Code for debugging, investigation, architecture, and adversarial review.
- `backlog` — Git-backed deferred-work list in each project's `docs/backlog/`; adapted from [cc-thingz](https://github.com/umputun/cc-thingz) (MIT).

Flutter auto-refresh is installed separately from [VS-Code-Flutter-bridge](https://github.com/Sergionius/VS-Code-Flutter-bridge). Tax push/reply is installed separately from [`Sergionius/tax`](https://github.com/Sergionius/tax).

## Install

Install from GitHub (repository access is required while this repository is private; once public, GitHub SSH access is not required):

```bash
pi install git:github.com/Sergionius/pi-toolkit
```

Pi, Node.js 22.19 or newer, and Git are required. Individual integrations have additional requirements: `FIGMA_TOKEN` for Figma; Claude Code CLI for `ask-claude` and Ralphex review; and CDT with a configured `cdt.yaml` for optional test releases. OpenAI/Codex account commands require an existing Pi OAuth login. Only use a package whose source you trust: installing a Pi package executes its extension code.

Reload Pi after installation:

```text
/reload
```

### Load only the extensions you need

The default installation loads all toolkit resources. To load fewer extensions, replace the **existing** pi-toolkit entry in `~/.pi/agent/settings.json` with the object in [`config/package-selection.example.json`](config/package-selection.example.json). Keep your other packages and settings unchanged; do not add a second pi-toolkit entry. If your installed source uses an SSH Git URL, keep that exact `source` value instead of the HTTPS-style one in the example.

The example loads only `/commit`, `/later`, and the `backlog_choice` tool. Add exact paths to its `extensions` list to opt in to other workflows:

| Workflow | Add these paths |
| --- | --- |
| Plan Mode and Ralphex | `+extensions/plan/index.ts`, `+extensions/ralphex/index.ts` |
| Figma | `+extensions/figma-context.ts` |
| Codex accounts | `+extensions/codex-accounts.ts` |
| Codex usage | `+extensions/codex-status.ts` |
| Orca Ralphex status | `+extensions/orca-ralphex-status.ts` (use with Plan Mode/Ralphex) |
| Toolkit doctor | `+extensions/toolkit.ts` |

For example, add both Plan Mode and Ralphex paths to get `/plan`, `/ralphex-plan`, `/ralphex-exec`, and the other planning commands. `pi config` provides an interactive alternative for enabling individual resources. Run `/reload` after changing settings and check that only the chosen commands are available.

This filters **what Pi loads**, not what `pi install` downloads: the whole repository and its dependencies are still installed and updated together. Skills (`ask-claude`, `backlog`, `figma-to-css`) and prompts (`auto`, `duo`) remain loaded unless filtered separately with the package entry's `skills` and `prompts` fields. For example, `"skills": []` and `"prompts": []` disable all toolkit skills and prompts. Ralphex review needs the `ask-claude` skill; `/duo` needs Orca and its skills. Filtering does not change other packages or globally installed skills.

For Flutter auto-refresh, install [VS-Code-Flutter-bridge](https://github.com/Sergionius/VS-Code-Flutter-bridge) as a separate Pi package. See [migration instructions](#migrating-flutter-auto-refresh) if you previously used the bundled bridge.

Check the toolkit installation:

```text
/pi-toolkit-doctor
```

Create a local commit from any Git repository:

```text
/commit
```

The command runs `git add .` from the repository root, asks a separate ephemeral Pi process using the required `PI_COMMIT_MODEL` environment variable with low reasoning for a validated Conventional Commit message, and runs `git commit`. It never pushes. For example: `export PI_COMMIT_MODEL="zai/glm-5.3-flash"`.

## Backlog

After installing this package and running `/reload`, use `/skill:backlog` to inspect the current project's backlog, `/skill:backlog <slug>` for one item, or `/skill:backlog --all` to decide on every item in turn. Deferred findings go in `docs/backlog/<slug>.md` in the **project being worked on**, not this package. An optional `priority: p0 | p1 | p2` frontmatter field records known urgency; omit it when urgency is unknown, and keep priority out of filenames. The `backlog_choice` tool presents an interactive menu (including in normal mode, not only Plan Mode). Cancelling a menu makes no changes; without an interactive UI the workflow stops rather than assuming approval. The skill does not fix items or commit without your authorization. Git is required.

## Update

```bash
pi update --extensions
```

Run `/reload` after updating the toolkit. Update the Flutter bridge separately with `pi update git:github.com/Sergionius/VS-Code-Flutter-bridge`.

## Environment

Features are enabled by environment variables; values are never stored in this repository:

- `FIGMA_TOKEN` — Figma API access.
- `PI_COMMIT_MODEL` — required model for `/commit`, for example `zai/glm-5.3-flash`.
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

## Pi + Claude via Orca

Use the installed package's `/duo` prompt in any Pi project with Orca and a configured Claude agent:

```text
/duo fix the login error
/duo parallel investigate ways to speed up list loading
/duo discuss investigate ways to speed up list loading
```

In the default mode, the current Pi session implements and tests the task, then delegates read-only code review to Claude through Orca orchestration. Pi assesses and fixes verified findings and reruns relevant checks. In `parallel` mode, Pi and Claude independently investigate without editing files; Pi compares their evidence and proposes a solution without implementing it. In `discuss` mode, the same independent investigation is followed by up to two read-only rounds of exchanging arguments through Orca; Pi reports the conclusion and any unresolved disagreement without implementing it. The prompt loads Orca's existing `orchestration` skill and version-matched CLI guide rather than maintaining its own command reference. Missing Orca or Claude is reported as a blocker, not silently replaced with another integration. Run `/reload` after updating the package to discover the command.

## Ralphex plan

`/ralphex-plan` creates an implementation plan through a conversational workflow in the current Pi session. By default it selects the saved `planModel` from `/ralphex-models` (project override for trusted projects, then global); interactive planning switches the current session model and leaves it selected after planning. Use `--default` to keep the current Pi model or `--model provider/model` to select one explicitly for this run. These flags are mutually exclusive. Without a saved model, specify one of these flags or configure `/ralphex-models`:

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

Configure separate saved models for planning and execution (interactive or autonomous):

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
/ralphex-auto add row separators to localhost:3000/claims/list
```

One-run model overrides take precedence over project and global settings:

```text
/ralphex-auto --plan-model openai-codex/gpt-5.6-sol --exec-model zai/glm-5.3-flash add row separators
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
/ralphex-exec --default docs/plans/yyyy-MM-dd-feature.md
```

Execution uses the saved `execModel` by default. `--default` uses the current Pi model instead; `--model provider/model` overrides both. The two flags cannot be combined. If no exec model is configured, choose one explicitly or run `/ralphex-models`. The same selection applies to the execution phase of `/ralphex-loop`.

Each Task runs in a fresh Pi process. The worker completes exactly one `### Task N:` section, runs the plan's validation (or the project's cheapest existing compile/analyze/typecheck/build check), marks its checkboxes, and creates one `feat: ...` commit containing code plus the updated plan. One fresh retry is allowed. Existing uncommitted changes other than the plan stop execution. In a repository with no commits, Ralphex first stages all non-ignored files and creates a `chore: initial commit` baseline (empty if there are no stageable files); check `.gitignore` before running. On `main`, `master`, or `trunk`, interactive execution offers to continue directly, cancel, or create/switch to a `feature/<plan-name>` branch; an existing generated branch is reused for resume. `--auto` treats the explicit unattended invocation as approval to create task commits on the current branch. Interactive mode surfaces material questions, while `--auto` resolves safe engineering decisions from project conventions and records them under `## Execution Notes`. Final success and failure reports include total elapsed time; `/ralphex-auto` reports planning and execution together.

New plan drafts (Plan Mode, interactive Ralphex, and autonomous planning) include `<!-- plan-slug: meaningful-english-name -->`. The model translates the task meaning into concise English kebab-case; filenames and new execution branches use this slug, never Cyrillic transliteration or a copied legacy backlog name. Titles and bodies may remain in the user's language. Localized legacy plans need this metadata before a new branch can be derived; existing files and branches are not renamed. New backlog filenames follow the same English naming rule. English legacy drafts and filenames remain supported; syntax validation cannot determine whether an ASCII word is English or transliterated.

Worker diagnostics preserve each attempt (including retries) for 7 days in a private `$TMPDIR/pi-toolkit-<uid>-worker-logs/attempt-*/attempt.json`, outside the repository. Retention is configurable with `RALPHEX_WORKER_LOG_RETENTION_DAYS` (expired completed attempts are pruned on the next worker start). Directories use mode `0700`, files `0600`; logs contain redacted JSON events, stderr, exit status and final worker error, but not the invocation prompt. Secrets are redacted structurally before serialization on a best-effort basis: logs may still contain sensitive source/tool output, so inspect before sharing. Failure reports list unmet completion conditions and log paths; retries receive the same diagnostic. A recovered intermediate model error does not fail a successful later response, but final JSON errors/aborts fail even with exit code zero.

The worker watchdog defaults to 10 minutes without stdout/stderr activity **outside active tool calls**. Configure `RALPHEX_WORKER_IDLE_TIMEOUT_MS` (milliseconds, `0` disables). Silent active tools are exempt; optionally set `RALPHEX_WORKER_TOOL_TIMEOUT_MS` for a separate maximum tool duration (default `0`, unlimited). On timeout, terminate the worker and its descendants with TERM, escalating to KILL after 5 seconds (Windows uses `taskkill /T /F`); the same process-tree kill applies to `runCommand` timeouts (git pushes, CDT waits).

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

## Migrating Flutter auto-refresh

Flutter auto-refresh, its helper, and the VS Code extension are maintained together in [VS-Code-Flutter-bridge](https://github.com/Sergionius/VS-Code-Flutter-bridge). Update pi-toolkit first so its old Flutter listener is gone, then run `/reload` in Pi **before** installing the new package:

```bash
pi update git:github.com/Sergionius/pi-toolkit
# In Pi: /reload
pi install git:github.com/Sergionius/VS-Code-Flutter-bridge
```

Run `/reload` again, then `/pi-flutter-bridge-sync` and `Developer: Reload Window` in VS Code. If you configured a direct path to the old `extensions/flutter-refresh.ts`, remove it to avoid duplicate refreshes. `/pi-toolkit-sync-vscode` is replaced with `/pi-flutter-bridge-sync`. The bridge repository documents manual installation, environment variables, and rollback.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, and pull request guidelines; report vulnerabilities as described in [SECURITY.md](SECURITY.md).

```bash
npm ci
npm test
npm audit --omit=dev
```

Tests load every toolkit extension, check command registration, exercise local commit behavior, and verify the Claude wrapper with a mock CLI. Flutter bridge and handshake tests live in the separate Flutter repository.

## Migration from global files

After the Git package is installed and verified, archive old top-level resources to avoid duplicate command registrations:

```text
~/.pi/agent/migrated-backup/<timestamp>/
```

Archive only the extensions and skills that belong to this package. Do not move `auth.json`, sessions, goals, trust, model state, or unrelated binaries.

## Rollback

```bash
pi remove git:github.com/Sergionius/pi-toolkit
```

Restore archived resources to `~/.pi/agent/` and run `/reload`.

## Security boundaries

Never commit:

- `auth.json`, `codex-accounts.json`, account-switch backups, or provider tokens;
- Pi sessions, goals, trust decisions, or model state;
- `.env` files;
- generated Figma cache;
- machine-specific backup files.
