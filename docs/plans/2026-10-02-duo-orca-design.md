# Pi + Claude Orca collaboration design

Updated after separating the analysis workflows into their own commands.

## Goal

Provide three short global Pi commands from the pi-toolkit package: `/duo` for writable Pi implementation followed by read-only Claude review, `/parallel` for independent read-only Pi/Claude analysis, and `/discuss` for read-only analysis followed by a bounded exchange of arguments. Avoid duplicating Orca's lifecycle reference.

## Architecture and flow

`prompts/duo.md`, `prompts/parallel.md`, and `prompts/discuss.md` are Pi prompt templates discovered via the existing `pi.prompts` package manifest. `/duo <task>` implements with review; `/parallel <task>` analyzes independently; `/discuss <task>` adds at most two exchange rounds. The current Pi session coordinates work through the installed `orchestration` skill and its version-matched Orca CLI guide. It does not launch Claude through a direct CLI or invent message-bus semantics.

For `/duo`, Pi owns code changes, validation, and addressing verified review findings; Claude owns read-only review. For `/parallel`, both agents inspect independently without file edits, and Pi synthesizes their conclusions. For `/discuss`, Pi first preserves independent analysis, then relays arguments to Claude via Orca and weighs Claude's critique; a second exchange round is optional when substantial disagreement remains. Follow-ups obey the current Orca guide (including its finished-worker behavior and placement exceptions), rather than hardcoding a Dispatch rule. Neither agent edits files in either analysis command. Empty tasks start nothing. Orca/Claude failures are reported explicitly rather than silently falling back to another integration. Unrelated pre-existing changes are preserved.

## Validation

Package tests verify command discovery, skill delegation, mode boundaries, and failure behavior in the templates. The README documents all three invocations and requirements. No new Orca integration or skill is bundled because Orca already supplies the authoritative coordination contract.
