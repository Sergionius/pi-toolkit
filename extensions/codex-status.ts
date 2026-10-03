import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runCommand } from "./ralphex/process";
import { redactDiagnostic } from "./ralphex/diagnostics";
import { randomUUID } from "node:crypto";
import { readCurrentCodexCredential } from "./lib/codex-auth";

const USAGE_URL = "https://chatgpt.com/backend-api/codex/usage";
const RESET_CREDIT_CONSUME_URL = "https://chatgpt.com/backend-api/codex/rate-limit-reset-credits/consume";

type UsageWindow = {
  used_percent?: number;
  window_minutes?: number;
  limit_window_seconds?: number;
  resets_at?: number;
  reset_at?: number;
  reset_after_seconds?: number;
};

type Usage = {
  email?: string;
  plan_type?: string;
  plan?: string;
  rate_limit?: {
    allowed?: boolean;
    limit_reached?: boolean;
    primary_window?: UsageWindow | null;
    secondary_window?: UsageWindow | null;
  };
  primary?: UsageWindow | null;
  secondary?: UsageWindow | null;
  credits?: {
    unlimited?: boolean;
    balance?: string | number;
    overage_limit_reached?: boolean;
  } | null;
  spend_control?: {
    reached?: boolean;
    individual_limit?: string | number | null;
  } | null;
  rate_limit_reset_credits?: {
    available_count?: number;
  } | null;
  rate_limit_reached_type?: string | null;
};

async function readPiCodexAuth() {
  const credential = await readCurrentCodexCredential();
  return {
    accessToken: credential.access,
    accountId: credential.accountId,
  };
}

export const DEFAULT_CODEX_USER_AGENT = "codex-cli/0.144.1";

export async function codexRequest(script: string, env: NodeJS.ProcessEnv, runner = runCommand): Promise<string> {
  const userAgent = process.env.PI_CODEX_USER_AGENT?.trim() || DEFAULT_CODEX_USER_AGENT;
  if (/[\r\n]/.test(userAgent)) throw new Error("Invalid PI_CODEX_USER_AGENT");
  const result = await runner({ command: "python3", args: ["-c", script], cwd: process.cwd(), timeoutMs: 25000,
    env: { ...process.env, ...env, PI_CODEX_USER_AGENT: userAgent } });
  if (result.code !== 0) {
    const text = (result.stderr || `python exited ${result.code}`).split(env.PI_CODEX_ACCESS_TOKEN || "\0").join("[REDACTED]");
    throw new Error(`pi Codex request failed: ${redactDiagnostic(text)}`);
  }
  return result.stdout;
}

export function parseUsage(text: string): Usage {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw new Error("Codex usage returned invalid JSON"); }
}

async function fetchUsage(): Promise<Usage> {
  const auth = await readPiCodexAuth();

  // Node's built-in fetch is currently Cloudflare-challenged by chatgpt.com for
  // this endpoint, while Python urllib matches the working Codex CLI behavior on
  // this machine. Pass secrets only through env, never argv/stdout.
  const script = String.raw`
import json, os, sys, urllib.request, urllib.error
url = os.environ["PI_CODEX_USAGE_URL"]
token = os.environ["PI_CODEX_ACCESS_TOKEN"]
account_id = os.environ.get("PI_CODEX_ACCOUNT_ID", "")
headers = {
    "Authorization": "Bearer " + token,
    "Accept": "application/json",
    "User-Agent": os.environ["PI_CODEX_USER_AGENT"],
    "Origin": "https://chatgpt.com",
    "Referer": "https://chatgpt.com/codex/settings/usage",
}
if account_id:
    headers["ChatGPT-Account-Id"] = account_id
req = urllib.request.Request(url, headers=headers)
try:
    with urllib.request.urlopen(req, timeout=20) as response:
        sys.stdout.write(response.read().decode("utf-8", "replace"))
except urllib.error.HTTPError as error:
    body = error.read().decode("utf-8", "replace")[:240]
    sys.stderr.write(f"HTTP {error.code}: {body}")
    sys.exit(1)
`;

  return parseUsage(await codexRequest(script, {
    PI_CODEX_USAGE_URL: USAGE_URL,
    PI_CODEX_ACCESS_TOKEN: auth.accessToken,
    PI_CODEX_ACCOUNT_ID: auth.accountId || "",
  }));
}

async function consumeResetCredit(redeemRequestId: string): Promise<void> {
  const auth = await readPiCodexAuth();

  const script = String.raw`
import json, os, sys, urllib.request, urllib.error
url = os.environ["PI_CODEX_RESET_URL"]
token = os.environ["PI_CODEX_ACCESS_TOKEN"]
account_id = os.environ.get("PI_CODEX_ACCOUNT_ID", "")
redeem_request_id = os.environ["PI_CODEX_REDEEM_REQUEST_ID"]
body = json.dumps({"redeem_request_id": redeem_request_id}).encode("utf-8")
headers = {
    "Authorization": "Bearer " + token,
    "Accept": "application/json",
    "Content-Type": "application/json",
    "User-Agent": os.environ["PI_CODEX_USER_AGENT"],
    "Origin": "https://chatgpt.com",
    "Referer": "https://chatgpt.com/codex/settings/usage",
}
if account_id:
    headers["ChatGPT-Account-Id"] = account_id
req = urllib.request.Request(url, data=body, headers=headers, method="POST")
try:
    with urllib.request.urlopen(req, timeout=20) as response:
        sys.stdout.write(response.read().decode("utf-8", "replace"))
except urllib.error.HTTPError as error:
    body = error.read().decode("utf-8", "replace")[:240]
    sys.stderr.write(f"HTTP {error.code}: {body}")
    sys.exit(1)
`;

  // Never retry a consumption request: a timeout may mean the credit was spent.
  await codexRequest(script, {
    PI_CODEX_RESET_URL: RESET_CREDIT_CONSUME_URL,
    PI_CODEX_ACCESS_TOKEN: auth.accessToken,
    PI_CODEX_REDEEM_REQUEST_ID: redeemRequestId,
    PI_CODEX_ACCOUNT_ID: auth.accountId || "",
  });
}

