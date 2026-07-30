<!-- recipe_version: 16c5106480f5 · generated_at: 2026-07-28 · canonical: recipe://resume-teaching -->
# Recipe · 下一课读取记忆续教

> 状态：官方 recipe · Agent Surface Hardening 第一批
> 素材来源：真实 dogfood（2026-07-07 commit `get_context`/`get_learner_brief` 上线；`get_teacher_inbox` 是同批新增的 P1 能力；场景出自"跨 Agent 接棒"的验收）
> 工具名与参数以 `apps/server/src/mcp/server.ts` 当前注册为准

给一个刚刚醒来的 agent——不管是同一个 agent 的新 session，还是完全换了一个 agent（模型、客户端都不同）：怎么不用学习者重新解释一遍，就知道"现在该做什么、上一次学到哪、上一次说好下一步要做什么"。

事故史与设计缘由见 recipe://resume-teaching.reference——reference 版本未变时无需重读。

---

## 前置条件

- 至少已经跑过一轮 [first-contract-and-lesson](./first-contract-and-lesson.md)，有课可续。
- 这三个工具（`get_context`/`get_learner_brief`/`get_teacher_inbox`）都是**只读**、无副作用，随便调、可以轮询，不会写坏任何东西。它们的返回统一走 `{status:'success', operation, human_note, data}` 的结构化回执——真正的内容在 `data` 字段里，`human_note` 只是一句摘要（比如 `"3 inbox item(s) for pair pair_xxx since 1970-01-01T00:00:00.000Z."`），不要试图从 `human_note` 里解析实质信息。

---

## 步骤

### 0. 先 `get_context` —— 醒来第一步永远是它

**这条以 [bootstrap.md](./bootstrap.md) 为正典,本 recipe 向它对齐**:醒来第一动作是 `get_context`,先弄清这个 pair 活在哪个阶段（有没有 pair、有没有现役契约、有没有课在途、上一场 Live 收没收尾）。**状态说了算,不是话说了算**——同一句"接着上次讲"，可能来自上了十节课的老学习者，也可能来自一个契约都还没签的新人。

看完 `get_context`，**确认确实有教学在途**，再往下走第 1 步的待办清单。没有 pair 或没有现役契约时，你要走的是 bootstrap 的分支路，不是收待办。

### 1. `get_teacher_inbox` — 增量教师待办清单（`get_context` 之后的第一刀）

**用途**：比自己拼 `live_pending` + 提交列表 + AdHoc 好几刀更省事的单一入口——直接告诉你"有哪些具体的事等着处理，每件事该调哪个工具"。这是本批新增的 P1 能力。

**前置条件**：`pair_id` 可省（缺省用当前 active pair）；`since` 可省（缺省 = 全量待办，从 epoch 算起）。服务端**不维护游标状态**——`since` 是调用方自己记住的时间戳，下次调用把上次看到的最新 `occurred_at`传回来，不传就是重新看全部积压。

**调用**：`get_teacher_inbox({})` 或 `get_teacher_inbox({ since: "2026-07-09T12:00:00Z" })`

**返回**（`data` 字段内容）：
```json
{
  "pair_id": "pair_xxx",
  "since": "1970-01-01T00:00:00.000Z",
  "generated_at": "2026-07-10T...",
  "items": [
    {
      "item_id": "...",
      "type": "exercise_submitted",
      "priority": "normal",
      "resource_refs": ["sub_xxx", "ex_xxx"],
      "recommended_tool": "grade_exercise",
      "occurred_at": "2026-07-09T..."
    }
  ]
}
```

**`items` 的五种来源类型**（按 `priority` high→low、同优先级按 `occurred_at` 升序排列）。**`priority` 按类型写死，不随内容浮动**——同一类型的每一条永远是同一档，别指望"这份作业更急"会自己升档：

| type | priority | 说明 |
|---|---|---|
| `adhoc_message` | `high` | 学习者发了新的 AdHoc 消息还没回 → `recommended_tool: 'adhoc_message_send'` |
| `again_cluster` | `high` | 近 24 小时同一张闪卡被评 Again ≥ 3 次 → `recommended_tool: 'get_learner_brief'` |
| `exercise_submitted` | `normal` | 待批改的作业提交 → `recommended_tool: 'grade_exercise'` |
| `live_session_needs_reflection` | `normal` | 一场已 `completed` 的 Live，它自己那条 `live_sessions.teacher_reflection` 还是空的 → `recommended_tool: 'live_session_complete'` |
| `contract_proposed` | `low` | 有一份 `propose_contract` 递交了但还没签字（对应 [first-contract-and-lesson](./first-contract-and-lesson.md) 第 2 步"等待学习者签字"） |

