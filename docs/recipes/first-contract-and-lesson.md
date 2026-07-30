<!-- recipe_version: e3852b5c7d52 · generated_at: 2026-07-28 · canonical: recipe://first-contract-and-lesson -->
# Recipe · 首次立约与备课

> 状态：官方 recipe · Agent Surface Hardening 第一批
> 素材来源：真实 dogfood（2026-07-02 第一节真课立约链路）
> 工具名与参数以 `apps/server/src/mcp/server.ts` 当前注册为准（写这份 recipe 时 50 个工具；数量本身还在变，别当成固定常量记，认工具名不认数字——要当下的真数就读 `manifest://capabilities`）

给一个从未连过 Learn Shell 的 agent：怎么从"跟学习者谈完要学什么"，走到"学习者能打开一节完整的课开始学"。

事故史与设计缘由见 recipe://first-contract-and-lesson.reference——reference 版本未变时无需重读。

> **回执格式**：本 recipe 涉及的全部写入工具（`propose_contract`/`create_course`/`add_lesson`/`update_lesson`/`add_concept`/`add_flashcard`/`add_exercise`/`add_mindmap_seed`/`publish_lesson`）都已经统一成结构化 JSON 回执（回执统一那一批施工定的形状）：成功是 `{status:'success', operation, resource_id?, created_refs?, learner_url?, next_recommended_actions?, human_note}`，失败是 `{status:'error', code, message, retryable, recovery_hint, human_note, details?}`，`code` 是 `VALIDATION`/`NOT_FOUND`/`CONFLICT`/`PERMISSION`/`RETRYABLE` 五选一。`human_note` 里永远是那句原来当成唯一返回值的人类可读文本，没丢，只是现在旁边多了机器字段。每个工具的 `inputSchema` 里都能看到一个可选的 `idempotency_key`（字符串，建议传 uuid）：同一个 key 重放同一个调用直接拿回第一次的结果、不重复写入，网络重试/断线重连时该传上，不要猜"上次到底写没写"。

---

## 前置条件（连接前）

- MCP 已连接，transport 是 stdio，agent 作为子进程持有它。接线命令与 README / SETUP.md §4 / 首跑页语义同源：

  ```bash
  claude mcp add learn-shell \
    -e DATABASE_URL="postgresql://learn_shell:learn_shell_dev@localhost:5432/learn_shell" \
    -- pnpm -C /absolute/path/to/learn-shell --filter @learn-shell/server mcp
  ```

  `-e DATABASE_URL` 省不得：MCP 入口不加载 `apps/server/.env`，变量不进它自己的进程环境，第一笔数据库调用就被拒。`pnpm -C <绝对路径>` 同理——MCP 子进程的 cwd 由客户端定，裸 `--filter` 未必解析得到 workspace。其他客户端（Codex CLI / OpenClaw / 通用 stdio）见 SETUP.md §4。
- 数据库里已经存在一条 `learner_agent_pairs.active = true` 的记录。没有的话，正门是 `create_pair` 工具（全服务器唯一无 pair 可调的工具）：学习者先在首跑页亲手输入自己的名字，agent 再以同名调用建对——完整义务链见 `recipe://bootstrap` 的无 pair 分支。`db:seed:demo` 只是可选样板间，不是入学前置。没建对之前，其余工具调用都会报 `code: NOT_FOUND`/`No active pair`。
- 立约对话（"你想学什么、想怎么学"）**住在 agent 原生对话通道**（终端/聊天），不住在 Learn Shell 页面里——LS 没有"立约聊天"UI。谈完之后才调用下面第一步。

---

## 步骤

### 1. `propose_contract` — 把谈好的草案递交给 LS

**前置条件**：已有 active pair；至少确定了 `goal`。

**调用**：
```
propose_contract({
  goal: "Pass CFA Level 1 in February 2027",
  time_range: { start: "2026-07-10T00:00:00Z", end_target: "2027-02-28T00:00:00Z" },
  success_criteria: ["..."],
  intensity: "standard",        // relaxed | standard | hardcore，可省，默认 standard
  interaction_mode: "hybrid",   // async | realtime | hybrid，可省，默认 hybrid
  content_modality: "mixed",    // text | visual | mixed，可省，默认 mixed
  pace: "weekly",               // daily | weekly | flexible，可省
  idempotency_key: "uuid-mint-once-per-attempt"  // 可选，重试安全
})
```

