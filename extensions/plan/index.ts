import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { Type } from "typebox";
import { createAutonomousPlan, parsePlanCommandArgs, type AutonomousPlanResult } from "../ralphex/index";
import {
  currentPlanMode,
  extractProposedPlan,
  loadStore,
  rememberProposedPlan,
  setGoal,
  setPlanMode,
  saveStore,
  threadId,
} from "../lib/codex-state";

const PLAN_MODE_INSTRUCTIONS = `# Plan Mode (Conversational)

You work in 3 phases, and you should chat your way to a great plan before finalizing it. A great plan is detailed enough to be handed to another engineer or agent for implementation. It must be decision complete, where the implementer does not need to make decisions.

## Mode rules (strict)

You are in Plan Mode until a developer/system instruction explicitly ends it. User intent, tone, or imperative language does not end Plan Mode. If a user asks for execution while still in Plan Mode, treat it as a request to plan the execution, not perform it.

## Plan Mode vs update_plan tool

Plan Mode is a collaboration mode that can involve requesting user input and eventually issuing a <proposed_plan> block. The update_plan checklist/TODO tool is not Plan Mode; do not use update_plan while in Plan Mode.

## Execution vs mutation in Plan Mode

You may explore and execute non-mutating actions that improve the plan. You must not perform mutating actions.

Allowed: reading/searching files, static inspection, dry-run commands, and tests/builds/checks that only write caches or build artifacts and do not edit repo-tracked files.

Not allowed: editing/writing files, formatters/linters that rewrite files, migrations/codegen/patches that update repo-tracked files, or side-effectful commands whose purpose is doing the work rather than planning it.

## Phase 1 — Ground in the environment

Begin by grounding yourself in the actual environment. Resolve discoverable facts through targeted non-mutating exploration before asking the user. Do not ask questions that can be answered from the repo or system.

## Phase 2 — Intent chat

Ask until you can clearly state: goal, success criteria, audience, in/out of scope, constraints, current state, and key preferences/tradeoffs. If high-impact ambiguity remains, ask instead of finalizing.

## Phase 3 — Implementation chat

Once intent is stable, ask until the spec is decision complete: approach, interfaces, data flow, edge cases/failure modes, testing/acceptance criteria, rollout/monitoring, migrations/compat constraints.

## Asking questions

Strongly prefer the request_user_input tool for questions. Offer only meaningful multiple-choice options. Ask only questions that materially change the spec/plan, confirm/lock an assumption, choose between meaningful tradeoffs, or cannot be answered by non-mutating exploration.

## Finalization rule

Only output the final plan when decision complete. Wrap the official plan in exactly one proposed_plan block:

<proposed_plan>
# Title

## Summary
...

## Key Changes
...

## Test Plan
...

## Assumptions
...
</proposed_plan>

The opening and closing tags must be on their own lines and must stay exactly <proposed_plan> and </proposed_plan>. Use Markdown inside. Keep the plan concise by default, with 3–5 short sections. Do not ask “should I proceed?” in the final output. The client/user can choose implementation after the proposed plan is produced.`;

const PLAN_PROMPT = (task: string) => `Plan this request in Plan Mode. Do not modify files or run mutating commands.\n\n${task}`;
const GOAL_PLAN_PROMPT = (goal: string) => `Plan this future goal in Plan Mode. Do not modify files or run mutating commands. When decision complete, output exactly one <proposed_plan> block and do not ask whether to proceed.\n\nPotential goal:\n${goal}`;
const GOAL_KICKOFF = (goal: string) => `Plan Mode is now finished. Ignore any earlier Plan Mode / non-mutating-only instructions from the planning turn and execute the approved goal.\n\nPursue the active thread goal:\n${goal}\n\nWork autonomously until the objective is achieved or genuinely blocked. Use get_goal when you need goal state. When achieved, call update_goal with status "complete". Mark "blocked" only after the same blocking condition has recurred for at least three consecutive goal turns.`;

