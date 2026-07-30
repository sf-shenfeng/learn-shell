-- move_type 白名单收口 (任务瘦身版 —— 原规格里的传输层回执
-- 列 (delivered_at/teacher_seen_at) 整块取消, 这次迁移只剩这一件事).
--
-- teaching_moves.move_type 此前是裸 text, 无 DB 级约束——mcp/server.ts 的
-- live_message_send 只在 TS 层做 `as MoveType` 类型断言, 放行任意字符串
-- 落库 (含历史上老师手动发的 ACK move 当"在场确认"用; bench 库有 10 行占用
-- 正式 seq, prod 0 行, 见验尸报告)。这次同批给 live_message_send 补运行时
-- 白名单校验的同时, DB 层补一道硬闸做双保险——校验代码是可能被绕过的
-- (未来新写入路径 / 直连 db 的脚本), CHECK 才是真正兜底、不依赖调用方
-- 老实的那道门。
--
-- NOT VALID: 只管这条约束生效之后的新增/更新行, 不回填校验存量行。bench
-- 库那 10 行历史 ACK move 是既定事实 (记录在案, 明确不清理——ACK 的
-- 根因是 recipe 里的义务条款, 不是数据卫生问题), 若不加 NOT VALID,
-- ALTER TABLE ADD CONSTRAINT 会先扫全表拿这 10 行历史行做校验, 当场判它们
-- 违规、迁移直接失败。NOT VALID 让存量行免检, 历史包袱留在原地, 新账从
-- 这条迁移生效那一刻起干净。
ALTER TABLE "teaching_moves" DROP CONSTRAINT IF EXISTS "teaching_moves_move_type_check";
--> statement-breakpoint
ALTER TABLE "teaching_moves" ADD CONSTRAINT "teaching_moves_move_type_check" CHECK (
  "teaching_moves"."move_type" IN ('FRAME', 'ASK', 'EXPLAIN', 'PROBE', 'HINT', 'CHALLENGE', 'REFLECT')
) NOT VALID;
