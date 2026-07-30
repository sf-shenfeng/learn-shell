<!-- recipe_version: 2b4318fae1e7 · generated_at: 2026-07-28 · canonical: recipe://grade-attribute-revise -->
# Recipe · 课后批改、归因与修订

> 状态：官方 recipe · Agent Surface Hardening 第一批
> 素材来源：真实 dogfood（2026-07-04 首次 revision pass；7/9 归因骨架落地）
> 工具名与参数以 `apps/server/src/mcp/server.ts` 当前注册为准

给一个从未见过这个学习者的 agent：学生交了作业之后，怎么走完"批改 → 形成假设 → 归因反思 → 修订下一课"这条闭环，并且不是靠自觉，而是靠 schema 强制。

事故史与设计缘由见 recipe://grade-attribute-revise.reference——reference 版本未变时无需重读。

> **回执格式**：本 recipe 涉及的 `grade_exercise`/`record_learner_hypothesis`/`reflect_on_teaching`/`update_lesson`/`record_post_lesson_evaluation` 全部走统一的结构化 JSON 回执（回执统一那一批施工定的形状）——成功 `{status:'success', operation, resource_id?, created_refs?, next_recommended_actions?, human_note}`，失败 `{status:'error', code, message, retryable, recovery_hint, human_note, details?}`。这几个工具的校验错误都已经用 `validationError()`/`notFoundError()` 分类，`code` 是准的（不是笼统的 `RETRYABLE`）。每个工具都接受可选的 `idempotency_key`（inputSchema 里能看到），批改/反思这类"写一次就不该重复"的操作尤其该传。

**语言合同（契约）**：凡学习者可见的文本用学习者的语言写——读 `get_context`/`get_learner_brief` 的 `identity.learner.locale`；locale 缺席（null）时跟随她在对话现场用的语言。语言归学习者，风格仍归你的声纹。

**先记清楚哪些字段她读得到**（这份名单比很多人以为的长）：`grade_exercise.feedback`、评估的 `learner_note`、评估的 `agent_observation`（学习者折叠区，**不是内账**）、`update_lesson.evidence`（修订病历本）。**内部 id（`sub_`/`tr_`/`evt_`/`hyp_`/`snap_` 等机器词）唯一合法归宿是 `evidence_refs`**——所有散文字段一律说人话。`update_lesson.evidence` 尤其要留神：它没有配套的 `evidence_refs` 通道，写笼统胜过塞机器词。

**证据引用义务（契约）**：凡机器引用字段（`evidence_event_ids`/评估的 `evidence_refs`/`action_link.ref_id`）里的 id 必须真实存在且属于本关系——服务端校验，幽灵引用 `VALIDATION` 拒并点名坏 id。为什么：证据先于叙事，引用不许凭记忆拼。

---

## 前置条件

- 已经存在至少一节 lesson、一条 exercise，且**学习者已经在 Web UI 里提交过作业**——`exercise_submissions` 只能通过学习者在 `/courses/.../lessons/:lessonId` 页面提交产生（`POST /api/submissions`），**没有 MCP 工具能代替学习者写提交**。agent 唯一的入口是"读到已经存在的提交，批改它"。
- 想知道有哪些作业等着批改，两个办法，**都是按 pair 过滤的**：
  1. 读 `pair://exercises/pending` resource（`exercise_submissions.status` 落在 `submitted`/`pending_grade` 的那些）。查询沿 `exercise_submissions → exercises → lessons → courses.pair_id` 一路 join 回当前 pair，多 pair 环境下不会串台。（早期版本确实只按 status 过滤、会泄漏全库待批作答——那是已修的旧账，不必再自己核对归属。）
  2. 调 `get_teacher_inbox`，待批改提交会以 `exercise_submitted` 类型出现，`recommended_tool: 'grade_exercise'`（见 [resume-teaching.md](./resume-teaching.md)）。它比 resource 多给一层"下一步调哪个工具"的指路，接棒时更省事。

---

## 步骤

### 1. 找到待批改的提交

用 `get_teacher_inbox`（推荐，附带下一步指路）或读 `pair://exercises/pending` resource（不是 tool，是 `ReadResource`；返回 `exercise_submissions` 行的 JSON 数组，按 pair 过滤）。拿到 `submission_id`（前缀 `sub_`）和 `exercise_id`。

### 2. 批改前先审教材（纪律，不是工具强制）

