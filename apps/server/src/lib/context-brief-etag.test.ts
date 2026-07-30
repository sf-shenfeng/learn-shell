// Unit tests for computeBriefEtag (context/brief 去重) — 纯函数,
// 无 DB (context-brief.ts 的连接池是惰性的, import 不落地连接)。
// Run via `pnpm --filter @learn-shell/server test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBriefEtag, type LearnerBrief } from './context-brief';

function makeBrief(overrides: Partial<Omit<LearnerBrief, 'brief_etag'>> = {}): Omit<LearnerBrief, 'brief_etag'> {
  return {
    pair_id: 'pair_1',
    generated_at: '2026-07-14T08:00:00.000Z',
    identity: {
      learner: { id: 'lrn_1', display_name: 'Demo Learner', locale: 'zh-CN' },
      agent: { id: 'agt_1', display_name: 'Demo Agent (Claude Code)', identity_note: null },
    },
    top_confidence_hypotheses: [
      {
        id: 'hyp_1',
        allowed_for_teaching: true,
        domain: 'cfa',
        observation: '例题先行比定义先行有效',
        confidence: 0.8,
        last_verified_at: null,
        last_evidence_at: '2026-07-10T00:00:00.000Z',
        user_approved: null,
      },
    ],
    needs_reverification: [],
    hypotheses_in_book_count: 1,
    hypotheses_note: '在册 1 条, 简报只携最近有证据的 1 条',
    recent_evaluations: [],
    latest_reflection: null,
    confidence_facts: null,
    source_material: null,
    ...overrides,
  };
}

test('brief etag: stable across calls for identical content', () => {
  assert.equal(computeBriefEtag(makeBrief()), computeBriefEtag(makeBrief()));
  assert.match(computeBriefEtag(makeBrief()), /^[0-9a-f]{12}$/);
});

test('brief etag: generated_at (per-call volatile) is excluded — same model, same etag', () => {
  const a = makeBrief({ generated_at: '2026-07-14T08:00:00.000Z' });
  const b = makeBrief({ generated_at: '2026-07-15T09:30:00.000Z' });
  assert.equal(computeBriefEtag(a), computeBriefEtag(b));
});

test('brief etag: any real model change flips the etag', () => {
  const base = computeBriefEtag(makeBrief());
  const changed = computeBriefEtag(
    makeBrief({ latest_reflection: { id: 'ref_1', method: '费曼', next_action: '下节课先出题', written_at: '2026-07-14T00:00:00.000Z' } })
  );
  assert.notEqual(base, changed);
});
