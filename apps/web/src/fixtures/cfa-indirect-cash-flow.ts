// CFA "Cash Flow Statement — Indirect Method" seed scenario.
//
// Slice Spec week-01 demands one complete Teacher Loop visible on Dashboard:
//   Contract → Intervention → Evidence → Hypothesis → Reflection → Next Change
//
// Round 2 (TEACHING-SPEC-v1): 扩 contract 偏好字段; 加 Exercise / Mindmap /
// PendingCard / QuestionBank / Feedback / Reminder / PostLessonEvaluation
// 让 UI 立刻能看到 round 2 全部模块的演示数据.
//
// All ids are deterministic so we can reference them across pages.
// All timestamps are static (today UTC midnight + offsets) so screenshots
// look the same across runs.

import type {
  Agent,
  AgentId,
  ConceptId,
  Course,
  CourseId,
  ContractId,
  DeckId,
  Flashcard,
  FlashcardId,
  Learner,
  LearnerAgentPair,
  LearnerHypothesis,
  LearnerHypothesisId,
  LearnerId,
  Lesson,
  LessonId,
  LearningSession,
  PairId,
  SessionEvent,
  SessionId,
  SourceRef,
  TeacherReflection,
  TeacherReflectionId,
  TeachingContract,
  Exercise,
  ExerciseId,
  ExerciseSubmission,
  ExerciseSubmissionId,
  Mindmap,
  MindmapAssociation,
  MindmapId,
  PendingMindmapCard,
  PendingCardId,
  QuestionBank,
  QuestionBankId,
  QuizQuestion,
  SimulatedQuiz,
  SimulatedQuizId,
  LearnerFeedback,
  LearnerFeedbackId,
  Reminder,
  ReminderId,
  PostLessonEvaluation,
  PostLessonEvaluationId,
  AnnotationId,
} from '@learn-shell/contracts';
import type { LessonAnnotationWithOrphan } from '../annotation/orphan';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------
const LEARNER_ID = 'lrn_demo' as LearnerId;
const AGENT_ID = 'agt_demo_claude_code' as AgentId;
const PAIR_ID = 'pair_demo_cfa' as PairId;
const CONTRACT_ID = 'tc_demo_cfa_v1' as ContractId;

const COURSE_ID = 'crs_cfa_cash_flow' as CourseId;
const LESSON_1 = 'lsn_intro_indirect' as LessonId;
const LESSON_2 = 'lsn_noncash_adjustments' as LessonId;

const CONCEPT_DIRECT_VS_INDIRECT = 'cpt_direct_vs_indirect' as ConceptId;
const CONCEPT_NONCASH_ADJ = 'cpt_noncash_adjustments' as ConceptId;
const CONCEPT_WC_CHANGES = 'cpt_working_capital_changes' as ConceptId;

const DECK_ID = 'deck_cfa_cash_flow' as DeckId;
const CARD_DIRECT_VS_INDIRECT = 'fc_direct_vs_indirect' as FlashcardId;
const CARD_NONCASH = 'fc_noncash' as FlashcardId;
const CARD_DEPRECIATION = 'fc_depreciation' as FlashcardId;

const SESSION_1 = 'ses_cfa_2026-06-26' as SessionId;
const HYPOTHESIS_1 = 'hyp_formula_aversion' as LearnerHypothesisId;
const REFLECTION_1 = 'refl_formula_first_failed' as TeacherReflectionId;

// round 2 ids
const EXERCISE_L1_1 = 'ex_l1_1' as ExerciseId;
const EXERCISE_L1_2 = 'ex_l1_2' as ExerciseId;
const EXERCISE_L2_1 = 'ex_l2_1' as ExerciseId;
const EXERCISE_L2_2 = 'ex_l2_2' as ExerciseId;
const EXERCISE_L2_3 = 'ex_l2_3' as ExerciseId;
const SUBMISSION_L2_1 = 'sub_l2_1' as ExerciseSubmissionId;

const MINDMAP_L2 = 'mm_l2' as MindmapId;
const MINDMAP_CUSTOM = 'mm_custom_1' as MindmapId;

const PENDING_1 = 'pc_1' as PendingCardId;
const PENDING_2 = 'pc_2' as PendingCardId;
const PENDING_3 = 'pc_3' as PendingCardId;

const BANK_CFA_L1 = 'qb_cfa_l1_2025' as QuestionBankId;
const BANK_JLPT = 'qb_jlpt_n3' as QuestionBankId;

const SIM_QUIZ_1 = 'sq_cfa_cash_flow_1' as SimulatedQuizId;

const FEEDBACK_LAST_WEEK = 'fb_week_2026-06-22' as LearnerFeedbackId;

const REMINDER_SETUP_DONE = 'rmd_setup_done' as ReminderId;
const REMINDER_LESSON_DUE = 'rmd_lesson_due' as ReminderId;
const REMINDER_REVIEW_DUE = 'rmd_review_due' as ReminderId;
const REMINDER_FEEDBACK = 'rmd_feedback_invite' as ReminderId;

const EVAL_L2 = 'ev_l2' as PostLessonEvaluationId;

// ---------------------------------------------------------------------------
// Static timestamps (so demo doesn't drift)
// ---------------------------------------------------------------------------
const T_BASE = '2026-06-26T13:00:00.000Z';
const T_PLUS = (mins: number): string =>
  new Date(new Date(T_BASE).getTime() + mins * 60_000).toISOString();
const T_TOMORROW = new Date(new Date(T_BASE).getTime() + 24 * 60 * 60_000).toISOString();
const T_NEXT_MONDAY = '2026-06-29T18:00:00.000Z';

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------
const CFA_OFFICIAL: SourceRef = {
  type: 'web',
  url: 'https://www.cfainstitute.org/programs/cfa/curriculum',
  syllabus_version: '2027',
  confidence: 1,
};

const AGENT_GEN: SourceRef = {
  type: 'agent-generated',
  confidence: 0.8,
};

// ---------------------------------------------------------------------------
// Pair + Contract
// ---------------------------------------------------------------------------
// Demo-mode identity is deliberately generic (顶栏名称数据驱动化 连带): a fresh browser
// lands in seeded mode before anyone runs db:seed, so this is the first
// identity a new deployment ever shows. Real names come from live mode
// (db/seed.ts env overrides + Settings identity 区块).
export const learner: Learner = {
  id: LEARNER_ID,
  display_name: 'Learner',
  preferences: { timezone: 'UTC', locale: 'en' },
  created_at: '2026-05-18T00:00:00.000Z',
};

export const agent: Agent = {
  id: AGENT_ID,
  display_name: 'My Agent',
  provider: 'claude-code-cli',
  model_family: 'claude',
  capabilities: ['web_search', 'file_read', 'mcp_call'],
  created_at: '2026-05-18T00:00:00.000Z',
};