`live_session_needs_reflection` **别望文生义**：查的是 Live 场次上的场评字段，**不是** lesson 级的 `reflect_on_teaching` 有没有写。已 `completed` 的场次回填不了这一列；不推进 `since` 游标时这条待办会重复出现，游标越过该场 `ended_at` 后即从增量视图消失。这两件事互不顶替：lesson 级反思缺不缺，看那节课的 `closure_progress.reflection`。

**`item_id` 是确定性的**——同一条底层记录再次出现在待办里会拿到同一个 `item_id`（除非状态真的变了），不会每次轮询都发一个新 id，方便调用方自己判断"这条我处理过了吗"。无待办时 `items` 是空数组，不是错误。

`data` 里另附一段 `open_feedback`（现场反馈笔）：`status=open` 的学习者反馈计数 + 前 5 条摘要。软牙齿——只发光不进 `items[]` 待办节拍，永不阻塞闭环；回应走 `update_feedback_status`（declined 必须带判词）。`since` 游标对它无效，open 就一直亮。

### 2. `get_context` — 一发式冷启动定位

**用途**：想知道"现在这个 pair 处在哪"的整体快照（契约状态、最近的课、脑图池、Live 会话、未读数），和 `get_teacher_inbox` 是互补关系——inbox 给"待办事项"，`get_context` 给"整体处境"。

**前置条件**：`pair_id` 可省；如果传了一个不存在的 `pair_id`，返回 `code: NOT_FOUND`，`message: "Pair {id} not found."`，`details.available_pairs` 是可用 pair 列表（`[{id, active, learner_id}, ...]`）——自愈式错误，直接从 `details` 里取一个可用 id，不用另外查。

**调用**：`get_context({})` 或 `get_context({ pair_id: "pair_xxx" })`

**返回**（`data` 字段内容）：
```json
{
  "pair_id": "pair_xxx",
  "generated_at": "2026-07-10T...",
  "identity": { "...": "..." },
  "active_contracts": [
    { "id": "tc_xxx", "title": "Pass CFA L1", "setup_status": "established", "progress": "lessons: 2/5",
      "source_material": "教材:《Quantitative Investment Analysis》(2020) · anchored(~80%)" }
  ],
  "contract_progress": [
    { "contract_id": "tc_xxx", "goal": "Pass CFA L1", "covered_course_count": 1, "completed_course_count": 0,
      "operationally_caught_up": false, "goal_completion_ready": false }
  ],
  "recent_lessons": [
    { "id": "lsn_xxx", "title": "GDP 三法", "status": "in_progress", "last_activity_at": "2026-07-09T..." }
  ],
  "pending_pool": { "count": 3, "latest_titles": ["...", "...", "..."] },
  "live_session": null,
  "unread_adhoc_count": 0,
  "active_reminder_count": 1,
  "hypotheses_in_book_count": 4,
  "brief_etag": "b3f1c9…"
}
```

