import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveRealtimeBootstrapContextInstructions } from "openclaw/plugin-sdk/realtime-bootstrap-context";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL,
  resolveConfiguredRealtimeVoiceProvider,
  resolveRealtimeVoiceAgentConsultToolPolicy,
} from "openclaw/plugin-sdk/realtime-voice";

type BrowserVoiceParams = {
  sessionKey?: string;
  agentId?: string;
};

type DiscordRealtimeConfig = {
  enabled?: boolean;
  provider?: string;
  providers?: Record<string, unknown>;
  model?: string;
  voice?: string;
  mode?: string;
  instructions?: string;
  consultPolicy?: string;
  toolPolicy?: string;
  bootstrapContextFiles?: string[];
  // voice-call's equivalent of bootstrapContextFiles. Normalized into
  // bootstrapContextFiles when sourcing realtime config from voice-call.
  agentContext?: { enabled?: boolean; files?: string[] };
  minBargeInAudioEndMs?: number;
};

type IceServerConfig = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

// WebRTC relay configuration. Each Gateway operator supplies their own here
// ("bring your own"); nothing is baked into the app. `cloudflareTurn` mints
// short-lived TURN credentials per session from a Cloudflare TURN key, while
// `iceServers` is a static passthrough escape hatch for any other STUN/TURN
// provider (self-hosted coturn, Twilio, etc.).
type WebRtcConfig = {
  iceServers?: IceServerConfig[];
  cloudflareTurn?: {
    keyId?: string;
    // Provide the API token directly, or name an env var to read it from so the
    // secret stays out of openclaw.json.
    apiToken?: string;
    apiTokenEnv?: string;
    ttlSeconds?: number;
  };
};

// Static web-app serving. When the built PWA (the Vite `dist/`) is shipped
// alongside this plugin, the gateway serves it directly so a single origin
// handles both the HTTPS page and the WebSocket — no separate static host.
type WebappConfig = {
  // Disable serving entirely (default: served when the assets are present).
  enabled?: boolean;
  // Mount path on the gateway (default "/voice"). The page connects its
  // WebSocket back to the same origin's root, so this only affects the page URL.
  path?: string;
  // Absolute path to the built assets. Defaults to the `webapp/` directory
  // shipped next to this plugin (populated by `npm run build:webapp`).
  dir?: string;
};

type PluginConfig = {
  webrtc?: WebRtcConfig;
  webapp?: WebappConfig;
};

type RuntimeConfig = {
  channels?: {
    discord?: {
      voice?: {
        mode?: string;
        realtime?: DiscordRealtimeConfig;
      };
    };
  };
  plugins?: {
    entries?: Record<
      string,
      { config?: { webrtc?: WebRtcConfig; realtime?: DiscordRealtimeConfig } }
    >;
  };
};

const PLUGIN_ID = "sureclaw-voice";
const VOICE_CALL_PLUGIN_ID = "voice-call";

// Resolves the realtime voice config the browser session should use. Realtime
// config is attached per transport, so we fall back across the known sources:
//   1. voice-call's realtime block — the shared config used for phone calls
//      (read-only; the browser session inherits the same proven settings).
//   2. channels.discord.voice.realtime — the legacy Discord voice surface.
// voice-call stores its bootstrap context under agentContext.files, so that is
// normalized into bootstrapContextFiles for the shared instruction builder.
function resolveBrowserRealtimeConfig(
  cfg: RuntimeConfig,
): { realtimeConfig: DiscordRealtimeConfig; mode: string; source: string } | undefined {
  const voiceCall = cfg.plugins?.entries?.[VOICE_CALL_PLUGIN_ID]?.config?.realtime;
  if (voiceCall && voiceCall.enabled !== false) {
    return { realtimeConfig: normalizeRealtimeConfig(voiceCall), mode: "agent-proxy", source: VOICE_CALL_PLUGIN_ID };
  }

  const discord = cfg.channels?.discord?.voice?.realtime;
  if (discord) {
    return {
      realtimeConfig: normalizeRealtimeConfig(discord),
      mode: normalizeDiscordVoiceMode(cfg.channels?.discord?.voice?.mode),
      source: "discord",
    };
  }

  return undefined;
}

function normalizeRealtimeConfig(realtime: DiscordRealtimeConfig): DiscordRealtimeConfig {
  return {
    ...realtime,
    bootstrapContextFiles: realtime.bootstrapContextFiles ?? realtime.agentContext?.files,
  };
}

