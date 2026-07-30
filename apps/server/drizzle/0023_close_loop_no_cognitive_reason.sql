-- 空转防护 check ② — lesson_progress 加 no_cognitive_update_reason 列。
--
-- close_lesson_loop 关课时, 若本课既无 post_lesson_evaluation 也无指向真实假设
-- 的 hypothesis_update 回执, 老师须显式声明"本课无认知更新及原因"。回执 kind 是
-- 封闭七枚举(lesson_loop_receipts_kind_check, 加不了第八种), 故该理由落在关课
-- 记录行 lesson_progress 上。可空——只有走逃生舱的关课才写。
ALTER TABLE "lesson_progress" ADD COLUMN IF NOT EXISTS "no_cognitive_update_reason" text;
