// apps/server/src/lib/reflection-anchor.ts — reflect_on_teaching 挂锚推断
//
// 真实误读案例: reflect_on_teaching 成功、close_lesson_loop 成功,
// closure_progress 却仍报 reflection 缺——因为 lesson_id/live_session_id 全可选,
// 不填就落一行"无主反思" (lesson_id=null), 而聚合侧只按 lesson_id 精确匹配 +
// pair 级近似兜底, 无主行永远数不进"这节课反思过没有"。
//
// 修法双管齐下:
//   ① 写入侧 (本文件): lesson_id 未显式提供时, 从现场上下文强推断——参数不改
//      必填 (breaking change 不做), 但上下文能指认唯一一节课时就替调用方挂上,
//      回执里明示"由 X 推断"; 推断不出来时回执里明确警告 (无主反思不计入任何
//      课的 closure)。
//   ② 聚合侧 (lib/lesson-closure-facts.ts fetchAnchoredReflectionExists):
//      lesson_id 为 null 但 live_session_id 指向本课场次的行, 也算挂锚命中。
//
// 本文件只做无副作用的"候选 → 锚"判定 (同 close-loop-guard / validate-prep-core
// 的抽取纪律, 好单测); 候选采集 (查 live_sessions) 留在 mcp/server.ts 的
// reflect_on_teaching case 里。
//
// 推断阶梯 (从硬到软, 命中即止):
//   1. live_session_id 参数给了且该场次 context_type='lesson' → 它的 context_id。
//      (确定性链路, 不是猜——这条反思自述"关于这场课", 这场课就挂在那节课上。)
//   2. live_session_id 给了但 context 不是 lesson → 停, 不再猜别的课
//      (调用方已显式把反思挂到非课上下文, 再从别处翻一节课出来反而是错锚)。
//   3. 本 pair 当前 active 且 context_type='lesson' 的场次恰好一间 → 它的课
//      (人就在教室里写反思, 上下文唯一)。多于一间 → 歧义, 不猜。
//   4. 本 pair 最近一场 lesson 场次 (任意状态) 且 last_activity_at 落在
//      RECENCY_WINDOW 内 → 它的课。覆盖常规流:
//      live_session_complete → record_live_evaluation → reflect_on_teaching,
//      写反思时场次刚 completed 几分钟。窗口外的陈年场次不算"上下文", 不猜。
//   5. 都没有 → 不挂锚, 由调用方回执警告。

/** 阶梯 4 的"最近"窗口: 场次 last_activity_at 距今在此窗口内才算"还在上下文里"。
 *  24h 覆盖"下课当天补反思"的正常节拍; 更久远的场次不该替一条来意不明的反思
 *  做主。 */
export const REFLECTION_ANCHOR_RECENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 一个可推断的候选: 某场 lesson-context live session 与它挂的课。 */
export interface ReflectionAnchorSessionCandidate {
  sessionId: string;
  lessonId: string;
}

export type ReflectionAnchorSource =
  | 'live_session_param'
  | 'active_live_session'
  | 'recent_live_session';

export type ReflectionAnchorResolution =
  | { lessonId: string; source: ReflectionAnchorSource; sessionId: string }
  | {
      lessonId: null;
      /** no_context: 没有任何可用上下文; ambiguous_active: 同时开着多间 lesson
       *  教室, 不替调用方二选一; non_lesson_live_session: 调用方显式挂了非课
       *  上下文的场次, 尊重之, 不另猜课。 */
      reason: 'no_context' | 'ambiguous_active' | 'non_lesson_live_session';
    };

export function resolveInferredReflectionAnchor(input: {
  /** 调用方显式传的 live_session_id 对应场次 (已验存在 + 同 pair)。 */
  liveSessionParam?: { sessionId: string; contextType: string; contextId: string };
  /** 本 pair 当前 status='active' 且 context_type='lesson' 的全部场次。 */
  activeLessonSessions: ReflectionAnchorSessionCandidate[];
  /** 本 pair 最近一场 context_type='lesson' 的场次 (last_activity_at 已由调用
   *  方按 RECENCY_WINDOW 过滤; 窗口外传 undefined)。 */
  recentLessonSession?: ReflectionAnchorSessionCandidate;
}): ReflectionAnchorResolution {
  const { liveSessionParam, activeLessonSessions, recentLessonSession } = input;

  if (liveSessionParam) {
    if (liveSessionParam.contextType === 'lesson') {
      return {
        lessonId: liveSessionParam.contextId,
        source: 'live_session_param',
        sessionId: liveSessionParam.sessionId,
      };
    }
    return { lessonId: null, reason: 'non_lesson_live_session' };
  }

  const only = activeLessonSessions.length === 1 ? activeLessonSessions[0] : undefined;
  if (only) {
    return { lessonId: only.lessonId, source: 'active_live_session', sessionId: only.sessionId };
  }
  if (activeLessonSessions.length > 1) {
    return { lessonId: null, reason: 'ambiguous_active' };
  }

  if (recentLessonSession) {
    return {
      lessonId: recentLessonSession.lessonId,
      source: 'recent_live_session',
      sessionId: recentLessonSession.sessionId,
    };
  }

  return { lessonId: null, reason: 'no_context' };
}

/** 回执措辞单点 (写入侧 ① 的"明示"半边) — human_note 里拼接。 */
export function describeReflectionAnchorSource(source: ReflectionAnchorSource): string {
  switch (source) {
    case 'live_session_param':
      return 'inferred from the session pointed to by the live_session_id parameter';
    case 'active_live_session':
      return 'inferred from the single currently-active Live classroom';
    case 'recent_live_session':
      return 'inferred from the most recent Live session within 24h';
  }
}

/** 无主反思的回执警告 (写入侧 ① 的"警告"半边) — 单点定义好测好改。 */
export const UNANCHORED_REFLECTION_WARNING =
  "⚠ This reflection isn't anchored to any lesson (lesson_id is empty and the context can't be inferred) — " +
  "this reflection won't count toward any lesson's closure — pass lesson_id for post-lesson reflections, " +
  "only then does closure_progress's reflection item recognize it.";
