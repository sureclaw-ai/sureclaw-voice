import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAgentIdentity } from "openclaw/plugin-sdk/agent-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  REALTIME_BOOTSTRAP_CONTEXT_FILE_NAMES,
  type RealtimeBootstrapContextFileName,
  resolveRealtimeBootstrapContextInstructions,
} from "openclaw/plugin-sdk/realtime-bootstrap-context";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  type RealtimeVoiceFastContextConfig,
  type RealtimeVoiceProviderPlugin,
  type RealtimeVoiceTool,
  resolveConfiguredRealtimeVoiceProvider,
  resolveRealtimeVoiceAgentConsultToolPolicy,
  resolveRealtimeVoiceFastContextConsult,
} from "openclaw/plugin-sdk/realtime-voice";

type BrowserVoiceParams = {
  sessionKey?: string;
  agentId?: string;
};

type RealtimeVoiceConfig = {
  enabled?: boolean;
  // Voice engine. Omitted/"legacy" preserves the plugin's existing
  // browser-owned OpenAI Realtime and xAI paths. "gpt-live" delegates the
  // control channel, tools, and transcript lifecycle to native OpenClaw Talk
  // and is restricted to OpenAI gpt-live-* models.
  path?: "legacy" | "gpt-live";
  // GPT-Live engine settings, used when `path` is "gpt-live", so the legacy
  // provider/model/voice above can stay configured for switching back.
  // Without it, `path: "gpt-live"` reads the top-level model/voice instead.
  gptLive?: GptLiveConfig;
  provider?: string;
  providers?: Record<string, unknown>;
  model?: string;
  voice?: string;
  instructions?: string;
  // "always" (default) | "auto" | "substantive" | "never". See the consult
  // policy handling in the browserVoice.create handler.
  consultPolicy?: string;
  toolPolicy?: string;
  // Low-latency memory/session lookup tried before the full agent consult.
  // Consumed by the browserVoice.consult gateway method. All fields optional;
  // defaults mirror the host realtime config (disabled unless enabled:true).
  fastContext?: Partial<RealtimeVoiceFastContextConfig>;
  // Legacy: a bare list of profile files folded into the realtime instructions.
  // Superseded by `agentContext`; still honored when `agentContext` is absent so
  // existing configs keep working. See resolveAgentContext.
  bootstrapContextFiles?: string[];
  agentContext?: AgentContextConfig;
  minBargeInAudioEndMs?: number;
};

type GptLiveConfig = {
  enabled?: boolean;
  // gpt-live-1 (OpenAI Platform key, $/min) or gpt-live-1-codex (ChatGPT
  // OAuth). Omit to let OpenClaw choose from the credentials it has.
  model?: string;
  voice?: string;
};

type VoiceEngine = {
  engine: "legacy" | "gpt-live";
  gptLive?: { model: string; voice: string };
};

// Bounded agent persona/context capsule injected into realtime voice
// instructions. Mirrors the host `realtime.agentContext` block so a browser
// voice agent can sound like the configured agent (identity + profile files)
// rather than a generic assistant. Opt-in via `enabled`, matching the host.
type AgentContextConfig = {
  enabled?: boolean;
  // Hard cap on capsule characters appended to the instructions. Default 6000.
  maxChars?: number;
  // Include configured agent identity fields (name/theme/emoji). Default true.
  includeIdentity?: boolean;
  // Include profile files (SOUL.md/IDENTITY.md/USER.md). Default true.
  includeWorkspaceFiles?: boolean;
  // Profile files to include. Constrained to the SDK's allowed set; anything
  // else is dropped with a warning. Defaults to the full allowed set.
  files?: string[];
};

const DEFAULT_AGENT_CONTEXT_MAX_CHARS = 6000;

type IceServerConfig = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

// WebRTC relay configuration. Each Gateway operator supplies their own here
// ("bring your own"); nothing is baked into the app. `cloudflareTurn` mints
// short-lived TURN credentials per session from a Cloudflare TURN key, while
// `iceServers` is a static passthrough escape hatch for any other STUN/TURN
// provider (self-hosted coturn, Twilio, etc.). The TURN API token is always
// read from the CF_TURN_API_TOKEN env var so the secret never lives in config.
type WebRtcConfig = {
  iceServers?: IceServerConfig[];
  cloudflareTurn?: {
    keyId?: string;
    ttlSeconds?: number;
  };
};

// Env var holding the Cloudflare TURN API token. Fixed by design — the operator
// sets keyId in config and exports the secret here; we never read it from config.
const CF_TURN_API_TOKEN_ENV = "CF_TURN_API_TOKEN";

