// Recents "最近接触"选取规则的单元测试 (二期, 2026-07-30)。
//
// 盯的是学习者实测报出来的那两条病, 以及修它们时立下的向后兼容承诺:
//   · Lesson 行原本认活跃契约的课程 → 改认"最新一条带 course_id 的
//     lesson.viewed"; 2026-07-30 之前写下的事件没有 course_id (不迁移不回填),
//     必须被跳过而不是当成"没有课程"把整条规则带塌。
//   · Review 行原本只有到期计数 → 改认最新一条 review.viewed 的 deck_id;
//     "全部到期"那一档 deck_id 记 null, 必须被跳过 (没有对象可显示)。
// 这两条一旦失效, 症状都是左栏悄悄指错东西 —— 不报错、不崩、没人发现, 正是
// 最该由机器盯着的那一类。
//
// node:test / node:assert, zero new deps, 无库无网, 与 lesson/judge.test.ts 同规格。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CourseId, LessonProgress, SessionEvent } from '@learn-shell/contracts';
import {
  latestTouchedLesson,
  latestViewedCourse,
  latestViewedDeck,
  latestViewedLesson,
} from './recentSignals';

/** 只填这几个函数真正读的字段 (event_type / occurred_at / payload); 信封其余
 *  部分与判定无关, 不假造一整个 EventEnvelope 来制造"测试很全面"的错觉。 */
function ev(event_type: string, occurred_at: string, payload: unknown): SessionEvent {
  return { event_type, occurred_at, payload } as unknown as SessionEvent;
}

const COURSE_A = 'crs_a' as CourseId;
const COURSE_B = 'crs_b' as CourseId;

test('latestViewedCourse: 取最新一条 lesson.viewed 的 course_id', () => {
  const events = [
    ev('lesson.viewed', '2026-07-29T10:00:00Z', { lesson_id: 'l1', course_id: COURSE_A }),
    ev('lesson.viewed', '2026-07-30T09:00:00Z', { lesson_id: 'l2', course_id: COURSE_B }),
  ];
  assert.equal(latestViewedCourse(events)?.courseId, COURSE_B);
});

test('latestViewedCourse: 乱序输入也认时间最大的那条 (跨 session 拍平后无序)', () => {
  const events = [
    ev('lesson.viewed', '2026-07-30T09:00:00Z', { lesson_id: 'l2', course_id: COURSE_B }),
    ev('lesson.viewed', '2026-07-29T10:00:00Z', { lesson_id: 'l1', course_id: COURSE_A }),
  ];
  assert.equal(latestViewedCourse(events)?.courseId, COURSE_B);
});

test('latestViewedCourse: 存量事件缺 course_id —— 跳过它, 认更旧但带字段的那条', () => {
  const events = [
    ev('lesson.viewed', '2026-07-29T10:00:00Z', { lesson_id: 'l1', course_id: COURSE_A }),
    // 2026-07-30 之前写下的老事件: 只有 lesson_id / position_at_close
    ev('lesson.viewed', '2026-07-30T09:00:00Z', { lesson_id: 'l9', position_at_close: 0.4 }),
  ];
  assert.equal(latestViewedCourse(events)?.courseId, COURSE_A);
});

test('latestViewedCourse: 一条带 course_id 的都没有 → undefined (调用方回落契约课程)', () => {
  const events = [ev('lesson.viewed', '2026-07-30T09:00:00Z', { lesson_id: 'l9' })];
  assert.equal(latestViewedCourse(events), undefined);
  assert.equal(latestViewedCourse([]), undefined);
  assert.equal(latestViewedCourse(undefined), undefined);
});

test('latestViewedCourse: 不被别的事件类型带偏', () => {
  const events = [
    ev('document.viewed', '2026-07-30T11:00:00Z', { document_id: 'doc1' }),
    ev('review.viewed', '2026-07-30T12:00:00Z', { deck_id: 'FSA', course_id: COURSE_B }),
    ev('lesson.viewed', '2026-07-29T10:00:00Z', { lesson_id: 'l1', course_id: COURSE_A }),
  ];
  assert.equal(latestViewedCourse(events)?.courseId, COURSE_A);
});

test('latestViewedDeck: 取最新一条 review.viewed 的 deck_id', () => {
  const events = [
    ev('review.viewed', '2026-07-29T10:00:00Z', { deck_id: 'Ethics', course_id: null }),
    ev('review.viewed', '2026-07-30T09:00:00Z', { deck_id: 'FSA', course_id: COURSE_B }),
  ];
  assert.equal(latestViewedDeck(events)?.deckId, 'FSA');
});

test('latestViewedDeck: deck_id 为 null ("全部到期") 被跳过, 认更旧但具体的那组', () => {
  const events = [
    ev('review.viewed', '2026-07-29T10:00:00Z', { deck_id: 'Ethics', course_id: null }),
    ev('review.viewed', '2026-07-30T09:00:00Z', { deck_id: null, course_id: null }),
  ];
  assert.equal(latestViewedDeck(events)?.deckId, 'Ethics');
});

test('latestViewedDeck: 没有任何 review.viewed → undefined (Review 行退回纯计数文案)', () => {
  assert.equal(latestViewedDeck([]), undefined);
  assert.equal(latestViewedDeck(undefined), undefined);
  assert.equal(
    latestViewedDeck([ev('review.rated', '2026-07-30T09:00:00Z', { card_id: 'c1' })]),
    undefined
  );
});

test('latestViewedLesson: 取最新一条 lesson.viewed 的 lesson_id, 老事件照样算数', () => {
  const events = [
    ev('lesson.viewed', '2026-07-30T09:00:00Z', { lesson_id: 'l9', position_at_close: 0.4 }),
    ev('lesson.viewed', '2026-07-29T10:00:00Z', { lesson_id: 'l1', course_id: COURSE_A }),
  ];
  // 课内选节这一根信号不看 course_id —— 缺字段的老事件在这里必须仍然有效。
  assert.equal(latestViewedLesson(events)?.lessonId, 'l9');
});

test('latestTouchedLesson: not_started / updated_at 为 null 的行不算接触过', () => {
  const progress = [
    { lesson_id: 'l1', state: 'in_progress', updated_at: '2026-07-29T10:00:00Z' },
    { lesson_id: 'l2', state: 'not_started', updated_at: '2026-07-30T09:00:00Z' },
    { lesson_id: 'l3', state: 'in_progress', updated_at: null },
  ] as unknown as LessonProgress[];
  assert.equal(latestTouchedLesson(progress)?.lessonId, 'l1');
  assert.equal(latestTouchedLesson([]), undefined);
});
