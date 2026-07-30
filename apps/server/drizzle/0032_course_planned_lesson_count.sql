-- 计划节数 (学习者钦定设计, 2026-07-19) — courses 加一列 planned_lesson_count:
-- 建课时学习者被问的第一问"一共几节", 落这里。null = 未定 (旧课兼容——0032
-- 之前建的课全部回填 null, 不强行倒推一个假节数); 非空时是 ready_to_complete
-- 判定 (lib/course-completion.ts evaluateCourseCompletion / 详见 context-brief.ts
-- buildContractProgressLines + mcp/server.ts complete_contract 前置校验③) 的
-- 一道新门槛: 已发布节数须 ≥ 这个数, 课才算"完成"。这里不加 CHECK 约束——
-- 正整数校验在 mcp/server.ts 的 create_course 参数校验层做, 列本身只管"有没有
-- 定过".

ALTER TABLE "courses" ADD COLUMN IF NOT EXISTS "planned_lesson_count" integer;
