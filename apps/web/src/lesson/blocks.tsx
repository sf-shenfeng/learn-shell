// Interactive lesson block components — docs/LESSON-BLOCKS-v1.md §2.
//
// Each component receives `datafields` (JSON-encoded LsBlockField[]) from
// remarkLsBlocks, or markdown children for prose blocks (callout).
// Visual language: --ls-* tokens only; the design system lives here, not
// in lesson content.
//
// `data-ls-block` (batch B, 交付物 5):
// a stable marker on ConceptFlip/FormulaPanel/TrialBlock/CfaNote's root
// containers — annotation/anchor.ts's EXCLUDED_SELECTOR uses it to decline
// the *whole* block from text-selection anchoring, closing the gap where
// prose inside these blocks (a formula's intuition line, a trial's
// question text, …) could still be highlighted even though it isn't a
// real form control. Callout and UnknownBlock are deliberately left
// unmarked — they're plain content passthrough (no structured fields, no
// interactive affordance), so their text stays highlightable like any
// other paragraph.

import { useMemo, useState, type ReactNode } from 'react';
import type { LsBlockField } from './remarkLsBlocks';
import { useLessonContext } from './LessonContext';
import { useTrialState } from './trialStore';
import { parseExpectedItems, judgeTrial, judgeCloze } from './judge';
import { useRepository } from '../repository';
import { usePair } from '../shell/PairProvider';
import { useT } from '../i18n';
import type { DictKey } from '../i18n/dict';
import { FlipCard, usePrefersReducedMotion } from '../shell/FlipCard';
import type { LessonId, TrialVerdict } from '@learn-shell/contracts';

type BlockProps = Record<string, unknown>;

/** remarkLsBlocks emits hProperties.dataFields; React receives it as the
 *  'data-fields' prop (property-information normalization). */
function useFields(props: BlockProps): LsBlockField[] {
  const raw = props['data-fields'];
  return useMemo(() => {
    if (typeof raw !== 'string' || !raw) return [];
    try {
      return JSON.parse(raw) as LsBlockField[];
    } catch {
      return [];
    }
  }, [raw]);
}

function pick(fields: LsBlockField[], prefix: string): LsBlockField | undefined {
  const p = prefix.toLowerCase();
  return fields.find((f) => f.label.toLowerCase().startsWith(p));
}

const LABEL_CLS =
  'text-[10px] uppercase tracking-[0.08em] font-medium text-[var(--ls-text-tertiary)]';

/* --------------------------- fields-unparsed fallback --------------------- */

// 真机案 2026-07(裸 `Question:` 事故): 字段块解析后零字段命中——
// 常见诱因是作者没把字段标签加粗(`Question:` 而非 `**Question**:`),
// extractFields() 静默拿不到任何字段。以前这种情况会让 ConceptFlip/
// FormulaPanel/TrialBlock/CfaNote 落进"全部字段皆 undefined"的分支,渲染出
// 一个学习者摸不着头脑的空交互(空输入框/空翻卡)。现在改为一个低调的虚线提
// 示框, 复用 UnknownBlock 的视觉语气——不装作这是一个正常习题。合法块(字段
// 数 >0)不会走到这个分支, 渲染路径一个像素不变。
function FieldsUnparsedBlock() {
  const { t } = useT();
  return (
    <div
      className="border border-dashed border-[var(--ls-border)]"
      style={{ borderRadius: '10px', padding: '14px 16px', marginTop: '18px' }}
    >
      <div className={LABEL_CLS}>{t('lesson.block.fieldsUnparsedPrefix')}</div>
      <div className="text-[13px] leading-[21px] text-[var(--ls-text-secondary)]" style={{ marginTop: '6px' }}>
        {t('lesson.block.fieldsUnparsedHint')}
      </div>
    </div>
  );
}

/* ------------------------------ concept-flip ----------------------------- */

