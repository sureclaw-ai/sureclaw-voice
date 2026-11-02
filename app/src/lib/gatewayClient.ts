import type { GatewayAuthMode, GatewayEvent, GatewayResponse } from "../types";
import { buildDeviceAuth } from "./deviceIdentity";

const CLIENT_ID = "openclaw-control-ui";
const CLIENT_MODE = "ui";
const ROLE = "operator";
// operator.admin keeps owner-level agent consults and chat.inject (the legacy
// transcript bridge); operator.talk covers native GPT-Live Talk. The gateway
// still caps these to whatever the device pairing / identity grant allows.
const SCOPES = ["operator.admin", "operator.read", "operator.write", "operator.talk"];

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: number;
};

export class GatewayClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private listeners = new Set<(event: GatewayEvent) => void>();
  private helloPromise: Promise<unknown> | null = null;

  constructor(
    private readonly url: string,
    private readonly authMode: GatewayAuthMode,
    private readonly secret: string,
    // Behind a trusted proxy (Cloudflare Access) the proxy identity is the
    // credential, and an unpaired device would only trigger a pairing prompt.
    private readonly useDeviceIdentity = true,
  ) {}

  connect(): Promise<unknown> {
    this.disconnect();
    this.helloPromise = new Promise((resolve, reject) => {
      let settled = false;
      let connectTimeout: number | undefined;
      const settleResolve = (value: unknown) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(connectTimeout);
        resolve(value);
      };
      const settleReject = (error: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(connectTimeout);
        reject(error);
      };
      connectTimeout = window.setTimeout(
        () => settleReject(new Error("Gateway connect timed out")),
        15000,
      );
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.addEventListener("message", (message) => {
        let frame: GatewayEvent | GatewayResponse;
        try {
          frame = JSON.parse(String(message.data));
        } catch {
          return;
        }

        if (frame.type === "event") {
          if (frame.event === "connect.challenge") {
            this.buildConnectParams(frame.payload)
              .then((params) => this.request("connect", params, 15000))
              .then(settleResolve, settleReject);
            return;
          }
          this.listeners.forEach((listener) => listener(frame));
          return;
        }

        if (frame.type === "res") {
          const pending = this.pending.get(frame.id);
          if (!pending) return;
          window.clearTimeout(pending.timeout);
          this.pending.delete(frame.id);
          if (frame.ok) pending.resolve(frame.payload);
          else pending.reject(describeGatewayError(frame.error));
        }
      });

      ws.addEventListener("error", () => settleReject(new Error("Gateway WebSocket failed")));
      ws.addEventListener("close", (event) => {
        this.flushPending(new Error(`Gateway closed (${event.code}) ${event.reason}`.trim()));
        if (!settled)
          settleReject(new Error(`Gateway closed (${event.code}) ${event.reason}`.trim()));
      });
    });
    return this.helloPromise;
  }

  // Whether the WebSocket is currently open — used to skip best-effort work
  // (e.g. the rolling transcript flush) that would only reject while offline.
  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  disconnect() {
    this.flushPending(new Error("Gateway disconnected"));
    this.ws?.close();
    this.ws = null;
    this.helloPromise = null;
  }

  addEventListener(listener: (event: GatewayEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  request(method: string, params?: unknown, timeoutMs = 30000): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Gateway is not connected"));
    }

    const id = crypto.randomUUID();
    const frame = { type: "req", id, method, params };
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Gateway request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
    });
    this.ws.send(JSON.stringify(frame));
    return promise;
  }

  private async buildConnectParams(challengePayload: unknown) {
    const challenge = (challengePayload ?? {}) as { nonce?: unknown; ts?: unknown };
    const nonce = typeof challenge.nonce === "string" ? challenge.nonce : "";
    const signedAt = typeof challenge.ts === "number" ? challenge.ts : Date.now();
    const token = this.authMode === "password" ? "" : this.secret;
    const device = this.useDeviceIdentity
      ? await buildDeviceAuth({
          clientId: CLIENT_ID,
          clientMode: CLIENT_MODE,
          role: ROLE,
          scopes: SCOPES,
          token,
          nonce,
          signedAt,
        })
      : null;
    return {
      minProtocol: 4,
      maxProtocol: 4,
      client: {
        id: CLIENT_ID,
        displayName: "OpenClaw Voice PWA",
        version: __PLUGIN_VERSION__,
        // This plugin UI is versioned independently from OpenClaw's bundled
        // Control UI. Current gateways explicitly accept "dev" here rather
        // than applying the bundled UI's exact-build reload guard.
        buildId: "dev",
        platform: "web",
        mode: CLIENT_MODE,
      },
      caps: ["tool-events"],
      auth: this.authMode === "password" ? { password: this.secret } : { token: this.secret },
      role: ROLE,
      scopes: SCOPES,
      ...(device ? { device } : {}),
    };
  }

  private flushPending(error: Error) {
    this.pending.forEach((pending) => {
      window.clearTimeout(pending.timeout);
      pending.reject(error);
    });
    this.pending.clear();
  }
}

// Turns a gateway error frame into an Error, adding the approval command when
// the gateway is waiting for this browser's first device pairing.
function describeGatewayError(error: GatewayResponse["error"]) {
  const message = error?.message || error?.code || "Gateway request failed";
  const details = (error?.details ?? {}) as { requestId?: unknown };
  if (error?.code === "NOT_PAIRED" && typeof details.requestId === "string") {
    return new Error(
      `${message} — approve this device on the gateway host with: openclaw devices approve ${details.requestId}`,
    );
  }
  return new Error(message);
}
