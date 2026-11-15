// pi-fleet core: hard file locks + inter-session mailboxes for concurrent pi sessions.
//
// Pure, pi-independent functions so tests can exercise real filesystem behavior
// with temp dirs and injectable PID liveness.
//
// Registry layout (gitignored, see ensureFleetIgnored):
//   <cwd>/.pi/fleet/locks/<sha256(absPath)>.lock   O_EXCL-created lock files
//   <cwd>/.pi/fleet/locks/<hash>.lock.steal        steal guard (serializes stealers)
//   <cwd>/.pi/fleet/sessions/<sessionId>.json      live-session presence rows
//   <cwd>/.pi/fleet/inbox/<sessionId>/<id>.json    per-session mailboxes

import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const HEARTBEAT_INTERVAL_MS = 30_000;
/** A lock whose heartbeat is older than this AND whose owner PID is dead may be stolen. */
export const LOCK_STALE_MS = 90_000;
/** An empty lock file younger than this is an acquisition in progress; never steal it. */
export const LOCK_EMPTY_GRACE_MS = 10_000;
/** A .steal guard older than this belongs to a stealer that died mid-steal; recover it. */
export const STEAL_GUARD_GRACE_MS = 15_000;
/** Mailbox temp files older than this are sweepable litter from a crashed sender. */
const TMP_MAIL_GRACE_MS = 60_000;

export type FleetIdentity = {
  sessionId: string;
  sessionName: string;
  pid: number;
  cwd: string;
};

export type LockInfo = {
  absPath: string;
  ownerSessionId: string;
  ownerSessionName: string;
  ownerPid: number;
  reason?: string;
  acquiredAt: number;
  lastHeartbeatAt: number;
};

export type SessionInfo = {
  sessionId: string;
  sessionName: string;
  pid: number;
  cwd: string;
  startedAt: number;
  lastSeenAt: number;
};

export type Envelope = {
  id: string;
  from: { sessionId: string; sessionName: string; pid: number };
  to: string;
  subject: string;
  body: string;
  filePaths?: string[];
  createdAt: number;
};

/** Lock file state under the agreed decision matrix (design §3 + addendum Gap 3). */
export type LockState =
  | { kind: "held"; lock: LockInfo }
  | { kind: "in-progress" }
  | { kind: "orphaned" }
  | { kind: "missing" };

export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM"; // EPERM means the process exists but is not ours to signal
  }
}

/** True when a content-bearing lock may be stolen: owner dead AND heartbeat cold. */
export function isLockStale(lock: LockInfo, now: number, pidAlive: (pid: number) => boolean = isPidAlive): boolean {
  if (pidAlive(lock.ownerPid)) return false; // hung-but-alive keeps the lock by design
  return now - lock.lastHeartbeatAt > LOCK_STALE_MS;
}

export function fleetRoot(cwd: string): string {
  return join(resolve(cwd), ".pi", "fleet");
}

export function lockFilePath(root: string, absPath: string): string {
  const hash = createHash("sha256").update(resolve(absPath)).digest("hex");
  return join(root, "locks", `${hash}.lock`);
}

export function locksDir(root: string): string {
  return join(root, "locks");
}

export function sessionsDir(root: string): string {
  return join(root, "sessions");
}

export function inboxDir(root: string, sessionId: string): string {
  return join(root, "inbox", sessionId);
}

async function ensureDirs(root: string): Promise<void> {
  await mkdir(locksDir(root), { recursive: true });
  await mkdir(sessionsDir(root), { recursive: true });
  await mkdir(join(root, "inbox"), { recursive: true });
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null; // ENOENT, crash-mid-write truncation, foreign garbage: callers decide
  }
}

/** Temp+rename write: concurrent readers never see empty/truncated content. */
async function writeFileAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