export const RALPHEX_PLAN_INSTRUCTIONS = `# Ralphex implementation plan creation

Create an implementation plan for the request below. Work conversationally in the current Pi session. Your only deliverable is an accepted plan file; do not implement the requested feature.

## Workflow

1. Ground yourself in the actual project before asking questions. Read project instructions and inspect relevant code, structure, dependencies, and existing conventions directly with the available read-only tools. Keep exploration targeted, but read as much as needed to understand the change. Do not launch subagents or delegate the investigation.
2. Briefly summarize what you found: the current flow, likely affected files, constraints, and remaining ambiguity.
3. Ask only questions that materially affect behavior, scope, compatibility, interfaces, or architecture and cannot be answered from the repository. Ask exactly one question at a time. Do not ask about a testing preference.
4. If there is a meaningful implementation choice, present 2–3 approaches with concrete trade-offs, lead with a recommendation, and ask the user to choose. Skip this when there is one obvious path.
5. Once the request is decision-complete, show the full Markdown plan as a draft in chat. Do not create or modify any file yet. Explicitly invite the user to accept the draft or give revision feedback.
6. Revise and show a new complete draft after feedback. Continue until the user explicitly accepts the current draft.
7. Only after explicit acceptance, check for a matching existing plan under docs/plans/. If one exists, do not overwrite or duplicate it: report its path and stop. Otherwise write the accepted draft to docs/plans/YYYYMMDD-<slug>.md, using the current local date and a short lowercase ASCII kebab-case slug.
8. After writing, report only the created plan path and stop. Do not implement it, review it, commit it, create or switch branches, create a worktree, or invoke another workflow.

## Mutation boundary

Before explicit acceptance, use only non-mutating exploration. Do not call edit or write, and do not run commands that modify project files or Git state. After acceptance, the only allowed project mutation is creating the single plan file (and its docs/plans directory when absent).

## Plan format

Use the language of the user's request, except that every executable task heading must retain the exact structural form ### Task N: <title> with sequential integers.

The plan should contain:

# <Title>

## Goal
A concrete description of the intended outcome.

## Context
Relevant current behavior, files, patterns, dependencies, and constraints discovered in the repository.

## Scope
What the implementation includes.

## Out of Scope
Include only when useful to prevent ambiguity.

## Implementation Steps

### Task 1: <specific completed unit>

**Files:**
- Modify: path/to/file
- Create: path/to/file (only when genuinely needed)

- [ ] concrete, automatable implementation action
- [ ] another action belonging to the same logical unit

Continue with ordered Task sections. Put executable checkboxes only inside Task sections. Tasks should be specific, reasonably sized, dependency-ordered, and sufficient for another coding agent to implement without making product or architecture decisions. Every Task must leave the project in a state that passes the plan's applicable Validation; combine interdependent changes into one Task when an intermediate split would knowingly break compilation or analysis.

## Validation
Include the project's existing cheapest relevant non-destructive compile, analyze, typecheck, lint, or build commands when they can be discovered. Do not invent a test framework, mandatory tests, coverage targets, or testing tasks for a project that does not already use them. Tests belong here only when the project already relies on them for this area or the user explicitly requested them.

## Acceptance Criteria
A short, observable list of conditions proving the requested behavior is complete. Do not use checkboxes here.

## Planning constraints

- Prefer the simplest implementation that fits existing project conventions; avoid speculative abstractions and future-proofing.
- Use exact file paths when they can be discovered. Clearly identify any path that can only be resolved during implementation.
- Do not add plan review, code review, deployment, release, commit, branch, worktree, rebase, squash, push, or merge steps.
- Do not propose implementing anything after the plan is created.
- Do not wrap the draft in <proposed_plan> tags; present it as ordinary Markdown so this workflow remains separate from Codex Plan Mode.`;

export function buildRalphexPlanPrompt(request: string) {
  return `${RALPHEX_PLAN_INSTRUCTIONS}\n\n## User request\n\n${request.trim()}`;
}

export const PLAN_COMPLETION_CHOICES = [
  "Yes, implement this plan",
  "No, save plan in file",
  "No, rewrite plan in ralphex mode",
  "No, stay in Plan mode",
] as const;

const CYRILLIC_TO_ASCII: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

export function planSlug(plan: string): string {
  const title = plan.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "plan";
  const transliterated = [...title.toLowerCase()].map((character) => CYRILLIC_TO_ASCII[character] ?? character).join("");
  return transliterated
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "") || "plan";
}

function localDateStamp(date: Date): string {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, "0"))
    .join("");
}

