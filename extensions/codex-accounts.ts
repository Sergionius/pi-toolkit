import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  findCurrentProfile,
  formatCredentialExpiry,
  readCodexAccountsVault,
  readCurrentCodexCredential,
  removeCodexProfile,
  saveCurrentCodexProfile,
  shortenAccountId,
  switchCodexProfile,
  syncActiveCodexProfile,
  validateProfileName,
} from "./lib/codex-auth";

function formatProfileLine(
  name: string,
  profile: { accountId?: string; credential: { expires: number } },
  activeProfile?: string,
  currentProfile?: string,
): string {
  const markers = [name === activeProfile ? "saved-active" : "", name === currentProfile ? "current-auth" : ""]
    .filter(Boolean)
    .join(", ");
  const suffix = markers ? ` [${markers}]` : "";
  return `${name}${suffix} — account ${shortenAccountId(profile.accountId)}, expires ${formatCredentialExpiry(profile.credential.expires)}`;
}

async function currentState() {
  const vault = await readCodexAccountsVault();
  const credential = await readCurrentCodexCredential();
  return { vault, credential, currentProfile: findCurrentProfile(vault, credential) };
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("codex-account-save", {
    description: "Save the current OpenAI/Codex OAuth credential as a named local profile",
    handler: async (args, ctx) => {
      try {
        const name = validateProfileName(args);
        const profile = await saveCurrentCodexProfile(name);
        ctx.ui.notify(`Codex account saved as '${name}' (${shortenAccountId(profile.accountId)})`, "info");
      } catch (error) {
        ctx.ui.notify(`codex-account-save failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("codex-account-list", {
    description: "List saved Codex account profiles without displaying tokens",
    handler: async (_args, ctx) => {
      try {
        const vault = await readCodexAccountsVault();
        const names = Object.keys(vault.profiles).sort();
        if (!names.length) {
          ctx.ui.notify("No Codex account profiles saved. Use /codex-account-save <name>.", "warning");
          return;
        }
        let currentProfile: string | undefined;
        try {
          currentProfile = findCurrentProfile(vault, await readCurrentCodexCredential());
        } catch {
          // List remains useful while logged out.
        }
        const lines = names.map((name) => formatProfileLine(name, vault.profiles[name], vault.activeProfile, currentProfile));
        ctx.ui.notify(lines.join("\n"), "info");
      } catch (error) {
        ctx.ui.notify(`codex-account-list failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("codex-account-current", {
    description: "Show which saved Codex profile matches the active Pi credential",
    handler: async (_args, ctx) => {
      try {
        const { vault, credential, currentProfile } = await currentState();
        if (!currentProfile) {
          ctx.ui.notify(
            `Current Codex account ${shortenAccountId(credential.accountId)} is not tracked. Use /codex-account-save <name>.`,
            "warning",
          );
          return;
        }
        ctx.ui.notify(formatProfileLine(currentProfile, vault.profiles[currentProfile], vault.activeProfile, currentProfile), "info");
      } catch (error) {
        ctx.ui.notify(`codex-account-current failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("codex-account-switch", {
    description: "Switch the active Codex profile and exit Pi so the new credential is loaded",
    handler: async (args, ctx) => {
      try {
        await ctx.waitForIdle();
        const vault = await readCodexAccountsVault();
        const names = Object.keys(vault.profiles).sort();
        if (!names.length) {
          ctx.ui.notify("No Codex account profiles saved. Use /codex-account-save <name>.", "warning");
          return;
        }

        let name = args.trim();
        if (name) {
          name = validateProfileName(name);
          if (!vault.profiles[name]) throw new Error(`Codex profile '${name}' does not exist`);
        } else {
          const selection = await ctx.ui.select(
            "Switch Codex account (Pi will exit)",
            names.map((profileName) => formatProfileLine(profileName, vault.profiles[profileName], vault.activeProfile, undefined)),
          );
          if (!selection) return;
          name = selection.split(" — ", 1)[0].split(" [", 1)[0];
        }

        const current = await readCurrentCodexCredential();
        if (findCurrentProfile(vault, current) === name) {
          await switchCodexProfile(name);
          ctx.ui.notify(`Codex profile '${name}' is already active`, "info");
          return;
        }

        const confirmed = await ctx.ui.confirm(
          "Switch Codex account?",
          `Switch to '${name}' and exit Pi? Resume this session with: pi -c`,
        );
        if (!confirmed) return;

        const result = await switchCodexProfile(name);
        if (!result.changed) {
          ctx.ui.notify(`Codex profile '${name}' is already active`, "info");
          return;
        }
        ctx.ui.notify(`Codex profile switched to '${name}'. Restart with: pi -c`, "info");
        ctx.shutdown();
      } catch (error) {
        ctx.ui.notify(`codex-account-switch failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("codex-account-remove", {
    description: "Remove a saved Codex profile without deleting the active Pi credential",
    handler: async (args, ctx) => {
      try {
        const name = validateProfileName(args);
        const vault = await readCodexAccountsVault();
        if (!vault.profiles[name]) {
          ctx.ui.notify(`Codex profile '${name}' does not exist`, "warning");
          return;
        }
        const confirmed = await ctx.ui.confirm(
          "Remove Codex profile?",
          `Remove saved profile '${name}'? The active credential in auth.json will not be deleted.`,
        );
        if (!confirmed) return;
        await removeCodexProfile(name);
        ctx.ui.notify(`Codex profile '${name}' removed`, "info");
      } catch (error) {
        ctx.ui.notify(`codex-account-remove failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.on("session_shutdown", async () => {
    try {
      await syncActiveCodexProfile();
    } catch {
      // Shutdown must not be blocked by account-vault maintenance.
    }
  });
}
