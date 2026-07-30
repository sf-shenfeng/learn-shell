// Agent presence signal for the AdHoc surfaces (2026-07-12: distinguish
// "agent online" vs "async" on the FAB icon + skip the thinking indicator
// while async). No new backend surface — this reuses the existing bridge
// heartbeat protocol (Stage 7d, packages/contracts/src/teaching.ts):
// bridge_states.online_until, already written by live_heartbeat and already
// read by GET /teaching/bridge/pending. That endpoint is the agent's own
// poll loop; here the web UI polls the same boolean on a much slower (30s)
// cadence suited to a presence dot, not an agent turn loop.
import { useQuery } from '@tanstack/react-query';
import { useRepository } from '../repository';
import { usePair } from './PairProvider';
import type { BridgeStatus } from '@learn-shell/contracts';

const BRIDGE_POLL_MS = 30_000;

export function useAgentBridge(): { online: boolean; status: BridgeStatus | null } {
  const { pairId } = usePair();
  const repo = useRepository();
  // 二裁: 顶栏 BridgeIndicator chip (曾用同一 queryKey, 5s poll，让这里
  // "搭车"吃到更快的刷新) 已整灯拆除 —— 这个 queryKey 现在只有本 hook 一个
  // 消费者，独立按自己的 30s 节奏轮询，不再有别的观察者把它顶得更快。
  const query = useQuery({
    queryKey: ['bridge', 'pending', pairId, !!repo],
    queryFn: () =>
      pairId && repo ? repo.pollBridgePending(pairId) : Promise.resolve(null),
    enabled: !!pairId && !!repo,
    refetchInterval: BRIDGE_POLL_MS,
    staleTime: BRIDGE_POLL_MS,
  });
  const status = query.data?.bridge ?? null;
  return { online: !!status?.online, status };
}
