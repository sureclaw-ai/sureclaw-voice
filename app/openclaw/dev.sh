#!/usr/bin/env bash
# One-command dev rig (think foreman): runs the gateway and the Vite HMR server
# in parallel, with prefixed, interleaved logs and clean teardown on Ctrl-C.
#
#   gateway  → localhost:<auto>   (WS / realtime / agent backend, PWA at /voice/)
#   vite     → localhost:<auto>   (PWA with HMR)
#
# Both ports auto-bump to the next free one if taken (stale process? no
# EADDRINUSE). The picked gateway URL is injected into Vite as
# VITE_GATEWAY_URL, so the PWA targets the right WS automatically — no manual
# Settings override needed. Override the start ports with OPENCLAW_PORT /
# VITE_PORT.
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$HERE/../.." && pwd)"

if [[ -f "$HERE/.env" ]]; then
  set -o allexport; source "$HERE/.env"; set +o allexport
fi
if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  echo "⚠️  OPENAI_API_KEY is not set (export it or put it in app/openclaw/.env)" >&2
fi

port_taken() { nc -z 127.0.0.1 "$1" 2>/dev/null; }
pick_port() {
  local p start
  start="${1:-5173}"
  p="$start"
  while (( p < 65536 )); do
    if ! port_taken "$p"; then echo "$p"; return 0; fi
    p=$((p + 1))
  done
  echo "no free port found starting at $start" >&2
  return 1
}

PIDS=()
cleanup() {
  echo
  echo "→ shutting down (gateway + vite on :$GW_PORT / :$VITE_PORT)"
  # Kill whatever holds our picked ports first — robust against pipelines
  # (killing the wrapper subshell can otherwise leave the gateway node / vite
  # grandchild orphaned on the port, causing EADDRINUSE on the next run).
  for port in "$GW_PORT" "$VITE_PORT"; do
    for pid in $(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null); do
      kill "$pid" 2>/dev/null || true
    done
  done
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Pick the gateway port up front so we can (a) pin it on the gateway and (b)
# inject it into Vite so the PWA's WS lands on the right backend.
GW_PORT="$(pick_port "${OPENCLAW_PORT:-18789}")"
VITE_PORT="$(pick_port "${VITE_PORT:-5173}")"
export VITE_GATEWAY_URL="ws://127.0.0.1:${GW_PORT}"

echo "▶ gateway → http://127.0.0.1:${GW_PORT}/voice/   (PWA will WS to ws://127.0.0.1:${GW_PORT})"
echo "▶ vite    → http://127.0.0.1:${VITE_PORT}/"

# Gateway: build if stale, then run with the pinned port. Pass --port to bypass
# gateway.sh's own auto-pick.
GW_ARGS=(--port "$GW_PORT")
[[ -z "${OPENCLAW_VERBOSE+x}" ]] && GW_ARGS+=(--verbose)
( bash "$HERE/gateway.sh" "${GW_ARGS[@]}" 2>&1 | sed -u 's/^/[gateway] /' ) &
PIDS+=($!)

# Give the gateway a beat so the WS backend is up before Vite starts.
sleep 3

# Vite: PWA with HMR. VITE_GATEWAY_URL is picked up by App.tsx's defaultGatewayUrl.
( cd "$ROOT/app"; pnpm exec vite --host 127.0.0.1 --port "$VITE_PORT" 2>&1 | sed -u 's/^/[vite]    /' ) &
PIDS+=($!)

wait
