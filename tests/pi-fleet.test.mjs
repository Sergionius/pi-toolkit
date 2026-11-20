import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, utimes, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const jiti = createJiti(import.meta.url);

const core = await jiti.import(resolve(root, "extensions/lib/fleet-core.ts"));
const { default: loadFleet } = await jiti.import(resolve(root, "extensions/pi-fleet.ts"));

const DEAD_PID = 2_147_483_000; // beyond any real pid_max -> isPidAlive == false
const ALIVE_PID = process.pid;

async function makeTmp() {
  return mkdtemp(join(tmpdir(), "pi-fleet-test-"));
}

function identity(id, name) {
  return { sessionId: id, sessionName: name, pid: ALIVE_PID, cwd: process.cwd() };
}

function lockJson(ownerId, ownerName, pid, heartbeatAgeMs, now) {
  return JSON.stringify({
    absPath: "/does/not/matter",
    ownerSessionId: ownerId,
    ownerSessionName: ownerName,
    ownerPid: pid,
    acquiredAt: now - heartbeatAgeMs - 1000,
    lastHeartbeatAt: now - heartbeatAgeMs,
  });
}

// --- staleness decision matrix (base design §3 + addendum Gap 3) ---

test("staleness matrix: alive pid keeps the lock regardless of heartbeat age", () => {
  const now = Date.now();
  const lock = JSON.parse(lockJson("s-b", "beta", ALIVE_PID, 10 * 60_000, now));
  assert.equal(core.isLockStale(lock, now), false, "hung-but-alive session keeps its lock");
});

test("staleness matrix: dead pid + cold heartbeat is stealable", () => {
  const now = Date.now();
  const lock = JSON.parse(lockJson("s-b", "beta", DEAD_PID, core.LOCK_STALE_MS + 1000, now));
  assert.equal(core.isLockStale(lock, now), true);
});

test("staleness matrix: dead pid + fresh heartbeat is NOT stealable (crash grace)", () => {
  const now = Date.now();
  const lock = JSON.parse(lockJson("s-b", "beta", DEAD_PID, 1000, now));
  assert.equal(core.isLockStale(lock, now), false);
});

test("isPidAlive: own process alive, dead pid and invalid pids not alive", () => {
  assert.equal(core.isPidAlive(ALIVE_PID), true);
  assert.equal(core.isPidAlive(DEAD_PID), false);
  assert.equal(core.isPidAlive(0), false);
  assert.equal(core.isPidAlive(-1), false);
});

// --- lock lifecycle on real fs ---

