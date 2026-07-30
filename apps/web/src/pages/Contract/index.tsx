import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import type { TeachingContract } from '@learn-shell/contracts';
import { useRepository } from '../../repository';
import { usePair } from '../../shell/PairProvider';
import { useIdentity, cleanAgentName } from '../../lib/identity';
import { useT } from '../../i18n';
import type { DictKey } from '../../i18n/dict';

/**
 * Contract — single-contract signing table (route: /contract/:contractId).
 *
 * 裁决 (2026-07-08, "Contract 页降维为证书组件"): the intake dialogue
 * that used to live on this page is dead — 立约对话 now happens in the
 * native user↔agent channel, and
 * the agent hands LS a finished draft via the `propose_contract` MCP tool
 * (setup_status: 'proposed'). This page's only remaining job is the part
 * that *can't* move off-surface: the actual signature.
 *
 * 证书揭示改版 (2026-07-11, 真机复测拆除签署流水线遗迹): the
 * post-Establish "组合课程" animation (WorkflowComposingView) and the
 * Generate Outline → lesson-selection → §6.8 备课 progress screen
 * (ContractCardView/ContractActionArea/LessonSelectionView/
 * ContractLoadingScreen) are gone — building the course is the agent's job
 * via MCP tools now (create_course/add_lesson/…), not a UI-driven pipeline.
 * Establish now goes straight from the signing form to a certificate-card
 * preview (same visual as Settings' certificate, see
 * `CertificatePreviewCard` below) with a brief existing-token transition,
 * then hands off to /settings with the new contract's id flagged for a
 * short highlight there. "证书的诞生不比一次翻页更隆重" — the phrase that names
 * the whole point of this change.
 *
 * 证书居中停留改版 (2026-07-17 实测三症修缮 — refines 证书揭示改版, does not reopen it;
 * no new animation species, no stamps/confetti, still the same live-card-
 * enter/220ms token language): the reveal (1) no longer auto-redirects on a
 * timer — it holds until the learner acts (CTA / click outside the card /
 * Esc), see `CertificateRevealView`'s `onFile`; (2) renders in a page-
 * centered overlay (`position: fixed; inset: 0`, same escape-AppShell's-
 * column trick as shell/FocusOverlay.tsx, same backdrop convention as
 * Cards.tsx's import modal / CommandPalette) instead of inline in the
 * signing table's document flow, which is why it used to land hugging the
 * top of the viewport; (3) the Establish mutation now invalidates
 * `['contracts', pairId]` and `['contract', pairId]` on success so Settings'
 * certificate block / archive / active-contract cadence view aren't
 * showing 30s-stale data (main.tsx's global `staleTime: 30_000`) until a
 * manual refresh — same write-side invalidation asymmetry as 批注计数同步案①,
 * see annotation/host.ts's `journalHostQueryKey` doc comment for the
 * precedent ("shared key, no shared code").
 *
 * Any contract this page is asked to show that *isn't* `proposed` (already
 * established / mid old-pipeline leftover data / ready) has nothing left
 * for this page to do — it bounces to /settings, where the certificate +
 * archive already know how to display every one of those states.
 *
 * The page is reached two ways: (1) the RecentRail "待签之约" row / top-bar
 * chip when a `proposed` contract is waiting, or (2) a "continue setup →"
 * link from the Settings certificate archive for a contract stuck
 * mid-pipeline (that link now just bounces back here → /settings, see
 * 证书揭示改版 report). Bare `/contract` (no id) or an id that doesn't
 * resolve redirects to /settings too.
 */

/**
 * Editable contract draft shown in the signing card. Field names + enum
 * values align with packages/contracts/src/pair.ts TeachingContract schema.
 */
interface ProposalDraft {
  goal: string;
  timeline: string;
  baseline: string;
  success_criteria?: string[];
  intensity: 'relaxed' | 'standard' | 'hardcore';
  content_modality: 'text' | 'visual' | 'mixed';
  interaction_mode: 'async' | 'realtime' | 'hybrid';
  pace: 'daily' | 'weekly' | 'flexible';
}

// ---- component ----

