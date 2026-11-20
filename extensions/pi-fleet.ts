// pi-fleet: hard file locks + inter-session messaging for concurrent pi sessions.
//
// One machine, one working tree, shared branch: sessions claim files, the tool_call
// gate denies foreign writes (prompt discipline is not required), and peers message
// each other (bug toss, takeover-by-message) via file mailboxes that wake idle sessions.
//
// Full design: locks = O_EXCL per-file with PID+heartbeat staleness and mtime grace
// for empty files; messaging = fs.watch + 10s poll sweep + sendMessage({deliverAs:
// "steer", triggerTurn:true}); interface = fleet_* tools (model-facing) + /fleet
// commands (human sugar). Bash stays warn-only by design.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { mkdir, stat } from "node:fs/promises";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import {
  acquireLock,
  commandMentionsPath,
  deleteEnvelope,
  ensureFleetIgnored,
  fleetRoot,
  formatEnvelope,
  isLockStale,
  listLocks,
  listSessions,
  makeEnvelope,
  peekInbox,
  readLockState,
  registerSession,
  releaseAllLocks,
  releaseLock,
  removeSession,
  resolveRecipient,
  scanBashWrites,
  sendEnvelope,
  touchAllLocks,
  HEARTBEAT_INTERVAL_MS,
  type FleetIdentity,
  type LockInfo,
} from "./lib/fleet-core";

const SWEEP_INTERVAL_MS = 10_000;

const TEXT = (text: string, details?: unknown) => ({
  content: [{ type: "text" as const, text }],
  ...(details === undefined ? {} : { details }),
});

function describeLock(lock: LockInfo): string {
  return `is locked by session "${lock.ownerSessionName}" (${lock.ownerSessionId.slice(0, 8)})`;
}

const askOwnerHint = (absPath: string) =>
  `Call fleet_send with to:"owner-of:${absPath}" to ask them, or fleet_team to see all claims.`;

