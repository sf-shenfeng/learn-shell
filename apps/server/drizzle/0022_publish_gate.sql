-- Publish Gate — lessons 加 published_at 上架闸列 + 回填。
--
-- 回填现实说明: lessons 表没有 created_at 列(schema/content.ts 现实——只有
-- courses/flashcards 有), 故立项案文的 "published_at = created_at" 无法直译。
-- 服从现实: 用该课所属 course 的 created_at 作代理时间戳回填, 保证 52 节在架
-- 课全部非空(= 已发布), 学习者书架无缝不变空。新建 lesson (add_lesson) 走
-- DEFAULT NULL = 草稿态, 不受此回填影响(回填只在迁移时刻一次性作用于存量行)。
ALTER TABLE "lessons" ADD COLUMN IF NOT EXISTS "published_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "lessons"
SET "published_at" = "courses"."created_at"
FROM "courses"
WHERE "lessons"."course_id" = "courses"."id"
  AND "lessons"."published_at" IS NULL;