/** Decide the state of a lock file without stealing it. Retries briefly on ENOENT (steal race). */
export async function readLockState(root: string, absPath: string, now: number): Promise<LockState> {
  const file = lockFilePath(root, absPath);
  for (let attempt = 0; attempt < 3; attempt++) {
    let raw: string | null;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      // Either genuinely missing, or a stealer unlinked it between our calls: retry, then missing.
      const exists = await stat(file).then(
        () => true,
        () => false,
      );
      if (!exists) return { kind: "missing" };
      await new Promise((r) => setTimeout(r, 25));
      continue;
    }
    if (raw.trim() === "") {
      // O_EXCL won, content not yet written: crash window or concurrent acquisition.
      const mtime = await stat(file)
        .then((s) => s.mtimeMs)
        .catch(() => now);
      return now - mtime >= LOCK_EMPTY_GRACE_MS ? { kind: "orphaned" } : { kind: "in-progress" };
    }
    let lock: LockInfo | null = null;
    try {
      lock = JSON.parse(raw) as LockInfo;
    } catch {
      // truncated mid-write: same grace rule as empty files, mtime is the only sound signal
      const mtime = await stat(file)
        .then((st) => st.mtimeMs)
        .catch(() => now);
      return now - mtime >= LOCK_EMPTY_GRACE_MS ? { kind: "orphaned" } : { kind: "in-progress" };
    }
    if (!lock?.ownerSessionId) return { kind: "orphaned" }; // garbage content from a foreign writer
    return { kind: "held", lock };
  }
  return { kind: "missing" };
}

export type AcquireResult =
  | { ok: true }
  | { ok: false; state: LockState; message: string };

/** O_EXCL acquire. Steals orphaned/stale locks first (guarded), never live ones. */
export async function acquireLock(
  root: string,
  absPath: string,
  identity: FleetIdentity,
  reason: string | undefined,
  now: number = Date.now(),
): Promise<AcquireResult> {
  await ensureDirs(root);
  const file = lockFilePath(root, absPath);

  const state = await readLockState(root, absPath, now);
  if (state.kind === "held") {
    if (state.lock.ownerSessionId === identity.sessionId) {
      await touchLock(root, absPath, identity, now); // re-claim by owner is a heartbeat refresh
      return { ok: true };
    }
    if (!isLockStale(state.lock, now)) {
      return {
        ok: false,
        state,
        message: `held by session "${state.lock.ownerSessionName}" (${state.lock.ownerSessionId.slice(0, 8)})`,
      };
    }
    // Stale: fall through to guarded steal.
  } else if (state.kind === "in-progress") {
    return { ok: false, state, message: "lock acquisition in progress, retry shortly" };
  } else if (state.kind === "orphaned") {
    // Fall through to guarded steal.
  }

  if (state.kind === "held" || state.kind === "orphaned") {
    const stolen = await stealLock(root, absPath, identity, reason, now);
    if (!stolen.ok) {
      // Lost the steal race: re-read and report the new reality.
      const fresh = await readLockState(root, absPath, Date.now());
      if (fresh.kind === "held" && fresh.lock.ownerSessionId === identity.sessionId) return { ok: true };
      if (fresh.kind === "held") {
        return {
          ok: false,
          state: fresh,
          message: `held by session "${fresh.lock.ownerSessionName}" (${fresh.lock.ownerSessionId.slice(0, 8)})`,
        };
      }
      return { ok: false, state: fresh, message: "lock changed during acquisition, retry" };
    }
    return { ok: true };
  }

  // No lock: plain O_EXCL acquire.
  const payload: LockInfo = {
    absPath: resolve(absPath),
    ownerSessionId: identity.sessionId,
    ownerSessionName: identity.sessionName,
    ownerPid: identity.pid,
    reason,
    acquiredAt: now,
    lastHeartbeatAt: now,
  };
  try {
    const handle = await open(file, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(payload, null, "\t"));
    } finally {
      await handle.close();
    }
    return { ok: true };
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
    const fresh = await readLockState(root, absPath, Date.now());
    if (fresh.kind === "held" && fresh.lock.ownerSessionId === identity.sessionId) return { ok: true };
    const who =
      fresh.kind === "held"
        ? `held by session "${fresh.lock.ownerSessionName}"`
        : fresh.kind === "in-progress"
          ? "lock acquisition in progress, retry shortly"
          : "lock changed during acquisition, retry";
    return { ok: false, state: fresh, message: who };
  }
}

