// 把握度模式总开关读取 — 批1.
//
// Shared by ExerciseCard (Lesson.tsx) and SimulatedQuizRunner (Quiz.tsx) to
// decide whether to render the ConfidencePicker at all. Default true
// (7/8 补票: 默认开) when there's no repo/pair yet to ask.

import { useQuery } from '@tanstack/react-query';
import type { Repository } from '@learn-shell/contracts';
import { useRepository } from '../repository';
import { usePair } from '../shell/PairProvider';
import type { ObservationGateRepo } from '../repository/observationGateExt';

export function useConfidenceModeEnabled(): boolean {
  const repo = useRepository() as (Repository & ObservationGateRepo) | null;
  const { pairId } = usePair();

  const q = useQuery({
    queryKey: ['observation-gate', pairId],
    queryFn: () => (repo && pairId ? repo.getObservationGateState(pairId) : Promise.resolve(null)),
    enabled: !!repo && !!pairId,
  });

  return q.data?.confidence_mode_enabled ?? true;
}
