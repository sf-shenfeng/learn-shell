-- State 2.0 schema 地基 — 四件事: 拆僵尸列 / 评估拆分 / 合约
-- 完成态 / 修订已读回执。逐节对应侦察报告 + 设计稿 §9.1/9.2 规格, 见本迁移同批
-- 报告的改动清单逐一列明。

-- ============================================================================
-- A. 拆僵尸列 (侦察实证: 全部无有效写点或读点, 生产数据全默认值)
-- ============================================================================

-- lessons.status: 75 行全 null, 从未被真实写路径写过 (add_lesson/update_lesson
-- 都不碰它) —— 且与 lesson_progress.state 撞名, 是 B 病根本身 (两张表两个
-- 真相源, 字段名字撞了车; 见 lib/context-brief.ts buildRecentLessons 头注)。
ALTER TABLE "lessons" DROP COLUMN IF EXISTS "status";
--> statement-breakpoint
-- lessons.needs_review: 未接线 —— verify_prep/publish_lesson 的红黄绿判定
-- 现算于 validate-prep-core.ts 的 checks 数组, 从不回写这一列。
ALTER TABLE "lessons" DROP COLUMN IF EXISTS "needs_review";
--> statement-breakpoint
-- courses.review_status: 无读点 —— 仅 seed.ts 写死一个演示值, 没有任何真实
-- 消费方读它做判断。
ALTER TABLE "courses" DROP COLUMN IF EXISTS "review_status";
--> statement-breakpoint
-- teaching_contracts.active: -B 退休列 —— 唯一写点是 propose_contract
-- 写死 false, 真正驱动"当前合约"选择的信号早已是 setup_status (见
-- lib/currentContract.ts 头注)。voided_at/void_reason(迁移 0027) 才是作废轴,
-- 与这列无关, 原样保留。
ALTER TABLE "teaching_contracts" DROP COLUMN IF EXISTS "active";

-- ============================================================================
-- B. 评估拆分 (设计稿 §9.1/9.2) —— 一场 live session 一份现场评估, 一节课一份总评
-- ============================================================================

-- live_session_evaluations: 现场评估, 挂在单场 live_session 上 —— 与课级总评
-- (post_lesson_evaluations) 分层, 一课可能横跨多场 live session, 每场各自的
-- 现场观察不该被课级总评摊平掉。唯一索引 (live_session_id): 一场一评, 不许
-- 同一场重复写。pair_id 冗余存一份(便于按 pair 直接查, 不必每次 join
-- live_sessions), 但按规格不建 FK —— 真正的引用完整性锚点是 live_session_id。
CREATE TABLE IF NOT EXISTS "live_session_evaluations" (
	"id" text PRIMARY KEY NOT NULL,
	"pair_id" text NOT NULL,
	"live_session_id" text NOT NULL,
	"concepts_touched" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"live_turns_count" integer,
	"duration_minutes" integer,
	"agent_observation" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "live_session_evaluations" ADD CONSTRAINT "live_session_evaluations_live_session_id_live_sessions_id_fk" FOREIGN KEY ("live_session_id") REFERENCES "public"."live_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "live_session_evaluations_live_session_id_uniq"
  ON "live_session_evaluations" ("live_session_id");
--> statement-breakpoint
-- post_lesson_evaluations.session_id → learning_session_id: 名实相符 —— 这列
-- 的 FK 本就指向 learning_sessions(见 0000 建表时的
-- post_lesson_evaluations_session_id_learning_sessions_id_fk 约束), 只是列名
-- 沿用了泛化的 "session_id", 现在评估拆成两层(live 现场 / 课级总评)之后容易
-- 和 live_session_id 混淆, 借这次迁移把名字改准。FK 约束本身不动(仍是
-- 那个旧名字的约束, 只是它引用的列改了名 —— PG 层面约束自动跟着列走)。
ALTER TABLE "post_lesson_evaluations" RENAME COLUMN "session_id" TO "learning_session_id";
--> statement-breakpoint
-- 一课一总评: 加唯一索引 (pair_id, lesson_id)。生产仅 1 行, 且该行
-- learning_session_id 为 null, 不存在需要回填的冲突行, 无需去重脚本。
CREATE UNIQUE INDEX IF NOT EXISTS "post_lesson_evaluations_pair_lesson_uniq"
  ON "post_lesson_evaluations" ("pair_id", "lesson_id");

-- ============================================================================
-- C. 合约完成态 (文书三幕剧: 立约 → 履约 → 结业)
-- ============================================================================

-- covered_course_ids: 这份合约名下实际教过的课程清单 (course_id 数组) ——
-- 结业时回望"这份合约到底教了什么"的证据, 不是许可范围声明。
ALTER TABLE "teaching_contracts" ADD COLUMN IF NOT EXISTS "covered_course_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
-- completed_at: null = 未结业。这是合约生命周期的第三幕 —— establish(签约)/
-- void(作废, 迁移 0027) 之外的第三种终态, 与作废并列而非互斥的"善终"通道。
ALTER TABLE "teaching_contracts" ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;
--> statement-breakpoint
-- completion_note: 结业词 —— 结业那一刻留的一句话, 可空(只有真正结业的合约才写)。
ALTER TABLE "teaching_contracts" ADD COLUMN IF NOT EXISTS "completion_note" text;

-- ============================================================================
-- D. 修订已读回执 (服务端真相, 替换 web localStorage)
-- ============================================================================

-- lesson_revision_seen: "这个学习者把这节课读到第几版了" 的服务端真相 ——
-- 此前这个状态活在 web 端 localStorage 里, 换设备/清缓存就丢, 也没法在
-- get_context/教师端读到"学习者是不是还没看过我刚改的这版"。upsert 更新
-- revision + seen_at, 唯一索引 (pair_id, lesson_id) 是这行"已读到第几版"的
-- 落点。
CREATE TABLE IF NOT EXISTS "lesson_revision_seen" (
	"id" text PRIMARY KEY NOT NULL,
	"pair_id" text NOT NULL,
	"lesson_id" text NOT NULL,
	"revision" integer NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lesson_revision_seen" ADD CONSTRAINT "lesson_revision_seen_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lesson_revision_seen_pair_lesson_uniq"
  ON "lesson_revision_seen" ("pair_id", "lesson_id");
