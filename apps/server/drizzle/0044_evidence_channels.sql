-- 迁移 0044: 证据链三通道 + 语言合同 + Live 回答断链修复 (2026-07-24)。
--
-- 一次迁移四件事 (///成套):
--
-- 1. 三通道制 (/) — live_session_evaluations / post_lesson_evaluations
--    各加两列: learner_note (学习者可见人话, 语言随 learners.locale) 与
--    evidence_refs (机器引用数组 jsonb)。既有 agent_observation 定位为教师
--    内账——一次判决三种呈现, 不算复判。两列可空: 存量行与未分层的写入是
--    "没写", 不是空字符串; 不回填 (诚实原则, 同 0035/0040)。evidence_refs
--    的 id 真实性+归属校验在写入口 (lib/evidence-refs.ts), 不设 DB 约束
--    (jsonb 数组无外键可言, 同 evidence_event_ids 的既有姿态——但代码层闸门
--    从本批起是硬的)。
--
-- 2. 语言合同 — learners.locale 提级为实体列。此前只住在
--    preferences->>'locale' (jsonb) 里, 无法被 brief/评估语言合同引用为
--    第一等公民。回填自 preferences (空串折 NULL——没表达过就是没表达过);
--    新写入双写 (列为真相源, preferences 保形状兼容)。
--
-- 3. Live 回答断链 — exercise_submissions.live_response_id: 提交可
--    引用一条 Live 回答 (teaching_responses.id)。可空, 不加 FK (跨前缀 id
--    只按字符串存, 同 bridge_delivery_cursors/acked_message_id 风格);
--    存在性+同 pair 归属在写入口校验。不回填——历史提交没有这份引用是事实。
--
-- additive + idempotent: IF NOT EXISTS 使重复执行安全; UPDATE 只补 NULL 行。
ALTER TABLE "live_session_evaluations" ADD COLUMN IF NOT EXISTS "learner_note" text;
ALTER TABLE "live_session_evaluations" ADD COLUMN IF NOT EXISTS "evidence_refs" jsonb;
ALTER TABLE "post_lesson_evaluations" ADD COLUMN IF NOT EXISTS "learner_note" text;
ALTER TABLE "post_lesson_evaluations" ADD COLUMN IF NOT EXISTS "evidence_refs" jsonb;
ALTER TABLE "learners" ADD COLUMN IF NOT EXISTS "locale" text;
UPDATE "learners" SET "locale" = NULLIF(trim("preferences"->>'locale'), '') WHERE "locale" IS NULL;
ALTER TABLE "exercise_submissions" ADD COLUMN IF NOT EXISTS "live_response_id" text;
