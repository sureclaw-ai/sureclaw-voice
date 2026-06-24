#!/usr/bin/env bash
# Builds the sureclaw-voice plugin (dist/index.js) and the voice PWA
# (webapp/index.html) so the gateway can load the runtime entry and serve the
# page from /voice. Skips a step if its artifact is already present and newer
# than its sources — pass --force to rebuild regardless.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
FORCE=false
if [[ "${1:-}" == "--force" || "${1:-}" == "-f" ]]; then FORCE=true; fi

cd "$ROOT"

newer() {
  # newer <candidate> <source...> — true if candidate is older than any source
  local cand="$1"; shift
  [[ -e "$cand" ]] || return 0
  local s
  for s in "$@"; do
    if [[ -e "$s" ]] && [[ "$s" -nt "$cand" ]]; then return 0; fi
  done
  return 1
}

# --- Plugin runtime: index.ts -> dist/index.js ---
if $FORCE || newer "dist/index.js" "index.ts" "rolldown.config.ts" "package.json"; then
  echo "→ building plugin (dist/index.js)"
  pnpm run build:plugin
else
  echo "✓ plugin up to date (dist/index.js)"
fi

# --- PWA: app/ -> webapp/ ---
APP_SRCS=()
while IFS= read -r f; do APP_SRCS+=("$f"); done < <( \
  find app/src app/index.html app/vite.config.ts app/sw-plugin.ts app/package.json app/tsconfig.json \
       -type f 2>/dev/null )
if $FORCE || newer "webapp/index.html" "${APP_SRCS[@]}"; then
  echo "→ building voice PWA (webapp/)"
  pnpm run build:app
else
  echo "✓ voice PWA up to date (webapp/index.html)"
fi

echo "done. artifacts:"
echo "  $ROOT/dist/index.js"
echo "  $ROOT/webapp/index.html"
