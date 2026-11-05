import type { PlanTask } from "./plan";
import { PLAN_NAMING_INSTRUCTIONS } from "./naming";

export function autonomousPlanPrompt(request: string, retryContext?: string): string {
  return `# Ralphex autonomous planning worker

Create a decision-complete Ralphex implementation plan for this request:

${request.trim()}

## Workflow

1. Read all applicable project guidance and inspect the relevant repository files and existing conventions. Trace the existing interfaces and call paths required by the risky parts of the request (for example, cancellation, persistence, authentication, or retries); do not assume an API supports an option without checking its signature and callers. Keep exploration targeted. Do not launch subagents.
2. Do not modify files, Git state, dependencies, services, or external systems. Your only output is the plan envelope below.
3. Do not ask the user questions. Resolve ordinary engineering ambiguity using the safest, smallest, reversible choice consistent with repository precedent.
4. If a safe plan requires credentials, destructive action, scope expansion, resolving contradictory requirements, or inventing incompatible public behavior without precedent, output only:
<<<RALPHEX:PLAN_BLOCKED>>>
{"reason":"concise blocking reason"}
<<<RALPHEX:END>>>
5. Record every material autonomous choice under ## Execution Notes. Use one bullet per choice in this form:
- Decision: <choice>; Alternatives: <alternatives>; Reason: <reason>; Side effects: <effects or none>
6. Use exact discovered paths. For each Task, include prerequisite changes to existing contracts in its Files and actions, or put them in an earlier Task; do not defer a necessary cross-layer dependency to the worker. Do not invent tests or infrastructure. Include existing relevant validation commands and, when behavior cannot be established by compilation alone, concrete observable acceptance scenarios and available automated checks. State what needs manual verification instead of presenting a build as proof of runtime behavior.

${PLAN_NAMING_INSTRUCTIONS}

## Required plan structure

# <title>

## Goal
## Context
## Scope
## Out of Scope (only when useful)
## Implementation Steps
### Task 1: <title>
**Files:**
- Modify/Create: <path>
- [ ] <concrete action>
## Validation
## Acceptance Criteria
## Execution Notes

Task numbers must be sequential, every Task must contain at least one unchecked checkbox, and executable checkboxes must appear only in Task sections. Group work by a coherent, independently verifiable outcome, not a fixed file, line, or checkbox limit. Split unrelated subflows or tasks that cannot leave the project in a valid state, but keep tightly coupled contract and caller changes together. Do not group all remaining screens into one Task. Before returning the plan, check that each Task's declared files cover the prerequisites you found, dependencies are ordered, and its validation can establish what it actually claims. The plan must be implementable without further product or architecture choices. Do not include review, release, push, branch, worktree, or deployment steps.

Return only:
<<<RALPHEX:PLAN>>>
<complete Markdown plan>
<<<RALPHEX:END>>>
${retryContext ? `\n## Previous attempt diagnostics\n${retryContext.slice(0, 8000)}` : ""}`;
}

