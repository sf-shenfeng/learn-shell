# Learn Shell · Skills (workflow 组合)

Markdown teaching skills the agent puts on when wearing the Learn Shell "teacher
hat" (TEACHING-SPEC-v1 §1, round 3 update).

## 四层 skill: orchestrator + teaching stack + pre-teaching + enforcement

```
skills/
├── workflow/    ── orchestrator — 整个 stack 的协调者
│                   unconditional FIRST in `_stack`
├── domain/      ┐
├── modality/    │
├── intensity/   ├─ 5 conditional facets — 按 contract 偏好选 0-1 份
├── tone/        │   from each category
├── pace/        ┘
├── intake/      ── pre-teaching — 教学之前 (no contract yet)
│                   pulled individually, NOT in `_stack`
└── verify/      ── enforcement gate — 备课最后一道闸
                    unconditional LAST in `_stack`
```

**Stack composition order in `_stack`:**

```
1. workflow/lesson-prep      ← orchestrator first (必装)
2. domain/...                ← conditional, by contract.goal
3. modality/...              ← conditional, by contract.content_modality
4. intensity/...             ← always
5. pace/... (TBD)            ← conditional
6. verify/content-verify     ← gate last (必装)
```

`workflow/lesson-prep.md` 告诉 agent 整个 stack 怎么协作 — hat 顺序, 协作哲
学, 备课产物 (课文 + 闪卡 + 习题 + 思维导图), 质量 bar, 修订循环, 红线. 不
含 domain/modality/intensity 的细则 — 那些在各 facet 文件里.

`intake/contract-establish.md` 是 learner 进 `/contract` 页时 agent 戴的
"intake host hat" — 主持对话, 推导 preference, 输出 contract 草案. 它不进
`_stack` 因为 stack 是 contract active 之后的事; 入口 agent 单独 pull
`intake/contract-establish`.

`verify/content-verify.md` 是备课流水线的最后一步 — 三维度交叉验证 (内容准
确性 / 格式完整性 / 来源可追溯). 不论前面用什么 domain / modality /
intensity 组合, 末尾都必须戴这个 hat. 不可跳过.

下面是 **conditional teaching stack** 部分.

## 组合, 不是 monolith

每份 contract 不是匹配**一份** skill, 而是 server 从 5 个分类各派 0-1 份组合成
一个 stack:

```
contract → server picker → [
  domain/teach-cfa.md,         ← 教什么
  modality/formula-first.md,   ← 怎么呈现
  intensity/hardcore.md,       ← 多硬
  tone/direct.md,              ← 口吻 (default 跳过让 agent soul 拿捏)
  pace/morning-burst.md,       ← 时段节奏 (optional)
] → MCP `_stack` prompt 一次性返回拼接 system prompt
```

每份 skill 只管自己 facet, **不重叠规则** — 这样不会冲突.

## 分类

| 目录 | 角色 | 厚度 | 含 example? | 派发依据 |
|---|---|---|---|---|
| `domain/`    | 教什么 (subject 知识 + 备考模式) | 200-400 行 | ✅ (sample lesson + exercise + feedback) | contract.goal keyword |
| `modality/`  | 怎么呈现 (跟 contract.content_modality 映射) | 40-80 行 | 偶尔 | contract.content_modality |
| `intensity/` | 多硬 (跟 contract.intensity 映射) | 30-60 行 | ❌ 规则为主 | contract.intensity |
| `tone/`      | 口吻 | 20-40 行 | ❌ | 当前不主动派 (留给 agent soul, 声纹条款同宗) |
| `pace/`      | 时段节奏 (optional) | 20-30 行 | ❌ | contract.preferred_time_of_day 多数派 |

## 冲突哲学

我们 **设计 skill 时就避免冲突** (Q7 from 产品主理人, 2026-06-29):
- domain skill 只讲 subject-specific 教学顺序 / 例子 / 边界
- modality skill 只讲呈现形式 (公式 / 图 / 类比), 不讲学什么
- intensity skill 只讲量级 (几道题 / 多少 challenge)
- tone skill 只讲口吻 (severity / playfulness), 不讲内容

