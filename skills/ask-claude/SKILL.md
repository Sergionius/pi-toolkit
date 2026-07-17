---
name: ask-claude
description: Consult Claude Code for investigation, debugging, architecture questions, or adversarial code review. Use when the user explicitly asks to ask/check with Claude, requests a Claude review or second opinion, or as a last resort after 4+ failed attempts at the same problem. Claude analyzes the project in plan/read-only mode; Pi evaluates the answer and must not implement recommendations without user approval.
compatibility: Requires an installed and authenticated Claude Code CLI with support for print and plan permission modes.
---

# Ask Claude

Consult Claude Code as a read-only second opinion for investigation, debugging, architecture, or code review.

## Activation Triggers

**Explicit:**

- "спроси Claude", "проверь через Claude", "что думает Claude"
- "ask claude", "check with claude", "claude review"
- "consult claude", "get Claude's opinion"

**Automatic, only as a last resort:**

- at least four failed attempts at the same bug or investigation
- several materially different approaches produced no progress
- the investigation is going in circles and there are no new reasonable hypotheses

Do not use this skill for simple questions, basic codebase navigation, or tasks whose solution is already clear.

## Safety Contract

Claude is a consultant, not an implementation agent.

- Always invoke the bundled wrapper, which forces Claude Code `--permission-mode plan`.
- Never add `--dangerously-skip-permissions` or edit-enabling flags.
- Never ask Claude to apply, commit, or push changes.
- Do not implement Claude's recommendations automatically.
- After presenting the result, stop and ask the user what to do next.

## Step 1: Check Availability

Run:

```bash
command -v claude && claude auth status
```

If the CLI is absent or unauthenticated, explain what failed and stop. Do not request or print authentication tokens.

## Step 2: Build Focused Context

Summarize the current conversation rather than dumping full files:

1. **Problem/question** — 2–3 precise sentences.
2. **Known facts** — observed behavior, errors, constraints.
3. **Relevant locations** — project-relative files and line references.
4. **What was tried** — approaches and outcomes, or "First consultation".
5. **Specific question** — exactly what Claude should determine.

Claude runs from the current project directory and can inspect files itself. Provide paths, not complete file contents. Include short error excerpts only when they are essential.

## Step 3: Construct the Prompt

Always prepend:

```text
First read project guidance files if present: AGENTS.md files from the current
working directory up to the repository root, CLAUDE.md, CLAUDE.local.md, and
.claude/rules/. Follow them while analyzing, but do not modify files.
You are a read-only consultant. Do not edit files, run mutating commands, commit,
or push. Analyze and recommend only.
```

Claude Code normally loads Claude guidance itself; the explicit preamble ensures it also checks `AGENTS.md`, which carries Pi project context.

### Investigation/debug template

```text
# Investigation Request

## Problem
[2–3 sentence description]

## Context
- Files: [path/to/file:line, ...]
- Observed: [actual behavior]
- Expected: [expected behavior]
- Constraints: [important constraints]

## What We Tried
[attempts and outcomes, or "First consultation"]

## Question
[specific question]

Provide:
1. Root cause analysis, clearly separating evidence from inference
2. Concrete recommendation with file:line references
3. Why previous approaches failed, if applicable
4. Unknowns and confidence level

Keep the response focused and actionable. Do not modify anything.
```

### Adversarial review template

For reviews, require inner structured JSON:

```text
<role>
You are performing an adversarial code review as a read-only consultant.
Your job is to find the strongest evidence that this change should not ship yet.
</role>

<task>
Review: [files, branch diff, or change description]
Focus: [user-specified area, otherwise general]
Do not modify files or run mutating commands.
</task>

<attack_surfaces>
Prioritize material failures involving:
- authentication, permissions, tenant isolation, and trust boundaries
- data loss, corruption, duplication, and irreversible changes
- rollback, retries, partial failure, and idempotency
- races, stale state, ordering, and re-entrancy
- empty, nil, timeout, offline, and degraded dependency behavior
- schema drift, migration safety, compatibility, and version skew
- observability gaps that hide failures or prevent recovery
</attack_surfaces>

<finding_bar>
Report only material findings grounded in code you can inspect.
No style feedback or unsupported speculation. Every finding must explain:
1. What can go wrong
2. Why this code path is vulnerable
3. Likely impact
4. A concrete risk-reducing change
</finding_bar>

<structured_output>
Return ONLY valid JSON, without markdown fences:
{
  "verdict": "approve" or "needs-attention",
  "summary": "short summary",
  "findings": [
    {
      "severity": "critical" or "high" or "medium" or "low",
      "title": "finding title",
      "body": "evidence and impact",
      "file": "relative/path",
      "line_start": 1,
      "line_end": 1,
      "confidence": 0.0,
      "recommendation": "concrete change"
    }
  ],
  "next_steps": ["step"]
}

Use needs-attention for any material shipping risk. Use approve only when no
substantive finding is supported by the code.
</structured_output>
```

## Step 4: Invoke Claude

Resolve the directory containing this `SKILL.md`, then run its bundled script from the project root. Pass the prompt through stdin so shell metacharacters cannot alter the command:

```bash
printf '%s' "$CLAUDE_PROMPT" | "<SKILL_DIR>/scripts/ask-claude.sh"
```

Use a Bash tool timeout of 600 seconds for normal consultations and at most 900 seconds for complex reviews. The call is synchronous because Pi does not provide Claude Code's `run_in_background`/`BashOutput` mechanism.

The wrapper enforces:

```text
claude -p
--model ${ASK_CLAUDE_MODEL:-opus}
--effort ${ASK_CLAUDE_EFFORT:-high}
--permission-mode plan
--no-session-persistence
--no-chrome
--strict-mcp-config --mcp-config '{}'
--output-format json
```

It closes Claude's stdin, checks the exit status, parses Claude Code's outer JSON envelope, and prints only its `result` field.

Do not bypass the wrapper. Optional user-level overrides:

```bash
export ASK_CLAUDE_MODEL=sonnet
export ASK_CLAUDE_EFFORT=high
```

## Step 5: Evaluate and Present

Do not relay the answer uncritically. Check file references and distinguish valid findings from unsupported claims.

### Investigation output

```text
**Claude Analysis:**

[cleaned analysis]

---

**Assessment:** [Pi's evaluation and caveats]

**Proposed action:** [recommendation, awaiting approval]
```

### Review output

Parse the inner JSON, sort findings by critical → high → medium → low, and omit findings with confidence below `0.3`.

```text
**Claude Review: [verdict]**
[summary]

**Findings** (N issues):

1. **[severity]** title (confidence: 0.90)
   path/file:line_start-line_end
   [body]
   → [recommendation]

**Next steps:** [items]

---

**Assessment:** [which findings are valid, uncertain, or false positives]
```

If the verdict is `approve` with no findings, state that Claude found no material issues.

**Stop after presenting the result and explicitly ask the user whether to proceed.**

## Troubleshooting

- **CLI missing:** install Claude Code, then check `claude --version`.
- **Not authenticated:** run `claude auth status`, then authenticate through Claude Code.
- **Timeout:** narrow the prompt first; increase the Bash timeout only when necessary.
- **Off-target result:** provide a more specific question and file:line references.
- **Invalid outer JSON:** ensure the wrapper still uses `--output-format json`.
- **Review JSON wrapped in prose:** repeat the review request and emphasize "ONLY valid JSON without markdown fences".