**每个字段怎么读**：
- `active_contracts` — **只包含已签字且非终态的契约**（`established`/`outlining`/`outline_ready`/`generating`/`ready`）。`proposed`（学习者还没签）不会出现在这里——如果你刚 `propose_contract` 完就调 `get_context`，这里大概率是空的，不代表出错（这种情况下 `get_teacher_inbox` 会有一条 `contract_proposed`）。`progress` 是一句话摘要：还在备课流程里是 `setup: {status} ({done}/{total} steps)`，进了正式教学阶段是 `lessons: {touched}/{total}`（touched = 有过 PostLessonEvaluation 的课数，不是"存在的课数"）。
- `recent_lessons` — 最多 2 条，**按"最近一次 PostLessonEvaluation"排序**，不是按 lesson 创建顺序。`status` 是教学闭环状态（`not_started`/`in_progress`/`completed_declared`/`closed`，无进度记录时为 `null`），不是内容生成态（那个撞名字段已拆除）。如果这个 pair 从来没上过课（没有任何 PostLessonEvaluation），会退回到"当前契约的 course 里排序最前的 2 节课"作为冷启动兜底。**只给 id/title/status/最后活动时间，不给正文**——正文另外用 REST 或前端读，这个工具刻意 token-frugal。
- `pending_pool` — 脑图待归类卡片池的计数 + 最近 3 个标题，不是全量。
- `live_session` — 最近一次 Live Teaching session 的 id/status/结束时间 + 是否有中途快照（存在性+时间戳），不含快照全文；没有任何 Live session 时是 `null`。
- `unread_adhoc_count` — 上次 agent 回复之后学习者又发了几条新消息（AdHoc 悬浮窗），不是全量未读消息内容。
- `active_reminder_count` — 还没触发也没被 dismiss 的提醒数量。
- `active_contracts[].source_material` — 自带教材条款的一行亮灯（`教材:《书名》(年份) · 依赖档位`）。这份合约没谈教材时是 `null`。开课前廉价看见"这门课跟着哪本书、哪一档教"，不用翻合同。
- `contract_progress` — **结业判定专用的一段，和 `active_contracts[].progress` 那句人话摘要不是一回事**。每份现役合约一条，给 `covered_course_count` / `completed_course_count` 两个计数，外加两个分层的布尔：
  - `operationally_caught_up` — 覆盖单里的课"已发布的都读完了"（覆盖单为空恒 `false`）。**不看** `planned_lesson_count`。
  - `goal_completion_ready` — 结业门:在上一条之上**还要**每门课定过 `planned_lesson_count` 且已发布节数够数。这两个字段拆开正是为了让你分清卡在哪一层——`complete_contract` 认的是后者。
- `hypotheses_in_book_count` — 在册假设总数（排除 `rejected`/`frozen`/`expired`）。`get_context` 只给计数，具体条目归 `get_learner_brief`。
- `brief_etag` — 默认口径（`limit=5`、无 lesson 挂锚）learner brief 的内容指纹。**省一刀用**：和你上次记住的 etag 一样，就说明学生模型没变，这一轮不必再拉 `get_learner_brief`。

### 3. `get_learner_brief` — 备课前读学生模型

**用途**：开课前调这个，读回 `learner_hypotheses` / `post_lesson_evaluations` / `teacher_reflections`，不用自己扒表拼装。

**前置条件**：`pair_id` 可省；`limit` 可省，默认 5，会被 clamp 到 `[1, 20]` 之间（传 0 或负数、或传 100，都会被拉回合法区间，不会报错）；`pair_id` 不存在时同 `get_context`，`code: NOT_FOUND` + `details.available_pairs`。

**调用**：`get_learner_brief({ limit: 5 })`

**返回**（`data` 字段内容）：
```json
{
  "pair_id": "pair_xxx",
  "generated_at": "2026-07-10T...",
  "identity": { "...": "..." },
  "top_confidence_hypotheses": [
    { "id": "hyp_xxx", "allowed_for_teaching": true, "domain": "...", "observation": "...", "confidence": 0.6, "last_verified_at": null, "last_evidence_at": "2026-07-09T...", "user_approved": null },
    { "id": "hyp_yyy", "allowed_for_teaching": true, "domain": "...", "observation": "...", "confidence": 0.7, "last_verified_at": null, "last_evidence_at": "2026-06-02T...", "stale": true, "user_approved": null }
  ],
  "needs_reverification": [ { "...": "在场假设里最该复验的 1-2 条" } ],
  "hypotheses_in_book_count": 4,
  "hypotheses_note": "在册 4 条, 简报只携最近有证据的 2 条",
  "recent_evaluations": [ { "...": "最近 3 条 PostLessonEvaluation 摘要" } ],
  "latest_reflection": { "id": "refl_xxx", "method": "...", "next_action": "修订 L4：给非现金调整项加方向对照表", "written_at": "2026-07-09T..." },
  "confidence_facts": {
    "lesson_ids": ["lsn_xxx", "lsn_yyy"], "total_count": 12, "overall_accuracy": 0.75, "by_level": [ { "...": "..." } ]
  },
  "source_material": "教材:《Quantitative Investment Analysis》(2020) · anchored(~80%)",
  "brief_etag": "b3f1c9…"
}
```

**后面这几个字段容易被漏读，但正是省你事的那几个**：

