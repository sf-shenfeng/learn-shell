// Stable relational objects — Learner / Agent / LearnerAgentPair / TeachingContract.
//
// VISION-v4 core insight: the smallest unit is a learner-agent pair, not a generic user.
// Contracts enforce both sides' rights and obligations.

export type LearnerId = string & { readonly __brand: 'LearnerId' };
export type AgentId = string & { readonly __brand: 'AgentId' };
export type PairId = string & { readonly __brand: 'PairId' };
export type ContractId = string & { readonly __brand: 'ContractId' };

export interface Learner {
  id: LearnerId;
  display_name: string;
  preferences: {
    timezone: string;
    locale: string;
    learning_style_notes?: string;
  };
  /** 语言合同 (迁移 0044): 学习者可见文本的语言, 归学习者所有。
   *  实体列真相源 (preferences.locale 保留为历史形状兼容); 可选+可空 —
   *  学习者从未表达过语言偏好时缺席, 不猜。 */
  locale?: string | null;
  created_at: string;
}

export interface Agent {
  id: AgentId;
  display_name: string;
  provider: 'claude-code-cli' | 'cursor' | 'claude-desktop' | 'windsurf' | 'custom';
  model_family?: string; // 'claude' | 'gpt' | 'gemini' | 'custom'
  capabilities: string[]; // e.g. ['web_search', 'code_execution', 'file_read']
  identity_note?: string; // agent's self-description, surfaced to learner
  created_at: string;
}

export interface LearnerAgentPair {
  id: PairId;
  learner_id: LearnerId;
  agent_id: AgentId;
  established_at: string;
  active: boolean;
  /** 首跑入学 (迁移 0042) — 样板间户口。true = demo pair (seed:demo
   *  写入的展厅数据), false = 真实关系 (MCP create_pair 正门)。参与默认
   *  pair 选择: 隐式"当前 pair"解析按 (is_demo ASC, established_at ASC),
   *  真 pair 永远优先于样板间。Optional 兼容旧数据/fixture — 缺省视同
   *  false (server 列 NOT NULL DEFAULT false)。 */
  is_demo?: boolean;
}

export type FeedbackTone = {
  reminders: 'gentle' | 'firm' | 'off';
  questioning: 'sparse' | 'moderate' | 'persistent';
  correction: 'soft' | 'direct';
  encouragement: 'sparing' | 'frequent';
};

// TEACHING-SPEC v1 round 2: 新增的偏好字段, 见 §3.8.
// 'feedback_tone preset' 入口 drop, 避免给 agent soul 加风格化滤镜.

export type ContractIntensity = 'relaxed' | 'standard' | 'hardcore';
// relaxed:   exercise_count 1-2 / live_challenge_density low
// standard:  exercise_count 2-3 / live_challenge_density medium  (default)
// hardcore:  exercise_count 3+  / live_challenge_density high

export type ContractInteractionMode = 'async' | 'realtime' | 'hybrid';
// async    = 实时授课也按节奏 + 批改 patient (老师定时上班)
// realtime = 实时授课即时 + 批改 tight
// hybrid   = 默认; 实时即时, 批改 standard

export type ContractContentModality = 'text' | 'visual' | 'mixed';

// Pace = 学习节奏频次 (区别于 preferred_time_of_day, 后者是时段).
// daily    = 每天都安排
// weekly   = 集中在一周里的几天 (e.g. 周末)
// flexible = 按学生当时状态, 不固定
// 由 intake/contract-establish skill 的 Class B 观察推导. Stage 3 加入
// (CONTRACT-REDESIGN-BRIEF, 2026-06-29).
export type ContractPace = 'daily' | 'weekly' | 'flexible';

export type PreferredTimeOfDay = 'morning' | 'afternoon' | 'evening' | 'late_night';

// Cadence 条款 (Contract 2.0) — 签约时学习者决定学习节奏:
// 定时(scheduled) 或碎片化(fragmented)。定时者可约固定时段(slots)、是否
// 提醒(reminders)、提醒触发时 agent 是否自动上岗值更(auto_duty)。
//
// 提醒本身不由 LS 发出——LS 无推送通道且不该造这一层。LS 只存约定 + 亮约定
// (读端点带出来给 agent/学习者看), 立钟(设日历/闹钟等实际提醒动作)由
// agent/user 在各自的原生工具里完成, 不是这个字段的职责。
//
// 区别于既有 ContractPace(Stage 3, daily/weekly/flexible 频次粗分类):
// cadence 是这轮 2.0 新增的更细粒度节奏条款(定时/碎片化 + 具体时段 + 提醒
// 偏好), 两个字段并存, 不是替换关系——旧数据的 pace 不受影响。
export type ContractCadenceMode = 'scheduled' | 'fragmented';
export type ContractCadenceReminders = 'native' | 'none';

export interface ContractCadenceSlot {
  /** 0-6, 0 = 周日 (JS Date#getDay 惯例)。 */
  weekday: number;
  /** "HH:MM", 24 小时制。 */
  time: string;
  /** IANA 时区, 如 "Asia/Shanghai"。 */
  tz: string;
}