**预期返回（成功）**：
```json
{
  "status": "success",
  "operation": "propose_contract",
  "resource_id": "tc_xxx",
  "created_refs": { "contract_id": "tc_xxx" },
  "learner_url": "/contract/tc_xxx",
  "next_recommended_actions": ["adhoc_message_send"],
  "human_note": "Proposed contract tc_xxx — awaiting learner signature at /contract."
}
```
`resource_id`/`created_refs.contract_id` 就是 `tc_xxx`，不需要再从 `human_note` 里正则解析。`idempotency_key` 重放时会额外带一个 `idempotent_replay: true`。

写入的是 `setup_status: 'proposed'`。**这个状态还不是"当前契约"**——`get_context` 的 `active_contracts` 只认已签字且非终态的契约（`established`/`outlining`/`outline_ready`/`generating`/`ready` 等），`proposed` 不在其中。也就是说 agent 递交草案之后，自己用 `get_context` 是看不到它的，直到学习者签字。

**只传 Class A（goal 必答/time_range/success_criteria）+ Class B（intensity/interaction_mode/content_modality/pace/weekly_capacity_hours/preferred_time_of_day）**。Class C（提醒偏好）不要传——这个工具不收，签字台表单也已不再收集这些字段（提醒旋钮从签字台撤下，LS 从未真正派发过提醒；节奏条款走 `cadence`，立钟归学习者/agent 的原生工具）。

**常见失败**：
- `code: VALIDATION`，`goal is required` — `goal` 是空字符串或缺失，`retryable: false`。恢复：按 `recovery_hint` 补上再调一次，`propose_contract` 本身没有副作用残留（失败在写库之前就抛错）。
- `code: NOT_FOUND`，`No active pair — create a learner_agent_pair before calling any tool.` — 见"前置条件"，这不是 agent 能自己恢复的错误，需要人类介入。

### 1½. 自带教材（source_material）——摄取模式

学习者带自己的教科书（EPUB/PDF）来学时，立约对话多三问（依赖档位/外延偏好/版本年份，见 skill `intake/contract-establish` 的 Class A¾），谈定的条款随 `propose_contract` 一并递交：

```
propose_contract({
  goal: "...",
  source_material: {
    title: "International Financial Statement Analysis",
    year: 2024,                 // 可选——时效风险立约时声明
    reliance: "anchored"        // strict(严格,100%) | anchored(锚定,~80%) | inspired(启发,~60%)
  },
  ...
})
```

回执的 `human_note` 会回显教材一行（`教材:《…》(年份) · 档位`）；此后每次 `get_context`（`active_contracts[].source_material`）和 `get_learner_brief`（顶层 `source_material`）都亮同一行——备课的老师躲不开它。

**摄取模式（LS 不建文件解析器，设计缘由见 reference 卷）**：

1. **书由你的宿主读**——你的运行环境怎么读 EPUB/PDF 是你的事，LS 不收文件、不解析文件；
2. **课程骨架 = 书的骨架**——`create_course` 后，lessons 按章节拆（一章一课或按篇幅再切），顺序遵档位（strict/anchored 随书目录，inspired 可重组）；
3. **`add_document` 存每章蒸馏**——不是全文粘贴，是你消化后的每章精要，作为学习者的伴读材料；
4. **`source_refs` 锚到章/页**——概念与课文引用落到"第 N 章 / p.NN"这一级，学习者能循线回到原书；
5. **每课第一页给整课定位**——课文第一页写 `本课来源` 与 `本课覆盖` 两行，放在学习者一眼可见处、不折叠。来源精度跟档位走：`strict` 到**章 + 页码范围**，`anchored` 到**章**，`inspired` 只写"以《书名》为出发点，不逐节对应"——**不许标章页假装有对应关系**（那是伪造定位）。覆盖一行写清这课实际讲到的要点。与第 4 条是两个尺度：第 4 条让学习者读到某一句时能回去查那一句，这条让他**未读先知道自己站在书的哪一段**——缺任一个，"蒸馏不誊抄"就变成蒸馏完找不回去。

**引源分家制**：课文与 live 教学里，书说的与你加的必须可区分——超出书的内容带"外延"标记（课文散文用加粗前缀 `**外延**`，闪卡/习题/live 等纯文本面用 `外延:` 前缀；书内内容不加标）。当书和 agent 的知识打架时，学习者有权知道自己正在信的是谁。备课侧的档位语义与标记纪律全文见 skill `workflow/lesson-prep` 的"教材模式"。

### 2. 等待学习者签字（没有 MCP 工具，纯等待）

