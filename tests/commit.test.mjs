import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createJiti } from "jiti";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const jiti = createJiti(import.meta.url);
const commitExtension = await jiti.import(join(root, "extensions", "commit.ts"));

async function run(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, { cwd: options.cwd, encoding: "utf8" });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    return {
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message,
      code: typeof error.code === "number" ? error.code : 1,
    };
  }
}

async function git(cwd, ...args) {
  const result = await run("git", args, { cwd });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

test("cleanCommitMessage validates a single Conventional Commit line", () => {
  assert.equal(commitExtension.cleanCommitMessage("feat(core): add commit command\n"), "feat(core): add commit command");
  assert.equal(commitExtension.cleanCommitMessage("```\nfix: handle failure\n```"), "fix: handle failure");
  assert.throws(() => commitExtension.cleanCommitMessage("message without type"), /invalid Conventional Commit/);
  assert.throws(() => commitExtension.cleanCommitMessage("fix: one\nfix: two"), /exactly one/);
});

test("commitAllChanges stages the repository root, commits once, and never pushes", async () => {
  const repository = await mkdtemp(join(tmpdir(), "pi-toolkit-commit-"));
  try {
    await git(repository, "init", "-q");
    await git(repository, "config", "user.name", "Pi Toolkit Test");
    await git(repository, "config", "user.email", "pi-toolkit@example.invalid");
    await writeFile(join(repository, "tracked.txt"), "before\n", "utf8");
    await git(repository, "add", ".");
    await git(repository, "commit", "-qm", "chore: initial commit");

    await writeFile(join(repository, "tracked.txt"), "after\n", "utf8");
    await writeFile(join(repository, "new.txt"), "new\n", "utf8");
    await mkdir(join(repository, "nested"));
    const commands = [];
    const recordingExec = async (command, args, options) => {
      commands.push([command, ...args]);
      return run(command, args, options);
    };
    let suppliedDiff = "";
    const result = await commitExtension.commitAllChanges(
      join(repository, "nested"),
      recordingExec,
      async (diff) => {
        suppliedDiff = diff;
        return "feat(test): commit all changes";
      },
    );

    assert.equal(result.committed, true);
    assert.equal(result.message, "feat(test): commit all changes");
    assert.match(suppliedDiff, /tracked\.txt/);
    assert.match(suppliedDiff, /new\.txt/);
    assert.equal(await git(repository, "status", "--porcelain"), "");
    assert.equal(await git(repository, "log", "-1", "--pretty=%s"), "feat(test): commit all changes");
    assert.equal(commands.some((command) => command.includes("push")), false);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("commitAllChanges skips a clean repository without generating a message", async () => {
  const repository = await mkdtemp(join(tmpdir(), "pi-toolkit-commit-clean-"));
  try {
    await git(repository, "init", "-q");
    await git(repository, "config", "user.name", "Pi Toolkit Test");
    await git(repository, "config", "user.email", "pi-toolkit@example.invalid");
    await writeFile(join(repository, "tracked.txt"), "clean\n", "utf8");
    await git(repository, "add", ".");
    await git(repository, "commit", "-qm", "chore: initial commit");

    const result = await commitExtension.commitAllChanges(repository, run, async () => {
      throw new Error("message generator must not run");
    });
    assert.deepEqual(result, { committed: false, reason: "clean" });
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});
