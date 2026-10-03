import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const UNIT_MS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000 };
const MAX_DELAY_MS = 24 * UNIT_MS.h;
const DELAY_PATTERN = /^(?:\d+[hms])+$/;
const PAYLOAD_PREVIEW_LIMIT = 80;

const USAGE =
  "Usage: /later <delay> <command or message> (e.g. /later 30m /ralphex-exec plan.md) | /later list | /later cancel <id|all>";

type MinimalUi = {
  notify: (message: string, type?: "info" | "warning" | "error") => void;
  setStatus: (key: string, text: string | undefined) => void;
};

export type LaterTask = { id: number; payload: string; fireAt: number };

export type LaterPlan =
  | { action: "schedule"; delayMs: number; payload: string }
  | { action: "list" }
  | { action: "cancel"; target: string }
  | { action: "usage"; reason?: string };

export function parseDelayMs(raw: string): number | null {
  const token = raw.trim().toLowerCase();
  if (!DELAY_PATTERN.test(token)) return null;
  let ms = 0;
  for (const match of token.matchAll(/(\d+)([hms])/g)) {
    ms += Number(match[1]) * UNIT_MS[match[2]];
  }
  if (ms <= 0 || ms > MAX_DELAY_MS) return null;
  return ms;
}

export function parseLaterArgs(raw: string): LaterPlan {
  const args = raw.trim();
  if (!args) return { action: "usage" };
  if (args === "list") return { action: "list" };

  const cancelMatch = /^cancel(?:\s+(\S+))?$/.exec(args);
  if (cancelMatch) {
    if (!cancelMatch[1]) return { action: "usage", reason: "Specify a task id or \"all\": /later cancel <id|all>" };
    return { action: "cancel", target: cancelMatch[1] };
  }

  const match = /^(\S+)(?:\s+([\s\S]+))?$/.exec(args);
  if (!match) return { action: "usage" };
  const delayMs = parseDelayMs(match[1]);
  if (delayMs === null) {
    return { action: "usage", reason: `Invalid delay "${match[1]}". Use a combination of h, m, s like 90s, 45m, or 1h30m (max 24h).` };
  }
  const payload = (match[2] ?? "").trim();
  if (!payload) return { action: "usage", reason: "Add the command or message to run after the delay." };
  return { action: "schedule", delayMs, payload };
}

export function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