test("acquire -> foreign deny -> release -> re-acquire", async () => {
  const tmp = await makeTmp();
  try {
    const rootFleet = core.fleetRoot(tmp);
    const file = join(tmp, "src.ts");
    const A = identity("sess-aaaa", "alpha");
    const B = identity("sess-bbbb", "beta");

    assert.deepEqual(await core.acquireLock(rootFleet, file, A, "task", Date.now()), { ok: true });
    const locked = await core.readLockState(rootFleet, file, Date.now());
    assert.equal(locked.kind, "held");
    assert.equal(locked.lock.ownerSessionId, "sess-aaaa");

    const foreign = await core.acquireLock(rootFleet, file, B, "task", Date.now());
    assert.equal(foreign.ok, false);
    assert.match(foreign.message, /alpha/);

    await core.releaseLock(rootFleet, file, A);
    const foreign2 = await core.acquireLock(rootFleet, file, B, "task", Date.now());
    assert.deepEqual(foreign2, { ok: true });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("owner re-acquire refreshes heartbeat instead of failing", async () => {
  const tmp = await makeTmp();
  try {
    const rootFleet = core.fleetRoot(tmp);
    const file = join(tmp, "src.ts");
    const A = identity("sess-aaaa", "alpha");
    await core.acquireLock(rootFleet, file, A, "task", Date.now() - 50_000);
    const before = JSON.parse(await readFile(core.lockFilePath(rootFleet, file), "utf8"));
    assert.deepEqual(await core.acquireLock(rootFleet, file, A, "task", Date.now()), { ok: true });
    const after = JSON.parse(await readFile(core.lockFilePath(rootFleet, file), "utf8"));
    assert.ok(after.lastHeartbeatAt > before.lastHeartbeatAt);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("stale lock (dead pid + cold heartbeat) is stolen by acquire", async () => {
  const tmp = await makeTmp();
  try {
    const rootFleet = core.fleetRoot(tmp);
    const file = join(tmp, "src.ts");
    const lockFile = core.lockFilePath(rootFleet, file);
    await mkdir(core.locksDir(rootFleet), { recursive: true });
    const now = Date.now();
    await writeFile(lockFile, lockJson("sess-bbbb", "beta", DEAD_PID, core.LOCK_STALE_MS + 5000, now));

    const result = await core.acquireLock(rootFleet, file, identity("sess-aaaa", "alpha"), "takeover", now);
    assert.deepEqual(result, { ok: true });
    const after = JSON.parse(await readFile(lockFile, "utf8"));
    assert.equal(after.ownerSessionId, "sess-aaaa");
    assert.equal(after.reason, "takeover");
    await assert.rejects(() => readFile(`${lockFile}.steal`, "utf8")); // guard cleaned up
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("empty lock file: fresh = in-progress deny, old = orphaned steal", async () => {
  const tmp = await makeTmp();
  try {
    const rootFleet = core.fleetRoot(tmp);
    const file = join(tmp, "src.ts");
    const lockFile = core.lockFilePath(rootFleet, file);
    await mkdir(core.locksDir(rootFleet), { recursive: true });
    await writeFile(lockFile, "");

    const fresh = await core.acquireLock(rootFleet, file, identity("sess-aaaa", "alpha"), undefined, Date.now());
    assert.equal(fresh.ok, false);
    assert.match(fresh.message, /in progress/);

    const old = new Date(Date.now() - core.LOCK_EMPTY_GRACE_MS - 2000);
    await utimes(lockFile, old, old);
    const stolen = await core.acquireLock(rootFleet, file, identity("sess-aaaa", "alpha"), undefined, Date.now());
    assert.deepEqual(stolen, { ok: true });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("a foreign .steal guard blocks theft (lost steal race)", async () => {
  const tmp = await makeTmp();
  try {
    const rootFleet = core.fleetRoot(tmp);
    const file = join(tmp, "src.ts");
    const lockFile = core.lockFilePath(rootFleet, file);
    await mkdir(core.locksDir(rootFleet), { recursive: true });
    await writeFile(lockFile, "");
    const old = new Date(Date.now() - core.LOCK_EMPTY_GRACE_MS - 2000);
    await utimes(lockFile, old, old);
    await writeFile(`${lockFile}.steal`, "someone-else-stealing");

    const result = await core.acquireLock(rootFleet, file, identity("sess-aaaa", "alpha"), undefined, Date.now());
    assert.equal(result.ok, false);
    assert.equal(await readFile(lockFile, "utf8"), "", "orphaned lock left for the other stealer");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("release all removes only owned locks", async () => {
  const tmp = await makeTmp();
  try {
    const rootFleet = core.fleetRoot(tmp);
    const f1 = join(tmp, "a.ts");
    const f2 = join(tmp, "b.ts");
    await core.acquireLock(rootFleet, f1, identity("sess-aaaa", "alpha"));
    await core.acquireLock(rootFleet, f2, identity("sess-bbbb", "beta"));
    const released = await core.releaseAllLocks(rootFleet, identity("sess-aaaa", "alpha"));
    assert.equal(released.length, 1);
    assert.equal(released[0].path, resolve(f1));
    const states = await core.listLocks(rootFleet, Date.now());
    assert.equal(states.length, 1);
    assert.equal(states[0].state.kind, "held");
    assert.equal(states[0].state.lock.ownerSessionId, "sess-bbbb");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("truncated garbage lock follows mtime grace rule instead of throwing", async () => {
  const tmp = await makeTmp();
  try {
    const rootFleet = core.fleetRoot(tmp);
    const file = join(tmp, "src.ts");
    const lockFile = core.lockFilePath(rootFleet, file);
    await mkdir(core.locksDir(rootFleet), { recursive: true });
    await writeFile(lockFile, '{"absPath": "/trun'); // crash mid-write
    const fresh = await core.readLockState(rootFleet, file, Date.now());
    assert.equal(fresh.kind, "in-progress");
    const oldTime = new Date(Date.now() - core.LOCK_EMPTY_GRACE_MS - 1000);
    await utimes(lockFile, oldTime, oldTime);
    const old = await core.readLockState(rootFleet, file, Date.now());
    assert.equal(old.kind, "orphaned");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// --- session registry ---

test("listSessions registers, keeps live, and prunes dead sessions", async () => {
  const tmp = await makeTmp();
  try {
    const rootFleet = core.fleetRoot(tmp);
    await core.registerSession(rootFleet, identity("sess-aaaa", "alpha"));
    const sessions = await core.listSessions(rootFleet);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].info.sessionId, "sess-aaaa");

    const deadFile = join(core.sessionsDir(rootFleet), "sess-dead.json");
    await writeFile(
      deadFile,
      JSON.stringify({ sessionId: "sess-dead", sessionName: "ghost", pid: DEAD_PID, cwd: tmp, startedAt: 0, lastSeenAt: 0 }),
    );
    const afterPrune = await core.listSessions(rootFleet);
    assert.deepEqual(afterPrune.map((s) => s.info.sessionId), ["sess-aaaa"]);
    await assert.rejects(() => readFile(deadFile, "utf8"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// --- addressing ---

test("resolveRecipient: by id, by name, owner-of, and error paths", async () => {
  const tmp = await makeTmp();
  try {
    const rootFleet = core.fleetRoot(tmp);
    const me = identity("sess-aaaa", "alpha");
    const peer = identity("sess-bbbb", "beta");
    await core.registerSession(rootFleet, me);
    await core.registerSession(rootFleet, peer);
    const file = join(tmp, "owned.ts");
    await core.acquireLock(rootFleet, file, peer, "peer task");

    const byId = await core.resolveRecipient(rootFleet, "sess-bbbb", me);
    assert.deepEqual(byId, { sessionId: "sess-bbbb", label: "beta" });
    const byName = await core.resolveRecipient(rootFleet, "beta", me);
    assert.deepEqual(byName, { sessionId: "sess-bbbb", label: "beta" });
    const byOwner = await core.resolveRecipient(rootFleet, `owner-of:${file}`, me);
    assert.deepEqual(byOwner, { sessionId: "sess-bbbb", label: "beta" });

    const unclaimed = await core.resolveRecipient(rootFleet, `owner-of:${join(tmp, "nothing.ts")}`, me);
    assert.match(unclaimed.error, /no lock owner/);
    const selfName = await core.resolveRecipient(rootFleet, "alpha", me);
    assert.match(selfName.error, /this session/);
    const unknown = await core.resolveRecipient(rootFleet, "gamma", me);
    assert.match(unknown.error, /no live session/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// --- mailbox ---

test("envelope send -> peek -> ack-delete -> drain", async () => {
  const tmp = await makeTmp();
  try {
    const rootFleet = core.fleetRoot(tmp);
    const me = identity("sess-aaaa", "alpha");
    const peer = identity("sess-bbbb", "beta");
    const envelope = core.makeEnvelope(me, "sess-bbbb", "bug in auth", "login crashes on empty email", [join(tmp, "auth.ts")]);
    await core.sendEnvelope(rootFleet, "sess-bbbb", envelope);

    const peeked = await core.peekInbox(rootFleet, "sess-bbbb");
    assert.equal(peeked.length, 1);
    assert.equal(peeked[0].envelope.subject, "bug in auth");
    assert.match(core.formatEnvelope(envelope), /\[pi-fleet\] From "alpha"/);
    assert.match(core.formatEnvelope(envelope), /auth\.ts/);

    await core.deleteEnvelope(peeked[0].file);
    assert.equal((await core.peekInbox(rootFleet, "sess-bbbb")).length, 0);

    await core.sendEnvelope(rootFleet, "sess-bbbb", envelope);
    const drained = await core.drainInbox(rootFleet, "sess-bbbb");
    assert.equal(drained.length, 1);
    assert.equal((await core.peekInbox(rootFleet, "sess-bbbb")).length, 0, "drain consumes");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// --- bash warn-only scanner ---

test("scanBashWrites flags write shapes, ignores reads", () => {
  for (const command of [
    "sed -i 's/a/b/' file",
    "perl -pi -e 's/a/b/' file",
    "echo x | tee file",
    "dd if=a of=b",
    "git restore -- file",
    "git checkout -- file",
    "echo hi > file",
    "echo hi >> file",
    "patch -p1 < fix.diff",
    "rm -rf build",
    "mv a b",
  ]) {
    assert.ok(core.scanBashWrites(command).length > 0, `should flag: ${command}`);
  }
  for (const command of ["ls -la", "cat file", "grep -rn foo src", "echo a < b", "git status", "git log --oneline"]) {
    assert.equal(core.scanBashWrites(command).length, 0, `should not flag: ${command}`);
  }
});

test("commandMentionsPath matches stem, skips generic short stems", () => {
  assert.equal(core.commandMentionsPath("sed -i s/a/b/ src/auth/service.ts", "/repo/src/auth/service.ts"), true);
  assert.equal(core.commandMentionsPath("cat README.md", "/repo/src/auth/service.ts"), false);
  assert.equal(core.commandMentionsPath("grep x x.ts", "/repo/src/x.ts"), false, "stem 'x' too generic to warn without noise");
  assert.equal(core.commandMentionsPath("rm file+1.ts", "/repo/weird/file+1.ts"), true, "regex chars escaped");
});

// --- extension wiring (mock pi) ---

function mockPi() {
  const handlers = {};
  const tools = {};
  const commands = {};
  const sent = [];
  const pi = {
    on(type, fn) {
      handlers[type] = fn;
    },
    registerTool(def) {
      tools[def.name] = def;
    },
    registerCommand(name, def) {
      commands[name] = def;
    },
    sendMessage: async (message, options) => {
      sent.push({ message, options });
    },
  };
  return { pi, handlers, tools, commands, sent };
}

function mockCtx(cwd, overrides = {}) {
  return {
    cwd,
    hasUI: false,
    ui: { notify: () => {} },
    sessionManager: {
      getSessionId: () => "sess-aaaa",
      getSessionName: () => "alpha",
      getSessionFile: () => undefined,
    },
    ...overrides,
  };
}

async function startSession(pi, handlers, cwd) {
  await handlers.session_start({ type: "session_start", reason: "startup" }, mockCtx(cwd));
}

async function stopSession(handlers, cwd) {
  await handlers.session_shutdown({ type: "session_shutdown", reason: "quit" }, mockCtx(cwd));
}

async function callTool(tools, name, params, cwd) {
  return tools[name].execute("id", params, undefined, undefined, mockCtx(cwd));
}

test("wiring: auto-lock claims on first write, foreign write is denied with fleet_send hint", async () => {
  const tmp = await makeTmp();
  const { pi, handlers, tools } = mockPi();
  try {
    loadFleet(pi);
    await startSession(pi, handlers, tmp);

    const target = join(tmp, "claimed.ts");
    const allowed = await handlers.tool_call({ type: "tool_call", toolName: "write", input: { path: target, content: "x" } }, mockCtx(tmp));
    assert.equal(allowed, undefined, "own auto-claim passes");
    const lockFile = core.lockFilePath(core.fleetRoot(tmp), target);
    const lock = JSON.parse(await readFile(lockFile, "utf8"));
    assert.equal(lock.ownerSessionId, "sess-aaaa");

    // peer session takes over the registry view: B acquires a different file, then hits ours
    const peer = identity("sess-bbbb", "beta");
    const foreign = await core.acquireLock(core.fleetRoot(tmp), target, peer, "peer work", Date.now());
    assert.equal(foreign.ok, false, "O_EXCL registry denies peer at the core level too");

    // simulate the gate seeing a foreign-held lock (release ours, lock as peer, retry gate)
    await core.releaseLock(core.fleetRoot(tmp), target, identity("sess-aaaa", "alpha"));
    await core.acquireLock(core.fleetRoot(tmp), target, peer, "peer work", Date.now());
    const blocked = await handlers.tool_call({ type: "tool_call", toolName: "edit", input: { path: "claimed.ts", edits: [] } }, mockCtx(tmp));
    assert.deepEqual({ ...blocked, reason: undefined }, { block: true, reason: undefined });
    assert.match(blocked.reason, /WRITE DENIED/);
    assert.match(blocked.reason, /fleet_send/);
    assert.match(blocked.reason, /owner-of:/);

    await stopSession(handlers, tmp);
    const afterShutdown = JSON.parse(await readFile(lockFile, "utf8"));
    assert.equal(afterShutdown.ownerSessionId, "sess-bbbb", "shutdown releases only OWN locks, never foreign ones");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("wiring: session receives and delivers mailbox mail on start", async () => {
  const tmp = await makeTmp();
  const { pi, handlers, sent } = mockPi();
  try {
    const rootFleet = core.fleetRoot(tmp);
    // mail arrives before the session starts
    const peer = identity("sess-bbbb", "beta");
    await core.registerSession(rootFleet, peer);
    await core.sendEnvelope(
      rootFleet,
      "sess-aaaa",
      core.makeEnvelope(peer, "sess-aaaa", "found a bug", "fix in your area please"),
    );

    loadFleet(pi);
    await startSession(pi, handlers, tmp);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].message.customType, "fleet-message");
    assert.match(sent[0].message.content, /\[pi-fleet\] From "beta"/);
    assert.match(sent[0].message.content, /found a bug/);
    assert.deepEqual(sent[0].options, { deliverAs: "steer", triggerTurn: true });
    assert.equal((await core.peekInbox(rootFleet, "sess-aaaa")).length, 0, "delivered mail is acked");
    await stopSession(handlers, tmp);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("wiring: fleet tools — claim busy, release only own, team lists, send errors gracefully", async () => {
  const tmp = await makeTmp();
  const { pi, handlers, tools } = mockPi();
  try {
    const rootFleet = core.fleetRoot(tmp);
    loadFleet(pi);
    await startSession(pi, handlers, tmp);

    const peer = identity("sess-bbbb", "beta");
    await core.registerSession(rootFleet, peer);
    const peerFile = join(tmp, "peer-file.ts");
    await core.acquireLock(rootFleet, peerFile, peer, "peer task");

    const claim = await callTool(tools, "fleet_claim", { paths: ["peer-file.ts", "mine.ts"], reason: "test" }, tmp);
    assert.match(claim.content[0].text, /BUSY peer-file\.ts/);
    assert.match(claim.content[0].text, /CLAIMED mine\.ts/);
    assert.match(claim.content[0].text, /fleet_send/);

    const release = await callTool(tools, "fleet_release", { paths: ["peer-file.ts"], all: true }, tmp);
    assert.match(release.content[0].text, /NOT YOURS peer-file\.ts/);

    const team = await callTool(tools, "fleet_team", {}, tmp);
    assert.match(team.content[0].text, /"beta"/);
    assert.match(team.content[0].text, /peer-file\.ts/);

    const badSend = await callTool(tools, "fleet_send", { to: "ghost", subject: "s", body: "b" }, tmp);
    assert.match(badSend.content[0].text, /NOT DELIVERED/);
    assert.equal(badSend.details.delivered, false);

    const goodSend = await callTool(tools, "fleet_send", { to: "beta", subject: "bug", body: "fix pls", filePaths: ["peer-file.ts"] }, tmp);
    assert.equal(goodSend.details.delivered, true);
    assert.equal((await core.peekInbox(rootFleet, "sess-bbbb")).length, 1);

    await stopSession(handlers, tmp);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("wiring: fleet_claim is invisible by default and debug restores call/result without changing tool output", async () => {
  const tmp = await makeTmp();
  const { pi, handlers, tools, commands } = mockPi();
  const notices = [];
  const ctx = mockCtx(tmp, { hasUI: true, ui: { notify: (message) => notices.push(message) } });
  try {
    loadFleet(pi);
    await startSession(pi, handlers, tmp);
    const claimTool = tools.fleet_claim;
    const args = { paths: ["mine.ts"] };
    const result = await claimTool.execute("id", args, undefined, undefined, mockCtx(tmp));
    assert.match(result.content[0].text, /CLAIMED mine\.ts/);
    assert.deepEqual(claimTool.renderCall(args).render(80), []);
    assert.deepEqual(claimTool.renderResult(result).render(80), []);

    await commands.fleet.handler("debug on", ctx);
    assert.match(claimTool.renderCall(args).render(80).join("\n"), /fleet_claim.*mine\.ts/);
    assert.match(claimTool.renderResult(result).render(80).join("\n"), /CLAIMED mine\.ts/);
    assert.match(notices.at(-1), /display is ON/);

    await commands.fleet.handler("debug off", ctx);
    assert.deepEqual(claimTool.renderCall(args).render(80), []);
    assert.deepEqual(claimTool.renderResult(result).render(80), []);
    await commands.fleet.handler("debug nope", ctx);
    assert.match(notices.at(-1), /usage: \/fleet debug on\|off/);
    await stopSession(handlers, tmp);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("wiring: bash gate never blocks, only warns via UI when present", async () => {
  const tmp = await makeTmp();
  const { pi, handlers, tools } = mockPi();
  try {
    loadFleet(pi);
    await startSession(pi, handlers, tmp);

    const peer = identity("sess-bbbb", "beta");
    await core.registerSession(core.fleetRoot(tmp), peer);
    const peerFile = join(tmp, "service.ts");
    await core.acquireLock(core.fleetRoot(tmp), peerFile, peer, "peer task");

    const notifications = [];
    const ctxWithUi = { ...mockCtx(tmp), hasUI: true, ui: { notify: (m) => notifications.push(m) } };
    const result = await handlers.tool_call(
      { type: "tool_call", toolName: "bash", input: { command: `sed -i 's/a/b/' ${peerFile}` } },
      ctxWithUi,
    );
    assert.equal(result, undefined, "bash is never blocked in v1");
    assert.equal(notifications.length, 1);
    assert.match(notifications[0], /locked by peers/);

    const quiet = await handlers.tool_call(
      { type: "tool_call", toolName: "bash", input: { command: "sed -i 's/a/b/' unrelated-file.ts" } },
      ctxWithUi,
    );
    assert.equal(quiet, undefined);
    assert.equal(notifications.length, 1, "no warning without a locked-path mention");

    await stopSession(handlers, tmp);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("wiring: /fleet auto off allows writes to unclaimed files without claiming them", async () => {
  const tmp = await makeTmp();
  const { pi, handlers, commands } = mockPi();
  try {
    loadFleet(pi);
    await startSession(pi, handlers, tmp);

    commands.fleet.handler("auto off", mockCtx(tmp));

    const target = join(tmp, "unclaimed.ts");
    const allowed = await handlers.tool_call({ type: "tool_call", toolName: "write", input: { path: target, content: "x" } }, mockCtx(tmp));
    assert.equal(allowed, undefined);
    const lockFile = core.lockFilePath(core.fleetRoot(tmp), target);
    await assert.rejects(() => readFile(lockFile, "utf8"), "no lock created while auto is off");

    // a foreign LIVE lock still denies even with auto off
    const peer = identity("sess-bbbb", "beta");
    await core.registerSession(core.fleetRoot(tmp), peer);
    const peerFile = join(tmp, "peer.ts");
    await core.acquireLock(core.fleetRoot(tmp), peerFile, peer, "peer task");
    const blocked = await handlers.tool_call({ type: "tool_call", toolName: "write", input: { path: peerFile, content: "x" } }, mockCtx(tmp));
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /fleet_send/);

    await stopSession(handlers, tmp);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// --- review-driven regressions (pi-fleet-review.md: P1-1, P1-2, P2-1/4, test gaps) ---

test("acquire EEXIST fallback: lock appearing between read and wx is reported, not lost", async () => {
  const tmp = await makeTmp();
  try {
    const rootFleet = core.fleetRoot(tmp);
    const file = join(tmp, "raced.ts");
    await mkdir(core.locksDir(rootFleet), { recursive: true });
    // simulate losing the create race: the winner's content is already on disk
    await writeFile(core.lockFilePath(rootFleet, file), lockJson("sess-bbbb", "beta", ALIVE_PID, 0, Date.now()));
    const result = await core.acquireLock(rootFleet, file, identity("sess-aaaa", "alpha"), undefined, Date.now());
    assert.equal(result.ok, false);
    assert.match(result.message, /beta/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("owner-of resolution refuses stale, orphaned, and dead-owner locks (P1-2)", async () => {
  const tmp = await makeTmp();
  try {
    const rootFleet = core.fleetRoot(tmp);
    const me = identity("sess-aaaa", "alpha");
    const file = join(tmp, "orphaned-owner.ts");
    const lockFile = core.lockFilePath(rootFleet, file);
    await mkdir(core.locksDir(rootFleet), { recursive: true });

    // stale lock: dead pid + cold heartbeat -> claim it, do not message
    const now = Date.now();
    await writeFile(lockFile, lockJson("sess-bbbb", "beta", DEAD_PID, core.LOCK_STALE_MS + 5000, now));
    const stale = await core.resolveRecipient(rootFleet, `owner-of:${file}`, me, now);
    assert.match(stale.error, /stale/);
    assert.match(stale.error, /fleet_claim/);

    // orphaned lock: empty + old mtime -> claim it
    await writeFile(lockFile, "");
    const oldTime = new Date(now - core.LOCK_EMPTY_GRACE_MS - 1000);
    await utimes(lockFile, oldTime, oldTime);
    const orphaned = await core.resolveRecipient(rootFleet, `owner-of:${file}`, me, now);
    assert.match(orphaned.error, /orphaned/);

    // fresh lock but no live session row (crashed inside grace window) -> steal path
    await writeFile(lockFile, lockJson("sess-cccc", "gamma", DEAD_PID, 1000, now));
    const deadOwner = await core.resolveRecipient(rootFleet, `owner-of:${file}`, me, now);
    assert.match(deadOwner.error, /no live session|steal/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("ambiguous session names resolve to an error pointing at ids", async () => {
  const tmp = await makeTmp();
  try {
    const rootFleet = core.fleetRoot(tmp);
    const me = identity("sess-aaaa", "alpha");
    await core.registerSession(rootFleet, me);
    await core.registerSession(rootFleet, identity("sess-bbbb", "beta"));
    await core.registerSession(rootFleet, identity("sess-cccc", "beta"));
    const result = await core.resolveRecipient(rootFleet, "beta", me);
    assert.match(result.error, /ambiguous/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("touchAllLocks refreshes heartbeats on disk for owned locks only", async () => {
  const tmp = await makeTmp();
  try {
    const rootFleet = core.fleetRoot(tmp);
    const mine = join(tmp, "mine.ts");
    const theirs = join(tmp, "theirs.ts");
    const me = identity("sess-aaaa", "alpha");
    await core.acquireLock(rootFleet, mine, me, undefined, Date.now() - 40_000);
    await core.acquireLock(rootFleet, theirs, identity("sess-bbbb", "beta"), undefined, Date.now() - 40_000);
    const beforeMine = JSON.parse(await readFile(core.lockFilePath(rootFleet, mine), "utf8")).lastHeartbeatAt;
    await core.touchAllLocks(rootFleet, me, Date.now());
    const afterMine = JSON.parse(await readFile(core.lockFilePath(rootFleet, mine), "utf8")).lastHeartbeatAt;
    const afterTheirs = JSON.parse(await readFile(core.lockFilePath(rootFleet, theirs), "utf8")).lastHeartbeatAt;
    assert.ok(afterMine > beforeMine, "owned lock heartbeat refreshed");
    assert.equal(afterTheirs, JSON.parse(await readFile(core.lockFilePath(rootFleet, theirs), "utf8")).lastHeartbeatAt);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("fresh .steal guard blocks theft; stale guard is recovered (P2-4)", async () => {
  const tmp = await makeTmp();
  try {
    const rootFleet = core.fleetRoot(tmp);
    const file = join(tmp, "guarded.ts");
    const lockFile = core.lockFilePath(rootFleet, file);
    await mkdir(core.locksDir(rootFleet), { recursive: true });
    await writeFile(lockFile, "");
    const oldTime = new Date(Date.now() - core.LOCK_EMPTY_GRACE_MS - 1000);
    await utimes(lockFile, oldTime, oldTime);
    await writeFile(`${lockFile}.steal`, "mid-steal");

    const freshGuard = await core.acquireLock(rootFleet, file, identity("sess-aaaa", "alpha"), undefined, Date.now());
    assert.equal(freshGuard.ok, false, "fresh guard means another stealer is active");

    const guardOld = new Date(Date.now() - core.STEAL_GUARD_GRACE_MS - 1000);
    await utimes(`${lockFile}.steal`, guardOld, guardOld);
    const recovered = await core.acquireLock(rootFleet, file, identity("sess-aaaa", "alpha"), undefined, Date.now());
    assert.deepEqual(recovered, { ok: true }, "abandoned guard is recovered and steal proceeds");
    await assert.rejects(() => readFile(`${lockFile}.steal`, "utf8"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("deliverPending: send failure keeps mail on disk, success acks it (no-loss ordering)", async () => {
  const tmp = await makeTmp();
  const { pi, handlers, commands, sent } = mockPi();
  try {
    const rootFleet = core.fleetRoot(tmp);
    const peer = identity("sess-bbbb", "beta");
    await core.registerSession(rootFleet, peer);
    const envelope = core.makeEnvelope(peer, "sess-aaaa", "subject", "body");
    await core.sendEnvelope(rootFleet, "sess-aaaa", envelope);

    pi.sendMessage = async (message, options) => {
      if (failing) throw new Error("session busy");
      return sent.push({ message, options });
    };

    let failing = true;
    const api = loadFleet(pi); // extension returns { deliverPendingNow } test seam
    await startSession(pi, handlers, tmp);
    await api.deliverPendingNow();
    assert.equal((await core.peekInbox(rootFleet, "sess-aaaa")).length, 1, "mail survives delivery failure");

    failing = false;
    await api.deliverPendingNow();
    assert.equal(sent.length, 1, "redelivered on the next attempt");
    assert.equal((await core.peekInbox(rootFleet, "sess-aaaa")).length, 0, "acked after success");
    await stopSession(handlers, tmp);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("wiring: session_shutdown removes the session row", async () => {
  const tmp = await makeTmp();
  const { pi, handlers } = mockPi();
  try {
    loadFleet(pi);
    await startSession(pi, handlers, tmp);
    const rootFleet = core.fleetRoot(tmp);
    assert.equal((await core.listSessions(rootFleet)).length, 1);
    await stopSession(handlers, tmp);
    assert.equal((await core.listSessions(rootFleet)).length, 0);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("ensureFleetIgnored resolves linked worktrees (.git is a file, P1-1)", async () => {
  const tmp = await makeTmp();
  const gitdir = join(tmp, "super", "modules", "repo");
  try {
    await mkdir(gitdir, { recursive: true });
    await writeFile(join(tmp, ".git"), `gitdir: ${gitdir}\n`);
    const ok = await core.ensureFleetIgnored(tmp);
    assert.equal(ok, true);
    const exclude = await readFile(join(gitdir, "info", "exclude"), "utf8");
    assert.match(exclude, /^\.pi\/fleet\/$/m);
    // second call is a success (already ensured), not a failure and not a duplicate line
    assert.equal(await core.ensureFleetIgnored(tmp), true);
    const again = await readFile(join(gitdir, "info", "exclude"), "utf8");
    assert.equal(again.split("\n").filter((l) => l === ".pi/fleet/").length, 1);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("ensureFleetIgnored returns false outside a repo without throwing", async () => {
  const tmp = await makeTmp();
  try {
    assert.equal(await core.ensureFleetIgnored(tmp), false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("ensureFleetIgnored reports success when the entry already exists", async () => {
  const tmp = await makeTmp();
  try {
    await mkdir(join(tmp, ".git", "info"), { recursive: true });
    await writeFile(join(tmp, ".git", "info", "exclude"), "# existing\n.pi/fleet/\n");
    assert.equal(await core.ensureFleetIgnored(tmp), true);
    const exclude = await readFile(join(tmp, ".git", "info", "exclude"), "utf8");
    assert.equal(exclude.split("\n").filter((l) => l.trim() === ".pi/fleet/").length, 1, "no duplicate appended");
    assert.match(exclude, /# existing/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
