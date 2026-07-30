// apps/server/src/lib/hypothesis-lifecycle.ts — 假设生命周期纯判定核心。
//
// 三根柱子 (假设生命周期立法):
//   ① 生命周期: 没有证据喂养的假设会衰老。老师侧续期/修订/退役经
//      record_learner_hypothesis 的 hypothesis_id + action 扩展进来
//      (mcp/server.ts), DB 读写留在那边——这里只做无副作用的"行 + 动作 →
//      补丁或拒绝"判定, 好脱离数据库单测 (同 close-loop-guard /
//      validate-prep-core 的抽取纪律)。
//   ② 陈旧只在读取时现算, 永不落库: 事实只当扳机——stale 是报告里的一枚
//      轻标注, 不触发任何自动退役。
//   ③ 简报限载: get_learner_brief 至多携 BRIEF_HYPOTHESES_CAP 条, 尊重学习者
//      主权判决 (rejected/frozen 永不回简报), active+confirmed 优先,
//      按 last_evidence_at 降序。选择逻辑抽在 selectBriefHypotheses,
//      context-brief.ts 调用。
//
// 主权层级 (压倒一切, 与 REST /hypotheses/:id/review 的判决对齐):
//   confirmed/rejected/frozen 是学习者的判决。老师动作对它们的权限:
//     rejected/frozen — 三个动作全拒 (判决终局, 不许绕行复活或改写);
//     confirmed      — 只许 reinforce (续证据); revise/retire 拒
//                      (老师不得改写/退役学习者已采纳的判断)。
//   'expired' 是老师侧死状态 (retire/revise 的旧行归宿), 三个动作全拒
//   (死行不复活——新的观察走创建路径立新行)。

import type { LearnerHypothesisRow } from '../db/schema/teacher_growth';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 陈旧阈值 (天)。last_evidence_at 距今超过这个天数的假设, 在简报/报告里读作
 *  'stale'——纯 informational, 事实只当扳机: 不自动退役、不改状态、不落库。
 *  取 21 天 ≈ 三周教学节拍: 一门正常推进的课在三周内总会产生可归属的证据
 *  (作答/Live/评估); 三周没有任何证据喂养, 这条观察至少值得老师重新看一眼。 */
export const HYPOTHESIS_STALE_AFTER_DAYS = 21;

/** 简报限载: get_learner_brief 至多携带的假设条数 (默认口径)。 */
export const BRIEF_HYPOTHESES_CAP = 5;

/** 学习者主权判决状态 (REST review 写入)。 */
export const LEARNER_VERDICT_STATUSES = ['confirmed', 'rejected', 'frozen'] as const;

/** 永不回简报的状态: 学习者驳回/冻结 (主权判决) + 老师侧死状态 expired。 */
export const BRIEF_EXCLUDED_STATUSES = new Set(['rejected', 'frozen', 'expired']);

// ---------------------------------------------------------------------------
// ② 陈旧现算
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** 陈旧判定 — 读取时现算, 永不落库。lastEvidenceAt 为 null (仅迁移前的
 *  fixture/mock 可能) 时回落 createdAt: 出生时刻是最诚实的最近证据时刻,
 *  与迁移 0041 的回填口径同一。 */
export function isHypothesisStale(
  lastEvidenceAt: Date | null,
  createdAt: Date,
  now: Date
): boolean {
  const basis = lastEvidenceAt ?? createdAt;
  return now.getTime() - basis.getTime() > HYPOTHESIS_STALE_AFTER_DAYS * DAY_MS;
}

// ---------------------------------------------------------------------------
// ① 老师侧动作判定 (reinforce / revise / retire)
// ---------------------------------------------------------------------------

export type HypothesisAction = 'reinforce' | 'revise' | 'retire';

export const HYPOTHESIS_ACTIONS: HypothesisAction[] = ['reinforce', 'revise', 'retire'];

export function isHypothesisAction(value: string): value is HypothesisAction {
  return (HYPOTHESIS_ACTIONS as string[]).includes(value);
}

export interface HypothesisActionArgs {
  /** reinforce/revise 可附带的新证据 (session_event id 追加进
   *  evidence_event_ids——行内自有的证据账, 不另立列)。 */
  evidence_event_ids?: string[];
  /** revise 必填: 超越旧文本的新观察。 */
  observation?: string;
  /** revise 可选: 新置信度, 缺省沿用旧行。 */
  confidence?: number;
}

/** 行级字段补丁 (drizzle .set() 可直接用的形状)。 */
export interface HypothesisRowPatch {
  status?: string;
  observation?: string;
  confidence?: number;
  evidence_event_ids?: string[];
  last_evidence_at?: Date;
  updated_at: Date;
}

export type HypothesisActionPlan =
  | { kind: 'refused'; message: string }
  /** reinforce / retire — 原行打补丁。`fed`: 本次是否有真证据入账
   *  ——false 时 last_evidence_at 不动 (空证据不刷时间戳), 回执提示未计入
   *  喂养。retire 恒 false (退役不是证据, 既有语义)。 */
  | { kind: 'patch'; patch: HypothesisRowPatch; fed: boolean }
  /** revise — 旧行 expired, 新行超越 (keep history: 旧行留在表里就是历史)。
   *  `fed` 同上: 无新证据的 revise 新行沿用旧行的 last_evidence_at ——
   *  改写文本是叙事, 不是喂养。 */
  | {
      kind: 'supersede';
      fed: boolean;
      oldPatch: HypothesisRowPatch;
      newRow: {
        domain: string;
        observation: string;
        confidence: number;
        status: string;
        evidence_event_ids: string[];
        last_evidence_at: Date;
      };
    };