export function taskPrompt(options: {
  planPath: string;
  task: PlanTask;
  auto: boolean;
  retryContext?: string;
}): string {
  return `# Ralphex task worker

Work in the current repository and execute exactly Task ${options.task.number}: ${options.task.title} from this plan:
${options.planPath}

Read the entire plan first, including Goal, Context, Scope, Validation, Acceptance Criteria, and Execution Notes. Do not execute any other Task section.

## Required workflow

1. Inspect the relevant project files, actual API signatures and call paths yourself. Compare the plan's Files and assumptions with the code before implementing. Do not launch subagents. On a retry, inspect git status and the diff first; preserve valid uncommitted work from the previous attempt instead of restarting or restoring it blindly. The previous attempt may have already changed code or the plan.
2. Complete every unchecked item in Task ${options.task.number}. Immediately before starting each unchecked item, output this progress envelope as a separate assistant message, with its 1-based position among all checkboxes in this Task, the total checkbox count, and the checkbox text:
<<<RALPHEX:PROGRESS>>>
{"stage":"checkbox","index":1,"total":3,"text":"concise checkbox text"}
<<<RALPHEX:END>>>
Do not wait for the item to finish before emitting its progress envelope. Progress envelopes are informational and do not replace editing the plan after validation.
3. Keep the task within the accepted Scope. If an existing interface or prerequisite contradicts the plan, do not repeatedly try the impossible step or silently mark it done. For a small, necessary, reversible dependency within the accepted Scope, update this Task's Files/actions and record the discovery and reason under ## Execution Notes before implementing it; preserve all previously completed items. Keep the task's outcome coherent. For a change to product behavior, Scope, public contracts without precedent, or a dependency that cannot safely be resolved in this Task, follow the Questions and decisions section instead. Do not perform code review or unrelated cleanup.
4. Format changed files using the project's existing formatter when applicable.
5. Validate before committing. Immediately before each validation command or non-regression check, output this progress envelope as a separate assistant message:
<<<RALPHEX:PROGRESS>>>
{"stage":"validation","text":"command or concise validation activity"}
<<<RALPHEX:END>>>
Then:
   - Run the commands explicitly listed in the plan when applicable to this task.
   - For a documentation-only task, validate the document against the referenced source; do not run compile, typecheck, test, or build commands unless the plan explicitly requires them for that individual task.
   - Otherwise, if the plan has no usable validation command, identify and run the project's cheapest existing non-destructive compile, analyze, typecheck, or build command.
   - Do not invent test infrastructure or run tests unless the plan explicitly asks for them. If the plan names applicable behavioral checks, run them; compilation/analyze alone cannot prove runtime behavior. Record unavailable manual or integration scenarios as limitations, not verified results.
   - Fix and rerun failures introduced by this task. For compiler/analyzer errors caused by removing const from scaled widgets, also update their const call sites (including tests); resolve each diagnostic and rerun validation rather than stopping at the first failed command. Do not fix unrelated pre-existing failures.
   - If a validation command fails only because of pre-existing issues outside this task, establish that this task did not add or worsen them by comparing diagnostics with the base commit or otherwise inspecting the affected paths. Record the command and concise non-regression evidence under ## Execution Notes, then treat that command as a non-regression pass.
   - If an applicable validation cannot run because the environment, SDK, credentials, or dependencies are unavailable, or you cannot distinguish its failure from a regression introduced by this task, do not commit and report failure.
6. Only after applicable validation passes or pre-existing failures are proven unchanged, mark all completed checkboxes in Task ${options.task.number} as [x].
7. Commit all changes for this task, including the updated plan, with a concise message in the form feat: <task summary>. Write the entire commit message in English only, regardless of the language used in the plan or user request. Do not amend an earlier commit and do not push.
8. Stop immediately after that commit. Do not continue to another Task.

## Questions and decisions

${options.auto ? `This is unattended mode. Do not ask the user questions. Resolve ordinary engineering ambiguity and missing implementation dependencies from the plan, project guidance, and existing conventions. Amend this Task for safe, necessary dependencies within the accepted Scope and record the evidence and reason under ## Execution Notes; preserve already completed work and do not silently change requirements. Stop without committing if a safe decision requires credentials, destructive action, a new incompatible public behavior without precedent, scope expansion, or resolving contradictory requirements. For such a structural blocker, preserve existing changes and output only this machine-readable signal with concrete evidence and a proposed plan correction:
<<<RALPHEX:TASK_BLOCKED>>>
{"reason":"what in the existing code blocks this Task","proposal":"specific plan change needed"}
<<<RALPHEX:END>>>
Do not use this signal for a validation failure that you can reasonably fix within the accepted Scope.` : `This is interactive mode. If a material ambiguity or plan correction cannot be resolved safely within the accepted Scope from the plan or repository, do not guess and do not modify or commit anything further. Ask one concrete question that includes the discovered mismatch and proposed correction. Output exactly:
<<<RALPHEX:QUESTION>>>
{"question":"one concrete question"}
<<<RALPHEX:END>>>
Then stop. The orchestrator will record the answer and restart this same Task in a fresh worker; preserve existing changes. For small, necessary, reversible dependencies already determined by project conventions, amend this Task and proceed without asking.`}

If the task succeeds, end with this concise machine-readable summary followed by the completion signal:
<<<RALPHEX:SUMMARY>>>
{"result":"what was implemented","sideEffects":["observable effect"],"limitations":["remaining limitation"]}
<<<RALPHEX:END>>>
<<<RALPHEX:TASK_DONE>>>
Use empty arrays when there are no side effects or limitations.
If it cannot be completed after reasonable attempts to diagnose and repair an ordinary failure, do not commit and end with <<<RALPHEX:TASK_FAILED>>>. Use TASK_BLOCKED instead only for the structural blockers described above in unattended mode; the orchestrator stops without a futile retry. Do not abandon a task merely because the first validation run reports errors. Before failing, state the concrete blocker and what you tried in a separate assistant message (the final signal remains machine-readable).
${options.retryContext ? `\n## Previous attempt diagnostics\n${options.retryContext.slice(0, 8000)}` : ""}`;
}