export interface ContractCadence {
  mode: ContractCadenceMode;
  /** 仅 scheduled 有意义; fragmented 通常留空。 */
  slots?: ContractCadenceSlot[];
  reminders: ContractCadenceReminders;
  /** 提醒触发时 agent 是否自动上岗值更——涉及学习者额度消耗, 签约对话必须
   *  明示询问; 未被明确问过/答过时按 false 处理, 不默认开。 */
  auto_duty: boolean;
  /** fragmented 学习者的温和周复习提醒意愿, 可选; 语义同 reminders——只是
   *  意愿声明, 不代表 LS 会真的发送。 */
  weekly_review_nudge?: boolean;
  /** 备课节奏 (零迁移, cadence jsonb 内加键, 学习者钦定设计) —— "课程内容
   *  你想怎么长出来?" 的答案落这里。
   *  'per_lesson' (随学而备, 推荐默认) — 每课带着上一课的真实表现出生:
   *  探针/评估/难度管线全激活, 上一课 close_lesson_loop 后才备下一课
   *  (见 skills/workflow/lesson-prep.md "随学而备的触发时机")。
   *  'batch' (一次备齐) — 先看全貌自己掌节奏; 代价是诚实的: 课与课之间
   *  不再互相学习, 探针教义仍适用但降级为"备课时只有开课前信息"。
   *  可选——未谈这一问的合约留空, 不强加默认写入。 */
  prep_rhythm?: 'per_lesson' | 'batch';
  /** update_contract_cadence 修约时自动盖章的时间戳(ISO)——teaching_contracts
   *  没有 revision/history 表(version 列是历史遗留, 从未被真实写路径 bump
   *  过), 这是"修约留痕"退而求其次的落点。propose_contract 首次立约写入时
   *  不设这个键。 */
  updated_at?: string;
}

// Reminder channels (same union as in reminder.ts, duplicated here to
// avoid the cyclic import; checked at build time via tests).
export type ContractReminderChannel = 'in_app' | 'push' | 'ical' | 'email';
export type ContractReminderType =
  | 'lesson_due'
  | 'review_due'
  | 'feedback_invitation';

// State machine (Stage 5, 2026-06-29, per GENERATE-FLOW-BRIEF; 'proposed'
// added 2026-07-05 per CONTRACT-NATIVE-INTAKE-BRIEF §1.1).
//
// (2026-07-11): the outline/generate pipeline
// (outlining → outline_ready → generating/in_progress) was torn down
// 2026-07-11 — there was never a real write path advancing a contract past
// 'established' (see prior investigation), and the pipeline UI it
// belonged to is gone. 'established' is now the contract lifecycle's
// terminal/"done" state in the live state machine:
//
//   proposed → draft → established
//                                 ↘
//                                  failed / cancelled
//
//   proposed      — agent submitted a draft via MCP propose_contract;
//                   awaiting learner signature (Establish) at /contract.
//                   Not yet edited/confirmed by the learner — distinct from
//                   'draft' below, which today's real backend already
//                   stamps once the learner *has* clicked Establish.
//   draft         — pre-Establish (intake conversation in flight); NOTE:
//                   the real backend (routes/write.ts POST /contracts)
//                   currently stamps 'draft' unconditionally on insert, i.e.
//                   in practice this is also where a just-Established
//                   contract sits until a later status flip lands
//                   (2026-07-02) — see apps/web Contract/index.tsx.
//   established   — Establish 后; terminal "done" state (2026-07-11) —
//                   Contract 卡片 visible, no further setup
//                   step exists or is expected in the real backend.
//   outlining, outline_ready, generating, in_progress, ready
//                 — @deprecated (2026-07-11). Belonged to the
//                   outline/generate pipeline, dismantled 2026-07-11; no
//                   real write path ever produced or advanced them (see
//                   prior investigation). Kept only so existing rows written
//                   under the old pipeline (and the wire type) still
//                   type-check — do not write these from new code, and do
//                   not add a path that advances a contract past
//                   'established'. 'in_progress' was already a legacy
//                   alias of 'generating' before the pipeline itself was
//                   retired.
//   failed / cancelled — terminal
export type ContractSetupStatus =
  | 'proposed'
  | 'draft'
  | 'established'
  /** @deprecated (2026-07-11) — outline pipeline dismantled; no real write path. Legacy data only. */
  | 'outlining'
  /** @deprecated (2026-07-11) — outline pipeline dismantled; no real write path. Legacy data only. */
  | 'outline_ready'
  /** @deprecated (2026-07-11) — legacy alias of 'generating', outline pipeline dismantled; no real write path. Legacy data only. */
  | 'in_progress'
  /** @deprecated (2026-07-11) — outline pipeline dismantled; no real write path. Legacy data only. */
  | 'generating'
  /** @deprecated (2026-07-11) — retired; 'established' is now terminal. No real write path ever reached this. Legacy data only. */
  | 'ready'
  | 'failed'
  | 'cancelled';

