import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type RalphexModelConfig = {
  planModel?: string;
  execModel?: string;
};

export type RalphexModelOverrides = {
  planModel?: string;
  execModel?: string;
};

export function modelConfigPaths(root: string, agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")) {
  return {
    global: join(resolve(agentDir), "ralphex.json"),
    project: join(resolve(root), ".pi", "ralphex.json"),
  };
}

function normalizeConfig(value: unknown, path: string): RalphexModelConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid Ralphex model config: ${path}`);
  const source = value as Record<string, unknown>;
  const config: RalphexModelConfig = {};
  for (const key of ["planModel", "execModel"] as const) {
    if (source[key] === undefined) continue;
    if (typeof source[key] !== "string" || !source[key].trim()) throw new Error(`invalid ${key} in ${path}`);
    config[key] = source[key].trim();
  }
  return config;
}

export async function readModelConfig(path: string): Promise<RalphexModelConfig> {
  try {
    return normalizeConfig(JSON.parse(await readFile(path, "utf8")), path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (error instanceof SyntaxError) throw new Error(`invalid JSON in Ralphex model config: ${path}`);
    throw error;
  }
}

export async function resolveModelConfig(options: {
  root: string;
  projectTrusted: boolean;
  overrides?: RalphexModelOverrides;
  agentDir?: string;
}): Promise<RalphexModelConfig> {
  const paths = modelConfigPaths(options.root, options.agentDir);
  const global = await readModelConfig(paths.global);
  const project = options.projectTrusted ? await readModelConfig(paths.project) : {};
  const overrides = Object.fromEntries(
    Object.entries(options.overrides ?? {}).filter(([, value]) => value !== undefined),
  ) as RalphexModelOverrides;
  return { ...global, ...project, ...overrides };
}

export async function writeModelConfig(path: string, config: RalphexModelConfig, privateFile = false): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: privateFile ? 0o700 : undefined });
  const temporary = join(directory, `.${Date.now()}-${process.pid}-ralphex.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: privateFile ? 0o600 : 0o644 });
    await rename(temporary, path);
    if (privateFile) await chmod(path, 0o600);
  } catch (error) {
    try { await rm(temporary, { force: true }); } catch {}
    throw error;
  }
}
