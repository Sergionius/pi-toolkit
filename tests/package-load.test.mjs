import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const jiti = createJiti(import.meta.url);
const extensionFiles = [
  "extensions/agterm-status.ts",
  "extensions/codex-accounts.ts",
  "extensions/codex-status.ts",
  "extensions/figma-context.ts",
  "extensions/flutter-refresh.ts",
  "extensions/goal/index.ts",
  "extensions/notify-sound.ts",
  "extensions/plan/index.ts",
  "extensions/provider-switch.ts",
  "extensions/ralphex/index.ts",
  "extensions/toolkit.ts",
];

function fakePi() {
  const commands = [];
  const commandDefinitions = new Map();
  const tools = [];
  const handlers = [];
  const userMessages = [];
  return {
    commands,
    commandDefinitions,
    tools,
    handlers,
    userMessages,
    api: {
      on(event, handler) { handlers.push({ event, handler }); },
      registerCommand(name, definition) {
        commands.push(name);
        commandDefinitions.set(name, definition);
      },
      registerTool(definition) { tools.push(definition.name); },
      sendUserMessage(message, options) { userMessages.push({ message, options }); },
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
      events: { on() {}, emit() {} },
    },
  };
}

function fakeCommandContext(inputAnswer) {
  const notifications = [];
  const inputCalls = [];
  return {
    notifications,
    inputCalls,
    ctx: {
      cwd: "/tmp/ralphex-plan-test",
      sessionManager: { getSessionFile: () => "/tmp/ralphex-plan-test/session.jsonl" },
      waitForIdle: async () => {},
      isIdle: () => true,
      ui: {
        input: async (title, placeholder) => {
          inputCalls.push({ title, placeholder });
          return inputAnswer;
        },
        notify: (message, level) => notifications.push({ message, level }),
      },
    },
  };
}

test("all extension entry points load and register expected commands once", async () => {
  const pi = fakePi();
  for (const relative of extensionFiles) {
    const imported = await jiti.import(join(root, relative));
    const factory = imported.default;
    assert.equal(typeof factory, "function", `${relative} must export a default extension factory`);
    await factory(pi.api);
  }

  const expected = [
    "goal",
    "plan",
    "ralphex-plan",
    "ralphex-exec",
    "ralphex-review",
    "ralphex-loop",
    "goal-plan",
    "codex-status",
    "codex-account-save",
    "codex-account-list",
    "codex-account-current",
    "codex-account-switch",
    "codex-account-remove",
    "provider-switch",
    "pi-toolkit-doctor",
  ];
  for (const command of expected) {
    assert.equal(pi.commands.filter((name) => name === command).length, 1, `${command} must be registered once`);
  }
  assert.equal(new Set(pi.commands).size, pi.commands.length, "no duplicate commands are allowed inside pi-toolkit");
});

test("ralphex-plan starts an isolated planning workflow from command arguments", async () => {
  const pi = fakePi();
  const imported = await jiti.import(join(root, "extensions", "plan", "index.ts"));
  await imported.default(pi.api);

  const { ctx, inputCalls, notifications } = fakeCommandContext();
  const modeChanges = [];
  await imported.startRalphexPlan(pi.api, ctx, "  добавить кеширование API  ", (_ctx, active) => {
    modeChanges.push(active);
  });

  assert.deepEqual(modeChanges, [false], "ralphex-plan must disable conflicting Codex Plan Mode");
  assert.equal(inputCalls.length, 0, "an explicit request must not trigger an extra input dialog");
  assert.equal(pi.userMessages.length, 1);
  const prompt = pi.userMessages[0].message;
  assert.match(prompt, /добавить кеширование API/);
  assert.match(prompt, /Do not launch subagents/);
  assert.match(prompt, /Do not create or modify any file yet/);
  assert.match(prompt, /Only after explicit acceptance/);
  assert.match(prompt, /do not implement the requested feature/i);
  assert.match(prompt, /Do not invent a test framework, mandatory tests, coverage targets/);
  assert.doesNotMatch(prompt, /every task MUST include.*tests/i);
  assert.doesNotMatch(prompt, /launch.*review.*agent/i);
  assert.deepEqual(notifications, [{ message: "Starting /ralphex-plan", level: "info" }]);
});

test("ralphex-plan asks for a request when command arguments are empty", async () => {
  const pi = fakePi();
  const imported = await jiti.import(join(root, "extensions", "plan", "index.ts"));
  const { ctx, inputCalls } = fakeCommandContext("спланировать новый экран профиля");
  const modeChanges = [];

  await imported.startRalphexPlan(pi.api, ctx, "", (_ctx, active) => modeChanges.push(active));

  assert.deepEqual(inputCalls, [
    { title: "Ralphex plan", placeholder: "What should the implementation plan cover?" },
  ]);
  assert.deepEqual(modeChanges, [false]);
  assert.equal(pi.userMessages.length, 1);
  assert.match(pi.userMessages[0].message, /спланировать новый экран профиля/);
});

test("ralphex-plan cancellation leaves Plan Mode untouched and sends no prompt", async () => {
  const pi = fakePi();
  const imported = await jiti.import(join(root, "extensions", "plan", "index.ts"));
  const { ctx, notifications } = fakeCommandContext(undefined);
  const modeChanges = [];

  await imported.startRalphexPlan(pi.api, ctx, "   ", (_ctx, active) => modeChanges.push(active));

  assert.deepEqual(modeChanges, []);
  assert.equal(pi.userMessages.length, 0);
  assert.deepEqual(notifications, [{ message: "Ralphex plan creation cancelled", level: "warning" }]);
});

test("VS Code bridge sync is verified, idempotent, and removes the legacy install", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-toolkit-vscode-"));
  try {
    const legacy = join(temporary, "local.pi-flutter-refresh-bridge-0.1.0");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "legacy.txt"), "legacy", "utf8");

    const imported = await jiti.import(join(root, "extensions", "toolkit.ts"));
    const first = await imported.syncVsCodeBridge({ extensionsDir: temporary });
    const second = await imported.syncVsCodeBridge({ extensionsDir: temporary });

    assert.equal(first.destination, second.destination);
    assert.equal(first.version, "0.2.0");
    assert.equal(first.removedLegacy.length, 1);
    assert.equal(second.removedLegacy.length, 0);

    const manifest = JSON.parse(await readFile(join(second.destination, "package.json"), "utf8"));
    assert.equal(manifest.version, "0.2.0");
    assert.equal(manifest.publisher, "local");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
