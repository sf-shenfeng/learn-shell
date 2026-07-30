// Identity (称谓体系, 2026-07-07) — thin client read/write for the block
// apps/server/src/lib/context-brief.ts now returns as `identity` on both
// get_context (GET /pairs/:pairId/context) and get_learner_brief.
//
// No consumption point existed before this: journal/agentLabel.ts's
// shortAgentLabel + KNOWN_ALIASES table was a workaround built when the only
// signal available was the raw `agents` row (repo.getCurrentPair → repo.getAgent),
// with no registered-name concept above it. That workaround is superseded —
// see useJournalTimeline.ts.
//
// @learn-shell/contracts' Repository interface is locked for this task and
// has no identity methods yet, so this talks to the REST API directly,
// mirroring HttpRepository's BASE_URL/fetch shape rather than routing
// through `useRepository()`. Only actually wired when the active repo is
// 'http' — mock/empty modes have no server behind them, so callers get
// `identity: null` and fall back to whatever word they'd have shown anyway.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRepository } from '../repository';
import { usePair } from '../shell/PairProvider';

export interface IdentityBrief {
  learner: { id: string; display_name: string };
  agent: { id: string; display_name: string; identity_note: string | null };
}

import { API_BASE_URL } from './apiBase';

const BASE_URL = API_BASE_URL;

/** agents.display_name carries provenance in parens, e.g. "某老师 (Claude Code ·
 *  Opus)" (apps/server/src/db/seed.ts) — strip it for display; that detail
 *  isn't part of the name anyone calls the agent by. */
export function cleanAgentName(displayName: string): string {
  return displayName.split(' (')[0]?.trim() ?? displayName.trim();
}

export function useIdentity(): { identity: IdentityBrief | null | undefined; isLoading: boolean } {
  const { pairId } = usePair();
  const repo = useRepository();
  const live = repo?.mode === 'http';

  const q = useQuery({
    queryKey: ['identity', pairId],
    queryFn: async (): Promise<IdentityBrief | null> => {
      const res = await fetch(`${BASE_URL}/pairs/${pairId}/context`);
      if (!res.ok) throw new Error(`identity fetch failed: HTTP ${res.status}`);
      const data = (await res.json()) as { identity: IdentityBrief | null };
      return data.identity ?? null;
    },
    enabled: !!pairId && live,
  });

  return { identity: live ? q.data : null, isLoading: live && q.isLoading };
}

export interface IdentityPatch {
  learner_display_name?: string;
  agent_display_name?: string;
  agent_identity_note?: string;
}

export function useUpdateIdentity() {
  const { pairId } = usePair();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (patch: IdentityPatch): Promise<IdentityBrief> => {
      if (!pairId) throw new Error('no active pair');
      const res = await fetch(`${BASE_URL}/pairs/${pairId}/identity`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`identity update failed: HTTP ${res.status} ${body}`);
      }
      return (await res.json()) as IdentityBrief;
    },
    onSuccess: () => {
      // Broad invalidate — every surface reading ['identity', ...] (Settings,
      // journal, live/contract chat labels) refetches.
      qc.invalidateQueries({ queryKey: ['identity'] });
    },
  });
}
