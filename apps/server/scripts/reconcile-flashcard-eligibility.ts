#!/usr/bin/env -S npx tsx
/** Default is read-only. Requires DATABASE_URL and --pair-id=... explicitly.
 * --apply reconciles exact provenance and lesson activation only.
 * --opt-out-unlinked-ids=fc_a,fc_b is a ONE-TIME explicit list of legacy cards
 * to remove from review; do not reuse it after users manually opt them back in.
 * No tags inference. No writes to FSRS, paused, deck, or content. */
import { and, eq } from 'drizzle-orm';
import { db, closeDb } from '../src/db/client';
import { flashcards } from '../src/db/schema';
import { getFlashcardContext, projectFlashcards } from '../src/lib/flashcard-projection';

async function main() {
  const args = process.argv.slice(2);
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pairId = args.find((a) => a.startsWith('--pair-id='))?.slice(10);
  if (!pairId) throw new Error('--pair-id=... is required');
  const apply = args.includes('--apply');
  const optOut = new Set((args.find((a) => a.startsWith('--opt-out-unlinked-ids='))?.split('=')[1] ?? '').split(',').filter(Boolean));
  await db.transaction(async (tx) => {
    // Recompute under row locks when applying; stale dry-run output is never an update plan.
    const cards = await tx.select().from(flashcards).where(eq(flashcards.pair_id, pairId)).for(apply ? 'update' : 'share');
    const { sources, completed } = await getFlashcardContext(tx, pairId);
    const projected = projectFlashcards(cards, sources, completed);
    const changes = projected.flatMap((p, index) => {
      const before = cards[index]!;
      const activated = optOut.has(p.id) && p.source_status === 'independent' ? false : p.activated;
      if (before.concept_id === p.concept_id && before.activated === activated) return [];
      return [{ id: p.id, concept_id: p.concept_id, activated,
        before: { concept_id: before.concept_id, activated: before.activated } }];
    });
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', pair_id: pairId, changes }, null, 2));
    if (apply) for (const change of changes) {
      await tx.update(flashcards).set({ concept_id: change.concept_id, activated: change.activated })
        .where(and(eq(flashcards.id, change.id), eq(flashcards.pair_id, pairId)));
    }
  });
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(closeDb);
