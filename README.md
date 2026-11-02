# SureClaw Voice

An OpenClaw plugin that lets you **call your OpenClaw from the browser** using
OpenAI Realtime or xAI Grok Voice. The plugin serves a small voice PWA from the
gateway's own HTTP server and mints browser realtime voice sessions, so a
**single origin** handles both the HTTPS page and the WSS gateway connection —
put cloudflared (or any HTTPS terminator) in front of the gateway port and
you're done.

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

`realtime.path` selects the implementation. It defaults to `"legacy"`, so
existing OpenAI Realtime and xAI installations keep their current behavior.

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
          "path": "legacy",              // default when omitted
          "enabled": true,
          "provider": "openai",          // a registered realtime voice provider
          "model": "gpt-realtime-2.1",     // required — no provider default
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

### GPT-Live engine

OpenClaw 2026.9.4+ can run OpenAI's full-duplex
[GPT-Live](https://developers.openai.com/api/docs/models/gpt-live-1) through
native Talk. The browser only does microphone/speaker WebRTC (SDP brokered by
the gateway at `/plugins/openai/realtime/calls`); OpenClaw owns the GPT-Live
control channel, delegates work to the real agent (tools, memory, the same
session), and persists the transcript itself.

Select it with `path` and a `gptLive` block; the legacy settings can stay in
place so switching back is a one-line `path` change:

```jsonc
"realtime": {
  "enabled": true,
  "provider": "openai",
  "model": "gpt-realtime-2.1",     // legacy engine (unchanged)
  "voice": "marin",
  "path": "gpt-live",              // engine: "legacy" (default) | "gpt-live"
  "gptLive": {
    "model": "gpt-live-1",         // or "gpt-live-1-codex"; omit to let OpenClaw choose
    "voice": "marin"
  }
}
```

For a GPT-Live-only deployment, set `"path": "gpt-live"` with a `gpt-live-*`
top-level `model`/`voice` and no `gptLive` block.

| Model | Auth | Billing | Voices (OpenClaw 2026.10) |
| --- | --- | --- | --- |
| `gpt-live-1` | OpenAI Platform key (`OPENAI_API_KEY` / `openai` api-key profile) | $0.05/min + agent model | alloy, ash, ballad, cedar, coral, echo, marin (default), sage, shimmer, verse, quartz & ripple (Australian), vesper, willow, stone, gleam, meridian, bossa, tempo, beacon, delta, cinder |
| `gpt-live-1-codex` | ChatGPT OAuth (`openclaw models auth login --provider openai`), Platform key fallback | ChatGPT subscription | arbor, breeze, cove (default), ember, juniper, maple, sol, spruce, vale |

Behaviour worth knowing:

- **Full duplex.** The mic streams continuously and the model decides when to
  speak, yield, or backchannel ("mhm"). The PWA runs no local VAD and never ducks
  playback — interruptions and overlap are the model's job.
- **Delegation.** GPT-Live hands substantive requests to the OpenClaw agent
  (`talk-realtime-consult-*` runs on the call's session) and keeps talking while
  it works; the PWA shows "Working on it… / Running <tool>…" and the pending cue
  fills any silence. High-impact tool calls wait for a spoken "yes".
- **Voices.** A voice the host doesn't list for the model silently becomes the
  model default; the PWA logs the substitution. The newer voices (OpenAI's
  2026-10-16 additions, Codex v3 voices such as `himari`) need a newer OpenClaw.
- **Limits.** OpenClaw caps a GPT-Live session at 30 minutes; the PWA reconnects
  with the same voice session id so the agent session and accepted work carry on.
- **Not used by GPT-Live:** `consultPolicy`, `toolPolicy`, `agentContext`,
  `fastContext`, `instructions` — native Talk uses `talk.realtime.*`
  (`instructions`, `consultThinkingLevel`, …) and the agent's own context.
- Don't set a custom OpenAI `baseUrl` for Talk — OpenClaw then falls back to
  `gpt-realtime-2.1`.

### xAI Grok Voice alternative

Use `provider: "xai"` to connect the browser directly to the [xAI Voice Agent
API](https://docs.x.ai/developers/model-capabilities/audio/voice-agent) over its
PCM WebSocket transport. The gateway exchanges `XAI_API_KEY` for a short-lived
client secret; the long-lived API key is never sent to the browser.

```jsonc
"realtime": {
  "enabled": true,
  "provider": "xai",
  "model": "grok-voice-latest",
  "voice": "eve",
  "consultPolicy": "always",
  "toolPolicy": "owner",
  "agentContext": { "enabled": true },
  "fastContext": { "enabled": true },
  "providers": {
    "xai": {
      // "apiKey": "xai-…",              // or set XAI_API_KEY in the gateway env
      // "reasoningEffort": "high",      // "high" or "none"
      // "baseUrl": "https://api.x.ai/v1"
    }
  }
}
```

xAI's built-in voice IDs are `eve` (default), `ara`, `rex`, `sal`, and `leo`;
custom voice IDs are also accepted. `grok-voice-latest` tracks xAI's current
recommended voice model; use `grok-voice-think-fast-1.0` to pin the current
version. TURN configuration applies only to OpenAI's WebRTC transport and is
ignored for xAI's direct WebSocket transport.

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

> **`sessions` in `fastContext.sources` is not enough on its own.** That list is
> only the *request* passed into the memory search — the builtin manager then
> filters it down to the sources it actually **indexes**
> (`searchSources = requested.filter(s => this.sources.has(s))`). Two separate
> things gate `sessions`, both in the top-level **`agents.defaults.memorySearch`**
> section (not this plugin's config):
>
> 1. **`sources` must include `sessions`** — defaults to `["memory"]` only, so
>    `sessions` is dropped before the search runs if you don't add it.
> 2. **`experimental.sessionMemory: true`** — session memory is an experimental
>    flag (default `false`). `normalizeSources()` **silently strips `sessions`**
>    from the indexed set unless this is on, so adding it to `sources` alone is a
>    no-op.
>
> ```jsonc
> "agents": {
>   "defaults": {
>     "memorySearch": {
>       "sources": ["memory", "sessions"],
>       "experimental": { "sessionMemory": true }
>     }
>   }
> }
> ```
>
> Session transcripts are indexed on gateway (re)start and embedded one chunk at a
> time, so the first index of a large history takes a while — watch
> the manager's `Sources:` line and chunk count grow to confirm `sessions` is
> actually indexing before expecting `fast_context` to return session hits.

## Authentication

The plugin serves only the static page (no credential is embedded). The gateway
authenticates the WebSocket.

On OpenClaw 2026.10+ a browser UI client needs either a **paired device
identity** or a **trusted-proxy identity grant** to keep any operator scopes —
`controlUi.dangerouslyDisableDeviceAuth` is retired and ignored. The PWA signs
its connect with a per-browser Ed25519 key (non-extractable, in IndexedDB),
exactly like the bundled Control UI, except behind a trusted proxy where the
proxy identity is the credential.

### A. Token (simple / single operator)

Keep `gateway.auth.mode: "token"`. Open the app's Settings once and paste the
gateway token. The first call from each browser fails with
`pairing required — approve this device on the gateway host with: openclaw devices approve <requestId>`;
approve it once (`openclaw devices list` shows pending requests) and call again.

### B. Cloudflare Access (recommended for customers — no token anywhere)

Put a Cloudflare Access policy on the hostname and run the gateway in
trusted-proxy mode so it trusts the Access-authenticated identity, granting
scopes per Access email:

```jsonc
"gateway": {
  "auth": {
    "mode": "trusted-proxy",
    "trustedProxy": { "userHeader": "cf-access-authenticated-user-email", "allowLoopback": true },
    "identityScopes": {
      "owner@example.com": ["operator.admin"]
    }
  },
  "trustedProxies": ["127.0.0.1", "::1", "::ffff:127.0.0.1"],
  "controlUi": {
    "allowedOrigins": ["https://<host>"]
  }
}
```

Notes:
- Remove `OPENCLAW_GATEWAY_TOKEN` / `gateway.auth.token` — trusted-proxy and a
  shared token are **mutually exclusive** (the gateway won't start with both).
- `trustedProxies` must include the loopback address cloudflared connects from.
- `controlUi.allowedOrigins` must include the page origin, or the gateway rejects
  the WebSocket with "Browser origin not allowed".
- `identityScopes` is **required**: without a grant the connection keeps no
  scopes and every method fails with "missing scope". Keys match the Access email
  case-insensitively. `operator.admin` gives owner-level agent consults and the
  legacy transcript bridge (`chat.inject`); `["operator.write"]` is enough for
  non-owner consults, and `["operator.talk"]` limits GPT-Live delegation to
  safe read-only tools.
- This is safe **only** because Cloudflare Access is the sole gate — never
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
