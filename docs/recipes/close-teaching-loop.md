<!-- recipe_version: d9eb72ae80d3 · generated_at: 2026-07-28 · canonical: recipe://close-teaching-loop -->
# Recipe · 收尾闭环:批改到回执

> 给任何一位批改学习者作业的 agent 老师。与 resume-teaching 配成一对:那篇教你接棒,这篇教你收尾。**收尾没走完,课就没教完——你留下的烂尾,下一任老师要摸黑还债。**

事故史与设计缘由见 recipe://close-teaching-loop.reference——reference 版本未变时无需重读。

## 顺序(五步,一步不跳)

### 1. 批改 — `grade_exercise`
- 逐份提交批,`{submission_id, feedback, score?}`
- **feedback 引用学习者的原文作答**,不许泛泛("第二题不对"是差评,"你写的'流通性'是 liquidity 的地盘,float 是自由流通股本"才是批改)
- **score 是 0..1 软评分**——85% 写 `0.85`,写 `85` 会被打回
- 批改落笔即冻结该提交(反刍窗口关闭),所以**确认学习者已宣布学完再批**;没宣布的,等
- 成功回执随行 `closure_progress`(经 exercise 反查 lesson 锚)——批完一份就地看这节课的收尾还缺哪几笔

### 2. 归因 — 每节课都做,不止教学不奏效时
七类主因单选(详见 verify 技能 attribution-discipline):`not_yet_mastered / material_flaw / difficulty_timing / path_mismatch / judgment_error / weather / path_worked`(⑦路径适配、如预期奏效——全对的课选这个,唯一的成功归因分支,须写出奏效证据,禁止有真实问题时用它逃避归因)
- 反事实必答:"若真相是另一个最可信归因,我预期看到 X,实际看到 Y"
- 证据可指认:引用真实提交、真实时间
- weather 归因过期即焚:不写画像、不改教法

### 3. 课后评估 — `record_post_lesson_evaluation`
- **总评做增量,不复判——`agent_observation` 只装三样**:①整体判断 ②与 Live 表现的对照 ③下一课建议
- **永不逐题复述习题**:习题的判决在 grade_exercise 记录上,把 submission id 填进 `evidence_refs` 指过去即可,不把评语再写一遍
- **三通道分层(契约)**:`agent_observation` **会出现在学习者的折叠区("Teaching observation"),不是纯内账**(2026-07-26 学习者当面裁定收窄的口径)。所以内部 id(`sub_`/`tr_`/`evt_`/`snap_` 等机器词)**唯一合法归宿是 `evidence_refs`,不写进任何散文字段**——原先"写正文或 evidence_refs 二选一"的说法就此作废:学习者读得到的地方,就不写机器词。可选的 `learner_note` 是另开的人话版,**语言用 `learners.locale`**(get_context/get_learner_brief 的 `identity.learner.locale`;缺席时跟随她对话现场的语言。语言归学习者,风格归声纹)
- **证据引用义务(契约)**:`evidence_refs` 里的每个 id 必须真实存在且属本关系——服务端校验,幽灵引用 `VALIDATION` 拒并点名坏 id。证据先于叙事,引用不凭记忆拼
- 观察写具体行为不写形容词;如实保存事实(她按了什么、得了几分),差值不解读、不入前馈;契约含校准条款时除外
- 学习者的申诉/留言若核实为真,写明"已核实"并链接你做的修订

### 4. 教学反思 — `reflect_on_teaching`
- **顺序纪律:排在第 3 步之后**——`record_post_lesson_evaluation` 先行,
  `reflect_on_teaching` 殿后。反思要用全部证据,总评是那份证据的一部分;
  总评没写就先写反思,是拿半份牌面去归因。
  **说清口径:这是配方纪律,不是机器闸。** 收口只检查两者最终都在,不记录也不
  拒绝相反的写入顺序——反着写不会报错,只会让你自己少看一份牌。这条靠你守,
  没人替你拦
- **next_action 必填,写给下一任老师**——你接棒时若两手空空,就知道这条为什么是硬的
- 归因引用第 2 步;行动链接引用你实际做的修订(lesson revision id / mindmap id)
- 学习者假设(hypothesis)守三课阈值纪律:不满三课不立

