// Learn Shell MCP server.
//
// TEACHING-SPEC-v1 §1: Skill files (markdown in `<learn-shell>/skills/`) are
// distributed via MCP Prompts; Resources expose teacher memory + content;
// Tools let the agent author/grade/reflect through MCP.
//
// Transport: stdio. Agent (Claude Code CLI) launches this as a subprocess.
//
// Connect from Claude Code (same one line as README "For agents" §1 and
// SETUP.md §4 — keep all three semantically in sync):
//
//   claude mcp add learn-shell \
//     -e DATABASE_URL="postgresql://learn_shell:learn_shell_dev@localhost:5432/learn_shell" \
//     -- pnpm -C /absolute/path/to/learn-shell --filter @learn-shell/server mcp
//
// Both halves are load-bearing; the two older forms that used to sit here were
// broken and have been removed:
//   · `-e DATABASE_URL=…` — this entrypoint does NOT import lib/load-env, so it
//     never reads apps/server/.env. The variable has to be in this process's own
//     environment or requireDatabaseUrl throws on the first db call.
//   · `pnpm -C <abs path>` — the client picks this subprocess's cwd, so a bare
//     `pnpm --filter …` may not resolve the workspace; and `tsx` is only a
//     devDependency of apps/server, never a global binary on a fresh install.
//     (If you want the binary directly, it lives at
//     apps/server/node_modules/.bin/tsx — not in the repo-root .bin.)

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { and, asc, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { db, queryClient } from '../db/client';
import { newCardState } from '../lib/fsrs';
import {
  validateLesson,
  resolveCourseLessonIds,
  buildCourseSummaryPayload,
  compactLessonReport,
  anyFailed,
  statusLine,
  canPublish,
  type LessonReport,
} from '../lib/validate-prep-core';
import { buildPublishStatusNote, publishStatusLabel } from '../lib/publish-status-note';
import {
  evaluateCloseLoop,
  pickCloseLoopNextActions,
  resolveHasReflectedForClose,
  resolveCloseAttempt,
  type CloseLoopFacts,
  type RefTable,
} from '../lib/close-loop-guard';
import { assertLiveTransition } from '../lib/live-session-transitions';
import { assertLearnerCloseDeclared } from '../lib/learner-close-declaration';
import { createPairForRegisteredLearner } from '../lib/first-run-onboarding';
import { gradeSubmission } from '../lib/grade-submission';
import {
  assertSessionEventEvidence,
  assertEvidenceRefs,
  assertActionLinkTarget,
} from '../lib/evidence-refs';
import {
  assembleLessonClosureCoreFacts,
  fetchHasPostLessonEvaluation,
  fetchHasReceipts,
  fetchLessonProgressState,
  fetchAnchoredReflectionExists,
  fetchMostRecentCloseAt,
  fetchReflectedSinceApprox,
  computeLessonClosureProgress,
  toClosureProgress,
  isIncorrectVerdict,
} from '../lib/lesson-closure-facts';
import {
  buildLiveRuntimeContract,
  buildContractStamp,
  buildLiveWaitData,
  liveRuntimeContractVersion,
  toLiveSessionStub,
  isTerminalLiveSessionStatus,
  pairHasActiveLiveSession,
  findActiveLiveSessionForContext,
} from '../lib/live-contract';
import { appendSessionEvent } from '../lib/session-events';
import {
  waitForBridgeEvents,
  resolveWaitSince,
  checkPendingPollGate,
  POLL_GUARD_MESSAGE,
  isNewerEventId,
  isAdhocMessageOutstanding,
  classifyPendingReason,
} from '../lib/live-wait';
import {
  REFLECTION_ANCHOR_RECENCY_WINDOW_MS,
  UNANCHORED_REFLECTION_WARNING,
  describeReflectionAnchorSource,
  resolveInferredReflectionAnchor,
} from '../lib/reflection-anchor';
import { syncCourseLessonIds } from '../lib/course-structure';
import { sweepLessonAnnotations, sweepDocumentAnnotations } from '../lib/annotation-sweep';
import { deriveDocumentTitle } from '../lib/document-title';
import {
  isObservationForbidden,
  TEACHING_ATTRIBUTION_OBSERVATION_CATEGORY,
} from '../lib/observation-gate';
// 假设生命周期 (0041) — reinforce/revise/retire 纯判定核心。
import {
  HYPOTHESIS_ACTIONS,
  isHypothesisAction,
  planHypothesisAction,
} from '../lib/hypothesis-lifecycle';
import {
  buildContextSnapshot,
  buildLearnerBrief,
  listAvailablePairs,
  notExpiredWeatherFilter,
  pairExists,
} from '../lib/context-brief';
import { getCurrentContract, listCurrentContracts } from '../lib/currentContract';
// 自带教材条款 (迁移 0040) — 形状校验 + 回执/brief 亮灯行。
import { validateSourceMaterialArg, formatSourceMaterialLine } from '../lib/source-material';
import { buildTeacherInbox } from '../lib/teacher-inbox';
import { buildFlashcardContentPatch, updateFlashcardContent } from '../lib/flashcard-update';
import { getLessonReadback, getExerciseReadback, getSubmissionReadback } from '../lib/read-back';
// State 2.0 结业 (complete_contract) — 四轴单点读取, 见 lib/lesson-state.ts
// 顶部长注: content(published_at)/revision/revision_seen/learning(lesson_
// progress.state)/evaluated/loop_closed。complete_contract 只用 content 轴
// (筛已发布课) 和 learning 轴 (须 ∈ completed_declared/closed)。
import { getLessonAxesForLessons, type LessonAxes } from '../lib/lesson-state';
import { evaluateCourseCompletion } from '../lib/course-completion';
import { validationError, notFoundError, conflictError, permissionError, McpToolError } from '../lib/mcp-errors';
import { validateSimulatedQuestions } from '../lib/validate-simulated-quiz';
import { requireStringArg, requireNumberArg, resolveClientMessageId } from '../lib/tool-args';
import { findUnknownField, type JsonSchemaLike } from '../lib/schema-guard';
import {
  buildSuccessEnvelope,
  success,
  fail,
  runIdempotentMutation,
  errorFromException,
} from '../lib/tool-envelope';
import {
  teaching_contracts,
  learner_agent_pairs,
  learners,
  courses,
  lessons,
  lesson_revisions,
  concepts,
  flashcards,
  documents,
  exercises,
  exercise_submissions,
  learner_hypotheses,
  teacher_reflections,
  live_sessions,
  teaching_moves,
  teaching_responses,
  bridge_states,
  post_lesson_evaluations,
  live_session_evaluations,
  simulated_quizzes,
  lesson_progress,
  lesson_patches,
  lesson_loop_receipts,
  session_events,
  learner_feedback,
  type LiveSessionRow,
} from '../db/schema';
import type {
  ActionLink,
  ActionLinkType,
  AdHocContextSnapshot,
  AdHocPayload,
  AwaitingRole,
  BridgePendingItem,
  ContractCadence,
  ContractCadenceMode,
  ContractCadenceReminders,
  ContractCadenceSlot,
  ContractContentModality,
  ContractInteractionMode,
  ContractIntensity,
  ContractPace,
  ExerciseSubmissionStatus,
  LiveContextType,
  MindmapContent,
  MoveType,
  PreferredTimeOfDay,
  PrimaryAttribution,
  ResponseKind,
  SourceRef,
  LessonPatchKind,
  LessonLoopReceiptKind,
  LessonRevisionKind,
} from '@learn-shell/contracts';
import { LESSON_LOOP_RECEIPT_KINDS, MOVE_TYPES } from '@learn-shell/contracts';
import {
  ad_hoc_threads,
  ad_hoc_messages,
  mid_lesson_snapshots,
  mindmaps,
  mindmap_associations,
} from '../db/schema';

// ============================================================================
// Skill files location (relative to this file)
// ============================================================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SKILLS_DIR = resolve(__dirname, '..', '..', '..', '..', 'skills');
// Capability-manifest work (agent-callability 北极星门面工程): docs/recipes/*.md
// are registered 1:1 as `recipe://<name>` MCP resources below, and summarized
// into `manifest://capabilities`'s `recipes[]` array — directory is read at
// request time, so dropping a new file in docs/recipes/ picks it up with no
// server restart-time registration list to hand-maintain.
const RECIPES_DIR = resolve(__dirname, '..', '..', '..', '..', 'docs', 'recipes');

// TEACHING-SPEC §1 round 3: skill = workflow 组合, 不 monolithic.
// Skills live in subdirs:
//   - 5 teaching facets (domain/modality/intensity/tone/pace) → composed into
//     `_stack` for the active contract.
//   - intake/ → pre-teaching skills (e.g. contract-establish). NOT in stack;
//     agent pulls individually when the learner enters /contract before a
//     TeachingContract exists.
// MCP Prompt name format: `<category>/<skill-name>` (e.g. 'domain/teach-cfa',
// 'intake/contract-establish').

const SKILL_CATEGORIES = [
  'workflow',
  'domain',
  'modality',
  'intensity',
  'tone',
  'pace',
  'intake',
  'verify',
] as const;
type SkillCategory = (typeof SKILL_CATEGORIES)[number];

// Stack layout for the `_stack` composite prompt:
//   [workflow] [conditional facets] [verify]
//
// `workflow` is the orchestrator (unconditional first) — tells the agent how
// the rest of the stack composes, what artifacts to produce, the quality bar.
// `intake` is in SKILL_CATEGORIES so it's listable / pullable as a single prompt,
// but `pickSkillStack` does NOT push intake skills — there's no active contract
// yet when intake runs. Agent pulls `intake/contract-establish` explicitly when
// the learner opens /contract.
// `verify` is the enforcement gate (unconditional last) — content-verify;
// see `skills/verify/content-verify.md`.

interface SkillRef {
  category: SkillCategory;
  name: string;
}

async function loadSkill(category: SkillCategory, name: string): Promise<string | null> {
  try {
    return await readFile(resolve(SKILLS_DIR, category, `${name}.md`), 'utf-8');
  } catch {
    return null;
  }
}

async function listAllSkills(): Promise<SkillRef[]> {
  const out: SkillRef[] = [];
  for (const cat of SKILL_CATEGORIES) {
    try {
      const files = await readdir(resolve(SKILLS_DIR, cat));
      for (const f of files) {
        if (f.endsWith('.md') && f !== 'README.md') {
          out.push({ category: cat, name: f.replace(/\.md$/, '') });
        }
      }
    } catch {
      // missing subdir is fine — that facet is just empty
    }
  }
  return out;
}

// pickSkillStack — server decides which skills to compose, based on the
// current contract's spec §3.8 facet fields (intensity / interaction_mode /
// content_modality / preferred_time_of_day) + goal keyword for domain.
// "Current" = signed non-terminal setup_status, newest updated_at wins
// (historical: `active = true` was a filter with no real write path ever
// satisfying it; see lib/currentContract.ts for the full story).
//
// 哲学 (south wind 2026-06-29): skill 之间 orthogonal, 不在 picker 解决冲突,
// 而是在 skill .md 写作时避免冲突.
async function pickSkillStack(): Promise<SkillRef[]> {
  const pairId = await getCurrentPairId();
  if (!pairId) return [];
  const contract = await getCurrentContract(pairId);
  if (!contract) return [];

  const stack: SkillRef[] = [];

  // workflow — unconditional first; orchestrator for the whole stack.
  stack.push({ category: 'workflow', name: 'lesson-prep' });

  // domain — goal keyword
  const goal = (contract.goal ?? '').toLowerCase();
  if (/cfa/.test(goal)) stack.push({ category: 'domain', name: 'teach-cfa' });
  else if (/jlpt|toefl|ielts|japanese|chinese|english|spanish|language/.test(goal))
    stack.push({ category: 'domain', name: 'teach-language' });
  else stack.push({ category: 'domain', name: 'teach-general' });

  // modality — explicit only ('mixed' skipped, agent chooses)
  if (contract.content_modality === 'visual')
    stack.push({ category: 'modality', name: 'visual-heavy' });
  else if (contract.content_modality === 'text')
    stack.push({ category: 'modality', name: 'formula-first' });

  // intensity — always
  stack.push({
    category: 'intensity',
    name: (contract.intensity as string) ?? 'standard',
  });

  // tone — skipped by default; agent uses its own soul. W2+ may add a
  // contract field tone_preset to activate.

  // pace — optional. Pick the first preferred slot if any.
  const times = (contract.preferred_time_of_day as string[] | null) ?? [];
  if (times.includes('morning')) stack.push({ category: 'pace', name: 'morning-burst' });
  else if (times.includes('evening')) stack.push({ category: 'pace', name: 'evening-deep' });
  else if (times.includes('afternoon')) stack.push({ category: 'pace', name: 'lunch-quick' });

  // verify — unconditional enforcement gate (content-verify); always last.
  stack.push({ category: 'verify', name: 'content-verify' });

  return stack;
}

// ============================================================================
// Helper: current pair (single-tenant; W2-W3 will resolve from auth)
//
// 资历优先——婚约不许被任何后来者顶替(7/19 t144test 入侵案)。
// 之前这里没有 ORDER BY,"哪个 active pair 排前面"全凭 Postgres 的默认物理
// 顺序摆布——7/19 一个测试脚本把 DATABASE_URL 指错到了生产库,写进了 18 对
// 'Test Learner/Test Agent' 测试 pair,其中一个恰好排到了真实 pair 前面,
// 把默认解析出的"当前 pair"顶替掉了。策略改为按 established_at 升序取
// 最先建立的那对——后来者(不管是测试数据还是新配对)永远不会隐式顶替一段
// 已经在的关系;需要用后来的 pair 时,调用方必须显式传 pair id。
//
// 首跑入学 (迁移 0042): 资历之上再叠一层身份 —— ORDER BY is_demo ASC,
// established_at ASC。真 pair (create_pair 正门, is_demo=false) 永远优先于
// 样板间 (seed:demo, is_demo=true) 当选"当前关系"; 同身份内仍是资历优先,
// 规则不破。
// ============================================================================
async function getCurrentPairId(): Promise<string | null> {
  const rows = await db
    .select()
    .from(learner_agent_pairs)
    .where(eq(learner_agent_pairs.active, true))
    .orderBy(asc(learner_agent_pairs.is_demo), asc(learner_agent_pairs.established_at))
    .limit(1);
  return rows[0]?.id ?? null;
}

// ============================================================================
// Shared inputSchema fragment — idempotency (Agent Surface Hardening 第一批).
// Spliced into every mutation tool's `properties` below.
// ============================================================================
const IDEMPOTENCY_KEY_SCHEMA = {
  type: 'string',
  description:
    '可选。幂等键 (建议 uuid) —— 同一 key 重放此调用返回首次结果, 不重复写入. ' +
    '网络重试/断线重连时带上同一个 key, 而不是猜"上次到底写没写".',
} as const;

// ============================================================================
// Shared inputSchema fragment — SourceRef (packages/contracts/src/envelope.ts).
// Spliced into every `source_refs`/`generated_from` array's `items` below —
// schema-by-need suite (W3, red team P1): previously these were bare
// `{ type: 'object' }` with the real shape only living in a description
// string, so `additionalProperties: false` at that level would have rejected
// every legitimate field. One declared shape, reused everywhere it appears.
// ============================================================================
const SOURCE_REF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description: 'SourceRef — packages/contracts/src/envelope.ts',
  properties: {
    type: {
      type: 'string',
      enum: ['pdf', 'epub', 'markdown', 'web', 'anki', 'notebook-lm', 'readwise', 'obsidian', 'agent-generated'],
      description: 'pdf|epub|markdown|web|anki|notebook-lm|readwise|obsidian|agent-generated',
    },
    url: { type: 'string' },
    file_ref: { type: 'string' },
    page: { type: 'number' },
    range: {
      type: 'object',
      additionalProperties: false,
      properties: {
        start: { type: 'number' },
        end: { type: 'number' },
      },
      required: ['start', 'end'],
    },
    syllabus_version: { type: 'string' },
    confidence: { type: 'number', description: '0..1, for agent-generated content' },
  },
  required: ['type'],
} as const;

// ============================================================================
// Shared inputSchema fragments — MindmapContent (packages/contracts/src/
// mindmap.ts). Same rationale as SOURCE_REF_SCHEMA above: `content.nodes`/
// `content.links` used to be bare `{ type: 'object' }` items with the real
// 13/4-field shape only living in the tool description's prose ("节点七字段"
// etc.) — declared once here, reused by add_mindmap_seed/update_mindmap_seed.
// validateMindmapContent (below) still does the deep semantic validation
// (uniqueness, parent_id referential integrity, level enum) this JSON Schema
// layer doesn't attempt — the two are complementary, not duplicative.
// ============================================================================
const MINDMAP_NODE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    parent_id: { type: 'string', description: '非 root 节点必带 (父子树)' },
    title: { type: 'string' },
    content: {
      type: 'string',
      description: '@deprecated 2026-07-01 — 子想法请用子节点, 不要塞进这里. 仅为向后兼容保留.',
    },
    level: {
      type: 'string',
      enum: ['root', 'branch', 'detail', 'note'],
      description: '节点层级: root|branch|detail|note',
    },
    source_type: {
      type: 'string',
      enum: ['lesson', 'flashcard', 'exercise', 'concept', 'custom'],
      description: '来源类型: lesson|flashcard|exercise|concept|custom',
    },
    source_id: { type: 'string' },
    source_title: { type: 'string' },
    pos_x: { type: 'number' },
    pos_y: { type: 'number' },
    is_pinned: {
      type: 'boolean',
      description: '为 true 时 pos_x/pos_y 是绝对画布坐标并覆盖自动树布局; 否则位置由 parent_id+sort_order+is_expanded 计算, pos_x/pos_y 可留 0.',
    },
    color: { type: 'string' },
    is_expanded: { type: 'boolean' },
    sort_order: { type: 'number' },
  },
  required: ['id', 'title', 'level', 'pos_x', 'pos_y', 'is_expanded', 'sort_order'],
} as const;

const MINDMAP_LINK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    from_node_id: { type: 'string' },
    to_node_id: { type: 'string' },
    label: { type: 'string', description: '跟父子线并存的自由连线标签' },
  },
  required: ['id', 'from_node_id', 'to_node_id'],
} as const;

const MINDMAP_CONTENT_PROPERTIES = {
  nodes: { type: 'array', items: MINDMAP_NODE_SCHEMA },
  links: { type: 'array', items: MINDMAP_LINK_SCHEMA },
} as const;

// ============================================================================
// Shared inputSchema fragment — cadence (Contract 2.0).
// Identical shape used by propose_contract.cadence and
// update_contract_cadence.cadence (the latter's tool description literally
// says "形状同 propose_contract 的 cadence") — one declared shape, not two
// copies that could silently drift.
// ============================================================================
const CADENCE_SLOT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    weekday: { type: 'number', description: '0-6, 0=周日' },
    time: { type: 'string', description: 'HH:MM, 24 小时制' },
    tz: { type: 'string', description: 'IANA 时区, 如 Asia/Shanghai' },
  },
  required: ['weekday', 'time', 'tz'],
} as const;

const CADENCE_PROPERTIES = {
  mode: { type: 'string', enum: ['scheduled', 'fragmented'], description: 'scheduled|fragmented' },
  slots: { type: 'array', items: CADENCE_SLOT_SCHEMA },
  reminders: { type: 'string', enum: ['native', 'none'], description: 'native|none' },
  auto_duty: {
    type: 'boolean',
    description: '默认 false——涉及学习者额度消耗, 必须明示询问后才置 true.',
  },
  weekly_review_nudge: { type: 'boolean' },
  prep_rhythm: {
    type: 'string',
    enum: ['per_lesson', 'batch'],
    description: '备课节奏——per_lesson(随学而备, 推荐默认) 或 batch(一次备齐)。可选, 未谈就不写.',
  },
} as const;

// live_wait — 比 HTTP /bridge/wait 的 55s 上限更保守: MCP 客户端自
// 己也有调用超时, 留出余量不让服务端阻塞时间贴着客户端超时线走。
const MCP_LIVE_WAIT_MAX_TIMEOUT_S = 50;

// ============================================================================
// Server
// ============================================================================
const server = new Server(
  { name: 'learn-shell', version: '0.1.0' },
  {
    capabilities: {
      resources: {},
      tools: {},
      prompts: {},
    },
  }
);

// ============================================================================
// Resources — teacher memory + content surfaces
// ============================================================================

// Static pair:// resources (DB-backed, need an active pair to read). This
// array is the single source of truth for both ListResourcesRequestSchema
// below and manifest://capabilities's `resources[]` — no parallel list.
const BASE_RESOURCE_DEFINITIONS = [
  {
    uri: 'pair://contract/active',
    name: 'Active TeachingContract',
    description: '当前生效的教学契约 (goal, intensity, interaction_mode, scopes, etc)',
    mimeType: 'application/json',
  },
  {
    uri: 'pair://learner/profile',
    name: 'Learner profile',
    description: '学生身份 + 偏好',
    mimeType: 'application/json',
  },
  {
    uri: 'pair://courses',
    name: 'All courses for this pair',
    mimeType: 'application/json',
  },
  {
    uri: 'pair://flashcards/due',
    name: 'Flashcards currently due (FSRS)',
    mimeType: 'application/json',
  },
  {
    uri: 'pair://exercises/pending',
    name: 'ExerciseSubmissions awaiting agent grading (status=submitted/pending_grade)',
    description:
      'Confidence 主权立法: 每条 submission 带 confidence(序数: guess/likely/certain), ' +
      '不带 confidence_pct(百分比是学习者建模层的数值, 已在服务端剔除, 不进教师读路径)。',
    mimeType: 'application/json',
  },
  {
    uri: 'pair://teacher/hypotheses',
    name: 'Learner hypotheses (teacher memory)',
    mimeType: 'application/json',
  },
  {
    uri: 'pair://teacher/reflections',
    name: 'Teacher reflections',
    mimeType: 'application/json',
  },
] as const;

// manifest://capabilities — the machine-readable capability menu itself.
// Content is built on read (buildCapabilityManifest, defined below) straight
// from the same registries everything else here uses (TOOL_DEFINITIONS,
// listAllResourceDefinitions, buildPromptDefinitions, docs/recipes/*.md) — no
// hand-authored parallel manifest to drift out of sync.
const MANIFEST_RESOURCE_DEFINITION = {
  uri: 'manifest://capabilities',
  name: 'Capability manifest',
  description:
    '机器可读的完整能力菜单 — tools/resources/prompts/recipes + 关键规范指引一次拿到。' +
    '陌生 agent 冷启动第一发读这个, 不用翻 README 撞报错拼地图。',
  mimeType: 'application/json',
} as const;

// docs/recipes/*.md → one `recipe://<name>` resource per file, directory
// read at request time (new files show up with no registration edit here).
async function listRecipeResourceDefinitions(): Promise<
  { uri: string; name: string; description: string; mimeType: string }[]
> {
  let files: string[] = [];
  try {
    files = (await readdir(RECIPES_DIR)).filter((f) => f.endsWith('.md'));
  } catch {
    files = []; // missing dir is fine — recipes just show up empty
  }
  return files
    .map((f) => f.replace(/\.md$/, ''))
    .sort()
    .map((name) => ({
      uri: `recipe://${name}`,
      name: `Recipe: ${name}`,
      description: `docs/recipes/${name}.md`,
      mimeType: 'text/markdown',
    }));
}

async function listAllResourceDefinitions() {
  return [
    ...BASE_RESOURCE_DEFINITIONS,
    ...(await listRecipeResourceDefinitions()),
    MANIFEST_RESOURCE_DEFINITION,
  ];
}

async function readRecipeContent(name: string): Promise<string> {
  return readFile(resolve(RECIPES_DIR, `${name}.md`), 'utf-8');
}

// Recipe-file convention in this repo (see docs/recipes/*.md): H1 title,
// then an optional metadata blockquote (状态/素材来源/工具名 lines) before the
// real one-line description. `summary` = "取文件首段一行" (manifest spec) —
// the first real paragraph after the H1, skipping that metadata blockquote
// if present, collapsed to one line.
const RECIPE_METADATA_LINE_RE = /^(状态|素材来源|工具名)/;

function firstParagraphOneLine(markdown: string): string {
  const lines = markdown.split('\n');
  let i = 0;
  if (i < lines.length && /^#\s+\S/.test(lines[i]!.trim())) i++; // skip H1 title

  let para: string[] = [];
  const finalize = (): string | null => {
    if (para.length === 0) return null;
    const stripped = para.map((l) => l.replace(/^>\s?/, '').trim());
    const isMetadata = stripped.every((l) => RECIPE_METADATA_LINE_RE.test(l));
    para = [];
    if (isMetadata) return null;
    const joined = stripped.join(' ').trim();
    return joined ? (joined.length > 240 ? joined.slice(0, 239) + '…' : joined) : null;
  };

  for (; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed === '') {
      const result = finalize();
      if (result) return result;
      continue;
    }
    if (/^#{1,6}\s+\S/.test(trimmed)) break; // hit a heading before any real paragraph
    para.push(trimmed);
  }
  return finalize() ?? '';
}

async function buildRecipeManifestEntries(): Promise<{ name: string; summary: string; uri: string }[]> {
  const defs = await listRecipeResourceDefinitions();
  return Promise.all(
    defs.map(async (d) => {
      const name = d.uri.slice('recipe://'.length);
      let summary = '';
      try {
        summary = firstParagraphOneLine(await readRecipeContent(name));
      } catch {
        summary = '';
      }
      return { name, summary, uri: d.uri };
    })
  );
}

// Key docs an agent should know exist even though they're not resources of
// their own — pointers only (path + one-line note), read on demand.
const MANIFEST_DOCS_POINTERS = [
  {
    name: 'LESSON-BLOCKS-v1',
    path: 'docs/LESSON-BLOCKS-v1.md',
    note:
      'lesson content_markdown 分页/kicker/h2 结构合同 — add_lesson/update_lesson 写入前必读, ' +
      '写错了会被 validateLessonContent 在写入前打回.',
  },
  {
    name: 'DOGFOOD-LEDGER',
    path: 'docs/DOGFOOD-LEDGER.md',
    note: '真实使用履历 + 事故记录 — 本文件里大量写入校验器的"为什么"都从这里来.',
  },
] as const;

// The manifest itself: { tools, resources, prompts, recipes, docs }. Every
// field is derived from this file's own live registries at read time
// (TOOL_DEFINITIONS / listAllResourceDefinitions / buildPromptDefinitions /
// docs/recipes/*.md) — never a hand-authored parallel list, so it can't
// silently drift from what the server actually registers.
async function buildCapabilityManifest() {
  const resources = await listAllResourceDefinitions();
  const prompts = await buildPromptDefinitions();
  const recipes = await buildRecipeManifestEntries();
  return {
    // 追加工单 (2026-07-17 实测发现) — 陌生 agent 冷启动读 manifest 后仍然
    // 不知道"第一步该干嘛", 直接被一句"帮我备课"带进备课流跳过契约建立。这个
    // 顶级字段是唯一路牌: 内容本体(docs/recipes/bootstrap.md)是老师亲笔,
    // 这里只放指针——recipe:// 已经从 docs/recipes/*.md 动态枚举, 文件落地即可读。
    start_here: {
      uri: 'recipe://bootstrap',
      note: '首次接入或不确定下一步时, 先读这份路由',
    },
    // α批四针 (2026-07-20) — 各写工具回执里的 learner_url 是相对路径
    // (如 /courses/:courseId/lessons/:lessonId), 拼完整链接要靠这个 base。
    // 来自环境变量 LEARNER_APP_BASE_URL, 缺省本地开发端口 5173 (apps/web
    // 的 vite dev 默认端口)。bench lane (bench/bench-up.sh) 把 web 起在
    // :5174, 并自 2026-07-22 起显式传入本变量 (bench-up.sh line ~64);
    // 回执绝对化亦自当日起在 tool-envelope 总装线单点完成。
    learner_app_base_url: process.env.LEARNER_APP_BASE_URL ?? 'http://localhost:5173',
    tools: TOOL_DEFINITIONS.map((t) => ({
      name: t.name,
      description: t.description,
      required_args: ((t.inputSchema as { required?: string[] } | undefined)?.required ?? []) as string[],
    })),
    resources: resources.map((r) => ({
      uri: r.uri,
      name: r.name,
      description: 'description' in r ? r.description : r.name,
    })),
    prompts: prompts.map((p) => ({ name: p.name, description: p.description })),
    recipes,
    // 指针按文件存在性过滤: 家用构建两份全亮, 发行包只亮随包文档——
    // 指向不存在文件的指针本身就是谎言.
    docs: MANIFEST_DOCS_POINTERS.filter((d) => existsSync(resolve(__dirname, '..', '..', '..', '..', d.path))),
  };
}

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: await listAllResourceDefinitions(),
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const uri = req.params.uri;

  // manifest:// and recipe:// are filesystem/registry-backed, not pair-scoped
  // — no active pair required to read them.
  if (uri === MANIFEST_RESOURCE_DEFINITION.uri) {
    const manifest = await buildCapabilityManifest();
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(manifest, null, 2) }] };
  }
  if (uri.startsWith('recipe://')) {
    const recipeName = uri.slice('recipe://'.length);
    // allows dots so `<name>.reference` resolves to docs/recipes/<name>.reference.md
    // (quick/reference split) — '/' stays excluded so no path traversal.
    if (!/^[a-zA-Z0-9_.-]+$/.test(recipeName)) {
      throw new Error(`Invalid recipe resource uri: ${uri}`);
    }
    let text: string;
    try {
      text = await readRecipeContent(recipeName);
    } catch {
      throw new Error(`Recipe not found: ${recipeName} (looked for docs/recipes/${recipeName}.md)`);
    }
    return { contents: [{ uri, mimeType: 'text/markdown', text }] };
  }

  const pairId = await getCurrentPairId();
  if (!pairId) {
    return { contents: [{ uri, mimeType: 'application/json', text: 'null' }] };
  }

  let data: unknown;
  switch (uri) {
    case 'pair://contract/active': {
      // (historical) resource URI kept as-is; selection now goes through
      // signed non-terminal setup_status (see lib/currentContract.ts), not
      // the retired `active` column.
      data = await getCurrentContract(pairId);
      break;
    }
    case 'pair://learner/profile': {
      const pairRows = await db.select().from(learner_agent_pairs).where(eq(learner_agent_pairs.id, pairId)).limit(1);
      if (!pairRows[0]) {
        data = null;
        break;
      }
      const lrnRows = await db.select().from(learners).where(eq(learners.id, pairRows[0].learner_id)).limit(1);
      data = lrnRows[0] ?? null;
      break;
    }
    case 'pair://courses':
      data = await db.select().from(courses).where(eq(courses.pair_id, pairId));
      break;
    case 'pair://flashcards/due': {
      const all = await db.select().from(flashcards).where(eq(flashcards.pair_id, pairId));
      const now = Date.now();
      data = all.filter((f) => new Date(f.fsrs_state.due_at).getTime() <= now);
      break;
    }
    case 'pair://exercises/pending': {
      // Join: exercise_submissions where status in (submitted, pending_grade)
      // and exercise belongs to a lesson belongs to a course belongs to this pair.
      //
      // 案⑤修复 — 注释一直说要 join 到 pair, 实现却只按 status
      // 过滤, 从没 join 过: 多 pair 场景下这个 resource 把全库待批作答一并
      // 泄漏给任何一个 pair 的 agent。join 链与 lib/teacher-inbox.ts 的
      // pendingSubmissionItems()(兄弟实现, 同样的 pending-submission 查询)
      // 一致——exercise_submissions → exercises → lessons → courses.pair_id,
      // 只是那边只挑三个字段拼 inbox item, 这里要把 exercise_submissions
      // 整行原样交给 grade_exercise 消费, 所以 select 整行再按 pair 过滤。
      const pendingStatuses: ExerciseSubmissionStatus[] = ['submitted', 'pending_grade'];
      const pendingRows = await db
        .select({ submission: exercise_submissions })
        .from(exercise_submissions)
        .innerJoin(exercises, eq(exercise_submissions.exercise_id, exercises.id))
        .innerJoin(lessons, eq(exercises.lesson_id, lessons.id))
        .innerJoin(courses, eq(lessons.course_id, courses.id))
        .where(
          and(
            eq(courses.pair_id, pairId),
            inArray(exercise_submissions.status, pendingStatuses)
          )
        );
      // Confidence 主权立法: 教师侧只给序数词, 不给百分比 —— confidence_pct
      // 是学习者建模层的数值(且这个数是拿这个 pair *当刻*的锚值配置折算的,
      // 教师连锚值配置本身都不该看见), 从不进教师读路径。confidence(序数)
      // 保留 —— 那是"她按了哪个按钮"的事实, 教师看得到。
      data = pendingRows.map((r) => {
        const { confidence_pct, ...rest } = r.submission;
        void confidence_pct;
        return rest;
      });
      break;
    }
    case 'pair://teacher/hypotheses':
      data = await db.select().from(learner_hypotheses).where(eq(learner_hypotheses.pair_id, pairId));
      break;
    case 'pair://teacher/reflections':
      // 0018 (§1/§5): expired ⑥ (weather) rows are
      // excluded from every read path, this resource included.
      data = await db
        .select()
        .from(teacher_reflections)
        .where(and(eq(teacher_reflections.pair_id, pairId), notExpiredWeatherFilter()));
      break;
    default:
      throw new Error(`Unknown resource URI: ${uri}`);
  }

  return {
    contents: [
      { uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) },
    ],
  };
});

// ============================================================================
// Tools — what the agent can do
// ============================================================================
// TOOL_DEFINITIONS — single source of truth for the tool registry.
// ListToolsRequestSchema below and manifest://capabilities (buildCapabilityManifest,
// defined above) both read this same array — never a hand-maintained parallel
// tool list to keep in sync.
const TOOL_DEFINITIONS = [
    // ========================================================================
    // 首跑入学 — pair 的唯一
    // 真入学正门。红队 P0-04: 此前 pair/learner/agent 的出生通道只有 seed。
    // 这是全服务器唯一一个"无 active pair 也能调"的工具 (handleToolCall 在
    // pair 门之前分流) —— 它就是造 pair 的那扇门。
    // ========================================================================
    {
      name: 'create_pair',
      description:
        '建立一段新的 learner-agent 关系 (pair) —— 真入学的唯一正门 (get_context 报 No active pair 时走这里, ' +
        '流程见 recipe://bootstrap 的"无 pair 分支": 先说明、知情同意对话、再建对)。' +
        '⚠️ 名字主权红线: learner_display_name 必须与学习者本人在首跑页亲手登记的名字逐字一致——' +
        '名字是学习者的主权动作, agent 代填代猜即越权; 学习者还没登记时本工具会拒绝, ' +
        '此时引导她去首跑页亲手输入自己的名字, 不要替她填。' +
        'agent 三件套 (provider/model/display_name) 由你自报——一千个不同的好老师, 系统不推断你的身份。' +
        '守卫: 该学习者已有 active pair 时拒绝重复建对, 回执指路既有关系。' +
        '成功后 pair 即为"当前关系" (真 pair 永远优先于 demo 样板间), 下一步读 ' +
        'recipe://learner-orientation 上开学第一课, 顺势谈第一份契约。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          learner_display_name: {
            type: 'string',
            description:
              '必填——逐字来自学习者在首跑页亲手登记的名字 (trim 后 1-80 字符)。代填即越权。',
          },
          agent_provider: {
            type: 'string',
            description:
              '必填——你的宿主环境, 自报 (如 claude-code-cli / cursor / claude-desktop / windsurf / custom)。',
          },
          agent_model: {
            type: 'string',
            description: '必填——你的模型系, 自报 (如 claude / gpt / gemini / custom)。',
          },
          agent_display_name: {
            type: 'string',
            description: '必填——你在这段关系里的名字, 学习者会在界面上看到它。',
          },
          locale: {
            type: 'string',
            description: '可选——学习者的语言偏好 (如 zh-CN / en), 来自学习者本人的表达。',
          },
          preferences: {
            type: 'object',
            description:
              '可选——学习者偏好对象 (如 {timezone, learning_style_notes}), 浅合并进登记行的既有 ' +
              'preferences。learner-owned: 只写学习者本人说过的, 不猜。',
          },
          idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
        },
        required: ['learner_display_name', 'agent_provider', 'agent_model', 'agent_display_name'],
      },
    },
    // ========================================================================
    // Contract intake (CONTRACT-NATIVE-INTAKE-BRIEF §1.1) — 立约对话住在
    // user-agent 原生通道, 不在 LS 页面里. 谈完后用这个工具把草案递进 LS;
    // 学习者在 /contract 签字台看到草案, 拧旋钮, Establish 签字.
    // ========================================================================
    {
      name: 'propose_contract',
      description:
        '立约前先读 skill intake/contract-establish（prompt _stack 可见全栈）——goal 一句话不足以立好约, ' +
        '挖掘对话产出 timeline/baseline/cadence 后再填单. ' +
        '立约对话谈完后, 把 TeachingContract 草案递交给 LS, 状态为等待学习者签字 (setup_status: proposed). ' +
        '只写 Class A (goal 必答/time_range/success_criteria) + Class B (intensity/interaction_mode/content_modality/pace/weekly_capacity_hours/preferred_time_of_day) —' +
        ' Class C (提醒渠道偏好: push/ical/email 等) 不收, 那是学习者在签字台表单里自己定的. ' +
        'cadence(节奏条款, Contract 2.0)例外: 若立约对话里谈过"定时 or 碎片化学习", 在这里一并写下——它决定的是' +
        '"存不存在固定节奏约定"这件事本身, 不是 Class C 的渠道细节, 谈过就该带着签字台走, 不用学习者自己再填一遍. ' +
        'source_material(自带教材条款)同理: 学习者带自己的书来学时, 把谈定的教材条款(书名+依赖档位' +
        '+版本年份)一并记进合同, 见该参数的形状说明. ' +
        '学习者点开 /contract 页看到草案卡片, 可以拧 Class B/cadence 旋钮再签, 也可以直接 Establish.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          goal: { type: 'string', description: '学习目标, 课程级别的范围 (必填)' },
          time_range: {
            type: 'object',
            additionalProperties: false,
            description: '{ start: ISO datetime, end_target?: ISO datetime }. 缺省用 now() 作 start.',
            properties: {
              start: { type: 'string', description: 'ISO datetime. 缺省用 now().' },
              end_target: { type: 'string', description: '可选, ISO datetime.' },
            },
          },
          success_criteria: { type: 'array', items: { type: 'string' } },
          intensity: { type: 'string', enum: ['relaxed', 'standard', 'hardcore'], description: 'relaxed|standard|hardcore' },
          interaction_mode: { type: 'string', enum: ['async', 'realtime', 'hybrid'], description: 'async|realtime|hybrid' },
          content_modality: { type: 'string', enum: ['text', 'visual', 'mixed'], description: 'text|visual|mixed' },
          pace: { type: 'string', enum: ['daily', 'weekly', 'flexible'], description: 'daily|weekly|flexible' },
          weekly_capacity_hours: { type: 'number' },
          preferred_time_of_day: {
            type: 'array',
            items: { type: 'string', enum: ['morning', 'afternoon', 'evening', 'late_night'] },
            description: '每项取 morning|afternoon|evening|late_night',
          },
          cadence: {
            type: 'object',
            additionalProperties: false,
            description:
              '可选 — 节奏条款 (Contract 2.0). 签约时学习者决定学习节奏: 定时(scheduled) 还是碎片化' +
              '(fragmented). 形状: {mode:"scheduled"|"fragmented", slots?:[{weekday:0-6(0=周日), ' +
              'time:"HH:MM"(24h), tz:string(IANA 时区)}], reminders:"native"|"none", auto_duty:boolean, ' +
              'weekly_review_nudge?:boolean, prep_rhythm?:"per_lesson"|"batch"}. 提醒本身不由 LS 发出——LS ' +
              '无推送通道且不该造这一层; 这里只是"存约定 + 亮约定", 立钟(设日历/闹钟等实际提醒动作)由 ' +
              'agent/user 在原生工具里完成. auto_duty=提醒触发时 agent 是否自动上岗值更——涉及学习者额度' +
              '消耗, 签约对话必须明示询问, 不问不写, 省略时按 false 处理, 不要替学习者猜. ' +
              'weekly_review_nudge 只对 fragmented 有意义——碎片化学习者的温和周复习提醒意愿, 可选. ' +
              'prep_rhythm=备课节奏("课程内容你想怎么长出来?", 见 skill intake/contract-establish): ' +
              'per_lesson(随学而备, 推荐默认)——每课带着上一课的真实表现出生, 探针/评估/难度管线全激活; ' +
              'batch(一次备齐)——先看全貌自己掌节奏, 代价是课与课之间不再互相学习. 整个 cadence 都可省略' +
              '——未谈节奏条款就不写.',
            properties: CADENCE_PROPERTIES,
            required: ['mode', 'reminders'],
          },
          source_material: {
            type: 'object',
            additionalProperties: false,
            description:
              '可选 — 自带教材条款 (迁移 0040)。学习者带自己的教科书 (EPUB/PDF) 来学时, 把立约' +
              '对话谈定的条款记进合同: {title:书名(必填), author?:作者, year?:出版/版本年份(时效风险开门见山), ' +
              'reliance:依赖档位(必填)}. reliance 三档: strict(严格, 100%: 结构/顺序/口径全随书, 只讲解不延伸) | ' +
              'anchored(锚定, ~80%: 骨架随书, 每课留外延余地) | inspired(启发, ~60%: 书是出发点, 可重组可大幅外延). ' +
              '合同是文书不是引擎——这个字段只记谈定的条款, 摄取与教学行为语义住 recipe://first-contract-and-lesson ' +
              '(教材摄取段) 与 skill workflow/lesson-prep (教材模式). LS 不解析文件: 书由你的宿主读, 你来拆解. ' +
              '未谈教材就不写.',
            properties: {
              title: { type: 'string', description: '书名 (必填)' },
              author: { type: 'string', description: '可选, 作者' },
              year: { type: 'number', description: '可选, 出版/版本年份 — 时效风险在立约时声明, 不留到课上才发现' },
              reliance: {
                type: 'string',
                enum: ['strict', 'anchored', 'inspired'],
                description:
                  'strict(严格,100%随书只讲解不延伸)|anchored(锚定,~80%骨架随书留外延)|inspired(启发,~60%书为出发点可重组)',
              },
            },
            required: ['title', 'reliance'],
          },
          idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
        },
        required: ['goal'],
      },
    },
    // 修约零仪式 (Contract 2.0): 节奏条款随时可改, 改约成本
    // 必须低于立约——不必重新走 propose_contract/签字流程, 只动 cadence 这一
    // 个字段, 其他条款(goal/success_criteria/intensity/...)原样不动。
    {
      name: 'update_contract_cadence',
      description:
        '只改一份已签合同的 cadence(节奏条款), 不动其他任何条款、不必重签. 节奏条款随时可改, 改约成本必须' +
        '低于立约——这是它存在的意义. 形状同 propose_contract 的 cadence: {mode:"scheduled"|"fragmented", ' +
        'slots?:[{weekday:0-6(0=周日), time:"HH:MM"(24h), tz:string}], reminders:"native"|"none", ' +
        'auto_duty:boolean(涉及学习者额度消耗, 必须明示询问, 默认 false), weekly_review_nudge?:boolean, ' +
        'prep_rhythm?:"per_lesson"|"batch"(备课节奏——per_lesson 随学而备/推荐默认, batch 一次备齐; ' +
        '见 skill intake/contract-establish 的语义说明)}. **完整替换, 不是逐字段合并**——改 prep_rhythm ' +
        '而漏带其他既有键(如 slots)会把它们清空, 调用前先读现有 cadence 再整体重写. ' +
        'teaching_contracts 没有 revision/history 表(version 列是历史遗留, 从未被真实写路径 bump 过)——' +
        '留痕方式: 本工具自动在写入的 cadence 里盖一个 updated_at(ISO 时间戳, 不是调用者字段), 同时' +
        '同步 bump 合同自身的 updated_at 列. 提醒本身仍不由 LS 发出——只是改了"存的约定"。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          contract_id: { type: 'string', description: '必须是已存在的 teaching_contracts id' },
          cadence: {
            type: 'object',
            additionalProperties: false,
            description: '必填, 完整替换现有 cadence(不是逐字段合并) — 形状同上, mode/reminders 必填.',
            properties: CADENCE_PROPERTIES,
            required: ['mode', 'reminders'],
          },
          idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
        },
        required: ['contract_id', 'cadence'],
      },
    },
    // 作废机制 (迁移 0027, Void not delete — 审计留痕): 作废权双方都有——学习者
    // 在签字台/证书区点, agent 走这个工具。不删除行, 只把它标记出局 (active=
    // false, voided_at=now(), void_reason=理由) 并让它从"当前合约"选择结果里
    // 消失 (lib/currentContract.ts)。
    {
      name: 'void_contract',
      description:
        '作废合约前，必须把作废理由原文展示给学习者，并取得学习者亲口的同意答复；learner_consent 填学习者的原话。' +
        '未经同意调用属违纪。' +
        ' 作废不是删除——合约行原样保留，只是标记作废(active=false, voided_at=now(), void_reason=你传入的 reason)并' +
        '从此退出"当前合约"选择(get_context/pickSkillStack/pair://contract/active 等一切现读, 见 ' +
        'lib/currentContract.ts)。幂等：对已作废的合约重复调用，原样返回其作废状态，不报错、不二次写入、不覆盖' +
        '原 void_reason。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          contract_id: { type: 'string', description: '必须是已存在的 teaching_contracts id.' },
          reason: {
            type: 'string',
            description: '作废理由原文（必填，非空）——这是要先给学习者看过的那段话，也是留痕的一部分。',
          },
          learner_consent: {
            type: 'string',
            description:
              '学习者的原话同意答复（必填，非空）。不是你替学习者写的摘要——她/他说了什么就填什么。',
          },
          idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
        },
        required: ['contract_id', 'reason', 'learner_consent'],
      },
    },
    // ========================================================================
    // State 2.0 文书三幕剧 (立约 → 履约 → 结业, 迁移 0030): update_contract_coverage
    // 是"履约"这一幕的记账工具——covered_course_ids 是这份合约名下实际教过的
    // 课程清单, 不是许可范围声明; complete_contract 是"结业"这一幕, 与
    // established(签约)/voided(作废, 迁移0027)并列的第三种终态。
    // ========================================================================
    {
      name: 'update_contract_coverage',
      description:
        '修改一份合约的 covered_course_ids 覆盖单(这份合约名下实际教过的课程清单, 不是许可范围声明) —— ' +
        '{add_course_ids?, remove_course_ids?} 至少传一个非空数组。去重(加了两遍/加了已存在的不报错), ' +
        '并校验每个 course_id 存在且属于同一个 pair(不属于/不存在直接拒绝, 不静默忽略)。已结业的合约' +
        '(completed_at 非空)拒改——结业是终态, 覆盖单在那一刻定格, 想续教开新合约。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          contract_id: { type: 'string', description: '必须是已存在的 teaching_contracts id.' },
          add_course_ids: { type: 'array', items: { type: 'string' }, description: '要并入覆盖单的 course id' },
          remove_course_ids: { type: 'array', items: { type: 'string' }, description: '要从覆盖单移除的 course id' },
          idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
        },
        required: ['contract_id'],
      },
    },
    {
      name: 'complete_contract',
      description:
        '把一份合约收作结业 (State 2.0 文书三幕剧: 立约 → 履约 → 结业, 迁移 0030) —— completed_at/completion_note ' +
        '是与 established(签约)/voided(作废)并列的第三种终态, 不是覆盖关系。completion_note 是结业词——给这段' +
        '学习旅程的证词, 认真写, 不是流程按钮上敷衍一句"完成了"。' +
        '前置校验, 任一条不满足即结构化拒绝并附差额: ① 合约现役(经 lib/currentContract 判定路径——未签/已作废/' +
        '已过终态一律拒绝); ② covered_course_ids 非空(先 update_contract_coverage 或建课时带 contract_id 把' +
        '教过的课挂上); ③ 覆盖单里每门课须 goal_completion_ready (见 get_context 的 contract_progress) —— ' +
        '全部已发布课 learning 状态 ∈ {completed_declared, closed} (未发布的课不计入), 且课程定过 ' +
        'planned_lesson_count 并已发布节数够数——没定过计划节数的课不再放行。不满足则回执附结构化差额, 分两种: ' +
        '缺 planned_lesson_count (missing_planned_count) 或已发布节数不足计划 (below_planned_count), 外加' +
        '"哪门课还差几节未读完"的清单, 不是一句"没教完"。幂等: 已结业的合约重复调用原样返回既有结业词, 不报错、' +
        '不二次写入。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          contract_id: { type: 'string', description: '必须是已存在的 teaching_contracts id.' },
          completion_note: {
            type: 'string',
            description: '结业词(必填非空)——这段学习旅程的证词, 认真写.',
          },
          idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
        },
        required: ['contract_id', 'completion_note'],
      },
    },
    {
      name: 'create_course',
      description:
        '新建一个 course. 零材料启动新主题时用——不需要挂靠已有 course. ' +
        '可选 contract_id: 建课即履约——有现役合约时应携带, 建课成功后新课 id 会自动并入该合约的 ' +
        'covered_course_ids(等价紧接着调一次 update_contract_coverage, 这里省一刀)。contract_id 必须现役 ' +
        '(经 lib/currentContract 判定路径)且属于同一 pair, 否则拒绝建课(不留孤儿关联)。' +
        '建课时问学习者的第一问——"一共几节"——落 planned_lesson_count(可选, 正整数)。定了它, ' +
        'complete_contract/get_context 的结业判定会多一道门槛: 已发布节数须够这个数才算课程完成; ' +
        '留空(null)则 goal_completion_ready 恒为 false, 结业永不放行, 且事后无补录入口。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          topic: { type: 'string' },
          description: { type: 'string' },
          syllabus_version: { type: 'string' },
          generated_from: { type: 'array', items: SOURCE_REF_SCHEMA, description: 'SourceRef[]' },
          planned_lesson_count: {
            type: 'number',
            description:
              '可选——这门课计划一共几节 (正整数)。建课时问学习者的第一问, 定了它会成为结业判定的' +
              '节数门槛 (见 complete_contract)。留空则该课结业永不放行, 且事后无补录入口。',
          },
          contract_id: {
            type: 'string',
            description: '可选——现役合约 id, 建课成功后自动并入其 covered_course_ids.',
          },
          idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
        },
        required: ['topic'],
      },
    },
    {
      name: 'add_lesson',
      description:
        '为指定 course 添加一节 lesson. agent 备课时用. ' +
        '脑图种子为可选教具, 默认不生成、例外才有 (2026-07-21 定): 仅当空间/因果/分支结构确实比文字' +
        '更清楚时才配 (判断权归老师), 不为教具齐整而出图. 想留"为什么不配"的教学法笔记可写 ' +
        'modality_declarations.mindmap (纯可选, 不写不罚).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          course_id: { type: 'string', description: '必须是已存在的 course id（server 会查存在性）' },
          order: { type: 'number' },
          title: { type: 'string' },
          content_markdown: { type: 'string' },
          concept_ids: {
            type: 'array',
            items: { type: 'string' },
            description: '可选；每项必须是已存在的 concept id（server 会查存在性）',
          },
          estimated_minutes: { type: 'number' },
          skill_used: { type: 'string', description: '本次备课派发的 skill 名称' },
          modality_declarations: {
            type: 'object',
            additionalProperties: false,
            properties: {
              mindmap: {
                type: 'string',
                description:
                  '不配脑图时的教学法笔记 (如 "背诵类内容, 关系不是难点")。纯可选——脑图默认不生成 ' +
                  '留空不触发任何黄灯; 写了 verify_prep 会在报告里原文回显。',
              },
            },
            description: '可选教具的"声明式跳过"记录; 目前只用 mindmap 键。',
          },
          idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
        },
        required: ['course_id', 'order', 'title', 'content_markdown'],
      },
    },
    {
      name: 'update_lesson',
      description:
        '修订已有 lesson (revision pass 回写). 旧版全文快照入 lesson_revisions 后应用 patch, revision += 1. ' +
        '必须带 revision_reason; 没有理由的修订直接拒绝. modality_declarations.mindmap 同 add_lesson ' +
        '(纯可选笔记; 脑图默认不生成, 留空不罚). revision_kind (迁移 0033, 双轨修订): 问自己——' +
        '这次改动是她教出来的, 还是机器逼出来的? 前者 teaching (会呈现给学习者并触发回看提醒), ' +
        '后者 technical (留痕但对她隐身)。缺省 teaching——发布后的修订默认面向学习者, 宁可多呈现不可偷藏.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          lesson_id: { type: 'string' },
          revision_reason: { type: 'string', description: '必填——为什么改' },
          evidence: {
            type: 'string',
            description:
              '可选, 依据什么证据 (如 "作业二里 Prepaid 方向连错两次")。' +
              '**学习者会在修订病历本里读到这一段**——写人话, 内部 id 不进正文。' +
              '注意本字段没有配套的 evidence_refs 通道, 所以宁可说得笼统, 也不要塞机器词。',
          },
          revision_kind: {
            type: 'string',
            enum: ['teaching', 'technical'],
            description:
              '可选, 缺省 teaching。问自己："这次改动是她教出来的, 还是机器逼出来的?" 前者 teaching ' +
              '(会呈现给学习者并触发回看提醒), 后者 technical (留痕但对她隐身, 如格式/门禁/重构/错别字)。',
          },
          content_markdown: { type: 'string' },
          title: { type: 'string' },
          concept_ids: {
            type: 'array',
            items: { type: 'string' },
            description: '可选；每项必须是已存在的 concept id（server 会查存在性）',
          },
          estimated_minutes: { type: 'number' },
          modality_declarations: {
            type: 'object',
            additionalProperties: false,
            properties: {
              mindmap: {
                type: 'string',
                description: '不配脑图时的教学法笔记 (纯可选; 脑图默认不生成, 留空不罚)。',
              },
            },
            description: '可选教具的"声明式跳过"记录; 目前只用 mindmap 键。',
          },
          idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
        },
        required: ['lesson_id', 'revision_reason'],
      },
    },
    // ========================================================================
    // §4 改课三律 + §5 回执制 + §6 完成状态机 (施工批
    // 2026-07-11). update_lesson above is the "未开始的课: 自由改" 落点;
    // add_lesson_patch is the other two档 (学习中: teacher_note / 已学完:
    // erratum); close_lesson_loop is the "已回课"终态 + 回执写入。学习者侧
    // "宣布已学完" 是 REST (POST /pairs/:pairId/lessons/:lessonId/declare-
    // completed, routes/write.ts) 不是 MCP 工具——那是学习者的动作, 不是老师的。
    // ========================================================================
    {
      name: 'add_lesson_patch',
      description:
        '给一节课打老师注或勘误补丁 (§4 改课三律): 三律边界 — 未开始的课直接用 update_lesson 整改, ' +
        '不要打补丁; 学习中的课 (学习者还没宣布已学完) 只许 kind=teacher_note (追加, 不抽换正文, ' +
        '标注来源"基于你第X课的作业, 此处补一句"); 已学完的课 (学习者已宣布) 只许 kind=erratum ' +
        '(原文保留, 补丁并列, 永不重写课文本身)。判断学习中/已学完请先查这节课的 lesson_progress ' +
        '状态 (GET /pairs/:pairId/lessons/:lessonId/progress)。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          lesson_id: { type: 'string', description: '必须是已存在的 lesson id（server 会查存在性）' },
          kind: {
            type: 'string',
            enum: ['teacher_note', 'erratum'],
            description: 'teacher_note=学习中的课追加注; erratum=已学完的课的勘误。二选一, 不是自由文本。',
          },
          body: { type: 'string', description: '补丁正文, 非空' },
          anchor: { type: 'string', description: '可选——锚定页码或引用原文片段, 自由文本' },
          source_attribution: {
            type: 'string',
            description: '可选——引用归因/批改依据, 例如 "基于你第X课的作业二"',
          },
          idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
        },
        required: ['lesson_id', 'kind', 'body'],
      },
    },
    {
      name: 'close_lesson_loop',
      description:
        '把一节课的教学闭环收口: 写回执 (§5, 逐条列出本轮动了哪里) + 把这节课的 lesson_progress 置为 ' +
        'closed (§6 "已回课"终态, 由批改完成+回执送达触发, 不可逆——已 closed 的课再调用本工具会报错)。' +
        '一次判决原则: 关课不产生新判决——判决齐不齐由 closure_progress 核对。' +
        'receipt 现在是可选的 (2026-07-26): 它曾是"给学习者的 changelog", 但学习者侧的回执渲染卡已于 ' +
        '2026-07-22 退役 (行项退役案 — 行项是记账动词, 对学习者零价值; 已回课由课页的 已回课 徽标传达), ' +
        '这份 changelog 现在没有读者, 不再强制老师写。想留档就照旧传, 每条 description 指认"动了哪里", ' +
        '不重新评讲、不复述判决内容; 传了就仍然按老规矩验 (ref_id 悬空照拒)。注意: 本课若有已完成的 Live 课, ' +
        '闸门 ④ 仍然要求一条引用其 snapshot/场评 的回执 —— 那种课上不传 receipt 是关不掉的。' +
        'receipt 的每条 kind 必须落在封闭枚举内 (七种, 没有第八种): exercise_feedback(指认某份提交已批改, ' +
        'ref_id 指 submission——评语和分数的判决本体在 grade_exercise 记录上, 此处不复述评语、不重新打分) / ' +
        'forward_revision(前方课修订) / teacher_note(学习中的课的老师注) / erratum(已学完的课的勘误补丁) / ' +
        'flashcard_change(闪卡增删) / hypothesis_update(假设修订) / journal_entry(journal条目)。' +
        '枚举外的 kind 一律打回——这是"不许发明新黑箱"的机器化, 不要绕过。' +
        ' 空转防护: 关课服务端强制四检——① 本课有已提交未批改的作业则拒关(先 grade_exercise 还债);' +
        ' ② 关课须带认知更新(post_lesson_evaluation 或指向真实假设的 hypothesis_update 回执), 皆无则须传' +
        ' no_cognitive_update_reason; ③ 每条 ref_id 必须指向真实记录(悬空 ref 拒关); ④ 本课有已完成 Live 课则' +
        ' 回执须有一条 kind=journal_entry 引用其 snapshot。回执自带闭环进度——不用另查状态机。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          lesson_id: { type: 'string', description: '必须是已存在的 lesson id（server 会查存在性）' },
          receipt: {
            type: 'array',
            description:
              '可选 (2026-07-26 起; 渲染面已退役, 见工具说明), 每条 {kind, description, ref_id?}。' +
              '省略或传空数组都算"本次不留 changelog"; 传了的每条仍走全套校验。',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: {
                  type: 'string',
                  enum: [
                    'exercise_feedback',
                    'forward_revision',
                    'teacher_note',
                    'erratum',
                    'flashcard_change',
                    'hypothesis_update',
                    'journal_entry',
                  ],
                  description:
                    'exercise_feedback|forward_revision|teacher_note|erratum|flashcard_change|' +
                    'hypothesis_update|journal_entry',
                },
                description: {
                  type: 'string',
                  description:
                    '这条回执具体动了什么, 非空——指认落点的一句话, 可选收尾短注; 不用于重新评讲或复述习题 ' +
                    '(一次判决原则: 评语看 grade_exercise 记录, 不在回执里重写)。',
                },
                ref_id: {
                  type: 'string',
                  description:
                    '可选, 但填了就必须真实——按 kind 指向对应表的真实 id: exercise_feedback→submission, ' +
                    'forward_revision→lesson_revision, teacher_note/erratum→lesson_patch, flashcard_change→flashcard, ' +
                    'hypothesis_update→hypothesis, journal_entry→session_event/snapshot/live_session/evaluation。',
                },
              },
              required: ['kind', 'description'],
            },
          },
          no_cognitive_update_reason: {
            type: 'string',
            description:
              '可选逃生舱 (空转防护 check ②): 本课确无认知更新时, 显式声明原因。仅在既无 post_lesson_evaluation ' +
              '也无 hypothesis_update 回执时需要; 提供后写入关课记录 (lesson_progress)。',
          },
          idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
        },
        required: ['lesson_id'],
      },
    },
    {
      name: 'get_lesson_closure_state',
      description:
        '关课前先调我——顺序、缺口、下一步和 id 都替你串好，不用脑内记账。' +
        '只读, 复用 close_lesson_loop 同一份事实装配 (lib/lesson-closure-facts.ts), 不改动任何状态。' +
        '返回 { lesson_id, state, completed[], missing[], next_required_action, incorrect_review_signal }。' +
        'state 是"首个缺口的语义名"(graded/live_completed/live_evidence/live_evaluation/' +
        'post_lesson_evaluation/reflection 之一), 或 ready_to_close(万事俱备只差调 close_lesson_loop), ' +
        '或 closed(已关课, 终态)。读法警示: state 点名的是"当前卡在哪一项"——它指的是还欠着的' +
        '待办, 不是已达成的成就, 所以 state=graded 时 missing[] 里同时出现 graded 是同一句话说了两遍, ' +
        '不是矛盾; 已完成的项只看 completed[]。live_completed/live_evidence/live_evaluation 三项只在本课挂过 Live 时出现。' +
        'next_required_action 是 {tool, pre_filled_refs} —— 能预填的 id (submission_id/session_id/' +
        'live_session_id/lesson_id) 已经替你摘出来了, closed 时为 null。' +
        'incorrect_review_signal (错题卡事实行) 是纯陈述, 不进 missing[], 不带 severity: ' +
        '{incorrect_submission_count, concepts_with_flashcard, concepts_total} —— 本课判错提交数, 以及' +
        '这些判错习题涉及的概念里已经挂了闪卡的比例, 读读即可, 不是缺口, 不阻塞关课。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          lesson_id: { type: 'string', description: '必须是已存在的 lesson id（server 会查存在性）' },
        },
        required: ['lesson_id'],
      },
    },
    {
      name: 'publish_lesson',
      description:
        '把一节课上架给学习者 (Publish Gate)。add_lesson 建的课默认草稿态 (published_at ' +
        '留空, 仅教师/MCP 侧可见); publish_lesson 服务端直接跑验尺 (与 verify_prep 同一套 validate-prep ' +
        '判定): 存在 ❌ (FAIL 级) → 拒绝上架并返回红灯清单, 红灯不清零不许翻牌; PASS / PASS_WITH_WARNINGS ' +
        '→ 写 published_at, 课进学习者书架 (黄灯过目制归人工, 不阻断)。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          lesson_id: { type: 'string', description: '必须是已存在的 lesson id（server 会查存在性）' },
          idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
        },
        required: ['lesson_id'],
      },
    },
    // ========================================================================
    // Document (批G) — "晨报塞进门缝": agent 写完
    // 一篇研究报告直接上架, 不经过 course/lesson 结构. 学习者划线 → 一键生成
    // 闪卡 → 进复习队列 ("报告可以死, 知识不许死", brief §1).
    // ========================================================================
    {
      name: 'add_document',
      description:
        '上架一份新文档 (Markdown) 供学习者阅读/划线/生成闪卡, 不挂靠任何 course/lesson. ' +
        'title 缺省时按 frontmatter title → 首个 H1 → 首行截断 自动派生 (brief §2). source 固定为 mcp.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: '缺省时从 content_md 自动派生' },
          content_md: { type: 'string' },
          idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
        },
        required: ['content_md'],
      },
    },
    {
      name: 'update_document',
      description:
        '更新已有文档的标题和/或正文 (报告修订版). 正文变化时自动重新普查这份文档的全部划线 —' +
        ' 失联的进孤儿区, 绝不静默删行 (金缮条款, brief §3 item 3).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          document_id: { type: 'string' },
          title: { type: 'string' },
          content_md: { type: 'string' },
          idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
        },
        required: ['document_id'],
      },
    },
    {
      name: 'add_concept',
      description:
        '为 lesson 添加一个 concept. course_id 自动取 lesson 所属的 course, 不需要单独传. ' +
        '新 concept 会自动登记进 lesson.concept_ids, 不需要（也不应该）再手动补写.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          lesson_id: { type: 'string' },
          name: { type: 'string' },
          short_definition: { type: 'string' },
          source_refs: {
            type: 'array',
            items: SOURCE_REF_SCHEMA,
            description: 'SourceRef[]；每项须为对象 {type, url?, file_ref?, page?, ...}，type 取封闭枚举',
          },
          idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
        },
        required: ['lesson_id', 'name'],
      },
    },
    {
      name: 'update_concept',
      description: '修订已有 concept 的字段 (name / short_definition / source_refs / flashcard_ids).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          concept_id: { type: 'string' },
          name: { type: 'string' },
          short_definition: { type: 'string' },
          source_refs: {
            type: 'array',
            items: SOURCE_REF_SCHEMA,
            description: 'SourceRef[]；每项须为对象 {type, url?, file_ref?, page?, ...}，type 取封闭枚举',
          },
          flashcard_ids: {
            type: 'array',
            items: { type: 'string' },
            description: '每项必须是已存在的 flashcard id（server 会查存在性）',
          },
          idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
        },
        required: ['concept_id'],
      },
    },
    {
      name: 'add_flashcard',
      description: '添加一张闪卡; FSRS state 由 server 初始化.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          concept_id: {
            type: 'string',
            description:
              '推荐每张卡都挂——deck_id 不再承载"出处"语义(course/topic 级 deck 是合法归组)，concept_id 经 ' +
              'concept→lesson 链路才是这张卡出处可追溯的锚点。可选；若传入必须是已存在的 concept id（server 会查存在性），省略则不挂概念（verify_prep 会警告）',
          },
          deck_id: {
            type: 'string',
            description:
              '必填；自由字符串；同名自动归入同一卡组；是卡片列表的分组主键。course/topic 级 deck 合法且推荐——' +
              '间隔复习(FSRS)按主题混抽效果更好，不必"一课一卡组"。出处不要塞进 deck 名——每张卡该挂的是 ' +
              'concept_id (经 concept→lesson 链路追溯出处)，deck_id 只管"按什么主题混抽复习"。',
          },
          front: {
            type: 'string',
            description:
              'front=勾起回忆的问题/场景。纯文本渲染（不解析 markdown/LaTeX）。注意：这与课文 :::concept-flip 块的 Front/Back 语义不同，勿混。',
          },
          back: {
            type: 'string',
            description:
              'back=答案，≤3 句。纯文本渲染（不解析 markdown/LaTeX）。注意：这与课文 :::concept-flip 块的 Front/Back 语义不同，勿混。',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: '可选；必须是字符串数组，例如 ["GDP"]——不要传裸字符串 "GDP"',
          },
          idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
        },
        required: ['deck_id', 'front', 'back'],
      },
    },
    {
      name: 'update_flashcard',
      description:
        '修订已有闪卡的内容字段 (front / back / deck_id) — 纯 patch 语义, 只改给出的字段, 不建 revision 快照 ' +
        '(同 update_concept 先例)。编辑卡面不影响复习计划: FSRS 调度状态 (fsrs_state 的 due_at/stability/' +
        'difficulty/review_count 等) 与 paused 原样保留, 改内容不清进度、不重置排期。只能改当前 pair 的卡, ' +
        '其他 pair (或不存在) 的卡一律 NOT_FOUND。验尺/复盘抓到卡面问题后走这里修, 不必删卡重建 (重建才会丢调度进度)。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          flashcard_id: { type: 'string', description: '必填; 要修订的闪卡 id (fc_ 前缀), 须属当前 pair' },
          front: {
            type: 'string',
            description:
              '可选; 新的卡面问题。front=勾起回忆的问题/场景, 纯文本渲染 (不解析 markdown/LaTeX), 同 add_flashcard 口径。',
          },
          back: {
            type: 'string',
            description: '可选; 新的答案, ≤3 句, 纯文本渲染 (不解析 markdown/LaTeX), 同 add_flashcard 口径。',
          },
          deck_id: {
            type: 'string',
            description:
              '可选; 移入的卡组 (自由字符串, 同名自动归组)。deck 语义纪律见 add_flashcard 的 deck_id 说明 — ' +
              '出处不塞 deck 名, deck 只管"按什么主题混抽复习"。',
          },
          idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
        },
        required: ['flashcard_id'],
      },
    },
    {
      name: 'add_mindmap_seed',
      description:
        '为 lesson 或 course 挂一张 agent 出的思维导图 seed (root+branch+detail 基础框架). ' +
        '一次调用完成建图 + 写关联 — 等价于 REST POST /mindmaps 接 POST /mindmaps/:id/associations ' +
        '两步的合并版, 省得 agent 备课时绕 REST. ' +
        '字段合同: 节点七字段 {id,title,level,pos_x,pos_y,is_expanded,sort_order} + 非 root 必带 ' +
        'parent_id, level ∈ root/branch/detail/note; links 只画跨分支联想, 禁止把父子关系抄进 links. ' +
        '结构: root 1 个 → branch 3-4 个且各自说得出主张 → 每支 detail 2-4 个, 禁止连续独子成链, ' +
        '禁止辐条伞(root 对每项发一根辐条, 与课文列表同构). ' +
        '布局: pos_x/pos_y 落在 x 8-92 / y 12-95 内, root 天窗位 (50,8), 同级节点 y 差 ≥14, ' +
        'note 标题 ≤12 字. ' +
        '完整教程: docs/recipes/mindmap-authoring.md(bench 考生看 candidate-kit/recipes/ 同名文件).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pair_id: {
            type: 'string',
            description:
              '可选; 缺省用当前 pair。填了也只能填当前 pair —— 服务端校验归属, 别人的 pair id 一律 NOT_FOUND ' +
              '(脑图种不到别人名下)。',
          },
          title: { type: 'string' },
          content: {
            type: 'object',
            additionalProperties: false,
            description: 'MindmapContent — { nodes: MindmapNode[], links: MindmapLink[] }',
            properties: MINDMAP_CONTENT_PROPERTIES,
          },
          lesson_id: {
            type: 'string',
            description: '与 course_id 二选一 — 关联到某节 lesson; 必须是当前 pair 名下的课 (服务端验存在性+归属)',
          },
          course_id: {
            type: 'string',
            description: '与 lesson_id 二选一 — 关联到某门 course; 必须是当前 pair 名下的门 (服务端验存在性+归属)',
          },
          agent_skill_used: { type: 'string', description: '本次出图用的 skill 名称' },
          idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
        },
        required: ['title', 'content'],
      },
    },
    {
      name: 'update_mindmap_seed',
      description:
        '修复/迭代你自己播种的课程脑图, 拓扑不再一锤定音. 只对 source=agent 的图开放 ' +
        '(学习者自己长出来的图不许 agent 动, 会打 PERMISSION); content 走与 add_mindmap_seed ' +
        '一致的全套校验(字段合同见 add_mindmap_seed 说明, 完整教程 docs/recipes/mindmap-authoring.md). ' +
        '写入会同时同步 content 与 agent_seed_snapshot 两列 — 有过案底: 只改 content 会让 ' +
        'Clear & redo(从 agent_seed_snapshot 复原)诈尸出你改之前的旧方言图, 这里两列一起写, 新内容' +
        '即是新种子, 免疫诈尸.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mindmap_id: {
            type: 'string',
            description:
              '必须是当前 pair 名下、已存在、且 source=agent 的 mindmap id (服务端先验归属+存在性, ' +
              '别人 pair 的图一律 NOT_FOUND, 再验 source)',
          },
          content: {
            type: 'object',
            additionalProperties: false,
            description: 'MindmapContent — { nodes: MindmapNode[], links: MindmapLink[] }, 全量替换(不是 patch)',
            properties: MINDMAP_CONTENT_PROPERTIES,
          },
          idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
        },
        required: ['mindmap_id', 'content'],
      },
    },
    {
      name: 'add_exercise',
      description: '为 lesson 添加课后习题.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          lesson_id: { type: 'string', description: '必须是已存在的 lesson id（server 会查存在性）' },
          order: { type: 'number' },
          prompt: { type: 'string' },
          reference_answer: { type: 'string' },
          expected_concepts: {
            type: 'array',
            items: { type: 'string' },
            description: '可选；必须是字符串数组，且每个 id 都必须是已存在的 concept id（server 会查存在性）',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description:
              '可选；自由标签的字符串数组（迁移 0039, 二审补的通道）。当前唯一约定值 "probe"——' +
              '探针题标记（见 skill lesson-prep "探针与难度"），对学习者不展示、不告知。',
          },
          agent_skill_used: { type: 'string' },
          idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
        },
        required: ['lesson_id', 'order', 'prompt', 'reference_answer'],
      },
    },
    {
      name: 'add_simulated_quiz',
      description:
        '为指定 course 添加一份模拟卷 (SimulatedQuiz, round 3 Quiz 通电). 与 REST POST ' +
        '/pairs/:pairId/simulated-quizzes 1:1 镜像 — course_id 必须存在, questions 非空; ' +
        'single_choice/multi_choice 题必须带 choices 且 reference_answer 的每一项都在 ' +
        'choices 里 (multi_choice 用逗号分隔编码多个正确项). 开放题 (short_answer/essay, ' +
        '或省略 question_type) 不判分, 留给学习者自评 reference_answer.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          course_id: { type: 'string' },
          agent_skill_used: { type: 'string' },
          questions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', description: '缺省自动生成' },
                stem: { type: 'string' },
                question_type: {
                  type: 'string',
                  enum: ['single_choice', 'multi_choice', 'short_answer', 'essay'],
                  description: 'single_choice|multi_choice|short_answer|essay; 缺省 short_answer (round 2 兼容)',
                },
                choices: { type: 'array', items: { type: 'string' } },
                reference_answer: { type: 'string' },
                explanation: { type: 'string' },
                concept_tags: { type: 'array', items: { type: 'string' } },
              },
              required: ['stem', 'reference_answer'],
            },
          },
          idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
        },
        required: ['course_id', 'questions'],
      },
    },
    // ========================================================================
    // verify_prep — MCP 化的 scripts/validate-prep.ts (2026-
    // 07). LS 的备课产物散在四张表(lessons.content_markdown / flashcards /
    // exercises / mindmaps), 写入门禁(add_lesson/add_flashcard/add_exercise/
    // add_mindmap_seed)各自只看单次调用, 没人看"这一整套教具凑在一起自洽不
    // 自洽"。这个工具看的是全家福。只读, 判定逻辑与 CLI 共用同一份实现
    // (lib/validate-prep-core.ts), 两边不会各自漂移。
    // ========================================================================
    {
      name: 'verify_prep',
      description:
        '备课收尾必调: 交付前跑一遍, 清掉每一条 ❌, ⚠️ 逐条过目。检查跨件一致性' +
        '(课文格式/闪卡/习题引用/脑图拓扑/概念覆盖)——写入门禁看单发, 本工具看全家福。' +
        '只读, 零写库。lesson_id / course_id 二选一必填(都传或都不传 → code: VALIDATION)。' +
        '传 lesson_id 返回单课报告(status PASS/PASS_WITH_WARNINGS/FAIL); ' +
        '传 course_id 按 lessons.order 顺序逐课校验, 给 course 级三档汇总 ' +
        '(lesson_count/overall_status/lessons[])。id 不存在或 course 下无 lesson → code: NOT_FOUND。' +
        '默认紧凑报告: status + errors/warnings 逐条原文 + check_counts {pass, skip} 计数; ' +
        'verbose:true 取全表 (checks 逐条含 pass/skip 项, 与旧版逐字同形)。' +
        '等价于 `npx tsx scripts/validate-prep.ts <id> --json` 的 MCP 化版本(同一份判定实现, CLI 恒为全表)。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          lesson_id: { type: 'string', description: '与 course_id 二选一——校验单节课成套教具的自洽性 (脑图仅当配了才查)' },
          course_id: { type: 'string', description: '与 lesson_id 二选一——按 order 顺序逐课校验, 给 course 级汇总' },
          verbose: {
            type: 'boolean',
            description:
              '默认 false=紧凑报告 (errors/warnings 逐条 + pass/skip 计数); true=逐条全表 checks (旧版全形状)。',
          },
        },
        required: [],
      },
    },
    {
      name: 'grade_exercise',
      description:
        '批改一条 ExerciseSubmission. agent 异步收到 pair://exercises/pending 后调用. ' +
        '判错递笔: score 给了且落进判错区间时, 回执带 concept_refs (这道题已解出的概念 id, ' +
        '白拿, 不用你再走一遍 exercise→concept) + human_note 一句顺手提示——配不配张针对性闪卡纯属你裁量, ' +
        '不进 next_recommended_actions, 不是义务。' +
        '重批持证: 已 graded 的提交要改判, 必须显式带 regrade: true——缺省会被 CONFLICT 拒绝。' +
        '改判自由, 痕迹免费: 放行时旧判决摘要 (previous_score/previous_feedback) 自动写进追加的 ' +
        'exercise.graded 事件 payload, 历史不蒸发。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          submission_id: { type: 'string' },
          feedback: { type: 'string' },
          score: {
            type: 'number',
            description: '可选；0..1 的软评分（闭区间），85% 请写 0.85，不要写 85——server 会拒绝越界值',
          },
          regrade: {
            type: 'boolean',
            description:
              '改判意图声明: 该提交已有判决 (status=graded) 时必须显式传 true 才放行; 首判不需要。',
          },
          idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
        },
        required: ['submission_id', 'feedback'],
      },
    },
    {
      name: 'record_post_lesson_evaluation',
      description:
        '写一条 PostLessonEvaluation (纯事实层, 每节课末尾都写, 不打 confidence 标签). ' +
        '一次判决原则: 总评做增量, 不复判——agent_observation 只装三样内容: ①整体判断 ' +
        '②与 Live 表现的对照 ③下一课建议。永不逐题复述习题: 习题的判决在 grade_exercise 记录上, ' +
        '不把评语再写一遍——要指向具体作业, 把 id 填进 evidence_refs, 正文保持人话。' +
        '3-课阈值规则见 TEACHING-SPEC §4.3. ' +
        '空评估拒收: concepts_touched / flashcards_reviewed_count / flashcards_rating_distribution / ' +
        'exercises_submitted_count / live_turns_count / duration_minutes / agent_observation 至少一项非默认值——' +
        '全默认(空数组+全 0+空字符串) 会污染 learner brief, 直接拒收。' +
        '(pair_id, lesson_id) 唯一索引(迁移 0030): 一课一份总评——第二次对同一课调用本工具是修订, ' +
        '服务端 update-in-place(不插新行), 回执里会说明这是 update 而不是新建。' +
        '回执自带闭环进度——不用另查状态机。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          lesson_id: { type: 'string' },
          learning_session_id: {
            type: 'string',
            description:
              '可选——挂靠的 learning_session id (迁移 0030 从 session_id 改名而来, 名实相符). 旧名 session_id 已不再接受.',
          },
          session_id: {
            type: 'string',
            description:
              '已改名——声明这个字段只是为了给出精确的改名错误(见 learning_session_id); 传了但没同时传 ' +
              'learning_session_id 会被拒收并指路改名, 不会被静默接受当作旧字段用。',
          },
          concepts_touched: { type: 'array', items: { type: 'string' } },
          flashcards_reviewed_count: { type: 'number' },
          flashcards_rating_distribution: {
            type: 'object',
            additionalProperties: false,
            description: '{ Again, Hard, Good, Easy } counts, default all 0',
            properties: {
              Again: { type: 'number' },
              Hard: { type: 'number' },
              Good: { type: 'number' },
              Easy: { type: 'number' },
            },
          },
          exercises_submitted_count: { type: 'number' },
          live_turns_count: { type: 'number' },
          duration_minutes: { type: 'number' },
          agent_observation: {
            type: 'string',
            description:
              '三段增量 (一次判决原则): 整体判断 / 与 Live 表现的对照 / 下一课建议。不逐题复述习题——' +
              '不重写评语——要指向具体作业, 把 id 填 evidence_refs。三通道制 ' +
              '**口径收窄 (2026-07-26, 学习者当面裁定)**: 本段会出现在学习者的折叠区 ' +
              '("Teaching observation"), 已不再是纯内账——**内部 id 一律只进 evidence_refs, ' +
              '不写进任何散文字段**。原"写这里或 evidence_refs"的二选一就此作废: 学习者读得到的地方, ' +
              '就不写机器词。',
          },
          learner_note: {
            type: 'string',
            description:
              '可选——学习者可见的人话版 (三通道制)。语言用 learners.locale (brief 的 ' +
              'identity.learner.locale 可见); 不含任何内部 id (sub_/tr_/evt_ 等机器词)。',
          },
          evidence_refs: {
            type: 'array',
            items: { type: 'string' },
            description:
              '可选——机器引用通道 (三通道制): 本判断依据的真实 id (sub_/tr_/evt_/snap_ 等)。' +
              '服务端逐 id 验存在+同 pair 归属, 幽灵引用直接拒——证据先于叙事。',
          },
          idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
        },
        required: ['lesson_id'],
      },
    },
    // 迁移 0030 (设计稿 §9.1/9.2, 评估拆分): 一场 live session 一份现场评估,
    // 一节课一份总评 (PostLessonEvaluation) — 两层分开写、分开读, 不互相摊平:
    // 一课可能横跨多场 live session, 每场各自的现场观察不该被课级总评抹平。
    {
      name: 'record_live_evaluation',
      description:
        '写一条 LiveSessionEvaluation (现场评估, 挂在单场 live_session 上, 不是课级总评——那是 ' +
        'record_post_lesson_evaluation). 一次判决原则: 收课的正门是 live_session_complete 携可选 ' +
        'evaluation 一笔写完 (收课+场评一次动作)——本工具是收课时漏带场评的补写通道, 不是第二次判决的机会. ' +
        '前置: live_session 存在且 status=completed(先 live_session_complete 收课, 再写现场评估). ' +
        '一场一评(live_session_id 唯一索引)——撞了就幂等返回已有那条, 不二次写入、不覆盖。' +
        'agent_observation 必填非空——短判词, 不复述课堂过程; 要锚到具体对话条目, id 填 ' +
        'evidence_refs, 本段保持人话 (学习者会在折叠区读到它)。' +
        '回执自带闭环进度(该场挂课时)——不用另查状态机。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          live_session_id: { type: 'string', description: '必须是已存在且 status=completed 的 live_session id.' },
          agent_observation: {
            type: 'string',
            description:
              '必填非空——这场现场课的观察记录: 短判词, 不复述过程。三通道制 ' +
              '**口径收窄 (2026-07-26, 学习者当面裁定)**: 本段会出现在学习者的折叠区 ' +
              '("Teaching observation"), 已不再是纯内账——**内部 id 一律只进 evidence_refs, ' +
              '不写进任何散文字段**。原"写这里或 evidence_refs"的二选一作废: 学习者读得到的地方, ' +
              '就不写机器词。',
          },
          learner_note: {
            type: 'string',
            description:
              '可选——学习者可见的人话版 (三通道制)。语言用 learners.locale; 不含内部 id 机器词。',
          },
          evidence_refs: {
            type: 'array',
            items: { type: 'string' },
            description:
              '可选——机器引用通道: 判词锚到的具体 id (tr_/evt_/snap_ 等)。服务端逐 id 验存在+' +
              '同 pair 归属, 幽灵引用直接拒。',
          },
          concepts_touched: { type: 'array', items: { type: 'string' } },
          live_turns_count: { type: 'number' },
          duration_minutes: { type: 'number' },
          idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
        },
        required: ['live_session_id', 'agent_observation'],
      },
    },
    {
      name: 'record_learner_hypothesis',
      description:
        '写一条 LearnerHypothesis (3 课之后才允许首次写, agent 自己 enforce). ' +
        '若 domain 命中学习者的观察禁区登记簿, 直接不写入 (不报错, 返回说明). ' +
        '禁令 (Confidence 主权立法): 关于学习者 confidence 水平/校准好坏的推断——' +
        '"她的把握度偏低" "她高估/低估自己" 这类判词——不得作为 hypothesis 记录。' +
        '那是当次反思(reflect_on_teaching)才配装的东西, 不是可教状态, 不许经这个' +
        '工具进 learner_hypotheses/学生画像的前馈通道。' +
        ' 生命周期扩展 (同一支笔的续写面): 带 hypothesis_id + action 时不再创建, ' +
        '而是对既有假设做 reinforce(证据续期: last_evidence_at 推到当下, 可附 ' +
        'evidence_event_ids 追加)/revise(新文本超越: 旧行转 expired 留痕, 新行承接' +
        '在场状态与证据账, 回执给 superseded_hypothesis_id)/retire(老师判旧转 expired, ' +
        '与学习者 reject 分属两支)。主权层级: confirmed/rejected/frozen 是学习者判决' +
        '——rejected/frozen 三动作全拒, confirmed 只许 reinforce。没有证据喂养的假设' +
        '在简报里会读作 stale (纯提示, 不自动退役)——有证据就 reinforce, 被推翻就 ' +
        'revise/retire, 别让账本长灰。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          domain: { type: 'string', description: '创建路径必填; 带 action 时忽略 (沿用原行 domain)。' },
          observation: {
            type: 'string',
            description: '创建路径与 action=revise 必填 (revise 的新文本); reinforce/retire 不需要。',
          },
          confidence: {
            type: 'number',
            description: '0..1。创建路径必填; revise 可选 (缺省沿用旧行); reinforce/retire 忽略。',
          },
          evidence_event_ids: {
            type: 'array',
            items: { type: 'string' },
            description: '创建时初始证据; reinforce/revise 时追加进原行证据账 (去重)。',
          },
          hypothesis_id: {
            type: 'string',
            description: '生命周期动作的目标假设 id——与 action 成对出现, 单给报错。',
          },
          action: {
            type: 'string',
            enum: ['reinforce', 'revise', 'retire'],
            description:
              'reinforce=证据续期 revise=新文本超越(旧行留痕) retire=老师判旧。' +
              '与 hypothesis_id 成对出现; 不带则走创建路径。',
          },
          idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
        },
        required: [],
      },
    },
    {
      name: 'reflect_on_teaching',
      description:
        '写一份 TeacherReflection (每节课末尾, 第 3 课起开始升级). ' +
        '§1-§5: 归因骨架已收紧——必须站队一个主归因、' +
        '给证据、给反事实、挂一个类型匹配的 action_link；weather(⑥天气)必须带 weather_expires_at 且' +
        '禁止触发任何学习者画像写入，过期即焚。呈现全静默：返回值只捎带一行近 20 次主归因计数，' +
        '不进任何 UI。' +
        ' 反思挂锚: lesson_id/live_session_id 可选, 但推荐至少挂 lesson_id —— ' +
        '反思挂在课上, 下一任老师才能按课读回"这节课到底反思过没有", 而不是靠 pair 级近似猜。' +
        '两者若填写, server 会校验存在性 + 与当前 pair 一致(lesson 经 courses.pair_id, ' +
        'live_session 经 live_sessions.pair_id), 不属于本 pair 的 id 直接拒写。' +
        ' 挂锚推断: lesson_id 不填时 server 会从现场上下文强推断——依次看 live_session_id ' +
        '指向的场次的课 / 当前唯一 active 的 Live 教室 / 24h 内最近一场 Live 课; 推断命中会替你挂上并在' +
        '回执明示来源(created_refs.anchored_lesson_id + human_note), 推不出则落无主反思并在回执警告: ' +
        '无主反思不计入任何课的 closure(closure_progress.reflection 会一直显示缺)。' +
        '回执自带闭环进度(带 lesson 锚时, 显式或推断皆算)——不用另查状态机。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          method: { type: 'string' },
          rationale: { type: 'string' },
          expected_outcome: { type: 'string' },
          actual_evidence: { type: 'string' },
          what_worked: { type: 'array', items: { type: 'string' } },
          what_failed: { type: 'array', items: { type: 'string' } },
          next_action: { type: 'string' },
          primary_attribution: {
            type: 'string',
            enum: [
              'not_yet_mastered',
              'material_flaw',
              'difficulty_timing',
              'path_mismatch',
              'judgment_error',
              'weather',
              'path_worked',
            ],
            description:
              '必填单选，逼出立场：not_yet_mastered=①学生尚未掌握 material_flaw=②教学材料有误或不完整 ' +
              'difficulty_timing=③难度与时机不合适 path_mismatch=④解释路径不适合这个人 ' +
              'judgment_error=⑤原判断本身就错 weather=⑥天气(同日状态性噪音: 累/疼/心不在焉) ' +
              'path_worked=⑦路径适配、如预期奏效——全对的课选这个，但必须写出什么奏效了、证据是哪几次' +
              '作答；"一切都好"不带证据等于什么都没说。禁止在有真实问题时用它逃避归因.',
          },
          secondary_attribution: {
            type: 'string',
            enum: [
              'not_yet_mastered',
              'material_flaw',
              'difficulty_timing',
              'path_mismatch',
              'judgment_error',
              'weather',
              'path_worked',
            ],
            description: '可选，至多一个，且必须不同于 primary_attribution——留一格诚实，不是多选打勾.',
          },
          evidence: {
            type: 'string',
            description: '必填。本次 session 里的具体观察，不是归因的同义复述.',
          },
          counterfactual: {
            type: 'string',
            description:
              '必填。防自利归因机关(§3)：一句话——"如果真相是（另一个最可信的归因），' +
              '我预期会看到 X；我实际看到的是 Y。"',
          },
          action_link: {
            type: 'object',
            additionalProperties: false,
            description:
              '必填。归因必须接行动(§4)，否则只是日记。type 由 primary_attribution 决定: ' +
              'not_yet_mastered→review_action material_flaw→lesson_revision ' +
              'difficulty_timing→course_adjustment path_mismatch→intervention_note ' +
              'judgment_error→hypothesis_update weather→retest_only ' +
              'path_worked→hypothesis_update(证实现有假设, 走 confidence-up 而非 judgment_error 的纠错方向). ' +
              '**ref_id 的合法落点按 type 定死如下**(服务端逐一验存在+同 pair 归属, 幽灵引用直接拒 ' +
              '——所以不必试探, 照表填即可): review_action→flashcards / exercises / concepts / lessons; ' +
              'lesson_revision→lesson_revisions(最精确: 填 update_lesson 回执里的 lesson_revision_id) / lessons; ' +
              'course_adjustment→courses / lessons; ' +
              'intervention_note→lessons / live_sessions / session_events / lesson_patches; ' +
              'hypothesis_update→learner_hypotheses; retest_only→exercises / flashcards / lessons。' +
              '**注意六类里有五类都收 lessons**——拿本课的 lesson_id 当落点是合法的, 不是权宜之计。',
            properties: {
              type: {
                type: 'string',
                enum: [
                  'review_action',
                  'lesson_revision',
                  'course_adjustment',
                  'intervention_note',
                  'hypothesis_update',
                  'retest_only',
                ],
              },
              ref_id: { type: 'string', description: '指向具体行动记录的 id.' },
            },
            required: ['type', 'ref_id'],
          },
          weather_expires_at: {
            type: 'string',
            description:
              '仅 primary_attribution=weather 时必填 (ISO timestamp)，过期即焚——过期后不再出现在任何读路径.',
          },
          lesson_id: {
            type: 'string',
            description:
              '可选, 推荐填——挂锚这份反思是为哪节课写的。反思挂在课上, 下一任老师才能按课' +
              '读回, 而不是靠 pair 级近似猜。填了会校验: 必须是已存在的 lesson id, 且属于当前 pair。' +
              '不填时 server 会从现场上下文强推断 (见工具描述); 推断也落空则该反思不计入' +
              '任何课的 closure。',
          },
          live_session_id: {
            type: 'string',
            description:
              '可选——挂锚这份反思是为哪场 Live 课写的。填了会校验: 必须是已存在的 ' +
              'live_session id, 且属于当前 pair。',
          },
          idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
        },
        required: ['method', 'rationale', 'next_action', 'primary_attribution', 'evidence', 'counterfactual', 'action_link'],
      },
    },
    // ========================================================================
    // 现场反馈笔 — 反馈没有专用入口: 学习者的日常消息就是入口,
    // 老师在正常对话里识别 issue/idea 并落账。软牙齿: open 反馈只在
    // get_teacher_inbox 发光, 永不阻塞 close_lesson_loop。
    // ========================================================================
    {
      name: 'record_learner_feedback',
      description:
        '现场反馈笔: 学习者在日常消息里提出关于产品或教学的 issue/idea 时, 用这支笔落账——' +
        '反馈没有专用 UI 入口, 她的每一个普通输入框都是入口, 识别是你的义务。' +
        '逐字纪律: text 存她的原话, 不是你的转述——转述是二次判决, 原话才是证据。' +
        '挂锚 (lesson_id/live_session_id/exercise_id 可选): 填了就必须真实, server 校验存在性 + 属于当前 pair; ' +
        'source_message_ref 是自由文本引用 (live 消息可能活在 bridge 事件流里), 只存不校验。' +
        '落账必回执: 记录成功后, 你必须在同一回合向学习者回一句确认——她要知道她的话被记下了, ' +
        '静默落账等于没落账。软牙齿: open 反馈只在 get_teacher_inbox 发光提醒, 永不阻塞 close_lesson_loop。' +
        '观察边界(禁区)变更也走这支笔 (Settings 观察禁区 UI 已撤下, 边界协商回到第一序对话)——' +
        '学习者在对话里谈"不要再观察/记录某类"或"撤回某个边界"时, 用 boundary_update 参数带上; ' +
        '绝不能凭对话印象私自认定/静默生效, 不填 boundary_update 就不改变任何边界。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: {
            type: 'string',
            enum: ['issue', 'idea'],
            description: "封闭两类, 没有第三种: issue=问题/障碍 (产品或教学哪里不对), idea=想法/建议 (她想要什么).",
          },
          text: {
            type: 'string',
            description: '必填。学习者的原话, 逐字——不许转述、不许润色、不许翻译成你的话.',
          },
          lesson_id: {
            type: 'string',
            description: '可选挂锚——反馈发生时正在学哪节课。填了会校验: 存在且属于当前 pair.',
          },
          live_session_id: {
            type: 'string',
            description: '可选挂锚——反馈发生在哪场 Live。填了会校验: 存在且属于当前 pair.',
          },
          exercise_id: {
            type: 'string',
            description: '可选挂锚——反馈针对哪道题。填了会校验: 存在且 (经 lesson→course) 属于当前 pair.',
          },
          source_message_ref: {
            type: 'string',
            description: '可选自由文本引用——她这句话出自哪条消息 (adhoc message id / bridge event id / 你能指认的任何 ref)。不校验, 只存.',
          },
          note: {
            type: 'string',
            description: '可选。老师落账时的补充说明 (存入 status_note; 之后 update_feedback_status 带 note 时会覆盖).',
          },
          boundary_update: {
            type: 'object',
            additionalProperties: false,
            description:
              '可选。只在这条反馈本身就是一次观察边界(禁区)请求时才填——不要脑补, 只在学习者' +
              '原话真的在谈"不要观察/记录某类东西"或"这个可以恢复观察了"时才带。{action:"add"|"remove", ' +
              'boundary: 非空字符串(禁区类别名)}。add=新增禁区、remove=撤销既有禁区, 均幂等(已是目标状态则' +
              '原样返回, 不报错、不二次写入)。与本工具的 text(反馈原话)在同一次调用里原子落账——不另开审计表, ' +
              'text 字段本身就是这次边界变更的逐字留痕, 这也是把它折进这支笔而不单开工具的原因。生效时点: ' +
              '下一次 get_learner_brief 才会体现, 当前进行中的这轮教学看到的仍是旧边界。',
            properties: {
              action: {
                type: 'string',
                enum: ['add', 'remove'],
                description: "add=新增禁区(学习者要求'以后不要再观察/记录这一类'); remove=撤销既有禁区(学习者要求'这个可以恢复观察了').",
              },
              boundary: {
                type: 'string',
                description: '禁区类别名(非空字符串)——学习者原话里指认的那个观察类别/主题, 与 pair.forbidden_observations 里存的字符串同形.',
              },
            },
            required: ['action', 'boundary'],
          },
          idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
        },
        required: ['kind', 'text'],
      },
    },
    {
      name: 'update_feedback_status',
      description:
        '推进一条学习者反馈的生命周期: open → acknowledged → addressed/declined。' +
        'addressed/declined 是终态, 不可再改。declined 必须带 note——拒绝欠判词, ' +
        '拒绝的理由保护接受的价值; acknowledged/addressed 的 note 可选。' +
        '软牙齿: 不推进状态不拦任何闸门 (close_lesson_loop 不看这张表), 但 open 反馈会一直在 ' +
        'get_teacher_inbox 里发光。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          feedback_id: { type: 'string', description: 'record_learner_feedback 回执里的 feedback id.' },
          status: {
            type: 'string',
            enum: ['acknowledged', 'addressed', 'declined'],
            description:
              'acknowledged=看到了、在想; addressed=已处理 (改了课/修了产品/回应了诉求); ' +
              'declined=不采纳 (必须带 note 说明为什么).',
          },
          note: {
            type: 'string',
            description:
              "老师的判词, 存入 status_note。declined 时必填 (declining requires the teacher's reasoning — 老师欠判词); 其余可选.",
          },
          idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
        },
        required: ['feedback_id', 'status'],
      },
    },
    // ========================================================================
    // Read-back / orient tools — the "eyes" to match record_learner_hypothesis /
    // record_post_lesson_evaluation / reflect_on_teaching's write-only "pen".
    // Both are read-only, token-frugal by design: counts + one-line summaries,
    // never full text. Pull the granular tool/resource once you know what to open.
    // ========================================================================
    {
      name: 'get_context',
      description:
        '一发式冷启动定位: session 醒来先调这个, 拿到"现在这个 pair 处在哪"的紧凑快照, 而不是自己拼 live_pending + snapshot + thread 好几刀. ' +
        '输入 { pair_id? } (缺省用当前 active pair). 返回: active_contracts (id/title/setup_status/一行 progress' +
        '/source_material——合约带自带教材条款时的一行亮灯"教材:《书名》·档位"; null=没谈教材) + ' +
        'recent_lessons (最近 1-2 节课的 id/title/status, 来自最近的 PostLessonEvaluation, 没有活动记录时退回 course 前两节) + ' +
        'pending_pool ({count, latest_titles} 脑图待整理池, 不含全量) + ' +
        'live_session (最近一次 id/status/ended_at + 最新 snapshot 的存在性+时间戳, 不含全文) + ' +
        'unread_adhoc_count (最近一次 agent 回复之后学生新发的 adhoc 消息数) + active_reminder_count (未 fire 且未 dismiss 的提醒数). ' +
        'Etag 契约: 返回体带 brief_etag (默认口径 learner brief 的内容指纹) —— 与上次记住的 ' +
        'brief_etag 一致 ⇒ 学生模型没变, 跳过 get_learner_brief 重拉; identity 只给 learner_id/agent_id, ' +
        '称谓全量在 get_learner_brief。pair_id 不存在时报错并附可用 pair 列表.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pair_id: { type: 'string' },
        },
        required: [],
      },
    },
    {
      name: 'get_learner_brief',
      description:
        '开课前先调这个: 读回学生模型 (learner_hypotheses / post_lesson_evaluations / teacher_reflections), 不用自己扒表。' +
        '输入 { pair_id?, limit? } (limit 默认 5, clamp [1,20]; pair_id 缺省用当前 active pair)。返回: ' +
        'top_confidence_hypotheses (在场假设按 confidence 降序取 top-limit) + ' +
        'needs_reverification (在场假设里 last_verified_at 最老/为空的前 2 条, 该复验了) + ' +
        'recent_evaluations (最近 3 条 PostLessonEvaluation 摘要, 含 agent_observation) + ' +
        'latest_reflection (最近一条 TeacherReflection 的 method/next_action) + ' +
        'confidence_facts (近三课把握度中性事实聚合: lesson_ids + total_count + overall_accuracy + ' +
        'by_level[{level,count,accuracy}], 纯数字词频——没有形容词、没有"她低估/高估自己"这类判词, ' +
        '也没有百分比锚值; 没数据时为 null) + ' +
        'source_material (自带教材条款一行亮灯: 当前合约带 source_material 时给"教材:《书名》·档位", ' +
        '档位语义/外延标记纪律见 skill workflow/lesson-prep 教材模式; null=当前合约没谈教材)。' +
        '学生主权红线: allowed_for_teaching=false 的假设一律不吐 observation/domain/confidence 等内容, 只回 {id, allowed_for_teaching:false, redacted:true} —— ' +
        '冻结的假设不该被这个读回口子悄悄泄回教学决策。' +
        'Etag 契约: 返回体带 brief_etag (内容指纹, generated_at 不计入) —— 与上次同参数调用一致 ⇒ 学生模型没变, 可复用上次已读内容不必重读。' +
        'pair_id 不存在时报错并附可用 pair 列表. ' +
        '可选 lesson_id — 传了且这节课有挂锚反思(teacher_reflections.lesson_id 命中)时, ' +
        'latest_reflection 优先给这节课的那条; 没有挂锚数据时退回原有的 pair 级最新一条。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pair_id: { type: 'string' },
          limit: { type: 'number', description: 'default 5, clamp [1, 20]' },
          lesson_id: {
            type: 'string',
            description: '可选——传了会优先按这节课过滤 latest_reflection(反思挂锚)。',
          },
        },
        required: [],
      },
    },
    {
      name: 'get_teacher_inbox',
      description:
        '增量教师待办清单 (Agent Surface Hardening 第一批, P1) — 醒来先看这个而不是自己拼 ' +
        'live_pending + submissions + adhoc 好几刀. 输入 { pair_id?, since? } (since 缺省=全量, ' +
        'ISO 时间戳游标——服务端不维护游标状态, 消费方自己记住 max(occurred_at) 下次传回). ' +
        '来源: 待批改 submission / 无 reflection 的已结束 live session / 学习者新 adhoc 消息 / ' +
        '近 24h 同一张卡 ≥3 次 Again / proposed 未签合同. 每项 { item_id(确定性), type, priority, ' +
        'resource_refs, recommended_tool, occurred_at }, 按 priority (high→low) 排序, 同优先级按 ' +
        'occurred_at 升序. 无待办返回空数组. 另附 open_feedback 段 (现场反馈笔): ' +
        'status=open 的学习者反馈 count + 最近若干条摘要 (kind/原话节选/挂锚/账龄)——纯发光提醒, ' +
        '软牙齿: 不阻塞任何闭环动作, 回应它用 update_feedback_status.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pair_id: { type: 'string' },
          since: { type: 'string', description: 'ISO timestamp cursor, 缺省=全量待办' },
        },
        required: [],
      },
    },
    // ------------------------------------------------------------------------
    // Content read-back — the granular tools get_context's compact
    // snapshot points at: a teacher can finally read back what it taught
    // (military rule "批改前先审教材" / resume-teaching cold start).
    // ------------------------------------------------------------------------
    {
      name: 'get_lesson',
      description:
        '读回一节课: 标题 / 结构 (概念+习题清单) / 发布状态 (published: published_at 非空=已发布, 空=草稿) / ' +
        '正文。默认紧凑 (include_content 缺省 false): 只给结构与元数据 + content_chars 全文字数 + 开头节选, ' +
        '不吐全文 — token 经济。要读全文 (批改前审教材 / resume-teaching 冷启动接课) 显式传 ' +
        'include_content: true, 返回体多一个 content_markdown 字段 (可能很长, 确认要再开)。' +
        '只能读当前 pair 的课, 其他 pair (或不存在) 的 lesson_id 一律 NOT_FOUND。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          lesson_id: { type: 'string', description: '必填; 要读回的 lesson id (lsn_ 前缀), 须属当前 pair' },
          include_content: {
            type: 'boolean',
            description:
              '可选, 默认 false (紧凑: 结构+元数据+节选)。true = 附 content_markdown 全文 — 只在真要读课文时开。',
          },
        },
        required: ['lesson_id'],
      },
    },
    {
      name: 'get_exercise',
      description:
        '读回一道习题: prompt / reference_answer / expected_concepts / tags / 所属 lesson ' +
        '(lesson_id + lesson_title + course_id)。批改前先审教材用这个取题面与评分标准。' +
        'reference_answer 是评分钥匙 (教师侧机密) — 不要原样透给学习者。' +
        '只能读当前 pair 的题, 其他 pair (或不存在) 的 exercise_id 一律 NOT_FOUND。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exercise_id: { type: 'string', description: '必填; 要读回的 exercise id (ex_ 前缀), 须属当前 pair' },
        },
        required: ['exercise_id'],
      },
    },
    {
      name: 'get_submission',
      description:
        '读回一份学习者提交: learner_answer 答案正文 / status 批改状态 (枚举 draft | submitted | ' +
        'pending_grade | graded) / agent_score / agent_feedback / 把握度 (confidence, 可空) / 所属 exercise 链 ' +
        '(exercise_id + exercise_prompt_excerpt + lesson_id + course_id)。批改与复盘的读回面 — ' +
        '配合 get_exercise 取 reference_answer 后再 grade_exercise。' +
        '只能读当前 pair 的提交, 其他 pair (或不存在) 的 submission_id 一律 NOT_FOUND。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          submission_id: { type: 'string', description: '必填; 要读回的 submission id (sub_ 前缀), 须属当前 pair' },
        },
        required: ['submission_id'],
      },
    },
    // ========================================================================
    // Live Teaching (Stage 7d) — agent side of the bridge.
    // ========================================================================
    {
      name: 'live_pending',
      description:
        '这不是值更工具 —— 值更请挂 live_wait 或后台看门脚本 scripts/live-watch.py, 反复空手调用这个属违纪(值更契约红线)。' +
        'live_pending 只做一件事: 拍一张 Live Teaching pending queue 的快照 (bridge 状态 + 按优先级排序的 sessions, ' +
        'ad_hoc_question > ad_hoc_response > session_start > guided_response), 不阻塞、不等待。没传 pair_id 时用当前 active pair. ' +
        '牙齿: 同一 pair 在 90s 内连续 6 次空手调用 (queue 里什么都没有) 会在回执里附结构化警告字段, 连续 12 次直接拒答该次查询——' +
        '真有 pending 数据的调用永远正常返回并重置计数, 牙齿不吞真实数据。值更契约 v3(方法自由): 看门脚本 scripts/live-watch.py 与 ' +
        'live_wait 阻塞调用是平级合法路径, 你家 harness 有更好的监听机制也行——考核只看红线加四条目标, 见 recipe://live-teaching。' +
        '每个 live_teaching item 带 pending_reason (session_start / learner_response_waiting / agent_owes_move): ' +
        'agent_owes_move 类只在 pending 快照出现, 不走 wait 事件流——欠的 move 是你的债, 不是学习者的事件。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pair_id: { type: 'string' },
        },
        required: [],
      },
    },
    {
      name: 'live_heartbeat',
      description:
        'Agent 端 keep-alive. 在 ttl_seconds 内 bridge 算 online. ⚠️ ttl_seconds 是在线判定窗口, NOT 轮询间隔. 值更契约 v3: 等待不烧模型回合(红线: 禁止模型层轮询), 用看门脚本/live_wait/你家自己的监听机制均可, 见 recipe://live-teaching. 看门脚本会替你打心跳; 走 live_wait 的, 它自带 auto-heartbeat. 回应契约(单层 v3): 实质回答质量优先, 不设硬秒数, 在场感由在线灯负责不由报文. (旧 context_status 参数已退役——上下文余量指示灯已整体拆除, 心跳只管在线.)',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pair_id: { type: 'string' },
          ttl_seconds: { type: 'number', description: 'default 60, clamp [15, 600]' },
        },
        required: [],
      },
    },
    {
      name: 'live_wait',
      description:
        '一次调用 ≈50 秒静默等待, 数据即到即返, 超时重挂即可 —— 这是等待, 不是轮询。' +
        '阻塞等待下一个 Live Teaching / AdHoc 事件 (与 GET /bridge/wait 共用同一份等待逻辑, ' +
        'lib/live-wait.ts) —— MCP 原生的零空转值更: 比反复调用 live_pending 省 token, ' +
        '不用自己算轮询间隔。timeout_s 上限 50 (留出 MCP 客户端自身超时的余量), 缺省即用上限. ' +
        '超时未等到事件 → timeout=true, events=[], 直接再挂一次即可, 不必先调 live_pending 探路。' +
        '每次调用顺手续一次 heartbeat (ttl 60), 等待期间在线灯不灭。可选 consumer_id: 传了就走服务端 ' +
        '持久化 delivery cursor (断点续传) —— 同一 consumer_id 下次调用不传 since 就自动从上次的断点继续, ' +
        '传 since 则视为"上一批我已处理完"的确认并推进游标; 不传 consumer_id 时行为与旧版一致(每次都从此刻起等)。' +
        '契约版本协议: 每个响应都带 contract_version, 把它作为 known_contract_version 传回, ' +
        '命中现行版时超时/事件响应都不再重发 live_runtime_contract 全文 (只留 contract_version + may_end_turn), ' +
        '缺省或版本过期则完整合约照发。' +
        '值更契约 v3(方法自由): 本工具与后台看门脚本 scripts/live-watch.py 是平级合法路径, 你家 harness 有 ' +
        '自己的监听原语也行——考核只看红线加四条目标, 见 recipe://live-teaching。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pair_id: { type: 'string' },
          timeout_s: { type: 'number', description: '默认/上限 50, clamp [1, 50]' },
          consumer_id: {
            type: 'string',
            description: '可选。传了才启用服务端持久化游标 (断点续传); 省略则与旧版行为完全一致。',
          },
          since: {
            type: 'string',
            description:
              '可选。带 consumer_id 时: 传 since 等于确认"上一批事件我已处理完", 服务端据此推进该 consumer_id ' +
              '的持久化游标; 省略则读取上次持久化的游标续等。不带 consumer_id 时: since 仅对本次调用生效(从该游标起等), 不落库。',
          },
          known_contract_version: {
            type: 'string',
            description:
              '可选。传上一次响应里的 contract_version: 命中现行版 ⇒ 响应省略 live_runtime_contract ' +
              '全文, 只带 contract_version + may_end_turn; 缺省/过期 ⇒ 完整合约照发 (首次完整)。',
          },
        },
        required: [],
      },
    },
    {
      name: 'live_session_get',
      description:
        '读 LiveSession 全貌 (session + 全部 moves + 全部 responses). 决定下一步前必读.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string' },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'live_message_send',
      description:
        '追加一条 Teaching Move (Live Teaching 结构化教学). 会话第一条 move (seq=1) 必须 move_type="FRAME"——否则结构化拒绝, 不接受其他类型开场. FRAME content 须覆盖三要素: 本场做什么/多久/怎么算完. ASK/PROBE/CHALLENGE 必须 response_kind="text". REFLECT 必须 "none". content 控制在 300 中文字以内 (EXPLAIN). 一个 move 只做一件事. 自由对话/答疑请用 adhoc_message_send.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string' },
          move_type: {
            type: 'string',
            enum: ['FRAME', 'ASK', 'EXPLAIN', 'PROBE', 'HINT', 'CHALLENGE', 'REFLECT'],
            description: 'FRAME|ASK|EXPLAIN|PROBE|HINT|CHALLENGE|REFLECT',
          },
          content: { type: 'string' },
          response_kind: {
            type: 'string',
            enum: ['none', 'text', 'continue'],
            description: 'none|text|continue — none 不交轮(轮次留在老师), text/continue 交轮等学习者',
          },
          payload: { type: 'object' },
          source_type: { type: 'string' },
          source_id: { type: 'string' },
          idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
        },
        required: ['session_id', 'move_type', 'content', 'response_kind'],
      },
    },
    // ----- Mid-lesson snapshot (Stage 7e, compact recovery) -----
    {
      name: 'live_snapshot_write',
      description:
        '在 Live Teaching session 中段 flush 一个 rolling checkpoint. 建议每 3 轮写一次. compact 后用 live_snapshot_get_latest 拿回来, 不用重读全部 moves.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string' },
          after_turn_n: { type: 'number', description: '当前已完成的 move seq' },
          rolling_summary: { type: 'string', description: '到目前为止 learner 学到了什么' },
          current_direction: { type: 'string', description: '现在 agent 在朝什么方向推' },
          weak_signals: {
            type: 'array',
            items: { type: 'string' },
            description: '观察到的薄弱点 / 待跟进的概念缺口',
          },
          idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
        },
        required: ['session_id', 'after_turn_n', 'rolling_summary', 'current_direction'],
      },
    },
    {
      name: 'live_snapshot_get_latest',
      description:
        '读 session 最近一份 mid-lesson snapshot. compact 恢复时第一步: snapshot + 之后的 moves = 续上 session 的最小集.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { session_id: { type: 'string' } },
        required: ['session_id'],
      },
    },
    // ----- AdHoc Thread tools (Stage 7d-fix) -----
    {
      name: 'adhoc_thread_get',
      description:
        'Get-or-create 这个 pair 的长存 AdHoc thread. 默认用当前 pair. ' +
        '值更循环里带上你已读到的最后一条 id 只取增量 (after_message_id) —— 全量回读烧的是学习者的钱' +
        '（值更契约·低损耗）；全量仍合法：首次上任/断档补课时用 (不传 after_message_id 即全量, 缺省行为不变).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pair_id: { type: 'string' },
          after_message_id: {
            type: 'string',
            description:
              '可选。只返回这条消息 id 之后的新消息 (增量读, 与 live_wait/GET /bridge/wait 同一套 ' +
              'isNewerEventId 排序语义). 缺省=全量回读整个消息历史——仅在首次上任/断档补课时用, ' +
              '值更循环里请传上一次读到的最后一条消息 id.',
          },
        },
        required: [],
      },
    },
    {
      name: 'adhoc_ack',
      description:
        '消账 —— 学习者明说不必回、或你判断该消息无需回应时调用: 它从 pending (live_pending / ' +
        'GET /bridge/pending)、桥事件 (live_wait / GET /bridge/wait) 与 teacher inbox 里退场, ' +
        '但消息本身仍保留, 可随时用 adhoc_thread_get 读回. 缺省 message_id 时消账到该 thread ' +
        '当前最新一条. 幂等: 重复 ack 同一条不报错. 滥用即失职: 拿 ack 逃避该回的问题, 学习者看得见.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          thread_id: { type: 'string' },
          message_id: {
            type: 'string',
            description: '可选。消账到这条消息 id (含). 缺省=消账到该 thread 当前最新一条消息.',
          },
        },
        required: ['thread_id'],
      },
    },
    {
      name: 'adhoc_message_send',
      description:
        'Agent 在 AdHoc thread 里回应用户. 自由对话不限 move_type. 富内容用 payload (component_type: interactive_html | whiteboard_svg | tts_audio + body). 学习相关写 is_learning_related=true 会落 SessionEvent.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          thread_id: { type: 'string' },
          content: { type: 'string' },
          payload: {
            type: 'object',
            additionalProperties: false,
            description:
              '{ component_type: "interactive_html"|"whiteboard_svg"|"tts_audio", body: string, hints?: object }',
            properties: {
              component_type: { type: 'string', enum: ['interactive_html', 'whiteboard_svg', 'tts_audio'] },
              body: { type: 'string', description: '原始 body — HTML / SVG / 音频 URL 等, 渲染端按 component_type 解读.' },
              hints: { type: 'object', description: '可选渲染提示 (宽度/沙箱标志/字幕等) — 自由形状, 不做字段校验.' },
            },
            required: ['component_type', 'body'],
          },
          context_snapshot: {
            type: 'object',
            additionalProperties: false,
            description:
              '{ page, entity_type?, entity_id?, entity_label? } - 跟最近 user message 一致. 不传时默认 { page: "agent" }',
            properties: {
              page: { type: 'string', description: '学习者当前所在页面 — 如 lesson/card/mindmap/quiz/dashboard/review/sessions/settings/contract/agent' },
              entity_type: { type: 'string', description: '如 lesson/flashcard/mindmap/mindmap_node/quiz_question/concept' },
              entity_id: { type: 'string' },
              entity_label: { type: 'string', description: 'UI 短标签, 如 "Equity Risk Premium node"' },
            },
          },
          is_learning_related: { type: 'boolean', description: 'default false' },
          client_message_id: {
            type: 'string',
            description:
              '可选。重放去重键 (建议 uuid) — 同 key 重发返回已存在的消息, 不重复写. ' +
              '缺省时 server 自动生成 (该次调用没有重试去重保护) — 此前标记 required 但 ' +
              'SDK 不强制, 漏传直接崩 UNDEFINED_VALUE, 现改为可选+自动生成.',
          },
        },
        required: ['thread_id', 'content'],
      },
    },
    {
      name: 'live_session_complete',
      description:
        '收课——Live 收尾的一次写作动作 (一次判决原则). REFLECT 三段全部必填, 缺任一即拒收: ' +
        'summary (她这节课学了什么——短判词, 不复述课堂过程) / ' +
        'teacher_reflection (薄弱环节, 直白不吹捧) / next_action (下次课的钩子, 具体到下一步该练什么). ' +
        '**这三段学习者会在课文页直接读到**——写成给她看的人话, 内部 id (tr_/evt_/snap_ 等) ' +
        '一律不进正文; 要给判词锚证据, 填 evaluation.evidence_refs (那才是机器引用通道, 服务端验 ' +
        'id 存在与同 pair 归属)。**id 只有一个归宿: evidence_refs** ' +
        '(2026-07-26 口径收窄——agent_observation 已在学习者折叠区可见, 不再是纯内账, ' +
        '故原"写内账或 evidence_refs"的二选一作废)。 ' +
        '可选 evaluation 随行——同一次调用把这场的现场评估一并落库 (等价于紧接着调 record_live_evaluation, ' +
        '一场一评, 已有场评时不覆盖), 收课+场评从此是一次动作, 不必分两笔写两段长文. ' +
        'status → completed, awaiting_role → none, ended_at 只在首次完成时打. ' +
        '幂等: session 已是 completed 时重复调用不再改 session, 原样回执 "已于 <首次 ended_at> 完成, ' +
        '本次为幂等重放, 未改动", ended_at 保留首次值 (带 evaluation 且该场还没有场评时, 场评仍会补写). ' +
        '收课握手: 调用前确认——学习者最后一题已单独判过 (对错+点评自成回合), 且她已明确表态收课; ' +
        '顶着未判的消息、或没等她点头就 complete, 违反 live-teaching 红线. ' +
        '下课铃机器门禁: 本场必须已有学习者收课宣告 (learner_close_declared_at, 她在 Live 房内' +
        '亲手按的下课铃)——未宣告时本工具 CONFLICT 拒收官; 若她已口头表示结束, 请引导其按下 Live 房内的' +
        '下课铃后再收官 (铃响会追加 live.learner_close_declared 事件, live_wait/live_pending 都看得见). ' +
        'cancel 不受此门 (取消≠收官).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string' },
          summary: {
            type: 'string',
            description:
              '必填, 非空——她这节课学了什么: 短判词, 不复述过程。**学习者在课文页直接读这一段**: ' +
              '写人话不写机器词, 内部 id 不进正文——需要锚到具体对话条目时, 把 id 填进 ' +
              'evaluation.evidence_refs (机器引用通道), 判词本身保持可读。',
          },
          teacher_reflection: {
            type: 'string',
            description:
              '必填, 非空——薄弱环节, 直白不吹捧。**学习者在课文页直接读这一段**: 写人话, ' +
              '内部 id 不进正文 (要锚证据填 evaluation.evidence_refs)。',
          },
          next_action: {
            type: 'string',
            description:
              '必填, 非空——下次课的钩子, 具体到下一步该练什么。**学习者在课文页直接读这一段**: ' +
              '写人话, 内部 id 不进正文 (要锚证据填 evaluation.evidence_refs)。',
          },
          evaluation: {
            type: 'object',
            additionalProperties: false,
            description:
              '可选——收课同笔写入这场的现场评估 (一次判决原则: 收课+场评一次动作)。字段与 ' +
              'record_live_evaluation 相同 (live_session_id 自动取本场)。该场已有场评时幂等返回既有那条, 不覆盖。',
            properties: {
              agent_observation: {
                type: 'string',
                description:
                  '必填非空——这场现场课的观察记录: 短判词, 不复述过程; 要锚到具体对话条目, ' +
                  'id 填 evidence_refs, 本段保持人话 (学习者会在折叠区读到它)。',
              },
              learner_note: {
                type: 'string',
                description:
                  '可选——学习者可见的人话版 (三通道制)。语言用 learners.locale; 不含内部 id 机器词。',
              },
              evidence_refs: {
                type: 'array',
                items: { type: 'string' },
                description:
                  '可选——机器引用通道: 判词锚到的具体 id (tr_/evt_/snap_ 等)。服务端逐 id 验存在+同 pair 归属。',
              },
              concepts_touched: { type: 'array', items: { type: 'string' } },
              live_turns_count: { type: 'number' },
              duration_minutes: { type: 'number' },
            },
            required: ['agent_observation'],
          },
          idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
        },
        required: ['session_id', 'summary', 'teacher_reflection', 'next_action'],
      },
    },
    {
      name: 'live_session_cancel',
      description: '中止 session (learner 提前结束或 system 超时). idempotent.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session_id: { type: 'string' },
          idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
        },
        required: ['session_id'],
      },
    },
    {
      name: 'live_session_start',
      description:
        '开一场新的 Live session —— 学习者裁决 (2026-07-20): 学习者侧 web 的 Start Session 按钮已退役, ' +
        '开课正门收窄到这里, 老师(agent)侧主动开课。context_type 默认 "lesson"。' +
        '同课已有 active 教室时不开新场，直接送你进既有会话（joined_existing）。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          context_type: {
            type: 'string',
            enum: ['lesson', 'flashcard', 'trial', 'mindmap', 'highlight'],
            description: 'lesson|flashcard|trial|mindmap|highlight',
          },
          context_id: { type: 'string' },
          context_preview: { type: 'string' },
          goal: { type: 'string' },
          idempotency_key: IDEMPOTENCY_KEY_SCHEMA,
        },
        required: ['context_type', 'context_id'],
      },
    },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

// Schema-by-need suite (W3, red team P1) — single lookup table handleToolCall
// uses to run every call's `args` through findUnknownField before dispatch.
// Built once from the same TOOL_DEFINITIONS array ListTools/manifest read —
// never a hand-maintained parallel copy.
const TOOL_SCHEMA_BY_NAME = new Map<string, JsonSchemaLike>(
  TOOL_DEFINITIONS.map((t) => [t.name, t.inputSchema as unknown as JsonSchemaLike])
);

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Unified machine receipt envelope construction (Agent Surface Hardening
// 第一批) — `success`/`fail`/`buildSuccessEnvelope`/
// `runIdempotentMutation`/`errorFromException` all live in
// ../lib/tool-envelope.ts now (extracted so they're importable from a unit
// test without pulling in this file's side-effecting stdio transport
// connect() call at the bottom — see tool-envelope.test.ts).

// §1: the seven-way taxonomy, closed set — no free
// text. Semantic slugs (①-⑦ numbering in comments only — the values
// are a permanent data contract). Shared by inputSchema validation and the
// action_link.type mapping. 'path_worked' (⑦, 红队第四轮) is the taxonomy's
// only success branch — see packages/contracts/src/teacher-growth.ts for why.
const VALID_ATTRIBUTIONS: PrimaryAttribution[] = [
  'not_yet_mastered', // ①
  'material_flaw', // ②
  'difficulty_timing', // ③
  'path_mismatch', // ④
  'judgment_error', // ⑤
  'weather', // ⑥
  'path_worked', // ⑦
];

// §4 — each primary attribution has exactly one valid action_link.type.
// path_worked (⑦) reuses hypothesis_update — see contracts comment.
const REQUIRED_ACTION_LINK_TYPE: Record<PrimaryAttribution, ActionLinkType> = {
  not_yet_mastered: 'review_action',
  material_flaw: 'lesson_revision',
  difficulty_timing: 'course_adjustment',
  path_mismatch: 'intervention_note',
  judgment_error: 'hypothesis_update',
  weather: 'retest_only',
  path_worked: 'hypothesis_update',
};

// Envelope `next_recommended_actions` for reflect_on_teaching, keyed by the
// action_link.type it just wrote (Agent Surface Hardening 第一批)
// — advisory only, not enforced. lesson_revision and hypothesis_update
// point straight back at the tool that would actually carry out that action;
// the rest don't have a single obvious next MCP call (course_adjustment/
// intervention_note are judgment calls, retest_only is "wait and see").
//
// State 2.0 去环 (设计稿 §9.3): review_action used to point back at
// record_post_lesson_evaluation, which itself recommends reflect_on_teaching
// — a two-tool cycle (一课一份总评不该被反思反复推荐重写)。record 的推荐仍
// 单向指向 reflect；这里移除回指，环就断了。
const ACTION_LINK_NEXT_TOOL: Record<ActionLinkType, string[]> = {
  review_action: [],
  lesson_revision: ['update_lesson'],
  course_adjustment: [],
  intervention_note: [],
  hypothesis_update: ['record_learner_hypothesis'],
  retest_only: [],
};

// §5 "偏度分布取最冷版" — a one-line primary_attribution tally over the last
// 20 reflections, piggybacked on reflect_on_teaching's own return value.
// No UI, no dedicated resource/tool: the teacher glimpses it only at the
// moment it writes a reflection.
async function buildAttributionTally(pairId: string): Promise<Record<string, number>> {
  const rows = await db
    .select({ primary_attribution: teacher_reflections.primary_attribution })
    .from(teacher_reflections)
    .where(eq(teacher_reflections.pair_id, pairId))
    .orderBy(desc(teacher_reflections.written_at))
    .limit(20);
  const tally: Record<string, number> = {};
  for (const row of rows) {
    if (!row.primary_attribution) continue; // pre-0018 rows carry none
    tally[row.primary_attribution] = (tally[row.primary_attribution] ?? 0) + 1;
  }
  return tally;
}

// propose_contract defaults — mirror apps/web/src/pages/Contract/index.tsx's
// DEFAULT_AGENT_READ_SCOPES / DEFAULT_AGENT_WRITE_SCOPES / feedback_tone
// (Stage 1 createMut). Duplicated intentionally (server has no dependency
// on the web app); keep the two in sync if either changes.
const PROPOSE_CONTRACT_READ_SCOPES = [
  'permission:read',
  'permission:reflect',
  'permission:correct',
];
const PROPOSE_CONTRACT_WRITE_SCOPES = ['create_course', 'add_lesson', 'add_flashcard'];
const PROPOSE_CONTRACT_FEEDBACK_TONE = {
  reminders: 'gentle' as const,
  questioning: 'moderate' as const,
  correction: 'soft' as const,
  encouragement: 'sparing' as const,
};

// 薄提案检测: intake 被跳过, 一句 goal 直接
// propose_contract, 签字台收到的是空白条款卡片. 这里列的是 intake 对话本该
// 产出、随 propose_contract 一并递交的补充字段 (Class A½ cadence + Class B
// 四项 + timeline/success_criteria) —— 一个都没带, 说明挖掘对话没发生过。
const CONTRACT_SUPPLEMENTARY_FIELDS = [
  'time_range',
  'success_criteria',
  'intensity',
  'interaction_mode',
  'content_modality',
  'pace',
  'weekly_capacity_hours',
  'preferred_time_of_day',
  'cadence',
  // 自带教材条款 — 教材三问 (依赖档位/外延偏好/版本年份) 是
  // intake 挖掘对话的产物, 带着它来的提案不算薄。
  'source_material',
] as const;

function hasMeaningfulProposalValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true; // numbers/booleans — any explicit value counts
}

// ---- add_mindmap_seed / add_simulated_quiz write-side validation ----
//
// Bench 案一/二 (真机报障同族): a naive agent free-
// formed a generic graph JSON — nodes shaped {id,label}, links shaped
// {source,target,label} — straight through add_mindmap_seed, and a flat
// {prompt,options,correct_index} quiz shape through add_simulated_quiz.
// Neither tool checked the payload against the MindmapContent /quiz
// contract at write time (the inputSchema's `required` list is documentation
// for the LLM only — see lib/tool-args.ts's note, the MCP SDK never
// enforces it), so both writes succeeded silently and the renderer was
// left holding data it structurally cannot show (missing title/level/
// pos_x/pos_y/is_expanded/sort_order on nodes; missing stem/reference_answer
// on questions) — pages that render "blank" or "garbled" instead of erroring
// anywhere. These two validators close the gap at the only place that can
// actually explain the mistake back to the writer: reject with a VALIDATION
// error naming the exact missing/wrong-shaped field (and, where the mistake
// is a plausible field-name swap like label→title or source→from_node_id,
// say so) instead of a renderer silently swallowing garbage.

const MINDMAP_NODE_LEVELS = new Set(['root', 'branch', 'detail', 'note']);

// All validateMindmapContent rejections route through this instead of the
// bare validationError so every message carries the same pointer back to
// the authoring recipe — one string to edit, not seventeen call sites to
// keep in sync.
const MINDMAP_RECIPE_HINT = ' (完整画法见 recipe: mindmap-authoring)';

function mindmapValidationError(message: string, details?: Record<string, unknown>): McpToolError {
  return validationError(message + MINDMAP_RECIPE_HINT, details);
}

function validateMindmapContent(raw: unknown): MindmapContent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw mindmapValidationError(
      "content must be an object shaped { nodes: MindmapNode[], links: MindmapLink[] } — got " +
        (raw === undefined ? 'nothing' : JSON.stringify(raw))
    );
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.nodes)) {
    throw mindmapValidationError('content.nodes is required and must be an array of MindmapNode', {
      field: 'content.nodes',
    });
  }
  if (!Array.isArray(obj.links)) {
    throw mindmapValidationError('content.links is required and must be an array of MindmapLink', {
      field: 'content.links',
    });
  }

  const nodeIds = new Set<string>();
  const nodes = obj.nodes as unknown[];
  const links = obj.links as unknown[];

  nodes.forEach((raw_n, i) => {
    if (!raw_n || typeof raw_n !== 'object') {
      throw mindmapValidationError(`content.nodes[${i}] must be an object`, { field: `nodes[${i}]` });
    }
    const n = raw_n as Record<string, unknown>;
    if (typeof n.id !== 'string' || n.id.trim() === '') {
      throw mindmapValidationError(`content.nodes[${i}].id is required (non-empty string)`, {
        field: `nodes[${i}].id`,
      });
    }
    if (nodeIds.has(n.id)) {
      throw mindmapValidationError(`content.nodes[${i}].id '${n.id}' is duplicated — node ids must be unique`, {
        field: `nodes[${i}].id`,
      });
    }
    nodeIds.add(n.id);
    if (typeof n.title !== 'string' || n.title.trim() === '') {
      throw mindmapValidationError(
        `content.nodes[${i}] (id '${n.id}') is missing 'title' (non-empty string)` +
          (typeof n.label === 'string' ? " — did you mean 'title' instead of 'label'?" : ''),
        { field: `nodes[${i}].title` }
      );
    }
    if (typeof n.level !== 'string' || !MINDMAP_NODE_LEVELS.has(n.level)) {
      throw mindmapValidationError(
        `content.nodes[${i}] (id '${n.id}') has invalid 'level' (${JSON.stringify(n.level)}) — must be one of root/branch/detail/note`,
        { field: `nodes[${i}].level` }
      );
    }
    if (typeof n.pos_x !== 'number' || typeof n.pos_y !== 'number') {
      throw mindmapValidationError(
        `content.nodes[${i}] (id '${n.id}') is missing numeric 'pos_x'/'pos_y' — leave both at 0 if you have no layout hint, but the fields must be present`,
        { field: `nodes[${i}].pos_x/pos_y` }
      );
    }
    if (typeof n.is_expanded !== 'boolean') {
      throw mindmapValidationError(`content.nodes[${i}] (id '${n.id}') is missing boolean 'is_expanded'`, {
        field: `nodes[${i}].is_expanded`,
      });
    }
    if (typeof n.sort_order !== 'number') {
      throw mindmapValidationError(`content.nodes[${i}] (id '${n.id}') is missing numeric 'sort_order'`, {
        field: `nodes[${i}].sort_order`,
      });
    }
    if (n.parent_id !== undefined && typeof n.parent_id !== 'string') {
      throw mindmapValidationError(`content.nodes[${i}] (id '${n.id}').parent_id must be a string if present`, {
        field: `nodes[${i}].parent_id`,
      });
    }
  });

  // Second pass (needs the full nodeIds set): parent_id referential integrity.
  nodes.forEach((raw_n, i) => {
    const n = raw_n as Record<string, unknown>;
    if (typeof n.parent_id === 'string' && !nodeIds.has(n.parent_id)) {
      throw mindmapValidationError(
        `content.nodes[${i}] (id '${n.id}').parent_id '${n.parent_id}' does not match any id in content.nodes`,
        { field: `nodes[${i}].parent_id` }
      );
    }
  });

  links.forEach((raw_l, i) => {
    if (!raw_l || typeof raw_l !== 'object') {
      throw mindmapValidationError(`content.links[${i}] must be an object`, { field: `links[${i}]` });
    }
    const l = raw_l as Record<string, unknown>;
    if (typeof l.id !== 'string' || l.id.trim() === '') {
      throw mindmapValidationError(`content.links[${i}].id is required (non-empty string)`, {
        field: `links[${i}].id`,
      });
    }
    if (typeof l.from_node_id !== 'string' || !nodeIds.has(l.from_node_id)) {
      throw mindmapValidationError(
        `content.links[${i}] (id '${l.id}').from_node_id must reference an existing node id` +
          (typeof l.source === 'string' ? " — did you mean 'from_node_id' instead of 'source'?" : ''),
        { field: `links[${i}].from_node_id` }
      );
    }
    if (typeof l.to_node_id !== 'string' || !nodeIds.has(l.to_node_id)) {
      throw mindmapValidationError(
        `content.links[${i}] (id '${l.id}').to_node_id must reference an existing node id` +
          (typeof l.target === 'string' ? " — did you mean 'to_node_id' instead of 'target'?" : ''),
        { field: `links[${i}].to_node_id` }
      );
    }
  });

  return obj as unknown as MindmapContent;
}

// SIMULATED_QUESTION_TYPES / validateSimulatedQuestions 起搬到
// lib/validate-simulated-quiz.ts（multi_choice reference_answer 分隔约定改回
// ' || ', 与判分侧同制；抽出理由见该文件头注释：本文件底部有裸 top-level
// await server.connect(...), 单测不能直接 import 这整个模块）。

// ---- add_lesson / update_lesson content_markdown write-side validation ----
//
// (真机报障，同族的最后一案): add_lesson had
// zero structural validation on `content_markdown` — a naive agent wrote
// free-form prose (no `---` page breaks, no `::kicker[...]`, no per-page
// single-h2 discipline) straight through, and the write succeeded silently.
// The product's lesson contract (docs/LESSON-BLOCKS-v1.md §1) is "paged like
// a slide deck", not a scrolling document; the renderer's own isPaged() check
// (apps/web/src/lesson/paging.ts) falls back to a single-scroll view for
// exactly this shape, so the mistake only ever surfaced later as "一整屏滚动
// +格式破碎" — never at the point that could actually explain it to the
// writer. This validator closes the write-time gap, same shape as
// validateMindmapContent/validateSimulatedQuestions above: reject with a
// VALIDATION naming the exact page that's wrong and how to fix it.
//
// Scope is deliberately narrow, per the ledger's own "尺度拿捏": only the
// format's hard skeleton is enforced — page count (≥2), kicker-first-line,
// exactly-one-h2-per-page (and no h3+ inside a page — LESSON-BLOCKS-v1 §1.2
// folds that into the same h2-owns-the-title structural rule, not a
// pedagogy preference). Soft pedagogy (≤200 字/page, 8-14 pages, block
// density, highlight budget, fable-first kicker ordering) stays a
// verify-gate/skill-prompt concern (skills/workflow/lesson-prep.md,
// LESSON-BLOCKS-v1 §5) — this tool has no channel to warn-without-rejecting;
// the success envelope (packages/contracts/src/mcp-envelope.ts) has no
// notices/warnings field, and growing that shape just for this one softer
// check isn't worth it.
//
// The `---`/fence/directive scanning below is a deliberate duplicate of
// apps/web/src/lesson/paging.ts's splitPages() — the server has no
// dependency on the web app, so this can't import it; keep the two in sync
// if the paging grammar ever changes (same posture as this file's
// PROPOSE_CONTRACT_READ_SCOPES duplication note above).

const LESSON_FENCE_RE = /^(```|~~~)/;
const LESSON_DIRECTIVE_OPEN_RE = /^:{3,}\s*\S/;
const LESSON_DIRECTIVE_CLOSE_RE = /^:{3,}\s*$/;
const LESSON_PAGE_BREAK_RE = /^-{3,}\s*$/;
const LESSON_KICKER_RE = /^::kicker\[([^\]]+)\]\s*$/;
const LESSON_H2_RE = /^##(?!#)\s+\S/;
const LESSON_H3PLUS_RE = /^#{3,}\s+\S/;

const LESSON_CONTENT_SKELETON = `::kicker[HOOK]
## Why learn this

One or two sentences making clear why this concept matters on the exam / in the real world (≤200 chars).

---

::kicker[NEXT]
## Next up

Wrap up + tee up the hook for the next lesson.`;

/** Strip a leading YAML frontmatter block the same way paging.ts's
 *  stripFrontmatter() does, so a lesson authored with frontmatter isn't
 *  double-counted as "page 1 has no kicker" when page 1 is really just the
 *  frontmatter's leftover blank line. */
function stripLessonFrontmatter(src: string): string {
  const lines = src.split('\n');
  let start = 0;
  while (start < lines.length && lines[start]!.trim() === '') start++;
  if (start >= lines.length || lines[start]!.trim() !== '---') return src;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^(---|\.\.\.)\s*$/.test(lines[i]!)) return lines.slice(i + 1).join('\n');
  }
  return src;
}

/** Fence/directive-aware split on top-level `---` lines — mirrors
 *  paging.ts's splitPages() line-scan exactly, minus the kicker-extraction
 *  step (validation needs the kicker line still in place to check its
 *  position). Returns each page as its raw array of lines. */
function splitLessonPagesForValidation(contentMarkdown: string): string[][] {
  const body = stripLessonFrontmatter(contentMarkdown);
  const lines = body.split('\n');

  const rawPages: string[][] = [];
  let current: string[] = [];
  let inFence = false;
  let directiveDepth = 0;

  for (const line of lines) {
    if (LESSON_FENCE_RE.test(line)) {
      inFence = !inFence;
      current.push(line);
      continue;
    }
    if (!inFence && LESSON_DIRECTIVE_OPEN_RE.test(line) && !LESSON_KICKER_RE.test(line)) {
      directiveDepth++;
      current.push(line);
      continue;
    }
    if (!inFence && directiveDepth > 0 && LESSON_DIRECTIVE_CLOSE_RE.test(line)) {
      directiveDepth--;
      current.push(line);
      continue;
    }
    if (!inFence && directiveDepth === 0 && LESSON_PAGE_BREAK_RE.test(line)) {
      rawPages.push(current);
      current = [];
      continue;
    }
    current.push(line);
  }
  rawPages.push(current);
  return rawPages;
}

function validateLessonContent(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw validationError('content_markdown is required (non-empty string)', {
      field: 'content_markdown',
    });
  }

  const pages = splitLessonPagesForValidation(raw);
  const hasAnyKicker = pages.some((pageLines) => pageLines.some((l) => LESSON_KICKER_RE.test(l)));

  if (pages.length < 2 && !hasAnyKicker) {
    throw validationError(
      "You submitted free-form markdown — this contract requires paged block structure (docs/LESSON-BLOCKS-v1.md §1): " +
        'at least 2 pages, separated by a top-level `---` (on its own line); each page\'s first non-blank line is `::kicker[...]`; ' +
        'each page has exactly one `## ` h2 heading. Minimum valid skeleton:\n\n' +
        LESSON_CONTENT_SKELETON,
      { field: 'content_markdown' }
    );
  }

  if (pages.length < 2) {
    throw validationError(
      `content_markdown only split into ${pages.length} page(s) — no top-level \`---\` page break found. This contract requires at least 2 pages; ` +
        'use a line containing only `---` (not inside a code fence / :::block) to break pages, for example:\n\n' +
        LESSON_CONTENT_SKELETON,
      { field: 'content_markdown' }
    );
  }

  pages.forEach((pageLines, i) => {
    const pageNo = i + 1;
    const firstNonBlank = pageLines.find((l) => l.trim() !== '');
    if (firstNonBlank === undefined || !LESSON_KICKER_RE.test(firstNonBlank)) {
      throw validationError(
        `content_markdown page ${pageNo} is missing a kicker — each page's first non-blank line must be ` +
          `\`::kicker[...]\` (e.g. ::kicker[FABLE]); the first line actually read was ` +
          `${firstNonBlank === undefined ? '(the whole page is blank)' : JSON.stringify(firstNonBlank.slice(0, 60))}. ` +
          'Did you mean to add a kicker line at the top of this page? See the word list in docs/LESSON-BLOCKS-v1.md §1.3 ' +
          '(HOOK/FABLE/NAME/FORMULA/EXAMPLE/TRIAL/TRAPS/EXAM/NEXT).',
        { field: `content_markdown.page[${pageNo}].kicker` }
      );
    }

    let inFence = false;
    let directiveDepth = 0;
    let h2Count = 0;
    let sawDeeperHeading = false;
    for (const line of pageLines) {
      if (LESSON_FENCE_RE.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      if (LESSON_DIRECTIVE_OPEN_RE.test(line) && !LESSON_KICKER_RE.test(line)) {
        directiveDepth++;
        continue;
      }
      if (directiveDepth > 0 && LESSON_DIRECTIVE_CLOSE_RE.test(line)) {
        directiveDepth--;
        continue;
      }
      if (directiveDepth > 0) continue;
      if (LESSON_H2_RE.test(line)) h2Count++;
      else if (LESSON_H3PLUS_RE.test(line)) sawDeeperHeading = true;
    }

    if (h2Count === 0) {
      throw validationError(
        `content_markdown page ${pageNo} is missing a heading — each page must have exactly one \`## \` h2 heading` +
          ' (right after the kicker; page hierarchy is carried only by kicker + h2 + body).',
        { field: `content_markdown.page[${pageNo}].h2` }
      );
    }
    if (h2Count > 1) {
      throw validationError(
        `content_markdown page ${pageNo} has ${h2Count} h2 headings — exactly one \`## \` per page; ` +
          'split the extra ones onto the next page (using a top-level `---`) instead of cramming them onto the same page.',
        { field: `content_markdown.page[${pageNo}].h2` }
      );
    }
    if (sawDeeperHeading) {
      throw validationError(
        `content_markdown page ${pageNo} has an h3-or-deeper heading (###/####…) — stacking sub-h2 headings within a page is not allowed` +
          ' (docs/LESSON-BLOCKS-v1.md §1.2); page hierarchy is carried only by kicker + h2 + body — ' +
          'rewrite whatever you wanted h3 to express as a body paragraph or a list.',
        { field: `content_markdown.page[${pageNo}].heading_depth` }
      );
    }
  });

  return raw;
}

// ---- add_flashcard / add_exercise / grade_exercise write-side validation ----
//
// 本批案由: 闪卡练习合同链审计 (2026-07-11). 前几批关的是结构化
// content(mindmap/quiz/lesson markdown) 的洞；这批审计翻出
// 的是几个"看起来只是标量字段"但一样能裸奔的洞：
//
//   - add_flashcard.tags: 若传成裸字符串（"GDP" 而非 ["GDP"]）会原样落进
//     flashcards.tags(jsonb)——渲染层对 tags 做的是无保护 .forEach/.join，字符
//     串本身可迭代，"GDP".forEach 会把它拆成 'G'/'D'/'B' 三个假标签渲染出来，
//     不会报错也不会留下任何"这里出过错"的痕迹。这是当前唯一能崩前端的洞，
//     必须在写入前拒绝。
//   - add_flashcard.concept_id / add_exercise.expected_concepts: 若传入不存
//     在的 concept id，会静默写入一个指向空气的引用（concepts 表没有反向 FK
//     约束这两处，DB 不会替我们兜底）。
//   - add_exercise.lesson_id: 没有存在性预检，错了直接撞 exercises 表的
//     lesson_id FK 约束——docs/recipes/first-contract-and-lesson.md 曾经把这
//     记成"落进 code:RETRYABLE"，那是修复(6813c71，tool-envelope.ts 的
//     23503→NOT_FOUND 映射)之前的旧账；现在撞 FK 至少已经是 NOT_FOUND 而非
//     RETRYABLE 了，但仍然是"先撞库再分类"——这里补一道写入前预检，直接给
//     VALIDATION + 指路，不必真去撞一次外键。
//   - grade_exercise.score: inputSchema 里写了"0..1"，但从未在运行时校验过
//     ——把百分数当小数传（85 想表达 85%）会原样落库，再在渲染层显示成
//     "8500%"。这是该起事故的门禁。
//
// 风格延续 validateMindmapContent/validateSimulatedQuestions/
// validateLessonContent 三个既有校验器：validationError + 报错文案教怎么改，
// 带"是不是想…"级纠正指引。

/** Optional "array of strings" field validator — shared by add_flashcard's
 *  `tags` and add_exercise's `expected_concepts`. Both fields are jsonb
 *  columns with no DB-level type enforcement, so a bare string sails through
 *  undetected until it hits a renderer that assumes an array. */
function validateOptionalStringArrayArg(
  args: Record<string, unknown>,
  key: string
): string[] | undefined {
  const raw = args[key];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) {
    throw validationError(
      `${key} must be an array of strings if present — got ${JSON.stringify(raw)}` +
        (typeof raw === 'string'
          ? ` — did you mean ${JSON.stringify([raw])} (a one-element array), not a bare string?`
          : ''),
      { field: key }
    );
  }
  return raw;
}

/** Optional positive-integer field validator — shared by create_course's
 *  `planned_lesson_count` ("一共几节" — 建课时问学习者的第一问). Zero/negative/
 *  non-integer values are almost certainly a caller mistake (a fractional or
 *  zero lesson count can't mean anything), so this rejects rather than
 *  silently coercing. Same style as validateOptionalStringArrayArg. */
function validateOptionalPositiveIntArg(args: Record<string, unknown>, key: string): number | undefined {
  const raw = args[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw validationError(
      `${key} must be a positive integer if present — got ${JSON.stringify(raw)}`,
      { field: key }
    );
  }
  return raw;
}

/** Optional "flat string-map" field validator — shared by add_lesson/
 *  update_lesson's `modality_declarations` (脑图裁量条款子项: 脑图缺席要留言).
 *  jsonb column with no DB-level type enforcement; a bare string or an array
 *  would sail through undetected until checkMindmap tries to read `.mindmap`
 *  off it. Same style as validateOptionalStringArrayArg above. */
function validateOptionalStringMapArg(
  args: Record<string, unknown>,
  key: string
): Record<string, string> | undefined {
  const raw = args[key];
  if (raw === undefined) return undefined;
  if (
    typeof raw !== 'object' ||
    raw === null ||
    Array.isArray(raw) ||
    Object.values(raw as Record<string, unknown>).some((v) => typeof v !== 'string')
  ) {
    throw validationError(
      `${key} must be an object of string values if present — got ${JSON.stringify(raw)}` +
        ` — e.g. { "mindmap": "rote-memorization content, the relationships aren't the hard part" }`,
      { field: key }
    );
  }
  return raw as Record<string, string>;
}

// Contract 2.0 cadence 条款 — 校验器, propose_contract (可选)
// 与 update_contract_cadence (必填) 共用。jsonb 列无 DB 层类型强制, 形状必须
// 在这里把死: {mode:'scheduled'|'fragmented', slots?:[{weekday,time,tz}],
// reminders:'native'|'none', auto_duty:boolean, weekly_review_nudge?:boolean,
// prep_rhythm?:'per_lesson'|'batch'}。prep_rhythm (零迁移, 学习者钦定设计) 是
// cadence 内加的第五个键——同一个 jsonb 列, 不动 DB schema, 只在这个校验器
// 和 ContractCadence 类型(packages/contracts/src/pair.ts)里补形状。
const CADENCE_MODES = new Set(['scheduled', 'fragmented']);
const CADENCE_REMINDERS = new Set(['native', 'none']);
const CADENCE_PREP_RHYTHMS = new Set(['per_lesson', 'batch']);
const CADENCE_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function validateCadenceArg(
  args: Record<string, unknown>,
  key: string,
  opts: { required: boolean }
): ContractCadence | undefined {
  const raw = args[key];
  if (raw === undefined) {
    if (opts.required) {
      throw validationError(
        `${key} is required — shape: {mode:'scheduled'|'fragmented', slots?:[{weekday:0-6,time:'HH:MM',tz:string}], ` +
          `reminders:'native'|'none', auto_duty:boolean, weekly_review_nudge?:boolean, ` +
          `prep_rhythm?:'per_lesson'|'batch'}`,
        { field: key }
      );
    }
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw validationError(`${key} must be an object if present — got ${JSON.stringify(raw)}`, { field: key });
  }
  const c = raw as Record<string, unknown>;

  if (typeof c.mode !== 'string' || !CADENCE_MODES.has(c.mode)) {
    throw validationError(
      `${key}.mode must be one of scheduled/fragmented — got ${JSON.stringify(c.mode)}`,
      { field: `${key}.mode` }
    );
  }
  if (typeof c.reminders !== 'string' || !CADENCE_REMINDERS.has(c.reminders)) {
    throw validationError(
      `${key}.reminders must be one of native/none — got ${JSON.stringify(c.reminders)}`,
      { field: `${key}.reminders` }
    );
  }

  let slots: ContractCadenceSlot[] | undefined;
  if (c.slots !== undefined) {
    if (!Array.isArray(c.slots)) {
      throw validationError(`${key}.slots must be an array if present — got ${JSON.stringify(c.slots)}`, {
        field: `${key}.slots`,
      });
    }
    slots = c.slots.map((rawSlot, i) => {
      if (typeof rawSlot !== 'object' || rawSlot === null || Array.isArray(rawSlot)) {
        throw validationError(`${key}.slots[${i}] must be an object {weekday, time, tz}`, {
          field: `${key}.slots[${i}]`,
        });
      }
      const s = rawSlot as Record<string, unknown>;
      if (typeof s.weekday !== 'number' || !Number.isInteger(s.weekday) || s.weekday < 0 || s.weekday > 6) {
        throw validationError(
          `${key}.slots[${i}].weekday must be an integer 0-6 (0=Sunday) — got ${JSON.stringify(s.weekday)}`,
          { field: `${key}.slots[${i}].weekday` }
        );
      }
      if (typeof s.time !== 'string' || !CADENCE_TIME_RE.test(s.time)) {
        throw validationError(
          `${key}.slots[${i}].time must be "HH:MM" 24h — got ${JSON.stringify(s.time)}`,
          { field: `${key}.slots[${i}].time` }
        );
      }
      if (typeof s.tz !== 'string' || s.tz.trim() === '') {
        throw validationError(
          `${key}.slots[${i}].tz must be a non-empty IANA timezone string — got ${JSON.stringify(s.tz)}`,
          { field: `${key}.slots[${i}].tz` }
        );
      }
      return { weekday: s.weekday, time: s.time, tz: s.tz };
    });
  }

  if (c.auto_duty !== undefined && typeof c.auto_duty !== 'boolean') {
    throw validationError(`${key}.auto_duty must be boolean if present — got ${JSON.stringify(c.auto_duty)}`, {
      field: `${key}.auto_duty`,
    });
  }
  // 默认 false — auto_duty 涉及学习者额度消耗, 签约对话必须明示询问; 没被
  // 明确问过/答过 (字段缺省) 时不默认开, 不是"服务器猜你想要".
  const autoDuty = typeof c.auto_duty === 'boolean' ? c.auto_duty : false;

  if (c.weekly_review_nudge !== undefined && typeof c.weekly_review_nudge !== 'boolean') {
    throw validationError(
      `${key}.weekly_review_nudge must be boolean if present — got ${JSON.stringify(c.weekly_review_nudge)}`,
      { field: `${key}.weekly_review_nudge` }
    );
  }

  // 备课节奏 (零迁移, 学习者钦定设计) — "课程内容你想怎么长出来?" 的答案。
  if (c.prep_rhythm !== undefined && (typeof c.prep_rhythm !== 'string' || !CADENCE_PREP_RHYTHMS.has(c.prep_rhythm))) {
    throw validationError(
      `${key}.prep_rhythm must be one of per_lesson/batch if present — got ${JSON.stringify(c.prep_rhythm)}`,
      { field: `${key}.prep_rhythm` }
    );
  }

  const result: ContractCadence = {
    mode: c.mode as ContractCadenceMode,
    reminders: c.reminders as ContractCadenceReminders,
    auto_duty: autoDuty,
  };
  if (slots !== undefined) result.slots = slots;
  if (typeof c.weekly_review_nudge === 'boolean') result.weekly_review_nudge = c.weekly_review_nudge;
  if (typeof c.prep_rhythm === 'string') result.prep_rhythm = c.prep_rhythm as 'per_lesson' | 'batch';
  return result;
}

// ---- P1 五连修 (concepts 链审计, 2026-07-12) ----
//
// 上一批关的是 tags/expected_concepts 这类"数组该是数组"的
// 洞；这批审计接着往 concept 双向链走，翻出的是结构对象数组 + 双向引用一致性
// 两类洞：
//
//   - add_concept/update_concept.source_refs: 不只是"该是数组"，每一项还得
//     是 {type, ...} 形状的对象——裸字符串或数组混进来一样会原样落进
//     concepts.source_refs(jsonb)，渲染层假设的是对象数组，不是标量数组。
//   - update_concept.flashcard_ids / add_lesson/update_lesson.concept_ids:
//     裸字符串同样能裸奔进 jsonb 数组列；悬空 id（对应表里根本没有这一行）
//     不会被 DB 挡住——concepts/flashcards 表都没有反向 FK 约束这些字段，
//     只能应用层查一遍存在性。
//   - add_concept 成功后不回填 lesson.concept_ids、add_flashcard(concept_id)
//     成功后不回写 concept.flashcard_ids: 两条本该双向的链只有一半在写，
//     "课末概念清单"/"概念下挂了哪些卡"这两处计数因此永远比真实行数少。
//
// 风格延续上面 validateOptionalStringArrayArg 一路：validationError + 报错
// 文案教怎么改；两个 assert* 存在性检查沿用 add_exercise.expected_concepts
// 那段的做法(先查一遍再一次性报出全部悬空 id，不逐个撞 FK)。

const SOURCE_REF_TYPES = new Set([
  'pdf',
  'epub',
  'markdown',
  'web',
  'anki',
  'notebook-lm',
  'readwise',
  'obsidian',
  'agent-generated',
]);

/** Optional "array of SourceRef objects" field validator — shared by
 *  add_concept/update_concept's `source_refs`. The column is jsonb with no
 *  DB-level shape enforcement, so either a bare string/scalar or an array of
 *  bare strings would otherwise sail straight through to a renderer that
 *  expects `{type, url?, file_ref?, page?, ...}` objects. */
function validateOptionalSourceRefsArg(
  args: Record<string, unknown>,
  key: string
): SourceRef[] | undefined {
  const raw = args[key];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw validationError(
      `${key} must be an array of SourceRef objects if present — got ${JSON.stringify(raw)}` +
        ' — each item looks like {type: "web"|"pdf"|"markdown"|..., url?, file_ref?, page?}.',
      { field: key }
    );
  }
  raw.forEach((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw validationError(
        `${key}[${i}] must be an object like {type, url?, file_ref?, page?, ...} — got ${JSON.stringify(item)}` +
          (typeof item === 'string'
            ? ` — did you mean ${JSON.stringify({ type: 'agent-generated' })}-shaped, not a bare string?`
            : ''),
        { field: `${key}[${i}]` }
      );
    }
    const t = (item as Record<string, unknown>).type;
    if (typeof t !== 'string' || !SOURCE_REF_TYPES.has(t)) {
      throw validationError(
        `${key}[${i}].type must be one of ${[...SOURCE_REF_TYPES].join(', ')} — got ${JSON.stringify(t)}`,
        { field: `${key}[${i}].type` }
      );
    }
  });
  return raw as SourceRef[];
}

/** Existence precheck for `concept_ids` (add_lesson/update_lesson) — same
 *  shape as add_exercise's expected_concepts precheck: lessons.concept_ids
 *  has no reverse FK into concepts, so a bad id would otherwise sail through
 *  silently and count against "课末概念清单" without a matching row. */
async function assertConceptIdsExist(conceptIds: string[], field: string): Promise<void> {
  if (conceptIds.length === 0) return;
  const foundRows = await db.select({ id: concepts.id }).from(concepts).where(inArray(concepts.id, conceptIds));
  const foundIds = new Set(foundRows.map((r) => r.id));
  const dangling = conceptIds.filter((cid) => !foundIds.has(cid));
  if (dangling.length > 0) {
    throw validationError(
      `${field} has ${dangling.length} concept id(s) that don't exist: ${JSON.stringify(dangling)} — ` +
        'use get_context to see the existing concept list, or create it first with add_concept before referencing it.',
      { field, dangling_ids: dangling }
    );
  }
}

/** Existence precheck for `flashcard_ids` (update_concept) — same shape as
 *  assertConceptIdsExist above: concepts.flashcard_ids has no reverse FK
 *  into flashcards, so a bad id would otherwise sail through silently. */
async function assertFlashcardIdsExist(flashcardIds: string[], field: string): Promise<void> {
  if (flashcardIds.length === 0) return;
  const foundRows = await db
    .select({ id: flashcards.id })
    .from(flashcards)
    .where(inArray(flashcards.id, flashcardIds));
  const foundIds = new Set(foundRows.map((r) => r.id));
  const dangling = flashcardIds.filter((fid) => !foundIds.has(fid));
  if (dangling.length > 0) {
    throw validationError(
      `${field} has ${dangling.length} flashcard id(s) that don't exist: ${JSON.stringify(dangling)} — ` +
        'use get_context to see the existing flashcard list, or create it first with add_flashcard before referencing it.',
      { field, dangling_ids: dangling }
    );
  }
}

// P1-e (concepts 链审计) — documents.source whitelist. DB column is `text`
// with no CHECK constraint. add_document below hardcodes 'mcp' — the only
// other writer (routes/documents.ts POST /pairs/:pairId/documents) already
// whitelists paste/upload/mcp at the HTTP layer. This precheck is therefore
// unreachable via any live path today (装栏杆性质) — it's here so that if a
// future add_document revision ever exposes `source` as a caller-supplied
// arg, a typo/foreign value is stopped at the door instead of sailing into
// a NOT NULL text column with zero DB-level enforcement.
const VALID_DOCUMENT_SOURCES = new Set(['paste', 'upload', 'mcp']);
function assertValidDocumentSource(source: string): void {
  if (!VALID_DOCUMENT_SOURCES.has(source)) {
    throw validationError(
      `source must be one of ${[...VALID_DOCUMENT_SOURCES].join(', ')} — got ${JSON.stringify(source)}`,
      { field: 'source' }
    );
  }
}

// ============================================================================
// LS_INSPECT — 无库检视模式 (registry/automated-inspection 场景专用, 例如
// Glama 质检机器人: 它会真的把这个进程跑起来枚举 tools/resources, 但它的
// 容器里没有 Postgres)。
//
// 勘察结论 (工单要求先摸清链路再动刀):
//   · initialize 握手 / ListToolsRequestSchema / manifest://capabilities /
//     recipe:// 今天就是无库安全的 —— TOOL_DEFINITIONS 是字面量数组,
//     listAllResourceDefinitions 只读 docs/recipes/*.md, db/client.ts 的池是
//     惰性单例 (import 不触发连接, 见该文件头注)。这条路径不用改一行。
//   · 唯一会撞库的路径是工具真调用: 除 create_pair 外全部 49 个工具在
//     switch 之前都先 getCurrentPairId() 查 active pair, create_pair 自己也
//     直接经 createPairForRegisteredLearner 写库 —— 这台服务器里没有一个
//     "纯静态、调用时完全不碰库"的工具, 所以不需要逐工具甄别, 一个门就够。
//   · 不拦这里的话, requireDatabaseUrl 会在 getCurrentPairId()/create_pair
//     内部裸抛 `Error('DATABASE_URL is not set...')`, 一路冒到
//     errorFromException 兜底分类成 RETRYABLE —— 语义上是错的 (库压根没接,
//     同一次调用重试到天荒地老也不会成功), 而且消息里带着未经打磨的内部
//     措辞。改用 PERMISSION (五族分类里"当前 scope/gate 下不允许"那一档,
//     retryable 默认 false) 是诚实的分类, 不是新发明一档。
//
// LS_INSPECT 未设置(生产/日常开发默认)时 LS_INSPECT 恒为 false, 调用点是
// 一次纯布尔判断——对既有路径零行为变化。
const LS_INSPECT = process.env.LS_INSPECT === '1';

function inspectionModeError(toolName: string): McpToolError {
  return permissionError(
    `inspection mode: no database attached — LS_INSPECT=1 disables every database-backed tool call on ` +
      `purpose (this process was started with no DATABASE_URL / no Postgres attached, for registry/automated ` +
      `inspection only). '${toolName}' needs a database and cannot execute for real in this mode.`,
    { tool: toolName, ls_inspect: true },
    'Not available under LS_INSPECT — restart the server with a real DATABASE_URL (and without LS_INSPECT) to invoke this tool for real.'
  );
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    return await handleToolCall(name, args);
  } catch (e) {
    return errorFromException(e);
  }
});

async function handleToolCall(
  name: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  // Schema-by-need suite (W3, red team P1: "让老师不需要猜 schema") —
  // 运行时未知字段拒绝, one hook for all tools (see lib/schema-guard.ts
  // header): the MCP SDK does not enforce inputSchema server-side at all, so
  // additionalProperties:false on TOOL_DEFINITIONS is decorative unless
  // something actually walks args against it before any handler runs.
  const unknownField = findUnknownField(TOOL_SCHEMA_BY_NAME.get(name), args, name);
  if (unknownField) {
    throw validationError(
      `Unknown field '${unknownField.field_path}' — not part of ${name}'s inputSchema.`,
      { ...unknownField }
    );
  }

  // LS_INSPECT 无库检视模式 (见上方 inspectionModeError 注释) — 挡在
  // create_pair 分流 / getCurrentPairId() 真正撞库之前, 每个工具统一走这一
  // 处, 不需要逐 case 甄别。
  if (LS_INSPECT) {
    throw inspectionModeError(name);
  }

  // create_pair 是全服务器唯一"无 active pair 也能调"的工具: 它就是
  // 造 pair 的那扇门, 放在 pair 门之前分流。有 pair 时也从这里走 (守卫在
  // 核心逻辑里: 该 learner 已有 active pair 会被 CONFLICT 拒绝并指路)。
  if (name === 'create_pair') {
    const idempotencyKey = args.idempotency_key as string | undefined;
    const learnerDisplayName = requireStringArg(args, 'learner_display_name').trim();
    const agentProvider = requireStringArg(args, 'agent_provider').trim();
    const agentModel = requireStringArg(args, 'agent_model').trim();
    const agentDisplayName = requireStringArg(args, 'agent_display_name').trim();
    const locale = typeof args.locale === 'string' && args.locale.trim() ? args.locale.trim() : undefined;
    const preferencesRaw = args.preferences;
    if (
      preferencesRaw !== undefined &&
      (preferencesRaw === null || typeof preferencesRaw !== 'object' || Array.isArray(preferencesRaw))
    ) {
      throw validationError('preferences must be a plain object if present.', { field: 'preferences' });
    }
    // idempotency 作用域: 此刻可能尚无 pair — 用 bootstrap 哨兵值占位
    // (idempotency_keys.pair_id 非 FK, 见该表头注)。
    return runIdempotentMutation('(bootstrap)', 'create_pair', idempotencyKey, args, async () => {
      // NOT_FOUND 分支的 recovery 文案在 createPairForRegisteredLearner 的
      // details 里只有机器码 — 这里包一层, 把"人话带路"补上。
      let result;
      try {
        result = await createPairForRegisteredLearner({
          learner_display_name: learnerDisplayName,
          agent_provider: agentProvider,
          agent_model: agentModel,
          agent_display_name: agentDisplayName,
          locale,
          preferences: preferencesRaw as Record<string, unknown> | undefined,
        });
      } catch (e) {
        if (e instanceof McpToolError && e.code === 'NOT_FOUND') {
          throw new McpToolError('NOT_FOUND', e.message, {
            retryable: false,
            details: e.details,
            recovery_hint:
              "Have the learner type her own name on the first-run page first (a sovereign action — the agent filling it in on her behalf would be overreach), " +
              'then call create_pair once registration is complete — learner_display_name must match her registered name character-for-character ' +
              '(including case and spaces).',
          });
        }
        throw e;
      }
      return buildSuccessEnvelope({
        operation: 'create_pair',
        resource_id: result.pair_id,
        created_refs: {
          pair_id: result.pair_id,
          learner_id: result.learner_id,
          agent_id: result.agent_id,
        },
        next_recommended_actions: ['get_context'],
        human_note:
          `Pair ${result.pair_id} established — learner "${learnerDisplayName}" × teacher "${agentDisplayName}" ` +
          `(established_at=${result.established_at}). Next: read recipe://learner-orientation and personally ` +
          "teach the first lesson (a fresh pair naturally has no contract and an empty shelf, so the fresh-pair precondition holds automatically), then flow straight into the contracting conversation.",
      });
    });
  }

  const pairId = await getCurrentPairId();
  if (!pairId) {
    throw notFoundError(
      "No active pair — there is no learner-agent relationship yet. Real enrollment goes through create_pair (the only front door; " +
        'see the "no-pair branch" of recipe://bootstrap): first have the learner register her own name on the first-run page, ' +
        'then you call create_pair to establish the pair. The demo showcase (seed:demo) is an optional showroom, not a prerequisite for enrollment.'
    );
  }

  switch (name) {
    case 'propose_contract': {
      const idempotencyKey = args.idempotency_key as string | undefined;
      const goal = (args.goal as string | undefined)?.trim();
      if (!goal) throw validationError('goal is required');
      // Contract 2.0 cadence 条款 — 可选, 谈过就带着签字台走。
      const cadence = validateCadenceArg(args, 'cadence', { required: false });
      // 自带教材条款 (迁移 0040) — 可选; 形状在写入口把死。
      const sourceMaterial = validateSourceMaterialArg(args, 'source_material');

      // 薄提案检测: 除 goal 外, 补充字段一个都没带, 说明 intake
      // 挖掘对话被跳过了. 不拒绝(签字台仍可拧旋钮补), 但要出声。
      const isThinProposal = !CONTRACT_SUPPLEMENTARY_FIELDS.some((field) =>
        hasMeaningfulProposalValue(args[field])
      );
      // 厚提案检测(薄提案检测的镜像病): goal 被塞成需求文档——课表/
      // 验收标准/教学法全挤在一句里, 证书没法一口气读完签名。goal 是誓言,
      // ≤~120 字符; 其余各回各家(cadence/success_criteria), 教学法进备课。
      // 同样不拒绝, 只出声——允许长, 不允许沉默的长。
      const GOAL_OATH_MAX_CHARS = 120;
      const isBloatedGoal = goal.length > GOAL_OATH_MAX_CHARS;

      return runIdempotentMutation(pairId, 'propose_contract', idempotencyKey, args, async () => {
        const id = genId('tc');
        const now = new Date();
        const timeRange =
          (args.time_range as { start: string; end_target?: string } | undefined) ??
          { start: now.toISOString() };

        await db.insert(teaching_contracts).values({
          id,
          pair_id: pairId,
          version: 1,
          goal,
          time_range: timeRange,
          success_criteria: (args.success_criteria as string[]) ?? [],
          agent_read_scopes: PROPOSE_CONTRACT_READ_SCOPES,
          agent_write_scopes: PROPOSE_CONTRACT_WRITE_SCOPES,
          feedback_tone: PROPOSE_CONTRACT_FEEDBACK_TONE,
          human_approval_required: [],
          forbidden_observations: [],
          created_at: now,
          updated_at: now,
          intensity: (args.intensity as ContractIntensity) ?? 'standard',
          interaction_mode: (args.interaction_mode as ContractInteractionMode) ?? 'hybrid',
          content_modality: (args.content_modality as ContractContentModality) ?? 'mixed',
          weekly_capacity_hours: (args.weekly_capacity_hours as number) ?? null,
          preferred_time_of_day: (args.preferred_time_of_day as PreferredTimeOfDay[]) ?? null,
          pace: (args.pace as ContractPace) ?? null,
          // Contract 2.0 — 可选; null 表示这次立约没谈节奏条款。
          cadence: cadence ?? null,
          // 自带教材条款 — 可选; null 表示这次立约没谈教材。
          source_material: sourceMaterial ?? null,
          // Class C (reminders) is the learner's signing-table form default —
          // not written here. accepts_reminders keeps the column's own
          // NOT NULL default (true).
          setup_status: 'proposed',
        });

        return buildSuccessEnvelope({
          operation: 'propose_contract',
          resource_id: id,
          created_refs: { contract_id: id },
          learner_url: `/contract/${id}`,
          // get_teacher_inbox 的 contract_proposed 项对同一等待态推荐的就是
          // adhoc_message_send (lib/teacher-inbox.ts proposedContractItems) —
          // 这里直接复用同一惯例, 不新造一个"该干嘛"的口径。
          next_recommended_actions: ['adhoc_message_send'],
          ...(isThinProposal
            ? {
                warning:
                  '薄提案：仅凭一句目标立约，学习者签到的是空白条款——建议先走 intake 挖掘（skill intake/contract-establish）。',
              }
            : isBloatedGoal
              ? {
                  warning:
                    'goal 过长（>120 字符）：契约是誓言不是需求文档——课表归 cadence、验收标准归 success_criteria、教学法进备课不进合同。学习者该能一口气读完并复述她签的是什么（见 skill intake/contract-establish 的 goal 写作契约）。',
                }
              : {}),
          // 回执回显教材档位 — 立约人当场看见自己记进合同的是
          // 哪本书、哪一档, 记错档位不用等到 brief 才发现。
          human_note:
            `Proposed contract ${id} — awaiting learner signature at /contract.` +
            (sourceMaterial ? ` ${formatSourceMaterialLine(sourceMaterial)}` : ''),
        });
      });
    }
    case 'update_contract_cadence': {
      const idempotencyKey = args.idempotency_key as string | undefined;
      const contractId = requireStringArg(args, 'contract_id');
      const cadence = validateCadenceArg(args, 'cadence', { required: true }) as ContractCadence;

      return runIdempotentMutation(pairId, 'update_contract_cadence', idempotencyKey, args, async () => {
        const [current] = await db
          .select({ id: teaching_contracts.id, pair_id: teaching_contracts.pair_id })
          .from(teaching_contracts)
          .where(eq(teaching_contracts.id, contractId))
          .limit(1);
        if (!current) throw notFoundError(`Contract ${contractId} not found`, { contract_id: contractId });
        if (current.pair_id !== pairId) {
          throw notFoundError(`Contract ${contractId} not found for this pair`, { contract_id: contractId });
        }

        const now = new Date();
        // 修约零仪式: teaching_contracts 没有 revision/history 表(version 列
        // 是历史遗留, 从未被真实写路径 bump 过) — 留痕退而求其次: 把这次改约
        // 的时间戳内嵌进 cadence 本身, 同时 bump 合同自身的 updated_at 列。
        const cadenceWithStamp: ContractCadence = { ...cadence, updated_at: now.toISOString() };

        await db
          .update(teaching_contracts)
          .set({ cadence: cadenceWithStamp, updated_at: now })
          .where(eq(teaching_contracts.id, contractId));

        return buildSuccessEnvelope({
          operation: 'update_contract_cadence',
          resource_id: contractId,
          created_refs: { contract_id: contractId },
          human_note:
            `Contract ${contractId} cadence updated (mode=${cadenceWithStamp.mode}, ` +
            `reminders=${cadenceWithStamp.reminders}, auto_duty=${cadenceWithStamp.auto_duty}). ` +
            'Other clauses untouched, not re-signed. The contract has no revision/history mechanism — the paper trail is the timestamp embedded in ' +
            `cadence.updated_at (${cadenceWithStamp.updated_at}) plus the contract's own updated_at column bumping in sync.`,
        });
      });
    }
    case 'void_contract': {
      const idempotencyKey = args.idempotency_key as string | undefined;
      const contractId = requireStringArg(args, 'contract_id');
      const reason = requireStringArg(args, 'reason');
      // Not persisted (no column for it — void_reason is the audit trail);
      // required here purely as the consent gate the tool description
      // demands. Carried into the receipt's human_note so the call itself
      // is the record that consent was obtained and what it said.
      const learnerConsent = requireStringArg(args, 'learner_consent');

      return runIdempotentMutation(pairId, 'void_contract', idempotencyKey, args, async () => {
        const [current] = await db
          .select({
            id: teaching_contracts.id,
            pair_id: teaching_contracts.pair_id,
            voided_at: teaching_contracts.voided_at,
            void_reason: teaching_contracts.void_reason,
          })
          .from(teaching_contracts)
          .where(eq(teaching_contracts.id, contractId))
          .limit(1);
        if (!current) throw notFoundError(`Contract ${contractId} not found`, { contract_id: contractId });
        if (current.pair_id !== pairId) {
          throw notFoundError(`Contract ${contractId} not found for this pair`, { contract_id: contractId });
        }

        // 幂等: 已作废的合约重复调用返回已作废状态, 不报错、不二次写入、不
        // 覆盖原 void_reason(第一次作废的理由才是历史真相)。
        if (current.voided_at) {
          return buildSuccessEnvelope({
            operation: 'void_contract',
            resource_id: contractId,
            created_refs: { contract_id: contractId },
            human_note:
              `Contract ${contractId} was already voided at ${current.voided_at.toISOString()} ` +
              `(reason: ${current.void_reason ?? '(none recorded)'}). No change made.`,
          });
        }

        const now = new Date();
        await db
          .update(teaching_contracts)
          .set({ voided_at: now, void_reason: reason, updated_at: now })
          .where(eq(teaching_contracts.id, contractId));

        return buildSuccessEnvelope({
          operation: 'void_contract',
          resource_id: contractId,
          created_refs: { contract_id: contractId },
          human_note:
            `Contract ${contractId} voided at ${now.toISOString()} (reason: ${reason}). ` +
            `Learner consent on record: "${learnerConsent}". ` +
            'The contract row is retained, not deleted — it has simply dropped out of the "current contract" selection result.',
        });
      });
    }
    case 'update_contract_coverage': {
      const idempotencyKey = args.idempotency_key as string | undefined;
      const contractId = requireStringArg(args, 'contract_id');
      const addCourseIds = validateOptionalStringArrayArg(args, 'add_course_ids') ?? [];
      const removeCourseIds = validateOptionalStringArrayArg(args, 'remove_course_ids') ?? [];
      if (addCourseIds.length === 0 && removeCourseIds.length === 0) {
        throw validationError(
          'add_course_ids / remove_course_ids — at least one must be a non-empty array; an empty call changes nothing.'
        );
      }

      return runIdempotentMutation(pairId, 'update_contract_coverage', idempotencyKey, args, async () => {
        const [current] = await db
          .select()
          .from(teaching_contracts)
          .where(eq(teaching_contracts.id, contractId))
          .limit(1);
        if (!current) throw notFoundError(`Contract ${contractId} not found`, { contract_id: contractId });
        if (current.pair_id !== pairId) {
          throw notFoundError(`Contract ${contractId} not found for this pair`, { contract_id: contractId });
        }
        if (current.completed_at) {
          throw conflictError(
            `Contract ${contractId} is already completed (completed_at=${current.completed_at.toISOString()}) — ` +
              'completed is a terminal state; the coverage sheet is locked in as of that moment and cannot be changed further. Open a new contract to continue teaching.',
            { contract_id: contractId, completed_at: current.completed_at.toISOString() }
          );
        }

        // 存在性 + 同 pair 校验 (同 assertConceptIdsExist / assertFlashcardIdsExist
        // 一路: 先查一遍, 一次性报出全部悬空/跨 pair 的 id, 不逐个撞 FK)。
        const touchedIds = [...new Set([...addCourseIds, ...removeCourseIds])];
        if (touchedIds.length > 0) {
          const foundRows = await db
            .select({ id: courses.id, pair_id: courses.pair_id })
            .from(courses)
            .where(inArray(courses.id, touchedIds));
          const foundById = new Map(foundRows.map((r) => [r.id, r.pair_id]));
          const dangling = touchedIds.filter((cid) => !foundById.has(cid));
          if (dangling.length > 0) {
            throw validationError(
              `add_course_ids/remove_course_ids has ${dangling.length} course id(s) that don't exist: ${JSON.stringify(dangling)}`,
              { dangling_ids: dangling }
            );
          }
          const foreign = touchedIds.filter((cid) => foundById.get(cid) !== pairId);
          if (foreign.length > 0) {
            throw validationError(
              `add_course_ids/remove_course_ids has ${foreign.length} course id(s) that don't belong to the current pair: ${JSON.stringify(foreign)}`,
              { foreign_ids: foreign }
            );
          }
        }

        const nextSet = new Set(current.covered_course_ids ?? []);
        for (const cid of addCourseIds) nextSet.add(cid);
        for (const cid of removeCourseIds) nextSet.delete(cid);
        const nextCoveredCourseIds = [...nextSet];

        const now = new Date();
        await db
          .update(teaching_contracts)
          .set({ covered_course_ids: nextCoveredCourseIds, updated_at: now })
          .where(eq(teaching_contracts.id, contractId));

        return buildSuccessEnvelope({
          operation: 'update_contract_coverage',
          resource_id: contractId,
          created_refs: { contract_id: contractId },
          human_note: `Contract ${contractId} covered_course_ids now: ${JSON.stringify(nextCoveredCourseIds)}.`,
        });
      });
    }
    case 'complete_contract': {
      const idempotencyKey = args.idempotency_key as string | undefined;
      const contractId = requireStringArg(args, 'contract_id');
      const completionNote = requireStringArg(args, 'completion_note');

      return runIdempotentMutation(pairId, 'complete_contract', idempotencyKey, args, async () => {
        const [current] = await db
          .select()
          .from(teaching_contracts)
          .where(eq(teaching_contracts.id, contractId))
          .limit(1);
        if (!current) throw notFoundError(`Contract ${contractId} not found`, { contract_id: contractId });
        if (current.pair_id !== pairId) {
          throw notFoundError(`Contract ${contractId} not found for this pair`, { contract_id: contractId });
        }

        // 幂等: 已结业的合约重复调用原样返回既有结业词, 不报错、不二次写入。
        if (current.completed_at) {
          return buildSuccessEnvelope({
            operation: 'complete_contract',
            resource_id: contractId,
            created_refs: { contract_id: contractId },
            human_note:
              `Contract ${contractId} was already completed at ${current.completed_at.toISOString()} ` +
              `(completion_note: ${current.completion_note ?? '(none recorded)'}). No change made.`,
          });
        }

        // 前置校验① — 合约现役, 经 lib/currentContract 的判定路径 (未签/已
        // 作废/已过终态一律拒绝) — 不自造一套 active 判断, 复用同一个真相源。
        const eligibleContracts = await listCurrentContracts(pairId);
        if (!eligibleContracts.some((c) => c.id === contractId)) {
          throw conflictError(
            `Contract ${contractId} is not an active contract (unsigned / voided / setup_status is terminal) — only an active contract can be completed.`,
            { contract_id: contractId, setup_status: current.setup_status, voided_at: current.voided_at?.toISOString() ?? null }
          );
        }

        // 前置校验② — covered_course_ids 非空。
        const coveredCourseIds = current.covered_course_ids ?? [];
        if (coveredCourseIds.length === 0) {
          throw conflictError(
            `Contract ${contractId}'s covered_course_ids is empty — this contract hasn't taught any course yet. ` +
              "Use update_contract_coverage (or pass contract_id when creating a course) to attach the taught course(s) first — only then can it be completed.",
            { contract_id: contractId }
          );
        }

        // 前置校验③ — 覆盖单里每门课的完课判定, 复用 lib/course-completion.ts
        // 的 evaluateCourseCompletion (与 get_context 的 buildContractProgressLines
        // 同一判据函数——两处施工前是各自独立的手写实现, 加 planned_lesson_count
        // 新口径(迁移 0032)时若只改一处会分叉, 本批统一到这一个函数)。
        //
        // 2026-07-20 (α批四针, 红队: "结业应是有证据的判断, 不是'数据库里
        // 暂时没有下一课'的副作用") — 门槛从旧 ready_to_complete 口径改用
        // goalReady (goal_completion_ready 的逐课判据): 该课程全部已发布课
        // learning 轴须 ∈ {completed_declared, closed} (未发布的课不计入),
        // *且* planned_lesson_count 非空且已发布节数 ≥ 那个数——没定过计划
        // 节数的课不再放行(旧口径下"零已发布课 + 未定计划"会静默通过, 现在
        // 结构化拒绝)。差额分两种独立上报, 互不覆盖:
        //   ① missing_planned_count — 课程没定 planned_lesson_count, 无从判断
        //      "教够了"; 文案指路 create_course 的这一问, 已建课程目前没有
        //      补录入口(未来若开放会在这里更新)。
        //   ② below_planned_count — 定过计划节数, 但已发布节数不足。
        // 两者都不覆盖 lessons (已发布但 learning 未到终态的清单) —— 一门课
        // 可以同时"缺计划节数"又"有未读完的课"。
        const coveredLessons = await db
          .select({ id: lessons.id, course_id: lessons.course_id, title: lessons.title })
          .from(lessons)
          .where(inArray(lessons.course_id, coveredCourseIds));

        const coveredCourseRows = await db
          .select({ id: courses.id, planned_lesson_count: courses.planned_lesson_count })
          .from(courses)
          .where(inArray(courses.id, coveredCourseIds));
        const plannedByCourse = new Map(coveredCourseRows.map((r) => [r.id, r.planned_lesson_count]));

        const gapsByCourse = new Map<
          string,
          {
            course_id: string;
            lessons: { lesson_id: string; title: string; learning: string }[];
            missing_planned_count?: true;
            below_planned_count?: { published_count: number; planned_lesson_count: number };
          }
        >();

        if (coveredLessons.length > 0) {
          const axes = await getLessonAxesForLessons(
            db,
            pairId,
            coveredLessons.map((l) => l.id)
          );
          const lessonsByCourse = new Map<string, typeof coveredLessons>();
          for (const lesson of coveredLessons) {
            const arr = lessonsByCourse.get(lesson.course_id) ?? [];
            arr.push(lesson);
            lessonsByCourse.set(lesson.course_id, arr);
          }

          for (const courseId of coveredCourseIds) {
            const courseLessons = lessonsByCourse.get(courseId) ?? [];
            const published = courseLessons
              .map((lesson) => ({ lesson, ax: axes.get(lesson.id) }))
              .filter(
                (x): x is { lesson: (typeof courseLessons)[number]; ax: LessonAxes } => x.ax?.content === 'published'
              );
            const plannedLessonCount = plannedByCourse.get(courseId) ?? null;
            const judgment = evaluateCourseCompletion(
              published.map((x) => ({ id: x.lesson.id, learning: x.ax.learning })),
              plannedLessonCount
            );
            if (judgment.goalReady) continue;

            const incompleteSet = new Set(judgment.incompleteLessonIds);
            const entry: {
              course_id: string;
              lessons: { lesson_id: string; title: string; learning: string }[];
              missing_planned_count?: true;
              below_planned_count?: { published_count: number; planned_lesson_count: number };
            } = { course_id: courseId, lessons: [] };
            for (const x of published) {
              if (incompleteSet.has(x.lesson.id)) {
                entry.lessons.push({ lesson_id: x.lesson.id, title: x.lesson.title, learning: x.ax.learning });
              }
            }
            if (judgment.missingPlannedCount) {
              entry.missing_planned_count = true;
            } else if (judgment.belowPlannedCount) {
              entry.below_planned_count = {
                published_count: judgment.publishedCount,
                planned_lesson_count: plannedLessonCount as number,
              };
            }
            gapsByCourse.set(courseId, entry);
          }
        }

        if (gapsByCourse.size > 0) {
          const gaps = [...gapsByCourse.values()];
          const gapSummary = gaps
            .map((g) => {
              const parts: string[] = [];
              if (g.lessons.length > 0) {
                parts.push(`${g.lessons.length} lesson(s) not yet completed (${g.lessons.map((l) => l.title).join(', ')})`);
              }
              if (g.missing_planned_count) {
                parts.push(
                  "planned_lesson_count not set (create_course's \"how many lessons total\" question was never answered; there is currently no way to backfill it on an already-created course)"
                );
              }
              if (g.below_planned_count) {
                parts.push(
                  `${g.below_planned_count.published_count} lesson(s) published, short of the planned ${g.below_planned_count.planned_lesson_count}`
                );
              }
              return `course ${g.course_id}: ${parts.join('; ')}`;
            })
            .join(' | ');
          throw conflictError(
            `Contract ${contractId} does not yet meet the completion criteria — some course(s) in the coverage sheet haven't cleared the completion bar ` +
              `(each published lesson's learning axis must be ∈ {completed_declared, closed}; and planned_lesson_count must be set with enough published lessons to meet it): ${gapSummary}.`,
            { contract_id: contractId, gaps }
          );
        }

        const now = new Date();
        await db
          .update(teaching_contracts)
          .set({ completed_at: now, completion_note: completionNote, updated_at: now })
          .where(eq(teaching_contracts.id, contractId));

        return buildSuccessEnvelope({
          operation: 'complete_contract',
          resource_id: contractId,
          created_refs: { contract_id: contractId },
          human_note: `Contract ${contractId} completed at ${now.toISOString()}. completion_note: "${completionNote}"`,
        });
      });
    }
    case 'create_course': {
      const idempotencyKey = args.idempotency_key as string | undefined;
      // topic is NOT NULL values-only, validated for a precise error.
      const courseTopic = requireStringArg(args, 'topic');
      const linkContractIdRaw = (args.contract_id as string | undefined)?.trim();
      const linkContractId = linkContractIdRaw ? linkContractIdRaw : undefined;
      // 计划节数 (学习者钦定设计, 迁移 0032) — 建课时的第一问"一共几节"。
      const plannedLessonCount = validateOptionalPositiveIntArg(args, 'planned_lesson_count');

      return runIdempotentMutation(pairId, 'create_course', idempotencyKey, args, async () => {
        // 建课即履约 (task item 3) — contract_id 传入时先验现役 + 同 pair,
        // 建课与合约覆盖单并入在同一次调用里完成, 不留孤儿关联(校验先于插入)。
        let linkedContract: (typeof teaching_contracts.$inferSelect) | undefined;
        if (linkContractId) {
          const eligibleContracts = await listCurrentContracts(pairId);
          linkedContract = eligibleContracts.find((c) => c.id === linkContractId);
          if (!linkedContract) {
            throw validationError(
              `contract_id ${linkContractId} is not an active contract for the current pair (doesn't exist / voided / unsigned / terminal state) — ` +
                'refusing to create the course (to avoid leaving an orphaned association). Use get_context to see active contracts.',
              { field: 'contract_id', contract_id: linkContractId }
            );
          }
        }

        const id = genId('crs');
        const now = new Date();
        await db.insert(courses).values({
          id,
          pair_id: pairId,
          topic: courseTopic,
          description: (args.description as string) ?? '',
          structure: { lesson_ids: [] },
          generated_by_agent_id: 'mcp',
          generated_from: (args.generated_from as SourceRef[]) ?? [],
          syllabus_version: (args.syllabus_version as string) ?? null,
          planned_lesson_count: plannedLessonCount ?? null,
          created_at: now,
          updated_at: now,
        });

        if (linkedContract) {
          const nextCoveredCourseIds = [...new Set([...(linkedContract.covered_course_ids ?? []), id])];
          await db
            .update(teaching_contracts)
            .set({ covered_course_ids: nextCoveredCourseIds, updated_at: new Date() })
            .where(eq(teaching_contracts.id, linkedContract.id));
        }

        // 追加工单 (2026-07-17 实测发现) — create_course 无契约软提示:
        // 白板 agent 曾被一句"帮我备课"直接带进备课流, 完全跳过契约建立——
        // 没有任何机器可见的路牌。不拒绝(可能是有意的快速试用), 但检测该
        // pair 有无生效契约(复用 getCurrentContract, 与 get_context 的
        // active_contracts 同一判定口径: 签过字且非终态), 无则挂 warning +
        // 把 propose_contract 排到推荐动作第一位。linkedContract 已经是现役
        // 合约, 不用再查一遍。
        const currentContract = linkedContract ?? (await getCurrentContract(pairId));
        const noContractWarning = currentContract
          ? undefined
          : '该 pair 尚无生效契约。若这是有意的快速试用可继续；否则先读 recipe://bootstrap——新学习关系应从 intake 立约开始。';

        return buildSuccessEnvelope({
          operation: 'create_course',
          resource_id: id,
          created_refs: { course_id: id },
          // α批四针 (2026-07-20) — 没有独立的课程详情页 (apps/web/src/
          // App.tsx 只有 /lesson 课程列表 + /courses/:courseId/lessons/:lessonId
          // 课文页, 课本身没有 courseId-only 路由), 落课程列表页, 新课会出现
          // 在这里。
          learner_url: `/lesson`,
          next_recommended_actions: noContractWarning
            ? ['propose_contract', 'add_lesson']
            : ['add_lesson'],
          ...(noContractWarning ? { warning: noContractWarning } : {}),
          human_note:
            `Created course ${id}` +
            (linkedContract ? ` · linked to contract ${linkedContract.id} (covered_course_ids +1)` : ''),
        });
      });
    }
    case 'add_lesson': {
      const idempotencyKey = args.idempotency_key as string | undefined;
      // course_id reaches syncCourseLessonIds's eq() (lethal as
      // undefined); title/content_markdown/order are NOT NULL values-only
      // (undefined → SQL DEFAULT → not-null violation), validated here anyway
      // so the caller gets a precise VALIDATION instead of a raw PG error.
      const courseId = requireStringArg(args, 'course_id');
      const lessonTitle = requireStringArg(args, 'title');
      const lessonContent = validateLessonContent(requireStringArg(args, 'content_markdown'));
      const lessonOrder = requireNumberArg(args, 'order');
      // P1-c (concepts 链审计) — concept_ids must be an array of strings, not
      // a bare string (裸字符串可迭代, 会让"课末概念清单"计数拆成单字符);
      // dangling ids get an existence precheck inside the mutation below,
      // same shape as add_exercise's expected_concepts precheck.
      const lessonConceptIds = validateOptionalStringArrayArg(args, 'concept_ids');
      // 脑图裁量条款子项 — 脑图缺席要留言; shape-check same style as concept_ids.
      const lessonModalityDeclarations = validateOptionalStringMapArg(args, 'modality_declarations');
      return runIdempotentMutation(pairId, 'add_lesson', idempotencyKey, args, async () => {
        // course_id existence precheck, same shape as
        // add_exercise's lesson_id precheck above. Without this, a bad
        // course_id sails into the insert below and trips lessons' course_id
        // FK constraint — a raw PG error classified after a write attempt
        // instead of a precise VALIDATION before one.
        const [course] = await db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
        if (!course) {
          throw validationError(
            `course_id '${courseId}' does not exist — check the real id returned by create_course, or use get_context to see existing courses.`,
            { field: 'course_id' }
          );
        }
        if (lessonConceptIds !== undefined) {
          await assertConceptIdsExist(lessonConceptIds, 'concept_ids');
        }

        const id = genId('lsn');
        // Publish Gate: published_at 不写 = DEFAULT NULL = 草稿态,
        // 仅教师/MCP 侧可见。要上架给学习者须过 publish_lesson 的验尺红灯闸。
        await db.insert(lessons).values({
          id,
          course_id: courseId,
          order: lessonOrder,
          title: lessonTitle,
          content_markdown: lessonContent,
          concept_ids: lessonConceptIds ?? [],
          source_refs: [],
          estimated_minutes: (args.estimated_minutes as number) ?? 15,
          skill_used: (args.skill_used as string) ?? null,
          modality_declarations: lessonModalityDeclarations ?? null,
        });
        // structure.lesson_ids is derived, not independently
        // authored; keep it in sync with the lessons table on every insert.
        await syncCourseLessonIds(courseId);
        return buildSuccessEnvelope({
          operation: 'add_lesson',
          resource_id: id,
          created_refs: { lesson_id: id, course_id: courseId },
          learner_url: `/courses/${courseId}/lessons/${id}`,
          // 断点②③ — add_lesson 建的课默认草稿态 (published_at
          // NULL), 但旧回执只报"课建好了"+一个 learner_url, 完全不提"学习者
          // 现在看不见"; next_recommended_actions 也从不推荐 publish_lesson,
          // agent 备完配套内容就以为流程结束。human_note 明示草稿态 + 紧邻
          // 说明 learner_url 要发布后才生效; publish_lesson 追加到推荐动作
          // 末位(语义=最终步, 排在配套内容三件套之后)。
          next_recommended_actions: ['add_concept', 'add_flashcard', 'add_exercise', 'publish_lesson'],
          human_note:
            `Created lesson ${id} — established as a draft, not visible to the learner ` +
            '(learner_url takes effect for the learner only after publishing). Once supporting content ' +
            '(concepts/flashcards/exercises) is complete and verify_prep passes, call publish_lesson to publish.',
        });
      });
    }
    case 'update_lesson': {
      const idempotencyKey = args.idempotency_key as string | undefined;
      // lesson_id reaches eq() in the select below (lethal as undefined).
      const lessonId = requireStringArg(args, 'lesson_id');
      const revisionReason = args.revision_reason as string | undefined;
      if (!revisionReason) {
        throw validationError(
          'revision_reason is required — a revision without a reason is rejected'
        );
      }
      // 迁移 0033 (双轨修订) — 缺省 teaching: 发布后的修订默认面向学习者,
      // 宁可多呈现不可偷藏。显式传值时只认 'teaching'/'technical' 两种,
      // 其余一律拒绝 (同 add_lesson_patch 的 kind 校验风格)。
      const revisionKindRaw = args.revision_kind;
      if (
        revisionKindRaw !== undefined &&
        revisionKindRaw !== 'teaching' &&
        revisionKindRaw !== 'technical'
      ) {
        throw validationError(
          `revision_kind must be 'teaching' or 'technical' — got ${JSON.stringify(revisionKindRaw)}. ` +
            'Test: did this change come out of teaching her, or was it forced by the machine? The former is teaching, the latter is technical.',
          { field: 'revision_kind' }
        );
      }
      const revisionKind: LessonRevisionKind = (revisionKindRaw as LessonRevisionKind) ?? 'teaching';
      // P1-c (concepts 链审计) — same shape-check as add_lesson's concept_ids
      // above; existence precheck happens inside the mutation below.
      const patchLessonConceptIds = validateOptionalStringArrayArg(args, 'concept_ids');
      // 脑图裁量条款子项 — 脑图缺席要留言; shape-check same style as concept_ids.
      const patchLessonModalityDeclarations = validateOptionalStringMapArg(args, 'modality_declarations');
      const patch: Record<string, unknown> = {};
      if (args.content_markdown !== undefined) {
        patch.content_markdown = validateLessonContent(args.content_markdown);
      }
      if (args.title !== undefined) patch.title = args.title as string;
      if (patchLessonConceptIds !== undefined) patch.concept_ids = patchLessonConceptIds;
      if (args.estimated_minutes !== undefined) patch.estimated_minutes = args.estimated_minutes as number;
      if (patchLessonModalityDeclarations !== undefined) {
        patch.modality_declarations = patchLessonModalityDeclarations;
      }
      if (Object.keys(patch).length === 0) {
        throw validationError(
          'At least one of content_markdown / title / concept_ids / estimated_minutes / ' +
            'modality_declarations is required'
        );
      }

      return runIdempotentMutation(pairId, 'update_lesson', idempotencyKey, args, async () => {
        const [current] = await db.select().from(lessons).where(eq(lessons.id, lessonId)).limit(1);
        if (!current) throw notFoundError(`Lesson ${lessonId} not found`, { lesson_id: lessonId });
        if (patchLessonConceptIds !== undefined) {
          await assertConceptIdsExist(patchLessonConceptIds, 'concept_ids');
        }

        // Agent Surface Hardening 第一批 ("同病同治") —
        // snapshot + bump used to be two unguarded statements; a crash
        // between them left a lesson_revisions row with no matching revision
        // bump (or vice versa if reordered). Both now commit atomically.
        const revId = genId('lrev');
        const updated = await db.transaction(async (tx) => {
          await tx.insert(lesson_revisions).values({
            id: revId,
            lesson_id: lessonId,
            revision: current.revision,
            prev_content_markdown: current.content_markdown,
            prev_title: current.title,
            reason: revisionReason,
            evidence: (args.evidence as string) ?? null,
            revised_by: 'mcp',
            revised_at: new Date(),
            kind: revisionKind,
          });

          const [row] = await tx
            .update(lessons)
            .set({ ...patch, revision: current.revision + 1 })
            .where(eq(lessons.id, lessonId))
            .returning();
          return row;
        });

        // 已发布课修订重过闸 — 已发布课的每次修订都要重新过
        // 发布门禁, 与 publish_lesson 同一套 validateLesson+canPublish 判定
        // (照抄 publish_lesson 的调用形状)。validateLesson 走独立的
        // queryClient 连接读 DB, 只有 commit 之后才看得见上面刚写的新内容,
        // 所以这里放在事务 commit 之后而不是里面; FAIL 时用 `current` 快照
        // 把 lesson 字段 + revision 计数撤回, 并删掉被拒的 revision 行——
        // 净效果与"事务内回滚"等价("拒绝写入"), 只是走了 commit+revert 两步,
        // 不是真正的单事务回滚。草稿课 (published_at 为空) 不受影响, 行为不变。
        if (current.published_at != null) {
          const report = await validateLesson(queryClient, lessonId);
          if (report && !canPublish(report.status)) {
            const reds = report.checks.filter((c) => c.severity === 'fail');
            await db.transaction(async (tx2) => {
              const revertFields: Record<string, unknown> = {};
              for (const key of Object.keys(patch)) {
                revertFields[key] = (current as unknown as Record<string, unknown>)[key];
              }
              await tx2
                .update(lessons)
                .set({ ...revertFields, revision: current.revision })
                .where(eq(lessons.id, lessonId));
              await tx2.delete(lesson_revisions).where(eq(lesson_revisions.id, revId));
            });
            throw validationError(
              `Publish rejected — a published lesson's revision must clear the Publish Gate again: ${lessonId} ${statusLine(report)}. Red-light list: ` +
                reds.map((c) => `[${c.category}·${c.id}] ${c.detail}`).join('; ') +
                '. Every revision to a published lesson has to clear the publish gate (Publish Gate) again — fix the issues and resubmit, ' +
                'or unpublish first via update_lesson (if no unpublish tool exists, contact an administrator).',
              { lesson_id: lessonId, status: report.status, red_lights: reds }
            );
          }
        }

        // 批D: content_markdown changing
        // is exactly the case that can strand an existing highlight's anchor —
        // re-check this lesson's annotations right away rather than waiting
        // for the next standalone sweep-orphans call. Only worth doing when
        // the text itself moved; a title/concept_ids/estimated_minutes-only
        // patch can't affect any anchor. Kept outside the transaction above —
        // it's a best-effort repair scan over a separate entity
        // (lesson_annotations), not required for the revision write's own
        // atomicity.
        let sweepNote = '';
        if (patch.content_markdown !== undefined) {
          const sweep = await sweepLessonAnnotations(lessonId);
          if (sweep.swept > 0) {
            sweepNote = ` · annotations re-swept: ${sweep.swept} checked, ${sweep.orphaned} orphaned`;
          }
        }

        // 断点② 的姊妹病灶 — 未发布课的修订回执同样只报"改好了",
        // 不提醒仍是草稿态。已发布课不加这句(上面重验闸已经把它管住,
        // 这里加只会制造"发布了又说没发布"的噪音)。current 是事务前快照,
        // update_lesson 本身不动 published_at, 用它判定草稿/已发布安全。
        const draftNote =
          current.published_at == null
            ? ' · 仍是草稿态，学习者不可见——完成配套内容并 verify_prep 通过后调 publish_lesson 发布'
            : '';

        // (件四, "无条件推荐三窝"之二) — 推荐前查状态: 这节课若已有
        // W1C 挂锚反思 (teacher_reflections.lesson_id 命中), 不再无条件重推
        // reflect_on_teaching (同病: 前提已满足的动作还在被推荐, 与
        // close_lesson_loop 7/19 修口径一致)。
        const alreadyReflected = await fetchAnchoredReflectionExists(pairId, lessonId);

        return buildSuccessEnvelope({
          operation: 'update_lesson',
          resource_id: lessonId,
          revision: updated?.revision,
          created_refs: { lesson_revision_id: revId },
          next_recommended_actions: alreadyReflected ? [] : ['reflect_on_teaching'],
          human_note: `Lesson ${lessonId} revised to v${updated?.revision}${sweepNote}${draftNote}`,
        });
      });
    }
    case 'add_lesson_patch': {
      const idempotencyKey = args.idempotency_key as string | undefined;
      const patchLessonId = requireStringArg(args, 'lesson_id');
      const patchKindRaw = args.kind;
      if (patchKindRaw !== 'teacher_note' && patchKindRaw !== 'erratum') {
        throw validationError(
          `kind must be 'teacher_note' or 'erratum' — got ${JSON.stringify(patchKindRaw)}. ` +
            'Three-way boundary: a lesson currently being learned only allows teacher_note; a completed lesson only allows erratum; ' +
            "a lesson that hasn't started shouldn't be patched at all — just use update_lesson to revise it directly.",
          { field: 'kind' }
        );
      }
      const patchKind = patchKindRaw as LessonPatchKind;
      const patchBody = requireStringArg(args, 'body');

      return runIdempotentMutation(pairId, 'add_lesson_patch', idempotencyKey, args, async () => {
        const [lesson] = await db.select().from(lessons).where(eq(lessons.id, patchLessonId)).limit(1);
        if (!lesson) {
          throw validationError(
            `lesson_id '${patchLessonId}' does not exist — check the real id returned by the earlier add_lesson/create_course call; ` +
              'use get_context to see the current course structure.',
            { field: 'lesson_id' }
          );
        }
        const id = genId('lpatch');
        await db.insert(lesson_patches).values({
          id,
          lesson_id: patchLessonId,
          pair_id: pairId,
          kind: patchKind,
          body: patchBody,
          anchor: (args.anchor as string | undefined) ?? null,
          source_attribution: (args.source_attribution as string | undefined) ?? null,
          created_at: new Date(),
        });
        return buildSuccessEnvelope({
          operation: 'add_lesson_patch',
          resource_id: id,
          created_refs: { lesson_patch_id: id, lesson_id: patchLessonId },
          next_recommended_actions: ['close_lesson_loop'],
          human_note: `Added ${patchKind} patch ${id} to lesson ${patchLessonId}`,
        });
      });
    }
    case 'close_lesson_loop': {
      const idempotencyKey = args.idempotency_key as string | undefined;
      const closeLessonId = requireStringArg(args, 'lesson_id');
      const noCognitiveUpdateReason =
        typeof args.no_cognitive_update_reason === 'string' ? args.no_cognitive_update_reason : undefined;
      // 回执改为可选 (2026-07-26 · 行项退役案的收尾): 学习者侧的回执渲染卡已
      // 于 2026-07-22 退役 (apps/web/src/pages/Lesson.tsx §5 头注, 全前端零调
      // 用 —— getLessonLoopReceipts 现在只剩那条注释在提它), 老师却一直被强制
      // 写一份没有读者的 changelog。缺席 = 空数组。
      // 松的只有"必须有"这一条: 传了的每一条仍走下面全套校验 (kind 封闭枚举 /
      // description 非空 / 下游 evaluateCloseLoop 的 DANGLING_REF 逐条验真 /
      // LIVE_REF_NO_SUBSTANCE), 一条都没放。空回执也不会让别的闸门失效 ——
      // 见 lib/close-loop-guard.ts 里 ② NO_COGNITIVE_UPDATE 与 ④
      // LIVE_SNAPSHOT_UNREFERENCED 两处"空回执时如何表现"的头注。
      const receiptRaw = args.receipt ?? [];
      if (!Array.isArray(receiptRaw)) {
        throw validationError('receipt must be an array of { kind, description, ref_id? } when provided', {
          field: 'receipt',
        });
      }
      const allowedReceiptKinds = new Set<string>(LESSON_LOOP_RECEIPT_KINDS);
      const receiptItems: { kind: LessonLoopReceiptKind; description: string; ref_id?: string }[] = [];
      receiptRaw.forEach((raw, i) => {
        if (!raw || typeof raw !== 'object') {
          throw validationError(`receipt[${i}] must be an object`, { field: `receipt[${i}]` });
        }
        const r = raw as Record<string, unknown>;
        if (typeof r.kind !== 'string' || !allowedReceiptKinds.has(r.kind)) {
          throw validationError(
            `receipt[${i}].kind '${JSON.stringify(r.kind)}' is not in the closed enum — only: ` +
              `${LESSON_LOOP_RECEIPT_KINDS.join(', ')}. This mechanically enforces "don't invent a new black box" — don't route around it.`,
            { field: `receipt[${i}].kind` }
          );
        }
        if (typeof r.description !== 'string' || r.description.trim() === '') {
          throw validationError(`receipt[${i}].description is required (non-empty string)`, {
            field: `receipt[${i}].description`,
          });
        }
        receiptItems.push({
          kind: r.kind as LessonLoopReceiptKind,
          description: r.description,
          ref_id: typeof r.ref_id === 'string' ? r.ref_id : undefined,
        });
      });

      return runIdempotentMutation(pairId, 'close_lesson_loop', idempotencyKey, args, async () => {
        // ---- 完成权 gate: 关课前先看本课 progress 行 ----
        // closed → 幂等短路: closed 是不可逆终态, 无论 idempotency_key 是否
        // 变化都返回幂等成功, 不重写 closed_at、不追加新回执副作用 (回执
        // insert 在下面的事务里, 这里 return 时一行都还没写)。
        // 未宣告 → resolveCloseAttempt 算出 hasCompletedDeclared=false, 由
        // evaluateCloseLoop 的 NOT_DECLARED 硬检拒绝 (declare → 铃 → 批改 →
        // close 的正序)。注意此查询按 (pair_id, lesson_id) 过滤: 别的 pair 的
        // 课不会有本 pair 的 progress 行, 存在性/归属双检仍由下面的
        // assembleLessonClosureCoreFacts 入口把守, 顺序不受影响。
        const [progressBefore] = await db
          .select()
          .from(lesson_progress)
          .where(and(eq(lesson_progress.pair_id, pairId), eq(lesson_progress.lesson_id, closeLessonId)))
          .limit(1);
        const closeAttempt = resolveCloseAttempt(
          progressBefore ? { state: progressBefore.state, declared_at: progressBefore.declared_at } : null
        );
        if (closeAttempt.kind === 'already_closed') {
          return buildSuccessEnvelope({
            operation: 'close_lesson_loop',
            resource_id: closeLessonId,
            created_refs: {
              lesson_id: closeLessonId,
              lesson_progress_id: progressBefore!.id,
            },
            human_note:
              `Lesson ${closeLessonId} was already closed at ${progressBefore!.closed_at?.toISOString() ?? '(unknown)'} — ` +
              'closed is an irreversible terminal state; this call is an idempotent replay, closed_at unchanged and no receipt appended.',
          });
        }

        // ---- 空转防护: 采集事实 → 五道硬检 (纯判定在 lib/close-loop-guard) ----

        // ①②④ 三道检查共同的"从 DB 数出发生了什么"部分现在共享一份查询
        // (lib/lesson-closure-facts.ts assembleLessonClosureCoreFacts) ——
        // 只读的 get_lesson_closure_state (件二) 同吃这份, 不许两处各写一遍。
        // 存在性 + pair 归属双检 (lessons⋈courses.pair_id, 验收判词回炉
        // 2026-07-20) 也下沉在该 helper 入口, 过不了直接抛, 这里不再另查一遍。
        const coreFacts = await assembleLessonClosureCoreFacts(pairId, closeLessonId);
        const {
          ungradedSubmissionIds,
          hasPostLessonEvaluation,
          completedLiveSessionIds,
          snapshotIdsBySession,
          evaluationIdsBySession,
        } = coreFacts;

        // ③ 回执各 ref_id 逐表批量验存在 → refPresence[id] = 它命中的表清单。
        const providedRefIds = Array.from(
          new Set(receiptItems.map((it) => it.ref_id).filter((x): x is string => typeof x === 'string'))
        );
        const refPresence: Record<string, RefTable[]> = {};
        // ⑦ live 引用须有实质: 命中 live_sessions 的 ref → 该场的实质
        // 档案 (completed? / 有快照或场评?), 喂给 evaluateCloseLoop 的
        // LIVE_REF_NO_SUBSTANCE 检查。
        const liveRefSubstance: Record<string, { completed: boolean; hasEvidence: boolean }> = {};
        if (providedRefIds.length > 0) {
          const addPresence = (id: string, table: RefTable) => {
            (refPresence[id] ??= []).push(table);
          };
          const [subRows, revRows, patchRows, cardRows, hypRows, evtRows, snapRows, plevRows, liveRows, liveEvalRows] =
            await Promise.all([
              db.select({ id: exercise_submissions.id }).from(exercise_submissions).where(inArray(exercise_submissions.id, providedRefIds)),
              db.select({ id: lesson_revisions.id }).from(lesson_revisions).where(inArray(lesson_revisions.id, providedRefIds)),
              db.select({ id: lesson_patches.id }).from(lesson_patches).where(inArray(lesson_patches.id, providedRefIds)),
              db.select({ id: flashcards.id }).from(flashcards).where(inArray(flashcards.id, providedRefIds)),
              db.select({ id: learner_hypotheses.id }).from(learner_hypotheses).where(inArray(learner_hypotheses.id, providedRefIds)),
              db.select({ id: session_events.event_id }).from(session_events).where(inArray(session_events.event_id, providedRefIds)),
              db.select({ id: mid_lesson_snapshots.id }).from(mid_lesson_snapshots).where(inArray(mid_lesson_snapshots.id, providedRefIds)),
              db.select({ id: post_lesson_evaluations.id }).from(post_lesson_evaluations).where(inArray(post_lesson_evaluations.id, providedRefIds)),
              db.select({ id: live_sessions.id, status: live_sessions.status }).from(live_sessions).where(inArray(live_sessions.id, providedRefIds)),
              db.select({ id: live_session_evaluations.id }).from(live_session_evaluations).where(inArray(live_session_evaluations.id, providedRefIds)),
            ]);
          subRows.forEach((r) => addPresence(r.id, 'exercise_submissions'));
          revRows.forEach((r) => addPresence(r.id, 'lesson_revisions'));
          patchRows.forEach((r) => addPresence(r.id, 'lesson_patches'));
          cardRows.forEach((r) => addPresence(r.id, 'flashcards'));
          hypRows.forEach((r) => addPresence(r.id, 'learner_hypotheses'));
          evtRows.forEach((r) => addPresence(r.id, 'session_events'));
          snapRows.forEach((r) => addPresence(r.id, 'mid_lesson_snapshots'));
          plevRows.forEach((r) => addPresence(r.id, 'post_lesson_evaluations'));
          liveRows.forEach((r) => addPresence(r.id, 'live_sessions'));
          liveEvalRows.forEach((r) => addPresence(r.id, 'live_session_evaluations'));

          // 被引用场次的证据存在性 (快照/场评任一即算): 只查被 ref 命中的
          // 场次, 不重复 coreFacts 那份"本课全部场次"的查询。
          const referencedLiveIds = liveRows.map((r) => r.id);
          if (referencedLiveIds.length > 0) {
            const [refSnaps, refEvals] = await Promise.all([
              db
                .select({ session_id: mid_lesson_snapshots.session_id })
                .from(mid_lesson_snapshots)
                .where(inArray(mid_lesson_snapshots.session_id, referencedLiveIds)),
              db
                .select({ session_id: live_session_evaluations.live_session_id })
                .from(live_session_evaluations)
                .where(inArray(live_session_evaluations.live_session_id, referencedLiveIds)),
            ]);
            const withEvidence = new Set<string>([
              ...refSnaps.map((s) => s.session_id),
              ...refEvals.map((e) => e.session_id),
            ]);
            for (const live of liveRows) {
              liveRefSubstance[live.id] = {
                completed: live.status === 'completed',
                hasEvidence: withEvidence.has(live.id),
              };
            }
          }
        }

        // ④ 本课已完成的 Live session + 它们的 snapshot/场评 — 来自上面共享的
        // coreFacts (completedLiveSessionIds / snapshotIdsBySession /
        // evaluationIdsBySession), 不再本地重查一遍。红队第四轮: 快照 OR
        // 场评皆可满足 check ④ 的现场证据要求 (课后合法证据走
        // record_live_evaluation, 不再靠补写快照冒充)。

        const facts: CloseLoopFacts = {
          ungradedSubmissionIds,
          hasPostLessonEvaluation,
          refPresence,
          liveRefSubstance,
          completedLiveSessionIds,
          snapshotIdsBySession,
          evaluationIdsBySession,
          noCognitiveUpdateReason,
          // ⓪ 完成权 gate — 上面 resolveCloseAttempt 从 progress 行
          // 现算的"学习者是否已亲手宣告完成"。
          hasCompletedDeclared: closeAttempt.hasCompletedDeclared,
        };
        const violations = evaluateCloseLoop(receiptItems, facts);
        if (violations.length > 0) {
          throw validationError(
            'Closing rejected — empty-run guard: ' + violations.map((v) => `[${v.code}] ${v.message}`).join('  '),
            { violations: violations.map((v) => ({ code: v.code, ...v.details })) }
          );
        }

        const now = new Date();
        const receiptIds: string[] = [];
        const progressRow = await db.transaction(async (tx) => {
          for (const item of receiptItems) {
            const rid = genId('lrcpt');
            receiptIds.push(rid);
            await tx.insert(lesson_loop_receipts).values({
              id: rid,
              pair_id: pairId,
              lesson_id: closeLessonId,
              kind: item.kind,
              description: item.description,
              ref_id: item.ref_id ?? null,
              created_at: now,
            });
          }

          const [existing] = await tx
            .select()
            .from(lesson_progress)
            .where(and(eq(lesson_progress.pair_id, pairId), eq(lesson_progress.lesson_id, closeLessonId)))
            .limit(1);

          const reasonToPersist = noCognitiveUpdateReason?.trim() || null;
          if (existing) {
            const [row] = await tx
              .update(lesson_progress)
              .set({
                state: 'closed',
                closed_at: now,
                updated_at: now,
                ...(reasonToPersist ? { no_cognitive_update_reason: reasonToPersist } : {}),
              })
              .where(eq(lesson_progress.id, existing.id))
              .returning();
            return row;
          }
          // 无 progress 行时不再允许直接 insert closed —— 未宣告即无行,
          // 早被完成权 gate (NOT_DECLARED) 拦下; 走到这里必有行。空到这里只剩
          // 并发删除的极端窗口, 防御性抛错, 不静默造一行终态。
          throw conflictError(
            `lesson_progress row for lesson ${closeLessonId} vanished mid-close —— ` +
              'the row disappeared after the completion-right gate (concurrent delete?); this close attempt was aborted, no terminal state was written. Re-check status and try again.',
            { lesson_id: closeLessonId }
          );
        });

        // 回执推荐状态化: next_recommended_actions 按该 pair 已
        // 闭环课数(含本次, state='closed' 是关课终态)条件化, 不再无条件推
        // reflect_on_teaching (与 recipe "前两课不立假设不写反思" 纪律打架)。
        // 判定是纯函数(lib/close-loop-guard.ts), 这里只数数。
        //
        // 红队第四轮: 数完还要看"上一次关课之后, 这个 pair 是不是已经写过
        // 反思了"——写过就不再重复推荐 reflect_on_teaching(同病: 前提已满足
        // 的动作还在被推荐)。取两条已关课行(本次 + 上一次)按 closed_at 倒序,
        // 第二条就是"上一次关课"的时间点; 拿这个 pair 最新一条 teacher_
        // reflections.written_at 跟它比——这是 pair 粒度的近似判定(fallback)。
        //
        // 0035 (反思挂锚) 双轨升级: 同时查这节课本身是否有挂锚反思
        // (teacher_reflections.lesson_id = 本课 id)。挂锚存在 → 精确判定"已
        // 反思", 不需要再看近似分支; 挂锚数据要么还没积累(存量反思 lesson_id
        // 恒 null), 要么这节课确实还没人挂锚反思过时, 才回落上面的 pair 级
        // 近似——resolveHasReflectedForClose 做这道合流(lib/close-loop-guard.ts)。
        //
        // 取数复用 lib/lesson-closure-facts.ts 的三个 helper (与 get_lesson_
        // closure_state 同一份查询, 验收判词回炉 2026-07-20 兑现 DRY): 此刻
        // 关课事务已提交, 最新一条已关课行就是本课自己, 故 skip=1 取第二新
        // 作为"上一次关课"基准 (见 fetchMostRecentCloseAt 头注)。
        const [closedCountRow, previousCloseAt, hasAnchoredReflectionForLesson] = await Promise.all([
          db
            .select({ n: sql<number>`count(*)::int` })
            .from(lesson_progress)
            .where(and(eq(lesson_progress.pair_id, pairId), eq(lesson_progress.state, 'closed'))),
          fetchMostRecentCloseAt(pairId, 1),
          fetchAnchoredReflectionExists(pairId, closeLessonId),
        ]);
        const closedLessonCount = Number(closedCountRow[0]?.n ?? 0);
        const hasReflectedSinceLastCloseApprox = await fetchReflectedSinceApprox(pairId, previousCloseAt);
        const hasReflectedForClose = resolveHasReflectedForClose(
          hasAnchoredReflectionForLesson,
          hasReflectedSinceLastCloseApprox
        );

        // 随行回执 (红队第六轮针二) — 关课事务已提交, 写后重新装配一次事实。
        // recentCloseSkip=1: 最新一条已关课行此刻就是本课自己, 见
        // computeLessonClosureProgress 头注 —— 用默认 0 会把反思近似判定的
        // 基准错摆到本课自己刚写下的 closed_at 上。正常路径下 (单场已完成
        // Live + 已有总评/反思) 这里应显示 missing=[] (全 completed)。
        const closureProgress = toClosureProgress(
          await computeLessonClosureProgress(pairId, closeLessonId, { recentCloseSkip: 1 })
        );

        return buildSuccessEnvelope({
          operation: 'close_lesson_loop',
          resource_id: closeLessonId,
          created_refs: {
            lesson_id: closeLessonId,
            lesson_progress_id: progressRow?.id ?? '',
            receipt_ids: receiptIds.join(','),
          },
          next_recommended_actions: pickCloseLoopNextActions(closedLessonCount, hasReflectedForClose),
          closure_progress: closureProgress,
          human_note: `Closed loop for lesson ${closeLessonId} with ${receiptItems.length} receipt item(s).`,
        });
      });
    }
    case 'get_lesson_closure_state': {
      // 红队 P1 (Live 2.0 二期 W2 件二) — 只读, 不改动任何状态。事实装配复用
      // close_lesson_loop 同一份 helper (lib/lesson-closure-facts.ts), 判定
      // 复用同一套纯函数 (lib/close-loop-guard.ts computeLessonClosureState /
      // pickLessonClosureNextAction) —— close_lesson_loop 关课那一刻做的
      // "缺不缺"判断, 这里在关课前把同一套判断摆到台面上。
      const closureLessonId = requireStringArg(args, 'lesson_id');
      // 存在性 + pair 归属双检 (lessons⋈courses.pair_id) 下沉在
      // assembleLessonClosureCoreFacts 入口 (验收判词回炉 2026-07-20), 与
      // close_lesson_loop 同一道闸。事实装配 + 判定现在单点收在
      // lib/lesson-closure-facts.ts computeLessonClosureProgress —— 红队第
      // 六轮针二把这段抽成共享函数, 四工具随行回执 (record_live_evaluation /
      // record_post_lesson_evaluation / reflect_on_teaching / close_lesson_
      // loop) 的 closure_progress 字段同吃这一份, 不再各写一遍。关课前只读:
      // 本课根本不在已关课集合里, 默认 recentCloseSkip=0 直接取最新一条即可。
      const report = await computeLessonClosureProgress(pairId, closureLessonId);

      return success({
        operation: 'get_lesson_closure_state',
        resource_id: closureLessonId,
        // 曾写 `state=graded` 而 missing 里也有 graded, 被读成自相
        // 矛盾——state 的语义是"首个缺口"(待办名, 非已达成), human_note 措辞
        // 改成把这层语义直接说出口, 不再指望读者去翻 contracts 的字段注释。
        human_note:
          report.state === 'closed'
            ? `Lesson ${closureLessonId} is closed.`
            : `Lesson ${closureLessonId} is stuck at '${report.state}' (state = first gap, i.e. outstanding, not done) · missing: ${report.missing.join(', ') || '(none)'}`,
        data: report,
      });
    }
    case 'publish_lesson': {
      const idempotencyKey = args.idempotency_key as string | undefined;
      const publishLessonId = requireStringArg(args, 'lesson_id');
      return runIdempotentMutation(pairId, 'publish_lesson', idempotencyKey, args, async () => {
        const [lesson] = await db
          .select({ id: lessons.id, published_at: lessons.published_at, course_id: lessons.course_id })
          .from(lessons)
          .where(eq(lessons.id, publishLessonId))
          .limit(1);
        if (!lesson) throw notFoundError(`Lesson ${publishLessonId} not found`, { lesson_id: publishLessonId });

        // 红灯闸: 与 verify_prep 同一套 validateLesson 判定 (lib/validate-prep-core)。
        const report = await validateLesson(queryClient, publishLessonId);
        if (!report) throw notFoundError(`Lesson ${publishLessonId} not found`, { lesson_id: publishLessonId });
        if (!canPublish(report.status)) {
          const reds = report.checks.filter((c) => c.severity === 'fail');
          throw validationError(
            `Publish rejected — verification red lights not cleared: ${publishLessonId} ${statusLine(report)}. Red-light list: ` +
              reds.map((c) => `[${c.category}·${c.id}] ${c.detail}`).join('; ') +
              '. Fix the ❌ items (revise the lesson text / add missing teaching materials) and rerun publish_lesson — publishing is not allowed until the red lights are cleared.',
            { lesson_id: publishLessonId, status: report.status, red_lights: reds }
          );
        }

        const now = new Date();
        // 幂等: 已发布的课重复 publish 不改动原 published_at (留住首次上架时间戳)。
        const alreadyPublished = lesson.published_at != null;
        if (!alreadyPublished) {
          await db.update(lessons).set({ published_at: now }).where(eq(lessons.id, publishLessonId));
        }

        // (件四, "无条件推荐三窝"之三) — 推荐前查状态, 与
        // close_lesson_loop 7/19 修口径一致: 发布不再无条件推两项
        // (record_post_lesson_evaluation / reflect_on_teaching), 各自查该
        // (pair,lesson) 是否已存在, 存在则从推荐里剔除。两项复用 lib/
        // lesson-closure-facts.ts 的判定, 与 grade_exercise / update_lesson
        // 同一套查询, 不再各自手写一份。
        const [hasEval, hasReflection] = await Promise.all([
          fetchHasPostLessonEvaluation(pairId, publishLessonId),
          fetchAnchoredReflectionExists(pairId, publishLessonId),
        ]);
        const publishNextActions = [
          ...(hasEval ? [] : ['record_post_lesson_evaluation']),
          ...(hasReflection ? [] : ['reflect_on_teaching']),
        ];

        return buildSuccessEnvelope({
          operation: 'publish_lesson',
          resource_id: publishLessonId,
          // α批四针 (2026-07-20) — 原先落 `/courses` (课程列表页, 不是这节
          // 课本身), 改成课页精确路由 (同 add_lesson 的 learner_url 形态,
          // apps/web/src/App.tsx 的 /courses/:courseId/lessons/:lessonId)。
          learner_url: `/courses/${lesson.course_id}/lessons/${publishLessonId}`,
          ...(publishNextActions.length > 0 ? { next_recommended_actions: publishNextActions } : {}),
          // 断点③闭环确认 — publish_lesson 是三断点里唯一"补一句
          // 就完整"的一环: 幂等重放行为本就对(首次 published_at 不
          // 被二次改写), 缺的只是回执里明说"学习者现在可见"这句确认, 呼应
          // add_lesson/update_lesson 草稿态提示的收尾。
          human_note:
            `Published lesson ${publishLessonId} — now visible to the learner (${statusLine(report)}` +
            (report.warning_count > 0 ? ` · ${report.warning_count} warning(s) routed to manual review` : '') +
            (alreadyPublished ? ' · already published, published_at unchanged' : '') +
            ')',
        });
      });
    }
    case 'add_document': {
      const idempotencyKey = args.idempotency_key as string | undefined;
      const contentMd = args.content_md as string;
      if (!contentMd || !contentMd.trim()) throw validationError('content_md is required');
      return runIdempotentMutation(pairId, 'add_document', idempotencyKey, args, async () => {
        const id = genId('doc');
        const now = new Date();
        const title = (args.title as string | undefined)?.trim() || deriveDocumentTitle(contentMd);
        // P1-e (concepts 链审计) — see assertValidDocumentSource's doc
        // comment above: unreachable today (source is hardcoded, not a
        // caller arg), kept as a guardrail against a future regression.
        const documentSource = 'mcp';
        assertValidDocumentSource(documentSource);
        await db.insert(documents).values({
          id,
          pair_id: pairId,
          title,
          content_md: contentMd,
          source: documentSource,
          created_at: now,
          updated_at: now,
        });
        return buildSuccessEnvelope({
          operation: 'add_document',
          resource_id: id,
          created_refs: { document_id: id },
          learner_url: `/documents/${id}`,
          human_note: `Created document ${id} — "${title}"`,
        });
      });
    }
    case 'update_document': {
      const idempotencyKey = args.idempotency_key as string | undefined;
      const documentId = args.document_id as string;
      if (!documentId) throw validationError('document_id is required');
      const patch: Record<string, unknown> = {};
      if (args.title !== undefined) patch.title = args.title as string;
      if (args.content_md !== undefined) patch.content_md = args.content_md as string;
      if (Object.keys(patch).length === 0) {
        throw validationError('At least one of title / content_md is required');
      }

      return runIdempotentMutation(pairId, 'update_document', idempotencyKey, args, async () => {
        const [current] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1);
        if (!current) throw notFoundError(`Document ${documentId} not found`, { document_id: documentId });

        const [updated] = await db
          .update(documents)
          .set({ ...patch, updated_at: new Date() })
          .where(eq(documents.id, documentId))
          .returning();

        let sweepNote = '';
        if (patch.content_md !== undefined) {
          const sweep = await sweepDocumentAnnotations(documentId);
          if (sweep.swept > 0) {
            sweepNote = ` · annotations re-swept: ${sweep.swept} checked, ${sweep.orphaned} orphaned`;
          }
        }

        return buildSuccessEnvelope({
          operation: 'update_document',
          resource_id: documentId,
          learner_url: `/documents/${documentId}`,
          human_note: `Document ${documentId} updated ("${updated?.title}")${sweepNote}`,
        });
      });
    }
    case 'add_concept': {
      const idempotencyKey = args.idempotency_key as string | undefined;
      // lesson_id reaches eq() (lethal as undefined); name is
      // NOT NULL values-only, validated for a precise error.
      const lessonId = requireStringArg(args, 'lesson_id');
      const conceptName = requireStringArg(args, 'name');
      // P1-a (concepts 链审计) — source_refs must be an array of SourceRef
      // objects, not a bare string/scalar array — see
      // validateOptionalSourceRefsArg's doc comment above for the shape gap
      // this closes.
      const conceptSourceRefs = validateOptionalSourceRefsArg(args, 'source_refs');
      return runIdempotentMutation(pairId, 'add_concept', idempotencyKey, args, async () => {
        const [lesson] = await db.select().from(lessons).where(eq(lessons.id, lessonId)).limit(1);
        if (!lesson) throw notFoundError(`Lesson ${lessonId} not found`, { lesson_id: lessonId });

        const id = genId('cpt');
        // Root fix (7/21 夜发包) — insert + lesson.concept_ids
        // append committed atomically. Without this, "课末概念清单"
        // (lesson.concept_ids) never gains this concept's id from this
        // direction — concepts has no reverse derivation like
        // courses.structure.lesson_ids/syncCourseLessonIds, so the count
        // silently undercounts every concept created through add_concept
        // (root cause of the EN production line's 120-flashcard deck→course
        // grouping break, backfilled separately — this is the recurrence fix).
        //
        // The append itself is a single containment-guarded UPDATE, not a
        // read (outer `lesson` row, fetched before this transaction opened)
        // + JS array-splice + blind write — the read-modify-write form would
        // race two concurrent add_concept calls against the same lesson (the
        // second commit's array literally overwrites the first's, dropping an
        // id with no error). `not (concept_ids ? id)` re-checks presence
        // against the current row inside the transaction at write time, so
        // the append is safe under concurrency even though `id` here is
        // always fresh (genId('cpt') can't already be in the array).
        await db.transaction(async (tx) => {
          await tx.insert(concepts).values({
            id,
            lesson_id: lessonId,
            course_id: lesson.course_id,
            name: conceptName,
            short_definition: (args.short_definition as string) ?? '',
            source_refs: conceptSourceRefs ?? [],
            flashcard_ids: [],
          });
          await tx.execute(sql`
            update lessons
            set concept_ids = concept_ids || ${JSON.stringify([id])}::jsonb
            where id = ${lessonId}
              and not (concept_ids ? ${id})
          `);
        });
        return buildSuccessEnvelope({
          operation: 'add_concept',
          resource_id: id,
          created_refs: { concept_id: id, lesson_id: lessonId },
          next_recommended_actions: ['add_flashcard'],
          human_note: `Created concept ${id}, appended to lesson ${lessonId}.concept_ids`,
        });
      });
    }
    case 'update_concept': {
      const idempotencyKey = args.idempotency_key as string | undefined;
      // concept_id reaches the update's where-eq() (lethal as undefined).
      const conceptId = requireStringArg(args, 'concept_id');
      // Audit note: lesson_id is immutable here — not in this
      // tool's inputSchema (additionalProperties: false, no lesson_id
      // property above) and never read from `args` below. A concept can't
      // be moved to a different lesson through this handler, so there's no
      // "move the lessons.concept_ids registration" case to handle. If
      // lesson_id ever becomes patchable here, it must mirror add_concept's
      // containment-guarded UPDATE on both ends: remove the concept id from
      // the old lesson's concept_ids and add it to the new lesson's.
      // P1-a/P1-b (concepts 链审计) — source_refs shape-checked same as
      // add_concept; flashcard_ids shape-checked same as add_exercise's
      // expected_concepts, with a dangling-id existence precheck below
      // (concepts.flashcard_ids has no reverse FK into flashcards, so a bad
      // id would otherwise sail straight into a jsonb column undetected).
      const patchSourceRefs = validateOptionalSourceRefsArg(args, 'source_refs');
      const patchFlashcardIds = validateOptionalStringArrayArg(args, 'flashcard_ids');
      const patch: Record<string, unknown> = {};
      if (args.name !== undefined) patch.name = args.name as string;
      if (args.short_definition !== undefined) patch.short_definition = args.short_definition as string;
      if (patchSourceRefs !== undefined) patch.source_refs = patchSourceRefs;
      if (patchFlashcardIds !== undefined) patch.flashcard_ids = patchFlashcardIds;
      if (Object.keys(patch).length === 0) {
        throw validationError(
          'At least one of name / short_definition / source_refs / flashcard_ids is required'
        );
      }
      return runIdempotentMutation(pairId, 'update_concept', idempotencyKey, args, async () => {
        if (patchFlashcardIds !== undefined) {
          await assertFlashcardIdsExist(patchFlashcardIds, 'flashcard_ids');
        }
        const [row] = await db
          .update(concepts)
          .set(patch)
          .where(eq(concepts.id, conceptId))
          .returning();
        if (!row) throw notFoundError(`Concept ${conceptId} not found`, { concept_id: conceptId });
        return buildSuccessEnvelope({
          operation: 'update_concept',
          resource_id: conceptId,
          human_note: `Concept ${conceptId} updated`,
        });
      });
    }
    case 'add_flashcard': {
      const idempotencyKey = args.idempotency_key as string | undefined;
      // deck_id/front/back are NOT NULL values-only (undefined →
      // SQL DEFAULT → not-null violation, no crash), validated for a precise
      // VALIDATION envelope instead of a raw PG error.
      const deckId = requireStringArg(args, 'deck_id');
      const cardFront = requireStringArg(args, 'front');
      const cardBack = requireStringArg(args, 'back');
      // tags must be an array, not a bare string (see the
      // validateOptionalStringArrayArg doc comment above for the renderer
      // crash this closes).
      const cardTags = validateOptionalStringArrayArg(args, 'tags');
      const conceptId = args.concept_id as string | undefined;
      return runIdempotentMutation(pairId, 'add_flashcard', idempotencyKey, args, async () => {
        let concept: { id: string; flashcard_ids: string[] } | undefined;
        if (conceptId !== undefined) {
          const [c] = await db
            .select({ id: concepts.id, flashcard_ids: concepts.flashcard_ids })
            .from(concepts)
            .where(eq(concepts.id, conceptId))
            .limit(1);
          if (!c) {
            throw validationError(
              `concept_id '${conceptId}' does not exist — use get_context to see the existing concept list, or omit this field` +
                ' (a flashcard is allowed to have no concept attached; concept_id is optional to begin with).',
              { field: 'concept_id' }
            );
          }
          concept = c;
        }
        const id = genId('fc');
        const now = new Date();
        // P1-b (concepts 链审计) — insert + concept.flashcard_ids reciprocal
        // write-back committed atomically. Without this, concept.flashcard_ids
        // never gains the new card's id from this direction (only
        // update_concept's explicit flashcard_ids patch ever touched it
        // before), leaving the concept→flashcard half of this two-way link
        // permanently empty for every card created through add_flashcard.
        await db.transaction(async (tx) => {
          await tx.insert(flashcards).values({
            id,
            pair_id: pairId,
            concept_id: conceptId ?? null,
            deck_id: deckId,
            front: cardFront,
            back: cardBack,
            tags: cardTags ?? [],
            source_refs: [],
            fsrs_state: newCardState(now),
            created_at: now,
            updated_at: now,
          });
          if (concept) {
            const existingFlashcardIds = concept.flashcard_ids ?? [];
            if (!existingFlashcardIds.includes(id)) {
              await tx
                .update(concepts)
                .set({ flashcard_ids: [...existingFlashcardIds, id] })
                .where(eq(concepts.id, conceptId!));
            }
          }
        });
        return buildSuccessEnvelope({
          operation: 'add_flashcard',
          resource_id: id,
          created_refs: { flashcard_id: id },
          human_note: `Created flashcard ${id}${concept ? ` · appended to concept ${conceptId}.flashcard_ids` : ''}`,
        });
      });
    }
    case 'update_flashcard': {
      // 改卡面的合法通道。此前 MCP 无此工具、REST PATCH 只放
      // paused/deck_id, 验尺抓到卡面问题后外测用户被迫裸写 DB。
      // 纯 patch 语义, 无 revision 快照 (update_concept 同判例); FSRS 调度
      // 状态 (fsrs_state/paused) 结构性不可达 — 见 lib/flashcard-update.ts
      // 头注。归属: WHERE (id, pair_id) 双键, 他 pair 的卡与不存在的卡同一个
      // NOT_FOUND, 不泄露存在性。
      const idempotencyKey = args.idempotency_key as string | undefined;
      // flashcard_id reaches the update's where-eq() (lethal as
      // undefined).
      const flashcardId = requireStringArg(args, 'flashcard_id');
      const contentPatch = buildFlashcardContentPatch(args);
      return runIdempotentMutation(pairId, 'update_flashcard', idempotencyKey, args, async () => {
        const { updated_fields } = await updateFlashcardContent(pairId, flashcardId, contentPatch);
        return buildSuccessEnvelope({
          operation: 'update_flashcard',
          resource_id: flashcardId,
          human_note:
            `Flashcard ${flashcardId} updated (${updated_fields.join(', ')}) — ` +
            'only the card content changed; the FSRS review schedule is untouched (scheduling/progress unchanged).',
          data: { updated_fields },
        });
      });
    }
    case 'add_mindmap_seed': {
      const idempotencyKey = args.idempotency_key as string | undefined;
      const targetPair = (args.pair_id as string | undefined) ?? pairId;
      const lessonId = args.lesson_id as string | undefined;
      const courseId = args.course_id as string | undefined;
      if ((lessonId && courseId) || (!lessonId && !courseId)) {
        throw validationError('Exactly one of lesson_id or course_id is required');
      }
      // ---- pair 归属校验 (2026-07-26): 越 pair 写入的封口 ----
      // 旧版把 args.pair_id 原样写进 mindmaps.owner_pair_id, 零校验 —— 填一个
      // 别人的真实 pair_id 就能往别人名下播种脑图; lesson_id/course_id 那两个
      // 锚点也只查了"存在", 没查"是不是当前 pair 的", 于是同一次写入里三个
      // 归属点(图的户口 / 课的归属 / 门的归属)可以各归各家。
      // 口径照 lib/grade-submission.ts 的既定范式: 写前一次校验, "不存在"与
      // "不属于当前 pair"同报一个 NOT_FOUND, 不泄露存在性。这里 pair_id 这一
      // 层不查 pairs 表 —— 与当前 pair 不符即报同一句 NOT_FOUND, 外部 pair 是
      // 真是假一律看不出来。
      if (targetPair !== pairId) {
        throw notFoundError(
          `Pair ${targetPair} not found — the id may not exist, or it isn't the current pair. A mindmap can only be seeded under the current pair.`,
          { field: 'pair_id', pair_id: targetPair }
        );
      }
      const mindmapTitle = requireStringArg(args, 'title');
      // Bench 案一: validate BEFORE the transaction — a naive
      // agent's free-formed graph JSON (nodes: {id,label}, links:
      // {source,target}) used to sail straight into agent_seed_snapshot/
      // content with zero shape checking; see validateMindmapContent's doc
      // comment above for the full incident.
      const content = validateMindmapContent(args.content);

      return runIdempotentMutation(pairId, 'add_mindmap_seed', idempotencyKey, args, async () => {
        const now = new Date();
        const mindmapId = genId('mm');
        const assocId = genId('mma');
        // Agent Surface Hardening 第一批 ("同病同治") —
        // the mindmap insert + its association insert used to be two
        // unguarded statements; a crash between them left an orphan mindmap
        // (GET /lessons/:id/mindmaps finds mindmaps only via association rows,
        // so an orphan is invisible/leaked, not just inconsistent). Both now
        // commit atomically.
        await db.transaction(async (tx) => {
          // 锚点的存在性 + 归属合并成一次 pair-scoped 查询 (lessons 本身不带
          // pair_id, 经 courses.pair_id 判归属 —— 同 reflect_on_teaching /
          // lesson-closure-facts 的 join 链)。查询搬进事务里跑, 与 grade-
          // submission 的"校验与写入同一事务"同款: 校验和两条 insert 之间没有
          // 别的事务能把这节课改嫁到别的 pair 名下。查不到即抛, 一行都还没写。
          if (lessonId) {
            const [lesson] = await tx
              .select({ id: lessons.id })
              .from(lessons)
              .innerJoin(courses, eq(lessons.course_id, courses.id))
              .where(and(eq(lessons.id, lessonId), eq(courses.pair_id, pairId)))
              .limit(1);
            if (!lesson) {
              throw notFoundError(
                `Lesson ${lessonId} not found — the id may not exist, may have been deleted, or may not belong to the current pair.`,
                { field: 'lesson_id', lesson_id: lessonId }
              );
            }
          } else {
            const [course] = await tx
              .select({ id: courses.id })
              .from(courses)
              .where(and(eq(courses.id, courseId!), eq(courses.pair_id, pairId)))
              .limit(1);
            if (!course) {
              throw notFoundError(
                `Course ${courseId} not found — the id may not exist, may have been deleted, or may not belong to the current pair.`,
                { field: 'course_id', course_id: courseId }
              );
            }
          }

          // Mirrors POST /mindmaps: agent_seed_snapshot defaults to content at
          // creation (routes/write.ts) — same here, no separate seed arg needed.
          await tx.insert(mindmaps).values({
            id: mindmapId,
            // 户口取校验过的当前 pair, 不取入参 —— 上面那道闸已经确认二者相等,
            // 这里写 pairId 是让"能写进 owner_pair_id 的只有当前 pair"成为读代码
            // 时一眼可见的事实, 而不是依赖上游变量没被改过。
            owner_pair_id: pairId,
            scope: lessonId ? 'lesson' : 'course',
            title: mindmapTitle,
            source: 'agent',
            agent_skill_used: (args.agent_skill_used as string) ?? null,
            agent_seed_snapshot: JSON.parse(JSON.stringify(content)),
            content,
            has_been_reset: false,
            created_at: now,
            updated_at: now,
          });
          // Mirrors POST /mindmaps/:id/associations.
          await tx.insert(mindmap_associations).values({
            id: assocId,
            mindmap_id: mindmapId,
            target_type: lessonId ? 'lesson' : 'course',
            target_id: (lessonId ?? courseId) as string,
            created_at: now,
          });
        });

        return buildSuccessEnvelope({
          operation: 'add_mindmap_seed',
          resource_id: mindmapId,
          created_refs: { mindmap_id: mindmapId, association_id: assocId },
          learner_url: '/mindmap',
          human_note: `Created mindmap ${mindmapId} + association ${assocId} → ${lessonId ? 'lesson' : 'course'} ${lessonId ?? courseId}`,
        });
      });
    }
    case 'update_mindmap_seed': {
      // "脑图有生无改" — add_mindmap_seed can
      // create but nothing let an agent go back and fix its own seed's
      // topology, so a bad first draft was permanent. Same validation as
      // add_mindmap_seed (mindmapValidationError's recipe-hint tail), plus
      // a pair-ownership + existence precheck and a source=agent gate — a
      // learner's own hand-grown map is theirs, not the agent's to rewrite,
      // and another pair's map is not even visible to this tool (归属闸在前,
      // 见下面 case 体里的头注)。
      const idempotencyKey = args.idempotency_key as string | undefined;
      const targetMindmapId = requireStringArg(args, 'mindmap_id');
      const newContent = validateMindmapContent(args.content);

      return runIdempotentMutation(pairId, 'update_mindmap_seed', idempotencyKey, args, async () => {
        // ---- pair 归属校验 (2026-07-26): 同族越 pair 写洞的封口 ----
        // 旧版只查存在性 + source=agent, 不查 owner_pair_id —— 拿到别人 pair
        // 的 mm_ id 就能改写别人的图, 而且 content 与 agent_seed_snapshot 一起
        // 被覆盖 (案底双写军规), 学习者 Clear & redo 也回不到原图。比
        // add_mindmap_seed 那个洞更疼: 那是往别人名下写新东西, 这是覆盖别人已
        // 有的东西且不可恢复。
        // 口径与 add_mindmap_seed 同一段: 写前一次 pair-scoped 查询, "不存在"
        // 与"不属于当前 pair"同报一个 NOT_FOUND, 不泄露存在性 (lib/grade-
        // submission.ts 的既定范式)。
        //
        // 两道闸的先后: 归属在前, source=agent 的 PERMISSION 在后 —— 不属于你
        // 的图, 连"它是不是 agent 播的种"都不该告诉你。反过来先判 source 会把
        // PERMISSION 与 NOT_FOUND 变成一对可区分的回答, 外 pair 的图的 source
        // 就被这台工具当探针读出来了。
        //
        // 校验与写入同事务 (与 add_mindmap_seed 同款): update 的 WHERE 在事务内
        // 再带一次 owner_pair_id, 校验到写入之间的竞态窗口也被兜住 —— 真发生
        // 的话 UPDATE 落空, 事务回滚, 与"从未调用过"等价。
        const now = new Date();
        const updated = await db.transaction(async (tx) => {
          const [current] = await tx
            .select({ source: mindmaps.source })
            .from(mindmaps)
            .where(and(eq(mindmaps.id, targetMindmapId), eq(mindmaps.owner_pair_id, pairId)))
            .limit(1);
          if (!current) {
            throw notFoundError(
              `Mindmap ${targetMindmapId} not found — the id may not exist, may have been deleted, or may not belong to the current pair.`,
              { field: 'mindmap_id', mindmap_id: targetMindmapId }
            );
          }
          if (current.source !== 'agent') {
            throw permissionError(
              `Mindmap ${targetMindmapId} has source='${current.source}', not 'agent' — only maps the agent ` +
                'itself seeded may be rewritten by update_mindmap_seed; a learner-grown map is not yours to edit.',
              { mindmap_id: targetMindmapId, source: current.source }
            );
          }

          // 案底军规: 双写 content + agent_seed_snapshot, 否则 Clear & redo
          // 会把学习者拉回这次修复之前的旧方言图。
          const [row] = await tx
            .update(mindmaps)
            .set({
              content: newContent,
              agent_seed_snapshot: JSON.parse(JSON.stringify(newContent)),
              updated_at: now,
            })
            .where(and(eq(mindmaps.id, targetMindmapId), eq(mindmaps.owner_pair_id, pairId)))
            .returning();
          return row;
        });
        // 只有校验之后、提交之前的竞态 (刚查完就被删/改归属) 才会走到这里 ——
        // 事务已回滚, 一个字都没改, 报同一个 NOT_FOUND (不泄露此前查到过的那份
        // 归属)。同 lib/grade-submission.ts 收尾。
        if (!updated) {
          throw notFoundError(
            `Mindmap ${targetMindmapId} not found — the id may not exist, may have been deleted, or may not belong to the current pair.`,
            { field: 'mindmap_id', mindmap_id: targetMindmapId }
          );
        }

        return buildSuccessEnvelope({
          operation: 'update_mindmap_seed',
          resource_id: targetMindmapId,
          learner_url: '/mindmap',
          human_note: `Mindmap ${targetMindmapId} content + agent_seed_snapshot re-seeded (updated_at ${updated?.updated_at?.toISOString()})`,
        });
      });
    }
    case 'add_exercise': {
      const idempotencyKey = args.idempotency_key as string | undefined;
      // all values-only NOT NULL (undefined → SQL DEFAULT →
      // not-null/FK violation, no crash), validated for precise errors.
      const exLessonId = requireStringArg(args, 'lesson_id');
      const exPrompt = requireStringArg(args, 'prompt');
      const exReferenceAnswer = requireStringArg(args, 'reference_answer');
      const exOrder = requireNumberArg(args, 'order');
      // expected_concepts must be an array of strings, same
      // shape-check as add_flashcard's tags (see the shared helper's doc
      // comment above).
      const exExpectedConcepts = validateOptionalStringArrayArg(args, 'expected_concepts');
      // 探针标签通道: lesson-prep 工作流要求探针题
      // 打 ["probe"] 标, 此前 schema (additionalProperties:false) 拒收 tags。
      // 与 add_flashcard.tags 同一把形状尺; 值不设白名单 ("probe" 是约定值,
      // 非封闭枚举)。存储列由迁移 0039 提供 (exercises.tags jsonb, 缺省 [])。
      const exTags = validateOptionalStringArrayArg(args, 'tags');
      return runIdempotentMutation(pairId, 'add_exercise', idempotencyKey, args, async () => {
        // lesson_id existence precheck. Without this, a bad
        // lesson_id sails into the insert below and trips exercises'
        // lesson_id FK constraint; tool-envelope.ts's classifyThrown maps
        // 23503 to NOT_FOUND since the fix (6813c71) — no longer the
        // RETRYABLE misclassification docs/recipes/first-contract-and-lesson.md
        // used to warn about — but that's still "fail after a write attempt,
        // classify from a raw PG error". Precheck it here instead so the
        // caller gets a VALIDATION with a direct pointer before any write is
        // attempted.
        const [lesson] = await db.select().from(lessons).where(eq(lessons.id, exLessonId)).limit(1);
        if (!lesson) {
          throw validationError(
            `lesson_id '${exLessonId}' does not exist — check the real id returned by the earlier add_lesson/create_course call; ` +
              "don't guess-assemble an id; use get_context to see the current course structure.",
            { field: 'lesson_id' }
          );
        }
        if (exExpectedConcepts !== undefined && exExpectedConcepts.length > 0) {
          const foundRows = await db
            .select({ id: concepts.id })
            .from(concepts)
            .where(inArray(concepts.id, exExpectedConcepts));
          const foundIds = new Set(foundRows.map((r) => r.id));
          const dangling = exExpectedConcepts.filter((cid) => !foundIds.has(cid));
          if (dangling.length > 0) {
            throw validationError(
              `expected_concepts has ${dangling.length} concept id(s) that don't exist: ` +
                `${JSON.stringify(dangling)} — use get_context to see the existing concept list, or create it first with ` +
                'add_concept before referencing it.',
              { field: 'expected_concepts', dangling_ids: dangling }
            );
          }
        }

        const id = genId('ex');
        const now = new Date();
        await db.insert(exercises).values({
          id,
          lesson_id: exLessonId,
          order: exOrder,
          prompt: exPrompt,
          reference_answer: exReferenceAnswer,
          expected_concepts: exExpectedConcepts ?? [],
          // 未传时不写这一列 (交给 0039 的列缺省 '[]'), 让
          // insert 语句在迁移落地前的库上也照常工作; 传了才点名写入。
          ...(exTags !== undefined ? { tags: exTags } : {}),
          agent_skill_used: (args.agent_skill_used as string) ?? 'teach-general',
          created_at: now,
          updated_at: now,
        });
        return buildSuccessEnvelope({
          operation: 'add_exercise',
          resource_id: id,
          created_refs: { exercise_id: id },
          human_note: `Created exercise ${id}${exTags && exTags.length > 0 ? ` (tags: ${exTags.join(', ')})` : ''}`,
        });
      });
    }
    case 'add_simulated_quiz': {
      const idempotencyKey = args.idempotency_key as string | undefined;
      const courseId = requireStringArg(args, 'course_id');
      // Bench 案二: validateSimulatedQuestions replaces the
      // old choice-type-only check — it now also rejects the naive-agent
      // {prompt,options,correct_index} shape that used to sail through
      // untouched because stem/reference_answer were never checked when
      // question_type was omitted. See lib/validate-simulated-quiz.ts's
      // header comment for that incident and the separator fix on top of it.
      const questions = validateSimulatedQuestions(args.questions);
      return runIdempotentMutation(pairId, 'add_simulated_quiz', idempotencyKey, args, async () => {
        // course_id existence precheck (description above has
        // long claimed "course_id 必须存在" but nothing ever checked it —
        // same 裸奔 gap as add_lesson's course_id before this batch).
        const [course] = await db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
        if (!course) {
          throw validationError(
            `course_id '${courseId}' does not exist — check the real id returned by create_course, or use get_context to see existing courses.`,
            { field: 'course_id' }
          );
        }

        const id = genId('sq');
        const now = new Date();
        const questionsWithIds = questions.map((q) => ({ ...q, id: q.id || genId('sqq') }));
        await db.insert(simulated_quizzes).values({
          id,
          pair_id: pairId,
          course_id: courseId,
          agent_skill_used: (args.agent_skill_used as string) ?? 'teach-general',
          questions: questionsWithIds,
          created_at: now,
        });
        return buildSuccessEnvelope({
          operation: 'add_simulated_quiz',
          resource_id: id,
          created_refs: { simulated_quiz_id: id },
          human_note: `Created simulated quiz ${id} (${questions.length} questions)`,
        });
      });
    }
    case 'verify_prep': {
      const lessonId = args.lesson_id as string | undefined;
      const courseId = args.course_id as string | undefined;
      // 默认紧凑 (公理②), verbose:true 走旧版全表 (公理③的显式
      // 取回路径; 全表分支与压缩前逐字同形)。
      const verbose = args.verbose === true;
      if ((lessonId && courseId) || (!lessonId && !courseId)) {
        throw validationError('Exactly one of lesson_id or course_id is required');
      }

      if (lessonId) {
        const report = await validateLesson(queryClient, lessonId);
        if (!report) throw notFoundError(`Lesson ${lessonId} not found`, { lesson_id: lessonId });
        // 断点④ — validateLesson/LessonReport (validate-prep-core
        // 的纯检查逻辑) 天然不知道 published_at, 也不该知道; 这里在结果装配
        // 处补一次独立读取, 与 publish_lesson 用同一张 lessons 表同一列。
        const [lessonMeta] = await db
          .select({ published_at: lessons.published_at })
          .from(lessons)
          .where(eq(lessons.id, lessonId))
          .limit(1);
        const publishedAt = lessonMeta?.published_at ?? null;
        const publishNote = buildPublishStatusNote(report.status, publishedAt);
        return success({
          operation: 'verify_prep',
          resource_id: lessonId,
          human_note:
            `verify_prep ${lessonId}: ${statusLine(report)} (${report.error_count} errors, ` +
            `${report.warning_count} warnings)${publishNote}` +
            (verbose ? '' : ' · compact report — pass verbose:true for the full table'),
          data: {
            ...(verbose ? report : compactLessonReport(report)),
            published_at: publishedAt,
            publish_status: publishStatusLabel(publishedAt),
          },
        });
      }

      const lessonIds = await resolveCourseLessonIds(queryClient, courseId!);
      if (lessonIds === null) throw notFoundError(`Course ${courseId} not found`, { course_id: courseId });
      if (lessonIds.length === 0) {
        throw notFoundError(`Course ${courseId} has no lessons under it — nothing to self-check`, { course_id: courseId });
      }

      const reports: LessonReport[] = [];
      for (const id of lessonIds) {
        const r = await validateLesson(queryClient, id);
        if (r) reports.push(r);
      }
      // 断点④ 的 course 级同款 — 一门课里任何一节"验尺过但没发布"
      // 都该在汇总里露出来, 不止单课查询有这句话。按 lesson_id 建个
      // published_at 映射, 再把每节课的 publish_status 缝进汇总载荷。
      const publishedRows = lessonIds.length
        ? await db
            .select({ id: lessons.id, published_at: lessons.published_at })
            .from(lessons)
            .where(inArray(lessons.id, lessonIds))
        : [];
      const publishedAtById = new Map(publishedRows.map((r) => [r.id, r.published_at ?? null]));
      const passedButUnpublishedCount = reports.filter(
        (r) =>
          (r.status === 'PASS' || r.status === 'PASS_WITH_WARNINGS') &&
          (publishedAtById.get(r.lesson_id) ?? null) == null
      ).length;
      const payload = {
        ...buildCourseSummaryPayload(courseId!, reports),
        lessons: reports.map((r) => {
          const publishedAt = publishedAtById.get(r.lesson_id) ?? null;
          // course 级同款: 默认逐课紧凑, verbose:true 逐课全表。
          return {
            ...(verbose ? r : compactLessonReport(r)),
            published_at: publishedAt,
            publish_status: publishStatusLabel(publishedAt),
          };
        }),
      };
      const failCount = reports.filter((r) => r.status === 'FAIL').length;
      return success({
        operation: 'verify_prep',
        resource_id: courseId,
        human_note:
          `verify_prep ${courseId}: ${payload.lesson_count} lesson(s) · overall ${payload.overall_status}` +
          (anyFailed(reports) ? ` · ${failCount} lesson(s) FAIL` : '') +
          (passedButUnpublishedCount > 0
            ? ` · ${passedButUnpublishedCount} lesson(s) passed verification but not yet published — next: publish_lesson`
            : '') +
          (verbose ? '' : ' · compact report — pass verbose:true for the full table'),
        data: payload,
      });
    }
    case 'grade_exercise': {
      const idempotencyKey = args.idempotency_key as string | undefined;
      // submission_id reaches the update's where-eq() (lethal
      // as undefined); feedback is a schema-required string.
      const sid = requireStringArg(args, 'submission_id');
      const gradeFeedback = requireStringArg(args, 'feedback');
      // score is documented as "0..1, 软评分" in the
      // inputSchema but was never runtime-checked: an agent that means "85%"
      // and passes score:85 used to land untouched in agent_score, then
      // render as "8500%" wherever the UI multiplies by 100 for display. Only
      // validate when present — score is optional.
      let gradeScore: number | undefined;
      if (args.score !== undefined) {
        if (typeof args.score !== 'number' || !Number.isFinite(args.score) || args.score < 0 || args.score > 1) {
          throw validationError(
            `score must be a number in the closed range 0..1 — got ${JSON.stringify(args.score)}. ` +
              'score is a soft rating in 0..1 — for 85%, write 0.85, not 85.',
            { field: 'score' }
          );
        }
        gradeScore = args.score;
      }
      const regradeFlag = args.regrade as boolean | undefined;
      return runIdempotentMutation(pairId, 'grade_exercise', idempotencyKey, args, async () => {
        // P0 修复 (回归考 v2 核心 finding, docs/LS-REGRESSION-EXAM-V2-
        // 2026-07-24.md): 归属校验 (submission → exercise → lesson →
        // course.pair_id) 与重批持证判定、update + 事件追加的原子事务全部
        // 收进 lib/grade-submission.ts 的 gradeSubmission() —— 外 pair /
        // 不存在在任何写入之前就被同一个 NOT_FOUND 挡下 (归属纪律头注:
        // 不泄露存在性), 不再可能出现"先写后错"。
        const graded = await gradeSubmission(pairId, sid, {
          feedback: gradeFeedback,
          score: gradeScore,
          regrade: regradeFlag,
        });
        const row = graded.row;

        // (件四, "无条件推荐三窝"之一) — 推荐前查状态: 该 (pair,
        // lesson) 若已有 post_lesson_evaluation, 不再无条件重推
        // record_post_lesson_evaluation (与 close_lesson_loop 7/19 修口径
        // 一致)。lesson_id/expected_concepts 已随 gradeSubmission 的归属
        // 查询一并拿到, 不加第二次查询。
        const alreadyEvaluated = await fetchHasPostLessonEvaluation(pairId, graded.lesson_id);

        // 判错递笔 — 纯信息性的顺手指路, 不是新判决、不改判、不带
        // severity: 这份提交的分数落进"判错"区间 (isIncorrectVerdict, 阈值
        // 与错题卡事实行共用一处定义) 且这道题挂了概念时, 把概念链
        // (exercise.expected_concepts, gradeSubmission 已经白拿) 原样递给
        // 调用方, 配一句"配不配张针对性闪卡由你裁量"——不进
        // next_recommended_actions (那是"该做"的清单, 这是"可以考虑"的清单,
        // 声纹条款口吻: 零强制语言)。score 缺失 = 没有判断依据, 不递笔。
        const isIncorrect = isIncorrectVerdict(gradeScore);
        const nudgeConceptIds = isIncorrect ? graded.expected_concepts : [];
        const gradedVerb = graded.regraded
          ? `Regraded ${sid} (改判, 旧判决摘要已入 exercise.graded 事件)`
          : `Graded ${sid}`;
        const humanNote =
          nudgeConceptIds.length > 0
            ? `${gradedVerb} · 判错 (score ${gradeScore}) · concept(s) ${nudgeConceptIds.join(', ')} 已解出 — ` +
              '配不配一张针对性闪卡 (add_flashcard + 这个 concept_id) 由你裁量, 非强制。'
            : gradedVerb;

        return buildSuccessEnvelope({
          operation: 'grade_exercise',
          resource_id: sid,
          created_refs: { submission_id: sid },
          next_recommended_actions: alreadyEvaluated ? [] : ['record_post_lesson_evaluation'],
          ...(nudgeConceptIds.length > 0 ? { concept_refs: nudgeConceptIds } : {}),
          // 随行回执补第一写: 批改是关课判决链的
          // 头一笔 (closure 四检之首"有提交未批改则拒关"消费的就是它), recipe
          // 承诺 closure_progress 骑行全部收尾写工具, 此前独漏这里。与
          // record_post_lesson_evaluation / reflect_on_teaching /
          // live_session_complete 同款: 写后现算, 默认 recentCloseSkip=0
          // (本课此刻尚未关, 同 eval 侧口径, 只有 close_lesson_loop 自己要
          // 跳过刚写的关课行)。lesson 锚此刻已经过归属校验 (gradeSubmission
          // 写入前就确认了 pair 归属), 这里现算不会再因为归属不符而抛错。
          closure_progress: toClosureProgress(await computeLessonClosureProgress(pairId, graded.lesson_id)),
          human_note: humanNote,
        });
      });
    }
    case 'record_post_lesson_evaluation': {
      const idempotencyKey = args.idempotency_key as string | undefined;
      // lesson_id is NOT NULL FK values-only (undefined → SQL
      // DEFAULT → not-null violation, no crash), validated for a precise error.
      const evalLessonId = requireStringArg(args, 'lesson_id');
      // 迁移 0030 改名: session_id → learning_session_id. 不留 deprecated 别名
      // (会助长混乱) —— 老名字撞上来直接报错指路, 不是静默丢弃这个引用。
      if (args.session_id !== undefined && args.learning_session_id === undefined) {
        throw validationError(
          'session_id was renamed to learning_session_id (migration 0030: name now matches reality — the FK always pointed at learning_sessions) — ' +
            'resend with the new name; the old name is no longer accepted.',
          { field: 'session_id' }
        );
      }
      const evalLearningSessionId = (args.learning_session_id as string | undefined) ?? null;
      // 空评估拒收 — 业务规则: 至少一个实质字段非默认值。learning_session_id
      // 不算(它是引用, 不是事实); 字段清单取自本工具 inputSchema 的全部数据字段
      // (concepts_touched/flashcards_reviewed_count/flashcards_rating_distribution/
      // exercises_submitted_count/live_turns_count/duration_minutes/agent_observation)。
      const evalConceptsTouched = (args.concepts_touched as string[] | undefined) ?? [];
      const evalFlashcardsReviewedCount = (args.flashcards_reviewed_count as number | undefined) ?? 0;
      const evalRating = (args.flashcards_rating_distribution as Record<
        'Again' | 'Hard' | 'Good' | 'Easy',
        number
      > | undefined) ?? { Again: 0, Hard: 0, Good: 0, Easy: 0 };
      const evalRatingHasSignal = Object.values(evalRating).some((n) => typeof n === 'number' && n > 0);
      const evalExercisesSubmittedCount = (args.exercises_submitted_count as number | undefined) ?? 0;
      const evalLiveTurnsCount = (args.live_turns_count as number | undefined) ?? 0;
      const evalDurationMinutes = (args.duration_minutes as number | undefined) ?? 0;
      const evalAgentObservation = ((args.agent_observation as string | undefined) ?? '').trim();
      // 三通道制 (迁移 0044): learner_note 人话 / evidence_refs
      // 机器引用, 皆可选。learner_note 算实质字段 (它是内容, 不是引用)。
      const evalLearnerNote =
        typeof args.learner_note === 'string' && args.learner_note.trim() ? args.learner_note.trim() : null;
      const evalEvidenceRefs = validateOptionalStringArrayArg(args, 'evidence_refs') ?? null;
      const hasSubstantiveField =
        evalConceptsTouched.length > 0 ||
        evalFlashcardsReviewedCount > 0 ||
        evalRatingHasSignal ||
        evalExercisesSubmittedCount > 0 ||
        evalLiveTurnsCount > 0 ||
        evalDurationMinutes > 0 ||
        evalAgentObservation !== '' ||
        evalLearnerNote !== null;
      if (!hasSubstantiveField) {
        throw validationError(
          'An empty evaluation pollutes the learner brief — provide at least one fact: ' +
            'concepts_touched / flashcards_reviewed_count / flashcards_rating_distribution / ' +
            'exercises_submitted_count / live_turns_count / duration_minutes / agent_observation ' +
            'cannot all be left blank/0.'
        );
      }
      return runIdempotentMutation(pairId, 'record_post_lesson_evaluation', idempotencyKey, args, async () => {
        const rating = evalRating;

        // evidence_refs 硬闸 (与任务一③同款 validator): 逐 id 验
        // 存在+同 pair 归属, 幽灵引用 VALIDATION 拒。
        if (evalEvidenceRefs?.length) {
          await assertEvidenceRefs(pairId, evalEvidenceRefs);
        }

        // (pair_id, lesson_id) 唯一索引 (迁移 0030): 一课一份总评——第二次
        // 对同一课调用是修订, update-in-place, 不插新行。
        const [existing] = await db
          .select({ id: post_lesson_evaluations.id })
          .from(post_lesson_evaluations)
          .where(
            and(eq(post_lesson_evaluations.pair_id, pairId), eq(post_lesson_evaluations.lesson_id, evalLessonId))
          )
          .limit(1);

        if (existing) {
          await db
            .update(post_lesson_evaluations)
            .set({
              learning_session_id: evalLearningSessionId,
              concepts_touched: evalConceptsTouched,
              flashcards_reviewed_count: evalFlashcardsReviewedCount,
              flashcards_rating_distribution: rating,
              exercises_submitted_count: evalExercisesSubmittedCount,
              live_turns_count: evalLiveTurnsCount,
              duration_minutes: evalDurationMinutes,
              agent_observation: evalAgentObservation,
              learner_note: evalLearnerNote,
              evidence_refs: evalEvidenceRefs,
            })
            .where(eq(post_lesson_evaluations.id, existing.id));
          // 随行回执 (红队第六轮针二) — lesson_id 是本工具必填参数, 恒有锚。
          return buildSuccessEnvelope({
            operation: 'record_post_lesson_evaluation',
            resource_id: existing.id,
            created_refs: { evaluation_id: existing.id, lesson_id: evalLessonId },
            next_recommended_actions: ['reflect_on_teaching'],
            closure_progress: toClosureProgress(await computeLessonClosureProgress(pairId, evalLessonId)),
            human_note: `Updated evaluation ${existing.id} for lesson ${evalLessonId} (one summary evaluation per lesson; this call is an update-in-place revision).`,
          });
        }

        const id = genId('ple');
        await db.insert(post_lesson_evaluations).values({
          id,
          pair_id: pairId,
          lesson_id: evalLessonId,
          learning_session_id: evalLearningSessionId,
          concepts_touched: evalConceptsTouched,
          flashcards_reviewed_count: evalFlashcardsReviewedCount,
          flashcards_rating_distribution: rating,
          exercises_submitted_count: evalExercisesSubmittedCount,
          live_turns_count: evalLiveTurnsCount,
          duration_minutes: evalDurationMinutes,
          agent_observation: evalAgentObservation,
          learner_note: evalLearnerNote,
          evidence_refs: evalEvidenceRefs,
        });
        return buildSuccessEnvelope({
          operation: 'record_post_lesson_evaluation',
          resource_id: id,
          created_refs: { evaluation_id: id, lesson_id: evalLessonId },
          next_recommended_actions: ['reflect_on_teaching'],
          closure_progress: toClosureProgress(await computeLessonClosureProgress(pairId, evalLessonId)),
          human_note: `Recorded evaluation ${id} for lesson ${evalLessonId}`,
        });
      });
    }
    // 迁移 0030 (设计稿 §9.1/9.2): 一场 live_session 一份现场评估, 独立于课级总评
    // (post_lesson_evaluations) —— 一课可能横跨多场 live session, 每场各自的
    // 现场观察不该被课级总评摊平掉。
    case 'record_live_evaluation': {
      const idempotencyKey = args.idempotency_key as string | undefined;
      const liveSessionId = requireStringArg(args, 'live_session_id');
      const liveObservation = requireStringArg(args, 'agent_observation').trim();
      if (!liveObservation) {
        throw validationError('agent_observation is required (non-empty).', { field: 'agent_observation' });
      }
      const liveConceptsTouched = validateOptionalStringArrayArg(args, 'concepts_touched') ?? [];
      const liveTurnsCount = typeof args.live_turns_count === 'number' ? args.live_turns_count : null;
      const liveDurationMinutes = typeof args.duration_minutes === 'number' ? args.duration_minutes : null;
      // 三通道制 (迁移 0044): learner_note 人话 / evidence_refs
      // 机器引用, 皆可选; agent_observation 定位为教师内账。
      const liveLearnerNote =
        typeof args.learner_note === 'string' && args.learner_note.trim() ? args.learner_note.trim() : null;
      const liveEvidenceRefs = validateOptionalStringArrayArg(args, 'evidence_refs') ?? null;

      return runIdempotentMutation(pairId, 'record_live_evaluation', idempotencyKey, args, async () => {
        const [session] = await db
          .select()
          .from(live_sessions)
          .where(eq(live_sessions.id, liveSessionId))
          .limit(1);
        if (!session) throw notFoundError(`Live session ${liveSessionId} not found`, { live_session_id: liveSessionId });
        if (session.pair_id !== pairId) {
          throw notFoundError(`Live session ${liveSessionId} not found for this pair`, {
            live_session_id: liveSessionId,
          });
        }
        if (session.status !== 'completed') {
          throw conflictError(
            `Live session ${liveSessionId} is not yet completed (current status ${session.status}) — call live_session_complete to close it out first, then write the live evaluation.`,
            { live_session_id: liveSessionId, status: session.status }
          );
        }

        // 随行回执 (红队第六轮针二) — 场评经 live_session→context_id 取
        // lesson 锚: 只有 context_type='lesson' 时这场 Live 才挂着一节课
        // (flashcard/trial/mindmap/highlight 四种上下文没有 closure_progress
        // 可言, 字段整体不出现)。
        const liveLessonId = session.context_type === 'lesson' ? session.context_id : undefined;

        // 一场一评 (live_session_id 唯一索引) — 撞了就幂等返回既有行, 不二次
        // 写入、不覆盖。
        const [existing] = await db
          .select()
          .from(live_session_evaluations)
          .where(eq(live_session_evaluations.live_session_id, liveSessionId))
          .limit(1);
        if (existing) {
          return buildSuccessEnvelope({
            operation: 'record_live_evaluation',
            resource_id: existing.id,
            created_refs: { evaluation_id: existing.id, live_session_id: liveSessionId },
            ...(liveLessonId
              ? { closure_progress: toClosureProgress(await computeLessonClosureProgress(pairId, liveLessonId)) }
              : {}),
            human_note: `Live session ${liveSessionId} already has an evaluation (${existing.id}) — one evaluation per session, returned as-is, not written twice.`,
          });
        }

        // evidence_refs 硬闸 (与任务一③同款 validator): 逐 id 验
        // 存在+同 pair 归属, 幽灵引用 VALIDATION 拒。
        if (liveEvidenceRefs?.length) {
          await assertEvidenceRefs(pairId, liveEvidenceRefs);
        }
        const id = genId('lse');
        await db.insert(live_session_evaluations).values({
          id,
          pair_id: pairId,
          live_session_id: liveSessionId,
          concepts_touched: liveConceptsTouched,
          live_turns_count: liveTurnsCount,
          duration_minutes: liveDurationMinutes,
          agent_observation: liveObservation,
          learner_note: liveLearnerNote,
          evidence_refs: liveEvidenceRefs,
        });
        return buildSuccessEnvelope({
          operation: 'record_live_evaluation',
          resource_id: id,
          created_refs: { evaluation_id: id, live_session_id: liveSessionId },
          ...(liveLessonId
            ? { closure_progress: toClosureProgress(await computeLessonClosureProgress(pairId, liveLessonId)) }
            : {}),
          human_note: `Recorded live evaluation ${id} for session ${liveSessionId}`,
        });
      });
    }
    case 'record_learner_hypothesis': {
      const idempotencyKey = args.idempotency_key as string | undefined;

      // ---- 生命周期动作分支 (假设生命周期立法): hypothesis_id + action 成对
      // 出现时走既有行的 reinforce/revise/retire, 纯判定在
      // lib/hypothesis-lifecycle.ts (planHypothesisAction), 这里只做取行 +
      // 应用补丁。主权层级 (学习者判决压倒一切) 由纯核心拒绝, 拒绝原样上抛。
      const hypActionRaw = args.action as string | undefined;
      const hypTargetId = args.hypothesis_id as string | undefined;
      if ((hypActionRaw === undefined) !== (hypTargetId === undefined)) {
        throw validationError(
          'hypothesis_id and action appear as a pair: a lifecycle action (reinforce/revise/retire) requires both; ' +
            "creating a new hypothesis requires neither — providing only one asks the server to guess the other half, and it won't."
        );
      }
      if (hypActionRaw !== undefined && hypTargetId !== undefined) {
        if (!isHypothesisAction(hypActionRaw)) {
          throw validationError(
            `action must be one of ${HYPOTHESIS_ACTIONS.join('/')}, got ${JSON.stringify(hypActionRaw)}.`
          );
        }
        const hypAction = hypActionRaw;
        return runIdempotentMutation(pairId, 'record_learner_hypothesis', idempotencyKey, args, async () => {
          const [target] = await db
            .select()
            .from(learner_hypotheses)
            .where(and(eq(learner_hypotheses.id, hypTargetId), eq(learner_hypotheses.pair_id, pairId)))
            .limit(1);
          if (!target) {
            throw notFoundError(
              `Hypothesis ${hypTargetId} does not exist or does not belong to the current pair — use get_learner_brief / ` +
                `pair://teacher/hypotheses to read back a real id and try again.`
            );
          }
          // revise 写新文本 (同 domain 的新行) — 与创建路径同一道观察禁区闸门。
          if (hypAction === 'revise' && (await isObservationForbidden(pairId, target.domain))) {
            return buildSuccessEnvelope({
              operation: 'record_learner_hypothesis',
              next_recommended_actions: [],
              human_note: `Not revised — "${target.domain}" is on this learner's forbidden-observations list.`,
            });
          }
          // ③ 证据归属硬闸: 附带的 evidence_event_ids 逐个必须是本 pair
          // 的真实 session_event (批量一查); 含无效 id → VALIDATION 列坏 id。
          await assertSessionEventEvidence(pairId, (args.evidence_event_ids as string[] | undefined) ?? []);
          const now = new Date();
          const plan = planHypothesisAction(
            target,
            hypAction,
            {
              evidence_event_ids: args.evidence_event_ids as string[] | undefined,
              observation: args.observation as string | undefined,
              confidence: args.confidence as number | undefined,
            },
            now
          );
          if (plan.kind === 'refused') {
            throw validationError(plan.message);
          }
          if (plan.kind === 'patch') {
            await db
              .update(learner_hypotheses)
              .set(plan.patch)
              .where(eq(learner_hypotheses.id, target.id));
            // ① 空证据不刷时间戳: 无证据的 reinforce 照常落 updated_at
            // 痕迹, 但 last_evidence_at 不动——回执明说本次未计入喂养。
            const reinforceNote = plan.fed
              ? `Reinforced hypothesis ${target.id} (last_evidence_at → now)`
              : `Reinforced hypothesis ${target.id} — no evidence_event_ids attached this time, not counted as feeding ` +
                '(last_evidence_at unchanged; the lifecycle only feeds on real evidence).';
            return buildSuccessEnvelope({
              operation: 'record_learner_hypothesis',
              resource_id: target.id,
              created_refs: { hypothesis_id: target.id },
              human_note:
                hypAction === 'reinforce'
                  ? reinforceNote
                  : `Retired hypothesis ${target.id} (status → expired; the learner-verdict channel is unaffected)`,
            });
          }
          // supersede (revise): 旧行 expired 留痕即历史, 新行承接在场状态。
          const newId = genId('hyp');
          await db
            .update(learner_hypotheses)
            .set(plan.oldPatch)
            .where(eq(learner_hypotheses.id, target.id));
          await db.insert(learner_hypotheses).values({
            id: newId,
            pair_id: pairId,
            domain: plan.newRow.domain,
            observation: plan.newRow.observation,
            evidence_event_ids: plan.newRow.evidence_event_ids,
            counterevidence_event_ids: [],
            confidence: plan.newRow.confidence,
            status: plan.newRow.status,
            written_by_agent_id: 'mcp',
            from_session_id: null,
            user_approved: null,
            user_note: null,
            last_verified_at: null,
            last_evidence_at: plan.newRow.last_evidence_at,
            allowed_for_teaching: true,
            created_at: now,
            updated_at: now,
          });
          return buildSuccessEnvelope({
            operation: 'record_learner_hypothesis',
            resource_id: newId,
            created_refs: { hypothesis_id: newId, superseded_hypothesis_id: target.id },
            human_note:
              `Revised hypothesis: ${target.id} superseded by ${newId}` +
              (plan.fed
                ? ''
                : ' — no evidence_event_ids attached this time, not counted as feeding (the new row inherits the old row\'s last_evidence_at).'),
          });
        });
      }

      // ---- 创建路径 (原样) ----
      // domain/observation are NOT NULL values-only; confidence
      // NOT NULL double. All undefined-safe at the DB layer (SQL DEFAULT →
      // not-null violation) but validated for precise errors. domain also
      // feeds isObservationForbidden (an includes() check, undefined-safe).
      const domain = requireStringArg(args, 'domain');
      const hypObservation = requireStringArg(args, 'observation');
      const hypConfidence = requireNumberArg(args, 'confidence');
      // 批0 gate (LEARNER-MODEL-BRIEF §4 军规 3) — 命中禁区直接不写入, 不是
      // 写入后隐藏. This is the pre-existing "画像类采集" write path (the
      // domain-tagged hypothesis pen) — every profile write batch 1 adds
      // must go through the same gate (see routes/write.ts's confidence
      // capture). Deliberately NOT run through runIdempotentMutation — this
      // branch never writes, so there's nothing whose replay needs caching.
      if (await isObservationForbidden(pairId, domain)) {
        return success({
          operation: 'record_learner_hypothesis',
          next_recommended_actions: [],
          human_note: `Not recorded — "${domain}" is on this learner's forbidden-observations list.`,
        });
      }
      return runIdempotentMutation(pairId, 'record_learner_hypothesis', idempotencyKey, args, async () => {
        const createEvidenceIds = (args.evidence_event_ids as string[] | undefined) ?? [];
        // ③ 证据归属硬闸 — 同生命周期分支: 填了就必须真实且属本 pair。
        await assertSessionEventEvidence(pairId, createEvidenceIds);
        const id = genId('hyp');
        const now = new Date();
        await db.insert(learner_hypotheses).values({
          id,
          pair_id: pairId,
          domain,
          observation: hypObservation,
          evidence_event_ids: createEvidenceIds,
          counterevidence_event_ids: [],
          confidence: hypConfidence,
          status: 'tentative',
          written_by_agent_id: 'mcp',
          from_session_id: null,
          user_approved: null,
          user_note: null,
          last_verified_at: null,
          // 假设生命周期 (0041): 带证据出生 = 第一次喂养; 空证据出生时这个
          // 时刻只是出生时刻 (= created_at, 与 0041 回填口径同一), 不是喂养
          // ——① 空证据不刷时间戳, 回执明说。
          last_evidence_at: now,
          allowed_for_teaching: true,
          created_at: now,
          updated_at: now,
        });
        return buildSuccessEnvelope({
          operation: 'record_learner_hypothesis',
          resource_id: id,
          created_refs: { hypothesis_id: id },
          human_note:
            createEvidenceIds.length > 0
              ? `Recorded hypothesis ${id}`
              : `Recorded hypothesis ${id} — no evidence_event_ids attached this time, not counted as feeding ` +
                "(the brief's staleness clock starts at birth; use action=reinforce with real evidence to renew).",
        });
      });
    }
    case 'reflect_on_teaching': {
      const idempotencyKey = args.idempotency_key as string | undefined;
      // method/rationale/next_action are NOT NULL values-only
      // (undefined → SQL DEFAULT → not-null violation, no crash), validated
      // for precise errors.
      const reflMethod = requireStringArg(args, 'method');
      const reflRationale = requireStringArg(args, 'rationale');
      const reflNextAction = requireStringArg(args, 'next_action');
      // ---- §1/§2: primary_attribution — required, closed enum, no free text.
      const primaryAttribution = args.primary_attribution as PrimaryAttribution | undefined;
      if (!primaryAttribution || !VALID_ATTRIBUTIONS.includes(primaryAttribution)) {
        throw validationError(
          `primary_attribution is required and must be one of ${VALID_ATTRIBUTIONS.join(', ')} — ` +
            `got ${JSON.stringify(args.primary_attribution)}. §1: pick one, no free text.`
        );
      }

      // ---- secondary_attribution — optional, at most one, must differ.
      const secondaryAttribution = args.secondary_attribution as PrimaryAttribution | undefined;
      if (secondaryAttribution !== undefined) {
        if (!VALID_ATTRIBUTIONS.includes(secondaryAttribution)) {
          throw validationError(
            `secondary_attribution must be one of ${VALID_ATTRIBUTIONS.join(', ')} or omitted — ` +
              `got ${JSON.stringify(args.secondary_attribution)}.`
          );
        }
        if (secondaryAttribution === primaryAttribution) {
          throw validationError(
            'secondary_attribution must differ from primary_attribution — picking the same one twice ' +
              'is not a second read, it is the first one restated.'
          );
        }
      }

      // ---- evidence / counterfactual — required, non-empty.
      const evidence = (args.evidence as string | undefined)?.trim();
      if (!evidence) {
        throw validationError(
          'evidence is required — a specific observation from this session, not a restatement of the attribution.'
        );
      }
      const counterfactual = (args.counterfactual as string | undefined)?.trim();
      if (!counterfactual) {
        throw validationError(
          'counterfactual is required (§3) — one line: ' +
            '"If the truth were (the other most plausible attribution), I would expect to see X; what I actually saw was Y." ' +
            'This is the anti-self-serving-attribution check; skipping it defeats the point of §1.'
        );
      }

      // ---- action_link — required, type must match primary_attribution (§4).
      const actionLinkArg = args.action_link as { type?: string; ref_id?: string } | undefined;
      if (!actionLinkArg || typeof actionLinkArg !== 'object' || !actionLinkArg.type || !actionLinkArg.ref_id) {
        throw validationError(
          'action_link is required — { type, ref_id } (§4): ' +
            'an attribution without a linked action is a diary entry, not a reflection.'
        );
      }
      const expectedActionLinkType = REQUIRED_ACTION_LINK_TYPE[primaryAttribution];
      if (actionLinkArg.type !== expectedActionLinkType) {
        throw validationError(
          `action_link.type must be '${expectedActionLinkType}' for primary_attribution '${primaryAttribution}' ` +
            `(§4 mapping) — got '${actionLinkArg.type}'.`
        );
      }
      const actionLink: ActionLink = {
        type: actionLinkArg.type as ActionLinkType,
        ref_id: actionLinkArg.ref_id,
      };

      // ---- weather_expires_at — required iff primary_attribution === 'weather' (⑥).
      const weatherExpiresAtRaw = args.weather_expires_at as string | undefined;
      let weatherExpiresAt: Date | null = null;
      if (primaryAttribution === 'weather') {
        if (!weatherExpiresAtRaw) {
          throw validationError(
            "weather_expires_at is required when primary_attribution is 'weather' — " +
              'weather burns after its expiry; it needs a timestamp to burn at.'
          );
        }
        weatherExpiresAt = new Date(weatherExpiresAtRaw);
        if (Number.isNaN(weatherExpiresAt.getTime())) {
          throw validationError(`weather_expires_at is not a valid timestamp: ${weatherExpiresAtRaw}`);
        }
      } else if (weatherExpiresAtRaw) {
        throw validationError(
          `weather_expires_at is only valid when primary_attribution is 'weather' — ` +
            `got it with primary_attribution '${primaryAttribution}'.`
        );
      }

      // ---- 反思挂锚: lesson_id / live_session_id — both optional,
      // both type-checked here; existence + same-pair checked below (needs DB).
      const reflLessonIdRaw = args.lesson_id;
      if (reflLessonIdRaw !== undefined && typeof reflLessonIdRaw !== 'string') {
        throw validationError('lesson_id must be a string when provided', { field: 'lesson_id' });
      }
      const reflLessonId = (reflLessonIdRaw as string | undefined)?.trim() || undefined;
      const reflLiveSessionIdRaw = args.live_session_id;
      if (reflLiveSessionIdRaw !== undefined && typeof reflLiveSessionIdRaw !== 'string') {
        throw validationError('live_session_id must be a string when provided', { field: 'live_session_id' });
      }
      const reflLiveSessionId = (reflLiveSessionIdRaw as string | undefined)?.trim() || undefined;

      return runIdempotentMutation(pairId, 'reflect_on_teaching', idempotencyKey, args, async () => {
        // ---- 挂锚存在性 + 同 pair 校验(填了就必须真实, 不填不检——
        // 同 close_lesson_loop 回执 ref_id 的既定纪律)。lesson 经 courses.pair_id
        // 判 pair 归属(lessons 本身不带 pair_id, 同 pair://exercises/pending
        // 的 join 链); live_session 直接带 pair_id。
        if (reflLessonId) {
          const [lessonRow] = await db
            .select({ id: lessons.id, pair_id: courses.pair_id })
            .from(lessons)
            .innerJoin(courses, eq(lessons.course_id, courses.id))
            .where(eq(lessons.id, reflLessonId))
            .limit(1);
          if (!lessonRow) {
            throw notFoundError(`Lesson ${reflLessonId} not found`, { field: 'lesson_id', lesson_id: reflLessonId });
          }
          if (lessonRow.pair_id !== pairId) {
            throw validationError(
              `lesson_id '${reflLessonId}' belongs to a different pair — reflections can only anchor to a lesson in the current pair.`,
              { field: 'lesson_id', lesson_id: reflLessonId }
            );
          }
        }
        let liveSessionParamRow: { id: string; context_type: string; context_id: string } | undefined;
        if (reflLiveSessionId) {
          const [liveRow] = await db
            .select({
              id: live_sessions.id,
              pair_id: live_sessions.pair_id,
              context_type: live_sessions.context_type,
              context_id: live_sessions.context_id,
            })
            .from(live_sessions)
            .where(eq(live_sessions.id, reflLiveSessionId))
            .limit(1);
          if (!liveRow) {
            throw notFoundError(`Live session ${reflLiveSessionId} not found`, {
              field: 'live_session_id',
              live_session_id: reflLiveSessionId,
            });
          }
          if (liveRow.pair_id !== pairId) {
            throw validationError(
              `live_session_id '${reflLiveSessionId}' belongs to a different pair — reflections can only anchor to a live session in the current pair.`,
              { field: 'live_session_id', live_session_id: reflLiveSessionId }
            );
          }
          liveSessionParamRow = {
            id: liveRow.id,
            context_type: liveRow.context_type as string,
            context_id: liveRow.context_id,
          };
        }

        // ---- 挂锚推断: lesson_id 没显式给时, 从现场上下文强推断
        // (阶梯与判定纯函数见 lib/reflection-anchor.ts; 这里只采集候选)。
        // 参数不改必填 (breaking change 不做); 推断命中就替调用方挂上并在回执
        // 明示来源, 推不出就落无主行 + 回执警告——写入各自成功、聚合装不认识
        // 的病 (真实误读案例: reflect 成功 + close 成功, closure_progress 仍报
        // reflection 缺) 从写入侧断根。聚合侧的另半边修在
        // lib/lesson-closure-facts.ts fetchAnchoredReflectionExists。
        let anchorLessonId = reflLessonId;
        let anchorNote = '';
        if (!anchorLessonId) {
          // liveSessionParamRow 在场时判定会在阶梯 1/2 短路, 不必查候选。
          const needCandidates = !liveSessionParamRow;
          const [activeRows, recentRows] = needCandidates
            ? await Promise.all([
                db
                  .select({ id: live_sessions.id, context_id: live_sessions.context_id })
                  .from(live_sessions)
                  .where(
                    and(
                      eq(live_sessions.pair_id, pairId),
                      eq(live_sessions.context_type, 'lesson'),
                      eq(live_sessions.status, 'active')
                    )
                  ),
                db
                  .select({ id: live_sessions.id, context_id: live_sessions.context_id })
                  .from(live_sessions)
                  .where(
                    and(
                      eq(live_sessions.pair_id, pairId),
                      eq(live_sessions.context_type, 'lesson'),
                      gte(
                        live_sessions.last_activity_at,
                        new Date(Date.now() - REFLECTION_ANCHOR_RECENCY_WINDOW_MS)
                      )
                    )
                  )
                  .orderBy(desc(live_sessions.last_activity_at))
                  .limit(1),
              ])
            : [[], []];
          const resolved = resolveInferredReflectionAnchor({
            liveSessionParam: liveSessionParamRow
              ? {
                  sessionId: liveSessionParamRow.id,
                  contextType: liveSessionParamRow.context_type,
                  contextId: liveSessionParamRow.context_id,
                }
              : undefined,
            activeLessonSessions: activeRows.map((r) => ({ sessionId: r.id, lessonId: r.context_id })),
            recentLessonSession: recentRows[0]
              ? { sessionId: recentRows[0].id, lessonId: recentRows[0].context_id }
              : undefined,
          });
          if (resolved.lessonId) {
            // 防御复检: 推断出的课走与显式 lesson_id 同一道存在+归属双检。过
            // 不了就放弃推断落回无主+警告——推断永远不该把一次合法写入变成报错。
            const [inferredLessonRow] = await db
              .select({ id: lessons.id, pair_id: courses.pair_id })
              .from(lessons)
              .innerJoin(courses, eq(lessons.course_id, courses.id))
              .where(eq(lessons.id, resolved.lessonId))
              .limit(1);
            if (inferredLessonRow && inferredLessonRow.pair_id === pairId) {
              anchorLessonId = resolved.lessonId;
              anchorNote =
                ` · anchored to: lesson ${resolved.lessonId} (${describeReflectionAnchorSource(resolved.source)}, ` +
                `session ${resolved.sessionId} — if this reflection doesn't belong to this lesson, pass lesson_id explicitly to correct it)`;
            }
          }
          if (!anchorLessonId) {
            anchorNote = ` · ${UNANCHORED_REFLECTION_WARNING}`;
          }
        }

        // ---- §5 观察禁区 gate: attribution content (①-⑤, i.e. everything but
        // 'weather') is an observation about the learner and goes through the
        // same registry as every other profile-write path (复用现有
        // isObservationForbidden, 不绕过). 'weather' (⑥) never checks this —
        // it's structurally out of scope for the registry, not opted out of it
        // (brief §1/§3).
        let attributionColumns: {
          primary_attribution: PrimaryAttribution | null;
          secondary_attribution: PrimaryAttribution | null;
          evidence: string | null;
          counterfactual: string | null;
          action_link: ActionLink | null;
          weather_expires_at: Date | null;
        };
        let gateNote = '';
        if (
          primaryAttribution !== 'weather' &&
          (await isObservationForbidden(pairId, TEACHING_ATTRIBUTION_OBSERVATION_CATEGORY))
        ) {
          // Not written, not written-then-hidden (LEARNER-MODEL-BRIEF §4 军规
          // 3) — the base reflection (method/rationale/next_action) below is
          // the teacher's pre-existing diary, not the observation this batch
          // adds, so it still lands.
          attributionColumns = {
            primary_attribution: null,
            secondary_attribution: null,
            evidence: null,
            counterfactual: null,
            action_link: null,
            weather_expires_at: null,
          };
          gateNote = ' (attribution fields NOT recorded — forbidden-observations registry hit)';
        } else {
          // ④ action_link 目标存在性硬闸: ref_id 按 type 到对应落点表
          // 验存在+归属 (lib/evidence-refs.ts ACTION_LINK_REF_TABLES), 幽灵
          // → VALIDATION。只在 attribution 真要落库时验 (禁区分支上面已经
          // 不写 action_link, 没有目标可言)。
          await assertActionLinkTarget(pairId, actionLink.type, actionLink.ref_id);
          attributionColumns = {
            primary_attribution: primaryAttribution,
            secondary_attribution: secondaryAttribution ?? null,
            evidence,
            counterfactual,
            action_link: actionLink,
            weather_expires_at: weatherExpiresAt,
          };
        }

        const id = genId('refl');
        await db.insert(teacher_reflections).values({
          id,
          pair_id: pairId,
          from_session_id: null,
          linked_intervention_event_id: null,
          lesson_id: anchorLessonId ?? null,
          live_session_id: reflLiveSessionId ?? null,
          method: reflMethod,
          rationale: reflRationale,
          expected_outcome: (args.expected_outcome as string) ?? '',
          actual_evidence: (args.actual_evidence as string) ?? '',
          what_worked: (args.what_worked as string[]) ?? [],
          what_failed: (args.what_failed as string[]) ?? [],
          hypothesis_changes: [],
          next_action: reflNextAction,
          ...attributionColumns,
          written_at: new Date(),
        });

        const attribution_tally = await buildAttributionTally(pairId);
        // 随行回执 (红队第六轮针二) — 只在这条反思带 lesson 锚(显式或推断,
        // 挂锚推断)时附 closure_progress (无锚 = 这条反思不属于任何单课,
        // 没有"这节课"可言——此时 human_note 里的 UNANCHORED 警告替它说话)。
        return buildSuccessEnvelope({
          operation: 'reflect_on_teaching',
          resource_id: id,
          created_refs: {
            reflection_id: id,
            // 推断挂锚是"替调用方做的写"——机器可读地交代出来, 不只藏在 note 里。
            ...(anchorLessonId && !reflLessonId ? { anchored_lesson_id: anchorLessonId } : {}),
          },
          next_recommended_actions: ACTION_LINK_NEXT_TOOL[actionLink.type] ?? [],
          ...(anchorLessonId
            ? { closure_progress: toClosureProgress(await computeLessonClosureProgress(pairId, anchorLessonId)) }
            : {}),
          human_note: `Wrote reflection ${id}${gateNote}${anchorNote} · attribution_tally: ${JSON.stringify(attribution_tally)}`,
        });
      });
    }
    // =====================================================================
    // 现场反馈笔
    // =====================================================================
    case 'record_learner_feedback': {
      const idempotencyKey = args.idempotency_key as string | undefined;
      // kind — closed two-way enum, no free text (裁决 c).
      const fbKind = args.kind;
      if (fbKind !== 'issue' && fbKind !== 'idea') {
        throw validationError(
          `kind is required and must be 'issue' or 'idea' — got ${JSON.stringify(args.kind)}.`,
          { field: 'kind' }
        );
      }
      // text — her verbatim words, required non-empty. Stored untouched.
      const fbText = requireStringArg(args, 'text');
      // Optional anchors — type-checked here, existence + same-pair below
      // (needs DB), 同 reflect_on_teaching 的既定纪律: 填了就必须
      // 真实, 不填不检。source_message_ref 与 note 只做类型检查, 不查存在性
      // (live 消息可能活在 bridge 事件流里, 没有稳定单表 id 可查)。
      const optionalString = (key: string): string | undefined => {
        const raw = args[key];
        if (raw !== undefined && typeof raw !== 'string') {
          throw validationError(`${key} must be a string when provided`, { field: key });
        }
        return (raw as string | undefined)?.trim() || undefined;
      };
      const fbLessonId = optionalString('lesson_id');
      const fbLiveSessionId = optionalString('live_session_id');
      const fbExerciseId = optionalString('exercise_id');
      const fbSourceMessageRef = optionalString('source_message_ref');
      const fbNote = optionalString('note');
      // 观察边界折笔 — boundary_update 可选, 形状已由
      // findUnknownField 递归校验过 additionalProperties(见 lib/schema-guard.ts),
      // 这里只做值域校验(action 枚举 + boundary 非空)。
      const boundaryUpdateRaw = args.boundary_update as
        | { action?: unknown; boundary?: unknown }
        | undefined;
      let boundaryAction: 'add' | 'remove' | undefined;
      let boundaryValue: string | undefined;
      if (boundaryUpdateRaw !== undefined) {
        const rawAction = boundaryUpdateRaw.action;
        if (rawAction !== 'add' && rawAction !== 'remove') {
          throw validationError(
            `boundary_update.action is required and must be 'add' or 'remove' — got ${JSON.stringify(rawAction)}.`,
            { field: 'boundary_update.action' }
          );
        }
        const rawBoundary = boundaryUpdateRaw.boundary;
        if (typeof rawBoundary !== 'string' || rawBoundary.trim() === '') {
          throw validationError(
            'boundary_update.boundary is required (non-empty string) when boundary_update is present.',
            { field: 'boundary_update.boundary' }
          );
        }
        boundaryAction = rawAction;
        boundaryValue = rawBoundary.trim();
      }

      return runIdempotentMutation(pairId, 'record_learner_feedback', idempotencyKey, args, async () => {
        if (fbLessonId) {
          const [lessonRow] = await db
            .select({ id: lessons.id, pair_id: courses.pair_id })
            .from(lessons)
            .innerJoin(courses, eq(lessons.course_id, courses.id))
            .where(eq(lessons.id, fbLessonId))
            .limit(1);
          if (!lessonRow) {
            throw notFoundError(`Lesson ${fbLessonId} not found`, { field: 'lesson_id', lesson_id: fbLessonId });
          }
          if (lessonRow.pair_id !== pairId) {
            throw validationError(
              `lesson_id '${fbLessonId}' belongs to a different pair — feedback can only anchor to a lesson in the current pair.`,
              { field: 'lesson_id', lesson_id: fbLessonId }
            );
          }
        }
        if (fbLiveSessionId) {
          const [liveRow] = await db
            .select({ id: live_sessions.id, pair_id: live_sessions.pair_id })
            .from(live_sessions)
            .where(eq(live_sessions.id, fbLiveSessionId))
            .limit(1);
          if (!liveRow) {
            throw notFoundError(`Live session ${fbLiveSessionId} not found`, {
              field: 'live_session_id',
              live_session_id: fbLiveSessionId,
            });
          }
          if (liveRow.pair_id !== pairId) {
            throw validationError(
              `live_session_id '${fbLiveSessionId}' belongs to a different pair — feedback can only anchor to a live session in the current pair.`,
              { field: 'live_session_id', live_session_id: fbLiveSessionId }
            );
          }
        }
        if (fbExerciseId) {
          // exercises 不带 pair_id — 经 lesson→course 判 pair 归属, 同
          // pair://exercises/pending 的 join 链。
          const [exerciseRow] = await db
            .select({ id: exercises.id, pair_id: courses.pair_id })
            .from(exercises)
            .innerJoin(lessons, eq(exercises.lesson_id, lessons.id))
            .innerJoin(courses, eq(lessons.course_id, courses.id))
            .where(eq(exercises.id, fbExerciseId))
            .limit(1);
          if (!exerciseRow) {
            throw notFoundError(`Exercise ${fbExerciseId} not found`, { field: 'exercise_id', exercise_id: fbExerciseId });
          }
          if (exerciseRow.pair_id !== pairId) {
            throw validationError(
              `exercise_id '${fbExerciseId}' belongs to a different pair — feedback can only anchor to an exercise in the current pair.`,
              { field: 'exercise_id', exercise_id: fbExerciseId }
            );
          }
        }

        const id = genId('fb');
        const now = new Date();

        // 观察边界折笔: 有 boundary_update 时, feedback 落账 +
        // pair.forbidden_observations 变更在同一事务里原子发生——这条 feedback
        // 的 text(她的原话)就是这次边界变更的审计留痕, 不必另开审计表/字段。
        // add 用 containment-guarded 的 CASE(已含则原样保留, 不追加重复项);
        // remove 用 jsonb `-` 操作符(对字符串数组=移除匹配的元素, 元素本不
        // 存在时是天然 no-op)。两条分支都不加 WHERE 内容守卫——UPDATE 始终命中
        // 这一个 pair 行, 所以 RETURNING 始终能拿到(可能不变的)最终列表, 回执
        // 才有东西可回。
        let updatedForbiddenObservations: string[] | undefined;
        await db.transaction(async (tx) => {
          await tx.insert(learner_feedback).values({
            id,
            pair_id: pairId,
            // ritual 遗留列: contract_id 自 0038 起可空, 现场反馈不挂合同;
            // week_of 仍 NOT NULL, 按落账时刻写入 (事件式反馈没有"周"概念,
            // 该列对新行只是落账时间的粗粒度影子)。
            contract_id: null,
            week_of: now,
            kind: fbKind,
            status: 'open',
            status_note: fbNote ?? null,
            status_changed_at: null,
            free_text: fbText,
            lesson_id: fbLessonId ?? null,
            live_session_id: fbLiveSessionId ?? null,
            exercise_id: fbExerciseId ?? null,
            source_message_ref: fbSourceMessageRef ?? null,
            submitted_at: now,
          });

          if (boundaryAction && boundaryValue) {
            const newValue =
              boundaryAction === 'add'
                ? sql`case when ${learner_agent_pairs.forbidden_observations} ? ${boundaryValue}
                    then ${learner_agent_pairs.forbidden_observations}
                    else ${learner_agent_pairs.forbidden_observations} || ${JSON.stringify([boundaryValue])}::jsonb
                    end`
                : sql`${learner_agent_pairs.forbidden_observations} - ${boundaryValue}`;
            const [pairRow] = await tx
              .update(learner_agent_pairs)
              .set({ forbidden_observations: newValue })
              .where(eq(learner_agent_pairs.id, pairId))
              .returning({ forbidden_observations: learner_agent_pairs.forbidden_observations });
            if (!pairRow) {
              throw notFoundError(`Pair ${pairId} not found — cannot update forbidden_observations`, {
                pair_id: pairId,
              });
            }
            updatedForbiddenObservations = pairRow.forbidden_observations;
          }
        });

        return buildSuccessEnvelope({
          operation: 'record_learner_feedback',
          resource_id: id,
          created_refs: { feedback_id: id },
          next_recommended_actions: ['update_feedback_status'],
          human_note:
            `Recorded ${fbKind} ${id} — a logged entry demands a receipt: this turn must reply to the learner ` +
            "with one confirming line, letting her know it's been recorded; a silent log is the same as no log." +
            (updatedForbiddenObservations
              ? ` Observation boundary (${boundaryAction}: "${boundaryValue}") was logged atomically with this feedback entry — ` +
                `pair.forbidden_observations is now ${JSON.stringify(updatedForbiddenObservations)}. This change takes effect ` +
                'only on the next get_learner_brief; this teaching turn still follows the old boundary.'
              : ''),
        });
      });
    }
    case 'update_feedback_status': {
      const idempotencyKey = args.idempotency_key as string | undefined;
      const feedbackId = requireStringArg(args, 'feedback_id');
      // status — closed enum ('open' is where rows are born, not a
      // destination anyone can move them to).
      const nextStatus = args.status;
      if (nextStatus !== 'acknowledged' && nextStatus !== 'addressed' && nextStatus !== 'declined') {
        throw validationError(
          `status must be one of acknowledged, addressed, declined — got ${JSON.stringify(args.status)}.`,
          { field: 'status' }
        );
      }
      const noteRaw = args.note;
      if (noteRaw !== undefined && typeof noteRaw !== 'string') {
        throw validationError('note must be a string when provided', { field: 'note' });
      }
      const statusNote = (noteRaw as string | undefined)?.trim() || undefined;
      // 裁决 d: 老师可以拒绝, 但必须给理由——拒绝的判词保护接受的价值。
      if (nextStatus === 'declined' && !statusNote) {
        throw validationError(
          "note is required when declining — declining requires the teacher's reasoning (the teacher owes a verdict: " +
            'the reason for declining is what protects the value of accepting; a decline with no reasoning is a disappearance, not a decline).',
          { field: 'note' }
        );
      }

      return runIdempotentMutation(pairId, 'update_feedback_status', idempotencyKey, args, async () => {
        const [row] = await db
          .select()
          .from(learner_feedback)
          .where(eq(learner_feedback.id, feedbackId))
          .limit(1);
        if (!row) {
          throw notFoundError(`Feedback ${feedbackId} not found`, { field: 'feedback_id', feedback_id: feedbackId });
        }
        if (row.pair_id !== pairId) {
          throw validationError(
            `feedback_id '${feedbackId}' belongs to a different pair.`,
            { field: 'feedback_id', feedback_id: feedbackId }
          );
        }
        // Legal transitions: open → acknowledged/addressed/declined;
        // acknowledged → addressed/declined; addressed/declined terminal.
        const LEGAL_NEXT: Record<string, readonly string[]> = {
          open: ['acknowledged', 'addressed', 'declined'],
          acknowledged: ['addressed', 'declined'],
        };
        const allowed = LEGAL_NEXT[row.status] ?? [];
        if (!allowed.includes(nextStatus)) {
          throw conflictError(
            row.status === 'addressed' || row.status === 'declined'
              ? `Feedback ${feedbackId} is already '${row.status}' — addressed/declined are terminal, the judgment stands.`
              : `Illegal transition '${row.status}' → '${nextStatus}' for feedback ${feedbackId}.`,
            { feedback_id: feedbackId, current_status: row.status, requested_status: nextStatus }
          );
        }
        const now = new Date();
        await db
          .update(learner_feedback)
          .set({
            status: nextStatus,
            status_changed_at: now,
            // note omitted (acknowledged/addressed) → keep whatever note the
            // row already carries; never silently null out a judgment.
            ...(statusNote ? { status_note: statusNote } : {}),
          })
          .where(eq(learner_feedback.id, feedbackId));
        return buildSuccessEnvelope({
          operation: 'update_feedback_status',
          resource_id: feedbackId,
          human_note: `Feedback ${feedbackId}: ${row.status} → ${nextStatus}${statusNote ? ' (with note)' : ''}.`,
        });
      });
    }
    // =====================================================================
    // Read-back / orient tools
    // =====================================================================
    case 'get_context': {
      const targetPair = (args.pair_id as string | undefined) ?? pairId;
      if (!(await pairExists(targetPair))) {
        const available = await listAvailablePairs();
        throw notFoundError(`Pair ${targetPair} not found.`, { available_pairs: available });
      }
      const snapshot = await buildContextSnapshot(targetPair);
      // (context/brief 去重) — identity 的 display_name/identity_note
      // 展示块与 get_learner_brief 逐字重复, MCP 面只留 id + brief_etag;
      // 全量 identity 归 get_learner_brief (REST 镜像 GET /pairs/:id/context
      // 保持全量 — apps/web 的称谓体系 useIdentity 以它为权威来源, 不动)。
      const { identity: fullIdentity, ...snapshotRest } = snapshot;
      return success({
        operation: 'get_context',
        human_note: `Context snapshot for pair ${targetPair}.`,
        data: {
          ...snapshotRest,
          identity: fullIdentity
            ? { learner_id: fullIdentity.learner.id, agent_id: fullIdentity.agent.id }
            : null,
        },
      });
    }
    case 'get_learner_brief': {
      const targetPair = (args.pair_id as string | undefined) ?? pairId;
      if (!(await pairExists(targetPair))) {
        const available = await listAvailablePairs();
        throw notFoundError(`Pair ${targetPair} not found.`, { available_pairs: available });
      }
      const limit = Math.max(1, Math.min(20, (args.limit as number | undefined) ?? 5));
      // 反思挂锚: 可选 lesson_id — 有挂锚数据时 latest_reflection
      // 优先给当前课的那条(读现状, 最小改法), 见 buildLearnerBrief 第三参。
      const briefLessonId = typeof args.lesson_id === 'string' ? args.lesson_id : undefined;
      const brief = await buildLearnerBrief(targetPair, limit, briefLessonId);
      return success({
        operation: 'get_learner_brief',
        human_note: `Learner brief for pair ${targetPair} (limit ${limit}).`,
        data: brief,
      });
    }
    case 'get_teacher_inbox': {
      const targetPair = (args.pair_id as string | undefined) ?? pairId;
      if (!(await pairExists(targetPair))) {
        const available = await listAvailablePairs();
        throw notFoundError(`Pair ${targetPair} not found.`, { available_pairs: available });
      }
      const inbox = await buildTeacherInbox(targetPair, args.since as string | undefined);
      // 现场反馈笔 · 软牙齿: status=open 的反馈在这里发光——
      // 纯 informational, 不进 items[] 的待办机制 (它没有 recommended_tool
      // 义务节拍), 更不阻塞 close_lesson_loop。cursor (since) 对它无效:
      // open 就一直亮, 直到 update_feedback_status 把它推进生命周期。
      const OPEN_FEEDBACK_PREVIEW_LIMIT = 5;
      const openFeedbackRows = await db
        .select()
        .from(learner_feedback)
        .where(and(eq(learner_feedback.pair_id, targetPair), eq(learner_feedback.status, 'open')))
        .orderBy(desc(learner_feedback.submitted_at));
      const nowMs = Date.now();
      const open_feedback = {
        count: openFeedbackRows.length,
        items: openFeedbackRows.slice(0, OPEN_FEEDBACK_PREVIEW_LIMIT).map((f) => {
          const text = f.free_text ?? '';
          return {
            feedback_id: f.id,
            kind: f.kind,
            text_excerpt: text.length > 120 ? `${text.slice(0, 120)}…` : text,
            anchors: {
              ...(f.lesson_id ? { lesson_id: f.lesson_id } : {}),
              ...(f.live_session_id ? { live_session_id: f.live_session_id } : {}),
              ...(f.exercise_id ? { exercise_id: f.exercise_id } : {}),
              ...(f.source_message_ref ? { source_message_ref: f.source_message_ref } : {}),
            },
            age_hours: Math.max(0, Math.round((nowMs - f.submitted_at.getTime()) / (60 * 60 * 1000))),
            submitted_at: f.submitted_at.toISOString(),
          };
        }),
        note:
          '软牙齿: open 反馈只发光, 不拦路——它不阻塞 close_lesson_loop 或任何闭环动作。' +
          '回应它用 update_feedback_status (acknowledged/addressed/declined, declined 必须带判词)。',
      };
      return success({
        operation: 'get_teacher_inbox',
        human_note:
          `${inbox.items.length} inbox item(s) for pair ${targetPair} since ${inbox.since}.` +
          (open_feedback.count > 0 ? ` · ${open_feedback.count} open learner feedback (soft glow, non-blocking).` : ''),
        data: { ...inbox, open_feedback },
      });
    }
    // ---------------------------------------------------------------------
    // Content read-back — get_lesson / get_exercise / get_submission.
    // 归属纪律 (三工具共通, 与写工具挂锚校验故意不同): pair 过滤在 lib/
    // read-back.ts 的同一条 WHERE 里, 他 pair 的资源与不存在的资源返回同一个
    // NOT_FOUND — 读回面不泄露他人资源的存在性。
    // ---------------------------------------------------------------------
    case 'get_lesson': {
      const lessonId = requireStringArg(args, 'lesson_id');
      // include_content 只认字面 boolean — "true"/1 这类近似值按 VALIDATION
      // 拒收带路, 不做静默宽容 (schema-by-need: 描述即合同)。
      if (args.include_content !== undefined && typeof args.include_content !== 'boolean') {
        throw validationError(
          `include_content must be a boolean — got ${JSON.stringify(args.include_content)}. Pass true/false, not a string.`,
          { field: 'include_content' }
        );
      }
      const includeContent = args.include_content === true;
      const lessonData = await getLessonReadback(pairId, lessonId, includeContent);
      return success({
        operation: 'get_lesson',
        resource_id: lessonId,
        human_note:
          `Lesson ${lessonId} "${lessonData.title}" (${lessonData.published ? 'published' : 'draft'}, ` +
          `rev ${lessonData.revision}, ${lessonData.concepts.length} concept(s), ${lessonData.exercises.length} exercise(s))` +
          (includeContent
            ? ` · full text included, ${lessonData.content_chars} chars (content_markdown).`
            : ` · compact mode — full text not included (${lessonData.content_chars} chars); pass include_content: true for the full lesson text.`),
        data: lessonData,
      });
    }
    case 'get_exercise': {
      const exerciseId = requireStringArg(args, 'exercise_id');
      const exerciseData = await getExerciseReadback(pairId, exerciseId);
      return success({
        operation: 'get_exercise',
        resource_id: exerciseId,
        human_note:
          `Exercise ${exerciseId} (lesson "${exerciseData.lesson_title}", order ${exerciseData.order}) — ` +
          "reference_answer is the grading key, confidential to the teacher's side — don't pass it verbatim to the learner.",
        data: exerciseData,
      });
    }
    case 'get_submission': {
      const submissionId = requireStringArg(args, 'submission_id');
      const submissionData = await getSubmissionReadback(pairId, submissionId);
      return success({
        operation: 'get_submission',
        resource_id: submissionId,
        // 批改动线顺手指路: 未批改的提交读回后, 下一步自然是审题 (get_exercise
        // 取评分钥匙) 再判 (grade_exercise)。已批改的读回多是复盘, 不推荐。
        ...(submissionData.status === 'submitted' || submissionData.status === 'pending_grade'
          ? { next_recommended_actions: ['get_exercise', 'grade_exercise'] }
          : {}),
        human_note:
          `Submission ${submissionId} (status ${submissionData.status}` +
          (submissionData.agent_score != null ? `, score ${submissionData.agent_score}` : '') +
          `) — exercise ${submissionData.exercise_id} / lesson ${submissionData.lesson_id}。`,
        data: submissionData,
      });
    }
    // =====================================================================
    // Live Teaching (Stage 7d)
    // =====================================================================
    case 'live_pending': {
      const targetPair = (args.pair_id as string | undefined) ?? pairId;

      const [bridge] = await db
        .select()
        .from(bridge_states)
        .where(eq(bridge_states.pair_id, targetPair))
        .limit(1);
      const now = new Date();
      const bridgeStatus = {
        pair_id: targetPair,
        online: bridge ? bridge.online_until.getTime() > now.getTime() : false,
        last_heartbeat_at: bridge?.last_heartbeat_at?.toISOString() ?? null,
        online_until: bridge ? bridge.online_until.toISOString() : null,
      };

      const awaiting = await db
        .select()
        .from(live_sessions)
        .where(
          and(
            eq(live_sessions.pair_id, targetPair),
            eq(live_sessions.status, 'active'),
            eq(live_sessions.awaiting_role, 'agent')
          )
        )
        .orderBy(asc(live_sessions.last_activity_at));

      const items: BridgePendingItem[] = [];

      // Live Teaching pending.
      for (const sess of awaiting) {
        const [latestResp] = await db
          .select()
          .from(teaching_responses)
          .where(eq(teaching_responses.session_id, sess.id))
          .orderBy(desc(teaching_responses.created_at))
          .limit(1);
        const [moveCountRow] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(teaching_moves)
          .where(eq(teaching_moves.session_id, sess.id));
        const moveCount = Number(moveCountRow?.n ?? 0);
        const reason = moveCount === 0 ? 'live_session_start' : 'live_response';
        // 件三 — 分工标签: 最新一条 move 的 response_kind 决定
        // 这笔 pending 是"学习者的回应在等你" 还是 "你自己欠自己的下一拍"
        // (见 lib/live-wait.ts classifyPendingReason 头注)。
        const [latestMove] =
          moveCount === 0
            ? [undefined]
            : await db
                .select({ response_kind: teaching_moves.response_kind })
                .from(teaching_moves)
                .where(eq(teaching_moves.session_id, sess.id))
                .orderBy(desc(teaching_moves.seq))
                .limit(1);

        items.push({
          channel: 'live_teaching',
          reason,
          session_id: sess.id as never,
          // (件三) — 整行 session 瘦成 stub; 全量状态归 live_session_get。
          session: toLiveSessionStub(sess),
          latest_response: latestResp as never,
          queued_at: sess.last_activity_at.toISOString(),
          // 软牌 — 新 session (还没有任何 move) 提示首个 move 该是 FRAME。
          ...(reason === 'live_session_start' ? { next_expected: 'FRAME' as const } : {}),
          pending_reason: classifyPendingReason(moveCount, latestMove?.response_kind),
        });
      }

      // Ad Hoc pending (trailing user message without agent reply).
      // Archived threads are excluded — 归档是隐私边界, agent 侧的 pending
      // 扫描不能把归档线程当成待办 (参照 routes/adhoc.ts by-pair 过滤).
      const threads = await db
        .select()
        .from(ad_hoc_threads)
        .where(and(eq(ad_hoc_threads.pair_id, targetPair), isNull(ad_hoc_threads.archived_at)));
      for (const th of threads) {
        const [last] = await db
          .select()
          .from(ad_hoc_messages)
          .where(eq(ad_hoc_messages.thread_id, th.id))
          .orderBy(desc(ad_hoc_messages.created_at))
          .limit(1);
        if (!last || last.role !== 'user') continue;
        // 消账游标退场 (AdHoc 三票并一之三) — 同口径见 lib/live-wait.ts
        // isAdhocMessageOutstanding 头注 (三处手写扫描共享该 helper：这里 /
        // computeBridgeWaitEvents / routes/teaching.ts GET /bridge/pending)。
        if (!isAdhocMessageOutstanding(th.acked_message_id, last.id)) continue;
        items.push({
          channel: 'adhoc',
          reason: 'adhoc_message',
          thread_id: th.id,
          latest_message: last,
          queued_at: last.created_at.toISOString(),
        });
      }

      const priority: Record<string, number> = {
        adhoc_message: 0,
        live_session_start: 1,
        live_response: 2,
      };
      items.sort((a, b) => {
        const pa = priority[a.reason] ?? 99;
        const pb = priority[b.reason] ?? 99;
        if (pa !== pb) return pa - pb;
        return a.queued_at.localeCompare(b.queued_at);
      });

      // 轮询牙齿 (Goal B) — 同一 pair 90s 内连续空手调用达阈值 → 警告; 达双倍
      // 阈值 → 拒答。真有 items 时 hadRealItems=true, 牙齿函数内部直接重置计数
      // 并放行, 绝不吞真实数据 (lib/live-wait.ts checkPendingPollGate 头注)。
      const pollGate = checkPendingPollGate(targetPair, items.length > 0);
      if (pollGate.action === 'block') {
        throw permissionError(
          POLL_GUARD_MESSAGE,
          {
            empty_streak: pollGate.empty_streak,
            window_s: pollGate.window_s,
            warn_threshold: pollGate.warn_threshold,
            block_threshold: pollGate.block_threshold,
          },
          '停止轮询 live_pending。改挂 live_wait(阻塞等待, 超时重挂)或后台看门脚本 scripts/live-watch.py; 你家 harness 有自己的监听原语也行。真实 pending 到达后本工具自动恢复放行。'
        );
      }

      // 值更契约全路径暴露 (件一) — bridge 级 may_end_turn: 该 pair 是否还有
      // active 会话, 不看这次 items 里有没有东西 (没有 pending 不等于没有值更
      // 义务——会话可能还在, 只是这一拍轮到学习者说话)。
      const pendingHasActive = await pairHasActiveLiveSession(targetPair);

      return success({
        operation: 'live_pending',
        human_note: `${items.length} pending item(s) for pair ${targetPair}.`,
        ...(pollGate.action === 'warn' ? { warning: POLL_GUARD_MESSAGE } : {}),
        live_runtime_contract: buildLiveRuntimeContract(!pendingHasActive),
        contract_version: liveRuntimeContractVersion(),
        data: {
          bridge: bridgeStatus,
          items,
          ...(pollGate.action === 'warn'
            ? {
                poll_guard: {
                  violated: true,
                  message: POLL_GUARD_MESSAGE,
                  empty_streak: pollGate.empty_streak,
                  window_s: pollGate.window_s,
                  warn_threshold: pollGate.warn_threshold,
                  block_threshold: pollGate.block_threshold,
                },
              }
            : {}),
        },
      });
    }
    case 'live_heartbeat': {
      // 指示灯全拆: context_status 参数已退役 (schema 同步收窄) ——
      // bridge_states 的 context_* 列留存但不再读写, 心跳只管在线窗口。
      const targetPair = (args.pair_id as string | undefined) ?? pairId;
      const ttl = Math.max(15, Math.min(600, (args.ttl_seconds as number | undefined) ?? 60));
      const now = new Date();
      const onlineUntil = new Date(now.getTime() + ttl * 1000);
      await db
        .insert(bridge_states)
        .values({
          pair_id: targetPair,
          last_heartbeat_at: now,
          online_until: onlineUntil,
        })
        .onConflictDoUpdate({
          target: bridge_states.pair_id,
          set: { last_heartbeat_at: now, online_until: onlineUntil },
        });
      return success({
        operation: 'live_heartbeat',
        human_note: `Heartbeat recorded for pair ${targetPair}, online until ${onlineUntil.toISOString()}.`,
        data: {
          pair_id: targetPair,
          online: true,
          last_heartbeat_at: now.toISOString(),
          online_until: onlineUntil.toISOString(),
        },
      });
    }
    case 'live_wait': {
      // 阻塞等待, 与 GET /bridge/wait 共用 lib/live-wait.ts 的核心
      // 等待逻辑 (computeBridgeWaitEvents + poll loop), 只是各自夹自己的
      // timeout_s 上限。
      //
      // Live 2.0 (2026-07-18): consumer_id/since 都是可选的 —— 不传
      // consumer_id 时行为与旧版完全一致 (每次都从"此刻起"等下一个事件,
      // 不读写任何持久化游标)。传了 consumer_id 才走 resolveWaitSince() 的
      // 服务端持久化 delivery cursor 路径 (同 GET /bridge/wait, 见
      // lib/live-wait.ts 头注): since 省略=续读该 consumer_id 上次持久化的
      // 断点, since 传了=确认"上一批已处理完"并推进该 consumer_id 的游标。
      const targetPair = (args.pair_id as string | undefined) ?? pairId;
      const requestedTimeoutS = args.timeout_s as number | undefined;
      const timeoutS = Math.max(
        1,
        Math.min(
          MCP_LIVE_WAIT_MAX_TIMEOUT_S,
          typeof requestedTimeoutS === 'number' && Number.isFinite(requestedTimeoutS)
            ? requestedTimeoutS
            : MCP_LIVE_WAIT_MAX_TIMEOUT_S
        )
      );
      const consumerId = (args.consumer_id as string | undefined) || undefined;
      const sinceParam = args.since as string | undefined;

      // 顺手续一次 heartbeat (ttl 60) —— 等待期间 (最长 timeoutS ≤ 50s) 在线灯
      // 不灭。同 live_heartbeat 的 upsert 形状。
      const now = new Date();
      const onlineUntil = new Date(now.getTime() + 60 * 1000);
      await db
        .insert(bridge_states)
        .values({
          pair_id: targetPair,
          last_heartbeat_at: now,
          online_until: onlineUntil,
        } as typeof bridge_states.$inferInsert)
        .onConflictDoUpdate({
          target: bridge_states.pair_id,
          set: { last_heartbeat_at: now, online_until: onlineUntil },
        });

      const since = await resolveWaitSince(targetPair, consumerId, sinceParam);
      const result = await waitForBridgeEvents(targetPair, since, timeoutS);
      // 值更契约全路径暴露 (件一) — pair 级 may_end_turn: 超时空手不等于可以
      // 收工, 只要这个 pair 还挂着 active 会话, 义务就还在。
      const waitHasActive = await pairHasActiveLiveSession(targetPair);
      // known_contract_version 命中现行版 ⇒ 合约体省略, 超时
      // 响应缩到 {timeout, since, heartbeat_until, contract_version,
      // may_end_turn}; 缺省/过期 ⇒ 完整合约照发 (首次完整), 并随行现行
      // contract_version 供下次传回。may_end_turn 是逐次现算的状态, 瘦
      // 响应里单独保留 (无损红线③)。
      const stamp = buildContractStamp(
        args.known_contract_version as string | undefined,
        !waitHasActive
      );
      const humanNote = result.timeout
        ? `等了 ${timeoutS}s 超时, 无新事件 (pair ${targetPair})。`
        : `等到 ${result.events.length} 个新事件 (pair ${targetPair})。`;
      // data 装配收口 lib/live-contract.ts
      // buildLiveWaitData: 两个分支 (命中/未命中 known_contract_version) 的
      // data 恒为 {events, timeout, since, heartbeat_until, contract_version,
      // may_end_turn} 六件套——超时空手也齐全, 机器不必回头翻 human_note。
      // 信封级字段维持协议原样: 命中 ⇒ 只留 contract_version; 未命中 ⇒
      // 完整合约体随行。
      const waitData = buildLiveWaitData(stamp, result, since, onlineUntil.toISOString());
      if (stamp.matched) {
        return success({
          operation: 'live_wait',
          human_note: humanNote,
          contract_version: stamp.contract_version,
          data: waitData,
        });
      }
      return success({
        operation: 'live_wait',
        human_note: humanNote,
        live_runtime_contract: stamp.live_runtime_contract,
        contract_version: stamp.contract_version,
        data: waitData,
      });
    }
    case 'live_snapshot_write': {
      const idempotencyKey = args.idempotency_key as string | undefined;
      // all four values-only NOT NULL (undefined → SQL DEFAULT →
      // not-null/FK violation, no crash), validated for precise errors.
      const snapSessionId = requireStringArg(args, 'session_id');
      const snapAfterTurnN = requireNumberArg(args, 'after_turn_n');
      const snapRollingSummary = requireStringArg(args, 'rolling_summary');
      const snapCurrentDirection = requireStringArg(args, 'current_direction');
      return runIdempotentMutation(pairId, 'live_snapshot_write', idempotencyKey, args, async () => {
        // 红队第四轮 — 快照时序 enforce: 快照是课中接力棒, 只属于现场。
        // 会话已终态 (非 active) 时拒绝写入, 免得课后补写快照冒充"过闸证据"
        // (证据时序未 enforce 的漏洞)。课后观察请走 record_live_evaluation。
        const [snapSession] = await db
          .select()
          .from(live_sessions)
          .where(eq(live_sessions.id, snapSessionId))
          .limit(1);
        if (!snapSession) {
          throw notFoundError(`Live session ${snapSessionId} not found`, { session_id: snapSessionId });
        }
        if (snapSession.status !== 'active') {
          throw conflictError(
            'A snapshot is the in-class relay baton, belonging only to a live session in progress — this session is already terminal. ' +
              'Post-lesson observations belong in the live evaluation, record_live_evaluation.',
            { session_id: snapSessionId, status: snapSession.status }
          );
        }
        const id = genId('snap');
        const now = new Date();
        const [row] = await db
          .insert(mid_lesson_snapshots)
          .values({
            id,
            session_id: snapSessionId,
            after_turn_n: snapAfterTurnN,
            rolling_summary: snapRollingSummary,
            current_direction: snapCurrentDirection,
            weak_signals: ((args.weak_signals as string[] | undefined) ?? []) as string[],
            created_at: now,
          })
          .returning();
        return buildSuccessEnvelope({
          operation: 'live_snapshot_write',
          resource_id: row?.id,
          created_refs: { snapshot_id: row?.id ?? id },
          human_note: `Snapshot ${row?.id} written after turn ${row?.after_turn_n}`,
        });
      });
    }
    case 'live_snapshot_get_latest': {
      // session_id reaches eq() (lethal as undefined).
      const sid = requireStringArg(args, 'session_id');
      const [row] = await db
        .select()
        .from(mid_lesson_snapshots)
        .where(eq(mid_lesson_snapshots.session_id, sid))
        .orderBy(desc(mid_lesson_snapshots.created_at))
        .limit(1);
      return success({
        operation: 'live_snapshot_get_latest',
        human_note: row ? `Latest snapshot for session ${sid}: ${row.id}.` : `No snapshot for session ${sid}.`,
        data: row ?? null,
      });
    }
    case 'adhoc_thread_get': {
      const targetPair = (args.pair_id as string | undefined) ?? pairId;
      // Only the non-archived thread is a valid get-or-create target — mirrors
      // routes/adhoc.ts by-pair lookup. An archived thread is a
      // dead end here too: once archived, the next message starts a fresh
      // thread instead of resurrecting the old one.
      let [thread] = await db
        .select()
        .from(ad_hoc_threads)
        .where(and(eq(ad_hoc_threads.pair_id, targetPair), isNull(ad_hoc_threads.archived_at)))
        .orderBy(desc(ad_hoc_threads.created_at))
        .limit(1);
      if (!thread) {
        const newId = genId('ah');
        const now = new Date();
        const [created] = await db
          .insert(ad_hoc_threads)
          .values({
            id: newId,
            pair_id: targetPair,
            message_count: 0,
            created_at: now,
            last_activity_at: now,
          })
          .returning();
        thread = created;
      }
      const allMessages = await db
        .select()
        .from(ad_hoc_messages)
        .where(eq(ad_hoc_messages.thread_id, thread!.id))
        .orderBy(asc(ad_hoc_messages.created_at));
      // 增量游标 (值更契约·低损耗, 2026-07-19) — after_message_id 缺省=全量
      // 回读 (行为与迁移前逐字不变); 传了=只返回更新的消息, 用 isNewerEventId
      // 的排序语义 (与 live_wait/GET /bridge/wait 同一套 ah_*/ahm_* id 总序,
      // 见 lib/live-wait.ts 头注), 不按 created_at 时间戳裸比较。
      const afterMessageId = args.after_message_id as string | undefined;
      const messages = afterMessageId
        ? allMessages.filter((m) => isNewerEventId(m.id, afterMessageId))
        : allMessages;
      const hasEarlier = afterMessageId ? messages.length < allMessages.length : false;
      return success({
        operation: 'adhoc_thread_get',
        resource_id: thread!.id,
        human_note: afterMessageId
          ? `Thread ${thread!.id} for pair ${targetPair}: ${messages.length} new message(s) after ${afterMessageId}` +
            `${hasEarlier ? ' (earlier history exists — omitted, this was an incremental read)' : ''}.`
          : `Thread ${thread!.id} for pair ${targetPair} (${messages.length} message(s)).`,
        data: { thread, messages, returned_count: messages.length, has_earlier: hasEarlier },
      });
    }
    case 'adhoc_ack': {
      // AdHoc 三票并一之二 — 消账: 学习者说"不用回了"或 agent 判断无需回应
      // 时把 thread 的 pending 游标挪到某条消息 (缺省=最新一条)。三处退场
      // 判定共享 lib/live-wait.ts isAdhocMessageOutstanding (见其头注)。
      const ackThreadId = requireStringArg(args, 'thread_id');
      const [ackThread] = await db
        .select()
        .from(ad_hoc_threads)
        .where(eq(ad_hoc_threads.id, ackThreadId))
        .limit(1);
      if (!ackThread) throw notFoundError(`Thread ${ackThreadId} not found`, { thread_id: ackThreadId });

      let ackTarget = args.message_id as string | undefined;
      if (ackTarget) {
        const [ackMsg] = await db
          .select()
          .from(ad_hoc_messages)
          .where(eq(ad_hoc_messages.id, ackTarget))
          .limit(1);
        if (!ackMsg) throw notFoundError(`Message ${ackTarget} not found`, { message_id: ackTarget });
        if (ackMsg.thread_id !== ackThreadId) {
          throw validationError(
            `Message ${ackTarget} belongs to thread ${ackMsg.thread_id}, not ${ackThreadId}`,
            { thread_id: ackThreadId, message_id: ackTarget }
          );
        }
      } else {
        const [latestMsg] = await db
          .select()
          .from(ad_hoc_messages)
          .where(eq(ad_hoc_messages.thread_id, ackThreadId))
          .orderBy(desc(ad_hoc_messages.created_at))
          .limit(1);
        if (!latestMsg) {
          return success({
            operation: 'adhoc_ack',
            resource_id: ackThreadId,
            human_note: `Thread ${ackThreadId} has no messages yet — nothing to ack.`,
          });
        }
        ackTarget = latestMsg.id;
      }

      await db
        .update(ad_hoc_threads)
        .set({ acked_message_id: ackTarget })
        .where(eq(ad_hoc_threads.id, ackThreadId));

      return success({
        operation: 'adhoc_ack',
        resource_id: ackThreadId,
        created_refs: { thread_id: ackThreadId, acked_message_id: ackTarget },
        human_note: `Thread ${ackThreadId} acked through message ${ackTarget} — it drops out of pending/bridge events until a newer message arrives; the message itself stays readable via adhoc_thread_get.`,
      });
    }
    case 'adhoc_message_send': {
      // (bench run 0) — thread_id must be validated BEFORE the
      // first query touches it: the MCP SDK doesn't enforce inputSchema
      // `required`, and eq(col, undefined) crashes postgres-js with
      // UNDEFINED_VALUE (see lib/tool-args.ts header for drizzle's per-
      // position semantics).
      const tid = requireStringArg(args, 'thread_id');
      // Root cause: client_message_id was schema-required but SDK-
      // unenforced, so a candidate omitting it sent undefined into the dedupe
      // select below → UNDEFINED_VALUE, misclassified RETRYABLE, six-retry
      // loop. Now optional-with-default: omitted → server mints an id (no
      // replay dedupe for that call — same opt-in posture as every other
      // tool's idempotency_key).
      const { id: clientId, generated: clientIdGenerated } = resolveClientMessageId(
        args.client_message_id
      );
      // Idempotency — this tool already had its own caller-supplied-key
      // mechanism (client_message_id + unique index) before this batch;
      // left as-is rather than layered under the generic idempotency_keys
      // table too, to avoid two competing dedupe mechanisms on one tool.
      // Skip the dedupe select entirely for a server-minted id — it can't
      // collide with anything by construction.
      if (!clientIdGenerated) {
        const existing = await db
          .select()
          .from(ad_hoc_messages)
          .where(eq(ad_hoc_messages.client_message_id, clientId))
          .limit(1);
        if (existing.length > 0) {
          return success({
            operation: 'adhoc_message_send',
            resource_id: existing[0]!.id,
            idempotent_replay: true,
            human_note: `Message already exists: ${existing[0]!.id}`,
          });
        }
      }
      // Hard stop on archived threads — archiving is a privacy
      // boundary, not just a front-end filter. No silent redirect: an agent
      // that believes it wrote into thread `tid` must not be quietly rerouted
      // to a different thread without knowing its message never landed there.
      const [targetThread] = await db
        .select()
        .from(ad_hoc_threads)
        .where(eq(ad_hoc_threads.id, tid))
        .limit(1);
      if (!targetThread) throw notFoundError(`Thread ${tid} not found`, { thread_id: tid });
      if (targetThread.archived_at) {
        throw conflictError(
          `Thread ${tid} is archived (archived_at=${targetThread.archived_at.toISOString()}). ` +
            'Call adhoc_thread_get again to obtain the active thread before sending.',
          { thread_id: tid, archived_at: targetThread.archived_at.toISOString() }
        );
      }
      const id = genId('ahm');
      const now = new Date();
      const [row] = await db
        .insert(ad_hoc_messages)
        .values({
          id,
          thread_id: tid,
          role: 'agent',
          content: (args.content as string) ?? '',
          // 勘误: 最初的探针打在这一行, 但 .values() 里的 undefined 被
          // drizzle 映射为 SQL DEFAULT (此列 nullable 无默认 → NULL), 从不触发
          // UNDEFINED_VALUE — 真正的雷是上面 dedupe select 的
          // eq(client_message_id, undefined) (query 参数位是唯一致命位, 见
          // lib/tool-args.ts). `?? null` 保留作显式化, 行为等价.
          payload: (args.payload as AdHocPayload | undefined) ?? null,
          context_snapshot:
            (args.context_snapshot as AdHocContextSnapshot | undefined) ??
            ({ page: 'agent' } as unknown as AdHocContextSnapshot),
          is_learning_related: (args.is_learning_related as boolean | undefined) ?? false,
          client_message_id: clientId,
          created_at: now,
        })
        .returning();
      // Bump thread activity + count.
      await db
        .update(ad_hoc_threads)
        .set({
          last_activity_at: now,
          message_count: sql`${ad_hoc_threads.message_count} + 1`,
        })
        .where(eq(ad_hoc_threads.id, tid));
      return success({
        operation: 'adhoc_message_send',
        resource_id: row?.id,
        created_refs: { message_id: row?.id ?? id, thread_id: tid, client_message_id: clientId },
        human_note: `Message ${row?.id} appended to thread ${tid}${clientIdGenerated ? ' (client_message_id omitted — server generated one; supply your own uuid to get retry dedupe)' : ''}`,
      });
    }
    case 'live_session_get': {
      const sid = requireStringArg(args, 'session_id');
      const [sess] = await db.select().from(live_sessions).where(eq(live_sessions.id, sid)).limit(1);
      if (!sess) throw notFoundError(`session ${sid} not found`, { session_id: sid });
      const moves = await db
        .select()
        .from(teaching_moves)
        .where(eq(teaching_moves.session_id, sid))
        .orderBy(asc(teaching_moves.seq));
      const responses = await db
        .select()
        .from(teaching_responses)
        .where(eq(teaching_responses.session_id, sid))
        .orderBy(asc(teaching_responses.created_at));
      return success({
        operation: 'live_session_get',
        resource_id: sid,
        human_note: `Session ${sid}: ${moves.length} move(s), ${responses.length} response(s).`,
        // 值更契约全路径暴露 (件一) — session 级 may_end_turn: 终态会话
        // (completed/cancelled/expired) 才 true。
        live_runtime_contract: buildLiveRuntimeContract(isTerminalLiveSessionStatus(sess.status)),
        contract_version: liveRuntimeContractVersion(),
        data: { session: sess, moves, responses },
      });
    }
    case 'live_message_send': {
      const idempotencyKey = args.idempotency_key as string | undefined;
      // session_id reaches the max-seq select's eq() (lethal as
      // undefined); move_type/response_kind/content are schema-required.
      const sid = requireStringArg(args, 'session_id');
      const moveContent = requireStringArg(args, 'content');
      const moveTypeRaw = requireStringArg(args, 'move_type');
      // 案①修复 — 此前是纯 `as MoveType` 类型断言, 编译期看着
      // 有类型, 运行期对任意字符串照单全收 (bench 库 10 行 ACK move 就是
      // 这么落库的)。这里补运行时白名单, 非法值结构化拒收, 不再靠调用方
      // 老实。MOVE_TYPES 是 packages/contracts 里与 MoveType 手动同步的
      // 唯一真源 (见该文件头注), DB 层另有 0028 迁移的 CHECK NOT VALID 兜底。
      if (!MOVE_TYPES.includes(moveTypeRaw as MoveType)) {
        throw validationError(
          `move_type must be one of the 7 types (${MOVE_TYPES.join('/')}). A presence confirmation is not a move — don't send ACK-style messages; see the response contract in docs/recipes/live-teaching.md.`,
          { move_type: moveTypeRaw }
        );
      }
      const moveType = moveTypeRaw as MoveType;
      const respKind = requireStringArg(args, 'response_kind') as ResponseKind;
      // Validation parity with REST.
      if ((moveType === 'ASK' || moveType === 'PROBE' || moveType === 'CHALLENGE') && respKind !== 'text') {
        throw validationError(`${moveType} requires response_kind='text'`);
      }
      if (moveType === 'REFLECT' && respKind !== 'none') {
        throw validationError(`REFLECT requires response_kind='none'`);
      }
      return runIdempotentMutation(pairId, 'live_message_send', idempotencyKey, args, async () => {
        const [maxRow] = await db
          .select({ max: sql<number>`coalesce(max(${teaching_moves.seq}), 0)` })
          .from(teaching_moves)
          .where(eq(teaching_moves.session_id, sid));
        const seq = (maxRow?.max ?? 0) + 1;
        // 红队 (2026-07-20)——"seq 1 若不是 FRAME 直接拒绝, 而不是只在 start
        // 回执里建议"。live_session_start 的 next_expected:'FRAME' 只是软提示
        // (agent 可以不看), 这里补硬校验: 会话首个 move 结构化拒绝非 FRAME,
        // 错误里带合法示例, 不让 agent 靠自觉。
        if (seq === 1 && moveType !== 'FRAME') {
          throw validationError(
            "The session's first move (seq=1) must be move_type='FRAME' — FRAME's content must cover three things: " +
              'what this session will do / roughly how long / what counts as done. Example: {"move_type":"FRAME","content":"We\'ll go through three steps this session: first review the three categories of indirect-method adjustments (about 10 minutes), then you work through a cash flow statement independently — getting it right wraps up the session.","response_kind":"none"}.',
            { move_type: moveType, seq }
          );
        }
        const id = genId('tm');
        const now = new Date();
        await db
          .insert(teaching_moves)
          .values({
            id,
            session_id: sid,
            seq,
            move_type: moveType,
            content: moveContent,
            response_kind: respKind,
            payload: args.payload as Record<string, unknown> | undefined,
            source_type: args.source_type as string | undefined,
            source_id: args.source_id as string | undefined,
            created_at: now,
          })
          .returning();
        const nextAwaiting: AwaitingRole =
          moveType === 'REFLECT' && respKind === 'none'
            ? 'none'
            : respKind === 'none'
              ? 'agent'
              : 'learner';
        await db
          .update(live_sessions)
          .set({ awaiting_role: nextAwaiting, last_activity_at: now })
          .where(eq(live_sessions.id, sid));
        // 逐 move 指路, 按 awaiting 状态机说话, 不留
        // "FRAME 发完是不是就能挂等待"的缝:
        //   awaiting='agent'   → 轮次仍在老师手上 (response_kind='none' 的 move
        //     不交轮), 下一步是发下一个 move (开场 FRAME 之后即 ASK)——此刻挂
        //     live_wait 等不来任何事件 (computeBridgeWaitEvents 对
        //     awaiting='agent' 的会话不产事件, 见 lib/live-wait.ts 头注)。
        //   awaiting='learner' → 这一拍轮到她, 挂 live_wait/看门脚本等作答。
        //   awaiting='none'    → REFLECT 已收口, 下一步收课 (live_session_
        //     complete; 收课握手须在她明确表态收课之后)。
        const nextRequiredAction =
          nextAwaiting === 'agent'
            ? moveType === 'FRAME'
              ? 'send_ASK'
              : 'send_next_move'
            : nextAwaiting === 'learner'
              ? 'wait_for_learner_response'
              : 'live_session_complete';
        const turnNote =
          nextAwaiting === 'agent'
            ? moveType === 'FRAME'
              ? '轮次仍在你手上——FRAME 不交轮, 下一步发 ASK 把问题递出去; 现在挂等待等不来事件'
              : '轮次仍在你手上 (response_kind=none 不交轮)——继续发下一个 move; 现在挂等待等不来事件'
            : nextAwaiting === 'learner'
              ? '轮到学习者作答——挂 live_wait/看门脚本等她'
              : 'REFLECT 已收口——她明确表态收课后 live_session_complete';
        return buildSuccessEnvelope({
          operation: 'live_message_send',
          resource_id: id,
          created_refs: { move_id: id, session_id: sid },
          next_required_action: nextRequiredAction,
          human_note: `Move ${id} appended (seq=${seq}, awaiting=${nextAwaiting}) · ${turnNote}`,
        });
      });
    }
    case 'live_session_complete': {
      const idempotencyKey = args.idempotency_key as string | undefined;
      // session_id reaches the update's where-eq() (lethal as undefined).
      const sid = requireStringArg(args, 'session_id');
      // REFLECT 三段全部必填 — a session "completed" with a blank field is a
      // silent brief hole (summary/teacher_reflection/next_action all feed
      // the learner brief downstream). trim() so whitespace-only doesn't sneak
      // through requireStringArg's non-empty check.
      const completeSummary = requireStringArg(args, 'summary').trim();
      const completeTeacherReflection = requireStringArg(args, 'teacher_reflection').trim();
      const completeNextAction = requireStringArg(args, 'next_action').trim();
      if (!completeSummary || !completeTeacherReflection || !completeNextAction) {
        throw validationError(
          'summary / teacher_reflection / next_action must all be non-empty strings (after trimming whitespace) — ' +
            `missing: ${[
              !completeSummary ? 'summary' : null,
              !completeTeacherReflection ? 'teacher_reflection' : null,
              !completeNextAction ? 'next_action' : null,
            ]
              .filter(Boolean)
              .join(', ')}.`
        );
      }
      // 一次判决 — 可选 evaluation 随行: 收课同笔写这场的场评 (与
      // record_live_evaluation 同一落表 live_session_evaluations, 一场一评),
      // 收课+场评从此是一次写作动作。前置校验放在幂等包裹之外, 结构坏了直接拒。
      const completeEvalRaw = args.evaluation;
      let completeEvalInput: {
        agent_observation: string;
        learner_note: string | null;
        evidence_refs: string[] | null;
        concepts_touched: string[];
        live_turns_count: number | null;
        duration_minutes: number | null;
      } | null = null;
      if (completeEvalRaw !== undefined) {
        if (completeEvalRaw === null || typeof completeEvalRaw !== 'object' || Array.isArray(completeEvalRaw)) {
          throw validationError('evaluation must be an object if present — see live_session_complete inputSchema.', {
            field: 'evaluation',
          });
        }
        const evalArgs = completeEvalRaw as Record<string, unknown>;
        const evalObservation = typeof evalArgs.agent_observation === 'string' ? evalArgs.agent_observation.trim() : '';
        if (!evalObservation) {
          throw validationError('evaluation.agent_observation is required (non-empty) when evaluation is provided.', {
            field: 'evaluation.agent_observation',
          });
        }
        const completeLearnerNote =
          typeof evalArgs.learner_note === 'string' && evalArgs.learner_note.trim()
            ? evalArgs.learner_note.trim()
            : null;
        const completeEvidenceRefs = validateOptionalStringArrayArg(evalArgs, 'evidence_refs') ?? null;
        completeEvalInput = {
          agent_observation: evalObservation,
          learner_note: completeLearnerNote,
          evidence_refs: completeEvidenceRefs,
          concepts_touched: validateOptionalStringArrayArg(evalArgs, 'concepts_touched') ?? [],
          live_turns_count: typeof evalArgs.live_turns_count === 'number' ? evalArgs.live_turns_count : null,
          duration_minutes: typeof evalArgs.duration_minutes === 'number' ? evalArgs.duration_minutes : null,
        };
      }
      return runIdempotentMutation(pairId, 'live_session_complete', idempotencyKey, args, async () => {
        const [current] = await db
          .select()
          .from(live_sessions)
          .where(eq(live_sessions.id, sid))
          .limit(1);
        if (!current) throw notFoundError(`Session ${sid} not found`, { session_id: sid });

        // 一场一评 (live_session_id 唯一索引, 与 record_live_evaluation 同一
        // 纪律): 已有场评就幂等复用, 不二次写入、不覆盖。返回 null = 本次调用
        // 没带 evaluation。
        const writeEvaluationIfRequested = async (): Promise<{ evaluation_id: string; reused: boolean } | null> => {
          if (!completeEvalInput) return null;
          const [existingEval] = await db
            .select()
            .from(live_session_evaluations)
            .where(eq(live_session_evaluations.live_session_id, sid))
            .limit(1);
          if (existingEval) return { evaluation_id: existingEval.id, reused: true };
          // 三通道 evidence_refs 硬闸: 逐 id 验存在+归属, 幽灵拒。
          if (completeEvalInput.evidence_refs?.length) {
            await assertEvidenceRefs(pairId, completeEvalInput.evidence_refs, 'evaluation.evidence_refs');
          }
          const eid = genId('lse');
          await db.insert(live_session_evaluations).values({
            id: eid,
            pair_id: pairId,
            live_session_id: sid,
            concepts_touched: completeEvalInput.concepts_touched,
            live_turns_count: completeEvalInput.live_turns_count,
            duration_minutes: completeEvalInput.duration_minutes,
            agent_observation: completeEvalInput.agent_observation,
            learner_note: completeEvalInput.learner_note,
            evidence_refs: completeEvalInput.evidence_refs,
          });
          return { evaluation_id: eid, reused: false };
        };

        // 终态单向化 — REST 与 MCP 共用同一个状态机 guard (lib/
        // live-session-transitions.ts, 单一真相源): active → completed 合法
        // (proceed); cancelled/expired → completed 在 assertLiveTransition 里
        // 被 CONFLICT 拒掉 (终态互斥, 不可逆); completed → completed 幂等
        // no-op (下面这支)——ended_at 永远保留首次值, 不许后来的 complete
        // 调用悄悄改写"这节课到底哪一刻结束的"。带 evaluation 且该场还没有
        // 场评时, 场评仍会补写 (session 更新成功但场评落库前中断的重试路径,
        // 不能因为 session 已 completed 就把场评吞掉)。
        // 二期 下课铃门禁 (迁移 0042) — 状态机 guard 之上的新一层
        // (终态锁归 live-session-transitions 本体, 宣告门归 lib/
        // learner-close-declaration): 学习者尚未按铃 ⇒ CONFLICT, 不收官。
        // 放在 noop 分流之后 —— 已 completed 的幂等重放不受此门 (门只拦
        // 第一次收官, 不追溯拦铃诞生之前就完成的历史场); cancel 也不受此门
        // (取消≠收官)。
        const completeTransition = assertLiveTransition(current.status, 'completed');
        if (completeTransition === 'proceed') {
          assertLearnerCloseDeclared(current.learner_close_declared_at, sid);
        }
        if (completeTransition === 'noop') {
          const evalResult = await writeEvaluationIfRequested();
          return buildSuccessEnvelope({
            operation: 'live_session_complete',
            resource_id: sid,
            ...(evalResult
              ? { created_refs: { evaluation_id: evalResult.evaluation_id, live_session_id: sid } }
              : {}),
            human_note:
              `Session ${sid} was already completed at ${current.ended_at?.toISOString() ?? '(unknown)'} — ` +
              'this call is an idempotent replay, unchanged.' +
              (evalResult
                ? evalResult.reused
                  ? ` This session already has an evaluation (${evalResult.evaluation_id}); one evaluation per session, not written twice.`
                  : ` Evaluation ${evalResult.evaluation_id} was backfilled.`
                : ''),
          });
        }

        const now = new Date();
        const [row] = await db
          .update(live_sessions)
          .set({
            status: 'completed',
            awaiting_role: 'none',
            summary: completeSummary,
            teacher_reflection: completeTeacherReflection,
            next_action: completeNextAction,
            ended_at: now,
            last_activity_at: now,
          })
          .where(eq(live_sessions.id, sid))
          .returning();
        if (!row) throw notFoundError(`Session ${sid} not found`, { session_id: sid });

        // 一次判决 — evaluation 随行落库 (session 更新之后写, 保持
        // record_live_evaluation 的前置语义: 场评只挂在 completed 的场上)。
        const evalResult = await writeEvaluationIfRequested();

        // 随行回执 — 场评已写且本场挂着一节课时, 顺手带上闭环进度 (与
        // record_live_evaluation 的回执纪律一致)。
        const completeLessonId = row.context_type === 'lesson' ? row.context_id : undefined;

        // 件二 (get_lesson_closure_state) 落地后改口: 先指 record_live_
        // evaluation (这场课本身的现场评估, 最贴近的下一步), 再指
        // get_lesson_closure_state (它会把批改/总评/反思/receipts 缺口和
        // 预填 id 一次串给你, 不必再猜 record_post_lesson_evaluation 还是
        // reflect_on_teaching 哪个该先来)。此后: evaluation 已随行写入时
        // 场评不再是缺口, 不推荐 record_live_evaluation。
        return buildSuccessEnvelope({
          operation: 'live_session_complete',
          resource_id: sid,
          ...(evalResult
            ? { created_refs: { evaluation_id: evalResult.evaluation_id, live_session_id: sid } }
            : {}),
          next_recommended_actions: evalResult
            ? ['get_lesson_closure_state']
            : ['record_live_evaluation', 'get_lesson_closure_state'],
          ...(evalResult && completeLessonId
            ? { closure_progress: toClosureProgress(await computeLessonClosureProgress(pairId, completeLessonId)) }
            : {}),
          human_note:
            `Session ${sid} completed` +
            (evalResult
              ? evalResult.reused
                ? ` — this session already has an evaluation (${evalResult.evaluation_id}); one evaluation per session, not written twice`
                : ` — evaluation ${evalResult.evaluation_id} written in the same call (one-verdict principle)`
              : ''),
        });
      });
    }
    case 'live_session_cancel': {
      const idempotencyKey = args.idempotency_key as string | undefined;
      // session_id reaches the update's where-eq() (lethal as undefined).
      const sid = requireStringArg(args, 'session_id');
      return runIdempotentMutation(pairId, 'live_session_cancel', idempotencyKey, args, async () => {
        // 终态单向化 — 同 live_session_complete, 过同一个状态机 guard
        // (lib/live-session-transitions.ts): active → cancelled 合法;
        // completed/expired → cancelled 被 CONFLICT 拒掉 (终态互斥, 不可逆);
        // cancelled → cancelled 幂等 no-op, 不重写 ended_at、不追加事件。
        const [current] = await db
          .select()
          .from(live_sessions)
          .where(eq(live_sessions.id, sid))
          .limit(1);
        if (!current) throw notFoundError(`Session ${sid} not found`, { session_id: sid });
        const cancelTransition = assertLiveTransition(current.status, 'cancelled');
        if (cancelTransition === 'noop') {
          return buildSuccessEnvelope({
            operation: 'live_session_cancel',
            resource_id: sid,
            human_note:
              `Session ${sid} was already cancelled at ${current.ended_at?.toISOString() ?? '(unknown)'} — ` +
              'this call is an idempotent replay, ended_at unchanged.',
          });
        }
        const now = new Date();
        const [row] = await db
          .update(live_sessions)
          .set({ status: 'cancelled', awaiting_role: 'none', ended_at: now, last_activity_at: now })
          .where(eq(live_sessions.id, sid))
          .returning();
        if (!row) throw notFoundError(`Session ${sid} not found`, { session_id: sid });
        return buildSuccessEnvelope({
          operation: 'live_session_cancel',
          resource_id: sid,
          human_note: `Session ${sid} cancelled`,
        });
      });
    }
    case 'live_session_start': {
      const idempotencyKey = args.idempotency_key as string | undefined;
      // context_type/context_id are NOT NULL values-only
      // (undefined → SQL DEFAULT → not-null violation, no crash), validated
      // for precise errors.
      const startContextType = requireStringArg(args, 'context_type') as LiveContextType;
      const startContextId = requireStringArg(args, 'context_id');
      return runIdempotentMutation(pairId, 'live_session_start', idempotencyKey, args, async () => {
        // 开课原子去重 (红队第六轮针一, 2026-07-20) — 同 (pair, context_type,
        // context_id) 已有 active 教室就直接送进去, 不开第二间。学习者裁决
        // (7/20): 学习者侧 Start Session 按钮已退役, 开课正门收窄到这个 MCP
        // 工具一处, 竞态已从入口结构上大半消除——这条查询+索引兜底仍照做,
        // 当作保险带 (route 侧仍留着同语义的第二个写入路径, 见 routes/
        // teaching.ts POST /sessions 头注)。
        const joined = (existing: LiveSessionRow) =>
          buildSuccessEnvelope({
            operation: 'live_session_start',
            resource_id: existing.id,
            created_refs: { session_id: existing.id },
            learner_url: `/sessions/${existing.id}`,
            joined_existing: true,
            live_runtime_contract: buildLiveRuntimeContract(false),
            contract_version: liveRuntimeContractVersion(),
            human_note: `This room is already open — routing you into it (session ${existing.id}, context_type=${existing.context_type}).`,
          });

        const existing = await findActiveLiveSessionForContext(pairId, startContextType, startContextId);
        if (existing) return joined(existing);

        const id = genId('ls');
        const now = new Date();
        let row: LiveSessionRow | undefined;
        try {
          [row] = await db
            .insert(live_sessions)
            .values({
              id,
              pair_id: pairId,
              context_type: startContextType as never,
              context_id: startContextId,
              context_preview: args.context_preview as string | undefined,
              goal: args.goal as string | undefined,
              status: 'active',
              awaiting_role: 'agent',
              started_at: now,
              last_activity_at: now,
            })
            .returning();
        } catch (e) {
          // 兜底路径: 上面那次查询之后、这次 insert 之前, 另一侧真的抢先开成了
          // 同一间教室 —— 迁移 0036 的部分唯一索引拦下这次写, postgres-js 抛
          // 23505 (dbCode 直接挂在 e.code 上, 同 tool-envelope.ts classifyThrown
          // 的既定读法)。回查既有行, 当成功返回, 不让这个异常冒泡成一次失败的
          // live_session_start。
          if ((e as { code?: unknown } | null | undefined)?.code === '23505') {
            const raced = await findActiveLiveSessionForContext(pairId, startContextType, startContextId);
            if (raced) return joined(raced);
          }
          throw e;
        }
        return buildSuccessEnvelope({
          operation: 'live_session_start',
          resource_id: id,
          created_refs: { session_id: id },
          // α批四针 (2026-07-20) — apps/web/src/App.tsx 的
          // /sessions/:sessionId 路由。
          learner_url: `/sessions/${id}`,
          // 软牌 — 提示, 不硬拦: 新 session 的首个 move 应该是 FRAME。
          next_expected: 'FRAME',
          // 值更契约全路径暴露 (件一) — next_expected 是软牌, next_required_
          // action 是硬指令: 新会话刚开, 义务不能就地卸下 (may_end_turn:false)。
          // 旧值 'send_FRAME_then_wait' 是状态机嘴瓢:
          // FRAME 是 response_kind='none' 的 move, 落地后 awaiting 仍是 agent,
          // 此刻挂等待等不来任何事件 (computeBridgeWaitEvents 对
          // awaiting='agent' 的会话不产事件, 见 lib/live-wait.ts 头注)。轮次要
          // 到 ASK 把问题递出去、awaiting 转给 learner 之后才轮到等待——
          // live_message_send 的回执 (同批修) 会在每个 move 落地后按 awaiting
          // 状态机继续指路。
          next_required_action: 'send_FRAME_then_ASK',
          live_runtime_contract: buildLiveRuntimeContract(false),
          contract_version: liveRuntimeContractVersion(),
          human_note: `Started session ${id} (context_type=${row?.context_type}) · first move should be FRAME (see recipe://live-teaching)`,
        });
      });
    }
    default:
      throw validationError(`Unknown tool: ${name}`);
  }
}

// ============================================================================
// Prompts — skill files distributed as MCP Prompts (TEACHING-SPEC §1 round 3)
//
// Two shapes of prompts:
//   1. Individual skill — name = `<category>/<skill-name>`, returns one .md
//      file content. Use this to inspect a single facet.
//   2. Composite — name = `_stack`, server picks the right skills for active
//      contract and returns the combined system-prompt prefix. Agent should
//      pull this once at session start.
// ============================================================================
// Single source of truth for the prompt registry — used by ListPromptsRequestSchema
// below and by manifest://capabilities (buildCapabilityManifest, defined in the
// Resources section above; function declarations hoist, so the forward reference
// from there to this one is safe).
async function buildPromptDefinitions(): Promise<
  { name: string; description: string; arguments: never[] }[]
> {
  const skills = await listAllSkills();
  return [
    {
      name: '_stack',
      description:
        'Composite skill stack picked by server based on the currently active TeachingContract. ' +
        'Pull this once at session start to get the full system-prompt prefix (domain + modality + intensity + pace).',
      arguments: [],
    },
    ...skills.map((s) => ({
      name: `${s.category}/${s.name}`,
      description: `Teaching skill (${s.category}): ${s.name} — from <learn-shell>/skills/${s.category}/${s.name}.md`,
      arguments: [],
    })),
  ];
}

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: await buildPromptDefinitions(),
}));

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  const name = req.params.name;

  // Composite stack
  if (name === '_stack') {
    const stack = await pickSkillStack();
    const parts: string[] = [];
    for (const s of stack) {
      const content = await loadSkill(s.category, s.name);
      if (content) {
        parts.push(`# Skill: ${s.category}/${s.name}\n\n${content}`);
      }
    }
    const combined = parts.length
      ? parts.join('\n\n---\n\n')
      : '# No active contract\n\nNo skill stack picked (no active TeachingContract found).';
    return {
      description: `Learn Shell skill stack — composed for active contract (${stack
        .map((s) => `${s.category}/${s.name}`)
        .join(' + ')})`,
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: combined },
        },
      ],
    };
  }

  // Individual skill — name = "category/skill-name"
  const slash = name.indexOf('/');
  if (slash < 0) {
    throw new Error(
      `Invalid skill prompt name: '${name}'. Expected '<category>/<name>' or '_stack'.`
    );
  }
  const category = name.slice(0, slash) as SkillCategory;
  const skillName = name.slice(slash + 1);
  if (!SKILL_CATEGORIES.includes(category)) {
    throw new Error(
      `Unknown skill category: '${category}'. Must be one of ${SKILL_CATEGORIES.join(' / ')}.`
    );
  }
  const content = await loadSkill(category, skillName);
  if (!content) {
    throw new Error(`Skill not found: ${name}`);
  }
  return {
    description: `Learn Shell teaching skill: ${name}`,
    messages: [
      {
        role: 'user',
        content: { type: 'text', text: content },
      },
    ],
  };
});

// ============================================================================
// Start
// ============================================================================
const transport = new StdioServerTransport();
await server.connect(transport);
// stdio transport prints nothing on connect (would corrupt JSON-RPC).
// Use stderr for diagnostics if needed:
process.stderr.write('[learn-shell mcp] connected via stdio\n');
