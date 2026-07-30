// Live Teaching "summon agent" prompt card — 召唤卡案 子项③ (UI half),
// v3 文案+落位改版 (召唤状态机 v3, 作者原句逐字执行),
// v3.1 信封减脂 (学习者裁决, 2026-07-18).
//
// v2 (召唤卡瘦身版) shrunk the card down to a single copy-me phrase, but that
// phrase itself grew into a whole watch-order — cadence, timeouts, sign-off
// clauses, contract-shaped, aimed at the agent being summoned. The v3
// review verdict: "我不会说请用 180bpm 的节奏，我只会红着眼求你快点" — a summon is a
// human calling for help, not a job posting. v3 split the card into a human
// line + a machine envelope; v3.1 then put the envelope itself on a diet:
//   - 一句人话 (large text): what a person would actually say out loud —
//     "teacher, so-and-so is waiting in the X classroom." No jargon.
//   - 一行机器行 (small monospace, single line): only what the agent can't
//     look up on its own — the lesson id — plus the pointer at the recipe
//     that carries all the actual watch-order rules:
//       LS: lesson={context_id} · 开工前先读 docs/recipes/bootstrap.md
//     v3's JSON block (pair_id / context_type / context_preview) is gone:
//     get_context answers all of that server-side, so shipping it in the
//     card was redundant weight (学习者裁决原话: "get_context 可自查,
//     不再随卡").
// Both copy together as one block (single button, same copy mechanism as
// before) — the human line is just visually its own line, not a separate
// affordance.
//
// Visibility (unchanged mechanics, now driven by the caller's state machine
// instead of a `sessionTerminal` prop — see Lesson.tsx's LiveTeaching,
// 召唤状态机 v3): the caller only mounts this component in its 'summon' branch
// (no session, or a cancelled/expired one) — never during an in-progress
// session (a disconnect there gets LiveDisconnectBanner instead, not this
// card — interrupting a lesson already underway was 召唤状态机 v3's 现病) and
// never once a session has completed (that lesson's live has graduated to
// read-only history, nothing left to summon). Internally this component
// still gates on:
//   - live data mode only (not mock/seeded) — no point summoning anything
//     against a scripted mock agent.
//   - agent bridge NOT online — reuses useAgentBridge()'s `online` boolean
//     (see shell/useAgentBridge.ts; 二裁 拆掉了曾经引用同一信号的顶栏
//     BridgeIndicator chip — 这里的读法不受影响) — no new
//     polling added here. `online` is server-computed from
//     bridge_states.online_until vs now (packages/contracts/src/teaching.ts
//     BridgeStatus.online) — an agent already reachable doesn't need a
//     human to go paste a summon phrase at it.
//
// Rendered by the caller as a plain child inside LiveTeaching's scrollable
// content column.
//
// 阅卷铃条款: variant='grading' 复用同一套视觉语言, 由
// DeclareCompletedSection (自习流, 不是 LiveTeaching) 在"已宣布学完、回路
// 未收口"时挂载 — 人话换成对学习者的搬运指引, 机器行换成自带 id/标题的收官
// 传呼, 复制只带机器行, 且不看 bridge online (细节见下方各分支注释)。
//
// 提示词是门铃, 不是说明书 (门铃提示词案 PIN1): 机器行原本逐字铺开整段收官到访
// (对账→补判→总评→反思→闭环→分岔→回执) — 那份步骤单本就活在
// close-teaching-loop 配方(阅卷铃义务小节)里, 铃自己重复一遍是维护双份真相
// 源。现在机器行只响铃 + 指一个路: id、标题、`recipe://close-teaching-loop`
// 指针, 长度/语气对齐 'summon' 变体的机器行(同样是"id + 指一份文档", 不是
// 工单)。
import { useRef, useState } from 'react';
import { useAgentBridge } from '../shell/useAgentBridge';
import { useRepositoryState } from '../repository';
import { useIdentity } from '../lib/identity';
import { useT } from '../i18n';

