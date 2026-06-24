# SureClaw Voice

An OpenClaw plugin that lets you **call your OpenClaw from the browser** over
WebRTC. The plugin serves a small voice PWA from the gateway's own HTTP server
and mints browser realtime voice sessions, so a **single origin** handles both
the HTTPS page and the WSS gateway connection — put cloudflared (or any HTTPS
terminator) in front of the gateway port and you're done.

- App at `https://<host>/voice`, WebSocket back to `wss://<host>` — same origin.
- Realtime voice config lives in the plugin's own config under
  `plugins.entries.sureclaw-voice.config.realtime` (provider, model, voice,
  instructions, tool/consult policy).
- The plugin does **no auth** — the gateway authenticates the WebSocket itself.

## Install

```bash
openclaw plugins install git:github.com/sureclaw-ai/sureclaw-voice@main
openclaw plugins enable sureclaw-voice
# restart the gateway service
```

The plugin id is `sureclaw-voice`, so it lives at
`plugins.entries.sureclaw-voice` in `openclaw.json`.

### Plugin config (all optional)

```jsonc
"plugins": {
  "entries": {
    "sureclaw-voice": {
      "enabled": true,
      "config": {
        "webapp": {
          "path": "/voice"            // mount path (default "/voice")
          // "dir": "/abs/path/to/dist" // override the bundled web app
          // "enabled": false           // don't serve the page at all
        },
        "webrtc": {                    // optional TURN relay for mobile/5G
          "cloudflareTurn": { "keyId": "…", "apiTokenEnv": "CF_TURN_API_TOKEN", "ttlSeconds": 86400 }
        }
      }
    }
  }
}
```

## Authentication

The plugin serves only the static page (no credential is embedded). The gateway
authenticates the WebSocket. Two supported deployments:

### A. Token (simple / single operator)

Keep `gateway.auth.mode: "token"`. Open the app's Settings once and paste the
gateway token. Fine for personal/dev use.

### B. Cloudflare Access (recommended for customers — no token anywhere)

Put a Cloudflare Access policy on the hostname and run the gateway in
trusted-proxy mode so it trusts the Access-authenticated identity:

```jsonc
"gateway": {
  "auth": {
    "mode": "trusted-proxy",
    "trustedProxy": { "userHeader": "cf-access-authenticated-user-email", "allowLoopback": true }
  },
  "trustedProxies": ["127.0.0.1", "::1", "::ffff:127.0.0.1"],
  "controlUi": {
    "allowedOrigins": ["https://<host>"],
    "dangerouslyDisableDeviceAuth": true
  }
}
```

Notes:
- Remove `OPENCLAW_GATEWAY_TOKEN` / `gateway.auth.token` — trusted-proxy and a
  shared token are **mutually exclusive** (the gateway won't start with both).
- `trustedProxies` must include the loopback address cloudflared connects from.
- `controlUi.allowedOrigins` must include the page origin, or the gateway rejects
  the WebSocket with "Browser origin not allowed".
- `dangerouslyDisableDeviceAuth` is **required** here: trusted-proxy establishes
  identity, but operator **scopes** otherwise only bind to a paired device, so
  without it every method fails with "missing scope". It is safe **only** because
  Cloudflare Access is the sole gate and there is no token to steal — never
  expose the gateway without Access in front. The gateway binds to loopback and
  is reachable only through cloudflared, and Cloudflare strips client-supplied
  `Cf-Access-*` headers, so a bypass cannot forge identity.

## Repo layout

```
/                     the plugin package (installed from git)
  openclaw.plugin.json  manifest (id: sureclaw-voice)
  package.json          openclaw.runtimeExtensions → ./dist/index.js
  index.ts              plugin source
  dist/index.js         compiled plugin entry (committed — installs run no build)
  webapp/               built voice PWA (committed — served at the mount path)
  app/                  the PWA source (React + Vite)
```

## Develop / rebuild

The committed `dist/` and `webapp/` are the install artifacts; regenerate them
before committing:

```bash
npm install          # esbuild for the plugin build
npm run build        # builds app/ → webapp/, and index.ts → dist/index.js
```

- `npm run build:app` — `cd app && npm install && vite build` → copies to `webapp/`
- `npm run build:plugin` — esbuild `index.ts` → `dist/index.js`

Local dev of the PWA: `cd app && npm run dev` (see `app/README.md`).
