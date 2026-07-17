import { constants } from "node:fs";
import { access, chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const CODEX_PROVIDER_ID = "openai-codex";
export const PROFILE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const VAULT_VERSION = 1;
const LOCK_RETRIES = 50;
const LOCK_RETRY_MS = 50;
const LOCK_STALE_MS = 30_000;

type JsonObject = Record<string, unknown>;

export type CodexOAuthCredential = {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  [key: string]: unknown;
};

export type CodexAccountProfile = {
  credential: CodexOAuthCredential;
  accountId?: string;
  savedAt: number;
  updatedAt: number;
};

export type CodexAccountsVault = {
  version: 1;
  activeProfile?: string;
  profiles: Record<string, CodexAccountProfile>;
};

export type CodexAccountPaths = {
  agentDir: string;
  authPath: string;
  vaultPath: string;
  backupPath: string;
  lockPath: string;
};

export type SwitchOptions = {
  paths?: CodexAccountPaths;
  /** Test hook used to verify auth rollback after the active credential was written. */
  afterAuthWrite?: () => Promise<void> | void;
};

export function getCodexAccountPaths(agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")): CodexAccountPaths {
  const normalized = resolve(agentDir);
  return {
    agentDir: normalized,
    authPath: join(normalized, "auth.json"),
    vaultPath: join(normalized, "codex-accounts.json"),
    backupPath: join(normalized, "auth.json.codex-switch.bak"),
    lockPath: join(normalized, ".codex-accounts.lock"),
  };
}

function emptyVault(): CodexAccountsVault {
  return { version: VAULT_VERSION, profiles: {} };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateProfileName(name: string): string {
  const normalized = name.trim();
  if (!normalized || !PROFILE_NAME_PATTERN.test(normalized)) {
    throw new Error("Profile name must contain only letters, digits, '_' or '-'");
  }
  return normalized;
}

export function validateCodexCredential(value: unknown): CodexOAuthCredential {
  if (!isObject(value) || value.type !== "oauth") throw new Error("Current openai-codex credential is not OAuth");
  if (typeof value.access !== "string" || !value.access) throw new Error("Codex OAuth access token is missing");
  if (typeof value.refresh !== "string" || !value.refresh) throw new Error("Codex OAuth refresh token is missing");
  if (typeof value.expires !== "number" || !Number.isFinite(value.expires)) throw new Error("Codex OAuth expiry is invalid");
  if (value.accountId !== undefined && typeof value.accountId !== "string") throw new Error("Codex OAuth accountId is invalid");
  return structuredClone(value) as CodexOAuthCredential;
}

function validateProfile(value: unknown, name: string): CodexAccountProfile {
  if (!isObject(value)) throw new Error(`Codex profile '${name}' is invalid`);
  const credential = validateCodexCredential(value.credential);
  if (typeof value.savedAt !== "number" || typeof value.updatedAt !== "number") {
    throw new Error(`Codex profile '${name}' timestamps are invalid`);
  }
  return {
    credential,
    accountId: typeof value.accountId === "string" ? value.accountId : credential.accountId,
    savedAt: value.savedAt,
    updatedAt: value.updatedAt,
  };
}

export async function ensurePrivateAgentDir(paths = getCodexAccountPaths()): Promise<void> {
  await mkdir(paths.agentDir, { recursive: true, mode: 0o700 });
  await chmod(paths.agentDir, 0o700);
}

async function atomicWriteJson(path: string, value: unknown, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
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

async function readJsonObject(path: string, label: string): Promise<JsonObject> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${label} not found: ${path}`);
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!isObject(parsed)) throw new Error("root must be an object");
    return parsed;
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function readAuthFile(paths = getCodexAccountPaths()): Promise<JsonObject> {
  return readJsonObject(paths.authPath, "Pi auth.json");
}

export async function readCurrentCodexCredential(paths = getCodexAccountPaths()): Promise<CodexOAuthCredential> {
  const auth = await readAuthFile(paths);
  if (!(CODEX_PROVIDER_ID in auth)) throw new Error("OpenAI/Codex is not logged in. Run /login first.");
  return validateCodexCredential(auth[CODEX_PROVIDER_ID]);
}

export async function readCodexAccountsVault(paths = getCodexAccountPaths()): Promise<CodexAccountsVault> {
  try {
    await access(paths.vaultPath, constants.F_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyVault();
    throw error;
  }
  const parsed = await readJsonObject(paths.vaultPath, "Codex accounts vault");
  if (parsed.version !== VAULT_VERSION) throw new Error(`Unsupported Codex accounts vault version: ${String(parsed.version)}`);
  if (!isObject(parsed.profiles)) throw new Error("Codex accounts vault profiles are invalid");

  const profiles: Record<string, CodexAccountProfile> = {};
  for (const [name, profile] of Object.entries(parsed.profiles)) {
    validateProfileName(name);
    profiles[name] = validateProfile(profile, name);
  }
  const activeProfile = typeof parsed.activeProfile === "string" ? validateProfileName(parsed.activeProfile) : undefined;
  if (activeProfile && !profiles[activeProfile]) throw new Error(`Active Codex profile '${activeProfile}' does not exist`);
  return { version: VAULT_VERSION, activeProfile, profiles };
}

async function saveVault(vault: CodexAccountsVault, paths: CodexAccountPaths): Promise<void> {
  await ensurePrivateAgentDir(paths);
  await atomicWriteJson(paths.vaultPath, vault, 0o600);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function acquireLock(paths: CodexAccountPaths): Promise<() => Promise<void>> {
  await ensurePrivateAgentDir(paths);
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
    try {
      const handle = await open(paths.lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.writeFile(`${process.pid}\n`, "utf8");
      await handle.close();
      return async () => { await rm(paths.lockPath, { force: true }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const lockStat = await stat(paths.lockPath);
        if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
          await rm(paths.lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      await delay(LOCK_RETRY_MS);
    }
  }
  throw new Error("Codex account storage is busy; try again");
}

async function withVaultLock<T>(paths: CodexAccountPaths, operation: () => Promise<T>): Promise<T> {
  const release = await acquireLock(paths);
  try {
    return await operation();
  } finally {
    await release();
  }
}

function credentialsMatch(left: CodexOAuthCredential | undefined, right: CodexOAuthCredential | undefined): boolean {
  return Boolean(left?.accountId && right?.accountId && left.accountId === right.accountId);
}

export function findCurrentProfile(vault: CodexAccountsVault, credential: CodexOAuthCredential): string | undefined {
  if (vault.activeProfile && credentialsMatch(vault.profiles[vault.activeProfile]?.credential, credential)) {
    return vault.activeProfile;
  }
  return Object.entries(vault.profiles).find(([, profile]) => credentialsMatch(profile.credential, credential))?.[0];
}

export async function saveCurrentCodexProfile(name: string, paths = getCodexAccountPaths()): Promise<CodexAccountProfile> {
  const profileName = validateProfileName(name);
  return withVaultLock(paths, async () => {
    const credential = await readCurrentCodexCredential(paths);
    const vault = await readCodexAccountsVault(paths);
    const now = Date.now();
    const existing = vault.profiles[profileName];
    const profile: CodexAccountProfile = {
      credential,
      accountId: credential.accountId,
      savedAt: existing?.savedAt ?? now,
      updatedAt: now,
    };
    vault.profiles[profileName] = profile;
    vault.activeProfile = profileName;
    await saveVault(vault, paths);
    return structuredClone(profile);
  });
}

export async function syncActiveCodexProfile(paths = getCodexAccountPaths()): Promise<boolean> {
  return withVaultLock(paths, async () => {
    const vault = await readCodexAccountsVault(paths);
    if (!vault.activeProfile) return false;
    const profile = vault.profiles[vault.activeProfile];
    if (!profile) return false;

    let current: CodexOAuthCredential;
    try {
      current = await readCurrentCodexCredential(paths);
    } catch {
      return false;
    }
    if (!credentialsMatch(profile.credential, current)) return false;

    profile.credential = current;
    profile.accountId = current.accountId;
    profile.updatedAt = Date.now();
    await saveVault(vault, paths);
    return true;
  });
}

export async function switchCodexProfile(name: string, options: SwitchOptions = {}): Promise<{ changed: boolean; profile: string }> {
  const profileName = validateProfileName(name);
  const paths = options.paths ?? getCodexAccountPaths();
  return withVaultLock(paths, async () => {
    const vault = await readCodexAccountsVault(paths);
    const target = vault.profiles[profileName];
    if (!target) throw new Error(`Codex profile '${profileName}' does not exist`);

    const auth = await readAuthFile(paths);
    const current = validateCodexCredential(auth[CODEX_PROVIDER_ID]);
    if (vault.activeProfile) {
      const active = vault.profiles[vault.activeProfile];
      if (active && credentialsMatch(active.credential, current)) {
        active.credential = current;
        active.accountId = current.accountId;
        active.updatedAt = Date.now();
      }
    }

    if (credentialsMatch(target.credential, current)) {
      vault.activeProfile = profileName;
      await saveVault(vault, paths);
      return { changed: false, profile: profileName };
    }

    await ensurePrivateAgentDir(paths);
    await atomicWriteJson(paths.backupPath, auth, 0o600);

    const nextAuth = { ...auth, [CODEX_PROVIDER_ID]: structuredClone(target.credential) };
    let authChanged = false;
    try {
      await atomicWriteJson(paths.authPath, nextAuth, 0o600);
      authChanged = true;
      await options.afterAuthWrite?.();
      vault.activeProfile = profileName;
      await saveVault(vault, paths);
    } catch (error) {
      if (authChanged) await atomicWriteJson(paths.authPath, auth, 0o600);
      throw new Error(`Failed to switch Codex profile; auth.json restored: ${error instanceof Error ? error.message : String(error)}`);
    }

    return { changed: true, profile: profileName };
  });
}

export async function removeCodexProfile(name: string, paths = getCodexAccountPaths()): Promise<boolean> {
  const profileName = validateProfileName(name);
  return withVaultLock(paths, async () => {
    const vault = await readCodexAccountsVault(paths);
    if (!vault.profiles[profileName]) return false;
    delete vault.profiles[profileName];
    if (vault.activeProfile === profileName) vault.activeProfile = undefined;
    await saveVault(vault, paths);
    return true;
  });
}

export function shortenAccountId(accountId?: string): string {
  if (!accountId) return "unknown";
  if (accountId.length <= 12) return accountId;
  return `${accountId.slice(0, 6)}…${accountId.slice(-4)}`;
}

export function formatCredentialExpiry(expires: number): string {
  if (!Number.isFinite(expires)) return "unknown";
  return new Date(expires).toLocaleString();
}

export async function getCodexAccountsSummary(paths = getCodexAccountPaths()): Promise<{
  count: number;
  activeProfile?: string;
  currentProfile?: string;
}> {
  const vault = await readCodexAccountsVault(paths);
  let currentProfile: string | undefined;
  try {
    currentProfile = findCurrentProfile(vault, await readCurrentCodexCredential(paths));
  } catch {
    // Logged-out state is reported without exposing credential details.
  }
  return { count: Object.keys(vault.profiles).length, activeProfile: vault.activeProfile, currentProfile };
}