/** Guarded steal: .steal O_EXCL serializes stealers; winner replaces the lock atomically-enough. */
async function stealLock(
  root: string,
  absPath: string,
  identity: FleetIdentity,
  reason: string | undefined,
  now: number,
): Promise<{ ok: boolean }> {
  const file = lockFilePath(root, absPath);
  const guard = `${file}.steal`;
  let guardHandle;
  try {
    guardHandle = await open(guard, "wx", 0o600);
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
    // A guard left behind means a stealer died mid-steal: recover it after the grace window,
    // otherwise it would block every future steal of this lock forever.
    const mtime = await stat(guard)
      .then((st) => st.mtimeMs)
      .catch(() => Date.now());
    if (Date.now() - mtime < STEAL_GUARD_GRACE_MS) return { ok: false }; // another stealer is on it
    await unlink(guard).catch(() => {});
    try {
      guardHandle = await open(guard, "wx", 0o600);
    } catch {
      return { ok: false };
    }
  }
  try {
    await unlink(file).catch(() => {}); // best effort: it may already be gone
    const result = await acquireLock(root, absPath, identity, reason, Date.now());
    return { ok: result.ok };
  } finally {
    await guardHandle.close();
    await unlink(guard).catch(() => {});
  }
}

/** Heartbeat refresh: only rewrites the content of locks this session owns. */
export async function touchLock(root: string, absPath: string, identity: FleetIdentity, now: number = Date.now()): Promise<void> {
  const file = lockFilePath(root, absPath);
  const lock = await readJson<LockInfo>(file);
  if (!lock || lock.ownerSessionId !== identity.sessionId) return;
  lock.lastHeartbeatAt = now;
  await writeFileAtomic(file, JSON.stringify(lock, null, "\t"));
}

export async function touchAllLocks(root: string, identity: FleetIdentity, now: number = Date.now()): Promise<void> {
  for (const file of await listLockFiles(root)) {
    const lock = await readJson<LockInfo>(file);
    if (lock?.ownerSessionId === identity.sessionId) {
      lock.lastHeartbeatAt = now;
      await writeFileAtomic(file, JSON.stringify(lock, null, "\t"));
    }
  }
}

async function listLockFiles(root: string): Promise<string[]> {
  try {
    const names = await readdir(locksDir(root));
    return names.filter((n) => n.endsWith(".lock")).map((n) => join(locksDir(root), n));
  } catch {
    return [];
  }
}

export type ReleaseResult = { path: string; released: boolean };

/** Release only locks owned by this session. Never touches foreign locks. */
export async function releaseLock(root: string, absPath: string, identity: FleetIdentity): Promise<ReleaseResult> {
  const file = lockFilePath(root, absPath);
  const lock = await readJson<LockInfo>(file);
  if (!lock || lock.ownerSessionId !== identity.sessionId) return { path: absPath, released: false };
  await unlink(file).catch(() => {});
  return { path: absPath, released: true };
}

export async function releaseAllLocks(root: string, identity: FleetIdentity): Promise<ReleaseResult[]> {
  const results: ReleaseResult[] = [];
  for (const file of await listLockFiles(root)) {
    const lock = await readJson<LockInfo>(file);
    if (lock?.ownerSessionId !== identity.sessionId) continue;
    await unlink(file).catch(() => {});
    results.push({ path: lock.absPath, released: true });
  }
  return results;
}

export type LockRow = { state: Exclude<LockState, { kind: "missing" }>; absPath: string };