export const pair: LearnerAgentPair = {
  id: PAIR_ID,
  learner_id: LEARNER_ID,
  agent_id: AGENT_ID,
  established_at: '2026-05-18T00:00:00.000Z',
  active: true,
};

export const contract: TeachingContract = {
  id: CONTRACT_ID,
  pair_id: PAIR_ID,
  version: 1,
  goal: 'Pass CFA Level 1 in February 2027',
  time_range: { start: '2026-05-18T00:00:00.000Z', end_target: '2027-02-28T00:00:00.000Z' },
  success_criteria: [
    'Pass CFA Level 1 official exam',
    'Maintain 80%+ FSRS retention on core concepts',
    'Apply Financial Reporting concepts to real portfolio decisions',
  ],
  agent_read_scopes: [
    'pair://contract',
    'pair://learner/profile',
    'pair://courses',
    'pair://flashcards/*',
    'pair://reviews/due',
    'pair://learning-sessions',
    'pair://teacher/identity',
  ],
  agent_write_scopes: [
    'create_course',
    'add_lesson',
    'add_flashcard',
    'record_review',
    'record_learner_hypothesis',
    'reflect_on_teaching',
  ],
  feedback_tone: {
    reminders: 'gentle',
    questioning: 'persistent',
    correction: 'direct',
    encouragement: 'sparing',
  },
  human_approval_required: ['hypothesis.proposed'],
  forbidden_observations: ['general_personality_traits'],
  created_at: '2026-05-18T00:00:00.000Z',
  updated_at: T_BASE,

  // ----- round 2 preferences -----
  intensity: 'standard',
  interaction_mode: 'hybrid',
  content_modality: 'mixed',
  weekly_capacity_hours: 8,
  preferred_time_of_day: ['evening'],

  // ----- round 2 reminder block -----
  accepts_reminders: true,
  reminder_channels: ['in_app', 'ical'],
  reminder_types: ['lesson_due', 'review_due', 'feedback_invitation'],
  do_not_disturb: { start: '22:00', end: '07:00' },
  ical_subscription_url: 'https://learn-shell.local/api/u/cfa-demo-token.ics',

  // ----- round 2 setup progress -----
  setup_status: 'ready',
  setup_started_at: '2026-06-25T08:30:00.000Z',
  setup_completed_at: '2026-06-25T08:32:34.000Z',
  setup_steps: [
    { name: 'parse_goal', status: 'done', duration_ms: 8_000 },
    { name: 'read_materials', status: 'done', duration_ms: 23_000 },
    { name: 'select_skill', status: 'done', duration_ms: 2_000 },
    { name: 'draft_lesson_1', status: 'done', duration_ms: 42_000 },
    { name: 'gen_flashcards', status: 'done', duration_ms: 31_000 },
    { name: 'write_exercises', status: 'done', duration_ms: 28_000 },
    { name: 'sketch_mindmap', status: 'done', duration_ms: 15_000 },
    { name: 'verify', status: 'done', duration_ms: 5_000 },
  ],

  // ----- State 2.0 (迁移 0030): 合约完成态 -----
  covered_course_ids: [],
};

// ---------------------------------------------------------------------------
// Course + lessons
// ---------------------------------------------------------------------------
export const course: Course = {
  id: COURSE_ID,
  pair_id: PAIR_ID,
  topic: 'CFA L1 — Cash Flow Statement (Indirect Method)',
  description:
    '从净利润出发，倒推经营活动现金流的方法。包含非现金调整、营运资本变化、与直接法的区别。',
  structure: { lesson_ids: [LESSON_1, LESSON_2] },
  generated_by_agent_id: AGENT_ID,
  generated_from: [CFA_OFFICIAL, AGENT_GEN],
  syllabus_version: '2027',
  planned_lesson_count: null,
  created_at: '2026-06-25T09:00:00.000Z',
  updated_at: T_BASE,
};

export const lessons: Lesson[] = [
  {
    id: LESSON_1,
    course_id: COURSE_ID,
    order: 1,
    title: '直接法 vs 间接法',
    content_markdown:
      '## 直接法 vs 间接法\n\n直接法逐项加总现金收入与现金支出；间接法从净利润倒推。\n\n在 IFRS 和 US GAAP 下两种都被允许，但实务中 **间接法更普遍**——因为大多数公司的会计系统就是按权责发生制记账，倒推比从头加总更省事。\n\n关键差异：直接法看"现金从哪来"，间接法看"利润和现金差在哪"。',
    concept_ids: [CONCEPT_DIRECT_VS_INDIRECT],
    source_refs: [CFA_OFFICIAL],
    estimated_minutes: 12,
    skill_used: 'teach-cfa-v2',
  },
  {
    id: LESSON_2,
    course_id: COURSE_ID,
    order: 2,
    title: '非现金调整与营运资本变化',
    content_markdown:
      '## 非现金调整\n\n净利润里包含了一些"账面上有但没真现金动"的项目——典型是 **折旧、摊销、减值**。这些要加回。\n\n## 营运资本变化\n\n应收账款增加 = 客户欠你的钱多了 = 实际现金少进了 = 减项。\n应付账款增加 = 你欠供应商的钱多了 = 实际现金少出了 = 加项。',
    concept_ids: [CONCEPT_NONCASH_ADJ, CONCEPT_WC_CHANGES],
    source_refs: [CFA_OFFICIAL],
    estimated_minutes: 18,
    skill_used: 'teach-cfa-v2',
  },
];

// ---------------------------------------------------------------------------
// Flashcards
// ---------------------------------------------------------------------------
const fsrsDue = (offsetHours: number) =>
  new Date(new Date(T_BASE).getTime() + offsetHours * 3_600_000).toISOString();

// activated: true (激活门, 迁移 0045) —— 这三张卡都挂在这节已经上过的课
// (Live 场 + 复习史 review_count >= 1 都在 fixture 里), 所以是醒着的。
// 显式写出来而不是靠"缺字段按默认解读": fixture 是示例模式下的唯一真相,
// 它得让人一眼看出这几张卡为什么会出现在复习队列里。

