<!-- recipe_version: 5097fe00b42e · generated_at: 2026-07-28 · canonical: recipe://first-contract-and-lesson.reference -->
本册是 first-contract-and-lesson 的参考卷:事故史/设计解释/示例。执行规则以 quick 卷为准。

## 2. 等待学习者签字 —— 为什么没有 push 通知

"学生递了拜师帖，老师靠翻库才发现"——这是产品哲学级已知缺口，
不在本批修，说明了为什么这里没有 push 通知机制，agent 只能靠轮询
`get_context`/`get_teacher_inbox` 或学习者当面告知这三条路自己恢复状态。

## 4. `add_lesson` —— course_id 错误分类三代沿革(历史记录,仅供追溯)

现状（2026-07-12 起定案）：`add_lesson` 与
`add_concept`/`add_mindmap_seed` 一样**写入前先查存在性**——course_id 错了
返回 `code: VALIDATION`（`course_id 'xxx' 不存在`），不撞库。`add_simulated_quiz`
同病同治，同一批修上。走到这一步之前有过两代旧貌：

- **一代（早期版本）**：没有预检，course_id 直接撞数据库外键约束，被外层
  统一 catch 包成 `code: "RETRYABLE"` + `recovery_hint: "Unexpected server
  error — retry..."`——对确定性失败的误分类，把新 agent 送进过六连重试。
- **二代（修复版本）**：`tool-envelope.ts` 把 `23503
  foreign_key_violation` 映射到 `NOT_FOUND`——分类诚实了，但仍是"先撞库
  再分类"，message 是裸 Postgres 报错。
- **三代（现状）**：预检风格追补到 `add_lesson`，错误发生在任何写
  之前，message 直接指路。

## 1½. 自带教材 —— 为什么 LS 不建文件解析器（设计缘由）

产品裁决（2026-07-22）：自带教材场景里 LS **不做任何 EPUB/PDF 解析**。三条理由：

- **解析器是无底洞**——版式、扫描件、DRM、公式排版，每一样都是长期维护负担，而 agent 的宿主环境本来就会读文件，重复建设且注定更差；
- **拆解本来就是教学动作**——"这本书该切成几课、每章的精要是什么"是老师的判断，不是格式转换；机器切章出来的骨架没有教学观点；
- **合同是文书不是引擎**——`source_material` 字段只记谈定的条款（书名/作者/年份/依赖档位），行为语义全部住 recipes/skills；引擎化（按字段自动改变服务端行为）会把谈判条款变成配置开关，学习者失去"条款是谈出来的"这层含义。

依赖档位三档的数字（100%/~80%/~60%）是意向刻度，不是可计量的合规指标——档位真正约束的是结构权（目录顺序谁说了算）与外延权（每课能不能超出书）。

引源分家制的立法理由，原话：**当书和 agent 的知识打架时，学习者有权知道自己正在信的是谁。**标记选加粗前缀 `**外延**`（纯文本面用 `外延:`）而不是新造 `:::` 块，是刻意的轻——LESSON-BLOCKS 的块目录不为它扩张，渲染器零改动，标记本身也不打断阅读。书内内容不加标：在 strict/anchored 档下书是默认声部，逐句标"书说"会把课文变成脚注沼泽。

## 7. `add_exercise` × N —— 预检沿革(历史记录,已过时,仅供追溯)

这段曾经写着"同 add_lesson，没有存在性预检，撞 FK 后落进 `code: RETRYABLE`"
——那是修复（`tool-envelope.ts` 把 `23503 foreign_key_violation`
映射到 `NOT_FOUND`）之前的旧账。后续这批之后 `add_exercise` 不再撞库，直接
写入前 `VALIDATION`；`add_lesson` 的 `course_id` 预检当时没赶上这批，2026-07-12
另批补上（见上一节三代沿革）——如今两个工具同款，都是写入前 `VALIDATION`。

🖤
