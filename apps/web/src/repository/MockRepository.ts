// MockRepository — W1+round 2.
//
// 接 TEACHING-SPEC-v1 §7 全部 read + mutation 接口. localStorage 持久化,
// 刷新页面不丢. 用 fixture 作为初始 seed; 任何 mutation 写回 localStorage.
//
// W2+ 接 HttpRepository (Hono REST + MCP) 时, 这个文件保持作为 'mock' 模式
// 留 dev 用; 真后端是 'live' 模式.

import type {
  Repository,
  TeachingContract,
  ContractId,
  PairId,
  LearnerId,
  Exercise,
  ExerciseSubmission,
  ExerciseSubmissionId,
  ExerciseId,
  Mindmap,
  MindmapId,
  MindmapContent,
  MindmapAssociation,
  MindmapAssociationTargetType,
  MindmapNode,
  PendingMindmapCard,
  PendingCardId,
  QuestionBank,
  QuestionBankId,
  QuizQuestion,
  QuizAttempt,
  QuizAttemptId,
  SimulatedQuiz,
  SimulatedQuizAttempt,
  SimulatedQuizAttemptAnswer,
  SimulatedQuizAttemptId,
  SimulatedQuestion,
  LearnerFeedback,
  Reminder,
  ReminderId,
  PostLessonEvaluation,
  LiveSessionEvaluation,
  LessonId,
  CourseId,
  CourseFootprint,
  SkillRef,
  Course,
  Lesson,
  LiveSession,
  LiveSessionId,
  LiveSessionFullView,
  TeachingMove,
  TeachingMoveId,
  TeachingResponse,
  TeachingResponseId,
  Flashcard,
  FlashcardId,
  LessonAnnotation,
  AnnotationId,
  AdHocThread,
  AdHocThreadId,
  AdHocMessage,
  AdHocMessageId,
  MidLessonSnapshot,
  MidLessonSnapshotId,
  AwaitingRole,
  MoveType,
  ResponseKind,
  LessonProgress,
  LessonPatch,
  LessonLoopReceipt,
  LessonChecklistSnapshot,
  SessionEvent,
} from '@learn-shell/contracts';
import type { SimulatedQuizRepo } from './simulatedQuiz';
import type { JournalRepo } from './journalExt';
import type { FlashcardImportRepo, FlashcardImportDeckResult } from './flashcardImportExt';
import type { LessonAnnotationWithOrphan } from '../annotation/orphan';
import type { ObservationGateRepo, ObservationGateState } from './observationGateExt';
import type { FeedbackLedgerRepo, FeedbackLedgerEntry } from './feedbackLedgerExt';
import type { CalibrationRepo, CalibrationCurve, CalibrationBucket } from './calibrationExt';
import type { BrierTrendRepo, BrierTrendPoint } from './brierTrendExt';
import type { ConfidenceAnchorRepo } from './confidenceAnchorExt';
import type {
  ConfidenceCaptureRepo,
  ExerciseSubmissionWithConfidence,
} from './confidenceCaptureExt';
import type { DocumentRepo } from './documentExt';
import type { Document, DocumentId, DocumentSummary } from '../document/types';
import type { SyllabusRepo, SyllabusSnapshot } from './syllabusExt';
import { AlreadyGradedError, type ProgressRepo } from './progressExt';
import {
  SessionTerminalError,
  type OnboardingRepo,
  type LiveSessionWithClose,
} from './onboardingExt';
import { pickCurrentContract } from './currentContract';
import { cfaIndirectCashFlowFixture } from '../fixtures/cfa-indirect-cash-flow';
import { parseFlashcardMarkdown, normalizeCardFace } from '../lib/flashcardImportParser';
import {
  CONFIDENCE_LEVELS,
  CONFIDENCE_ANCHOR_PCT,
  CONFIDENCE_OBSERVATION_CATEGORY,
  validateConfidenceAnchors,
  type ConfidenceLevel,
  type ConfidenceAnchorConfig,
} from '../lib/confidence';

