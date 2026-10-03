import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export function figmaCacheRoot(): string {
  return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "cache", "figma");
}

/** Immutable generations + an atomic pointer keep the last good export on refresh failure. */
export async function figmaCache(key: string, root = figmaCacheRoot()) {
  const directory = join(root, createHash("sha256").update(key).digest("hex"));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe Figma cache directory");
  await chmod(directory, 0o700);
  const pointer = join(directory, "current.json");
  return {
    async current(nodeId: string): Promise<string | undefined> {
      try {
        const { generation } = JSON.parse(await readFile(pointer, "utf8"));
        if (!/^export-[a-zA-Z0-9]+$/.test(generation)) return;
        const path = join(directory, generation);
        if ((await lstat(path)).isSymbolicLink()) return;
        const payload = JSON.parse(await readFile(join(path, "node.json"), "utf8"));
        if (payload?.nodes?.[nodeId]?.document) return path;
      } catch { /* Missing or corrupt cache is a miss. */ }
    },
    async create() { return mkdtemp(join(directory, "export-")); },
    async publish(path: string) {
      const generation = path.slice(directory.length + 1);
      if (!/^export-[a-zA-Z0-9]+$/.test(generation)) throw new Error("Invalid cache generation");
      const temporary = join(directory, `${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify({ generation }), { mode: 0o600, flag: "wx" });
        await rename(temporary, pointer);
      } finally { await rm(temporary, { force: true }); }
    },
  };
}
