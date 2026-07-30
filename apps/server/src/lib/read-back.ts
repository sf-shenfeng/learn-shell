// 读回面三工具核心 — get_lesson / get_exercise / get_submission。
//
// 病灶: MCP 写入强读回弱 — 老师能 add_lesson/add_exercise, 却取不回自己
// 教过的东西; 军规 "批改前先审教材" 要求读回全文教材+评分标准, 换任
// 老师(resume-teaching 冷启动)在内容层面是瘸的。这里补读回。
//
// 归属纪律 (与既有读路径的重要差异, 本批新法): 三个函数都把 pair 过滤写进
// 同一条 WHERE — 资源不存在与属于他 pair 返回同一个 NOT_FOUND, 不泄露
// 存在性 (对照 record_learner_feedback 的挂锚校验会明说 "belongs to a
// different pair" — 那是写锚点的自纠提示; 读回面是查询他人数据的口子,
// 一律装作没有)。归属链路照现有读路径惯例:
//   lessons                       ⋈ courses.pair_id
//   exercises        ⋈ lessons    ⋈ courses.pair_id
//   exercise_submissions ⋈ exercises ⋈ lessons ⋈ courses.pair_id
//
// Token 经济 (三公理: 默认紧凑 / 按需 verbose / 无损红线):
// getLessonReadback 默认只给结构+元数据+开头节选, 全文要 include_content
// 显式开。exercise/submission 本体就是要读的内容, 不设开关。
//
// 拆 lib 模块同 flashcard-update.ts 的理由: mcp/server.ts import 即开
// stdio transport, bench DB 测试直连这里。

import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { courses, lessons, concepts, exercises, exercise_submissions } from '../db/schema';
import type { ExerciseSubmissionRow } from '../db/schema';
import { notFoundError } from './mcp-errors';
import type { LessonReadback, ExerciseReadback, SubmissionReadback } from '@learn-shell/contracts';

/** Compact-mode leading slice length for lesson content / exercise prompt.
 *  Orientation-sized: enough to recognize the text, not enough to teach from
 *  — the full text is one include_content:true (or get_exercise) away. */
export const READBACK_EXCERPT_CHARS = 280;

export function excerptOf(text: string): string {
  return text.length > READBACK_EXCERPT_CHARS ? `${text.slice(0, READBACK_EXCERPT_CHARS)}…` : text;
}

function readbackNotFound(kind: string, idField: string, id: string) {
  return notFoundError(
    `${kind} ${id} not found — the id may not exist, may have been deleted, or may not belong to the current pair.`,
    { [idField]: id }
  );
}

export async function getLessonReadback(
  pairId: string,
  lessonId: string,
  includeContent: boolean
): Promise<LessonReadback> {
  const [row] = await db
    .select({ lesson: lessons, course_id: courses.id, course_topic: courses.topic })
    .from(lessons)
    .innerJoin(courses, eq(lessons.course_id, courses.id))
    .where(and(eq(lessons.id, lessonId), eq(courses.pair_id, pairId)))
    .limit(1);
  if (!row) throw readbackNotFound('Lesson', 'lesson_id', lessonId);

  const [conceptRows, exerciseRows] = await Promise.all([
    db
      .select({ id: concepts.id, name: concepts.name })
      .from(concepts)
      .where(eq(concepts.lesson_id, lessonId)),
    db
      .select({ id: exercises.id, order: exercises.order, tags: exercises.tags })
      .from(exercises)
      .where(eq(exercises.lesson_id, lessonId))
      .orderBy(asc(exercises.order)),
  ]);

  const content = row.lesson.content_markdown;
  return {
    lesson_id: row.lesson.id,
    course_id: row.course_id,
    course_topic: row.course_topic,
    title: row.lesson.title,
    order: row.lesson.order,
    summary: row.lesson.summary,
    revision: row.lesson.revision,
    published: row.lesson.published_at != null,
    published_at: row.lesson.published_at?.toISOString() ?? null,
    estimated_minutes: row.lesson.estimated_minutes,
    modality_declarations: row.lesson.modality_declarations ?? null,
    source_refs: row.lesson.source_refs,
    concepts: conceptRows.map((c) => ({ concept_id: c.id, name: c.name })),
    exercises: exerciseRows.map((e) => ({ exercise_id: e.id, order: e.order, tags: e.tags })),
    content_chars: content?.length ?? 0,
    content_excerpt: content ? excerptOf(content) : null,
    // 默认紧凑 — the key is *absent* (not null) unless explicitly asked for,
    // so a compact response never carries a full-text-sized field at all.
    ...(includeContent ? { content_markdown: content } : {}),
  };
}