/** All non-missing locks in the registry with their evaluated state. */
export async function listLocks(root: string, now: number = Date.now()): Promise<LockRow[]> {
  const rows: LockRow[] = [];
  for (const file of await listLockFiles(root)) {
    const raw = await readFile(file, "utf8").catch(() => "");
    if (raw.trim() === "") {
      const mtime = await stat(file)
        .then((s) => s.mtimeMs)
        .catch(() => now);
      rows.push({ absPath: file, state: now - mtime >= LOCK_EMPTY_GRACE_MS ? { kind: "orphaned" } : { kind: "in-progress" } });
      continue;
    }
    const lock = await readJson<LockInfo>(file);
    if (!lock) continue;
    rows.push({ absPath: lock.absPath, state: { kind: "held", lock } });
  }
  return rows;
}

export async function registerSession(root: string, identity: FleetIdentity, now: number = Date.now()): Promise<void> {
  await ensureDirs(root);
  const file = join(sessionsDir(root), `${identity.sessionId}.json`);
  const existing = await readJson<SessionInfo>(file);
  const info: SessionInfo = existing
    ? { ...existing, sessionName: identity.sessionName, pid: identity.pid, lastSeenAt: now }
    : { sessionId: identity.sessionId, sessionName: identity.sessionName, pid: identity.pid, cwd: identity.cwd, startedAt: now, lastSeenAt: now };
  await writeFileAtomic(file, JSON.stringify(info, null, "\t"));
}

export async function touchSession(root: string, identity: FleetIdentity, now: number = Date.now()): Promise<void> {
  const file = join(sessionsDir(root), `${identity.sessionId}.json`);
  const info = await readJson<SessionInfo>(file);
  if (!info) return registerSession(root, identity, now);
  info.lastSeenAt = now;
  info.sessionName = identity.sessionName;
  await writeFileAtomic(file, JSON.stringify(info, null, "\t"));
}

export async function removeSession(root: string, sessionId: string): Promise<void> {
  await unlink(join(sessionsDir(root), `${sessionId}.json`)).catch(() => {});
}

export type SessionRow = { info: SessionInfo };

/** Live sessions; prunes rows whose PID is dead (crashed without cleanup). */
export async function listSessions(root: string, pidAlive: (pid: number) => boolean = isPidAlive): Promise<SessionRow[]> {
  let names: string[] = [];
  try {
    names = await readdir(sessionsDir(root));
  } catch {
    return [];
  }
  const rows: SessionRow[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = join(sessionsDir(root), name);
    const info = await readJson<SessionInfo>(file);
    if (!info) continue;
    if (!pidAlive(info.pid)) {
      await unlink(file).catch(() => {}); // prune the dead; their locks age out via staleness
      await rm(inboxDir(root, info.sessionId), { recursive: true, force: true }).catch(() => {}); // undeliverable mail
      continue;
    }
    rows.push({ info });
  }
  return rows;
}

export function makeEnvelope(
  from: FleetIdentity,
  to: string,
  subject: string,
  body: string,
  filePaths?: string[],
): Envelope {
  return {
    id: randomUUID(),
    from: { sessionId: from.sessionId, sessionName: from.sessionName, pid: from.pid },
    to,
    subject,
    body,
    filePaths: filePaths?.length ? filePaths : undefined,
    createdAt: Date.now(),
  };
}

/** Atomic delivery: temp file + rename inside the recipient's inbox dir. */
export async function sendEnvelope(root: string, toSessionId: string, envelope: Envelope): Promise<string> {
  const dir = inboxDir(root, toSessionId);
  await mkdir(dir, { recursive: true });
  const target = join(dir, `${envelope.id}.json`);
  const tmp = join(dir, `${envelope.id}.tmp-${process.pid}`);
  await writeFile(tmp, JSON.stringify(envelope, null, "\t"));
  await rename(tmp, target);
  return target;
}

