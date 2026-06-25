# SureClaw Voice

An OpenClaw plugin that lets you **call your OpenClaw from the browser** over
WebRTC. The plugin serves a small voice PWA from the gateway's own HTTP server
and mints browser realtime voice sessions, so a **single origin** handles both
the HTTPS page and the WSS gateway connection — put cloudflared (or any HTTPS
terminator) in front of the gateway port and you're done.

- App at `https://<host>/voice`, WebSocket back to `wss://<host>` — same origin.
- Realtime voice config lives in the plugin's own config under
  `plugins.entries.sureclaw-voice.config.realtime` (provider, model, voice,
  instructions, tool/consult policy, an agent persona/context capsule, and a
  fast-context recall tool).
- The plugin does **no auth** — the gateway authenticates the WebSocket itself.

## Agent installation prompt

Hand the install to your OpenClaw agent — paste this:

```
You will be installing the OpenClaw plugin [SureClaw Voice](https://github.com/sureclaw-ai/sureclaw-voice)
It is a browser based voice interface to call your OpenClaw without and with higher quality than a phone number.
For proper instructions, read [INSTALLATION.md](https://github.com/sureclaw-ai/sureclaw-voice/blob/main/INSTALLATION.md)
```

## Install

```bash
openclaw plugins install git:github.com/sureclaw-ai/sureclaw-voice@main
openclaw plugins enable sureclaw-voice
# restart the gateway service
```

The plugin id is `sureclaw-voice`, so it lives at
`plugins.entries.sureclaw-voice` in `openclaw.json`.

### Plugin config

A complete, current config (`plugins.entries.sureclaw-voice` in `openclaw.json`).
Everything is optional except a usable `realtime.provider` — without one,
`browserVoice.create` returns `UNAVAILABLE`.

```jsonc
"plugins": {
  "entries": {
    "sureclaw-voice": {
      "enabled": true,
      "config": {
        "realtime": {
          "enabled": true,
          "provider": "openai",          // a registered realtime voice provider
          "model": "gpt-realtime-2",     // provider default if omitted
          "voice": "alloy",              // provider default if omitted
          "toolPolicy": "owner",         // safe-read-only | owner | none
          // consultPolicy is the behavioral dial:
          //   "always"     (default) full OpenClaw agent proxy — delegate everything
          //   "auto"/"substantive"    consult only on substantive turns
          //   "never"                 pure voice; no OpenClaw, no consult tool
          "consultPolicy": "always",
          // "instructions": "…",        // override the base voice instructions

          // Persona/identity capsule injected into the voice instructions so the
          // agent sounds like *your* agent. Opt-in via enabled.
          "agentContext": {
            "enabled": true,
            "includeIdentity": true,            // name/theme/emoji from agent config
            "includeWorkspaceFiles": true,      // the profile files below
            "files": ["SOUL.md", "IDENTITY.md", "USER.md"],
            "maxChars": 6000
          },

          // Fast context: exposes a `fast_context` tool the model can call for
          // quick recall from memory and past sessions, answered with no agent
          // run (see "Two consult tools" below). When disabled, only the full
          // openclaw_agent_consult tool is offered.
          "fastContext": {
            "enabled": true,
            "timeoutMs": 800,                  // deadline for the lookup
            "maxResults": 3,                   // max snippets returned
            "sources": ["memory", "sessions"]
          },

          // Provider-specific config, keyed by provider id. The OpenAI realtime
          // provider also reads OPENAI_API_KEY from the environment.
          "providers": {
            "openai": { "apiKey": "sk-…" }
          }
        },

        "webapp": {
          "path": "/voice"               // mount path (default "/voice")
          // "name": "Acme"              // title + Call-button label
        },

        "webrtc": {                      // optional TURN relay for mobile/5G
          // The TURN API token is read from the CF_TURN_API_TOKEN env var.
          "cloudflareTurn": { "keyId": "…", "ttlSeconds": 86400 }
        }
      }
    }
  }
}
```

> **Two consult tools.** When `fastContext.enabled`, the voice model is given
> two tools and chooses between them: **`fast_context`** — a bounded memory/
> session lookup owned by this plugin (`browserVoice.consult`), answered with no
> agent run; and **`openclaw_agent_consult`** — the full OpenClaw agent via the
> gateway's core Talk consult. `fast_context` never escalates on its own; if it
> finds nothing the model decides whether to then call `openclaw_agent_consult`.
> When `fastContext` is disabled, only `openclaw_agent_consult` is exposed.
>
> The full consult's `consultThinkingLevel` / `consultFastMode` are read from the
> top-level **`talk`** section (e.g. `"talk": { "consultThinkingLevel": "low" }`),
> not from this plugin's `realtime` block.

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
