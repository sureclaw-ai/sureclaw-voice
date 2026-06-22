export type GatewayAuthMode = "token" | "password";

export type GatewaySettings = {
  gatewayUrl: string;
  authMode: GatewayAuthMode;
  secret: string;
  sessionKey: string;
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

export type RealtimeBrowserSession = {
  provider: string;
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
  model?: string;
  voice?: string;
  expiresAt?: number;
};

export type TranscriptEntry = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
};

export type CallStatus = "idle" | "connecting" | "listening" | "thinking" | "error";
