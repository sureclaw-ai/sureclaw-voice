import type { CallStatus, GatewayEvent, RealtimeBrowserSession, TranscriptEntry } from "../types";
import { GatewayClient } from "./gatewayClient";

type RealtimeEvent = Record<string, unknown> & { type?: string };

type CallCallbacks = {
  onStatus: (status: CallStatus, detail?: string) => void;
  onTranscript: (entry: TranscriptEntry) => void;
  onLog: (line: string) => void;
  /**
   * Fired as audio streams become available — the local mic on start and the
   * remote (assistant) track once it arrives. Used to drive the visualizer.
   */
  onStream?: (kind: "mic" | "remote", stream: MediaStream) => void;
  /**
   * Fired when the peer connection is lost in a way that will not recover on
   * its own (ICE `failed`, or a `disconnected` state that did not heal within
   * the grace window). The orchestrator can use this to re-mint and re-dial.
   */
  onConnectionLost: (state: string) => void;
};

// Public STUN fallback used when the Gateway does not supply its own ICE
// servers. STUN lets the browser discover its public reflexive candidate so
// NAT traversal can succeed; without any STUN, only host candidates are
// gathered and connections fail intermittently behind NAT.
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

// A `disconnected` ICE state is a transient, *recoverable* event: the same
// connection's ICE keeps re-probing and can return to `connected` on its own
// (a brief idle stretch during a long tool call, a network blip, a 5G handoff).
// We ride it out on the SAME connection — preserving the OpenAI session and the
// whole conversation — and let the browser's own machinery decide the outcome:
// it returns to `connected` (recovered → seamless) or escalates to `failed`
// (truly dead → fail entirely). This backstop only exists so a connection stuck
// in `disconnected` forever does not leave the user in limbo; the primary
// "dead" signal is `failed`/`closed`, handled immediately.
const DISCONNECT_GRACE_MS = 30000;

const LOG_PREFIX = "[realtime]";

type ToolBuffer = {
  name: string;
  callId: string;
  args: string;
};

export class OpenAIRealtimeCall {
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private media: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private closed = false;
  private responseActive = false;
  private responseCreateInFlight = false;
  private responseCreatePending = false;
  private toolBuffers = new Map<string, ToolBuffer>();
  private abortControllers = new Set<AbortController>();
  private recoveryTimer: number | null = null;
  private toolCallsInFlight = 0;
  private turnDetectionSuspended = false;

  constructor(
    private readonly gateway: GatewayClient,
    private readonly sessionKey: string,
    private readonly session: RealtimeBrowserSession,
    private readonly callbacks: CallCallbacks,
  ) {}

  async start() {
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
      throw new Error("This browser does not support microphone WebRTC calls");
    }

    this.closed = false;
    const iceServers = this.session.iceServers?.length
      ? this.session.iceServers
      : DEFAULT_ICE_SERVERS;
    this.callbacks.onLog(
      `WebRTC ICE servers: ${iceServers.map((server) => JSON.stringify(server.urls)).join(", ")}`,
    );
    this.peer = new RTCPeerConnection({ iceServers });
    this.audio = document.createElement("audio");
    this.audio.autoplay = true;
    this.audio.style.display = "none";
    document.body.append(this.audio);

    this.peer.addEventListener("track", (event) => {
      if (this.audio) this.audio.srcObject = event.streams[0];
      if (event.streams[0]) this.callbacks.onStream?.("remote", event.streams[0]);
    });
    this.peer.addEventListener("connectionstatechange", () => this.handleConnectionStateChange());

    this.media = await navigator.mediaDevices.getUserMedia({
      audio: { autoGainControl: true, echoCancellation: true, noiseSuppression: true },
    });
    this.media.getAudioTracks().forEach((track) => this.peer?.addTrack(track, this.media!));
    this.callbacks.onStream?.("mic", this.media);

    this.channel = this.peer.createDataChannel("oai-events");
    this.channel.addEventListener("open", () => {
      this.callbacks.onStatus("listening");
      this.callbacks.onLog("Realtime data channel is open");
    });
    this.channel.addEventListener("message", (event) => this.handleRealtimeEvent(event.data));

    const offer = await this.peer.createOffer();
    await this.peer.setLocalDescription(offer);