export function ConceptFlip(props: BlockProps) {
  const { t } = useT();
  const fields = useFields(props);
  const [flipped, setFlipped] = useState(false);
  const reduceMotion = usePrefersReducedMotion();
  // 零字段命中的兜底检查放在全部 hook 调用之后——Rules of Hooks 不许在这之前
  // return（否则 flipped/reduceMotion 这两个 hook 会在某些渲染里被跳过）。
  if (fields.length === 0) return <FieldsUnparsedBlock />;
  const front = pick(fields, 'front')?.value ?? '';
  const back = pick(fields, 'back')?.value ?? '';
  const definition = pick(fields, 'definition')?.value ?? '';

  return (
    <button
      type="button"
      data-ls-block="concept-flip"
      onClick={() => setFlipped((f) => !f)}
      className="block w-full text-left border bg-[var(--ls-bg)] hover:border-[var(--ls-border-strong)] transition-colors duration-[var(--ls-duration-fast)]"
      style={{
        borderColor: flipped ? 'var(--ls-border-strong)' : 'var(--ls-border)',
        borderRadius: '10px',
        padding: '20px 22px',
        marginTop: '18px',
      }}
    >
      {/* 翻面组件抽取 — same real rotateY flip dialect as Review's flashcards
          (shell/FlipCard.tsx). The eyebrow row rides along with the
          content since here it's one small face turning over, not a
          static header above a bigger card (Review's question stem). */}
      <FlipCard
        flipKey="concept-flip"
        showBack={flipped}
        reduceMotion={reduceMotion}
        front={
          <>
            <div className="flex items-center justify-between" style={{ marginBottom: '10px' }}>
              <span className={LABEL_CLS}>{t('lesson.block.termCn')}</span>
              <span className="text-[10px] text-[var(--ls-text-tertiary)]">{t('lesson.block.tapToFlip')}</span>
            </div>
            <div className="font-semibold text-[18px] leading-[26px] text-[var(--ls-text)]">
              {front}
            </div>
          </>
        }
        back={
          <>
            <div className="flex items-center justify-between" style={{ marginBottom: '10px' }}>
              <span className={LABEL_CLS}>{t('lesson.block.termEn')}</span>
              <span className="text-[10px] text-[var(--ls-text-tertiary)]">{t('lesson.block.flipBack')}</span>
            </div>
            <div className="flex flex-col" style={{ gap: '8px' }}>
              <div className="font-semibold text-[17px] leading-[25px] text-[var(--ls-text)]">
                {back}
              </div>
              {definition && (
                <div className="text-[13px] leading-[21px] text-[var(--ls-text-secondary)]">
                  {definition}
                </div>
              )}
            </div>
          </>
        }
      />
    </button>
  );
}

/* -------------------------------- formula -------------------------------- */