// 誓言三 (Settings CertificateCard, confidence 可视化视图三) — deterministic
// fake trend, not derived from mock exercise-submission state (brief: "Mock
// 给确定性假数据"). 14 weeks (>12) so both the first-six-week and
// last-six-week baseline bands actually render in dev. Base Monday
// (2024-01-01) is a known Monday — anchor is arbitrary, only its
// weekday-correctness matters.
const BRIER_MOCK_BASE_MONDAY = '2024-01-01';
function mondayPlusWeeks(baseMondayISO: string, weeks: number): string {
  const d = new Date(`${baseMondayISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + weeks * 7);
  return d.toISOString().slice(0, 10);
}
const BRIER_MOCK_TREND: { n: number; brier: number }[] = [
  { n: 6, brier: 0.24 },
  { n: 8, brier: 0.21 },
  { n: 7, brier: 0.22 },
  { n: 9, brier: 0.19 },
  { n: 10, brier: 0.17 },
  { n: 8, brier: 0.18 },
  { n: 11, brier: 0.15 },
  { n: 9, brier: 0.14 },
  { n: 12, brier: 0.13 },
  { n: 10, brier: 0.12 },
  { n: 13, brier: 0.11 },
  { n: 11, brier: 0.1 },
  { n: 14, brier: 0.095 },
  { n: 12, brier: 0.09 },
];

/** Mock mode is single-pair (f.pair.id) — gate check mirrors
 *  apps/server/src/lib/observation-gate.ts's isConfidenceCaptureAllowed. */
function mockConfidenceCaptureAllowed(): boolean {
  return (
    state.confidenceModeEnabled &&
    !state.forbiddenObservations.includes(CONFIDENCE_OBSERVATION_CATEGORY)
  );
}

// Learner Model 批1 — simulated quiz answers
// locally widened with optional confidence fields (packages/contracts'
// SimulatedQuizAttemptAnswer stays untouched, same reasoning as
// simulatedQuiz.ts's header comment). Exercise submissions get the same
// treatment via ExerciseSubmissionWithConfidence (confidenceCaptureExt.ts).
type SimulatedQuizAttemptAnswerWithConfidence = SimulatedQuizAttemptAnswer & {
  confidence?: ConfidenceLevel;
  confidence_pct?: number;
};
type SimulatedQuizAttemptWithConfidence = Omit<SimulatedQuizAttempt, 'answers'> & {
  answers: SimulatedQuizAttemptAnswerWithConfidence[];
};

const f = cfaIndirectCashFlowFixture;

// ============================================================================
// localStorage helpers
// ============================================================================
const STORAGE_PREFIX = 'learn-shell:mock:v1:';

function load<T>(key: string, seed: T): T {
  if (typeof window === 'undefined') return clone(seed);
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + key);
    if (raw) return JSON.parse(raw) as T;
  } catch {
    /* fall through */
  }
  return clone(seed);
}

function save<T>(key: string, value: T): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
  } catch {
    /* localStorage may be full / disabled — degrade silently */
  }
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

function genId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${ts}${rand}`;
}

// ============================================================================
// Document (批G) mock-mode helpers — small, self-contained duplicates of the
// server's real logic (apps/server/src/lib/document-title.ts /
// annotation-anchor-match.ts). Mock mode has no code-sharing path to the
// server package (browser-only app), so these are deliberately NOT faithful
// ports, just "good enough for the demo/dev fixture" — same trade-off this
// file already makes everywhere else (e.g. pickSkillStackForContract's own
// header comment above).
// ============================================================================
function mockDeriveDocumentTitle(contentMd: string, filename?: string | null): string {
  const lines = contentMd.split('\n');
  let start = 0;
  while (start < lines.length && lines[start]!.trim() === '') start++;
  let body = contentMd;
  if (lines[start]?.trim() === '---') {
    for (let i = start + 1; i < lines.length; i++) {
      if (/^(---|\.\.\.)\s*$/.test(lines[i]!)) {
        const frontmatter = lines.slice(start + 1, i).join('\n');
        const m = frontmatter.match(/^title:\s*(.+)$/m);
        if (m) {
          const v = m[1]!.trim().replace(/^["']|["']$/g, '');
          if (v) return v;
        }
        body = lines.slice(i + 1).join('\n');
        break;
      }
    }
  }
  const h1 = body.split('\n').find((l) => /^#\s+.+/.test(l));
  if (h1) return h1.replace(/^#\s+/, '').trim();
  if (filename) {
    const stripped = filename.replace(/\.(md|txt)$/i, '').trim();
    if (stripped) return stripped;
  }
  const firstLine = body.split('\n').find((l) => l.trim().length > 0);
  return firstLine?.trim() ?? 'Untitled document';
}

/** Best-effort re-anchor of a document's annotations against its new
 *  content — plain substring search (no DOM in mock mode), orphans when the
 *  selected_text no longer appears verbatim. Never deletes a row (永不丢行原则). */
function mockResweepDocument(documentId: string): void {
  const doc = state.documents.find((d) => d.id === documentId);
  if (!doc) return;
  const rows = state.annotations as unknown as LessonAnnotationWithOrphan[];
  const now = new Date().toISOString();
  for (const row of rows) {
    if (row.document_id !== documentId) continue;
    const stillResolves = row.selected_text ? doc.content_md.includes(row.selected_text) : false;
    row.orphaned_at = stillResolves ? null : (row.orphaned_at ?? now);
  }
  persist('annotations');
}

// ============================================================================
// In-memory state (loaded from localStorage on first import, fallback to fixture)
// ============================================================================
interface State {
  contracts: TeachingContract[];
  courses: Course[];
  lessons: Lesson[];
  liveSessions: LiveSession[];
  teachingMoves: TeachingMove[];
  teachingResponses: TeachingResponse[];
  exercises: Exercise[];
  exerciseSubmissions: ExerciseSubmissionWithConfidence[];
  mindmaps: Mindmap[];
  mindmapAssociations: MindmapAssociation[];
  pendingCards: PendingMindmapCard[];
  questionBanks: QuestionBank[];
  quizQuestions: QuizQuestion[];
  quizAttempts: QuizAttempt[];
  simulatedQuizzes: SimulatedQuiz[];
  simulatedQuizAttempts: SimulatedQuizAttemptWithConfidence[];
  feedback: LearnerFeedback[];
  reminders: Reminder[];
  postLessonEvaluations: PostLessonEvaluation[];
  adHocThreads: AdHocThread[];
  adHocMessages: AdHocMessage[];
  midLessonSnapshots: MidLessonSnapshot[];
  flashcards: Flashcard[];
  annotations: LessonAnnotation[];
  // 批G — Documents, empty seed (no fixture
  // needed for a first-run reading module; South wind's real content arrives
  // via 'live' mode's MCP add_document, this mode is dev/demo only).
  documents: Document[];
  // Learner Model 批0/批1 — pair-scoped, but
  // mock mode is single-pair (f.pair.id) so a flat list/pair of values is
  // enough; keyed lookups would be overkill for one fixture pair.
  forbiddenObservations: string[];
  confidenceModeEnabled: boolean;
  confidenceModeChangedAt: string | null;
  // Confidence 主权立法 (学习者裁决版) — 映射权归学习者, mock 镜像同一份
  // pair 级配置(单 pair 演示世界, 同 confidenceModeEnabled 邻近字段先例)。
  confidenceAnchorPct: ConfidenceAnchorConfig;
  // Empty seed (no fixture needed, same
  // "dev/demo only, real content arrives via live mode" call as `documents`
  // above; 'closed'/patches/receipts are teacher-authored via MCP, which
  // mock mode has no path to simulate faithfully).
  lessonProgress: LessonProgress[];
  lessonPatches: LessonPatch[];
  lessonLoopReceipts: LessonLoopReceipt[];
  // 迁移 0030 (State 2.0) — 修订回执制服务端真相的 mock 镜像: lessonId →
  // 已读到的 revision 号 (替换 lesson/revisionSeen.ts 的 localStorage 方案)。
  // 单 pair 演示世界, key 只用 lessonId 足够, 同 lessonProgress 邻近字段的
  // 单 pair 简化先例。
  lessonRevisionSeen: Record<string, number>;
  // 评估两区 (学习者裁决 B) — mock 没有真实 live 现场评估写路径(record_
  // post_lesson_evaluation 的 MCP-only 姊妹工具尚未镜像到这里), 空数组起
  // 步, 同 lessonProgress/lessonPatches 上方注释的 "dev/demo only" 先例。
  liveSessionEvaluations: LiveSessionEvaluation[];
}

const state: State = {
  contracts: load('contracts', [f.contract] as TeachingContract[]),
  courses: load('courses', [f.course] as Course[]),
  lessons: load('lessons', [...f.lessons] as Lesson[]),
  liveSessions: load('liveSessions', [] as LiveSession[]),
  teachingMoves: load('teachingMoves', [] as TeachingMove[]),
  teachingResponses: load('teachingResponses', [] as TeachingResponse[]),
  adHocThreads: load('adHocThreads', [] as AdHocThread[]),
  adHocMessages: load('adHocMessages', [] as AdHocMessage[]),
  midLessonSnapshots: load('midLessonSnapshots', [] as MidLessonSnapshot[]),
  flashcards: load('flashcards', [...f.flashcards] as Flashcard[]),
  // Batch D fixture: 5 colors + 2 orphans, 视觉验证 "我的笔记" / 孤儿区用
  // (真库 lesson_annotations 目前为空 — 施工说明).
  annotations: load('annotations', [...f.annotations] as LessonAnnotation[]),
  documents: load('documents', [] as Document[]),
  exercises: load('exercises', [...f.exercises] as Exercise[]),
  exerciseSubmissions: load(
    'exerciseSubmissions',
    [...f.exerciseSubmissions] as ExerciseSubmissionWithConfidence[]
  ),
  mindmaps: load('mindmaps', [...f.mindmaps] as Mindmap[]),
  mindmapAssociations: load('mindmapAssociations', [...f.mindmapAssociations] as MindmapAssociation[]),
  pendingCards: load('pendingCards', [...f.pendingCards] as PendingMindmapCard[]),
  questionBanks: load('questionBanks', [...f.questionBanks] as QuestionBank[]),
  quizQuestions: load('quizQuestions', [...f.quizQuestions] as QuizQuestion[]),
  quizAttempts: load('quizAttempts', [] as QuizAttempt[]),
  simulatedQuizzes: load('simulatedQuizzes', [...f.simulatedQuizzes] as SimulatedQuiz[]),
  simulatedQuizAttempts: load('simulatedQuizAttempts', [] as SimulatedQuizAttemptWithConfidence[]),
  feedback: load('feedback', [...f.feedback] as LearnerFeedback[]),
  reminders: load('reminders', [...f.reminders] as Reminder[]),
  postLessonEvaluations: load(
    'postLessonEvaluations',
    [...f.postLessonEvaluations] as PostLessonEvaluation[]
  ),
  forbiddenObservations: load('forbiddenObservations', [] as string[]),
  confidenceModeEnabled: load('confidenceModeEnabled', true),
  confidenceModeChangedAt: load('confidenceModeChangedAt', null as string | null),
  confidenceAnchorPct: load('confidenceAnchorPct', { ...CONFIDENCE_ANCHOR_PCT } as ConfidenceAnchorConfig),
  lessonProgress: load('lessonProgress', [] as LessonProgress[]),
  lessonPatches: load('lessonPatches', [] as LessonPatch[]),
  lessonLoopReceipts: load('lessonLoopReceipts', [] as LessonLoopReceipt[]),
  lessonRevisionSeen: load('lessonRevisionSeen', {} as Record<string, number>),
  liveSessionEvaluations: load('liveSessionEvaluations', [] as LiveSessionEvaluation[]),
};

function persist<K extends keyof State>(key: K): void {
  save(key, state[key]);
}

// 最近接触 (2026-07-30) — mock 侧不保留事件日志 (recordLearningEvent 是 no-op,
// 见下), 但 Recents 的"最近读过/看过"排序要有个落点, 所以就地记一张
// id → ISO 时间戳 的内存表。刻意不进 State/localStorage: 刷新即回落到
// updated_at 排序, 与服务端"没有 viewed 事件就回落存量排序"是同一条规则。
const viewedAt = new Map<string, string>();
/** 取"最近接触"排序键 = max(实体自己的 updated_at, 最近一次 viewed)。 */
function touchedAt(id: string, updated_at: string | null | undefined): string {
  const viewed = viewedAt.get(id) ?? '';
  const updated = updated_at ?? '';
  return viewed > updated ? viewed : updated;
}

// 最近接触二期 (2026-07-30) — 上面那张表只够 documents/mindmaps 用: 那两行读
// 的是"已排好序的列表"。Lesson 行和 Review 行读的是事件本身 (getSessionEvents
// 里找最新的 lesson.viewed / review.viewed), 排序表接不住, 所以 mock 侧补一
// 条真的内存事件日志, 挂到 fixture 那场 session 上。
// 同样刻意不落 localStorage: 刷新即清空, 回落到"没有 viewed 事件"的存量路径,
// 与服务端语义一致。只收这两种类型 —— 其余事件 mock 仍旧不记 (见
// recordLearningEvent 的注释)。
const mockViewedEvents: SessionEvent[] = [];

// Expose a way for tests / dev console to wipe persistence
export function __resetMockStorage(): void {
  if (typeof window === 'undefined') return;
  for (const k of Object.keys(state)) {
    window.localStorage.removeItem(STORAGE_PREFIX + k);
  }
}

// ============================================================================
// Mock latency helpers (so async-grading 等流程看得到 lag)
// ============================================================================
function tick(ms = 0): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================================
// Skill stack picker
//
// TODO (stage 7+): extract into a shared package so server.ts and
// MockRepository use the same source-of-truth. For now: duplicate the logic
// here for mock-mode, server.ts has its own copy.
//
// Returns the skills LS freezes onto a TeachingContract at Establish time.
// Stage 6a omits the `pace` facet because contract.pace (daily/weekly/
// flexible) doesn't map cleanly onto the existing pace/*.md filenames
// (morning-burst / evening-deep / lunch-quick) — that alignment is a later
// stage's job (rename pace skill files + map by contract.pace).
// ============================================================================
function pickSkillStackForContract(
  input: Pick<TeachingContract, 'goal' | 'intensity' | 'content_modality'>
): SkillRef[] {
  const stack: SkillRef[] = [];

  // workflow — unconditional first; orchestrator for the whole stack.
  stack.push({ category: 'workflow', name: 'lesson-prep' });

  const goal = (input.goal ?? '').toLowerCase();
  if (/cfa/.test(goal)) {
    stack.push({ category: 'domain', name: 'teach-cfa' });
  } else if (/jlpt|toefl|ielts|japanese|chinese|english|spanish|language/.test(goal)) {
    stack.push({ category: 'domain', name: 'teach-language' });
  } else {
    stack.push({ category: 'domain', name: 'teach-general' });
  }

  if (input.content_modality === 'visual') {
    stack.push({ category: 'modality', name: 'visual-heavy' });
  } else if (input.content_modality === 'text') {
    stack.push({ category: 'modality', name: 'formula-first' });
  }
  // 'mixed' → skip; agent will choose modality fluidly.

  stack.push({
    category: 'intensity',
    name: input.intensity ?? 'standard',
  });

  // verify — unconditional enforcement gate (content-verify); always last.
  stack.push({ category: 'verify', name: 'content-verify' });

  return stack;
}

// ============================================================================
// Repository implementation
// ============================================================================
// ============================================================================
// Mock-mode helpers — small faithful-enough
// ports of the server's own logic (routes/write.ts's synthesizedProgress /
// computeChecklistSnapshot), same "no code-sharing path to the server
// package" trade-off this file already makes everywhere else (see
// mockDeriveDocumentTitle's header comment above).
// ============================================================================
function mockSynthesizedProgress(pairId: string, lessonId: string): LessonProgress {
  return {
    id: null as unknown as string,
    pair_id: pairId as PairId,
    lesson_id: lessonId as LessonId,
    state: 'not_started',
    declared_at: null,
    closed_at: null,
    checklist_snapshot: null,
    prerequisite_skips: [],
    pages_visited: [],
    updated_at: null as unknown as string,
  };
}

function mockComputeChecklistSnapshot(
  lessonId: string,
  pagesInput: { pages_total: number | null; pages_read: number | null },
  extraGaps: string[]
): LessonChecklistSnapshot {
  const exIds = state.exercises.filter((e) => e.lesson_id === lessonId).map((e) => e.id);
  const exercisesTotal = exIds.length;
  const submittedIds = new Set(
    state.exerciseSubmissions
      .filter((s) => exIds.includes(s.exercise_id) && s.status !== 'draft')
      .map((s) => s.exercise_id)
  );
  const exercisesSubmitted = submittedIds.size;

  const gaps = [...extraGaps];
  if (exercisesSubmitted < exercisesTotal) {
    gaps.push(`习题 ${exercisesSubmitted}/${exercisesTotal} 已交 — 还有 ${exercisesTotal - exercisesSubmitted} 道未交`);
  }
  if (
    pagesInput.pages_total !== null &&
    pagesInput.pages_read !== null &&
    pagesInput.pages_read < pagesInput.pages_total
  ) {
    gaps.push(`页面 ${pagesInput.pages_read}/${pagesInput.pages_total} 已读`);
  }

  return {
    pages_total: pagesInput.pages_total,
    pages_read: pagesInput.pages_read,
    exercises_total: exercisesTotal,
    exercises_submitted: exercisesSubmitted,
    gaps,
  };
}

const MockRepository: Repository &
  SimulatedQuizRepo &
  JournalRepo &
  FlashcardImportRepo &
  ObservationGateRepo &
  FeedbackLedgerRepo &
  CalibrationRepo &
  BrierTrendRepo &
  ConfidenceAnchorRepo &
  ConfidenceCaptureRepo &
  DocumentRepo &
  SyllabusRepo &
  ProgressRepo &
  OnboardingRepo = {
  mode: 'mock',

  // -------- pair + contract (read) --------
  async getCurrentPair() {
    return f.pair;
  },
  async getActiveContract(pair_id) {
    // 合同签名态改革 — was `.active` (retired signal); now signed non-terminal
    // setup_status, newest updated_at wins (see repository/currentContract.ts),
    // same semantics as HttpRepository's server-backed answer.
    return pickCurrentContract(state.contracts.filter((c) => c.pair_id === pair_id));
  },
  async getAllContracts(pair_id) {
    return state.contracts.filter((c) => c.pair_id === pair_id);
  },
  async getLearner() {
    return f.learner;
  },
  async getAgent(agent_id) {
    return agent_id === f.agent.id ? f.agent : null;
  },

  // -------- content (read) --------
  async getCourses(pair_id) {
    return state.courses.filter((c) => c.pair_id === pair_id);
  },
  async getCourse(course_id) {
    return state.courses.find((c) => c.id === course_id) ?? null;
  },
  async getCourseFootprint(course_id) {
    if (!state.courses.some((c) => c.id === course_id)) {
      throw new Error(`course ${course_id} not found`);
    }
    const lessonRows = state.lessons.filter((l) => l.course_id === course_id);
    const lessonIds = lessonRows.map((l) => l.id);
    // Mock mode has no standalone `concepts` store (Repository never
    // exposed a Concept read/write surface at all) — Lesson.concept_ids is
    // the only place concept ids live here, so that's the derivation.
    const conceptIds = Array.from(new Set(lessonRows.flatMap((l) => l.concept_ids)));
    const assetIds: string[] = [course_id, ...lessonIds];
    return {
      lessons: lessonIds.length,
      concepts: conceptIds.length,
      exercises: state.exercises.filter((e) => lessonIds.includes(e.lesson_id)).length,
      flashcards: state.flashcards.filter(
        (fc) => fc.concept_id != null && conceptIds.includes(fc.concept_id)
      ).length,
      quizzes: state.simulatedQuizzes.filter((q) => q.course_id === course_id).length,
      // Mock mode has no syllabus_mappings store at all (getSyllabus below
      // always returns an empty tree) — 0 is the honest answer here, same
      // "no fixture tree in mock mode" call as getSyllabus.
      syllabus_mappings: 0,
      mindmap_associations: state.mindmapAssociations.filter((a) => assetIds.includes(a.target_id))
        .length,
    } satisfies CourseFootprint;
  },
  async getLessons(course_id) {
    return state.lessons
      .filter((l) => l.course_id === course_id)
      .sort((a, b) => a.order - b.order);
  },
  async getLatestLessonRevision() {
    // Mock mode has no update_lesson entry point (agent-only tool/REST
    // path) — mock lessons never advance past revision 1, so there is
    // never a revision record to return.
    return null;
  },
  async getLessonRevisions() {
    // Same reasoning as getLatestLessonRevision above — mock lessons never
    // accumulate a lesson_revisions history.
    return [];
  },
  // 迁移 0030 (State 2.0) — 进行中接线: Lesson 页首次打开某课时的幂等 ping。
  // 只在 not_started 时翻一格到 in_progress; 已经 declared/closed 的课不倒退。
  // 迁移 0037 (学习者裁决第三针) — page_index 可选, 并入 pages_visited 足迹
  // 集合(去重, 只增不减), 不受 state 档位限制——镜像 routes/write.ts 同名
  // 端点的逻辑, 见那边的头注。
  async touchLessonProgress(lesson_id, page_index) {
    const pair_id = f.pair.id;
    const idx = state.lessonProgress.findIndex(
      (p) => p.pair_id === pair_id && p.lesson_id === lesson_id
    );
    const now = new Date().toISOString();
    if (idx < 0) {
      state.lessonProgress.push({
        id: genId('lprog'),
        pair_id: pair_id as PairId,
        lesson_id,
        state: 'in_progress',
        declared_at: null,
        closed_at: null,
        checklist_snapshot: null,
        prerequisite_skips: [],
        pages_visited: page_index !== undefined ? [page_index] : [],
        updated_at: now,
      });
      persist('lessonProgress');
      return;
    }
    const cur = state.lessonProgress[idx]!;
    const mergedPagesVisited =
      page_index !== undefined && !cur.pages_visited.includes(page_index)
        ? [...cur.pages_visited, page_index]
        : cur.pages_visited;
    if (cur.state === 'not_started') {
      state.lessonProgress[idx] = {
        ...cur,
        state: 'in_progress',
        pages_visited: mergedPagesVisited,
        updated_at: now,
      };
      persist('lessonProgress');
      return;
    }
    // 已经 in_progress/completed_declared/closed — state 幂等 no-op, 但
    // pages_visited 的并入不受这道闸限制。
    if (mergedPagesVisited !== cur.pages_visited) {
      state.lessonProgress[idx] = { ...cur, pages_visited: mergedPagesVisited, updated_at: now };
      persist('lessonProgress');
    }
  },
  // 修订回执制 (学习者裁决 A) — 服务端真相, 替换 lesson/revisionSeen.ts 的
  // localStorage 方案。只前进, 不回退 (同旧 markRevisionSeen 的防御逻辑)。
  async markRevisionSeen(lesson_id) {
    const lesson = state.lessons.find((l) => l.id === lesson_id);
    const revision = lesson?.revision ?? 1;
    const prev = state.lessonRevisionSeen[lesson_id];
    if (prev == null || prev < revision) {
      state.lessonRevisionSeen[lesson_id] = revision;
      persist('lessonRevisionSeen');
    }
  },

  async getDueReviews(pair_id, limit) {
    if (pair_id !== f.pair.id) return [];
    const now = Date.now();
    const due = state.flashcards
      .filter((c) => c.pair_id === pair_id)
      .filter((c) => !c.paused)
      .filter((c) => new Date(c.fsrs_state.due_at).getTime() <= now)
      .sort(
        (a, b) =>
          new Date(a.fsrs_state.due_at).getTime() - new Date(b.fsrs_state.due_at).getTime()
      );
    return limit ? due.slice(0, limit) : due;
  },
  async getAllFlashcards(pair_id) {
    return state.flashcards.filter((c) => c.pair_id === pair_id);
  },

  // -------- session (read) --------
  async getRecentSessions(pair_id, limit) {
    if (pair_id !== f.pair.id) return [];
    const all = [f.session];
    return limit ? all.slice(0, limit) : all;
  },
  async getSession(session_id) {
    return session_id === f.session.id ? f.session : null;
  },
  async getSessionEvents(session_id) {
    // 最近接触二期: fixture 事件 + 本次会话内 recordLearningEvent 记下的
    // lesson.viewed / review.viewed, 都挂在 fixture 那一场上 (mock 只有一场)。
    return session_id === f.session.id ? [...f.sessionEvents, ...mockViewedEvents] : [];
  },

  // -------- learning evidence (write) --------
  async recordReview(input) {
    const idx = state.flashcards.findIndex((c) => c.id === input.card_id);
    if (idx < 0) throw new Error(`flashcard ${input.card_id} not found`);
    const card = state.flashcards[idx]!;
    const prev = card.fsrs_state;
    const now = new Date();
    // Mock-mode approximation of FSRS (real ts-fsrs runs server-side):
    // Again → relearn in 10 min, others scale stability multiplicatively.
    const mult = { Again: 0.5, Hard: 1.2, Good: 2.5, Easy: 4 }[input.rating];
    const stability = Math.max(0.1, prev.stability * mult);
    const dueMs =
      input.rating === 'Again' ? 10 * 60 * 1000 : Math.max(1, stability) * 24 * 60 * 60 * 1000;
    state.flashcards[idx] = {
      ...card,
      fsrs_state: {
        ...prev,
        stability,
        due_at: new Date(now.getTime() + dueMs).toISOString(),
        last_review_at: now.toISOString(),
        review_count: prev.review_count + 1,
        retrievability: 1,
        lapses: (prev.lapses ?? 0) + (input.rating === 'Again' ? 1 : 0),
      },
      updated_at: now.toISOString(),
    };
    persist('flashcards');
    return state.flashcards[idx]!;
  },
  async recordLearningEvent(input) {
    // Mock mode keeps no live event log — Sessions page reads fixture data.
    // The real write path lives in the HTTP repository / server.
    // 唯一例外 (最近接触, 2026-07-30): document.viewed / mindmap.viewed 这两枚
    // 只服务于 Recents 排序, 记进上面那张内存表, 好让 mock 模式下"读了 A 回来
    // Recents 显 A"与真后端同行为。
    const id =
      input.event_type === 'document.viewed'
        ? (input.payload.document_id as string | undefined)
        : input.event_type === 'mindmap.viewed'
          ? (input.payload.mindmap_id as string | undefined)
          : undefined;
    if (id) viewedAt.set(id, new Date().toISOString());
    // 二期 (同日): Lesson 行/Review 行不读排序好的列表, 读事件本身, 所以这两
    // 种类型还得真的进一条内存事件日志 (见文件上方 mockViewedEvents)。
    if (input.event_type === 'lesson.viewed' || input.event_type === 'review.viewed') {
      const now = new Date().toISOString();
      mockViewedEvents.push({
        ...f.sessionEvents[0]!, // 借 fixture 的信封底 (pair/session/permission 那几栏)
        event_id: `evt_mock_viewed_${mockViewedEvents.length + 1}`,
        event_type: input.event_type,
        actor_type: 'learner',
        recorded_by: 'learner',
        occurred_at: now,
        created_at: now,
        payload: input.payload,
        // 双段 cast: recordLearningEvent 的入参 payload 是自由的
        // Record<string, unknown> (契约就这么定的), 而 SessionEvent 的 payload
        // 是按 event_type 判别的具体形状 —— 两者不重叠, 单段 as 过不去。
        // mock 只是把调用方给什么原样存回去, 不做校验。
      } as unknown as SessionEvent);
    }
  },
  async recordTrialAttempt() {
    // No-op — see recordLearningEvent above.
  },

  // -------- teacher growth (read) --------
  async getHypotheses(pair_id) {
    return pair_id === f.pair.id ? [f.hypothesis] : [];
  },
  async getReflections(pair_id) {
    return pair_id === f.pair.id ? [f.reflection] : [];
  },
  async getPostLessonEvaluations(pair_id) {
    return state.postLessonEvaluations.filter((e) => e.pair_id === pair_id);
  },
  // 评估两区 (学习者裁决 B) — 课级总评, 一课一份 (unique on pair+lesson)。
  async getPostLessonEvaluation(pair_id, lesson_id) {
    return (
      state.postLessonEvaluations.find(
        (e) => e.pair_id === pair_id && e.lesson_id === lesson_id
      ) ?? null
    );
  },
  // 场评 — 单场 live session 的现场评估。Mock 目前没有真实写路径产出这张表
  // 的数据 (record_post_lesson_evaluation 的姊妹 MCP 工具尚未镜像), 空数组
  // 起步 = 永远 null, 与 HttpRepository 那侧"路由尚未落地"的降级效果一致。
  async getLiveSessionEvaluation(live_session_id) {
    return (
      state.liveSessionEvaluations.find((e) => e.live_session_id === live_session_id) ?? null
    );
  },

  // -------- Learner Model 批0/批1 (observation gate + calibration) --------
  async getObservationGateState(): Promise<ObservationGateState> {
    return {
      forbidden_observations: [...state.forbiddenObservations],
      confidence_mode_enabled: state.confidenceModeEnabled,
      confidence_mode_changed_at: state.confidenceModeChangedAt,
    };
  },
  // 观察禁区下线案 — add/removeForbiddenObservation dropped along with the
  // boundary registry UI (see observationGateExt.ts). The stored list still
  // reads back via getObservationGateState above.
  async setConfidenceModeEnabled(_pair_id, enabled) {
    state.confidenceModeEnabled = enabled;
    state.confidenceModeChangedAt = new Date().toISOString();
    persist('confidenceModeEnabled');
    persist('confidenceModeChangedAt');
    return {
      confidence_mode_enabled: state.confidenceModeEnabled,
      confidence_mode_changed_at: state.confidenceModeChangedAt,
    };
  },
  async getCalibrationCurve(pair_id, course_id): Promise<CalibrationCurve> {
    const outcomesByLevel = new Map<ConfidenceLevel, number[]>();
    for (const lvl of CONFIDENCE_LEVELS) outcomesByLevel.set(lvl, []);

    if (pair_id === f.pair.id) {
      for (const sub of state.exerciseSubmissions) {
        if (!sub.confidence || sub.agent_score == null) continue;
        if (course_id) {
          const exercise = state.exercises.find((e) => e.id === sub.exercise_id);
          const lesson = exercise ? state.lessons.find((l) => l.id === exercise.lesson_id) : undefined;
          if (lesson?.course_id !== course_id) continue;
        }
        outcomesByLevel.get(sub.confidence)?.push(sub.agent_score);
      }

      for (const attempt of state.simulatedQuizAttempts) {
        const quiz = state.simulatedQuizzes.find((q) => q.id === attempt.quiz_id);
        if (course_id && quiz?.course_id !== course_id) continue;
        for (const a of attempt.answers) {
          if (!a.confidence || a.correct === undefined) continue;
          outcomesByLevel.get(a.confidence)?.push(a.correct ? 1 : 0);
        }
      }
    }

    // anchor_pct is a label (this pair's CURRENT mapping), not a filter —
    // same "history is history" split as the server's calibration.ts.
    const buckets: CalibrationBucket[] = CONFIDENCE_LEVELS.map((level) => {
      const outcomes = outcomesByLevel.get(level) ?? [];
      return {
        level,
        anchor_pct: state.confidenceAnchorPct[level],
        sample_count: outcomes.length,
        actual_correct_rate:
          outcomes.length > 0 ? outcomes.reduce((s, v) => s + v, 0) / outcomes.length : null,
      };
    });

    return { pair_id, course_id: course_id ?? null, buckets };
  },

  async getBrierTrend(pair_id): Promise<BrierTrendPoint[]> {
    if (pair_id !== f.pair.id) return [];
    return BRIER_MOCK_TREND.map((point, i) => ({
      week_start: mondayPlusWeeks(BRIER_MOCK_BASE_MONDAY, i),
      n: point.n,
      brier: point.brier,
    }));
  },

  // Confidence 主权立法 (学习者裁决版) — 映射权归学习者, mirrors server's
  // lib/confidence-anchors.ts get/set 1:1 (single-pair mock world, same
  // "no MCP surface reads this" boundary — nothing in this file's
  // teacher-facing paths touches state.confidenceAnchorPct).
  async getConfidenceAnchors(): Promise<ConfidenceAnchorConfig> {
    return { ...state.confidenceAnchorPct };
  },
  async setConfidenceAnchors(_pair_id, anchors): Promise<ConfidenceAnchorConfig> {
    const err = validateConfidenceAnchors(anchors);
    if (err) throw new Error(err);
    state.confidenceAnchorPct = { ...anchors };
    persist('confidenceAnchorPct');
    return { ...state.confidenceAnchorPct };
  },

  // -------- teacher growth (write) --------
  async reviewHypothesis(id, action, user_note) {
    if (f.hypothesis.id !== id) throw new Error(`hypothesis not found: ${id}`);
    // 对齐 server (routes/write.ts POST /hypotheses/:id/review): 非法
    // action 曾经在这里落到 else 分支静默兜底成 'freeze' —— 一个拼错的字符串
    // 会被悄悄当成"冻结"落库。现在显式校验、拼错直接抛错，跟 server 的 400
    // 同款行为对齐，只是 Mock 惯例用 throw 而非 HTTP 状态码。
    if (action !== 'confirm' && action !== 'reject' && action !== 'freeze') {
      throw new Error(`invalid action: ${action} (must be confirm, reject, or freeze)`);
    }
    const now = new Date().toISOString();

    if (user_note !== undefined) f.hypothesis.user_note = user_note;
    f.hypothesis.updated_at = now;

    if (action === 'confirm') {
      f.hypothesis.status = 'confirmed';
      f.hypothesis.user_approved = true;
      f.hypothesis.allowed_for_teaching = true;
      f.hypothesis.last_verified_at = now;
    } else if (action === 'reject') {
      f.hypothesis.status = 'rejected';
      f.hypothesis.user_approved = false;
      f.hypothesis.allowed_for_teaching = false;
    } else {
      f.hypothesis.status = 'frozen';
      f.hypothesis.allowed_for_teaching = false;
    }

    return f.hypothesis;
  },

  // -------- exercise (read) --------
  async getExercises(lesson_id: LessonId) {
    return state.exercises.filter((e) => e.lesson_id === lesson_id);
  },
  async getExerciseSubmissions(learner_id: LearnerId, exercise_id?: ExerciseId) {
    return state.exerciseSubmissions.filter(
      (s) => s.learner_id === learner_id && (!exercise_id || s.exercise_id === exercise_id)
    );
  },

  // -------- quiz (read) --------
  async getSimulatedQuizzes(pair_id, course_id) {
    return state.simulatedQuizzes.filter(
      (q) => q.pair_id === pair_id && (!course_id || q.course_id === course_id)
    );
  },
  async getSimulatedQuizAttempts(quiz_id) {
    return state.simulatedQuizAttempts
      .filter((a) => a.quiz_id === quiz_id)
      .sort((a, b) => b.started_at.localeCompare(a.started_at));
  },
  async deleteSimulatedQuiz(quiz_id) {
    if (!state.simulatedQuizzes.some((q) => q.id === quiz_id)) {
      throw new Error(`simulated quiz ${quiz_id} not found`);
    }
    state.simulatedQuizzes = state.simulatedQuizzes.filter((q) => q.id !== quiz_id);
    state.simulatedQuizAttempts = state.simulatedQuizAttempts.filter((a) => a.quiz_id !== quiz_id);
    persist('simulatedQuizzes');
    persist('simulatedQuizAttempts');
  },
  async getQuestionBanks() {
    return [...state.questionBanks];
  },
  async getQuizQuestions(bank_id: QuestionBankId) {
    return state.quizQuestions.filter((q) => q.bank_id === bank_id);
  },
  async getQuizAttempts(learner_id: LearnerId) {
    return state.quizAttempts.filter((a) => a.learner_id === learner_id);
  },

  // -------- mindmap (read) --------
  async getMindmapsForLesson(lesson_id) {
    // association 是 lesson↔图 的唯一真相（mindmap 本身没有 target 字段）
    const assocIds = state.mindmapAssociations
      .filter((a) => a.target_type === 'lesson' && a.target_id === (lesson_id as unknown as string))
      .map((a) => a.mindmap_id);
    return state.mindmaps.filter((m) => assocIds.includes(m.id));
  },
  async getMindmapsForCourse(course_id) {
    const assocIds = state.mindmapAssociations
      .filter((a) => a.target_type === 'course' && a.target_id === (course_id as unknown as string))
      .map((a) => a.mindmap_id);
    return state.mindmaps.filter((m) => assocIds.includes(m.id));
  },
  async getCustomMindmaps(pair_id) {
    return state.mindmaps.filter((m) => m.owner_pair_id === pair_id && m.scope === 'custom');
  },
  async getAllMindmaps(pair_id) {
    // 最近接触序 — 镜像服务端 GET /pairs/:pairId/mindmaps 的 ORDER BY
    // greatest(updated_at, 最近一条 mindmap.viewed) DESC (RecentRail 现在直接
    // 取第一条, 不再自己排)。
    return state.mindmaps
      .filter((m) => m.owner_pair_id === pair_id)
      .sort((a, b) => touchedAt(b.id, b.updated_at).localeCompare(touchedAt(a.id, a.updated_at)));
  },
  async getMindmap(id) {
    return state.mindmaps.find((m) => m.id === id) ?? null;
  },
  async getMindmapAssociations(mindmap_id) {
    return state.mindmapAssociations.filter((a) => a.mindmap_id === mindmap_id);
  },
  async getPendingCards(pair_id) {
    return state.pendingCards.filter((p) => p.owner_pair_id === pair_id);
  },

  // -------- feedback / reminder (read) --------
  async getFeedback(pair_id) {
    return state.feedback.filter((fb) => fb.pair_id === pair_id);
  },
  // 现场反馈笔改革 — ledger view over the same mock store. Ritual-era fixture rows
  // predate kind/status/anchors; they surface with the column defaults the
  // 0038 migration would give them (kind 'issue', status 'open', no anchors).
  async getFeedbackLedger(pair_id) {
    return state.feedback
      .filter((fb) => fb.pair_id === pair_id)
      .map<FeedbackLedgerEntry>((fb) => ({
        id: fb.id,
        pair_id: fb.pair_id,
        kind: 'issue',
        status: 'open',
        status_note: null,
        status_changed_at: null,
        lesson_id: null,
        live_session_id: null,
        exercise_id: null,
        source_message_ref: null,
        free_text: fb.free_text ?? null,
        submitted_at: fb.submitted_at,
      }))
      .sort((a, b) => b.submitted_at.localeCompare(a.submitted_at));
  },
  async getReminders(pair_id) {
    return state.reminders.filter((r) => r.pair_id === pair_id);
  },

  // ==========================================================================
  // Mutations
  // ==========================================================================

  // -------- Live Teaching (Stage 7c, Hub-aligned) --------

  async getLiveSessionForLesson(pair_id, lesson_id) {
    const matches = state.liveSessions
      .filter(
        (s) =>
          s.pair_id === pair_id &&
          s.context_type === 'lesson' &&
          s.context_id === (lesson_id as unknown as string)
      )
      .sort((a, b) =>
        (b.last_activity_at ?? '').localeCompare(a.last_activity_at ?? '')
      );
    return matches[0] ?? null;
  },

  // 召唤状态机 v3 gap-4: latest completed session, independent of any newer
  // cancelled/expired retry masking it — same filter as above plus status.
  async getCompletedLiveSessionForLesson(pair_id, lesson_id) {
    const matches = state.liveSessions
      .filter(
        (s) =>
          s.pair_id === pair_id &&
          s.context_type === 'lesson' &&
          s.context_id === (lesson_id as unknown as string) &&
          s.status === 'completed'
      )
      .sort((a, b) =>
        (b.last_activity_at ?? '').localeCompare(a.last_activity_at ?? '')
      );
    return matches[0] ?? null;
  },

  // 完课历史列表案: full session list (newest first by started_at) — powers the
  // web history stack. Same filter as getCompletedLiveSessionForLesson
  // above plus the optional status narrowing; move_count computed from
  // state.teachingMoves the same way the mock elsewhere derives counts.
  async getLiveSessionsForLesson(pair_id, lesson_id, status) {
    const matches = state.liveSessions
      .filter(
        (s) =>
          s.pair_id === pair_id &&
          s.context_type === 'lesson' &&
          s.context_id === (lesson_id as unknown as string) &&
          (!status || s.status === status)
      )
      .sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''));
    return matches.map((s) => ({
      ...s,
      move_count: state.teachingMoves.filter((m) => m.session_id === s.id).length,
    }));
  },

  async getLiveSessionFullView(session_id) {
    const session = state.liveSessions.find((s) => s.id === session_id);
    if (!session) return null;
    const moves = state.teachingMoves
      .filter((m) => m.session_id === session_id)
      .sort((a, b) => a.seq - b.seq);
    const responses = state.teachingResponses
      .filter((r) => r.session_id === session_id)
      .sort((a, b) =>
        (a.created_at ?? '').localeCompare(b.created_at ?? '')
      );
    return { session, moves, responses } satisfies LiveSessionFullView;
  },

  async startLiveSession(input) {
    const now = new Date().toISOString();
    const session: LiveSession = {
      id: genId('lvs') as LiveSessionId,
      pair_id: input.pair_id,
      context_type: input.context_type,
      context_id: input.context_id,
      context_preview: input.context_preview,
      goal: input.goal,
      status: 'active',
      awaiting_role: 'agent',
      started_at: now,
      last_activity_at: now,
    };
    state.liveSessions.push(session);
    persist('liveSessions');
    // Mock: schedule the first agent move (~500ms thinking pause).
    void simulateAgentTurn(session.id);
    return session;
  },

  async appendTeachingMove(input) {
    const sessionIdx = state.liveSessions.findIndex(
      (s) => s.id === input.session_id
    );
    if (sessionIdx < 0) throw new Error(`session ${input.session_id} not found`);
    if (state.liveSessions[sessionIdx]!.status !== 'active') {
      throw new Error('cannot append move to non-active session');
    }
    validateMove(input.move_type, input.response_kind);
    const moves = state.teachingMoves.filter(
      (m) => m.session_id === input.session_id
    );
    const nextSeq = moves.length + 1;
    const now = new Date().toISOString();
    const move: TeachingMove = {
      id: genId('tmv') as TeachingMoveId,
      session_id: input.session_id,
      seq: nextSeq,
      move_type: input.move_type,
      content: input.content,
      response_kind: input.response_kind,
      payload: input.payload,
      source_type: input.source_type,
      source_id: input.source_id,
      created_at: now,
    };
    state.teachingMoves.push(move);
    persist('teachingMoves');

    // Flip awaiting based on move + response_kind.
    const awaiting: AwaitingRole =
      input.move_type === 'REFLECT'
        ? 'none'
        : input.response_kind === 'none'
          ? 'none'
          : 'learner';
    state.liveSessions[sessionIdx] = {
      ...state.liveSessions[sessionIdx]!,
      awaiting_role: awaiting,
      last_activity_at: now,
    };
    persist('liveSessions');
    return move;
  },

  async submitTeachingResponse(input) {
    // Dedup on client_response_id
    const existing = state.teachingResponses.find(
      (r) => r.client_response_id === input.client_response_id
    );
    if (existing) return existing;
    const now = new Date().toISOString();
    const resp: TeachingResponse = {
      id: genId('trp') as TeachingResponseId,
      session_id: input.session_id,
      move_id: input.move_id,
      client_response_id: input.client_response_id,
      content: input.content,
      input_type: input.input_type,
      created_at: now,
    };
    state.teachingResponses.push(resp);
    persist('teachingResponses');
    // Flip awaiting → agent.
    const idx = state.liveSessions.findIndex((s) => s.id === input.session_id);
    if (idx >= 0) {
      state.liveSessions[idx] = {
        ...state.liveSessions[idx]!,
        awaiting_role: 'agent',
        last_activity_at: now,
      };
      persist('liveSessions');
    }
    // Mock: agent takes its turn after a brief pause.
    void simulateAgentTurn(input.session_id);
    return resp;
  },

  async completeLiveSession(session_id, closing) {
    const idx = state.liveSessions.findIndex((s) => s.id === session_id);
    if (idx < 0) throw new Error(`session ${session_id} not found`);
    const now = new Date().toISOString();
    state.liveSessions[idx] = {
      ...state.liveSessions[idx]!,
      status: 'completed',
      awaiting_role: 'none',
      summary: closing.summary,
      teacher_reflection: closing.teacher_reflection,
      next_action: closing.next_action,
      ended_at: now,
      last_activity_at: now,
    };
    persist('liveSessions');
    return state.liveSessions[idx]!;
  },

  // -------- 首跑入学 + 下课铃 (onboardingExt) --------
  // Mock 模式即样板间: 首跑页只在 live 模式挂载 (demo 模式自带数据, 见
  // pages/FirstRun.tsx 的挂载条件), 这里的 registerLearner 只是让类型闭合
  // 的诚实假实现 — 返回 fixture learner 的 id + 学习者敲的名字。
  async registerLearner(input) {
    return {
      learner_id: f.learner.id as unknown as string,
      display_name: input.display_name.trim(),
    };
  },
  async declareSessionClose(session_id) {
    const idx = state.liveSessions.findIndex((s) => s.id === session_id);
    if (idx < 0) throw new Error(`session ${session_id} not found`);
    const cur = state.liveSessions[idx]! as LiveSessionWithClose;
    // 幂等: 已宣告返回原值 (与服务端契约一致)。
    if (cur.learner_close_declared_at) {
      return { declared_at: cur.learner_close_declared_at };
    }
    if (cur.status !== 'active') {
      throw new SessionTerminalError('session is terminal');
    }
    const now = new Date().toISOString();
    state.liveSessions[idx] = {
      ...cur,
      learner_close_declared_at: now,
      last_activity_at: now,
    } as LiveSession;
    persist('liveSessions');
    return { declared_at: now };
  },
  async getCurrentPairWithMeta() {
    // fixture pair 名副其实是 pair_demo_cfa — 数据身份如实自报 (DEMO pill
    // 在 mock 模式同样成立: 它标的是"这是演示数据", 不是连接模式)。
    return { ...f.pair, is_demo: true };
  },

  async cancelLiveSession(session_id) {
    const idx = state.liveSessions.findIndex((s) => s.id === session_id);
    if (idx < 0) throw new Error(`session ${session_id} not found`);
    const cur = state.liveSessions[idx]!;
    if (cur.status !== 'active') return cur; // idempotent on terminal
    const now = new Date().toISOString();
    state.liveSessions[idx] = {
      ...cur,
      status: 'cancelled',
      awaiting_role: 'none',
      ended_at: now,
      last_activity_at: now,
    };
    persist('liveSessions');
    return state.liveSessions[idx]!;
  },

  // -------- Flashcard management (Stage 7e-cards) --------
  async createFlashcard(input) {
    const now = new Date().toISOString();
    const card: Flashcard = {
      ...input,
      id: genId('fc') as FlashcardId,
      fsrs_state: {
        due_at: now,
        stability: 0.5,
        difficulty: 5,
        last_review_at: null,
        review_count: 0,
        retrievability: 1,
      },
      paused: false,
      created_at: now,
      updated_at: now,
    };
    state.flashcards.push(card);
    persist('flashcards');
    return card;
  },
  async setFlashcardPaused(id, paused) {
    const idx = state.flashcards.findIndex((c) => c.id === id);
    if (idx < 0) throw new Error(`flashcard ${id} not found`);
    state.flashcards[idx] = {
      ...state.flashcards[idx]!,
      paused,
      updated_at: new Date().toISOString(),
    };
    persist('flashcards');
    return state.flashcards[idx]!;
  },
  async setFlashcardDeck(id, deck_id) {
    const idx = state.flashcards.findIndex((c) => c.id === id);
    if (idx < 0) throw new Error(`flashcard ${id} not found`);
    state.flashcards[idx] = {
      ...state.flashcards[idx]!,
      deck_id,
      updated_at: new Date().toISOString(),
    };
    persist('flashcards');
    return state.flashcards[idx]!;
  },
  async resetFlashcardFsrs(id) {
    const idx = state.flashcards.findIndex((c) => c.id === id);
    if (idx < 0) throw new Error(`flashcard ${id} not found`);
    const now = new Date().toISOString();
    state.flashcards[idx] = {
      ...state.flashcards[idx]!,
      fsrs_state: {
        due_at: now,
        stability: 0.5,
        difficulty: 5,
        last_review_at: null,
        review_count: 0,
        retrievability: 1,
      },
      updated_at: now,
    };
    persist('flashcards');
    return state.flashcards[idx]!;
  },
  async deleteFlashcard(id) {
    state.flashcards = state.flashcards.filter((c) => c.id !== id);
    persist('flashcards');
  },

  // -------- Flashcard Markdown batch import (2026-07-08 定案) --------
  // Mirrors the collapse/categorize/apply logic of the server's
  // POST /pairs/:pairId/flashcards/import (apps/server/src/routes/write.ts)
  // against the in-memory/localStorage `state.flashcards` array instead of
  // Postgres — see lib/flashcardImportParser.ts's header for why the parser
  // itself is duplicated rather than shared.
  async importFlashcards({ pair_id, content, dry_run }) {
    const { cards: parsedCards, errors } = parseFlashcardMarkdown(content);

    const collapsedByKey = new Map<
      string,
      { deck: string; front: string; back: string; line: number }
    >();
    const keyOrder: string[] = [];
    for (const pc of parsedCards) {
      const key = `${pc.deck} ${normalizeCardFace(pc.front)}`;
      if (!collapsedByKey.has(key)) keyOrder.push(key);
      collapsedByKey.set(key, { deck: pc.deck, front: pc.front, back: pc.back, line: pc.line });
    }
    const collapsed = keyOrder.map((k) => collapsedByKey.get(k)!);

    const existingRows = state.flashcards.filter((c) => c.pair_id === pair_id);
    const existingDecks = new Set(existingRows.map((r) => r.deck_id as unknown as string));
    const decksReferenced = Array.from(new Set(collapsed.map((cc) => cc.deck)));
    const decksToCreate = decksReferenced.filter((d) => !existingDecks.has(d));

    const existingByKey = new Map<string, Flashcard>();
    for (const row of existingRows) {
      existingByKey.set(`${row.deck_id as unknown as string} ${normalizeCardFace(row.front)}`, row);
    }

    const decksResult: Record<string, FlashcardImportDeckResult> = {};
    function bucketFor(deck: string): FlashcardImportDeckResult {
      let b = decksResult[deck];
      if (!b) {
        b = { new: [], duplicates: [], updated: [] };
        decksResult[deck] = b;
      }
      return b;
    }

    const toInsert: typeof collapsed = [];
    const toUpdate: { id: FlashcardId; back: string }[] = [];

    for (const item of collapsed) {
      const key = `${item.deck} ${normalizeCardFace(item.front)}`;
      const existing = existingByKey.get(key);
      const bucket = bucketFor(item.deck);
      if (!existing) {
        bucket.new.push({ front: item.front, back: item.back, line: item.line });
        toInsert.push(item);
      } else if (existing.back.trim() === item.back.trim()) {
        bucket.duplicates.push({ front: item.front, back: item.back, line: item.line });
      } else {
        bucket.updated.push({
          front: item.front,
          back: item.back,
          line: item.line,
          previous_back: existing.back,
        });
        toUpdate.push({ id: existing.id, back: item.back });
      }
    }

    if (!dry_run) {
      const now = new Date().toISOString();
      for (const item of toInsert) {
        state.flashcards.push({
          id: genId('fc') as FlashcardId,
          pair_id,
          concept_id: null,
          deck_id: item.deck as Flashcard['deck_id'],
          front: item.front,
          back: item.back,
          tags: [],
          source_refs: [],
          fsrs_state: {
            due_at: now,
            stability: 0.5,
            difficulty: 5,
            last_review_at: null,
            review_count: 0,
            retrievability: 1,
          },
          paused: false,
          created_at: now,
          updated_at: now,
        });
      }
      for (const u of toUpdate) {
        const idx = state.flashcards.findIndex((c) => c.id === u.id);
        if (idx >= 0) {
          state.flashcards[idx] = { ...state.flashcards[idx]!, back: u.back, updated_at: now };
        }
      }
      persist('flashcards');
    }

    return { errors, decks: decksResult, decks_to_create: decksToCreate };
  },

  // -------- Annotation (batch A) --------
  async getAnnotationsForLesson(lesson_id) {
    return state.annotations
      .filter((a) => a.lesson_id === lesson_id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  },
  async createAnnotation(input) {
    const now = new Date().toISOString();
    const record: LessonAnnotation = {
      id: genId('ann') as AnnotationId,
      pair_id: input.pair_id,
      lesson_id: input.lesson_id,
      page_index: input.page_index,
      selected_text: input.selected_text,
      prefix: input.prefix,
      suffix: input.suffix,
      color: input.color ?? 'amber',
      note: input.note ?? null,
      created_at: now,
      updated_at: now,
    };
    state.annotations.push(record);
    persist('annotations');
    return record;
  },
  // 第三种作用域 (教学记录挂批注, 2026-07-18) — same cast pattern as the
  // document-hosted pair below: state.annotations' declared row type is
  // contracts' LessonAnnotation, live rows carry live_session_id on top.
  async getAnnotationsForLiveSession(live_session_id) {
    return (state.annotations as unknown as LessonAnnotationWithOrphan[])
      .filter((a) => a.live_session_id === live_session_id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at)) as unknown as LessonAnnotation[];
  },
  async createLiveSessionAnnotation(input) {
    const now = new Date().toISOString();
    const record: LessonAnnotationWithOrphan = {
      id: genId('ann') as AnnotationId,
      pair_id: input.pair_id,
      lesson_id: null,
      document_id: null,
      live_session_id: input.live_session_id,
      page_index: input.page_index,
      selected_text: input.selected_text,
      prefix: input.prefix,
      suffix: input.suffix,
      color: input.color ?? 'amber',
      note: input.note ?? null,
      orphaned_at: null,
      created_at: now,
      updated_at: now,
    };
    state.annotations.push(record as unknown as LessonAnnotation);
    persist('annotations');
    return record as unknown as LessonAnnotation;
  },
  async updateAnnotation(id, patch) {
    const idx = state.annotations.findIndex((a) => a.id === id);
    if (idx < 0) throw new Error(`annotation ${id} not found`);
    state.annotations[idx] = {
      ...state.annotations[idx]!,
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      ...(patch.color !== undefined ? { color: patch.color } : {}),
      updated_at: new Date().toISOString(),
    };
    persist('annotations');
    return state.annotations[idx]!;
  },
  async deleteAnnotation(id) {
    state.annotations = state.annotations.filter((a) => a.id !== id);
    persist('annotations');
  },

  // -------- Journal 自由笔记 (batch E; 批G 加了 document_id 半边判据) --------
  // state.annotations stays typed LessonAnnotation[] (unchanged) — same
  // "static type undersells the real shape" trick orphan.ts already uses for
  // orphaned_at; lesson_id: null is likewise present at runtime here without
  // widening the shared State field type. Casts below make that explicit at
  // the two boundary points instead of threading the wider type everywhere.
  // 批G: a document-anchored row also has lesson_id null — without the
  // `document_id === null` half of this filter it would misread as a free
  // note (same bug fixed server-side, routes/annotations.ts's GET
  // /pairs/:pairId/annotations/free).
  async getFreeNotesForPair(pair_id) {
    // 第三种作用域: live-session rows also have lesson_id/document_id null —
    // exclude them here too (mock mirror of the server-side isNull(
    // live_session_id) third filter, routes/annotations.ts).
    return (state.annotations as unknown as LessonAnnotationWithOrphan[])
      .filter(
        (a) =>
          a.pair_id === pair_id &&
          a.lesson_id === null &&
          a.document_id == null &&
          a.live_session_id == null
      )
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  },
  async createFreeNote(input) {
    const now = new Date().toISOString();
    const record: LessonAnnotationWithOrphan = {
      id: genId('ann') as AnnotationId,
      pair_id: input.pair_id,
      lesson_id: null,
      document_id: null,
      live_session_id: null,
      page_index: 0,
      selected_text: '',
      prefix: '',
      suffix: '',
      color: input.color ?? 'amber',
      note: input.note,
      orphaned_at: null,
      created_at: now,
      updated_at: now,
    };
    state.annotations.push(record as unknown as LessonAnnotation);
    persist('annotations');
    return record;
  },
  async getAnnotationCountForPair(pair_id) {
    return state.annotations.filter((a) => a.pair_id === pair_id).length;
  },

  // -------- Document (批G) --------
  async getDocuments(pair_id) {
    return state.documents
      .filter((d) => d.pair_id === pair_id)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  },
  async getDocument(id) {
    return state.documents.find((d) => d.id === id) ?? null;
  },
  async createDocument(input) {
    const now = new Date().toISOString();
    // Title derivation mirrors apps/server/src/lib/document-title.ts's rule
    // (frontmatter → 首个 H1 → 文件名/首行截断) closely enough for mock-mode
    // demo purposes — not byte-for-byte ported (mock repos don't share code
    // with the server, same "duplicate the small thing" call this codebase
    // already makes elsewhere, e.g. annotation-anchor-match.ts).
    const title = input.title?.trim() || mockDeriveDocumentTitle(input.content_md, input.filename);
    const record: Document = {
      id: genId('doc') as DocumentId,
      pair_id: input.pair_id,
      title,
      content_md: input.content_md,
      source: input.source,
      created_at: now,
      updated_at: now,
    };
    state.documents.push(record);
    persist('documents');
    return record;
  },
  async updateDocument(id, patch) {
    const idx = state.documents.findIndex((d) => d.id === id);
    if (idx < 0) throw new Error(`document ${id} not found`);
    state.documents[idx] = {
      ...state.documents[idx]!,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.content_md !== undefined ? { content_md: patch.content_md } : {}),
      updated_at: new Date().toISOString(),
    };
    persist('documents');
    // 批G resweep parity: mock mode re-anchors document annotations the same
    // way the server's PATCH/MCP paths do (brief §3 item 3) — best-effort
    // text-quote re-check against the new content, not a byte-for-byte port
    // of apps/server/src/lib/annotation-anchor-match.ts (no DOM here either,
    // same "approximation, flagged" trade-off that module's own header
    // documents for its own, different, approximation).
    if (patch.content_md !== undefined) {
      mockResweepDocument(id);
    }
    return state.documents[idx]!;
  },
  async deleteDocument(id) {
    state.documents = state.documents.filter((d) => d.id !== id);
    state.annotations = state.annotations.filter(
      (a) => (a as unknown as LessonAnnotationWithOrphan).document_id !== id
    );
    persist('documents');
    persist('annotations');
  },
  async getRecentDocuments(pair_id, limit = 5) {
    // 最近接触序 — 镜像服务端 GET /pairs/:pairId/documents/recent 的
    // greatest(updated_at, 最近一条 document.viewed)。
    return state.documents
      .filter((d) => d.pair_id === pair_id)
      .sort((a, b) => touchedAt(b.id, b.updated_at).localeCompare(touchedAt(a.id, a.updated_at)))
      .slice(0, limit)
      .map((d) => ({ id: d.id, title: d.title, updated_at: d.updated_at }) as DocumentSummary);
  },
  async getAnnotationsForDocument(document_id) {
    return (state.annotations as unknown as LessonAnnotationWithOrphan[])
      .filter((a) => a.document_id === document_id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  },
  async createDocumentAnnotation(input) {
    const now = new Date().toISOString();
    const record: LessonAnnotationWithOrphan = {
      id: genId('ann') as AnnotationId,
      pair_id: input.pair_id,
      lesson_id: null,
      document_id: input.document_id,
      live_session_id: null,
      page_index: 0,
      selected_text: input.selected_text,
      prefix: input.prefix,
      suffix: input.suffix,
      color: input.color ?? 'amber',
      note: input.note ?? null,
      orphaned_at: null,
      created_at: now,
      updated_at: now,
    };
    state.annotations.push(record as unknown as LessonAnnotation);
    persist('annotations');
    return record;
  },

  // -------- Syllabus Registry (考纲登记簿) --------
  // Content supply (importing a real syllabus tree) is explicitly out of
  // scope for this delivery (brief §5: "考纲树的实际灌入...不在本工程内") —
  // mock/seeded mode has no fixture tree to show, so this always returns the
  // same empty structure the live server returns for a pair with zero nodes
  // (brief §5 空态克制). Journal's syllabus-week projection reads this and
  // correctly produces zero entries.
  async getSyllabus(): Promise<SyllabusSnapshot> {
    return { version: null, nodes: [], mappings: [], coverage_pct: null };
  },

  // -------- Mid-lesson snapshot (Stage 7e) --------
  async writeMidLessonSnapshot(input) {
    const now = new Date().toISOString();
    const snap: MidLessonSnapshot = {
      id: genId('snap') as MidLessonSnapshotId,
      session_id: input.session_id,
      after_turn_n: input.after_turn_n,
      rolling_summary: input.rolling_summary,
      current_direction: input.current_direction,
      weak_signals: input.weak_signals,
      created_at: now,
    };
    state.midLessonSnapshots.push(snap);
    persist('midLessonSnapshots');
    return snap;
  },
  async getLatestMidLessonSnapshot(session_id) {
    const list = state.midLessonSnapshots
      .filter((s) => s.session_id === session_id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return list[0] ?? null;
  },

  // -------- Bridge (Stage 7d / 7d-fix) --------
  // Mock-mode bridge is a no-op happy path — there's no real agent on the
  // other end. Returns "always online" so any web UI that wants to render
  // an availability indicator still gets a sensible value. context view is
  // 'unknown' since no agent is reporting.
  async heartbeatBridge(input) {
    const now = new Date();
    const ttl = Math.max(15, Math.min(600, input.ttl_seconds ?? 60));
    return {
      pair_id: input.pair_id,
      online: true,
      last_heartbeat_at: now.toISOString(),
      online_until: new Date(now.getTime() + ttl * 1000).toISOString(),
      context: { level: 'unknown', compact_count: 0, last_reported_at: null },
    };
  },
  async pollBridgePending(pair_id) {
    const now = new Date();
    return {
      bridge: {
        pair_id,
        online: true,
        last_heartbeat_at: now.toISOString(),
        online_until: new Date(now.getTime() + 60_000).toISOString(),
        context: { level: 'unknown', compact_count: 0, last_reported_at: null },
      },
      // Mock simulator drives moves locally via setTimeout — nothing real
      // to poll for. Real-bridge demo runs against the http backend.
      items: [],
    };
  },

  // -------- AdHoc thread (Stage 7d-fix) --------
  async getOrCreateAdHocThread(pair_id) {
    // Skip archived threads (隐私清理案) — mirrors the server's by-pair
    // lookup so archiving actually starts a fresh thread on next message.
    let existing = state.adHocThreads.find((t) => t.pair_id === pair_id && !t.archived_at);
    if (!existing) {
      const now = new Date().toISOString();
      existing = {
        id: genId('ah') as AdHocThreadId,
        pair_id,
        message_count: 0,
        created_at: now,
        last_activity_at: now,
      };
      state.adHocThreads.push(existing);
      persist('adHocThreads');
    }
    return existing;
  },
  async getAdHocThreadFullView(thread_id) {
    const thread = state.adHocThreads.find((t) => t.id === thread_id);
    if (!thread) return null;
    const messages = state.adHocMessages
      .filter((m) => m.thread_id === thread_id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    return { thread, messages };
  },
  async appendAdHocMessage(input) {
    // Idempotent on client_message_id.
    const existing = state.adHocMessages.find(
      (m) => m.client_message_id === input.client_message_id
    );
    if (existing) return existing;
    const now = new Date().toISOString();
    const msg: AdHocMessage = {
      id: genId('ahm') as AdHocMessageId,
      thread_id: input.thread_id,
      role: input.role,
      content: input.content,
      payload: input.payload,
      context_snapshot: input.context_snapshot,
      is_learning_related: input.is_learning_related,
      client_message_id: input.client_message_id,
      created_at: now,
    };
    state.adHocMessages.push(msg);
    persist('adHocMessages');
    const tIdx = state.adHocThreads.findIndex((t) => t.id === input.thread_id);
    if (tIdx >= 0) {
      state.adHocThreads[tIdx] = {
        ...state.adHocThreads[tIdx]!,
        message_count: state.adHocThreads[tIdx]!.message_count + 1,
        last_activity_at: now,
      };
      persist('adHocThreads');
    }
    // Mock: if it's a user message, kick off a trivial agent reply.
    if (input.role === 'user') void simulateAdHocReply(input.thread_id, input.content);
    return msg;
  },
  async archiveAdHocThread(thread_id) {
    const idx = state.adHocThreads.findIndex((t) => t.id === thread_id);
    if (idx < 0) throw new Error(`AdHocThread ${thread_id} not found`);
    state.adHocThreads[idx] = {
      ...state.adHocThreads[idx]!,
      archived_at: new Date().toISOString(),
    };
    persist('adHocThreads');
    return state.adHocThreads[idx]!;
  },
  async deleteAdHocMessage(id) {
    const idx = state.adHocMessages.findIndex((m) => m.id === id);
    if (idx < 0) return;
    const { thread_id } = state.adHocMessages[idx]!;
    state.adHocMessages.splice(idx, 1);
    persist('adHocMessages');
    const tIdx = state.adHocThreads.findIndex((t) => t.id === thread_id);
    if (tIdx >= 0) {
      state.adHocThreads[tIdx] = {
        ...state.adHocThreads[tIdx]!,
        message_count: Math.max(0, state.adHocThreads[tIdx]!.message_count - 1),
      };
      persist('adHocThreads');
    }
  },

  // -------- contract intake + 备课 --------
  async createContract(input) {
    const now = new Date().toISOString();
    const next: TeachingContract = {
      ...input,
      id: genId('tc') as ContractId,
      version: 1,
      // Stage 5 (GENERATE-FLOW-BRIEF): Establish only creates the contract
      // record; provisioning happens later via generateOutline (秒级) and a
      // separate lesson-selection commit.
      // 迁移 0030 (State 2.0): `active` column retired (合同签名态改革 —
      // never read by any real path); `setup_status` below is what
      // getActiveContract/rotateIcalToken actually key off (see
      // repository/currentContract.ts).
      created_at: now,
      updated_at: now,
      setup_status: 'established',
      // Stage 6a (2026-06-29): freeze the skill workflow at Establish time.
      // Once frozen, agent GetPrompt('_stack') reads against this snapshot —
      // preference edits don't silently mutate an in-flight contract.
      skill_stack: pickSkillStackForContract(input),
    };
    state.contracts.push(next);
    persist('contracts');
    return next;
  },
  async updateContract(id, patch) {
    const idx = state.contracts.findIndex((c) => c.id === id);
    if (idx < 0) throw new Error(`contract ${id} not found`);
    const merged: TeachingContract = {
      ...state.contracts[idx]!,
      ...patch,
      updated_at: new Date().toISOString(),
    };
    state.contracts[idx] = merged;
    persist('contracts');
    return merged;
  },
  async commitLessonSelection(id, selected_lesson_ids) {
    const idx = state.contracts.findIndex((c) => c.id === id);
    if (idx < 0) throw new Error(`contract ${id} not found`);
    const cur = state.contracts[idx]!;
    if (cur.setup_status !== 'outline_ready') {
      throw new Error(
        `commitLessonSelection: contract ${id} is in '${cur.setup_status}', not 'outline_ready'`
      );
    }
    const now = new Date().toISOString();
    state.contracts[idx] = {
      ...cur,
      setup_status: 'generating',
      setup_started_at: now,
      updated_at: now,
    };
    persist('contracts');

    // Walk selected lessons one by one in the background.
    void simulateLessonGeneration(id, selected_lesson_ids);

    return state.contracts[idx]!;
  },
  async cancelContractSetup(id) {
    const idx = state.contracts.findIndex((c) => c.id === id);
    if (idx < 0) throw new Error(`contract ${id} not found`);
    state.contracts[idx] = {
      ...state.contracts[idx]!,
      setup_status: 'cancelled',
      updated_at: new Date().toISOString(),
    };
    persist('contracts');
    return state.contracts[idx]!;
  },
  async voidContract(id, reason) {
    const idx = state.contracts.findIndex((c) => c.id === id);
    if (idx < 0) throw new Error(`contract ${id} not found`);
    const cur = state.contracts[idx]!;
    // 幂等: 已作废的合约重复调用返回现状, 不报错、不覆盖原 void_reason —
    // 与 server 侧 POST /contracts/:id/void 和 mcp/server.ts void_contract
    // 工具的幂等语义一致。
    if (cur.voided_at) return cur;
    const now = new Date().toISOString();
    state.contracts[idx] = {
      ...cur,
      voided_at: now,
      // 学习者裁决 (2026-07-18): reason 可选——空串表示不留理由, 与 server
      // 侧写 void_reason=null 同义 (TeachingContract.void_reason 是可选
      // 字段, 这里以 undefined 表达)。
      void_reason: reason.trim() || undefined,
      updated_at: now,
    };
    persist('contracts');
    return state.contracts[idx]!;
  },
  async rotateIcalToken(pair_id) {
    const url = `https://learn-shell.local/api/u/${genId('tok')}.ics`;
    // 合同签名态改革 — was `.active` (retired), now signed non-terminal
    // setup_status via the shared helper.
    const current = pickCurrentContract(state.contracts.filter((c) => c.pair_id === pair_id));
    const idx = current ? state.contracts.findIndex((c) => c.id === current.id) : -1;
    if (idx >= 0) {
      state.contracts[idx] = {
        ...state.contracts[idx]!,
        ical_subscription_url: url,
        updated_at: new Date().toISOString(),
      };
      persist('contracts');
    }
    return url;
  },
  async deleteCourse(course_id) {
    if (!state.courses.some((c) => c.id === course_id)) {
      throw new Error(`course ${course_id} not found`);
    }
    const lessonIds = state.lessons.filter((l) => l.course_id === course_id).map((l) => l.id);
    const conceptIds = new Set(
      state.lessons
        .filter((l) => l.course_id === course_id)
        .flatMap((l) => l.concept_ids)
    );
    const assetIds = new Set<string>([course_id, ...lessonIds]);
    const exerciseIds = new Set(
      state.exercises.filter((e) => lessonIds.includes(e.lesson_id)).map((e) => e.id)
    );
    const quizIds = new Set(
      state.simulatedQuizzes.filter((q) => q.course_id === course_id).map((q) => q.id)
    );

    // Mirrors the server's FK-cascade footprint (lessons/exercises/
    // submissions/quizzes/quiz attempts/progress/patches/receipts) since
    // mock mode has no real DB cascade to lean on, plus the same three
    // cascade-blind cleanups (flashcards / mindmap_associations here —
    // syllabus_mappings has no mock store to clean, see getCourseFootprint).
    state.courses = state.courses.filter((c) => c.id !== course_id);
    state.lessons = state.lessons.filter((l) => l.course_id !== course_id);
    state.exercises = state.exercises.filter((e) => !lessonIds.includes(e.lesson_id));
    state.exerciseSubmissions = state.exerciseSubmissions.filter(
      (s) => !exerciseIds.has(s.exercise_id)
    );
    state.simulatedQuizzes = state.simulatedQuizzes.filter((q) => q.course_id !== course_id);
    state.simulatedQuizAttempts = state.simulatedQuizAttempts.filter(
      (a) => !quizIds.has(a.quiz_id)
    );
    state.lessonProgress = state.lessonProgress.filter((p) => !lessonIds.includes(p.lesson_id));
    state.lessonPatches = state.lessonPatches.filter((p) => !lessonIds.includes(p.lesson_id));
    state.lessonLoopReceipts = state.lessonLoopReceipts.filter(
      (r) => !lessonIds.includes(r.lesson_id)
    );
    state.flashcards = state.flashcards.filter(
      (fc) => fc.concept_id == null || !conceptIds.has(fc.concept_id)
    );
    state.mindmapAssociations = state.mindmapAssociations.filter(
      (a) => !assetIds.has(a.target_id)
    );

    persist('courses');
    persist('lessons');
    persist('exercises');
    persist('exerciseSubmissions');
    persist('simulatedQuizzes');
    persist('simulatedQuizAttempts');
    persist('lessonProgress');
    persist('lessonPatches');
    persist('lessonLoopReceipts');
    persist('flashcards');
    persist('mindmapAssociations');
  },

  // -------- exercise submission flow (4-state machine) --------
  async submitExercise(input) {
    const now = new Date().toISOString();
    const next: ExerciseSubmission = {
      ...input,
      id: genId('sub') as ExerciseSubmissionId,
      status: 'submitted',
      submitted_at: now,
    };
    state.exerciseSubmissions.push(next);
    persist('exerciseSubmissions');

    // Mock async grading after a short delay (simulates 老师定时上班)
    void simulateGrading(next.id, input.learner_answer);

    return next;
  },
  async submitExerciseWithConfidence(input) {
    const now = new Date().toISOString();
    const allowed = mockConfidenceCaptureAllowed();
    const next: ExerciseSubmissionWithConfidence = {
      exercise_id: input.exercise_id,
      learner_id: input.learner_id,
      learner_answer: input.learner_answer,
      id: genId('sub') as ExerciseSubmissionId,
      status: 'submitted',
      submitted_at: now,
      // 双轨存储: confidence 是事实层(学习者按的哪个按钮), confidence_pct 是
      // 建模层——用这个 pair *当刻*的锚值折算, 从不信任 input.confidence_pct
      // (前端可能带着缓存的旧锚值), 镜像服务端 routes/write.ts 的权威计算。
      confidence: allowed ? (input.confidence ?? null) : null,
      confidence_pct: allowed && input.confidence ? state.confidenceAnchorPct[input.confidence] : null,
    };
    state.exerciseSubmissions.push(next);
    persist('exerciseSubmissions');
    void simulateGrading(next.id, input.learner_answer);
    return next;
  },
  async resubmitExercise(previous_id, new_answer) {
    const prev = state.exerciseSubmissions.find((s) => s.id === previous_id);
    if (!prev) throw new Error(`submission ${previous_id} not found`);
    const now = new Date().toISOString();
    const next: ExerciseSubmission = {
      id: genId('sub') as ExerciseSubmissionId,
      exercise_id: prev.exercise_id,
      learner_id: prev.learner_id,
      learner_answer: new_answer,
      status: 'submitted',
      submitted_at: now,
      previous_submission_id: previous_id,
    };
    state.exerciseSubmissions.push(next);
    persist('exerciseSubmissions');
    void simulateGrading(next.id, new_answer);
    return next;
  },
  async gradeExercise(id, feedback, score) {
    const idx = state.exerciseSubmissions.findIndex((s) => s.id === id);
    if (idx < 0) throw new Error(`submission ${id} not found`);
    state.exerciseSubmissions[idx] = {
      ...state.exerciseSubmissions[idx]!,
      status: 'graded',
      agent_feedback: feedback,
      agent_score: score,
      graded_at: new Date().toISOString(),
    };
    persist('exerciseSubmissions');
    return state.exerciseSubmissions[idx]!;
  },
  // 反刍窗口 — mirrors write.ts's PATCH
  // /submissions/:id: editable until graded, 409-equivalent (AlreadyGradedError)
  // once graded_at/status='graded' land.
  async editSubmission(id, learner_answer) {
    const idx = state.exerciseSubmissions.findIndex((s) => s.id === id);
    if (idx < 0) throw new Error(`submission ${id} not found`);
    const cur = state.exerciseSubmissions[idx]!;
    if (cur.status === 'graded' || cur.graded_at != null) {
      throw new AlreadyGradedError('批改已定格，请新开提交（resubmit）或留言，不改原卷。');
    }
    state.exerciseSubmissions[idx] = { ...cur, learner_answer };
    persist('exerciseSubmissions');
    return state.exerciseSubmissions[idx]!;
  },

  // -------- lesson progress / patches / receipts --------
  async getLessonProgress(pair_id, lesson_id) {
    const row = state.lessonProgress.find(
      (p) => p.pair_id === pair_id && p.lesson_id === lesson_id
    );
    return row ?? mockSynthesizedProgress(pair_id, lesson_id);
  },
  async getCourseProgress(pair_id, course_id) {
    const courseLessons = state.lessons
      .filter((l) => l.course_id === course_id)
      .sort((a, b) => a.order - b.order);
    return courseLessons.map(
      (l) =>
        state.lessonProgress.find((p) => p.pair_id === pair_id && p.lesson_id === l.id) ??
        mockSynthesizedProgress(pair_id, l.id)
    );
  },
  async declareLessonCompleted(pair_id, lesson_id, input) {
    const idx = state.lessonProgress.findIndex(
      (p) => p.pair_id === pair_id && p.lesson_id === lesson_id
    );
    const existing = idx >= 0 ? state.lessonProgress[idx] : undefined;
    if (existing?.state === 'closed') {
      throw new Error('already_closed: 这节课已回课(closed) — 不能再宣布已学完。');
    }
    // 足迹只增不减 (迁移 0037, 学习者裁决第三针) — 镜像 routes/write.ts 同名
    // 端点: pages_read 不再信任 input 里的瞬时"当前页", 改算 pages_visited
    // 足迹集合 ∪ 本次声明附带的 current_page_index。
    const currentPageIndex =
      typeof input.current_page_index === 'number' && Number.isInteger(input.current_page_index) && input.current_page_index >= 0
        ? input.current_page_index
        : undefined;
    const existingPagesVisited = existing?.pages_visited ?? [];
    const mergedPagesVisited =
      currentPageIndex !== undefined && !existingPagesVisited.includes(currentPageIndex)
        ? [...existingPagesVisited, currentPageIndex]
        : existingPagesVisited;
    const snapshot = mockComputeChecklistSnapshot(
      lesson_id,
      {
        pages_total: input.pages_total ?? null,
        pages_read: mergedPagesVisited.length > 0 ? mergedPagesVisited.length : null,
      },
      input.gaps ?? []
    );
    const now = new Date().toISOString();
    const next: LessonProgress = {
      id: existing?.id ?? genId('lprog'),
      pair_id,
      lesson_id,
      state: 'completed_declared',
      declared_at: now,
      closed_at: existing?.closed_at ?? null,
      checklist_snapshot: snapshot,
      prerequisite_skips: existing?.prerequisite_skips ?? [],
      pages_visited: mergedPagesVisited,
      updated_at: now,
    };
    if (idx >= 0) {
      state.lessonProgress[idx] = next;
    } else {
      state.lessonProgress.push(next);
    }
    persist('lessonProgress');
    return next;
  },
  async getLessonPatches(lesson_id) {
    return state.lessonPatches
      .filter((p) => p.lesson_id === lesson_id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  },
  async getLessonLoopReceipts(lesson_id) {
    return state.lessonLoopReceipts
      .filter((r) => r.lesson_id === lesson_id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  },

  // -------- mindmap --------
  async createMindmap(input) {
    const now = new Date().toISOString();
    const seed = input.agent_seed_snapshot ?? input.content;
    const next: Mindmap = {
      ...input,
      id: genId('mm') as MindmapId,
      agent_seed_snapshot: clone(seed),
      has_been_reset: false,
      created_at: now,
      updated_at: now,
    };
    state.mindmaps.push(next);
    persist('mindmaps');
    return next;
  },
  async updateMindmapContent(id, content) {
    const idx = state.mindmaps.findIndex((m) => m.id === id);
    if (idx < 0) throw new Error(`mindmap ${id} not found`);
    state.mindmaps[idx] = {
      ...state.mindmaps[idx]!,
      content,
      updated_at: new Date().toISOString(),
    };
    persist('mindmaps');
    return state.mindmaps[idx]!;
  },
  async updateMindmapTitle(id, title) {
    const idx = state.mindmaps.findIndex((m) => m.id === id);
    if (idx < 0) throw new Error(`mindmap ${id} not found`);
    state.mindmaps[idx] = {
      ...state.mindmaps[idx]!,
      title,
      updated_at: new Date().toISOString(),
    };
    persist('mindmaps');
    return state.mindmaps[idx]!;
  },
  async resetMindmap(id) {
    const idx = state.mindmaps.findIndex((m) => m.id === id);
    if (idx < 0) throw new Error(`mindmap ${id} not found`);
    state.mindmaps[idx] = {
      ...state.mindmaps[idx]!,
      content: { nodes: [], links: [] },
      has_been_reset: true,
      updated_at: new Date().toISOString(),
    };
    persist('mindmaps');
    return state.mindmaps[idx]!;
  },
  async restoreMindmapFromSeed(id) {
    const idx = state.mindmaps.findIndex((m) => m.id === id);
    if (idx < 0) throw new Error(`mindmap ${id} not found`);
    const seed = clone(state.mindmaps[idx]!.agent_seed_snapshot);
    state.mindmaps[idx] = {
      ...state.mindmaps[idx]!,
      content: seed,
      has_been_reset: false,
      updated_at: new Date().toISOString(),
    };
    persist('mindmaps');
    return state.mindmaps[idx]!;
  },
  async addMindmapAssociation(mindmap_id, target_type, target_id) {
    const assoc: MindmapAssociation = {
      id: genId('mma'),
      mindmap_id,
      target_type: target_type as MindmapAssociationTargetType,
      target_id,
      created_at: new Date().toISOString(),
    };
    state.mindmapAssociations.push(assoc);
    persist('mindmapAssociations');
    return assoc;
  },
  async removeMindmapAssociation(association_id) {
    state.mindmapAssociations = state.mindmapAssociations.filter((a) => a.id !== association_id);
    persist('mindmapAssociations');
  },

  // -------- pending card --------
  async placePendingCard(card_id, mindmap_id, pos) {
    const cardIdx = state.pendingCards.findIndex((p) => p.id === card_id);
    if (cardIdx < 0) throw new Error(`pending card ${card_id} not found`);
    const mmIdx = state.mindmaps.findIndex((m) => m.id === mindmap_id);
    if (mmIdx < 0) throw new Error(`mindmap ${mindmap_id} not found`);
    const card = state.pendingCards[cardIdx]!;
    // Card title carries a short label; card content is the actual body.
    // We put the body in the node title so it renders in the pill (LS
    // note pills show title with no line-clamp — full multi-line body).
    // Content field kept for compatibility but no longer displayed.
    const body = card.content?.trim() || card.title;
    const node: MindmapNode = {
      id: genId('n'),
      title: body,
      content: card.content,
      level: 'note',
      source_type: card.source_type === 'agent_seed' ? 'custom' : (card.source_type as MindmapNode['source_type']),
      source_id: card.source_id,
      source_title: card.source_title,
      pos_x: pos.x,
      pos_y: pos.y,
      // is_pinned = true so the auto-layout doesn't sweep the free-
      // floating note back into the tree — user placed it at pos.
      is_pinned: true,
      is_expanded: false,
      sort_order: state.mindmaps[mmIdx]!.content.nodes.length,
    };
    state.mindmaps[mmIdx] = {
      ...state.mindmaps[mmIdx]!,
      content: {
        nodes: [...state.mindmaps[mmIdx]!.content.nodes, node],
        links: state.mindmaps[mmIdx]!.content.links,
      },
      updated_at: new Date().toISOString(),
    };
    state.pendingCards[cardIdx] = {
      ...card,
      placed_in_mindmap_id: mindmap_id,
    };
    persist('mindmaps');
    persist('pendingCards');
    return node;
  },
  async dismissPendingCard(card_id) {
    state.pendingCards = state.pendingCards.filter((p) => p.id !== card_id);
    persist('pendingCards');
  },
  async addPendingCard(pair_id, card) {
    const newCard: PendingMindmapCard = {
      id: genId('pcard') as PendingCardId,
      owner_pair_id: pair_id,
      title: card.title,
      content: card.content,
      source_type: card.source_type,
      source_id: card.source_id,
      source_title: card.source_title,
      reason: card.reason,
      created_at: new Date().toISOString(),
    };
    state.pendingCards = [...state.pendingCards, newCard];
    persist('pendingCards');
    return newCard;
  },

  // -------- quiz attempts --------
  async submitQuizAttempt(input) {
    const now = new Date().toISOString();
    const correctCount = input.answers.filter((a) => a.correct).length;
    const score = input.answers.length > 0 ? correctCount / input.answers.length : 0;
    const next: QuizAttempt = {
      ...input,
      id: genId('qa') as QuizAttemptId,
      started_at: now,
      score,
    };
    state.quizAttempts.push(next);
    persist('quizAttempts');
    return next;
  },
  async finishQuizAttempt(id) {
    const idx = state.quizAttempts.findIndex((a) => a.id === id);
    if (idx < 0) throw new Error(`attempt ${id} not found`);
    state.quizAttempts[idx] = {
      ...state.quizAttempts[idx]!,
      finished_at: new Date().toISOString(),
    };
    persist('quizAttempts');
    return state.quizAttempts[idx]!;
  },

  // -------- SimulatedQuiz attempts (round 3 Quiz 通电) --------
  // 判分口径注释修正: 这里曾经写"Server (write.ts) owns the same grading logic —
  // duplicated here intentionally"——是谎言。routes/ 下没有 simulated-quiz-
  // attempt 判分路由，判分 100% 在这里（客户端 gradeSimulatedAnswer）算完再
  // POST 结果上去；server 端目前只负责存, 不判分。真判分归属（要不要挪到
  // server 端、要不要认证）待信任边界工程一并定夺。
  async submitSimulatedQuizAttempt(input) {
    const quiz = state.simulatedQuizzes.find((q) => q.id === input.quiz_id);
    if (!quiz) throw new Error(`simulated quiz ${input.quiz_id} not found`);

    // Learner Model 批1 (LEARNER-MODEL-BRIEF §9 考场条款) — same gate
    // server-side write.ts applies before persisting per-answer confidence.
    const confidenceAllowed = mockConfidenceCaptureAllowed();

    const graded: SimulatedQuizAttemptAnswerWithConfidence[] = input.answers.map((a) => {
      const q = quiz.questions.find((qq) => qq.id === a.question_id);
      const correct = q ? gradeSimulatedAnswer(q, a.answer) : undefined;
      const base: SimulatedQuizAttemptAnswerWithConfidence =
        correct === undefined
          ? { question_id: a.question_id, answer: a.answer }
          : { question_id: a.question_id, answer: a.answer, correct };
      if (confidenceAllowed && a.confidence) {
        base.confidence = a.confidence;
        // 服务端权威计算, 不信任 a.confidence_pct — 同 submitExerciseWithConfidence
        // 上方注释的双轨存储理由。
        base.confidence_pct = state.confidenceAnchorPct[a.confidence];
      }
      return base;
    });
    const gradable = graded.filter((g) => g.correct !== undefined);
    const score =
      gradable.length > 0 ? gradable.filter((g) => g.correct).length / gradable.length : undefined;

    const now = new Date().toISOString();
    const next: SimulatedQuizAttemptWithConfidence = {
      id: genId('sqa') as SimulatedQuizAttemptId,
      quiz_id: input.quiz_id,
      learner_id: input.learner_id,
      started_at: now,
      finished_at: now,
      answers: graded,
      score,
    };
    state.simulatedQuizAttempts.push(next);
    persist('simulatedQuizAttempts');
    return next;
  },

  // -------- feedback --------
  async submitFeedback(input) {
    const now = new Date().toISOString();
    const next: LearnerFeedback = {
      ...input,
      id: genId('fb') as ReturnType<typeof load<LearnerFeedback[]>>[number]['id'],
      submitted_at: now,
    };
    state.feedback.push(next);
    persist('feedback');
    return next;
  },

  // -------- reminder --------
  async dispatchReminder(input) {
    const now = new Date().toISOString();
    const next: Reminder = {
      ...input,
      id: genId('rmd') as ReminderId,
      created_at: now,
      fired_at: now,
    };
    state.reminders.push(next);
    persist('reminders');
    return next;
  },
  async dismissReminder(id) {
    const idx = state.reminders.findIndex((r) => r.id === id);
    if (idx >= 0) {
      state.reminders[idx] = {
        ...state.reminders[idx]!,
        dismissed_at: new Date().toISOString(),
      };
      persist('reminders');
    }
  },
};

// ============================================================================
// Mock-only background simulators (run async, no UI blocking)
// ============================================================================

// Simulate agent batch-grading after a 3-second "老师上班" delay
async function simulateGrading(submission_id: ExerciseSubmissionId, learner_answer: string) {
  await tick(3_000);
  const idx = state.exerciseSubmissions.findIndex((s) => s.id === submission_id);
  if (idx < 0) return;
  const cur = state.exerciseSubmissions[idx]!;
  if (cur.status !== 'submitted') return; // user withdrew or already graded

  // Move through pending_grade for a tick (visual progress)
  state.exerciseSubmissions[idx] = { ...cur, status: 'pending_grade' };
  persist('exerciseSubmissions');
  await tick(2_000);

  const len = learner_answer.trim().length;
  const score = len < 40 ? 0.45 : len < 120 ? 0.7 : 0.85;
  const feedback =
    score < 0.6
      ? '答案方向对了, 但论据不够展开. 试着把"为什么"再讲一层.'
      : score < 0.8
        ? '基本对了 ✓ 如果能补一个跟你自己 portfolio 相关的例子, 会更扎实.'
        : '很好, 这个答案能直接放进笔记里. 继续保持.';

  const finalIdx = state.exerciseSubmissions.findIndex((s) => s.id === submission_id);
  if (finalIdx < 0) return;
  state.exerciseSubmissions[finalIdx] = {
    ...state.exerciseSubmissions[finalIdx]!,
    status: 'graded',
    agent_feedback: feedback,
    agent_score: score,
    graded_at: new Date().toISOString(),
  };
  persist('exerciseSubmissions');
}

// ============================================================================
// Live Teaching mock simulator (Stage 7c).
//
// The agent-side is faked: we walk a fixed script after each learner
// response. Real agent loop (CC CLI ↔ MCP) lands in stage 7d.
// Script is CFA · FRA · indirect cash flow themed for the dogfood path.
//
// response_kind validation mirrors Hub backend:
//   ASK / PROBE / CHALLENGE  → MUST be 'text'
//   FRAME / EXPLAIN / HINT   → 'continue' | 'none'
//   REFLECT                  → 'none'
// ============================================================================
function validateMove(move_type: MoveType, response_kind: ResponseKind): void {
  const requireText = (['ASK', 'PROBE', 'CHALLENGE'] as MoveType[]).includes(
    move_type
  );
  if (requireText && response_kind !== 'text') {
    throw new Error(`${move_type} requires response_kind='text'`);
  }
  if (move_type === 'REFLECT' && response_kind !== 'none') {
    throw new Error(`REFLECT requires response_kind='none'`);
  }
}

// SimulatedQuiz grading — 判分口径注释修正: 这条注释曾经说"mirrors apps/server/src/
// routes/write.ts's gradeSimulatedAnswer"——write.ts 里没有这个函数，routes/
// 下也没有任何 simulated-quiz-attempt 判分路由。真相：这就是唯一的判分实现，
// 纯客户端算完直接落 mock 状态；server 端（真机走 REST，见 add_simulated_quiz
// 的 reference_answer 校验器 apps/server/src/lib/validate-simulated-quiz.ts）
// 只校验写入形状，不判分、不复算。是否该在 server 端补一份真判分（连带认证）
// 留给信任边界工程定夺。
function gradeSimulatedAnswer(q: SimulatedQuestion, answer: string): boolean | undefined {
  const qType = q.question_type ?? 'short_answer';
  if (qType === 'single_choice') {
    return answer.trim() === q.reference_answer.trim();
  }
  if (qType === 'multi_choice') {
    // ' || ' separator — multi_choice reference_answer 分隔约定（竖线分隔约定），
    // add_simulated_quiz 校验器（lib/validate-simulated-quiz.ts）同制。
    const given = new Set(
      answer
        .split('||')
        .map((s) => s.trim())
        .filter(Boolean)
    );
    const ref = new Set(
      q.reference_answer
        .split('||')
        .map((s) => s.trim())
        .filter(Boolean)
    );
    if (given.size === 0 || given.size !== ref.size) return false;
    for (const g of given) if (!ref.has(g)) return false;
    return true;
  }
  return undefined; // short_answer / essay — ungraded
}

interface MockMove {
  move_type: MoveType;
  content: string;
  response_kind: ResponseKind;
}

const MOCK_LIVE_SCRIPT: MockMove[] = [
  {
    move_type: 'FRAME',
    response_kind: 'continue',
    content:
      'Welcome to this lesson. We will walk through indirect cash flow together — intuition first, then the formula, then a worked example. Tap continue when you are ready.',
  },
  {
    move_type: 'ASK',
    response_kind: 'text',
    content:
      'Before any formula: in your own words, what does "cash flow from operations" mean to a small business owner?',
  },
  {
    move_type: 'EXPLAIN',
    response_kind: 'continue',
    content:
      'Right. CFO is the cash actually moving in and out from running the business — distinct from net income, which is the accountants\' record of what was earned. Indirect method bridges those two by reversing non-cash and timing-mismatched items out of net income.',
  },
  {
    move_type: 'ASK',
    response_kind: 'text',
    content:
      'Quick check: if accounts receivable increases by $50 during the year, does the indirect method add or subtract that $50 when computing CFO? And why?',
  },
  {
    move_type: 'EXPLAIN',
    response_kind: 'continue',
    content:
      'Subtract. The $50 sale was recorded in net income, but the cash has not arrived yet — so we back it out to land on what the bank account actually saw. Direction rule: increase in current asset → subtract; decrease → add. Liabilities mirror it.',
  },
  {
    move_type: 'REFLECT',
    response_kind: 'none',
    content:
      'Today: 1) net income vs CFO — accountant view vs bank-account view. 2) Direction rule for working-capital adjustments. Next session hook: depreciation as the canonical non-cash add-back.',
  },
];

async function simulateAgentTurn(session_id: LiveSessionId) {
  // ~700ms thinking pause to feel agent-like.
  await tick(700);
  const idx = state.liveSessions.findIndex((s) => s.id === session_id);
  if (idx < 0) return;
  const session = state.liveSessions[idx]!;
  if (session.status !== 'active') return;
  if (session.awaiting_role !== 'agent') return;

  const movesCount = state.teachingMoves.filter(
    (m) => m.session_id === session_id
  ).length;
  if (movesCount >= MOCK_LIVE_SCRIPT.length) return; // script exhausted
  const next = MOCK_LIVE_SCRIPT[movesCount]!;

  const now = new Date().toISOString();
  const move: TeachingMove = {
    id: genId('tmv') as TeachingMoveId,
    session_id,
    seq: movesCount + 1,
    move_type: next.move_type,
    content: next.content,
    response_kind: next.response_kind,
    created_at: now,
  };
  state.teachingMoves.push(move);
  persist('teachingMoves');

  // Flip awaiting + status.
  const awaiting: AwaitingRole =
    next.move_type === 'REFLECT'
      ? 'none'
      : next.response_kind === 'none'
        ? 'none'
        : 'learner';
  const wasReflect = next.move_type === 'REFLECT';
  state.liveSessions[idx] = {
    ...session,
    awaiting_role: awaiting,
    last_activity_at: now,
    status: wasReflect ? 'completed' : 'active',
    summary: wasReflect
      ? 'Covered net-income vs CFO mental model + working-capital direction rule.'
      : session.summary,
    teacher_reflection: wasReflect
      ? 'Learner picked up the direction rule on first try but hesitated on the why — anchor next session in a worked example to solidify.'
      : session.teacher_reflection,
    next_action: wasReflect
      ? 'Next lesson: depreciation as the canonical non-cash add-back.'
      : session.next_action,
    ended_at: wasReflect ? now : session.ended_at,
  };
  persist('liveSessions');
}

// Stage 7d-fix: trivial Ad Hoc reply simulator. When a user message is
// appended, an agent reply lands ~1s later. Mock-only; real agent goes
// through MCP adhoc_message_send.
async function simulateAdHocReply(thread_id: AdHocThreadId, user_text: string) {
  await tick(900);
  const tIdx = state.adHocThreads.findIndex((t) => t.id === thread_id);
  if (tIdx < 0) return;
  // Take the snapshot from the latest user message in the thread.
  const lastUser = [...state.adHocMessages]
    .reverse()
    .find((m) => m.thread_id === thread_id && m.role === 'user');
  if (!lastUser) return;
  const now = new Date().toISOString();
  const reply: AdHocMessage = {
    id: genId('ahm') as AdHocMessageId,
    thread_id,
    role: 'agent',
    content: `(Mock 应答) 收到："${user_text.slice(0, 60)}"——真实 agent 接通 MCP 后会替这里。`,
    context_snapshot: lastUser.context_snapshot,
    is_learning_related: lastUser.is_learning_related,
    client_message_id: genId('cli'),
    created_at: now,
  };
  state.adHocMessages.push(reply);
  persist('adHocMessages');
  state.adHocThreads[tIdx] = {
    ...state.adHocThreads[tIdx]!,
    message_count: state.adHocThreads[tIdx]!.message_count + 1,
    last_activity_at: now,
  };
  persist('adHocThreads');
}

// Stage 6b: per-lesson prep simulator (LESSON-PREP-BRIEF).
//
// For each selected lesson: flip status `proposed` → `generating` (~3s),
// generate placeholder content, then flip to `generated`. Sequential —
// later lessons may reference earlier ones, no parallelism.
//
// Unselected lessons stay `proposed`; user can come back later via [+]
// (stage 7+).
//
// At completion: contract.setup_status flips to 'ready' + dispatches
// `setup_complete` reminder via configured channels.
// ============================================================================
async function simulateLessonGeneration(
  contract_id: ContractId,
  selected_lesson_ids: string[]
) {
  const PER_LESSON_MS = 3_000;

  for (const lessonId of selected_lesson_ids) {
    // bail out if contract was cancelled
    const ci = state.contracts.findIndex((c) => c.id === contract_id);
    if (ci < 0) return;
    if (state.contracts[ci]!.setup_status !== 'generating') return;

    // 迁移 0030: Lesson.status(生成态) 列拆除 — 此处曾在生成中途翻一次占位
    // 状态, 该列从未被真实写路径消费, 已随基建批一并退役。保留延时模拟生成
    // 耗时, 只是不再写一个没人读的字段。
    const li = state.lessons.findIndex((l) => l.id === lessonId);
    if (li < 0) continue;

    await tick(PER_LESSON_MS);

    // re-check after the wait
    const ci2 = state.contracts.findIndex((c) => c.id === contract_id);
    if (ci2 < 0) return;
    if (state.contracts[ci2]!.setup_status !== 'generating') return;

    const li2 = state.lessons.findIndex((l) => l.id === lessonId);
    if (li2 < 0) continue;
    state.lessons[li2] = {
      ...state.lessons[li2]!,
      // mock content placeholder — stage 7+ real agent fills the 4 artifacts
      content_markdown: `# ${state.lessons[li2]!.title}\n\n_(Mock content — stage 7+ agent generation will populate this with the full lesson body, flashcards, exercises, and mindmap seed per the lesson-prep workflow.)_`,
    };
    persist('lessons');
  }

  // All selected lessons done → contract.setup_status='ready'
  const ci3 = state.contracts.findIndex((c) => c.id === contract_id);
  if (ci3 < 0) return;
  if (state.contracts[ci3]!.setup_status !== 'generating') return;
  const completedAt = new Date().toISOString();
  const finalContract: TeachingContract = {
    ...state.contracts[ci3]!,
    setup_status: 'ready',
    setup_completed_at: completedAt,
    updated_at: completedAt,
  };
  state.contracts[ci3] = finalContract;
  persist('contracts');

  // dispatch setup_complete reminder per channel
  const channels = finalContract.reminder_channels ?? ['in_app'];
  for (const ch of channels) {
    const rmd: Reminder = {
      id: genId('rmd') as ReminderId,
      pair_id: finalContract.pair_id,
      type: 'setup_complete',
      scheduled_for: completedAt,
      channel: ch,
      fired_at: completedAt,
      payload: {
        contract_id: finalContract.id,
        contract_goal: finalContract.goal,
        lessons_generated: selected_lesson_ids.length,
      },
      created_at: completedAt,
    };
    state.reminders.push(rmd);
  }
  persist('reminders');
}

export default MockRepository;
