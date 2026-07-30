import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useHotkeys } from 'react-hotkeys-hook';
import { Link, useSearchParams } from 'react-router-dom';
import { applyTheme, getStoredTheme, setStoredTheme, type Theme } from '@learn-shell/ui';
import type {
  ContractCadence,
  CourseId,
  LearnerHypothesis,
  Repository,
  TeachingContract,
} from '@learn-shell/contracts';
import { useRepository } from '../repository';
import { usePair } from '../shell/PairProvider';
import { useIdentity, useUpdateIdentity, cleanAgentName } from '../lib/identity';
import { DemoPill, usePairIsDemo } from '../components/DemoPill';
import { API_BASE_URL } from '../lib/apiBase';
import { useT } from '../i18n';
import type { DictKey, Lang } from '../i18n/dict';
import type { ObservationGateRepo } from '../repository/observationGateExt';
import type {
  FeedbackKind,
  FeedbackStatus,
  FeedbackLedgerEntry,
  FeedbackLedgerRepo,
} from '../repository/feedbackLedgerExt';
import type { CalibrationRepo, CalibrationBucket } from '../repository/calibrationExt';
import type { BrierTrendRepo, BrierTrendPoint } from '../repository/brierTrendExt';
import type { ConfidenceAnchorRepo } from '../repository/confidenceAnchorExt';
import {
  CALIBRATION_MIN_SAMPLES,
  CONFIDENCE_LEVELS,
  validateConfidenceAnchors,
  type ConfidenceLevel,
  type ConfidenceAnchorConfig,
} from '../lib/confidence';

/**
 * Settings — top-level page (G ,).
 *
 * 横向 tabs 回归 — horizontal tabs, restored per the original design handoff
 * ("UI design based on documents/" — ARCHITECTURE.md §4 + the Learn Shell
 * design comp): H1, then a flat underline tab strip (same visual language as
 * Quiz.tsx's TabBtn), tabs General / Appearance / Teaching Contract /
 * Learner Model / Data & privacy. The comp predates two changes, so today's
 * sections map into its five groups plus one:
 *   通用       ← Identity (comp's "Pair" card) + Cadence
 *   外观       ← Appearance (theme + language, as in the comp)
 *   教学契约   ← Certificate + archive (contract management became 证书化)
 *   学习者模型 ← Learner Model + Portrait (observation boundary removed, 观察禁区下线案)
 *   反馈       ← feedback ledger (现场反馈笔改革 — new since the comp; same tab idiom)
 *   数据与隐私 ← Data & privacy
 *
 * Tab state lives in ?tab= (app convention — survives refresh/back, same
 * URLSearchParams channel the 证书揭示改版 highlightContract deep-link already uses).
 * Default tab is 通用; an unknown value falls back rather than 404ing.
 *
 * "Learner Model 深埋" is design's call: hypotheses should be visible & correctable
 * but not prominently displayed — it's a trust layer, not a feature. The tab
 * is the burial now — inside it, sections render open.
 */
const SETTINGS_TABS = [
  { id: 'general', labelKey: 'settings.tab.general' },
  { id: 'appearance', labelKey: 'settings.tab.appearance' },
  { id: 'contract', labelKey: 'settings.tab.contract' },
  { id: 'model', labelKey: 'settings.tab.model' },
  { id: 'feedback', labelKey: 'settings.tab.feedback' },
  { id: 'data', labelKey: 'settings.tab.data' },
] as const satisfies readonly { id: string; labelKey: DictKey }[];

type SettingsTab = (typeof SETTINGS_TABS)[number]['id'];

function isSettingsTab(v: string | null): v is SettingsTab {
  return SETTINGS_TABS.some((tab) => tab.id === v);
}

export default function Settings() {
  const { t } = useT();
  const [searchParams, setSearchParams] = useSearchParams();

  const rawTab = searchParams.get('tab');
  // 证书揭示改版 — the certificate-reveal redirect arrives as
  // ?highlightContract=<id> without a tab: land on the tab that actually
  // renders that contract instead of showing 通用 with the highlight buried.
  const tab: SettingsTab = isSettingsTab(rawTab)
    ? rawTab
    : searchParams.get('highlightContract')
      ? 'contract'
      : 'general';

  const selectTab = (next: SettingsTab) => {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      if (next === 'general') p.delete('tab');
      else p.set('tab', next);
      return p;
    });
  };

  // ←/→ cycle the tab strip, wrapping at the ends, through the same
  // setSearchParams path as clicking (横向 tabs 回归 follow-up). Default
  // react-hotkeys-hook behavior already skips input/textarea/select/
  // contenteditable — same idiom as Review.tsx's left/right (左右键翻卡案).
  const tabIndex = SETTINGS_TABS.findIndex((s) => s.id === tab);
  useHotkeys(
    'left',
    () => selectTab(SETTINGS_TABS[(tabIndex - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length]!.id),
    [tabIndex]
  );
  useHotkeys(
    'right',
    () => selectTab(SETTINGS_TABS[(tabIndex + 1) % SETTINGS_TABS.length]!.id),
    [tabIndex]
  );

  return (
    <div>
      <h1
        className="font-bold text-[24px] leading-[32px] tracking-[-0.02em]"
        style={{ margin: 0, marginBottom: '18px' }}
      >
        {t('settings.title')}
      </h1>

      {/* Tab strip — design comp: flex/gap-6px/wrap, hairline bottom border,
          active = 2px underline in --ls-text (identical to Quiz.tsx). */}
      <div
        className="flex flex-wrap border-b border-[var(--ls-border)]"
        style={{ gap: '6px', marginBottom: '28px' }}
      >
        {SETTINGS_TABS.map(({ id, labelKey }) => (
          <SettingsTabBtn key={id} active={tab === id} onClick={() => selectTab(id)}>
            {t(labelKey)}
          </SettingsTabBtn>
        ))}
      </div>

      {/* Pane wrapper exists so Section's `first:` variant can drop the
          leading border-top — the strip's border-bottom already draws that
          rule; without the wrapper the h1/strip are siblings and every
          section would count as non-first. */}
      <div>
        {tab === 'general' && (
          <>
            <IdentitySection />
            <CadenceSection />
          </>
        )}
        {tab === 'appearance' && <AppearanceSection />}
        {tab === 'contract' && <CertificateSection />}
        {tab === 'model' && (
          <>
            <LearnerModelSection />
            <PortraitSection />
          </>
        )}
        {tab === 'feedback' && <FeedbackLedgerSection />}
        {tab === 'data' && <DataPrivacySection />}
      </div>
    </div>
  );
}

function SettingsTabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
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

/* -------------------------------------------------------------------------- */

