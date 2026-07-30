// Repository interface — shared by MockRepository (W1) and HttpRepository (W2+).
//
// Round 2: 大幅扩展 — 从 read-only 变成 read + write,
// 加入 TEACHING-SPEC-v1 §7 list 的所有 mutation 方法.
// W1 用 localStorage 模拟持久化; W2+ 走 MCP/HTTP.

import type {
  Learner,
  Agent,
  AgentId,
  LearnerAgentPair,
  TeachingContract,
  PairId,
  ContractId,
  LearnerId,
} from './pair';
import type {
  Course,
  CourseId,
  CourseFootprint,
  Lesson,
  LessonId,
  LessonRevision,
  LessonRevisionKind,
  Flashcard,
  FlashcardId,
} from './content';
import type {
  FSRSRating,
  LearningSession,
  LearningSessionMode,
  SessionEvent,
  SessionId,
  TrialVerdict,
} from './session';
import type { LearnerHypothesis, TeacherReflection } from './teacher-growth';
import type { Exercise, ExerciseSubmission, ExerciseSubmissionId } from './exercise';
import type {
  SimulatedQuiz,
  QuestionBank,
  QuestionBankId,
  QuizQuestion,
  QuizAttempt,
  QuizAttemptId,
} from './quiz';
import type {
  Mindmap,
  MindmapId,
  MindmapContent,
  MindmapAssociation,
  MindmapAssociationTargetType,
  MindmapNode,
  PendingMindmapCard,
  PendingCardId,
} from './mindmap';
import type { LearnerFeedback } from './feedback';
import type { Reminder, ReminderId } from './reminder';
import type { PostLessonEvaluation, LiveSessionEvaluation } from './evaluation';
import type {
  BridgeHeartbeatInput,
  BridgePendingResponse,
  BridgeStatus,
  LiveContextType,
  LiveSession,
  LiveSessionFullView,
  LiveSessionId,
  LiveSessionListItem,
  LiveSessionStatus,
  MidLessonSnapshot,
  MoveType,
  ResponseInputType,
  ResponseKind,
  TeachingMove,
  TeachingMoveId,
  TeachingResponse,
} from './teaching';
import type {
  AdHocContextSnapshot,
  AdHocMessage,
  AdHocMessageId,
  AdHocPayload,
  AdHocThread,
  AdHocThreadFullView,
  AdHocThreadId,
} from './adhoc';
import type { AnnotationColorKey, AnnotationId, LessonAnnotation } from './annotation';

export type DataLayerMode = 'mock' | 'http' | 'memory';

export interface Repository {
  readonly mode: DataLayerMode;

  // -------- pair + contract (read) --------
  getCurrentPair(): Promise<LearnerAgentPair | null>;
  getActiveContract(pair_id: PairId): Promise<TeachingContract | null>;
  getAllContracts(pair_id: PairId): Promise<TeachingContract[]>;
  getLearner(): Promise<Learner | null>;
  getAgent(agent_id: AgentId): Promise<Agent | null>;

  // -------- content (read) --------
  getCourses(pair_id: PairId): Promise<Course[]>;
  getCourse(course_id: CourseId): Promise<Course | null>;
  /** asset counts a course-delete would sweep up (confirm-before-
   *  you-nuke-it UI). Rejects if the course doesn't exist (mirrors the
   *  server's 404 — this is a precondition check, not a nullable read). */
  getCourseFootprint(course_id: CourseId): Promise<CourseFootprint>;
  getLessons(course_id: CourseId): Promise<Lesson[]>;
  /** update_lesson — most recent revision record for a lesson's
   *  Revised pill (`reason` + date). Null if the lesson has never been
   *  revised (revision === 1). */
  getLatestLessonRevision(lesson_id: LessonId): Promise<LessonRevision | null>;
  /** full revision history ("病历本") for a lesson's Revised pill
   *  popover: every row in `lesson_revisions`, newest first. Empty array if
   *  the lesson has never been revised (in the requested track).
   *  迁移 0033 (双轨修订) — 可选 `kind` 过滤: 缺省/未传 = 'teaching'
   *  (学习者界面默认口径, 工程性修订对她隐身); 传 'technical' 或 'all' 才
   *  看得见后厨事务。不传 kind 与旧调用行为兼容(结果范围收紧为 teaching, 不
   *  是签名变化)。 */
  getLessonRevisions(
    lesson_id: LessonId,
    kind?: LessonRevisionKind | 'all'
  ): Promise<LessonRevision[]>;
  getDueReviews(pair_id: PairId, limit?: number): Promise<Flashcard[]>;
  /** Stage 7e-cards: all flashcards for management. Includes paused. */
  getAllFlashcards(pair_id: PairId): Promise<Flashcard[]>;

