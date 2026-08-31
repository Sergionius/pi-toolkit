import type { PlanTask } from "./plan";

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

1. Inspect the relevant project files and conventions yourself. Do not launch subagents.
2. Complete every unchecked item in Task ${options.task.number}. Immediately before starting each unchecked item, output this progress envelope as a separate assistant message, with its 1-based position among all checkboxes in this Task, the total checkbox count, and the checkbox text:
<<<RALPHEX:PROGRESS>>>
{"stage":"checkbox","index":1,"total":3,"text":"concise checkbox text"}
<<<RALPHEX:END>>>
Do not wait for the item to finish before emitting its progress envelope. Progress envelopes are informational and do not replace editing the plan after validation.
3. Keep the task within the accepted Scope. Do not perform code review or unrelated cleanup.
4. Format changed files using the project's existing formatter when applicable.
5. Validate before committing. Immediately before each validation command or non-regression check, output this progress envelope as a separate assistant message:
<<<RALPHEX:PROGRESS>>>
{"stage":"validation","text":"command or concise validation activity"}
<<<RALPHEX:END>>>
Then:
   - Run the commands explicitly listed in the plan when applicable to this task.
   - For a documentation-only task, validate the document against the referenced source; do not run compile, typecheck, test, or build commands unless the plan explicitly requires them for that individual task.
   - Otherwise, if the plan has no usable validation command, identify and run the project's cheapest existing non-destructive compile, analyze, typecheck, or build command.
   - Do not invent test infrastructure or run tests unless the plan explicitly asks for them.
   - Fix and rerun failures introduced by this task. Do not fix unrelated pre-existing failures.
   - If a validation command fails only because of pre-existing issues outside this task, establish that this task did not add or worsen them by comparing diagnostics with the base commit or otherwise inspecting the affected paths. Record the command and concise non-regression evidence under ## Execution Notes, then treat that command as a non-regression pass.
   - If an applicable validation cannot run because the environment, SDK, credentials, or dependencies are unavailable, or you cannot distinguish its failure from a regression introduced by this task, do not commit and report failure.
6. Only after applicable validation passes or pre-existing failures are proven unchanged, mark all completed checkboxes in Task ${options.task.number} as [x].
7. Commit all changes for this task, including the updated plan, with a concise message in the form feat: <task summary>. Do not amend an earlier commit and do not push.
8. Stop immediately after that commit. Do not continue to another Task.

## Questions and decisions

${options.auto ? `This is unattended mode. Do not ask the user questions. Resolve ordinary engineering ambiguity from the plan, project guidance, and existing conventions. Choose the simplest reversible option that does not expand scope, and append every material autonomous decision with its reason under ## Execution Notes in the plan. Stop without committing if a safe decision requires credentials, destructive action, a new incompatible public behavior without precedent, scope expansion, or resolving contradictory requirements.` : `This is interactive mode. If a material ambiguity cannot be resolved from the plan or repository, do not guess and do not modify or commit anything further. Output exactly:
<<<RALPHEX:QUESTION>>>
{"question":"one concrete question"}
<<<RALPHEX:END>>>
Then stop. For ordinary implementation details already determined by project conventions, proceed without asking.`}

If the task succeeds, end with <<<RALPHEX:TASK_DONE>>>.
If it cannot be completed after reasonable attempts, do not commit and end with <<<RALPHEX:TASK_FAILED>>>.
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
