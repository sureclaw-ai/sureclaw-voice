// Browser device identity for the gateway `connect` handshake.
//
// OpenClaw 2026.10 rejects (or strips every operator scope from) a browser UI
// connection that has no device identity, unless a trusted proxy such as
// Cloudflare Access authenticated it. The bundled Control UI signs the connect
// with a per-browser Ed25519 key; this mirrors that so token, password, and
// auth-none gateways keep working. The gateway pairs the device on first use
// (`openclaw devices approve <requestId>`), then recognises it by key.
//
// Wire format (src/gateway/device-auth.ts + src/infra/device-identity.ts):
//   deviceId  = hex(sha256(raw 32-byte public key))
//   publicKey = base64url(raw public key)
//   signature = base64url(Ed25519(utf8("v2|deviceId|clientId|mode|role|scopes|signedAt|token|nonce")))
//
// The private key is generated non-extractable and kept in IndexedDB as a
// CryptoKey, so page script can sign with it but can never read it out.

type StoredIdentity = {
  deviceId: string;
  publicKey: string;
  privateKey: CryptoKey;
};

export type DeviceAuth = {
  id: string;
  publicKey: string;
  signature: string;
  signedAt: number;
  nonce: string;
};

const DB_NAME = "sureclaw-voice-device";
const STORE = "identity";
const KEY = "ed25519";

let cached: Promise<StoredIdentity | null> | null = null;

/** Loads (or creates) this browser's identity; null when Ed25519 is unavailable. */
function loadOrCreateIdentity(): Promise<StoredIdentity | null> {
  cached ??= (async () => {
    if (!globalThis.crypto?.subtle || typeof indexedDB === "undefined") return null;
    try {
      const existing = await readStored();
      if (existing) return existing;
      const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
        "sign",
        "verify",
      ])) as CryptoKeyPair;
      const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
      const identity: StoredIdentity = {
        deviceId: toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", raw))),
        publicKey: toBase64Url(raw),
        privateKey: pair.privateKey,
      };
      await writeStored(identity);
      return identity;
    } catch {
      // Older browsers without WebCrypto Ed25519: connect device-less. That
      // still works behind a trusted proxy; elsewhere the gateway explains why.
      return null;
    }
  })();
  return cached;
}

export async function buildDeviceAuth(params: {
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  token: string;
  nonce: string;
  signedAt: number;
}): Promise<DeviceAuth | null> {
  const identity = await loadOrCreateIdentity();
  if (!identity) return null;
  const payload = [
    "v2",
    identity.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAt),
    params.token,
    params.nonce,
  ].join("|");
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    identity.privateKey,
    new TextEncoder().encode(payload),
  );
  return {
    id: identity.deviceId,
    publicKey: identity.publicKey,
    signature: toBase64Url(new Uint8Array(signature)),
    signedAt: params.signedAt,
    nonce: params.nonce,
  };
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readStored(): Promise<StoredIdentity | null> {
  const db = await openDb();
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const stored = value as Partial<StoredIdentity> | undefined;
    if (
      typeof stored?.deviceId === "string" &&
      typeof stored.publicKey === "string" &&
      stored.privateKey instanceof CryptoKey
    ) {
      return stored as StoredIdentity;
    }
    return null;
  } finally {
    db.close();
  }
}

async function writeStored(identity: StoredIdentity) {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(identity, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
