import type { CallStatus, GatewayEvent, GptLiveBrowserSession, TranscriptEntry } from "../types";
import { GatewayClient } from "./gatewayClient";
import { humanizeToolName } from "./openaiRealtimeCall";

type CallCallbacks = {
  onStatus: (status: CallStatus, detail?: string) => void;
  onTranscript: (entry: TranscriptEntry) => void;
  onLog: (line: string) => void;
  onStream?: (kind: "mic" | "remote", stream: MediaStream) => void;
  onConnectionLost: (state: string) => void;
  onSpeaking?: (speaking: boolean) => void;
  onConsulting?: (active: boolean) => void;
};

type TalkEvent = {
  type?: string;
  payload?: unknown;
};

type TranscriptRole = "user" | "assistant";

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];
const DISCONNECT_GRACE_MS = 30000;
// GPT-Live sends no "audio done" event, so "speaking" is read off the inbound
// RTP audio level. The hold bridges the gaps between words.
const SPEAKING_POLL_MS = 150;
const SPEAKING_LEVEL = 0.01;
const SPEAKING_HOLD_MS = 700;
// OpenClaw delegates GPT-Live work to the agent as runs with this id prefix.
const CONSULT_RUN_PREFIX = "talk-realtime-consult-";
const DEFAULT_OFFER_RESPONSE_MAX_BYTES = 262144;

/**
 * Thin GPT-Live WebRTC client. OpenClaw owns the provider control channel,
 * delegations, tools, and transcript persistence; this class only owns browser
 * media, SDP exchange, and presentation of canonical Talk events.
 *
 * GPT-Live is full duplex: the mic streams continuously and the model decides
 * when to speak, yield, or backchannel. Nothing here gates the mic, runs a
 * local VAD, or cuts playback when the caller talks — doing so would break the
 * overlap and interruption behaviour the model is built for.
 */
export class OpenClawGptLiveCall {
  private peer: RTCPeerConnection | null = null;
  private media: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private removeGatewayListener: (() => void) | null = null;
  private recoveryTimer: number | null = null;
  private speakingTimer: number | null = null;
  private speaking = false;
  private lastHeardAt = 0;
  private consultRuns = new Set<string>();
  private transcriptBuffers: Record<TranscriptRole, string> = { user: "", assistant: "" };
  private closed = false;
  private logicalSessionClosed = false;
  private sessionInfo: GptLiveBrowserSession | null = null;

  constructor(
    private readonly gateway: GatewayClient,
    private readonly gatewayUrl: string,
    private readonly sessionKey: string,
    // Mints the Talk session. Called only after the microphone is granted: the
    // returned offer token is single-use and expires 60 seconds after minting.
    private readonly createSession: () => Promise<GptLiveBrowserSession>,
    private readonly callbacks: CallCallbacks,
    private readonly requestedVoice?: string,
  ) {}

  get session() {
    return this.sessionInfo;
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
      throw new Error("This browser does not support microphone WebRTC calls");
    }

    this.closed = false;
    this.removeGatewayListener = this.gateway.addEventListener((event) =>
      this.handleGatewayEvent(event),
    );

    // Echo cancellation matters more than usual: with overlapping speech the
    // model would otherwise hear (and answer) itself.
    const media = await navigator.mediaDevices.getUserMedia({
      audio: { autoGainControl: true, echoCancellation: true, noiseSuppression: true },
    });
    if (this.closed) {
      media.getTracks().forEach((track) => track.stop());
      return;
    }
    this.media = media;
    this.callbacks.onStream?.("mic", media);

    // oxlint-disable-next-line react-doctor/async-defer-await -- hang-up during setup
    const session = await this.createSession();
    if (this.closed) return;
    this.sessionInfo = session;
    if (
      session.provider !== "openai" ||
      typeof session.model !== "string" ||
      !session.model.startsWith("gpt-live-") ||
      session.clientControl?.owner !== "gateway"
    ) {
      throw new Error(
        "GPT-Live requires an OpenAI gpt-live-* model with Gateway control (OpenClaw 2026.9.4 or newer)",
      );
    }
    this.callbacks.onLog(
      `GPT-Live session ${session.voiceSessionId} model=${session.model} voice=${session.voice ?? "default"}`,
    );
    if (this.requestedVoice && session.voice && session.voice !== this.requestedVoice) {
      // OpenClaw silently substitutes the model's default for voices it does
      // not list for that model; make the substitution visible.
      this.callbacks.onLog(
        `GPT-Live voice "${this.requestedVoice}" is not available for ${session.model}; using "${session.voice}"`,
      );
    }