export default function SummonAgentCard({
  lessonTitle,
  contextId,
  variant = 'summon',
}: {
  /** Lesson title — used in the human line. */
  lessonTitle: string;
  /** lesson.id, pre-cast to string by the caller (same
   *  `as unknown as string` idiom Lesson.tsx already uses for
   *  context_id elsewhere) — the one field the machine line carries. */
  contextId: string;
  /** 情境变体 (验收回炉 2026-07-20): 三处召唤场景的劝语随场景区分 —
   *  'summon'=处女课(无提示行) · 'half'=半场未收官 · 'again'=完课再开。
   *  劝语只是一行前置小字, 人话/机器行/复制行为全部不变。
   *
   *  'grading' (阅卷铃条款): 宣布已学完后的判卷召唤 — 同一套
   *  人话+机器行视觉语言, 但语义反转了一处: 人话是对学习者说的搬运指引
   *  ("把下面这行交给你的老师"), 不是给老师看的召唤词本身 — 所以复制
   *  只带机器行, 人话不进剪贴板。标题行与劝语行都不渲染 (人话已经承担
   *  了标题的职责)。 */
  variant?: 'summon' | 'half' | 'again' | 'grading';
}) {
  const { kind } = useRepositoryState();
  const { online } = useAgentBridge();
  const { identity } = useIdentity();
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const [selectOnly, setSelectOnly] = useState(false);
  // 复制/全选的目标节点 — 非 grading 变体圈整块 (人话+机器行), grading 只圈
  // 机器行 (见 render 处注释), 所以放宽成 HTMLElement + callback ref。
  const containerRef = useRef<HTMLElement | null>(null);
  const setCopyTarget = (el: HTMLElement | null) => {
    containerRef.current = el;
  };

  // 'grading' 不看 bridge online (阅卷铃条款): 判卷是一份具体的工单 —
  // bridge 在线只说明 agent 可达, 不说明它知道该来收官; 召唤行仍然要由
  // 人递过去。live-mode-only 门保留 (mock 里没有真老师可召)。
  if (kind !== 'live' || (variant !== 'grading' && online)) return null;

  const learnerName = identity?.learner.display_name || t('lesson.live.summonDefaultLearner');
  const humanLine =
    variant === 'grading'
      ? t('lesson.progress.bellHuman')
      : t('lesson.live.summonHumanPrefix') +
        learnerName +
        t('lesson.live.summonHumanMiddle') +
        lessonTitle +
        t('lesson.live.summonHumanSuffix');

  // v3.1 机器行 (学习者裁决): single monospace line — lesson id + recipe
  // pointer, nothing else. The recipe path is part of the i18n string
  // itself (the whole line is 钦定 verbatim copy, not assembled config).
  // 'grading' 的机器行 (门铃提示词案 PIN1) 同款瘦身: id + 标题 + recipe://
  // close-teaching-loop 指针, 步骤单本身留在配方里不重复。
  const machineLine =
    variant === 'grading'
      ? t('lesson.progress.bellMachinePrefix') +
        contextId +
        t('lesson.progress.bellMachineMid') +
        lessonTitle +
        t('lesson.progress.bellMachineSuffix')
      : t('lesson.live.summonMachinePrefix') + contextId + t('lesson.live.summonMachineSuffix');
  // grading: 人话是给学习者的搬运指引, 不进剪贴板 — 只复制机器行。
  const copyText = variant === 'grading' ? machineLine : `${humanLine}\n${machineLine}`;

  const selectAll = () => {
    const el = containerRef.current;
    if (!el || typeof window === 'undefined') return;
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  };

  // Clipboard API unavailable (insecure context — the app served over plain
  // http on a LAN IP, 召唤卡瘦身版) — select the text, then try the legacy
  // execCommand('copy'), which still works without a secure context in every
  // major browser. Only if THAT fails do we leave it at "selected, press ⌘C
  // yourself" — and the button says so instead of silently pretending.
  const legacyCopy = () => {
    selectAll();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } else {
      setSelectOnly(true);
      window.setTimeout(() => setSelectOnly(false), 3_000);
    }
  };

  const handleCopy = () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard
        .writeText(copyText)
        .then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2_000);
        })
        .catch(() => legacyCopy());
      return;
    }
    legacyCopy();
  };

  return (
    <div className="flex flex-col" style={{ gap: '8px', flexShrink: 0 }}>
      {variant !== 'grading' && (
        <div className="text-[13px] leading-5 text-[var(--ls-text-secondary)]">
          {t('lesson.live.summonTitle')}
        </div>
      )}
      {(variant === 'half' || variant === 'again') && (
        <div className="text-[12px] leading-[18px] text-[var(--ls-text-tertiary)]">
          {t(variant === 'half' ? 'lesson.live.summonHalfHint' : 'lesson.live.summonAgainHint')}
        </div>
      )}
      <div
        className="relative border border-[var(--ls-border)] bg-[var(--ls-bg-subtle)]"
        style={{ padding: '10px 12px', borderRadius: '8px' }}
      >
        {/* grading: 复制/全选只圈机器行 (人话是给学习者的指引, 不进剪贴板),
            所以复制目标落在 <pre> 上; 其余变体仍圈整块。 */}
        <div ref={variant === 'grading' ? undefined : setCopyTarget} style={{ paddingRight: '58px' }}>
          {/* 人话行 — 大字，独立成行，可单独辨认/复制 */}
          <div
            className="text-[15px] leading-[22px] font-medium text-[var(--ls-text)]"
            style={{ marginBottom: '8px' }}
          >
            {humanLine}
          </div>
          {/* 机器行 — 等宽小字单行 (v3.1)，随人话一并复制 */}
          <pre
            ref={variant === 'grading' ? setCopyTarget : undefined}
            className="font-mono text-[11px] leading-[17px] text-[var(--ls-text-secondary)] whitespace-pre-wrap select-all"
            style={{ margin: 0 }}
          >
            {machineLine}
          </pre>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className="absolute inline-flex items-center border border-[var(--ls-border)] bg-[var(--ls-bg)] text-[var(--ls-text-secondary)] hover:bg-[var(--ls-panel)] transition-colors duration-[var(--ls-duration-fast)]"
          style={{
            top: '8px',
            right: '8px',
            height: '24px',
            padding: '0 8px',
            borderRadius: '6px',
            fontSize: '10px',
            lineHeight: '1',
          }}
        >
          {copied
            ? t('lesson.live.summonCopiedButton')
            : selectOnly
              ? t('lesson.live.summonSelectOnlyButton')
              : t('lesson.live.summonCopyButton')}
        </button>
      </div>
    </div>
  );
}
