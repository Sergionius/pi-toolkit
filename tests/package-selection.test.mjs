import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const jiti = createJiti(import.meta.url);
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const example = JSON.parse(await readFile(join(root, "config/package-selection.example.json"), "utf8"));
const packageConfig = example.packages[0];

async function entryPoints() {
  const topLevel = (await readdir(join(root, "extensions"))).filter((name) => name.endsWith(".ts"))
    .map((name) => `extensions/${name}`);
  const directories = (await readdir(join(root, "extensions"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory());
  const nested = [];
  for (const directory of directories) {
    if ((await readdir(join(root, "extensions", directory.name))).includes("index.ts")) {
      nested.push(`extensions/${directory.name}/index.ts`);
    }
  }
  return [...topLevel, ...nested].sort();
}

async function registrations(paths) {
  const commands = [];
  const tools = [];
  const pi = {
    on() {},
    events: { on() {}, emit() {} },
    registerCommand(name) { commands.push(name); },
    registerTool(tool) { tools.push(tool.name); },
  };
  for (const path of paths) {
    const extension = await jiti.import(join(root, path));
    await extension.default(pi);
  }
  return { commands, tools };
}

test("selection example names real entry points exposed by the package manifest", async () => {
  assert.deepEqual(manifest.pi.extensions, ["./extensions/*.ts", "./extensions/*/index.ts"]);
  assert.equal(example.packages.length, 1);
  assert.equal(packageConfig.source, "git:github.com/Sergionius/pi-toolkit");
  const selected = packageConfig.extensions.map((path) => {
    assert.match(path, /^\+extensions\/[\w/-]+\.ts$/);
    return path.slice(1);
  });
  assert.equal(new Set(selected).size, selected.length);
  assert.deepEqual(selected.sort(), [
    "extensions/backlog-choice.ts",
    "extensions/commit.ts",
    "extensions/later.ts",
  ]);
  const all = await entryPoints();
  assert.deepEqual(all, [
    "extensions/backlog-choice.ts",
    "extensions/codex-accounts.ts",
    "extensions/codex-status.ts",
    "extensions/commit.ts",
    "extensions/figma-context.ts",
    "extensions/flutter-refresh.ts",
    "extensions/later.ts",
    "extensions/orca-ralphex-status.ts",
    "extensions/plan/index.ts",
    "extensions/ralphex/index.ts",
    "extensions/toolkit.ts",
  ]);
  assert.ok(selected.every((path) => all.includes(path)));
});

test("base selection registers only the base commands and backlog tool", async () => {
  const selected = packageConfig.extensions.map((path) => path.slice(1));
  const { commands, tools } = await registrations(selected);
  assert.deepEqual(commands.sort(), ["commit", "later"]);
  assert.deepEqual(tools, ["backlog_choice"]);
});

test("planning selection adds planning commands without other integrations", async () => {
  const selected = [
    ...packageConfig.extensions.map((path) => path.slice(1)),
    "extensions/plan/index.ts",
    "extensions/ralphex/index.ts",
  ];
  const { commands, tools } = await registrations(selected);
  for (const name of ["plan", "ralphex-plan", "ralphex-exec", "ralphex-auto", "ralphex-review", "ralphex-loop"]) {
    assert.equal(commands.filter((command) => command === name).length, 1);
  }
  assert.ok(!commands.includes("codex-status"));
  assert.ok(!commands.includes("pi-toolkit-doctor"));
  assert.ok(!tools.includes("figma_get_screen_context"));
  assert.equal(new Set(commands).size, commands.length);
});
