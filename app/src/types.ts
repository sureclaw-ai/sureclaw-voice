export type GatewayAuthMode = "token" | "password";

export type GatewaySettings = {
  gatewayUrl: string;
  authMode: GatewayAuthMode;
  secret: string;
};

export type GatewayEvent = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
};

export type GatewayResponse = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
};

type RealtimeBrowserSessionBase = {
  provider: string;
  model?: string;
  voice?: string;
  expiresAt?: number;
};

export type GptLiveBrowserSession = RealtimeBrowserSessionBase & {
  provider: "openai";
  transport: "webrtc";
  voiceSessionId: string;
  clientSecret: string;
  offerUrl?: string;
  offerHeaders?: Record<string, string>;
  offerResponseMaxBytes?: number;
  iceServers?: RTCIceServer[];
  clientControl: { owner: "gateway" };
};

export type RealtimeBrowserSession =
  | (RealtimeBrowserSessionBase & {
      transport: "webrtc";
      clientSecret: string;
      offerUrl?: string;
      offerHeaders?: Record<string, string>;
      /**
       * ICE servers (STUN/TURN) supplied by the Gateway. When present these take
       * precedence over the client's built-in public STUN defaults, letting the
       * server hand out TURN relay credentials for restrictive networks.
       */
      iceServers?: RTCIceServer[];
    })
  | (RealtimeBrowserSessionBase & {
      transport: "provider-websocket";
      protocol: string;
      clientSecret: string;
      websocketUrl: string;
      audio: {
        inputEncoding: "pcm16" | "g711_ulaw";
        inputSampleRateHz: number;
        outputEncoding: "pcm16" | "g711_ulaw";
        outputSampleRateHz: number;
      };
      initialMessage?: unknown;
    });

export type TranscriptEntry = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
};

export type CallStatus = "idle" | "connecting" | "listening" | "thinking" | "error";

// A single dialogue turn replayed into a fresh realtime session to resume a
// conversation. Only user/assistant text is replayable as a conversation item
// (the API takes no audio on create), so this is narrower than TranscriptEntry.
export type ReplayTurn = { role: "user" | "assistant"; text: string };
