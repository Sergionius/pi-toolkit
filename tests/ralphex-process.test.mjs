import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const jiti = createJiti(import.meta.url);
const { runCommand } = await jiti.import(resolve(root, "extensions/ralphex/process.ts"));

test("runCommand handles commands that close stdin immediately", async () => {
  const options = { command: process.execPath, args: ["-e", "process.exit(0)"], cwd: root };
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal((await runCommand(options)).code, 0);
  }
  assert.equal((await runCommand({ ...options, stdin: "x".repeat(1024 * 1024) })).code, 0);
});
