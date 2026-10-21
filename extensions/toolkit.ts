import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCodexAccountsSummary } from "./lib/codex-auth";

export async function getDoctorReport(): Promise<{ lines: string[]; healthy: boolean }> {
  const lines: string[] = [];
  let healthy = true;

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
  return { lines, healthy };
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("pi-toolkit-doctor", {
    description: "Check pi-toolkit integrations",
    handler: async (_args, ctx) => {
      try {
        const report = await getDoctorReport();
        ctx.ui.notify(report.lines.join("\n"), report.healthy ? "info" : "warning");
      } catch (error) {
        ctx.ui.notify(`pi-toolkit doctor failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