**先看这道题是否真的在课文里教过。** 这是学习者申诉成立后写进 `lesson-prep`/`teach-cfa` 的军规：定罪前先审教材，同等证据下学习者自述优先于教师反推。判错的责任默认在教材，除非你确认课文正名过这道题涉及的每个构件。

**这一步有工具了,别再靠记忆。** 三件读回工具就是为这条军规配的,全部只读、全部限当前 pair（别的 pair 或不存在的 id 一律 `NOT_FOUND`）：

- `get_lesson({ lesson_id, include_content: true })` — 读回课文全文。默认紧凑模式只给结构+元数据+开头节选(省 token),要审教材必须显式开 `include_content: true`。回执里的 `published` 顺带告诉你这节课发没发布。
- `get_exercise({ exercise_id })` — 读回题面、`reference_answer`(评分钥匙)、`expected_concepts`、所属 lesson/course。**`reference_answer` 是教师侧机密,不要原样透给学习者。**
- `get_submission({ submission_id })` — 读回学习者答案正文、批改状态、既有的 `agent_score`/`agent_feedback`、她自报的把握度(`confidence`,可空)。

顺手的次序是 `get_submission` → `get_exercise` 取评分标准 → 有疑问再 `get_lesson` 回课文对账 → 然后才 `grade_exercise`。`grade_exercise` 本身仍然不会替你检查课文——工具给的是读回能力,审教材的判断还是你的。

### 3. `grade_exercise` — 批改

**前置条件**：`submission_id` 真实存在——**有预检**，不存在时返回 `code: NOT_FOUND`（不是把"没找到"当成功返回，这一点在升级到 envelope 后已经明确区分）。

**调用**：
```
grade_exercise({
  submission_id: "sub_xxx",
  feedback: "间接法里非现金调整项方向搞反了，具体是……",
  score: 0.6,   // 0..1，软评分，可选
  idempotency_key: "uuid-..."
})
```

**预期返回（成功）**：
```json
{
  "status": "success",
  "operation": "grade_exercise",
  "resource_id": "sub_xxx",
  "created_refs": { "submission_id": "sub_xxx" },
  "next_recommended_actions": ["record_post_lesson_evaluation"],
  "human_note": "Graded sub_xxx"
}
```
**失败**（`submission_id` 错）：`code: NOT_FOUND`，`message: "Submission sub_xxx not found"`。

**重批持证（契约）**：已 `graded` 的提交再调 `grade_exercise` 会被 `code: CONFLICT` 拒绝，改判必须显式带 `regrade: true`——改判自由，痕迹免费：放行时旧判决摘要（`previous_score`/`previous_feedback`）自动写进追加的 `exercise.graded` 事件 payload，不需要你另外交代。

批改+追加 `exercise.graded` session event 是同一个数据库事务。**这条 event 的 id 不会回传给你**——回执里没有 event id 字段。之后要在 `record_learner_hypothesis` 的 `evidence_event_ids` 里引用这次批改时，**必须用真实的 session event id**（`evidence_event_ids` 已是机器校验的引用字段，见下方第 4 步的证据引用义务）——从事件流读回真 id，两步：先 `GET /api/pairs/:pairId/sessions/recent` 列出近期 session，再对目标 session 调 `GET /api/sessions/:id/events` 取事件。拿不到就留空，**不要拿 `sub_xxx` 凑数**（会被 `VALIDATION` 拒并点名坏 id）。

**判错递笔**：`score` 给了且落进判错区间（<0.5，纯粹是这次操作性提示自己的局部阈值，不回灌 calibration 曲线，也不改 `agent_score` 本身的软分语义）时，回执多带一个 `concept_refs`（这道题 `expected_concepts` 原样递出，白拿，不用你再走一遍 exercise→concept）和一句 `human_note` 顺手提示——配不配一张针对性闪卡纯属你裁量，**不进 `next_recommended_actions`**，不是义务。`score` 没给（只写 feedback 不给分）时没有判断依据，不递这个笔。

### 4. `record_learner_hypothesis` — 形成假设（带证据）

**纪律，非代码强制**：教学规格里的 3 课阈值规则——第 1、2 课结束**不立假设**，第 3 课结束才第一次写。工具本身不检查"这是不是第 3 课"，全靠 agent 自觉。