// Static web-app serving. When the built PWA (the Vite `dist/`) is shipped
// alongside this plugin, the gateway serves it directly so a single origin
// handles both the HTTPS page and the WebSocket — no separate static host.
type WebappConfig = {
  // Mount path on the gateway (default "/voice"). The page connects its
  // WebSocket back to the same origin's root, so this only affects the page URL.
  // The PWA is the whole plugin, so serving cannot be disabled and the assets
  // are always the bundled ones — only the mount path is configurable.
  path?: string;
  // Display name shown in the page title, manifest, and the Call button.
  // Defaults to "OpenClaw" (full name "OpenClaw Voice").
  name?: string;
  // Whether, on hang-up, the client also runs one agent turn to store memories
  // from the call (via chat.send). Off by default: the transcript is always
  // appended to the session silently (via chat.inject — no agent turn, no reply),
  // and that session is already a recall source and dreamable, so per-call memory
  // extraction is opt-in. Turn this on to have the agent actively write memories
  // at the end of every call (costs one agent turn per call).
  recordMemoriesOnCallEnd?: boolean;
};

type PluginConfig = {
  webrtc?: WebRtcConfig;
  webapp?: WebappConfig;
  realtime?: RealtimeVoiceConfig;
};

type RuntimeConfig = {
  plugins?: {
    entries?: Record<string, { config?: PluginConfig }>;
  };
};

const PLUGIN_ID = "sureclaw-voice";
const XAI_REALTIME_PROVIDER_ID = "xai";
const XAI_REALTIME_DEFAULT_MODEL = "grok-voice-latest";
const XAI_REALTIME_DEFAULT_VOICE = "eve";
const XAI_REALTIME_DEFAULT_BASE_URL = "https://api.x.ai/v1";
const XAI_REALTIME_CLIENT_SECRET_TTL_SECONDS = 300;

// Second model-facing tool, exposed alongside openclaw_agent_consult when
// fastContext is enabled. The model calls this for quick recall (memory/past
// sessions); it returns found context or a "nothing relevant" note and never
// escalates on its own — the model decides whether to then call
// openclaw_agent_consult. Served by the browserVoice.consult gateway method.
const REALTIME_FAST_CONTEXT_TOOL: RealtimeVoiceTool = {
  type: "function",
  name: "fast_context",
  description:
    "Quickly look up the answer in OpenClaw's memory and past sessions without running the full agent. " +
    "Use this for recall — things the user told you before or that were discussed earlier. " +
    "If it returns nothing relevant and the request needs tools, actions, current state, or reasoning, " +
    "then call openclaw_agent_consult.",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "The concrete question or task to look up." },
      context: { type: "string", description: "Optional relevant context or transcript summary." },
    },
    required: ["question"],
  },
};

// Resolves the realtime voice config for the browser session from this plugin's
// own config slot (plugins.entries.sureclaw-voice.config.realtime), the same
// place webrtc and webapp settings are owned.
function resolveBrowserRealtimeConfig(cfg: RuntimeConfig): RealtimeVoiceConfig | undefined {
  const realtime = cfg.plugins?.entries?.[PLUGIN_ID]?.config?.realtime;
  if (!realtime || realtime.enabled === false) return undefined;
  return realtime;
}

type XaiRealtimeProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  voice?: string;
  vadThreshold?: number;
  silenceDurationMs?: number;
  prefixPaddingMs?: number;
  reasoningEffort?: string;
};

function buildXaiRealtimeVoiceProvider(): RealtimeVoiceProviderPlugin {
  return {
    id: XAI_REALTIME_PROVIDER_ID,
    label: "xAI Grok Voice",
    defaultModel: XAI_REALTIME_DEFAULT_MODEL,
    models: [XAI_REALTIME_DEFAULT_MODEL, "grok-voice-think-fast-1.0"],
    autoSelectOrder: 20,
    capabilities: {
      transports: ["provider-websocket"],
      inputAudioFormats: [REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ],
      outputAudioFormats: [REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ],
      supportsBrowserSession: true,
      supportsBargeIn: true,
      supportsToolCalls: true,
    },
    resolveConfig: ({ rawConfig }) => normalizeXaiRealtimeProviderConfig(rawConfig),
    isConfigured: ({ providerConfig }) =>
      Boolean(
        normalizeXaiRealtimeProviderConfig(providerConfig).apiKey || readEnv("XAI_API_KEY")?.trim(),
      ),
    createBridge: () => {
      throw new Error(
        "xAI realtime voice is available to this plugin through the browser provider-websocket transport only",
      );
    },
    createBrowserSession: async (req) => {
      const config = normalizeXaiRealtimeProviderConfig(req.providerConfig);
      const apiKey = config.apiKey || readEnv("XAI_API_KEY")?.trim();
      if (!apiKey) {
        throw new Error(
          "xAI credentials missing for realtime voice; set providers.xai.apiKey or XAI_API_KEY",
        );
      }

      const model = req.model?.trim() || config.model || XAI_REALTIME_DEFAULT_MODEL;
      const voice = req.voice?.trim() || config.voice || XAI_REALTIME_DEFAULT_VOICE;
      const baseUrl = normalizeXaiRealtimeBaseUrl(config.baseUrl);
      const clientSecret = await createXaiRealtimeClientSecret({ baseUrl, apiKey });

      const turnDetection: Record<string, unknown> = { type: "server_vad" };
      const vadThreshold = req.vadThreshold ?? config.vadThreshold;
      const silenceDurationMs = req.silenceDurationMs ?? config.silenceDurationMs;
      const prefixPaddingMs = req.prefixPaddingMs ?? config.prefixPaddingMs;
      if (typeof vadThreshold === "number") turnDetection.threshold = vadThreshold;
      if (typeof silenceDurationMs === "number") {
        turnDetection.silence_duration_ms = silenceDurationMs;
      }
      if (typeof prefixPaddingMs === "number") turnDetection.prefix_padding_ms = prefixPaddingMs;

      const sessionConfig: Record<string, unknown> = {
        voice,
        instructions: req.instructions,
        turn_detection: turnDetection,
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            transport: "json",
            transcription: { model: "grok-transcribe" },
          },
          output: {
            format: { type: "audio/pcm", rate: 24000 },
            transport: "json",
          },
        },
      };
      if (req.tools?.length) sessionConfig.tools = req.tools;
      const reasoningEffort = req.reasoningEffort?.trim() || config.reasoningEffort;
      if (reasoningEffort) sessionConfig.reasoning = { effort: reasoningEffort };

      return {
        provider: XAI_REALTIME_PROVIDER_ID,
        transport: "provider-websocket",
        protocol: "xai-realtime",
        clientSecret: clientSecret.value,
        websocketUrl: buildXaiRealtimeWebSocketUrl(baseUrl, model),
        audio: {
          inputEncoding: "pcm16",
          inputSampleRateHz: 24000,
          outputEncoding: "pcm16",
          outputSampleRateHz: 24000,
        },
        initialMessage: { type: "session.update", session: sessionConfig },
        model,
        voice,
        expiresAt: clientSecret.expiresAt,
      };
    },
  };
}

