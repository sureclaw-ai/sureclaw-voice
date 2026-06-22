import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Phone, PhoneOff, RotateCcw, Settings, X } from "lucide-react";
import type {
  CallStatus,
  GatewaySettings,
  RealtimeBrowserSession,
  TranscriptEntry,
} from "./types";
import { GatewayClient } from "./lib/gatewayClient";
import { OpenAIRealtimeCall } from "./lib/openaiRealtimeCall";
import { callSounds } from "./lib/callSounds";
import { Visualizer } from "./Visualizer";

const STORAGE_KEY = "openclaw.voice.settings";

// Same-origin Gateway endpoint. When the app is served by the OpenClaw gateway
// itself (e.g. https://host/voice behind cloudflared), the WebSocket goes back
// to the same host — no hardcoded customer domain. Falls back to localhost for
// non-browser contexts. Override in Settings for local dev (an SSH tunnel to
// ws://127.0.0.1:18789).
function defaultGatewayUrl(): string {
  if (typeof window !== "undefined" && window.location?.host) {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}`;
  }
  return "ws://127.0.0.1:18789";
}

const defaultSettings: GatewaySettings = {
  gatewayUrl: defaultGatewayUrl(),
  authMode: "token",
  secret: "",
  sessionKey: "",
};

function loadSettings(): GatewaySettings {
  try {
    return {
      ...defaultSettings,
      ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"),
    };
  } catch {
    return defaultSettings;
  }
}

export default function App() {
  const [settings, setSettings] = useState<GatewaySettings>(() =>
    loadSettings(),
  );
  const [saved, setSaved] = useState(false);
  // The gateway authenticates the WebSocket itself (token or trusted-proxy /
  // Cloudflare Access), so the app needs no credential to start — don't force
  // the settings sheet open. It stays available via the gear for overrides
  // (e.g. a manual token against a token-auth gateway, or a dev gateway URL).
  const [showSettings, setShowSettings] = useState(false);
  const [status, setStatus] = useState<CallStatus>("idle");
  const [detail, setDetail] = useState<string>("");
  const [errorTitle, setErrorTitle] = useState<string>("Call interrupted");
  const [streams, setStreams] = useState<
    Array<{ kind: "mic" | "remote"; stream: MediaStream }>
  >([]);
  const gatewayRef = useRef<GatewayClient | null>(null);
  const callRef = useRef<OpenAIRealtimeCall | null>(null);
  // Whether the user currently intends to be in a call. Guards against a late
  // connection-lost event (after a deliberate hang-up) flipping to an error.
  const wantCallRef = useRef(false);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  // Previous call status, so we can fire a cue only on the transition into a
  // state (not on every re-render or the listening⇄thinking toggle).
  const prevStatusRef = useRef<CallStatus>("idle");

  const statusText = useMemo(() => {
    if (status === "idle") return "Ready to call";
    if (status === "connecting") return "Connecting…";
    if (status === "listening") return "Listening";
    if (status === "thinking") return "Thinking…";
    return "Call interrupted";
  }, [status]);

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

  function log(line: string) {
    console.log(`[voice] ${new Date().toLocaleTimeString()} ${line}`);
  }

  function addStream(kind: "mic" | "remote", stream: MediaStream) {
    setStreams((current) =>
      current.some((s) => s.stream === stream)
        ? current
        : [...current, { kind, stream }],
    );
  }

  async function startCall() {
    wantCallRef.current = true;
    // Resume audio from within the click gesture so the call cues are allowed
    // to play once the connection progresses.
    callSounds.unlock();
    saveSettings();
    setShowSettings(false);
    try {
      await establishCall();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      teardownCall();
      raiseFatalError("Couldn't start the call", message);
    }
  }

  // Builds a fresh Gateway connection + voice session + WebRTC call.
  async function establishCall() {
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
    gateway.addEventListener((event) =>
      console.debug(`[gateway] event: ${event.event}`, event.payload),
    );
    await gateway.connect();
    log("Gateway connected");

    const sessionKey = await resolveSessionKey(gateway, settings.sessionKey);
    if (sessionKey !== settings.sessionKey) updateSettings({ sessionKey });

    setDetail("Setting up voice");
    const voiceSession = await createDiscordVoiceSessionWithRetry(
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
      throw new Error(
        `Gateway returned unsupported transport: ${voiceSession.transport}`,
      );
    }

    const call = new OpenAIRealtimeCall(gateway, sessionKey, voiceSession, {
      onStatus: (next, nextDetail = "") => {
        setStatus(next);
        setDetail(nextDetail);
      },
      onTranscript: (entry: TranscriptEntry) =>
        console.debug(`[transcript] ${entry.role}: ${entry.text}`),
      onLog: log,
      onStream: addStream,
      // A fatal WebRTC loss does NOT silently reconnect — it surfaces an error
      // screen so the drop is visible and the user decides whether to redial.
      onConnectionLost: (state) => {
        if (!wantCallRef.current) return; // already torn down by a deliberate hang-up
        teardownCall();
        raiseFatalError("Connection lost", describeConnectionLoss(state));
      },
    });
    callRef.current = call;
    await call.start();
    log("WebRTC call started");
  }

  // Tears down the active call + Gateway without changing the user's call intent.
  function teardownCall() {
    callRef.current?.stop();
    callRef.current = null;
    gatewayRef.current?.disconnect();
    gatewayRef.current = null;
    setStreams([]);
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

  function dismissError() {
    setStatus("idle");
    setDetail("");
  }

  const active =
    status === "connecting" || status === "listening" || status === "thinking";
  const isError = status === "error";

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
        wakeLockRef.current =
          (await navigator.wakeLock?.request("screen")) ?? null;
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
    if (status !== prev) {
      if (status === "connecting") {
        callSounds.startRinging();
      } else if (
        (status === "listening" || status === "thinking") &&
        prev === "connecting"
      ) {
        callSounds.connected();
      } else if (status === "error") {
        callSounds.error();
      } else if (status === "idle") {
        callSounds.stopRinging();
      }
      prevStatusRef.current = status;
    }
  }, [status]);

  return (
    <main className="app">
      <header className="bar">
        <span></span>
        <button
          className="iconButton"
          onClick={() => setShowSettings((value) => !value)}
          aria-label="Settings"
        >
          <Settings size={20} />
        </button>
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
              <button className="callButton call" onClick={startCall}>
                <RotateCcw size={22} />
                Reconnect
              </button>
              <button className="textButton" onClick={dismissError}>
                Dismiss
              </button>
            </>
          ) : active ? (
            <button className="callButton end" onClick={stopCall}>
              <PhoneOff size={22} />
              End call
            </button>
          ) : (
            <button className="callButton call" onClick={startCall}>
              <Phone size={22} />
              Call OpenClaw
            </button>
          )}
        </div>
      </section>

      {showSettings && (
        <div
          className="sheetBackdrop"
          onClick={() => settings.secret && setShowSettings(false)}
        >
          <section
            className="sheet"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="sheetHead">
              <h2>Settings</h2>
              {settings.secret && (
                <button
                  className="iconButton"
                  onClick={() => setShowSettings(false)}
                  aria-label="Close"
                >
                  <X size={18} />
                </button>
              )}
            </div>
            <form onSubmit={saveSettings}>
              <label>
                <span>Gateway URL</span>
                <input
                  value={settings.gatewayUrl}
                  onChange={(event) =>
                    updateSettings({ gatewayUrl: event.target.value })
                  }
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
                    onChange={(event) =>
                      updateSettings({ secret: event.target.value })
                    }
                    autoComplete="current-password"
                  />
                </label>
              </div>
              <label>
                <span>Session key</span>
                <input
                  placeholder="Auto from agents.list"
                  value={settings.sessionKey}
                  onChange={(event) =>
                    updateSettings({ sessionKey: event.target.value })
                  }
                />
              </label>
              <button className="saveButton" type="submit">
                {saved ? "Saved" : "Save"}
              </button>
            </form>
          </section>
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

async function createDiscordVoiceSessionWithRetry(
  gateway: GatewayClient,
  params: Record<string, unknown>,
  onRetry: (attempt: number) => void,
) {
  const attempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
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
  return /UND_ERR_SOCKET|SocketError|other side closed|terminated|Gateway request timed out: discordVoice\.browser\.create/i.test(
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
