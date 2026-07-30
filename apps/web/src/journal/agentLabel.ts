// "{agent.display_name}的观察" 的称谓来源.
//
// 称谓体系落地前 (2026-07-07 前) 这里曾是个独立兜底：没有任何"称谓"消费点
// 可读 (Settings.tsx / PairProvider.tsx 全仓库搜过，都没有)，只能从原始
// agents 行拿 display_name 现凑。现在 apps/server/src/lib/context-brief.ts
// 的 identity 块是权威来源 (lib/identity.ts 的 useIdentity/cleanAgentName)，
// useJournalTimeline.ts 已切过去；这个文件只留下清洗 + 兜底两件小事。
import type { DictKey } from '../i18n/dict';
import { cleanAgentName } from '../lib/identity';

/** Re-exported under the journal-local name call sites already use — same
 *  strip-the-parenthetical cleanup (agents.display_name carries provenance
 *  like "某老师 (Claude Code · Opus)"), now backed by identity.agent.display_name
 *  instead of a raw agents-table read. */
export const shortAgentLabel = cleanAgentName;

/** identity 还没取回来 (或跑在 mock/empty 模式, 没有真实身份数据) 时的占位
 *  ——不留空，也不假装是谁. This is a dict key, not display text (this module
 *  has no hook access) — resolve it with `t()` at the consuming call site
 *  (useJournalTimeline.ts). */
export const AGENT_LABEL_FALLBACK: DictKey = 'journal.agentFallback';
