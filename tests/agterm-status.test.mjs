import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const jiti = createJiti(import.meta.url);

async function loadExtension({ statusCode = 0 } = {}) {
  const handlers = new Map();
  const commands = new Map();
  const calls = [];
  const imported = await jiti.import(`${root}/extensions/agterm-status.ts`);
  imported.default({
    on(event, handler) { handlers.set(event, handler); },
    registerCommand(name, definition) { commands.set(name, definition); },
    async exec(command, args, options) {
      calls.push({ command, args, options });
      const code = command === "agtermctl" && args[0] === "session" ? statusCode : 0;
      return { stdout: "", stderr: "", code };
    },
  });
  return { handlers, commands, calls, imported };
}

function withAgtermEnvironment(overrides, callback) {
  const names = [
    "AGTERM_SESSION_ID",
    "AGTERM_SOCKET",
    "AGTERM_PANE",
    "AGTERM_PANE_ID",
    "AGTERM_AGENT_STATUS_DISABLED",
    "PI_AGTERM_COMPLETED_MODE",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  Object.assign(process.env, overrides);

  return Promise.resolve(callback()).finally(() => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });
}

test("agterm completion uses a zero-width terminal-native OSC notification", async () => {
  const { imported } = await loadExtension();
  const chunks = [];
  assert.equal(imported.emitCompletionNotification({ isTTY: true, write: (chunk) => chunks.push(chunk) }), true);
  assert.deepEqual(chunks, ["\x1b]9;pi task completed\x07"]);
  assert.equal(imported.emitCompletionNotification({ isTTY: false, write: () => assert.fail() }), false);
});

test("the unseen badge clear gate runs once on input and retries after failure", async () => {
  const { imported } = await loadExtension();
  const results = [false, true];
  let calls = 0;
  const gate = new imported.UnseenClearGate(async () => {
    calls += 1;
    return results.shift();
  });

  await gate.onInput();
  assert.equal(calls, 0);
  gate.arm();
  await gate.onInput();
  await gate.onInput();
  await gate.onInput();
  assert.equal(calls, 2);
});

test("agterm status follows the settled Pi lifecycle and keeps completion sticky", async () => {
  await withAgtermEnvironment({
    AGTERM_SESSION_ID: "session-1",
    AGTERM_SOCKET: "/tmp/agterm.sock",
    AGTERM_PANE: "right",
    AGTERM_PANE_ID: "pane-token",
  }, async () => {
    const { handlers, calls } = await loadExtension();
    assert.deepEqual([...handlers.keys()], ["session_start", "agent_start", "agent_settled"]);

    await handlers.get("agent_start")();
    await handlers.get("agent_settled")();

    assert.deepEqual(calls, [
      {
        command: "agtermctl",
        args: [
          "session", "status", "active", "--blink", "--target", "session-1",
          "--socket", "/tmp/agterm.sock", "--pane", "right", "--pane-id", "pane-token",
        ],
        options: { timeout: 1_000 },
      },
      {
        command: "agtermctl",
        args: [
          "session", "status", "completed", "--target", "session-1",
          "--socket", "/tmp/agterm.sock", "--pane", "right", "--pane-id", "pane-token",
        ],
        options: { timeout: 1_000 },
      },
    ]);
  });
});

test("auto-reset completion remains available as an opt-in mode", async () => {
  await withAgtermEnvironment({
    AGTERM_SESSION_ID: "session-2",
    PI_AGTERM_COMPLETED_MODE: "auto-reset",
  }, async () => {
    const { handlers, calls } = await loadExtension();
    await handlers.get("agent_settled")();
    assert.deepEqual(calls.map(({ command, args }) => ({ command, args })), [
      {
        command: "agtermctl",
        args: ["session", "status", "completed", "--auto-reset", "--target", "session-2"],
      },
    ]);
  });
});

test("completion notification is skipped when the status update fails", async () => {
  await withAgtermEnvironment({ AGTERM_SESSION_ID: "session-failed" }, async () => {
    const { handlers, calls } = await loadExtension({ statusCode: 1 });
    await handlers.get("agent_settled")();
    assert.deepEqual(calls.map((call) => call.command), ["agtermctl"]);
  });
});

test("agterm status is a no-op outside agterm or when disabled", async () => {
  await withAgtermEnvironment({}, async () => {
    const noSession = await loadExtension();
    await noSession.handlers.get("agent_start")();
    await noSession.handlers.get("agent_settled")();
    assert.equal(noSession.calls.length, 0);
  });

  await withAgtermEnvironment({
    AGTERM_SESSION_ID: "session-3",
    AGTERM_AGENT_STATUS_DISABLED: "1",
  }, async () => {
    const disabled = await loadExtension();
    await disabled.handlers.get("agent_start")();
    await disabled.handlers.get("agent_settled")();
    assert.equal(disabled.calls.length, 0);
  });
});
