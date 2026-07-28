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
import { BrowserRealtimeCall } from "./lib/openaiRealtimeCall";
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

// How long after the latest captured turn before the rolling transcript flush
// fires. Resets per turn, so a rapid exchange batches into one inject instead
// of one per line.
const TRANSCRIPT_FLUSH_DEBOUNCE_MS = 2000;

type TranscriptPersistenceState = {
  flushedTurnCount: number;
  injected: boolean;
  chain: Promise<void> | null;
};

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
    document.querySelector('meta[name="x-app-gateway-auth"]')?.getAttribute("content")?.trim() ===
    "trusted-proxy"
  );
}

const PROXY_AUTHED = isProxyAuthedGateway();

// Whether, on hang-up, we also run an agent turn to store memories from the call.
// Read from the <meta name="x-app-record-memories"> tag the gateway rewrites from
// __APP_RECORD_MEMORIES__ (config: webapp.recordMemoriesOnCallEnd). Off unless
// explicitly "true" — the transcript is always persisted regardless; this only
// controls the extra per-call memory-extraction turn. The unsubstituted
// placeholder on the raw Vite dev server therefore stays off.
function readRecordMemories(): boolean {
  return (
    document
      .querySelector('meta[name="x-app-record-memories"]')
      ?.getAttribute("content")
      ?.trim() === "true"
  );
}

const RECORD_MEMORIES = readRecordMemories();

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
};

function loadSettings(): GatewaySettings {
  // In Vite HMR dev, dev.sh injects VITE_GATEWAY_URL for the auto-picked
  // gateway port. Treat it as authoritative — it wins over a stale
  // localStorage URL so the PWA always hits the rig's WS, not a dead same-origin.
  // `injectedGatewayUrl()` is dev-only, so in production this is always undefined
  // and a stored or same-origin URL is never clobbered by a baked-in localhost.
  const injected = injectedGatewayUrl();
  try {
    const stored = JSON.parse(
      localStorage.getItem(STORAGE_KEY) || "{}",
    ) as Partial<GatewaySettings>;
    const merged: GatewaySettings = {
      gatewayUrl: stored.gatewayUrl ?? defaultSettings.gatewayUrl,
      authMode: stored.authMode ?? defaultSettings.authMode,
      secret: stored.secret ?? defaultSettings.secret,
    };
    if (injected) merged.gatewayUrl = injected;
    return merged;
  } catch {
    return injected ? { ...defaultSettings, gatewayUrl: injected } : defaultSettings;
  }
}

// Formats transcript turns as the `User:`/`Assistant:` lines persisted into the
// OpenClaw session — one shape shared by the rolling and hang-up flushes.
function formatTranscriptLines(turns: ReplayTurn[]): string {
  return turns
    .map((turn) => `${turn.role === "assistant" ? "Assistant" : "User"}: ${turn.text}`)
    .join("\n");
}

// Silently append the transcript to the session (no agent run). The session may
// not exist yet on a call that never triggered a consult, so on "not found" we
// create it (no run) and retry once. `continued` marks a rolling follow-up
// inject so the session reads as one transcript split across messages.
async function appendTranscriptSilently(
  gateway: GatewayClient,
  sessionKey: string,
  transcript: string,
  continued: boolean,
) {
  const header = continued ? "[Voice call transcript (continued)]" : "[Voice call transcript]";
  const params = {
    sessionKey,
    message: `${header}\n${transcript}`,
    label: "voice-transcript",
  };
  try {
    await gateway.request("chat.inject", params, 5000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/not.?found|unknown session|no such session/i.test(message)) throw error;
    // The session does not exist yet (no consult happened this call): create
    // it without starting a run, then retry the append.
    await gateway.request("sessions.create", { key: sessionKey }, 5000);
    await gateway.request("chat.inject", params, 5000);
  }
}