**这道阈值只管假设,不管反思。** 别把两件事一起推迟——**每一节课都必须有 teacher reflection**,否则 `close_lesson_loop` 收不了口:闭环状态机把 `reflection` 列为每课必备项,缺了它 `closure_progress.reflection` 一直显示缺,这节课就停在收尾链上关不掉。所以第 1、2 课的正确姿势是:写总评、写反思,只是**不立假设**。

**证据引用义务（契约）**：`evidence_event_ids` 逐个必须是**本关系真实存在的 session event id**——服务端批量校验存在性+归属，含幽灵 id 直接 `VALIDATION` 拒并列出坏 id。为什么是硬的：证据先于叙事——假设的生命周期（陈旧时钟、reinforce 续期）吃的是这份证据账，凑数的引用会把叙事伪装成证据。真 id 从事件流读回；拿不到就留空——**空证据合法，只是不计入喂养**（`last_evidence_at` 不更新，回执会明说），reinforce 空手调用同理不续期。

**前置条件**：`domain`/`observation`/`confidence` 必填。

**调用**：
```
record_learner_hypothesis({
  domain: "cash-flow-indirect-method-direction",
  observation: "非现金调整项的加减方向反复搞反，倾向于把所有调整都当加项处理",
  confidence: 0.6,
  evidence_event_ids: ["evt_xxx"]   // 真实 session event id；拿不到就留空，不拿别的 id 凑数
})
```

**预期返回有两种情况，都是 `status: 'success'`**：
- 正常写入：
  ```json
  {
    "status": "success",
    "operation": "record_learner_hypothesis",
    "resource_id": "hyp_xxx",
    "created_refs": { "hypothesis_id": "hyp_xxx" },
    "human_note": "Recorded hypothesis hyp_xxx"
  }
  ```
- **命中观察禁区**（这个 `domain` 在学习者的观察禁区登记簿上。登记簿的 Settings UI 已撤下，边界的建立与变更回到第一序对话，学习者说了口头边界后由 agent 用 `record_learner_feedback` 的 `boundary_update` 落账）：
  ```json
  {
    "status": "success",
    "operation": "record_learner_hypothesis",
    "next_recommended_actions": [],
    "human_note": "Not recorded — \"{domain}\" is on this learner's forbidden-observations list."
  }
  ```
  **这不是错误，`status` 仍然是 `success`，只是没有 `resource_id`/`created_refs`**——命中禁区是"礼貌地什么都不做"，不是失败。调用方必须检查有没有 `created_refs`（或读 `human_note`）区分"真写入"和"礼貌拒绝"，不能只看 `status === 'success'` 就假设假设已经落库；否则后续 `get_learner_brief` 读不到它，看起来像丢失数据。

### 5. `reflect_on_teaching` — 归因反思（七类 + 反事实 + 行动链接）

**七个字段全部服务端强校验**，不是靠 agent 自觉写好文章。校验失败全部走 `validationError()`，`code: VALIDATION`，`retryable: false`——不是笼统的重试。（此工具的 schema 收紧史见 recipe://grade-attribute-revise.reference。）

| 字段 | 必填 | 校验规则 |
|---|---|---|
| `lesson_id` | schema 上可选，**实务上请当必填** | 这条反思挂在哪节课上。不填时服务端会从现场上下文强推断（依次看 `live_session_id` 指向的场次 / 当前唯一 active 的 Live 教室 / 24h 内最近一场 Live 课），推断命中会替你挂上并在 `created_refs.anchored_lesson_id` + `human_note` 里明示。**推不出来就落成无主反思**——它的代价不是"白写"，而是"记不到人头上"，详见下方的无锚口径。课后异步批改正是最容易推不出来的场景（没有 Live 上下文可推），所以别赌推断，自己把 `lesson_id` 写上。填了会校验存在性+同 pair 归属 |
| `primary_attribution` | 是 | 七选一枚举：`not_yet_mastered`(①学生尚未掌握) / `material_flaw`(②教材有误或不完整) / `difficulty_timing`(③难度时机不合适) / `path_mismatch`(④解释路径不适合这个人) / `judgment_error`(⑤原判断本身就错) / `weather`(⑥天气：同日状态性噪音，累/疼/心不在焉) / `path_worked`(⑦路径适配、如预期奏效——唯一的成功归因分支，全对的课选这个，但必须写出什么奏效了、证据是哪几次；禁止在有真实问题时用它逃避归因) |
| `secondary_attribution` | 否 | 若给，必须是七选一之一，且**不能等于** `primary_attribution`——同一个答案填两遍会被拒绝 |
| `evidence` | 是 | 非空字符串，必须是"这次 session 里的具体观察"，不能只是复述归因结论（服务端不做语义检查，但字段是必填非空） |
| `counterfactual` | 是 | 非空字符串，反自利归因机关：一句话"如果真相是（另一个最可信的归因），我预期会看到 X；我实际看到的是 Y" |
| `action_link` | 是 | `{ type, ref_id }`，**`type` 必须匹配 `primary_attribution`**（见下表），否则报错 |
| `weather_expires_at` | 条件必填 | 仅当 `primary_attribution === 'weather'` 时必填（ISO 时间戳）；给了其他归因还传这个字段会报错 |