export const flashcards: Flashcard[] = [
  {
    id: CARD_DIRECT_VS_INDIRECT,
    pair_id: PAIR_ID,
    concept_id: CONCEPT_DIRECT_VS_INDIRECT,
    deck_id: DECK_ID,
    front: '间接法和直接法的核心区别是什么？',
    back:
      '直接法逐项加总现金收支；间接法从净利润倒推。直接法关心"现金从哪来"，间接法关心"利润和现金差在哪"。',
    tags: ['cfa', 'financial-reporting', 'cash-flow'],
    source_refs: [CFA_OFFICIAL],
    fsrs_state: {
      due_at: fsrsDue(-2),
      stability: 4.2,
      difficulty: 5.1,
      last_review_at: '2026-06-23T13:00:00.000Z',
      review_count: 3,
      retrievability: 0.62,
    },
    activated: true,
    created_at: '2026-06-25T09:30:00.000Z',
    updated_at: T_PLUS(0),
  },
  {
    id: CARD_NONCASH,
    pair_id: PAIR_ID,
    concept_id: CONCEPT_NONCASH_ADJ,
    deck_id: DECK_ID,
    front: '非现金项目是什么？给两个例子。',
    back: '账面有但没真实现金流动的项目。典型：折旧、摊销、减值。在间接法里要从净利润加回去。',
    tags: ['cfa', 'financial-reporting', 'cash-flow', 'non-cash'],
    source_refs: [CFA_OFFICIAL],
    fsrs_state: {
      due_at: fsrsDue(1),
      stability: 2.1,
      difficulty: 6.4,
      last_review_at: '2026-06-26T11:00:00.000Z',
      review_count: 2,
      retrievability: 0.41,
    },
    activated: true,
    created_at: '2026-06-25T09:30:00.000Z',
    updated_at: T_PLUS(0),
  },
  {
    id: CARD_DEPRECIATION,
    pair_id: PAIR_ID,
    concept_id: CONCEPT_NONCASH_ADJ,
    deck_id: DECK_ID,
    front: '折旧为什么要从净利润加回？',
    back:
      '折旧在利润表里是一笔费用，但实际上没有现金流出（资产是过去买的，购买时的现金流出已经记在投资活动里了）。所以倒推经营活动现金流时要把它加回去。',
    tags: ['cfa', 'financial-reporting', 'cash-flow', 'non-cash', 'depreciation'],
    source_refs: [CFA_OFFICIAL],
    fsrs_state: {
      due_at: fsrsDue(6),
      stability: 1.4,
      difficulty: 7.2,
      last_review_at: '2026-06-26T12:30:00.000Z',
      review_count: 1,
      retrievability: 0.55,
    },
    activated: true,
    created_at: '2026-06-25T09:30:00.000Z',
    updated_at: T_PLUS(0),
  },
];

// ---------------------------------------------------------------------------
// Annotation (划注, batch D — Journal "我的笔记" 视觉验证 fixture)
//
// 真库 lesson_annotations 目前为空 (批A-C 上线时尚无学习者划注数据);
// 这组是 Journal 右侧笔记栏 + 孤儿区在 Mock/示例模式下的唯一数据来源。
// 五色各一条 (ANNOTATION_COLORS 的顺序: blue/green/amber/red/purple) +
// 两条孤儿 (orphaned_at 预置为非空, 模拟课文修订后锚点定位失败 —
// batch D 没有为 Mock 写真实的 sweep 逻辑, 孤儿状态直接烘进 fixture)。
// 选段文本取自上面两节
// 课的 content_markdown 原句, 孤儿的选段文本刻意不在当前正文里出现。
//
// 批E 追加两条自由笔记 (lesson_id null, selected_text/prefix/suffix 空串 —
// 不锚定课文, 批E) — Journal 面板"按颜色 /
// 按课程 / 按时间"排序 + 筛选 + 搜索在 Mock/示例模式下的样例数据。
// ---------------------------------------------------------------------------
export const annotations: LessonAnnotationWithOrphan[] = [
  {
    id: 'ann_fixture_blue' as AnnotationId,
    pair_id: PAIR_ID,
    lesson_id: LESSON_1,
    document_id: null,
    live_session_id: null,
    page_index: 0,
    selected_text: '间接法更普遍',
    prefix: '两种都被允许，但实务中 **',
    suffix: '**——因为大多数公司',
    color: 'blue',
    note: '报告里几乎都是这么处理的',
    orphaned_at: null,
    created_at: T_PLUS(20),
    updated_at: T_PLUS(20),
  },
  {
    id: 'ann_fixture_green' as AnnotationId,
    pair_id: PAIR_ID,
    lesson_id: LESSON_2,
    document_id: null,
    live_session_id: null,
    page_index: 0,
    selected_text: '应付账款增加 = 你欠供应商的钱多了 = 实际现金少出了 = 加项。',
    prefix: '\n',
    suffix: '',
    color: 'green',
    note: null,
    orphaned_at: null,
    created_at: T_PLUS(35),
    updated_at: T_PLUS(35),
  },
  {
    id: 'ann_fixture_amber' as AnnotationId,
    pair_id: PAIR_ID,
    lesson_id: LESSON_2,
    document_id: null,
    live_session_id: null,
    page_index: 0,
    selected_text: '折旧、摊销、减值',
    prefix: '典型是 **',
    suffix: '**。这些要加回。',
    color: 'amber',
    note: '这三个是加回的核心',
    orphaned_at: null,
    created_at: T_PLUS(40),
    updated_at: T_PLUS(40),
  },
  {
    id: 'ann_fixture_red' as AnnotationId,
    pair_id: PAIR_ID,
    lesson_id: LESSON_1,
    document_id: null,
    live_session_id: null,
    page_index: 0,
    selected_text: '现金收入与现金支出',
    prefix: '直接法逐项加总',
    suffix: '；间接法从净利润倒推。',
    color: 'red',
    note: '直接法的定义句',
    orphaned_at: null,
    created_at: T_PLUS(18),
    updated_at: T_PLUS(18),
  },
  {
    id: 'ann_fixture_purple' as AnnotationId,
    pair_id: PAIR_ID,
    lesson_id: LESSON_2,
    document_id: null,
    live_session_id: null,
    page_index: 0,
    selected_text: '应收账款增加 = 客户欠你的钱多了 = 实际现金少进了 = 减项。',
    prefix: '',
    suffix: '\n',
    color: 'purple',
    note: '记得区分方向, 别跟应付搞反',
    orphaned_at: null,
    created_at: T_PLUS(38),
    updated_at: T_PLUS(38),
  },
  // 孤儿 ×2 — 永不丢行原则: 课文修订后锚点定位失败, 进"待重新安放", 不删除.
  {
    id: 'ann_fixture_orphan_1' as AnnotationId,
    pair_id: PAIR_ID,
    lesson_id: LESSON_1,
    document_id: null,
    live_session_id: null,
    page_index: 0,
    selected_text: '权责发生制记账更省事这句旧例句',
    prefix: '',
    suffix: '',
    color: 'blue',
    note: '当时觉得这句话点明了为什么行业都用间接法',
    orphaned_at: T_PLUS(50),
    created_at: T_PLUS(10),
    updated_at: T_PLUS(50),
  },
  {
    id: 'ann_fixture_orphan_2' as AnnotationId,
    pair_id: PAIR_ID,
    lesson_id: LESSON_2,
    document_id: null,
    live_session_id: null,
    page_index: 0,
    selected_text: '旧版关于减值的举例句子已被替换',
    prefix: '',
    suffix: '',
    color: 'amber',
    note: null,
    orphaned_at: T_PLUS(45),
    created_at: T_PLUS(25),
    updated_at: T_PLUS(45),
  },
  // 自由笔记 ×2 (批E) — 不锚定课文, lesson_id null.
  {
    id: 'ann_fixture_free_1' as AnnotationId,
    pair_id: PAIR_ID,
    lesson_id: null,
    document_id: null,
    live_session_id: null,
    page_index: 0,
    selected_text: '',
    prefix: '',
    suffix: '',
    color: 'green',
    note: '现金流量表这块儿, 复盘时最容易漏的是把间接法和权责发生制混在一起说——下次备考前单独整理一页对照表。',
    orphaned_at: null,
    created_at: T_PLUS(42),
    updated_at: T_PLUS(42),
  },
  {
    id: 'ann_fixture_free_2' as AnnotationId,
    pair_id: PAIR_ID,
    lesson_id: null,
    document_id: null,
    live_session_id: null,
    page_index: 0,
    selected_text: '',
    prefix: '',
    suffix: '',
    color: 'purple',
    note: '今天状态不错, 想给自己留句话: 别怕算错, 算错了知道错在哪儿比蒙对更值钱。',
    orphaned_at: null,
    created_at: T_PLUS(22),
    updated_at: T_PLUS(22),
  },
];

