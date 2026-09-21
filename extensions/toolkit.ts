import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { access, cp, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getCodexAccountsSummary } from "./lib/codex-auth";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER_PATH = join(PACKAGE_ROOT, "scripts", "flutter_refresh.sh");
const VSCODE_BRIDGE_SOURCE = join(PACKAGE_ROOT, "vscode", "pi-flutter-refresh-bridge");
const LEGACY_BRIDGE_DIRECTORY = "local.pi-flutter-refresh-bridge-0.1.0";

type BridgeManifest = {
  name: string;
  publisher: string;
  version: string;
};

export type SyncVsCodeBridgeOptions = {
  extensionsDir?: string;
};

export type SyncVsCodeBridgeResult = {
  destination: string;
  version: string;
  removedLegacy: string[];
};

async function readBridgeManifest(directory = VSCODE_BRIDGE_SOURCE): Promise<BridgeManifest> {
  const raw = await readFile(join(directory, "package.json"), "utf8");
  const manifest = JSON.parse(raw) as Partial<BridgeManifest>;
  if (!manifest.name || !manifest.publisher || !manifest.version) {
    throw new Error("VS Code bridge package.json is missing name, publisher, or version");
  }
  return manifest as BridgeManifest;
}

async function exists(path: string, mode = constants.F_OK): Promise<boolean> {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

export async function syncVsCodeBridge(options: SyncVsCodeBridgeOptions = {}): Promise<SyncVsCodeBridgeResult> {
  const manifest = await readBridgeManifest();
  const extensionsDir = resolve(
    options.extensionsDir
      ?? process.env.PI_TOOLKIT_VSCODE_EXTENSIONS_DIR
      ?? join(homedir(), ".vscode", "extensions"),
  );
  const directoryName = `${manifest.publisher}.${manifest.name}-${manifest.version}`;
  const destination = join(extensionsDir, directoryName);
  const nonce = `${process.pid}-${Date.now()}`;
  const temporary = join(extensionsDir, `.${directoryName}.tmp-${nonce}`);
  const backup = join(extensionsDir, `.${directoryName}.backup-${nonce}`);

  await mkdir(extensionsDir, { recursive: true });
  await rm(temporary, { recursive: true, force: true });
  await cp(VSCODE_BRIDGE_SOURCE, temporary, { recursive: true, force: true });

  const copiedManifest = await readBridgeManifest(temporary);
  if (copiedManifest.version !== manifest.version || copiedManifest.name !== manifest.name) {
    await rm(temporary, { recursive: true, force: true });
    throw new Error("VS Code bridge verification failed after copy");
  }

  const hadDestination = await exists(destination);
  if (hadDestination) await rename(destination, backup);
  try {
    await rename(temporary, destination);
  } catch (error) {
    if (hadDestination && await exists(backup)) await rename(backup, destination);
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  await rm(backup, { recursive: true, force: true });

  const removedLegacy: string[] = [];
  for (const entry of await readdir(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name !== LEGACY_BRIDGE_DIRECTORY || entry.name === directoryName) continue;
    const legacyPath = join(extensionsDir, entry.name);
    await rm(legacyPath, { recursive: true, force: true });
    removedLegacy.push(legacyPath);
  }

  return { destination, version: manifest.version, removedLegacy };
}

export async function getDoctorReport(): Promise<{ lines: string[]; healthy: boolean }> {
  const lines: string[] = [];
  let healthy = true;

  lines.push(`Package root: ${PACKAGE_ROOT}`);

  const helperReady = await exists(HELPER_PATH, constants.X_OK);
  lines.push(`Flutter helper: ${helperReady ? "OK" : "MISSING/NOT EXECUTABLE"} (${HELPER_PATH})`);
  healthy &&= helperReady;

  let manifest: BridgeManifest | undefined;
  try {
    manifest = await readBridgeManifest();
    lines.push(`VS Code bridge source: OK (${manifest.publisher}.${manifest.name}@${manifest.version})`);
  } catch (error) {
    healthy = false;
    lines.push(`VS Code bridge source: FAILED (${error instanceof Error ? error.message : String(error)})`);
  }

  if (manifest) {
    const extensionsDir = resolve(
      process.env.PI_TOOLKIT_VSCODE_EXTENSIONS_DIR ?? join(homedir(), ".vscode", "extensions"),
    );
    const installed = join(extensionsDir, `${manifest.publisher}.${manifest.name}-${manifest.version}`);
    const installedReady = await exists(join(installed, "package.json"));
    lines.push(`VS Code bridge installed: ${installedReady ? "OK" : "NOT SYNCED"} (${installed})`);
    healthy &&= installedReady;
  }

  try {
    const accounts = await getCodexAccountsSummary();
    const match = accounts.currentProfile
      ? `current auth matches '${accounts.currentProfile}'`
      : "current auth is untracked or logged out";
    lines.push(`Codex profiles: ${accounts.count} (${match})`);
  } catch (error) {
    healthy = false;
    lines.push(`Codex profiles: FAILED (${error instanceof Error ? error.message : String(error)})`);
  }

  lines.push(`FIGMA_TOKEN: ${process.env.FIGMA_TOKEN ? "set" : "not set (Figma tool unavailable)"}`);
  lines.push(`TAX_API_KEY: ${process.env.TAX_API_KEY ? "set" : "not set (Tax package push inactive)"}`);

  return { lines, healthy };
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("pi-toolkit-doctor", {
    description: "Check pi-toolkit helpers, integrations, and VS Code bridge installation",
    handler: async (_args, ctx) => {
      try {
        const report = await getDoctorReport();
        ctx.ui.notify(report.lines.join("\n"), report.healthy ? "info" : "warning");
      } catch (error) {
        ctx.ui.notify(`pi-toolkit doctor failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("pi-toolkit-sync-vscode", {
    description: "Install or atomically update the bundled Flutter refresh VS Code bridge",
    handler: async (_args, ctx) => {
      try {
        const result = await syncVsCodeBridge();
        const legacy = result.removedLegacy.length ? ` Removed ${result.removedLegacy.length} legacy install.` : "";
        ctx.ui.notify(
          `VS Code bridge ${result.version} synced to ${result.destination}.${legacy} Run “Developer: Reload Window” in VS Code.`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`VS Code bridge sync failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
