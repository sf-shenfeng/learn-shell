import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  QuestionBank,
  QuestionBankId,
  QuizQuestion,
  Repository,
  SimulatedQuiz,
  SimulatedQuizAttempt,
  SimulatedQuizId,
} from '@learn-shell/contracts';
import { useRepository } from '../repository';
import type { SimulatedQuizRepo } from '../repository/simulatedQuiz';
import { usePair } from '../shell/PairProvider';
import { useT } from '../i18n';
import type { DictKey } from '../i18n/dict';
import { ConfidencePicker } from '../lib/ConfidencePicker';
import { useConfidenceModeEnabled } from '../lib/useConfidenceMode';
import { CONFIDENCE_ANCHOR_PCT, CONFIDENCE_LEVEL_BY_KEY, type ConfidenceLevel } from '../lib/confidence';
import Kbd from '../shell/Kbd';

/**
 * Quiz — top-level page (G Q).
 *
 * TEACHING-SPEC §3.3 + §6.7:
 *   Tab 1 · Simulated — Agent 出题, 训练用. Round 3 (2026-07-07 Quiz 通电):
 *     grouped by course → answer flow (single/multi choice + open-ended) →
 *     server-graded score view → attempt history. See SimulatedTab below.
 *   Tab 2 · Past papers — 真题库 (QuestionBank → 选 bank → 答题 → 自动判分)
 */

type Tab = 'simulated' | 'real';

// 选项稳定洗牌：出题人容易把正确项写在固定位置（首份卷答案清一色
// A 位，学习者三题识破）。展示层按题目 id 做种子化 Fisher-Yates——同一题每次渲染
// 顺序一致（选中态不跳），不同题之间答案位置各不相同。只用于模拟线：它按选项
// 原文存答案，重排安全；真题线按字母序号存答案，重排会错位，二期一起改。
// 考试键盘快捷键（学习者=快捷键一等公民）：焦点在输入类元素内时全部快捷键失效，
// 不劫持打字。两个考试流（模拟卷 / BankRunner）共用这个判定。
function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

function stableShuffle<T>(arr: readonly T[], seed: string): T[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const rand = () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h = (h ^= h >>> 16) >>> 0;
    return h / 4294967296;
  };
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

// 置信度快捷键案: 快捷键图例，范式抄 Mindmap.tsx 的热键图例 ("Hotkey cheat sheet",
// 见该文件 dragPanZoom 一带) —— 同款 <Kbd> 逐段拼接 + text-tertiary 11px 小字。
// 两个考试流 (SimulatedQuizRunner / BankRunner) 共用；showConfidence 只在置信度
// 模式开启且该流确实渲染 ConfidencePicker 时为 true (BankRunner 目前没有置信度
// 环节，恒传 false —— 见任务二 "没有就只管模拟卷流")。
function QuizHotkeyLegend({ showConfidence }: { showConfidence: boolean }) {
  const { t } = useT();
  return (
    <p className="text-[11px] leading-4 text-[var(--ls-text-tertiary)]" style={{ marginTop: '10px' }}>
      <Kbd>↑</Kbd>
      <Kbd>↓</Kbd> {t('quiz.hotkeys.chooseOption')} · <Kbd>Enter</Kbd> {t('quiz.hotkeys.select')} ·{' '}
      <Kbd>Space</Kbd> {t('quiz.hotkeys.multiToggle')}
      {showConfidence && (
        <>
          {' '}
          · <Kbd>1</Kbd>–<Kbd>3</Kbd> {t('quiz.hotkeys.confidence')}
        </>
      )}{' '}
      · <Kbd>←</Kbd>
      <Kbd>→</Kbd> {t('quiz.hotkeys.switchQuestion')}
    </p>
  );
}

export default function Quiz() {
  const { t } = useT();
  const [tab, setTab] = useState<Tab>('simulated');

  return (
    <div>
      {/* Header */}
      <div className="flex items-baseline flex-wrap" style={{ gap: '14px', marginBottom: '6px' }}>
        <h1
          className="font-bold text-[24px] leading-[32px] tracking-[-0.02em]"
          style={{ margin: 0 }}
        >
          {t('quiz.title')}
        </h1>
        <span className="text-[13px] leading-[20px] text-[var(--ls-text-tertiary)]">
          {t('quiz.subtitle')}
        </span>
      </div>

      {/* Tab strip */}
      <div
        className="flex gap-1.5 flex-wrap border-b border-[var(--ls-border)]"
        style={{ marginTop: '20px', marginBottom: '24px' }}
      >
        <TabBtn active={tab === 'simulated'} onClick={() => setTab('simulated')}>
          {t('quiz.tab.simulated')}
        </TabBtn>
        <TabBtn active={tab === 'real'} onClick={() => setTab('real')}>
          {t('quiz.tab.pastPapers')}
        </TabBtn>
      </div>

      {tab === 'simulated' ? <SimulatedTab /> : <RealQuizTab />}
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`font-medium text-[13px] leading-5 transition-colors duration-[var(--ls-duration-fast)] ${
        active ? 'text-[var(--ls-text)]' : 'text-[var(--ls-text-secondary)] hover:text-[var(--ls-text)]'
      }`}
      style={{
        padding: '8px 12px',
        marginBottom: '-1px',
        borderBottom: `2px solid ${active ? 'var(--ls-text)' : 'transparent'}`,
      }}
    >
      {children}
    </button>
  );
}

/* ============================== SIMULATED ================================ */
//
// Round 3 (2026-07-07 Quiz 通电): SimulatedQuiz is agent-authored (REST
// POST /pairs/:pairId/simulated-quizzes or MCP add_simulated_quiz) — this
// tab is read + attempt only, grouped by course (product requirement).
// `useRepository()` is narrowed to `Repository & SimulatedQuizRepo` because
// the two attempt-flow methods live in a local extension type, not in
// packages/contracts (see repository/simulatedQuiz.ts for why).

function useSimulatedQuizRepo(): (Repository & SimulatedQuizRepo) | null {
  return useRepository() as (Repository & SimulatedQuizRepo) | null;
}