// ---------------------------------------------------------------------------
// Exercise (随堂作业, per-lesson)
// ---------------------------------------------------------------------------
export const exercises: Exercise[] = [
  // Lesson 1: intensity=standard → 2 道
  {
    id: EXERCISE_L1_1,
    lesson_id: LESSON_1,
    order: 1,
    prompt:
      'In your own words, explain why the indirect method is more common in practice than the direct method.',
    reference_answer:
      'Most accounting systems record on an accrual basis. Net income is already computed; backing out non-cash items and working-capital changes from net income reuses existing books, whereas the direct method requires tracking every cash receipt/disbursement separately — more bookkeeping cost.',
    expected_concepts: [CONCEPT_DIRECT_VS_INDIRECT],
    agent_skill_used: 'teach-cfa-v2',
    created_at: '2026-06-25T09:30:00.000Z',
    updated_at: '2026-06-25T09:30:00.000Z',
  },
  {
    id: EXERCISE_L1_2,
    lesson_id: LESSON_1,
    order: 2,
    prompt:
      'A company reports $1M net income and $200k depreciation. Using the indirect method, what is the starting cash flow from operations before working-capital adjustments?',
    reference_answer:
      '$1.2M. Net income $1M + depreciation $200k (added back as a non-cash item) = $1.2M operating cash flow before working-capital changes.',
    expected_concepts: [CONCEPT_DIRECT_VS_INDIRECT, CONCEPT_NONCASH_ADJ],
    agent_skill_used: 'teach-cfa-v2',
    created_at: '2026-06-25T09:30:00.000Z',
    updated_at: '2026-06-25T09:30:00.000Z',
  },
  // Lesson 2: intensity=standard → 3 道
  {
    id: EXERCISE_L2_1,
    lesson_id: LESSON_2,
    order: 1,
    prompt:
      'Explain why depreciation is added back when reconciling net income to operating cash flow under the indirect method.',
    reference_answer:
      'Depreciation is a non-cash expense that reduced net income on the income statement, but no cash actually left the business this period (the original cash outflow was recorded in investing activities when the asset was purchased). To reconcile to actual cash flow we add it back.',
    expected_concepts: [CONCEPT_NONCASH_ADJ],
    agent_skill_used: 'teach-cfa-v2',
    created_at: '2026-06-25T09:30:00.000Z',
    updated_at: '2026-06-25T09:30:00.000Z',
  },
  {
    id: EXERCISE_L2_2,
    lesson_id: LESSON_2,
    order: 2,
    prompt:
      'Accounts receivable rose by $40k this quarter. Under the indirect method, does this help or hurt operating cash flow? Explain.',
    reference_answer:
      'Hurts. A rise in AR means revenue was recognized but cash has not yet been collected — so $40k is subtracted from net income when reconciling to CFO.',
    expected_concepts: [CONCEPT_WC_CHANGES],
    agent_skill_used: 'teach-cfa-v2',
    created_at: '2026-06-25T09:30:00.000Z',
    updated_at: '2026-06-25T09:30:00.000Z',
  },
  {
    id: EXERCISE_L2_3,
    lesson_id: LESSON_2,
    order: 3,
    prompt:
      'A company has net income $500k, depreciation $80k, AR increased by $30k, AP increased by $20k, and inventory decreased by $10k. What is operating cash flow under the indirect method?',
    reference_answer:
      '$580k. NI $500k + Depreciation $80k − AR↑ $30k + AP↑ $20k + Inventory↓ $10k = $580k.',
    expected_concepts: [CONCEPT_NONCASH_ADJ, CONCEPT_WC_CHANGES],
    agent_skill_used: 'teach-cfa-v2',
    created_at: '2026-06-25T09:30:00.000Z',
    updated_at: '2026-06-25T09:30:00.000Z',
  },
];

export const exerciseSubmissions: ExerciseSubmission[] = [
  // One submission already graded — demonstrates 4-state machine
  {
    id: SUBMISSION_L2_1,
    exercise_id: EXERCISE_L2_1,
    learner_id: LEARNER_ID,
    learner_answer:
      '折旧是非现金费用所以要加回，但我不确定为什么购买当时的现金流不在经营活动里。',
    status: 'graded',
    submitted_at: T_PLUS(11),
    agent_feedback:
      '前半对了 ✓ 折旧确实是非现金费用要加回. 后半的疑问刚好揭示了一个理解关键: 购买长期资产时的现金流出属于"投资活动" (investing activities) 不是"经营活动" (operating activities). 现金流量表按"经营/投资/融资"三类分; 经营 CF 只看本期周期性现金流, 长期资产购置是"投资"类. 折旧把这个原本属于投资的过去现金流出, 通过 P&L 的非现金扣减, "影响"到了 NI; 所以从 NI 倒推 OCF 时, 必须把这个非现金扣减加回.',
    agent_score: 0.65,
    graded_at: T_PLUS(45),
  },
];