学习者打开 `/contract/:contractId`（顶栏待签徽章 / RecentRail 待签行会指向这个 URL），看到条款卡，可以拧 Class B 旋钮，然后点 Establish。这一步把 `setup_status` 推进到 `established`。

**这里没有 push 通知机制**（缺口出处见 recipe://first-contract-and-lesson.reference）。agent 恢复"知道学习者签了"的办法有三种：
1. 学习者当面/在对话里告诉 agent"我签了"；
2. agent 定期调 `get_context`，看 `active_contracts` 是否从空变成有一条、`setup_status` 是否已经不是 `proposed`；
3. agent 调 `get_teacher_inbox`——一份签好字但还没进入教学的契约会以 `contract_proposed` 类型的一项出现在待办里（见 [resume-teaching.md](./resume-teaching.md)）。

**不要**在 `propose_contract` 返回之后立刻假设契约已生效就去 `create_course`——**新契约流的建课必须带上 `contract_id`,而 `contract_id` 只接受现役(已签)合约**,所以"契约签没签"不是可选的前情确认,是下一步能不能跑通的前置。

### 3. `create_course` — 新建课程

**前置条件**：active pair；新契约流还需要一份**已签现役**的合约(`get_context` 的 `active_contracts` 里能看到、`setup_status` 已是 `established`)。

**两个参数省不得——省了这门课结不了业:**

- **`contract_id`** — 建课即履约。带上它,新课 id 会自动并入该合约的 `covered_course_ids`(等价于紧接着调一次 `update_contract_coverage`,这里省一刀)。不带,合约的覆盖单就是空的,而 `complete_contract` 的前置校验②直接拒绝空覆盖单:"这份合约还没有教过任何课程"。事后可以用 `update_contract_coverage` 补挂,但没理由把它拖到结业那天才发现。
- **`planned_lesson_count`** — 建课时问学习者的第一问:"这门课一共几节"。它是 `complete_contract` 前置校验③的硬门:覆盖单里每门课都必须定过这个数、且已发布节数够数,才判 `goal_completion_ready`。**没定过计划节数的课不放行**——回执会给 `missing_planned_count` 差额。

  **而已建课程目前没有补录 `planned_lesson_count` 的入口。** 建课那一刻没问、没填,这门课就卡在结业门前,没有工具能事后补上。这一问要当面问学习者,不要自己拍一个数——但更不要跳过。

**调用**：
```
create_course({
  topic: "CFA L1 — Economics",
  description: "...",
  contract_id: "tc_xxx",           // 现役合约的真实 id 前缀是 tc_,建课即并入覆盖单
  planned_lesson_count: 8,         // 学习者定的"一共几节",事后无法补录
  idempotency_key: "uuid-..."
})
```

`contract_id` 必须现役且同 pair,否则**不建课**直接 `VALIDATION` 拒绝(不留孤儿关联),文案指路 `get_context` 查现役合约。

**预期返回**：
```json
{
  "status": "success",
  "operation": "create_course",
  "resource_id": "crs_xxx",
  "created_refs": { "course_id": "crs_xxx" },
  "next_recommended_actions": ["add_lesson"],
  "human_note": "Created course crs_xxx"
}
```
`next_recommended_actions` 是建议性的，不是强制——但这里恰好就是下一步该做的事。

> **别把"可选"读成"不设门槛"**:`planned_lesson_count` 在 schema 上确实可选,但留空(null)**不是**放行,是**永远过不了门**。`goal_completion_ready` 的逐课判据写死了"planned_lesson_count 非空 **且** 已发布节数够数",null 让这一项恒 false;`complete_contract` 那边同一个 null 会渲染成 `missing_planned_count` 差额,附言"已建课程目前无补录入口"。
>
> 所以 null 的真实含义只有一个:**没人问过它一共几节,于是它结不了业**。想让它结业,只能另建一门定过数的课来覆盖。新建的课一律当面问、当面定数——省这一刀等于把这门课判死。

course 的 `structure.lesson_ids` 初始为空数组，由 `add_lesson` 自动维护（见下一步），不需要手写。

### 4. `add_lesson` — 写第一节课的正文

