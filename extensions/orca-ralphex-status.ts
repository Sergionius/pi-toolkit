import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const POST_TIMEOUT_MS = 1_000;

type HookCoordinates = {
  port?: string;
  token?: string;
  env: string;
  version: string;
};

function hookCoordinates(): HookCoordinates {
  const values: Record<string, string> = {};
  const endpoint = process.env.ORCA_AGENT_HOOK_ENDPOINT;
  if (endpoint) {
    try {
      for (const line of readFileSync(endpoint, "utf8").split(/\r?\n/)) {
        const match = line.match(/^(?:set\s+)?([A-Z0-9_]+)=(.*)$/);
        if (match) values[match[1]] = match[2].replace(/\r$/, "");
      }
    } catch {
      // Orca status is advisory and must not interrupt Ralphex.
    }
  }
  return {
    port: values.ORCA_AGENT_HOOK_PORT || process.env.ORCA_AGENT_HOOK_PORT,
    token: values.ORCA_AGENT_HOOK_TOKEN || process.env.ORCA_AGENT_HOOK_TOKEN,
    env: values.ORCA_AGENT_HOOK_ENV || process.env.ORCA_AGENT_HOOK_ENV || "",
    version: values.ORCA_AGENT_HOOK_VERSION || process.env.ORCA_AGENT_HOOK_VERSION || "",
  };
}

export default function (pi: ExtensionAPI): void {
  let operationInFlight = false;
  let sessionMetadata: Record<string, string> = {};
  let delivery = Promise.resolve();

  const post = (hookEventName: string, extra: Record<string, unknown> = {}) => {
    delivery = delivery.then(async () => {
      const coordinates = hookCoordinates();
      const paneKey = process.env.ORCA_PANE_KEY;
      if (!coordinates.port || !coordinates.token || !paneKey) return;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
      timeout.unref?.();
      try {
        await fetch(`http://127.0.0.1:${coordinates.port}/hook/pi`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Orca-Agent-Hook-Token": coordinates.token,
          },
          body: JSON.stringify({
            paneKey,
            launchToken: process.env.ORCA_AGENT_LAUNCH_TOKEN || "",
            tabId: process.env.ORCA_TAB_ID || "",
            worktreeId: process.env.ORCA_WORKTREE_ID || "",
            env: coordinates.env,
            version: coordinates.version,
            payload: { hook_event_name: hookEventName, ...sessionMetadata, ...extra },
          }),
          signal: controller.signal,
        });
      } catch {
        // Status delivery must never fail a Ralphex command.
      } finally {
        clearTimeout(timeout);
      }
    }).catch(() => {});
  };

  pi.on("session_start", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId?.();
    const sessionFile = ctx.sessionManager.getSessionFile?.();
    sessionMetadata = {
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(sessionFile ? { session_file: sessionFile } : {}),
    };
    operationInFlight = false;
  });

  pi.events.on("ralphex:started", (event: { name?: string } = {}) => {
    operationInFlight = true;
    post("before_agent_start", { prompt: event.name || "Ralphex" });
    post("agent_start");
  });

  pi.events.on("ralphex:completed", () => {
    operationInFlight = false;
    post("agent_end");
  });

  pi.events.on("ralphex:failed", () => {
    operationInFlight = false;
    post("agent_end");
  });

  pi.on("ui_prompt_end", () => {
    if (!operationInFlight) return;
    // Orca's managed Pi hook sees the parent command as idle after a dialog.
    // Reassert child-process activity after its prompt-end update is delivered.
    setTimeout(() => post("agent_start"), 50).unref?.();
  });
}
