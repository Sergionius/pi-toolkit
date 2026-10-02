# `/duo` Orca collaboration design

## Goal

Provide one short global Pi command from the pi-toolkit package for three workflows: writable Pi implementation followed by read-only Claude review, independent read-only Pi/Claude analysis, and read-only analysis followed by a bounded exchange of arguments. Avoid duplicating Orca's lifecycle reference.

## Architecture and flow

`prompts/duo.md` is a Pi prompt template discovered via the existing `pi.prompts` package manifest. `/duo <task>` selects implementation/review; `/duo parallel <task>` selects independent analysis; `/duo discuss <task>` selects independent analysis followed by at most two exchange rounds. The current Pi session coordinates work through the installed `orchestration` skill and its version-matched Orca CLI guide. It does not launch Claude through a direct CLI or invent message-bus semantics.

In default mode Pi owns code changes, validation, and addressing verified review findings; Claude owns read-only review. In parallel mode both agents inspect independently without file edits, and Pi synthesizes their conclusions. In discuss mode, Pi first preserves independent analysis, then relays arguments to Claude via Orca and weighs Claude's critique; a second exchange round is optional when substantial disagreement remains. Follow-up rounds use fresh Dispatches after settlement rather than mail to a completed worker. Neither agent edits files in either analysis mode. Empty tasks start nothing. Orca/Claude failures are reported explicitly rather than silently falling back to another integration. Unrelated pre-existing changes are preserved.

## Validation

A package test verifies command discovery, skill delegation, mode boundaries, and failure behavior in the template. The README documents both invocations and requirements. No new Orca integration or skill is bundled because Orca already supplies the authoritative coordination contract.
