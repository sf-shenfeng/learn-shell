import { useEffect, useRef, useState } from 'react';

// ============================================================================
// prefers-reduced-motion — read once + subscribe, no library needed for
// one media query.
// ============================================================================

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

// ============================================================================
// FlipCard — real rotateY flip between a card's front/back real estate
// (真翻转动画案). ~0.4s round trip, content swapped at the edge-on 90° midpoint
// (not a two-sided backface-hidden card — a single pane whose content is
// replaced while invisible side-on), using the design system's existing
// --ls-easing token (cubic-bezier(0.16,1,0.3,1), already "crisp settle, no
// bounce" — no new motion token needed).
//
// 翻面组件抽取 — extracted out of Review.tsx (its original home) so
// lesson/blocks.tsx's ConceptFlip block can share the same real-flip
// dialect instead of its previous instant content-swap. Logic unchanged
// from the Review.tsx original; only the module boundary moved.
//
// Mid-flip input: a target change that arrives while a flip is already
// in flight is not applied immediately (which would tear the rotation)
// and not stacked (which would queue up multiple full turns) — it's
// remembered in a ref and only kicked off once the in-flight half-turn
// settles, so rapid space-mashing always converges cleanly on whatever
// face was most recently requested.
// ============================================================================

const FLIP_HALF_MS = 200; // full round trip ~= 400ms, split at the swap point

// Velocity-matched half-turn easings (翻面缓动调优, 真机验收反馈: "稍稍卡顿").
// Using the settle curve (--ls-easing, ease-out) for BOTH halves made the
// card decelerate into the 90° edge, stall, then burst out — the perceived
// hitch. Fix: first half accelerates INTO the edge with the exact bezier
// mirror of --ls-easing, second half settles out with --ls-easing itself;
// angular velocity matches at the swap point and the composite 400ms reads
// as one continuous ease-in-out turn. (Linear would also kill the stall
// but feels mechanical — no commit, no settle.)
const FLIP_EASE_IN = 'cubic-bezier(0.7, 0, 0.84, 0)'; // mirror of (0.16,1,0.3,1)

type FlipFace = 'front' | 'back';
type FlipPhase = 'idle' | 'to-edge' | 'snap' | 'from-edge';

export function FlipCard({
  flipKey,
  showBack,
  reduceMotion,
  front,
  back,
}: {
  /** Remount key (card.id) — switching cards should never animate a flip,
   *  only in-card reveal/flip-back should. */
  flipKey: string;
  showBack: boolean;
  reduceMotion: boolean;
  front: React.ReactNode;
  back: React.ReactNode;
}) {
  return (
    <FlipCardInner
      key={flipKey}
      showBack={showBack}
      reduceMotion={reduceMotion}
      front={front}
      back={back}
    />
  );
}

function FlipCardInner({
  showBack,
  reduceMotion,
  front,
  back,
}: {
  showBack: boolean;
  reduceMotion: boolean;
  front: React.ReactNode;
  back: React.ReactNode;
}) {
  const target: FlipFace = showBack ? 'back' : 'front';
  const [displayFace, setDisplayFace] = useState<FlipFace>(target);
  const [phase, setPhase] = useState<FlipPhase>('idle');
  const timerRef = useRef<number | null>(null);
  const rotatorRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef(target);
  targetRef.current = target;

  const beginFlip = (want: FlipFace) => {
    setPhase('to-edge');
    timerRef.current = window.setTimeout(() => {
      // Edge-on: swap the rendered face while the card is invisible
      // side-on, then snap the transform to the mirrored angle with no
      // transition so the second half animates in cleanly from there —
      // avoids the mirrored/backwards-text look a naive 0→180 continuous
      // spin would give the swapped-in face.
      setDisplayFace(want);
      setPhase('snap');
      requestAnimationFrame(() => {
        // Force layout so the browser commits the no-transition -90deg
        // frame before the next state re-enables the transition.
        void rotatorRef.current?.offsetHeight;
        setPhase('from-edge');
        timerRef.current = window.setTimeout(() => {
          setPhase('idle');
          timerRef.current = null;
          // Chase the latest target if it moved on while we were
          // mid-turn (queue, not stack, not tear).
          if (targetRef.current !== want) beginFlip(targetRef.current);
        }, FLIP_HALF_MS);
      });
    }, FLIP_HALF_MS);
  };

  useEffect(() => {
    if (target === displayFace) return;
    if (reduceMotion) {
      setDisplayFace(target);
      return;
    }
    if (phase !== 'idle') return; // mid-flip — beginFlip's own settle chases it
    beginFlip(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, reduceMotion]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    []
  );

  const rotation = phase === 'to-edge' ? 90 : phase === 'snap' ? -90 : 0;
  const withTransition = phase === 'to-edge' || phase === 'from-edge';

  if (reduceMotion) {
    return <>{displayFace === 'front' ? front : back}</>;
  }

  return (
    <div style={{ perspective: '1400px' }}>
      <div
        ref={rotatorRef}
        style={{
          transform: `rotateY(${rotation}deg)`,
          transition: withTransition
            ? `transform ${FLIP_HALF_MS}ms ${
                phase === 'to-edge' ? FLIP_EASE_IN : 'var(--ls-easing)'
              }`
            : 'none',
          // GPU-promote the rotator so the mid-flip face swap (state update
          // + forced reflow at the animation's most visible moment) never
          // costs a paint hiccup.
          willChange: 'transform',
        }}
      >
        {displayFace === 'front' ? front : back}
      </div>
    </div>
  );
}
