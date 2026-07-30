-- Live 2.0 引擎: 服务端 delivery cursor (桥事件从"客户端本地
-- seen-cache 单机补丁"升级为"服务端按 (pair_id, consumer_id) 持久化断点续传")。
--
-- 语义 (完整版见 src/lib/live-wait.ts 头注):
--   - 一行 = 一个消费者 (pair_id, consumer_id) 在事件流上的"已确认到哪"。
--   - 消费者可以是多个 (同一 pair 下 live-watch.py 常驻进程 / 临时 MCP 会话
--     各自独立追更), 所以是 consumer 维度而非 pair 维度单行。
--   - 推进语义是隐式确认: 下一次 GET /bridge/wait?consumer_id=X&since=Y 到达
--     时, 服务端在开始等待前先把 Y upsert 成这一行的 cursor_event_id —— "带新
--     游标来"本身就是"我已经处理完上一批"的确认, 不新增独立 ack 端点。真正的
--     "先送达后推进"发生在调用方那一侧 (处理完了才带着新 since 来敲下一次
--     wait), 服务端这行 upsert 只是把那次确认落盘, 不在事件*送达*的那次调用
--     里就提前推进 (未携带 since 的 wait 调用只读游标, 不写)。
--   - consumer_id 调用方自铸、服务端不校验语义 (同 ad_hoc_messages.
--     client_message_id 的既定风格) —— 没有单独的 consumer 注册表, 也不加
--     FK 约束在 consumer_id 上。
--   - 兼容: 不带 consumer_id 的老调用方 (仍在跑旧版 live-watch.py 的客户端)
--     完全不触碰这张表 —— 路由层只在请求带 consumer_id 时才读写它, 行为对
--     老调用方零变化 (见 routes/teaching.ts /bridge/wait 的同批改动)。
--
-- 保留策略: 不设 TTL/清理任务。这张表按 pair×consumer 基数增长, 不是按事件数
-- 增长 (每个 consumer 恒定一行, upsert 覆写), 在这个应用的单学习者规模下体量
-- 可忽略, 同 idempotency_keys 表现存的"不清理, 体量不是问题"判断一致。
CREATE TABLE IF NOT EXISTS "bridge_delivery_cursors" (
  "id" text PRIMARY KEY NOT NULL,
  "pair_id" text NOT NULL REFERENCES "learner_agent_pairs"("id") ON DELETE CASCADE,
  "consumer_id" text NOT NULL,
  "cursor_event_id" text NOT NULL DEFAULT '',
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bridge_delivery_cursors_pair_consumer_uniq"
  ON "bridge_delivery_cursors" ("pair_id", "consumer_id");