    this.peer = new RTCPeerConnection({ iceServers: session.iceServers ?? DEFAULT_ICE_SERVERS });
    this.audio = document.createElement("audio");
    this.audio.autoplay = true;
    this.audio.style.display = "none";
    document.body.append(this.audio);

    this.peer.addEventListener("track", (event) => {
      const stream = event.streams[0];
      if (!stream) return;
      if (this.audio) this.audio.srcObject = stream;
      this.callbacks.onStream?.("remote", stream);
    });
    this.peer.addEventListener("connectionstatechange", () => this.handleConnectionStateChange());
    media.getAudioTracks().forEach((track) => this.peer?.addTrack(track, media));

    // Gateway control is the important boundary: unlike the legacy path, the
    // browser must not create an OpenAI provider data channel (the gateway
    // rejects any non-audio m-line).
    // `closed` can change during each await when the user hangs up, so these
    // post-await guards are intentional.
    // oxlint-disable react-doctor/async-defer-await
    const offer = await this.peer.createOffer();
    if (this.closed) return;
    await this.peer.setLocalDescription(offer);
    if (this.closed) return;

    const offerUrl = resolveOfferUrl(
      session.offerUrl || "/plugins/openai/realtime/calls",
      this.gatewayUrl,
    );
    this.callbacks.onLog(`Posting GPT-Live WebRTC offer to ${offerUrl}`);
    const response = await fetch(offerUrl, {
      method: "POST",
      body: offer.sdp || "",
      // Same-origin credentials carry the Cloudflare Access session cookie
      // when the gateway sits behind Access.
      credentials: "same-origin",
      headers: {
        ...session.offerHeaders,
        Authorization: `Bearer ${session.clientSecret}`,
        "Content-Type": "application/sdp",
      },
    });
    if (this.closed) return;
    const answer = await response.text();
    if (!response.ok) {
      const detail = answer.trim().slice(0, 500);
      throw new Error(
        `GPT-Live WebRTC setup failed (${response.status})${detail ? `: ${detail}` : ""}`,
      );
    }
    const maxBytes = session.offerResponseMaxBytes ?? DEFAULT_OFFER_RESPONSE_MAX_BYTES;
    if (new TextEncoder().encode(answer).byteLength > maxBytes) {
      throw new Error("GPT-Live WebRTC answer exceeded the gateway's size limit");
    }
    await this.peer.setRemoteDescription({ type: "answer", sdp: answer });
    // oxlint-enable react-doctor/async-defer-await
    this.startSpeakingMonitor();
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    this.flushTranscript("user");
    this.flushTranscript("assistant");
    this.clearRecoveryTimer();
    this.stopSpeakingMonitor();
    this.removeGatewayListener?.();
    this.removeGatewayListener = null;
    this.setSpeaking(false);
    if (this.consultRuns.size) {
      this.consultRuns.clear();
      this.callbacks.onConsulting?.(false);
    }
    this.media?.getTracks().forEach((track) => track.stop());
    this.media = null;
    this.peer?.close();
    this.peer = null;
    if (this.audio) {
      this.audio.pause();
      this.audio.srcObject = null;
      this.audio.remove();
      this.audio = null;
    }
  }

  async closeLogicalSession() {
    const voiceSessionId = this.sessionInfo?.voiceSessionId;
    if (this.logicalSessionClosed || !voiceSessionId) return;
    this.logicalSessionClosed = true;
    try {
      await this.gateway.request(
        "talk.client.close",
        { sessionKey: this.sessionKey, voiceSessionId },
        5000,
      );
    } catch (error) {
      this.callbacks.onLog(`GPT-Live session close failed: ${String(error)}`);
    }
  }

  setMicMuted(muted: boolean) {
    this.media?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
  }

  isMicMuted() {
    const tracks = this.media?.getAudioTracks() ?? [];
    return tracks.length > 0 && tracks.every((track) => !track.enabled);
  }

  simulateDropout() {
    if (this.closed) return;
    this.callbacks.onLog("Simulating GPT-Live connection dropout");
    this.callbacks.onConnectionLost("failed");
  }

  private handleGatewayEvent(event: GatewayEvent) {
    if (this.closed || !isRecord(event.payload)) return;
    if (event.event === "agent") {
      this.handleAgentEvent(event.payload);
      return;
    }
    const voiceSessionId = this.sessionInfo?.voiceSessionId;
    if (event.event !== "talk.event" || !voiceSessionId) return;
    if (event.payload.voiceSessionId !== voiceSessionId) return;
    const talkEvent = event.payload.talkEvent;
    if (!isRecord(talkEvent)) return;
    this.handleTalkEvent(talkEvent as TalkEvent);
  }

  // GPT-Live delegation runs as an ordinary agent run on this call's session.
  // Its lifecycle drives the "consulting" state (and the pending cue that fills
  // the silence after the model's spoken acknowledgement); its tool stream
  // drives the status detail.
  private handleAgentEvent(payload: Record<string, unknown>) {
    const runId = typeof payload.runId === "string" ? payload.runId : "";
    if (payload.sessionKey !== this.sessionKey || !runId.startsWith(CONSULT_RUN_PREFIX)) return;
    const data = isRecord(payload.data) ? payload.data : {};
    if (payload.stream === "lifecycle") {
      // GPT-Live has no assistant turn-done event; a delegation boundary is a
      // natural place to close the spoken acknowledgement / answer turn.
      if (data.phase === "start" || data.phase === "end") this.flushTranscript("assistant");
      if (data.phase === "start" && !this.consultRuns.has(runId)) {
        this.consultRuns.add(runId);
        if (this.consultRuns.size === 1) this.callbacks.onConsulting?.(true);
        this.callbacks.onStatus("thinking", "Working on it…");
      } else if (
        (data.phase === "end" || data.phase === "error") &&
        this.consultRuns.delete(runId)
      ) {
        if (this.consultRuns.size === 0) {
          this.callbacks.onConsulting?.(false);
          this.callbacks.onStatus("listening");
        }
      }
      return;
    }
    if (payload.stream === "tool" && typeof data.name === "string" && data.name) {
      this.callbacks.onStatus("thinking", `Running ${humanizeToolName(data.name)}…`);
    }
  }

  private handleTalkEvent(event: TalkEvent) {
    const payload = isRecord(event.payload) ? event.payload : {};
    switch (event.type) {
      case "session.started":
      case "session.ready":
        this.callbacks.onStatus("listening");
        break;
      case "transcript.delta":
        this.appendTranscript(payload.role === "assistant" ? "assistant" : "user", payload.text);
        break;
      case "transcript.done":
        this.finishTranscript(payload.role === "assistant" ? "assistant" : "user", payload.text);
        break;
      case "output.text.delta":
        this.appendTranscript("assistant", payload.text);
        break;
      case "output.text.done":
        this.finishTranscript("assistant", payload.text);
        break;
      case "output.audio.started":
        this.setSpeaking(true);
        break;
      case "output.audio.done":
        this.setSpeaking(false);
        break;
      case "session.error":
        // OpenClaw documents this as recoverable; session.closed is terminal.
        this.callbacks.onLog(`GPT-Live session warning: ${describePayload(payload)}`);
        break;
      case "session.closed":
        // Includes OpenClaw's 30-minute session cap: the app reconnects with
        // the same voiceSessionId, which keeps the agent session and work.
        this.callbacks.onLog("GPT-Live session closed by the gateway");
        this.callbacks.onConnectionLost("closed");
        break;
    }
  }

  // Captions arrive as two independent delta streams with no turn ids. A turn
  // is captured when OpenClaw finalises it, or when the other side starts
  // talking — so a full-duplex overlap never merges the two speakers.
  private appendTranscript(role: TranscriptRole, value: unknown) {
    if (typeof value !== "string" || !value) return;
    const other: TranscriptRole = role === "user" ? "assistant" : "user";
    if (role === "assistant" || this.transcriptBuffers[other]) this.flushTranscript(other);
    this.transcriptBuffers[role] += value;
  }

  private finishTranscript(role: TranscriptRole, value: unknown) {
    const text = typeof value === "string" && value.trim() ? value : this.transcriptBuffers[role];
    this.transcriptBuffers[role] = "";
    this.pushTranscript(role, text);
  }

  private flushTranscript(role: TranscriptRole) {
    const text = this.transcriptBuffers[role];
    this.transcriptBuffers[role] = "";
    this.pushTranscript(role, text);
  }

  private pushTranscript(role: TranscriptRole, value: string) {
    const text = value.trim();
    // Delegation boundaries can strand a lone "." from the caption stream.
    if (!/[\p{L}\p{N}]/u.test(text)) return;
    this.callbacks.onTranscript({ id: crypto.randomUUID(), role, text });
  }

  private startSpeakingMonitor() {
    this.stopSpeakingMonitor();
    this.speakingTimer = window.setInterval(() => void this.pollSpeaking(), SPEAKING_POLL_MS);
  }

  private stopSpeakingMonitor() {
    if (this.speakingTimer === null) return;
    window.clearInterval(this.speakingTimer);
    this.speakingTimer = null;
  }

  private async pollSpeaking() {
    const peer = this.peer;
    if (!peer || this.closed) return;
    let level = 0;
    try {
      const stats = await peer.getStats();
      stats.forEach((report) => {
        if (report.type === "inbound-rtp" && report.kind === "audio") {
          level = Math.max(level, Number(report.audioLevel) || 0);
        }
      });
    } catch {
      return;
    }
    const now = Date.now();
    if (level >= SPEAKING_LEVEL) this.lastHeardAt = now;
    this.setSpeaking(now - this.lastHeardAt < SPEAKING_HOLD_MS);
  }

  private setSpeaking(speaking: boolean) {
    if (this.speaking === speaking) return;
    this.speaking = speaking;
    console.debug(`[gpt-live] assistant ${speaking ? "speaking" : "silent"}`);
    this.callbacks.onSpeaking?.(speaking);
  }

  private handleConnectionStateChange() {
    const state = this.peer?.connectionState;
    if (!state || this.closed) return;
    this.callbacks.onLog(`GPT-Live WebRTC connection state: ${state}`);
    if (state === "connected") {
      this.clearRecoveryTimer();
      if (this.consultRuns.size === 0) this.callbacks.onStatus("listening");
    } else if (state === "disconnected") {
      this.callbacks.onStatus("connecting", "Connection unstable — trying to recover…");
      this.scheduleRecovery();
    } else if (state === "failed" || state === "closed") {
      this.clearRecoveryTimer();
      this.callbacks.onConnectionLost(state);
    }
  }

  private scheduleRecovery() {
    if (this.recoveryTimer !== null) return;
    this.recoveryTimer = window.setTimeout(() => {
      this.recoveryTimer = null;
      const state = this.peer?.connectionState;
      if (!this.closed && state !== "connected") this.callbacks.onConnectionLost(state ?? "failed");
    }, DISCONNECT_GRACE_MS);
  }

  private clearRecoveryTimer() {
    if (this.recoveryTimer === null) return;
    window.clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
  }
}

function resolveOfferUrl(offerUrl: string, gatewayUrl: string) {
  try {
    return new URL(offerUrl).toString();
  } catch {
    const base = new URL(gatewayUrl);
    base.protocol = base.protocol === "wss:" ? "https:" : "http:";
    return new URL(offerUrl, base).toString();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function describePayload(payload: Record<string, unknown>) {
  for (const key of ["message", "error", "reason", "status"]) {
    if (typeof payload[key] === "string") return payload[key];
  }
  return "Unknown error";
}
