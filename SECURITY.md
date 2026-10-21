# Security policy

## Supported versions

Security fixes are provided on the latest `main` branch. There is no separate long-term support for older Git revisions or Pi package installs pinned to a tag or commit.

## Reporting a vulnerability

When private vulnerability reporting is available, use the repository's **Security → Report a vulnerability** link. Do not open a public issue with exploit details, credentials, tokens, session files, or personal data. If private reporting is unavailable, ask the maintainer through GitHub for a private contact channel **without including the vulnerability details**.

Include the affected extension or skill, Pi version, operating system, minimal reproduction steps, and impact. Use fake credentials and redacted logs.

## Trust and local data

Pi extensions run with the current user's permissions. This package can access local files, Pi sessions and credentials; optional workflows can invoke Git, Claude Code, CDT, Figma, or Orca. Review the source before installing it or granting project trust. Only enable the extensions you need (see the [selection guide](README.md#load-only-the-extensions-you-need)).

Never commit `auth.json`, API keys, OAuth profiles, account-switch backups, `.env` files, Pi sessions, worker diagnostics, or generated Figma caches. Ralphex worker logs and release-tool logs can contain sensitive tool output even after best-effort redaction; inspect them before sharing. A package install or update executes code from the chosen source, so pin a Git tag or commit when reproducibility matters.