const entry = definePluginEntry({
  id: "sureclaw-voice",
  name: "SureClaw Voice",
  description:
    "Serves the voice web app and mints browser WebRTC realtime sessions from the configured realtime voice config (voice-call, falling back to Discord voice).",

  // Plugin config schema. The relay (STUN/TURN) settings live here under the
  // plugin's own `config` slot rather than in the host realtime block, which
  // rejects unknown keys.
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      webrtc: {
        type: "object",
        additionalProperties: false,
        properties: {
          iceServers: { type: "array" },
          cloudflareTurn: {
            type: "object",
            additionalProperties: false,
            properties: {
              keyId: { type: "string" },
              apiToken: { type: "string" },
              apiTokenEnv: { type: "string" },
              ttlSeconds: { type: "number" },
            },
          },
        },
      },
      webapp: {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean" },
          path: { type: "string" },
          dir: { type: "string" },
        },
      },
    },
  },

  register(api) {
    registerWebappRoute(api);

    api.registerGatewayMethod("browserVoice.create", async ({ params, respond, context }) => {
      const typedParams = normalizeParams(params);
      if (!typedParams) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "browserVoice.create requires a string sessionKey",
        });
        return;
      }

      try {
        const cfg = context.getRuntimeConfig() as RuntimeConfig;
        const resolved = resolveBrowserRealtimeConfig(cfg);
        if (!resolved) {
          respond(false, undefined, {
            code: "UNAVAILABLE",
            message:
              "No realtime voice config found — configure plugins.entries.voice-call.config.realtime or channels.discord.voice.realtime",
          });
          return;
        }
        const realtimeConfig = resolved.realtimeConfig;

        const resolution = resolveConfiguredRealtimeVoiceProvider({
          configuredProviderId: realtimeConfig.provider,
          providerConfigs: buildProviderConfigs(realtimeConfig),
          providerConfigOverrides: buildProviderConfigOverrides(realtimeConfig),
          cfg,
          defaultModel: realtimeConfig.model,
          noRegisteredProviderMessage: "No configured realtime voice provider registered",
        });

        if (!resolution.provider.createBrowserSession) {
          respond(false, undefined, {
            code: "UNAVAILABLE",
            message: `Realtime provider "${resolution.provider.id}" does not support browser WebRTC sessions`,
          });
          return;
        }

        const mode = resolved.mode;
        const toolPolicy = resolveRealtimeVoiceAgentConsultToolPolicy(
          realtimeConfig.toolPolicy,
          mode === "agent-proxy" ? "owner" : "safe-read-only",
        );
        const consultPolicy = realtimeConfig.consultPolicy ?? (mode === "agent-proxy" ? "always" : "auto");
        const bootstrapContextInstructions = await resolveBootstrapContext({
          cfg,
          realtimeConfig,
          sessionKey: typedParams.sessionKey,
          agentId: typedParams.agentId,
        });

        const session = await resolution.provider.createBrowserSession({
          cfg,
          providerConfig: resolution.providerConfig,
          instructions: buildDiscordRealtimeInstructions({
            mode,
            instructions: realtimeConfig.instructions,
            bootstrapContextInstructions,
            toolPolicy,
            consultPolicy,
          }),
          tools: toolPolicy === "none" ? [] : [REALTIME_VOICE_AGENT_CONSULT_TOOL],
          model: realtimeConfig.model,
          voice: realtimeConfig.voice,
        });

        const iceServers = await resolveIceServers(cfg.plugins?.entries?.[PLUGIN_ID]?.config?.webrtc);
        respond(true, iceServers ? { ...session, iceServers } : session, undefined);
      } catch (error) {
        respond(false, undefined, {
          code: "UNAVAILABLE",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  },
});

export default entry;

const DEFAULT_WEBAPP_MOUNT = "/voice";

const WEBAPP_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

// Serves the built voice PWA (Vite `dist/`) from the gateway's own HTTP server
// so a single origin handles both the HTTPS page and the operator WebSocket.
// Fails soft: if the assets are absent the route is simply not registered.
function registerWebappRoute(api: {
  pluginConfig?: PluginConfig;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
  registerHttpRoute: (params: {
    path: string;
    auth: "plugin" | "gateway";
    match?: "exact" | "prefix";
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean | void> | boolean | void;
  }) => void;
}) {
  const webapp = api.pluginConfig?.webapp;
  if (webapp?.enabled === false) return;

  const dir = resolveWebappDir(webapp?.dir);
  if (!dir) {
    api.logger?.warn?.(
      "sureclaw-voice: voice web app not served — no built assets found. " +
        "Build the PWA and stage it into the plugin's webapp/ directory (npm run build), " +
        "or set plugins.entries.sureclaw-voice.config.webapp.dir.",
    );
    return;
  }

  // Serve-only: the gateway authenticates the WebSocket itself (token or
  // trusted-proxy/Cloudflare Access). The page carries no credential.
  const mount = normalizeWebappMount(webapp?.path ?? DEFAULT_WEBAPP_MOUNT);
  api.registerHttpRoute({
    path: mount,
    auth: "plugin",
    match: "prefix",
    handler: (req, res) => serveWebappFile(req, res, mount, resolvePath(dir)),
  });
  api.logger?.info?.(`sureclaw-voice: serving voice web app at ${mount}/`);
}

