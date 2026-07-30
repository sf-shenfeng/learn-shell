<!-- recipe_version: 06a20270f0bd · generated_at: 2026-07-28 · canonical: recipe://grade-attribute-revise.reference -->
本册是 grade-attribute-revise 的参考卷:事故史/设计解释/示例。执行规则以 quick 卷为准。

## 3. `grade_exercise` —— 机制细节与用法示例

批改+追加 `exercise.graded` session event 现在是同一个数据库事务（不会出现
"提交状态改了，但没留下 event" 的半成品）。

**一条已作废的旧例**：这里曾把 `update_lesson.evidence` 写成
"sub_xxx 作业二 Prepaid 方向错 + hyp_xxx" 当范例。那种写法现在不许用——
该字段是学习者在修订病历本里读得到的散文，且没有配套的 `evidence_refs`
通道，内部 id 写进去接不住。同一句证据的正确写法是
"作业二里 Prepaid 的方向连错两次"。留下这条旧账是为了让照抄过它的老师
认得出自己抄的是哪一条。

## 5. `reflect_on_teaching` —— schema 收紧史

这是 Agent Surface Hardening 这批施工里被收紧过 schema 的工具——七个字段全部服务端强校验，是这批施工把它从
"靠 agent 自觉写好文章"收紧成结构化校验的。

## 5. `reflect_on_teaching` —— `action_link.ref_id` 回填链路补齐史

`update_lesson` 的回执直接给 `created_refs.lesson_revision_id`，可以原样填进
`reflect_on_teaching` 的 `action_link.ref_id`（`material_flaw` 路径）——这是
这次 envelope 升级顺带解决的一个真实缺口：以前 `update_lesson` 的返回文本里
没有这个 id，只能凭空对不上。

## 6. `update_lesson` —— 写入机制细节

旧版全文快照 + 版本号 `revision` +1 是同一个数据库事务，不会出现"快照写了
正文没更新"或反过来的半成品。

🖤
