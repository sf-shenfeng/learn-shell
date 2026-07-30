// LessonStatusBadge — §6 完成状态机 pill.
//
// "学习中(in_progress)/未开始(not_started)" render nothing — brief: "默认不
// 显示徽章，安静". Only the two learner/teacher-authored states get a pill,
// each its own color so they never impersonate each other (§6: "两个标签两
// 种颜色，互不冒充"): 已学完 (learner's own declaration, unverified) borrows
// --ls-hypothesis (same color CurrentMoveCard/ConfidencePicker already use
// for "this is a claim, not yet corroborated"); 已回课 (teacher-graded +
// receipt delivered) borrows --ls-corroborated (same color StatusBadge's
// 'graded' state uses in Lesson.tsx — "verified" is a fixed color across
// this app, not a new one invented for this badge).
//
// Shared by Lesson.tsx (page header) and Courses.tsx (lesson list rows) —
// identical (state → label/color) logic in both places, unlike e.g.
// ToPoolButton's precedent of deliberate duplication (that component closes
// over pool-membership context specific to its host page; this one doesn't).

import type { LessonProgressState } from '@learn-shell/contracts';
import { useT } from '../i18n';
import type { DictKey } from '../i18n/dict';
import { StatusPill } from '../components/StatusPill';

const STATE_STYLE: Partial<Record<LessonProgressState, { labelKey: DictKey; color: string }>> = {
  completed_declared: { labelKey: 'lesson.progress.declaredBadge', color: 'var(--ls-hypothesis)' },
  closed: { labelKey: 'lesson.progress.closedBadge', color: 'var(--ls-corroborated)' },
};

export function LessonStatusBadge({
  state,
}: {
  state: LessonProgressState | undefined;
}) {
  const { t } = useT();
  if (!state) return null;
  const cfg = STATE_STYLE[state];
  if (!cfg) return null;
  return <StatusPill color={cfg.color}>{t(cfg.labelKey)}</StatusPill>;
}