**前置条件**：`course_id` 必须是一个真实存在的 course id。**有存在性预检**（2026-07-12 与 `add_simulated_quiz` 同批修上的一批追补）：course_id 错了在写库之前就被拦下，返回 `code: VALIDATION`，`message` 点名 `course_id 'xxx' 不存在`，指引核对 `create_course` 返回的真实 id 或用 `get_context` 查现有课程——不要凭猜测拼 id。（这里曾两度是另一种样子：先是撞 FK 落 `RETRYABLE` 误分类，后来才变裸 PG 报错映射 `NOT_FOUND`——沿革见 recipe://first-contract-and-lesson.reference。）

**调用**：
```
add_lesson({
  course_id: "crs_xxx",
  order: 1,
  title: "GDP: 三种核算方法",
  content_markdown: "...",
  concept_ids: [],           // 通常先留空，概念在下一步 add_concept 后回填
  estimated_minutes: 20,
  skill_used: "domain/teach-cfa",  // 可选，记录这次备课用的 skill 名
  idempotency_key: "uuid-..."      // 可选
})
```

**预期返回**：
```json
{
  "status": "success",
  "operation": "add_lesson",
  "resource_id": "lsn_xxx",
  "created_refs": { "lesson_id": "lsn_xxx", "course_id": "crs_xxx" },
  "learner_url": "/courses/crs_xxx/lessons/lsn_xxx",
  "next_recommended_actions": ["add_concept", "add_flashcard", "add_exercise", "publish_lesson"],
  "human_note": "Created lesson lsn_xxx — 课已建立为草稿，学习者不可见（learner_url 发布后才对学习者生效）。完成配套内容（概念/闪卡/练习）并 verify_prep 通过后，调用 publish_lesson 发布。"
}
```
**`add_lesson` 建的是草稿**（Publish Gate）：`learner_url` 要等第 8½ 步 `publish_lesson` 之后才对学习者生效，别拿它当"已交付"的证明。服务端仍然会同步把这节课的 id 写进 course 的 `structure.lesson_ids`（旧代码曾经漏过这一步的教训——课程列表页显示 0 lessons）。

**课文格式速查（写入即校验）**：`content_markdown` 不是自由 markdown，是 PPT 式分页课——不合规直接 `code: VALIDATION` 打回，报错文案会指出第几页缺什么。三条硬规则：

1. 至少 2 页，页与页之间用单独一行的顶级 `---` 分隔；
2. 每页第一个非空行必须是 `::kicker[...]`（词表 HOOK/FABLE/NAME/FORMULA/EXAMPLE/TRIAL/TRAPS/EXAM/NEXT，见 `docs/LESSON-BLOCKS-v1.md` §1.3）；
3. 每页恰好一个 `## ` 二级标题，页内不出现 `###` 及更深的标题（层次只由 kicker + h2 + 正文承担）。

最小合法骨架：
```
::kicker[HOOK]
## 页标题

正文……

---

::kicker[NEXT]
## 收束

正文……
```
篇幅/页数（8-14 页、每页 ≤200 字）等软性教学法这里不强制拒绝，但仍是 verify gate 的检查项（`skills/workflow/lesson-prep.md`）。`update_lesson` 改 `content_markdown` 时挂的是同一套校验。

`:::trial` 块（随堂试炼）默认自由问答；加 `Options`（竖线分隔选项，如 `证券｜安保措施｜保障感`）→ 变点选按钮组单选即判，加 `Cloze: true` → `Question` 里的 `____` 变内联填空。两字段互斥，详见 `docs/LESSON-BLOCKS-v1.md` §2.3。
词汇类课程两条硬规矩:①随堂 trial 以识别型(Options 点选/Cloze 填空)为主,自由问答归课后习题区;②**必配一段融合阅读**——100-150 词的目标语短文,本批每个目标词都活在同一篇文本里,放 TRIAL 前的 EXAMPLE 页,要读起来像学习者真实世界的材料(市场简讯/邮件),不是塞词练习。(产品主理人立法 2026-07-12)

**互动组件的运用必须合乎逻辑且有效**(产品主理人立法 2026-07-12):每放一个组件前自问——它让学习者做了什么动作?这个动作服务本页刚教的哪个点?答不出就删。配对表:concept-flip 配 NAME(术语出生时)、formula 配 FORMULA、trial 配 TRIAL(只考本课刚教过的)、callout 配 TRAPS。trial 三律:①字段标签必须加粗(`**Question**:`——裸 `Question:` 解析器认不出,整块报废);②`Answer` 必填——"想清楚再翻页、下一页揭晓"是正文的修辞,不是 trial,悬念提问直接写进正文;③有 `Options` 时 Answer 必须是选项原文。

### 5. `add_concept` × N — 逐个补概念