function SimulatedTab() {
  const { t } = useT();
  const repo = useSimulatedQuizRepo();
  const { pairId } = usePair();
  const [selectedQuizId, setSelectedQuizId] = useState<SimulatedQuizId | null>(null);

  const coursesQ = useQuery({
    queryKey: ['courses', pairId],
    queryFn: () => (repo && pairId ? repo.getCourses(pairId) : Promise.resolve([])),
    enabled: !!repo && !!pairId,
  });
  const quizzesQ = useQuery({
    queryKey: ['simulated-quizzes', pairId],
    queryFn: () => (repo && pairId ? repo.getSimulatedQuizzes(pairId) : Promise.resolve([])),
    enabled: !!repo && !!pairId,
  });

  const courses = coursesQ.data ?? [];
  const quizzes = quizzesQ.data ?? [];
  const selectedQuiz = quizzes.find((q) => q.id === selectedQuizId) ?? null;

  if (selectedQuizId && selectedQuiz) {
    return <SimulatedQuizRunner quiz={selectedQuiz} onExit={() => setSelectedQuizId(null)} />;
  }

  const byCourse = new Map<string, SimulatedQuiz[]>();
  for (const q of quizzes) {
    const list = byCourse.get(q.course_id) ?? [];
    list.push(q);
    byCourse.set(q.course_id, list);
  }
  const courseName = (id: string): string =>
    courses.find((c) => c.id === id)?.topic ?? t('quiz.sim.untitledCourse');

  if (quizzes.length === 0) {
    return (
      <div
        className="border border-dashed border-[var(--ls-border)] text-center text-[13px] text-[var(--ls-text-tertiary)]"
        style={{ padding: '36px', borderRadius: '10px' }}
      >
        {t('quiz.sim.empty')}
      </div>
    );
  }

  return (
    <div className="flex flex-col" style={{ gap: '22px' }}>
      {[...byCourse.entries()].map(([courseId, qs]) => (
        <section key={courseId}>
          <h2 className="font-semibold text-[14px] leading-5" style={{ marginBottom: '10px' }}>
            {courseName(courseId)}
          </h2>
          <ul className="flex flex-col" style={{ gap: '10px' }}>
            {qs.map((quiz) => (
              <li key={quiz.id}>
                <button
                  type="button"
                  onClick={() => setSelectedQuizId(quiz.id)}
                  className="w-full text-left border border-[var(--ls-border)] bg-[var(--ls-bg)] hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)]"
                  style={{ padding: '14px 16px', borderRadius: '8px' }}
                >
                  <div className="flex items-baseline justify-between flex-wrap" style={{ gap: '8px' }}>
                    <span className="font-semibold text-[14px] leading-5">
                      {new Date(quiz.created_at).toLocaleDateString()}
                    </span>
                    <span className="text-[11px] leading-4 text-[var(--ls-text-tertiary)] tabular-nums">
                      {quiz.questions.length}
                      {t('quiz.sim.questionsSuffix')}
                    </span>
                  </div>
                  {quiz.agent_skill_used && (
                    <p
                      className="text-[12px] leading-[18px] text-[var(--ls-text-secondary)]"
                      style={{ marginTop: '6px' }}
                    >
                      {quiz.agent_skill_used}
                    </p>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function SimulatedQuizRunner({
  quiz,
  onExit,
}: {
  quiz: SimulatedQuiz;
  onExit: () => void;
}) {
  const { t } = useT();
  const repo = useSimulatedQuizRepo();
  const { learnerId } = usePair();
  const qc = useQueryClient();
  const confidenceModeEnabled = useConfidenceModeEnabled();

  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  // Learner Model 批1 (LEARNER-MODEL-BRIEF §9 考场条款) — 逐题可跳过 (missing
  // key = skipped), one map per question, submitted alongside the answer.
  const [confidences, setConfidences] = useState<Record<string, ConfidenceLevel | undefined>>({});
  const [viewingAttempt, setViewingAttempt] = useState<SimulatedQuizAttempt | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  // 考试键盘快捷键：↑/↓ 在当前题的选项间移动的"键盘游标"（非选中态，纯导航位置）。
  const [cursorIdx, setCursorIdx] = useState(0);
  // 置信度快捷键案: 置信度模式下 Enter 的两段式状态机——第一次 Enter 锁定答案、把这题
  // 标记为"等待评分"(true) 但不跳题；第二次 Enter 才真正跳题（不打分，skippable
  // 哲学保留）。数字键 1/2/3 打分则不看这个状态，随时可打分+跳题（死板不聪明）。
  // 切题时重置（见下方 effect）。置信度模式关闭时整个状态机不生效，Enter 照旧
  // 一键跳题（既有行为不变）。
  const [awaitingConfidence, setAwaitingConfidence] = useState(false);
  const submitBtnRef = useRef<HTMLButtonElement>(null);

  const historyQ = useQuery({
    queryKey: ['simulated-quiz-attempts', quiz.id],
    queryFn: () => (repo ? repo.getSimulatedQuizAttempts(quiz.id) : Promise.resolve([])),
    enabled: !!repo && showHistory,
  });

  const submitMut = useMutation({
    mutationFn: () => {
      if (!repo || !learnerId) throw new Error('no repo');
      return repo.submitSimulatedQuizAttempt({
        quiz_id: quiz.id,
        learner_id: learnerId,
        answers: quiz.questions.map((q) => {
          const conf = confidences[q.id];
          return {
            question_id: q.id,
            answer: answers[q.id] ?? '',
            confidence: conf,
            // 置信度去数字化 去数字化: 精确值由选中档位的固定锚定值派生
            // (0.35/0.65/0.9 → 存 35/65/90), 第四档自定义百分比已移除.
            confidence_pct: conf ? CONFIDENCE_ANCHOR_PCT[conf] : undefined,
          };
        }),
      });
    },
    onSuccess: (attempt) => {
      qc.invalidateQueries({ queryKey: ['simulated-quiz-attempts', quiz.id] });
      setViewingAttempt(attempt);
    },
  });

  const cur = quiz.questions[idx];
  const total = quiz.questions.length;
  const isMulti = cur?.question_type === 'multi_choice';
  // Defensive (自动分页兜底案 同族, bench 案二): a naive agent's write can
  // declare question_type single/multi_choice without ever attaching a
  // usable `choices` array (or omit question_type but still be malformed
  // in some other way) — the render used to just show NOTHING for that
  // question (no choice buttons, no textarea, dead-end Next/Submit
  // button) because neither branch below matched. hasUsableChoices makes
  // the two branches exhaustive: real choice data renders as choices,
  // anything else — including this malformed case — degrades to the
  // open-text branch instead of a blank screen.
  const isChoiceType = cur?.question_type === 'single_choice' || cur?.question_type === 'multi_choice';
  const hasUsableChoices = isChoiceType && Array.isArray(cur?.choices) && cur!.choices!.length > 0;
  const selectedSet = useMemo(
    () =>
      new Set(
        (cur ? (answers[cur.id] ?? '') : '')
          .split('||')
          .map((s) => s.trim())
          .filter(Boolean)
      ),
    [answers, cur]
  );

  const toggleChoice = useCallback(
    (choice: string) => {
      if (!cur) return;
      if (isMulti) {
        setAnswers((a) => {
          const set = new Set(
            (a[cur.id] ?? '')
              .split('||')
              .map((s) => s.trim())
              .filter(Boolean)
          );
          if (set.has(choice)) set.delete(choice);
          else set.add(choice);
          // ' || ' separator — commas occur inside English choices (竖线分隔约定)
          return { ...a, [cur.id]: [...set].join(' || ') };
        });
      } else {
        setAnswers((a) => ({ ...a, [cur.id]: choice }));
      }
    },
    [cur, isMulti]
  );

  // 键盘导航用的稳定选项数组——与渲染用的是同一份洗牌结果，游标下标才对得上。
  const shuffledChoices = useMemo(
    () => (hasUsableChoices ? stableShuffle(cur!.choices!, cur!.id) : []),
    [hasUsableChoices, cur]
  );

  // 切题时游标重置到该题已选项（单选：该选项；多选：已勾选的第一项）或第一项。
  useEffect(() => {
    if (!cur || !hasUsableChoices) {
      setCursorIdx(0);
      return;
    }
    if (isMulti) {
      const found = shuffledChoices.findIndex((c) => selectedSet.has(c));
      setCursorIdx(found >= 0 ? found : 0);
    } else {
      const ans = answers[cur.id];
      const found = ans ? shuffledChoices.findIndex((c) => c === ans) : -1;
      setCursorIdx(found >= 0 ? found : 0);
    }
    // 仅在切题时重置，答题过程中的游标移动不应被这个 effect 打断。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur?.id]);

  // 置信度快捷键案: 切题时"等待评分"状态从头开始——上一题按没按 Enter 锁定，跟这一题
  // 无关。
  useEffect(() => {
    setAwaitingConfidence(false);
  }, [cur?.id]);

  // 考试键盘快捷键：↑/↓ 移动游标（到边不循环），←/→ 自由换题。Enter 与数字键
  // 1/2/3 的语义随置信度模式变化——见下方分支注释（置信度快捷键案）。结果页/复盘页
  // 不挂这个监听（viewingAttempt 时提前 return）。
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (viewingAttempt) return;
      if (isTypingTarget(e.target)) return;
      if (!cur) return;

      if (e.key === 'ArrowLeft') {
        if (idx > 0) {
          e.preventDefault();
          setIdx((i) => i - 1);
        }
        return;
      }
      if (e.key === 'ArrowRight') {
        if (idx < total - 1) {
          e.preventDefault();
          setIdx((i) => i + 1);
        }
        return;
      }

      // ↑/↓/Space 只在有选项可导航时生效；Enter 与数字键（下面）不受这个门槛
      // 限制——开放题（essay/short_answer）也渲染 ConfidencePicker，键盘评分照样
      // 该起作用，只是 shuffledChoices 为空数组，"锁定答案"那步天然是 no-op。
      if (hasUsableChoices) {
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setCursorIdx((c) => Math.max(0, c - 1));
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setCursorIdx((c) => Math.min(shuffledChoices.length - 1, c + 1));
          return;
        }
        if (e.key === ' ' && isMulti) {
          e.preventDefault();
          const choice = shuffledChoices[cursorIdx];
          if (choice) toggleChoice(choice);
          return;
        }
      }

      const advance = () => {
        if (idx < total - 1) {
          setIdx((i) => i + 1);
        } else {
          // rAF：等这一帧的 setAnswers 提交到 DOM 后再聚焦，避免提交按钮此刻仍是
          // disabled（focus() 对 disabled 元素是 no-op）。
          requestAnimationFrame(() => submitBtnRef.current?.focus());
        }
      };

      if (e.key === 'Enter') {
        e.preventDefault();
        if (!isMulti) {
          const choice = shuffledChoices[cursorIdx];
          if (choice) setAnswers((a) => ({ ...a, [cur.id]: choice }));
        }
        // 多选：勾选已经由 Space 完成，Enter 只负责锁定/确认。
        if (!confidenceModeEnabled) {
          // 既有行为不变：置信度模式关闭时 Enter 一键跳题。
          advance();
          return;
        }
        // 置信度模式：第一次 Enter 锁定答案、把焦点交给置信度评分（不跳题，
        // ConfidencePicker 会亮起）；第二次 Enter（已在等待评分状态）不评分，
        // 直接跳题——skippable 哲学保留。
        if (awaitingConfidence) {
          advance();
        } else {
          setAwaitingConfidence(true);
        }
        return;
      }

      if (confidenceModeEnabled && (e.key === '1' || e.key === '2' || e.key === '3')) {
        e.preventDefault();
        // 评分即翻页，一键双职。规则死板不聪明：不管是不是回看旧题、按没按过
        // Enter，数字键永远是"锁定当前游标答案 + 评分 + 前进"这一套。
        if (!isMulti) {
          const choice = shuffledChoices[cursorIdx];
          if (choice) setAnswers((a) => ({ ...a, [cur.id]: choice }));
        }
        setConfidences((c) => ({ ...c, [cur.id]: CONFIDENCE_LEVEL_BY_KEY[e.key as '1' | '2' | '3'] }));
        advance();
        return;
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    viewingAttempt,
    cur,
    idx,
    total,
    hasUsableChoices,
    isMulti,
    shuffledChoices,
    cursorIdx,
    toggleChoice,
    confidenceModeEnabled,
    awaitingConfidence,
  ]);

  if (viewingAttempt) {
    return (
      <SimulatedScoreView
        quiz={quiz}
        attempt={viewingAttempt}
        onRetry={() => {
          setViewingAttempt(null);
          setAnswers({});
          setConfidences({});
          setIdx(0);
        }}
        onExit={onExit}
      />
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between flex-wrap" style={{ gap: '8px', marginBottom: '18px' }}>
        <button
          type="button"
          onClick={onExit}
          className="text-[12px] hover:underline"
          style={{ color: 'var(--ls-structure)' }}
        >
          {t('quiz.sim.backToQuizzes')}
        </button>
        <button
          type="button"
          onClick={() => setShowHistory((s) => !s)}
          className="text-[12px] hover:underline"
          style={{ color: 'var(--ls-structure)' }}
        >
          {showHistory ? t('quiz.sim.hideHistory') : t('quiz.sim.viewHistory')}
        </button>
      </div>

      {showHistory && (
        <div
          className="border border-dashed border-[var(--ls-border)]"
          style={{ padding: '14px 16px', borderRadius: '8px', marginBottom: '18px' }}
        >
          {(historyQ.data ?? []).length === 0 ? (
            <p className="text-[12px] text-[var(--ls-text-tertiary)]">{t('quiz.sim.historyEmpty')}</p>
          ) : (
            <ul className="flex flex-col" style={{ gap: '8px' }}>
              {(historyQ.data ?? []).map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => setViewingAttempt(a)}
                    className="w-full text-left text-[12px] hover:underline"
                    style={{ color: 'var(--ls-text-secondary)' }}
                  >
                    {new Date(a.started_at).toLocaleString()} ·{' '}
                    {a.score != null ? `${Math.round(a.score * 100)}%` : t('quiz.sim.historyUngraded')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!cur ? (
        <p className="text-[13px] text-[var(--ls-text-tertiary)]">{t('quiz.sim.loading')}</p>
      ) : (
        <section
          className="border border-[var(--ls-border-strong)] bg-[var(--ls-bg)]"
          style={{ padding: '26px 28px', borderRadius: '10px' }}
        >
          <div className="flex items-center justify-between flex-wrap" style={{ gap: '12px', marginBottom: '14px' }}>
            <span className="text-[11px] font-medium leading-4 tracking-[0.05em] uppercase text-[var(--ls-text-tertiary)]">
              {t('quiz.questionLabel')} {idx + 1} / {total}
            </span>
          </div>
          <p
            className="font-semibold text-[16px] leading-[24px]"
            style={{ marginBottom: isMulti ? '6px' : '16px' }}
          >
            {cur.stem || t('quiz.sim.stemMissing')}
          </p>
          {isMulti && (
            <p className="text-[11px] text-[var(--ls-text-tertiary)]" style={{ marginBottom: '10px' }}>
              {t('quiz.sim.multiHint')}
            </p>
          )}

          {hasUsableChoices && (
            <div className="flex flex-col" style={{ gap: '8px', marginBottom: '20px' }}>
              {shuffledChoices.map((choice, i) => {
                const selected = isMulti ? selectedSet.has(choice) : answers[cur.id] === choice;
                const isCursor = i === cursorIdx;
                return (
                  <button
                    key={choice}
                    type="button"
                    onClick={() => {
                      setCursorIdx(i);
                      toggleChoice(choice);
                    }}
                    className="text-left transition-colors duration-[var(--ls-duration-fast)]"
                    style={{
                      padding: '10px 14px',
                      borderRadius: '8px',
                      border: `1px solid ${selected ? 'var(--ls-text)' : 'var(--ls-border)'}`,
                      background: selected ? 'var(--ls-panel)' : 'var(--ls-bg)',
                      color: 'var(--ls-text)',
                      fontSize: '13px',
                      lineHeight: '20px',
                      boxShadow: isCursor ? 'inset 0 0 0 1px var(--ls-border-strong)' : 'none',
                    }}
                  >
                    {choice}
                  </button>
                );
              })}
            </div>
          )}

          {!hasUsableChoices && (
            <>
              {isChoiceType && (
                <p
                  className="text-[11px] leading-4"
                  style={{ marginBottom: '8px', color: 'var(--ls-risk)' }}
                >
                  {t('quiz.sim.choicesUnavailable')}
                </p>
              )}
              <div
                className="text-[11px] font-medium leading-4 tracking-[0.05em] uppercase text-[var(--ls-text-tertiary)]"
                style={{ marginBottom: '8px' }}
              >
                {t('quiz.answerLabel')}
              </div>
              <textarea
                value={answers[cur.id] ?? ''}
                onChange={(e) => setAnswers((a) => ({ ...a, [cur.id]: e.target.value }))}
                rows={cur.question_type === 'essay' ? 6 : 3}
                placeholder="…"
                className="w-full border border-[var(--ls-border)] bg-[var(--ls-bg)] text-[var(--ls-text)] text-[14px] leading-6 focus:outline-none focus:border-[var(--ls-border-strong)] resize-y"
                style={{ padding: '10px 12px', borderRadius: '6px', marginBottom: '16px' }}
              />
            </>
          )}

          {confidenceModeEnabled && (
            <div style={{ marginBottom: '16px' }}>
              <ConfidencePicker
                level={confidences[cur.id]}
                onLevelChange={(lvl) => setConfidences((c) => ({ ...c, [cur.id]: lvl }))}
                awaitingConfidence={awaitingConfidence}
              />
            </div>
          )}

          <div className="flex flex-wrap" style={{ gap: '10px' }}>
            {idx > 0 && (
              <button
                type="button"
                onClick={() => setIdx((i) => i - 1)}
                className="inline-flex items-center border border-[var(--ls-border)] text-[var(--ls-text-secondary)] font-medium hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)]"
                style={{ height: '34px', padding: '0 14px', borderRadius: '6px', fontSize: '12px', lineHeight: '1' }}
              >
                {t('quiz.sim.previous')}
              </button>
            )}
            {idx < total - 1 ? (
              <button
                type="button"
                onClick={() => setIdx((i) => i + 1)}
                disabled={!answers[cur.id]?.trim()}
                className="ml-auto inline-flex items-center border border-[var(--ls-border-strong)] text-[var(--ls-text)] font-medium hover:bg-[var(--ls-panel)] disabled:opacity-40 transition-colors duration-[var(--ls-duration-fast)]"
                style={{ height: '34px', padding: '0 14px', borderRadius: '6px', fontSize: '13px', lineHeight: '1' }}
              >
                {t('quiz.sim.next')}
              </button>
            ) : (
              <button
                ref={submitBtnRef}
                type="button"
                onClick={() => submitMut.mutate()}
                disabled={!answers[cur.id]?.trim() || submitMut.isPending}
                className="ml-auto inline-flex items-center bg-[var(--ls-text)] text-[var(--ls-bg)] font-medium hover:opacity-90 disabled:opacity-40 transition-opacity duration-[var(--ls-duration-fast)]"
                style={{ height: '34px', padding: '0 14px', borderRadius: '6px', fontSize: '13px', lineHeight: '1' }}
              >
                {submitMut.isPending ? t('quiz.sim.submitting') : t('quiz.sim.submitAll')}
              </button>
            )}
          </div>
        </section>
      )}

      {cur && <QuizHotkeyLegend showConfidence={confidenceModeEnabled} />}
    </div>
  );
}

function SimulatedScoreView({
  quiz,
  attempt,
  onRetry,
  onExit,
}: {
  quiz: SimulatedQuiz;
  attempt: SimulatedQuizAttempt;
  onRetry: () => void;
  onExit: () => void;
}) {
  const { t } = useT();
  const gradable = attempt.answers.filter((a) => a.correct !== undefined);
  const correctCount = gradable.filter((a) => a.correct).length;
  const pct = gradable.length > 0 ? (correctCount / gradable.length) * 100 : null;

  return (
    <section
      className="border border-[var(--ls-border-strong)] bg-[var(--ls-bg)]"
      style={{ padding: '32px', borderRadius: '10px' }}
    >
      <div className="font-semibold text-[18px] leading-[26px]" style={{ marginBottom: '6px' }}>
        {t('quiz.sim.scoreTitle')}
      </div>
      <p className="text-[13px] leading-5 text-[var(--ls-text-secondary)]" style={{ marginBottom: '22px' }}>
        {pct != null ? (
          <>
            {correctCount} / {gradable.length} {t('quiz.score')} ·{' '}
            <span className="tabular-nums">{pct.toFixed(0)}%</span>
          </>
        ) : (
          t('quiz.sim.noGradable')
        )}
      </p>

      <ul className="flex flex-col" style={{ gap: '10px', marginBottom: '22px' }}>
        {attempt.answers.map((a) => {
          const q = quiz.questions.find((qq) => qq.id === a.question_id);
          if (!q) return null;
          const graded = a.correct !== undefined;
          const showExplanation = (!graded || !a.correct) && q.explanation;
          return (
            <li
              key={a.question_id}
              className="border bg-[var(--ls-bg)]"
              style={{
                padding: '12px 14px',
                borderRadius: '8px',
                borderColor: graded ? (a.correct ? 'var(--ls-corroborated)' : 'var(--ls-risk)') : 'var(--ls-border)',
              }}
            >
              <div className="flex items-baseline justify-between flex-wrap" style={{ gap: '8px', marginBottom: '6px' }}>
                <span className="text-[11px] font-medium leading-4 tracking-[0.04em] uppercase text-[var(--ls-text-tertiary)]">
                  {graded ? (a.correct ? t('quiz.sim.correct') : t('quiz.sim.incorrect')) : t('quiz.sim.selfCheck')}
                </span>
              </div>
              <p className="text-[13px] leading-[20px]" style={{ marginBottom: '8px' }}>
                {q.stem}
              </p>
              <p className="text-[12px] leading-[18px] text-[var(--ls-text-tertiary)]">
                {t('quiz.sim.yourAnswer')}: {a.answer || '—'}
              </p>
              <p className="text-[12px] leading-[18px] text-[var(--ls-text-tertiary)]">
                {t('quiz.sim.referenceAnswer')}: {q.reference_answer}
              </p>
              {showExplanation && (
                <p className="text-[12px] leading-[18px] text-[var(--ls-text-secondary)]" style={{ marginTop: '6px' }}>
                  {q.explanation}
                </p>
              )}
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap" style={{ gap: '10px' }}>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center border border-[var(--ls-border-strong)] text-[var(--ls-text)] font-medium hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)]"
          style={{ height: '34px', padding: '0 14px', borderRadius: '6px', fontSize: '13px', lineHeight: '1' }}
        >
          {t('quiz.sim.retry')}
        </button>
        <button
          type="button"
          onClick={onExit}
          className="inline-flex items-center bg-[var(--ls-text)] text-[var(--ls-bg)] font-medium hover:opacity-90 transition-opacity duration-[var(--ls-duration-fast)]"
          style={{ height: '34px', padding: '0 14px', borderRadius: '6px', fontSize: '13px', lineHeight: '1' }}
        >
          {t('quiz.sim.backToQuizzes')}
        </button>
      </div>
    </section>
  );
}

/* ============================== REAL (Past papers) ======================= */

const QUIZ_SOURCE_LABEL_KEY: Record<string, DictKey> = {
  distribution: 'quiz.real.source.distribution',
  user_import: 'quiz.real.source.userImport',
};

function RealQuizTab() {
  const { t } = useT();
  const repo = useRepository();
  const [selectedBank, setSelectedBank] = useState<QuestionBankId | null>(null);

  const banksQ = useQuery({
    queryKey: ['question-banks'],
    queryFn: () => (repo ? repo.getQuestionBanks() : Promise.resolve([])),
    enabled: !!repo,
  });

  const banks = banksQ.data ?? [];

  if (selectedBank) {
    return (
      <BankRunner
        bankId={selectedBank}
        onExit={() => setSelectedBank(null)}
      />
    );
  }

  return (
    <div>
      <p
        className="text-[13px] leading-[20px] text-[var(--ls-text-secondary)]"
        style={{ marginBottom: '16px' }}
      >
        {t('quiz.real.intro')}
      </p>

      {banks.length === 0 ? (
        <div
          className="border border-dashed border-[var(--ls-border)] text-center text-[13px] text-[var(--ls-text-tertiary)]"
          style={{ padding: '36px', borderRadius: '10px' }}
        >
          {t('quiz.real.noBanksLoaded')}
        </div>
      ) : (
        <ul className="flex flex-col" style={{ gap: '10px' }}>
          {banks.map((b) => (
            <li key={b.id}>
              <button
                type="button"
                onClick={() => setSelectedBank(b.id)}
                disabled={b.questions_count === 0}
                className="w-full text-left border border-[var(--ls-border)] bg-[var(--ls-bg)] hover:bg-[var(--ls-panel)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-[var(--ls-duration-fast)]"
                style={{ padding: '14px 16px', borderRadius: '8px' }}
              >
                <div className="flex items-baseline justify-between flex-wrap" style={{ gap: '8px' }}>
                  <span className="font-semibold text-[14px] leading-5">
                    {b.exam}
                    {b.year && ` · ${b.year}`}
                  </span>
                  <span className="text-[11px] leading-4 text-[var(--ls-text-tertiary)] tabular-nums">
                    {b.questions_count}{t('quiz.real.questionsCountSuffix')} · {b.language.toUpperCase()} · {t(QUIZ_SOURCE_LABEL_KEY[b.source] ?? 'quiz.real.source.distribution')}
                  </span>
                </div>
                {b.description && (
                  <p className="text-[12px] leading-[18px] text-[var(--ls-text-secondary)]" style={{ marginTop: '6px' }}>
                    {b.description}
                  </p>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div
        className="border border-dashed border-[var(--ls-border-strong)] bg-[var(--ls-bg-subtle)]"
        style={{ marginTop: '18px', padding: '20px 22px', borderRadius: '10px' }}
      >
        <div className="text-[11px] font-medium leading-4 tracking-[0.05em] uppercase text-[var(--ls-text-tertiary)]" style={{ marginBottom: '8px' }}>
          {t('quiz.real.importOwnBank')}
        </div>
        <p className="text-[13px] leading-[20px] text-[var(--ls-text-secondary)]" style={{ marginBottom: '14px' }}>
          {t('quiz.real.importHintPrefix')}<code className="bg-[var(--ls-panel)] px-1 py-0.5 rounded text-[12px]">{'<learn-shell>/quizzes/'}</code>{t('quiz.real.importHintSuffix')}
        </p>
        <button
          type="button"
          disabled
          className="inline-flex items-center border border-[var(--ls-border-strong)] text-[var(--ls-text-tertiary)] font-medium cursor-not-allowed opacity-60"
          style={{ height: '34px', padding: '0 14px', borderRadius: '6px', fontSize: '12px', lineHeight: '1' }}
        >
          {t('quiz.real.importJsonButton')}
        </button>
      </div>
    </div>
  );
}

// 真题判分案: 真题线判分——single_choice 沿用既有的整串字母比对；multi_choice
// 新增，按逗号分隔的字母集合比对（集合而非顺序，答案里字母出现顺序不该影响判
// 分）。真题线的答案本来就编码成字母（见下方 letter = String.fromCharCode(65+i)
// 那一套，reference_answer 也存 'B'/'C' 这样的字母而非选项原文——见
// packages/contracts/src/quiz.ts 旁的 fixture），字母永远不含逗号，不需要模拟
// 线那种 '||' 分隔符规避英文选项里的逗号（竖线分隔约定 的顾虑）。三处判分口径
// （提交判分 / 本地 correctCount / 结果页逐题回顾）共用这一个函数，避免各写各
// 的、口径漂移。
function isBankAnswerCorrect(q: QuizQuestion, answer: string): boolean {
  const given = answer.trim();
  const ref = q.reference_answer.trim();
  if (q.question_type === 'multi_choice') {
    const givenSet = new Set(
      given
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    );
    const refSet = new Set(
      ref
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    );
    if (givenSet.size === 0 || givenSet.size !== refSet.size) return false;
    for (const g of givenSet) {
      if (!refSet.has(g)) return false;
    }
    return true;
  }
  return given === ref;
}

function BankRunner({ bankId, onExit }: { bankId: QuestionBankId; onExit: () => void }) {
  const { t } = useT();
  const repo = useRepository();
  const { learnerId } = usePair();
  const qc = useQueryClient();

  const banksQ = useQuery({
    queryKey: ['question-banks'],
    queryFn: () => (repo ? repo.getQuestionBanks() : Promise.resolve([])),
    enabled: !!repo,
  });
  const bank = banksQ.data?.find((b) => b.id === bankId);

  const qsQ = useQuery({
    queryKey: ['quiz-questions', bankId],
    queryFn: () => (repo ? repo.getQuizQuestions(bankId) : Promise.resolve([])),
    enabled: !!repo,
  });
  const questions = qsQ.data ?? [];

  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);
  // 考试键盘快捷键：↑/↓ 在当前题的选项间移动的"键盘游标"。
  const [cursorIdx, setCursorIdx] = useState(0);
  const submitBtnRef = useRef<HTMLButtonElement>(null);

  const submitMut = useMutation({
    mutationFn: () => {
      if (!repo || !learnerId) throw new Error('no repo');
      const checked = questions.map((q) => ({
        question_id: q.id,
        answer: answers[q.id] ?? '',
        correct: isBankAnswerCorrect(q, answers[q.id] ?? ''),
      }));
      return repo.submitQuizAttempt({
        learner_id: learnerId,
        bank_id: bankId,
        answers: checked,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['quiz-attempts'] });
      setDone(true);
    },
  });

  const cur = questions[idx];
  const total = questions.length;
  const correctCount = useMemo(() => {
    if (!done) return 0;
    return questions.filter((q) => isBankAnswerCorrect(q, answers[q.id] ?? '')).length;
  }, [done, questions, answers]);

  // 真题判分案: multi_choice 现在也渲染成选项按钮了（此前 single_choice 独占，
  // multi_choice 落进既无按钮也无输入框的空态——见报告）。
  const isMultiBank = cur?.question_type === 'multi_choice';
  const hasChoices =
    (cur?.question_type === 'single_choice' || cur?.question_type === 'multi_choice') &&
    Array.isArray(cur?.choices) &&
    cur!.choices!.length > 0;

  // 真题判分案: multi_choice 的答案编码为逗号分隔、按字母排序的字母集合（'A,C'）
  // ——toggle 而非整串覆盖，勾选语义抄模拟卷流的 toggleChoice（同文件
  // SimulatedQuizRunner），只是把"选项原文"换成这里既有的"字母"编码。
  const selectedLetters = useMemo(
    () =>
      new Set(
        (cur ? (answers[cur.id] ?? '') : '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      ),
    [answers, cur]
  );

  const toggleBankChoice = useCallback(
    (letter: string) => {
      if (!cur) return;
      setAnswers((a) => {
        const set = new Set(
          (a[cur.id] ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        );
        if (set.has(letter)) set.delete(letter);
        else set.add(letter);
        return { ...a, [cur.id]: [...set].sort().join(',') };
      });
    },
    [cur]
  );

  // 切题时游标重置到已选项对应的字母下标（多选取答案里排序后第一个字母），否
  // 则回到第一项。
  useEffect(() => {
    if (!cur || !hasChoices) {
      setCursorIdx(0);
      return;
    }
    const ans = answers[cur.id];
    const found = ans ? ans.charCodeAt(0) - 65 : -1;
    setCursorIdx(found >= 0 && found < cur.choices!.length ? found : 0);
    // 仅在切题时重置。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur?.id]);

  // 考试键盘快捷键：↑/↓ 移动游标（到边不循环），Space 切换多选勾选，Enter 选
  // 中游标项（单选）/确认（多选）并跳题/落到交卷按钮，←/→ 自由换题。结果页
  // （done）不挂这个监听。真题线没有置信度环节（见报告），Enter 恒定一键跳题
  // ——不套置信度快捷键案 那套两段式状态机，那套只在 SimulatedQuizRunner 里。
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (done) return;
      if (isTypingTarget(e.target)) return;
      if (!cur) return;

      if (e.key === 'ArrowLeft') {
        if (idx > 0) {
          e.preventDefault();
          setIdx((i) => i - 1);
        }
        return;
      }
      if (e.key === 'ArrowRight') {
        if (idx < total - 1) {
          e.preventDefault();
          setIdx((i) => i + 1);
        }
        return;
      }
      if (!hasChoices) return;

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCursorIdx((c) => Math.max(0, c - 1));
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCursorIdx((c) => Math.min(cur.choices!.length - 1, c + 1));
        return;
      }
      if (e.key === ' ' && isMultiBank) {
        e.preventDefault();
        const letter = String.fromCharCode(65 + cursorIdx);
        toggleBankChoice(letter);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!isMultiBank) {
          const letter = String.fromCharCode(65 + cursorIdx);
          setAnswers((a) => ({ ...a, [cur.id]: letter }));
        }
        // 多选：勾选已经由 Space 完成，Enter 只负责确认+跳题。
        if (idx < total - 1) {
          setIdx((i) => i + 1);
        } else {
          requestAnimationFrame(() => submitBtnRef.current?.focus());
        }
        return;
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [done, cur, idx, total, hasChoices, cursorIdx, isMultiBank, toggleBankChoice]);

  if (!bank || questions.length === 0) {
    return (
      <div>
        <button
          type="button"
          onClick={onExit}
          className="text-[12px] hover:underline"
          style={{ color: 'var(--ls-structure)', marginBottom: '12px' }}
        >
          {t('quiz.real.backToBanksLink')}
        </button>
        <p className="text-[13px] text-[var(--ls-text-tertiary)]">{t('quiz.real.loadingBank')}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between flex-wrap" style={{ gap: '8px', marginBottom: '18px' }}>
        <button
          type="button"
          onClick={onExit}
          className="text-[12px] hover:underline"
          style={{ color: 'var(--ls-structure)' }}
        >
          {t('quiz.real.backToBanksLink')}
        </button>
        <span className="text-[11px] leading-4 text-[var(--ls-text-tertiary)]">
          {bank.exam}
          {bank.year && ` · ${bank.year}`}
        </span>
      </div>

      {!done && cur && (
        <section
          className="border border-[var(--ls-border-strong)] bg-[var(--ls-bg)]"
          style={{ padding: '26px 28px', borderRadius: '10px' }}
        >
          <div className="flex items-center justify-between flex-wrap" style={{ gap: '12px', marginBottom: '14px' }}>
            <span className="text-[11px] font-medium leading-4 tracking-[0.05em] uppercase text-[var(--ls-text-tertiary)]">
              {t('quiz.real.questionPrefix')}{idx + 1}{t('quiz.real.questionMid')}{total}
            </span>
            <span
              className="inline-flex items-center"
              style={{
                padding: '2px 8px',
                border: '1px solid var(--ls-border)',
                borderRadius: '999px',
                fontSize: '10px',
                lineHeight: '14px',
                color: 'var(--ls-text-tertiary)',
                gap: '6px',
              }}
            >
              {t('quiz.real.difficultyPrefix')}{cur.difficulty}
            </span>
          </div>
          <p
            className="font-semibold text-[16px] leading-[24px]"
            style={{ marginBottom: isMultiBank ? '6px' : '16px' }}
          >
            {cur.stem}
          </p>
          {isMultiBank && (
            <p className="text-[11px] text-[var(--ls-text-tertiary)]" style={{ marginBottom: '10px' }}>
              {t('quiz.real.multiHint')}
            </p>
          )}

          {hasChoices && cur.choices && (
            <div className="flex flex-col" style={{ gap: '8px', marginBottom: '20px' }}>
              {cur.choices.map((choice, i) => {
                const letter = String.fromCharCode(65 + i);
                const selected = isMultiBank ? selectedLetters.has(letter) : answers[cur.id] === letter;
                const isCursor = i === cursorIdx;
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => {
                      setCursorIdx(i);
                      if (isMultiBank) toggleBankChoice(letter);
                      else setAnswers((a) => ({ ...a, [cur.id]: letter }));
                    }}
                    className="text-left transition-colors duration-[var(--ls-duration-fast)]"
                    style={{
                      padding: '10px 14px',
                      borderRadius: '8px',
                      border: `1px solid ${selected ? 'var(--ls-text)' : 'var(--ls-border)'}`,
                      background: selected ? 'var(--ls-panel)' : 'var(--ls-bg)',
                      color: 'var(--ls-text)',
                      fontSize: '13px',
                      lineHeight: '20px',
                      boxShadow: isCursor ? 'inset 0 0 0 1px var(--ls-border-strong)' : 'none',
                    }}
                  >
                    <span className="font-medium" style={{ marginRight: '8px' }}>{letter}.</span>
                    {choice}
                  </button>
                );
              })}
            </div>
          )}

          {(cur.question_type === 'short_answer' || cur.question_type === 'essay') && (
            <textarea
              value={answers[cur.id] ?? ''}
              onChange={(e) => setAnswers((a) => ({ ...a, [cur.id]: e.target.value }))}
              rows={cur.question_type === 'essay' ? 6 : 3}
              placeholder={t('quiz.real.answerPlaceholder')}
              className="w-full border border-[var(--ls-border)] bg-[var(--ls-bg)] text-[var(--ls-text)] text-[14px] leading-6 focus:outline-none focus:border-[var(--ls-border-strong)] resize-y"
              style={{ padding: '10px 12px', borderRadius: '6px', marginBottom: '16px' }}
            />
          )}

          <div className="flex flex-wrap" style={{ gap: '10px' }}>
            {idx > 0 && (
              <button
                type="button"
                onClick={() => setIdx((i) => i - 1)}
                className="inline-flex items-center border border-[var(--ls-border)] text-[var(--ls-text-secondary)] font-medium hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)]"
                style={{ height: '34px', padding: '0 14px', borderRadius: '6px', fontSize: '12px', lineHeight: '1' }}
              >
                {t('quiz.sim.previous')}
              </button>
            )}
            {idx < total - 1 ? (
              <button
                type="button"
                onClick={() => setIdx((i) => i + 1)}
                disabled={!answers[cur.id]}
                className="ml-auto inline-flex items-center border border-[var(--ls-border-strong)] text-[var(--ls-text)] font-medium hover:bg-[var(--ls-panel)] disabled:opacity-40 transition-colors duration-[var(--ls-duration-fast)]"
                style={{ height: '34px', padding: '0 14px', borderRadius: '6px', fontSize: '13px', lineHeight: '1' }}
              >
                {t('quiz.sim.next')}
              </button>
            ) : (
              <button
                ref={submitBtnRef}
                type="button"
                onClick={() => submitMut.mutate()}
                disabled={Object.keys(answers).length < total || submitMut.isPending}
                className="ml-auto inline-flex items-center bg-[var(--ls-text)] text-[var(--ls-bg)] font-medium hover:opacity-90 disabled:opacity-40 transition-opacity duration-[var(--ls-duration-fast)]"
                style={{ height: '34px', padding: '0 14px', borderRadius: '6px', fontSize: '13px', lineHeight: '1' }}
              >
                {t('quiz.sim.submitAll')}
              </button>
            )}
          </div>
        </section>
      )}

      {done && (
        <ScoreScreen
          bank={bank}
          questions={questions}
          answers={answers}
          correctCount={correctCount}
          onRestart={() => {
            setAnswers({});
            setIdx(0);
            setDone(false);
          }}
          onExit={onExit}
        />
      )}

      {!done && cur && <QuizHotkeyLegend showConfidence={false} />}
    </div>
  );
}

function ScoreScreen({
  bank,
  questions,
  answers,
  correctCount,
  onRestart,
  onExit,
}: {
  bank: QuestionBank;
  questions: QuizQuestion[];
  answers: Record<string, string>;
  correctCount: number;
  onRestart: () => void;
  onExit: () => void;
}) {
  const { t } = useT();
  const pct = questions.length > 0 ? (correctCount / questions.length) * 100 : 0;
  return (
    <section
      className="border border-[var(--ls-border-strong)] bg-[var(--ls-bg)]"
      style={{ padding: '32px', borderRadius: '10px' }}
    >
      <div className="font-semibold text-[18px] leading-[26px]" style={{ marginBottom: '6px' }}>
        {bank.exam}{t('quiz.real.roundCompleteSuffix')}
      </div>
      <p className="text-[13px] leading-5 text-[var(--ls-text-secondary)]" style={{ marginBottom: '22px' }}>
        {correctCount} / {questions.length}{t('quiz.real.correctSuffix')}
        <span className="tabular-nums">{pct.toFixed(0)}%</span>
      </p>

      <ul className="flex flex-col" style={{ gap: '10px', marginBottom: '22px' }}>
        {questions.map((q, i) => {
          const ans = (answers[q.id] ?? '').trim();
          const correct = isBankAnswerCorrect(q, ans);
          return (
            <li
              key={q.id}
              className="border bg-[var(--ls-bg)]"
              style={{
                padding: '10px 14px',
                borderRadius: '8px',
                borderColor: correct ? 'var(--ls-corroborated)' : 'var(--ls-risk)',
              }}
            >
              <div className="flex items-baseline justify-between flex-wrap" style={{ gap: '8px', marginBottom: '4px' }}>
                <span className="text-[11px] font-medium leading-4 tracking-[0.04em] uppercase text-[var(--ls-text-tertiary)]">
                  Q{i + 1} · {correct ? t('quiz.sim.correct') : t('quiz.sim.incorrect')}
                </span>
                <span className="text-[11px] leading-4 text-[var(--ls-text-tertiary)]">{t('quiz.real.yourPrefix')}{ans || '—'}{t('quiz.real.refPrefix')}{q.reference_answer}</span>
              </div>
              {!correct && q.explanation && (
                <p className="text-[12px] leading-[18px] text-[var(--ls-text-secondary)]">{q.explanation}</p>
              )}
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap" style={{ gap: '10px' }}>
        <button
          type="button"
          onClick={onRestart}
          className="inline-flex items-center border border-[var(--ls-border-strong)] text-[var(--ls-text)] font-medium hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)]"
          style={{ height: '34px', padding: '0 14px', borderRadius: '6px', fontSize: '13px', lineHeight: '1' }}
        >
          {t('quiz.sim.retry')}
        </button>
        <button
          type="button"
          onClick={onExit}
          className="inline-flex items-center bg-[var(--ls-text)] text-[var(--ls-bg)] font-medium hover:opacity-90 transition-opacity duration-[var(--ls-duration-fast)]"
          style={{ height: '34px', padding: '0 14px', borderRadius: '6px', fontSize: '13px', lineHeight: '1' }}
        >
          {t('quiz.real.backToBanksButton')}
        </button>
      </div>
    </section>
  );
}
