import type { GatewayAuthMode, GatewayEvent, GatewayResponse } from "../types";

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
  ) {}

  connect(): Promise<unknown> {
    this.disconnect();
    this.helloPromise = new Promise((resolve, reject) => {
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
            this.request("connect", this.buildConnectParams(frame.payload), 15000).then(
              resolve,
              reject,
            );
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
          else
            pending.reject(
              new Error(frame.error?.message || frame.error?.code || "Gateway request failed"),
            );
        }
      });

      ws.addEventListener("error", () => reject(new Error("Gateway WebSocket failed")));
      ws.addEventListener("close", (event) => {
        this.flushPending(new Error(`Gateway closed (${event.code}) ${event.reason}`.trim()));
        if (!event.wasClean && this.helloPromise)
          reject(new Error(`Gateway closed (${event.code}) ${event.reason}`.trim()));
      });
    });
    return this.helloPromise;
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

  private buildConnectParams(_challengePayload: unknown) {
    return {
      minProtocol: 4,
      maxProtocol: 4,
      client: {
        id: "openclaw-control-ui",
        displayName: "OpenClaw Voice PWA",
        version: "0.1.3",
        platform: "web",
        mode: "ui",
      },
      caps: ["tool-events"],
      auth: this.authMode === "password" ? { password: this.secret } : { token: this.secret },
      role: "operator",
      scopes: ["operator.admin"],
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