**前置条件**：`lesson_id` 存在——这个工具**有**预检，lesson 不存在会返回 `code: NOT_FOUND`，`message: "Lesson {id} not found"`，`details: { lesson_id }`。`course_id` 不用传，服务端从 lesson 反查，防止 agent 挂错课。

**调用**：
```
add_concept({ lesson_id: "lsn_xxx", name: "Expenditure Approach", short_definition: "..." })
```

**预期返回**：
```json
{
  "status": "success",
  "operation": "add_concept",
  "resource_id": "cpt_xxx",
  "created_refs": { "concept_id": "cpt_xxx", "lesson_id": "lsn_xxx" },
  "next_recommended_actions": ["add_flashcard"],
  "human_note": "Created concept cpt_xxx"
}
```

### 6. `add_flashcard` × N — 配闪卡

**前置条件**：`deck_id` 是自由字符串，不需要提前建deck——deck 是"派生概念"，第一张卡写入时自然诞生。`concept_id` 可选，建议填上一步拿到的 `cpt_xxx`，否则 flashcard 与 concept 脱钩；此后，`concept_id` 若传入会查 `concepts` 表存在性，不存在直接 `code: VALIDATION`。`tags` 若传入必须是字符串数组（例如 `["GDP"]`），传裸字符串（`"GDP"`）会被拒——旧版本会把裸字符串原样落库，渲染层再把它拆成三个假标签，现在写入前就挡住。

**调用**：
```
add_flashcard({ deck_id: "cfa-econ", front: "...", back: "...", concept_id: "cpt_xxx", tags: ["GDP"] })
```

**预期返回**：
```json
{
  "status": "success",
  "operation": "add_flashcard",
  "resource_id": "fc_xxx",
  "created_refs": { "flashcard_id": "fc_xxx" },
  "human_note": "Created flashcard fc_xxx"
}
```
FSRS 初始状态由服务端生成，不需要 agent 算。

### 7. `add_exercise` × N — 配课后习题

**前置条件**：`lesson_id` 必须真实存在——**现在有预检**（闪卡练习合同链审计，2026-07-11 补上）：查 `lessons` 表，不存在直接 `code: VALIDATION`，`message` 里点名 `lesson_id 'xxx' 不存在`，指引去核对上一步 `add_lesson`/`create_course` 返回的真实 id，不要凭猜测拼。`expected_concepts` 若传入必须是字符串数组（同 `add_flashcard.tags` 的校验方式），且数组里每个 id 都会查 `concepts` 表存在性，悬空 id 会被列在报错里。`reference_answer` 必填，这是给 `grade_exercise` 后续批改用的参照答案，不是展示给学习者的"标准答案"。

> 历史记录已移至 recipe://first-contract-and-lesson.reference（`add_exercise` 预检的沿革，含预检机制的修复经过）。

**调用**：
```
add_exercise({ lesson_id: "lsn_xxx", order: 1, prompt: "...", reference_answer: "..." })
```

**预期返回**：
```json
{
  "status": "success",
  "operation": "add_exercise",
  "resource_id": "ex_xxx",
  "created_refs": { "exercise_id": "ex_xxx" },
  "human_note": "Created exercise ex_xxx"
}
```

**教材纪律**（学习者申诉成立后写进的军规，不是 MCP 层强制，但省下返工）：习题里出现的每一个必要构件，必须在这节课的 `content_markdown` 里被正名过。课文没教、习题超纲，判错的责任在教材不在学生。

### 8.（可选）`add_mindmap_seed` — 挂一张概念图

**默认不生成（脑图裁量条款，2026-07-21 立法）**：脑图种子为可选教具，默认不生成。仅当空间关系、因果关系或分支结构确实比文字更清楚时才生成（判断权归老师）。不为教具齐整而出图——不能改变学习者动作的教具，最先接受削减。决定要出图再往下读，画法见 [mindmap-authoring.md](./mindmap-authoring.md)。

**前置条件**：`lesson_id` 与 `course_id` 二选一，不能都传也不能都不传，否则 `code: VALIDATION`，`Exactly one of lesson_id or course_id is required`。传的那个 id 要真实存在——**有预检**，错了是 `code: NOT_FOUND`（`Lesson {id} not found` 或 `Course {id} not found`）。

**调用**：
```
add_mindmap_seed({
  title: "GDP 三法概念图",
  content: { nodes: [...], links: [...] },
  lesson_id: "lsn_xxx"
})
```

