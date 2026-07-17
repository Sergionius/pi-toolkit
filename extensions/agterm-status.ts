import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";

type AgtermStatus = "idle" | "active" | "completed" | "blocked";

const WARN_KEY = "agterm-status-warning";
const COMPLETED_DELAY_MS = 250;
const COMPLETED_RETRY_MS = 250;
const COMPLETED_RETRY_ATTEMPTS = 20;

let warnedMissingCtl = false;

function sessionId() {
  return process.env.AGTERM_SESSION_ID?.trim();
}

function disabled() {
  return process.env.AGTERM_AGENT_STATUS_DISABLED === "1";
}

function canReportStatus() {
  return Boolean(sessionId()) && !disabled();
}

function spawnAgtermctl(args: string[], ctx?: any) {
  const child = spawn("agtermctl", args, {
    detached: true,
    stdio: "ignore",
  });

  child.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT" || warnedMissingCtl) return;
    warnedMissingCtl = true;
    try {
      ctx?.ui?.setWidget?.(WARN_KEY, [
        "agterm status disabled: agtermctl was not found on PATH",
        "Install it from agterm Help > Install Command Line Tool...",
      ]);
      setTimeout(() => {
        try {
          ctx?.ui?.setWidget?.(WARN_KEY, []);
        } catch {
          // ignore stale ctx
        }
      }, 5000).unref();
    } catch {
      // ignore stale ctx
    }
  });

  child.unref();
}

function reportStatus(status: AgtermStatus, flags: string[] = [], ctx?: any) {
  const target = sessionId();
  if (!target || disabled()) return;
  spawnAgtermctl(["session", "status", status, ...flags, "--auto-reset", "--target", target], ctx);
}

function clearUnseen(ctx?: any) {
  const target = sessionId();
  if (!target || disabled()) return;
  spawnAgtermctl(["session", "seen", "--target", target], ctx);
}

function reportCompleted(ctx?: any) {
  const target = sessionId();
  if (!target || disabled()) return;
  reportStatus("completed", ["--blink"], ctx);
  spawnAgtermctl(["notify", "pi task completed", "--title", "pi", "--target", target], ctx);
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    try {
      ctx.ui.setEditorComponent((tui, theme, keybindings) => {
        class AgtermEditor extends CustomEditor {
          handleInput(data: string): void {
            try {
              clearUnseen(ctx);
            } catch {
              // ignore stale ctx
            }
            super.handleInput(data);
          }
        }
        return new AgtermEditor(tui, theme, keybindings);
      });
    } catch {
      // ignore stale ctx
    }
  });

  pi.on("input", async (_event, ctx) => {
    try {
      clearUnseen(ctx);
    } catch {
      // ignore stale ctx
    }
  });

  pi.on("agent_start", async (_event, ctx) => {
    try {
      clearUnseen(ctx);
      reportStatus("active", [], ctx);
    } catch {
      // ignore stale ctx
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tryReportCompleted = () => {
      try {
        if (ctx.hasPendingMessages?.()) return;
        if (ctx.isIdle?.()) {
          reportCompleted(ctx);
          return;
        }
        if (attempts++ >= COMPLETED_RETRY_ATTEMPTS) return;
        timer = setTimeout(tryReportCompleted, COMPLETED_RETRY_MS);
        timer.unref();
      } catch {
        // ctx became stale; stop retrying safely
      }
    };

    try {
      timer = setTimeout(tryReportCompleted, COMPLETED_DELAY_MS);
      timer.unref();
    } catch {
      // ignore setup errors
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      reportStatus("idle", [], ctx);
    } catch {
      // ignore stale ctx
    }
  });

  pi.registerCommand("agterm-status-test", {
    description: "Set the current agterm session status for testing: idle, active, completed, or blocked",
    handler: async (args, ctx) => {
      const status = args.trim() as AgtermStatus;
      if (!["idle", "active", "completed", "blocked"].includes(status)) {
        ctx.ui.notify("Usage: /agterm-status-test idle|active|completed|blocked", "warning");
        return;
      }
      if (!canReportStatus()) {
        ctx.ui.notify("Not running in an agterm session, or AGTERM_AGENT_STATUS_DISABLED=1", "warning");
        return;
      }
      if (status === "completed") reportCompleted(ctx);
      else reportStatus(status, [], ctx);
      ctx.ui.notify(`agterm status set to ${status}`, "info");
    },
  });
}
