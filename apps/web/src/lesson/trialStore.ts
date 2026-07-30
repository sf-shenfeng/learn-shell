// Trial state store
//
// PagedLesson's `key={index}` remounts the page subtree on every nav (the
// page-enter animation depends on it — not allowed to change that), which
// would otherwise wipe TrialBlock's draft/verdict on every page turn.
// Module-level zustand store keyed by `${lessonId}#${trialIndex}` survives
// the remount. Deliberately NOT persisted to local/sessionStorage — a stale
// draft from yesterday is worse than losing today's in-memory one (design
// call, not negotiable per the brief).

import { create } from 'zustand';
import type { TrialVerdict } from '@learn-shell/contracts';

export interface TrialState {
  draft: string;
  showHint: boolean;
  revealed: boolean;
  verdict: TrialVerdict | null;
  attempts: number;
  /** 1-based index of the first Expected item that didn't match, for the
   *  most recent 'incorrect' verdict. Null otherwise. */
  mismatchAt: number | null;
  /** 作答框标红：答错或空稿点 Check 时置起，一开始编辑就清掉。 */
  inputError: boolean;
}

const EMPTY_STATE: TrialState = {
  draft: '',
  showHint: false,
  revealed: false,
  verdict: null,
  attempts: 0,
  mismatchAt: null,
  inputError: false,
};

interface TrialStore {
  byKey: Record<string, TrialState>;
  update: (key: string, patch: Partial<TrialState>) => void;
}

const useTrialStore = create<TrialStore>((set) => ({
  byKey: {},
  update: (key, patch) =>
    set((s) => ({
      byKey: {
        ...s.byKey,
        [key]: { ...(s.byKey[key] ?? EMPTY_STATE), ...patch },
      },
    })),
}));

/** TrialBlock's state hook. `trialIndex` is the AST-order 0-based index
 *  attached by remarkLsBlocks (docs/LESSON-BLOCKS-v1.md §2.3). */
export function useTrialState(
  lessonId: string,
  trialIndex: number
): [TrialState, (patch: Partial<TrialState>) => void] {
  const key = `${lessonId}#${trialIndex}`;
  const state = useTrialStore((s) => s.byKey[key] ?? EMPTY_STATE);
  const update = useTrialStore((s) => s.update);
  const setState = (patch: Partial<TrialState>) => update(key, patch);
  return [state, setState];
}
