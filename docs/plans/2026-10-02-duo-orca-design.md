# `/duo` Orca collaboration design

## Goal

Provide one short global Pi command from the pi-toolkit package for two workflows: writable Pi implementation followed by read-only Claude review, and independent read-only Pi/Claude analysis. Avoid duplicating Orca's lifecycle reference.

## Architecture and flow

`prompts/duo.md` is a Pi prompt template discovered via the existing `pi.prompts` package manifest. `/duo <task>` selects implementation/review; `/duo parallel <task>` selects independent analysis. The current Pi session coordinates work through the installed `orchestration` skill and its version-matched Orca CLI guide. It does not launch Claude through a direct CLI or invent message-bus semantics.

In default mode Pi owns code changes, validation, and addressing verified review findings; Claude owns read-only review. In parallel mode both agents inspect independently without file edits, and Pi synthesizes their conclusions. Empty tasks start nothing. Orca/Claude failures are reported explicitly rather than silently falling back to another integration. Unrelated pre-existing changes are preserved.

## Validation

A package test verifies command discovery, skill delegation, mode boundaries, and failure behavior in the template. The README documents both invocations and requirements. No new Orca integration or skill is bundled because Orca already supplies the authoritative coordination contract.