// Locates the built web app. Honors an explicit `dir`, otherwise looks next to
// this module — handling both the linked dev layout (index.ts at the package
// root → ./webapp) and the installed layout (compiled dist/index.js → ../webapp).
function resolveWebappDir(configDir?: string): string | undefined {
  if (configDir) {
    const dir = resolvePath(configDir);
    return existsSync(resolvePath(dir, "index.html")) ? dir : undefined;
  }
  for (const rel of ["./webapp/", "../webapp/"]) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(resolvePath(dir, "index.html"))) return dir;
  }
  return undefined;
}

function normalizeWebappMount(path: string): string {
  let mount = path.trim();
  if (!mount.startsWith("/")) mount = `/${mount}`;
  while (mount.length > 1 && mount.endsWith("/")) mount = mount.slice(0, -1);
  return mount;
}

async function serveWebappFile(
  req: IncomingMessage,
  res: ServerResponse,
  mount: string,
  root: string,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;

  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = decodeURIComponent(url.pathname);

  // Redirect the bare mount to a trailing slash so the relative asset URLs in
  // index.html resolve under the mount (…/voice/assets/… not /assets/…).
  if (pathname === mount) {
    res.statusCode = 301;
    res.setHeader("Location", `${mount}/${url.search}`);
    res.end();
    return true;
  }

  let rel = pathname.slice(mount.length);
  if (rel.startsWith("/")) rel = rel.slice(1);
  if (rel === "") rel = "index.html";

  let filePath = resolvePath(root, rel);
  // Path-traversal guard: the resolved file must stay within the asset root.
  if (filePath !== root && !filePath.startsWith(root + sep)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return true;
  }

  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    // A missing asset (a path with an extension) is a genuine 404; any other
    // path falls back to index.html so client-side routing/deep links work.
    if (extname(rel)) {
      res.statusCode = 404;
      res.end("Not found");
      return true;
    }
    filePath = resolvePath(root, "index.html");
  }

  const contentType = WEBAPP_CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
  res.statusCode = 200;
  res.setHeader("Content-Type", contentType);
  // Cache hashed assets hard; keep the plain HTML shell / service worker fresh.
  res.setHeader(
    "Cache-Control",
    filePath.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
  );

  if (method === "HEAD") {
    res.end();
    return true;
  }
  res.end(await readFile(filePath));
  return true;
}