- `hypotheses_in_book_count` / `hypotheses_note` — 在册总数与一句人话计数行（"在册 M 条,简报只携最近有证据的 N 条"）。**简报只携一部分假设，不是全部**——看到 `top_confidence_hypotheses` 只有 2 条不等于账上只有 2 条。在册 0 条时 `hypotheses_note` 是 `null`。
- 每条假设上的 `last_evidence_at` / `stale` — 前者是这条假设**最近一次被证据喂养**的时刻（新建即写入出生时刻，空证据不刷新），也是简报选条的排序键：学习者主权判决优先（`rejected`/`frozen`/`expired` 永不出现）、`active`+`confirmed` 排前，组内按 `last_evidence_at` 降序，至多 `limit` 条（默认 5，上限 20）。`stale` 是读取时现算的轻标注，`last_evidence_at`（没有就退回建档时刻）距今超过 21 天才挂上；**不陈旧的条目整个字段缺席，不是 `false`**。它纯 informational——不自动退役、不改状态、不落库、不影响入选资格，只是提醒你这条该找机会复验了。
- `confidence_facts` — 她自报把握度与实际正确率的事实聚合（近几课的 `lesson_ids`、样本数、总正确率、分档明细）。**纯事实层**：出手前看它决定难度，出手后结果入反思。没有任何带把握度的提交时是 `null`。校准是契约条款才谈的事，别把"校准她的把握度"自己变成教学目标。
- `source_material` — 当前合约的教材条款一行亮灯，与 `get_context` 里同格式。没谈教材或没有当前合约时 `null`。
- `brief_etag` — 这份 brief 的内容指纹（不含 `generated_at` 与它自己）。和 `get_context` 返回的 `brief_etag` 可直接比对：**一样就说明学生模型没变**，缓存可以直接复用，省掉这一刀。

**学生主权红线**（字段级强制，不是权限提示）：如果一条假设的 `allowed_for_teaching` 是 `false`（学习者拒绝或冻结了它），这条假设在返回里**只有** `{ id, allowed_for_teaching: false, redacted: true }`——`domain`/`observation`/`confidence` 等字段**在类型层面就不存在**，不是"给你空字符串"，是"这个形状的对象根本没有这些 key"。写代码消费这个返回值时不要假设每条假设都有 `domain`，要先判 `allowed_for_teaching`。

**下一课备课怎么用这份 brief**：
1. 看 `latest_reflection.next_action` ——上一次教学结束时说好"下一步要做什么"，这是续教的起点，不是从零决定这节课教什么。
2. 看 `needs_reverification` ——上次形成的假设里,哪些该在这节课里主动找机会验证/证伪(不是无脑当真)。
3. 看 `top_confidence_hypotheses` ——已经比较确信的判断,用于决定这节课的路径/难度,而不是重新试探。
4. 看 `recent_evaluations` 里的 `agent_observation` ——上几节课的具体观察原话,比归因结论更接近事实层。

### 3½. 读回具体内容 —— `get_lesson` / `get_exercise` / `get_submission`

`get_context` 和 `get_learner_brief` 给的是**摘要**：id、标题、状态、观察原话，刻意 token-frugal，**不给正文**。冷启动接课要看清上一课到底教了什么、题是怎么出的、她答成什么样，用这三件读回工具（全部只读、全部限当前 pair，别的 pair 或不存在的 id 一律 `NOT_FOUND`）：

- `get_lesson({ lesson_id, include_content: true })` — 读回课文。默认紧凑模式只给结构（概念+习题清单）+ 发布状态 + `content_chars` 字数 + 开头节选；**要全文必须显式开 `include_content: true`**（可能很长，确认要再开）。
- `get_exercise({ exercise_id })` — 题面、`reference_answer`（评分钥匙，**教师侧机密，不要原样透给学习者**）、`expected_concepts`、所属 lesson/course。
- `get_submission({ submission_id })` — 她的答案正文、批改状态、既有 `agent_score`/`agent_feedback`、她自报的把握度。把握度只给**序数** `confidence`（`guess` / `likely` / `certain`，即"她按了哪个按钮"这个事实）；折算的百分比属于学习者建模层，不进教师读路径，返回体里根本没有那个字段——跟 `pair://exercises/pending` 同一条红线。

接棒的典型次序：`get_context` 定位 → `get_learner_brief` 读学生模型 → 对 `recent_lessons` 里那节课 `get_lesson(include_content: true)` 把课文读进来 → 然后才动手备下一课。**没有这一步就备课，等于凭摘要臆想上一课的内容。**