export function formatEnvelope(envelope: Envelope): string {
  const files = envelope.filePaths?.length ? `\nFiles: ${envelope.filePaths.join(", ")}` : "";
  return `[pi-fleet] From "${envelope.from.sessionName}" (${envelope.from.sessionId.slice(0, 8)}): ${envelope.subject}\n${envelope.body}${files}`;
}

/** Read inbox WITHOUT consuming; delivery acks by deleting per file after successful injection. */
export async function peekInbox(root: string, sessionId: string): Promise<{ envelope: Envelope; file: string }[]> {
  const dir = inboxDir(root, sessionId);
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: { envelope: Envelope; file: string }[] = [];
  const now = Date.now();
  for (const name of names) {
    const file = join(dir, name);
    if (name.includes(".tmp-")) {
      // crashed sender's temp file: sweep it once it is definitely abandoned
      const mtime = await stat(file)
        .then((st) => st.mtimeMs)
        .catch(() => now);
      if (now - mtime > TMP_MAIL_GRACE_MS) await unlink(file).catch(() => {});
      continue;
    }
    if (!name.endsWith(".json")) continue;
    const envelope = await readJson<Envelope>(file);
    if (envelope) out.push({ envelope, file });
  }
  return out.sort((a, b) => a.envelope.createdAt - b.envelope.createdAt);
}

/** Delivery ack: called only after the message was injected into the session. */
export async function deleteEnvelope(file: string): Promise<void> {
  await unlink(file).catch(() => {});
}

/** Read-and-delete every message currently in the session's inbox. */
export async function drainInbox(root: string, sessionId: string): Promise<Envelope[]> {
  const dir = inboxDir(root, sessionId);
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const envelopes: Envelope[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.includes(".tmp-")) continue;
    const file = join(dir, name);
    const envelope = await readJson<Envelope>(file);
    await unlink(file).catch(() => {}); // consume regardless: a half-written message is undeliverable
    if (envelope) envelopes.push(envelope);
  }
  return envelopes.sort((a, b) => a.createdAt - b.createdAt);
}

/** `to` addressing: session id, session name (unique among live), or owner-of:<path>. */
export async function resolveRecipient(
  root: string,
  to: string,
  identity: FleetIdentity,
  now: number = Date.now(),
): Promise<{ sessionId: string; label: string } | { error: string }> {
  const trimmed = to.trim();
  if (trimmed.startsWith("owner-of:")) {
    const absPath = resolve(trimmed.slice("owner-of:".length));
    const state = await readLockState(root, absPath, now);
    if (state.kind === "held") {
      const lock = state.lock;
      if (lock.ownerSessionId === identity.sessionId) return { error: "you own that lock — send to a peer instead" };
      if (isLockStale(lock, now)) {
        return { error: `lock on "${trimmed.slice("owner-of:".length)}" is stale — its owner (${lock.ownerSessionName}) appears dead. fleet_claim it instead of messaging.` };
      }
      const sessions = await listSessions(root);
      if (!sessions.some((s) => s.info.sessionId === lock.ownerSessionId)) {
        return { error: `lock owner "${lock.ownerSessionName}" has no live session — fleet_claim to steal the lock instead.` };
      }
      return { sessionId: lock.ownerSessionId, label: lock.ownerSessionName };
    }
    if (state.kind === "orphaned") {
      return { error: `lock on "${trimmed.slice("owner-of:".length)}" is orphaned — fleet_claim it instead of messaging.` };
    }
    if (state.kind === "in-progress") {
      return { error: `lock acquisition in progress on "${trimmed.slice("owner-of:".length)}" — retry shortly.` };
    }
    return { error: `no lock owner for "${trimmed.slice("owner-of:".length)}" — nothing is claimed there (try fleet_team)` };
  }
  const sessions = await listSessions(root);
  const byId = sessions.find((s) => s.info.sessionId === trimmed);
  if (byId) return { sessionId: byId.info.sessionId, label: byId.info.sessionName };
  const byName = sessions.filter((s) => s.info.sessionName === trimmed);
  if (byName.length === 1 && byName[0].info.sessionId !== identity.sessionId) {
    return { sessionId: byName[0].info.sessionId, label: byName[0].info.sessionName };
  }
  if (byName.length > 0 && byName.every((s) => s.info.sessionId === identity.sessionId)) {
    return { error: `"${trimmed}" is this session — send to a peer instead` };
  }
  if (byName.length > 1) return { error: `ambiguous session name "${trimmed}" — use a session id (see fleet_team)` };
  return { error: `no live session "${trimmed}" — see fleet_team` };
}

