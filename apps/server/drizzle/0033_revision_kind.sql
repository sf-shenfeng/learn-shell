-- 迁移 0033: lesson_revisions 加 kind 列 (双轨修订 —— 学习者
-- 只该看见"因她的学习而改"的修订; 工程性修订(格式/门禁/重构/错别字)入库
-- 留痕但对学习者隐身)。kind = 'teaching' | 'technical', 缺省 'teaching' ——
-- 发布后的修订默认面向学习者, 宁可多呈现不可偷藏(见 mcp/server.ts
-- update_lesson 的 revision_kind 参数, 同一判据: "这次改动是她教出来的,
-- 还是机器逼出来的? 前者 teaching, 后者 technical")。CHECK 约束收口同
-- 0028 move_type / lesson_patches.kind 的先例 —— 校验代码可能被绕过
-- (未来新写入路径/直连 db 的脚本), DB 层这道硬闸才是真正兜底。
--
-- 回填: 备课期(首次发布前, lessons.published_at is null)的修订学习者从未
-- 见过旧版 —— 那是天然的后厨事务, 不管当时录入的理由写的是什么, 一律判
-- technical。同理, 理论上不该出现但作为近似规则兜底 —— 某条修订的时间戳
-- 早于该课首次发布时间(revised_at < published_at)的也一并计入 technical
-- (发布前的时间戳一律隐身)。这是一条近似规则、不是逐行精确溯源: kind
-- 参数上线之前落库的存量行没有人工判据可考, 只能按"是不是备课期"这道粗
-- 粒度规则回填; kind 参数上线之后的新修订才有精确的调用方人工判据(mcp/
-- server.ts update_lesson 的 revision_kind 参数)。
ALTER TABLE "lesson_revisions" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'teaching';
--> statement-breakpoint
ALTER TABLE "lesson_revisions" DROP CONSTRAINT IF EXISTS "lesson_revisions_kind_check";
--> statement-breakpoint
ALTER TABLE "lesson_revisions" ADD CONSTRAINT "lesson_revisions_kind_check" CHECK (
  "lesson_revisions"."kind" IN ('teaching', 'technical')
);
--> statement-breakpoint
UPDATE "lesson_revisions" r
SET "kind" = 'technical'
FROM "lessons" l
WHERE r."lesson_id" = l."id"
  AND (l."published_at" IS NULL OR r."revised_at" < l."published_at");