function mergedEvidence(row: LearnerHypothesisRow, extra: string[] | undefined): string[] {
  const merged = [...row.evidence_event_ids];
  for (const id of extra ?? []) if (!merged.includes(id)) merged.push(id);
  return merged;
}

/** 纯判定: 既有行 + 老师动作 → 补丁 / 超越 / 拒绝。主权层级见文件头注。 */
export function planHypothesisAction(
  row: LearnerHypothesisRow,
  action: HypothesisAction,
  args: HypothesisActionArgs,
  now: Date
): HypothesisActionPlan {
  if (row.status === 'rejected' || row.status === 'frozen') {
    return {
      kind: 'refused',
      message:
        `Hypothesis ${row.id} is in a learner-sovereign verdict state (${row.status}) — the verdict overrides everything; ` +
        `the teacher-side action (${action}) may not touch it. If there truly is new evidence, negotiate it in the first-person conversation with the learner — don't route around it.`,
    };
  }
  if (row.status === 'expired') {
    return {
      kind: 'refused',
      message:
        `Hypothesis ${row.id} is already dead (expired) — a dead row doesn't come back to life. A new observation goes through the creation path to start a new row ` +
        `(call record_learner_hypothesis without hypothesis_id/action).`,
    };
  }
  if (row.status === 'confirmed' && action !== 'reinforce') {
    return {
      kind: 'refused',
      message:
        `Hypothesis ${row.id} has already been adopted by the learner (confirmed) — the teacher may not revise/retire the learner's verdict ` +
        `(${action} refused). Only reinforce (add evidence) is allowed.`,
    };
  }

  // ① 空证据不刷时间戳: 生命周期的粮食必须是真证据。"有没有喂" 只看
  // 本次是否附带了新的 evidence_event_ids (非空数组); id 的真伪 (存在+归属)
  // 由调用方在进本函数之前用 lib/evidence-refs.ts 校验——纯核心不碰 DB。
  const hasNewEvidence = (args.evidence_event_ids?.length ?? 0) > 0;

  switch (action) {
    case 'reinforce':
      // 无新证据的 reinforce 不再是"免费续期": evidence_event_ids 不动、
      // last_evidence_at 不动, 只留 updated_at 痕迹——回执提示未计入喂养。
      return {
        kind: 'patch',
        fed: hasNewEvidence,
        patch: hasNewEvidence
          ? {
              evidence_event_ids: mergedEvidence(row, args.evidence_event_ids),
              last_evidence_at: now,
              updated_at: now,
            }
          : { updated_at: now },
      };
    case 'retire':
      // 老师判旧 — 与学习者的 reject 分属两支 (语义不混), 但归宿同为
      // 不回简报。last_evidence_at 不动: 退役不是证据。
      return { kind: 'patch', fed: false, patch: { status: 'expired', updated_at: now } };
    case 'revise': {
      const observation = args.observation?.trim();
      if (!observation) {
        return {
          kind: 'refused',
          message: 'revise requires a non-empty observation — the new text supersedes the old; no new text means no revise.',
        };
      }
      return {
        kind: 'supersede',
        fed: hasNewEvidence,
        oldPatch: { status: 'expired', updated_at: now },
        newRow: {
          domain: row.domain,
          observation,
          confidence: args.confidence ?? row.confidence,
          // 新行承接旧行的在场状态 (只可能是 tentative/active——判决态
          // 已在上面拦下): 修订不降级也不越级。
          status: row.status,
          evidence_event_ids: mergedEvidence(row, args.evidence_event_ids),
          // 无新证据 ⇒ 新行沿用旧行的喂养时刻 (回落 created_at 与 0041
          // 回填口径同一): 改写文本不是喂养。
          last_evidence_at: hasNewEvidence ? now : row.last_evidence_at ?? row.created_at,
        },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// ③ 简报限载选择 (context-brief.ts 调用)
// ---------------------------------------------------------------------------

export interface BriefHypothesisSelection {
  /** 携带的行 (≤ cap), 各自附陈旧标注。 */
  selected: { row: LearnerHypothesisRow; stale: boolean }[];
  /** 在册总数 (排除 rejected/frozen/expired 后)。 */
  inBookCount: number;
  /** 人话计数行; 在册为 0 时 null。 */
  countLine: string | null;
}

/** 简报选择: 尊重主权判决 (rejected/frozen 永不回简报; expired 同排),
 *  active+confirmed 优先于 tentative, 组内按 last_evidence_at 降序, 截取
 *  cap 条。陈旧标注随行现算 (最轻标注, 不改变排序资格)。 */
export function selectBriefHypotheses(
  rows: LearnerHypothesisRow[],
  cap: number,
  now: Date
): BriefHypothesisSelection {
  const inBook = rows.filter((r) => !BRIEF_EXCLUDED_STATUSES.has(r.status));
  const rank = (r: LearnerHypothesisRow) => (r.status === 'active' || r.status === 'confirmed' ? 0 : 1);
  const evidenceTime = (r: LearnerHypothesisRow) => (r.last_evidence_at ?? r.created_at).getTime();
  const ordered = [...inBook].sort((a, b) => rank(a) - rank(b) || evidenceTime(b) - evidenceTime(a));
  const selected = ordered
    .slice(0, cap)
    .map((row) => ({ row, stale: isHypothesisStale(row.last_evidence_at, row.created_at, now) }));
  return {
    selected,
    inBookCount: inBook.length,
    countLine:
      inBook.length > 0
        ? `${inBook.length} on record, brief carries only the ${selected.length} most recent with evidence`
        : null,
  };
}