function formatReset(epochSeconds?: number, afterSeconds?: number) {
  if (!epochSeconds && afterSeconds != null) epochSeconds = Math.floor(Date.now() / 1000) + afterSeconds;
  if (!epochSeconds) return "сброс неизвестен";

  const deltaSeconds = Math.max(0, epochSeconds - Math.floor(Date.now() / 1000));
  const days = Math.floor(deltaSeconds / 86400);
  const hours = Math.floor((deltaSeconds % 86400) / 3600);
  const minutes = Math.floor((deltaSeconds % 3600) / 60);
  const date = new Date(epochSeconds * 1000).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const parts = [];
  if (days) parts.push(`${days} д`);
  if (hours) parts.push(`${hours} ч`);
  parts.push(`${minutes} мин`);
  return `сброс через ${parts.join(" ")} (${date})`;
}

function normalizeWindow(window?: UsageWindow | null) {
  if (!window) return null;
  return {
    used: Math.round(Number(window.used_percent ?? 0)),
    resetAt: window.reset_at ?? window.resets_at,
    resetAfter: window.reset_after_seconds,
  };
}

function formatUsage(usage: Usage) {
  const primary = normalizeWindow(usage.rate_limit?.primary_window ?? usage.primary);
  const secondary = normalizeWindow(usage.rate_limit?.secondary_window ?? usage.secondary);
  const plan = usage.plan_type || usage.plan || "unknown";
  const email = usage.email || "unknown account";
  const allowed = usage.rate_limit?.allowed;
  const reached = usage.rate_limit?.limit_reached || Boolean(usage.rate_limit_reached_type);

  const lines = [
    `Codex: ${allowed === false || reached ? "лимит достигнут" : "доступен"}`,
    `Аккаунт: ${email}`,
    `План: ${plan}`,
  ];

  if (primary) lines.push(`Лимит: осталось ${Math.max(0, 100 - primary.used)}% (использовано ${primary.used}%), ${formatReset(primary.resetAt, primary.resetAfter)}`);
  if (secondary) lines.push(`Недельный/доп. лимит: осталось ${Math.max(0, 100 - secondary.used)}% (использовано ${secondary.used}%), ${formatReset(secondary.resetAt, secondary.resetAfter)}`);

  if (usage.credits) {
    const creditText = usage.credits.unlimited ? "безлимит" : String(usage.credits.balance ?? 0);
    lines.push(`Кредиты: ${creditText}${usage.credits.overage_limit_reached ? " (лимит превышен)" : ""}`);
  }

  if (usage.rate_limit_reset_credits?.available_count != null) {
    lines.push(`Быстрые сбросы лимита: ${usage.rate_limit_reset_credits.available_count}`);
  }
  if (usage.spend_control?.individual_limit != null) {
    lines.push(`Денежный лимит: ${usage.spend_control.individual_limit}${usage.spend_control.reached ? " (достигнут)" : ""}`);
  }
  if (usage.rate_limit_reached_type) lines.push(`Тип ограничения: ${usage.rate_limit_reached_type}`);

  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  async function showStatus(ctx: any) {
    const usage = await fetchUsage();
    ctx.ui.notify(formatUsage(usage), "info");
  }

  async function resetLimit(ctx: any, args?: string) {
    const usage = await fetchUsage();
    const available = usage.rate_limit_reset_credits?.available_count ?? 0;
    if (available <= 0) {
      ctx.ui.notify("Быстрых сбросов лимита не осталось", "warning");
      return;
    }

    const force = String(args || "").trim() === "--yes";
    if (!force) {
      const ok = await ctx.ui.confirm(
        "Сбросить лимит Codex?",
        `Будет потрачен 1 быстрый сброс. Доступно сейчас: ${available}. Продолжить?`,
      );
      if (!ok) {
        ctx.ui.notify("Сброс лимита отменён", "info");
        return;
      }
    }

    await consumeResetCredit(randomUUID());
    const updated = await fetchUsage();
    ctx.ui.notify(`Лимит Codex сброшен.\n\n${formatUsage(updated)}`, "info");
  }

  pi.registerCommand("codex-status", {
    description: "Show Codex ChatGPT usage/rate-limit status using pi OpenAI/Codex auth",
    handler: async (_args, ctx) => {
      try {
        await showStatus(ctx);
      } catch (error) {
        ctx.ui.notify(`codex-status failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("codex-usage", {
    description: "Alias for /codex-status",
    handler: async (_args, ctx) => {
      try {
        await showStatus(ctx);
      } catch (error) {
        ctx.ui.notify(`codex-usage failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("codex-reset-limit", {
    description: "Spend one Codex fast reset credit to reset the current rate limit",
    handler: async (args, ctx) => {
      try {
        await resetLimit(ctx, args);
      } catch (error) {
        ctx.ui.notify(`codex-reset-limit failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("codex-reset", {
    description: "Alias for /codex-reset-limit",
    handler: async (args, ctx) => {
      try {
        await resetLimit(ctx, args);
      } catch (error) {
        ctx.ui.notify(`codex-reset failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