// ---------------------------------------------------------------------------
// Mindmap (per-lesson Lesson 2, + 1 custom 自建图)
// ---------------------------------------------------------------------------
const mindmapL2Seed = {
  nodes: [
    {
      id: 'n_root',
      title: 'Lesson 2 · 非现金调整与营运资本变化',
      level: 'root' as const,
      pos_x: 50,
      pos_y: 10,
      is_expanded: true,
      sort_order: 0,
    },
    {
      id: 'n_noncash',
      parent_id: 'n_root',
      title: '非现金调整',
      level: 'branch' as const,
      pos_x: 25,
      pos_y: 35,
      is_expanded: true,
      sort_order: 1,
    },
    // detail 层原本带 content 字段承载解释语。2026-07-01 判断:
    // content 藏在悬停/侧栏是妥协, 思维导图就该把每条概念都做成可见节点.
    // 把原 content 按句号切分为 note 层子节点, 每条一个 pill.
    {
      id: 'n_noncash_dep',
      parent_id: 'n_noncash',
      title: '折旧 / Depreciation',
      level: 'detail' as const,
      source_type: 'concept' as const,
      source_id: CONCEPT_NONCASH_ADJ,
      pos_x: 10,
      pos_y: 55,
      is_expanded: false,
      sort_order: 2,
    },
    {
      id: 'n_noncash_dep_1',
      parent_id: 'n_noncash_dep',
      title: '账面扣利润，无现金流出',
      level: 'note' as const,
      pos_x: 2,
      pos_y: 68,
      is_expanded: false,
      sort_order: 3,
    },
    {
      id: 'n_noncash_dep_2',
      parent_id: 'n_noncash_dep',
      title: '原始购置流出记投资活动',
      level: 'note' as const,
      pos_x: 12,
      pos_y: 72,
      is_expanded: false,
      sort_order: 4,
    },
    {
      id: 'n_noncash_dep_3',
      parent_id: 'n_noncash_dep',
      title: '倒推 OCF 时要加回',
      level: 'note' as const,
      pos_x: 22,
      pos_y: 68,
      is_expanded: false,
      sort_order: 5,
    },
    {
      id: 'n_noncash_amort',
      parent_id: 'n_noncash',
      title: '摊销 / Amortization',
      level: 'detail' as const,
      pos_x: 25,
      pos_y: 60,
      is_expanded: false,
      sort_order: 6,
    },
    {
      id: 'n_noncash_amort_1',
      parent_id: 'n_noncash_amort',
      title: '无形资产的折旧',
      level: 'note' as const,
      pos_x: 20,
      pos_y: 74,
      is_expanded: false,
      sort_order: 7,
    },
    {
      id: 'n_noncash_amort_2',
      parent_id: 'n_noncash_amort',
      title: '处理逻辑同折旧',
      level: 'note' as const,
      pos_x: 30,
      pos_y: 76,
      is_expanded: false,
      sort_order: 8,
    },
    {
      id: 'n_noncash_imp',
      parent_id: 'n_noncash',
      title: '减值 / Impairment',
      level: 'detail' as const,
      pos_x: 40,
      pos_y: 65,
      is_expanded: false,
      sort_order: 9,
    },
    {
      id: 'n_noncash_imp_1',
      parent_id: 'n_noncash_imp',
      title: '账面 > 可收回金额',
      level: 'note' as const,
      pos_x: 34,
      pos_y: 79,
      is_expanded: false,
      sort_order: 10,
    },
    {
      id: 'n_noncash_imp_2',
      parent_id: 'n_noncash_imp',
      title: '一次性写减',
      level: 'note' as const,
      pos_x: 45,
      pos_y: 80,
      is_expanded: false,
      sort_order: 11,
    },
    {
      id: 'n_wc',
      parent_id: 'n_root',
      title: '营运资本变化',
      level: 'branch' as const,
      pos_x: 75,
      pos_y: 35,
      is_expanded: true,
      sort_order: 12,
    },
    {
      id: 'n_wc_ar',
      parent_id: 'n_wc',
      title: 'AR ↑ → CF 减',
      level: 'detail' as const,
      pos_x: 60,
      pos_y: 60,
      is_expanded: false,
      sort_order: 13,
    },
    {
      id: 'n_wc_ar_1',
      parent_id: 'n_wc_ar',
      title: 'AR 增 = 客户欠你多了',
      level: 'note' as const,
      pos_x: 54,
      pos_y: 74,
      is_expanded: false,
      sort_order: 14,
    },
    {
      id: 'n_wc_ar_2',
      parent_id: 'n_wc_ar',
      title: '实际现金少进了',
      level: 'note' as const,
      pos_x: 66,
      pos_y: 75,
      is_expanded: false,
      sort_order: 15,
    },
    {
      id: 'n_wc_ap',
      parent_id: 'n_wc',
      title: 'AP ↑ → CF 加',
      level: 'detail' as const,
      pos_x: 80,
      pos_y: 65,
      is_expanded: false,
      sort_order: 16,
    },
    {
      id: 'n_wc_ap_1',
      parent_id: 'n_wc_ap',
      title: 'AP 增 = 你欠供应商多了',
      level: 'note' as const,
      pos_x: 73,
      pos_y: 79,
      is_expanded: false,
      sort_order: 17,
    },
    {
      id: 'n_wc_ap_2',
      parent_id: 'n_wc_ap',
      title: '实际现金少出了',
      level: 'note' as const,
      pos_x: 86,
      pos_y: 80,
      is_expanded: false,
      sort_order: 18,
    },
    {
      id: 'n_wc_inv',
      parent_id: 'n_wc',
      title: 'Inventory ↑ → CF 减',
      level: 'detail' as const,
      pos_x: 92,
      pos_y: 55,
      is_expanded: false,
      sort_order: 19,
    },
    {
      id: 'n_wc_inv_1',
      parent_id: 'n_wc_inv',
      title: '库存 = 现金压在货上',
      level: 'note' as const,
      pos_x: 92,
      pos_y: 68,
      is_expanded: false,
      sort_order: 20,
    },
  ],
  links: [
    {
      id: 'l_1',
      from_node_id: 'n_noncash_dep',
      to_node_id: 'n_wc_ar',
      label: 'both add back / subtract from NI',
    },
  ],
};

export const mindmaps: Mindmap[] = [
  {
    id: MINDMAP_L2,
    owner_pair_id: PAIR_ID,
    scope: 'lesson',
    title: 'Lesson 2 · 非现金调整与营运资本变化',
    source: 'agent',
    agent_skill_used: 'teach-cfa-v2',
    agent_seed_snapshot: mindmapL2Seed,
    content: mindmapL2Seed, // 学生还没动过, content = seed
    has_been_reset: false,
    created_at: '2026-06-25T09:30:00.000Z',
    updated_at: '2026-06-25T09:30:00.000Z',
  },
  {
    id: MINDMAP_CUSTOM,
    owner_pair_id: PAIR_ID,
    scope: 'custom',
    title: '我的现金流总表',
    source: 'user',
    agent_seed_snapshot: { nodes: [], links: [] },
    content: {
      nodes: [
        {
          id: 'cn_root',
          title: '现金流总览',
          level: 'root',
          pos_x: 50,
          pos_y: 20,
          is_expanded: true,
          sort_order: 0,
        },
      ],
      links: [],
    },
    has_been_reset: false,
    folder: '我的笔记',
    created_at: '2026-06-26T10:00:00.000Z',
    updated_at: '2026-06-26T10:00:00.000Z',
  },
];