### 4. 备课时引用证据（跨 agent 接棒的关键动作）

Agent B 备课时（走 [first-contract-and-lesson](./first-contract-and-lesson.md) 的 `add_lesson`/`update_lesson` 步骤）**必须能在自己的备课决策里指出**："这一课这么设计，是因为上一轮 `refl_xxx` 说 `next_action` 是 X，`hyp_xxx` 观察到 Y"——而不是重新问学习者"你之前学得怎么样"。

如果 Agent B 备的课完全没有引用 `get_learner_brief` 返回的任何字段（假设 id、reflection 的 next_action、具体 observation），这就是接棒失败——即便课程本身写得不错，也没有完成"记忆延续"这件事。**这一点没有工具能强制**，是读这份 brief 之后agent 自己的责任。这条义务的验收出处见 recipe://resume-teaching.reference。

### 5. （如果上次是被打断的）检查 Live Teaching 残留状态

`get_context.data.live_session` 如果不是 `null` 且 `status` 是 `active`，说明上次有一节 Live Teaching 没有正常收尾；`get_teacher_inbox` 里也可能有一条 `live_session_needs_reflection`。继续前建议先用 `live_session_get`/`live_snapshot_get_latest` 读一下断点在哪（不在本 recipe 范围内，属于 Live Teaching 专属工具族），不要假装它没发生过直接开新课。

**终态有三个,不是两个**:`completed` / `cancelled` / **`expired`**。`active` 是唯一的非终态。状态机的规则是**单向**:`active` → 三终态之一合法;终态 → 同一终态是幂等 no-op(不重写 `ended_at`);终态 → 其它任何态一律拒。所以撞见一场 `expired`：

- 它**不能**被 complete、被 cancel、被"恢复"。任何这类调用都会 `CONFLICT` 拒绝，`retryable: false`，原样重试永远不会成功。
- 正确的接续方式是**读回之后开新场**：`live_session_get` / `live_snapshot_get_latest` 把断点和上下文读出来，然后 `live_session_start` 开一场新的接着上。那场过期的课就留在账上作为历史事实，不去改写它的 `ended_at`。

> **这道锁的实际强度,说准一点。** 它是**读后写**的 guard,不是原子条件更新:REST 与 MCP 两条路都先 `select` 出当前状态、交给同一个状态机判定,判定放行后再 `update ... where id = ?`——那条 `update` 没有把"状态仍是 active"写进 WHERE。所以在**并发**下(两个调用者同时对同一场 active session 收官/取消)存在读-写竞态窗口:两边都读到 `active`、都判定放行、后写的一笔覆盖先写的一笔,`ended_at` 与终态被改写而**不会**报 `CONFLICT`。
>
> 换句话说:**顺序调用下这把锁是可靠的,并发覆盖不是"不可能",只是没被机器挡住**。原子条件更新的硬化在 README 的 Promise 表里明确列为 Planned——别把它当成已经生效的不变量,更别据此设计"反正机器会拦"的并发流程。真要防,现在的办法是别让两个 agent 同时收同一场课。

---

## 常见失败与恢复（汇总）

| 现象 | 真相 | 恢复 |
|---|---|---|
| `get_context`/`get_learner_brief`/`get_teacher_inbox` 报 `code: NOT_FOUND` | pair_id 错 | 读 `details.available_pairs`，照抄一个可用 id |
| `active_contracts` 是空数组，但你记得刚建过契约 | `proposed`（未签字）状态不计入 | 确认学习者是否已经在 `/contract/:id` 点了 Establish，或看 `get_teacher_inbox` 里有没有 `contract_proposed` |
| 某条假设读出来只有 `{id, allowed_for_teaching:false, redacted:true}` | 学习者的主权边界生效 | 不要试图从别的字段/别的工具绕出这条假设的内容，这是设计意图 |
| 备好的课看起来和上次教学完全脱节 | 没有真正读 `get_learner_brief` 就开始备课 | 备课前一定先调这个工具，并在课文/习题设计里体现引用 |
| 试图从 `human_note` 里解析结构化信息 | `human_note` 只是一句摘要，实质内容在 `data` 里 | 直接读 `data` 字段 |

## 相关

首次立约见 [first-contract-and-lesson.md](./first-contract-and-lesson.md)；课后批改归因见 [grade-attribute-revise.md](./grade-attribute-revise.md)。

🖤
