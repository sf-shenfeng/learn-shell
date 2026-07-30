-- 迁移 0038: learner_feedback 改造为"现场反馈笔"底座 (2026-07-22)。
--
-- 背景: learner_feedback 是 ritual 时代的周反馈表 (week_of + 四个 1-5 评分),
-- 从 seed 起只有仪式性写入路径。产品裁决: 反馈没有专用入口——学习者的
-- 日常消息就是入口, agent 在正常对话里识别 issue/idea 并落账。本迁移把这张
-- 表改造成事件式反馈账本: 一条反馈 = 她的原话 (逐字, 不许老师转述) + 挂锚
-- (哪节课/哪场 Live/哪道题/哪条消息) + 生命周期 (open → acknowledged →
-- addressed/declined)。
--
-- 软牙齿 (裁决 b): open 反馈只在 get_teacher_inbox 里发光提示, 永不阻塞
-- close_lesson_loop —— 本迁移不加任何供闭环 guard 消费的列, 这是有意的。
--
-- 挂锚列不建 FK —— 照本仓跨前缀 id 先例 (0035 reflection_anchor / 0029
-- bridge_delivery_cursors): 存在性 + 同 pair 校验在代码层做 (mcp/server.ts
-- record_learner_feedback), 不靠 DB 约束兜底。source_message_ref 是自由文本
-- 引用 (live 消息可能活在 bridge 事件流里, 没有稳定的单表 id 可指), 连
-- 代码层存在性校验都不做, 只存。
--
-- kind/status 的 CHECK 收口同 0033 revision_kind / 0028 move_type 先例——
-- 校验代码可能被绕过 (未来新写入路径/直连 db 的脚本), DB 层这道硬闸才是
-- 真正兜底。status_note 是老师的判词 (addressed/declined 时的说明——拒绝
-- 必须给理由, 拒绝的判词保护接受的价值; 代码层强制, 见 update_feedback_status)。
--
-- contract_id 放开 NOT NULL: ritual 时代每条周反馈都挂合同, 的现场
-- 反馈不必——她随口说的一句"这个 quiz 按钮反了"不欠任何合同一个归属。
-- 存量行 (seed 的那条周反馈) 各自保留原值, 不动。
--
-- 回填: kind 缺省 'issue' / status 缺省 'open' 对存量行同样成立——ritual
-- 周反馈里的 free_text 本来就是"她提出的问题/想法", 按 issue+open 归档
-- 不失真; 挂锚列存量行保持 NULL (锚点语义自本迁移起才存在, 同 0035 的
-- 诚实原则, 不编造假锚点)。
ALTER TABLE "learner_feedback" ADD COLUMN IF NOT EXISTS "lesson_id" text;
--> statement-breakpoint
ALTER TABLE "learner_feedback" ADD COLUMN IF NOT EXISTS "live_session_id" text;
--> statement-breakpoint
ALTER TABLE "learner_feedback" ADD COLUMN IF NOT EXISTS "exercise_id" text;
--> statement-breakpoint
ALTER TABLE "learner_feedback" ADD COLUMN IF NOT EXISTS "source_message_ref" text;
--> statement-breakpoint
ALTER TABLE "learner_feedback" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'issue';
--> statement-breakpoint
ALTER TABLE "learner_feedback" DROP CONSTRAINT IF EXISTS "learner_feedback_kind_check";
--> statement-breakpoint
ALTER TABLE "learner_feedback" ADD CONSTRAINT "learner_feedback_kind_check" CHECK (
  "learner_feedback"."kind" IN ('issue', 'idea')
);
--> statement-breakpoint
ALTER TABLE "learner_feedback" ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'open';
--> statement-breakpoint
ALTER TABLE "learner_feedback" DROP CONSTRAINT IF EXISTS "learner_feedback_status_check";
--> statement-breakpoint
ALTER TABLE "learner_feedback" ADD CONSTRAINT "learner_feedback_status_check" CHECK (
  "learner_feedback"."status" IN ('open', 'acknowledged', 'addressed', 'declined')
);
--> statement-breakpoint
ALTER TABLE "learner_feedback" ADD COLUMN IF NOT EXISTS "status_note" text;
--> statement-breakpoint
ALTER TABLE "learner_feedback" ADD COLUMN IF NOT EXISTS "status_changed_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "learner_feedback" ALTER COLUMN "contract_id" DROP NOT NULL;
