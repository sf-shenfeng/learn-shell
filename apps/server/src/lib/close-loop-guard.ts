// apps/server/src/lib/close-loop-guard.ts — close_lesson_loop 空转防护
//
// 纯判定核心：给定"已从 DB 取好的事实"(CloseLoopFacts) + 回执条目, 返回违规
// 清单。DB 读取留在 mcp/server.ts 的 close_lesson_loop case 里(那是长驻连接的
// 活), 这里只做无副作用的判定, 好让四道硬检脱离数据库单测(见 close-loop-
// guard.test.ts)——同 validate-prep-core / flashcard-import 的抽取纪律。
//
// 四道硬检 (§5/§7):
//   ① 本课有已提交未批改的 exercise_submissions → 拒关, 列待批 id (还债纪律)
//   ② 关课须带认知更新: post_lesson_evaluation / 有效 hypothesis_update 回执 /
//      显式 no_cognitive_update_reason 三者其一, 皆无 → 拒关
//   ③ 回执各条 ref_id 逐个验存在(按 kind 落点表), 悬空 ref → 拒关并指出哪条
//   ④ 本课有已完成 live session → 回执须含引用其 snapshot 的条目; 无则不阻塞
// + ⑦ live 引用须有实质 (④ 语义的写入侧扩展): ref_id 指向 live_sessions
//   的回执条目, 该场须 completed 或存在快照/场评——空壳场引用直接拒
//
// 回执可选 (2026-07-26): close_lesson_loop 的 receipt 不再必填 (学习者侧渲染卡
// 2026-07-22 已退役), items 可以是空数组。这里的判定一行没改——③⑦ 本就是"填了
// 才检", 空数组自然无事可检; ②④ 空回执时如何表现见各自就地头注 (结论: 二者都
// 只会更严, 不会更松)。

import type {
  LessonClosureItemName,
  LessonClosureNextRequiredAction,
  LessonLoopReceiptKind,
  LessonProgressState,
} from '@learn-shell/contracts';

// ---------------------------------------------------------------------------
// kind → 该 kind 的 ref_id 合法落点表(存在于任一即算真实)。以现有 schema 现实
// 为准: 每种回执 kind 指向的真实产物落在哪张表。
// ---------------------------------------------------------------------------

export type RefTable =
  | 'exercise_submissions'
  | 'lesson_revisions'
  | 'lesson_patches'
  | 'flashcards'
  | 'learner_hypotheses'
  | 'session_events'
  | 'mid_lesson_snapshots'
  | 'post_lesson_evaluations'
  | 'live_sessions'
  | 'live_session_evaluations';

export const RECEIPT_KIND_REF_TABLES: Record<LessonLoopReceiptKind, RefTable[]> = {
  exercise_feedback: ['exercise_submissions'],
  forward_revision: ['lesson_revisions'],
  teacher_note: ['lesson_patches'],
  erratum: ['lesson_patches'],
  flashcard_change: ['flashcards'],
  hypothesis_update: ['learner_hypotheses'],
  // journal_entry 是派生"学习传记"的原子单元——没有单一 journal 表(Journal 是
  // 由 session_events / 评估 / Live 快照拼出的视图)。故落点是一组:
  // session_events(传记事件) / mid_lesson_snapshots + live_sessions(Live 课的
  // 传记落点) / post_lesson_evaluations(课后评估条目) / live_session_evaluations
  // (Live 课的场评落点, 红队第四轮补入——课后合法证据不再靠补写快照冒充,
  // 而是走 record_live_evaluation 的真实落点)。命中任一即算真实。
  // 这也让 check ④ 的 snapshot/场评引用(kind=journal_entry, ref=snapshot id 或
  // evaluation id)与 check ③ 不打架。
  journal_entry: [
    'session_events',
    'mid_lesson_snapshots',
    'live_sessions',
    'post_lesson_evaluations',
    'live_session_evaluations',
  ],
};

// ---------------------------------------------------------------------------
// 输入/输出类型
// ---------------------------------------------------------------------------

