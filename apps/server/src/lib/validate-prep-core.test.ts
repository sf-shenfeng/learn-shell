// Unit tests for checkMindmap's absence branch — pure function, no DB.
// 脑图裁量条款 (2026-07-21, "默认没有、例外才有"): 脑图缺席是默认态, 旧规则的
// "缺席未声明→warn" 黄灯撤销, 缺席一律 skip; 声明理由仅作可选笔记原文回显。
// Run via `pnpm --filter @learn-shell/server test`
// (tsx --test / node:assert, zero deps, same harness as close-loop-guard.test.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkMindmap,
  compactLessonReport,
  type LessonReport,
  type MindmapNode,
} from './validate-prep-core';

function findCheck(checks: ReturnType<typeof checkMindmap>, id: string) {
  return checks.find((c) => c.id === id);
}

// ---- nodes === null: 缺席即默认态, 永远 skip, 永不 warn ----
test('mindmap absent + no declared reason → skip (absence is the default, no nag)', () => {
  const checks = checkMindmap(null, undefined);
  assert.equal(checks.length, 1);
  const c = findCheck(checks, 'mindmap_absent_default');
  assert.ok(c, 'expected mindmap_absent_default check item');
  assert.equal(c!.severity, 'skip');
});

test('mindmap absent + blank/whitespace-only reason → skip, same as no reason', () => {
  const checks = checkMindmap(null, '   ');
  const c = findCheck(checks, 'mindmap_absent_default');
  assert.ok(c);
  assert.equal(c!.severity, 'skip');
});

test('mindmap absent + null reason (explicit) → skip, same as undefined', () => {
  const checks = checkMindmap(null, null);
  const c = findCheck(checks, 'mindmap_absent_default');
  assert.ok(c);
  assert.equal(c!.severity, 'skip');
});

test('mindmap absent: no severity above skip is ever emitted (no absence-nag survives the fix)', () => {
  for (const reason of [undefined, null, '', '   ', '背诵类内容, 关系不是难点']) {
    const checks = checkMindmap(null, reason);
    assert.ok(
      checks.every((c) => c.severity === 'skip'),
      `absence must never warn/fail (reason=${JSON.stringify(reason)})`
    );
  }
});

// ---- nodes === null, 有声明: 可选笔记, 原文回显 ----
test('mindmap absent + declared reason → skip, detail echoes the reason verbatim', () => {
  const reason = '背诵类内容, 关系不是难点';
  const checks = checkMindmap(null, reason);
  assert.equal(checks.length, 1);
  const c = findCheck(checks, 'mindmap_absent_default');
  assert.ok(c);
  assert.equal(c!.severity, 'skip');
  assert.ok(c!.detail.includes(reason), 'declared reason should be echoed verbatim in detail');
});

test('mindmap absent + declared reason with surrounding whitespace → trimmed in echo', () => {
  const checks = checkMindmap(null, '  背诵类内容, 关系不是难点  ');
  const c = findCheck(checks, 'mindmap_absent_default');
  assert.ok(c);
  assert.ok(c!.detail.includes('背诵类内容, 关系不是难点'));
  assert.ok(!c!.detail.includes('  背诵类内容'));
});

// ---- nodes 非空: 质量检查行为完全不变 (regression — the fix only touched the absence branch) ----
const validNodes: MindmapNode[] = [
  { id: 'n_root', title: '根', level: 'root', pos_x: 50, pos_y: 50, is_expanded: true, sort_order: 0 },
  {
    id: 'n_b1',
    title: '分支一',
    level: 'branch',
    pos_x: 20,
    pos_y: 30,
    is_expanded: true,
    sort_order: 0,
    parent_id: 'n_root',
  },
  {
    id: 'n_b2',
    title: '分支二',
    level: 'branch',
    pos_x: 80,
    pos_y: 30,
    is_expanded: true,
    sort_order: 1,
    parent_id: 'n_root',
  },
];

