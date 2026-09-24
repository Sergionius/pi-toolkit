import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(import.meta.url);

test("VS Code bridge dispatches the Dart-Code reload and Flutter restart commands", async () => {
  const source = await readFile(resolve(root, "vscode/pi-flutter-refresh-bridge/extension.js"), "utf8");
  const commands = [];
  const module = { exports: {} };
  vm.runInNewContext(`${source}\nmodule.exports.executeDartCommandForTest = executeDartCommand;`, {
    module,
    require(name) {
      if (name === "vscode") return { commands: { executeCommand: async (id) => { commands.push(id); } } };
      return require(name);
    },
  });
  await module.exports.executeDartCommandForTest("reload");
  await module.exports.executeDartCommandForTest("restart");
  assert.deepEqual(commands, ["dart.hotReload", "flutter.hotRestart"]);
});