→ skill 之间正交, 拼接不打架.

万一冲突 (将来某份 skill 不小心讲了别 facet 的事), **domain 优先** —
但优先解决方式是**改写 skill 让冲突不发生**, 不是建复杂 resolver.

## User 怎么改 skill

LS 不在这里写指引 (Q8 from 产品主理人, 2026-06-29). User 在自己 Claude Code CLI 里
让 agent 决定改哪份 .md 即可:

```
user (in CC): "把 CFA 的课更视觉化一点"
agent: 自己判断改 domain/teach-cfa.md 还是 modality/visual-heavy.md
       (LS 只暴露文件, 不替 user agent 思考)
```

改完即生效 — skill prompt 每次被读取时都从磁盘现读 (`mcp/server.ts`
`loadSkill`), 无需重启 server.

## 派发逻辑 (in apps/server/src/mcp/server.ts pickSkillStack)

```typescript
async function pickSkillStack(): Promise<SkillRef[]> {
  // 无 contract 参数 — 内部自己按 current pair 查 current contract
  const contract = await getCurrentContract(await getCurrentPairId());
  const stack = [];

  // workflow — unconditional first; orchestrator for the whole stack.
  stack.push({ category: 'workflow', name: 'lesson-prep' });

  // domain — goal keyword
  if (/cfa/.test(goal))                      stack.push({ category: 'domain', name: 'teach-cfa' });
  else if (/jlpt|toefl|ielts|language/...)   stack.push({ category: 'domain', name: 'teach-language' });
  else                                        stack.push({ category: 'domain', name: 'teach-general' });

  // modality — explicit only (mixed 跳过, agent 自己选)
  if (contract.content_modality === 'visual') stack.push({ category: 'modality', name: 'visual-heavy' });
  else if (contract.content_modality === 'text') stack.push({ category: 'modality', name: 'formula-first' });

  // intensity — always, falls back to 'standard' if unset
  stack.push({ category: 'intensity', name: contract.intensity ?? 'standard' });

  // tone — skip (agent soul); W2+ 加 contract 字段时激活

  // pace — conditional on preferred_time_of_day (morning / evening / afternoon
  // each map to their own pace skill); not skipped, just optional
  if (times.includes('morning'))      stack.push({ category: 'pace', name: 'morning-burst' });
  else if (times.includes('evening')) stack.push({ category: 'pace', name: 'evening-deep' });
  else if (times.includes('afternoon')) stack.push({ category: 'pace', name: 'lunch-quick' });

  // verify — unconditional enforcement gate; always last.
  stack.push({ category: 'verify', name: 'content-verify' });

  return stack;
}
```

## MCP Prompts 暴露方式

- 每份 .md 都是单独 prompt, name = `category/skill-name` (e.g. `domain/teach-cfa`)
- 额外一个 composite prompt `_stack` — server 据 active contract 实时拼接当前 stack
- agent 推荐用 `_stack` 一次拉; user 想 inspect 单份用 `category/skill-name`

## 当前状态 (2026-07-02 更新)

全部 23 份 skill 均为**真实内容, 无占位 stub**. 厚度分布 (不写死行数 —
内容持续在改, 数字很快过时; 看相对厚薄即可):
- `domain/teach-cfa.md` 最厚, 含 sample lesson + exercise + reflection;
  teach-language / teach-general 较薄, 等真有 user 学那个 subject 再加厚
- `workflow/lesson-prep.md` 是整个 stack 的 orchestrator, 篇幅居中;
  `verify/content-verify.md` 是备课流水线最后一道闸, 篇幅居中
- modality / intensity 是中短规则文; tone / pace 是 10 行上下的短
  modifier — 短是设计使然 (single-facet, stay in your lane), 不是未完成

课文格式基座 (Markdown + directive / 分页制 / 块目录) 的唯一真相在
`docs/LESSON-BLOCKS-v1.md` — skill 与 verify 引用它, 不各自复述.