// Opt-in: run one agent turn at hang-up that stores memories from the call.
// chat.send starts a durable server-side run (it acks immediately and creates
// the session if needed). The transcript itself now reaches the session via the
// rolling [Voice call transcript] injects, so when those already ran
// (`injectedEarlier`) this turn only carries the not-yet-injected tail plus a
// pointer to the injected messages; otherwise it carries the full transcript
// as before.
async function persistWithMemoryTurn(
  gateway: GatewayClient,
  sessionKey: string,
  transcript: string,
  injectedEarlier: boolean,
) {
  const message = [
    "[Voice call ended]",
    ...(injectedEarlier
      ? [
          "The transcript of the voice call that just ended is in the preceding [Voice call transcript] messages.",
          ...(transcript ? ["", "Final turns not yet included there:", "", transcript] : []),
        ]
      : ["Transcript of the voice call that just ended:", "", transcript]),
    "",
    "Store anything worth remembering long-term, following your normal memory practice. No spoken reply is needed.",
  ].join("\n");
  await gateway.request(
    "chat.send",
    { sessionKey, message, idempotencyKey: `voice-flush-${sessionKey}-${crypto.randomUUID()}` },
    5000,
  );
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
  const callRef = useRef<BrowserRealtimeCall | null>(null);
  // The live transcript of the current/last call, captured turn-by-turn from the
  // realtime session and mirrored to storage. Replayed into a fresh session on
  // reconnect/resume so the model picks the conversation back up.
  const transcriptRef = useRef<ReplayTurn[]>([]);
  // Debounce timer for the rolling transcript flush — reset on every captured
  // turn so a rapid exchange lands as one inject.
  const flushTimerRef = useRef<number | null>(null);
  // Replaced for each user-started call and retained over reconnects. Keeping
  // the write chain and watermarks per call prevents a slow write from an ended
  // call mutating the next call's persistence state.
  const persistenceStateRef = useRef<TranscriptPersistenceState>({
    flushedTurnCount: 0,
    injected: false,
    chain: null,
  });
  // The sessionKey the current call resolved to, so captured turns persist under
  // the right internally minted key.
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
    // A new call gets a fresh transcript-message header; a stale debounce from
    // the previous call must not fire into this one. (Reconnects go through
    // establishCall directly and deliberately keep both.)
    cancelScheduledFlush();

    let sessionKeyOverride: string | undefined;
    let flushedTurnCount = 0;
    if (mode === "resume") {
      const stored = loadConversation();
      transcriptRef.current = stored ? [...stored.turns] : [];
      const storedFlushedTurnCount =
        typeof stored?.flushedTurnCount === "number" && Number.isFinite(stored.flushedTurnCount)
          ? stored.flushedTurnCount
          : 0;
      flushedTurnCount = Math.max(
        0,
        Math.min(transcriptRef.current.length, storedFlushedTurnCount),
      );
      sessionKeyOverride = stored?.sessionKey || undefined;
    } else {
      transcriptRef.current = [];
      clearConversation();
      setResumeAvailable(false);
    }
    persistenceStateRef.current = {
      flushedTurnCount,
      injected: false,
      chain: null,
    };

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
  async function establishCall(opts: { replayTurns: ReplayTurn[]; sessionKeyOverride?: string }) {
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

    const sessionKey = await resolveSessionKey(gateway, opts.sessionKeyOverride ?? "");
    const agentId = parseAgentIdFromSessionKey(sessionKey) ?? (await resolveMainAgentId(gateway));
    // Hold the resolved key for this call so captured turns and the end-of-call
    // flush target it. Deliberately not written back to Settings: persisting a
    // minted key would pin every later call to it, defeating one-session-per-call.
    // The key still survives a drop (reconnect reuses sessionKeyRef) and a resume
    // (saveConversation stores it alongside the transcript).
    sessionKeyRef.current = sessionKey;

    setDetail("Setting up voice");
    const voiceSession = await createVoiceSessionWithRetry(
      gateway,
      {
        sessionKey,
        agentId,
      },
      (attempt) => {
        setDetail(`Retrying setup (${attempt}/3)`);
        log(`Retrying voice session setup (${attempt}/3)`);
      },
    );

    const returnedTransport = (voiceSession as { transport?: unknown }).transport;
    if (returnedTransport !== "webrtc" && returnedTransport !== "provider-websocket") {
      throw new Error(`Gateway returned unsupported transport: ${String(returnedTransport)}`);
    }

    const call = new BrowserRealtimeCall(
      gateway,
      sessionKey,
      agentId,
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
    log(`${voiceSession.provider} realtime call started (${voiceSession.transport})`);
  }

  // Records a spoken turn (user or assistant — the transcript the model itself
  // emits) into the live buffer and mirrors it to storage, so the conversation
  // can be replayed into a fresh session on reconnect/resume.
  function captureTurn(entry: TranscriptEntry) {
    if (entry.role !== "user" && entry.role !== "assistant") return;
    const text = entry.text.trim();
    if (!text) return;
    transcriptRef.current.push({ role: entry.role, text });
    saveConversation(
      sessionKeyRef.current,
      transcriptRef.current,
      persistenceStateRef.current.flushedTurnCount,
    );
    setResumeAvailable(true);
    scheduleTranscriptFlush();
  }

  // Debounced rolling persistence: flush the not-yet-flushed turns into the
  // OpenClaw session a beat after the latest captured turn, so the session
  // tracks the call as it happens instead of only at hang-up. The timer resets
  // per turn; the actual flush is chained on the per-call persistence state so
  // a slow inject can never interleave with (or be overtaken by) the next one.
  function scheduleTranscriptFlush() {
    if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null;
      const gateway = gatewayRef.current;
      // Only flush while the gateway is live and a call session key exists —
      // otherwise leave the turns unflushed for the next flush (or hang-up).
      if (!gateway?.connected || !sessionKeyRef.current) return;
      const state = persistenceStateRef.current;
      const sessionKey = sessionKeyRef.current;
      const turns = transcriptRef.current;
      state.chain = (state.chain ?? Promise.resolve()).then(() =>
        flushPendingTurnsToSession(gateway, sessionKey, turns, state),
      );
    }, TRANSCRIPT_FLUSH_DEBOUNCE_MS);
  }

  function cancelScheduledFlush() {
    if (flushTimerRef.current === null) return;
    window.clearTimeout(flushTimerRef.current);
    flushTimerRef.current = null;
  }

  // The incremental-flush core: append the turns captured since the last flush
  // to the OpenClaw session via the silent chat.inject path (never chat.send
  // mid-call). The watermark advances only after the gateway acknowledges the
  // append, so a later rolling or hang-up flush retries any failed batch.
  async function flushPendingTurnsToSession(
    gateway: GatewayClient,
    sessionKey: string,
    turns: ReplayTurn[],
    state: TranscriptPersistenceState,
  ) {
    if (!sessionKey) return;
    const targetTurnCount = turns.length;
    const unflushedTurns = turns.slice(state.flushedTurnCount, targetTurnCount);
    if (unflushedTurns.length === 0) return;
    const continued = state.injected;
    try {
      await appendTranscriptSilently(
        gateway,
        sessionKey,
        formatTranscriptLines(unflushedTurns),
        continued,
      );
      state.flushedTurnCount = targetTurnCount;
      state.injected = true;
      saveConversationIfCurrent(sessionKey, turns, state);
    } catch (error) {
      log(`Rolling transcript persist failed: ${String(error)}`);
    }
  }

  function saveConversationIfCurrent(
    sessionKey: string,
    turns: ReplayTurn[],
    state: TranscriptPersistenceState,
  ) {
    if (
      persistenceStateRef.current !== state ||
      transcriptRef.current !== turns ||
      sessionKeyRef.current !== sessionKey
    ) {
      return;
    }
    saveConversation(sessionKey, turns, state.flushedTurnCount);
  }

  // Silently rebuilds the call after a drop, replaying the captured transcript
  // so the model resumes mid-conversation. Backs off per attempt and gives up to
  // the error screen once MAX_RECONNECT_ATTEMPTS is hit or nothing was captured.
  async function attemptReconnect(state: string) {
    const turns = transcriptRef.current;
    if (turns.length === 0 || reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
      // The call is over for good — best-effort flush of any turns the rolling
      // persistence hasn't sent (the realtime side already committed pending
      // speech into transcriptRef before reporting the loss). The gateway WS is
      // separate from the WebRTC leg, so it is often still alive here; bounded
      // inside flushTranscriptToSession so the error screen isn't held up.
      await flushTranscriptToSession(gatewayRef.current);
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
    // The guard reads a ref that can flip during the backoff delay, so it must run after it.
    // oxlint-disable-next-line react-doctor/async-defer-await
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

  async function stopCall() {
    const gateway = gatewayRef.current;
    wantCallRef.current = false;
    callSounds.ended();
    // Stop audio/mic and settle the UI right away so hang-up feels instant...
    callRef.current?.stop();
    callRef.current = null;
    setStreams([]);
    setMuted(false);
    setStatus("idle");
    setDetail("");
    // ...but keep the socket open just long enough to hand this call's transcript
    // to the gateway for the memory flush, then drop it. Bounded inside
    // flushTranscriptToSession so a slow gateway can't stall the disconnect.
    await flushTranscriptToSession(gateway);
    gateway?.disconnect();
    if (gatewayRef.current === gateway) gatewayRef.current = null;
    log("Call ended");
  }

  // On hang-up (or a call that dropped for good), persist whatever the rolling
  // flush hasn't sent yet into the OpenClaw session so it survives the call and
  // is referenceable later — the session is a recall source, and memory
  // dreaming (if enabled) can promote it. Usually a near no-op now: the rolling
  // injects have already carried the transcript. Best-effort: a failure here
  // must never surface as a call error, and we cap the wait so hang-up stays
  // snappy.
  async function flushTranscriptToSession(gateway: GatewayClient | null) {
    // The debounced rolling flush must not fire after teardown into a dead (or
    // worse, the next call's) gateway.
    cancelScheduledFlush();
    const sessionKey = sessionKeyRef.current;
    const turns = transcriptRef.current;
    if (!gateway || !sessionKey || turns.length === 0) return;
    const state = persistenceStateRef.current;
    // chat.inject appends the transcript to the session with NO agent turn (no
    // reply, no wasted tokens). chat.send is used only when memory recording is
    // enabled, since actively storing memories needs an agent turn. Chained
    // onto the rolling-flush queue so this final write can't overtake or
    // interleave with a rolling inject still in flight. Determine the tail only
    // after earlier writes settle so a successful rolling append is not sent
    // twice and a failed one is retried here.
    const request = (state.chain ?? Promise.resolve()).then(async () => {
      const targetTurnCount = turns.length;
      const unflushedTurns = turns.slice(state.flushedTurnCount, targetTurnCount);
      const injectedEarlier = state.injected;
      // Nothing new this call at all (no unflushed tail and no rolling injects
      // to summarize a memory turn over) — skip entirely.
      if (unflushedTurns.length === 0 && !(RECORD_MEMORIES && injectedEarlier)) return;
      const transcript = formatTranscriptLines(unflushedTurns);
      if (RECORD_MEMORIES) {
        await persistWithMemoryTurn(gateway, sessionKey, transcript, injectedEarlier);
      } else {
        await appendTranscriptSilently(gateway, sessionKey, transcript, injectedEarlier);
        state.injected = true;
      }
      state.flushedTurnCount = targetTurnCount;
      saveConversationIfCurrent(sessionKey, turns, state);
    });
    state.chain = request.then(
      () => undefined,
      () => undefined,
    );
    // These ack as soon as the write starts / run starts, so this resolves fast;
    // the cap is just a safety net so a stalled socket can't hold up disconnect.
    await Promise.race([
      request.catch((error) => log(`Transcript persist failed: ${String(error)}`)),
      delay(1500),
    ]);
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
  // Deliberately an effect, not per-handler calls: "idle" is reached from several
  // paths (hang-up, error dismissal, the call's onStatus callback) and the check
  // is wall-clock TTL-dependent, so one central re-evaluation is the robust shape.
  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-event-handler, react-doctor/no-chain-state-updates
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
              <button type="button" className="callButton call" onClick={() => startCall("resume")}>
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

// Resolves the sessionKey for a call. A stored key carried by resume/reconnect
// is honored verbatim.
// Otherwise a *new* call mints a fresh session under the main agent: a unique
// suffix so each call is its own conversation thread, while the agent (and its
// long-term memory) stays the same across calls. Nothing is minted back into
// Settings, so the next new call mints again — one session per call.
async function resolveSessionKey(gateway: GatewayClient, explicit: string) {
  const trimmed = explicit.trim();
  if (trimmed) return trimmed;
  const agentId = await resolveMainAgentId(gateway);
  // Key under the `voice` channel so OpenClaw-native tooling (session/cost views,
  // the token-usage rollup) buckets these as voice without special-casing. The
  // `agent:<id>:` prefix is kept deliberately: it binds the session to the main
  // agent's store, which is what shares long-term memory across calls — a bare
  // `voice:` key carries no agent identity and would fall back to default routing.
  return `agent:${agentId}:voice:sureclaw-${crypto.randomUUID()}`;
}

function parseAgentIdFromSessionKey(sessionKey: string): string | undefined {
  const parts = sessionKey.split(":");
  return parts[0] === "agent" && parts[1] ? parts[1] : undefined;
}

// Derives the configured main agent's id from agents.list so a minted session
// key attaches to the real main agent even when it isn't literally "main".
// Falls back to "main" if the lookup fails or returns nothing usable.
async function resolveMainAgentId(gateway: GatewayClient): Promise<string> {
  try {
    const agents = (await gateway.request("agents.list", {}, 10000)) as { defaultId?: string };
    const defaultId = agents.defaultId?.trim();
    if (defaultId) return defaultId;
  } catch {
    // Fall back to the conventional id below.
  }
  return "main";
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
