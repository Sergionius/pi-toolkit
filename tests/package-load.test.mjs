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
  "extensions/codex-status.ts",
  "extensions/figma-context.ts",
  "extensions/flutter-refresh.ts",
  "extensions/goal/index.ts",
  "extensions/notify-sound.ts",
  "extensions/plan/index.ts",
  "extensions/toolkit.ts",
];

function fakePi() {
  const commands = [];
  const tools = [];
  const handlers = [];
  return {
    commands,
    tools,
    handlers,
    api: {
      on(event, handler) { handlers.push({ event, handler }); },
      registerCommand(name) { commands.push(name); },
      registerTool(definition) { tools.push(definition.name); },
      sendUserMessage() {},
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
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

  const expected = ["goal", "plan", "goal-plan", "codex-status", "pi-toolkit-doctor"];
  for (const command of expected) {
    assert.equal(pi.commands.filter((name) => name === command).length, 1, `${command} must be registered once`);
  }
  assert.equal(new Set(pi.commands).size, pi.commands.length, "no duplicate commands are allowed inside pi-toolkit");
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
