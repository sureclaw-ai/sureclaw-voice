#!/usr/bin/env bash
# Starts the Vite dev server for the voice PWA with hot module replacement.
# Run this IN A SEPARATE TERMINAL alongside ./gateway.sh so that:
#   - the gateway serves the WS API + agent/realtime backend on :18789
#   - Vite serves the PWA on :5173 with instant HMR on edits to app/src/**
#
# Because the PWA talks to the gateway by WS, you must point the app at the
# gateway URL from the in-app Settings:
#   Gateway URL:  ws://127.0.0.1:18789
# (the page's own origin on http://localhost:5173 is not a ws:// URL, so the
# same-origin fallback in App.tsx does not apply — set it manually once.)
#
# Auth is "none" on the gateway, so leave the token field empty.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/app"

# Vite reads this from app/package.json; resolve it through the repo's pnpm.
exec "$ROOT/node_modules/.bin/pnpm" exec vite --host 127.0.0.1 --port 5173 "$@"