export async function saveProposedPlan(cwd: string, plan: string, date = new Date()): Promise<string> {
  const directory = join(cwd, "docs", "plans");
  const stem = `${localDateStamp(date)}-${planSlug(plan)}`;
  await mkdir(directory, { recursive: true });

  for (let suffix = 1; ; suffix += 1) {
    const filename = `${stem}${suffix === 1 ? "" : `-${suffix}`}.md`;
    const path = join(directory, filename);
    try {
      await writeFile(path, `${plan.trim()}\n`, { encoding: "utf8", flag: "wx" });
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

export function buildRalphexRewritePrompt(plan: string): string {
  return buildRalphexPlanPrompt(`Rewrite the following Codex Plan Mode draft into an accepted Ralphex implementation plan. Treat the draft as source material, verify it against the repository, resolve any remaining ambiguity conversationally, and do not implement it.\n\n## Existing draft\n\n${plan.trim()}`);
}

async function sendPrompt(pi: ExtensionAPI, ctx: ExtensionCommandContext | any, prompt: string) {
  if (typeof ctx.waitForIdle === "function") await ctx.waitForIdle();
  if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
    pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    return;
  }
  pi.sendUserMessage(prompt);
}

async function implementApprovedPlan(pi: ExtensionAPI, ctx: ExtensionCommandContext | any) {
  const store = loadStore();
  const id = threadId(ctx);
  const pendingGoal = store.pendingGoalPlan?.[id];
  const planMode = store.planModes?.[id];

  setPlanMode(ctx, false);

  if (pendingGoal) {
    try {
      const goal = setGoal(ctx, pendingGoal.objective);
      ctx.ui.notify("Leaving Plan mode; starting goal", "info");
      await sendPrompt(pi, ctx, GOAL_KICKOFF(goal.objective));
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
    return;
  }

  ctx.ui.notify("Leaving Plan mode; implementing approved plan", "info");
  const prompt = planMode?.lastProposedPlan
    ? `Plan Mode is now finished. Ignore any earlier Plan Mode / non-mutating-only instructions from the planning turn and implement this approved plan:\n\n${planMode.lastProposedPlan}`
    : "Plan Mode is now finished. Ignore any earlier Plan Mode / non-mutating-only instructions from the planning turn and implement the plan.";
  await sendPrompt(pi, ctx, prompt);
}

function assistantTextFromAgentEnd(event: any) {
  return event.messages
    ?.filter((message: any) => message.role === "assistant")
    .map((message: any) =>
      Array.isArray(message.content)
        ? message.content.map((part: any) => (part?.type === "text" ? part.text : "")).join("\n")
        : String(message.content ?? ""),
    )
    .join("\n");
}

function autonomousPlanPayload(result: AutonomousPlanResult) {
  return {
    status: "planned" as const,
    plan: relative(result.root, result.planPath),
    model: result.model,
    decisions: result.decisions,
    assumptions: result.assumptions,
    limitations: result.limitations,
  };
}

function formatAutonomousPlanResult(result: AutonomousPlanResult): string {
  const lines = [
    "✓ Ralphex autonomous plan created",
    "",
    `Plan: ${relative(result.root, result.planPath)}`,
    `Model: ${result.model}`,
    "",
    "Решения:",
  ];
  if (!result.decisions.length) lines.push("- Материальных автономных решений не зафиксировано");
  for (const item of result.decisions) {
    lines.push(`- Выбрано: ${item.decision}`);
    lines.push(`  Альтернативы: ${item.alternatives.length ? item.alternatives.join(", ") : "не было"}`);
    lines.push(`  Причина: ${item.reason}`);
    lines.push(`  Побочные эффекты: ${item.sideEffects.length ? item.sideEffects.join(", ") : "нет"}`);
  }
  lines.push("", "Допущения:", ...(result.assumptions.length ? result.assumptions.map((item) => `- ${item}`) : ["- Нет"]));
  lines.push("", "Ограничения:", ...(result.limitations.length ? result.limitations.map((item) => `- ${item}`) : ["- Нет"]));
  return lines.join("\n");
}

function emitAutonomousPlanOutput(pi: ExtensionAPI, ctx: ExtensionCommandContext, content: string): void {
  if (ctx.mode === "print") {
    process.stdout.write(`${content}\n`);
    return;
  }
  pi.sendMessage({ customType: "ralphex", content, display: true });
}

export async function startAutonomousRalphexPlan(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
  createPlan: typeof createAutonomousPlan = createAutonomousPlan,
): Promise<void> {
  let parsed;
  let completed = false;
  pi.events.emit("ralphex:started", { name: "Ralphex plan" });
  try {
    parsed = parsePlanCommandArgs(args);
    const result = await createPlan(ctx, parsed.request, parsed.model);
    const content = parsed.json
      ? JSON.stringify(autonomousPlanPayload(result))
      : formatAutonomousPlanResult(result);
    emitAutonomousPlanOutput(pi, ctx, content);
    completed = true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const json = parsed?.json ?? commandTokensForJsonFallback(args);
    const content = json
      ? JSON.stringify({ status: "blocked", phase: "planning", reason })
      : `✗ Ralphex autonomous plan blocked\n\nPhase: planning\nReason: ${reason}`;
    emitAutonomousPlanOutput(pi, ctx, content);
  } finally {
    ctx.ui.setWidget("ralphex", undefined);
    pi.events.emit(completed ? "ralphex:completed" : "ralphex:failed", { name: "Ralphex plan" });
  }
}

function commandTokensForJsonFallback(args: string): boolean {
  return /(?:^|\s)--json(?:\s|$)/.test(args);
}

export async function startRalphexPlan(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
  disablePlanMode: typeof setPlanMode = setPlanMode,
) {
  let request = args.trim();
  if (!request) {
    request = (await ctx.ui.input("Ralphex plan", "What should the implementation plan cover?"))?.trim() ?? "";
    if (!request) {
      ctx.ui.notify("Ralphex plan creation cancelled", "warning");
      return;
    }
  }

  disablePlanMode(ctx, false);
  ctx.ui.notify("Starting /ralphex-plan", "info");
  await sendPrompt(pi, ctx, buildRalphexPlanPrompt(request));
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    if (!currentPlanMode(ctx)?.active) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${PLAN_MODE_INSTRUCTIONS}` };
  });

  pi.on("agent_end", async (event, ctx) => {
    const proposedPlan = extractProposedPlan(assistantTextFromAgentEnd(event) ?? "");
    const planMode = currentPlanMode(ctx);
    if (!planMode?.active || !proposedPlan || !ctx.hasUI) return;

    rememberProposedPlan(ctx, proposedPlan);
    const choice = await ctx.ui.select("Implement this plan?", [...PLAN_COMPLETION_CHOICES]);
    if (choice === "Yes, implement this plan") {
      await implementApprovedPlan(pi, ctx as ExtensionCommandContext);
      return;
    }
    if (choice === "No, save plan in file") {
      setPlanMode(ctx, false);
      try {
        const path = await saveProposedPlan(ctx.cwd, proposedPlan);
        ctx.ui.notify(`Plan saved to ${relative(ctx.cwd, path)}`, "info");
      } catch (error) {
        setPlanMode(ctx, true);
        ctx.ui.notify(`Failed to save plan: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
      return;
    }
    if (choice === "No, rewrite plan in ralphex mode") {
      setPlanMode(ctx, false);
      ctx.ui.notify("Leaving Plan mode; rewriting draft in Ralphex mode", "info");
      await sendPrompt(pi, ctx as ExtensionCommandContext, buildRalphexRewritePrompt(proposedPlan));
    }
  });

  pi.on("input", async (event, ctx) => {
    const text = event.text.trim().toLowerCase();
    const yes = /^(y|yes|ok|okay|да|ага|подтверждаю|приступай|go|делай|выполняй)[.!\s]*$/i.test(text);
    const implement = /^(implement|implement the plan|приступай|выполняй|делай|давай делай|go|ok|да)[.!\s]*$/i.test(text);

    const store = loadStore();
    const id = threadId(ctx);

    if (store.awaitingGoalPlan?.[id]) {
      const objective = event.text.trim();
      if (!objective) {
        ctx.ui.notify("Send the goal text after /goal-plan", "warning");
        return { action: "handled" };
      }
      const now = Math.floor(Date.now() / 1000);
      delete store.awaitingGoalPlan[id];
      store.pendingGoalPlan ??= {};
      store.planModes ??= {};
      store.pendingGoalPlan[id] = { objective, createdAt: now };
      store.planModes[id] = { active: true, lastPrompt: objective, updatedAt: now };
      saveStore(store);
      ctx.ui.notify("Starting /goal-plan in Plan mode", "info");
      return { action: "transform", text: GOAL_PLAN_PROMPT(objective) };
    }

    const pending = store.pendingGoalPlan?.[id];
    if (yes && pending) {
      try {
        const goal = setGoal(ctx, pending.objective);
        setPlanMode(ctx, false);
        ctx.ui.notify("Goal started after plan confirmation", "info");
        return { action: "transform", text: GOAL_KICKOFF(goal.objective) };
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return { action: "handled" };
      }
    }

    const planMode = store.planModes?.[id];
    if (planMode?.active && implement && planMode.lastProposedPlan) {
      setPlanMode(ctx, false);
      ctx.ui.notify("Leaving Plan mode; implementing last proposed plan", "info");
      return {
        action: "transform",
        text: `Plan Mode is now finished. Ignore any earlier Plan Mode / non-mutating-only instructions from the planning turn and implement this approved plan:\n\n${planMode.lastProposedPlan}`,
      };
    }

    return { action: "continue" };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!currentPlanMode(ctx)?.active) return;
    if (["write", "edit"].includes(event.toolName)) {
      return { block: true, reason: "Plan Mode forbids mutating file tools; produce a <proposed_plan> instead." };
    }
    if (event.toolName === "bash") {
      const command = String((event.input as any).command ?? "").toLowerCase();
      const mutating = /\b(git\s+(commit|push|merge|rebase|reset|checkout|switch|restore|add)|rm\s|mv\s|cp\s|chmod\s|chown\s|mkdir\s|touch\s|npm\s+run\s+format|prettier\s+--write|eslint\b.*--fix|cargo\s+fmt|go\s+fmt|terraform\s+apply|kubectl\s+apply)\b/.test(command);
      if (mutating) return { block: true, reason: "Plan Mode allows only non-mutating exploration; this bash command looks mutating." };
    }
  });

  pi.registerTool({
    name: "request_user_input",
    label: "Request User Input",
    description:
      "Request user input for one to three short questions and wait for the response. Use in Plan Mode for decisions that materially change the plan or cannot be discovered by non-mutating exploration.",
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          question: Type.String(),
          options: Type.Optional(Type.Array(Type.String())),
          recommended: Type.Optional(Type.String()),
        }),
        { minItems: 1, maxItems: 3 },
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!currentPlanMode(ctx)?.active) {
        return { content: [{ type: "text", text: "request_user_input is intended for Plan Mode." }], isError: true };
      }
      const answers: Array<{ question: string; answer: string }> = [];
      for (const q of params.questions) {
        const title = q.recommended ? `${q.question}\nRecommended: ${q.recommended}` : q.question;
        const answer = q.options?.length ? await ctx.ui.select(title, q.options) : await ctx.ui.input("Plan Mode question", title);
        answers.push({ question: q.question, answer: answer || q.recommended || "(no answer)" });
      }
      return { content: [{ type: "text", text: JSON.stringify({ answers }, null, 2) }], details: { answers } };
    },
  });

  pi.registerCommand("plan", {
    description: "Enter Codex-style Plan mode, optionally with a task",
    handler: async (args, ctx) => {
      const task = args.trim();
      setPlanMode(ctx, true, task || undefined);
      ctx.ui.notify(task ? "Starting /plan" : "Plan mode enabled", "info");
      if (task) await sendPrompt(pi, ctx, PLAN_PROMPT(task));
    },
  });

  pi.registerCommand("ralphex-plan", {
    description: "Create an implementation plan; add --auto [--model provider/model] [--json] for unattended plan-only mode",
    handler: async (args, ctx) => {
      if (/(?:^|\s)--auto(?:\s|$)/.test(args)) {
        await startAutonomousRalphexPlan(pi, ctx, args);
        return;
      }
      await startRalphexPlan(pi, ctx, args);
    },
  });

  pi.registerCommand("plan-exit", {
    description: "Leave Codex-style Plan mode",
    handler: async (_args, ctx) => {
      setPlanMode(ctx, false);
      ctx.ui.notify("Plan mode disabled", "info");
    },
  });

  pi.registerCommand("implement-plan", {
    description: "Leave Plan mode and implement the last proposed plan",
    handler: async (_args, ctx) => {
      await implementApprovedPlan(pi, ctx);
    },
  });

  pi.registerCommand("goal-plan", {
    description: "Plan a goal first, then start it after user confirmation",
    handler: async (args, ctx) => {
      const objective = args.trim();
      const store = loadStore();
      const id = threadId(ctx);
      const now = Math.floor(Date.now() / 1000);
      if (!objective) {
        store.awaitingGoalPlan ??= {};
        store.awaitingGoalPlan[id] = { createdAt: now };
        saveStore(store);
        ctx.ui.notify("/goal-plan enabled. Send the goal text next.", "info");
        return;
      }
      store.pendingGoalPlan ??= {};
      store.planModes ??= {};
      store.pendingGoalPlan[id] = { objective, createdAt: now };
      store.planModes[id] = { active: true, lastPrompt: objective, updatedAt: now };
      saveStore(store);
      ctx.ui.notify("Starting /goal-plan in Plan mode", "info");
      await sendPrompt(pi, ctx, GOAL_PLAN_PROMPT(objective));
    },
  });
}
