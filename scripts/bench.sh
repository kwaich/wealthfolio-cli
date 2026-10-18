#!/usr/bin/env bash
# Measures how much each read command prints, as a Markdown table: what an
# agent pays to read it. Tokens are estimated as bytes / 4.
#
#   scripts/bench.sh            # dist/wf.js against the seeded server
#   scripts/bench.sh <git-ref>  # also builds <git-ref> and compares
#
# Needs a server seeded by scripts/bench-seed.sh (it reuses its login), and a
# build (pnpm build). Runs only reads, so it can run any number of times.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export WF_CONFIG_DIR="${WF_BENCH_CONFIG_DIR:-$ROOT/.bench}"
NEW="$ROOT/dist/wf.js"
[ -f "$NEW" ] || { echo "Run pnpm build first." >&2; exit 2; }
[ -d "$WF_CONFIG_DIR" ] || { echo "Run scripts/bench-seed.sh first." >&2; exit 2; }

BASE=""
if [ -n "${1:-}" ]; then
  TREE="$(mktemp -d)"
  trap 'git -C "$ROOT" worktree remove --force "$TREE" >/dev/null 2>&1 || true' EXIT
  git -C "$ROOT" worktree add -q --detach "$TREE" "$1"
  ln -s "$ROOT/node_modules" "$TREE/node_modules"
  (cd "$TREE" && pnpm -s build >/dev/null)
  BASE="$TREE/dist/wf.js"
fi

account() {
  node "$NEW" accounts | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const a=JSON.parse(s).find((x)=>x.name===process.argv[1]); console.log(a ? a.id : "")})' "$1"
}
BROKER="$(account Brokerage)"
[ -n "$BROKER" ] || { echo "No Brokerage account. Run scripts/bench-seed.sh first." >&2; exit 2; }

# label|arguments. <broker> is replaced by the Brokerage account id.
COMMANDS=(
  "status|status"
  "accounts|accounts"
  "holdings|holdings"
  "holdings --account|holdings --account <broker>"
  "holdings --full|holdings --full"
  "activity search|activity search"
  "activity search --page-size 100|activity search --page-size 100"
  "activity search --full|activity search --full"
  "health|health"
  "budget|budget --period 2025-11"
  "budget --full|budget --period 2025-11 --full"
  "spending report|spending report --from 2025-11-01 --to 2025-11-30"
  "spending report --full|spending report --from 2025-11-01 --to 2025-11-30 --full"
  "commands|commands"
  "schema create_activity|schema create_activity"
  "--help|--help"
)

# Bytes on stdout, or "exit N" when the command fails.
measure() {
  local bin=$1 out code
  shift
  set +e
  out="$(node "$bin" "$@" 2>/dev/null | wc -c)"
  code=${PIPESTATUS[0]}
  set -e
  if [ "$code" != 0 ]; then echo "exit $code"; else echo "$out"; fi
}

cell() { case $1 in exit*) echo "$1" ;; *) echo "$1 (~$(($1 / 4)))" ;; esac; }

if [ -n "$BASE" ]; then
  echo "| Command | $1 bytes (~tokens) | dist bytes (~tokens) | Change |"
  echo "| --- | ---: | ---: | ---: |"
else
  echo "| Command | Bytes (~tokens) |"
  echo "| --- | ---: |"
fi
for entry in "${COMMANDS[@]}"; do
  label="${entry%%|*}"
  read -r -a args <<<"${entry#*|}"
  args=("${args[@]/<broker>/$BROKER}")
  now="$(measure "$NEW" "${args[@]}")"
  if [ -n "$BASE" ]; then
    before="$(measure "$BASE" "${args[@]}")"
    change=""
    case "$before$now" in
      *exit*) ;;
      *) [ "$before" -gt 0 ] && change="$(((now - before) * 100 / before))%" ;;
    esac
    echo "| \`$label\` | $(cell "$before") | $(cell "$now") | $change |"
  else
    echo "| \`$label\` | $(cell "$now") |"
  fi
done