function normalizeXaiRealtimeProviderConfig(value: unknown): XaiRealtimeProviderConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const config = value as Record<string, unknown>;
  return {
    apiKey: trimmedString(config.apiKey),
    baseUrl: trimmedString(config.baseUrl),
    model: trimmedString(config.model),
    voice: trimmedString(config.voice),
    vadThreshold: finiteNumber(config.vadThreshold),
    silenceDurationMs: finiteNumber(config.silenceDurationMs),
    prefixPaddingMs: finiteNumber(config.prefixPaddingMs),
    reasoningEffort: trimmedString(config.reasoningEffort),
  };
}

function normalizeXaiRealtimeBaseUrl(value?: string): string {
  const url = new URL(value || XAI_REALTIME_DEFAULT_BASE_URL);
  if (url.protocol !== "https:") throw new Error("xAI realtime baseUrl must use https://");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function buildXaiRealtimeWebSocketUrl(baseUrl: string, model: string): string {
  const url = new URL(`${baseUrl}/realtime`);
  url.protocol = "wss:";
  url.searchParams.set("model", model);
  return url.toString();
}

async function createXaiRealtimeClientSecret(params: { baseUrl: string; apiKey: string }) {
  const response = await fetch(`${params.baseUrl}/realtime/client_secrets`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      expires_after: { seconds: XAI_REALTIME_CLIENT_SECRET_TTL_SECONDS },
    }),
    signal: AbortSignal.timeout(10000),
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `xAI realtime client-secret request failed (${response.status})${
        responseText.trim() ? `: ${formatProviderHttpError(responseText)}` : ""
      }`,
    );
  }

  let data: { value?: unknown; expires_at?: unknown };
  try {
    data = JSON.parse(responseText) as { value?: unknown; expires_at?: unknown };
  } catch {
    throw new Error("xAI realtime client-secret response was not valid JSON");
  }
  if (typeof data.value !== "string" || !data.value.trim()) {
    throw new Error("xAI realtime client-secret response did not include a token");
  }
  return {
    value: data.value,
    expiresAt: typeof data.expires_at === "number" ? data.expires_at : undefined,
  };
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatProviderHttpError(body: string): string {
  const trimmed = body.trim();
  const redacted = trimmed.replace(/(Bearer|Token)\s+[A-Za-z0-9._~+/=-]+/giu, "$1 [redacted]");
  try {
    const parsed = JSON.parse(redacted) as {
      error?: { message?: unknown; code?: unknown; type?: unknown };
    };
    const error = parsed.error;
    const parts = [
      typeof error?.message === "string" ? error.message : "",
      typeof error?.code === "string" ? `code=${error.code}` : "",
      typeof error?.type === "string" ? `type=${error.type}` : "",
    ].filter(Boolean);
    if (parts.length) return parts.join(" ");
  } catch {
    // Fall through to a bounded plaintext response.
  }
  return redacted.slice(0, 500);
}

