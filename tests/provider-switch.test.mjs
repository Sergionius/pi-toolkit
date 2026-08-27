import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const jiti = createJiti(import.meta.url);
const stateModule = await jiti.import(join(root, "extensions", "lib", "provider-switch-state.ts"));

async function writeSettings(paths, value = {}) {
  await writeFile(paths.settingsPath, `${JSON.stringify({ theme: "dark", customSetting: 42, ...value }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(paths.settingsPath, 0o600);
}

function model(provider, id, name = id) {
  return { provider, id, name };
}

function fakeRegistry({ kimiConfigured = true } = {}) {
  const models = [
    model("openai-codex", "gpt-current", "GPT Current"),
    model("kimi-coding", "kimi-for-coding", "Kimi Coding"),
    model("kimi-coding", "k3", "Kimi K3"),
  ];
  return {
    getProvider: (provider) => ["openai-codex", "kimi-coding"].includes(provider) ? { id: provider } : undefined,
    getProviderAuthStatus: (provider) => ({ configured: provider !== "kimi-coding" || kimiConfigured }),
    getAvailable: () => models,
  };
}

async function loadCommand() {
  const commands = new Map();
  const imported = await jiti.import(join(root, "extensions", "provider-switch.ts"));
  imported.default({ registerCommand(name, definition) { commands.set(name, definition); } });
  return commands.get("provider-switch");
}

test("provider state updates settings, remembers both models, and keeps private permissions", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-toolkit-provider-state-"));
  const paths = stateModule.getProviderSwitchPaths(temporary);
  try {
    await writeSettings(paths, { defaultProvider: "openai-codex", defaultModel: "gpt-current" });
    await stateModule.commitProviderSwitch({
      targetProvider: "kimi-coding",
      targetModel: "kimi-for-coding",
      currentProvider: "openai-codex",
      currentModel: "gpt-current",
    }, { paths });

    const settings = JSON.parse(await readFile(paths.settingsPath, "utf8"));
    assert.equal(settings.defaultProvider, "kimi-coding");
    assert.equal(settings.defaultModel, "kimi-for-coding");
    assert.equal(settings.customSetting, 42);

    const state = await stateModule.readProviderSwitchState(paths);
    assert.deepEqual(state.lastModels, {
      "openai-codex": "gpt-current",
      "kimi-coding": "kimi-for-coding",
    });
    assert.equal((await stat(paths.agentDir)).mode & 0o777, 0o700);
    assert.equal((await stat(paths.statePath)).mode & 0o777, 0o600);
    assert.equal((await stat(paths.backupPath)).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(paths.statePath, "utf8"), /access|refresh|api.?key/i);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("provider state rejects corruption and restores settings after a failed transaction", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-toolkit-provider-rollback-"));
  const paths = stateModule.getProviderSwitchPaths(temporary);
  try {
    await writeSettings(paths, { defaultProvider: "openai-codex", defaultModel: "gpt-current" });
    const original = await readFile(paths.settingsPath, "utf8");
    await assert.rejects(stateModule.commitProviderSwitch({
      targetProvider: "kimi-coding",
      targetModel: "kimi-for-coding",
    }, {
      paths,
      afterSettingsWrite: () => { throw new Error("fixture failure"); },
    }), /settings\.json restored/);
    assert.equal(await readFile(paths.settingsPath, "utf8"), original);

    await writeFile(paths.statePath, "{broken", { encoding: "utf8", mode: 0o600 });
    await assert.rejects(stateModule.readProviderSwitchState(paths), /invalid JSON/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("provider command toggles to Kimi only after confirmation and requests shutdown", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-toolkit-provider-command-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = temporary;
  const paths = stateModule.getProviderSwitchPaths(temporary);
  try {
    await writeSettings(paths, { defaultProvider: "openai-codex", defaultModel: "gpt-current" });
    const command = await loadCommand();
    let waited = false;
    let shutdown = false;
    const confirmations = [];
    const notifications = [];
    const ctx = {
      model: model("openai-codex", "gpt-current"),
      modelRegistry: fakeRegistry(),
      waitForIdle: async () => { waited = true; },
      shutdown: () => { shutdown = true; },
      ui: {
        select: async () => undefined,
        confirm: async (title, message) => { confirmations.push({ title, message }); return false; },
        notify: (message, level) => notifications.push({ message, level }),
      },
    };

    await command.handler("", ctx);
    assert.equal(waited, true);
    assert.equal(shutdown, false);
    assert.equal(JSON.parse(await readFile(paths.settingsPath, "utf8")).defaultProvider, "openai-codex");

    ctx.ui.confirm = async (title, message) => { confirmations.push({ title, message }); return true; };
    await command.handler("kimi", ctx);
    assert.equal(shutdown, true);
    assert.match(confirmations.at(-1).message, /Kimi \/ kimi-for-coding.*pi -c/);
    assert.equal(JSON.parse(await readFile(paths.settingsPath, "utf8")).defaultProvider, "kimi-coding");
    assert.match(notifications.at(-1).message, /Provider switched to Kimi/);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(temporary, { recursive: true, force: true });
  }
});

test("provider command reports already-active and missing-auth states without mutation", async () => {
  const command = await loadCommand();
  const notifications = [];
  let confirmed = false;
  const baseContext = {
    waitForIdle: async () => {},
    shutdown: () => { throw new Error("must not shut down"); },
    ui: {
      select: async () => undefined,
      confirm: async () => { confirmed = true; return true; },
      notify: (message, level) => notifications.push({ message, level }),
    },
  };

  await command.handler("codex", {
    ...baseContext,
    model: model("openai-codex", "gpt-current"),
    modelRegistry: fakeRegistry(),
  });
  assert.match(notifications.at(-1).message, /already active/);
  assert.equal(confirmed, false);

  await command.handler("kimi", {
    ...baseContext,
    model: model("openai-codex", "gpt-current"),
    modelRegistry: fakeRegistry({ kimiConfigured: false }),
  });
  assert.equal(notifications.at(-1).level, "error");
  assert.match(notifications.at(-1).message, /\/login kimi-coding.*API key/);
});