export interface ContractSetupStep {
  name: string;
  // e.g. "parse_goal" / "read_materials" / "select_skill" /
  //      "draft_lesson_1" / "gen_flashcards" / "write_exercises" /
  //      "sketch_mindmap" / "verify"
  status: 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';
  started_at?: string;
  duration_ms?: number;
  error?: string;
}

/**
 * Skill stack frozen onto a contract at Establish time.
 *
 * The MCP server computes this from the contract's preferences
 * (goal keyword → domain, content_modality → modality, intensity →
 * intensity, preferred_time_of_day → pace) and stores it on the contract
 * record. Once frozen, the agent's GetPrompt('_stack') resolves against
 * this snapshot — preference edits don't silently mutate an in-flight
 * teaching contract.
 *
 * Stage 6a (2026-06-29).
 */
export interface SkillRef {
  /**
   * Stack layout: [workflow, ...conditional facets, verify].
   * - `workflow`: unconditional first; orchestrator that tells the agent
   *   how the rest of the stack composes. See
   *   `skills/workflow/lesson-prep.md`.
   * - `domain` / `modality` / `intensity` / `tone` / `pace`: conditional
   *   facets selected from the contract's preferences.
   * - `verify`: unconditional last; quality gate, see
   *   `skills/verify/content-verify.md`.
   */
  category:
    | 'workflow'
    | 'domain'
    | 'modality'
    | 'intensity'
    | 'tone'
    | 'pace'
    | 'verify';
  name: string;
}

export interface TeachingContract {
  id: ContractId;
  pair_id: PairId;
  version: number;
  goal: string;
  time_range: { start: string; end_target?: string };
  success_criteria: string[];
  agent_read_scopes: string[]; // resource URIs the agent is allowed to read
  agent_write_scopes: string[]; // tool names the agent is allowed to invoke
  feedback_tone: FeedbackTone;
  human_approval_required: string[]; // event_types that require explicit user approval
  forbidden_observations: string[]; // categories the agent must not record
  // 迁移 0030: active 列拆除 (退休列) — 唯一写点是 propose_contract
  // 写死 false, 从未被任何真实读路径消费; "当前合约"选择早已改用 setup_status
  // (server helper: apps/server/src/lib/currentContract.ts)。
  /**
   * 迁移 0027 (Void, not delete — 审计留痕). voided = `voided_at` set.
   * `void_reason` carries the void reason verbatim. Both undefined/null =
   * never voided. See apps/server/src/lib/currentContract.ts's
   * isCurrentEligible — voided_at is the signal excluding a contract from
   * "current contract" selection.
   */
  voided_at?: string;
  void_reason?: string;
  created_at: string;
  updated_at: string;

  // ----- round 2 新增: 偏好 -----
  intensity: ContractIntensity;
  interaction_mode: ContractInteractionMode;
  content_modality: ContractContentModality;
  weekly_capacity_hours?: number;
  preferred_time_of_day?: PreferredTimeOfDay[];
  /** Stage 3 加入 — 节奏频次 (Class B 观察推导). Optional 兼容旧数据. */
  pace?: ContractPace;
  /** Contract 2.0 加入 — 定时/碎片化节奏条款, 见 ContractCadence
   *  文档注释。可空——未谈节奏条款的合同留 null。 */
  cadence?: ContractCadence;

  // ----- round 2 新增: 提醒 -----
  accepts_reminders: boolean;
  reminder_channels?: ContractReminderChannel[];
  reminder_types?: ContractReminderType[];
  do_not_disturb?: { start: string; end: string }; // "22:00" "07:00"
  ical_subscription_url?: string;

  // ----- round 2 新增: 备课进度 -----
  setup_status: ContractSetupStatus;
  setup_started_at?: string;
  setup_completed_at?: string;
  setup_steps?: ContractSetupStep[];

  /** Stage 6a 加入 — Establish 时 freeze 的 skill workflow snapshot. */
  skill_stack?: SkillRef[];

  /** Stage 6b 加入 — Course generated at outline time (GENERATE-FLOW-BRIEF).
   * Plain string to avoid circular type import with content.ts; cast to
   * CourseId at consumer sites if needed. */
  course_id?: string;

  // ----- 迁移 0030 (State 2.0): 合约完成态 (文书三幕剧: 立约 → 履约 → 结业) -----
  /** 这份合约名下实际教过的课程清单 (course_id 数组) — 结业时回望"这份合约
   *  到底教了什么"的证据, 不是许可范围声明。 */
  covered_course_ids: string[];
  /** undefined/null = 未结业。establish(签约)/void(作废, 迁移 0027) 之外的
   *  第三种终态, 与作废并列而非互斥的"善终"通道。 */
  completed_at?: string;
  /** 结业词 — 结业那一刻留的一句话, 可空(只有真正结业的合约才写)。 */
  completion_note?: string;
}