const entry = definePluginEntry({
  id: "sureclaw-voice",
  name: "SureClaw Voice",
  description:
    "Serves the voice web app and mints OpenAI or xAI browser realtime sessions from the plugin's own config.",

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
              ttlSeconds: { type: "number" },
            },
          },
        },
      },
      webapp: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          name: { type: "string" },
          recordMemoriesOnCallEnd: { type: "boolean" },
        },
      },
      // Realtime voice config (provider, model, voice, instructions, tool/consult
      // policy, etc.). Loosely validated — provider-specific keys vary by provider
      // — but `model` is required: there is no provider-side default realtime
      // model, so an omitted model mints a session against an undefined model.
      realtime: {
        type: "object",
        additionalProperties: true,
        required: ["model"],
        properties: {
          path: { type: "string", enum: ["legacy", "gpt-live"] },
          model: { type: "string" },
          gptLive: {
            type: "object",
            additionalProperties: false,
            properties: {
              enabled: { type: "boolean" },
              model: { type: "string" },
              voice: { type: "string" },
            },
          },
        },
      },
    },
  },

  register(api) {
    // OpenClaw does not currently register xAI's upstream Voice Agent API as a
    // realtime-voice provider. Register the browser-native WebSocket path here
    // so the same provider selection/config flow used by OpenAI can select xAI.
    // The browser receives only a short-lived client secret, never the API key.
    // Register the compatibility provider only when the legacy xAI path is
    // selected. New OpenClaw releases bundle xAI themselves; avoiding an
    // unconditional registration also keeps OpenAI/GPT-Live startups free of
    // duplicate-provider warnings while retaining the old xAI implementation.
    const configuredRealtime = api.pluginConfig?.realtime;
    if (configuredRealtime?.provider === XAI_REALTIME_PROVIDER_ID) {
      api.registerRealtimeVoiceProvider(buildXaiRealtimeVoiceProvider());
    }

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
        const realtimeConfig = resolveBrowserRealtimeConfig(cfg);
        if (!realtimeConfig) {
          respond(false, undefined, {
            code: "UNAVAILABLE",
            message:
              "No realtime voice config found — configure plugins.entries.sureclaw-voice.config.realtime",
          });
          return;
        }
        if (isGptLiveModel(realtimeConfig.model)) {
          // GPT-Live needs OpenClaw's gateway-owned Talk runtime; the browser
          // starts it through talk.client.create, not this legacy minting path.
          respond(false, undefined, {
            code: "UNAVAILABLE",
            message: `${realtimeConfig.model} is a GPT-Live model; use the GPT-Live engine (talk.client.create)`,
          });
          return;
        }

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

        // `consultPolicy` is the single behavioral axis: "always" (the default)
        // makes the voice surface a full OpenClaw agent proxy; "auto"/
        // "substantive" consult only on substantive turns; "never" is pure
        // realtime voice with no OpenClaw delegation and no consult tool.
        const consultPolicy = realtimeConfig.consultPolicy ?? "always";
        const toolPolicy =
          consultPolicy === "never"
            ? "none"
            : resolveRealtimeVoiceAgentConsultToolPolicy(realtimeConfig.toolPolicy, "owner");
        // Expose the fast_context tool alongside the agent consult only when fast
        // context is enabled (and the consult tool itself is exposed).
        const fastContextEnabled = resolveFastContextConfig(realtimeConfig.fastContext).enabled;
        const agentContextInstructions = await resolveAgentContext({
          cfg,
          realtimeConfig,
          sessionKey: typedParams.sessionKey,
          agentId: typedParams.agentId,
        });

        const session = await resolution.provider.createBrowserSession({
          cfg,
          providerConfig: resolution.providerConfig,
          instructions: buildRealtimeInstructions({
            instructions: realtimeConfig.instructions,
            agentContextInstructions,
            toolPolicy,
            consultPolicy,
            fastContextEnabled,
          }),
          tools:
            toolPolicy === "none"
              ? []
              : fastContextEnabled
                ? [REALTIME_VOICE_AGENT_CONSULT_TOOL, REALTIME_FAST_CONTEXT_TOOL]
                : [REALTIME_VOICE_AGENT_CONSULT_TOOL],
          model: realtimeConfig.model,
          voice: realtimeConfig.voice,
        });

        const iceServers =
          session.transport === "webrtc"
            ? await resolveIceServers(cfg.plugins?.entries?.[PLUGIN_ID]?.config?.webrtc)
            : undefined;
        respond(true, iceServers ? { ...session, iceServers } : session, undefined);
      } catch (error) {
        respond(false, undefined, {
          code: "UNAVAILABLE",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });

    // Serves the model-facing fast_context tool: a bounded memory/session lookup
    // owned by this plugin's config slot. Always returns speakable text (found
    // context, or a "nothing relevant" note) so the model can decide whether to
    // then call openclaw_agent_consult. It never runs the full agent itself —
    // that stays on the core consult path (running an embedded agent needs a
    // runtime the plugin SDK does not expose).
    api.registerGatewayMethod("browserVoice.consult", async ({ params, respond, context }) => {
      const typed = normalizeConsultParams(params);
      if (!typed) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "browserVoice.consult requires a string sessionKey",
        });
        return;
      }

      try {
        const cfg = context.getRuntimeConfig() as RuntimeConfig;
        const realtimeConfig = resolveBrowserRealtimeConfig(cfg);
        const fastContext = resolveFastContextConfig(realtimeConfig?.fastContext);
        if (!fastContext.enabled) {
          respond(true, { text: "Fast context lookup is not enabled." }, undefined);
          return;
        }

        const result = await resolveRealtimeVoiceFastContextConsult({
          cfg,
          agentId: typed.agentId || "main",
          sessionKey: typed.sessionKey,
          // Force fallbackToConsult:false so a miss returns speakable "nothing
          // found" text rather than a silent fall-through — escalation to the
          // full agent is the model's call (it has its own tool for that).
          config: { ...fastContext, fallbackToConsult: false },
          args: typed.args,
          logger: { debug: (message) => console.debug(`sureclaw-voice: fast context: ${message}`) },
        });

        respond(
          true,
          { text: result.handled ? result.result.text : "No relevant context found." },
          undefined,
        );
      } catch (error) {
        // Fail soft: a fast-context error should never break the call.
        console.warn(
          `sureclaw-voice: fast context consult failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        respond(true, { text: "Fast context lookup is currently unavailable." }, undefined);
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

// File extensions whose payloads carry __APP_*__ display-name tokens and must be
// rewritten at serve time: the HTML shell (title + iOS/PWA metas) and the web
// manifest (name/short_name). Deliberately excludes .js/.css — see the note in
// serveWebappFile on why tokenizing the JS bundle corrupts it.
const TOKENIZED_EXTENSIONS = new Set([".html", ".webmanifest"]);

// Serves the built voice PWA (Vite `dist/`) from the gateway's own HTTP server
// so a single origin handles both the HTTPS page and the operator WebSocket.
// Fails soft: if the assets are absent the route is simply not registered.
function registerWebappRoute(api: {
  pluginConfig?: PluginConfig;
  // The gateway's own auth config. The app reads the mode (via the injected
  // meta tag below) to decide whether to expose its Settings sheet at all.
  config?: { gateway?: { auth?: { mode?: string } } };
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
  registerHttpRoute: (params: {
    path: string;
    auth: "plugin" | "gateway";
    match?: "exact" | "prefix";
    handler: (
      req: IncomingMessage,
      res: ServerResponse,
    ) => Promise<boolean | void> | boolean | void;
  }) => void;
}) {
  const webapp = api.pluginConfig?.webapp;
  const voiceEngine = resolveVoiceEngine(api.pluginConfig?.realtime);
  if (voiceEngine.gptLive) {
    api.logger?.info?.(
      `sureclaw-voice: GPT-Live engine ${voiceEngine.gptLive.model || "(OpenClaw default model)"}` +
        `${voiceEngine.gptLive.voice ? ` voice=${voiceEngine.gptLive.voice}` : ""}`,
    );
  }

  const dir = resolveWebappDir();
  if (!dir) {
    api.logger?.warn?.(
      "sureclaw-voice: voice web app not served — no built assets found. " +
        "Build the PWA and stage it into the plugin's webapp/ directory (npm run build).",
    );
    return;
  }

  // Resolve the display name. When `name` is configured it's used verbatim
  // for the product title, manifest, and Call button (e.g. "Acme" →
  // title "Acme", button "Call Acme"). When unset, defaults are:
  //   - product (title/manifest name): "SureClaw Voice"
  //   - home-screen label (short_name): "SureClaw Voice"
  //   - assistant (Call button):        "OpenClaw"
  const configuredName = webapp?.name?.trim();
  const assistantName = (configuredName || "OpenClaw").slice(0, 60);
  const productTitle = (configuredName || "SureClaw Voice").slice(0, 60);
  const homeScreenLabel = (configuredName || "SureClaw Voice").slice(0, 60);
  // The gateway authenticates the WebSocket itself; the app only needs a
  // credential in token/password mode. In trusted-proxy mode (Cloudflare
  // Access et al.) there is nothing for the user to configure, so the app
  // hides its Settings sheet entirely. Default to "token" when unset — that
  // is the gateway's own default for an unconfigured auth mode.
  const gatewayAuthMode = api.config?.gateway?.auth?.mode ?? "token";
  // Whether the client runs an end-of-call agent turn to store memories. Off
  // unless explicitly enabled (the transcript itself is always persisted).
  const recordMemories = webapp?.recordMemoriesOnCallEnd === true;
  const tokens: Record<string, string> = {
    __APP_NAME__: assistantName,
    __APP_FULL_NAME__: productTitle,
    __APP_SHORT_NAME__: homeScreenLabel,
    __APP_GATEWAY_AUTH__: gatewayAuthMode,
    __APP_RECORD_MEMORIES__: String(recordMemories),
    __APP_VOICE_ENGINE__: voiceEngine.engine,
    __APP_GPT_LIVE_MODEL__: voiceEngine.gptLive?.model ?? "",
    __APP_GPT_LIVE_VOICE__: voiceEngine.gptLive?.voice ?? "",
  };

  // Serve-only: the gateway authenticates the WebSocket itself (token or
  // trusted-proxy/Cloudflare Access). The page carries no credential.
  const mount = normalizeWebappMount(webapp?.path ?? DEFAULT_WEBAPP_MOUNT);
  api.registerHttpRoute({
    path: mount,
    auth: "plugin",
    match: "prefix",
    handler: (req, res) => serveWebappFile(req, res, mount, resolvePath(dir), tokens),
  });
  api.logger?.info?.(`sureclaw-voice: serving voice web app at ${mount}/`);
}

// Works out which voice engine the PWA runs (realtime.path). The legacy engine
// is the plugin's own realtime provider/model; GPT-Live is either the `gptLive`
// block or, for GPT-Live-only configs, a gpt-live-* top-level model.
function resolveVoiceEngine(realtime: RealtimeVoiceConfig | undefined): VoiceEngine {
  const topLevelIsGptLive = isGptLiveModel(realtime?.model);
  let gptLive: VoiceEngine["gptLive"];
  if (realtime?.gptLive && realtime.gptLive.enabled !== false) {
    gptLive = { model: realtime.gptLive.model?.trim() ?? "", voice: realtime.gptLive.voice?.trim() ?? "" };
  } else if (realtime?.path === "gpt-live" && (topLevelIsGptLive || !realtime.model)) {
    gptLive = { model: realtime.model?.trim() ?? "", voice: realtime.voice?.trim() ?? "" };
  }
  if (gptLive?.model && !isGptLiveModel(gptLive.model)) gptLive = undefined;
  if (!gptLive || realtime?.path !== "gpt-live") return { engine: "legacy" };
  return { engine: "gpt-live", gptLive };
}

function isGptLiveModel(model: string | undefined) {
  return typeof model === "string" && model.trim().startsWith("gpt-live-");
}

// Locates the bundled web app next to this module — handling both the linked
// dev layout (index.ts at the package root → ./webapp) and the installed layout
// (compiled dist/index.js → ../webapp). The assets are always the bundled ones.
function resolveWebappDir(): string | undefined {
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
  tokens: Record<string, string>,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;

  const url = new URL(req.url ?? "/", "http://localhost");
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (error) {
    if (error instanceof URIError) {
      res.statusCode = 400;
      res.end("Bad request");
      return true;
    }
    throw error;
  }

  // Redirect the bare mount to a trailing slash so the relative asset URLs in
  // index.html resolve under the mount (…/voice/assets/… not /assets/…).
  // Use 307 (temporary), never 301: a permanent redirect is cached by browsers
  // indefinitely, so a stale mount target can poison clients long after the
  // server is fixed (e.g. an old /voice → / redirect surviving a remount).
  if (pathname === mount) {
    res.statusCode = 307;
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

  const ext = extname(filePath).toLowerCase();
  const contentType = WEBAPP_CONTENT_TYPES[ext] ?? "application/octet-stream";
  // Token substitution runs ONLY on the files that carry __APP_*__ tokens: the
  // HTML shell and the web manifest. It must never touch the JS bundle — that
  // bundle legitimately contains the literal tokens as object keys (main.tsx's
  // unsubstituted-token fallback map), and rewriting them with a multi-word
  // display name produces invalid JS (e.g. `{SureClaw Voice: …}`), which fails
  // to parse so the app never mounts. A content-type heuristic gets this wrong
  // because `.js` is served as text/javascript; key on the extension instead.
  const isTokenized = TOKENIZED_EXTENSIONS.has(ext);
  let body: Buffer;
  if (isTokenized) {
    const raw = await readFile(filePath, "utf8");
    body = Buffer.from(replaceTokens(raw, tokens, ext), "utf8");
  } else {
    body = await readFile(filePath);
  }
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
  res.end(body);
  return true;
}

// Replaces __APP_*__ tokens in the served HTML/manifest. Values stay raw in the
// shared token map and are escaped per file type here: HTML attributes/text need
// entity escaping, while manifest string values need JSON string escaping.
// Only touches text payloads (see isTokenized), so binary assets are untouched.
function replaceTokens(input: string, tokens: Record<string, string>, ext: string): string {
  if (!input.includes("__APP_")) return input;
  const escapedTokens = escapeTokensForExtension(tokens, ext);
  let out = input;
  for (const [key, value] of Object.entries(escapedTokens)) {
    out = out.split(key).join(value);
  }
  return out;
}

function escapeTokensForExtension(
  tokens: Record<string, string>,
  ext: string,
): Record<string, string> {
  const escapeValue =
    ext === ".webmanifest"
      ? (value: string) => JSON.stringify(value).slice(1, -1)
      : escapeHtmlTokenValue;
  return Object.fromEntries(
    Object.entries(tokens).map(([key, value]) => [key, escapeValue(value)]),
  );
}

function escapeHtmlTokenValue(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
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
    const apiToken = readEnv(CF_TURN_API_TOKEN_ENV);
    if (!apiToken) {
      console.warn(
        `sureclaw-voice: cloudflareTurn.keyId is set but ${CF_TURN_API_TOKEN_ENV} is not set; skipping TURN.`,
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
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ ttl: ttlSeconds }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Cloudflare TURN API responded ${response.status}: ${(await response.text()).slice(0, 200)}`,
    );
  }

  const data = (await response.json()) as {
    iceServers?: { urls?: string | string[]; username?: string; credential?: string };
  };
  const ice = data.iceServers;
  if (!ice?.urls) return undefined;
  return { urls: ice.urls, username: ice.username, credential: ice.credential };
}

