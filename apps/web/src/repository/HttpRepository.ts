import type { FlashcardActivationRepo } from './flashcardActivationExt';
// HttpRepository — talks to apps/server REST API.
//
// Stage B3: read paths wired.
// Stage B6: write paths now wired — full live闭环.

import type {
  Repository,
  TeachingContract,
  ContractId,
  PairId,
  LearnerId,
  CourseId,
  CourseFootprint,
  LessonId,
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
  QuizAttempt,
  QuizAttemptId,
  LearnerFeedback,
  Reminder,
  ReminderId,
  Flashcard,
  LessonAnnotation,
  Course,
  Lesson,
  LessonRevision,
  LearningSession,
  SessionEvent,
  SessionId,
  LearnerHypothesis,
  TeacherReflection,
  PostLessonEvaluation,
  LiveSessionEvaluation,
  SimulatedQuiz,
  SimulatedQuizAttempt,
  QuestionBank,
  QuestionBankId,
  QuizQuestion,
  Learner,
  Agent,
  AgentId,
  LearnerAgentPair,
  LessonProgress,
  LessonPatch,
  LessonLoopReceipt,
} from '@learn-shell/contracts';
import type { SimulatedQuizRepo } from './simulatedQuiz';
import type { JournalRepo } from './journalExt';
import type { FlashcardImportRepo, FlashcardImportResult } from './flashcardImportExt';
import type { LessonAnnotationWithOrphan } from '../annotation/orphan';
import type { ObservationGateRepo, ObservationGateState } from './observationGateExt';
import type { FeedbackLedgerRepo, FeedbackLedgerEntry } from './feedbackLedgerExt';
import type { CalibrationRepo, CalibrationCurve } from './calibrationExt';
import type { BrierTrendRepo, BrierTrendPoint } from './brierTrendExt';
import type { ConfidenceAnchorRepo } from './confidenceAnchorExt';
import type { ConfidenceAnchorConfig } from '../lib/confidence';
import type {
  ConfidenceCaptureRepo,
  ExerciseSubmissionWithConfidence,
} from './confidenceCaptureExt';
import type { DocumentRepo } from './documentExt';
import type { Document, DocumentSummary } from '../document/types';
import type { SyllabusRepo, SyllabusSnapshot } from './syllabusExt';
import { AlreadyGradedError, type ProgressRepo } from './progressExt';
import {
  SessionTerminalError,
  type OnboardingRepo,
  type PairWithDemo,
  type RegisteredLearner,
} from './onboardingExt';

import { API_BASE_URL } from '../lib/apiBase';

const BASE_URL = API_BASE_URL;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status} ${res.statusText} on ${path}: ${body}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const post = <T>(path: string, body?: unknown): Promise<T> =>
  api<T>(path, { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined });

const patch = <T>(path: string, body: unknown): Promise<T> =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });

const del = <T>(path: string): Promise<T> => api<T>(path, { method: 'DELETE' });