    const offerUrl = this.session.offerUrl || "https://api.openai.com/v1/realtime/calls";
    this.callbacks.onLog(`Posting WebRTC offer to ${offerUrl}`);
    const response = await fetch(offerUrl, {
      method: "POST",
      body: offer.sdp || "",
      headers: {
        Authorization: `Bearer ${this.session.clientSecret}`,
        ...(this.session.offerHeaders || {}),
        "Content-Type": "application/sdp",
      },
    });
    const responseText = await response.text();
    if (!response.ok) {
      const detail = formatHttpErrorDetail(responseText);
      throw new Error(
        `Realtime WebRTC setup failed (${response.status})${detail ? `: ${detail}` : ""}`,
      );
    }
    await this.peer.setRemoteDescription({ type: "answer", sdp: responseText });
  }

  private handleConnectionStateChange() {
    const state = this.peer?.connectionState;
    if (!state || this.closed) return;
    // Surface ICE/connection transitions prominently — these are the events
    // that explain a mid-call drop.
    console.warn(`${LOG_PREFIX} connection state → ${state}`, {
      iceConnectionState: this.peer?.iceConnectionState,
      iceGatheringState: this.peer?.iceGatheringState,
      signalingState: this.peer?.signalingState,
    });
    this.callbacks.onLog(`WebRTC connection state: ${state}`);

    if (state === "connected") {
      this.clearRecoveryTimer();
      this.callbacks.onStatus("listening");
      return;
    }

    if (state === "disconnected") {
      // Transient and recoverable: surface it (not as a fatal error) and let
      // the existing connection's ICE re-establish within the grace window.
      this.callbacks.onStatus("connecting", "Connection unstable — trying to recover…");
      this.scheduleRecovery();
      return;
    }

    if (state === "failed" || state === "closed") {
      this.clearRecoveryTimer();
      this.reportConnectionLost(state);
    }
  }

  private scheduleRecovery() {
    if (this.recoveryTimer !== null) return;
    this.recoveryTimer = window.setTimeout(() => {
      this.recoveryTimer = null;
      const state = this.peer?.connectionState;
      if (this.closed || state === "connected") return;
      this.reportConnectionLost(state ?? "failed");
    }, DISCONNECT_GRACE_MS);
  }

  private clearRecoveryTimer() {
    if (this.recoveryTimer === null) return;
    window.clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
  }

  private reportConnectionLost(state: string) {
    if (this.closed) return;
    this.callbacks.onStatus("error", `WebRTC ${state}`);
    this.callbacks.onConnectionLost(state);
  }

  stop() {
    this.closed = true;
    this.clearRecoveryTimer();
    this.channel?.close();
    this.channel = null;
    this.peer?.close();
    this.peer = null;
    this.media?.getTracks().forEach((track) => track.stop());
    this.media = null;
    this.audio?.remove();
    this.audio = null;
    this.abortControllers.forEach((controller) => controller.abort());
    this.abortControllers.clear();
    this.toolBuffers.clear();
    this.responseActive = false;
    this.responseCreateInFlight = false;
    this.responseCreatePending = false;
    this.toolCallsInFlight = 0;
    this.turnDetectionSuspended = false;
  }

  private send(event: unknown) {
    const type = (event as { type?: string } | null)?.type ?? "unknown";
    if (this.channel?.readyState === "open") {
      console.debug(`${LOG_PREFIX} → send ${type}`, event);
      this.channel.send(JSON.stringify(event));
    } else {
      console.warn(
        `${LOG_PREFIX} → send DROPPED ${type} (data channel: ${this.channel?.readyState ?? "none"})`,
        event,
      );
    }
  }

  private handleRealtimeEvent(raw: unknown) {
    if (this.closed) return;
    let event: RealtimeEvent;
    try {
      event = JSON.parse(String(raw));
    } catch (error) {
      console.warn(`${LOG_PREFIX} ← recv unparseable frame`, raw, error);
      return;
    }

    // Suppress the high-frequency incremental events (transcript/audio/argument
    // deltas) from the console so the meaningful lifecycle + error + connection
    // events stand out and the log stays pasteable.
    const eventType = event.type ?? "unknown";
    if (!eventType.endsWith(".delta")) console.debug(`${LOG_PREFIX} ← recv ${eventType}`, event);

    switch (event.type) {
      case "conversation.item.input_audio_transcription.completed":
        this.pushTranscript("user", stringField(event, "transcript"));
        return;
      case "response.audio_transcript.done":
        this.pushTranscript("assistant", stringField(event, "transcript"));
        return;
      case "response.function_call_arguments.delta":
        this.bufferToolDelta(event);
        return;
      case "response.function_call_arguments.done":
        void this.handleToolCall(event);
        return;
      case "input_audio_buffer.speech_started":
        this.callbacks.onStatus("listening", "Speech detected");
        return;
      case "input_audio_buffer.speech_stopped":
        this.callbacks.onStatus("thinking", "Processing speech");
        return;
      case "response.created":
        this.responseActive = true;
        this.responseCreateInFlight = false;
        this.callbacks.onStatus("thinking", "Generating response");
        return;
      case "response.cancelled":
      case "response.done":
        this.responseActive = false;
        this.responseCreateInFlight = false;
        this.callbacks.onStatus("listening");
        this.flushPendingResponseCreate();
        this.maybeResumeTurnDetection();
        return;
      case "error": {
        // A realtime protocol error (bad client event, model error, etc.) does
        // NOT take down the WebRTC connection — the call is still alive. Surface
        // it in logs but do not raise the fatal error screen; reset to a live
        // state so the UI is not stuck on "thinking". Only a genuine WebRTC
        // connection loss (connectionstatechange) is treated as fatal.
        this.responseCreateInFlight = false;
        const detail = this.extractErrorDetail(event.error);
        const raw = safeStringify(event.error ?? event);
        console.error(`${LOG_PREFIX} error event (non-fatal): ${detail}`, event);
        this.callbacks.onLog(`Realtime error: ${detail}${raw ? ` — ${raw.slice(0, 400)}` : ""}`);
        this.callbacks.onStatus(this.responseActive ? "thinking" : "listening");
        return;
      }
    }
  }

  private pushTranscript(role: "user" | "assistant", text?: string) {
    const value = text?.trim();
    if (!value) return;
    this.callbacks.onTranscript({ id: crypto.randomUUID(), role, text: value });
  }

  private bufferToolDelta(event: RealtimeEvent) {
    const itemId = stringField(event, "item_id") || "unknown";
    const existing = this.toolBuffers.get(itemId);
    if (existing) {
      existing.args += stringField(event, "delta") || "";
      return;
    }
    this.toolBuffers.set(itemId, {
      name: stringField(event, "name") || "",
      callId: stringField(event, "call_id") || "",
      args: stringField(event, "delta") || "",
    });
  }

  private async handleToolCall(event: RealtimeEvent) {
    const itemId = stringField(event, "item_id") || "unknown";
    const buffered = this.toolBuffers.get(itemId);
    this.toolBuffers.delete(itemId);

    const name = buffered?.name || stringField(event, "name") || "";
    const callId = buffered?.callId || stringField(event, "call_id") || "";
    const args = buffered?.args || stringField(event, "arguments") || "{}";
    if (!callId || name !== "openclaw_agent_consult") return;

    this.callbacks.onStatus("thinking", "Asking OpenClaw");
    this.callbacks.onLog("Forwarding realtime tool call to OpenClaw");
    // The consult can take several seconds. Server VAD ships with
    // create_response/interrupt_response enabled, so without this the model
    // would spontaneously answer (or get cut off) on any stray audio while we
    // wait, talking over the eventual tool result. Suspend auto turn-taking for
    // the duration and restore it once the post-tool answer is delivered.
    this.toolCallsInFlight += 1;
    this.suspendTurnDetection();
    const controller = new AbortController();
    this.abortControllers.add(controller);

    try {
      const result = await this.runOpenClawConsult(callId, args, controller.signal);
      this.submitToolResult(callId, { result });
    } catch (error) {
      this.submitToolResult(callId, {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.abortControllers.delete(controller);
      this.toolCallsInFlight -= 1;
    }
  }

  private suspendTurnDetection() {
    if (this.turnDetectionSuspended) return;
    this.turnDetectionSuspended = true;
    // Disable automatic responses/interruption (explicit response.create still
    // works), and drop any buffered partial speech so it cannot fire the moment
    // we resume.
    this.send({
      type: "session.update",
      session: {
        type: "realtime",
        audio: {
          input: {
            turn_detection: {
              type: "server_vad",
              create_response: false,
              interrupt_response: false,
            },
          },
        },
      },
    });
    this.send({ type: "input_audio_buffer.clear" });
    this.callbacks.onLog("Suspended auto turn-taking for OpenClaw tool call");
  }

  private maybeResumeTurnDetection() {
    if (!this.turnDetectionSuspended) return;
    // Only restore once no tool calls remain pending and the post-tool answer
    // has fully completed, so the answer itself is never interrupted.
    if (
      this.toolCallsInFlight > 0 ||
      this.responseActive ||
      this.responseCreateInFlight ||
      this.responseCreatePending
    ) {
      return;
    }
    this.turnDetectionSuspended = false;
    this.send({
      type: "session.update",
      session: {
        type: "realtime",
        audio: {
          input: {
            turn_detection: { type: "server_vad", create_response: true, interrupt_response: true },
          },
        },
      },
    });
    this.callbacks.onLog("Resumed auto turn-taking");
  }

  private async runOpenClawConsult(callId: string, rawArgs: string, signal: AbortSignal) {
    const args = safeJson(rawArgs);
    console.debug(`${LOG_PREFIX} consult → gateway talk.client.toolCall`, {
      sessionKey: this.sessionKey,
      callId,
      args,
    });
    const response = (await this.gateway.request("talk.client.toolCall", {
      sessionKey: this.sessionKey,
      callId,
      name: "openclaw_agent_consult",
      args,
    })) as { runId?: string; idempotencyKey?: string };
    console.debug(`${LOG_PREFIX} consult ← gateway response`, response);

    const runId = response.runId || response.idempotencyKey;
    if (!runId) throw new Error("OpenClaw did not return a run id");
    this.callbacks.onLog(`OpenClaw run started (runId=${runId}); awaiting chat final`);
    return this.waitForChatFinal(runId, signal);
  }

  private waitForChatFinal(runId: string, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        console.warn(
          `${LOG_PREFIX} consult TIMEOUT after 120s (runId=${runId}) — no chat 'final' event arrived`,
        );
        cleanup(() => reject(new Error("OpenClaw consult timed out")));
      }, 120000);
      const abort = () =>
        cleanup(() => reject(new DOMException("OpenClaw consult aborted", "AbortError")));
      const unsubscribe = this.gateway.addEventListener((event: GatewayEvent) => {
        if (event.event !== "chat") return;
        const payload = event.payload;
        if (!payload || typeof payload !== "object") return;
        const chat = payload as {
          runId?: string;
          state?: string;
          message?: string;
          errorMessage?: string;
        };
        console.debug(
          `${LOG_PREFIX} consult chat event: runId=${chat.runId} state=${chat.state}${chat.runId === runId ? " (MATCH)" : " (waiting for " + runId + ")"}`,
          payload,
        );
        if (chat.runId !== runId) return;
        if (chat.state === "final")
          cleanup(() => resolve(chat.message?.trim() || "OpenClaw finished with no text."));
        if (chat.state === "aborted")
          cleanup(() =>
            reject(new DOMException(chat.errorMessage || "OpenClaw aborted", "AbortError")),
          );
        if (chat.state === "error")
          cleanup(() => reject(new Error(chat.errorMessage || "OpenClaw failed")));
      });

      signal.addEventListener("abort", abort, { once: true });

      const cleanup = (finish: () => void) => {
        window.clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        unsubscribe();
        finish();
      };
    });
  }

  private submitToolResult(callId: string, result: unknown) {
    this.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result),
      },
    });
    this.requestResponseCreate();
  }

  private requestResponseCreate() {
    if (this.responseActive || this.responseCreateInFlight) {
      this.responseCreatePending = true;
      return;
    }
    this.responseCreatePending = false;
    this.responseCreateInFlight = true;
    this.send({ type: "response.create" });
  }

  private flushPendingResponseCreate() {
    if (!this.responseCreatePending) return;
    this.responseCreatePending = false;
    this.requestResponseCreate();
  }

  private extractErrorDetail(error: unknown) {
    if (!error || typeof error !== "object") return "Realtime provider error";
    const record = error as Record<string, unknown>;
    return (
      stringField(record, "message") ||
      stringField(record, "code") ||
      stringField(record, "type") ||
      "Realtime provider error"
    );
  }
}

function stringField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function safeJson(raw: string) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return { text: raw };
  }
}

function safeStringify(value: unknown) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatHttpErrorDetail(body: string) {
  const trimmed = body.trim();
  if (!trimmed) return "";
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
    if (parts.length > 0) return parts.join(" ");
  } catch {
    // Fall through to a bounded plaintext snippet.
  }
  return redacted.slice(0, 500);
}