// --- bash warn-only scanner (design: deny-on-confident never ships in v1) ---

const BASH_WRITE_PATTERNS: RegExp[] = [
  /\bsed\b[^\n|;&]*\B-i\b/,
  /\bperl\b[^\n|;&]*\B-pi?\b/,
  /\btee\b/,
  /\bdd\b[^\n]*\bof=/,
  /\btruncate\b/,
  /\bpatch\b(?:\s|$)/,
  /\bgit\s+(?:checkout|restore|clean)\b(?!\s+-[bB]\b)/, // branch creation is not a write
  /\bmv\b(?:\s|$)/,
  /\brm\b(?:\s|$)/,
  /\btouch\b(?:\s|$)/,
  />{1,2}\s*["']?[^\s"'|;&\n]+/, // output redirection only ("<" is a read)
  /\bsponge\b/,
];

/** Returns matched write-ish pattern sources; empty array = nothing write-looking. */
export function scanBashWrites(command: string): string[] {
  const hits: string[] = [];
  for (const pattern of BASH_WRITE_PATTERNS) {
    if (pattern.test(command)) hits.push(pattern.source);
  }
  return hits;
}

/** Does the command plausibly reference this locked path (token match, quoting-tolerant enough to warn)? */
export function commandMentionsPath(command: string, absPath: string): boolean {
  const base = absPath.split("/").pop() ?? absPath;
  const stem = base.replace(/\.[^.]+$/, "");
  if (stem.length < 4) return false; // too generic (e.g. "index") to warn without noise
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return command.includes(absPath) || new RegExp(`\\b${escaped}\\b`).test(command);
}

/** Best-effort: keep the registry out of git via local exclude (never touches committed .gitignore).
 *  Resolves linked worktrees too: there `.git` is a file (`gitdir: <path>`), not a directory. */
export async function ensureFleetIgnored(cwd: string): Promise<boolean> {
  const cwdAbs = resolve(cwd);
  const gitEntry = join(cwdAbs, ".git");
  let excludeFile: string | null = null;
  try {
    const st = await stat(gitEntry);
    if (st.isDirectory()) {
      excludeFile = join(gitEntry, "info", "exclude");
    } else if (st.isFile()) {
      const content = await readFile(gitEntry, "utf8");
      const match = content.match(/^gitdir:\s*(.+)$/m);
      if (match) excludeFile = join(resolve(cwdAbs, match[1].trim()), "info", "exclude");
    }
  } catch {
    return false; // no .git at all — not a repository, nothing to exclude
  }
  if (!excludeFile) return false;
  try {
    await mkdir(dirname(excludeFile), { recursive: true });
    let current = "";
    try {
      current = await readFile(excludeFile, "utf8");
    } catch {
      // no exclude file yet — create with a header
    }
    if (current.split("\n").some((line) => line.trim() === ".pi/fleet/")) return true; // already ensured — not a failure
    const header = current === "" ? "# Managed by pi-fleet (local only)\n" : "";
    await appendFile(excludeFile, `${header}.pi/fleet/\n`);
    return true;
  } catch {
    return false; // not a git worktree or read-only: locks still work, just visible to git status
  }
}