test('mindmap present: declaredReason param is ignored, quality checks run as before', () => {
  const withoutReason = checkMindmap(validNodes, undefined);
  const withReason = checkMindmap(validNodes, '理由不该影响非空脑图的判定');
  assert.deepEqual(withoutReason, withReason);
  // sanity: no absence check ids show up when nodes are present
  assert.equal(findCheck(withoutReason, 'mindmap_absent_default'), undefined);
  assert.equal(findCheck(withoutReason, 'field_contract')?.severity, 'pass');
});

// ===========================================================================
// verify_prep 紧凑报告 (compactLessonReport): 紧凑/verbose 两种
// 形状的 error/warning 内容必须逐字等价 (无损红线③ — 压的是 pass/skip 的
// 重复, 不是可行动信息)。
// ===========================================================================

const sampleReport: LessonReport = {
  lesson_id: 'lsn_compact_1',
  title: '紧凑报告样例课',
  order: 3,
  status: 'FAIL',
  error_count: 2,
  warning_count: 1,
  checks: [
    { category: '课文', id: 'pages', label: '翻页', severity: 'pass', detail: '9 页' },
    { category: '课文', id: 'kicker', label: 'kicker', severity: 'fail', detail: '第 4 页缺 kicker' },
    { category: '闪卡', id: 'count', label: '数量', severity: 'warn', detail: '闪卡 4 张, 低于建议密度' },
    { category: '闪卡', id: 'dupes', label: '查重', severity: 'pass', detail: '无重复' },
    { category: '习题', id: 'refs', label: '概念引用', severity: 'fail', detail: 'ex_1 引用了不存在的 concept' },
    { category: '脑图', id: 'mindmap_absent_default', label: '缺席', severity: 'skip', detail: '未配脑图' },
    { category: '跨件', id: 'coverage', label: '概念覆盖', severity: 'pass', detail: '3/3' },
  ],
};

test('compact: errors/warnings carry the exact same CheckItems as the verbose checks array', () => {
  const compact = compactLessonReport(sampleReport);
  assert.deepEqual(compact.errors, sampleReport.checks.filter((c) => c.severity === 'fail'));
  assert.deepEqual(compact.warnings, sampleReport.checks.filter((c) => c.severity === 'warn'));
  // 逐字等价: JSON 序列化后也一致 (verify_prep 的 MCP 返回体就是 JSON)。
  assert.equal(
    JSON.stringify(compact.errors),
    JSON.stringify(sampleReport.checks.filter((c) => c.severity === 'fail'))
  );
});

test('compact: status/error_count/warning_count keep verbose values; pass/skip become counts', () => {
  const compact = compactLessonReport(sampleReport);
  assert.equal(compact.status, sampleReport.status);
  assert.equal(compact.error_count, sampleReport.error_count);
  assert.equal(compact.warning_count, sampleReport.warning_count);
  assert.deepEqual(compact.check_counts, { pass: 3, skip: 1 });
  assert.equal(compact.lesson_id, sampleReport.lesson_id);
  assert.equal(compact.title, sampleReport.title);
  assert.equal(compact.order, sampleReport.order);
});

test('compact: totals reconcile — errors+warnings+pass+skip === checks.length (nothing dropped silently)', () => {
  const compact = compactLessonReport(sampleReport);
  assert.equal(
    compact.errors.length + compact.warnings.length + compact.check_counts.pass + compact.check_counts.skip,
    sampleReport.checks.length
  );
});

test('compact: all-pass report → empty errors/warnings, counts only', () => {
  const clean: LessonReport = {
    ...sampleReport,
    status: 'PASS',
    error_count: 0,
    warning_count: 0,
    checks: sampleReport.checks.map((c) => ({ ...c, severity: 'pass' as const })),
  };
  const compact = compactLessonReport(clean);
  assert.deepEqual(compact.errors, []);
  assert.deepEqual(compact.warnings, []);
  assert.deepEqual(compact.check_counts, { pass: clean.checks.length, skip: 0 });
});