// association 是 lesson↔图 的唯一挂载点——scope 字段只描述图的种类，不携带目标
export const mindmapAssociations: MindmapAssociation[] = [
  {
    id: 'mma_l2',
    mindmap_id: MINDMAP_L2,
    target_type: 'lesson',
    target_id: LESSON_2,
    created_at: '2026-06-25T09:30:00.000Z',
  },
];

// ---------------------------------------------------------------------------
// PendingMindmapCard (待整理池)
// ---------------------------------------------------------------------------
export const pendingCards: PendingMindmapCard[] = [
  {
    id: PENDING_1,
    owner_pair_id: PAIR_ID,
    title: '折旧为什么要加回',
    content: '账面扣减 NI, 但无现金流出. 倒推 OCF 时加回.',
    source_type: 'flashcard',
    source_id: CARD_DEPRECIATION,
    source_title: '折旧为什么要从净利润加回？',
    reason: 'fsrs_difficulty > 7',
    created_at: T_PLUS(11),
  },
  {
    id: PENDING_2,
    owner_pair_id: PAIR_ID,
    title: 'AR 变化方向 (易混)',
    content: 'AR↑ 减; AR↓ 加. 想成"钱还没收到".',
    source_type: 'exercise',
    source_id: EXERCISE_L2_2,
    source_title: 'Exercise L2-2: AR rose by $40k',
    reason: 'exercise_repeated_miss',
    created_at: T_PLUS(20),
  },
  {
    id: PENDING_3,
    owner_pair_id: PAIR_ID,
    title: '现金流量表三类活动',
    content: '经营 / 投资 / 融资. 经营 CF 是常规周期; 投资 CF 是长期资产; 融资 CF 是股权/债权.',
    source_type: 'lesson_highlight',
    source_id: LESSON_1,
    source_title: 'Lesson 1 高亮',
    reason: 'learner_highlight',
    created_at: T_PLUS(5),
  },
];

// ---------------------------------------------------------------------------
// QuestionBank + QuizQuestion (真题路径 sample)
// ---------------------------------------------------------------------------
export const questionBanks: QuestionBank[] = [
  {
    id: BANK_CFA_L1,
    exam: 'CFA Level 1',
    year: 2025,
    source: 'distribution',
    language: 'en',
    version: '2025.1',
    questions_count: 3,
    description: 'Financial Reporting & Analysis · 现金流量表 模块官方真题样本.',
  },
  {
    id: BANK_JLPT,
    exam: 'JLPT N3',
    year: 2024,
    source: 'distribution',
    language: 'ja',
    version: '2024.7',
    questions_count: 0,
    description: '日语能力测试 N3 真题样本 (待补全).',
  },
];

export const quizQuestions: QuizQuestion[] = [
  {
    id: 'qq_cfa_1',
    bank_id: BANK_CFA_L1,
    stem: 'Under the indirect method, an increase in accounts receivable of $50,000 would most likely:',
    question_type: 'single_choice',
    choices: [
      'Be added to net income',
      'Be subtracted from net income',
      'Have no effect on cash flow from operations',
      'Be classified under investing activities',
    ],
    reference_answer: 'B',
    explanation:
      'An increase in AR means revenue was recognized but cash was not collected, so the $50,000 must be subtracted from net income to reconcile to operating cash flow.',
    concept_tags: ['cash-flow', 'working-capital'],
    difficulty: 2,
  },
  {
    id: 'qq_cfa_2',
    bank_id: BANK_CFA_L1,
    stem: 'Which of the following is most accurately classified as a non-cash item that is added back to net income under the indirect method?',
    question_type: 'single_choice',
    choices: [
      'Dividends paid',
      'Interest paid',
      'Depreciation expense',
      'Issuance of long-term debt',
    ],
    reference_answer: 'C',
    explanation:
      'Depreciation is a non-cash expense that reduced net income. Dividends and debt issuance are financing activities; interest paid is operating cash outflow.',
    concept_tags: ['cash-flow', 'non-cash'],
    difficulty: 1,
  },
  {
    id: 'qq_cfa_3',
    bank_id: BANK_CFA_L1,
    stem: 'A company reports the following: Net income $200,000; Depreciation $30,000; AR increased $15,000; AP decreased $10,000; Inventory increased $5,000. CFO under indirect method?',
    question_type: 'single_choice',
    choices: ['$170,000', '$180,000', '$200,000', '$220,000'],
    reference_answer: 'C',
    explanation:
      '$200k NI + $30k Dep − $15k (AR↑) − $10k (AP↓) − $5k (Inv↑) = $200k. (Both AP↓ and Inv↑ subtract from CFO.)',
    concept_tags: ['cash-flow', 'working-capital', 'computation'],
    difficulty: 3,
  },
];