export type ClaudeFinding = {
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  body: string;
  file: string;
  line_start: number;
  line_end: number;
  confidence: number;
  recommendation: string;
};

export type ClaudeReview = {
  verdict: "approve" | "needs-attention";
  summary: string;
  findings: ClaudeFinding[];
  next_steps: string[];
};

export function claudeReviewPrompt(options: {
  planPath: string;
  baseCommit: string;
  previousContext?: string;
}): string {
  return `First read project guidance files if present: AGENTS.md files from the current working directory up to the repository root, CLAUDE.md, CLAUDE.local.md, and .claude/rules/. Follow them while analyzing, but do not modify files.

<role>
You are performing an adversarial code review as a read-only consultant. Find material reasons this implementation should not ship yet.
</role>

<task>
Read the accepted implementation plan at ${options.planPath}.
Review every change in: git diff ${options.baseCommit}...HEAD
Check the implementation against the plan's Goal, Scope, Task sections, Execution Notes, and Acceptance Criteria.
Do not modify files, run mutating commands, commit, or push.
</task>

<focus>
Report only actionable issues introduced by this implementation:
- incorrect or incomplete plan behavior;
- crashes, data loss, unsafe parsing, broken error handling, or regressions;
- edge cases supported by concrete code paths;
- compatibility or state-flow mistakes;
- unnecessary complexity with a concrete maintenance or correctness cost.
Do not report style preferences, missing tests when the plan does not request tests, pre-existing unrelated problems, or unsupported speculation.
</focus>

<finding_bar>
Every finding must explain what fails, cite inspectable evidence with file and line, describe impact, and give a concrete correction. Return approve only when no substantive finding is supported.
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
</structured_output>
${options.previousContext ? `\n<previous_review_context>\nDo not repeat findings already resolved or explicitly rejected unless current code provides new evidence.\n${options.previousContext.slice(-16000)}\n</previous_review_context>` : ""}`;
}

export function fixerPrompt(options: {
  planPath: string;
  findings: ClaudeFinding[];
  finalCriticalOnly?: boolean;
}): string {
  return `# Ralphex Claude-review fixer

Read the accepted plan at ${options.planPath} and inspect the current branch changes. Evaluate every Claude finding below against the actual code. Do not accept findings blindly.

${JSON.stringify(options.findings, null, 2)}

For each finding:
- confirm it with concrete code evidence or reject it as a false positive with a reason;
- fix every confirmed finding${options.finalCriticalOnly ? " (this final pass contains only critical/high findings)" : ""};
- do not expand the accepted scope or perform unrelated cleanup;
- do not add tests unless the plan explicitly requires them;
- append material implementation decisions under ## Execution Notes when committing fixes; keep rejected-finding reasons in the final report so an all-false-positive pass leaves the worktree clean.

After fixes, run the plan's applicable Validation commands. If none are usable, run the project's cheapest existing non-destructive compile, analyze, typecheck, or build command. Fix failures introduced by your changes, but do not fix unrelated pre-existing failures. A command that fails only for diagnostics proven unchanged from the base implementation is an acceptable non-regression result; record the command and evidence under ## Execution Notes. If an applicable validation cannot run or its failure cannot be distinguished from a regression, do not commit and output <<<RALPHEX:FIX_FAILED>>>.

If at least one finding was fixed and validation passed, commit all fixes and the updated plan with exactly:
fix: address code review findings

If every finding is a false positive, leave the worktree clean and do not create a commit.

End with a concise FIXED and REJECTED report, followed by exactly one signal:
<<<RALPHEX:FIX_DONE>>> or <<<RALPHEX:NO_FIXES>>> or <<<RALPHEX:FIX_FAILED>>>.
Do not push or start another review.`;
}

export function parseClaudeReview(raw: string): ClaudeReview {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(cleaned) as Partial<ClaudeReview>;
  if (!['approve', 'needs-attention'].includes(String(parsed.verdict))) throw new Error("Claude review has invalid verdict");
  if (!Array.isArray(parsed.findings)) throw new Error("Claude review has no findings array");
  const severities = new Set(["critical", "high", "medium", "low"]);
  for (const finding of parsed.findings) {
    if (!finding || !severities.has(String(finding.severity))) throw new Error("Claude review has invalid finding severity");
  }
  return {
    verdict: parsed.verdict as ClaudeReview["verdict"],
    summary: String(parsed.summary ?? ""),
    findings: parsed.findings as ClaudeFinding[],
    next_steps: Array.isArray(parsed.next_steps) ? parsed.next_steps.map(String) : [],
  };
}