const HttpRepository: Repository & FlashcardActivationRepo &
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
  mode: 'http',

  // -------- pair + contract (read) --------
  async getCurrentPair() {
    return api<LearnerAgentPair | null>('/pair/current');
  },
  async getActiveContract(pair_id) {
    return api<TeachingContract | null>(`/pairs/${pair_id}/contract/active`);
  },
  async getAllContracts(pair_id) {
    return api<TeachingContract[]>(`/pairs/${pair_id}/contracts`);
  },
  async getLearner() {
    return api<Learner | null>('/learners/me');
  },
  async getAgent(agent_id) {
    return api<Agent | null>(`/agents/${agent_id}`);
  },

  // -------- content (read) --------
  async getCourses(pair_id) {
    return api<Course[]>(`/pairs/${pair_id}/courses`);
  },
  async getCourse(course_id) {
    return api<Course | null>(`/courses/${course_id}`);
  },
  async getCourseFootprint(course_id) {
    return api<CourseFootprint>(`/courses/${course_id}/footprint`);
  },
  async getLessons(course_id) {
    return api<Lesson[]>(`/courses/${course_id}/lessons`);
  },
  async getLatestLessonRevision(lesson_id) {
    return api<LessonRevision | null>(`/lessons/${lesson_id}/revisions/latest`);
  },
  async getLessonRevisions(lesson_id, kind) {
    const q = kind ? `?kind=${kind}` : '';
    return api<LessonRevision[]>(`/lessons/${lesson_id}/revisions${q}`);
  },
  async getDueReviews(pair_id, limit) {
    const q = limit != null ? `?limit=${limit}` : '';
    return api<Flashcard[]>(`/pairs/${pair_id}/reviews/due${q}`);
  },
  async getAllFlashcards(pair_id) {
    return api<Flashcard[]>(`/pairs/${pair_id}/flashcards`);
  },

  // -------- State 2.0 axes (迁移 0030) --------
  async touchLessonProgress(lesson_id, page_index) {
    // 迁移 0037 (学习者裁决第三针) — page_index 省略时 body 留空, 服务端行为
    // 与迁移前完全一致(纯 in_progress ping)。
    await post<void>(
      `/lessons/${lesson_id}/progress/touch`,
      page_index !== undefined ? { page_index } : undefined
    );
  },
  async markRevisionSeen(lesson_id) {
    await post<void>(`/lessons/${lesson_id}/revision-seen`);
  },
  async createFlashcard(input) {
    return post<Flashcard>('/flashcards', input);
  },
  async setFlashcardActivated(id, activated) {
    return patch<Flashcard>(`/flashcards/${id}`, { activated });
  },
  async setFlashcardPaused(id, paused) {
    return patch<Flashcard>(`/flashcards/${id}`, { paused });
  },
  async setFlashcardDeck(id, deck_id) {
    return patch<Flashcard>(`/flashcards/${id}`, { deck_id });
  },
  async resetFlashcardFsrs(id) {
    return post<Flashcard>(`/flashcards/${id}/reset`);
  },
  async deleteFlashcard(id) {
    await del<void>(`/flashcards/${id}`);
  },

  // -------- Flashcard Markdown batch import (2026-07-08 定案) --------
  async importFlashcards({ pair_id, content, dry_run }) {
    return post<FlashcardImportResult>(`/pairs/${pair_id}/flashcards/import`, { content, dry_run });
  },

  // -------- Annotation (batch A) --------
  async getAnnotationsForLesson(lesson_id) {
    return api<LessonAnnotation[]>(`/lessons/${lesson_id}/annotations`);
  },
  async createAnnotation(input) {
    const { lesson_id, ...body } = input;
    return post<LessonAnnotation>(`/lessons/${lesson_id}/annotations`, body);
  },
  // 第三种作用域 (教学记录挂批注, 2026-07-18) — mirrors the lesson pair
  // above against routes/annotations.ts's /live-sessions/:id/annotations.
  async getAnnotationsForLiveSession(live_session_id) {
    return api<LessonAnnotation[]>(`/live-sessions/${live_session_id}/annotations`);
  },
  async createLiveSessionAnnotation(input) {
    const { live_session_id, ...body } = input;
    return post<LessonAnnotation>(`/live-sessions/${live_session_id}/annotations`, body);
  },
  async updateAnnotation(id, body) {
    return patch<LessonAnnotation>(`/annotations/${id}`, body);
  },
  async deleteAnnotation(id) {
    await del<void>(`/annotations/${id}`);
  },

  // -------- Journal 自由笔记 (batch E) --------
  async getFreeNotesForPair(pair_id) {
    return api<LessonAnnotationWithOrphan[]>(`/pairs/${pair_id}/annotations/free`);
  },
  async createFreeNote(input) {
    const { pair_id, ...body } = input;
    return post<LessonAnnotationWithOrphan>(`/pairs/${pair_id}/annotations/free`, body);
  },
  async getAnnotationCountForPair(pair_id) {
    const { total } = await api<{ total: number }>(`/pairs/${pair_id}/annotations/count`);
    return total;
  },

  // -------- Document (批G) --------
  async getDocuments(pair_id) {
    return api<Document[]>(`/pairs/${pair_id}/documents`);
  },
  async getDocument(id) {
    return api<Document | null>(`/documents/${id}`);
  },
  async createDocument(input) {
    const { pair_id, ...body } = input;
    return post<Document>(`/pairs/${pair_id}/documents`, body);
  },
  async updateDocument(id, body) {
    return patch<Document>(`/documents/${id}`, body);
  },
  async deleteDocument(id) {
    await del<void>(`/documents/${id}`);
  },
  async getRecentDocuments(pair_id, limit) {
    const q = limit != null ? `?limit=${limit}` : '';
    return api<DocumentSummary[]>(`/pairs/${pair_id}/documents/recent${q}`);
  },
  async getAnnotationsForDocument(document_id) {
    return api<LessonAnnotationWithOrphan[]>(`/documents/${document_id}/annotations`);
  },
  async createDocumentAnnotation(input) {
    const { document_id, ...body } = input;
    return post<LessonAnnotationWithOrphan>(`/documents/${document_id}/annotations`, body);
  },

  // -------- Syllabus Registry (考纲登记簿) --------
  async getSyllabus(pair_id, version) {
    const q = version ? `?version=${encodeURIComponent(version)}` : '';
    return api<SyllabusSnapshot>(`/pairs/${pair_id}/syllabus${q}`);
  },

  // -------- session (read) --------
  async getRecentSessions(pair_id, limit) {
    const q = limit != null ? `?limit=${limit}` : '';
    return api<LearningSession[]>(`/pairs/${pair_id}/sessions/recent${q}`);
  },
  async getSession(session_id) {
    return api<LearningSession | null>(`/sessions/${session_id}`);
  },
  async getSessionEvents(session_id) {
    return api<SessionEvent[]>(`/sessions/${session_id}/events`);
  },

  // -------- learning evidence (write) --------
  async recordReview(input) {
    return post<Flashcard>('/reviews', input);
  },
  async recordLearningEvent(input) {
    await post('/sessions/events', input);
  },
  async recordTrialAttempt(input) {
    const { pair_id, mode, ...payload } = input;
    await post('/sessions/events', {
      pair_id,
      event_type: 'trial.attempted',
      payload,
      mode,
    });
  },

  // -------- teacher growth (read) --------
  async getHypotheses(pair_id) {
    return api<LearnerHypothesis[]>(`/pairs/${pair_id}/hypotheses`);
  },
  async getReflections(pair_id) {
    return api<TeacherReflection[]>(`/pairs/${pair_id}/reflections`);
  },
  async getPostLessonEvaluations(pair_id) {
    return api<PostLessonEvaluation[]>(`/pairs/${pair_id}/evaluations`);
  },
  // 评估两区 (学习者裁决 B) — 课级总评。post_lesson_evaluations 的
  // (pair_id, lesson_id) 唯一约束已经保证"一课一份", 复用现成的批量端点按
  // lesson_id 过滤, 不需要新 server 路由。
  async getPostLessonEvaluation(pair_id, lesson_id) {
    const list = await api<PostLessonEvaluation[]>(`/pairs/${pair_id}/evaluations`);
    return list.find((e) => e.lesson_id === lesson_id) ?? null;
  },
  // 场评 — 单场 live session 的现场评估。读端点 GET /teaching/sessions/:id/
  // evaluation 已于 State 2.0 验收阶段补齐 (无评返回 null 属正常态)；调用方
  // (Lesson.tsx 的 LiveHistory 尾部"本场评价"小块) 对 null/isError 均按
  // "无数据, 不渲染"处理。
  async getLiveSessionEvaluation(live_session_id) {
    return api<LiveSessionEvaluation | null>(`/teaching/sessions/${live_session_id}/evaluation`);
  },

  // -------- teacher growth (write) --------
  async reviewHypothesis(id, action, user_note) {
    return post<LearnerHypothesis>(`/hypotheses/${id}/review`, { action, user_note });
  },

  // -------- exercise (read) --------
  async getExercises(lesson_id: LessonId) {
    return api<Exercise[]>(`/lessons/${lesson_id}/exercises`);
  },
  async getExerciseSubmissions(learner_id: LearnerId, exercise_id?: ExerciseId) {
    const q = exercise_id != null ? `?exercise_id=${exercise_id}` : '';
    return api<ExerciseSubmission[]>(`/learners/${learner_id}/submissions${q}`);
  },

  // -------- quiz (read) --------
  async getSimulatedQuizzes(pair_id: PairId, course_id?: CourseId) {
    const q = course_id ? `?course_id=${course_id}` : '';
    return api<SimulatedQuiz[]>(`/pairs/${pair_id}/simulated-quizzes${q}`);
  },
  async getSimulatedQuizAttempts(quiz_id) {
    return api<SimulatedQuizAttempt[]>(`/simulated-quizzes/${quiz_id}/attempts`);
  },
  async deleteSimulatedQuiz(quiz_id) {
    await del<void>(`/simulated-quizzes/${quiz_id}`);
  },
  async getQuestionBanks() {
    return api<QuestionBank[]>('/question-banks');
  },
  async getQuizQuestions(bank_id: QuestionBankId) {
    return api<QuizQuestion[]>(`/question-banks/${bank_id}/questions`);
  },
  async getQuizAttempts(learner_id: LearnerId) {
    return api<QuizAttempt[]>(`/learners/${learner_id}/quiz-attempts`);
  },

  // -------- mindmap (read) --------
  async getMindmapsForLesson(lesson_id) {
    return api<Mindmap[]>(`/lessons/${lesson_id}/mindmaps`);
  },
  async getMindmapsForCourse(course_id) {
    return api<Mindmap[]>(`/courses/${course_id}/mindmaps`);
  },
  async getCustomMindmaps(pair_id) {
    return api<Mindmap[]>(`/pairs/${pair_id}/mindmaps?scope=custom`);
  },
  async getAllMindmaps(pair_id) {
    return api<Mindmap[]>(`/pairs/${pair_id}/mindmaps`);
  },
  async getMindmap(id) {
    return api<Mindmap | null>(`/mindmaps/${id}`);
  },
  async getMindmapAssociations(mindmap_id) {
    return api<MindmapAssociation[]>(`/mindmaps/${mindmap_id}/associations`);
  },
  async getPendingCards(pair_id) {
    return api<PendingMindmapCard[]>(`/pairs/${pair_id}/pending-cards`);
  },

  // -------- feedback / reminder (read) --------
  async getFeedback(pair_id) {
    return api<LearnerFeedback[]>(`/pairs/${pair_id}/feedback`);
  },
  // 现场反馈笔改革 — same endpoint, full-row typing (kind/status/anchors), the
  // server select()s every column and orders by submitted_at desc.
  async getFeedbackLedger(pair_id) {
    return api<FeedbackLedgerEntry[]>(`/pairs/${pair_id}/feedback`);
  },
  async getReminders(pair_id) {
    return api<Reminder[]>(`/pairs/${pair_id}/reminders`);
  },

  // ==========================================================================
  // Mutations — Stage B6: real HTTP fetch to apps/server.
  // ==========================================================================

  async createContract(input) {
    return post<TeachingContract>('/contracts', input);
  },
  async updateContract(id: ContractId, patchBody) {
    return patch<TeachingContract>(`/contracts/${id}`, patchBody);
  },
  // -------- Live Teaching (Stage 7d wired) --------
  async getLiveSessionForLesson(pair_id, lesson_id) {
    return api(`/teaching/pairs/${pair_id}/lesson/${lesson_id}/active-session`);
  },
  // 召唤状态机 v3 gap-4: latest completed session, independent of any newer
  // cancelled/expired retry — see routes/teaching.ts completed-session.
  async getCompletedLiveSessionForLesson(pair_id, lesson_id) {
    return api(`/teaching/pairs/${pair_id}/lesson/${lesson_id}/completed-session`);
  },
  // 完课历史列表案: full session list (newest first) — powers the web history
  // stack. `status` optional, mirrors the server route's own "omit = all".
  async getLiveSessionsForLesson(pair_id, lesson_id, status) {
    const qs = status ? `?status=${status}` : '';
    return api(`/teaching/pairs/${pair_id}/lesson/${lesson_id}/sessions${qs}`);
  },
  async getLiveSessionFullView(session_id) {
    return api(`/teaching/sessions/${session_id}`);
  },
  async startLiveSession(input) {
    return post(`/teaching/sessions`, input);
  },
  async appendTeachingMove(input) {
    const { session_id, ...body } = input;
    return post(`/teaching/sessions/${session_id}/moves`, body);
  },
  async submitTeachingResponse(input) {
    const { session_id, ...body } = input;
    return post(`/teaching/sessions/${session_id}/responses`, body);
  },
  async completeLiveSession(session_id, closing) {
    return post(`/teaching/sessions/${session_id}/complete`, closing);
  },
  async cancelLiveSession(session_id) {
    return post(`/teaching/sessions/${session_id}/cancel`);
  },
  async heartbeatBridge(input) {
    return post(`/teaching/bridge/heartbeat`, input);
  },
  async pollBridgePending(pair_id) {
    return api(`/teaching/bridge/pending?pair_id=${pair_id}`);
  },
  async getOrCreateAdHocThread(pair_id) {
    return api(`/adhoc/threads/by-pair/${pair_id}`);
  },
  async getAdHocThreadFullView(thread_id) {
    return api(`/adhoc/threads/${thread_id}`);
  },
  async appendAdHocMessage(input) {
    const { thread_id, ...body } = input;
    return post(`/adhoc/threads/${thread_id}/messages`, body);
  },
  async archiveAdHocThread(thread_id) {
    return post(`/adhoc/threads/${thread_id}/archive`);
  },
  async deleteAdHocMessage(id) {
    await del<void>(`/adhoc/messages/${id}`);
  },
  async writeMidLessonSnapshot(input) {
    const { session_id, ...body } = input;
    return post(`/teaching/sessions/${session_id}/snapshots`, body);
  },
  async getLatestMidLessonSnapshot(session_id) {
    return api(`/teaching/sessions/${session_id}/snapshots/latest`);
  },

  async commitLessonSelection(id: ContractId, selected_lesson_ids: string[]) {
    return post<TeachingContract>(
      `/contracts/${id}/outline/commit`,
      { selected_lesson_ids }
    );
  },
  async cancelContractSetup(id: ContractId) {
    return post<TeachingContract>(`/contracts/${id}/setup/cancel`);
  },
  async voidContract(id: ContractId, reason: string) {
    return post<TeachingContract>(`/contracts/${id}/void`, { reason });
  },
  async rotateIcalToken(pair_id: PairId) {
    const { url } = await post<{ url: string }>(`/pairs/${pair_id}/ical-token/rotate`);
    return url;
  },
  async deleteCourse(course_id) {
    await del<void>(`/courses/${course_id}`);
  },

  async submitExercise(input) {
    return post<ExerciseSubmission>('/submissions', input);
  },
  async submitExerciseWithConfidence(input) {
    return post<ExerciseSubmissionWithConfidence>('/submissions', input);
  },
  async resubmitExercise(previous_id: ExerciseSubmissionId, new_answer: string) {
    return post<ExerciseSubmission>(`/submissions/${previous_id}/resubmit`, { new_answer });
  },
  async gradeExercise(id: ExerciseSubmissionId, feedback: string, score?: number) {
    return post<ExerciseSubmission>(`/submissions/${id}/grade`, { feedback, score });
  },
  // 反刍窗口 — a dedicated fetch (not the shared
  // `patch()` helper) because the 409 body is meaningful here, not just an
  // error to surface generically — see AlreadyGradedError's doc comment.
  async editSubmission(id: ExerciseSubmissionId, learner_answer: string) {
    const res = await fetch(`${BASE_URL}/submissions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ learner_answer }),
    });
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    if (res.status === 409) {
      throw new AlreadyGradedError(
        (body as { message?: string }).message ?? '批改已定格，请新开提交或留言，不改原卷。'
      );
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} on /submissions/${id}: ${JSON.stringify(body)}`);
    }
    return body as ExerciseSubmission;
  },

  // -------- lesson progress / patches / receipts --------
  async getLessonProgress(pair_id, lesson_id) {
    return api<LessonProgress>(`/pairs/${pair_id}/lessons/${lesson_id}/progress`);
  },
  async getCourseProgress(pair_id, course_id) {
    return api<LessonProgress[]>(`/pairs/${pair_id}/courses/${course_id}/progress`);
  },
  async declareLessonCompleted(pair_id, lesson_id, input) {
    return post<LessonProgress>(`/pairs/${pair_id}/lessons/${lesson_id}/declare-completed`, input);
  },
  async getLessonPatches(lesson_id) {
    return api<LessonPatch[]>(`/lessons/${lesson_id}/patches`);
  },
  async getLessonLoopReceipts(lesson_id) {
    return api<LessonLoopReceipt[]>(`/lessons/${lesson_id}/receipts`);
  },

  async createMindmap(input) {
    return post<Mindmap>('/mindmaps', input);
  },
  async updateMindmapContent(id: MindmapId, content: MindmapContent) {
    return patch<Mindmap>(`/mindmaps/${id}/content`, { content });
  },
  async updateMindmapTitle(id: MindmapId, title: string) {
    return patch<Mindmap>(`/mindmaps/${id}/title`, { title });
  },
  async resetMindmap(id: MindmapId) {
    return post<Mindmap>(`/mindmaps/${id}/reset`);
  },
  async restoreMindmapFromSeed(id: MindmapId) {
    return post<Mindmap>(`/mindmaps/${id}/restore`);
  },
  async addMindmapAssociation(
    mindmap_id: MindmapId,
    target_type: MindmapAssociationTargetType,
    target_id: string
  ) {
    return post<MindmapAssociation>(`/mindmaps/${mindmap_id}/associations`, {
      target_type,
      target_id,
    });
  },
  async removeMindmapAssociation(association_id: string) {
    await del(`/mindmap-associations/${association_id}`);
  },

  async placePendingCard(
    card_id: PendingCardId,
    mindmap_id: MindmapId,
    pos: { x: number; y: number }
  ) {
    return post<MindmapNode>(`/pending-cards/${card_id}/place`, { mindmap_id, pos });
  },
  async dismissPendingCard(card_id: PendingCardId) {
    await del(`/pending-cards/${card_id}`);
  },
  async addPendingCard(pair_id, card) {
    return post<PendingMindmapCard>(`/pairs/${pair_id}/pending-cards`, card);
  },

  async submitQuizAttempt(attempt) {
    return post<QuizAttempt>('/quiz-attempts', attempt);
  },
  async finishQuizAttempt(id: QuizAttemptId) {
    return post<QuizAttempt>(`/quiz-attempts/${id}/finish`);
  },

  async submitSimulatedQuizAttempt(input) {
    const { quiz_id, ...body } = input;
    return post<SimulatedQuizAttempt>(`/simulated-quizzes/${quiz_id}/attempts`, body);
  },

  async submitFeedback(feedback) {
    return post<LearnerFeedback>('/feedback', feedback);
  },

  async dispatchReminder(reminder) {
    return post<Reminder>('/reminders/dispatch', reminder);
  },
  async dismissReminder(id: ReminderId) {
    await post(`/reminders/${id}/dismiss`);
  },

  // -------- 首跑入学 + 下课铃 (onboardingExt) --------
  async registerLearner(input) {
    return post<RegisteredLearner>('/onboarding/learner', input);
  },
  // Dedicated fetch (not the shared post() helper) because the 409 body is
  // meaningful — "session already terminal" is a state the bell renders,
  // not an error to surface generically. Same precedent as editSubmission.
  async declareSessionClose(session_id) {
    const res = await fetch(`${BASE_URL}/teaching/sessions/${session_id}/declare-close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    if (res.status === 409) {
      throw new SessionTerminalError(
        (body as { error?: string }).error ?? 'session is terminal'
      );
    }
    if (!res.ok) {
      throw new Error(
        `HTTP ${res.status} ${res.statusText} on /teaching/sessions/${session_id}/declare-close: ${JSON.stringify(body)}`
      );
    }
    return body as { declared_at: string };
  },
  async getCurrentPairWithMeta() {
    return api<PairWithDemo | null>('/pair/current');
  },

  // -------- Learner Model 批0/批1 (observation gate + calibration) --------
  async getObservationGateState(pair_id) {
    return api<ObservationGateState>(`/pairs/${pair_id}/observation-gate`);
  },
  // 观察禁区下线案 — add/removeForbiddenObservation dropped from the web client:
  // the boundary registry UI is gone, negotiation moves to first-order
  // conversation with the agent (REST paths stay server-side for the
  // incoming MCP pen).
  async setConfidenceModeEnabled(pair_id, enabled) {
    return patch(`/pairs/${pair_id}/confidence-mode`, { enabled });
  },
  async getCalibrationCurve(pair_id, course_id) {
    const q = course_id ? `?course_id=${course_id}` : '';
    return api<CalibrationCurve>(`/pairs/${pair_id}/calibration${q}`);
  },
  async getBrierTrend(pair_id) {
    return api<BrierTrendPoint[]>(`/pairs/${pair_id}/brier-trend`);
  },

  // -------- Confidence 主权立法 (映射锚值, 学习者裁决版) --------
  async getConfidenceAnchors(pair_id) {
    const { confidence_anchor_pct } = await api<{ confidence_anchor_pct: ConfidenceAnchorConfig }>(
      `/pairs/${pair_id}/confidence-anchors`
    );
    return confidence_anchor_pct;
  },
  async setConfidenceAnchors(pair_id, anchors) {
    const { confidence_anchor_pct } = await patch<{ confidence_anchor_pct: ConfidenceAnchorConfig }>(
      `/pairs/${pair_id}/confidence-anchors`,
      anchors
    );
    return confidence_anchor_pct;
  },
};

// Silence unused -- AgentId / SessionId only consumed via path-as-string
void ({} as AgentId);
void ({} as SessionId);

export default HttpRepository;
