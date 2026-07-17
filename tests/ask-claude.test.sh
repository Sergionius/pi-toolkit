#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILL="$ROOT/skills/ask-claude/SKILL.md"
WRAPPER="$ROOT/skills/ask-claude/scripts/ask-claude.sh"
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
mkdir -p "$TEMP/bin"

cat > "$TEMP/bin/claude" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\0' "$@" > "$MOCK_CLAUDE_ARGS"
wc -c < /dev/stdin | tr -d ' ' > "$MOCK_CLAUDE_STDIN_BYTES"
case "${MOCK_CLAUDE_MODE:-success}" in
  success)
    printf '%s\n' '{"result":"Claude fixture analysis"}'
    ;;
  object)
    printf '%s\n' '{"result":{"verdict":"approve","findings":[]}}'
    ;;
  malformed)
    printf '%s\n' 'not-json'
    ;;
  failure)
    echo 'fixture CLI failure' >&2
    exit 42
    ;;
  *)
    exit 99
    ;;
esac
MOCK
chmod +x "$TEMP/bin/claude"
chmod +x "$WRAPPER"

export MOCK_CLAUDE_ARGS="$TEMP/args.bin"
export MOCK_CLAUDE_STDIN_BYTES="$TEMP/stdin-bytes.txt"

output="$(printf '%s' 'focused prompt with spaces' | PATH="$TEMP/bin:$PATH" "$WRAPPER")"
[[ "$output" == "Claude fixture analysis" ]]
[[ "$(cat "$MOCK_CLAUDE_STDIN_BYTES")" == "0" ]]

python3 - "$MOCK_CLAUDE_ARGS" <<'PY'
import sys
args = [value.decode() for value in open(sys.argv[1], "rb").read().split(b"\0") if value]

def value(flag):
    return args[args.index(flag) + 1]

assert "-p" in args
assert value("--model") == "opus"
assert value("--effort") == "high"
assert value("--permission-mode") == "plan"
assert "--no-session-persistence" in args
assert "--no-chrome" in args
assert "--strict-mcp-config" in args
assert value("--mcp-config") == "{}"
assert value("--output-format") == "json"
assert args[-1] == "focused prompt with spaces"
PY

ASK_CLAUDE_MODEL=sonnet ASK_CLAUDE_EFFORT=xhigh \
  output="$(printf '%s' 'override prompt' | PATH="$TEMP/bin:$PATH" ASK_CLAUDE_MODEL=sonnet ASK_CLAUDE_EFFORT=xhigh "$WRAPPER")"
[[ "$output" == "Claude fixture analysis" ]]
python3 - "$MOCK_CLAUDE_ARGS" <<'PY'
import sys
args = [value.decode() for value in open(sys.argv[1], "rb").read().split(b"\0") if value]
assert args[args.index("--model") + 1] == "sonnet"
assert args[args.index("--effort") + 1] == "xhigh"
PY

output="$(printf '%s' 'review prompt' | PATH="$TEMP/bin:$PATH" MOCK_CLAUDE_MODE=object "$WRAPPER")"
grep -q '"verdict": "approve"' <<<"$output"

set +e
output="$(printf '%s' 'bad response' | PATH="$TEMP/bin:$PATH" MOCK_CLAUDE_MODE=malformed "$WRAPPER" 2>&1)"
code=$?
set -e
[[ $code -eq 3 ]]
grep -q 'invalid JSON' <<<"$output"

set +e
output="$(printf '%s' 'failing request' | PATH="$TEMP/bin:$PATH" MOCK_CLAUDE_MODE=failure "$WRAPPER" 2>&1)"
code=$?
set -e
[[ $code -eq 42 ]]
grep -q 'fixture CLI failure' <<<"$output"

set +e
output="$(printf '   ' | PATH="$TEMP/bin:$PATH" "$WRAPPER" 2>&1)"
code=$?
set -e
[[ $code -eq 2 ]]
grep -q 'prompt is empty' <<<"$output"

set +e
output="$(printf '%s' 'availability check' | PATH="/usr/bin:/bin" "$WRAPPER" 2>&1)"
code=$?
set -e
[[ $code -eq 127 ]]
grep -q 'not found on PATH' <<<"$output"

python3 - "$SKILL" "$WRAPPER" <<'PY'
import re
import sys

text = open(sys.argv[1], encoding="utf-8").read()
assert text.startswith("---\n")
frontmatter = text.split("---\n", 2)[1]
name = re.search(r"^name:\s*(.+)$", frontmatter, re.MULTILINE).group(1).strip()
description = re.search(r"^description:\s*(.+)$", frontmatter, re.MULTILINE).group(1).strip()
assert name == "ask-claude"
assert 0 < len(description) <= 1024
assert "--permission-mode plan" in text
wrapper = open(sys.argv[2], encoding="utf-8").read()
assert "--permission-mode plan" in wrapper
assert "--dangerously-skip-permissions" not in wrapper
PY

bash -n "$WRAPPER"
printf 'ask-claude wrapper tests: OK\n'