export function formatLaterList(tasks: LaterTask[], now: number = Date.now()): string {
  if (tasks.length === 0) return "No pending /later tasks.";
  const lines = tasks.map((task) => {
    const at = new Date(task.fireAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return `  #${task.id} in ${formatRemaining(task.fireAt - now)} (at ${at}) ${task.payload}`;
  });
  return `Pending /later tasks:\n${lines.join("\n")}`;
}

function previewPayload(payload: string): string {
  const firstLine = payload.split("\n", 1)[0].trim();
  return firstLine.length > PAYLOAD_PREVIEW_LIMIT ? `${firstLine.slice(0, PAYLOAD_PREVIEW_LIMIT - 1)}…` : firstLine;
}

export class LaterScheduler {
  private tasks = new Map<number, { task: LaterTask; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 1;

  constructor(
    private readonly onFire: (task: LaterTask) => void,
    private readonly canFire: () => boolean = () => true,
  ) {}

  schedule(delayMs: number, payload: string, now: number = Date.now()): LaterTask {
    const id = this.nextId++;
    const task: LaterTask = { id, payload, fireAt: now + delayMs };
    const fire = () => {
      const entry = this.tasks.get(id);
      if (!entry) return;
      if (!this.canFire()) {
        entry.timer = setTimeout(fire, 250);
        return;
      }
      this.tasks.delete(id);
      this.onFire(task);
    };
    const timer = setTimeout(fire, delayMs);
    this.tasks.set(id, { task, timer });
    return task;
  }

  cancel(id: number): LaterTask | null {
    const entry = this.tasks.get(id);
    if (!entry) return null;
    clearTimeout(entry.timer);
    this.tasks.delete(id);
    return entry.task;
  }

  cancelAll(): LaterTask[] {
    const cancelled = this.list();
    for (const { timer } of this.tasks.values()) clearTimeout(timer);
    this.tasks.clear();
    return cancelled;
  }

  list(): LaterTask[] {
    return [...this.tasks.values()].map(({ task }) => task).sort((a, b) => a.fireAt - b.fireAt || a.id - b.id);
  }

  get size(): number {
    return this.tasks.size;
  }

  nextFireAt(): number | null {
    return this.list()[0]?.fireAt ?? null;
  }

  clear(): void {
    for (const { timer } of this.tasks.values()) clearTimeout(timer);
    this.tasks.clear();
  }
}

export function sendLaterPayload(pi: ExtensionAPI, payload: string): void {
  const options: { deliverAs: "followUp"; expandPromptTemplates?: boolean } = { deliverAs: "followUp" };
  if (payload.startsWith("/")) options.expandPromptTemplates = true;
  pi.sendUserMessage(payload, options);
}

export default function (pi: ExtensionAPI) {
  let latestUi: MinimalUi | null = null;
  let context: ExtensionCommandContext | null = null;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let compacting = false;

  const safeNotify = (message: string, type?: "info" | "warning" | "error") => {
    try {
      latestUi?.notify(message, type);
    } catch {
      // The context may have been replaced; never let UI reporting break firing.
    }
  };

  const updateStatus = () => {
    try {
      if (!latestUi) return;
      const nextFireAt = scheduler.nextFireAt();
      if (nextFireAt === null && ticker) {
        clearInterval(ticker);
        ticker = undefined;
      }
      latestUi.setStatus(
        "later",
        nextFireAt === null ? undefined : `later: ${scheduler.size} pending, ${nextFireAt <= Date.now() ? "waiting for idle" : `next in ${formatRemaining(nextFireAt - Date.now())}`}`,
      );
    } catch {
      // Status is cosmetic; ignore stale context failures.
    }
  };

  const supported = (payload: string) => {
    if (!payload.startsWith("/")) return true;
    const name = payload.slice(1).split(/\s/, 1)[0];
    return name === "compact" || pi.getCommands().some((command) => command.name === name);
  };

  const scheduler = new LaterScheduler((task) => {
    try {
      if (!supported(task.payload)) throw new Error("Command is unavailable or unsupported");
      safeNotify(`/later #${task.id} dispatched: ${previewPayload(task.payload)}`, "info");
      if (/^\/compact(?:\s|$)/.test(task.payload)) {
        compacting = true;
        context!.compact({
          customInstructions: task.payload.slice("/compact".length).trim() || undefined,
          onComplete: () => { compacting = false; },
          onError: (error) => { compacting = false; safeNotify(error.message, "error"); },
        });
      } else {
        sendLaterPayload(pi, task.payload);
      }
    } catch (error) {
      compacting = false;
      safeNotify(`/later #${task.id} failed: ${String(error)}`, "error");
    } finally {
      updateStatus();
    }
  }, () => !!context && !compacting && context.isIdle() && !context.hasPendingMessages());

  pi.registerCommand("later", {
    description: "Run a command or send a message after a delay, e.g. /later 30m /ralphex-exec plan.md",
    handler: async (args, ctx) => {
      latestUi = ctx.ui ?? null;
      context = ctx;
      const plan = parseLaterArgs(args);

      if (plan.action === "usage") {
        ctx.ui.notify(plan.reason ? `${plan.reason}\n${USAGE}` : USAGE, "warning");
        return;
      }

      if (plan.action === "list") {
        ctx.ui.notify(formatLaterList(scheduler.list()), "info");
        return;
      }

      if (plan.action === "cancel") {
        if (plan.target === "all") {
          const cancelled = scheduler.cancelAll();
          ctx.ui.notify(cancelled.length ? `Cancelled ${cancelled.length} /later task(s).` : "No pending /later tasks.", "info");
        } else {
          const id = Number(plan.target);
          const task = Number.isInteger(id) && id > 0 ? scheduler.cancel(id) : null;
          ctx.ui.notify(task ? `Cancelled /later #${task.id}: ${previewPayload(task.payload)}` : `No pending /later task #${plan.target}.`, task ? "info" : "warning");
        }
        updateStatus();
        return;
      }

      if (!supported(plan.payload)) {
        ctx.ui.notify("Unsupported command. /later supports loaded extension, skill and prompt commands, plus /compact; other built-in commands cannot be scheduled.", "warning");
        return;
      }
      const task = scheduler.schedule(plan.delayMs, plan.payload);
      if (!ticker) ticker = setInterval(updateStatus, 1_000);
      ctx.ui.notify(`Scheduled /later #${task.id} in ${formatRemaining(plan.delayMs)}: ${previewPayload(task.payload)}`, "info");
      updateStatus();
    },
  });

  const cancelOnSessionChange = () => {
    const cancelled = scheduler.cancelAll();
    if (cancelled.length) safeNotify(`Session changed: cancelled ${cancelled.length} pending /later task(s).`, "warning");
    updateStatus();
  };

  pi.on("session_before_switch", cancelOnSessionChange);
  pi.on("session_before_fork", cancelOnSessionChange);
  pi.on("session_shutdown", () => {
    scheduler.clear();
    updateStatus();
    context = null;
    latestUi = null;
    compacting = false;
  });
}
