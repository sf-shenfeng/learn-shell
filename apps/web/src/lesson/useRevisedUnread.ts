// useRevisedUnreadSet — 票二 (2026-07-17 定案) 的服务端真相版
// (迁移 0030, State 2.0 — 学习者裁决 A): "这课改过了，回来看看" 判定。
// Courses.tsx 用它给已学完的课时行 + 课程卡 header 决定要不要露"已修订"标
// (行级) / 计数 (卡级)。
//
// 原实现 (票二首版) 是纯客户端拼装: 自己拉 progress + lesson_revisions,
// 再拿 lesson/revisionSeen.ts 的 localStorage 已读标记做比对——三处数据源、
// N+1 请求 (每个满足门槛的课时单独发一次 getLessonRevisions)。这一批服务端
// 把"已读到第几版"做成了真相 (lesson_revision_seen 表 + Lesson.axes 的
// revision/revision_seen/learning 三个字段, 见 lesson/axes.ts 的命名契约),
// 判定逻辑整个搬到服务端算好、随课清单一起吐出来——这里只是照 axes 读结果,
// 不再发任何额外请求, 也不用再传 progressByLessonId。
//
// lesson/revisionSeen.ts (localStorage 方案) 已随这批一并退役删除——它自己
// 的文档注释早就写好了这句话: "A real read receipt... is future work... this
// module can be deleted outright."

import { useMemo } from 'react';
import type { LessonId } from '@learn-shell/contracts';
import { isRevisedUnread, type LessonWithAxes } from './axes';

/** Returns the set of lesson ids that are "revised, unread" for the current
 *  pair, per axes.revision > (axes.revision_seen ?? 0) 且 learning 已完成过
 *  一轮 (见 lesson/axes.ts 的 isRevisedUnread)。Empty set when nothing
 *  qualifies — callers treat that as silence (x=0 silence precedent), not an
 *  error/loading state. */
export function useRevisedUnreadSet(lessons: LessonWithAxes[]): ReadonlySet<LessonId> {
  return useMemo(() => {
    const unread = new Set<LessonId>();
    for (const l of lessons) {
      if (isRevisedUnread(l.axes)) unread.add(l.id);
    }
    return unread;
  }, [lessons]);
}
