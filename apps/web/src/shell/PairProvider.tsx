import { useRepositoryState } from '../repository';
import { API_BASE_URL } from '../lib/apiBase';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { PairId, LearnerId } from '@learn-shell/contracts';

interface PairContextValue {
  pairId: PairId | null;
  learnerId: LearnerId | null;
  // 顶栏名称数据驱动化: defensive extraction of learner/agent display_name straight off
  // /pair/current's response body, in case a future backend revision starts
  // returning them there. Today it doesn't — learner_agent_pairs (apps/server/
  // src/db/schema/pair.ts) only carries learner_id/agent_id; display names
  // live on the separate learners/agents tables and only join in via
  // GET /pairs/:pairId/context (lib/identity.ts's useIdentity — the actual
  // wired "custom display name" source, see lib/pairDisplay.ts). These two
  // fields are forward-compat tier-2 ingredients, not the primary path.
  pairLearnerDisplayName: string | null;
  pairAgentDisplayName: string | null;
  // 焊缝修复 (并行工单续): true 当且仅当 live 模式下能确认"没有真
  // pair" —— 判定问的是 GET /api/onboarding/status 的 has_real_pair, 样板间
  // (is_demo=true, db:seed:demo 造的那份) 不算数, 不然数据库只有样板间时
  // pairMissing 永远是 false, 首跑页永不出现, 学习者无处登记名字。该端点
  // 404(旧后端没有这条路由)或不可达时, 整支回退到旧版直接问 /pair/current
  // 的判定 (兼容旧后端); fetch 失败(服务端不可达)依旧不算首跑, 那是连接
  // 问题——保持 false 让既有兜底行为不变。
  pairMissing: boolean;
  // 同一次 /onboarding/status 探测顺带带出的 demo_pair_count>0 —— 首跑页
  // 用来决定要不要露出"先逛逛样板间"的旁路链接。旧后端回退路径(没有这条
  // 端点)时探测不到, 保持 false 是安全默认(不多秀一个进不去的入口)。
  demoAvailable: boolean;
}

const PairContext = createContext<PairContextValue>({
  pairId: null,
  learnerId: null,
  pairLearnerDisplayName: null,
  pairAgentDisplayName: null,
  pairMissing: false,
  demoAvailable: false,
});

export function usePair(): PairContextValue {
  return useContext(PairContext);
}

// W1: hardcoded to the seeded fixture pair.
// W2: replaced by auth session lookup.
const SEEDED_PAIR_ID = 'pair_demo_cfa' as PairId;
const SEEDED_LEARNER_ID = 'lrn_demo' as LearnerId;

// 2026-07-11（bench 现场抓获，当时未归档）：hardcoded pair 使前端永远替
// pair_demo_cfa 查数据——任何第二个部署（bench/新用户）全页皆空。live 模式
// 下改为问后端 /pair/current（active pair），seeded/mock 保持原常量。
// 真正的 principal 解析属于信任边界工程，此处是它到来前的最小正确。
/** Defensive: pull `${role}_display_name` (flat) or `${role}.display_name`
 *  (nested) off an arbitrary JSON body, tolerating either shape a future
 *  /pair/current revision might use. Returns null rather than throwing. */
function extractDisplayName(body: unknown, role: 'learner' | 'agent'): string | null {
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;
  const flat = obj[`${role}_display_name`];
  if (typeof flat === 'string' && flat.trim()) return flat;
  const nested = obj[role];
  if (nested && typeof nested === 'object') {
    const nestedName = (nested as Record<string, unknown>).display_name;
    if (typeof nestedName === 'string' && nestedName.trim()) return nestedName;
  }
  return null;
}

export default function PairProvider({ children }: { children: ReactNode }) {
  const state = useRepositoryState();
  const live = state.kind === 'live';
  const [pair, setPair] = useState<{
    pairId: PairId;
    learnerId: LearnerId;
    pairLearnerDisplayName: string | null;
    pairAgentDisplayName: string | null;
  }>({
    pairId: SEEDED_PAIR_ID,
    learnerId: SEEDED_LEARNER_ID,
    pairLearnerDisplayName: null,
    pairAgentDisplayName: null,
  });
  // 焊缝修复: 首跑等待态判定改问 /onboarding/status (has_real_pair — 样板间
  // 不算数), 5s 轻轮询与 pair 出生自动翻回的节奏不变: agent 那边 create_pair
  // 一落地, 这里自己发现, 首跑页自动让路, 不需要学习者刷新。
  const [pairMissing, setPairMissing] = useState(false);
  const [demoAvailable, setDemoAvailable] = useState(false);
  useEffect(() => {
    if (!live) {
      setPairMissing(false);
      setDemoAvailable(false);
      return;
    }
    let cancelled = false;
    let timer: number | undefined;

    // 旧版判定: 直接问 /pair/current, 明确"没有 pair"(200 空 body 或 404)
    // 才算首跑。/onboarding/status 404(旧后端)或不可达时整支回退到这里
    // ——兼容旧后端, 且不改动 pair 身份数据(pairId/学习者显示名等)的取数
    // 来源。legacyGate=true 时才据此结果推 pairMissing + 排下一轮轮询;
    // legacyGate=false 时只用它来补齐真 pair 已确认存在时的身份数据。
    const fetchPairCurrent = async (legacyGate: boolean) => {
      try {
        const res = await fetch(`${API_BASE_URL}/pair/current`);
        if (!res.ok && res.status !== 404) return; // server error — 保持兜底
        const p = res.status === 404 ? null : await res.json().catch(() => null);
        if (cancelled) return;
        if (p?.id && p?.learner_id) {
          if (legacyGate) setPairMissing(false);
          setPair({
            pairId: p.id as PairId,
            learnerId: p.learner_id as LearnerId,
            pairLearnerDisplayName: extractDisplayName(p, 'learner'),
            pairAgentDisplayName: extractDisplayName(p, 'agent'),
          });
        } else if (legacyGate) {
          setPairMissing(true);
          timer = window.setTimeout(probe, 5_000);
        }
      } catch {
        /* 保持 seeded 兜底 */
      }
    };

    const probe = async () => {
      let handledByStatus = false;
      try {
        const statusRes = await fetch(`${API_BASE_URL}/onboarding/status`);
        if (statusRes.ok) {
          const status = await statusRes.json().catch(() => null);
          if (status && typeof status.has_real_pair === 'boolean') {
            handledByStatus = true;
            if (cancelled) return;
            setDemoAvailable((status.demo_pair_count ?? 0) > 0);
            if (status.has_real_pair) {
              setPairMissing(false);
              await fetchPairCurrent(false); // 补齐身份数据, 不重复判定
            } else {
              setPairMissing(true);
              timer = window.setTimeout(probe, 5_000);
            }
          }
        }
        // !res.ok (含 404) 或响应体不含预期字段 — 旧后端没有这条端点,
        // 落到下面的回退分支。
      } catch {
        /* 不可达 — 落到下面的回退分支, 由它自己的 catch 兜住"不算首跑" */
      }
      if (!handledByStatus) {
        await fetchPairCurrent(true);
      }
    };

    void probe();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [live]);
  return (
    <PairContext.Provider value={{ ...pair, pairMissing, demoAvailable }}>
      {children}
    </PairContext.Provider>
  );
}