`action_link.type` 映射表（选错会被拒），以及成功写入后 `next_recommended_actions` 会依据这张表给出建议下一步：

| primary_attribution | action_link.type | next_recommended_actions（成功时） |
|---|---|---|
| not_yet_mastered | review_action | `record_post_lesson_evaluation` |
| material_flaw | lesson_revision | `update_lesson` |
| difficulty_timing | course_adjustment | （无建议） |
| path_mismatch | intervention_note | （无建议） |
| judgment_error | hypothesis_update | `record_learner_hypothesis` |
| weather | retest_only | （无建议） |
| path_worked | hypothesis_update | `record_learner_hypothesis`（confidence-up 方向，证实现有假设） |

**调用示例**（对应"材料有问题，下一课要修订"这条路径）：
```
reflect_on_teaching({
  lesson_id: "lsn_xxx",              // 挂锚：别省，省了推不出来就是无主反思，这节课名下读不回它
  method: "间接法 revision pass",
  rationale: "学生反复答错的构件在课文里从未正名",
  next_action: "修订 L4：给非现金调整项加方向对照表",
  primary_attribution: "material_flaw",
  evidence: "作业二里把折旧/摊销当减项处理，课文 Notation 一节从未给出方向示例",   // 散文字段，说人话，不塞 sub_xxx
  counterfactual: "如果真相是 not_yet_mastered（学生只是没掌握），我预期会看到概念定义题也答错；实际概念定义题全对，只错方向应用题——课文没教方向，不是没学会概念",
  action_link: { type: "lesson_revision", ref_id: "lsn_xxx" }
})
```

**预期返回（成功）**：
```json
{
  "status": "success",
  "operation": "reflect_on_teaching",
  "resource_id": "refl_xxx",
  "created_refs": { "reflection_id": "refl_xxx" },
  "next_recommended_actions": ["update_lesson"],
  "closure_progress": { "completed": ["graded", "post_lesson_evaluation", "reflection"], "missing": ["receipts", "closed"], "next_required_action": {} },
  "human_note": "Wrote reflection refl_xxx · attribution_tally: {\"material_flaw\":2,\"not_yet_mastered\":1,...}"
}
```
`human_note` 里附带的 `attribution_tally` 是近 20 次反思的主归因计数分布，纯只读参考。

**`closure_progress` 只在挂上 lesson 锚（显式或推断）时随行。** 回执里没有它，就是在告诉你这条反思无主——不是"这次不带而已"。看到无锚警告就补写一条带 `lesson_id` 的。

**无锚反思的真实代价，说准一点（回执里那句警告说得比机器狠）。** 收口时"这节课反思过没有"走的是**双轨**判定：

- **精确轨（挂锚）**——这节课名下确有反思行：`lesson_id` 直接等于本课，**或者** `lesson_id` 为空但 `live_session_id` 指向本课挂过的某场 Live（只挂场次锚不挂课锚是合法写法，聚合侧认）。
- **近似轨（pair 级兜底）**——本 pair **最近一条**反思（不问挂没挂锚）写在**本 pair 最近一次关课之后**；若这个 pair 迄今一次课都没关过，那么"写过任何一条反思"就算数。

两轨**取或**：任一命中，`closure_progress.reflection` 就算满足。所以别信"无锚反思一节课都收不了口"这种说法——**一条无主反思照样能把 `reflection` 这一项顶绿**，收口不会卡住。

真正丢掉的是这三样，每一样都比"卡住"更难查：

