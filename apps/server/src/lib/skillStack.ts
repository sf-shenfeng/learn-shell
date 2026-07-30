// skillStack — pickSkillStack shared lib (skill_stack 冻结案).
//
// Establish 时刻冻结 skill_stack 的映射逻辑 (goal → domain / content_modality →
// modality / intensity / preferred_time_of_day → pace). Ported from
// apps/server/src/mcp/server.ts's pickSkillStack (~line 162-208, the fuller
// reference impl — it includes the `pace` facet, which apps/web/src/
// repository/MockRepository.ts's pickSkillStackForContract omits — see
// docstring below for that known drift).
//
// This copy is a pure function (no db access) so both REST write routes
// (apps/server/src/routes/write.ts: POST /contracts + PATCH /contracts/:id)
// can call it without depending on mcp/server.ts, which another workstream
// owns concurrently. mcp/server.ts's pickSkillStack() still has its own
// (near-identical) copy — unifying the two into one source of truth is
// tracked debt, not done here (see ledger report).
//
// 哲学 (2026-06-29, ported verbatim from mcp/server.ts): skill 之间
// orthogonal, 不在 picker 解决冲突, 而是在 skill .md 写作时避免冲突.

import type {
  ContractContentModality,
  ContractIntensity,
  PreferredTimeOfDay,
  SkillRef,
} from '@learn-shell/contracts';

export interface SkillStackInput {
  goal: string;
  intensity: ContractIntensity;
  content_modality: ContractContentModality;
  preferred_time_of_day?: PreferredTimeOfDay[] | null;
}

export function pickSkillStack(input: SkillStackInput): SkillRef[] {
  const stack: SkillRef[] = [];

  // workflow — unconditional first; orchestrator for the whole stack.
  stack.push({ category: 'workflow', name: 'lesson-prep' });

  // domain — goal keyword
  const goal = (input.goal ?? '').toLowerCase();
  if (/cfa/.test(goal)) stack.push({ category: 'domain', name: 'teach-cfa' });
  else if (/jlpt|toefl|ielts|japanese|chinese|english|spanish|language/.test(goal))
    stack.push({ category: 'domain', name: 'teach-language' });
  else stack.push({ category: 'domain', name: 'teach-general' });

  // modality — explicit only ('mixed' skipped, agent chooses)
  if (input.content_modality === 'visual')
    stack.push({ category: 'modality', name: 'visual-heavy' });
  else if (input.content_modality === 'text')
    stack.push({ category: 'modality', name: 'formula-first' });

  // intensity — always
  stack.push({
    category: 'intensity',
    name: input.intensity ?? 'standard',
  });

  // tone — skipped by default; agent uses its own soul. W2+ may add a
  // contract field tone_preset to activate.

  // pace — optional. Pick the first preferred slot if any.
  const times = input.preferred_time_of_day ?? [];
  if (times.includes('morning')) stack.push({ category: 'pace', name: 'morning-burst' });
  else if (times.includes('evening')) stack.push({ category: 'pace', name: 'evening-deep' });
  else if (times.includes('afternoon')) stack.push({ category: 'pace', name: 'lunch-quick' });

  // verify — unconditional enforcement gate (content-verify); always last.
  stack.push({ category: 'verify', name: 'content-verify' });

  return stack;
}
