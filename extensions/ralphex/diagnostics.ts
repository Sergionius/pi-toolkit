const SECRET_KEY = /^(?:authorization|access[_-]?token|refresh[_-]?token|api[_-]?key|token|password|secret|client[_-]?secret)$/i;

/** Best effort only: source code and arbitrary tool output may still be sensitive. */
export function redactDiagnostic(text: string, depth = 0): string {
  for (const [key, value] of Object.entries(process.env)) {
    if (/token|secret|password|api_?key|credential/i.test(key) && value && value.length >= 4) text = text.split(value).join("[REDACTED]");
  }
  if (depth < 12) {
    try {
      const parsed = JSON.parse(text);
      if (parsed !== null && (typeof parsed === "object" || typeof parsed === "string")) {
        return JSON.stringify(redactValue(parsed, depth + 1));
      }
    } catch { /* Plain text or incomplete JSON; use the fallback below. */ }
    if (text.includes("\n")) return text.split("\n").map((line) => redactDiagnostic(line, depth + 1)).join("\n");
  }
  return text.replace(/(Bearer\s+)[^\s"'\\]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)(?:\\*["'])?\s*[:=]\s*(?:\\*["'])?)[^\s"'\\,}]+/gi, "$1[REDACTED]");
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactDiagnostic(value, depth);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key, SECRET_KEY.test(key) ? "[REDACTED]" : redactValue(item, depth + 1),
  ]));
  return value;
}