1. **记不到人头上。** 下一任老师按课读回时，这节课名下是空的——他只能从 pair 级近似里猜"应该反思过吧"。工具描述里那句"靠 pair 级近似猜"，指的就是这个坑。
2. **一条顶一片。** 近似轨是 pair 粒度的，一条无主反思会把**这个 pair 当下所有没关的课**的 `reflection` 项一起顶绿——包括你压根没反思过的那几节。收口于是过在代理指标上，不是过在证据上。
3. **回执没有进度条。** 无锚时 `closure_progress` 整个不随行，你当场看不到这节课还差什么。

一句话：无锚不是"不算数"，是"算得不对人"。别拿它省事。

**`action_link.ref_id` 填什么**：指向具体行动落点的真实 id——**服务端按 `type` 到对应表校验存在性+归属（契约）**，幽灵 id `VALIDATION` 拒。当 `primary_attribution` 是 `material_flaw`（`action_link.type: 'lesson_revision'`）时，**先做第 6 步 `update_lesson`，它的回执会直接给你 `created_refs.lesson_revision_id`**，原样填进 `ref_id` 就是最精确的引用（被修订的课文 `lsn_xxx` 也是合法落点）。其余类型填各自语义下最相关的**真实**既有 id：`hypothesis_update` 填 `hyp_xxx`（get_learner_brief 可读回）、`review_action` 填卡/题/概念/课文 id、`course_adjustment` 填课程/课文 id、`intervention_note` 填课文/场次/事件/patch id、`retest_only` 填要重测的题/卡/课文 id。凭记忆拼 id 会被拒——归因必须接真实行动。这个 id 回填链路的补齐史见 recipe://grade-attribute-revise.reference。

**常见失败**（`code: VALIDATION`，`retryable: false`；`message` 逐字精确到具体缺什么）：
- `primary_attribution is required and must be one of ...` — 传空或传了枚举之外的值
- `secondary_attribution must differ from primary_attribution — picking the same one twice is not a second read` — 两个归因字段填了同一个值
- `evidence is required — a specific observation from this session, not a restatement of the attribution` — evidence 为空
- `counterfactual is required (…) — one line: ...` — counterfactual 为空（真实报文里那对括号引的是归因规格的内部条款号，包内不可追索，照错误文本本身处理即可）
- `action_link is required — { type, ref_id } ... an attribution without a linked action is a diary entry, not a reflection` — action_link 缺失或不完整
- `action_link.type must be '{expected}' for primary_attribution '{primary}' ...` — type 与 primary_attribution 不匹配
- `weather_expires_at is required when primary_attribution is 'weather' ...` — 选了 weather 却没给过期时间
- `weather_expires_at is only valid when primary_attribution is 'weather' ...` — 没选 weather 却给了这个字段
- `action_link.ref_id '...' 不存在或不属于当前 pair` — ref_id 是幽灵：按 `type` 到对应落点表验存在+归属（证据引用义务），引用真实 id 再来

**观察禁区同样生效**：非 `weather` 的归因内容如果命中学习者的观察禁区登记簿，`primary_attribution`/`evidence`/`counterfactual`/`action_link` 等字段**不落库**（`method`/`rationale`/`next_action` 这些"教师自己的日记"字段仍然照常写入），返回仍是 `status: 'success'`，`human_note` 会带一句 `(attribution fields NOT recorded — forbidden-observations registry hit)`——同样是"读 `human_note`，不是看 `status`"。

### 6. `update_lesson` — 修订课文（带 reason/evidence）

**前置条件**：`lesson_id` 存在（`code: NOT_FOUND`）；`revision_reason` 必填（`code: VALIDATION`）——**没有理由的修订直接拒绝**，这是唯一一个"必须先说明白为什么改"的写入工具。

**`evidence` 写人话，不写机器词。** 这一段**学习者会在修订病历本里读到**，而且这个字段**没有配套的 `evidence_refs` 通道**——机器词写进去就没有别的地方能接住它。所以宁可说得笼统（"作业二里方向连错两次"），也不要塞 `sub_xxx`/`hyp_xxx`。要精确指认证据，那是 `reflect_on_teaching` 的 `action_link.ref_id` 和评估的 `evidence_refs` 的活。

**调用**：
```
update_lesson({
  lesson_id: "lsn_xxx",
  revision_reason: "非现金调整项方向从未在课文中正名，学生反复答错方向",
  evidence: "作业二里非现金调整项的加减方向连错两次，都是当成加项处理",
  content_markdown: "...(新正文，含方向对照表)...",
  idempotency_key: "uuid-..."
})
```

