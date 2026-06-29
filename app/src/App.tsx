import { FormEvent, useEffect, useRef, useState } from "react";
import { Mic, MicOff, Phone, PhoneOff, RotateCcw, Settings, X } from "lucide-react";
import type {
  CallStatus,
  GatewayEvent,
  GatewaySettings,
  RealtimeBrowserSession,
  ReplayTurn,
  TranscriptEntry,
} from "./types";
import { GatewayClient } from "./lib/gatewayClient";
import { OpenAIRealtimeCall } from "./lib/openaiRealtimeCall";
import {
  clearConversation,
  hasResumableConversation,
  loadConversation,
  saveConversation,
} from "./lib/transcriptStore";
import { callSounds } from "./lib/callSounds";
import { Visualizer } from "./Visualizer";
import { InstallBanner } from "./InstallBanner";
import { setCallActive } from "./callState";

const STORAGE_KEY = "openclaw.sureclaw-voice.settings";

// How long to wait after the model stops speaking before the "thinking" pending
// pulse comes in, so the cue doesn't clip the tail of the spoken lead-in.
const PENDING_PULSE_DELAY_MS = 700;

// How many times a dropped call silently reconnects (and replays the
// conversation) before giving up and surfacing the error screen. Each attempt
// backs off a little; a truly dead network exhausts these and the user is told.
const MAX_RECONNECT_ATTEMPTS = 4;

// Read the configured assistant name from the <meta name="x-app-assistant-name">
// tag, which the gateway rewrites from __APP_NAME__ at serve time. Falls back
// to "OpenClaw" when unset (e.g. when the page is opened directly from the Vite
// dev server without the gateway's token substitution).
function readAssistantName(): string {
  const raw = document
    .querySelector('meta[name="x-app-assistant-name"]')
    ?.getAttribute("content")
    ?.trim();
  // In the raw Vite dev server the gateway's token substitution hasn't run, so
  // the content is still the literal "__APP_NAME__" placeholder — treat any
  // unsubstituted __…__ token as unset and fall back to the default name.
  if (!raw || /^__.*__$/.test(raw)) return "OpenClaw";
  return raw;
}

const APP_NAME = readAssistantName();

// Reads the gateway's auth mode from the <meta name="x-app-gateway-auth"> tag,
// which the gateway rewrites from __APP_GATEWAY_AUTH__ at serve time. When the
// gateway authenticates the WebSocket through a trusted proxy (e.g. Cloudflare
// Access) rather than a token or password, there is no credential for the user
// to enter — so we hide the Settings sheet entirely. Any other value (token,
// password, or the unsubstituted placeholder seen on the raw Vite dev server)
// keeps Settings available for manual overrides.
function isProxyAuthedGateway(): boolean {
  return (
    document
      .querySelector('meta[name="x-app-gateway-auth"]')
      ?.getAttribute("content")
      ?.trim() === "trusted-proxy"
  );
}

const PROXY_AUTHED = isProxyAuthedGateway();

// Same-origin Gateway endpoint. When the app is served by the OpenClaw gateway
// itself (e.g. https://host/voice behind cloudflared), the WebSocket goes back
// to the same host — no hardcoded customer domain. Falls back to localhost for
// non-browser contexts. For local Vite HMR dev (page on :5173, gateway
// elsewhere), `app/openclaw/dev.sh` injects VITE_GATEWAY_URL so the PWA targets
// the auto-picked gateway WS without a manual Settings override.
// The dev-only gateway URL injected by `app/openclaw/dev.sh` via VITE_GATEWAY_URL.
// Gated on `import.meta.env.DEV` so it is ONLY honored in a dev build: Vite inlines
// `import.meta.env.*` at build time, so a stray VITE_GATEWAY_URL in the production
// build environment would otherwise be baked into the bundle as a literal and
// dead-code-eliminate the same-origin `window.location` path below — pinning every
// production client to localhost. In a production build this folds to `undefined`.
function injectedGatewayUrl(): string | undefined {
  if (!import.meta.env.DEV) return undefined;
  return import.meta.env.VITE_GATEWAY_URL as string | undefined;
}

