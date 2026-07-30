# Lesson Blocks & Paging · v1

*课文格式基座的唯一真相（single source of truth）。*
*skill（workflow/lesson-prep · modality/* · domain/*）、verify gate、web 渲染器三方共同引用本文件。三方与本文件冲突时，以本文件为准；要改，先改这里。*
*2026-07-02 定稿*

---

## 0. 格式基座（本轮锁定）

**课文以 Markdown + directive 块编写与存储；HTML 只在渲染时由前端组件实时生成，不落库。**

```
agent 备课 (Markdown + directives)
  → DB 存 lesson.content_markdown（结构化内容）
  → web 渲染器解析（remark-gfm + remark-directive + 自定义组件）
  → 学生看到的 HTML/DOM（设计系统组件实时生成）
```

理由（决策记录）：

- 视觉住在渲染器组件里，不住在每节课的 HTML 里——组件定义一次，所有课继承；设计系统演进时历史课文自动焕新
- 结构化内容可验算、可抽概念、可高亮、可导出——per-lesson HTML 全部做不到
- Hub iOS 已验证同一产品语言（ConceptFlipModule / TrialModule / SortableTableModule）

此决定**替代** LESSON-PREP-BRIEF.md 中"课文用 HTML"的旧表述（该 brief 已同步修订）。

---

## 1. 翻页语义（Paging）

课文不是长滚动文档，是**逐页学习的课**。一页一件事——与 Live Teaching "一个 move 只做一件事" 同一产品哲学。

### 1.1 分页符

顶层 `---`（thematic break）= 分页。frontmatter 的 `---` 定界符在解析前剥离，不冲突。页内不再使用 `---`（需要视觉间隔用空行）。

### 1.2 页结构（硬约束）

每一页从上到下：

```
::kicker[FABLE]          ← 眉题（leaf directive，必须是页的第一行）
## 页标题                 ← 每页恰好一个标题（h2）
正文……                   ← ≤ 200 中文字（或等密度英文）
:::block …… :::          ← 至多一个交互块（可以没有）
```

- **每页一个核心信息点。** 塞不下就分页，宁可 12 页轻，不要 6 页重
- **每页至多一个交互块**
- 页内禁止二级以下标题堆叠（h3 及更深不使用；层次由 kicker + h2 + 正文承担）

### 1.3 Kicker 词表（九拍映射）

| Kicker | 拍 | 说明 |
|---|---|---|
| `HOOK` | 开场 | 为什么这个概念在考试和真实世界都重要（1 页） |
| `FABLE` | 寓言 | 感受概念，零术语（1-2 页） |
| `NAME` | 命名 | 双语术语 + 定义 + concept-flip（1 页） |
| `FORMULA` | 公式 | 先直觉后数学 + formula 块（1 页） |
| `EXAMPLE` | 实算 | 真实数据 worked example（1-2 页） |
| `TRIAL` | 试炼 | 学生动手，trial 块（1 页/块） |
| `TRAPS` | 陷阱 | 高频错误，callout 块（1 页） |
| `EXAM` | 考纲 | cfa-note 块（1 页；非考证课程省略） |
| `NEXT` | 明日 | 收束 + 钩子（1 页，必须是最后一页） |

- 顺序可微调、拍可复用（两个概念 = 两轮 FABLE→NAME→…），但**不许没有 FABLE/EXAMPLE 直接上 FORMULA**（fable-first 三层顺序是硬的）
- 渲染器在**最后一页**自动追加本课概念清单 + "进闪卡复习"入口，agent 不用手写（实现按"末页"判定，不认 kicker 名——`NEXT` 放末页两个语义即重合；勘误 2026-07-11：旧文写"NEXT 页"与实现不符）

### 1.4 篇幅预算

- 每课 **8–14 页**（对应 15–20 分钟）。超出 → 拆课；不足 → 并课
- 全课正文合计仍守 workflow/lesson-prep 的 800–1500 字预算

---

## 2. 交互块目录 v1（五种）

容器 directive 语法 `:::name … :::`；字段用行首加粗标签（`**Field**: value`），agent 好写、裸读可读、解析无歧义。v1 不嵌套。

### 2.1 `:::concept-flip` — 双语概念翻卡

```
:::concept-flip
**Front (CN)**: 间接法编制经营活动现金流
**Back (EN)**: Indirect Method for Cash Flow from Operations
**Definition**: 从净利润出发，逐项还原非现金与时间错配项，得到真实经营现金流。
:::
```

字段：`Front (CN)` `Back (EN)` 必填，`Definition` 必填（≤1 句）。渲染：点击翻面卡片。

### 2.2 `:::formula` — 公式面板

```
:::formula
**Rule**: CFO (indirect) = Net Income + D&A ± non-operating losses/gains − ΔWC (方向调整)
**Intuition**: 净利润是会计说你赚了多少；CFO 是银行账户真看到多少。
**Notation**:
- CFO: Cash Flow from Operations
- D&A: Depreciation & Amortization
- ΔWC: 营运资本变动
:::
```

字段：`Rule` 必填，`Intuition` 必填（先直觉后数学的顺序由 FORMULA 页正文保证），`Notation` 有符号即必填。渲染：等宽排版的公式区 + 符号表。v1 纯文本样式；KaTeX 留 v1.1。

### 2.3 `:::trial` — 随堂试炼

```
:::trial
**Question**: 净利润 $850，折旧 $120，应收增加 $60，应付增加 $35。CFO 是多少？
**Hint**: 先问每一项——现金真的动了吗，往哪个方向？
**Answer**: 850 + 120 − 60 + 35 = $945
:::
```

字段：`Question` 必填；`Hint` 可选；`Answer` 必填（学生作答/点开前不可见）。**不再使用 `initialAnswer` 字段**（旧约定作废——作答框始终从空开始）。渲染：答题框居中占版，答完或主动展开后显示 Answer；可跳过不锁页。

**`Expected` 可选（2026-07-04 加，判定规则 2026-07-30 修）**——机器可判的期望数值，分隔符收 `,` `;` `；` `，` `、`、顺序敏感；写几位小数就是声明几位精度（`7.70` 收 ±0.005，`6582` 收 ±0.5——整数期望容纳未凑整的原值）：

```
**Expected**: +120, -300, -40, -90, +65     ← 多空判定（五连标）
**Expected**: 1050                           ← 单值判定（整合题）
```

- 有 `Expected` → "Check answer" 执行真判定：从学生 draft 提取数值 token（unicode 减号规范化、剥 `$`；千分位逗号**仅在紧跟三位数字时**剥离——"120, 300" 是两个数不并号；空格不全局剥——它是无符号数的天然分隔，但"− 300"这类脱开的符号会粘回数字保住负号），**首选末尾 N 个**（N = Expected 项数，容忍演算过程的中间数字）与 Expected 顺序比对；末窗不中时向前扫任意连续 N 数窗口，窗内顺序永不放松（答完数值后续写带数字的总结句不再误伤）。会计括号负数 `(300)` 仅在对应 Expected 项为负时读作 −300——`(1)(2)(3)` 步骤编号照旧为正。全对 → correct；不对 → 作答框标红并直接掀 Answer（2026-07-30 裁决，不再出"第几项不符"文案）；空稿点 Check 同样框红掀 Answer，但不进判定引擎也不记 `trial.attempted`；一开始编辑就清红框
- 无 `Expected` → 现行为不变（reveal 自查）。**判定只适用于数值题**；文字题不加 Expected
- verify 清单联动：有 `Expected` 时其值必须与 `Answer` 的最终结果一致（备课 agent 自查）

**`Options` 可选（2026-07-12 加：题型选择住进课文模块）**——竖线分隔的选项列表（`|` 或全角 `｜` 皆可），`Answer` 填正确选项的原文：

```
:::trial
**Question**: "证券"最贴近的中文含义是？
**Options**: 证券｜安保措施｜保障感
**Answer**: 证券
:::
```

有 `Options` → 渲染成点选按钮组（单选），**点击即判**：选中项立刻按对错着色（现有语义色 `--ls-corroborated`/`--ls-risk`），答对锁页，答错可重选重试。无 `Options` → 现状自由问答，一个像素不变。

**`Cloze` 可选**——值为 `true` 时，`Question` 里 4 个以上连续下划线（`____`）渲染为内联输入框；判定为 trim 后与 `Answer` 精确比对（有多个空时 `Answer` 同样用 `|`/`｜` 分隔，按序对应每个空）：

```
:::trial
**Question**: The bond trades at a ____ to par.
**Cloze**: true
**Answer**: discount
:::
```

Cloze 复用 `Expected` 的判定管线（"Check answer"、答错标红空格并掀 Answer）。`Options`/`Cloze` 互斥使用，二者都不写则是现状自由问答。**语言类课程随堂 trial 以识别型（选择/填空）为主**；概念辨析/计算类课程仍以自由问答/数值 `Expected` 判定为主。

### 2.4 `:::callout` — 警示标注

```
:::callout{kind=trap}
60% 以上考生在这里翻车：应收**减少**是加回现金，不是减。方向想不清就回到"现金到底动没动"。
:::
```

`kind` 属性：`trap`（考试陷阱）/ `warn`(操作警告) / `info`(补充说明)，缺省 `info`。渲染：语义色左边条 + 图标区分。

### 2.5 `:::cfa-note` — 考纲注解（CFA 域专用）

```
:::cfa-note
**LOS FRA-3-c**: Compare the direct and indirect methods of presenting cash flow from operations.
**Depth**: compare
**In practice**: 考试常给间接法报表让你对回直接法。两个方向都要能走。
:::
```

字段：`LOS [code]`（官方原文）、`Depth`（describe/explain/calculate/compare）、`In practice`（1-2 句落地翻译）。其他考证域可仿此建 `:::jlpt-note` 等——但**渲染器的块名单是写死的白名单**（remarkLsBlocks 的 FIELD_BLOCKS/PROSE_BLOCKS），在本文件登记只是第一步，渲染器没注册之前写了就是 UNREGISTERED BLOCK。新块上线顺序：本文件登记 → 渲染器注册组件 → 才许在课文里用（勘误 2026-07-11：旧文只说"登记"，让人误以为登记即生效）。

### 2.6 原生 Markdown 保留

- 表格用 GFM 原生（旧 `:::table` 计划作废）
- `==高亮==` → 渲染为语义色 mark；**每课 3–5 处**，超发由 verify 打回
- `:::poll` `:::aside` 降级为 v1.1 候选，v1 不写不渲染

### 2.7 语法陷阱（作者防误伤清单，2026-07-11 真机回灌）

解析器有几个咬人的死角，写正文时避开：

1. **成对 `==` 只能表示高亮**——`x == y == z` 这类比较式的中段会被
   吞成 mark。等式/代码比较放进代码块或反引号。
2. **整行 3+ 连字符 = 分页符**——页内不许写 `---` 当视觉分隔线
   （§1.1 已禁，此处再记一笔：`***`/`___` 不受影响）。
3. **字段块（concept-flip/formula/trial/cfa-note）内只放规范字段**——
   块内每个 `**加粗**` 都会被当成字段起点，非字段散文会被静默丢弃；
   且字段名按前缀匹配（写 `**Background**` 会被误领成 Back 字段）。
   举例、强调、补充说明一律放块外正文。
4. `::kicker[...]` 必须**整行独占**，尾部不许带字，方括号内不许再有
   `]`——尾部带字该页即无眉题，全课无一页合法眉题会整课掉进自动
   分页兜底。
5. （历史案，已拆弹）`**标签**:值` 冒号贴字曾被裸 textDirective 语法
   咬走——渲染器已把行内指令整类还原为字面文本，此坑不再存在，但
   冒号后加空格仍是更清晰的写法。

---

## 3. 美学硬规则（verify 强制）

1. **考试语言保真**：考点术语在 NAME 层给出英文原词后，后文每次出现保持英文可见（首次后可"中文（English）"或直接英文）。考场语言是英文，中文只是桥。
2. **零 emoji、零装饰性符号**：课文正文不出现 emoji 与装饰字符。视觉情绪由设计系统组件承担。
3. **块密度**：每课交互块 ≥3 种（不同类型）；带块的页面 ≤ 总页数的 50%。块是标点，不是正文。
4. **高亮预算**：`==...==` 每课 3–5 处。
5. **寓言纪律**（承 fable-first）：FABLE 页零术语零公式；≤3 个角色；不写道德教训。

---

## 4. Frontmatter

```yaml
---
course: cfa
courseName: CFA Level 1 · FRA
order: 4                      # course 内序号（替代 Hub 的 day）
title: "现金流量表 · 间接法 — Cash Flow Statement, Indirect Method"
topic: FRA                    # 域自定（CFA: QM|EC|FRA|CF|EI|FI|DI|AI|PM|ET）
los_ids: ["FRA-3-c", "FRA-3-d"]   # 考证域必填
estimated_minutes: 18
---
```

---

## 5. Verify gate 检查清单（格式维度，本文件为准）

- [ ] 页数 8–14；每页恰好一个 `::kicker` + 一个 h2
- [ ] kicker 全部来自 §1.3 词表；`NEXT` 是最后一页；FORMULA 前存在 FABLE
- [ ] 每页正文 ≤200 字、交互块 ≤1
- [ ] 全部 `:::` 块正确闭合、必填字段齐全、类型在 v1 目录内
- [ ] `:::trial` 的 Answer 存在且 Question 自含作答所需全部数据
- [ ] 块 ≥3 种；带块页 ≤50%；`==高亮==` 3–5 处
- [ ] 正文零 emoji；NAME 层英文术语存在且后文保真
- [ ] frontmatter 完整（§4）

---

## 6. 渲染器契约（apps/web）

- 解析：`remark-gfm` + `remark-directive` + 自定义 `==mark==` 处理
- 分页：AST 根层 `thematicBreak` 切页；`::kicker` leaf directive → 眉题组件
- 组件：五种块各一个 React 组件，走 `--ls-*` token（黑白灰 + 语义色，Geist + 冬青黑体）
- 导航：左右键 / 点击翻页 + 底部细进度条 + 页码；TRIAL 页答题框居中
- 收束：`NEXT` 页自动附概念清单 + Review 入口
- 兜底：未知 directive 渲染为带"未注册块"标记的中性容器，不裸奔纯文本；页内极端溢出允许页内滚动（verify 应拦在前面）
- v1.1 预留：通览模式（同一内容渲染为可滚动全文，供考前检索），poll/aside，KaTeX

---

*本文件为写入格式的硬合同：改动需同步全部三方消费者（写入校验器/渲染器/本说明）。*

🖤