  // -------- State 2.0 axes (迁移 0030) --------
  /** 进行中接线 — Lesson 页首次打开某课时的幂等 ping. 服务端更新
   *  lesson_progress 的 in_progress 落点 / touch 时间戳; POST
   *  /lessons/:id/progress/touch. 静默失败 — 调用方(Lesson.tsx) 不对
   *  reject 做任何 UI 反应, 不打扰学习者。
   *  `page_index` (迁移 0037, 学习者裁决第三针, 2026-07-20) — 可选, 0-based
   *  分页索引: PagedLesson 每次翻到一页静默带上这个值再 touch 一次, 服务端
   *  并入 lesson_progress.pages_visited 足迹集合(去重, 只增不减)。省略时
   *  行为与迁移前完全一致(纯 in_progress ping, 不动 pages_visited)。 */
  touchLessonProgress(lesson_id: LessonId, page_index?: number): Promise<void>;
  /** 修订回执制 (学习者裁决 A) — 服务端真相替换 lesson/revisionSeen.ts 的
   *  localStorage 方案. 记录"这个学习者把这节课读到当前 revision 了";
   *  POST /lessons/:id/revision-seen. (pair_id, lesson_id) 唯一, 服务端从
   *  当前登录 pair 推导, 不在参数里显式传. */
  markRevisionSeen(lesson_id: LessonId): Promise<void>;

  // -------- session (read) --------
  getRecentSessions(pair_id: PairId, limit?: number): Promise<LearningSession[]>;
  getSession(session_id: SessionId): Promise<LearningSession | null>;
  getSessionEvents(session_id: SessionId): Promise<SessionEvent[]>;

  // -------- learning evidence (write) --------
  /** Rate a flashcard: runs FSRS scheduling server-side and appends a
   *  `review.rated` session event. Returns the rescheduled card. */
  recordReview(input: {
    pair_id: PairId;
    card_id: FlashcardId;
    rating: FSRSRating;
    answer_text?: string | null;
    time_to_answer_ms?: number | null;
  }): Promise<Flashcard>;
  /** Append a client-observed learning event (e.g. lesson.viewed) to the
   *  open learning session. Fire-and-forget from the UI's perspective. */
  recordLearningEvent(input: {
    pair_id: PairId;
    event_type:
      | 'lesson.viewed'
      | 'concept.touched'
      | 'document.viewed'
      | 'mindmap.viewed'
      | 'review.viewed';
    payload: Record<string, unknown>;
    mode?: LearningSessionMode;
  }): Promise<void>;
  /** Append a `trial.attempted` event — every "Check answer" click on a
   *  `:::trial` block (docs/LESSON-BLOCKS-v1.md §2.3), including retries and
   *  the reveal click on ungraded (`self_check`) trials. Same
   *  sessions/events wire path as `recordLearningEvent`, split into its own
   *  method because the payload shape is fixed (5 required fields), not a
   *  free-form bag. Fire-and-forget from the UI's perspective. */
  recordTrialAttempt(input: {
    pair_id: PairId;
    lesson_id: LessonId;
    trial_index: number;
    verdict: TrialVerdict;
    attempts: number;
    draft: string;
    mode?: LearningSessionMode;
  }): Promise<void>;

