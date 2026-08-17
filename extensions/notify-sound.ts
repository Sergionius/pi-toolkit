import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";

const SOUND_PATH = "/System/Library/Sounds/Glass.aiff";

function playSound() {
  const child = spawn("/usr/bin/afplay", [SOUND_PATH], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function terminalBell() {
  process.stderr.write("\x07");
}

function playCompletionSound() {
  playSound();
  terminalBell();
}

export default function (pi: ExtensionAPI) {
  pi.events.on("ralphex:completed", () => {
    playCompletionSound();
  });

  pi.on("agent_end", async (_event, ctx) => {
    // Other extensions (notably goal auto-continue) may enqueue follow-up turns in
    // their own agent_end handlers. Defer the check so we only notify when the
    // session is really idle, avoiding repeated sounds during autonomous loops.
    try {
      setTimeout(() => {
        try {
          if (ctx.hasPendingMessages?.() || !ctx.isIdle?.()) return;
          playCompletionSound();
        } catch {
          // ctx became stale; stop safely
        }
      }, 250).unref();
    } catch {
      // ignore setup errors
    }
  });

  pi.registerCommand("test-sound", {
    description: "Play the agent-finished sound",
    handler: async () => {
      playCompletionSound();
    },
  });
}
