// useDocumentRepo — narrows useRepository() to the batch G Document
// extension, mirroring journal/useJournalNotes.ts's useJournalRepo() (same
// "concrete repos implement every extension interface, callers narrow with a
// cast" dance simulatedQuiz/observationGateExt/calibrationExt all use too).

import { useRepository } from '../repository';
import type { Repository } from '@learn-shell/contracts';
import type { DocumentRepo } from '../repository/documentExt';

export function useDocumentRepo(): (Repository & DocumentRepo) | null {
  return useRepository() as (Repository & DocumentRepo) | null;
}
