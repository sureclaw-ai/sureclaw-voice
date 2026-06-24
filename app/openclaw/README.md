# sureclaw-voice — local test rig

Run the sureclaw-voice plugin end-to-end against the OpenAI realtime backend
over localhost. The gateway serves the voice PWA at `/voice/` and links the
plugin from this repo so edits to `index.ts` / `app/src/**` take effect on the
next rebuild.

## Prerequisites

- Node 24+, pnpm, and a built repo (`pnpm install` at the repo root).
- `OPENAI_API_KEY` exported — used for both the realtime voice session (browser
  WebRTC ephemeral token) and the `openclaw_agent_consult` tool backend.

## Quick start

```bash
export OPENAI_API_KEY=sk-...
cd app/openclaw
./gateway.sh
```

Then open **http://localhost:18789/voice/** in your browser. Auth is `none` on
loopback, so no token is needed — just tap Call.

The `build.sh` step that runs first will (re)build `dist/index.js` (the plugin
runtime) and `webapp/` (the PWA) if their sources are newer than the artifacts.
Pass `--force` to rebuild unconditionally: `./build.sh --force`.

## Hot reload (optional)

Full plugin hot reload isn't supported — the runtime entry is loaded once at
gateway startup, so editing `index.ts` requires restarting `gateway.sh`.
The `webapp/` served at `/voice/` is also a static build, so PWA edits need a
rebuild too.

For live PWA HMR while developing the web app, run Vite against the source tree
in a second terminal:

```bash
./dev-app.sh            # separate terminal — serves the PWA on :5173
./gateway.sh            # keeps the WS / realtime backend on :18789
```

Open **http://localhost:5173/** and, in the in-app Settings, set:

- **Gateway URL:** `ws://127.0.0.1:18789`
- **Token:** _(leave empty — auth is `none`)_

The PWA's `__APP_*__` tokens fall back to safe defaults when raw Vite serves
`index.html`, so the page renders without the gateway's token substitution.

## Layout

```
app/openclaw/
  openclaw.json     # gateway + plugin + realtime config (env-substituted)
  build.sh          # builds dist/ and webapp/ if stale (--force to rebuild)
  gateway.sh       # launches `openclaw gateway run` on loopback :18789
  dev-app.sh        # launches Vite for the PWA with HMR on :5173
  .state/           # OPENCLAW_STATE_DIR (gitignored)
```

## Configuration knobs

`openclaw.json` uses `${VAR}` expansion resolved by the gateway at load time:

- `${SURECLAW_VOICE_ROOT}` — set by `gateway.sh` to the repo root; used as the
  `plugins.load.paths` entry so the plugin loads from `dist/index.js`.
- `${OPENAI_API_KEY}` — your OpenAI key; used for realtime + consult.

Common overrides (pass as flags to `gateway.sh`, forwarded to `openclaw
gateway run`):

```bash
./gateway.sh --port 18800        # change the port
./gateway.sh --verbose           # chatty logs
./gateway.sh --help              # full flag list
```

For persistent local overrides that you don't want in git, copy the file to
`openclaw.local.json` (gitignored) and point at it:

```bash
OPENCLAW_CONFIG_PATH=app/openclaw/openclaw.local.json ./gateway.sh
```
