-- 迁移 0041: learner_hypotheses.last_evidence_at — 假设生命周期规模化 (2026-07-23)。
--
-- 背景: 假设账本只进不出——写入后没有任何证据续期通道, 三个月前的观察和
-- 昨天的观察在简报里同等新鲜。裁决: 没有证据喂养的假设会"读作陈旧"——
-- 但陈旧只在读取时现算 (lib/hypothesis-lifecycle.ts 的阈值常量), 永不落库、
-- 永不自动退役; 事实只当扳机, 判决仍归老师 (retire/revise) 与学习者
-- (confirm/reject/freeze, 主权判决压倒一切)。
--
-- 这一列是唯一的新账: 最近一次证据喂养的时刻。写入方:
--   · record_learner_hypothesis 创建路径 — 写入当下;
--   · reinforce 动作 — 续期到当下 (可附带追加 evidence_event_ids);
--   · revise 动作 — 新行 (超越旧文本) 写入当下。
-- 证据计数不另立列——evidence_event_ids 数组长度即计数, 可导出的不落冗余账。
--
-- 回填 = created_at: 存量行没有喂养史, "出生时刻"是它们最诚实的最近证据
-- 时刻 (同 0035/0038/0040 的诚实原则——不虚构比事实更新鲜的时间戳)。
-- additive + idempotent: IF NOT EXISTS 使重复执行安全; UPDATE 只补 NULL 行;
-- 回填后收紧 NOT NULL + DEFAULT now (新行不写也不至于空账)。
ALTER TABLE "learner_hypotheses" ADD COLUMN IF NOT EXISTS "last_evidence_at" timestamptz;
UPDATE "learner_hypotheses" SET "last_evidence_at" = "created_at" WHERE "last_evidence_at" IS NULL;
ALTER TABLE "learner_hypotheses" ALTER COLUMN "last_evidence_at" SET NOT NULL;
ALTER TABLE "learner_hypotheses" ALTER COLUMN "last_evidence_at" SET DEFAULT now();