function AppearanceSection() {
  const { t, lang, setLang } = useT();
  const [theme, setTheme] = useState<Theme>(getStoredTheme());

  useEffect(() => {
    applyTheme(theme);
    setStoredTheme(theme);
  }, [theme]);

  const themeLabel: Record<Theme, string> = {
    system: t('settings.theme.system'),
    light: t('settings.theme.light'),
    dark: t('settings.theme.dark'),
  };

  return (
    <Section title={t('settings.appearance')} subtitle={t('settings.appearance.sub')}>
      {/* Theme */}
      <div className="text-[11px] leading-4 text-[var(--ls-text-tertiary)]" style={{ marginBottom: '8px' }}>
        {t('settings.theme')}
      </div>
      <div className="flex flex-wrap" style={{ gap: '8px', marginBottom: '18px' }}>
        {(['system', 'light', 'dark'] as const).map((opt) => {
          const on = theme === opt;
          return (
            <button
              key={opt}
              onClick={() => setTheme(opt)}
              className="inline-flex items-center font-medium transition-colors duration-[var(--ls-duration-fast)]"
              style={{
                height: '34px',
                padding: '0 16px',
                borderRadius: '6px',
                fontSize: '13px',
                lineHeight: '1',
                border: `1px solid ${on ? 'var(--ls-text)' : 'var(--ls-border)'}`,
                color: on ? 'var(--ls-text)' : 'var(--ls-text-secondary)',
                background: on ? 'var(--ls-panel)' : 'transparent',
              }}
            >
              {themeLabel[opt]}
            </button>
          );
        })}
      </div>

      {/* Language */}
      <div className="text-[11px] leading-4 text-[var(--ls-text-tertiary)]" style={{ marginBottom: '8px' }}>
        {t('settings.language')}
      </div>
      <div className="flex flex-wrap" style={{ gap: '8px' }}>
        {(['zh', 'en'] as const).map((opt) => {
          const on = lang === opt;
          return (
            <button
              key={opt}
              onClick={() => setLang(opt as Lang)}
              className="inline-flex items-center font-medium transition-colors duration-[var(--ls-duration-fast)]"
              style={{
                height: '34px',
                padding: '0 16px',
                borderRadius: '6px',
                fontSize: '13px',
                lineHeight: '1',
                border: `1px solid ${on ? 'var(--ls-text)' : 'var(--ls-border)'}`,
                color: on ? 'var(--ls-text)' : 'var(--ls-text-secondary)',
                background: on ? 'var(--ls-panel)' : 'transparent',
              }}
            >
              {t(`settings.lang.${opt}` as 'settings.lang.zh')}
            </button>
          );
        })}
      </div>
      <p
        className="text-[11px] leading-4 text-[var(--ls-text-tertiary)]"
        style={{ marginTop: '10px' }}
      >
        {t('settings.appearance.langNote')}
      </p>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Identity (称谓体系, 2026-07-07) — how you and your agent are addressed.
 * Plain inputs + one Save button, no inline editing tricks: the tool
 * aesthetic here is 模块化趁手、零炫技, same register as the rest of Settings.
 */
function IdentitySection() {
  const { t } = useT();
  const { identity, isLoading } = useIdentity();
  const updateMut = useUpdateIdentity();
  const qc = useQueryClient();

  const [learnerName, setLearnerName] = useState('');
  const [agentName, setAgentName] = useState('');
  const [agentNote, setAgentNote] = useState('');
  const [seeded, setSeeded] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (identity && !seeded) {
      setLearnerName(identity.learner.display_name);
      setAgentName(identity.agent.display_name);
      setAgentNote(identity.agent.identity_note ?? '');
      setSeeded(true);
    }
  }, [identity, seeded]);

  const validName = (s: string) => {
    const trimmed = s.trim();
    return trimmed.length > 0 && trimmed.length <= 40;
  };
  const canSave = !!identity && validName(learnerName) && validName(agentName) && !updateMut.isPending;

  const handleSave = () => {
    setError(null);
    updateMut.mutate(
      {
        learner_display_name: learnerName.trim(),
        agent_display_name: agentName.trim(),
        agent_identity_note: agentNote.trim(),
      },
      {
        onSuccess: (next) => {
          setLearnerName(next.learner.display_name);
          setAgentName(next.agent.display_name);
          setAgentNote(next.agent.identity_note ?? '');
          setSavedFlash(true);
          window.setTimeout(() => setSavedFlash(false), 1500);
          qc.invalidateQueries({ queryKey: ['journal-agent'] });
          qc.invalidateQueries({ queryKey: ['journal-current-pair'] });
        },
        onError: (e) => setError(e instanceof Error ? e.message : t('settings.identity.saveFailedFallback')),
      }
    );
  };

  return (
    <Section title={t('settings.identity.title')} subtitle={t('settings.identity.subtitle')}>
      {/* DEMO pill (设计单五.1) — pair 身份露脸处 = 这块档案区。pair 不带
          is_demo 时组件自己安静不渲染, 这里不再包判断。不进页眉 (页眉 pill
          标连接模式, 这里标数据身份 — 两层两问)。 */}
      <DemoPillRow />
      {!identity && isLoading && (
        <p className="text-[13px] leading-5 text-[var(--ls-text-tertiary)]">{t('contract.loading')}</p>
      )}
      {!identity && !isLoading && (
        <p className="text-[13px] leading-5 text-[var(--ls-text-tertiary)]">
          {t('settings.identity.needsLiveBackend')}
        </p>
      )}
      {identity && (
        <div className="flex flex-col" style={{ gap: '14px' }}>
          <LabeledField label={t('settings.identity.yourNameLabel')}>
            <input
              type="text"
              value={learnerName}
              onChange={(e) => setLearnerName(e.target.value)}
              maxLength={40}
              className="w-full border border-[var(--ls-border)] bg-[var(--ls-bg)] text-[var(--ls-text)] text-[13px] focus:outline-none focus:border-[var(--ls-border-strong)]"
              style={{ height: '32px', padding: '0 10px', borderRadius: '6px' }}
            />
          </LabeledField>
          <LabeledField label={t('settings.identity.agentNameLabel')}>
            <input
              type="text"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
              maxLength={40}
              className="w-full border border-[var(--ls-border)] bg-[var(--ls-bg)] text-[var(--ls-text)] text-[13px] focus:outline-none focus:border-[var(--ls-border-strong)]"
              style={{ height: '32px', padding: '0 10px', borderRadius: '6px' }}
            />
          </LabeledField>
          <LabeledField label={t('settings.identity.agentNoteLabel')}>
            <textarea
              value={agentNote}
              onChange={(e) => setAgentNote(e.target.value)}
              rows={3}
              className="w-full border border-[var(--ls-border)] bg-[var(--ls-bg)] text-[var(--ls-text)] text-[13px] focus:outline-none focus:border-[var(--ls-border-strong)]"
              style={{ padding: '8px 10px', borderRadius: '6px', resize: 'vertical' }}
            />
          </LabeledField>
          <div className="flex items-center" style={{ gap: '10px' }}>
            <button
              type="button"
              onClick={handleSave}
              disabled={!canSave}
              className="inline-flex items-center border border-[var(--ls-border)] hover:bg-[var(--ls-panel)] disabled:opacity-50 transition-colors duration-[var(--ls-duration-fast)]"
              style={{ height: '30px', padding: '0 14px', borderRadius: '6px', fontSize: '12px' }}
            >
              {updateMut.isPending ? t('settings.identity.saving') : t('settings.identity.saveButton')}
            </button>
            {savedFlash && (
              <span className="text-[11px] text-[var(--ls-text-tertiary)]">{t('settings.identity.savedFlash')}</span>
            )}
            {error && (
              <span className="text-[11px]" style={{ color: 'var(--ls-risk)' }}>
                {error}
              </span>
            )}
          </div>
          <p className="text-[11px] leading-4 text-[var(--ls-text-tertiary)]">
            {t('settings.identity.namesHint')}
          </p>
        </div>
      )}
    </Section>
  );
}

/** DemoPill + 行距包装: pill 自己在非 demo pair 时返回 null, 但那样
 *  会留下一个空 div 的 margin; 这里用 usePairIsDemo 先问一次, 非 demo 整行
 *  不渲染 (零占位)。 */
function DemoPillRow() {
  const isDemo = usePairIsDemo();
  if (!isDemo) return null;
  return (
    <div style={{ marginBottom: '14px' }}>
      <DemoPill />
    </div>
  );
}

function LabeledField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div
        className="text-[11px] leading-4 text-[var(--ls-text-tertiary)]"
        style={{ marginBottom: '6px' }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * CadenceSection — 节奏条款改革: the old RemindersSection is gone (it controlled
 * nothing — LS has no push channel and never dispatched a reminder from that
 * UI; dead surface). What replaced it is the one true fact the app does hold:
 * the active contract's 节奏条款 (ContractCadence, Contract 2.0, 7/17
 * 定版 — LS 只存约定 + 亮约定, 立钟归 agent/学习者的原生工具). One read-only
 * line, no toggle, no inputs. Data comes from the same `['contract', pairId]`
 * getActiveContract query the old section already used — no new fetches.
 * No active contract, or a contract that never negotiated a cadence clause →
 * render nothing (同 LessonStatusBadge 的 "state 缺省不渲染" 沉默哲学).
 */
const CADENCE_WEEKDAY_KEY: Record<number, DictKey> = {
  0: 'settings.cadence.weekday.0',
  1: 'settings.cadence.weekday.1',
  2: 'settings.cadence.weekday.2',
  3: 'settings.cadence.weekday.3',
  4: 'settings.cadence.weekday.4',
  5: 'settings.cadence.weekday.5',
  6: 'settings.cadence.weekday.6',
};

function formatCadence(cadence: ContractCadence, t: (key: DictKey) => string): string {
  const modeLabel =
    cadence.mode === 'scheduled'
      ? t('settings.cadence.mode.scheduled')
      : t('settings.cadence.mode.fragmented');
  const slots = (cadence.slots ?? [])
    .map((s) => `${t(CADENCE_WEEKDAY_KEY[s.weekday] ?? 'settings.cadence.weekday.0')} ${s.time}`)
    .join(' / ');
  return slots ? `${modeLabel} · ${slots}` : modeLabel;
}

