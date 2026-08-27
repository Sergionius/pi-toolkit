# Codex–Kimi Provider Switch Design

## Goal

Add a provider switcher for Pi that changes the default provider between OpenAI Codex and Kimi For Coding. This is separate from the existing Codex account manager: `/provider-switch` changes provider/model, while `/codex-account-switch` changes the active Codex OAuth account.

Kimi uses the built-in `kimi-coding` provider and an API key saved through `/login kimi-coding`. The extension must never copy or expose provider credentials.

## User interface

Register these commands:

```text
/provider-switch
/provider-switch codex
/provider-switch kimi
```

Without an argument, the command targets the other supported provider. Explicit arguments select that provider directly and are offered through argument completion.

Before changing anything, show a confirmation equivalent to the existing Codex account switch:

```text
Switch provider?
Switch to Kimi / <model> and exit Pi?
Resume this session with: pi -c
```

Cancellation leaves the process and all files unchanged. Selecting the already active provider only displays a notification and does not restart Pi. After a successful change, Pi exits gracefully; the user resumes manually with `pi -c`.

## Architecture and storage

Implement a separate `extensions/provider-switch.ts` extension and reusable file/state helpers under `extensions/lib/`. Do not add provider responsibilities to `codex-accounts.ts`.

Store non-secret state at `${PI_CODING_AGENT_DIR:-~/.pi/agent}/provider-switch.json`:

```json
{
  "version": 1,
  "lastModels": {
    "openai-codex": "gpt-5.6-sol",
    "kimi-coding": "kimi-for-coding"
  }
}
```

The state file and backup use mode `0600`; the agent directory uses mode `0700`. The extension records the current model before switching and restores the last valid model for the target provider.

Update only `defaultProvider` and `defaultModel` in `settings.json`, preserving all unknown fields. Use an atomic temporary-file write followed by rename. Before mutation, create `settings.json.provider-switch.bak`.

## Model resolution and data flow

Provider aliases map as follows:

- `codex` → `openai-codex`
- `kimi` → `kimi-coding`

On invocation:

1. Wait for Pi to become idle.
2. Resolve the current and target providers.
3. Verify that the target provider exists and has configured authentication.
4. Read the available target-provider models from the model registry.
5. Prefer the remembered target model when it is still available.
6. On first use, choose the provider's current/default coding model when identifiable.
7. If the remembered/default model is unavailable or ambiguous, show a selector containing only current models from the target provider.
8. Ask for confirmation.
9. Save the current provider/model in `provider-switch.json`.
10. Atomically update state and settings.
11. Notify the user and call `ctx.shutdown()`.

If Kimi authentication is missing, instruct the user to run `/login kimi-coding` and choose API-key authentication.

## Failure handling

Malformed settings or state files produce an error and no mutation. Validate the state schema and version before use.

Treat the settings and state update as one logical operation. If a failure occurs after `settings.json` changes, restore it from the in-memory original or backup. Do not shut down Pi unless all writes succeed. Temporary files must be removed on failure.

A disappeared remembered model is not an error: ask the user to select a current model and replace the stale state after confirmation.

## Testing

Add unit tests covering:

- Codex-to-Kimi and Kimi-to-Codex switching;
- explicit arguments and argumentless toggling;
- cancellation with no file changes;
- remembering the current model and restoring the target model;
- stale target models and replacement selection;
- missing Kimi authentication;
- already-active provider behavior;
- malformed settings/state JSON;
- write failure and settings rollback;
- preservation of unrelated settings fields;
- `0600` state/backup permissions;
- absence of credentials in provider-switch state.

Update package-load tests for the new extension and document Kimi setup and commands in `README.md`.

## Non-goals

- Managing multiple Kimi accounts.
- Combining provider switching with Codex account switching.
- Automatically launching a replacement Pi process.
- Storing or transforming Codex/Kimi credentials.