  // -------- teacher growth (read) --------
  getHypotheses(pair_id: PairId): Promise<LearnerHypothesis[]>;
  getReflections(pair_id: PairId): Promise<TeacherReflection[]>;
  getPostLessonEvaluations(pair_id: PairId): Promise<PostLessonEvaluation[]>;
  /** 评估两区 (学习者裁决 B) — 课级总评, 一课一份 (post_lesson_evaluations
   *  的 (pair_id, lesson_id) 唯一约束). 复用既有 /pairs/:pairId/evaluations
   *  批量端点按 lesson_id 过滤, 不新增 server 路由 — 该端点已经把所需字段全
   *  带出来了。Null when this lesson has no evaluation yet. */
  getPostLessonEvaluation(
    pair_id: PairId,
    lesson_id: LessonId
  ): Promise<PostLessonEvaluation | null>;
  /** 评估两区 (学习者裁决 B) — 单场 live session 的现场评估 (设计稿 §9.1/9.2,
   *  live_session_evaluations 表, 一场一评). 迁移 0030 (State 2.0):
   *  apps/server/src/routes/teaching.ts 目前没有对应的 GET
   *  /teaching/sessions/:id/evaluation 端点 — 缺口, 由服务端纵队补; 在此之前
   *  HttpRepository 这次调用会打到不存在的路由 (调用方需吞掉 404/error, 静默
   *  不渲染, 见 Lesson.tsx LiveHistory 尾部的"本场评价"小块)。 */
  getLiveSessionEvaluation(live_session_id: LiveSessionId): Promise<LiveSessionEvaluation | null>;

  // -------- teacher growth (write) --------
  /** Learner-sovereignty review: confirm / reject / freeze an agent hypothesis. */
  reviewHypothesis(
    id: string,
    action: 'confirm' | 'reject' | 'freeze',
    user_note?: string
  ): Promise<LearnerHypothesis>;

  // ===========================================================================
  // round 2 新增 (read)
  // ===========================================================================

  // -------- exercise --------
  getExercises(lesson_id: LessonId): Promise<Exercise[]>;
  getExerciseSubmissions(
    learner_id: LearnerId,
    exercise_id?: import('./exercise').ExerciseId
  ): Promise<ExerciseSubmission[]>;

  // -------- quiz --------
  getSimulatedQuizzes(pair_id: PairId, course_id?: CourseId): Promise<SimulatedQuiz[]>;
  getQuestionBanks(): Promise<QuestionBank[]>;
  getQuizQuestions(bank_id: QuestionBankId): Promise<QuizQuestion[]>;
  getQuizAttempts(learner_id: LearnerId): Promise<QuizAttempt[]>;

  // -------- mindmap --------
  getMindmapsForLesson(lesson_id: LessonId): Promise<Mindmap[]>;
  getMindmapsForCourse(course_id: CourseId): Promise<Mindmap[]>;
  getCustomMindmaps(pair_id: PairId): Promise<Mindmap[]>;
  getAllMindmaps(pair_id: PairId): Promise<Mindmap[]>;
  getMindmap(id: MindmapId): Promise<Mindmap | null>;
  getMindmapAssociations(mindmap_id: MindmapId): Promise<MindmapAssociation[]>;
  getPendingCards(pair_id: PairId): Promise<PendingMindmapCard[]>;

  // -------- feedback / reminder --------
  getFeedback(pair_id: PairId): Promise<LearnerFeedback[]>;
  getReminders(pair_id: PairId): Promise<Reminder[]>;

  // ===========================================================================
  // round 2 新增 (write) — W1 localStorage; W2+ MCP/HTTP
  // ===========================================================================