**预期返回**：
```json
{
  "status": "success",
  "operation": "add_mindmap_seed",
  "resource_id": "mm_xxx",
  "created_refs": { "mindmap_id": "mm_xxx", "association_id": "mma_xxx" },
  "learner_url": "/mindmap",
  "human_note": "Created mindmap mm_xxx + association mma_xxx → lesson lsn_xxx"
}
```
一次调用做完建图+挂关联两件事（同一数据库事务提交，不会留下"图建了、关联没建"的孤儿图），等价于 REST 两步的合并版。

### 交付前自检 —— 调 `verify_prep`

成套教具（课文/闪卡/习题，外加若生成了的脑图——脑图默认不生成，见第 8 步）交给学习者之前，调一次 MCP 工具 `verify_prep({ lesson_id: "lsn_xxx" })`：写入门禁（`add_lesson`/`add_flashcard`/`add_exercise`/`add_mindmap_seed`）各自只看单次调用，没人看"这一整套教具凑在一起自洽不自洽"——`verify_prep` 看的是全家福，逐课分区给出 `pass`/`warn`/`fail`/`skip` 判定（课文分页/kicker/高亮、闪卡数量与查重、习题引用、脑图拓扑——仅当配了脑图、跨件 concept 覆盖度）。只读，零写库。清掉每一条 ❌，⚠️ 逐条过目再收尾；传 `course_id` 可对整门课逐课批量跑。回执 `data` 里的 `publish_status`/`published_at` 顺带告诉你每节课发没发布——"验尺通过但尚未发布"就是下一步该干嘛的路牌。

### 8½. `publish_lesson` — 上架（草稿变学习者可见）

`add_lesson` 建的课是草稿（Publish Gate），学习者看不见——**每节课都要单独 `publish_lesson({ lesson_id })` 上架**。发布时服务端重跑同一套验尺，红灯未清零直接 `code: VALIDATION` 拒绝上架；幂等，重复发布不改首次 `published_at`。**回执即证明**：回执里那句"学习者现在可见"读的和学习者屏幕渲染的是同一面旗——确认可见性读回执就够，不要开浏览器目检（不要求、不期待、费 token）；只在回执缺失/矛盾或学习者报看不见时才升级目检，冲突时学习者屏幕是真相。（这一步曾经在清单里漏了三天，一整门课发进了虚空——解药是调用 publish，不是盯着像素。）

### 9. 学习者开学（没有 MCP 工具，UI 侧完成）

发布之后，学习者打开 `/lesson` → 选课程 → 进 `/courses/:courseId/lessons/:lessonId`，看到课文+习题+（如果有）脑图。到这一步，agent 侧的"一次调用交付一件完整教具"就算完成了。

---

## 常见失败与恢复（汇总）

| 失败 | 真相 | 恢复 |
|---|---|---|
| `code: NOT_FOUND`，`No active pair ...` | 数据库没有 active pair | 人类介入建 pair，agent 自己无法恢复 |
| `code: VALIDATION`，`goal is required` | propose_contract 缺 goal | 按 recovery_hint 补齐参数重调，无残留副作用 |
| `code: VALIDATION`，`lesson_id 'xxx' 不存在` | `add_exercise` 传了不存在的 `lesson_id`（写入前预检） | 核对上一步 `add_lesson` 返回的真实 id，不要凭猜测拼 id |
| `code: VALIDATION`，`course_id 'xxx' 不存在` | `add_lesson` 传了不存在的 `course_id`（写入前预检，2026-07-12 起追补；此前的 RETRYABLE/NOT_FOUND 两代旧貌见 reference 卷） | 核对上一步 `create_course` 返回的真实 id，不要凭猜测拼 id |
| `code: NOT_FOUND`，message 是 `Lesson {id} not found` / `Course {id} not found` | `add_concept`/`add_mindmap_seed` 有预检，`code` 是准的 | 照 `recovery_hint` 核对 id 重调即可 |
| 契约递交后 `get_context` 看不到它 | `proposed` 状态不算"当前契约" | 这是设计如此，不是 bug；等学习者签字，或调 `get_teacher_inbox` 看它有没有以 `contract_proposed` 出现 |

## 下一步

课上完之后，进入 [grade-attribute-revise.md](./grade-attribute-revise.md)（批改/归因/修订）；收尾闭环全流程见 [close-teaching-loop.md](./close-teaching-loop.md)。下次醒来续教，看 [resume-teaching.md](./resume-teaching.md)。

🖤