function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
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

type BrowserConsultParams = { sessionKey: string; agentId: string; args: unknown };

function normalizeConsultParams(value: unknown): BrowserConsultParams | undefined {
  if (!value || typeof value !== "object") return undefined;
  const params = value as Record<string, unknown>;
  const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
  if (!sessionKey) return undefined;
  const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
  return { sessionKey, agentId: agentId || "main", args: params.args ?? {} };
}

// Fills a (partial) fastContext config with the host's defaults so the raw SDK
// lookup receives a complete config (it reads these fields directly, without
// the schema layer that would otherwise apply defaults). Disabled by default.
function resolveFastContextConfig(
  config?: Partial<RealtimeVoiceFastContextConfig>,
): RealtimeVoiceFastContextConfig {
  return {
    enabled: config?.enabled ?? false,
    timeoutMs: config?.timeoutMs ?? 1000,
    maxResults: config?.maxResults ?? 3,
    sources: config?.sources ?? ["memory", "sessions"],
    fallbackToConsult: config?.fallbackToConsult ?? false,
  };
}

// Builds the agent-context capsule appended to realtime voice instructions.
// Prefers the structured `agentContext` block (identity fields + profile files,
// opt-in via `enabled`); falls back to the legacy `bootstrapContextFiles` list
// when `agentContext` is absent so older configs keep behaving as before.
async function resolveAgentContext(params: {
  cfg: RuntimeConfig;
  realtimeConfig: RealtimeVoiceConfig;
  sessionKey: string;
  agentId?: string;
}) {
  const agentId = params.agentId || "main";
  const agentContext = params.realtimeConfig.agentContext;

  if (!agentContext) {
    // Legacy path: a bare file list folded into instructions, on by default
    // unless explicitly emptied.
    return resolveProfileFileInstructions({
      cfg: params.cfg,
      agentId,
      sessionKey: params.sessionKey,
      files: params.realtimeConfig.bootstrapContextFiles,
    });
  }

  if (!agentContext.enabled) return undefined;

  const maxChars =
    typeof agentContext.maxChars === "number" && agentContext.maxChars > 0
      ? agentContext.maxChars
      : DEFAULT_AGENT_CONTEXT_MAX_CHARS;

  const sections: string[] = [];

  if (agentContext.includeIdentity !== false) {
    const identity = buildIdentityCapsule(params.cfg, agentId);
    if (identity) sections.push(identity);
  }

  if (agentContext.includeWorkspaceFiles !== false) {
    const fileInstructions = await resolveProfileFileInstructions({
      cfg: params.cfg,
      agentId,
      sessionKey: params.sessionKey,
      files: agentContext.files,
    });
    if (fileInstructions) sections.push(fileInstructions);
  }

  if (sections.length === 0) return undefined;
  const capsule = sections.join("\n\n");
  return capsule.length > maxChars ? `${capsule.slice(0, maxChars)}\n[truncated]` : capsule;
}

