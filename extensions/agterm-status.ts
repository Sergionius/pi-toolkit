import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type AgtermStatus = "idle" | "active" | "completed" | "blocked";

type TerminalWriter = {
  isTTY?: boolean;
  write(chunk: string): unknown;
};

export const AGTERM_COMPLETION_OSC = "\x1b]9;pi task completed\x07";

export function emitCompletionNotification(stream: TerminalWriter = process.stdout): boolean {
  if (!stream.isTTY) return false;
  stream.write(AGTERM_COMPLETION_OSC);
  return true;
}

function disabled(): boolean {
  return process.env.AGTERM_AGENT_STATUS_DISABLED === "1";
}

function completedFlags(): string[] {
  return process.env.PI_AGTERM_COMPLETED_MODE === "auto-reset" ? ["--auto-reset"] : [];
}

function statusArgs(status: AgtermStatus, flags: string[] = []): string[] | undefined {
  const target = process.env.AGTERM_SESSION_ID?.trim();
  if (!target || disabled()) return undefined;

  const args = ["session", "status", status, ...flags, "--target", target];
  const socket = process.env.AGTERM_SOCKET?.trim();
  const pane = process.env.AGTERM_PANE?.trim();
  const paneId = process.env.AGTERM_PANE_ID?.trim();

  if (socket) args.push("--socket", socket);
  if (pane) args.push("--pane", pane);
  if (paneId) args.push("--pane-id", paneId);
  return args;
}

export default function (pi: ExtensionAPI) {
  async function runAgtermctl(args: string[] | undefined): Promise<boolean> {
    if (!args) return false;
    try {
      const result = await pi.exec("agtermctl", args, { timeout: 1_000 });
      return result.code === 0;
    } catch {
      // Status reporting is advisory and must never interrupt Pi's agent loop.
      return false;
    }
  }

  async function report(status: AgtermStatus, flags: string[] = []): Promise<boolean> {
    return runAgtermctl(statusArgs(status, flags));
  }

  async function notifyCompleted(): Promise<void> {
    if (!process.env.AGTERM_SESSION_ID?.trim() || disabled()) return;

    // OSC 9 is handled by the originating agterm pane. Unlike `agtermctl notify`, its native path
    // suppresses the unseen badge only when this exact pane is focused AND agterm is the active app.
    // OSC has zero display width, so writing it into Pi's terminal stream does not disturb the TUI.
    emitCompletionNotification();
  }

  pi.on("agent_start", async () => {
    await report("active", ["--blink"]);
  });

  // Fires only after retries, compaction retries, and queued continuations have finished.
  pi.on("agent_settled", async () => {
    if (await report("completed", completedFlags())) await notifyCompleted();
  });

  pi.registerCommand("agterm-status-test", {
    description: "Set the current agterm session status for testing: idle, active, completed, or blocked",
    handler: async (args, ctx) => {
      const status = args.trim() as AgtermStatus;
      if (!["idle", "active", "completed", "blocked"].includes(status)) {
        ctx.ui.notify("Usage: /agterm-status-test idle|active|completed|blocked", "warning");
        return;
      }
      if (!process.env.AGTERM_SESSION_ID || disabled()) {
        ctx.ui.notify("Not running in an agterm session, or AGTERM_AGENT_STATUS_DISABLED=1", "warning");
        return;
      }

      const flags = status === "completed" ? completedFlags() : [];
      const reported = await report(status, flags);
      ctx.ui.notify(
        reported ? `agterm status set to ${status}` : "Failed to update agterm status via agtermctl",
        reported ? "info" : "warning",
      );
    },
  });
}
