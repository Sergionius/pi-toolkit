import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const PI_HOME = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
export const STATE_PATH = join(PI_HOME, "plan-state.json");

export type PlanModeState = {
  active: boolean;
  lastProposedPlan?: string;
  lastPrompt?: string;
  updatedAt: number;
};

export type Store = {
  planModes: Record<string, PlanModeState>;
};

export type SessionLike = { sessionManager: ExtensionCommandContext["sessionManager"]; cwd: string };

export function loadStore(): Store {
  try {
    if (!existsSync(STATE_PATH)) return { planModes: {} };
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<Store>;
    return { planModes: parsed.planModes ?? {} };
  } catch {
    return { planModes: {} };
  }
}

export function saveStore(store: Store) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(store, null, 2));
}

export function threadId(ctx: SessionLike) {
  return ctx.sessionManager.getSessionFile() ?? `cwd:${ctx.cwd}`;
}

export function currentPlanMode(ctx: SessionLike) {
  return loadStore().planModes[threadId(ctx)];
}

export function setPlanMode(ctx: SessionLike, active: boolean, lastPrompt?: string) {
  const store = loadStore();
  const id = threadId(ctx);
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
