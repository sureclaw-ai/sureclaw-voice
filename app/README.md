# SureClaw Voice — PWA source

React/Vite PWA for calling OpenClaw from the browser over WebRTC. This is the
**source** for the app; the built output is committed at the repo root under
`webapp/` and served by the `sureclaw-voice` OpenClaw plugin.

Deployment, plugin install, and gateway auth config live in the [root
README](../README.md).

## Local dev

```bash
npm install
npm run dev -- --port 5173
```

Open http://localhost:5173. The Gateway URL defaults to the page's own origin;
for a local gateway, open Settings (gear icon) and set:

- WebSocket URL: `ws://127.0.0.1:18789` (e.g. via `ssh -N -L 18789:127.0.0.1:18789 <host>`)
- A gateway token, if the gateway uses `auth.mode: "token"`.

When the gateway runs behind Cloudflare Access (trusted-proxy mode), no token is
needed — the call just connects.

## Build

```bash
npm run build      # → app/dist
```

From the repo root, `npm run build:app` builds this and stages it into `../webapp/`.

## How a call works

1. Connect to the gateway WebSocket (same origin).
2. `browserVoice.create` mints an OpenAI Realtime WebRTC session from the
   plugin's own realtime voice config (`plugins.entries.sureclaw-voice.config.realtime`).
3. The browser runs the WebRTC call directly with the realtime provider;
   `openclaw_agent_consult` tool calls are forwarded back through the gateway
   (`talk.client.toolCall`) so the voice agent can use the full OpenClaw agent.

## WebRTC reliability (TURN)

Calls use public STUN by default (fine on Wi-Fi). On mobile/5G a TURN relay is
recommended — configure it under the plugin's `webrtc` config (see root README);
the plugin mints short-lived credentials per session.
