# pi-toolkit

Private personal [Pi](https://pi.dev) package containing reusable extensions, skills, and the VS Code bridge used by the Flutter auto-refresh workflow.

## Included

### Extensions

- `plan/` and `goal/` — conversational plan mode and autonomous goals.
- `agterm-status.ts` — agterm active/completed status integration.
- `codex-status.ts` — Codex usage and reset-credit commands.
- `figma-context.ts` — `figma_get_screen_context` tool.
- `flutter-refresh.ts` — automatic Flutter reload/restart after successful edits.
- `notify-sound.ts` — completion sound without routine visual noise.
- `toolkit.ts` — toolkit diagnostics and VS Code bridge synchronization.

### Skills

- `figma-to-css` — workflow for implementing screens from Figma.

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
- `AGTERM_SESSION_ID` — supplied by agterm.
- `AGTERM_AGENT_STATUS_DISABLED=1` — disables agterm status reporting.
- `TAX_API_KEY` and `TAX_SERVER` — consumed by the separate Tax package.
- `PI_FLUTTER_REFRESH_DISABLED=1` — disables automatic Flutter refresh.
- `PI_FLUTTER_REFRESH_TIMEOUT_SECONDS` — bridge response timeout, default `10`.
- `PI_TOOLKIT_VSCODE_EXTENSIONS_DIR` — optional VS Code extension directory override, primarily for tests.

`config/settings.example.json` contains sanitized defaults. It is documentation only and is never copied over the active Pi settings automatically.

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

Tests load every extension, check command registration, exercise the Flutter handshake, and verify idempotent VS Code bridge synchronization in a temporary directory.

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

- `auth.json` or provider tokens;
- Pi sessions, goals, trust decisions, or model state;
- `.env` files;
- Tax queues/logs;
- generated Figma cache;
- machine-specific backup files.