// Reads the configured (or default) profile files and formats them as bounded
// realtime instructions via the SDK helper. Configured file names are
// constrained to the SDK's allowed profile set; anything else is dropped.
async function resolveProfileFileInstructions(params: {
  cfg: RuntimeConfig;
  agentId: string;
  sessionKey: string;
  files?: string[];
}) {
  const files = normalizeProfileFiles(params.files);
  if (files?.length === 0) return undefined;
  try {
    return await resolveRealtimeBootstrapContextInstructions({
      config: params.cfg,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      files,
      warn: (message) => console.warn(`sureclaw-voice: realtime agent context: ${message}`),
    });
  } catch (error) {
    console.warn(
      `sureclaw-voice: realtime agent context unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

// Filters a configured file list down to the SDK's allowed profile files,
// warning on anything dropped. Returns undefined to mean "use the SDK default".
function normalizeProfileFiles(files?: string[]): RealtimeBootstrapContextFileName[] | undefined {
  if (!files) return undefined;
  const allowed = new Set<string>(REALTIME_BOOTSTRAP_CONTEXT_FILE_NAMES);
  const kept = files.filter((file): file is RealtimeBootstrapContextFileName => allowed.has(file));
  const dropped = files.filter((file) => !allowed.has(file));
  if (dropped.length > 0) {
    console.warn(
      `sureclaw-voice: realtime agent context ignoring unsupported files (${dropped.join(", ")}); ` +
        `allowed: ${REALTIME_BOOTSTRAP_CONTEXT_FILE_NAMES.join(", ")}`,
    );
  }
  return kept;
}

// Renders the configured agent identity fields into a compact, non-spoken
// instruction block so the voice model adopts the agent's persona.
function buildIdentityCapsule(cfg: RuntimeConfig, agentId: string) {
  const identity = resolveAgentIdentity(cfg, agentId);
  if (!identity) return undefined;
  const lines = [
    identity.name ? `Name: ${identity.name}` : undefined,
    identity.theme ? `Theme: ${identity.theme}` : undefined,
    identity.emoji ? `Emoji: ${identity.emoji}` : undefined,
  ].filter(Boolean);
  if (lines.length === 0) return undefined;
  return [
    "Agent identity (speak and act as this agent; do not read these lines aloud):",
    ...lines,
  ].join("\n");
}

function buildProviderConfigs(realtimeConfig: RealtimeVoiceConfig) {
  const configs = realtimeConfig.providers;
  return configs && Object.keys(configs).length > 0 ? { ...configs } : undefined;
}

function buildProviderConfigOverrides(realtimeConfig: RealtimeVoiceConfig) {
  const overrides = {
    ...(realtimeConfig.model ? { model: realtimeConfig.model } : {}),
    ...(realtimeConfig.voice ? { voice: realtimeConfig.voice } : {}),
    ...(typeof realtimeConfig.minBargeInAudioEndMs === "number"
      ? { minBargeInAudioEndMs: realtimeConfig.minBargeInAudioEndMs }
      : {}),
  };
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function buildRealtimeInstructions(params: {
  instructions?: string;
  agentContextInstructions?: string;
  toolPolicy: string;
  consultPolicy: string;
  fastContextEnabled?: boolean;
}) {
  const base =
    params.instructions ??
    [
      "You are OpenClaw's voice interface.",
      "Keep spoken replies concise, natural, and suitable for a live voice call.",
    ].join("\n");
  const consultPolicyInstructions = buildConsultPolicyInstructions(
    params.toolPolicy,
    params.consultPolicy,
  );
  // Only describe fast_context when it is actually exposed as a tool.
  const fastContextInstructions =
    params.fastContextEnabled && params.toolPolicy !== "none"
      ? "You have two tools: fast_context for quick recall from memory and past sessions, and " +
        "openclaw_agent_consult for the full agent. Prefer fast_context for remembering things; " +
        "if it returns nothing relevant and the request needs tools, actions, current state, or " +
        "deeper reasoning, call openclaw_agent_consult."
      : undefined;

  // "always" consult => present as a full OpenClaw agent proxy.
  if (params.consultPolicy === "always") {
    return [
      base,
      params.agentContextInstructions?.trim(),
      "Mode: OpenClaw agent proxy.",
      "You are the realtime voice surface for the same OpenClaw agent the user can message directly.",
      "Do not mention a backend, supervisor, helper, or separate system. Present the result as your own work.",
      "Delegate substantive requests, actions, tool work, current facts, memory, workspace context, and user-specific context with openclaw_agent_consult.",
      "Do not block, refuse, or downscope at the voice layer. Delegate to OpenClaw and treat its result as authoritative.",
      "Answer directly only for greetings, acknowledgements, brief latency tests, or filler while waiting.",
      'While waiting for OpenClaw data or tool results, use at most one short natural backchannel such as "yeah", "mm-hmm", "got it", or "one sec"; vary it and do not treat it as the final answer.',
      "When OpenClaw sends an internal exact answer to speak, do not call tools. Say only that answer.",
      fastContextInstructions,
      consultPolicyInstructions,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  return [
    base,
    params.agentContextInstructions?.trim(),
    'While waiting for OpenClaw data or tool results, use at most one short natural backchannel such as "yeah", "mm-hmm", "got it", or "one sec"; vary it and do not treat it as the final answer.',
    fastContextInstructions,
    consultPolicyInstructions,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildConsultPolicyInstructions(toolPolicy: string, consultPolicy: string) {
  if (consultPolicy === "never") {
    return "Answer directly as a standalone voice assistant. There is no OpenClaw agent to consult in this session.";
  }

  const policyLines = [
    toolPolicy === "none"
      ? "No OpenClaw agent consult tool is available in this session."
      : "Use openclaw_agent_consult for requests that need the OpenClaw agent, tools, actions, current project state, memory, or deeper reasoning.",
  ];

  if (consultPolicy === "always") {
    policyLines.push(
      "For substantive user turns, call openclaw_agent_consult before giving the final spoken answer.",
    );
  } else if (consultPolicy === "auto") {
    policyLines.push(
      "For simple greetings or short acknowledgements, answer directly. For anything substantive, consult OpenClaw first.",
    );
  }

  if (toolPolicy === "safe-read-only") {
    policyLines.push("The consult tool may be limited to safe read-only work.");
  } else if (toolPolicy === "owner") {
    policyLines.push(
      "The consult tool may perform owner-authorized OpenClaw work according to the server policy.",
    );
  }

  return policyLines.join(" ");
}
