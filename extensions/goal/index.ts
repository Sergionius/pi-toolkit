import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  clearGoal,
  currentGoal,
  goalResponse,
  loadStore,
  renderGoal,
  setGoal,
  setPlanMode,
  saveStore,
  threadId,
  updateGoalStatus,
  type GoalStatus,
} from "../lib/codex-state";

const MAX_AUTO_GOAL_TURNS = 25;
const AUTO_CONTINUE_PROMPT = "Continue pursuing the active goal. If it is complete, call update_goal with status complete; if truly blocked by the repeated-blocking rule, call update_goal with status blocked.";

async function sendPrompt(pi: ExtensionAPI, ctx: ExtensionCommandContext, prompt: string) {
  await ctx.waitForIdle();
  pi.sendUserMessage(prompt);
}

const GOAL_KICKOFF = (goal: string) => `Plan Mode is now finished. Ignore any earlier Plan Mode / non-mutating-only instructions from the planning turn and execute the approved goal.

Pursue the active thread goal:
${goal}

Work autonomously until the objective is achieved or genuinely blocked. Use get_goal when you need goal state. When achieved, call update_goal with status "complete". Mark "blocked" only after the same blocking condition has recurred for at least three consecutive goal turns.`;

export default function (pi: ExtensionAPI) {
  pi.on("input", async (event, ctx) => {
    if (event.source !== "extension" || event.text !== AUTO_CONTINUE_PROMPT) return;
    const goal = currentGoal(ctx);
    if (!goal || goal.status !== "active") {
      ctx.ui.notify("Skipping stale goal auto-continue: no active goal", "info");
      return { action: "handled" as const };
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    const store = loadStore();
    const id = threadId(ctx);
    const goal = store.goals[id];
    if (goal?.status === "active" && goal.autoTurns < MAX_AUTO_GOAL_TURNS) {
      if (store.planModes?.[id]?.active) {
        store.planModes[id] = { ...store.planModes[id], active: false, updatedAt: Math.floor(Date.now() / 1000) };
      }
      goal.autoTurns += 1;
      goal.updatedAt = Math.floor(Date.now() / 1000);
      store.goals[id] = goal;
      saveStore(store);
      const latestGoal = currentGoal(ctx);
      if (latestGoal?.status === "active") {
        pi.sendUserMessage(AUTO_CONTINUE_PROMPT, { deliverAs: "followUp" });
      }
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const goal = currentGoal(ctx);
    if (!goal || goal.status !== "active") return;
    setPlanMode(ctx, false);
    return {
      systemPrompt:
        event.systemPrompt +
        `\n\nActive thread goal execution mode (Codex-style): ${goal.objective}\n- Plan Mode is over for this thread. Earlier planning-only / non-mutating-only instructions do not apply to this execution turn.\n- Continue working toward this goal across turns until complete or blocked.\n- Do not infer/create unrelated goals from ordinary tasks.\n- Use update_goal(status=\"complete\") only when the objective is achieved and no required work remains.\n- Use update_goal(status=\"blocked\") only after the same blocking condition recurs for at least three consecutive goal turns and progress requires user input or external state.`,
    };
  });

  pi.registerTool({
    name: "get_goal",
    label: "Get Goal",
    description: "Get the current goal for this thread, including status, budgets, token and elapsed-time usage, and remaining token budget.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const response = goalResponse(currentGoal(ctx));
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], details: response };
    },
  });

  pi.registerTool({
    name: "create_goal",
    label: "Create Goal",
    description:
      "Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks. Set token_budget only when an explicit token budget is requested. Fails if an unfinished goal exists; use update_goal only for status.",
    parameters: Type.Object({ objective: Type.String(), token_budget: Type.Optional(Type.Number()) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const goal = setGoal(ctx, params.objective, params.token_budget);
        const response = goalResponse(goal);
        return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], details: response };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  });

  pi.registerTool({
    name: "update_goal",
    label: "Update Goal",
    description:
      "Update the existing goal. Use only to mark the goal achieved or genuinely blocked. Set status to complete only when the objective has actually been achieved and no required work remains. Set status to blocked only when the same blocking condition has repeated for at least three consecutive goal turns and the agent cannot make meaningful progress without user input or an external-state change.",
    parameters: Type.Object({ status: Type.Union([Type.Literal("complete"), Type.Literal("blocked")]) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const goal = updateGoalStatus(ctx, params.status);
        const response = goalResponse(goal, params.status === "complete");
        return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], details: response };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  });

  pi.registerCommand("goal", {
    description: "Set/view/control a Codex-style long-running goal",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        const goal = currentGoal(ctx);
        ctx.ui.notify(goal ? renderGoal(goal) : "No goal is currently set. Usage: /goal <objective>", goal ? "info" : "warning");
        return;
      }

      try {
        const lower = trimmed.toLowerCase();
        if (lower === "clear") {
          ctx.ui.notify(clearGoal(ctx) ? "Goal cleared" : "No goal to clear", "info");
          return;
        }
        if (["pause", "resume", "complete", "blocked"].includes(lower)) {
          const status = lower === "pause" ? "paused" : lower === "resume" ? "active" : (lower as GoalStatus);
          const goal = updateGoalStatus(ctx, status);
          ctx.ui.notify(renderGoal(goal), "info");
          if (status === "active") await sendPrompt(pi, ctx, GOAL_KICKOFF(goal.objective));
          return;
        }

        let replace = false;
        const existing = currentGoal(ctx);
        if (existing && !["complete", "blocked"].includes(existing.status)) {
          replace = await ctx.ui.confirm("Replace current goal?", renderGoal(existing));
          if (!replace) return;
        }
        const goal = setGoal(ctx, trimmed, undefined, replace);
        setPlanMode(ctx, false);
        ctx.ui.notify(replace ? "Goal replaced" : "Goal set", "info");
        await sendPrompt(pi, ctx, GOAL_KICKOFF(goal.objective));
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
