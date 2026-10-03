---
name: backlog
description: Read, work, and maintain a Git repo's deferred-work items in docs/backlog/, one file per item. Use when the user says "backlog", "check backlog", "what's on my backlog", "work the backlog", "address the backlog", "add to backlog", "clean up backlog", or when a review or task produced items that are real but not being fixed now. Owns the item format and the create-then-delete lifecycle.
license: MIT (see LICENSE)
---

# Backlog

Adapted from [umputun/cc-thingz](https://github.com/umputun/cc-thingz/blob/master/plugins/workflow/skills/backlog/SKILL.md), © 2026 Umputun, MIT license (see `LICENSE`).

Use Pi's `read`, `edit`, `write`, and `bash` tools for file and Git operations. Use `backlog_choice` for interactive decisions: pass `{ "question": "...", "options": ["recommended action", "leave unchanged"] }` with 2–4 unique labels, recommended first. Only an explicitly selected label authorizes that action; a cancelled or unavailable menu is not consent. If the user explicitly asks only to read the backlog, report it without prompting to mutate.

`docs/backlog/` at a repo root holds work that is real but not being done now: a defect a change did not
introduce, drift with no user-visible symptom, a fix whose blast radius exceeded its value, an idea worth
keeping. One file per item. It is the maintainer's own list — it never gates anything and never reaches a
contributor.

The directory path is fixed, so every invocation in a repo reads and writes one predictable store.

**Git only.** The lifecycle is expressed in Git — `git rm` to close an item, branch detection before
writing, staging and committing the file. Outside a Git repository, say so plainly and stop; do not
improvise an equivalent in another VCS.

## Item format

`docs/backlog/<slug>.md`. The slug names the defect, not the file it lives in
(`reopen-fallback-ignores-frontmost.md`), so it can be cited from a commit and dedupe is a filename check.
Use concise, meaningful **English kebab-case** for new filenames, regardless of the user's language.
Translate the meaning; never transliterate (use `publish-android-app-bundle.md`, not
`publikatsiya-android-app-bundle.md`). The H1 and body may stay in the user's language.
When turning an item into a plan or a new branch, choose an English slug independently rather than
copying a legacy transliterated filename. Ralphex plans must include `<!-- plan-slug: english-task-name -->`.
Do not automatically rename existing items, plans, or branches; preserve their references and dedupe
by meaning and location as well as filename.

```markdown
---
worth: later
where: internal/window/library.go:537
added: 2026-08-05
---
# reopen fallback ignores the last-frontmost window

`reopen`'s fallback ignores which window was last frontmost once `frontmost` is nil, so a multi-window
user's last-window capture replays only when the exited window happened to be `windows.first`. Surfaced
reviewing PR #370; the fix touches restore ordering, which is why it was deferred rather than done inline.
```

Three existing frontmatter fields, plus an optional `priority`. Do not put priority in the filename.
Fields are written once except where **Appending** below allows updates or when new evidence changes priority:

- **`worth: yes | no | later`** — the triage call, and the field the list is ordered by:
  - **`yes`** — the value is agreed and it should be fixed. Says nothing about schedule: an item
    blocked on an upstream release is still `yes` if nobody disputes it is worth doing.
  - **`later`** — the value decision itself is unresolved, not the work. The body must name the unknown
    or the condition that would settle it; without that it is a `yes` or a `no` in disguise.
  - **`no`** — a decision not to fix, kept so the same finding is not rediscovered and re-argued by the
    next review that touches the file. Keep a `no` only while that rationale still earns its place; once
    it does not, delete the file rather than carrying it.
- **`priority: p0 | p1 | p2`** — optional urgency, separate from `worth`. Use `p0` only for a
  verified critical issue needing immediate action, `p1` for significant impact that should be addressed
  soon, and `p2` for known lower-impact work. Omit the field when impact or urgency is unknown; do not
  guess `p2` as a default. Reassess it when evidence changes. The filename remains a stable descriptive slug.
- **`where: path:line`** — omit when the item is not anchored to one place. Its path narrows the dedupe
  search alongside the slug and the line is a navigation hint that moves. Compare paths only when both
  items have `where`; two items missing it are not thereby the same item.
- **`added: YYYY-MM-DD`** — never updated, so it reads as age. A year-old item is itself information.
  Zero-pad it so the values sort lexically.

The H1 is the title. The body below it has no required sections — repro, what was tried, the review that
surfaced it, links, a snippet, in whatever shape suits. A two-line item stays two lines, a gnarly one gets
a page. Two items owe one sentence each, which a two-line body can carry: a `later` names the unknown that
would settle its value decision, and a `no` records why the fix was rejected, without which it cannot do
the anti-rediscovery job it is kept for.

## Lifecycle

Create the file. When the work lands, `git rm` it in the commit that lands the fix — not a separate cleanup
commit. There is no checkbox, no in-progress marker: the staged deletion is the state. Dropping an item
decided against is the same operation with a different reason.

## Briefing an item

Both argument forms below put the same four things on screen before asking anything about an item, as
ordinary output before calling `backlog_choice`. The menu should name the item and carry the
one-line reason for its recommendation.

- **Summary** — what the item is and why it was filed, in your own words, one or two sentences. Not the
  H1 restated and not the body pasted back.
- **Effort** — what the fix costs: the files and call sites it touches, whether a test already covers the
  path, and whether it is mechanical or a design decision still to be made.
- **Blast radius** — what else the change can reach. Callers, generated files, anything sharing the code
  path, and whether it reverts cleanly. "Contained" is a claim about what depends on the code, so check
  before making it.
- **Materiality** — who is affected today, how badly, and what leaving it costs. Most items have no
  user-visible symptom; say so rather than inflating one.

Each of the last three is ONE line carrying a word and the fact behind it — the word alone asks the user
to take the call on trust, the fact is what lets him disagree with it, and the length is what keeps the
briefing readable above its question. Judge all four against the repo as it stands rather than against
the item's own account: the reasoning in a file goes stale the same way its `where` does.

## Every item as the argument

`/skill:backlog --all` walks every current item to a disposition. Check this mode before slug handling.
An argument that starts with `-` is option syntax, so a file whose name begins with `-` cannot be reached
as a slug; `all.md` is still an ordinary slug and unaffected.

1. Use `bash` to list `docs/backlog/*.md` from the repo root and read every file in full. Keep `worth: no` items in the
   walk: worth informs the recommendation, it does not filter the list.
2. Before asking anything, verify every `where` and analyze each item's value, complexity, and blockers.
   Identify explicit blockers and relationships between items, ask about real prerequisites before their
   dependents, and carry each relationship into EVERY affected item's briefing — a prerequisite's own
   materiality rises because fixing it unblocks another, so the context runs both ways. The serial flow
   decides one item at a time, so a relationship is context for a question rather than a joint decision.
   For a blocker outside the backlog, recommend leaving the item and name the blocker.
3. Take the items ONE AT A TIME: print that item's briefing, ask about it alone with **`backlog_choice`**
   with the recommended disposition first, carry out the answer, and only then move to the next. Never
   brief several items and ask afterwards — a batch of briefings is a wall of text with no decision
   attached to any of it, and the answer to one item routinely changes the next. Number them, `item N of
   M`, so the walk's length is visible from the first question. Use the concrete actions from the list
   flow below rather than a single action for the whole list.
4. Carry out each answer before asking about the next item. Immediately before an accepted fix or drop
   — both mutate, a leave does not — re-read the item and verify its `where` again, because an earlier
   fix may have moved or changed it. If that materially changes the recommendation or any part of the
   briefing, print the updated briefing and ask about that item again — an answer given against a
   briefing now known to be stale is not an answer to act on.
   Apply the usual tests, formatters, and linters, and `git rm` a fixed or dropped item under the
   lifecycle rule above.
5. Continue until every item has a disposition. Never auto-commit. If the user later authorizes commits,
   default to one commit per independent fix with its item deletion; pure drops may share one backlog-only
   cleanup commit.

## A slug as the argument

`/skill:backlog <slug>` names one item: `docs/backlog/<slug>.md`, the file name without its extension. Read
that file alone, verify its `where` the same way step 2 below does when it has one, print the briefing
above for it, and go straight to the fix-or-drop question — skip the listing, which is not what was
asked for. A slug matching no file is a mistake worth saying plainly: report it and list what is there
instead of guessing at the nearest name.

## Reading and working the list

1. Use `bash` to list `docs/backlog/*.md` from the repo root and read each file's frontmatter and H1. If the directory
   does not exist, say so plainly and offer to start one — do not create it empty.
2. **Verify before reporting.** `where` goes stale when a file is renamed or a line moves. For each item
   that has one, check the location still exists and still says what the item claims; report a stale item
   as stale rather than as work. An item without `where` has nothing to verify — carry it through as-is.
3. Report every item, one line each — `yes` first, then `later`, then `no`; within `yes`, order by
   `priority` (`p0`, `p1`, `p2`, then unset), oldest `added` first for ties. Within `later` and `no`, order
   by oldest `added` first: priority does not override an unresolved or negative value decision. Show
   priority when set and say "unprioritized" when absent; include `where` when present. Do not editorialize;
   the item already carries its reasoning. If asked for the first/highest-priority item to fix, consider
   `worth: yes` only and use that ordering. Before acting on a selected item, check its current impact and
   blockers; if an unprioritized item could be more urgent or the ranking is uncertain, explain the
   uncertainty and ask rather than inventing a priority. Never treat missing priority as `p2`.
4. Offer concrete actions with **`backlog_choice`**, with the recommendation first. Use 2–4 unique option labels and always include a leave/no-change option; cancellation or tool failure is not permission to act:
   - **fix a named item now** — name the specific item in the option label, not "fix something";
   - **drop a named item** — a `no` whose rationale has stopped earning its place;
   - **leave it** — report only, nothing changes.

   With more than four items, group them across several menus rather than truncating the list.
5. On "fix it now": do the work under the usual gates — tests, formatters, linters — and `git rm` the file.
   If the user later authorizes a commit, include the fix and deletion in that same commit. Never auto-commit.

## Appending

When a run produces deferred items, offer to append them; never write silently.

**Never add a backlog item to an unrelated work branch.** Repo-wide notes dropped into someone else's
in-progress branch get swept into that branch's diff or vanish with it. Check the branch before creating
the directory or writing any file:

1. Detect the repository's default branch: read `git symbolic-ref refs/remotes/origin/HEAD` and strip
   the `refs/remotes/origin/` prefix. If that command fails or returns nothing — it exits non-zero when
   the ref is not symbolic, which is the usual signal — fall back to two ordered passes with
   `git rev-parse --verify`, remote first and complete before local: `refs/remotes/origin/master`, then
   `refs/remotes/origin/main`, then `refs/remotes/origin/trunk`; only if none of the three resolves, try
   `refs/heads/master`, then `refs/heads/main`, then `refs/heads/trunk`. Never interleave the two passes
   per candidate — a repo migrated to `main` can keep a stale local `master`, and checking local `master`
   before remote `main` picks the dead branch as the default. Probe the full ref paths, so a tag of the
   same name cannot answer for a branch.
2. Compare it with `git branch --show-current`. If no default branch was found at all, say so and take
   the "anywhere else" case below: there is nothing to compare against, so the answer must come from
   the user rather than from a guess.
   - **On the default branch** — write in place.
   - **Anywhere else** — report the current branch by name, or `detached HEAD at <sha>` when the command
     returns nothing, and ask whether to write in this checkout anyway. On yes, write here. On no, change
     nothing: do not create a branch, a worktree, or a temp checkout, do not switch the current checkout,
     and do not pick a destination the user did not name.

**Dedupe before writing.** The `where` path and the slug find the candidates; what settles it is the defect
each one claims. A shared path is not a duplicate on its own, since one file holds several unrelated defects,
and the trailing line moves with any edit above it. A pre-existing defect surfaces in every
review that touches its file, so the same item arrives repeatedly. If it is already there, say so and leave
it alone. If the new sighting sharpens the description or changes the `worth` or `priority` call, edit
that file in place rather than adding a second one.

Create `docs/backlog/` if it does not exist — after the branch check above, never before it.

When the files are written, read `git diff --cached --name-only` before offering anything. Nothing has
been staged yet at that point, so anything it lists is pre-existing — including another backlog file from
an earlier run. If it lists anything at all, do not commit: report what is staged and let the user resolve
it, because a plain `git commit` would sweep it in alongside the item. With an empty index, offer the next
step with **`backlog_choice`**, staging the exact paths this invocation created or edited and not the
directory — an item bundled with the run's other changes violates the rule below. Never commit without that
answer. Offer commit and push together: a backlog item is notes with no code in it, and unpushed it stays
invisible from every other machine, so the push is part of filing rather than an upsell.

## Rules

- **Never post a backlog item to a PR, MR, or issue thread** unless the user explicitly asks. These are the
  maintainer's cleanup notes; surfacing them on a contributor's change reads as scope pressure.
- **Never auto-commit** an item file, and never commit it alongside unrelated work.
- **Do not fix an item without being asked.** Reading the backlog is not permission to work it.
- **Prefer deleting to demoting** for an item nobody will ever do and whose reasoning nobody needs — say
  so and offer to drop it. This does not reach a `no` that is still doing its job of stopping a
  rediscovery; that one stays.
