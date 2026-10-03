import { execFileSync, spawn, type ChildProcess } from "node:child_process";

/** The caller must spawn the leader detached on POSIX. Retain descendants before reparenting. */
export function processTree(child: ChildProcess, graceMs = 5000, onError: (message: string) => void = () => {}) {
  const descendants = new Set<number>();
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  let disposed = false;
  const kill = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      killer.on("error", (error) => onError(error.message));
      return;
    }
    try {
      const rows = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8", timeout: 2000 }).trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number));
      const parents = new Set([child.pid, ...descendants]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const [pid, ppid] of rows) if (parents.has(ppid) && !parents.has(pid)) {
          parents.add(pid); descendants.add(pid); changed = true;
        }
      }
    } catch (error) { onError(`Cannot enumerate descendants: ${String(error)}`); }
    for (const pid of [...descendants].reverse()) {
      try { process.kill(-pid, signal); } catch { /* Not a group leader or already exited. */ }
      try { process.kill(pid, signal); } catch { /* Already exited. */ }
    }
    try { process.kill(-child.pid, signal); } catch { /* Already exited. */ }
  };
  return {
    stop() {
      if (stopping || disposed) return;
      stopping = true;
      kill("SIGTERM");
      escalation = setTimeout(() => { escalation = undefined; kill("SIGKILL"); }, graceMs);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (escalation) clearTimeout(escalation);
      // The leader may close its pipes before detached children terminate.
      if (stopping) kill("SIGKILL");
    },
  };
}