  // -------- Live Teaching (Stage 7c, ported from Hub) --------
  /**
   * Active or most-recent live session for a (pair, lesson). Returns null if
   * none. Used by Lesson page's right-panel to decide between "start
   * session" CTA vs ongoing turn-based view.
   */
  getLiveSessionForLesson(
    pair_id: PairId,
    lesson_id: LessonId
  ): Promise<LiveSession | null>;
  /**
   * Most-recent COMPLETED live session for a (pair, lesson), or null.
   * gap-4 fix: getLiveSessionForLesson returns the newest session
   * regardless of status, so a cancelled/expired retry started after a
   * completed class masks that completed history entirely (真实数据案例:
   * 间接法课 — 7/03 completed ls_mr4fizd5 hidden behind a 7/13 cancelled).
   * The Lesson page's history branch needs "did this lesson ever graduate,
   * and which session was that" independent of whatever happened after.
   */
  getCompletedLiveSessionForLesson(
    pair_id: PairId,
    lesson_id: LessonId
  ): Promise<LiveSession | null>;
  /**
   * Every session for a (pair, lesson), newest first by started_at;
   * `status` narrows (e.g. 'completed'), omitted returns the full status
   * mix. Powers the web history stack (multiple completed
   * sessions per lesson, folded-row list); the single-latest shortcuts
   * above (getLiveSessionForLesson / getCompletedLiveSessionForLesson)
   * stay as-is for callers (header pill, journal timeline) that only ever
   * need the one newest record.
   */
  getLiveSessionsForLesson(
    pair_id: PairId,
    lesson_id: LessonId,
    status?: LiveSessionStatus
  ): Promise<LiveSessionListItem[]>;
  /** Full read: session + ordered moves + ordered responses. */
  getLiveSessionFullView(
    session_id: LiveSessionId
  ): Promise<LiveSessionFullView | null>;
  /**
   * Learner-initiated: create a new live session anchored to a lesson (or
   * other context). status='active', awaiting_role='agent'.
   */
  startLiveSession(input: {
    pair_id: PairId;
    context_type: LiveContextType;
    context_id: string;
    context_preview?: string;
    goal?: string;
  }): Promise<LiveSession>;
  /**
   * Agent appends a move. Server assigns `seq` and flips
   * awaiting_role → learner (or 'none' if response_kind='none' and
   * move_type='REFLECT'). MCP `live_message_send` tool.
   */
  appendTeachingMove(input: {
    session_id: LiveSessionId;
    move_type: MoveType;
    content: string;
    response_kind: ResponseKind;
    payload?: Record<string, unknown>;
    source_type?: string;
    source_id?: string;
  }): Promise<TeachingMove>;
  /**
   * Learner submits a response to the latest move. Server pins to the
   * appropriate move and flips awaiting_role → agent. `client_response_id`
   * is the dedup token (uuid); same id is a no-op.
   */
  submitTeachingResponse(input: {
    session_id: LiveSessionId;
    move_id: TeachingMoveId;
    content: string;
    input_type: ResponseInputType;
    client_response_id: string;
  }): Promise<TeachingResponse>;
  /**
   * Agent writes the three closing fields and flips status='completed'.
   * Stage 7d's REFLECT collection point.
   */
  completeLiveSession(
    session_id: LiveSessionId,
    closing: {
      summary?: string;
      teacher_reflection?: string;
      next_action?: string;
    }
  ): Promise<LiveSession>;
  /** Learner exits early (or system expires). Idempotent on terminal. */
  cancelLiveSession(session_id: LiveSessionId): Promise<LiveSession>;

  // -------- Mid-lesson snapshot (Stage 7e) --------
  /**
   * Agent flushes a rolling checkpoint mid-session. Compact-recovery
   * reads the latest snapshot + the moves since then instead of the
   * entire session log.
   */
  writeMidLessonSnapshot(input: {
    session_id: LiveSessionId;
    after_turn_n: number;
    rolling_summary: string;
    current_direction: string;
    weak_signals: string[];
  }): Promise<MidLessonSnapshot>;
  /** Returns the most-recent snapshot for a session, or null. */
  getLatestMidLessonSnapshot(
    session_id: LiveSessionId
  ): Promise<MidLessonSnapshot | null>;

