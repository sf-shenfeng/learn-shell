-- Confidence 主权立法 (学习者裁决版) — 三档把握度按钮的词义映射锚值下放给
-- 学习者本人。之前锚值是代码里的死常量 (guess/likely/certain →
-- 35/65/90), "很稳" 被系统悄悄打成 90 分——这是一次不诚实的映射，不是学习者
-- 认领的数字。这张迁移只做一件事: 给 learner_agent_pairs 加一列可调锚值,
-- 默认换成词义诚实的 40/70/100 (低于旧默认的 35/65/90 ——两组值都保留在各自
-- 历史行里，互不覆写: exercise_submissions.confidence_pct /
-- simulated_quiz_attempts.answers[].confidence_pct 是已写入的历史事实，本迁移
-- 不touch它们一行——这些字段自 0016 起就与 confidence(序数) 同批写入，从未
-- 存在过"只有数字没有序数"的历史脏数据，不需要反推迁移。

ALTER TABLE "learner_agent_pairs"
  ADD COLUMN IF NOT EXISTS "confidence_anchor_pct" jsonb
  DEFAULT '{"guess":40,"likely":70,"certain":100}'::jsonb NOT NULL;