export default function Contract() {
  const { contractId } = useParams<{ contractId: string }>();
  const repo = useRepository();
  const { pairId } = usePair();
  const { t } = useT();
  const navigate = useNavigate();

  const contractsQ = useQuery({
    queryKey: ['contracts', pairId],
    queryFn: () =>
      repo && pairId
        ? repo.getAllContracts(pairId)
        : Promise.resolve([] as TeachingContract[]),
    enabled: !!repo && !!pairId,
  });

  const contract = (contractsQ.data ?? []).find((c) => c.id === contractId);

  // Holds the just-PATCHed contract for the certificate-reveal beat below —
  // rendered from this local copy rather than the live query so a stray
  // refetch mid-transition can't yank the view out from under it.
  const [justEstablished, setJustEstablished] =
    useState<TeachingContract | null>(null);

  // 证书居中停留改版: no more timer — filing happens only on the learner's own
  // action (CTA / backdrop click / Esc, all routed through this one
  // function by CertificateRevealView).
  const fileCertificate = () => {
    if (!justEstablished) return;
    navigate(
      `/settings?highlightContract=${encodeURIComponent(justEstablished.id)}`,
      { replace: true }
    );
  };

  if (!repo) {
    return (
      <p className="text-sm text-[var(--ls-text-secondary)]">
        {t('contract.emptyMode')}
      </p>
    );
  }

  if (justEstablished) {
    return (
      <CertificateRevealView
        contract={justEstablished}
        onFile={fileCertificate}
      />
    );
  }

  if (contractsQ.isLoading) {
    return (
      <p className="text-[13px] text-[var(--ls-text-tertiary)]">
        {t('contract.loading')}
      </p>
    );
  }

  // No id, or the id doesn't resolve to a contract this pair can see — the
  // signing table has nothing to do here. Land on Settings, where the
  // certificate + archive live.
  if (!contractId || !contract) {
    return <Navigate to="/settings" replace />;
  }

  // Anything past 'proposed' has no more UI work on this page (证书揭示改版 —
  // outline/lesson-selection/generating were the only reasons this page did
  // anything with a non-proposed contract, and that whole pipeline is gone).
  //
  // 迁移 0027 (Void 机制): a still-`proposed` draft can also be voided
  // (withdrawn) before the learner ever signs it — either party can do
  // this (MCP void_contract for the agent, Settings' certificate/archive
  // UI for the learner — the void entry
  // point itself deliberately lives there and not on this page). A voided draft has
  // nothing left to sign either, same as any non-proposed contract — bounce
  // it to /settings rather than rendering a live Establish button over a
  // withdrawn proposal.
  if (contract.setup_status !== 'proposed' || contract.voided_at) {
    return <Navigate to="/settings" replace />;
  }

  return (
    <>
      <div
        className="flex items-baseline justify-between flex-wrap"
        style={{ gap: '10px', marginBottom: '4px' }}
      >
        <h1
          className="font-bold text-[24px] leading-[32px] tracking-[-0.02em]"
          style={{ margin: 0 }}
        >
          {t('contract.title')}
        </h1>
        <Link
          to="/settings"
          className="text-[12px] hover:underline"
          style={{ color: 'var(--ls-text-tertiary)' }}
        >
          {t('contract.backToSettings')}
        </Link>
      </div>
      <p
        className="text-[13px] leading-5 text-[var(--ls-text-secondary)]"
        style={{ marginBottom: '24px', maxWidth: '580px' }}
      >
        {t('contract.subtitleProposed')}
      </p>

      <div style={{ maxWidth: '760px' }}>
        <ProposedContractCardView
          contract={contract}
          onEstablished={setJustEstablished}
        />
      </div>
    </>
  );
}

/**
 * CertificateRevealView — 证书揭示改版, refined by 证书居中停留改版. The post-Establish
 * "workflow" is still just this: fade the certificate card in with the
 * same existing live-card-enter token (global.css, 240ms, already used for
 * Live Teaching card entrances). No stamps, no confetti, no new keyframe.
 *
 * 证书居中停留改版 changes only the *frame* around that same card: it now sits in
 * a page-centered `position: fixed; inset: 0` overlay — the same trick
 * shell/FocusOverlay.tsx uses to escape AppShell's centred maxWidth column
 * regardless of where in the DOM it mounts — instead of inline in the
 * signing table's normal document flow (which is why it used to render
 * hugging the top of the page, under the h1/subtitle it had just replaced).
 * The dim/blur backdrop is the same convention as Cards.tsx's import modal
 * and shell/CommandPalette.tsx, not a new visual species.
 *
 * It also no longer times itself out — it holds until the learner acts.
 * `onFile` (passed down from Contract()) is the single exit: the CTA
 * button, a click on the backdrop (outside the card), and Escape all call
 * it once. Clicking the card itself does nothing (stopPropagation on the
 * inner wrapper) — it's still there to be read, not just glanced at.
 */