  // -------- Bridge protocol (Stage 7d) --------
  /**
   * Agent → server keep-alive. While inside the TTL window the pair's
   * bridge is `online`; pending items surface as soon as the agent
   * polls. Re-call on every poll cycle (typically 1-3s).
   */
  heartbeatBridge(input: BridgeHeartbeatInput): Promise<BridgeStatus>;
  /**
   * Agent poll. Returns bridge status + ordered pending items (highest
   * priority first) across both Live Teaching and AdHoc channels.
   * Always safe to call; returns empty items when nothing pending.
   */
  pollBridgePending(pair_id: PairId): Promise<BridgePendingResponse>;

  // -------- Flashcard management (Stage 7e-cards) --------
  /**
   * Manually author a new flashcard (Cards page "+ Add card"). FSRS state
   * is initialized server-side (ts-fsrs `newCardState`) — the same helper
   * the MCP `add_flashcard` tool uses, so both write paths behave
   * identically. `concept_id` is required (nullable) since the Cards page
   * has no concept picker yet — pass null when the author doesn't specify one.
   */
  createFlashcard(
    input: Omit<Flashcard, 'id' | 'created_at' | 'updated_at' | 'fsrs_state' | 'paused'>
  ): Promise<Flashcard>;
  /** Toggle the `paused` flag on a card. */
  setFlashcardPaused(id: FlashcardId, paused: boolean): Promise<Flashcard>;
  /**
   * Reassign a card to a different deck (Cards page select-mode →
   * "Move to deck"). Decks are single-owner / derived-from-cards entities,
   * so "adding a card to a deck" is a move (deck_id reassignment), not a
   * multi-membership add.
   */
  setFlashcardDeck(id: FlashcardId, deck_id: Flashcard['deck_id']): Promise<Flashcard>;
  /**
   * Reset the card's FSRS state (stability/difficulty/review_count etc) so
   * it behaves like a brand-new card on the next review.
   */
  resetFlashcardFsrs(id: FlashcardId): Promise<Flashcard>;
  /** Permanent delete. No undo. */
  deleteFlashcard(id: FlashcardId): Promise<void>;

  // -------- Annotation (batch A — 高亮+笔记一体) --------
  /** All annotations for a lesson, created_at asc. Caller resolves each
   *  anchor against the current page DOM and filters by page_index —
   *  resolution is a client-side concern (apps/web/src/annotation/anchor.ts),
   *  not a server-side one. */
  getAnnotationsForLesson(lesson_id: LessonId): Promise<LessonAnnotation[]>;
  /** Create from a captured selection. `note` omitted/null = pure highlight;
   *  a non-null note makes the same record a note (batch A: one entity, two
   *  faces — no separate note entity). `color` defaults server-side to
   *  'amber' (batch A single-color; batch B unions it to the Mindmap palette). */
  createAnnotation(input: {
    pair_id: PairId;
    lesson_id: LessonId;
    page_index: number;
    selected_text: string;
    prefix: string;
    suffix: string;
    color?: AnnotationColorKey;
    note?: string | null;
  }): Promise<LessonAnnotation>;
  /** Edit the note and/or reclassify color (batch B overlay uses this; batch
   *  A wires the method but ships no editing UI yet). */
  updateAnnotation(
    id: AnnotationId,
    patch: { note?: string | null; color?: AnnotationColorKey }
  ): Promise<LessonAnnotation>;
  /** Permanent delete. Batch A has no orphan区 UI, so there is no "soft"
   *  delete path yet — this is a hard delete, no undo. */
  deleteAnnotation(id: AnnotationId): Promise<void>;

  // -------- Live-session-hosted annotations (第三种作用域, 学习者需求
  // 2026-07-18 — 教学记录挂批注; server: lesson_annotations.live_session_id
  // + GET/POST /live-sessions/:id/annotations, routes/annotations.ts) -----
  /** All annotations on one live session's teaching record, created_at asc.
   *  约定: page_index carries the seq of the move the annotation anchors
   *  inside — anchors (selected_text/prefix/suffix) resolve against that
   *  single move's text, not the whole stream. Rows come back with
   *  lesson_id/document_id null on the wire (host-exclusive CHECK) — same
   *  narrow-type-vs-wire-reality treatment as orphaned_at (web's
   *  annotation/orphan.ts). */
  getAnnotationsForLiveSession(
    live_session_id: LiveSessionId
  ): Promise<LessonAnnotation[]>;
  /** Create on a live session's record — mirrors createAnnotation (lesson
   *  side), with page_index = the anchored move's seq per the convention
   *  above. */
  createLiveSessionAnnotation(input: {
    pair_id: PairId;
    live_session_id: LiveSessionId;
    page_index: number;
    selected_text: string;
    prefix: string;
    suffix: string;
    color?: AnnotationColorKey;
    note?: string | null;
  }): Promise<LessonAnnotation>;

