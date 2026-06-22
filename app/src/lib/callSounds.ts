// Modern call UI sounds, synthesized live with the Web Audio API — no audio
// files to ship or license. The Meet/Slack-style "bloops" are just pure sine
// tones at pleasant musical intervals with a smooth volume envelope (a gentle
// fade in/out so there is never a click). Everything here is a few oscillators
// and a gain ramp.

// Equal-tempered note frequencies (Hz) used by the cues below.
const NOTE = {
  C4: 261.63,
  E4: 329.63,
  G4: 392.0,
  A4: 440.0,
  C5: 523.25,
  D5: 587.33,
  E5: 659.25,
  G5: 783.99,
  C6: 1046.5,
} as const;

type Note = (typeof NOTE)[keyof typeof NOTE];

class CallSounds {
  private ctx: AudioContext | null = null;
  // Master gain keeps the cues comfortably below full scale so they sit under,
  // not over, the voice. ~0.18 is a soft "UI chime" level.
  private master: GainNode | null = null;
  private ringTimer: number | null = null;

  // Lazily build the AudioContext. Browsers start it suspended until a user
  // gesture, which is why unlock() is called from the click handlers.
  private audio(): { ctx: AudioContext; master: GainNode } | null {
    if (typeof window === "undefined") return null;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    if (!this.ctx) {
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.18;
      this.master.connect(this.ctx.destination);
    }
    return { ctx: this.ctx, master: this.master! };
  }

  // Resume the context from within a user gesture (the Call/End buttons) so
  // later, programmatic cues are allowed to make sound.
  unlock() {
    const a = this.audio();
    if (a && a.ctx.state === "suspended") void a.ctx.resume();
  }

  // One enveloped tone. `at` is an offset (seconds) from "now" so a cue can
  // schedule a little melody up front and let the audio clock play it out.
  private tone(
    freq: Note,
    at: number,
    duration: number,
    {
      type = "sine",
      gain = 1,
    }: { type?: OscillatorType; gain?: number } = {},
  ) {
    const a = this.audio();
    if (!a) return;
    const { ctx, master } = a;
    const t = ctx.currentTime + at;
    const attack = 0.012;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    // Fade in fast, then exponentially decay to silence — no clicks, soft tail.
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(env);
    env.connect(master);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  // Outgoing "calling…" pulse: a soft two-note ping repeated on a slow cycle,
  // the way Meet/Slack nudge you while the other side rings.
  startRinging() {
    this.unlock();
    if (this.ringTimer !== null) return; // already ringing
    const pulse = () => {
      this.tone(NOTE.E5, 0, 0.18, { gain: 0.9 });
      this.tone(NOTE.C5, 0.22, 0.26, { gain: 0.9 });
    };
    pulse();
    this.ringTimer = window.setInterval(pulse, 2600);
  }

  stopRinging() {
    if (this.ringTimer !== null) {
      window.clearInterval(this.ringTimer);
      this.ringTimer = null;
    }
  }

  // Connected: a quick bright rising arpeggio — the "you're in" cue.
  connected() {
    this.stopRinging();
    this.tone(NOTE.C5, 0, 0.14, { gain: 0.8 });
    this.tone(NOTE.E5, 0.1, 0.14, { gain: 0.8 });
    this.tone(NOTE.G5, 0.2, 0.16, { gain: 0.85 });
    this.tone(NOTE.C6, 0.3, 0.34, { gain: 0.6 });
  }

  // Hang-up: a gentle two-note fall.
  ended() {
    this.unlock();
    this.stopRinging();
    this.tone(NOTE.G4, 0, 0.16, { gain: 0.8 });
    this.tone(NOTE.C4, 0.12, 0.34, { gain: 0.8 });
  }

  // Something went wrong: a soft low descending pair (triangle for a touch of
  // warmth without being harsh).
  error() {
    this.stopRinging();
    this.tone(NOTE.A4, 0, 0.18, { type: "triangle", gain: 0.7 });
    this.tone(NOTE.E4, 0.16, 0.4, { type: "triangle", gain: 0.7 });
  }
}

// One shared instance for the whole app.
export const callSounds = new CallSounds();