export function FormulaPanel(props: BlockProps) {
  const { t } = useT();
  const fields = useFields(props);
  if (fields.length === 0) return <FieldsUnparsedBlock />;
  const rule = pick(fields, 'rule');
  const intuition = pick(fields, 'intuition');
  const notation = pick(fields, 'notation');

  return (
    <div
      data-ls-block="formula"
      className="border border-[var(--ls-border)] bg-[var(--ls-bg-subtle)]"
      style={{ borderRadius: '10px', padding: '18px 20px', marginTop: '18px' }}
    >
      <div className={LABEL_CLS} style={{ color: 'var(--ls-structure)' }}>
        {t('lesson.block.formula')}
      </div>
      {rule && (
        <div
          className="font-mono text-[14px] leading-[24px] text-[var(--ls-text)]"
          style={{ marginTop: '10px', whiteSpace: 'pre-wrap' }}
        >
          {rule.value}
        </div>
      )}
      {intuition && (
        <div
          className="text-[13px] leading-[21px] text-[var(--ls-text-secondary)]"
          style={{ marginTop: '10px' }}
        >
          {intuition.value}
        </div>
      )}
      {notation?.items && notation.items.length > 0 && (
        <div
          className="border-t border-[var(--ls-border)]"
          style={{ marginTop: '12px', paddingTop: '10px' }}
        >
          {notation.items.map((item) => (
            <div
              key={item}
              className="font-mono text-[11px] leading-[18px] text-[var(--ls-text-tertiary)]"
            >
              {item}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* --------------------------------- trial --------------------------------- */

// Options/Cloze (docs/LESSON-BLOCKS-v1.md §2.3, 2026-07-12): item lists in
// these two fields use either ASCII `|` or the fullwidth `｜` as separator
// (the spec example uses fullwidth — CJK authors reach for it naturally).
const PIPE_RE = /[|｜]/;

function splitPipeList(raw: string): string[] {
  return raw
    .split(PIPE_RE)
    .map((s) => s.trim())
    .filter(Boolean);
}

// A Cloze blank is 4+ consecutive underscores. Splitting on a capturing
// group keeps the blanks in the output at odd indices, text at even.
const BLANK_RE = /(_{4,})/;

function parseClozeDraft(draft: string, blankCount: number): string[] {
  if (draft) {
    try {
      const parsed = JSON.parse(draft);
      if (Array.isArray(parsed)) {
        return Array.from({ length: blankCount }, (_, i) => parsed[i] ?? '');
      }
    } catch {
      // fall through to empty blanks — e.g. draft left over from a
      // free-form/choice trial at the same index before a content edit.
    }
  }
  return Array(blankCount).fill('');
}

export function TrialBlock(props: BlockProps) {
  const { t } = useT();
  const fields = useFields(props);
  const question = pick(fields, 'question')?.value ?? '';
  const hint = pick(fields, 'hint')?.value ?? '';
  const answer = pick(fields, 'answer')?.value ?? '';
  const expectedRaw = pick(fields, 'expected')?.value ?? '';
  const hasExpected = expectedRaw.trim().length > 0;
  // parseExpectedItems (not parseExpected): the judge needs the precision
  // each Expected entry was AUTHORED with — `1.00` claims ±0.005 where `1`
  // claims ±0.5 — and that trailing zero is gone the moment it becomes a
  // plain number.
  const expectedItems = useMemo(
    () => (hasExpected ? parseExpectedItems(expectedRaw) : []),
    [hasExpected, expectedRaw]
  );

  // Options → choice trial (§2.3, 2026-07-12): present only when the field
  // is non-empty; absent entirely, rendering is untouched (spec's "一个像素
  // 不变" for the free-form path).
  const optionsRaw = pick(fields, 'options')?.value ?? '';
  const options = useMemo(
    () => (optionsRaw.trim() ? splitPipeList(optionsRaw) : []),
    [optionsRaw]
  );
  const hasOptions = options.length > 0;

  // Cloze → fill-in-blank trial (§2.3, 2026-07-12).
  const isCloze = (pick(fields, 'cloze')?.value ?? '').trim().toLowerCase() === 'true';
  const questionParts = useMemo(
    () => (isCloze ? question.split(BLANK_RE) : [question]),
    [isCloze, question]
  );
  const blankCount = isCloze ? questionParts.filter((_, i) => i % 2 === 1).length : 0;
  const answerParts = useMemo(() => splitPipeList(answer), [answer]);

  const { lessonId } = useLessonContext();
  // remarkLsBlocks attaches this via hProperties.dataTrialIndex — same
  // dataX→data-x normalization as data-fields (see useFields above).
  const rawTrialIndex = props['data-trial-index'];
  const trialIndex =
    typeof rawTrialIndex === 'number' || typeof rawTrialIndex === 'string'
      ? Number(rawTrialIndex)
      : 0;

  const [state, setState] = useTrialState(lessonId, trialIndex);
  const { draft, showHint, revealed, verdict, attempts, inputError } = state;
  const blanks = useMemo(
    () => (isCloze ? parseClozeDraft(draft, blankCount) : []),
    [isCloze, draft, blankCount]
  );

  const repo = useRepository();
  const { pairId } = usePair();

  // 零字段命中的兜底检查放在全部 hook 调用之后（同 ConceptFlip 注释）——此
  // 时 fields.length === 0 意味着 Question/Answer/Options 等全部拿不到值,
  // 上面几个 useMemo 算出的都是空派生态, 没有提前 return 的必要, 只是不能
  // 提前到 hook 调用中间。
  if (fields.length === 0) return <FieldsUnparsedBlock />;

  // 空输入守卫: 空稿点 Check answer 时, judgeTrial('', expected) 在 expected
  // 非空时数学上恒返回 mismatchAt:1 ([].slice(-N)[0] 恒为 undefined) —— 跟
  // Expected 内容无关, 就是"没写就查"这一步不该进判定引擎。isEmptyDraft 同时
  // 覆盖 Cloze (逐空判断) 和自由文本 (整体 trim) 两条路径, 在 handleCheck 里
  // 短路掉 judge 调用与 trial.attempted 记录 (什么都没答不算一次尝试), 只留
  // 呈现: 框红 + 掀答案。
  const isEmptyDraft = isCloze
    ? blanks.every((b) => !b.trim())
    : draft.trim().length === 0;

  const recordAttempt = (recordedDraft: string, verdictLabel: TrialVerdict, nextAttempts: number) => {
    if (repo && pairId && lessonId) {
      repo
        .recordTrialAttempt({
          pair_id: pairId,
          lesson_id: lessonId as LessonId,
          trial_index: trialIndex,
          verdict: verdictLabel,
          attempts: nextAttempts,
          draft: recordedDraft,
        })
        .catch((e) => console.error('[trial.attempted]', e));
    }
  };

  const handleCheck = () => {
    if (isEmptyDraft) {
      setState({ inputError: true, revealed: true });
      return;
    }
    const nextAttempts = attempts + 1;
    const nextVerdict = isCloze
      ? judgeCloze(blanks, answerParts)
      : hasExpected
        ? judgeTrial(draft, expectedItems)
        : null;
    const verdictLabel = nextVerdict ? nextVerdict.verdict : 'self_check';

    setState({
      attempts: nextAttempts,
      verdict: verdictLabel,
      mismatchAt: nextVerdict ? nextVerdict.mismatchAt : null,
      // 2026-07-30 裁决: 对错都掀 Answer。答错不再出"第 N 项不符"红字, 改成
      // 作答框标红 + 直接给正确答案 (spec §2.3)。
      revealed: true,
      inputError: verdictLabel === 'incorrect',
    });

    recordAttempt(draft, verdictLabel, nextAttempts);
  };

  const handleChoiceClick = (choice: string) => {
    if (revealed) return;
    const nextAttempts = attempts + 1;
    const verdictLabel = choice.trim() === answer.trim() ? 'correct' : 'incorrect';

    setState({
      draft: choice,
      attempts: nextAttempts,
      verdict: verdictLabel,
      mismatchAt: null,
      revealed: verdictLabel === 'correct',
    });

    recordAttempt(choice, verdictLabel, nextAttempts);
  };

  const setBlank = (index: number, value: string) => {
    const next = [...blanks];
    next[index] = value;
    setState({ draft: JSON.stringify(next), inputError: false });
  };

  return (
    <div
      data-ls-block="trial"
      className="border border-[var(--ls-border-strong)] bg-[var(--ls-bg)]"
      style={{ borderRadius: '10px', padding: '20px 22px', marginTop: '18px' }}
    >
      <div className={LABEL_CLS} style={{ color: 'var(--ls-structure)' }}>
        {t('lesson.block.yourTurn')}
      </div>
      {isCloze ? (
        <div
          className="text-[15px] leading-[24px] text-[var(--ls-text)]"
          style={{ marginTop: '10px' }}
        >
          {questionParts.map((part, i) =>
            i % 2 === 1 ? (
              <input
                key={i}
                type="text"
                value={blanks[(i - 1) / 2] ?? ''}
                onChange={(e) => setBlank((i - 1) / 2, e.target.value)}
                disabled={revealed}
                className={`border-b bg-transparent text-center text-[var(--ls-text)] focus:outline-none disabled:opacity-70 ${
                  inputError ? 'border-[var(--ls-risk)]' : 'border-[var(--ls-border-strong)]'
                }`}
                style={{ minWidth: '72px', padding: '0 4px', margin: '0 2px' }}
              />
            ) : (
              <span key={i}>{part}</span>
            )
          )}
        </div>
      ) : (
        <div
          className="text-[15px] leading-[24px] text-[var(--ls-text)]"
          style={{ marginTop: '10px' }}
        >
          {question}
        </div>
      )}

      {hasOptions && (
        <div className="flex flex-col" style={{ gap: '8px', marginTop: '14px' }}>
          {options.map((choice) => {
            const isSelected = draft === choice && verdict !== null;
            const judgedColor = verdict === 'correct' ? 'var(--ls-corroborated)' : 'var(--ls-risk)';
            const semanticColor = isSelected ? judgedColor : 'var(--ls-border)';
            return (
              <button
                key={choice}
                type="button"
                onClick={() => handleChoiceClick(choice)}
                disabled={revealed}
                className="text-left transition-colors duration-[var(--ls-duration-fast)] disabled:cursor-default"
                style={{
                  padding: '10px 14px',
                  borderRadius: '8px',
                  border: `1px solid ${semanticColor}`,
                  background: isSelected ? 'var(--ls-bg-subtle)' : 'var(--ls-bg)',
                  color: isSelected ? judgedColor : 'var(--ls-text)',
                  fontSize: '13px',
                  lineHeight: '20px',
                }}
              >
                {choice}
              </button>
            );
          })}
        </div>
      )}

      {!hasOptions && !isCloze && (
        <textarea
          value={draft}
          onChange={(e) => {
            setState({ draft: e.target.value, inputError: false });
            const el = e.target;
            el.style.height = 'auto';
            el.style.height = Math.min(el.scrollHeight, 320) + 'px';
          }}
          placeholder={t('lesson.block.workItOutPlaceholder')}
          rows={3}
          className={`w-full border bg-[var(--ls-bg)] text-[var(--ls-text)] text-[14px] leading-6 placeholder:text-[var(--ls-text-tertiary)] focus:outline-none resize-y overflow-y-auto ${
            inputError
              ? 'border-[var(--ls-risk)]'
              : 'border-[var(--ls-border)] focus:border-[var(--ls-border-strong)]'
          }`}
          style={{ marginTop: '14px', padding: '10px 12px', borderRadius: '6px', maxHeight: '320px' }}
        />
      )}

      <div className="flex flex-wrap items-center" style={{ marginTop: '10px', gap: '10px' }}>
        {!hasOptions && (
          <button
            type="button"
            onClick={handleCheck}
            disabled={revealed}
            className="inline-flex items-center bg-[var(--ls-text)] text-[var(--ls-bg)] font-medium hover:opacity-90 disabled:opacity-40 transition-opacity duration-[var(--ls-duration-fast)]"
            style={{ height: '30px', padding: '0 14px', borderRadius: '6px', fontSize: '12px', lineHeight: '1' }}
          >
            {t('lesson.block.checkAnswer')}
          </button>
        )}
        {hint && !revealed && (
          <button
            type="button"
            onClick={() => setState({ showHint: !showHint })}
            className="inline-flex items-center border border-[var(--ls-border)] text-[var(--ls-text-secondary)] font-medium hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)]"
            style={{ height: '30px', padding: '0 12px', borderRadius: '6px', fontSize: '12px', lineHeight: '1' }}
          >
            {showHint ? t('lesson.block.hideHint') : t('lesson.block.hint')}
          </button>
        )}
      </div>

      {showHint && !revealed && hint && (
        <div
          className="text-[13px] leading-[21px] text-[var(--ls-text-secondary)] border-l-2"
          style={{
            marginTop: '12px',
            paddingLeft: '12px',
            borderColor: 'var(--ls-hypothesis)',
          }}
        >
          {hint}
        </div>
      )}

      {revealed && (
        <div
          className="border-t border-[var(--ls-border)]"
          style={{ marginTop: '14px', paddingTop: '12px' }}
        >
          <div className={LABEL_CLS} style={{ color: 'var(--ls-corroborated)' }}>
            {t('lesson.block.answer')}
          </div>
          <div
            className="text-[14px] leading-[22px] text-[var(--ls-text)]"
            style={{ marginTop: '6px', whiteSpace: 'pre-wrap' }}
          >
            {answer}
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------------------- callout -------------------------------- */

const CALLOUT_STYLE_KEY: Record<string, { labelKey: DictKey; color: string }> = {
  trap: { labelKey: 'lesson.block.calloutTrap', color: 'var(--ls-risk)' },
  warn: { labelKey: 'lesson.block.calloutWatchOut', color: 'var(--ls-hypothesis)' },
  info: { labelKey: 'lesson.block.calloutNote', color: 'var(--ls-structure)' },
};

export function Callout({ kind, children }: { kind?: string; children?: ReactNode }) {
  const { t } = useT();
  const { labelKey, color } = CALLOUT_STYLE_KEY[kind ?? 'info'] ?? CALLOUT_STYLE_KEY.info!;
  const label = t(labelKey);
  return (
    <div
      className="border-l-2"
      style={{
        borderColor: color,
        paddingLeft: '16px',
        marginTop: '18px',
        paddingTop: '2px',
        paddingBottom: '2px',
      }}
    >
      <div className={LABEL_CLS} style={{ color, marginBottom: '4px' }}>
        {label}
      </div>
      <div className="text-[14px] leading-[23px] text-[var(--ls-text)]">{children}</div>
    </div>
  );
}

/* -------------------------------- cfa-note ------------------------------- */

export function CfaNote(props: BlockProps) {
  const fields = useFields(props);
  if (fields.length === 0) return <FieldsUnparsedBlock />;
  const los = fields.find((f) => f.label.toLowerCase().startsWith('los'));
  const depth = pick(fields, 'depth')?.value ?? '';
  const practice = pick(fields, 'in practice')?.value ?? '';

  return (
    <div
      data-ls-block="cfa-note"
      className="border border-[var(--ls-border)]"
      style={{ borderRadius: '10px', padding: '18px 20px', marginTop: '18px' }}
    >
      <div className="flex items-center justify-between flex-wrap" style={{ gap: '8px' }}>
        <span className="font-mono text-[12px] font-medium text-[var(--ls-text)]">
          {los?.label ?? 'LOS'}
        </span>
        {depth && (
          <span
            className="inline-flex items-center border tracking-[0.04em] uppercase font-medium"
            style={{
              padding: '2px 8px',
              borderRadius: '999px',
              fontSize: '10px',
              lineHeight: '14px',
              borderColor: 'var(--ls-structure)',
              color: 'var(--ls-structure)',
            }}
          >
            {depth}
          </span>
        )}
      </div>
      {los?.value && (
        <div
          className="text-[13px] leading-[21px] text-[var(--ls-text-secondary)] italic"
          style={{ marginTop: '8px' }}
        >
          {los.value}
        </div>
      )}
      {practice && (
        <div
          className="text-[13px] leading-[21px] text-[var(--ls-text)]"
          style={{ marginTop: '10px' }}
        >
          {practice}
        </div>
      )}
    </div>
  );
}

/* -------------------------------- unknown -------------------------------- */

export function UnknownBlock({ name, children }: { name?: string; children?: ReactNode }) {
  const { t } = useT();
  return (
    <div
      className="border border-dashed border-[var(--ls-border)]"
      style={{ borderRadius: '10px', padding: '14px 16px', marginTop: '18px' }}
    >
      <div className={LABEL_CLS}>{t('lesson.block.unregisteredBlockPrefix')}{name ?? '?'}</div>
      <div className="text-[13px] leading-[21px] text-[var(--ls-text-secondary)]" style={{ marginTop: '6px' }}>
        {children}
      </div>
    </div>
  );
}