  // -------- AdHoc thread (Stage 7d-fix) --------
  /**
   * Lazily get-or-create the singleton long-living AdHoc thread for a
   * pair. UI calls this when the floating panel opens. Server creates
   * if missing, returns existing otherwise.
   */
  getOrCreateAdHocThread(pair_id: PairId): Promise<AdHocThread>;
  /** Full read: thread + ordered messages. */
  getAdHocThreadFullView(thread_id: AdHocThreadId): Promise<AdHocThreadFullView | null>;
  /**
   * Append a message — either from the user (via floating panel) or
   * the agent (via MCP). `client_message_id` dedupes retries.
   *
   * `is_learning_related` is decided by the SENDER (frontend by page,
   * agent by its own judgment). If true and the sender is a 'user'
   * message, a live.learner_message SessionEvent is also written for
   * compact-recovery / replay; agent messages write live.agent_message.
   */
  appendAdHocMessage(input: {
    thread_id: AdHocThreadId;
    role: 'user' | 'agent';
    content: string;
    payload?: AdHocPayload;
    context_snapshot: AdHocContextSnapshot;
    is_learning_related: boolean;
    client_message_id: string;
  }): Promise<AdHocMessage>;
  /**
   * Learner-initiated privacy cleanup: mark the thread archived.
   * Excluded from `getOrCreateAdHocThread`'s by-pair lookup afterwards, so
   * the panel's next message lazily starts a fresh thread. Existing
   * messages are not deleted — still reachable via `getAdHocThreadFullView`
   * by id.
   */
  archiveAdHocThread(thread_id: AdHocThreadId): Promise<AdHocThread>;
  /** Hard-delete a single message (learner-initiated, no undo). */
  deleteAdHocMessage(id: AdHocMessageId): Promise<void>;

  // -------- contract intake + 备课流程 --------
  createContract(
    contract: Omit<
      TeachingContract,
      | 'id'
      | 'version'
      | 'created_at'
      | 'updated_at'
      | 'active'
      | 'setup_status'
      | 'setup_steps'
      | 'setup_started_at'
      | 'setup_completed_at'
    >
  ): Promise<TeachingContract>;
  updateContract(id: ContractId, patch: Partial<TeachingContract>): Promise<TeachingContract>;
  /**
   * Stage 6b (GENERATE-FLOW-BRIEF, 2026-06-29):
   * commit the user's lesson selection from the outline. Marks the chosen
   * lessons as the ones to prep; unselected lessons stay `proposed`.
   * Transitions setup_status: outline_ready → generating → ready.
   * Triggers the per-lesson prep simulator (LESSON-PREP-BRIEF flow).
   */
  commitLessonSelection(
    id: ContractId,
    selected_lesson_ids: string[]
  ): Promise<TeachingContract>;
  cancelContractSetup(id: ContractId): Promise<TeachingContract>;
  /**
   * 迁移 0027 (Void, not delete — 审计留痕): 学习者一侧的合约作废入口
   * (Settings.tsx 证书区现役合约卡 / 档案区已作废历史行). Stamps
   * `voided_at`/`void_reason` server-side (never client-supplied timestamps
   * — same JSON-string-into-timestamptz guard every other Date column on
   * this contract already follows). Idempotent: voiding an already-voided
   * contract returns its current state, doesn't error, doesn't overwrite
   * the original void_reason. 学习者裁决 (2026-07-18): reason is OPTIONAL
   * for the learner (forcing a reason is a burden) — pass '' to void
   * without one; the server stores void_reason=null. Agent-side counterpart
   * is the MCP void_contract tool (requires learner's verbatim consent AND
   * a reason before calling — that's the agent's duty, not the learner's)
   * — both paths write the same pair of columns.
   */
  voidContract(id: ContractId, reason: string): Promise<TeachingContract>;
  rotateIcalToken(pair_id: PairId): Promise<string>;

