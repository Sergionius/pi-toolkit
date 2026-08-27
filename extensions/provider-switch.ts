import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  CODEX_PROVIDER_ID,
  commitProviderSwitch,
  isSupportedProviderId,
  KIMI_PROVIDER_ID,
  readProviderSwitchState,
  type SupportedProviderId,
} from "./lib/provider-switch-state";

const PROVIDER_ALIASES = {
  codex: CODEX_PROVIDER_ID,
  kimi: KIMI_PROVIDER_ID,
} as const;

const FIRST_USE_MODEL_PREFERENCES: Record<SupportedProviderId, string[]> = {
  [CODEX_PROVIDER_ID]: ["gpt-5.6-sol", "gpt-5.5", "gpt-5.4"],
  [KIMI_PROVIDER_ID]: ["kimi-for-coding", "k3", "kimi-for-coding-highspeed", "k3-256k"],
};

function providerLabel(provider: SupportedProviderId): string {
  return provider === CODEX_PROVIDER_ID ? "Codex" : "Kimi";
}

export function parseProviderArgument(argument: string): SupportedProviderId | undefined {
  const normalized = argument.trim().toLowerCase();
  if (!normalized) return undefined;
  return PROVIDER_ALIASES[normalized as keyof typeof PROVIDER_ALIASES];
}

function otherProvider(provider: SupportedProviderId): SupportedProviderId {
  return provider === CODEX_PROVIDER_ID ? KIMI_PROVIDER_ID : CODEX_PROVIDER_ID;
}

async function selectModel(
  provider: SupportedProviderId,
  models: Model<Api>[],
  rememberedModel: string | undefined,
  ctx: ExtensionCommandContext,
): Promise<Model<Api> | undefined> {
  if (rememberedModel) {
    const remembered = models.find((model) => model.id === rememberedModel);
    if (remembered) return remembered;
  } else {
    for (const preferredId of FIRST_USE_MODEL_PREFERENCES[provider]) {
      const preferred = models.find((model) => model.id === preferredId);
      if (preferred) return preferred;
    }
    if (models.length === 1) return models[0];
  }

  const sorted = [...models].sort((left, right) => left.id.localeCompare(right.id));
  const options = sorted.map((model) => `${model.id} — ${model.name}`);
  const title = rememberedModel
    ? `${providerLabel(provider)} model '${rememberedModel}' is unavailable. Select a replacement:`
    : `Select a ${providerLabel(provider)} model:`;
  const selection = await ctx.ui.select(title, options);
  if (!selection) return undefined;
  return sorted[options.indexOf(selection)];
}

async function handleProviderSwitch(argument: string, ctx: ExtensionCommandContext): Promise<void> {
  await ctx.waitForIdle();

  const normalizedArgument = argument.trim().toLowerCase();
  const explicitTarget = parseProviderArgument(argument);
  if (normalizedArgument && !explicitTarget) {
    throw new Error("Provider must be 'codex' or 'kimi'");
  }

  const currentProvider = isSupportedProviderId(ctx.model?.provider) ? ctx.model.provider : undefined;
  if (!explicitTarget && !currentProvider) {
    throw new Error("Current provider is neither Codex nor Kimi; use /provider-switch codex or /provider-switch kimi");
  }
  const targetProvider = explicitTarget ?? otherProvider(currentProvider!);

  if (currentProvider === targetProvider) {
    ctx.ui.notify(`${providerLabel(targetProvider)} is already active`, "info");
    return;
  }

  if (!ctx.modelRegistry.getProvider(targetProvider)) {
    throw new Error(`${providerLabel(targetProvider)} provider is not available in this Pi installation`);
  }
  if (!ctx.modelRegistry.getProviderAuthStatus(targetProvider).configured) {
    const setup = targetProvider === KIMI_PROVIDER_ID
      ? "Run /login kimi-coding and choose API key."
      : "Run /login openai-codex.";
    throw new Error(`${providerLabel(targetProvider)} is not configured. ${setup}`);
  }

  const models = ctx.modelRegistry.getAvailable().filter((model) => model.provider === targetProvider);
  if (!models.length) throw new Error(`No available models found for ${providerLabel(targetProvider)}`);

  const state = await readProviderSwitchState();
  const targetModel = await selectModel(targetProvider, models, state.lastModels[targetProvider], ctx);
  if (!targetModel) return;

  const confirmed = await ctx.ui.confirm(
    "Switch provider?",
    `Switch to ${providerLabel(targetProvider)} / ${targetModel.id} and exit Pi? Resume this session with: pi -c`,
  );
  if (!confirmed) return;

  await commitProviderSwitch({
    targetProvider,
    targetModel: targetModel.id,
    currentProvider,
    currentModel: currentProvider ? ctx.model?.id : undefined,
  });
  ctx.ui.notify(
    `Provider switched to ${providerLabel(targetProvider)} / ${targetModel.id}. Restart with: pi -c`,
    "info",
  );
  ctx.shutdown();
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("provider-switch", {
    description: "Switch the default provider between Codex and Kimi, then exit Pi",
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.trim().toLowerCase();
      const items = [
        { value: "codex", label: "codex", description: "OpenAI Codex" },
        { value: "kimi", label: "kimi", description: "Kimi For Coding" },
      ].filter((item) => item.value.startsWith(normalized));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      try {
        await handleProviderSwitch(args, ctx);
      } catch (error) {
        ctx.ui.notify(`provider-switch failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
