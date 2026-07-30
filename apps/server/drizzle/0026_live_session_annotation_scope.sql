-- 批注第三种作用域 — lesson_annotations 加 live_session_id,
-- 与既有 lesson_id/document_id 并列。live 会话记录 (MoveStream 只读回放) 上的
-- 批注按 move 定位, 约定 page_index = 该 move 的 seq (web 端另一工人负责挂
-- 批注层, 这里只管服务端持久化)。
--
-- 服从现实条款: brief 原文要求 lesson_id/document_id/live_session_id "恰好一个
-- 非空", 但这张表已有批E自由笔记合法持有三者全 null (src/db/schema/annotation.ts
-- 批E注记), 收紧到"恰好一个"会当场判自由笔记违规。这里延续 0017 建的
-- lesson_annotations_host_exclusive 语义, 把两列的互斥门槛原样扩成三列的
-- "至多一个非空"(0 = 自由笔记, 1 = 三种宿主之一, ≥2 违规) —— CHECK 仍是实际
-- 生效的那道闸, 不只是约定。
--
-- 不加外键 (与 0024/0025 同风格, 不追加硬约束; live_sessions 表已存在但这次
-- 新列刻意不 references 它)。可空。
ALTER TABLE "lesson_annotations" ADD COLUMN IF NOT EXISTS "live_session_id" text;
--> statement-breakpoint
ALTER TABLE "lesson_annotations" DROP CONSTRAINT IF EXISTS "lesson_annotations_host_exclusive";
--> statement-breakpoint
ALTER TABLE "lesson_annotations" ADD CONSTRAINT "lesson_annotations_host_exclusive" CHECK (
  (
    (CASE WHEN "lesson_annotations"."lesson_id" IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN "lesson_annotations"."document_id" IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN "lesson_annotations"."live_session_id" IS NOT NULL THEN 1 ELSE 0 END)
  ) <= 1
);
