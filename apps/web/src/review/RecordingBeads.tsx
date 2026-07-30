import { useEffect, useRef, type MutableRefObject } from 'react';

/**
 * RecordingBeads — "珠列示波器" (示波器案, art-direction: "不许脱离
 * dots 方言 —— 休眠是 dots，录音也必须是 dots").
 *
 * Replaces the old 22-bar frequency visualizer (see git history on
 * Review.tsx's WaveformCanvas) with a strip of dots that never deforms
 * into bars or a line — same family as lesson/PageDots.tsx: a resting row
 * of small dots. Two states only:
 *
 *   - dormant  (not recording — idle / paused / recognizing all read the
 *     same here; the mic hint text one line up already carries that
 *     distinction, this row only answers "is it listening right now")
 *   - active   (recording — every bead is a moment in the recent past,
 *     entering at the right edge and stepping left one slot per frame)
 *
 * Amplitude comes from the AnalyserNode's *time-domain* data (a real
 * oscilloscope reads the waveform, not the spectrum) — one RMS scalar per
 * frame, run through an asymmetric attack/release follower, pushed into a
 * small ring buffer. Bead i renders buffer[i]; the buffer shift is what
 * makes time visibly flow right → left.
 *
 * Rendering is plain DOM spans with per-frame inline style writes (rAF,
 * no React state) rather than <canvas>: at ~28 beads the per-frame cost is
 * trivial either way, and DOM spans read var(--ls-*) colors natively — no
 * hand-rolled getComputedStyle → rgba parsing needed to blend "louder =
 * brighter toward var(--ls-text)". Each bead is two stacked circles: a
 * base dot (dormant tertiary / recording secondary) and a text-colour
 * "glow" overlay whose opacity tracks the bead's amplitude — both share
 * the exact same transform every frame so the glow reads as "this bead is
 * bright" rather than a second, disconnected mark.
 *
 * The active → dormant edge ("stop") is the one moment a CSS transition
 * (var(--ls-easing)) is allowed to touch these properties — while actively
 * recording every write is instant so the attack/release ballistics above
 * aren't double-smoothed by CSS on top of the JS envelope.
 */

// ---- Layout ----
const BEAD_COUNT = 28; // 24-32 per brief; even division of typical widget width
const BEAD_SIZE_PX = 3; // 7/6 真机 art-direction: 再小一号
const ROW_HEIGHT_PX = 22; // headroom above the baseline for peak displacement

// ---- Amplitude → displacement ----
// Upward-only (the brief flags symmetric up/down as the alternative to
// try): a mirrored split reads muddy at 13px of total travel and this
// bead size, upward-only read cleaner. A future real-machine pass may
// still want the symmetric variant — one constant to flip, not a rewrite.
const DISPLACEMENT_MAX_PX = 11; // 六轮: 再收敛（峰11+谷~4，合计~15px）
// ---- Traveling wave (7/6 二轮反馈: 要有向下沉的波动感 + 珠间差异) ----
// Each bead's drive is multiplied by a phase-staggered sine: full range
// upward, DOWN_RATIO of it below the baseline (troughs politer than peaks).
// Adjacent-bead phase offset makes the row read as a wave passing through,
// and a deterministic per-bead gain (±15%) keeps siblings from moving in
// lockstep — variation without randomness (rAF resume-safe).
const WAVE_HZ = 1.0; // 六轮: 再慢
const WAVE_PHASE_STEP_RAD = 0.8;
const DOWN_RATIO = 0.35;
// 五轮（卡顿真凶）：低音量区 breath 与行波负半周在 max() 缝上来回切换
// 造成跳变——改为按音量 smoothstep 渐入行波：v<LO 纯呼吸，v>HI 纯行波，
// 之间连续混合，全程无缝。
const WAVE_FADE_LO = 0.05;
const WAVE_FADE_HI = 0.2;
const BEAD_GAIN: number[] = Array.from({ length: BEAD_COUNT }, (_, i) => {
  const h = ((i * 2654435761) % 1000) / 1000; // deterministic hash in [0,1)
  return 1 + h * 0; // 四轮实验: 增益差完全去除（保留结构便于回调）
});

// ---- Needle ballistics: asymmetric one-pole smoothing ----
// This is the precision the brief calls out as non-negotiable: fast
// attack (it heard you instantly) + slow release (the needle drifts back
// down, doesn't chop off). Expressed as time constants so the per-frame
// blend factor is frame-rate independent (dt-based alpha below).
const ATTACK_MS = 50;
const RELEASE_MS = 300;

// ---- Silent breathing (recording, but quiet) ----
const BREATH_PERIOD_MS = 3000;
const BREATH_AMPLITUDE_PX = 2;
const BREATH_PHASE_STEP_RAD = 0.5; // fixed phase offset between adjacent beads