function CadenceSection() {
  const { t } = useT();
  const repo = useRepository();
  const { pairId } = usePair();

  const contractQ = useQuery({
    queryKey: ['contract', pairId],
    queryFn: () =>
      repo && pairId ? repo.getActiveContract(pairId) : Promise.resolve(null),
    enabled: !!repo && !!pairId,
  });

  const cadence = contractQ.data?.cadence;
  if (!cadence) return null;

  return (
    <Section title={t('settings.cadence.title')} subtitle={t('settings.cadence.subtitle')}>
      <p className="text-[13px] leading-5 text-[var(--ls-text-secondary)]">
        {t('settings.cadence.prefix')}
        {formatCadence(cadence, t)}
        {t('settings.cadence.suffix')}
      </p>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * FeedbackLedgerSection — 现场反馈笔改革 (web 半场): the ritual weekly-scores view
 * is gone with the ritual itself. Feedback is voiced in conversation, the
 * teacher records it (record_learner_feedback), and it lands here — a
 * read-only ledger, deliberately no form. Each row: kind chip (issue/idea,
 * quiet palette colors), the learner's verbatim words (逐字纪律 — that IS the
 * row), anchor links where they resolve, and status shown with restraint —
 * green only for real resolution (green-sovereignty), declined always with
 * the teacher's reasoning quoted (拒绝欠判词 — the reasoning is the point).
 */
const FEEDBACK_KIND_LABEL_KEY: Record<FeedbackKind, DictKey> = {
  issue: 'settings.feedback.kind.issue',
  idea: 'settings.feedback.kind.idea',
};

const FEEDBACK_STATUS_LABEL_KEY: Record<FeedbackStatus, DictKey> = {
  open: 'settings.feedback.status.open',
  acknowledged: 'settings.feedback.status.acknowledged',
  addressed: 'settings.feedback.status.addressed',
  declined: 'settings.feedback.status.declined',
};

// Quiet palette assignments: issue borrows the amber working-hypothesis
// color (something raised, not yet settled — NOT risk-red, a ledger row is
// not an alarm), idea borrows structure-blue. Status colors per doctrine:
// open neutral, addressed green (--ls-corroborated, real resolution only),
// declined gray.
const FEEDBACK_KIND_COLOR: Record<FeedbackKind, string> = {
  issue: 'var(--ls-hypothesis)',
  idea: 'var(--ls-structure)',
};

function FeedbackLedgerSection() {
  const { t } = useT();
  const repo = useRepository() as (Repository & FeedbackLedgerRepo) | null;
  const { pairId } = usePair();

  const ledgerQ = useQuery({
    queryKey: ['feedback-ledger', pairId],
    queryFn: () => (repo && pairId ? repo.getFeedbackLedger(pairId) : Promise.resolve([])),
    enabled: !!repo && !!pairId,
  });

  // Server already orders submitted_at desc; re-sort defensively so the
  // "newest first" contract doesn't depend on the transport.
  const rows = [...(ledgerQ.data ?? [])].sort((a, b) =>
    b.submitted_at.localeCompare(a.submitted_at)
  );

  // Lesson anchors: there is no /lesson/<id> route in this app — lessons
  // live at /courses/:courseId/lessons/:lessonId and the ledger row only
  // carries lesson_id, so resolve course via the lesson lists (one pass,
  // cached; only fired when some row actually has a lesson anchor). A
  // lesson_id that no longer resolves renders as a plain ref like the rest.
  const anyLessonAnchor = rows.some((r) => r.lesson_id);
  const lessonPathsQ = useQuery({
    queryKey: ['feedback-lesson-paths', pairId],
    enabled: !!repo && !!pairId && anyLessonAnchor,
    queryFn: async () => {
      const paths: Record<string, string> = {};
      const courses = await repo!.getCourses(pairId!);
      for (const course of courses) {
        for (const lesson of await repo!.getLessons(course.id)) {
          paths[lesson.id] = `/courses/${course.id}/lessons/${lesson.id}`;
        }
      }
      return paths;
    },
  });
  const lessonPaths = lessonPathsQ.data ?? {};

  return (
    <Section title={t('settings.feedback.title')} subtitle={t('settings.feedback.subtitle')}>
      {rows.length === 0 ? (
        <p className="text-[13px] leading-5 text-[var(--ls-text-tertiary)]">
          {t('settings.feedback.empty')}
        </p>
      ) : (
        <ul className="flex flex-col" style={{ gap: '12px' }}>
          {rows.map((f) => (
            <FeedbackLedgerRow key={f.id} entry={f} lessonPath={f.lesson_id ? lessonPaths[f.lesson_id] : undefined} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function FeedbackLedgerRow({
  entry,
  lessonPath,
}: {
  entry: FeedbackLedgerEntry;
  lessonPath?: string;
}) {
  const { t } = useT();
  const kindColor = FEEDBACK_KIND_COLOR[entry.kind] ?? 'var(--ls-text-tertiary)';
  const kindLabelKey = FEEDBACK_KIND_LABEL_KEY[entry.kind];
  const statusLabelKey = FEEDBACK_STATUS_LABEL_KEY[entry.status];

  const anchors: { key: string; labelKey: DictKey; value: string; to?: string }[] = [];
  if (entry.lesson_id)
    anchors.push({ key: 'lesson', labelKey: 'settings.feedback.anchor.lesson', value: entry.lesson_id, to: lessonPath });
  if (entry.live_session_id)
    anchors.push({ key: 'live', labelKey: 'settings.feedback.anchor.liveSession', value: entry.live_session_id });
  if (entry.exercise_id)
    anchors.push({ key: 'exercise', labelKey: 'settings.feedback.anchor.exercise', value: entry.exercise_id });
  if (entry.source_message_ref)
    anchors.push({ key: 'source', labelKey: 'settings.feedback.anchor.source', value: entry.source_message_ref });

  return (
    <li
      className="border border-[var(--ls-border)] bg-[var(--ls-bg)]"
      style={{ padding: '14px 16px', borderRadius: '8px' }}
    >
      <div
        className="flex items-center justify-between flex-wrap"
        style={{ gap: '8px', marginBottom: entry.free_text ? '8px' : 0 }}
      >
        <span
          className="inline-flex items-center border tracking-[0.04em] uppercase font-medium"
          style={{
            padding: '2px 8px',
            borderRadius: '999px',
            fontSize: '10px',
            lineHeight: '14px',
            borderColor: kindColor,
            color: kindColor,
          }}
        >
          {kindLabelKey ? t(kindLabelKey) : entry.kind}
        </span>
        <span className="text-[11px] text-[var(--ls-text-tertiary)] tabular-nums">
          {new Date(entry.submitted_at).toLocaleDateString()}
        </span>
      </div>

      {entry.free_text && (
        <p className="text-[13px] leading-[20px]">{entry.free_text}</p>
      )}

      {anchors.length > 0 && (
        <div
          className="flex flex-wrap text-[11px] leading-4 text-[var(--ls-text-tertiary)]"
          style={{ gap: '12px', marginTop: '8px' }}
        >
          {anchors.map((a) => (
            <span key={a.key}>
              {t(a.labelKey)}{' '}
              {a.to ? (
                <Link
                  to={a.to}
                  className="text-[var(--ls-structure)] hover:underline"
                >
                  {a.value}
                </Link>
              ) : (
                <span className="text-[var(--ls-text-secondary)]">{a.value}</span>
              )}
            </span>
          ))}
        </div>
      )}

      {/* Status — restraint: a dot and a word. open = neutral filled,
          acknowledged = hollow, addressed = green (real resolution only),
          declined = gray. */}
      <div
        className="flex items-center text-[11px] leading-4 text-[var(--ls-text-tertiary)]"
        style={{ gap: '6px', marginTop: '10px' }}
      >
        <FeedbackStatusDot status={entry.status} />
        <span>{statusLabelKey ? t(statusLabelKey) : entry.status}</span>
        {entry.status_changed_at && (
          <span className="tabular-nums">
            · {new Date(entry.status_changed_at).toLocaleDateString()}
          </span>
        )}
      </div>

      {/* 拒绝欠判词 — the teacher's status_note shown as a quote line; the
          reasoning is the point. Shown for any status that carries one. */}
      {entry.status_note && (
        <p
          className="text-[12px] leading-[18px] text-[var(--ls-text-secondary)] italic"
          style={{
            marginTop: '6px',
            paddingLeft: '10px',
            borderLeft: '2px solid var(--ls-border-strong)',
          }}
        >
          {entry.status_note}
        </p>
      )}
    </li>
  );
}

function FeedbackStatusDot({ status }: { status: FeedbackStatus }) {
  const style: Record<FeedbackStatus, { background: string; border?: string }> = {
    open: { background: 'var(--ls-text-secondary)' },
    acknowledged: { background: 'transparent', border: '1px solid var(--ls-text-tertiary)' },
    addressed: { background: 'var(--ls-corroborated)' },
    declined: { background: 'var(--ls-text-tertiary)' },
  };
  const s = style[status] ?? style.open;
  return (
    <span
      aria-hidden
      className="inline-block rounded-full"
      style={{ width: '7px', height: '7px', flex: '0 0 7px', ...s }}
    />
  );
}

/* -------------------------------------------------------------------------- */

/**
 * CertificateSection (证书化, 2026-07-08) — replaces the old
 * ContractsManagementSection placeholder. Contract page's browsing/CRUD
 * function is dead; the signed agreement now lives here as a
 * "certificate" — a document, not a field-list. `proposed` contracts are
 * deliberately excluded from both the certificate and the archive below:
 * they aren't signed yet, so they live in the "待签之约" surfacing
 * (RecentRail row + top-bar chip) until Establish flips them out of that
 * state.
 *
 * 证书揭示改版 (2026-07-11): Contract/index.tsx's certificate-reveal beat
 * redirects here with `?highlightContract=<id>` after Establish. Whichever
 * row actually renders that id — the "current" CertificateCard if the
 * agent has already finished provisioning (rare — nothing currently
 * flips a contract past `established` without the retired outline/
 * generate UI, see 证书揭示改版 report), or the ArchiveRow if it's still
 * mid-pipeline (the common case) — scrolls itself into view and shows a
 * brief amber highlight (琥珀点语言 borrowed from the top-bar "待签之约"
 * chip in shell/AppShell.tsx). The param self-clears after the highlight
 * window so revisiting/sharing the URL doesn't re-trigger it.
 */
function CertificateSection() {
  const { t } = useT();
  const repo = useRepository();
  const { pairId } = usePair();
  const { identity } = useIdentity();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const highlightId = searchParams.get('highlightContract');

  useEffect(() => {
    if (!highlightId) return;
    const timer = window.setTimeout(() => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete('highlightContract');
          return next;
        },
        { replace: true }
      );
    }, HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [highlightId, setSearchParams]);

  const contractsQ = useQuery({
    queryKey: ['contracts', pairId],
    queryFn: () =>
      repo && pairId ? repo.getAllContracts(pairId) : Promise.resolve([] as TeachingContract[]),
    enabled: !!repo && !!pairId,
  });

  const all = contractsQ.data ?? [];
  // 合同生命周期修缮B (2026-07-11): 'established' is now the contract lifecycle's
  // terminal/"done" state (the outline/generate pipeline that used to run
  // established → … → ready was torn down — no real write path ever
  // advanced a contract past 'established'; see packages/contracts/src/
  // pair.ts ContractSetupStatus). A signed contract certifies at Establish,
  // full stop — so 'established' belongs in the certificate section, not
  // the archive (previously every fresh contract landed in archive under a
  // "still mid-setup" label it could never actually leave — 合同生命周期修缮).
  // 'ready' stays included for pre-existing rows written under the old
  // pipeline (legacy data only, @deprecated — nothing produces it anymore).
  // Multiple parallel courses can all be simultaneously certified — each
  // gets its own certificate, newest first.
  //
  // 迁移 0027 尾巴 A (Void 学习者侧入口, 2026-07-18): a voided contract
  // (voided_at set) never belongs in the certificate section regardless of
  // its setup_status — voiding is orthogonal to the setup lifecycle, same
  // call server's currentContract.ts already made for "current contract"
  // selection. An established-but-voided contract falls straight through to
  // the archive below instead.
  const current = all
    .filter(
      (c) => !c.voided_at && (c.setup_status === 'established' || c.setup_status === 'ready')
    )
    .sort((a, b) => (b.time_range.start ?? '').localeCompare(a.time_range.start ?? ''));
  // Everything else that isn't a pending signature: legacy pipeline
  // fossils stuck mid-flight (outlining / outline_ready / generating /
  // in_progress — @deprecated, no real write path produces these anymore),
  // terminal leftovers (draft leftover / failed / cancelled), or a voided
  // contract kicked out of the certificate section above (established/ready
  // included) — archived, nothing left to certify. 'proposed' stays
  // excluded even if somehow voided pre-signature — it was never reachable
  // from either void entry point (CertificateCard requires 'current' above,
  // MCP void_contract is a post-signature courtesy) so this is belt-and-
  // braces, not a real path.
  const archive = all
    .filter(
      (c) =>
        c.setup_status !== 'proposed' &&
        (c.voided_at != null ||
          (c.setup_status !== 'established' && c.setup_status !== 'ready'))
    )
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));

  const studentName = identity
    ? identity.learner.display_name
    : t('settings.certificate.studentFallback');
  const teacherName = identity
    ? cleanAgentName(identity.agent.display_name)
    : t('settings.certificate.teacherFallback');

  const voidMut = useMutation({
    mutationFn: ({ id, reason }: { id: TeachingContract['id']; reason: string }) => {
      if (!repo) throw new Error('no repo');
      return repo.voidContract(id, reason);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['contracts', pairId] }),
    onError: (e) => console.error('[voidContract]', e),
  });

  return (
    <Section title={t('settings.certificate')} subtitle={t('settings.certificate.sub')}>
      {/* DEMO pill — 第二个 pair 身份露脸处 (设计单五.1 "Contract demo
          合约行"): is_demo 是 pair 级数据身份, 这个 pair 名下的合约全是样板
          间产物, 区块顶标一次, 不逐卡重复。非 demo pair 零占位。 */}
      <DemoPillRow />
      {current.length === 0 ? (
        <p className="text-[13px] leading-5 text-[var(--ls-text-tertiary)]">
          {t('settings.certificate.empty')}
        </p>
      ) : (
        <div className="flex flex-col" style={{ gap: '18px' }}>
          {current.map((c) => (
            <CertificateCard
              key={c.id}
              contract={c}
              studentName={studentName}
              teacherName={teacherName}
              highlighted={c.id === highlightId}
              onVoid={(reason) => voidMut.mutate({ id: c.id, reason })}
              voidPending={voidMut.isPending && voidMut.variables?.id === c.id}
            />
          ))}
        </div>
      )}

      <ContractArchive contracts={archive} highlightId={highlightId} />
    </Section>
  );
}

// 证书揭示改版: how long the amber highlight stays lit before the URL param
// (and therefore the highlight) clears itself.
const HIGHLIGHT_MS = 2_400;

/**
 * Scrolls the element into view the moment it becomes `highlighted` — used
 * by both CertificateCard (rare: agent already finished provisioning) and
 * ArchiveRow (common: still mid-pipeline) so whichever one actually renders
 * the freshly-established contract is what the learner's eye lands on,
 * regardless of which list it ended up in.
 */
function useHighlightScroll<T extends HTMLElement>(highlighted: boolean | undefined) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlighted]);
  return ref;
}

/** One signed contract, rendered as a document rather than a field-grid. */
function CertificateCard({
  contract,
  studentName,
  teacherName,
  highlighted,
  onVoid,
  voidPending,
}: {
  contract: TeachingContract;
  studentName: string;
  teacherName: string;
  highlighted?: boolean;
  /** 迁移 0027 尾巴 A — 学习者作废这份合约。reason 可选 (学习者裁决
   *  2026-07-18: 强制留理由构成负担)——空字符串表示不留理由, 服务端存 null。 */
  onVoid?: (reason: string) => void;
  voidPending?: boolean;
}) {
  const { t } = useT();
  const signedDate = new Date(contract.time_range.start).toLocaleDateString();
  const terms = [
    contract.intensity,
    contract.pace,
    contract.content_modality,
    contract.interaction_mode,
  ].filter(Boolean);
  const ref = useHighlightScroll<HTMLDivElement>(highlighted);

  // 迁移 0027 尾巴 A — inline confirm requiring a one-line reason, same "no
  // window.confirm" convention as Cards.tsx's confirmingDelete / AdHocPanel's
  // MessageDeleteControl (隐私清理案/就地确认删除控件): the trigger swaps in-place for a
  // reason input + Confirm/Cancel pair, no separate modal.
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');

  return (
    <div
      ref={ref}
      className="mx-auto w-full"
      style={{
        maxWidth: '520px',
        border: `1px solid ${highlighted ? 'var(--ls-hypothesis)' : 'var(--ls-border-strong)'}`,
        background: highlighted ? 'var(--ls-hyp-tint)' : 'transparent',
        borderRadius: '10px',
        padding: '30px 34px',
        textAlign: 'center',
        transition: `border-color var(--ls-duration-base) var(--ls-easing), background var(--ls-duration-base) var(--ls-easing)`,
      }}
    >
      <p
        className="italic text-[12px] leading-[18px] text-[var(--ls-text-tertiary)]"
        style={{ marginBottom: '20px' }}
      >
        {t('settings.certificate.quote')}
      </p>

      <h3
        className="font-semibold text-[18px] leading-[26px] tracking-[-0.005em]"
        style={{ marginBottom: '10px' }}
      >
        {contract.goal}
      </h3>

      {contract.success_criteria.length > 0 && (
        <div style={{ marginBottom: '18px' }}>
          <div
            className="text-[10px] uppercase tracking-[0.06em] text-[var(--ls-text-tertiary)]"
            style={{ marginBottom: '6px' }}
          >
            {t('settings.certificate.criteria')}
          </div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {contract.success_criteria.map((s, i) => (
              <li
                key={i}
                className="text-[13px] leading-[20px] text-[var(--ls-text-secondary)]"
              >
                {s}
              </li>
            ))}
          </ul>
        </div>
      )}

      {terms.length > 0 && (
        <div
          className="text-[11px] tracking-[0.04em] text-[var(--ls-text-tertiary)]"
          style={{ marginBottom: '22px' }}
        >
          {terms.join(' · ')}
        </div>
      )}

      <div
        className="flex items-center justify-center"
        style={{
          gap: '52px',
          borderTop: '1px solid var(--ls-border)',
          borderBottom: '1px solid var(--ls-border)',
          padding: '14px 0',
          marginBottom: '12px',
        }}
      >
        <div>
          <div className="text-[10px] uppercase tracking-[0.06em] text-[var(--ls-text-tertiary)]">
            {t('settings.certificate.student')}
          </div>
          <div className="text-[14px] font-medium" style={{ marginTop: '4px' }}>
            {studentName}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.06em] text-[var(--ls-text-tertiary)]">
            {t('settings.certificate.teacher')}
          </div>
          <div className="text-[14px] font-medium" style={{ marginTop: '4px' }}>
            {teacherName}
          </div>
        </div>
      </div>

      <div className="text-[11px] text-[var(--ls-text-tertiary)] tabular-nums">
        {t('settings.certificate.since')} {signedDate}
      </div>

      {/* 迁移 0030 (State 2.0) — 结业(completed_at): 与作废并列的第三种终态,
          分色不分位——绿色 pill (--ls-corroborated, "善终"的既有配色), 详情带
          结业日期 + 结业词。 */}
      {contract.completed_at && (
        <div style={{ marginTop: '14px' }}>
          <CompletedPill />
          <div className="text-[11px] text-[var(--ls-text-tertiary)]" style={{ marginTop: '6px' }}>
            {t('settings.certificate.completedOn')}{' '}
            {new Date(contract.completed_at).toLocaleDateString()}
            {contract.completion_note ? ` · ${contract.completion_note}` : ''}
          </div>
        </div>
      )}

      {/* 覆盖单 — covered_course_ids 非空时, 现役合约卡上露一个课程数提示。 */}
      {contract.covered_course_ids.length > 0 && (
        <div className="text-[11px] text-[var(--ls-text-tertiary)]" style={{ marginTop: '8px' }}>
          {t('settings.certificate.coveredCoursesPrefix')}
          {contract.covered_course_ids.length}
          {t('settings.certificate.coveredCoursesSuffix')}
        </div>
      )}

      {/* 誓言三 (confidence 可视化视图三) — 诚实启发式: 只在这份婚书自己写了
          "brier" 字样的 success_criteria 里才显示, 不是每张合约卡都长这个。 */}
      <BrierTrendSection contract={contract} />

      {/* 迁移 0027 尾巴 A — 次要样式, 不抢眼: 小号灰字, 只有点开才露出作废
          流程。学习者裁决 (2026-07-18): 理由可选——强制留理由构成负担。输入框
          保留但空着也能确认 (confirm 只在请求 pending 时 disabled), 空理由
          服务端写 void_reason=null。幂等/服务端校验交给 mutation 本身。 */}
      {onVoid && (
        <div style={{ marginTop: '16px', paddingTop: '12px', borderTop: '1px solid var(--ls-border)' }}>
          {voiding ? (
            <div style={{ textAlign: 'left' }}>
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t('settings.certificate.voidReasonPlaceholder')}
                autoFocus
                className="w-full text-[12px]"
                style={{
                  padding: '6px 10px',
                  border: '1px solid var(--ls-border-strong)',
                  borderRadius: '6px',
                  background: 'var(--ls-bg)',
                  color: 'var(--ls-text)',
                }}
              />
              <div className="flex items-center justify-end" style={{ gap: '12px', marginTop: '8px' }}>
                <button
                  type="button"
                  onClick={() => {
                    setVoiding(false);
                    setReason('');
                  }}
                  className="text-[12px] text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)]"
                >
                  {t('settings.certificate.voidCancel')}
                </button>
                <button
                  type="button"
                  disabled={voidPending}
                  onClick={() => onVoid(reason.trim())}
                  className="text-[12px] font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{ color: 'var(--ls-risk)' }}
                >
                  {voidPending ? t('settings.certificate.voidConfirming') : t('settings.certificate.voidConfirm')}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setVoiding(true)}
              className="text-[11px] text-[var(--ls-text-tertiary)] hover:text-[var(--ls-risk)] transition-colors"
            >
              {t('settings.certificate.voidTrigger')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** 誓言三 (confidence 可视化视图三) — Brier 趋势线, 只服务 success_criteria
 *  文本里写了"brier"字样的合约 (诚实启发式: 学习者/教师自己把这份婚书定义成
 *  可校准的, 不是系统替所有合约都加一张图). Query 本身也 gate 在这条判定
 *  之后 — 不是每张证书都要打一次 /brier-trend。 */
function BrierTrendSection({ contract }: { contract: TeachingContract }) {
  const { t } = useT();
  const repo = useRepository() as (Repository & BrierTrendRepo) | null;
  const { pairId } = usePair();
  const showBrier = /brier/i.test(contract.success_criteria.join(' \n '));

  const trendQ = useQuery({
    queryKey: ['brier-trend', pairId, contract.id],
    queryFn: () =>
      repo && pairId ? repo.getBrierTrend(pairId) : Promise.resolve([] as BrierTrendPoint[]),
    enabled: !!repo && !!pairId && showBrier,
  });

  if (!showBrier) return null;

  const points = trendQ.data ?? [];
  const thinRun = points.length > 0 && points.length < 12;

  return (
    <div
      style={{
        marginTop: '16px',
        paddingTop: '14px',
        borderTop: '1px solid var(--ls-border)',
        textAlign: 'left',
      }}
    >
      <div
        className="text-[10px] uppercase tracking-[0.06em] text-[var(--ls-text-tertiary)]"
        style={{ marginBottom: '8px' }}
      >
        {t('settings.certificate.brierTitle')}
      </div>

      {points.length === 0 ? (
        <p className="text-[12px] leading-4 text-[var(--ls-text-tertiary)] italic">
          {t('settings.certificate.brierEmptyNone')}
        </p>
      ) : (
        <>
          <div
            className="border border-[var(--ls-border)] bg-[var(--ls-bg-subtle)]"
            style={{ borderRadius: '8px', padding: '10px 10px 6px' }}
          >
            <BrierTrendChart points={points} />
          </div>
          {thinRun && (
            <p className="text-[11px] leading-4 text-[var(--ls-text-tertiary)] italic" style={{ marginTop: '6px' }}>
              {t('settings.certificate.brierThin')}
            </p>
          )}
          <p className="text-[11px] leading-4 text-[var(--ls-text-tertiary)]" style={{ marginTop: thinRun ? '2px' : '6px' }}>
            {t('settings.certificate.brierHint')}
          </p>
        </>
      )}
    </div>
  );
}

/** Hand-drawn SVG line — Brier per ISO week, y 轴 0–0.5 截断显示 (数值越低
 *  越好, 标准直角坐标: 数值大在上、小在下, 不倒转). 两条基准细横带 (前六周
 *  均值 / 后六周均值) 只在样本 ≥12 周时画, 用同一支前景色但 8% 透明度和数据线
 *  区分, 不新引一支色。不画数轴刻度文字——viewBox 只在横向非均匀缩放, 文字会
 *  被拉花, 索性不放, 留白也是"小、静"的一部分。 */
function BrierTrendChart({ points }: { points: BrierTrendPoint[] }) {
  const W = 400;
  const H = 110;
  const PAD_TOP = 6;
  const PAD_BOTTOM = 6;
  const plotH = H - PAD_TOP - PAD_BOTTOM;
  const Y_MAX = 0.5;

  const yFor = (brier: number) => {
    const clamped = Math.max(0, Math.min(Y_MAX, brier));
    return PAD_TOP + plotH - (clamped / Y_MAX) * plotH;
  };
  const xFor = (i: number) => (points.length <= 1 ? W / 2 : (i / (points.length - 1)) * W);

  const pathD = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i).toFixed(1)} ${yFor(p.brier).toFixed(1)}`)
    .join(' ');

  let firstBandY: number | null = null;
  let lastBandY: number | null = null;
  if (points.length >= 12) {
    const first6 = points.slice(0, 6);
    const last6 = points.slice(-6);
    firstBandY = yFor(first6.reduce((s, p) => s + p.brier, 0) / first6.length);
    lastBandY = yFor(last6.reduce((s, p) => s + p.brier, 0) / last6.length);
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Brier trend by week">
      {firstBandY != null && (
        <rect x={0} y={firstBandY - 2} width={W} height={4} fill="var(--ls-text)" fillOpacity={0.08} />
      )}
      {lastBandY != null && (
        <rect x={0} y={lastBandY - 2} width={W} height={4} fill="var(--ls-text)" fillOpacity={0.08} />
      )}
      <path d={pathD} fill="none" stroke="var(--ls-text)" strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
      {points.map((p, i) => (
        <circle key={p.week_start} cx={xFor(i)} cy={yFor(p.brier)} r={1.6} fill="var(--ls-text)" />
      ))}
    </svg>
  );
}

/** 迁移 0030 (State 2.0) — 结业 pill, 复用 LessonStatusBadge/RevisedFlag 同款
 *  border+dot+uppercase 形状, 颜色借 --ls-corroborated (跟"已回课"同一支绿,
 *  这里也是"善终"语义), 与 ArchiveRow 的 voidedLabel 刻意分色。 */
function CompletedPill() {
  const { t } = useT();
  const color = 'var(--ls-corroborated)';
  return (
    <span
      className="inline-flex items-center border tracking-[0.04em] uppercase font-medium"
      style={{
        padding: '2px 8px',
        borderRadius: '999px',
        fontSize: '10px',
        lineHeight: '14px',
        borderColor: color,
        color,
        gap: '6px',
      }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
      {t('settings.certificate.completedLabel')}
    </span>
  );
}

// 合同生命周期修缮B/死链修复 (2026-07-11): dropped RESUMABLE_STATUSES and the
// "continue setup →" link this archive used to render for it. 'ready'
// (the only state that gave "current" its meaning) was retired —
// 'established' is terminal now — so there is no longer any sense in
// which an archived contract is "resumable"; the link only ever bounced
// through /contract/:id straight back to /settings (死链修复 dead-link
// report). Archive rows are inert history now: label + expandable detail,
// nothing to click through to.
const ARCHIVE_STATUS_LABEL_KEY: Record<string, DictKey> = {
  draft: 'contract.pipeline.statusDraft',
  outlining: 'contract.pipeline.statusOutlining',
  outline_ready: 'contract.pipeline.statusOutlineReady',
  generating: 'contract.pipeline.statusGenerating',
  in_progress: 'contract.pipeline.statusGenerating',
  failed: 'contract.pipeline.statusFailed',
  cancelled: 'contract.pipeline.statusCancelled',
};

/** Collapsible archive of every non-certified, non-pending contract. */
function ContractArchive({
  contracts,
  highlightId,
}: {
  contracts: TeachingContract[];
  highlightId?: string | null;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);

  // A highlighted contract only ever lands in this archive if it's a
  // legacy-pipeline fossil or a terminal leftover (established now goes
  // straight to the certificate section above, see 合同生命周期修缮B) — force
  // the archive open so that row is visible instead of hiding behind "+".
  useEffect(() => {
    if (highlightId && contracts.some((c) => c.id === highlightId)) {
      setOpen(true);
    }
  }, [highlightId, contracts]);

  return (
    <div style={{ marginTop: '22px', borderTop: '1px solid var(--ls-border)', paddingTop: '14px' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between text-left cursor-pointer select-none"
      >
        <span className="text-[11px] uppercase tracking-[0.05em] font-medium text-[var(--ls-text-secondary)]">
          {t('settings.certificate.history')} · {contracts.length}
        </span>
        <span className="text-[14px] text-[var(--ls-text-tertiary)] tabular-nums">
          {open ? '−' : '+'}
        </span>
      </button>

      {open &&
        (contracts.length === 0 ? (
          <p
            className="text-[13px] leading-5 text-[var(--ls-text-tertiary)]"
            style={{ marginTop: '12px' }}
          >
            {t('settings.certificate.historyEmpty')}
          </p>
        ) : (
          <div className="flex flex-col" style={{ gap: '8px', marginTop: '12px' }}>
            {contracts.map((c) => (
              <ArchiveRow key={c.id} contract={c} highlighted={c.id === highlightId} />
            ))}
          </div>
        ))}
    </div>
  );
}

function ArchiveRow({
  contract,
  highlighted,
}: {
  contract: TeachingContract;
  highlighted?: boolean;
}) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);
  const status = contract.setup_status;
  const date = new Date(contract.created_at).toLocaleDateString();
  const titleClipped =
    contract.goal.length > 64 ? contract.goal.slice(0, 64) + '…' : contract.goal;
  const ref = useHighlightScroll<HTMLDivElement>(highlighted);
  // 迁移 0027 尾巴 A — a voided row is a distinct kind of history from a
  // normal pipeline-status archive row (换代/失败/取消): it was signed and
  // then deliberately ended by learner or agent, not superseded by setup
  // mechanics. Own label instead of ARCHIVE_STATUS_LABEL_KEY's pipeline
  // vocabulary, own detail line (date + reason) in the expanded panel.
  const voided = contract.voided_at != null;
  const voidedDate = contract.voided_at ? new Date(contract.voided_at).toLocaleDateString() : null;
  // 迁移 0030 (State 2.0) — 结业, 独立于作废的第三种终态标签; voided 优先
  // (既有 filter 已把 voided 合约都塞进档案区, 一份合约理论上不该同时结业+
  // 作废, 但 voided 分支本就先手, 这里沿用同一优先级不引入新歧义)。
  const completed = !voided && contract.completed_at != null;
  const completedDate = contract.completed_at
    ? new Date(contract.completed_at).toLocaleDateString()
    : null;

  return (
    <div
      ref={ref}
      style={{
        border: `1px solid ${highlighted ? 'var(--ls-hypothesis)' : 'var(--ls-border)'}`,
        background: highlighted ? 'var(--ls-hyp-tint)' : 'var(--ls-bg)',
        borderRadius: '8px',
        overflow: 'hidden',
        transition: `border-color var(--ls-duration-base) var(--ls-easing), background var(--ls-duration-base) var(--ls-easing)`,
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center hover:bg-[var(--ls-panel)] transition-colors text-left"
        style={{ padding: '10px 12px', gap: '10px' }}
      >
        {highlighted && (
          <span
            className="flex-none w-1.5 h-1.5 rounded-full"
            style={{ background: 'var(--ls-hypothesis)' }}
            aria-hidden
          />
        )}
        <span
          className="flex-1 min-w-0 text-[13px] text-[var(--ls-text)] truncate"
          title={contract.goal}
        >
          {titleClipped}
        </span>
        <span className="flex-none text-[11px] text-[var(--ls-text-tertiary)] tabular-nums">
          {date}
        </span>
        <span
          className="flex-none text-[10px] uppercase tracking-[0.05em]"
          style={{
            color: voided
              ? 'var(--ls-risk)'
              : completed
                ? 'var(--ls-corroborated)'
                : 'var(--ls-text-tertiary)',
          }}
        >
          {voided
            ? t('settings.certificate.voidedLabel')
            : completed
              ? t('settings.certificate.completedLabel')
              : ARCHIVE_STATUS_LABEL_KEY[status]
                ? t(ARCHIVE_STATUS_LABEL_KEY[status]!)
                : status}
        </span>
        <span
          className="flex-none text-[11px] text-[var(--ls-text-tertiary)]"
          style={{ width: '12px', textAlign: 'center' }}
        >
          {expanded ? '▾' : '▸'}
        </span>
      </button>

      {expanded && (
        <div
          className="border-t border-[var(--ls-border)] flex flex-col"
          style={{ padding: '12px 14px', gap: '10px' }}
        >
          <LabeledField label={t('contract.goal')}>
            <div className="text-[13px] leading-5">{contract.goal}</div>
          </LabeledField>
          {contract.success_criteria.length > 0 && (
            <LabeledField label={t('settings.certificate.criteria')}>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {contract.success_criteria.map((s, i) => (
                  <li key={i} className="text-[13px] leading-5">
                    {s}
                  </li>
                ))}
              </ul>
            </LabeledField>
          )}
          {voided && (
            <LabeledField label={t('settings.certificate.voidedOn')}>
              <div className="text-[13px] leading-5">
                {voidedDate}
                {contract.void_reason ? ` · ${contract.void_reason}` : ''}
              </div>
            </LabeledField>
          )}
          {completed && (
            <LabeledField label={t('settings.certificate.completedOn')}>
              <div className="text-[13px] leading-5">
                {completedDate}
                {contract.completion_note ? ` · ${contract.completion_note}` : ''}
              </div>
            </LabeledField>
          )}
          <div className="text-[11px] text-[var(--ls-text-tertiary)] tracking-[0.03em]">
            {[contract.intensity, contract.pace, contract.content_modality, contract.interaction_mode]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
      )}
    </div>
  );
}

function LearnerModelSection() {
  const { t } = useT();
  const repo = useRepository();
  const { pairId } = usePair();
  const qc = useQueryClient();

  const hypothesesQ = useQuery({
    queryKey: ['hypotheses', pairId],
    queryFn: () => (repo && pairId ? repo.getHypotheses(pairId) : Promise.resolve([])),
    enabled: !!repo && !!pairId,
  });

  const reviewMut = useMutation({
    mutationFn: ({
      id,
      action,
      user_note,
    }: {
      id: string;
      action: 'confirm' | 'reject' | 'freeze';
      user_note?: string;
    }) => {
      if (!repo) throw new Error('no repo');
      return repo.reviewHypothesis(id, action, user_note);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hypotheses', pairId] }),
  });

  return (
    <Section title={t('settings.learnerModel')} subtitle={t('settings.learnerModel.sub')}>
      {!repo ? (
        <p className="text-[13px] leading-5 text-[var(--ls-text-tertiary)]">{t('settings.learnerModel.emptyMode')}</p>
      ) : (
        <div>
          <h3 className="text-[11px] font-medium tracking-[0.05em] uppercase text-[var(--ls-text-tertiary)] leading-4" style={{ marginBottom: '10px' }}>
            {t('settings.hypotheses')}
          </h3>
          <ul className="flex flex-col" style={{ gap: '12px' }}>
            {hypothesesQ.data?.map((h) => (
              <HypothesisCard
                key={h.id}
                h={h}
                pending={reviewMut.isPending}
                onVote={(action, note) =>
                  reviewMut.mutateAsync({ id: h.id, action, user_note: note || undefined })
                }
              />
            ))}
          </ul>
          {/*
            教学复盘区 (teacher_reflections 的 method/rationale/what_failed/next_action)
            2026-07-26 撤除, 别再加回来。reflect_on_teaching 的工具描述自己写着
            "呈现全静默……不进任何 UI" (apps/server/src/mcp/server.ts), 而
            归因设计 §5 只给"学习者假设"开了在 Settings
            呈现的特许 —— 反思是老师写给自己的内账, 不是给学习者读的。学习者当面
            裁定: 停止渲染, 保住那句承诺。上面的假设区是制度指定的唯一呈现地,
            它留着 (可查看 / 确认 / 拒绝 / 冻结)。
          */}
        </div>
      )}
    </Section>
  );
}

const HYPOTHESIS_ACTIONS = ['confirm', 'reject', 'freeze'] as const;
type HypothesisAction = (typeof HYPOTHESIS_ACTIONS)[number];

const HYPOTHESIS_STATUS_LABEL_KEY: Record<string, DictKey> = {
  tentative: 'settings.hypothesis.status.tentative',
  active: 'settings.hypothesis.status.active',
  rejected: 'settings.hypothesis.status.rejected',
  frozen: 'settings.hypothesis.status.frozen',
  confirmed: 'settings.hypothesis.status.confirmed',
  expired: 'settings.hypothesis.status.expired',
};

function HypothesisCard({
  h,
  pending,
  onVote,
}: {
  h: LearnerHypothesis;
  pending: boolean;
  onVote: (action: HypothesisAction, note: string) => Promise<unknown>;
}) {
  const { t } = useT();
  const [note, setNote] = useState('');

  const selected: HypothesisAction | null =
    h.status === 'confirmed'
      ? 'confirm'
      : h.status === 'rejected'
        ? 'reject'
        : h.status === 'frozen'
          ? 'freeze'
          : null;
  const reviewed = selected !== null;

  const buttonClass = (action: HypothesisAction) =>
    selected === action
      ? 'bg-[var(--ls-text)] text-[var(--ls-bg)] transition-colors duration-[var(--ls-duration-fast)]'
      : `border border-[var(--ls-border)] hover:bg-[var(--ls-bg)] transition-colors duration-[var(--ls-duration-fast)]${
          selected ? ' opacity-60' : ''
        }`;

  const vote = (action: HypothesisAction) => {
    onVote(action, note.trim()).then(() => setNote(''));
  };

  // 假设生命周期 (0041): 'expired' 是老师侧退役/被修订超越的死状态 (与学习者
  // 的 rejected 分属两支)——灰显呈现, 既有 status 文案照常可读。stale 标注
  // (last_evidence_at 阈值现算) 留给后续批次: 需要 i18n 文案 + 与 server 常量
  // 对齐, 不在这次的零风险窗口里。
  const retired = h.status === 'expired';

  return (
    <li
      className="border border-[var(--ls-border)] bg-[var(--ls-hyp-tint)]"
      style={{ borderRadius: '8px', padding: '16px', ...(retired ? { opacity: 0.55 } : {}) }}
    >
      <div className="flex items-center justify-between text-[12px] leading-[18px] text-[var(--ls-text-secondary)]">
        <span className="font-medium">{h.domain}</span>
        <span>
          {t('settings.hypothesis.confidencePrefix')}{h.confidence.toFixed(2)}{t('settings.hypothesis.statusMidPrefix')}{t(HYPOTHESIS_STATUS_LABEL_KEY[h.status] ?? 'settings.hypothesis.status.tentative')}
        </span>
      </div>
      <p className="text-[14px] leading-[22px]" style={{ marginTop: '8px' }}>
        {h.observation}
      </p>
      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={t('settings.hypothesis.votePlaceholder')}
        className="w-full border border-[var(--ls-border)] bg-[var(--ls-bg)] text-[var(--ls-text)] text-[13px] focus:outline-none focus:border-[var(--ls-border-strong)]"
        style={{ height: '30px', padding: '0 10px', borderRadius: '6px', marginTop: '12px' }}
      />
      <div
        className="flex items-center flex-wrap text-[12px] leading-4"
        style={{ marginTop: '8px', gap: '8px' }}
      >
        <button
          className={buttonClass('confirm')}
          style={{ padding: '4px 10px', borderRadius: '6px' }}
          disabled={pending}
          onClick={() => vote('confirm')}
        >
          {t('settings.confirm')}
        </button>
        <button
          className={buttonClass('reject')}
          style={{ padding: '4px 10px', borderRadius: '6px' }}
          disabled={pending}
          onClick={() => vote('reject')}
        >
          {t('settings.reject')}
        </button>
        <button
          className={buttonClass('freeze')}
          style={{ padding: '4px 10px', borderRadius: '6px' }}
          disabled={pending}
          onClick={() => vote('freeze')}
        >
          {t('settings.freeze')}
        </button>
      </div>
      {reviewed && (
        <p
          className="text-[11px] leading-4 text-[var(--ls-text-tertiary)]"
          style={{ marginTop: '6px' }}
        >
          {t('settings.hypothesis.reviewedPrefix')}{t(HYPOTHESIS_STATUS_LABEL_KEY[h.status] ?? 'settings.hypothesis.status.tentative')}
        </p>
      )}
      {h.user_note && (
        <p
          className="text-[11px] leading-4 text-[var(--ls-text-tertiary)]"
          style={{ marginTop: '2px' }}
        >
          {t('settings.hypothesis.yourNotePrefix')}{h.user_note}
        </p>
      )}
    </li>
  );
}

/* -------------------------------------------------------------------------- */

// 观察禁区下线案 — ObservationBoundarySection removed (approved): the 观察禁区
// registry UI is gone from Settings. Boundary negotiation is first-order
// conversation with the agent now (an MCP pen lands separately); the server
// keeps its REST add path. The gate STATE still matters here — Portrait
// below reads getObservationGateState for the confidence-mode switch.

const CONFIDENCE_LEVEL_LABEL_KEY: Record<ConfidenceLevel, DictKey> = {
  guess: 'confidence.level.guess',
  likely: 'confidence.level.likely',
  certain: 'confidence.level.certain',
};

/**
 * PortraitSection (批1, LEARNER-MODEL-BRIEF.md §3/§9) — 把握度模式总开关 +
 * 校准曲线最小呈现. Lives in the same "学籍档案室" drawer as the certificate
 * and the observation boundary above it — no top-level nav entry (隐身术).
 */
function PortraitSection() {
  const { t } = useT();
  const repo = useRepository() as
    | (Repository & ObservationGateRepo & CalibrationRepo & ConfidenceAnchorRepo)
    | null;
  const { pairId } = usePair();
  const qc = useQueryClient();
  const [courseId, setCourseId] = useState<CourseId | ''>('');

  const gateQ = useQuery({
    queryKey: ['observation-gate', pairId],
    queryFn: () => (repo && pairId ? repo.getObservationGateState(pairId) : Promise.resolve(null)),
    enabled: !!repo && !!pairId,
  });

  const anchorsQ = useQuery({
    queryKey: ['confidence-anchors', pairId],
    queryFn: () => (repo && pairId ? repo.getConfidenceAnchors(pairId) : Promise.resolve(null)),
    enabled: !!repo && !!pairId,
  });

  const coursesQ = useQuery({
    queryKey: ['courses', pairId],
    queryFn: () => (repo && pairId ? repo.getCourses(pairId) : Promise.resolve([])),
    enabled: !!repo && !!pairId,
  });

  const calibrationQ = useQuery({
    queryKey: ['calibration', pairId, courseId || null],
    queryFn: () =>
      repo && pairId
        ? repo.getCalibrationCurve(pairId, courseId || undefined)
        : Promise.resolve(null),
    enabled: !!repo && !!pairId,
  });

  const toggleMut = useMutation({
    mutationFn: (enabled: boolean) => {
      if (!repo || !pairId) throw new Error('no repo');
      return repo.setConfidenceModeEnabled(pairId, enabled);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['observation-gate', pairId] }),
  });

  const anchorsMut = useMutation({
    mutationFn: (anchors: ConfidenceAnchorConfig) => {
      if (!repo || !pairId) throw new Error('no repo');
      return repo.setConfidenceAnchors(pairId, anchors);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['confidence-anchors', pairId] });
      qc.invalidateQueries({ queryKey: ['calibration', pairId] });
    },
  });

  const enabled = gateQ.data?.confidence_mode_enabled ?? true;
  const changedAt = gateQ.data?.confidence_mode_changed_at;
  const buckets = calibrationQ.data?.buckets ?? [];
  const anyBucketHasSamples = buckets.some((b) => b.sample_count > 0);

  return (
    <Section title={t('settings.portrait.title')} subtitle={t('settings.portrait.subtitle')}>
      {!repo ? (
        <p className="text-[13px] leading-5 text-[var(--ls-text-tertiary)]">
          {t('settings.learnerModel.emptyMode')}
        </p>
      ) : (
        <div className="flex flex-col" style={{ gap: '22px' }}>
          {/* 把握度模式总开关 */}
          <div>
            <div className="flex items-center justify-between flex-wrap" style={{ gap: '10px' }}>
              <div>
                <div className="text-[13px] font-medium leading-5">
                  {t('settings.portrait.modeLabel')}
                </div>
                <p className="text-[11px] leading-4 text-[var(--ls-text-tertiary)]" style={{ marginTop: '2px' }}>
                  {t('settings.portrait.modeHint')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => toggleMut.mutate(!enabled)}
                disabled={toggleMut.isPending}
                className="inline-flex items-center font-medium transition-colors duration-[var(--ls-duration-fast)]"
                style={{
                  height: '30px',
                  padding: '0 14px',
                  borderRadius: '6px',
                  fontSize: '12px',
                  border: `1px solid ${enabled ? 'var(--ls-text)' : 'var(--ls-border)'}`,
                  color: enabled ? 'var(--ls-text)' : 'var(--ls-text-secondary)',
                  background: enabled ? 'var(--ls-panel)' : 'transparent',
                }}
              >
                {enabled ? t('settings.portrait.modeOn') : t('settings.portrait.modeOff')}
              </button>
            </div>
            {changedAt && (
              <p className="text-[11px] leading-4 text-[var(--ls-text-tertiary)]" style={{ marginTop: '8px' }}>
                {t('settings.portrait.modeChangedPrefix')}
                {new Date(changedAt).toLocaleString()}
              </p>
            )}
          </div>

          {/* 映射锚值 (Confidence 主权立法, 学习者裁决版) — 映射权归学习者 */}
          {anchorsQ.data && (
            <ConfidenceAnchorsEditor
              anchors={anchorsQ.data}
              onSave={(next) => anchorsMut.mutate(next)}
              saving={anchorsMut.isPending}
            />
          )}

          {/* 校准曲线 */}
          <div>
            <div className="flex items-center justify-between flex-wrap" style={{ gap: '10px', marginBottom: '12px' }}>
              <h3 className="text-[11px] font-medium tracking-[0.05em] uppercase text-[var(--ls-text-tertiary)] leading-4">
                {t('settings.portrait.calibrationTitle')}
              </h3>
              {(coursesQ.data ?? []).length > 0 && (
                <select
                  value={courseId}
                  onChange={(e) => setCourseId(e.target.value as CourseId | '')}
                  className="border border-[var(--ls-border)] bg-[var(--ls-bg)] text-[var(--ls-text)] text-[12px] focus:outline-none focus:border-[var(--ls-border-strong)]"
                  style={{ height: '28px', padding: '0 8px', borderRadius: '6px' }}
                >
                  <option value="">{t('settings.portrait.allCourses')}</option>
                  {(coursesQ.data ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.topic}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {!anyBucketHasSamples ? (
              <p className="text-[13px] leading-5 text-[var(--ls-text-tertiary)]">
                {t('settings.portrait.calibrationEmpty')}
              </p>
            ) : (
              <>
                <CalibrationLegend />
                <ul className="flex flex-col" style={{ gap: '10px' }}>
                  {buckets.map((b) => (
                    <CalibrationBucketRow key={b.level} bucket={b} />
                  ))}
                </ul>
              </>
            )}
            <p className="text-[11px] leading-[16px] text-[var(--ls-text-tertiary)]" style={{ marginTop: '12px' }}>
              {t('settings.portrait.calibrationHint')}
            </p>
          </div>
        </div>
      )}
    </Section>
  );
}

/**
 * ConfidenceAnchorsEditor (Confidence 主权立法, 学习者裁决版) — 映射权归
 * 学习者: 三档按钮折算成数值时用的锚值, 在这里调, 0-100 整数、严格递增。
 * 教师侧没有对应的 MCP tool/resource——这份配置只活在这个组件和它调用的两条
 * REST 路由里 (见 lib/confidence-anchors.ts 顶部注释)。
 */
function ConfidenceAnchorsEditor({
  anchors,
  onSave,
  saving,
}: {
  anchors: ConfidenceAnchorConfig;
  onSave: (next: ConfidenceAnchorConfig) => void;
  saving: boolean;
}) {
  const { t } = useT();
  const [draft, setDraft] = useState<ConfidenceAnchorConfig>(anchors);
  const [justSaved, setJustSaved] = useState(false);

  // Server config changed under us (e.g. another tab saved) — resync, but
  // don't clobber an in-flight edit the learner hasn't saved yet.
  useEffect(() => {
    setDraft(anchors);
  }, [anchors.guess, anchors.likely, anchors.certain]);

  const error = validateConfidenceAnchors(draft);
  const dirty =
    draft.guess !== anchors.guess || draft.likely !== anchors.likely || draft.certain !== anchors.certain;

  return (
    <div>
      <h3
        className="text-[11px] font-medium tracking-[0.05em] uppercase text-[var(--ls-text-tertiary)] leading-4"
        style={{ marginBottom: '8px' }}
      >
        {t('settings.portrait.anchorsTitle')}
      </h3>
      <div className="flex flex-wrap items-end" style={{ gap: '14px' }}>
        {CONFIDENCE_LEVELS.map((level) => (
          <label key={level} className="flex flex-col" style={{ gap: '4px' }}>
            <span className="text-[11px] leading-4 text-[var(--ls-text-tertiary)]">
              {t(CONFIDENCE_LEVEL_LABEL_KEY[level])}
            </span>
            <input
              type="number"
              min={0}
              max={100}
              step={1}
              value={draft[level]}
              onChange={(e) => {
                setJustSaved(false);
                const n = Number(e.target.value);
                setDraft((d) => ({ ...d, [level]: Number.isFinite(n) ? Math.round(n) : d[level] }));
              }}
              className="border border-[var(--ls-border)] bg-[var(--ls-bg)] text-[var(--ls-text)] text-[13px] tabular-nums focus:outline-none focus:border-[var(--ls-border-strong)]"
              style={{ height: '30px', width: '64px', padding: '0 8px', borderRadius: '6px' }}
            />
          </label>
        ))}
        <button
          type="button"
          disabled={!dirty || !!error || saving}
          onClick={() => {
            onSave(draft);
            setJustSaved(true);
          }}
          className="inline-flex items-center font-medium border border-[var(--ls-border)] hover:bg-[var(--ls-panel)] disabled:opacity-50 transition-colors duration-[var(--ls-duration-fast)]"
          style={{ height: '30px', padding: '0 14px', borderRadius: '6px', fontSize: '12px' }}
        >
          {t('settings.portrait.anchorsSaveButton')}
        </button>
        {!dirty && justSaved && (
          <span className="text-[11px] leading-4 text-[var(--ls-text-tertiary)]">
            {t('settings.portrait.anchorsSaved')}
          </span>
        )}
      </div>
      {error && (
        <p className="text-[11px] leading-4" style={{ marginTop: '6px', color: 'var(--ls-risk)' }}>
          {t('settings.portrait.anchorsInvalid')}
        </p>
      )}
      <p className="text-[11px] leading-[16px] text-[var(--ls-text-tertiary)]" style={{ marginTop: '8px' }}>
        {t('settings.portrait.anchorsHint')}
      </p>
    </div>
  );
}

/** Legend for the water-level bars below — colors need a key exactly once,
 *  not per row (per-row repetition would be its own kind of duplicate
 *  info). Two entries only, no judgment words: 实际正确率 (fill) / 我的锚值
 *  (tick) — 零形容词铁律, this is the one place "偏低/偏高" would be tempting
 *  and is deliberately absent. */
function CalibrationLegend() {
  const { t } = useT();
  return (
    <div className="flex items-center flex-wrap" style={{ gap: '16px', marginBottom: '10px' }}>
      <span className="flex items-center text-[11px] text-[var(--ls-text-tertiary)]" style={{ gap: '6px' }}>
        <span
          aria-hidden="true"
          style={{ display: 'inline-block', width: '10px', height: '10px', background: 'var(--ls-structure)', borderRadius: '2px' }}
        />
        {t('settings.portrait.legendActual')}
      </span>
      <span className="flex items-center text-[11px] text-[var(--ls-text-tertiary)]" style={{ gap: '6px' }}>
        <span
          aria-hidden="true"
          style={{ display: 'inline-block', width: '2px', height: '12px', background: 'var(--ls-text)' }}
        />
        {t('settings.portrait.legendAnchor')}
      </span>
    </div>
  );
}

/** Hand-drawn water-level bar: fill = actual_correct_rate, thin vertical
 *  tick = this bucket's current anchor_pct (钦定: a line, not a triangle).
 *  Plain SVG, no chart library — vector-effect keeps the border/tick crisp
 *  at 1px regardless of how wide the row renders (viewBox stretches
 *  horizontally only; height is fixed, so nothing skews vertically). */
function ConfidenceWaterBar({ actualPct, anchorPct }: { actualPct: number; anchorPct: number }) {
  const W = 300;
  const H = 18;
  const fillW = (Math.max(0, Math.min(100, actualPct)) / 100) * W;
  const anchorX = (Math.max(0, Math.min(100, anchorPct)) / 100) * W;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      height={H}
      preserveAspectRatio="none"
      role="img"
      aria-label={`实际正确率 ${actualPct}%，我的锚值 ${anchorPct}%`}
    >
      <rect
        x={0.5}
        y={0.5}
        width={W - 1}
        height={H - 1}
        fill="var(--ls-bg-subtle)"
        stroke="var(--ls-border)"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
      <rect x={0} y={0} width={fillW} height={H} fill="var(--ls-structure)" />
      <line
        x1={anchorX}
        x2={anchorX}
        y1={0}
        y2={H}
        stroke="var(--ls-text)"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** One 自信度 vs 实际正确率 row — 档位词 + 次数 ×N + 水位条 (hand-drawn SVG,
 *  no chart library). anchor_pct used to sit as redundant "· 62%" text next
 *  to the level label; that's gone now that the same number renders as the
 *  tick on the bar itself (legend explains the tick once, above) — one
 *  source of truth per number, not two competing displays. 0 samples: whole
 *  row dims and no bar is drawn at all (不画水位, 不是画一条空水位) — thin-but-
 *  nonzero (<CALIBRATION_MIN_SAMPLES) keeps the pre-existing "显影中" honesty
 *  placeholder untouched. */
function CalibrationBucketRow({ bucket }: { bucket: CalibrationBucket }) {
  const { t } = useT();
  const empty = bucket.sample_count === 0;
  const thin = !empty && bucket.sample_count < CALIBRATION_MIN_SAMPLES;
  const actualPct = bucket.actual_correct_rate != null ? Math.round(bucket.actual_correct_rate * 100) : null;

  return (
    <li style={empty ? { opacity: 0.45 } : undefined}>
      <div className="flex items-baseline justify-between" style={{ marginBottom: '4px' }}>
        <span className="text-[13px] font-medium">{t(CONFIDENCE_LEVEL_LABEL_KEY[bucket.level])}</span>
        <span className="text-[11px] text-[var(--ls-text-tertiary)] tabular-nums">
          {t('settings.portrait.sampleCountPrefix')}
          {bucket.sample_count}
        </span>
      </div>
      {empty ? null : thin ? (
        <p className="text-[12px] leading-4 text-[var(--ls-text-tertiary)]">
          {t('settings.portrait.bucketThin')}
        </p>
      ) : (
        <div style={{ position: 'relative' }}>
          <ConfidenceWaterBar actualPct={actualPct ?? 0} anchorPct={bucket.anchor_pct} />
          <span
            className="tabular-nums"
            style={{
              position: 'absolute',
              right: '8px',
              top: '50%',
              transform: 'translateY(-50%)',
              fontSize: '10px',
              color: 'var(--ls-text)',
            }}
          >
            {actualPct}%
          </span>
        </div>
      )}
    </li>
  );
}

// 数据导出案 — 导出侧. "人可以暂停/导出/删除这段教学关系的数据" 的产品
// 承诺里，删除侧已散落在各页面的逐项删除动作，导出侧此前为零。安静的一个按钮：
// 拉全量 JSON bundle，浏览器直接落盘，不炫技、不加进度条剧场。
function DataPrivacySection() {
  const { t } = useT();
  const { pairId } = usePair();
  const [state, setState] = useState<'idle' | 'pending' | 'done' | 'error'>('idle');

  const handleExport = async () => {
    if (!pairId || state === 'pending') return;
    setState('pending');
    try {
      const res = await fetch(`${API_BASE_URL}/pairs/${pairId}/export`);
      if (!res.ok) throw new Error(`export failed: ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const dateStr = new Date().toISOString().slice(0, 10);
      const a = document.createElement('a');
      a.href = url;
      a.download = `learn-shell-export-${pairId}-${dateStr}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setState('done');
      window.setTimeout(() => setState('idle'), 1500);
    } catch {
      setState('error');
    }
  };

  return (
    <Section title={t('settings.dataPrivacy')} subtitle={t('settings.dataPrivacy.sub')}>
      <div className="flex flex-col" style={{ gap: '10px' }}>
        <p className="text-[13px] leading-5 text-[var(--ls-text-tertiary)]">
          {t('settings.dataPrivacy.exportDescription')}
        </p>
        <div className="flex items-center" style={{ gap: '10px' }}>
          <button
            type="button"
            onClick={handleExport}
            disabled={!pairId || state === 'pending'}
            className="inline-flex items-center border border-[var(--ls-border)] hover:bg-[var(--ls-panel)] disabled:opacity-50 transition-colors duration-[var(--ls-duration-fast)]"
            style={{ height: '30px', padding: '0 14px', borderRadius: '6px', fontSize: '12px' }}
          >
            {state === 'pending' ? t('settings.dataPrivacy.exportPending') : t('settings.dataPrivacy.exportButton')}
          </button>
          {state === 'done' && (
            <span className="text-[11px] text-[var(--ls-text-tertiary)]">
              {t('settings.dataPrivacy.exportDone')}
            </span>
          )}
          {state === 'error' && (
            <span className="text-[11px]" style={{ color: 'var(--ls-risk)' }}>
              {t('settings.dataPrivacy.exportFailed')}
            </span>
          )}
        </div>
      </div>
      {/* 数据真相案 — 数据真相白纸黑字: 旧的 "W9 待接入" 路线图脚注下线,
          换成这个 app 最有底气的一段话 (本地 Postgres, 数据不出机器)。 */}
      <p className="text-[13px] leading-5 text-[var(--ls-text-tertiary)]" style={{ marginTop: '14px' }}>
        {t('settings.dataPrivacy.localNote')}
      </p>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */

function Section({
  title,
  subtitle,
  children,
  defaultOpen = true,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section
      className="border-t border-[var(--ls-border)] first:border-t-0"
      style={{ paddingTop: '20px', paddingBottom: '4px', marginTop: '4px' }}
    >
      <header
        onClick={() => setOpen((o) => !o)}
        className="flex items-baseline justify-between cursor-pointer select-none"
      >
        <div>
          <h2 className="font-semibold text-[16px] leading-6">{title}</h2>
          {subtitle && (
            <p className="text-[12px] leading-[18px] text-[var(--ls-text-secondary)]" style={{ marginTop: '2px' }}>
              {subtitle}
            </p>
          )}
        </div>
        <span className="text-[16px] text-[var(--ls-text-tertiary)] tabular-nums">
          {open ? '−' : '+'}
        </span>
      </header>
      {open && <div style={{ marginTop: '16px' }}>{children}</div>}
    </section>
  );
}
