#!/usr/bin/env bash
set -euo pipefail

if ! CLAUDE_BIN="$(command -v claude)"; then
  echo "ask-claude: Claude Code CLI was not found on PATH. Install it and run 'claude auth status'." >&2
  exit 127
fi

prompt="$(cat)"
if [[ -z "${prompt//[[:space:]]/}" ]]; then
  echo "ask-claude: prompt is empty" >&2
  exit 2
fi

model="${ASK_CLAUDE_MODEL:-opus}"
effort="${ASK_CLAUDE_EFFORT:-high}"
stdout_file="$(mktemp -t ask-claude-stdout.XXXXXX)"
stderr_file="$(mktemp -t ask-claude-stderr.XXXXXX)"
trap 'rm -f "$stdout_file" "$stderr_file"' EXIT

set +e
"$CLAUDE_BIN" -p \
  --model "$model" \
  --effort "$effort" \
  --permission-mode plan \
  --no-session-persistence \
  --no-chrome \
  --strict-mcp-config \
  --mcp-config '{"mcpServers":{}}' \
  --output-format json \
  "$prompt" </dev/null >"$stdout_file" 2>"$stderr_file"
code=$?
set -e

if [[ $code -ne 0 ]]; then
  details="$(head -c 4000 "$stderr_file")"
  if [[ -z "$details" && -s "$stdout_file" ]]; then
    details="$(python3 - "$stdout_file" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        payload = json.load(handle)
    print(payload.get("result") or payload.get("error") or str(payload))
except Exception:
    with open(sys.argv[1], encoding="utf-8", errors="replace") as handle:
        print(handle.read(4000))
PY
)"
  fi
  if [[ -n "$details" ]]; then
    printf 'ask-claude: Claude Code exited with status %s: %s\n' "$code" "$details" >&2
  else
    printf 'ask-claude: Claude Code exited with status %s\n' "$code" >&2
  fi
  exit "$code"
fi

python3 - "$stdout_file" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        payload = json.load(handle)
except json.JSONDecodeError as error:
    print(f"ask-claude: Claude Code returned invalid JSON: {error}", file=sys.stderr)
    raise SystemExit(3)

if not isinstance(payload, dict) or "result" not in payload:
    print("ask-claude: Claude Code JSON response does not contain 'result'", file=sys.stderr)
    raise SystemExit(3)

result = payload["result"]
if isinstance(result, str):
    print(result)
elif isinstance(result, (dict, list)):
    print(json.dumps(result, ensure_ascii=False, indent=2))
else:
    print("ask-claude: Claude Code result has an unsupported type", file=sys.stderr)
    raise SystemExit(3)
PY