### 5. 回执 — `close_lesson_loop`
- 入参 `{lesson_id, receipt?: [{kind, description, ref_id?}]}` —— **`receipt` 自 2026-07-26 起可选**（学习者侧的回执渲染卡 7/22 已退役，这份 changelog 目前没有读者）。**但传了就仍走全套校验**：kind 封闭枚举／description 非空／ref_id 须落在该 kind 的合法表／`LIVE_REF_NO_SUBSTANCE`，一条都没放松。**且有已完成 Live 课时它事实上仍是必填**——check ④ `LIVE_SNAPSHOT_UNREFERENCED` 的触发条件与回执无关，一旦触发，空回执拿不出可接受的 ref 就会被拒关（那条闸守的是证据链，不是那张退役的卡）。
- **kind 七种封闭枚举,一个不多**:`exercise_feedback / forward_revision / teacher_note / erratum / flashcard_change / hypothesis_update / journal_entry`
- **本轮实际动过的每一处落点,一条不漏地列**——回执是这轮收尾的 changelog(审计账 + 下一任老师的接力棒),漏一条就是留一个黑箱
- **回执不是判决书**:关课的职责是核对判决齐全(`closure_progress` 替你查),不是产生新判决。`exercise_feedback` 条目指认"某份提交已批改"并用 `ref_id` 指向 submission——评语和分数留在 grade_exercise 记录上,description 不重新评讲、不复述习题内容
- 成功后该课进入"已回课"终态,学习者课页以"已回课"药丸呈现(逐条 changelog 回执卡已从学习者 UI 退役——流水账动词对她零信息量;回执数据仍在库,记账义务不变)。**给学习者的收尾交代走人话通道**:收课回合的对话/补课简报里说清楚判了什么、改了什么,不指望 UI 替你转述

## 收课扫账(现场反馈笔)

反馈没有专用入口——**学习者的日常消息就是入口**,收尾前欠一次扫账:

1. **识别义务**:本轮她的消息(adhoc/Live/申诉)里凡是关于产品或教学的 issue/idea,`record_learner_feedback` 落账——`text` 存她的**原话逐字**,带当时上下文的锚(`lesson_id`/`live_session_id`/`exercise_id`/`source_message_ref`)。
2. **回执义务**:落账的同一回合告诉她"记下了"。
3. **收课扫账**:`close_lesson_loop` 之前回扫本轮全部对话,漏账的补记。

**软牙齿**:open 反馈只在 `get_teacher_inbox` 发光,**永不阻塞 `close_lesson_loop`**——扫账是义务,不是闸门;回应走 `update_feedback_status`(declined 必须带判词)。

## 一次判决原则(2026-07-21 立法)

**一份证据只判一次,判在它出生的地方;上层只引用与增量,不复判。** 习题的判决在 `grade_exercise`,Live 的判决锚在对话条目,总评只做增量:整体判断、与 Live 的对照、下一课建议。四份收尾文字里若有哪两份在复述同一次作答,说明有一层在越权重审——回到判决的出生地引用它,别重写它。

## 一次构思、四处落笔
`record_live_evaluation` / `record_post_lesson_evaluation` / `reflect_on_teaching` / `close_lesson_loop` 四个工具字段不同、语气不同,但不是四次独立的观察——课后先在脑内把这节课说清楚一遍(她学到了什么、证据是哪几次作答、你的判断是什么、下一步该练什么),想透了这一遍,再让四个工具各取所需落笔:**场评取现场**(这一场 Live 里发生了什么,判词锚到具体对话条目——随 `live_session_complete` 的 `evaluation` 字段同笔写,收课+场评一次动作)、**总评取增量**(整体判断、与 Live 表现的对照、下一课建议——引用习题判决,不逐题复述)、**反思取归因**(为什么会是这个结果,主因是七类里的哪一类)、**回执取交付**(本轮实际动过哪些落点,收尾的 changelog——记账与接力用,不重新评讲;学习者那头用人话交代,见第 5 步)。设计缘由(为什么按这个切法分工、防的是什么)见 recipe://close-teaching-loop.reference。

**四工具的成功回执都会带上 `closure_progress`**(`{completed, missing, next_required_action}`,写后重新装配)——第 1 步的 `grade_exercise` 也同款随行(一次复审里补上的,收尾链五笔从此一笔不缺)。写完一份就地看这节课卡在哪、下一步该调哪个工具,不用另外调 `get_lesson_closure_state` 问一遍。

**一个例外:`reflect_on_teaching` 只在这条反思挂得上 lesson 锚时才附 `closure_progress`。** 锚可以是你显式传的 `lesson_id`,也可以是服务端从现场上下文推断出来的(依次看 `live_session_id` 指向的场次 / 当前唯一 active 的 Live 教室 / 24h 内最近一场 Live 课;推断命中会在 `created_refs.anchored_lesson_id` 和 `human_note` 里明示)。推不出来就是无主反思:回执没有 `closure_progress`,只给一条警告。

