import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAgentIdentity } from "openclaw/plugin-sdk/agent-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { REALTIME_BOOTSTRAP_CONTEXT_FILE_NAMES, resolveRealtimeBootstrapContextInstructions } from "openclaw/plugin-sdk/realtime-bootstrap-context";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL, resolveConfiguredRealtimeVoiceProvider, resolveRealtimeVoiceAgentConsultToolPolicy, resolveRealtimeVoiceFastContextConsult } from "openclaw/plugin-sdk/realtime-voice";
//#region index.ts
const DEFAULT_AGENT_CONTEXT_MAX_CHARS = 6e3;
const CF_TURN_API_TOKEN_ENV = "CF_TURN_API_TOKEN";
const PLUGIN_ID = "sureclaw-voice";
const REALTIME_FAST_CONTEXT_TOOL = {
	type: "function",
	name: "fast_context",
	description: "Quickly look up the answer in OpenClaw's memory and past sessions without running the full agent. Use this for recall — things the user told you before or that were discussed earlier. If it returns nothing relevant and the request needs tools, actions, current state, or reasoning, then call openclaw_agent_consult.",
	parameters: {
		type: "object",
		properties: {
			question: {
				type: "string",
				description: "The concrete question or task to look up."
			},
			context: {
				type: "string",
				description: "Optional relevant context or transcript summary."
			}
		},
		required: ["question"]
	}
};
function resolveBrowserRealtimeConfig(cfg) {
	const realtime = cfg.plugins?.entries?.[PLUGIN_ID]?.config?.realtime;
	if (!realtime || realtime.enabled === false) return void 0;
	return realtime;
}
const entry = definePluginEntry({
	id: "sureclaw-voice",
	name: "SureClaw Voice",
	description: "Serves the voice web app and mints browser WebRTC realtime sessions from the plugin's own realtime voice config.",
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
							ttlSeconds: { type: "number" }
						}
					}
				}
			},
			webapp: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: { type: "string" },
					name: { type: "string" }
				}
			},
			realtime: {
				type: "object",
				additionalProperties: true,
				required: ["model"],
				properties: { model: { type: "string" } }
			}
		}
	},
	register(api) {
		registerWebappRoute(api);
		api.registerGatewayMethod("browserVoice.create", async ({ params, respond, context }) => {
			const typedParams = normalizeParams(params);
			if (!typedParams) {
				respond(false, void 0, {
					code: "INVALID_REQUEST",
					message: "browserVoice.create requires a string sessionKey"
				});
				return;
			}
			try {
				const cfg = context.getRuntimeConfig();
				const realtimeConfig = resolveBrowserRealtimeConfig(cfg);
				if (!realtimeConfig) {
					respond(false, void 0, {
						code: "UNAVAILABLE",
						message: "No realtime voice config found — configure plugins.entries.sureclaw-voice.config.realtime"
					});
					return;
				}
				const resolution = resolveConfiguredRealtimeVoiceProvider({
					configuredProviderId: realtimeConfig.provider,
					providerConfigs: buildProviderConfigs(realtimeConfig),
					providerConfigOverrides: buildProviderConfigOverrides(realtimeConfig),
					cfg,
					defaultModel: realtimeConfig.model,
					noRegisteredProviderMessage: "No configured realtime voice provider registered"
				});
				if (!resolution.provider.createBrowserSession) {
					respond(false, void 0, {
						code: "UNAVAILABLE",
						message: `Realtime provider "${resolution.provider.id}" does not support browser WebRTC sessions`
					});
					return;
				}
				const consultPolicy = realtimeConfig.consultPolicy ?? "always";
				const toolPolicy = consultPolicy === "never" ? "none" : resolveRealtimeVoiceAgentConsultToolPolicy(realtimeConfig.toolPolicy, "owner");
				const fastContextEnabled = resolveFastContextConfig(realtimeConfig.fastContext).enabled;
				const agentContextInstructions = await resolveAgentContext({
					cfg,
					realtimeConfig,
					sessionKey: typedParams.sessionKey,
					agentId: typedParams.agentId
				});
				const session = await resolution.provider.createBrowserSession({
					cfg,
					providerConfig: resolution.providerConfig,
					instructions: buildRealtimeInstructions({
						instructions: realtimeConfig.instructions,
						agentContextInstructions,
						toolPolicy,
						consultPolicy,
						fastContextEnabled
					}),
					tools: toolPolicy === "none" ? [] : fastContextEnabled ? [REALTIME_VOICE_AGENT_CONSULT_TOOL, REALTIME_FAST_CONTEXT_TOOL] : [REALTIME_VOICE_AGENT_CONSULT_TOOL],
					model: realtimeConfig.model,
					voice: realtimeConfig.voice
				});
				const iceServers = await resolveIceServers(cfg.plugins?.entries?.[PLUGIN_ID]?.config?.webrtc);
				respond(true, iceServers ? {
					...session,
					iceServers
				} : session, void 0);
			} catch (error) {
				respond(false, void 0, {
					code: "UNAVAILABLE",
					message: error instanceof Error ? error.message : String(error)
				});
			}
		});
		api.registerGatewayMethod("browserVoice.consult", async ({ params, respond, context }) => {
			const typed = normalizeConsultParams(params);
			if (!typed) {
				respond(false, void 0, {
					code: "INVALID_REQUEST",
					message: "browserVoice.consult requires a string sessionKey"
				});
				return;
			}
			try {
				const cfg = context.getRuntimeConfig();
				const fastContext = resolveFastContextConfig(resolveBrowserRealtimeConfig(cfg)?.fastContext);
				if (!fastContext.enabled) {
					respond(true, { text: "Fast context lookup is not enabled." }, void 0);
					return;
				}
				const result = await resolveRealtimeVoiceFastContextConsult({
					cfg,
					agentId: typed.agentId || "main",
					sessionKey: typed.sessionKey,
					config: {
						...fastContext,
						fallbackToConsult: false
					},
					args: typed.args,
					logger: { debug: (message) => console.debug(`sureclaw-voice: fast context: ${message}`) }
				});
				respond(true, { text: result.handled ? result.result.text : "No relevant context found." }, void 0);
			} catch (error) {
				console.warn(`sureclaw-voice: fast context consult failed: ${error instanceof Error ? error.message : String(error)}`);
				respond(true, { text: "Fast context lookup is currently unavailable." }, void 0);
			}
		});
	}
});
const DEFAULT_WEBAPP_MOUNT = "/voice";
const WEBAPP_CONTENT_TYPES = {
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
	".txt": "text/plain; charset=utf-8"
};
const TOKENIZED_EXTENSIONS = /* @__PURE__ */ new Set([".html", ".webmanifest"]);
function registerWebappRoute(api) {
	const webapp = api.pluginConfig?.webapp;
	const dir = resolveWebappDir();
	if (!dir) {
		api.logger?.warn?.("sureclaw-voice: voice web app not served — no built assets found. Build the PWA and stage it into the plugin's webapp/ directory (npm run build).");
		return;
	}
	const configuredName = webapp?.name?.trim();
	const tokens = {
		__APP_NAME__: (configuredName || "OpenClaw").slice(0, 60),
		__APP_FULL_NAME__: (configuredName || "SureClaw Voice").slice(0, 60),
		__APP_SHORT_NAME__: (configuredName || "SureClaw Voice").slice(0, 60),
		__APP_GATEWAY_AUTH__: api.config?.gateway?.auth?.mode ?? "token"
	};
	const mount = normalizeWebappMount(webapp?.path ?? DEFAULT_WEBAPP_MOUNT);
	api.registerHttpRoute({
		path: mount,
		auth: "plugin",
		match: "prefix",
		handler: (req, res) => serveWebappFile(req, res, mount, resolve(dir), tokens)
	});
	api.logger?.info?.(`sureclaw-voice: serving voice web app at ${mount}/`);
}
function resolveWebappDir() {
	for (const rel of ["./webapp/", "../webapp/"]) {
		const dir = fileURLToPath(new URL(rel, import.meta.url));
		if (existsSync(resolve(dir, "index.html"))) return dir;
	}
}
function normalizeWebappMount(path) {
	let mount = path.trim();
	if (!mount.startsWith("/")) mount = `/${mount}`;
	while (mount.length > 1 && mount.endsWith("/")) mount = mount.slice(0, -1);
	return mount;
}
async function serveWebappFile(req, res, mount, root, tokens) {
	const method = (req.method ?? "GET").toUpperCase();
	if (method !== "GET" && method !== "HEAD") return false;
	const url = new URL(req.url ?? "/", "http://localhost");
	const pathname = decodeURIComponent(url.pathname);
	if (pathname === mount) {
		res.statusCode = 307;
		res.setHeader("Location", `${mount}/${url.search}`);
		res.end();
		return true;
	}
	let rel = pathname.slice(mount.length);
	if (rel.startsWith("/")) rel = rel.slice(1);
	if (rel === "") rel = "index.html";
	let filePath = resolve(root, rel);
	if (filePath !== root && !filePath.startsWith(root + sep)) {
		res.statusCode = 403;
		res.end("Forbidden");
		return true;
	}
	if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
		if (extname(rel)) {
			res.statusCode = 404;
			res.end("Not found");
			return true;
		}
		filePath = resolve(root, "index.html");
	}
	const ext = extname(filePath).toLowerCase();
	const contentType = WEBAPP_CONTENT_TYPES[ext] ?? "application/octet-stream";
	const isTokenized = TOKENIZED_EXTENSIONS.has(ext);
	let body;
	if (isTokenized) {
		const raw = await readFile(filePath, "utf8");
		body = Buffer.from(replaceTokens(raw, tokens), "utf8");
	} else body = await readFile(filePath);
	res.statusCode = 200;
	res.setHeader("Content-Type", contentType);
	res.setHeader("Cache-Control", filePath.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache");
	if (method === "HEAD") {
		res.end();
		return true;
	}
	res.end(body);
	return true;
}
function replaceTokens(input, tokens) {
	if (!input.includes("__APP_")) return input;
	let out = input;
	for (const [key, value] of Object.entries(tokens)) out = out.split(key).join(value);
	return out;
}
async function resolveIceServers(webrtc) {
	if (!webrtc) return void 0;
	const servers = [];
	if (Array.isArray(webrtc.iceServers)) servers.push(...webrtc.iceServers.filter((server) => Boolean(server?.urls)));
	const cf = webrtc.cloudflareTurn;
	if (cf?.keyId) {
		const apiToken = readEnv(CF_TURN_API_TOKEN_ENV);
		if (!apiToken) console.warn(`sureclaw-voice: cloudflareTurn.keyId is set but ${CF_TURN_API_TOKEN_ENV} is not set; skipping TURN.`);
		else try {
			const generated = await generateCloudflareTurn(cf.keyId, apiToken, cf.ttlSeconds ?? 86400);
			if (generated) servers.push(generated);
		} catch (error) {
			console.warn(`sureclaw-voice: Cloudflare TURN credential generation failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return servers.length > 0 ? servers : void 0;
}
async function generateCloudflareTurn(keyId, apiToken, ttlSeconds) {
	const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiToken}`,
			"Content-Type": "application/json"
		},
		body: JSON.stringify({ ttl: ttlSeconds })
	});
	if (!response.ok) throw new Error(`Cloudflare TURN API responded ${response.status}: ${(await response.text()).slice(0, 200)}`);
	const ice = (await response.json()).iceServers;
	if (!ice?.urls) return void 0;
	return {
		urls: ice.urls,
		username: ice.username,
		credential: ice.credential
	};
}
function readEnv(name) {
	return (globalThis.process?.env)?.[name];
}
function normalizeParams(value) {
	if (!value || typeof value !== "object") return void 0;
	const params = value;
	const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
	if (!sessionKey) return void 0;
	return {
		sessionKey,
		agentId: (typeof params.agentId === "string" ? params.agentId.trim() : "") || "main"
	};
}
function normalizeConsultParams(value) {
	if (!value || typeof value !== "object") return void 0;
	const params = value;
	const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
	if (!sessionKey) return void 0;
	return {
		sessionKey,
		agentId: (typeof params.agentId === "string" ? params.agentId.trim() : "") || "main",
		args: params.args ?? {}
	};
}
function resolveFastContextConfig(config) {
	return {
		enabled: config?.enabled ?? false,
		timeoutMs: config?.timeoutMs ?? 800,
		maxResults: config?.maxResults ?? 3,
		sources: config?.sources ?? ["memory", "sessions"],
		fallbackToConsult: config?.fallbackToConsult ?? false
	};
}
async function resolveAgentContext(params) {
	const agentId = params.agentId || "main";
	const agentContext = params.realtimeConfig.agentContext;
	if (!agentContext) return resolveProfileFileInstructions({
		cfg: params.cfg,
		agentId,
		sessionKey: params.sessionKey,
		files: params.realtimeConfig.bootstrapContextFiles
	});
	if (!agentContext.enabled) return void 0;
	const maxChars = typeof agentContext.maxChars === "number" && agentContext.maxChars > 0 ? agentContext.maxChars : DEFAULT_AGENT_CONTEXT_MAX_CHARS;
	const sections = [];
	if (agentContext.includeIdentity !== false) {
		const identity = buildIdentityCapsule(params.cfg, agentId);
		if (identity) sections.push(identity);
	}
	if (agentContext.includeWorkspaceFiles !== false) {
		const fileInstructions = await resolveProfileFileInstructions({
			cfg: params.cfg,
			agentId,
			sessionKey: params.sessionKey,
			files: agentContext.files
		});
		if (fileInstructions) sections.push(fileInstructions);
	}
	if (sections.length === 0) return void 0;
	const capsule = sections.join("\n\n");
	return capsule.length > maxChars ? `${capsule.slice(0, maxChars)}\n[truncated]` : capsule;
}
async function resolveProfileFileInstructions(params) {
	const files = normalizeProfileFiles(params.files);
	if (files?.length === 0) return void 0;
	try {
		return await resolveRealtimeBootstrapContextInstructions({
			config: params.cfg,
			agentId: params.agentId,
			sessionKey: params.sessionKey,
			files,
			warn: (message) => console.warn(`sureclaw-voice: realtime agent context: ${message}`)
		});
	} catch (error) {
		console.warn(`sureclaw-voice: realtime agent context unavailable: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
}
function normalizeProfileFiles(files) {
	if (!files) return void 0;
	const allowed = new Set(REALTIME_BOOTSTRAP_CONTEXT_FILE_NAMES);
	const kept = files.filter((file) => allowed.has(file));
	const dropped = files.filter((file) => !allowed.has(file));
	if (dropped.length > 0) console.warn(`sureclaw-voice: realtime agent context ignoring unsupported files (${dropped.join(", ")}); allowed: ${REALTIME_BOOTSTRAP_CONTEXT_FILE_NAMES.join(", ")}`);
	return kept;
}
function buildIdentityCapsule(cfg, agentId) {
	const identity = resolveAgentIdentity(cfg, agentId);
	if (!identity) return void 0;
	const lines = [
		identity.name ? `Name: ${identity.name}` : void 0,
		identity.theme ? `Theme: ${identity.theme}` : void 0,
		identity.emoji ? `Emoji: ${identity.emoji}` : void 0
	].filter(Boolean);
	if (lines.length === 0) return void 0;
	return ["Agent identity (speak and act as this agent; do not read these lines aloud):", ...lines].join("\n");
}
function buildProviderConfigs(realtimeConfig) {
	const configs = realtimeConfig.providers;
	return configs && Object.keys(configs).length > 0 ? { ...configs } : void 0;
}
function buildProviderConfigOverrides(realtimeConfig) {
	const overrides = {
		...realtimeConfig.model ? { model: realtimeConfig.model } : {},
		...realtimeConfig.voice ? { voice: realtimeConfig.voice } : {},
		...typeof realtimeConfig.minBargeInAudioEndMs === "number" ? { minBargeInAudioEndMs: realtimeConfig.minBargeInAudioEndMs } : {}
	};
	return Object.keys(overrides).length > 0 ? overrides : void 0;
}
function buildRealtimeInstructions(params) {
	const base = params.instructions ?? ["You are OpenClaw's voice interface.", "Keep spoken replies concise, natural, and suitable for a live voice call."].join("\n");
	const consultPolicyInstructions = buildConsultPolicyInstructions(params.toolPolicy, params.consultPolicy);
	const fastContextInstructions = params.fastContextEnabled && params.toolPolicy !== "none" ? "You have two tools: fast_context for quick recall from memory and past sessions, and openclaw_agent_consult for the full agent. Prefer fast_context for remembering things; if it returns nothing relevant and the request needs tools, actions, current state, or deeper reasoning, call openclaw_agent_consult." : void 0;
	if (params.consultPolicy === "always") return [
		base,
		params.agentContextInstructions?.trim(),
		"Mode: OpenClaw agent proxy.",
		"You are the realtime voice surface for the same OpenClaw agent the user can message directly.",
		"Do not mention a backend, supervisor, helper, or separate system. Present the result as your own work.",
		"Delegate substantive requests, actions, tool work, current facts, memory, workspace context, and user-specific context with openclaw_agent_consult.",
		"Do not block, refuse, or downscope at the voice layer. Delegate to OpenClaw and treat its result as authoritative.",
		"Answer directly only for greetings, acknowledgements, brief latency tests, or filler while waiting.",
		"While waiting for OpenClaw data or tool results, use at most one short natural backchannel such as \"yeah\", \"mm-hmm\", \"got it\", or \"one sec\"; vary it and do not treat it as the final answer.",
		"When OpenClaw sends an internal exact answer to speak, do not call tools. Say only that answer.",
		fastContextInstructions,
		consultPolicyInstructions
	].filter(Boolean).join("\n\n");
	return [
		base,
		params.agentContextInstructions?.trim(),
		"While waiting for OpenClaw data or tool results, use at most one short natural backchannel such as \"yeah\", \"mm-hmm\", \"got it\", or \"one sec\"; vary it and do not treat it as the final answer.",
		fastContextInstructions,
		consultPolicyInstructions
	].filter(Boolean).join("\n\n");
}
function buildConsultPolicyInstructions(toolPolicy, consultPolicy) {
	if (consultPolicy === "never") return "Answer directly as a standalone voice assistant. There is no OpenClaw agent to consult in this session.";
	const policyLines = [toolPolicy === "none" ? "No OpenClaw agent consult tool is available in this session." : "Use openclaw_agent_consult for requests that need the OpenClaw agent, tools, actions, current project state, memory, or deeper reasoning."];
	if (consultPolicy === "always") policyLines.push("For substantive user turns, call openclaw_agent_consult before giving the final spoken answer.");
	else if (consultPolicy === "auto") policyLines.push("For simple greetings or short acknowledgements, answer directly. For anything substantive, consult OpenClaw first.");
	if (toolPolicy === "safe-read-only") policyLines.push("The consult tool may be limited to safe read-only work.");
	else if (toolPolicy === "owner") policyLines.push("The consult tool may perform owner-authorized OpenClaw work according to the server policy.");
	return policyLines.join(" ");
}
//#endregion
export { entry as default };