export default function (pi: ExtensionAPI) {
  let identity: FleetIdentity | null = null;
  let autoLock = true;
  let debug = false; // TUI only: model-visible tool results remain unchanged.
  let watcher: fs.FSWatcher | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let sweepTimer: NodeJS.Timeout | null = null;
  let delivering = false;

  const haveIdentity = (ctx: { cwd: string; sessionManager: { getSessionId(): string; getSessionName(): string | undefined } }): FleetIdentity => {
    if (!identity) {
      identity = {
        sessionId: ctx.sessionManager.getSessionId(),
        sessionName: ctx.sessionManager.getSessionName() ?? `session-${ctx.sessionManager.getSessionId().slice(0, 8)}`,
        pid: process.pid,
        cwd: ctx.cwd,
      };
    }
    return identity;
  };

  async function heartbeat(root: string, me: FleetIdentity): Promise<void> {
    await registerSession(root, me).catch(() => {});
    await touchAllLocks(root, me).catch(() => {});
  }

  async function deliverPending(root: string, me: FleetIdentity): Promise<void> {
    if (delivering) return;
    delivering = true;
    try {
      const pending = await peekInbox(root, me.sessionId);
      for (const { envelope, file } of pending) {
        await pi.sendMessage(
          { customType: "fleet-message", content: formatEnvelope(envelope), display: true },
          { deliverAs: "steer", triggerTurn: true },
        );
        await deleteEnvelope(file); // ack only after successful injection
      }
    } catch {
      // keep mail on disk; the sweep retries
    } finally {
      delivering = false;
    }
  }

  // --- gate: the enforcement core ---

  pi.on("tool_call", async (event, ctx) => {
    const me = haveIdentity(ctx); // fail closed: never run the gate without an identity
    const root = fleetRoot(ctx.cwd);

    if (event.toolName === "write" || event.toolName === "edit") {
      const rawPath = (event.input as { path?: string }).path;
      if (!rawPath) return;
      const absPath = resolve(ctx.cwd, rawPath);

      if (!autoLock) {
        const state = await readLockState(root, absPath, Date.now());
        if (state.kind === "held" && state.lock.ownerSessionId !== me.sessionId && !isLockStale(state.lock, Date.now())) {
          if (ctx.hasUI) ctx.ui.notify(`[pi-fleet] blocked ${event.toolName} ${rawPath} (locked by "${state.lock.ownerSessionName}")`, "warning");
          return {
            block: true,
            reason: `WRITE DENIED: ${rawPath} ${describeLock(state.lock)}. ${askOwnerHint(absPath)}`,
          };
        }
        return; // unclaimed file, own lock, or stale lock: allow without claiming
      }

      let result;
      try {
        result = await acquireLock(root, absPath, me, `auto (${event.toolName})`, Date.now());
      } catch (error: any) {
        return {
          block: true,
          reason: `WRITE DENIED: pi-fleet registry error (${error?.message ?? error}). Fix the registry or run /fleet release all.`,
        };
      }
      if (result.ok) return;

      const hint =
        result.state.kind === "held"
          ? `WRITE DENIED: ${rawPath} ${result.message}. ${askOwnerHint(absPath)}`
          : `WRITE DENIED: ${rawPath} ${result.message}.`;
      if (ctx.hasUI) ctx.ui.notify(`[pi-fleet] blocked ${event.toolName} ${rawPath}`, "warning");
      return { block: true, reason: hint };
    }

    if (event.toolName === "bash") {
      // Warn-only by design: bash attribution is untrustworthy, false blocks hurt more than misses.
      const command = (event.input as { command?: string }).command;
      if (!command || !scanBashWrites(command).length) return;
      const rows = await listLocks(root, Date.now());
      const suspects = rows.filter(
        (row) => row.state.kind === "held" && row.state.lock.ownerSessionId !== me.sessionId && commandMentionsPath(command, row.absPath),
      );
      if (suspects.length && ctx.hasUI) {
        ctx.ui.notify(
          `[pi-fleet] bash command may modify files locked by peers: ${suspects.map((s) => s.absPath).join(", ")}. Prefer edit/write (hard-enforced) or coordinate via fleet_send.`,
          "warning",
        );
      }
      return;
    }

    return;
  });

  // --- lifecycle ---

  pi.on("session_start", async (_event, ctx) => {
    identity = null;
    debug = false;
    const me = haveIdentity(ctx);
    const root = fleetRoot(ctx.cwd);
    await registerSession(root, me);
    if (!(await ensureFleetIgnored(ctx.cwd)) && ctx.hasUI) {
      const isRepo = await stat(join(ctx.cwd, ".git")).then(
        () => true,
        () => false,
      );
      if (isRepo) ctx.ui.notify("[pi-fleet] could not exclude .pi/fleet/ from git — registry files may show in git status", "warning");
    }

    // Wake instantly on incoming mail; the sweep is the mandated backstop.
    const inbox = join(root, "inbox", me.sessionId);
    try {
      await mkdir(inbox, { recursive: true });
      watcher = fs.watch(inbox, () => {
        void deliverPending(root, me);
      });
      watcher.unref?.(); // never hold the process open; the sweep is the backstop
      watcher.on("error", () => {}); // sweep covers a broken watcher
    } catch {
      // sweep covers it
    }

    heartbeatTimer = setInterval(() => void heartbeat(root, me), HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref();
    sweepTimer = setInterval(() => void deliverPending(root, me), SWEEP_INTERVAL_MS);
    sweepTimer.unref();

    await deliverPending(root, me); // mail that arrived while this session was away
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    watcher?.close();
    watcher = null;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (sweepTimer) clearInterval(sweepTimer);
    heartbeatTimer = sweepTimer = null;
    const me = identity;
    if (!me) return;
    const root = fleetRoot(ctx.cwd);
    await releaseAllLocks(root, me).catch(() => {});
    await removeSession(root, me.sessionId).catch(() => {});
  });

  pi.on("session_info_changed", async (event: { name?: string }, ctx) => {
    const me = haveIdentity(ctx);
    if (event.name) {
      me.sessionName = event.name;
      await registerSession(fleetRoot(ctx.cwd), me).catch(() => {});
    }
  });

  pi.on("turn_end", async () => {
    if (!identity) return;
    const root = fleetRoot(identity.cwd);
    await registerSession(root, identity).catch(() => {});
  });

  // --- model-facing tools (the model cannot invoke slash commands) ---

  pi.registerTool({
    name: "fleet_claim",
    label: "fleet_claim",
    // Self-shell + empty components remove the entire row, including its spacer.
    renderShell: "self",
    renderCall(args) {
      return debug ? new Text(`fleet_claim ${JSON.stringify(args)}`, 0, 0) : new Container();
    },
    renderResult(result) {
      return debug ? new Text(result.content.map((item) => item.type === "text" ? item.text : "").join("\n"), 0, 0) : new Container();
    },
    description:
      "Claim exclusive write ownership of files for this pi session. Claimed paths deny foreign edit/write attempts. Required before editing files another session might touch. Stale/orphaned locks are stolen loudly.",
    parameters: Type.Object({
      paths: Type.Array(Type.String({ description: "File path (relative or absolute)" }), { minItems: 1 }),
      reason: Type.Optional(Type.String({ description: "Why these files are claimed (shown to peers)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const me = haveIdentity(ctx);
      const root = fleetRoot(ctx.cwd);
      const lines: string[] = [];
      const claims: { path: string; ok: boolean; owner?: string }[] = [];
      for (const raw of params.paths) {
        const absPath = resolve(ctx.cwd, raw);
        const st = await stat(absPath).catch(() => null);
        if (st?.isDirectory()) {
          lines.push(`ERROR ${raw} — is a directory; pi-fleet enforces files, claiming it would protect nothing`);
          claims.push({ path: absPath, ok: false });
          continue;
        }
        let result;
        try {
          result = await acquireLock(root, absPath, me, params.reason, Date.now());
        } catch (error: any) {
          lines.push(`ERROR ${raw} — registry failure: ${String(error?.message ?? error)}`);
          claims.push({ path: absPath, ok: false });
          continue;
        }
        if (result.ok) {
          lines.push(`CLAIMED ${raw}`);
          claims.push({ path: absPath, ok: true });
        } else {
          lines.push(`BUSY ${raw} — ${result.message}. ${askOwnerHint(absPath)}`);
          claims.push({ path: absPath, ok: false, owner: result.state.kind === "held" ? result.state.lock.ownerSessionId : undefined });
        }
      }
      return TEXT(lines.join("\n"), { claims });
    },
  });

  pi.registerTool({
    name: "fleet_release",
    label: "fleet_release",
    description:
      "Release file claims owned by this session (never foreign locks). Use after finishing an area, or when a peer asks you to via a fleet message.",
    parameters: Type.Object({
      paths: Type.Optional(Type.Array(Type.String(), { description: "Specific paths to release" })),
      all: Type.Optional(Type.Boolean({ description: "Release every lock owned by this session" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const me = haveIdentity(ctx);
      const root = fleetRoot(ctx.cwd);
      const released = params.all ? await releaseAllLocks(root, me) : [];
      const notYours: string[] = [];
      for (const raw of params.paths ?? []) {
        const result = await releaseLock(root, resolve(ctx.cwd, raw), me);
        if (result.released) released.push(result);
        else notYours.push(`NOT YOURS ${raw} (not locked or locked by another session)`);
      }
      const lines = [...released.map((r) => `RELEASED ${r.path}`), ...notYours];
      return TEXT(lines.length ? lines.join("\n") : "nothing to release", { released });
    },
  });

  pi.registerTool({
    name: "fleet_send",
    label: "fleet_send",
    description:
      'Send a message to another live pi session. Use to toss a bug to the session owning an area (to:"owner-of:<path>"), coordinate env/testing, or ask for a lock release. Delivery wakes an idle recipient within ~10s.',
    parameters: Type.Object({
      to: Type.String({ description: "Session id, session name, or owner-of:<path>" }),
      subject: Type.String(),
      body: Type.String(),
      filePaths: Type.Optional(Type.Array(Type.String(), { description: "Files the message is about" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const me = haveIdentity(ctx);
      const root = fleetRoot(ctx.cwd);
      const recipient = await resolveRecipient(root, params.to, me, Date.now());
      if ("error" in recipient) return TEXT(`NOT DELIVERED: ${recipient.error}`, { delivered: false });
      const envelope = makeEnvelope(me, recipient.sessionId, params.subject, params.body, params.filePaths);
      await sendEnvelope(root, recipient.sessionId, envelope);
      return TEXT(
        `Delivered to "${recipient.label}" (${recipient.sessionId.slice(0, 8)}). A live session picks it up within ~10s; the message also survives until their next turn.`,
        { delivered: true, to: recipient.sessionId },
      );
    },
  });

  pi.registerTool({
    name: "fleet_team",
    label: "fleet_team",
    description:
      "Show live pi sessions in this workspace and who holds which file locks. Run before claiming files or when a write is denied.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const me = haveIdentity(ctx);
      const root = fleetRoot(ctx.cwd);
      return TEXT(await renderTeam(root, me), {
        sessions: (await listSessions(root)).length,
        locks: (await listLocks(root, Date.now())).length,
      });
    },
  });

  async function renderTeam(root: string, me: FleetIdentity): Promise<string> {
    const sessions = await listSessions(root);
    const locks = await listLocks(root, Date.now());
    const lines = ["SESSIONS:"];
    for (const { info } of sessions) {
      lines.push(`  "${info.sessionName}" ${info.sessionId.slice(0, 8)} pid=${info.pid}${info.sessionId === me.sessionId ? " (you)" : ""}`);
    }
    lines.push("LOCKS:");
    if (!locks.length) lines.push("  none");
    for (const row of locks) {
      if (row.state.kind === "held") {
        const lock = row.state.lock;
        const stale = isLockStale(lock, Date.now()) ? " [STALE - stealable]" : "";
        lines.push(`  ${lock.absPath} -> "${lock.ownerSessionName}" (${lock.ownerSessionId.slice(0, 8)})${lock.reason ? ` — ${lock.reason}` : ""}${stale}`);
      } else if (row.state.kind === "orphaned") {
        lines.push(`  ${row.absPath} [ORPHANED - stealable]`);
      }
    }
    return lines.join("\n");
  }

  // --- human sugar ---

  pi.registerCommand("fleet", {
    description: "pi-fleet team coordination (team | lock <paths> | release [all|paths] | msg <to> <text> | auto on|off | debug on|off)",
    handler: async (args, ctx: ExtensionCommandContext) => {
      const me = haveIdentity(ctx);
      const root = fleetRoot(ctx.cwd);
      const [sub, ...rest] = args.trim().split(/\s+/);
      const say = (text: string) => ctx.ui.notify(`[pi-fleet] ${text}`, "info");

      if (!sub || sub === "team") {
        say(await renderTeam(root, me));
        return;
      }
      if (sub === "lock") {
        if (!rest.length) return say("usage: /fleet lock <path...>");
        for (const raw of rest) {
          const result = await acquireLock(root, resolve(ctx.cwd, raw), me, "manual /fleet lock", Date.now());
          say(result.ok ? `claimed ${raw}` : `busy ${raw} — ${result.message}`);
        }
        return;
      }
      if (sub === "release") {
        if (rest[0] === "all") {
          const results = await releaseAllLocks(root, me);
          return say(results.length ? `released ${results.length} lock(s)` : "no locks owned");
        }
        if (!rest.length) return say("usage: /fleet release <path...>|all");
        for (const raw of rest) {
          const result = await releaseLock(root, resolve(ctx.cwd, raw), me);
          say(result.released ? `released ${raw}` : `not yours: ${raw}`);
        }
        return;
      }
      if (sub === "msg") {
        const [to, ...text] = rest;
        const body = text.join(" ");
        if (!to || !body) return say("usage: /fleet msg <to> <text>  (to: session id/name or owner-of:<path>)");
        const recipient = await resolveRecipient(root, to, me, Date.now());
        if ("error" in recipient) return say(recipient.error);
        await sendEnvelope(root, recipient.sessionId, makeEnvelope(me, recipient.sessionId, "message", body));
        return say(`delivered to "${recipient.label}"`);
      }
      if (sub === "auto") {
        if (rest[0] !== "on" && rest[0] !== "off") return say("usage: /fleet auto on|off");
        autoLock = rest[0] === "on";
        return say(`auto-lock on first write is ${autoLock ? "ON" : "OFF"}`);
      }
      if (sub === "debug") {
        if (rest[0] !== "on" && rest[0] !== "off") return say("usage: /fleet debug on|off");
        debug = rest[0] === "on";
        return say(`fleet_claim display is ${debug ? "ON" : "OFF"}`);
      }
      say("usage: /fleet team | lock <paths> | release [all|paths] | msg <to> <text> | auto on|off | debug on|off");
    },
  });

  // Test seam: pi ignores the default export's return value.
  return {
    deliverPendingNow: async () => {
      if (!identity) return;
      await deliverPending(fleetRoot(identity.cwd), identity);
    },
  };
}
