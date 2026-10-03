import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const PI_HOME = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
export const STATE_PATH = join(PI_HOME, "plan-state.json");
export type PlanModeState = { active: boolean; lastProposedPlan?: string; lastPrompt?: string; updatedAt: number };
export type Store = { planModes: Record<string, PlanModeState> };
export type SessionLike = { sessionManager: ExtensionCommandContext["sessionManager"]; cwd: string };
let cached: { fingerprint: string; store: Store } | undefined;

export async function loadStore(): Promise<Store> {
  try {
    const info = await stat(STATE_PATH);
    const fingerprint = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    if (cached?.fingerprint === fingerprint) return structuredClone(cached.store);
    const parsed = JSON.parse(await readFile(STATE_PATH, "utf8"));
    if (!parsed?.planModes || typeof parsed.planModes !== "object" || Array.isArray(parsed.planModes)) throw new Error("missing planModes");
    for (const value of Object.values(parsed.planModes) as any[]) {
      if (!value || typeof value.active !== "boolean" || !Number.isFinite(value.updatedAt)
        || (value.lastProposedPlan !== undefined && typeof value.lastProposedPlan !== "string")
        || (value.lastPrompt !== undefined && typeof value.lastPrompt !== "string")) throw new Error("invalid plan mode entry");
    }
    cached = { fingerprint, store: parsed };
    return structuredClone(parsed);
  } catch (error) {
    cached = undefined;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { planModes: {} };
    throw new Error(`Cannot read Plan Mode state (${STATE_PATH}); refusing to assume execution mode: ${String(error)}`);
  }
}

async function updateStore<T>(update: (store: Store) => T): Promise<T> {
  await mkdir(dirname(STATE_PATH), { recursive: true, mode: 0o700 });
  // Same-machine advisory lock: an O_EXCL file records the owner PID. A stale
  // lock is reclaimed only when its recorded owner no longer exists, so a slow
  // live writer is never interrupted; everything else fails without changes.
  const lock = `${STATE_PATH}.lock`;
  let handle;
  const deadline = Date.now() + 3000;
  while (!handle) {
    try {
      handle = await open(lock, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const info = await stat(lock);
        const owner = Number((await readFile(lock, "utf8")).trim());
        if (Date.now() - info.mtimeMs > 30000 && Number.isInteger(owner) && owner > 0) {
          try { process.kill(owner, 0); } catch (killError) {
            if ((killError as NodeJS.ErrnoException).code === "ESRCH") await rm(lock, { force: true });
          }
        }
      } catch { /* Writer may be initializing or releasing the lock. */ }
      if (Date.now() > deadline) throw new Error("Plan Mode storage is busy; no state changed");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  const temporary = `${STATE_PATH}.${randomUUID()}.tmp`;
  try {
    await handle.writeFile(String(process.pid));
    cached = undefined;
    const store = await loadStore();
    const result = update(store);
    const cutoff = Date.now() / 1000 - 30 * 86400;
    for (const [key, value] of Object.entries(store.planModes)) if (!value.active && value.updatedAt < cutoff) delete store.planModes[key];
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(store, null, 2)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, STATE_PATH);
    cached = undefined;
    return result;
  } finally {
    try { await rm(temporary, { force: true }); } finally { await handle.close(); await rm(lock, { force: true }); }
  }
}

export function threadId(ctx: SessionLike) {
  return ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId?.() ?? `cwd:${ctx.cwd}`;
}
export async function currentPlanMode(ctx: SessionLike) { return (await loadStore()).planModes[threadId(ctx)]; }
export async function setPlanMode(ctx: SessionLike, active: boolean, lastPrompt?: string) {
  return updateStore((store) => {
    const id = threadId(ctx);
    store.planModes[id] = {
      active, lastProposedPlan: store.planModes[id]?.lastProposedPlan,
      lastPrompt: lastPrompt ?? store.planModes[id]?.lastPrompt, updatedAt: Math.floor(Date.now() / 1000),
    };
    return store.planModes[id];
  });
}
export async function rememberProposedPlan(ctx: SessionLike, plan: string) {
  return updateStore((store) => {
    const id = threadId(ctx);
    store.planModes[id] = {
      active: store.planModes[id]?.active ?? true, lastPrompt: store.planModes[id]?.lastPrompt,
      lastProposedPlan: plan.trim(), updatedAt: Math.floor(Date.now() / 1000),
    };
  });
}
export function extractProposedPlan(text: string) {
  return text.match(/<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i)?.[1]?.trim();
}
