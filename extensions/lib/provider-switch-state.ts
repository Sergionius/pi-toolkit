import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const CODEX_PROVIDER_ID = "openai-codex";
export const KIMI_PROVIDER_ID = "kimi-coding";
export const SUPPORTED_PROVIDER_IDS = [CODEX_PROVIDER_ID, KIMI_PROVIDER_ID] as const;

export type SupportedProviderId = typeof SUPPORTED_PROVIDER_IDS[number];

type JsonObject = Record<string, unknown>;

export type ProviderSwitchState = {
  version: 1;
  lastModels: Partial<Record<SupportedProviderId, string>>;
};

export type ProviderSwitchPaths = {
  agentDir: string;
  settingsPath: string;
  statePath: string;
  backupPath: string;
};

export type CommitProviderSwitchInput = {
  targetProvider: SupportedProviderId;
  targetModel: string;
  currentProvider?: SupportedProviderId;
  currentModel?: string;
};

export type CommitProviderSwitchOptions = {
  paths?: ProviderSwitchPaths;
  /** Test hook used to verify rollback after settings.json was written. */
  afterSettingsWrite?: () => Promise<void> | void;
};

const STATE_VERSION = 1;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSupportedProviderId(value: string | undefined): value is SupportedProviderId {
  return value === CODEX_PROVIDER_ID || value === KIMI_PROVIDER_ID;
}

export function getProviderSwitchPaths(
  agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
): ProviderSwitchPaths {
  const normalized = resolve(agentDir);
  return {
    agentDir: normalized,
    settingsPath: join(normalized, "settings.json"),
    statePath: join(normalized, "provider-switch.json"),
    backupPath: join(normalized, "settings.json.provider-switch.bak"),
  };
}

async function ensurePrivateAgentDir(paths: ProviderSwitchPaths): Promise<void> {
  await mkdir(paths.agentDir, { recursive: true, mode: 0o700 });
  await chmod(paths.agentDir, 0o700);
}

async function atomicWrite(path: string, content: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await chmod(path, mode);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readRequiredJson(path: string, label: string): Promise<{ raw: string; value: JsonObject }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${label} not found: ${path}`);
    throw error;
  }
  try {
    const value = JSON.parse(raw);
    if (!isObject(value)) throw new Error("root must be an object");
    return { raw, value };
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function readProviderSwitchState(paths = getProviderSwitchPaths()): Promise<ProviderSwitchState> {
  let raw: string;
  try {
    raw = await readFile(paths.statePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: STATE_VERSION, lastModels: {} };
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Provider switch state is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(parsed) || parsed.version !== STATE_VERSION || !isObject(parsed.lastModels)) {
    throw new Error("Provider switch state has an unsupported or invalid schema");
  }

  const lastModels: ProviderSwitchState["lastModels"] = {};
  for (const provider of SUPPORTED_PROVIDER_IDS) {
    const model = parsed.lastModels[provider];
    if (model !== undefined && (typeof model !== "string" || !model.trim())) {
      throw new Error(`Provider switch state model for '${provider}' is invalid`);
    }
    if (typeof model === "string") lastModels[provider] = model;
  }
  return { version: STATE_VERSION, lastModels };
}

export async function commitProviderSwitch(
  input: CommitProviderSwitchInput,
  options: CommitProviderSwitchOptions = {},
): Promise<void> {
  if (!input.targetModel.trim()) throw new Error("Target model must not be empty");
  const paths = options.paths ?? getProviderSwitchPaths();
  await ensurePrivateAgentDir(paths);

  const { raw: originalSettingsRaw, value: originalSettings } = await readRequiredJson(paths.settingsPath, "Pi settings.json");
  const state = await readProviderSwitchState(paths);
  const nextSettings = {
    ...originalSettings,
    defaultProvider: input.targetProvider,
    defaultModel: input.targetModel,
  };
  const nextState: ProviderSwitchState = {
    version: STATE_VERSION,
    lastModels: { ...state.lastModels, [input.targetProvider]: input.targetModel },
  };
  if (input.currentProvider && input.currentModel?.trim()) {
    nextState.lastModels[input.currentProvider] = input.currentModel;
  }

  await atomicWrite(paths.backupPath, originalSettingsRaw, 0o600);
  let settingsChanged = false;
  try {
    await atomicWrite(paths.settingsPath, serializeJson(nextSettings), 0o600);
    settingsChanged = true;
    await options.afterSettingsWrite?.();
    await atomicWrite(paths.statePath, serializeJson(nextState), 0o600);
  } catch (error) {
    if (settingsChanged) {
      try {
        await atomicWrite(paths.settingsPath, originalSettingsRaw, 0o600);
      } catch (rollbackError) {
        throw new Error(
          `Provider switch failed and settings rollback failed: ${error instanceof Error ? error.message : String(error)}; `
          + `${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    throw new Error(`Provider switch failed; settings.json restored: ${error instanceof Error ? error.message : String(error)}`);
  }
}