**别把那条警告读成"这条反思作废了"。** 收口的 `reflection` 项走双轨取或:**精确轨**是这节课名下确有挂锚反思(`lesson_id` 等于本课,或 `lesson_id` 空但 `live_session_id` 指向本课挂过的某场 Live);**近似轨**是本 pair 最近一条反思(不问挂没挂锚)写在本 pair 最近一次关课之后——pair 一次课都没关过时,写过任意一条就算数。任一轨命中即满足,所以一条无主反思照样能把 `reflection` 顶绿,收口不会卡在这儿。

丢的是别的:这节课名下按课读回是空的(下一任老师只能靠 pair 级近似猜)、这一条会把本 pair 当下**所有**没关的课的 `reflection` 一起顶绿(包括你没反思过的那几节)、以及你当场看不到进度条。看到回执里没有进度条,别当成"没事"——不是这笔写废了,是这笔记错了人头。

## 改课三律(修订的落点边界)
1. 学习者**未开始**的课:自由改(forward_revision)
2. **学习中**的课:不动正文,只贴 teacher_note(`add_lesson_patch`)
3. **已学完**的课:永不重写,勘误走 erratum patch,原文留痕

## 阅卷铃义务
学习者宣告完成即是阅卷铃——收到召唤提示词后一次到访连做:对账→补判→
总评→反思→闭环→分岔→在召唤对话中回执(判了几题/总评落点/下一步)。
铃是学习者摇的,回音必须落回她耳朵。

## 收官分岔表
收官分岔前扫一眼在册假设:本课证据支持的 reinforce,被推翻的 revise/retire——引用证据不复述,一次判决原则照管(软义务,不拦收课;没有证据喂养的假设在简报里会读作 stale)。

闭环走完(五步 + 回执)之后,分岔只有三条,判据写死,不许自己发明第四条:

| 分支 | 判据 | 去向 |
|---|---|---|
| ①还有下一课 | 默认路径,无需额外判据 | **随学而备**——带着本课的体温备下一课 |
| ②本课暴露结构性缺口 | 总评的"下一课建议"指回**本课自身缺陷**而非新内容 | **修订补丁**(`add_lesson_patch`/`update_lesson`) |
| ③本课是合约覆盖的最后一课 | 契约进度对上"最后一课" | `goal_completion_ready`,挂结业信号等学习者点头 |

**分支③要先对账,别直接报喜。** `goal_completion_ready` 不是"数据库里暂时没有下一课"的副作用,是一道有前置的判断。`complete_contract` 会逐条查:①合约现役;②`covered_course_ids` 非空;③覆盖单里每门课的已发布课 learning 状态全部 ∈ `{completed_declared, closed}`,**且**该课定过 `planned_lesson_count`、已发布节数够那个数。任一条不满足,回执给结构化差额(`missing_planned_count` / `below_planned_count`,外加"哪门课还差几节未读完"的清单),不是一句"没教完"。

所以宣布结业之前,先看 `get_context` 的 `contract_progress` 对不对得上。最常见的两种卡壳都是建课那天欠下的:课没带 `contract_id`,覆盖单是空的(可以 `update_contract_coverage` 补挂);或者课没定 `planned_lesson_count`——**这一种补不了,已建课程没有补录入口**,门就卡死在那里。两笔都在 `create_course` 那一刀省下来的,见 [first-contract-and-lesson.md](./first-contract-and-lesson.md) 第 3 步。

**闪卡裁量**(声纹条款口吻,非强制):错题是最肥的卡源——判错的题值不值
一张针对性闪卡,由你裁量;回执里(`grade_exercise` 的 `concept_refs`)已经
替你备好 concept 锚,不用再走一遍 exercise→concept。

## 自检
- [ ] 每份已宣布学完的提交都有带原文引用的 feedback
- [ ] score 全部落在 0..1
- [ ] 反思里有 next_action,且下一任照它能直接开工
- [ ] 回执条目数 = 本轮实际落点数;kind 全在七种枚举内
- [ ] 一次判决:总评没有逐题复述习题;回执 description 没有重新评讲;同一次作答只在它的出生地被判过一次
- [ ] 学习者的每条留言/申诉都有回音(adhoc 回复或评估中注明)
- [ ] 收课扫账:本轮消息里的 issue/idea 都已 `record_learner_feedback` 落账并回执过(现场反馈笔;open 反馈不拦收课,但漏账拦不住良心)

🖤
