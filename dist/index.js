import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveRealtimeBootstrapContextInstructions } from "openclaw/plugin-sdk/realtime-bootstrap-context";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL, resolveConfiguredRealtimeVoiceProvider, resolveRealtimeVoiceAgentConsultToolPolicy } from "openclaw/plugin-sdk/realtime-voice";
//#region index.ts
const PLUGIN_ID = "sureclaw-voice";
function resolveBrowserRealtimeConfig(cfg) {
	const config = cfg.plugins?.entries?.[PLUGIN_ID]?.config;
	const realtime = config?.realtime;
	if (!realtime || realtime.enabled === false) return void 0;
	return {
		realtimeConfig: realtime,
		mode: normalizeVoiceMode(config?.mode ?? realtime.mode)
	};
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
							apiToken: { type: "string" },
							apiTokenEnv: { type: "string" },
							ttlSeconds: { type: "number" }
						}
					}
				}
			},
			webapp: {
				type: "object",
				additionalProperties: false,
				properties: {
					enabled: { type: "boolean" },
					path: { type: "string" },
					dir: { type: "string" },
					name: { type: "string" }
				}
			},
			mode: {
				type: "string",
				enum: [
					"agent-proxy",
					"stt-tts",
					"bidi"
				]
			},
			realtime: {
				type: "object",
				additionalProperties: true
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
				const resolved = resolveBrowserRealtimeConfig(cfg);
				if (!resolved) {
					respond(false, void 0, {
						code: "UNAVAILABLE",
						message: "No realtime voice config found — configure plugins.entries.sureclaw-voice.config.realtime"
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
					noRegisteredProviderMessage: "No configured realtime voice provider registered"
				});
				if (!resolution.provider.createBrowserSession) {
					respond(false, void 0, {
						code: "UNAVAILABLE",
						message: `Realtime provider "${resolution.provider.id}" does not support browser WebRTC sessions`
					});
					return;
				}
				const mode = resolved.mode;
				const toolPolicy = resolveRealtimeVoiceAgentConsultToolPolicy(realtimeConfig.toolPolicy, mode === "agent-proxy" ? "owner" : "safe-read-only");
				const consultPolicy = realtimeConfig.consultPolicy ?? (mode === "agent-proxy" ? "always" : "auto");
				const bootstrapContextInstructions = await resolveBootstrapContext({
					cfg,
					realtimeConfig,
					sessionKey: typedParams.sessionKey,
					agentId: typedParams.agentId
				});
				const session = await resolution.provider.createBrowserSession({
					cfg,
					providerConfig: resolution.providerConfig,
					instructions: buildRealtimeInstructions({
						mode,
						instructions: realtimeConfig.instructions,
						bootstrapContextInstructions,
						toolPolicy,
						consultPolicy
					}),
					tools: toolPolicy === "none" ? [] : [REALTIME_VOICE_AGENT_CONSULT_TOOL],
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
	if (webapp?.enabled === false) return;
	const dir = resolveWebappDir(webapp?.dir);
	if (!dir) {
		api.logger?.warn?.("sureclaw-voice: voice web app not served — no built assets found. Build the PWA and stage it into the plugin's webapp/ directory (npm run build), or set plugins.entries.sureclaw-voice.config.webapp.dir.");
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
function resolveWebappDir(configDir) {
	if (configDir) {
		const dir = resolve(configDir);
		return existsSync(resolve(dir, "index.html")) ? dir : void 0;
	}
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
		const apiToken = cf.apiToken || (cf.apiTokenEnv ? readEnv(cf.apiTokenEnv) : void 0);
		if (!apiToken) console.warn("sureclaw-voice: cloudflareTurn.keyId is set but no apiToken/apiTokenEnv resolved; skipping TURN.");
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
async function resolveBootstrapContext(params) {
	const files = params.realtimeConfig.bootstrapContextFiles;
	if (files?.length === 0) return void 0;
	try {
		return await resolveRealtimeBootstrapContextInstructions({
			config: params.cfg,
			agentId: params.agentId || "main",
			sessionKey: params.sessionKey,
			files,
			warn: (message) => console.warn(`sureclaw-voice: realtime bootstrap context: ${message}`)
		});
	} catch (error) {
		console.warn(`sureclaw-voice: realtime bootstrap context unavailable: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
}
function normalizeVoiceMode(mode) {
	if (mode === "stt-tts" || mode === "bidi") return mode;
	return "agent-proxy";
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
	if (params.mode === "agent-proxy") return [
		base,
		params.bootstrapContextInstructions?.trim(),
		"Mode: OpenClaw agent proxy.",
		"You are the realtime voice surface for the same OpenClaw agent the user can message directly.",
		"Do not mention a backend, supervisor, helper, or separate system. Present the result as your own work.",
		"Delegate substantive requests, actions, tool work, current facts, memory, workspace context, and user-specific context with openclaw_agent_consult.",
		"Do not block, refuse, or downscope at the voice layer. Delegate to OpenClaw and treat its result as authoritative.",
		"Answer directly only for greetings, acknowledgements, brief latency tests, or filler while waiting.",
		"While waiting for OpenClaw data or tool results, use at most one short natural backchannel such as \"yeah\", \"mm-hmm\", \"got it\", or \"one sec\"; vary it and do not treat it as the final answer.",
		"When OpenClaw sends an internal exact answer to speak, do not call tools. Say only that answer.",
		consultPolicyInstructions
	].filter(Boolean).join("\n\n");
	return [
		base,
		params.bootstrapContextInstructions?.trim(),
		"While waiting for OpenClaw data or tool results, use at most one short natural backchannel such as \"yeah\", \"mm-hmm\", \"got it\", or \"one sec\"; vary it and do not treat it as the final answer.",
		consultPolicyInstructions
	].filter(Boolean).join("\n\n");
}
function buildConsultPolicyInstructions(toolPolicy, consultPolicy) {
	const policyLines = [toolPolicy === "none" ? "No OpenClaw agent consult tool is available in this session." : "Use openclaw_agent_consult for requests that need the OpenClaw agent, tools, actions, current project state, memory, or deeper reasoning."];
	if (consultPolicy === "always") policyLines.push("For substantive user turns, call openclaw_agent_consult before giving the final spoken answer.");
	else if (consultPolicy === "auto") policyLines.push("For simple greetings or short acknowledgements, answer directly. For anything substantive, consult OpenClaw first.");
	if (toolPolicy === "safe-read-only") policyLines.push("The consult tool may be limited to safe read-only work.");
	else if (toolPolicy === "owner") policyLines.push("The consult tool may perform owner-authorized OpenClaw work according to the server policy.");
	return policyLines.join(" ");
}
//#endregion
export { entry as default };
