# pi-toolkit

Private personal [Pi](https://pi.dev) package containing reusable extensions, skills, and the VS Code bridge used by the Flutter auto-refresh workflow.

## Included

### Extensions

- `plan/` and `goal/` — conversational plan mode, `/ralphex-plan` implementation-plan creation, and autonomous goals. Goal continuations start only after Pi fully settles; model/provider errors pause the goal without consuming an autonomous turn or queuing retries. Resume explicitly with `/goal resume` after service recovery.
- `agterm-status.ts` — pane-aware agterm lifecycle status integration with persistent completion indicators.
- `codex-status.ts` — Codex usage and reset-credit commands.
- `codex-accounts.ts` — local multi-account manager for OpenAI/Codex OAuth profiles.
- `figma-context.ts` — `figma_get_screen_context` tool.
- `flutter-refresh.ts` — automatic Flutter reload/restart after successful edits.
- `notify-sound.ts` — completion sound without routine visual noise.
- `toolkit.ts` — toolkit diagnostics and VS Code bridge synchronization.

### Skills

- `figma-to-css` — workflow for implementing screens from Figma.
- `ask-claude` — read-only second opinion from Claude Code for debugging, investigation, architecture, and adversarial review.

### Bundled integrations

- `scripts/flutter_refresh.sh` — confirmed request/response handshake with VS Code.
- `vscode/pi-flutter-refresh-bridge/` — Dart-Code reload/restart bridge.

The Tax push/reply extension is intentionally maintained in the separate `Sergionius/tax` package.

## Install

The repository is private, so GitHub SSH access must already work:

```bash
ssh -T git@github.com
pi install git:git@github.com:Sergionius/pi-toolkit.git
```

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

## Update

```bash
pi update --extensions
```

After an update that changes the VS Code bridge, run `/reload`, `/pi-toolkit-sync-vscode`, and `Developer: Reload Window` again.

## Environment

Features are enabled by environment variables; values are never stored in this repository:

- `FIGMA_TOKEN` — Figma API access.
- `AGTERM_SESSION_ID`, `AGTERM_SOCKET`, `AGTERM_PANE`, and `AGTERM_PANE_ID` — supplied by agterm and used to target the exact session and pane.
- `AGTERM_AGENT_STATUS_DISABLED=1` — disables agterm status reporting.
- `PI_AGTERM_COMPLETED_MODE=auto-reset` — restores agterm's one-shot completion behavior. By default, completed glyphs remain until you interact with that session or the agent starts again.
- `TAX_API_KEY` and `TAX_SERVER` — consumed by the separate Tax package.
- `PI_FLUTTER_REFRESH_DISABLED=1` — disables automatic Flutter refresh.
- `PI_FLUTTER_REFRESH_TIMEOUT_SECONDS` — bridge response timeout, default `10`.
- `PI_TOOLKIT_VSCODE_EXTENSIONS_DIR` — optional VS Code extension directory override, primarily for tests.
- `ASK_CLAUDE_MODEL` — model used by the `ask-claude` skill, default `opus`.
- `ASK_CLAUDE_EFFORT` — Claude reasoning effort, default `high`.

`config/settings.example.json` contains sanitized defaults. It is documentation only and is never copied over the active Pi settings automatically.

## Ralphex plan

`/ralphex-plan` creates an implementation plan through a conversational workflow in the current Pi session:

```text
/ralphex-plan add response caching to the API client
```

Pi first inspects the relevant project files directly, summarizes the current implementation, and asks only material questions that cannot be answered from the repository. If the implementation has a meaningful architectural choice, it presents alternatives and recommends one. It then shows a complete Markdown draft and revises it until explicitly accepted.

Only after acceptance does Pi create `docs/plans/YYYYMMDD-<slug>.md`. Plans use sequential `### Task N:` sections and executable checkboxes inside those sections. Validation steps are included only when the project already has relevant checks or the user requested them; the workflow does not invent test infrastructure or coverage requirements.

The command does not use subagents, review the plan, implement it, create commits or branches, or start another workflow. If invoked without a description, it prompts for one:

```text
/ralphex-plan
```

## Ralphex execution and review

Execute an accepted plan task by task:

```text
/ralphex-exec docs/plans/YYYYMMDD-feature.md
/ralphex-exec --auto docs/plans/YYYYMMDD-feature.md
```

Each Task runs in a fresh Pi process. The worker completes exactly one `### Task N:` section, runs the plan's validation (or the project's cheapest existing compile/analyze/typecheck/build check), marks its checkboxes, and creates one `feat: ...` commit containing code plus the updated plan. One fresh retry is allowed. Existing uncommitted changes other than the plan stop execution; running on `main`, `master`, or `trunk` requires confirmation. Interactive mode surfaces material questions, while `--auto` resolves safe engineering decisions from project conventions and records them under `## Execution Notes`.

The first execution stores the pre-task HEAD in an invisible `ralphex-base` comment in the plan. Review uses that exact baseline even when execution happened on the current default branch:

```text
/ralphex-review docs/plans/YYYYMMDD-feature.md
```

Review is autonomous: the existing read-only `ask-claude` wrapper reviews the complete diff, a fresh Pi fixer validates every finding and fixes confirmed issues, and Claude reviews again. All severities are considered. There are three normal fix iterations and one final critical/high-only attempt. Fix iterations commit as `fix: address code review findings`. On approval, the plan moves to `docs/plans/completed/` in a `move completed plan: <filename>` commit.

`/ralphex-review` inherits `ASK_CLAUDE_MODEL` and `ASK_CLAUDE_EFFORT` behavior from the existing wrapper. Neither command creates or switches branches, rebases, pushes, or merges. A future `/ralphex-loop` will compose execution and review after both commands have been tested independently.

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

## agterm status

The extension reports `active --blink` on `agent_start` and `completed` on `agent_settled`, after retries, compaction retries, and queued continuations finish. Completion is sticky by default, so switching to another agterm session does not remove the completed glyph from the first one. Typing in the completed session or starting another Pi turn clears/replaces it through agterm's normal status behavior.

The integration uses `agtermctl` for status and forwards agterm's socket, pane role, and stable pane ID. After a successful completion it emits an OSC 9 notification from the originating terminal pane. Agterm then applies its native focus rules: a background app or pane gets a `+1` unseen badge, focusing it clears the badge, and a completion already visible in the focused pane does not leave a stale `+1`. The extension also clears `+1` through `session seen` on the first subsequent Pi keystroke, matching the input-driven clearing of the green completion glyph.

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
npm install
npm test
```

Tests load every extension, check command registration, exercise the Flutter handshake, verify the Claude wrapper with a mock CLI, and verify idempotent VS Code bridge synchronization in temporary directories.

## Migration from global files

After the Git package is installed and verified, archive old top-level resources to avoid duplicate command registrations:

```text
~/.pi/agent/migrated-backup/<timestamp>/
```

Archive only the extensions, skill, and `flutter_refresh.sh` that now belong to this package. Do not move `auth.json`, sessions, goals, trust, model state, or unrelated binaries.

## Rollback

```bash
pi remove git:git@github.com:Sergionius/pi-toolkit.git
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
