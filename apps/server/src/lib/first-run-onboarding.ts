// apps/server/src/lib/first-run-onboarding.ts — 首跑入学核心
//
// 红队 P0-04: pair/learner/agent 此前唯一出生通道是 seed —— 不 seed 无法
// 开始, seed 了无法真入学。本文件是两扇新门的共用核心 (纯逻辑+DB, 不碰
// MCP transport, 可被单测直接 import —— mcp/server.ts import 时会开 stdio
// transport, 测试进不去, 同 lib/tool-envelope.ts 的抽取理由):
//
//   1. registerLearner — REST POST /api/onboarding/learner 的落点。
//      学习者的名字是主权动作, 必须由学习者本人在首跑页亲手输入 (设计单裁定,
//      设计单 §〇-2); 这里只负责把亲手敲下的名字落成一行未配对 learner。
//      幂等: 同名未配对 learner 已存在 ⇒ 返回既有行, 不重复建。
//      无鉴权 —— v1 单机信任模型 (同 README 安全声明)。
//
//   2. createPairForRegisteredLearner — MCP create_pair (唯一真入学正门)
//      的落点。按 display_name 找任务 1 登记的未配对 learner:
//        · 查无此名 ⇒ NOT_FOUND, recovery 指路首跑页 (agent 代填即越权);
//        · 同名 learner 已有 active pair ⇒ CONFLICT, 指路既有关系;
//        · 找到未配对行 ⇒ 建 agent 行 + pair 行 (established_at=now,
//          is_demo=false —— 真 pair, 参见 schema/pair.ts is_demo 注)。

import { asc, eq, inArray } from 'drizzle-orm';
import { db, type DbClient } from '../db/client';
import { agents, learner_agent_pairs, learners } from '../db/schema';
import { McpToolError, notFoundError } from './mcp-errors';

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// display_name 尺子 — trim 后 1-80 字符 (REST 与 MCP 两侧同一把)。
export const LEARNER_NAME_MAX_CHARS = 80;

export function normalizeLearnerDisplayName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > LEARNER_NAME_MAX_CHARS) return null;
  return trimmed;
}

export interface RegisterLearnerResult {
  learner_id: string;
  display_name: string;
  /** true = 命中既有未配对同名行 (幂等重放), false = 本次新建。 */
  reused: boolean;
}

/** 找同名 learner 中"未配对"(名下无 active pair)的那一行 — 最早注册者优先。
 *  返回 null = 同名者要么不存在、要么全都已有 active pair。 */
async function findUnpairedLearnerByName(
  displayName: string,
  dbClient: DbClient
): Promise<{ unpaired: { id: string } | null; activePairId: string | null }> {
  const sameName = await dbClient
    .select({ id: learners.id })
    .from(learners)
    .where(eq(learners.display_name, displayName))
    .orderBy(asc(learners.created_at));
  if (sameName.length === 0) return { unpaired: null, activePairId: null };

  // active 判定: learner_agent_pairs.active=true 的行才占户口; 历史
  // inactive pair 不挡再入学。一刀把 active 列带出来判 (单机规模行数个位数)。
  const pairRows = await dbClient
    .select({
      id: learner_agent_pairs.id,
      learner_id: learner_agent_pairs.learner_id,
      active: learner_agent_pairs.active,
    })
    .from(learner_agent_pairs)
    .where(
      inArray(
        learner_agent_pairs.learner_id,
        sameName.map((l) => l.id)
      )
    );
  const activeSet = new Map<string, string>();
  for (const p of pairRows) {
    if (p.active) activeSet.set(p.learner_id, p.id);
  }

  const unpaired = sameName.find((l) => !activeSet.has(l.id)) ?? null;
  const firstActivePairId = sameName
    .map((l) => activeSet.get(l.id))
    .find((v): v is string => !!v) ?? null;
  return { unpaired, activePairId: firstActivePairId };
}

/** REST POST /api/onboarding/learner 的核心。displayName 须已过
 *  normalizeLearnerDisplayName。 */
