#!/usr/bin/env bash
# Starts the OpenClaw gateway on localhost with the sureclaw-voice plugin
# linked in and the voice PWA served at /voice/.
#
# Requires:
#   OPENAI_API_KEY  — used by the realtime provider (browser WebRTC sessions)
#                     and the agent consult backend. Export it or put it in
#                     app/openclaw/.env.
#
# Port handling: defaults to 18789. If it's already taken (e.g. a stale
# gateway from a crashed session), the script auto-picks the next free port
# starting from 18790 so you never get an EADDRINUSE failure. Override the
# starting port with OPENCLAW_PORT, or pass --port to pin it explicitly.
#
# Open the page at the URL printed by the gateway (http://localhost:<port>/voice/).
# Auth is "none" on loopback, so no token is needed.
#
# Flags (after the script name) are forwarded to `openclaw gateway run`, e.g.:
#   ./gateway.sh --verbose
#   ./gateway.sh --port 18800      # pin a specific port (no auto-pick)
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$HERE/../.." && pwd)"
STATE="$HERE/.state"

# Auto-load secrets from a gitignored .env if present (overrides the shell env).
if [[ -f "$HERE/.env" ]]; then
  set -o allexport
  # shellcheck disable=SC1091
  source "$HERE/.env"
  set +o allexport
fi

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  echo "⚠️  OPENAI_API_KEY is not set — realtime voice sessions and agent" >&2
  echo "   consults will fail at runtime. Set it first, e.g.:" >&2
  echo "     export OPENAI_API_KEY=sk-..." >&2
  echo "   The gateway will still start (the key is only resolved lazily)." >&2
fi

# Ensure the plugin runtime + built PWA exist so /voice actually serves.
bash "$HERE/build.sh"

mkdir -p "$STATE"

# The gateway loads plugins from this absolute path; the bundled openclaw binary
# is vendored at the repo root via pnpm.
export SURECLAW_VOICE_ROOT="$ROOT"
export OPENCLAW_CONFIG_PATH="$HERE/openclaw.json"
export OPENCLAW_STATE_DIR="$STATE"

# Pick a free loopback port unless the caller pinned one with --port.
port_taken() { nc -z 127.0.0.1 "$1" 2>/dev/null; }
pick_port() {
  local p start
  start="${OPENCLAW_PORT:-18789}"
  p="$start"
  while (( p < 65536 )); do
    if ! port_taken "$p"; then echo "$p"; return 0; fi
    p=$((p + 1))
  done
  echo "no free port found starting at $start" >&2
  return 1
}

GW_ARGS=(--bind loopback --auth none --dev)
if [[ " $* " == *" --port "* ]]; then
  GW_ARGS+=("$@")          # caller pinned a port — use it verbatim
else
  GW_PORT="$(pick_port)"
  GW_ARGS+=("--port" "$GW_PORT" "$@")
  echo "▶ gateway → http://127.0.0.1:$GW_PORT/voice/  (override: --port / OPENCLAW_PORT)" >&2
fi

exec "$ROOT/node_modules/.bin/openclaw" gateway run "${GW_ARGS[@]}"