**预期返回**：
```json
{
  "status": "success",
  "operation": "update_lesson",
  "resource_id": "lsn_xxx",
  "revision": 2,
  "created_refs": { "lesson_revision_id": "lrev_xxx" },
  "next_recommended_actions": ["reflect_on_teaching"],
  "human_note": "Lesson lsn_xxx revised to v2 · annotations re-swept: 3 checked, 1 orphaned"
}
```
**`created_refs.lesson_revision_id` 就是这次修订在 `lesson_revisions` 表里的行 id**——回填进第 5 步 `reflect_on_teaching` 的 `action_link.ref_id`（`material_flaw` 路径）就是最精确的引用，不需要额外查表。如果这节课有划线/笔记，`human_note` 里的 `annotations re-swept: ...` 摘要会告诉你是否有笔记因为正文变化被重新普查、有几条掉进孤儿区。（写入机制细节见 recipe://grade-attribute-revise.reference。）

学习者在课文页会看到 `Revised · v{n}` 的 pill，点开能看到完整修订病历（每版 reason+evidence+时间）。

**格式校验同 `add_lesson`**：传了 `content_markdown` 就会被同一套分页校验检查——至少 2 页（顶级 `---` 分隔）、每页第一行 `::kicker[...]`、每页恰好一个 `## `。规则速查见 [first-contract-and-lesson](./first-contract-and-lesson.md) 第 4 步的"课文格式速查"，这里改的是既有课文的正文，不是从零写，容易忘的是**改完之后页数/kicker 结构还完不完整**——只改了中间一段正文而漏删/漏加分页符，一样会被打回。

**常见失败**：
- `code: VALIDATION`，`revision_reason is required — a revision without a reason is rejected` — 没给理由
- `code: VALIDATION`，`At least one of content_markdown / title / concept_ids / estimated_minutes is required` — 只传了 lesson_id 和 reason，没有任何实际要改的字段
- `code: VALIDATION`，`content_markdown 第 N 页缺少 kicker / 有 N 个二级标题 / ...` — 传了 `content_markdown` 但分页结构不合法，报错会指出具体第几页缺什么
- `code: NOT_FOUND`，`Lesson {id} not found` — id 错，`details.lesson_id` 会回显

### 7. `record_post_lesson_evaluation` — 收尾的事实层记录

每节课结束都应该写这一条（不打 confidence 标签，纯事实）。**总评做增量，不复判**（一次判决原则）：`agent_observation` 只装三样——①整体判断 ②与 Live 表现的对照 ③下一课建议。**永不逐题复述习题**：习题的判决在 grade_exercise 记录上，把 submission id 填进 `evidence_refs` 指过去，不把评语再写一遍。

**`agent_observation` 不是内账。** 它会出现在**学习者的折叠区**（"Teaching observation"，2026-07-26 学习者当面裁定收窄的口径）。所以：**内部 id 一律只进 `evidence_refs`，不写进任何散文字段**——原先"写正文或 `evidence_refs` 二选一"的说法已作废。`evidence_refs` 里的每个 id 服务端逐个验存在+同 pair 归属，幽灵引用直接拒。

```
record_post_lesson_evaluation({
  lesson_id: "lsn_xxx",
  concepts_touched: ["cpt_xxx"],
  flashcards_rating_distribution: { Again: 2, Hard: 1, Good: 3, Easy: 0 },
  exercises_submitted_count: 1,
  agent_observation: "整体判断: 间接法框架已立，非现金调整方向未稳。与Live对照: Live 近迁移接得稳，笔头独立作答时方向感掉线——现场有脚手架就对，撤了就错。下一课建议: 开课先做一道无提示方向判定，再进新内容。",
  evidence_refs: ["sub_xxx"],        // 机器引用走这里，正文保持人话
  learner_note: "这节课框架已经立住了，方向感还得练——下节课开场先来一道方向判定题热身。"
})
```

**预期返回**：
```json
{
  "status": "success",
  "operation": "record_post_lesson_evaluation",
  "resource_id": "ple_xxx",
  "created_refs": { "evaluation_id": "ple_xxx", "lesson_id": "lsn_xxx" },
  "next_recommended_actions": ["reflect_on_teaching"],
  "human_note": "Recorded evaluation ple_xxx for lesson lsn_xxx"
}
```
除 `lesson_id` 外其余字段在 schema 上都是可选的，`flashcards_rating_distribution` 缺省四档全 0。

