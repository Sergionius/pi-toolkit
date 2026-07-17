import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const jiti = createJiti(import.meta.url);
const authModule = await jiti.import(join(root, "extensions", "lib", "codex-auth.ts"));

function credential(accountId, marker, expires = Date.now() + 3_600_000) {
  return {
    type: "oauth",
    access: `fixture-access-${marker}`,
    refresh: `fixture-refresh-${marker}`,
    expires,
    accountId,
  };
}

async function writeAuth(paths, codexCredential, extra = { type: "api_key", key: "fixture-other-provider" }) {
  await writeFile(paths.authPath, `${JSON.stringify({ anthropic: extra, "openai-codex": codexCredential }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(paths.authPath, 0o600);
}

test("Codex profiles save, sync refreshed credentials, switch safely, and roll back", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-toolkit-codex-"));
  const paths = authModule.getCodexAccountPaths(temporary);
  try {
    await authModule.ensurePrivateAgentDir(paths);
    const primary = credential("account-primary", "primary");
    const secondary = credential("account-secondary", "secondary");
    await writeAuth(paths, primary);
    await authModule.saveCurrentCodexProfile("primary", paths);
    await writeAuth(paths, secondary);
    await authModule.saveCurrentCodexProfile("secondary", paths);

    assert.equal((await stat(paths.agentDir)).mode & 0o777, 0o700);
    assert.equal((await stat(paths.vaultPath)).mode & 0o777, 0o600);

    let vault = await authModule.readCodexAccountsVault(paths);
    assert.equal(Object.keys(vault.profiles).length, 2);
    assert.equal(vault.activeProfile, "secondary");
    assert.equal(authModule.findCurrentProfile(vault, secondary), "secondary");

    const refreshedSecondary = { ...secondary, access: "fixture-access-secondary-refreshed", expires: secondary.expires + 60_000 };
    await writeAuth(paths, refreshedSecondary);
    const switched = await authModule.switchCodexProfile("primary", { paths });
    assert.deepEqual(switched, { changed: true, profile: "primary" });

    const authAfterSwitch = JSON.parse(await readFile(paths.authPath, "utf8"));
    assert.deepEqual(authAfterSwitch["openai-codex"], primary);
    assert.deepEqual(authAfterSwitch.anthropic, { type: "api_key", key: "fixture-other-provider" });
    assert.equal((await stat(paths.authPath)).mode & 0o777, 0o600);
    assert.equal((await stat(paths.backupPath)).mode & 0o777, 0o600);

    vault = await authModule.readCodexAccountsVault(paths);
    assert.equal(vault.profiles.secondary.credential.access, "fixture-access-secondary-refreshed");
    assert.equal(vault.activeProfile, "primary");

    const noOp = await authModule.switchCodexProfile("primary", { paths });
    assert.deepEqual(noOp, { changed: false, profile: "primary" });

    await assert.rejects(
      authModule.switchCodexProfile("secondary", {
        paths,
        afterAuthWrite: () => { throw new Error("fixture post-write failure"); },
      }),
      /auth\.json restored/,
    );
    const authAfterRollback = JSON.parse(await readFile(paths.authPath, "utf8"));
    assert.deepEqual(authAfterRollback["openai-codex"], primary);

    const mismatched = credential("account-untracked", "untracked");
    await writeAuth(paths, mismatched);
    assert.equal(await authModule.syncActiveCodexProfile(paths), false);
    vault = await authModule.readCodexAccountsVault(paths);
    assert.deepEqual(vault.profiles.primary.credential, primary);

    const summary = await authModule.getCodexAccountsSummary(paths);
    assert.equal(summary.count, 2);
    assert.equal(summary.currentProfile, undefined);
    const summaryText = JSON.stringify(summary);
    assert.doesNotMatch(summaryText, /fixture-access|fixture-refresh/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("invalid names and corrupted vaults are rejected", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-toolkit-codex-invalid-"));
  const paths = authModule.getCodexAccountPaths(temporary);
  try {
    assert.throws(() => authModule.validateProfileName("bad profile"), /letters, digits/);
    await authModule.ensurePrivateAgentDir(paths);
    await writeFile(paths.vaultPath, "{broken", { encoding: "utf8", mode: 0o600 });
    await assert.rejects(authModule.readCodexAccountsVault(paths), /invalid JSON/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("account commands redact tokens and removal requires confirmation", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-toolkit-codex-commands-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = temporary;
  const paths = authModule.getCodexAccountPaths(temporary);
  try {
    await authModule.ensurePrivateAgentDir(paths);
    await writeAuth(paths, credential("account-command", "command-secret"));
    await authModule.saveCurrentCodexProfile("primary", paths);

    const commands = new Map();
    const imported = await jiti.import(join(root, "extensions", "codex-accounts.ts"));
    imported.default({
      registerCommand(name, definition) { commands.set(name, definition); },
      on() {},
    });

    const notifications = [];
    const context = {
      ui: {
        notify(message, level) { notifications.push({ message, level }); },
        confirm: async () => false,
      },
    };
    await commands.get("codex-account-list").handler("", context);
    const output = notifications.map(({ message }) => message).join("\n");
    assert.match(output, /primary/);
    assert.doesNotMatch(output, /fixture-access|fixture-refresh|command-secret/);

    await commands.get("codex-account-remove").handler("primary", context);
    assert.ok((await authModule.readCodexAccountsVault(paths)).profiles.primary, "cancelled removal must keep profile");

    context.ui.confirm = async () => true;
    await commands.get("codex-account-remove").handler("primary", context);
    assert.equal((await authModule.readCodexAccountsVault(paths)).profiles.primary, undefined);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(temporary, { recursive: true, force: true });
  }
});

test("switch command waits, confirms, and requests shutdown after changing account", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-toolkit-codex-switch-command-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = temporary;
  const paths = authModule.getCodexAccountPaths(temporary);
  try {
    await authModule.ensurePrivateAgentDir(paths);
    await writeAuth(paths, credential("account-primary", "switch-primary"));
    await authModule.saveCurrentCodexProfile("primary", paths);
    await writeAuth(paths, credential("account-secondary", "switch-secondary"));
    await authModule.saveCurrentCodexProfile("secondary", paths);

    const commands = new Map();
    const imported = await jiti.import(join(root, "extensions", "codex-accounts.ts"));
    imported.default({
      registerCommand(name, definition) { commands.set(name, definition); },
      on() {},
    });

    let waited = false;
    let confirmed = false;
    let shutdown = false;
    const notifications = [];
    await commands.get("codex-account-switch").handler("primary", {
      waitForIdle: async () => { waited = true; },
      shutdown: () => { shutdown = true; },
      ui: {
        confirm: async () => { confirmed = true; return true; },
        select: async () => undefined,
        notify: (message, level) => notifications.push({ message, level }),
      },
    });

    assert.equal(waited, true);
    assert.equal(confirmed, true);
    assert.equal(shutdown, true);
    assert.match(notifications.at(-1).message, /switched to 'primary'/);
    assert.equal((await authModule.readCurrentCodexCredential(paths)).accountId, "account-primary");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(temporary, { recursive: true, force: true });
  }
});

test("removing a profile leaves auth.json unchanged", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-toolkit-codex-remove-"));
  const paths = authModule.getCodexAccountPaths(temporary);
  try {
    await authModule.ensurePrivateAgentDir(paths);
    const primary = credential("account-primary", "remove");
    await writeAuth(paths, primary);
    await authModule.saveCurrentCodexProfile("primary", paths);
    const before = await readFile(paths.authPath, "utf8");
    assert.equal(await authModule.removeCodexProfile("primary", paths), true);
    assert.equal(await readFile(paths.authPath, "utf8"), before);
    assert.equal((await authModule.readCodexAccountsVault(paths)).activeProfile, undefined);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