  // -------- course (write) --------
  /** hard-delete a course and everything under it (lessons,
   *  concepts, exercises, simulated quizzes cascade at the DB layer;
   *  flashcards / syllabus_mappings / mindmap_associations pointing at this
   *  course or its lessons are cleaned up at the application layer since
   *  those references aren't real FKs). Server snapshots everything to a
   *  graveyard export before deleting. Rejects if the course doesn't exist. */
  deleteCourse(course_id: CourseId): Promise<void>;

  // -------- exercise submission --------
  submitExercise(
    submission: Omit<ExerciseSubmission, 'id' | 'submitted_at' | 'status'>
  ): Promise<ExerciseSubmission>;
  resubmitExercise(
    previous_id: ExerciseSubmissionId,
    new_answer: string
  ): Promise<ExerciseSubmission>;
  gradeExercise(
    submission_id: ExerciseSubmissionId,
    feedback: string,
    score?: number
  ): Promise<ExerciseSubmission>;

  // -------- mindmap --------
  createMindmap(
    mindmap: Omit<
      Mindmap,
      'id' | 'created_at' | 'updated_at' | 'has_been_reset' | 'agent_seed_snapshot'
    > & {
      // for user-created custom 图, agent_seed_snapshot 默认 = content
      agent_seed_snapshot?: MindmapContent;
    }
  ): Promise<Mindmap>;
  updateMindmapContent(id: MindmapId, content: MindmapContent): Promise<Mindmap>;
  /** Rename a mindmap (title only — no generalized edit endpoint). Used by
   *  the detail view's inline "click title to rename" UI. */
  updateMindmapTitle(id: MindmapId, title: string): Promise<Mindmap>;
  resetMindmap(id: MindmapId): Promise<Mindmap>;
  restoreMindmapFromSeed(id: MindmapId): Promise<Mindmap>;
  addMindmapAssociation(
    mindmap_id: MindmapId,
    target_type: MindmapAssociationTargetType,
    target_id: string
  ): Promise<MindmapAssociation>;
  removeMindmapAssociation(association_id: string): Promise<void>;

  // -------- pending card --------
  placePendingCard(
    card_id: PendingCardId,
    mindmap_id: MindmapId,
    pos: { x: number; y: number }
  ): Promise<MindmapNode>;
  dismissPendingCard(card_id: PendingCardId): Promise<void>;
  // Restore a card back into the pending pool (e.g. after removing a
  // note that was placed from a card).
  addPendingCard(
    pair_id: PairId,
    card: Omit<PendingMindmapCard, 'id' | 'owner_pair_id' | 'created_at' | 'placed_in_mindmap_id'>
  ): Promise<PendingMindmapCard>;

  // -------- quiz attempts --------
  submitQuizAttempt(
    attempt: Omit<QuizAttempt, 'id' | 'started_at' | 'finished_at' | 'score'>
  ): Promise<QuizAttempt>;
  finishQuizAttempt(id: QuizAttemptId): Promise<QuizAttempt>;

  // -------- feedback --------
  submitFeedback(
    feedback: Omit<LearnerFeedback, 'id' | 'submitted_at'>
  ): Promise<LearnerFeedback>;

  // -------- reminder --------
  dispatchReminder(reminder: Omit<Reminder, 'id' | 'created_at' | 'fired_at'>): Promise<Reminder>;
  dismissReminder(id: ReminderId): Promise<void>;
}

// W1 Mock + Live toggle — components don't care which.
export type RepositoryState =
  | { kind: 'empty' }
  | { kind: 'seeded'; repo: Repository }
  | { kind: 'live'; repo: Repository };
