import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const QUOTA_URLS: Record<string, string> = {
  zai: "https://api.z.ai/api/monitor/usage/quota/limit",
  "zai-coding-cn": "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
};
const QUOTA_URL = QUOTA_URLS.zai;
const REQUEST_TIMEOUT_MS = 15_000;

// Undocumented Z.ai monitor API (used by community CLIs): unit 3 is the
// rolling 5-hour window, unit 6 is the weekly window. Unknown units are
// skipped so new window types do not break the command.
const UNIT_LABELS: Record<number, string> = {
  3: "5ч лимит",
  6: "Недельный лимит",
};

type QuotaLimit = {
  unit?: number;
  usage?: number;
  currentValue?: number;
  percentage?: number;
  nextResetTime?: number;
};

export type QuotaWindow = {
  label: string;
  percentage: number;
  used: number;
  total: number;
  resetAt?: number;
};

export type Quota = {
  level?: string;
  windows: QuotaWindow[];
};

export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export type ZaiCredential = { key: string; url: string };

export async function readZaiCredential(dir: string = agentDir()): Promise<ZaiCredential> {
  let raw: string;
  try {
    raw = await readFile(join(dir, "auth.json"), "utf8");
  } catch {
    throw new Error(`z.ai ключ не найден: не удалось прочитать auth.json в ${dir}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("auth.json повреждён: ожидается JSON");
  }
  const auth = parsed as Record<string, { key?: unknown } | undefined>;
  for (const [provider, url] of Object.entries(QUOTA_URLS)) {
    const key = auth?.[provider]?.key;
    if (typeof key === "string" && key.trim()) return { key: key.trim(), url };
  }
  throw new Error("z.ai ключ не найден в auth.json (поля zai.key / zai-coding-cn.key)");
}

export async function readZaiKey(dir: string = agentDir()): Promise<string> {
  return (await readZaiCredential(dir)).key;
}

export function parseQuota(payload: unknown): Quota {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("z.ai usage вернул невалидный JSON");
  }
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("z.ai usage: в ответе нет данных");
  }
  const windows: QuotaWindow[] = [];
  const limits = (data as { limits?: unknown }).limits;
  for (const limit of Array.isArray(limits) ? (limits as QuotaLimit[]) : []) {
    const label = UNIT_LABELS[limit?.unit as number];
    if (!label) continue;
    const percentage = Math.round(Number(limit.percentage ?? 0));
    const total = Number(limit.usage ?? 0);
    const used = Number(limit.currentValue ?? 0);
    const resetAt = Number.isFinite(limit.nextResetTime) ? Number(limit.nextResetTime) : undefined;
    windows.push({ label, percentage, used, total, resetAt });
  }
  const level = (data as { level?: unknown }).level;
  return { level: typeof level === "string" ? level : undefined, windows };
}

export async function fetchQuota(
  key: string,
  url: string = QUOTA_URL,
  doFetch: typeof fetch = fetch,
): Promise<Quota> {
  let response: Response;
  try {
    response = await doFetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`z.ai запрос не выполнен: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`z.ai API HTTP ${response.status}: ${text.slice(0, 200)}`);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("z.ai usage вернул невалидный JSON");
  }
  const body = payload as { success?: boolean; msg?: unknown; code?: unknown };
  if (body.success === false || (body.code != null && body.code !== 200)) {
    throw new Error(`z.ai API ошибка: ${typeof body.msg === "string" && body.msg ? body.msg : "unknown"}`);
  }
  return parseQuota(payload);
}

export function formatReset(resetAt?: number, now: number = Date.now()): string {
  if (!resetAt || !Number.isFinite(resetAt)) return "сброс неизвестен";

  const deltaSeconds = Math.max(0, Math.round((resetAt - now) / 1000));
  const days = Math.floor(deltaSeconds / 86400);
  const hours = Math.floor((deltaSeconds % 86400) / 3600);
  const minutes = Math.floor((deltaSeconds % 3600) / 60);
  const date = new Date(resetAt).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  const parts: string[] = [];
  if (days) parts.push(`${days} д`);
  if (hours) parts.push(`${hours} ч`);
  parts.push(`${minutes} мин`);
  return `сброс через ${parts.join(" ")} (${date})`;
}

export function formatQuota(quota: Quota, now: number = Date.now()): string {
  const reached = quota.windows.some((window) => window.percentage >= 100);
  const lines = [`z.ai: ${reached ? "лимит достигнут" : "доступен"} · план ${quota.level ?? "unknown"}`];
  for (const window of quota.windows) {
    const left = Math.max(0, 100 - window.percentage);
    lines.push(`${window.label}: осталось ${left}% (${window.used}/${window.total}), ${formatReset(window.resetAt, now)}`);
  }
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("zai-usage", {
    description: "Show Z.ai GLM Coding Plan quota using the pi z.ai API key",
    handler: async (_args, ctx) => {
      try {
        const credential = await readZaiCredential();
        const quota = await fetchQuota(credential.key, credential.url);
        ctx.ui.notify(formatQuota(quota), "info");
      } catch (error) {
        ctx.ui.notify(`zai-usage failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
