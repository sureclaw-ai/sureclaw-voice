import { useEffect, useRef } from "react";
import type { CallStatus } from "./types";

const BAR_COUNT = 28;
// Anything below this normalized level is treated as silence so the noise floor
// doesn't make the bars jitter when nobody is talking.
const NOISE_GATE = 0.12;

type Source = { kind: "mic" | "remote"; stream: MediaStream };

type VisualizerProps = {
  streams: Source[];
  status: CallStatus;
};

// A live equalizer that reacts to the actual call audio. The mic and the
// assistant are analysed separately so the bars can be tinted by whoever is
// currently speaking. With no audio it falls back to a CSS idle animation.
export function Visualizer({ streams, status }: VisualizerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);
  const levelsRef = useRef<number[]>(new Array(BAR_COUNT).fill(0));

  useEffect(() => {
    const reset = () => {
      levelsRef.current.fill(0);
      barsRef.current.forEach((bar) => bar && (bar.style.transform = "scaleY(0.05)"));
    };

    if (streams.length === 0) {
      reset();
      return;
    }

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    void ctx.resume();

    const nodes = streams.map(({ kind, stream }) => {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      const source = ctx.createMediaStreamSource(stream);
      source.connect(analyser);
      return { kind, analyser, source, freq: new Uint8Array(analyser.frequencyBinCount) };
    });

    const usableBins = Math.min(nodes[0].freq.length, 80);
    const userBars = new Float32Array(BAR_COUNT);
    const clawBars = new Float32Array(BAR_COUNT);
    let userEnergy = 0;
    let clawEnergy = 0;
    let raf = 0;

    // Map a node's spectrum into per-bar averages, keeping the loudest source.
    const accumulate = (freq: Uint8Array, into: Float32Array) => {
      for (let i = 0; i < BAR_COUNT; i += 1) {
        const start = Math.floor((i / BAR_COUNT) * usableBins);
        const end = Math.max(start + 1, Math.floor(((i + 1) / BAR_COUNT) * usableBins));
        let sum = 0;
        for (let j = start; j < end; j += 1) sum += freq[j];
        into[i] = Math.max(into[i], sum / (end - start) / 255);
      }
    };

    const render = () => {
      userBars.fill(0);
      clawBars.fill(0);
      for (const node of nodes) {
        node.analyser.getByteFrequencyData(node.freq);
        accumulate(node.freq, node.kind === "mic" ? userBars : clawBars);
      }

      let frameUser = 0;
      let frameClaw = 0;
      for (let i = 0; i < BAR_COUNT; i += 1) {
        frameUser += userBars[i];
        frameClaw += clawBars[i];

        // Gate out the noise floor, then expand the remaining range.
        const raw = Math.max(userBars[i], clawBars[i]);
        const gated = raw <= NOISE_GATE ? 0 : (raw - NOISE_GATE) / (1 - NOISE_GATE);
        const target = Math.min(1, Math.pow(gated, 0.85) * 1.6);
        const next = levelsRef.current[i] + (target - levelsRef.current[i]) * 0.45;
        levelsRef.current[i] = next < 0.001 ? 0 : next;

        const bar = barsRef.current[i];
        if (bar) bar.style.transform = `scaleY(${0.05 + levelsRef.current[i] * 0.95})`;
      }

      // Tint by the dominant speaker; hold the last one through brief silences.
      userEnergy += (frameUser - userEnergy) * 0.4;
      clawEnergy += (frameClaw - clawEnergy) * 0.4;
      const container = containerRef.current;
      if (container) {
        if (userEnergy > 0.4 && userEnergy >= clawEnergy) container.dataset.speaker = "user";
        else if (clawEnergy > 0.4) container.dataset.speaker = "claw";
      }

      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      nodes.forEach((node) => node.source.disconnect());
      void ctx.close();
      reset();
    };
  }, [streams]);

  const live = streams.length > 0;
  return (
    <div
      ref={containerRef}
      data-speaker="claw"
      className={`viz ${status} ${live ? "viz-live" : "viz-idle"}`}
      aria-hidden="true"
    >
      {Array.from({ length: BAR_COUNT }).map((_, i) => (
        <span
          key={i}
          className="vizBar"
          style={{ animationDelay: `${(i % 7) * 0.12}s` }}
          ref={(el) => {
            barsRef.current[i] = el;
          }}
        />
      ))}
    </div>
  );
}
