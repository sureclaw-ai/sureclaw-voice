# Installing SureClaw Voice

**This is a runbook for an OpenClaw agent installing this plugin on behalf of its
operator.** If you are a human, you can follow it too — but it's written so your
agent can drive the whole install and only stop to ask you the few things it
can't decide on its own.

SureClaw Voice lets the operator **call their OpenClaw from a browser** over
WebRTC. The plugin serves a small voice PWA from the gateway's own HTTP server
and connects its WebSocket back to the **same origin**, so one HTTPS endpoint in
front of the gateway port handles everything.

---

## Step 0 — Make a TODO list first

Before doing anything else, create a tracked TODO list so every step is visible
and nothing is skipped. Use these items (prune the ones that don't apply once you
know the operator's setup):

1. Confirm the gateway is reachable over the web at an HTTPS origin (the one hard
   requirement).
2. Detect existing web-access paths (Cloudflare Tunnel, Tailscale, reverse proxy)
   and present options to the operator.
3. Install and enable the plugin; restart the gateway.
4. Configure the plugin — ask the operator for **voice** and **name**, apply the
   defaults for everything else.
5. Wire up authentication to match the chosen access path (token vs Cloudflare
   Access).
6. Offer TURN (Cloudflare) contextually, based on whether the operator already
   uses Cloudflare.
7. Verify: open the app, tap Call, confirm two-way audio.

Keep this list updated as you go — mark items in-progress and done so the
operator can follow along.

---

## Step 1 — The one hard requirement: HTTPS over the web

A browser will not grant microphone access except in a **secure context**, so the
app must be served over **HTTPS** and connect its WebSocket over **WSS**. The
gateway itself speaks plain HTTP/WS — you need a TLS terminator in front of its
port, reachable from wherever the operator will make calls.

First, find the gateway's HTTP port (the app and WebSocket share it). Check
`openclaw.json` for `gateway.port` (or the `OPENCLAW_GATEWAY_PORT` env var); if
unset, ask the operator or check what the gateway logs on startup. The local dev
rig uses `18789` as an example.

Then investigate what's already on the box. **Don't assume — gather evidence**
and run these (adapt to the platform; this assumes the gateway host):

```bash
# Cloudflare Tunnel (cloudflared)
which cloudflared && cloudflared --version
ls -la ~/.cloudflared 2>/dev/null
pgrep -fl cloudflared
systemctl status cloudflared 2>/dev/null || launchctl list 2>/dev/null | grep -i cloudflare

# Tailscale (funnel = public HTTPS, serve = tailnet-only HTTPS)
which tailscale && tailscale status
tailscale funnel status 2>/dev/null
tailscale serve status 2>/dev/null

# Reverse proxy / own TLS termination
which caddy nginx 2>/dev/null
ls /etc/letsencrypt/live 2>/dev/null
# What's already listening, and is there a public IP?
ss -tlnp 2>/dev/null || lsof -iTCP -sTCP:LISTEN -n -P 2>/dev/null
curl -s https://ifconfig.me; echo
```

Interpret the evidence:

- **cloudflared present / a tunnel already running** → Cloudflare Tunnel is the
  easiest path and gives free HTTPS. Strong default.
- **tailscale present** → `tailscale funnel` gives a public HTTPS URL;
  `tailscale serve` gives HTTPS reachable only inside the operator's tailnet
  (perfect if they only call from their own devices, and more private).
- **caddy/nginx + a public IP / domain** → they can terminate TLS themselves and
  reverse-proxy to the gateway port.
- **nothing** → recommend installing `cloudflared` (quickest to a working HTTPS
  URL) or Tailscale.

---

## Step 2 — Present access options to the operator

Summarize what you found and present the realistic options, **recommending the
one that best fits their existing setup** (least new moving parts wins). For each,
the end state is the same: an HTTPS origin in front of the gateway port, with WSS
to the same origin. Example framing:

> You'll need to reach your OpenClaw over the web with HTTPS so the browser will
> let you use the mic. Based on your box, here are your options:
>
> - **Cloudflare Tunnel** *(recommended — you already have `cloudflared`)*: free
>   HTTPS, no port-forwarding, and it pairs with Cloudflare Access for
>   token-free auth later.
> - **Tailscale Funnel / Serve**: public HTTPS (Funnel) or tailnet-only HTTPS
>   (Serve) if you only call from your own devices.
> - **Your own reverse proxy**: Caddy/nginx terminating TLS to the gateway port.

Let the operator pick. Whatever they choose, note the **public hostname** — you'll
need it for the auth config in Step 5. If they don't have one yet, that's fine:
proceed with the install and use a placeholder hostname, then come back and fill
it in once the tunnel/proxy is up.

---

## Step 3 — Install the plugin

```bash
openclaw plugins install git:github.com/sureclaw-ai/sureclaw-voice@main
openclaw plugins enable sureclaw-voice
# restart the gateway service
```

The plugin id is `sureclaw-voice`, so its config lives at
`plugins.entries.sureclaw-voice` in `openclaw.json`. The install ships prebuilt
artifacts (`dist/` and `webapp/`) — no build step runs on install.

---

## Step 4 — Configure: ask for voice + name, default the rest

**Ask the operator for these two things; everything else gets a sensible default.**

1. **Voice** — offer the OpenAI realtime voices and let them pick:
   `alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse`,
   `marin`, `cedar`. Recommend `alloy` if they have no preference. Point them at
   the voice guide to hear the differences:
   <https://sureclaw.com.au/guides/choosing-an-openai-realtime-voice>.
2. **Name** — the display name shown in the title and on the Call button (e.g.
   their agent's name). Optional; defaults to `OpenClaw`.

You also need a realtime **provider** and its credential. Default to `openai`;
the OpenAI realtime provider reads `OPENAI_API_KEY` from the environment, or you
can set it under `providers.openai.apiKey`.

Then apply this config — the **good default**: it makes the voice surface a full
proxy for the operator's own agent (persona, workspace files, memory all wired
in). Don't make the operator decide on any of the rest; just set it.

```jsonc
"plugins": {
  "entries": {
    "sureclaw-voice": {
      "enabled": true,
      "config": {
        "realtime": {
          "enabled": true,
          "provider": "openai",
          "voice": "alloy",            // ← the voice the operator picked
          "consultPolicy": "always",   // full OpenClaw agent proxy — delegate everything
          "toolPolicy": "owner",
          "agentContext": {
            "enabled": true,
            "includeIdentity": true,         // name/theme/emoji from agent config
            "includeWorkspaceFiles": true,   // the profile files below
            "files": ["SOUL.md", "IDENTITY.md", "USER.md"],
            "maxChars": 6000
          },
          "fastContext": {
            "enabled": true,                 // adds a fast_context quick-recall tool
            "timeoutMs": 800,
            "maxResults": 3,
            "sources": ["memory", "sessions"]
          },
          "providers": {
            "openai": { "apiKey": "sk-…" }   // or rely on OPENAI_API_KEY in the env
          }
        },
        "webapp": {
          "path": "/voice"             // mount path; app is served at https://<host>/voice
          // "name": "Acme"            // ← the name the operator picked
        }
      }
    }
  }
}
```

Restart the gateway after writing the config. Without a usable `realtime.provider`,
`browserVoice.create` returns `UNAVAILABLE` and calls won't connect.

---

## Step 5 — Authentication (match it to the access choice)

The plugin embeds no credential — the gateway authenticates the WebSocket. Pick
the mode that matches Step 2:

**A. Token** — simplest, good for a single operator / dev use. Keep
`gateway.auth.mode: "token"`, then open the app's **Settings** once and paste the
gateway token.

**B. Cloudflare Access (recommended if they chose Cloudflare)** — no token
anywhere. Put a Cloudflare Access policy on the hostname and run the gateway in
trusted-proxy mode:

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

- Remove `OPENCLAW_GATEWAY_TOKEN` / `gateway.auth.token` — trusted-proxy and a
  shared token are **mutually exclusive** (the gateway won't start with both).
- `controlUi.allowedOrigins` **must** include the page origin (`https://<host>`),
  or the gateway rejects the WebSocket with "Browser origin not allowed".
- `dangerouslyDisableDeviceAuth` is required here and is safe **only** because
  Cloudflare Access is the sole gate — never expose the gateway without Access in
  front. See the README's Authentication section for the full rationale.

---

## Step 6 — TURN relay (offer it contextually)

A TURN relay makes calls reliable on mobile/5G and restrictive networks where
plain peer-to-peer WebRTC fails. It's optional — without it, calls fall back to
public STUN and work fine on most home/office networks. Cloudflare provides TURN.

**Read the situation before asking:**

- **They already use Cloudflare** (chose Cloudflare Tunnel/Access above, or are
  clearly Cloudflare-proficient) → **just recommend it** — they're already in the
  ecosystem and it's a few minutes of work.
- **They don't use Cloudflare** → **propose it lightly** as an optional reliability
  upgrade for mobile, and only set it up if they want it. Don't push them into
  Cloudflare just for this.

If they go for it:

1. In the Cloudflare dashboard, create a **TURN key** (Realtime / Calls → TURN)
   and copy its **Key ID**.
2. Create an API token authorized for the TURN key and export it on the gateway
   host as `CF_TURN_API_TOKEN` (the secret stays in the env, never in config).
3. Add the key id to the plugin config:

   ```jsonc
   "webrtc": {
     "cloudflareTurn": { "keyId": "…", "ttlSeconds": 86400 }
   }
   ```

The gateway mints short-lived TURN credentials per session; the long-lived key
never reaches the browser. If `CF_TURN_API_TOKEN` is missing, the plugin logs a
warning and skips TURN (calls still proceed on public STUN), so this fails soft.

For any other provider (self-hosted coturn, Twilio, etc.), pass static servers via
`webrtc.iceServers` instead.

---

## Step 7 — Verify

1. Open `https://<host>/voice` in a browser.
2. In token mode, paste the gateway token in **Settings** once.
3. Tap **Call**, allow microphone access, and confirm two-way audio — say
   something that requires the agent (e.g. ask about a recent memory) to confirm
   the consult path works, not just the voice model.

Mark the TODO list complete and summarize for the operator: the access URL, the
auth mode, and whether TURN is on.