export interface CloseLoopReceiptItem {
  kind: LessonLoopReceiptKind;
  description: string;
  ref_id?: string;
}

export interface CloseLoopFacts {
  /** 本课已提交但未批改的 submission id 清单(status ∈ submitted/pending_grade)。 */
  ungradedSubmissionIds: string[];
  /** 本课 (pair+lesson) 是否已有 post_lesson_evaluation。 */
  hasPostLessonEvaluation: boolean;
  /** 每个"被提供的 ref_id" → 它在哪些表里被查到。未提供 ref 的条目不进此表。 */
  refPresence: Record<string, RefTable[]>;
  /**
   * ⑦ live 引用须有实质: 回执 ref_id 命中 live_sessions 表的每个
   * 场次 → 它的实质档案。live_sessions 是 journal_entry 的合法落点之一
   * (见 RECEIPT_KIND_REF_TABLES), 但一场既未 completed、又没有快照/场评的
   * 空壳场作不了数——引用它的回执条目会被拒 (LIVE_REF_NO_SUBSTANCE)。
   * 由调用方随 refPresence 一并装配 (只需覆盖命中 live_sessions 的 id)。
   */
  liveRefSubstance: Record<string, { completed: boolean; hasEvidence: boolean }>;
  /** 本课已完成(status=completed)的 live session id 清单。 */
  completedLiveSessionIds: string[];
  /** 每个已完成 live session → 它的 snapshot id 清单。 */
  snapshotIdsBySession: Record<string, string[]>;
  /**
   * 每个已完成 live session → 它的 live_session_evaluation id 清单(一场一评,
   * 实际最多一条, 数组是为了跟 snapshotIdsBySession 同构好复用)。红队第四轮
   * 快照写入现已 enforce 只能在 session active 时发生(课后补写被拒), 故
   * 课后的合法"现场证据"补上 record_live_evaluation 这条真实落点——快照 OR
   * 场评皆可满足 check ④, 不再逼着课后 agent 找不到证据。
   */
  evaluationIdsBySession: Record<string, string[]>;
  /** 工具入参: 显式声明"本课无认知更新"的理由(非空才算数)。 */
  noCognitiveUpdateReason?: string;
  /**
   * 完成权 gate: 学习者是否已亲手宣告完成 —— lesson_progress 当前
   * state==='completed_declared', 或 declared_at 非空 (closed 行若带
   * declared_at 也算已宣告, 历史合法关课不受影响)。无 progress 行 = 未宣告。
   * 由调用方从 progress 行现算 (resolveCloseAttempt), 这里只吃布尔值。
   */
  hasCompletedDeclared: boolean;
}

export type CloseLoopViolationCode =
  | 'NOT_DECLARED'
  | 'UNGRADED_SUBMISSIONS'
  | 'NO_COGNITIVE_UPDATE'
  | 'DANGLING_REF'
  | 'LIVE_SNAPSHOT_UNREFERENCED'
  | 'LIVE_REF_NO_SUBSTANCE';

