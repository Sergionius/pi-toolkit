# Ralphex Default-Branch Choice Design

## Goal

Make interactive `/ralphex-exec` safer and more convenient when invoked on `main`, `master`, or `trunk` by offering to execute the plan in a dedicated branch.

## User Experience

When interactive execution starts on a default branch, replace the existing boolean confirmation with a three-option selection:

1. Execute on the current default branch.
2. Create or switch to a branch derived from the plan filename.
3. Cancel execution.

For a plan named `docs/plans/20260912-self-release-pipeline.md`, the generated branch is `feature/self-release-pipeline`: remove the `.md` extension and a leading date in either `YYYYMMDD-` or `YYYY-MM-DD-` form, sanitize the remaining text for a Git branch component, and add the `feature/` prefix.

Interactive execution on non-default branches remains unchanged. Unattended `--auto` execution also remains unchanged and continues on the current branch without prompting.

## Branch Handling

The existing execution preflight remains responsible for repository and working-tree safety. It must reject unrelated uncommitted changes before attempting any checkout. The plan file may remain as the only uncommitted path.

If the generated branch does not exist locally, create and switch to it from the current default-branch HEAD. If it already exists locally, switch to it and continue execution there. Do not stash, force checkout, reset, delete branches, or resolve conflicts automatically. If Git cannot switch safely, stop and report the underlying error clearly.

After switching, reread and revalidate the plan from the target branch before selecting the first task or determining the baseline commit. This ensures resumed execution uses the branch's current plan state rather than content read before checkout.

## Implementation

- Replace the default-branch `ctx.ui.confirm` call in `ensureExecPreflight` with `ctx.ui.select`.
- Add small helpers for deriving and validating the generated branch name and for detecting a local branch.
- Run `git switch <branch>` for an existing branch or `git switch -c <branch>` for a new one.
- Return the post-switch plan state and baseline consistently to the execution workflow.
- Keep existing direct execution and cancellation behavior available through explicit menu choices.

## Error Handling

Cancel before making repository changes when the user chooses Cancel. Surface branch-switch failures without starting a worker. Reject a filename that cannot produce a safe non-empty branch component. Remote-only branches are out of scope; only an existing local branch is resumed automatically.

## Validation

Add tests covering:

- the three choices shown on a default branch;
- direct execution leaves the current branch unchanged;
- creating the derived branch, including date removal;
- switching to an existing local branch;
- cancellation;
- post-switch plan rereading and baseline selection;
- switch failures caused by conflicting working-tree state;
- unchanged behavior on feature branches and with `--auto`.
