# Contributing to pi-toolkit

## Setup

```bash
git clone https://github.com/Sergionius/pi-toolkit.git
cd pi-toolkit
npm ci
npm test
npm audit --omit=dev --audit-level=moderate
```

Node.js 22.19 or newer is required. Some integration tests use Bash and Python 3. Pi is required to try extensions interactively; individual workflows may also need Orca, Claude Code, CDT, Flutter, or VS Code. You do not need those integrations to work on unrelated extensions.

## Changes

- Keep each extension independently selectable through the `pi` manifest in `package.json`. Add a new entry point to the package-selection tests and document how to enable it.
- Include tests for changed behavior and update the README when commands, setup, or dependencies change.
- Keep tests isolated from real Pi credentials and sessions. Use temporary directories and fake tokens; never commit `auth.json`, API keys, account backups, production logs, or real application artifacts.
- Respect the difference between safe local checks and actions with side effects: do not make tests push, release, or use real provider credentials.
- Keep the bundled VS Code bridge snapshot in `vscode/bundled-flutter-refresh-bridge/` in sync with changes to its independent source repository.

## Pull requests

Keep pull requests focused. Describe the user-facing change, any security or compatibility implications, and which checks you ran. If an integration needs credentials or external software for manual testing, state what you could not verify.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in a public issue.