export async function registerLearner(
  displayName: string,
  locale?: string,
  dbClient: DbClient = db
): Promise<RegisterLearnerResult> {
  // 幂等: 同名"未配对"learner 已存在 ⇒ 返回既有行。已配对的同名者不算 ——
  // 那是另一段已成立的关系, 新登记应得到自己的新行。
  const { unpaired } = await findUnpairedLearnerByName(displayName, dbClient);
  if (unpaired) {
    return { learner_id: unpaired.id, display_name: displayName, reused: true };
  }

  const id = genId('lrn');
  await dbClient.insert(learners).values({
    id,
    display_name: displayName,
    // timezone 首跑页不问 (问了也只是猜) — 落 UTC 缺省, 后续偏好对话可改。
    preferences: { timezone: 'UTC', locale: locale?.trim() || 'en' },
    // 语言合同 (迁移 0044): locale 提级实体列, 读方只读这一列。
    // 双写 preferences 只为保 jsonb 形状兼容; 列上不猜缺省——学习者没表达
    // 过语言就是 null (preferences.locale 的 'en' 缺省是历史形状, 不上升为
    // 合同)。
    locale: locale?.trim() || null,
  });
  return { learner_id: id, display_name: displayName, reused: false };
}

export interface CreatePairInput {
  learner_display_name: string;
  agent_provider: string;
  agent_model: string;
  agent_display_name: string;
  locale?: string;
  preferences?: Record<string, unknown>;
}

export interface CreatePairResult {
  pair_id: string;
  learner_id: string;
  agent_id: string;
  established_at: string;
}

/** MCP create_pair 的核心 — 见文件头注三分支。抛 McpToolError, 由
 *  tool-envelope 层转结构化错误信封。 */
export async function createPairForRegisteredLearner(
  input: CreatePairInput,
  dbClient: DbClient = db
): Promise<CreatePairResult> {
  const displayName = input.learner_display_name.trim();
  const { unpaired, activePairId } = await findUnpairedLearnerByName(displayName, dbClient);

  if (!unpaired) {
    if (activePairId) {
      // 守卫: 该 learner 已有 active pair — 拒绝重复建对, 指路既有关系。
      throw new McpToolError(
        'CONFLICT',
        `Learner "${displayName}" already has an in-progress relationship (pair ${activePairId}) — no duplicate pairing.`,
        {
          retryable: false,
          details: { learner_display_name: displayName, existing_pair_id: activePairId },
          recovery_hint:
            `Use the existing relationship: call get_context (it resolves the current pair) or pass pair_id=${activePairId} explicitly ` +
            "and continue teaching; don't start a new one. If you genuinely need a new relationship, that's a multi-pair scenario, out of scope for v1 of this tool.",
        }
      );
    }
    throw notFoundError(
      `No learner registration found named "${displayName}" — pair cannot be established.`,
      {
        learner_display_name: displayName,
        recovery: 'learner-must-register-first',
      }
    );
  }

  const agentId = genId('agt');
  const pairId = genId('pair');
  const now = new Date();

  await dbClient.insert(agents).values({
    id: agentId,
    display_name: input.agent_display_name.trim(),
    provider: input.agent_provider.trim(),
    model_family: input.agent_model.trim(),
    capabilities: [],
  });
  await dbClient.insert(learner_agent_pairs).values({
    id: pairId,
    learner_id: unpaired.id,
    agent_id: agentId,
    established_at: now,
    active: true,
    // 真入学正门 — 永远不是样板间。
    is_demo: false,
  });

  // learner-owned 可选补充: locale / preferences — 来自学习者本人的表达,
  // 浅合并进既有 preferences (不整体覆盖, 不碰没提的键)。
  // 语言合同 (迁移 0044): locale 同时落 learners.locale 实体列 (读写
  // 归一的真相源——brief/评估语言合同读列, preferences 双写只保形状兼容)。
  if (input.locale || input.preferences) {
    const [row] = await dbClient
      .select({ preferences: learners.preferences })
      .from(learners)
      .where(eq(learners.id, unpaired.id))
      .limit(1);
    const existing = (row?.preferences ?? { timezone: 'UTC', locale: 'en' }) as Record<
      string,
      unknown
    >;
    const merged = {
      ...existing,
      ...(input.preferences ?? {}),
      ...(input.locale ? { locale: input.locale.trim() } : {}),
    };
    await dbClient
      .update(learners)
      .set({
        preferences: merged as unknown as {
          timezone: string;
          locale: string;
          learning_style_notes?: string;
        },
        ...(input.locale ? { locale: input.locale.trim() } : {}),
      })
      .where(eq(learners.id, unpaired.id));
  }

  return {
    pair_id: pairId,
    learner_id: unpaired.id,
    agent_id: agentId,
    established_at: now.toISOString(),
  };
}
