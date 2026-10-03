import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactValue } from "./diagnostics";

export function workerLogRoot(): string {
  return join(tmpdir(), `pi-toolkit-${process.getuid?.() ?? "user"}-worker-logs`);
}

function privateRoot(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new Error("Unsafe worker log directory");
  chmodSync(root, 0o700);
}

/** Only completed, toolkit-owned attempts are eligible. Never follow links. */
export function pruneWorkerLogs(root: string, days: number, now = Date.now()): void {
  for (const name of readdirSync(root)) {
    if (!/^attempt-[a-zA-Z0-9]+$/.test(name)) continue;
    const directory = join(root, name);
    try {
      const info = lstatSync(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) continue;
      const marker = join(directory, "completed.json");
      if (existsSync(join(directory, "active")) || !lstatSync(marker).isFile() || lstatSync(marker).isSymbolicLink()) continue;
      const completed = JSON.parse(readFileSync(marker, "utf8"));
      if (completed.owner !== "pi-toolkit-worker" || !Number.isFinite(completed.at) || completed.at >= now - days * 86400000) continue;
      // Another cleaner may win the race. Removing this directory does not follow child symlinks.
      rmSync(directory, { recursive: true, force: true });
    } catch { /* Active, incomplete, foreign or concurrently removed attempt: leave it alone. */ }
  }
}

export function createWorkerLog(root = workerLogRoot(), days = Number(process.env.RALPHEX_WORKER_LOG_RETENTION_DAYS ?? 7)) {
  if (!Number.isFinite(days) || days <= 0) throw new Error("RALPHEX_WORKER_LOG_RETENTION_DAYS must be a positive number");
  privateRoot(root);
  try { pruneWorkerLogs(root, days); } catch { /* Retention must not fail execution. */ }
  const directory = mkdtempSync(join(root, "attempt-"));
  chmodSync(directory, 0o700);
  writeFileSync(join(directory, "active"), String(process.pid), { mode: 0o600, flag: "wx" });
  const path = join(directory, "attempt.json");
  return {
    path,
    finish(result: unknown) {
      writeFileSync(join(directory, "attempt.tmp"), JSON.stringify(redactValue(result), null, 2), { mode: 0o600, flag: "wx" });
      renameSync(join(directory, "attempt.tmp"), path);
      writeFileSync(join(directory, "completed.json"), JSON.stringify({ owner: "pi-toolkit-worker", at: Date.now() }), { mode: 0o600, flag: "wx" });
      rmSync(join(directory, "active"));
    },
  };
}