// Resolves the ICE (STUN/TURN) servers handed to the browser for this session.
// Combines any static `iceServers` with freshly minted Cloudflare TURN
// credentials. Fails soft: a misconfigured or unreachable TURN provider logs a
// warning and is skipped, so the call still proceeds on the client's built-in
// public STUN rather than failing to mint.
async function resolveIceServers(webrtc?: WebRtcConfig): Promise<IceServerConfig[] | undefined> {
  if (!webrtc) return undefined;

  const servers: IceServerConfig[] = [];
  if (Array.isArray(webrtc.iceServers)) {
    servers.push(...webrtc.iceServers.filter((server) => Boolean(server?.urls)));
  }

  const cf = webrtc.cloudflareTurn;
  if (cf?.keyId) {
    const apiToken = cf.apiToken || (cf.apiTokenEnv ? readEnv(cf.apiTokenEnv) : undefined);
    if (!apiToken) {
      console.warn(
        "sureclaw-voice: cloudflareTurn.keyId is set but no apiToken/apiTokenEnv resolved; skipping TURN.",
      );
    } else {
      try {
        const generated = await generateCloudflareTurn(cf.keyId, apiToken, cf.ttlSeconds ?? 86400);
        if (generated) servers.push(generated);
      } catch (error) {
        console.warn(
          `sureclaw-voice: Cloudflare TURN credential generation failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  return servers.length > 0 ? servers : undefined;
}

// Mints short-lived TURN credentials from a Cloudflare TURN key. The long-lived
// key (keyId + apiToken) never leaves the server; only the expiring credentials
// reach the browser.
async function generateCloudflareTurn(
  keyId: string,
  apiToken: string,
  ttlSeconds: number,
): Promise<IceServerConfig | undefined> {
  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl: ttlSeconds }),
    },
  );

  if (!response.ok) {
    throw new Error(`Cloudflare TURN API responded ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    iceServers?: { urls?: string | string[]; username?: string; credential?: string };
  };
  const ice = data.iceServers;
  if (!ice?.urls) return undefined;
  return { urls: ice.urls, username: ice.username, credential: ice.credential };
}

function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.[name];
}

function normalizeParams(value: unknown): BrowserVoiceParams | undefined {
  if (!value || typeof value !== "object") return undefined;
  const params = value as Record<string, unknown>;
  const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
  if (!sessionKey) return undefined;
  const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
  return { sessionKey, agentId: agentId || "main" };
}

async function resolveBootstrapContext(params: {
  cfg: RuntimeConfig;
  realtimeConfig: DiscordRealtimeConfig;
  sessionKey: string;
  agentId?: string;
}) {
  const files = params.realtimeConfig.bootstrapContextFiles;
  if (files?.length === 0) return undefined;
  try {
    return await resolveRealtimeBootstrapContextInstructions({
      config: params.cfg,
      agentId: params.agentId || "main",
      sessionKey: params.sessionKey,
      files,
      warn: (message) => console.warn(`sureclaw-voice: realtime bootstrap context: ${message}`),
    });
  } catch (error) {
    console.warn(
      `sureclaw-voice: realtime bootstrap context unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

function normalizeDiscordVoiceMode(mode: unknown) {
  if (mode === "stt-tts" || mode === "bidi") return mode;
  return "agent-proxy";
}

function buildProviderConfigs(realtimeConfig: DiscordRealtimeConfig) {
  const configs = realtimeConfig.providers;
  return configs && Object.keys(configs).length > 0 ? { ...configs } : undefined;
}

function buildProviderConfigOverrides(realtimeConfig: DiscordRealtimeConfig) {
  const overrides = {
    ...(realtimeConfig.model ? { model: realtimeConfig.model } : {}),
    ...(realtimeConfig.voice ? { voice: realtimeConfig.voice } : {}),
    ...(typeof realtimeConfig.minBargeInAudioEndMs === "number"
      ? { minBargeInAudioEndMs: realtimeConfig.minBargeInAudioEndMs }
      : {}),
  };
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function buildDiscordRealtimeInstructions(params: {
  mode: string;
  instructions?: string;
  bootstrapContextInstructions?: string;
  toolPolicy: string;
  consultPolicy: string;
}) {
  const base =
    params.instructions ??
    ["You are OpenClaw's Discord voice interface.", "Keep spoken replies concise, natural, and suitable for a live Discord voice channel."].join(
      "\n",
    );
  const consultPolicyInstructions = buildConsultPolicyInstructions(params.toolPolicy, params.consultPolicy);

  if (params.mode === "agent-proxy") {
    return [
      base,
      params.bootstrapContextInstructions?.trim(),
      "Mode: OpenClaw agent proxy.",
      "You are the realtime voice surface for the same OpenClaw agent the user can message directly.",
      "Do not mention a backend, supervisor, helper, or separate system. Present the result as your own work.",
      "Delegate substantive requests, actions, tool work, current facts, memory, workspace context, and user-specific context with openclaw_agent_consult.",
      "Do not block, refuse, or downscope at the voice layer. Delegate to OpenClaw and treat its result as authoritative.",
      "Answer directly only for greetings, acknowledgements, brief latency tests, or filler while waiting.",
      'While waiting for OpenClaw data or tool results, use at most one short natural backchannel such as "yeah", "mm-hmm", "got it", or "one sec"; vary it and do not treat it as the final answer.',
      "When OpenClaw sends an internal exact answer to speak, do not call tools. Say only that answer.",
      consultPolicyInstructions,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  return [
    base,
    params.bootstrapContextInstructions?.trim(),
    'While waiting for OpenClaw data or tool results, use at most one short natural backchannel such as "yeah", "mm-hmm", "got it", or "one sec"; vary it and do not treat it as the final answer.',
    consultPolicyInstructions,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildConsultPolicyInstructions(toolPolicy: string, consultPolicy: string) {
  const policyLines = [
    toolPolicy === "none"
      ? "No OpenClaw agent consult tool is available in this session."
      : "Use openclaw_agent_consult for requests that need the OpenClaw agent, tools, actions, current project state, memory, or deeper reasoning.",
  ];

  if (consultPolicy === "always") {
    policyLines.push("For substantive user turns, call openclaw_agent_consult before giving the final spoken answer.");
  } else if (consultPolicy === "auto") {
    policyLines.push("For simple greetings or short acknowledgements, answer directly. For anything substantive, consult OpenClaw first.");
  }

  if (toolPolicy === "safe-read-only") {
    policyLines.push("The consult tool may be limited to safe read-only work.");
  } else if (toolPolicy === "owner") {
    policyLines.push("The consult tool may perform owner-authorized OpenClaw work according to the server policy.");
  }

  return policyLines.join(" ");
}