export interface CloseLoopViolation {
  code: CloseLoopViolationCode;
  message: string;
  details: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

/** 回执里是否有一条"指向真实假设行的 hypothesis_update"——check ② 的认知更新信号之一。 */
function hasValidHypothesisReceipt(
  items: CloseLoopReceiptItem[],
  refPresence: Record<string, RefTable[]>
): boolean {
  return items.some(
    (it) =>
      it.kind === 'hypothesis_update' &&
      !!it.ref_id &&
      (refPresence[it.ref_id] ?? []).includes('learner_hypotheses')
  );
}

export function evaluateCloseLoop(
  items: CloseLoopReceiptItem[],
  facts: CloseLoopFacts
): CloseLoopViolation[] {
  const violations: CloseLoopViolation[] = [];

  // ⓪ 完成权 gate: 学习者尚未亲手宣告完成 → 拒关。关课的正序是
  // declare(学习者宣告已学完) → 阅卷铃响 → 老师批改/回执 → close。老师不能
  // 替学习者按下宣告, 也不能跳过宣告直接关课。
  if (!facts.hasCompletedDeclared) {
    violations.push({
      code: 'NOT_DECLARED',
      message:
        "The learner hasn't declared this lesson complete themselves yet (lesson_progress isn't completed_declared, and there's no declared_at). " +
        'The correct order to close is: learner declares (declares complete) → grading bell rings → grading/receipt → close_lesson_loop. ' +
        "Wait for the grading bell — this declaration must come from the learner's own hand; it cannot be pressed by the teacher on their behalf or skipped.",
      details: { field: 'lesson_id' },
    });
  }

  // ① 未批改提交
  if (facts.ungradedSubmissionIds.length > 0) {
    violations.push({
      code: 'UNGRADED_SUBMISSIONS',
      message:
        `This lesson still has ${facts.ungradedSubmissionIds.length} submitted-but-ungraded submission(s); they must be graded before closing ` +
        `(§7 no-debt discipline): ${facts.ungradedSubmissionIds.join(', ')}. Grade each one with grade_exercise, then call close_lesson_loop.`,
      details: { field: 'lesson_id', ungraded_submission_ids: facts.ungradedSubmissionIds },
    });
  }

  // ③ 悬空 ref(填了 ref_id 就必须落在该 kind 的合法表里; 不填不检)
  const danglingRefs: { index: number; kind: string; ref_id: string; expected: RefTable[] }[] = [];
  items.forEach((it, i) => {
    if (!it.ref_id) return;
    const found = facts.refPresence[it.ref_id] ?? [];
    const allowed = RECEIPT_KIND_REF_TABLES[it.kind] ?? [];
    if (!found.some((t) => allowed.includes(t))) {
      danglingRefs.push({ index: i, kind: it.kind, ref_id: it.ref_id, expected: allowed });
    }
  });
  if (danglingRefs.length > 0) {
    violations.push({
      code: 'DANGLING_REF',
      message:
        'The receipt has dangling ref_id(s) (pointing to a record that does not exist, or not matching that kind\'s expected table): ' +
        danglingRefs
          .map(
            (d) => `receipt[${d.index}] kind=${d.kind} ref_id="${d.ref_id}" should exist in ${d.expected.join('/')}`
          )
          .join('; ') +
        '. Check the id, or remove that ref_id (ref_id is optional, but if provided it must be real).',
      details: { dangling_refs: danglingRefs },
    });
  }

  // ⑦ live 引用须有实质 (LIVE_SNAPSHOT 检查语义的写入侧扩展): ref_id
  // 落在 live_sessions 表的回执条目, 那场必须 completed 或至少留有快照/场评
  // ——空壳场 (没上完、也没有任何现场证据) 当不了证据链的一环。与 check ③
  // 分开报: ③ 说"这个 id 不真实", 这里说"id 真实, 但这场没有实质"。
  const hollowLiveRefs: { index: number; kind: string; ref_id: string }[] = [];
  items.forEach((it, i) => {
    if (!it.ref_id) return;
    if (!(facts.refPresence[it.ref_id] ?? []).includes('live_sessions')) return;
    const substance = facts.liveRefSubstance[it.ref_id];
    if (substance && !substance.completed && !substance.hasEvidence) {
      hollowLiveRefs.push({ index: i, kind: it.kind, ref_id: it.ref_id });
    }
  });
  if (hollowLiveRefs.length > 0) {
    violations.push({
      code: 'LIVE_REF_NO_SUBSTANCE',
      message:
        'The receipt references a live session with no substance (that session was neither completed, nor does it have any snapshot/evaluation): ' +
        hollowLiveRefs.map((d) => `receipt[${d.index}] kind=${d.kind} ref_id="${d.ref_id}"`).join('; ') +
        ". An empty-shell session doesn't count as evidence — first call live_session_complete to close it out " +
        '(or add record_live_evaluation to leave on-record evidence), then reference it; or reference evidence that actually occurred (snapshot / evaluation / session event).',
      details: { hollow_live_refs: hollowLiveRefs },
    });
  }

  // ② 认知更新: eval / 有效 hypothesis_update 回执 / 显式 no_cognitive_update_reason
  //
  // 回执可选之后 (2026-07-26, 渲染面退役) 空回执在这里如何表现: 三条满足路径
  // 里只有中间那条 (hypothesis_update 回执) 依赖 items, items 为空时它恒 false
  // ——剩下两条 (post_lesson_evaluation 真实落行 / 显式 reason) 与回执无关, 照
  // 常判定。即空回执让这道闸更严, 不更松: 少了一条可走的路, 没有多一条豁免。
  // 这正是要的表现, 所以这里一行不改——认知更新是关课的实质要求, 不是回执的
  // 附属品; 为了让空回执通过而在这里放行, 等于用"没写 changelog"换掉"这节课
  // 到底学到了什么"的落档。没写回执的老师照旧得有总评, 或者显式说明为什么没有。
  const reason = facts.noCognitiveUpdateReason?.trim();
  const cognitiveOk =
    facts.hasPostLessonEvaluation || hasValidHypothesisReceipt(items, facts.refPresence) || !!reason;
  if (!cognitiveOk) {
    violations.push({
      code: 'NO_COGNITIVE_UPDATE',
      message:
        'Closing requires a recorded cognitive update: this lesson has no post_lesson_evaluation, and the receipt has no ' +
        'hypothesis_update entry pointing to a real hypothesis. Either call record_post_lesson_evaluation / record_learner_hypothesis first, ' +
        'or explicitly pass no_cognitive_update_reason explaining why this lesson has no cognitive update (it will be written into the closure record).',
      details: { field: 'no_cognitive_update_reason' },
    });
  }

  // ④ 已完成 live session → 回执必须引用其 snapshot
  //
  // 回执可选之后 (2026-07-26) 空回执在这里如何表现: 触发条件是"本课有已完成的
  // Live 课", 与回执无关; 一旦触发, 空回执必然拿不出可接受的 ref → 直接判违规,
  // 关课被拒。也就是说"回执可选"在有 Live 课的课上等于不成立——那种课至少得留
  // 一条引用现场证据的回执。这是刻意的: 上过的 Live 课必须在闭环里留下引用,
  // 这条要求的读者从来不是学习者的 changelog 卡 (那才是退役的东西), 而是证据链
  // 本身; 渲染面退役动不了它。若在这里对空回执网开一面, 等于给"上完 Live 课
  // 一条证据不留就关课"开了一道门, 那正是空转防护要堵的洞。
  if (facts.completedLiveSessionIds.length > 0) {
    const refIds = new Set(
      items.map((it) => it.ref_id).filter((x): x is string => typeof x === 'string')
    );
    // 可接受的 ref: 任一已完成 session 的 snapshot id 或 live_session_evaluation
    // id(快照 OR 场评, 皆可满足——红队第四轮)。两者都没有时(既没在课中写过
    // 快照, 课后也没补场评)才回落到 session id 本身——服从现实, 至少让回执
    // 承认这场 Live 课。
    const acceptable = new Set<string>();
    for (const sid of facts.completedLiveSessionIds) {
      const snaps = facts.snapshotIdsBySession[sid] ?? [];
      const evals = facts.evaluationIdsBySession[sid] ?? [];
      snaps.forEach((s) => acceptable.add(s));
      evals.forEach((e) => acceptable.add(e));
      if (snaps.length === 0 && evals.length === 0) acceptable.add(sid);
    }
    const referenced = [...refIds].some((r) => acceptable.has(r));
    if (!referenced) {
      violations.push({
        code: 'LIVE_SNAPSHOT_UNREFERENCED',
        message:
          `This lesson has ${facts.completedLiveSessionIds.length} completed Live session(s); the closing receipt must reference at least one of their ` +
          `snapshots (kind=journal_entry, ref_id set to the snapshot id). Acceptable: ${[...acceptable].join(', ')}.`,
        details: {
          completed_live_session_ids: facts.completedLiveSessionIds,
          acceptable_refs: [...acceptable],
        },
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// 关课入口裁决 — closed 不可逆 + 完成权事实推导, 纯函数。
//
// close_lesson_loop 在做任何写入(回执 insert / progress update)之前先拿本课
// progress 行过这一道:
//   - state==='closed' → already_closed: 无论 idempotency_key 是否变化, 返回
//     幂等成功, 不重写 closed_at、不追加新回执副作用 (closed 是不可逆终态)。
//   - 否则 → proceed, 顺手把 hasCompletedDeclared 算好 (state===
//     'completed_declared' 或 declared_at 非空; 无行 = 未宣告) 喂给
//     evaluateCloseLoop 的 NOT_DECLARED 硬检。"无 progress 行直接 insert
//     closed"的旧路径由此自然堵死: 未宣告即无行, proceed 携 false, 被 ⓪ 拦。
// ---------------------------------------------------------------------------

export interface LessonProgressSnapshotForClose {
  state: LessonProgressState;
  declared_at: Date | null;
}

export type CloseAttemptResolution =
  | { kind: 'already_closed' }
  | { kind: 'proceed'; hasCompletedDeclared: boolean };

export function resolveCloseAttempt(
  row: LessonProgressSnapshotForClose | null
): CloseAttemptResolution {
  if (row?.state === 'closed') return { kind: 'already_closed' };
  return {
    kind: 'proceed',
    hasCompletedDeclared: !!row && (row.state === 'completed_declared' || row.declared_at != null),
  };
}

// ---------------------------------------------------------------------------
// 回执推荐状态化: close_lesson_loop 成功回执的
// next_recommended_actions 曾无条件含 reflect_on_teaching, 与 recipe "前两课
// 不立假设不写反思" 纪律打架 (机器可见的推荐在怂恿违纪, 同节拍案族: agent
// 服从必经之路上最响的指令)。按该 pair 已闭环课数(含本次)条件化: <2 → 推
// add_lesson(备下节课), 不推 reflect_on_teaching; ≥2 → 照旧推 reflect_on_
// teaching。纯函数, 计数由调用方(mcp/server.ts close_lesson_loop case)从 DB
// 数好再传进来, 好让这条状态判定脱离数据库单测。
//
// 红队第四轮补丁 — 推荐状态感知: ≥2 分支曾无条件推 reflect_on_teaching,
// 哪怕这个 pair 早已经在上一次关课之后写过反思了(同病: 前提已满足的动作还在
// 被推荐, 参见 record_post_lesson_evaluation/record_live_evaluation 那类"评估
// 已存在仍推荐评估")。原始现实说明: teacher_reflections 没有 lesson_id/
// session_id 落点(from_session_id 恒为 null), 没法按"这节课"精确
// 判定"是否已反思"；退而求其次按"这个 pair 自上一次关课起是否已写过反思"
// 判定(pair 粒度、按关课节拍度量的新鲜度)——服从现实, 比"从不检查、每次都
// 推荐"更贴近 brief 的意图。hasReflectedSinceLastClose 由调用方算好再传入,
// 判定本身仍是纯函数。
//
// 0035 (反思挂锚, W1C) 双轨过渡: teacher_reflections 现在有
// lesson_id 列了, 但只对本迁移之后的新写入生效——存量反思 lesson_id 恒
// null, 不能指望所有 pair 都已经积累出挂锚数据。pickCloseLoopNextActions
// 自身不变(仍是"数好了再传布尔值"的纯函数), 精确/近似两条判定在调用方
// (mcp/server.ts close_lesson_loop case)合流成一个布尔值: 该 lesson 若有
// 挂锚反思 → 精确判定为已反思, 不问先后时间(挂锚本身就是"为这节课写的"
// 这件事实, 不需要再拿 written_at 比大小); 没有挂锚数据时才回落到上面这条
// pair 级近似。resolveHasReflectedForClose 就是这道合流, 单独抽出来只是
// 为了让它可单测——调用方不用自己写 `anchored || approx` 这行就地判断。
// ---------------------------------------------------------------------------

export function resolveHasReflectedForClose(
  hasAnchoredReflectionForLesson: boolean,
  hasReflectedSinceLastCloseApprox: boolean
): boolean {
  return hasAnchoredReflectionForLesson || hasReflectedSinceLastCloseApprox;
}

export function pickCloseLoopNextActions(
  closedLessonCount: number,
  hasReflectedSinceLastClose: boolean
): string[] {
  if (closedLessonCount < 2) return ['add_lesson'];
  return hasReflectedSinceLastClose ? ['add_lesson'] : ['reflect_on_teaching'];
}

// ---------------------------------------------------------------------------
// get_lesson_closure_state 只读状态机 (红队 P1, Live 2.0 二期 W2 件二) — 纯
// 判定核心, 同文件既有分工: DB 事实装配在 lib/lesson-closure-facts.ts,
// 这里只做无副作用的"事实 → 完成/缺口/state/下一步"映射, 好单测。
//
// 项集合按现有关课前置逐项映射 (与 evaluateCloseLoop 的四道硬检同源, 但这里
// 报告的是"状态", 不是"通过/拒绝"):
//   graded              — check① 的正面表述 (无未批改提交)
//   live_completed      — 本课挂过的场次里至少一场已 completed (仅"有 live 时"出现)
//   live_evidence       — check④ 的证据门 (快照 OR 场评, 二选一即过, 仅"有 live 时"出现)
//   live_evaluation     — 更细的信号: 是否具体调过 record_live_evaluation
//                         (live_evidence 光靠快照也能满足, 这项单独盯"场评
//                         本身是否存在", 仅"有 live 时"出现)
//   post_lesson_evaluation — check② 三选一里最直接可观测的那一支
//   reflection          — W1C 挂锚精确+近似双轨口径 (resolveHasReflectedForClose)
//   receipts            — lesson_loop_receipts 是否已有行 (关课那一刻才会写)
//   closed              — lesson_progress.state === 'closed'
//
// receipts 与 closed 在现实里总是同一事务里一起翻转 (close_lesson_loop 的
// receipt 写入与 state='closed' 提交在同一个 tx 里) —— 故"首个缺口"扫描碰到
// receipts 或 closed 时不直接报它们的项名, 而是化名 'ready_to_close': receipts
// 缺口本身就是"万事俱备只差调 close_lesson_loop"的同义词, 报 'receipts' 反而
// 会跟"你还差点什么"的直觉背离。
// ---------------------------------------------------------------------------

export interface LessonClosureStateFacts {
  ungradedSubmissionIds: string[];
  /** 本课是否挂过任意一场 Live (不论状态) —— 决定 live_completed/live_evidence/
   *  live_evaluation 三项是否出现在 completed/missing 里。 */
  hasLive: boolean;
  hasCompletedLive: boolean;
  /** check④ 证据门: 至少一场已完成 session 有快照或场评。 */
  hasLiveEvidence: boolean;
  /** 至少一场已完成 session 具体有 record_live_evaluation 落的场评行。 */
  hasLiveEvaluation: boolean;
  hasPostLessonEvaluation: boolean;
  /** resolveHasReflectedForClose(...) 的结果 — 挂锚精确 OR pair 级近似。 */
  hasReflectedForClose: boolean;
  hasReceipts: boolean;
  isClosed: boolean;
}

const LESSON_CLOSURE_ORDER_WITH_LIVE: LessonClosureItemName[] = [
  'graded',
  'live_completed',
  'live_evidence',
  'live_evaluation',
  'post_lesson_evaluation',
  'reflection',
  'receipts',
  'closed',
];

const LESSON_CLOSURE_ORDER_NO_LIVE: LessonClosureItemName[] = [
  'graded',
  'post_lesson_evaluation',
  'reflection',
  'receipts',
  'closed',
];

export interface LessonClosureStateResult {
  state: LessonClosureItemName | 'ready_to_close';
  completed: LessonClosureItemName[];
  missing: LessonClosureItemName[];
}

export function computeLessonClosureState(facts: LessonClosureStateFacts): LessonClosureStateResult {
  const completed: LessonClosureItemName[] = [];
  const missing: LessonClosureItemName[] = [];
  const push = (name: LessonClosureItemName, ok: boolean) => (ok ? completed : missing).push(name);

  push('graded', facts.ungradedSubmissionIds.length === 0);
  if (facts.hasLive) {
    push('live_completed', facts.hasCompletedLive);
    push('live_evidence', facts.hasLiveEvidence);
    push('live_evaluation', facts.hasLiveEvaluation);
  }
  push('post_lesson_evaluation', facts.hasPostLessonEvaluation);
  push('reflection', facts.hasReflectedForClose);
  push('receipts', facts.hasReceipts);
  push('closed', facts.isClosed);

  if (facts.isClosed) {
    return { state: 'closed', completed, missing };
  }

  const order = facts.hasLive ? LESSON_CLOSURE_ORDER_WITH_LIVE : LESSON_CLOSURE_ORDER_NO_LIVE;
  const missingSet = new Set(missing);
  for (const item of order) {
    if (!missingSet.has(item)) continue;
    if (item === 'receipts' || item === 'closed') {
      return { state: 'ready_to_close', completed, missing };
    }
    return { state: item, completed, missing };
  }
  // Nothing missing at all but isClosed was false (shouldn't happen given
  // receipts/closed are always last in both orders) — defensive fallback.
  return { state: 'ready_to_close', completed, missing };
}

/** id 类引用, 供 next_required_action 预填 —— 调用方 (mcp/server.ts
 *  get_lesson_closure_state case) 从 assembleLessonClosureCoreFacts 的结果
 *  里现摘, 这里只管挑对哪个字段填进哪个工具的哪个参数名。 */
export interface LessonClosureNextActionRefs {
  lessonId: string;
  firstUngradedSubmissionId?: string;
  /** 存在且不是死会话 (cancelled/expired 且从未 completed) 时指
   *  live_session_complete；否则 (没有未完成场次, 或未完成场次已是死会话)
   *  指 live_session_start 重开一场。 */
  latestUnfinishedLiveSessionId?: string;
  latestUnfinishedLiveSessionIsDead?: boolean;
  firstCompletedLiveSessionId?: string;
}

export function pickLessonClosureNextAction(
  state: LessonClosureItemName | 'ready_to_close',
  refs: LessonClosureNextActionRefs
): LessonClosureNextRequiredAction | null {
  switch (state) {
    case 'closed':
      return null;
    case 'graded':
      return {
        tool: 'grade_exercise',
        pre_filled_refs: refs.firstUngradedSubmissionId
          ? { submission_id: refs.firstUngradedSubmissionId }
          : {},
      };
    case 'live_completed':
      return refs.latestUnfinishedLiveSessionId && !refs.latestUnfinishedLiveSessionIsDead
        ? { tool: 'live_session_complete', pre_filled_refs: { session_id: refs.latestUnfinishedLiveSessionId } }
        : { tool: 'live_session_start', pre_filled_refs: { context_type: 'lesson', context_id: refs.lessonId } };
    case 'live_evidence':
    case 'live_evaluation':
      return {
        tool: 'record_live_evaluation',
        pre_filled_refs: refs.firstCompletedLiveSessionId
          ? { live_session_id: refs.firstCompletedLiveSessionId }
          : {},
      };
    case 'post_lesson_evaluation':
      return { tool: 'record_post_lesson_evaluation', pre_filled_refs: { lesson_id: refs.lessonId } };
    case 'reflection':
      return { tool: 'reflect_on_teaching', pre_filled_refs: { lesson_id: refs.lessonId } };
    case 'ready_to_close':
      return { tool: 'close_lesson_loop', pre_filled_refs: { lesson_id: refs.lessonId } };
    default:
      return null;
  }
}