// ---------------------------------------------------------------------------
// SimulatedQuiz (agent 出题路径 sample, round 3 Quiz 通电) — 一份小 fixture:
// single_choice + multi_choice (' || ' 分隔编码多正确项, 竖线分隔约定 定案; 判分在
// 客户端 MockRepository.gradeSimulatedAnswer, server 无判分路由, 见 判分口径注释修正) +
// 一道省略 question_type 的开放题 (round 2 兼容默认).
// ---------------------------------------------------------------------------
export const simulatedQuizzes: SimulatedQuiz[] = [
  {
    id: SIM_QUIZ_1,
    pair_id: PAIR_ID,
    course_id: COURSE_ID,
    agent_skill_used: 'teach-cfa',
    created_at: T_PLUS(20),
    questions: [
      {
        id: 'sqq_1',
        stem: 'Under the indirect method, which of the following is added back to net income to arrive at CFO?',
        question_type: 'single_choice',
        choices: [
          'Depreciation expense',
          'Increase in accounts receivable',
          'Decrease in accounts payable',
          'Dividends paid',
        ],
        reference_answer: 'Depreciation expense',
        explanation:
          'Depreciation is a non-cash expense that reduced net income without a matching cash outflow — adding it back undoes that accounting effect.',
        concept_tags: [CONCEPT_NONCASH_ADJ],
      },
      {
        id: 'sqq_2',
        stem: 'Which of the following working-capital changes would be SUBTRACTED from net income when reconciling to CFO? (select all that apply)',
        question_type: 'multi_choice',
        choices: [
          'Increase in accounts receivable',
          'Increase in accounts payable',
          'Increase in inventory',
          'Decrease in accrued liabilities',
        ],
        reference_answer:
          'Increase in accounts receivable,Increase in inventory,Decrease in accrued liabilities',
        explanation:
          'Increases in current assets (AR, inventory) use cash and are subtracted; a decrease in a current liability (accrued liabilities) also uses cash and is subtracted. An increase in AP is a source of cash and gets added instead.',
        concept_tags: [CONCEPT_WC_CHANGES],
      },
      {
        id: 'sqq_3',
        stem: 'In your own words: why does the indirect method start from net income instead of just summing cash receipts and payments directly (the direct method)?',
        reference_answer:
          'The indirect method reconciles accrual-basis net income to a cash basis by reversing non-cash items and working-capital timing differences — it reuses numbers already on the income statement / balance sheet instead of re-deriving cash flows line by line, which is why most companies report it despite the direct method being more intuitive to read.',
        concept_tags: [CONCEPT_DIRECT_VS_INDIRECT],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// LearnerFeedback (周一次)
// ---------------------------------------------------------------------------
export const feedback: LearnerFeedback[] = [
  {
    id: FEEDBACK_LAST_WEEK,
    pair_id: PAIR_ID,
    contract_id: CONTRACT_ID,
    week_of: '2026-06-22T00:00:00.000Z',
    pace: 4,
    difficulty: 3,
    helpfulness: 5,
    tone_fit: 4,
    free_text: '希望再多一些例子, formula 直接给比较硬.',
    suggested_changes: '能不能从我的实际场景(portfolio)切入再讲公式?',
    submitted_at: '2026-06-26T20:00:00.000Z',
  },
];

// ---------------------------------------------------------------------------
// Reminder (4 channels demo)
// ---------------------------------------------------------------------------
export const reminders: Reminder[] = [
  {
    id: REMINDER_SETUP_DONE,
    pair_id: PAIR_ID,
    type: 'setup_complete',
    scheduled_for: '2026-06-25T08:32:34.000Z',
    channel: 'in_app',
    fired_at: '2026-06-25T08:32:34.000Z',
    dismissed_at: '2026-06-25T08:33:10.000Z',
    payload: { contract_id: CONTRACT_ID, total_setup_seconds: 154 },
    created_at: '2026-06-25T08:32:34.000Z',
  },
  {
    id: REMINDER_LESSON_DUE,
    pair_id: PAIR_ID,
    type: 'lesson_due',
    scheduled_for: T_TOMORROW,
    channel: 'in_app',
    payload: { lesson_id: LESSON_2 },
    created_at: T_PLUS(0),
  },
  {
    id: REMINDER_REVIEW_DUE,
    pair_id: PAIR_ID,
    type: 'review_due',
    scheduled_for: T_TOMORROW,
    channel: 'ical',
    payload: { due_count: 2 },
    created_at: T_PLUS(0),
  },
  {
    id: REMINDER_FEEDBACK,
    pair_id: PAIR_ID,
    type: 'feedback_invitation',
    scheduled_for: T_NEXT_MONDAY,
    channel: 'in_app',
    payload: { week_of: T_NEXT_MONDAY },
    created_at: T_PLUS(0),
  },
];

// ---------------------------------------------------------------------------
// PostLessonEvaluation (每课纯事实层)
// ---------------------------------------------------------------------------
export const postLessonEvaluations: PostLessonEvaluation[] = [
  {
    id: EVAL_L2,
    pair_id: PAIR_ID,
    lesson_id: LESSON_2,
    learning_session_id: SESSION_1,
    concepts_touched: [CONCEPT_NONCASH_ADJ],
    flashcards_reviewed_count: 2,
    flashcards_rating_distribution: { Again: 2, Hard: 0, Good: 0, Easy: 0 },
    exercises_submitted_count: 1,
    live_turns_count: 0,
    duration_minutes: 15,
    agent_observation:
      'Learner repeated Again on non-cash adjustments card; could state depreciation as a specific example but stalled at category-level recall.',
    created_at: T_PLUS(14),
  },
];

// ---------------------------------------------------------------------------
// Learning Session — the Teacher Loop's record.
// ---------------------------------------------------------------------------

const ENVELOPE_BASE = {
  pair_id: PAIR_ID,
  session_id: SESSION_1,
  source_refs: [],
  permission_state: 'authorized' as const,
};

export const sessionEvents: SessionEvent[] = [
  {
    ...ENVELOPE_BASE,
    event_id: 'evt_001',
    event_type: 'session.start',
    actor_type: 'learner',
    actor_id: LEARNER_ID,
    recorded_by: 'system',
    occurred_at: T_PLUS(0),
    created_at: T_PLUS(0),
    payload: { course_id: COURSE_ID, intent: 'continue_lesson_2' },
  },
  {
    ...ENVELOPE_BASE,
    event_id: 'evt_002',
    event_type: 'teaching.intervention',
    actor_type: 'agent',
    actor_id: AGENT_ID,
    recorded_by: 'agent',
    occurred_at: T_PLUS(1),
    created_at: T_PLUS(1),
    source_refs: [AGENT_GEN],
    payload: {
      method: 'formula-first',
      rationale: 'Lesson 2 introduces non-cash adjustments; standard pedagogy gives the formula then examples.',
      expected_outcome: 'Learner internalizes the formula and applies it to two practice problems.',
      prior_hypothesis_ids: [],
    },
  },
  {
    ...ENVELOPE_BASE,
    event_id: 'evt_003',
    event_type: 'lesson.viewed',
    actor_type: 'learner',
    actor_id: LEARNER_ID,
    recorded_by: 'system',
    occurred_at: T_PLUS(3),
    created_at: T_PLUS(3),
    payload: { lesson_id: LESSON_2, position_at_close: 0.65 },
  },
  {
    ...ENVELOPE_BASE,
    event_id: 'evt_004',
    event_type: 'review.rated',
    actor_type: 'learner',
    actor_id: LEARNER_ID,
    recorded_by: 'learner',
    occurred_at: T_PLUS(8),
    created_at: T_PLUS(8),
    payload: {
      card_id: CARD_NONCASH,
      rating: 'Again',
      answer_text: '折旧 + 利息？',
      time_to_answer_ms: 18_400,
    },
  },
  {
    ...ENVELOPE_BASE,
    event_id: 'evt_005',
    event_type: 'review.rated',
    actor_type: 'learner',
    actor_id: LEARNER_ID,
    recorded_by: 'learner',
    occurred_at: T_PLUS(9),
    created_at: T_PLUS(9),
    payload: {
      card_id: CARD_NONCASH,
      rating: 'Again',
      answer_text: '折旧、摊销...还有什么？想不起来。',
      time_to_answer_ms: 22_100,
    },
  },
  {
    ...ENVELOPE_BASE,
    event_id: 'evt_006',
    event_type: 'learning.evidence',
    actor_type: 'agent',
    actor_id: AGENT_ID,
    recorded_by: 'agent',
    occurred_at: T_PLUS(10),
    created_at: T_PLUS(10),
    payload: {
      observation: 'Learner can name depreciation but stalls on amortization/impairment when asked for examples.',
      related_concept_ids: [CONCEPT_NONCASH_ADJ],
      signal_strength: 'moderate',
    },
  },
  {
    ...ENVELOPE_BASE,
    event_id: 'evt_007',
    event_type: 'hypothesis.proposed',
    actor_type: 'agent',
    actor_id: AGENT_ID,
    recorded_by: 'agent',
    occurred_at: T_PLUS(11),
    created_at: T_PLUS(11),
    payload: { hypothesis_id: HYPOTHESIS_1 },
  },
  {
    ...ENVELOPE_BASE,
    event_id: 'evt_008',
    event_type: 'reflection.written',
    actor_type: 'agent',
    actor_id: AGENT_ID,
    recorded_by: 'agent',
    occurred_at: T_PLUS(13),
    created_at: T_PLUS(13),
    payload: { reflection_id: REFLECTION_1 },
  },
  {
    ...ENVELOPE_BASE,
    event_id: 'evt_009',
    event_type: 'exercise.submitted',
    actor_type: 'learner',
    actor_id: LEARNER_ID,
    recorded_by: 'learner',
    occurred_at: T_PLUS(11),
    created_at: T_PLUS(11),
    payload: {
      exercise_id: EXERCISE_L2_1,
      submission_id: SUBMISSION_L2_1,
      answer_excerpt: '折旧是非现金费用所以要加回...',
    },
  },
  {
    ...ENVELOPE_BASE,
    event_id: 'evt_010',
    event_type: 'exercise.graded',
    actor_type: 'agent',
    actor_id: AGENT_ID,
    recorded_by: 'agent',
    occurred_at: T_PLUS(45),
    created_at: T_PLUS(45),
    payload: {
      submission_id: SUBMISSION_L2_1,
      score: 0.65,
      feedback_excerpt: '前半对了 ✓ 后半的疑问刚好揭示了一个理解关键...',
    },
  },
  {
    ...ENVELOPE_BASE,
    event_id: 'evt_011',
    event_type: 'session.end',
    actor_type: 'learner',
    actor_id: LEARNER_ID,
    recorded_by: 'system',
    occurred_at: T_PLUS(15),
    created_at: T_PLUS(15),
    payload: { duration_ms: 15 * 60_000, graceful: true },
  },
];

export const session: LearningSession = {
  id: SESSION_1,
  pair_id: PAIR_ID,
  started_at: T_PLUS(0),
  ended_at: T_PLUS(15),
  course_refs: [COURSE_ID],
  concepts_touched: [CONCEPT_NONCASH_ADJ],
  cards_reviewed: [CARD_NONCASH],
  event_count: 0, // 下面 fix
  agent_summary:
    'Learner started Lesson 2 with the formula-first approach. Two consecutive Again on the non-cash adjustments card. Submitted exercise L2-1 with partial understanding; agent graded async. Identified a possible formula-aversion pattern in the Financial Reporting domain; will try analogy-first on the next session.',
  teacher_reflection_id: REFLECTION_1,
  next_actions: [
    'Next session: introduce non-cash adjustments via a real portfolio holding (real Q1 operating cash flow example) before the formula.',
    'If she answers Good on the next non-cash card, confirm hypothesis; if Again again, revise.',
  ],
  mode: 'review',
  skill_used: 'teach-cfa-v2',
};
// patch event_count after declaration
(session as { event_count: number }).event_count = sessionEvents.length;

// ---------------------------------------------------------------------------
// Hypothesis + Reflection
// ---------------------------------------------------------------------------

export const hypothesis: LearnerHypothesis = {
  id: HYPOTHESIS_1,
  pair_id: PAIR_ID,
  domain: 'CFA Financial Reporting',
  observation:
    'Learner may internalize accounting concepts faster when introduced via real cash flow stories from a real portfolio holding, before the formal formula. Two consecutive Again on a formula-first non-cash card; she could name depreciation but not derive the broader category.',
  evidence_event_ids: ['evt_004', 'evt_005', 'evt_006'],
  counterevidence_event_ids: [],
  confidence: 0.65,
  status: 'active',
  written_by_agent_id: AGENT_ID,
  from_session_id: SESSION_1,
  user_approved: null,
  user_note: null,
  last_verified_at: null,
  allowed_for_teaching: true,
  created_at: T_PLUS(11),
  updated_at: T_PLUS(11),
};

export const reflection: TeacherReflection = {
  id: REFLECTION_1,
  pair_id: PAIR_ID,
  from_session_id: SESSION_1,
  linked_intervention_event_id: 'evt_002',
  method: 'formula-first',
  rationale: 'Standard pedagogy: state the rule, then practice. Tried it because it is the textbook default.',
  expected_outcome: 'Learner derives non-cash adjustments from the formula after one example.',
  actual_evidence:
    'Two consecutive Again ratings on the non-cash card; the depreciation lone example came back but the category-level question stalled.',
  what_worked: ['Depreciation as a specific example was retained.'],
  what_failed: [
    'Formula-first did not let the learner connect the rule to an existing mental model of cash flow.',
    'No bridge to a real-world portfolio context.',
  ],
  hypothesis_changes: [
    { hypothesis_id: HYPOTHESIS_1, change: 'created', reason: 'Pattern observed: two Again on a formula-derived card.' },
  ],
  next_action:
    'Next session, open Lesson 2 by walking through Tesla Q1 operating cash flow from a real portfolio holding, then introduce the formula. Test the hypothesis with a fresh non-cash card.',
  written_at: T_PLUS(13),
};

// ---------------------------------------------------------------------------
// Exported entry point — bundles everything for fixtures consumers.
// ---------------------------------------------------------------------------

export const cfaIndirectCashFlowFixture = {
  pair,
  contract,
  learner,
  agent,
  course,
  lessons,
  flashcards,
  annotations,
  session,
  sessionEvents,
  hypothesis,
  reflection,
  // round 2
  exercises,
  exerciseSubmissions,
  mindmaps,
  mindmapAssociations,
  pendingCards,
  questionBanks,
  quizQuestions,
  simulatedQuizzes,
  feedback,
  reminders,
  postLessonEvaluations,
} as const;

export type CFAIndirectCashFlowFixture = typeof cfaIndirectCashFlowFixture;

export { T_TOMORROW };