function defaultGatewayUrl(): string {
  const injected = injectedGatewayUrl();
  if (injected) return injected;
  if (typeof window !== "undefined" && window.location?.host) {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}`;
  }
  return "ws://127.0.0.1:18789";
}

function log(line: string) {
  console.log(`[voice] ${new Date().toLocaleTimeString()} ${line}`);
}

// The PWA subscribes to the gateway's `tool-events` cap so a future UI can
// surface the agent's tool activity. During a substantive `openclaw_agent_consult`
// that firehose carries dozens of large `agent` frames in seconds — including raw
// exec output and full session-transcript dumps. Passing those payload objects
// straight to `console.debug` makes DevTools retain and serialize each one, which
// saturates the main thread and freezes the tab mid-call. Log a compact one-line
// summary for the high-volume `agent` stream and keep full payloads only for the
// bounded lifecycle events. Set `window.__voiceDebugToolEvents = true` to opt back
// into full agent payloads when inspecting a specific tool call.
function logGatewayEvent(event: GatewayEvent) {
  if (event.event !== "agent") {
    console.debug(`[gateway] event: ${event.event}`, event.payload);
    return;
  }
  const verbose = (globalThis as { __voiceDebugToolEvents?: boolean }).__voiceDebugToolEvents;
  if (verbose) {
    console.debug(`[gateway] event: agent`, event.payload);
    return;
  }
  const data = event.payload as { stream?: unknown; data?: { name?: unknown } } | undefined;
  const stream = typeof data?.stream === "string" ? data.stream : "?";
  const tool = typeof data?.data?.name === "string" ? ` tool=${data.data.name}` : "";
  const seq = typeof event.seq === "number" ? ` seq=${event.seq}` : "";
  // String-only log: nothing large is retained by the console.
  console.debug(`[gateway] event: agent stream=${stream}${tool}${seq}`);
}

function describeStatus(status: CallStatus): string {
  if (status === "idle") return "Ready to call";
  if (status === "connecting") return "Connecting…";
  if (status === "listening") return "Listening";
  if (status === "thinking") return "Thinking…";
  return "Call interrupted";
}

const defaultSettings: GatewaySettings = {
  gatewayUrl: defaultGatewayUrl(),
  authMode: "token",
  secret: "",
  sessionKey: "",
};

function loadSettings(): GatewaySettings {
  // In Vite HMR dev, dev.sh injects VITE_GATEWAY_URL for the auto-picked
  // gateway port. Treat it as authoritative — it wins over a stale
  // localStorage URL so the PWA always hits the rig's WS, not a dead same-origin.
  // `injectedGatewayUrl()` is dev-only, so in production this is always undefined
  // and a stored or same-origin URL is never clobbered by a baked-in localhost.
  const injected = injectedGatewayUrl();
  try {
    const merged: GatewaySettings = {
      ...defaultSettings,
      ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"),
    };
    if (injected) merged.gatewayUrl = injected;
    return merged;
  } catch {
    return injected ? { ...defaultSettings, gatewayUrl: injected } : defaultSettings;
  }
}

// oxlint-disable-next-line react-doctor/no-giant-component, react-doctor/prefer-useReducer
export default function App() {
  const [settings, setSettings] = useState<GatewaySettings>(() => loadSettings());
  const [saved, setSaved] = useState(false);
  // The gateway authenticates the WebSocket itself (token or trusted-proxy /
  // Cloudflare Access), so the app needs no credential to start — don't force
  // the settings sheet open. It stays available via the gear for overrides
  // (e.g. a manual token against a token-auth gateway, or a dev gateway URL).
  const [showSettings, setShowSettings] = useState(false);
  const [status, setStatus] = useState<CallStatus>("idle");
  const [detail, setDetail] = useState<string>("");
  const [errorTitle, setErrorTitle] = useState<string>("Call interrupted");
  const [streams, setStreams] = useState<Array<{ kind: "mic" | "remote"; stream: MediaStream }>>(
    [],
  );
  const [muted, setMuted] = useState(false);
  // Whether the assistant's audio is actually playing out the speakers right
  // now (tracked from the WebRTC output-buffer lifecycle, not the data-channel
  // events that race ahead of playback). Used to hold call cues until the model
  // has finished speaking.
  const [speaking, setSpeaking] = useState(false);
  // Whether a full OpenClaw agent consult is in flight — the long dead-air wait
  // the pending pulse fills. Tracked separately from the status detail, which
  // now shows live tool activity ("Running bash…") rather than a fixed string.
  const [consulting, setConsulting] = useState(false);
  // Whether a prior conversation is saved and can be resumed. Seeded from
  // storage so it survives a full PWA close, and kept in sync as turns are
  // captured / cleared. Drives the idle Resume-vs-Start-new choice.
  const [resumeAvailable, setResumeAvailable] = useState(() => hasResumableConversation());
  const gatewayRef = useRef<GatewayClient | null>(null);
  const callRef = useRef<OpenAIRealtimeCall | null>(null);
  // The live transcript of the current/last call, captured turn-by-turn from the
  // realtime session and mirrored to storage. Replayed into a fresh session on
  // reconnect/resume so the model picks the conversation back up.
  const transcriptRef = useRef<ReplayTurn[]>([]);
  // The sessionKey the current call resolved to, so captured turns persist under
  // the right key even when it was auto-resolved (settings.sessionKey empty).
  const sessionKeyRef = useRef<string>("");
  // Consecutive auto-reconnect attempts since the last stable connection. Reset
  // to 0 once a reconnect reaches "listening"; capped by MAX_RECONNECT_ATTEMPTS.
  const reconnectAttemptsRef = useRef(0);
  // Whether the user currently intends to be in a call. Guards against a late
  // connection-lost event (after a deliberate hang-up) flipping to an error.
  const wantCallRef = useRef(false);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  // Previous call status, so we can fire a cue only on the transition into a
  // state (not on every re-render or the listening⇄thinking toggle).
  const prevStatusRef = useRef<CallStatus>("idle");

  const statusText = describeStatus(status);

  function updateSettings(next: Partial<GatewaySettings>) {
    setSettings((current) => ({ ...current, ...next }));
    setSaved(false);
  }

  function saveSettings(event?: FormEvent) {
    event?.preventDefault();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  }

  function addStream(kind: "mic" | "remote", stream: MediaStream) {
    setStreams((current) =>
      current.some((s) => s.stream === stream) ? current : [...current, { kind, stream }],
    );
  }

  // Starts a call either fresh ("new") or resuming the last conversation
  // ("resume"). Resume loads the saved transcript (and its sessionKey, so both
  // the voice layer and the OpenClaw session continue together); new wipes it.
  async function startCall(mode: "new" | "resume") {
    wantCallRef.current = true;
    // Resume audio from within the click gesture so the call cues are allowed
    // to play once the connection progresses.
    callSounds.unlock();
    saveSettings();
    setShowSettings(false);
    reconnectAttemptsRef.current = 0;

    let sessionKeyOverride: string | undefined;
    if (mode === "resume") {
      const stored = loadConversation();
      transcriptRef.current = stored ? [...stored.turns] : [];
      sessionKeyOverride = stored?.sessionKey || undefined;
    } else {
      transcriptRef.current = [];
      clearConversation();
      setResumeAvailable(false);
    }

    try {
      await establishCall({ replayTurns: [...transcriptRef.current], sessionKeyOverride });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      teardownCall();
      raiseFatalError("Couldn't start the call", message);
    }
  }

  // Builds a fresh Gateway connection + voice session + WebRTC call, seeding the
  // realtime session with `replayTurns` so a resume/reconnect continues the
  // conversation. `sessionKeyOverride` pins the session key (used by resume and
  // reconnect); otherwise it auto-resolves from settings/agents.list.
  async function establishCall(opts: {
    replayTurns: ReplayTurn[];
    sessionKeyOverride?: string;
  }) {
    teardownCall();
    setStatus("connecting");
    setDetail("Opening gateway");
    log("Connecting to Gateway");

    const gateway = new GatewayClient(
      settings.gatewayUrl.trim(),
      settings.authMode,
      settings.secret.trim(),
    );
    gatewayRef.current = gateway;
    gateway.addEventListener((event) => logGatewayEvent(event));
    await gateway.connect();
    log("Gateway connected");

    // Subscribe to session events so the gateway streams this session's tool
    // activity to us as `session.tool` events during an agent consult. The
    // `tool-events` connect cap alone only delivers tool frames to runs we are
    // registered as a recipient of, which the browser Talk consult path is not —
    // so without this the consult status can't show what the agent is running.
    try {
      await gateway.request("sessions.subscribe", {});
      log("Subscribed to session events");
    } catch (error) {
      log(`Session-event subscribe failed (tool activity may be hidden): ${String(error)}`);
    }

    const sessionKey = await resolveSessionKey(
      gateway,
      opts.sessionKeyOverride ?? settings.sessionKey,
    );
    sessionKeyRef.current = sessionKey;
    if (sessionKey !== settings.sessionKey) updateSettings({ sessionKey });

    setDetail("Setting up voice");
    const voiceSession = await createVoiceSessionWithRetry(
      gateway,
      {
        sessionKey,
        agentId: "main",
      },
      (attempt) => {
        setDetail(`Retrying setup (${attempt}/3)`);
        log(`Retrying voice session setup (${attempt}/3)`);
      },
    );

    if (voiceSession.transport !== "webrtc") {
      throw new Error(`Gateway returned unsupported transport: ${voiceSession.transport}`);
    }

    const call = new OpenAIRealtimeCall(
      gateway,
      sessionKey,
      voiceSession,
      {
        onStatus: (next, nextDetail = "") => {
          // Reaching "listening" means the (re)connection is stable, so the
          // reconnect budget is reset for the next independent drop.
          if (next === "listening") reconnectAttemptsRef.current = 0;
          setStatus(next);
          setDetail(nextDetail);
        },
        onTranscript: (entry: TranscriptEntry) => {
          console.debug(`[transcript] ${entry.role}: ${entry.text}`);
          captureTurn(entry);
        },
        onLog: log,
        onStream: addStream,
        onSpeaking: setSpeaking,
        onConsulting: setConsulting,
        // The realtime session is gone, but we hold the transcript — so a drop
        // is recoverable: reconnect and replay rather than dumping the user on
        // an error screen. attemptReconnect falls back to the error screen once
        // retries are exhausted or there is nothing captured to resume.
        onConnectionLost: (state) => {
          if (!wantCallRef.current) return; // already torn down by a deliberate hang-up
          void attemptReconnect(state);
        },
      },
      opts.replayTurns,
    );
    callRef.current = call;
    await call.start();
    log("WebRTC call started");
  }

  // Records a spoken turn (user or assistant — the transcript the model itself
  // emits) into the live buffer and mirrors it to storage, so the conversation
  // can be replayed into a fresh session on reconnect/resume.
  function captureTurn(entry: TranscriptEntry) {
    if (entry.role !== "user" && entry.role !== "assistant") return;
    const text = entry.text.trim();
    if (!text) return;
    transcriptRef.current.push({ role: entry.role, text });
    saveConversation(sessionKeyRef.current, transcriptRef.current);
    setResumeAvailable(true);
  }

  // Silently rebuilds the call after a drop, replaying the captured transcript
  // so the model resumes mid-conversation. Backs off per attempt and gives up to
  // the error screen once MAX_RECONNECT_ATTEMPTS is hit or nothing was captured.
  async function attemptReconnect(state: string) {
    const turns = transcriptRef.current;
    if (turns.length === 0 || reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
      teardownCall();
      raiseFatalError("Connection lost", describeConnectionLoss(state));
      return;
    }
    reconnectAttemptsRef.current += 1;
    const attempt = reconnectAttemptsRef.current;
    teardownCall();
    setStatus("connecting");
    setDetail(`Reconnecting (${attempt}/${MAX_RECONNECT_ATTEMPTS})…`);
    log(`Connection ${state}; reconnecting (attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS})`);
    await delay(750 * attempt);
    if (!wantCallRef.current) return; // hung up while waiting to retry
    try {
      await establishCall({
        replayTurns: [...turns],
        sessionKeyOverride: sessionKeyRef.current || undefined,
      });
    } catch (error) {
      // The rebuild failed before a live call existed, so no connection-lost
      // event will fire — re-arm the retry chain here (still bounded by the cap).
      log(`Reconnect attempt ${attempt} failed: ${String(error)}`);
      void attemptReconnect(state);
    }
  }

  // Tears down the active call + Gateway without changing the user's call intent.
  function teardownCall() {
    callRef.current?.stop();
    callRef.current = null;
    gatewayRef.current?.disconnect();
    gatewayRef.current = null;
    setStreams([]);
    setMuted(false);
  }

  function raiseFatalError(title: string, reason: string) {
    wantCallRef.current = false;
    setErrorTitle(title);
    setStatus("error");
    setDetail(reason);
    log(`${title}: ${reason}`);
  }

  function stopCall() {
    wantCallRef.current = false;
    callSounds.ended();
    teardownCall();
    setStatus("idle");
    setDetail("");
    log("Call ended");
  }

  function toggleMute() {
    setMuted((current) => {
      const next = !current;
      callRef.current?.setMicMuted(next);
      return next;
    });
  }

  function dismissError() {
    setStatus("idle");
    setDetail("");
  }

  const active = status === "connecting" || status === "listening" || status === "thinking";
  const isError = status === "error";

  // Keep the shared call-active flag in sync so the service-worker update
  // flow in main.tsx can defer an incoming reload until the call ends.
  useEffect(() => {
    setCallActive(active);
    return () => setCallActive(false);
  }, [active]);

  // Re-evaluate resumability whenever we settle back to idle, so a conversation
  // that has aged past the resume TTL stops being offered (hasResumableConversation
  // drops a stale record). The freshly-ended call's record is still within the
  // window here, so the normal post-hang-up flow keeps offering Resume.
  useEffect(() => {
    if (status === "idle") setResumeAvailable(hasResumableConversation());
  }, [status]);

  // Hold a screen wake lock while a call is active so the phone does not
  // auto-lock and suspend the WebRTC mic — the most common avoidable way a
  // foreground call dies. The browser releases the lock whenever the page is
  // hidden, so we re-acquire it each time we return to the foreground. (This
  // does NOT enable background calls; iOS still suspends the page on hide.)
  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    async function acquireWakeLock() {
      if (cancelled || document.visibilityState !== "visible") return;
      try {
        wakeLockRef.current = (await navigator.wakeLock?.request("screen")) ?? null;
      } catch {
        // Denied (e.g. low-power mode). The call still runs while foreground.
      }
    }

    function handleVisibility() {
      if (document.visibilityState === "visible") void acquireWakeLock();
    }

    void acquireWakeLock();
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibility);
      wakeLockRef.current?.release().catch(() => undefined);
      wakeLockRef.current = null;
    };
  }, [active]);

  // Map call-status transitions to the synthesized UI cues: a soft ringback
  // while connecting, a bright chime the moment the call goes live, and a low
  // tone if it drops to an error. Hang-up is handled in stopCall (a gesture).
  useEffect(() => {
    const prev = prevStatusRef.current;
    // oxlint-disable-next-line react-doctor/no-event-handler
    if (status !== prev) {
      if (status === "connecting") {
        callSounds.startRinging();
      } else if ((status === "listening" || status === "thinking") && prev === "connecting") {
        callSounds.connected();
      } else if (status === "error") {
        callSounds.error();
      } else if (status === "idle") {
        callSounds.stopRinging();
      }
      prevStatusRef.current = status;
    }
  }, [status]);

  // While the call hands off to OpenClaw (a consult that can take many
  // seconds), the line goes dead silent. Fill it with the soft "pending"
  // pulse — same theme as the other call cues — and kill it the moment the
  // consult resolves or the call leaves the consult state.
  useEffect(() => {
    // Hold the pending pulse until the model has actually stopped speaking — the
    // consult begins the moment the tool call lands on the data channel, which is
    // typically while the model's lead-in ("Let me look into that…") is still
    // playing out the speakers. Starting the cue then would talk over it.
    if (!(consulting && !speaking)) {
      callSounds.stopPending();
      return;
    }
    // Let a beat of silence settle after the lead-in finishes before the pulse
    // comes in — starting the instant speech ends clips its tail and feels
    // abrupt. If speech resumes or the consult resolves within the delay, the
    // cleanup cancels the start so the cue never plays.
    const timer = window.setTimeout(() => callSounds.startPending(), PENDING_PULSE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [consulting, speaking]);

  useEffect(() => {
    if (!showSettings) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowSettings(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showSettings]);

  return (
    <main className="app">
      <InstallBanner appName={APP_NAME} />

      <header className="bar">
        <span />
        {!PROXY_AUTHED && (
          <button
            type="button"
            className="iconButton"
            onClick={() => setShowSettings((value) => !value)}
            aria-label="Settings"
          >
            <Settings size={20} />
          </button>
        )}
      </header>

      <section className={`stage ${status}`}>
        <Visualizer streams={streams} status={status} />

        <div className="statusBlock">
          <strong>{isError ? errorTitle : statusText}</strong>
          {detail && <p>{detail}</p>}
        </div>

        <div className="dock">
          {isError ? (
            <>
              <button
                type="button"
                className="callButton call"
                onClick={() => startCall(resumeAvailable ? "resume" : "new")}
              >
                <RotateCcw size={22} />
                {resumeAvailable ? "Resume" : "Reconnect"}
              </button>
              <button type="button" className="textButton" onClick={dismissError}>
                Dismiss
              </button>
            </>
          ) : active ? (
            <>
              <button
                type="button"
                className={`callButton mute ${muted ? "muted" : ""}`}
                onClick={toggleMute}
                aria-pressed={muted}
              >
                {muted ? <MicOff size={22} /> : <Mic size={22} />}
                {muted ? "Unmute" : "Mute"}
              </button>
              <button type="button" className="callButton end" onClick={stopCall}>
                <PhoneOff size={22} />
                End call
              </button>
              {/* Dev-only: import.meta.env.DEV folds to a literal `false` in
                  production, so this branch is dead-code-eliminated from the
                  bundle and the button never ships. */}
              {import.meta.env.DEV && (
                <button
                  type="button"
                  className="textButton"
                  onClick={() => callRef.current?.simulateDropout()}
                >
                  Simulate dropout
                </button>
              )}
            </>
          ) : resumeAvailable ? (
            <>
              <button
                type="button"
                className="callButton call"
                onClick={() => startCall("resume")}
              >
                <Phone size={22} />
                Resume conversation
              </button>
              <button type="button" className="textButton" onClick={() => startCall("new")}>
                Start new
              </button>
            </>
          ) : (
            <button type="button" className="callButton call" onClick={() => startCall("new")}>
              <Phone size={22} />
              Call {APP_NAME}
            </button>
          )}
        </div>
      </section>

      {showSettings && !PROXY_AUTHED && (
        <div className="sheetBackdrop">
          <button
            type="button"
            className="sheetBackdrop__dismiss"
            aria-label="Close settings"
            onClick={() => setShowSettings(false)}
          />
          <dialog open className="sheet" aria-label="Settings">
            <div className="sheetHead">
              <h2>Settings</h2>
              <button
                type="button"
                className="iconButton"
                onClick={() => setShowSettings(false)}
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>
            <form onSubmit={saveSettings}>
              <label>
                <span>Gateway URL</span>
                <input
                  value={settings.gatewayUrl}
                  onChange={(event) => updateSettings({ gatewayUrl: event.target.value })}
                />
              </label>
              <div className="split">
                <label>
                  <span>Auth</span>
                  <select
                    value={settings.authMode}
                    onChange={(event) =>
                      updateSettings({
                        authMode: event.target.value as "token" | "password",
                      })
                    }
                  >
                    <option value="token">Token</option>
                    <option value="password">Password</option>
                  </select>
                </label>
                <label>
                  <span>Secret</span>
                  <input
                    type="password"
                    value={settings.secret}
                    onChange={(event) => updateSettings({ secret: event.target.value })}
                    autoComplete="current-password"
                  />
                </label>
              </div>
              <label>
                <span>Session key</span>
                <input
                  placeholder="Auto from agents.list"
                  value={settings.sessionKey}
                  onChange={(event) => updateSettings({ sessionKey: event.target.value })}
                />
              </label>
              <button className="saveButton" type="submit">
                {saved ? "Saved" : "Save"}
              </button>
            </form>
          </dialog>
        </div>
      )}
    </main>
  );
}

async function resolveSessionKey(gateway: GatewayClient, explicit: string) {
  const trimmed = explicit.trim();
  if (trimmed) return trimmed;
  try {
    const agents = (await gateway.request("agents.list", {}, 10000)) as {
      mainKey?: string;
    };
    if (agents.mainKey?.trim()) return agents.mainKey.trim();
  } catch {
    // The Gateway will still accept an explicit fallback session key.
  }
  return "agent:main:direct:openclaw-voice-pwa";
}

async function createVoiceSessionWithRetry(
  gateway: GatewayClient,
  params: Record<string, unknown>,
  onRetry: (attempt: number) => void,
) {
  const attempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // oxlint-disable-next-line react-doctor/async-await-in-loop
      return (await gateway.request(
        "browserVoice.create",
        params,
        60000,
      )) as RealtimeBrowserSession;
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isTransientVoiceSessionError(error)) break;
      onRetry(attempt + 1);
      await delay(750 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isTransientVoiceSessionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /UND_ERR_SOCKET|SocketError|other side closed|terminated|Gateway request timed out: browserVoice\.create/i.test(
    message,
  );
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function describeConnectionLoss(state: string) {
  if (state === "failed") {
    return "The voice connection failed and could not recover — usually a network drop or NAT/relay issue.";
  }
  if (state === "closed") {
    return "The voice connection closed unexpectedly.";
  }
  if (state === "disconnected") {
    return "The voice connection dropped and could not re-establish itself.";
  }
  return `The voice connection ended (${state}).`;
}
