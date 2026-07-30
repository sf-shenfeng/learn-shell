// 顶栏名称数据驱动化: 顶栏 pair 名称从硬编码占位对名改数据驱动。
//
// 优先级（由 shell/AppShell.tsx 的 PairHeader 调用）：
//   1. identity — lib/identity.ts's useIdentity()，即 Settings 身份区块
//      （pages/Settings.tsx IdentitySection）编辑落库的 learner/agent
//      display_name（PATCH /pairs/:pairId/identity）。这就是设计要的
//      "Settings 自定义显示名"：这个字段已经存在，没有必要另建一份
//      localStorage 影子字段——两份数据源迟早会分叉，header 单独漂移出一个
//      跟别处（journal / 证书 / AdHocPanel 标题，称谓体系收尾 同一模式）不一致
//      的名字，反而是新 bug。
//   2. pairLearnerDisplayName / pairAgentDisplayName — shell/PairProvider.tsx
//      从 /pair/current 响应体防御式抽取的字段。今天后端不带这两个字段
//      （learner_agent_pairs 表只有 learner_id/agent_id），这一层目前总是
//      落空，纯前瞻：后端未来一旦直接在这条路由上返回，不用再走一遍这里。
//   3. 占位符 —— 不回退硬编码人名。
import { cleanAgentName, type IdentityBrief } from './identity';

export interface PairDisplayNameInput {
  identity?: IdentityBrief | null;
  pairLearnerDisplayName?: string | null;
  pairAgentDisplayName?: string | null;
}

export interface PairDisplayNamePlaceholders {
  learner: string;
  agent: string;
}

export interface PairDisplayName {
  learner: string;
  agent: string;
}

export function resolvePairDisplayName(
  input: PairDisplayNameInput,
  placeholders: PairDisplayNamePlaceholders
): PairDisplayName {
  if (input.identity) {
    return {
      learner: input.identity.learner.display_name,
      agent: cleanAgentName(input.identity.agent.display_name),
    };
  }
  if (input.pairLearnerDisplayName && input.pairAgentDisplayName) {
    return {
      learner: input.pairLearnerDisplayName,
      agent: cleanAgentName(input.pairAgentDisplayName),
    };
  }
  return { learner: placeholders.learner, agent: placeholders.agent };
}
