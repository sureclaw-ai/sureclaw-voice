import type { ReplayTurn } from "../types";

// The realtime voice session is ephemeral: OpenAI keeps no server-side copy we
// can re-attach to — there is no resume-by-id, and the durable Conversations
// API is not wired to Realtime. To resume a conversation we therefore replay it
// ourselves. This persists the transcript the model itself emitted (the user's
// input_audio_transcription and the assistant's audio_transcript), keyed by
// sessionKey, so the thread survives a mid-call drop, a hard error, and a full
// PWA close — and can be replayed verbatim into a fresh session.

const STORAGE_KEY = "openclaw.sureclaw-voice.conversation";

// Only dialogue turns are replayable as conversation items; cap the buffer so
// both storage and the per-reconnect re-priming cost stay bounded. The newest
// turns are the ones that matter for picking the thread back up.
const MAX_TURNS = 50;

// How long after the last turn a conversation stays offered for manual resume.
// Past this it reads as stale — you've moved on, and OpenClaw's own session may
// have too — so we drop it and offer a fresh call instead. The realtime session
// itself caps at 60 min, so 30 keeps "resume" meaning "continue what we were
// just doing". This only gates the idle Resume button; a mid-call drop still
// auto-reconnects from the in-memory buffer regardless of age.
const RESUME_TTL_MS = 30 * 60 * 1000;

export type StoredConversation = {
  sessionKey: string;
  turns: ReplayTurn[];
  updatedAt: number;
};

function read(): StoredConversation | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredConversation;
    if (!parsed || !Array.isArray(parsed.turns) || parsed.turns.length === 0) return null;
    // Stale beyond the resume window: discard it so it is neither offered nor
    // accidentally replayed, and the storage entry doesn't linger.
    if (typeof parsed.updatedAt !== "number" || Date.now() - parsed.updatedAt > RESUME_TTL_MS) {
      clearConversation();
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function loadConversation(): StoredConversation | null {
  return read();
}

export function hasResumableConversation(): boolean {
  return read() !== null;
}

export function saveConversation(sessionKey: string, turns: ReplayTurn[]) {
  if (turns.length === 0) return;
  const stored: StoredConversation = {
    sessionKey,
    turns: turns.slice(-MAX_TURNS),
    updatedAt: Date.now(),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Storage full or unavailable (e.g. private mode): resume just won't be
    // offered. A live call is unaffected.
  }
}

export function clearConversation() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}
