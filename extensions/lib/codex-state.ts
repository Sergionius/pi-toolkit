import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const PI_HOME = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
export const STATE_PATH = join(PI_HOME, "goals.json");

export type GoalStatus = "active" | "paused" | "blocked" | "complete" | "budget_limited" | "usage_limited";

export type Goal = {
  threadId: string;
  objective: string;
  status: GoalStatus;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
  autoTurns: number;
};

export type PlanModeState = {
  active: boolean;
  lastProposedPlan?: string;
  lastPrompt?: string;
  updatedAt: number;
};

export type Store = {
  goals: Record<string, Goal>;
  pendingGoalPlan?: Record<string, { objective: string; createdAt: number }>;
  awaitingGoalPlan?: Record<string, { createdAt: number }>;
  planModes?: Record<string, PlanModeState>;
};

export type SessionLike = { sessionManager: ExtensionCommandContext["sessionManager"]; cwd: string };

export function loadStore(): Store {
  try {
    if (!existsSync(STATE_PATH)) return { goals: {}, pendingGoalPlan: {}, awaitingGoalPlan: {}, planModes: {} };
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Store;
    return {
      goals: parsed.goals ?? {},
      pendingGoalPlan: parsed.pendingGoalPlan ?? {},
      awaitingGoalPlan: parsed.awaitingGoalPlan ?? {},
      planModes: parsed.planModes ?? {},
    };
  } catch {
    return { goals: {}, pendingGoalPlan: {}, awaitingGoalPlan: {}, planModes: {} };
  }
}

export function saveStore(store: Store) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(store, null, 2));
}

export function threadId(ctx: SessionLike) {
  return ctx.sessionManager.getSessionFile() ?? `cwd:${ctx.cwd}`;
}

export function currentGoal(ctx: SessionLike) {
  return loadStore().goals[threadId(ctx)];
}

export function goalResponse(goal: Goal | undefined, includeCompletionReport = false) {
  const remainingTokens = goal?.tokenBudget == null ? undefined : Math.max(0, goal.tokenBudget - goal.tokensUsed);
  return {
    goal: goal
      ? {
          threadId: goal.threadId,
          objective: goal.objective,
          status: goal.status,
          tokenBudget: goal.tokenBudget,
          tokensUsed: goal.tokensUsed,
          timeUsedSeconds: goal.timeUsedSeconds,
          createdAt: goal.createdAt,
          updatedAt: goal.updatedAt,
        }
      : null,
    remainingTokens,
    completionBudgetReport:
      includeCompletionReport && goal?.status === "complete" && (goal.tokenBudget || goal.timeUsedSeconds > 0)
        ? "Goal achieved. Report final usage from this tool result's structured goal fields. If goal.tokenBudget is present, include token usage from goal.tokensUsed and goal.tokenBudget. If goal.timeUsedSeconds is greater than 0, summarize elapsed time concisely."
        : undefined,
  };
}

export function setGoal(ctx: SessionLike, objective: string, tokenBudget?: number, replace = false) {
  const trimmed = objective.trim();
  if (!trimmed) throw new Error("goal objective must not be empty");
  if (trimmed.length > 20_000) throw new Error("goal objective is too long");
  if (tokenBudget != null && tokenBudget <= 0) throw new Error("goal budgets must be positive when provided");

  const store = loadStore();
  const id = threadId(ctx);
  const existing = store.goals[id];
  if (existing && !["complete", "blocked"].includes(existing.status) && !replace) {
    throw new Error("cannot create a new goal because this thread has an unfinished goal; complete, block, clear, or replace it first");
  }
  const now = Math.floor(Date.now() / 1000);
  const goal: Goal = {
    threadId: id,
    objective: trimmed,
    status: "active",
    tokenBudget,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: now,
    updatedAt: now,
    autoTurns: 0,
  };
  store.goals[id] = goal;
  delete store.pendingGoalPlan?.[id];
  delete store.awaitingGoalPlan?.[id];
  saveStore(store);
  return goal;
}

export function updateGoalStatus(ctx: SessionLike, status: GoalStatus) {
  const store = loadStore();
  const id = threadId(ctx);
  const goal = store.goals[id];
  if (!goal) throw new Error("cannot update goal because this thread has no goal");
  goal.status = status;
  goal.updatedAt = Math.floor(Date.now() / 1000);
  if (status === "active") goal.autoTurns = 0;
  store.goals[id] = goal;
  saveStore(store);
  return goal;
}

export function clearGoal(ctx: SessionLike) {
  const store = loadStore();
  const id = threadId(ctx);
  const existed = Boolean(store.goals[id]);
  delete store.goals[id];
  delete store.pendingGoalPlan?.[id];
  delete store.awaitingGoalPlan?.[id];
  saveStore(store);
  return existed;
}

export function currentPlanMode(ctx: SessionLike) {
  return loadStore().planModes?.[threadId(ctx)];
}

export function setPlanMode(ctx: SessionLike, active: boolean, lastPrompt?: string) {
  const store = loadStore();
  const id = threadId(ctx);
  store.planModes ??= {};
  store.planModes[id] = {
    active,
    lastProposedPlan: store.planModes[id]?.lastProposedPlan,
    lastPrompt: lastPrompt ?? store.planModes[id]?.lastPrompt,
    updatedAt: Math.floor(Date.now() / 1000),
  };
  saveStore(store);
  return store.planModes[id];
}

export function rememberProposedPlan(ctx: SessionLike, plan: string) {
  const store = loadStore();
  const id = threadId(ctx);
  store.planModes ??= {};
  store.planModes[id] = {
    active: store.planModes[id]?.active ?? true,
    lastPrompt: store.planModes[id]?.lastPrompt,
    lastProposedPlan: plan.trim(),
    updatedAt: Math.floor(Date.now() / 1000),
  };
  saveStore(store);
}

export function extractProposedPlan(text: string) {
  const match = text.match(/<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i);
  return match?.[1]?.trim();
}

export function renderGoal(goal: Goal) {
  const budget = goal.tokenBudget ? `, budget ${goal.tokenBudget}, used ${goal.tokensUsed}` : "";
  return `Goal ${goal.status}${budget}: ${goal.objective}`;
}
