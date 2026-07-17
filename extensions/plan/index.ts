import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
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
    const choice = await ctx.ui.select("Implement this plan?", ["Yes, implement this plan", "No, stay in Plan mode"]);
    if (choice !== "Yes, implement this plan") return;

    await implementApprovedPlan(pi, ctx as ExtensionCommandContext);
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