export async function getExerciseReadback(
  pairId: string,
  exerciseId: string
): Promise<ExerciseReadback> {
  const [row] = await db
    .select({
      exercise: exercises,
      lesson_id: lessons.id,
      lesson_title: lessons.title,
      course_id: courses.id,
    })
    .from(exercises)
    .innerJoin(lessons, eq(exercises.lesson_id, lessons.id))
    .innerJoin(courses, eq(lessons.course_id, courses.id))
    .where(and(eq(exercises.id, exerciseId), eq(courses.pair_id, pairId)))
    .limit(1);
  if (!row) throw readbackNotFound('Exercise', 'exercise_id', exerciseId);

  return {
    exercise_id: row.exercise.id,
    lesson_id: row.lesson_id,
    lesson_title: row.lesson_title,
    course_id: row.course_id,
    order: row.exercise.order,
    prompt: row.exercise.prompt,
    reference_answer: row.exercise.reference_answer,
    expected_concepts: row.exercise.expected_concepts,
    tags: row.exercise.tags,
  };
}

// ---------------------------------------------------------------------------
// Confidence 主权立法 — get_submission 的教师读路径红线 (回归修复 N5)。
//
// 病灶: 读回三件上线时 getSubmissionReadback 照抄了整行, 把 confidence_pct
// 一并交给教师。同一台服务器的 pair://exercises/pending 资源说明白纸黑字写着
// "百分比是学习者建模层的数值, 已在服务端剔除, 不进教师读路径"
// (mcp/server.ts 该资源 description), 该资源的 handler 也确实做了剔除 —— 只有
// 读回面漏了。confidence(序数: guess/likely/certain) 是"她按了哪个按钮"的事实,
// 教师看得到; confidence_pct 是拿这个 pair *当刻*的锚值配置折算出来的建模层数值,
// 而锚值配置本身归学习者所有 (lib/confidence-anchors.ts), 教师连配置都不该看见,
// 更不该拿到折算结果。
//
// 落法: 教师读路径自带一个显式的返回型 —— 不是"忘了写", 是类型上就没有这个字段;
// 映射逻辑抽成纯函数 buildTeacherSubmissionReadback, 由 DB-free 的守卫测试
// (read-back.confidence-redaction.test.ts) 逐键盯死, 随默认套件常跑。
// ---------------------------------------------------------------------------

/** 教师侧提交读回体 —— 结构上就不含 `confidence_pct`。
 *
 *  上游通用 payload 已删除该字段;此处保留 Omit:若字段在上游复活,
 *  Omit 仍将其从教师读回型中排除;若教师映射显式加回该字段,
 *  类型检查(TS2353)与默认键集守卫会红。 */
export type TeacherSubmissionReadback = Omit<SubmissionReadback, 'confidence_pct'>;

/** getSubmissionReadback 的行→载荷映射, 抽成纯函数只为一件事: 让"百分比不进
 *  教师读路径"这条红线有一个不需要数据库、随默认套件常跑的守卫。
 *  入参**故意**收下整行(含 confidence_pct) —— 守卫要证明的正是"喂进去了也吐不
 *  出来", 而不是"上游根本没给"。 */
export function buildTeacherSubmissionReadback(row: {
  submission: ExerciseSubmissionRow;
  exercise_prompt: string;
  lesson_id: string;
  course_id: string;
}): TeacherSubmissionReadback {
  const s = row.submission;
  return {
    submission_id: s.id,
    exercise_id: s.exercise_id,
    lesson_id: row.lesson_id,
    course_id: row.course_id,
    exercise_prompt_excerpt: excerptOf(row.exercise_prompt),
    learner_answer: s.learner_answer,
    status: s.status,
    submitted_at: s.submitted_at?.toISOString() ?? null,
    graded_at: s.graded_at?.toISOString() ?? null,
    agent_score: s.agent_score,
    agent_feedback: s.agent_feedback,
    // 序数保留 —— 事实层, 教师看得到。
    confidence: s.confidence,
    // confidence_pct 到此为止: 建模层数值不过这道门。别加回来, 加回来会红。
    previous_submission_id: s.previous_submission_id,
    // 断链修复 (迁移 0044): 提交引用的 Live 回答, 批改前可循迹回看原话。
    live_response_id: s.live_response_id,
  };
}

export async function getSubmissionReadback(
  pairId: string,
  submissionId: string
): Promise<TeacherSubmissionReadback> {
  const [row] = await db
    .select({
      submission: exercise_submissions,
      exercise_prompt: exercises.prompt,
      lesson_id: lessons.id,
      course_id: courses.id,
    })
    .from(exercise_submissions)
    .innerJoin(exercises, eq(exercise_submissions.exercise_id, exercises.id))
    .innerJoin(lessons, eq(exercises.lesson_id, lessons.id))
    .innerJoin(courses, eq(lessons.course_id, courses.id))
    .where(and(eq(exercise_submissions.id, submissionId), eq(courses.pair_id, pairId)))
    .limit(1);
  if (!row) throw readbackNotFound('Submission', 'submission_id', submissionId);

  return buildTeacherSubmissionReadback(row);
}