function CertificateRevealView({
  contract,
  onFile,
}: {
  contract: TeachingContract;
  onFile: () => void;
}) {
  const { t } = useT();
  const { identity } = useIdentity();
  const studentName = identity
    ? identity.learner.display_name
    : t('settings.certificate.studentFallback');
  const teacherName = identity
    ? cleanAgentName(identity.agent.display_name)
    : t('settings.certificate.teacherFallback');

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onFile();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onFile]);

  return (
    <div
      onClick={onFile}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-[2px]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('contract.certificateReveal.dialogLabel')}
        className="live-card-enter"
        style={{ maxWidth: '520px', width: '92vw' }}
      >
        <CertificatePreviewCard
          contract={contract}
          studentName={studentName}
          teacherName={teacherName}
        />
        <div className="flex justify-center" style={{ marginTop: '18px' }}>
          <button
            type="button"
            onClick={onFile}
            className="inline-flex items-center bg-[var(--ls-text)] text-[var(--ls-bg)] font-medium hover:opacity-90 transition-opacity duration-[var(--ls-duration-fast)]"
            style={{
              height: '36px',
              padding: '0 18px',
              borderRadius: '6px',
              fontSize: '13px',
              lineHeight: '1',
            }}
          >
            {t('contract.certificateReveal.fileCta')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * CertificatePreviewCard — same "document, not a field-list" visual as
 * Settings.tsx's CertificateCard. Duplicated rather than exported across
 * the page boundary (same convention Settings.tsx already uses for the
 * reminder label maps — see its own header comment).
 */
function CertificatePreviewCard({
  contract,
  studentName,
  teacherName,
}: {
  contract: TeachingContract;
  studentName: string;
  teacherName: string;
}) {
  const { t } = useT();
  const signedDate = new Date(contract.time_range.start).toLocaleDateString();
  const terms = [
    contract.intensity,
    contract.pace,
    contract.content_modality,
    contract.interaction_mode,
  ].filter(Boolean);

  return (
    <div
      className="mx-auto w-full"
      style={{
        maxWidth: '520px',
        border: '1px solid var(--ls-border-strong)',
        borderRadius: '10px',
        padding: '30px 34px',
        textAlign: 'center',
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
    </div>
  );
}

// ---- subcomponents ----

function formatTimeRange(
  tr: { start: string; end_target?: string },
  t: (key: DictKey) => string
): string {
  const start = tr.start.slice(0, 10);
  if (tr.end_target) {
    return `${start} → ${tr.end_target.slice(0, 10)}`;
  }
  return `${t('contract.pipeline.timeRangeSince')}${start}`;
}

// ---- ProposedContractCardView (CONTRACT-NATIVE-INTAKE-BRIEF §1.1 signing
// table — the view for a `proposed` contract) ----
//
// The *only* entry point into the signing flow now (the chat-driven
// Establish path that used to sit alongside it is gone — see the module
// doc comment at the top of this file). Same ProposalCard (Class B knobs)
// and EstablishBar as before; the Class C RemindersBlock is gone (
// 节奏条款改革 — LS never dispatched a reminder from those fields; 节奏归合约的
// cadence 条款, 立钟归 agent/学习者的原生工具). Establish here PATCHes the
// already-persisted contract (repo.updateContract) since the row already
// exists (MCP wrote it in as `proposed`). On success it hands the updated
// contract up to the page via `onEstablished` so the certificate-reveal
// beat (证书揭示改版) runs.
function ProposedContractCardView({
  contract,
  onEstablished,
}: {
  contract: TeachingContract;
  onEstablished: (contract: TeachingContract) => void;
}) {
  const repo = useRepository();
  const { pairId } = usePair();
  const qc = useQueryClient();
  const { t } = useT();

  const draftFromContract = (): ProposalDraft => ({
    goal: contract.goal,
    timeline: formatTimeRange(contract.time_range, t),
    baseline: '',
    success_criteria: contract.success_criteria,
    intensity: contract.intensity,
    content_modality: contract.content_modality,
    interaction_mode: contract.interaction_mode,
    pace: contract.pace ?? 'flexible',
  });
  const [draft, setDraft] = useState<ProposalDraft>(draftFromContract);

  const establishMut = useMutation({
    mutationFn: async () => {
      if (!repo) throw new Error('no repo');
      // 节奏条款改革 — the reminder fields (accepts_reminders / channels / types
      // / do_not_disturb / ical_subscription_url) are no longer collected at
      // the signing table; the row keeps whatever schema defaults it was
      // proposed with.
      return repo.updateContract(contract.id, {
        intensity: draft.intensity,
        content_modality: draft.content_modality,
        interaction_mode: draft.interaction_mode,
        pace: draft.pace,
        setup_status: 'established',
      });
    },
    onSuccess: (updated) => {
      // 证书居中停留改版③: this PATCH is the only write path that flips a contract
      // to 'established' — Settings' certificate block/archive
      // (Settings.tsx's contractsQ) and this very page's own contractsQ
      // above all key off `['contracts', pairId]` (see those files' own
      // "shares this key" comments), and Settings' CadenceSection keys off
      // `['contract', pairId]` (getActiveContract picks the newest
      // signed+non-terminal row — 'established' qualifies, see
      // repository/currentContract.ts). Neither was being invalidated, so
      // Settings kept showing pre-establish data for up to 30s (main.tsx's
      // global staleTime) until a manual refresh — same write-side
      // asymmetry as 批注计数同步案①, see annotation/host.ts's
      // journalHostQueryKey doc comment for the precedent.
      qc.invalidateQueries({ queryKey: ['contracts', pairId] });
      qc.invalidateQueries({ queryKey: ['contract', pairId] });
      onEstablished(updated);
    },
  });

  return (
    <div className="flex flex-col" style={{ gap: '20px' }}>
      <ProposalCard
        draft={draft}
        onChange={(next) => setDraft((d) => ({ ...d, ...next }))}
      />
      <EstablishBar
        onEstablish={() => establishMut.mutate()}
        onStartOver={() => setDraft(draftFromContract())}
        disabled={establishMut.isPending}
        isPending={establishMut.isPending}
      />
    </div>
  );
}

function ProposalCard({
  draft,
  onChange,
}: {
  draft: Partial<ProposalDraft>;
  onChange: (next: Partial<ProposalDraft>) => void;
}) {
  const { t } = useT();
  const update = <K extends keyof ProposalDraft>(
    key: K,
    value: ProposalDraft[K]
  ) => onChange({ ...draft, [key]: value });

  return (
    <div
      className="border border-[var(--ls-border-strong)] bg-[var(--ls-bg)]"
      style={{
        borderRadius: '10px',
        overflow: 'hidden',
      }}
    >
      {/* header */}
      <div
        className="flex items-center justify-between border-b border-[var(--ls-border)] bg-[var(--ls-panel)]"
        style={{ padding: '10px 14px', gap: '10px' }}
      >
        <div className="text-[11px] uppercase tracking-[0.06em] font-medium text-[var(--ls-text-secondary)]">
          {t('contract.pipeline.proposedHeader')}
        </div>
        <div className="text-[10px] text-[var(--ls-text-tertiary)] tracking-[0.04em]">
          {t('contract.pipeline.editableHint')}
        </div>
      </div>

      {/* readonly summary */}
      <div className="flex flex-col" style={{ padding: '14px 16px', gap: '10px' }}>
        <ProposalRow label={t('contract.pipeline.goalLabel')} value={draft.goal} />
        <ProposalRow label={t('contract.pipeline.timelineLabel')} value={draft.timeline} />
        <ProposalRow label={t('contract.pipeline.baselineLabel')} value={draft.baseline} />
        {draft.success_criteria && draft.success_criteria.length > 0 && (
          <ProposalRow
            label={t('contract.pipeline.successLabel')}
            value={draft.success_criteria.join(' · ')}
          />
        )}
      </div>

      {/* divider */}
      <div
        className="text-[10px] uppercase tracking-[0.06em] text-[var(--ls-text-tertiary)] border-t border-[var(--ls-border)]"
        style={{ padding: '10px 16px 4px' }}
      >
        {t('contract.pipeline.prefilledHint')}
      </div>

      {/* editable preferences */}
      <div
        className="flex flex-col"
        style={{ padding: '6px 16px 16px', gap: '12px' }}
      >
        <ProposalEditRow label={t('contract.pipeline.intensityLabel')}>
          <Segmented
            value={draft.intensity ?? 'standard'}
            options={['relaxed', 'standard', 'hardcore'] as const}
            onChange={(v) => update('intensity', v)}
          />
        </ProposalEditRow>
        <ProposalEditRow label={t('contract.pipeline.modalityLabel')}>
          <Segmented
            value={draft.content_modality ?? 'mixed'}
            options={['text', 'visual', 'mixed'] as const}
            onChange={(v) => update('content_modality', v)}
          />
        </ProposalEditRow>
        <ProposalEditRow label={t('contract.pipeline.interactionLabel')}>
          <Segmented
            value={draft.interaction_mode ?? 'hybrid'}
            options={['async', 'hybrid', 'realtime'] as const}
            onChange={(v) => update('interaction_mode', v)}
          />
        </ProposalEditRow>
        <ProposalEditRow label={t('contract.pipeline.paceLabel')}>
          <Segmented
            value={draft.pace ?? 'flexible'}
            options={['daily', 'weekly', 'flexible'] as const}
            onChange={(v) => update('pace', v)}
          />
        </ProposalEditRow>
      </div>
    </div>
  );
}

function ProposalRow({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex" style={{ gap: '14px' }}>
      <div
        className="flex-none text-[11px] uppercase tracking-[0.06em] text-[var(--ls-text-tertiary)]"
        style={{ width: '78px', paddingTop: '2px' }}
      >
        {label}
      </div>
      <div className="flex-1 min-w-0 text-[13px] leading-5 text-[var(--ls-text)]">
        {value || (
          <span className="text-[var(--ls-text-tertiary)] italic">—</span>
        )}
      </div>
    </div>
  );
}

function ProposalEditRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center" style={{ gap: '14px' }}>
      <div
        className="flex-none text-[11px] uppercase tracking-[0.06em] text-[var(--ls-text-tertiary)]"
        style={{ width: '78px' }}
      >
        {label}
      </div>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly T[];
  onChange: (next: T) => void;
}) {
  return (
    <div
      className="inline-flex border border-[var(--ls-border)] overflow-hidden"
      style={{ borderRadius: '6px' }}
    >
      {options.map((opt, i) => {
        const on = opt === value;
        return (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(opt)}
            className="font-medium transition-colors duration-[var(--ls-duration-fast)]"
            style={{
              padding: '6px 12px',
              fontSize: '11px',
              lineHeight: '1',
              background: on ? 'var(--ls-panel)' : 'transparent',
              color: on ? 'var(--ls-text)' : 'var(--ls-text-secondary)',
              borderLeft: i > 0 ? '1px solid var(--ls-border)' : 'none',
            }}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}

function EstablishBar({
  onEstablish,
  onStartOver,
  disabled,
  isPending,
}: {
  onEstablish: () => void;
  onStartOver: () => void;
  disabled: boolean;
  isPending: boolean;
}) {
  const { t } = useT();
  return (
    <div className="flex items-center flex-wrap" style={{ gap: '14px' }}>
      <button
        type="button"
        onClick={onEstablish}
        disabled={disabled}
        className="inline-flex items-center bg-[var(--ls-text)] text-[var(--ls-bg)] font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity duration-[var(--ls-duration-fast)]"
        style={{
          height: '38px',
          padding: '0 18px',
          borderRadius: '6px',
          fontSize: '13px',
          lineHeight: '1',
        }}
      >
        {isPending ? t('contract.pipeline.establishingEllipsis') : t('contract.pipeline.establishButton')}
      </button>
      <button
        type="button"
        onClick={onStartOver}
        disabled={isPending}
        className="inline-flex items-center border border-[var(--ls-border)] text-[var(--ls-text-secondary)] hover:bg-[var(--ls-panel)] disabled:opacity-40 disabled:cursor-not-allowed font-medium transition-colors duration-[var(--ls-duration-fast)]"
        style={{
          height: '38px',
          padding: '0 16px',
          borderRadius: '6px',
          fontSize: '13px',
          lineHeight: '1',
        }}
      >
        {t('contract.pipeline.resetButton')}
      </button>
      <span className="text-[12px] leading-[18px] text-[var(--ls-text-tertiary)]">
        {t('contract.pipeline.establishHint')}
      </span>
    </div>
  );
}