// ---- Color / opacity ----
const DORMANT_OPACITY = 0.35;
const ACTIVE_BASE_OPACITY = 0.7;
const GLOW_GAIN = 1.15; // headroom so envelope ~0.87 already reads as "full bright"

// ---- Audio pipeline ----
const TIME_DOMAIN_FFT_SIZE = 512; // AnalyserNode.fftSize — time-domain buffer length
const RMS_GAIN = 3.2; // speech RMS rarely clears ~0.3 — boost toward the visible range

const SETTLE_TRANSITION =
  'background-color var(--ls-duration-base) var(--ls-easing), ' +
  'opacity var(--ls-duration-base) var(--ls-easing), ' +
  'transform var(--ls-duration-base) var(--ls-easing)';

const centerX = (liftPx: number) => `translateX(-50%) translateY(${(-liftPx).toFixed(2)}px)`;

export function RecordingBeads({
  analyserRef,
  active,
  reducedMotion,
}: {
  analyserRef: MutableRefObject<AnalyserNode | null>;
  active: boolean;
  reducedMotion: boolean;
}) {
  const dotRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const glowRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const bufferRef = useRef<Float32Array>(new Float32Array(BEAD_COUNT));
  const envelopeRef = useRef(0); // last smoothed 0..1 amplitude
  const activeRef = useRef(active);
  // Explicitly parameterized over ArrayBuffer (not the ArrayBufferLike
  // default TS 5.7+ infers for a bare `Float32Array`) — AnalyserNode's
  // getFloatTimeDomainData only accepts a plain-ArrayBuffer-backed view.
  const timeArrRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  activeRef.current = active;

  // Active/dormant edge: swap base colour + opacity, arm (or disarm) the
  // CSS settle transition, and reset the buffer so a fresh recording never
  // shows the previous session's stale amplitude history.
  useEffect(() => {
    if (active) {
      bufferRef.current.fill(0);
      envelopeRef.current = 0;
    }
    for (let i = 0; i < BEAD_COUNT; i++) {
      const dot = dotRefs.current[i];
      const glow = glowRefs.current[i];
      // While actively recording, every property is written per-frame
      // below with no transition (the JS envelope already provides the
      // smoothing — true whether or not reduced-motion strips the
      // transform, since brightness still tracks amplitude live either
      // way). Settling back to dormant is the one edge that gets an eased
      // CSS transition, so the fall reads as "settle" not "cut".
      const transition = active ? 'none' : SETTLE_TRANSITION;
      if (dot) {
        dot.style.transition = transition;
        dot.style.background = active ? 'var(--ls-text-secondary)' : 'var(--ls-text-tertiary)';
        dot.style.opacity = String(active ? ACTIVE_BASE_OPACITY : DORMANT_OPACITY);
        if (!active || reducedMotion) dot.style.transform = centerX(0);
      }
      if (glow) {
        glow.style.transition = transition;
        if (!active) glow.style.opacity = '0';
        if (!active || reducedMotion) glow.style.transform = centerX(0);
      }
    }
  }, [active, reducedMotion]);

  // Per-frame drive loop. Reads live props via refs so it never needs to
  // tear down / restart on state changes — same precedent as the old
  // WaveformCanvas (doesn't cause Review re-renders).
  useEffect(() => {
    let mounted = true;
    let lastTs: number | null = null;

    const frame = (ts: number) => {
      if (!mounted) return;
      const dt = lastTs == null ? 16.7 : Math.min(64, ts - lastTs);
      lastTs = ts;

      const isActive = activeRef.current;
      let sample = 0;
      if (isActive) {
        const analyser = analyserRef.current;
        if (analyser) {
          const size = analyser.fftSize;
          let arr = timeArrRef.current;
          if (!arr || arr.length !== size) {
            arr = new Float32Array(size);
            timeArrRef.current = arr;
          }
          if (typeof analyser.getFloatTimeDomainData === 'function') {
            analyser.getFloatTimeDomainData(arr);
          } else {
            const bytes = new Uint8Array(size);
            analyser.getByteTimeDomainData(bytes);
            for (let i = 0; i < size; i++) arr[i] = ((bytes[i] ?? 128) - 128) / 128;
          }
          let sumSq = 0;
          for (let i = 0; i < size; i++) {
            const v = arr[i] ?? 0;
            sumSq += v * v;
          }
          const rms = Math.sqrt(sumSq / size);
          sample = Math.min(1, rms * RMS_GAIN);
        }
      }

      // Asymmetric one-pole low-pass: fast attack, slow release, both
      // expressed as dt-based alpha so playback speed doesn't chase the
      // display's frame rate.
      const tau = sample > envelopeRef.current ? ATTACK_MS : RELEASE_MS;
      const alpha = 1 - Math.exp(-dt / tau);
      envelopeRef.current += (sample - envelopeRef.current) * alpha;
      const envelope = envelopeRef.current;

      // Ring buffer: newest sample enters at the right (last index),
      // everything else steps one slot left — "time flows right to left".
      if (isActive) {
        const buf = bufferRef.current;
        buf.copyWithin(0, 1);
        buf[BEAD_COUNT - 1] = envelope;
      }

      if (isActive && !reducedMotion) {
        const t = ts / 1000;
        const breathHz = 1 / (BREATH_PERIOD_MS / 1000);
        for (let i = 0; i < BEAD_COUNT; i++) {
          const dot = dotRefs.current[i];
          const glow = glowRefs.current[i];
          if (!dot) continue;

          const v = bufferRef.current[i] ?? 0;
          // Silent breathing: slow phase-staggered sine, only visible when
          // it's louder than the real signal at that slot — real
          // amplitude crossing the breath's own ~2px ceiling naturally
          // overrides it, no separate hard threshold needed.
          const breath =
            ((Math.sin(t * 2 * Math.PI * breathHz + i * BREATH_PHASE_STEP_RAD) + 1) / 2) *
            BREATH_AMPLITUDE_PX;
          // Traveling wave: signed multiplier in [-DOWN_RATIO, 1] — a loud
          // bead oscillates THROUGH the baseline (that's what waves do);
          // breathing only competes with the upward half.
          const wave = Math.sin(t * 2 * Math.PI * WAVE_HZ + i * WAVE_PHASE_STEP_RAD);
          const signed = wave >= 0 ? wave : wave * DOWN_RATIO;
          const drivePx = v * DISPLACEMENT_MAX_PX * BEAD_GAIN[i]! * signed;
          const tMix = Math.min(1, Math.max(0, (v - WAVE_FADE_LO) / (WAVE_FADE_HI - WAVE_FADE_LO)));
          const mix = tMix * tMix * (3 - 2 * tMix); // smoothstep
          const liftPx = breath * (1 - mix) + drivePx * mix;
          const transform = centerX(liftPx);
          dot.style.transform = transform;
          if (glow) {
            glow.style.transform = transform;
            glow.style.opacity = Math.min(1, v * GLOW_GAIN).toFixed(3);
          }
        }
      } else if (isActive && reducedMotion) {
        // Reduced motion: no displacement, no breathing — brightness only.
        for (let i = 0; i < BEAD_COUNT; i++) {
          const glow = glowRefs.current[i];
          if (!glow) continue;
          const v = bufferRef.current[i] ?? 0;
          glow.style.opacity = Math.min(1, v * GLOW_GAIN).toFixed(3);
        }
      }
      // else (dormant): transforms/opacity already pinned by the
      // active-edge effect above; no per-frame write needed while resting.

      requestAnimationFrame(frame);
    };

    const raf = requestAnimationFrame(frame);
    return () => {
      mounted = false;
      cancelAnimationFrame(raf);
    };
    // analyserRef/reducedMotion are read live via refs inside the loop —
    // this effect sets up the rAF loop exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      aria-hidden="true"
      className="flex"
      // 7/6 反馈: 静息珠列在标题块与文本框之间视觉居中——上收下放
      style={{ marginTop: '7px', marginBottom: '11px', height: `${ROW_HEIGHT_PX}px`, gap: '2px' }}
    >
      {Array.from({ length: BEAD_COUNT }, (_, i) => (
        <span key={i} style={{ position: 'relative', flex: '1 1 0%' }}>
          <span
            ref={(el) => {
              dotRefs.current[i] = el;
            }}
            style={{
              position: 'absolute',
              left: '50%',
              bottom: 0,
              width: `${BEAD_SIZE_PX}px`,
              height: `${BEAD_SIZE_PX}px`,
              borderRadius: '50%',
              background: 'var(--ls-text-tertiary)',
              opacity: DORMANT_OPACITY,
              transform: centerX(0),
              willChange: 'transform',
            }}
          />
          <span
            ref={(el) => {
              glowRefs.current[i] = el;
            }}
            style={{
              position: 'absolute',
              left: '50%',
              bottom: 0,
              width: `${BEAD_SIZE_PX}px`,
              height: `${BEAD_SIZE_PX}px`,
              borderRadius: '50%',
              background: 'var(--ls-text)',
              opacity: 0,
              transform: centerX(0),
            }}
          />
        </span>
      ))}
    </div>
  );
}

// Exported for Review.tsx's beginRecording() to size the shared
// AnalyserNode's time-domain buffer consistently with what this component
// expects to read.
export const RECORDING_BEADS_FFT_SIZE = TIME_DOMAIN_FFT_SIZE;