**但空评估会被拒收。** 实质字段共**八**个——`concepts_touched` / `flashcards_reviewed_count` / `flashcards_rating_distribution` / `exercises_submitted_count` / `live_turns_count` / `duration_minutes` / `agent_observation` / **`learner_note`**——里头**至少要有一项非默认值**，全默认（空数组 + 全 0 + 空字符串 + 无留言）会污染 learner brief，服务端直接 `VALIDATION` 拒。所以"只传 `lesson_id` 占个位"这条路走不通，也不该走：占位的总评在下一任老师读回时和没写一样，只是更难发现。

> **两条容易踩反的边角：**
> - **`learner_note` 单独就够。** 它算内容不算引用，只写这一条（其余全默认）**会成功**。但服务端那句拒收文案里只念了前七个字段名，没提它——**照文案反推字段清单会漏掉这一个**。以这里的八项为准。
> - **`evidence_refs` 单独不够。** 它是引用不是事实，不进实质字段判定；只挂 `evidence_refs` 而八项全默认，照样拒。

另外 `(pair_id, lesson_id)` 有唯一索引——**一课一份总评**。对同一节课第二次调用是修订，服务端 update-in-place（不插新行），回执会说明这是 update 而不是新建。

### 8. `update_flashcard` — 顺手修卡面（可选）

复盘时抓到闪卡本身有毛病（问法含混、答案写错、卡串错了组），直接改，**不要删卡重建**：

```
update_flashcard({ flashcard_id: "fc_xxx", front: "...", back: "...", idempotency_key: "uuid-..." })
```

纯 patch 语义，只改你给出的字段，不建 revision 快照。关键在于**改内容不动进度**：FSRS 调度状态（`due_at` / `stability` / `difficulty` / `review_count`）与 `paused` 原样保留。删卡重建才会把她攒下来的复习进度一起丢掉——这是这个工具存在的全部理由。只能改当前 pair 的卡，别的卡一律 `NOT_FOUND`。

---

## 常见失败与恢复（汇总）

| 现象 | 真相 | 恢复 |
|---|---|---|
| `grade_exercise` 返回 `code: NOT_FOUND`，`Submission xxx not found` | `submission_id` 错，`code` 是准的 | 重新从 `get_teacher_inbox`/`pair://exercises/pending` 核对 id |
| `record_learner_hypothesis`/`reflect_on_teaching` 的 `human_note` 里带 "Not recorded"/"NOT recorded" | 命中观察禁区，`status` 仍是 `success`，不是错误 | 尊重边界，不要重试、不要换措辞硬写；判断真写没写看有没有 `created_refs`，不要只看 `status` |
| `reflect_on_teaching` 报 `action_link.type must be '...'` | type 没跟着 `primary_attribution` 换 | 查上面的映射表，七选一联动改 |
| 想在 `action_link.ref_id` 精确指向某次修订 | `update_lesson` 直接返回 `created_refs.lesson_revision_id` | 从 `update_lesson` 的回执里原样取用，不需要额外查表 |
| `record_post_lesson_evaluation` 报 `code: VALIDATION`，说评估为空 | 八个实质字段全是默认值——空评估拒收。注意拒收文案只念了其中七个，漏念 `learner_note`（它同样算数），也别指望 `evidence_refs` 顶数（引用不算事实） | 至少写一项实质内容（通常是 `agent_observation`），别拿空壳占位 |
| `reflect_on_teaching` 回执里没有 `closure_progress`，`human_note` 带无锚警告 | 这条反思没挂上 lesson。**注意警告的措辞比机器狠**：它并非"不计入任何闭环"——pair 级近似轨照样会把 `reflection` 顶绿；丢的是"这节课名下有反思"这条按课可读回的事实 | 补写一条显式带 `lesson_id` 的反思；异步批改一律自己填锚，别指望推断 |
| `close_lesson_loop` 收不了口，`closure_progress.reflection` 一直显示缺 | 精确轨与近似轨双双落空：这节课名下没有挂锚反思，且本 pair 最近一次关课之后一条反思都没写 | 给这节课补一条带 `lesson_id` 的 `reflect_on_teaching`（每节课都该有；3 课阈值只管假设不管反思） |

## 下一步

下次醒来续教，看 [resume-teaching.md](./resume-teaching.md)。首次立约见 [first-contract-and-lesson.md](./first-contract-and-lesson.md)。

🖤
