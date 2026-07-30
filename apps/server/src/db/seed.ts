// Minimal CFA "Time Value of Money" DEMO seed (样板间) for self-host bring-up.
//
// 首跑入学后定位收窄: 这是可选的展厅数据 (给装机头十分钟"证明活着"),
// 不是入学前置 —— 真入学走 MCP create_pair (唯一正门, 学习者先在首跑页亲手
// 登记名字)。本 seed 建的 pair 带 is_demo=true (迁移 0042), 默认 pair 选择
// 里永远排在真 pair 之后 (order by is_demo asc, established_at asc)。
// Lets `mode='live'` show real demo data after first migrate.
//
// 课文/闪卡/习题全部取自真教出来过的英文 TVM 课 (CFA L1 · Quantitative
// Methods 两课), 不是 lorem ipsum, 也不是为了 seed 现编的 —— 与 apps/web
// 的 seeded (无后端) 模式 fixture 是两套独立数据: fixture 演的是另一门课,
// 本 seed 演的是这门, 两边不互相导入 (apps/server 保持自足, 不跨 app 伸手
// 拿 TS)。
//
// Usage:
//   pnpm --filter @learn-shell/server db:seed:demo
// (旧名 db:seed 保留为 alias — README/SETUP/bench 候选包广泛引用)
// or
//   tsx src/db/seed.ts
//
// Safe to re-run — uses ON CONFLICT DO NOTHING throughout.
//
// Identity overrides (friend-package bring-up): IDs below (lrn_demo,
// agt_demo_claude_code, pair_demo_cfa, …) stay fixed — the demo course/
// lesson/flashcard/exercise rows and apps/web's PairProvider.tsx
// (SEEDED_PAIR_ID / SEEDED_LEARNER_ID fallback) all key off them. Only the
// human-facing display fields are overridable via env:
//   LS_LEARNER_NAME  — learner display_name          (default: "Learner")
//   LS_AGENT_NAME    — agent display_name             (default: "My Agent")
//   LS_TIMEZONE      — learner preferences.timezone   (default: "UTC")
//   LS_LOCALE        — learner preferences.locale      (default: "en")

// P1-02: apps/server/.env 真加载 — 必须排第一行, 早于任何会读 env 的
// import（下面 './client' 在模块加载时就读 DATABASE_URL 建连接池）。
import '../load-env';
import { db, closeDb } from './client';
import * as s from './schema';

const LEARNER_NAME = process.env.LS_LEARNER_NAME ?? 'Learner';
const AGENT_NAME = process.env.LS_AGENT_NAME ?? 'My Agent';
const TIMEZONE = process.env.LS_TIMEZONE ?? 'UTC';
const LOCALE = process.env.LS_LOCALE ?? 'en';

const T_BASE = '2026-06-26T13:00:00.000Z';
const tPlus = (mins: number): Date =>
  new Date(new Date(T_BASE).getTime() + mins * 60_000);
const tOffsetHours = (h: number): Date =>
  new Date(new Date(T_BASE).getTime() + h * 3_600_000);

// 课文正文 (分页格式见 docs/LESSON-BLOCKS-v1.md: 顶层 `---` 分页,
// 每页开头一行 `::kicker[NAME]`)。
const LESSON_1_MARKDOWN = `---
course: cfa
courseName: CFA Level I · Quantitative Methods
order: 1
title: "Time Value of Money — The Clock Inside Every Dollar"
topic: QM
los_ids: ["QM-1-a", "QM-1-b"]
estimated_minutes: 18
---

::kicker[HOOK]

## Money Keeps Time

Ask a trader what a dollar is worth and you will get a question back: a dollar *when*?

Every price you will ever value — a bond, a lease, a company, a pension promise — is a bundle of payments scattered across time. Before you can add them up, you have to bring them to the same moment. That single move, moving money across time, is the machinery under almost every number in this exam.

It is also the thing candidates lose points on for a small, embarrassing reason: they move the money in ==the wrong direction==. Not because the arithmetic is hard. Because the clock is easy to forget.

This lesson gives you the clock.

---

::kicker[FABLE]

## The Baker and the Jar

A baker keeps a jar of starter on the back shelf. Flour and water go in on Monday. She does nothing else.

By Friday the jar has doubled and is pushing at the lid. She did not add flour on Tuesday, Wednesday, or Thursday. What she added on Monday kept working while she slept — and what it produced kept working too.

Her neighbour asks for a cup of starter and promises to return a cup next month. The baker laughs and says: a cup next month is not a cup today. Give me back what a cup would have become.

---

::kicker[FABLE]

## Two Jars, Two Fridays

Now put two jars on the shelf.

The first jar was fed this Monday. The second is a photograph of a jar taken next spring, already risen, already full — a jar the baker will not be able to touch for eight months.

Which shelf space would you rather own? Everyone answers the same way, and everyone answers instantly. That instinct is not sentiment. It is a price, and it can be written down to the cent.

The jar teaches the whole idea before any symbol arrives: value depends on when.

---

::kicker[NAME]

## Present Value and Future Value

Two names carry the rest of this lesson.

**Present value (PV)** is what a future amount is worth today. **Future value (FV)** is what an amount today grows into by some later date. The bridge between them is the interest rate \`r\` — the price of waiting one period — and \`n\`, the number of periods you wait.

Growing money forward is **compounding**. Bringing money backward to today is **discounting**. Same road, opposite directions.

:::concept-flip
**Front**: Bringing a future amount back to what it is worth today
**Back**: Discounting (Present Value)
**Definition**: Dividing a future cash flow by the growth it would have earned over the waiting period.
:::

---

::kicker[FORMULA]

## The Same Road, Written Twice

Compounding multiplies. Discounting divides. Everything else is bookkeeping.

:::formula
**Rule**: FV = PV × (1 + r)^n  ·  PV = FV ÷ (1 + r)^n
**Intuition**: The starter jar grows on what it already grew. Going forward you multiply by that growth; going backward you strip it out.
**Notation**:
- PV: present value, the amount at time 0
- FV: future value, the amount at time n
- r: interest rate per period, in decimals
- n: number of compounding periods
:::

Notice that the two formulas are one formula. If you can state which side of the clock you are standing on, you never have to memorise the second.

---

::kicker[EXAMPLE]

## Forward: A Deposit That Waits

You put $1,000 into an account paying 6% a year and touch nothing for three years.

Year 1: 1,000 × 1.06 = 1,060.
Year 2: 1,060 × 1.06 = 1,123.60.
Year 3: 1,123.60 × 1.06 = ==1,191.02==.

Or in one step: 1,000 × 1.06³ = 1,191.02.

The extra $11.02 above simple interest of $180 is the part the exam cares about: interest earning interest. The jar feeding itself.

---

::kicker[EXAMPLE]

## Backward: A Payment That Is Promised

Now reverse the question. A contract promises you $1,191.02 three years from today, and the rate you could otherwise earn is 6%. What is that promise worth now?

PV = 1,191.02 ÷ 1.06³ = 1,000.

Read the operator, not the story: forward you multiply by (1.06)³, backward you divide by it. The two numbers you just computed are the same money photographed at two moments.

When a question hands you an amount that lives in the future and asks for value today, the growth factor belongs ==in the denominator==.

---

::kicker[TRIAL]

## Your Turn

Take your time. Write the operator down before you touch the arithmetic.

:::trial
**Question**: An insurer owes you $8,000 four years from today. Your required return is 5% per year. What is that obligation worth to you today, rounded to the nearest dollar?
**Hint**: Which moment does the $8,000 live in, and which moment does the question ask about?
**Expected**: 6582
**Answer**: PV = 8,000 ÷ (1.05)^4 = 8,000 ÷ 1.21550625 = $6,582.
:::

---

::kicker[TRAPS]

## Where Candidates Lose the Point

The error is almost never the arithmetic. It is the direction — and the sentence that causes it usually sounds reasonable: *the money is paid later, so interest has to be added on*. Waiting does have a price, but on a future amount that price has already been charged. The number in front of you is the grown one.

Two lines, said out loud, before any key is pressed:

:::callout{kind=trap}
First: which moment does the money live in, and which moment does the question ask about? Earlier target, divide. Later target, multiply.

Second: after computing, look at the size of what you got. Asked for value today at a positive rate, the answer must come out smaller than the future amount. An answer that grew means the road was walked forward. A promise of $12,000 in five years is worth less than $12,000 today — always, with no exception you will meet in this exam.
:::

---

::kicker[EXAM]

## What the Exam Actually Asks

:::cfa-note
**LOS QM-1-a**: Interpret interest rates as required rates of return, discount rates, or opportunity costs.
**Depth**: explain
**In practice**: The same rate wears three hats in one vignette. When it discounts a promised payment it is a discount rate; when it prices your patience it is a required return; when it names what you gave up it is an opportunity cost. The arithmetic never changes — only the sentence around it.
:::

---

::kicker[NEXT]

## Next: Money That Arrives in a Stream

One payment, one move. But bonds pay coupons every period, leases charge rent every month, and pensions pay for a lifetime.

Next lesson takes the single move you just learned and repeats it — a stream of equal payments, valued in one line instead of forty. The name for that stream is an ==annuity==, and once the clock is in your hand it is a short walk.

Bring the direction rule with you. It is the whole exam in one sentence: state the moment first, then compute.`;

const LESSON_2_MARKDOWN = `---
course: cfa
courseName: CFA Level I · Quantitative Methods
order: 2
title: "Annuities — One Move, Repeated"
topic: QM
los_ids: ["QM-1-c", "QM-1-d"]
estimated_minutes: 17
---

::kicker[HOOK]

## Forty Payments, One Line

A five-year lease is sixty payments. A thirty-year mortgage is three hundred and sixty. A pension is a promise that ends only when the person does.

You already know how to value any one of them: pick the moment, divide, done. Doing that sixty times is not hard, it is just slow — and an exam that gives you ninety seconds per question is not testing your patience.

So this lesson does not teach you a new move. It teaches you how to ==do the old move all at once==, and how to know which of the two versions of "all at once" a question is asking for.

---

::kicker[FABLE]

## The Orchard That Pays Every Autumn

A woman inherits an orchard that yields the same harvest every autumn for twelve years, then is cleared for a road.

A neighbour offers to buy it. He does not walk the rows counting trees. He sits down and asks a different question: what would I have to put in the bank today so that it would hand me exactly this harvest every autumn for twelve years, and be empty at the end?

Whatever that number is, that is what the orchard is worth to him. Not the trees. The stream.

---

::kicker[FABLE]

## The Autumn That Came Early

Her cousin inherits the neighbouring orchard, identical in every way but one: his trees fruit in early spring, at the start of each year rather than the end.

Twelve harvests, same size, same soil, same twelve years. Yet his orchard is worth more, and it is worth more for a reason that has nothing to do with farming: every one of his harvests arrives ==one full year earlier== than hers.

Same stream, shifted one step toward today. That shift has a price, and the price is exactly one year of interest on the whole thing.

---

::kicker[NAME]

## Ordinary, or Due

A stream of equal payments made at equal intervals is an **annuity**. Two flavours, and the only difference is where in the period the payment lands.

An **ordinary annuity** pays at the *end* of each period — the woman's orchard, and the default in almost every exam question. An **annuity due** pays at the *beginning* — the cousin's orchard, and the standard for rent and insurance premiums.

:::concept-flip
**Front**: Equal payments that land at the beginning of each period rather than the end
**Back**: Annuity due
**Definition**: An annuity whose payments each arrive one period earlier, making it worth exactly (1 + r) times the otherwise identical ordinary annuity.
:::

---

::kicker[FORMULA]

## The Stream, Collapsed

Discounting sixty payments one at a time gives the right answer. The closed form gives the same answer in one line, because the sixty terms are a geometric series and a geometric series has a sum.

:::formula
**Rule**: PV(ordinary) = PMT x [1 − (1 + r)^−n] / r  ·  PV(due) = PV(ordinary) x (1 + r)
**Intuition**: The bracket is a price tag on the whole stream: how many payments-worth of value n discounted payments actually add up to. Paying at the start of each period moves every payment one step closer to today, which is worth one period of growth on the lot.
**Notation**:
- PMT: the equal payment, one per period
- r: interest rate per period, in decimals
- n: number of payments, not number of years
:::

---

::kicker[EXAMPLE]

## A Lease, Priced

A tenant will pay $9,000 at the end of each year for five years. Your required return is 8%.

Bracket first: 1 − (1.08)^−5 = 1 − 0.680583 = 0.319417. Divide by r: 0.319417 / 0.08 = 3.992710.

Then the payment: 9,000 x 3.992710 = $35,934.39.

That factor, 3.9927, is worth reading rather than just using. Five payments of a dollar each, spread over five years, are worth just under four dollars today. ==The last one is worth the least==, and that is the whole idea of the stream in a single number.

---

::kicker[EXAMPLE]

## The Same Lease, Paid in Advance

Now the tenant pays each year's rent on the first day instead of the last. Nothing else changes.

Every one of the five payments now arrives a year earlier, so the whole stream is worth one year of growth more:

35,934.39 x 1.08 = $38,809.14.

You do not rebuild the calculation. You multiply the ordinary answer by (1 + r) once, at the end. If a question mentions rent, insurance, or "payments at the beginning of the period", that final multiplication is the entire difference between full marks and a near miss.

---

::kicker[TRIAL]

## Your Turn

Read the timing words before you read the numbers.

:::trial
**Question**: A savings plan pays $4,000 at the end of each year for six years. At 5% per year, what is the plan worth today? Round to the nearest dollar.
**Hint**: Build the bracket first, divide by r, then apply the payment. Nothing here shifts to the beginning of the period.
**Expected**: 20303
**Answer**: PV = 4,000 x [1 − (1.05)^−6] / 0.05 = 4,000 x 5.075692 = $20,303.

:::

---

::kicker[TRAPS]

## Where the Marks Leak

:::callout{kind=trap}
Three leaks, in order of how often they show up. First, n counts payments, not years — a monthly stream over four years has n = 48, and r becomes the monthly rate. Second, the timing words are load-bearing: "at the beginning of each period", "rent", "premium" all mean annuity due, and the answer needs its final (1 + r). Third, the direction rule from the last lesson still applies to the whole stream — a present value that comes out larger than the sum of the payments means the road was walked forward.
:::

---

::kicker[EXAM]

## What the Exam Actually Asks

:::cfa-note
**LOS QM-1-c**: Calculate and interpret the present value of a series of equal cash flows, including ordinary annuities and annuities due.
**Depth**: calculate
**In practice**: Vignettes rarely say "ordinary annuity". They say "rent, payable in advance" or "the first payment is made today", and expect you to translate. Read the timing sentence twice before touching the keypad.
:::

---

::kicker[NEXT]

## Next: A Stream That Never Ends

Take the annuity and let n run to infinity. Most of the formula collapses, and what is left is short enough to write on a thumbnail: PMT / r.

That is a perpetuity, and it prices preferred shares, ground rents, and every exam question that begins "assume the payment continues indefinitely". After that we tilt it: a stream that grows a little every period.

Bring the timing habit with you. The formula is short; the sentence that tells you which formula is not.`;

console.log('[seed] starting…');

// -- identity ----------------------------------------------------------------
await db
  .insert(s.learners)
  .values({
    id: 'lrn_demo',
    display_name: LEARNER_NAME,
    preferences: { timezone: TIMEZONE, locale: LOCALE },
    created_at: new Date('2026-05-18T00:00:00.000Z'),
  })
  .onConflictDoNothing();

await db
  .insert(s.agents)
  .values({
    id: 'agt_demo_claude_code',
    display_name: AGENT_NAME,
    provider: 'claude-code-cli',
    model_family: 'claude',
    capabilities: ['web_search', 'file_read', 'mcp_call'],
    identity_note: null,
    created_at: new Date('2026-05-18T00:00:00.000Z'),
  })
  .onConflictDoNothing();

await db
  .insert(s.learner_agent_pairs)
  .values({
    id: 'pair_demo_cfa',
    learner_id: 'lrn_demo',
    agent_id: 'agt_demo_claude_code',
    established_at: new Date('2026-05-18T00:00:00.000Z'),
    active: true,
    // 样板间户口 (迁移 0042): demo pair 永远不与真 pair 抢"当前关系"。
    // 注意 onConflictDoNothing — 已存在的旧 pair_demo_cfa 行不会被本次
    // 重跑改写成 demo (存量库里它是不是样板间由部署方判断, seed 不武断)。
    is_demo: true,
  })
  .onConflictDoNothing();

// -- contract (round 2 full fields) -----------------------------------------
await db
  .insert(s.teaching_contracts)
  .values({
    id: 'tc_demo_cfa_v1',
    pair_id: 'pair_demo_cfa',
    version: 1,
    goal: 'Pass CFA Level 1 in February 2027',
    time_range: {
      start: '2026-05-18T00:00:00.000Z',
      end_target: '2027-02-28T00:00:00.000Z',
    },
    success_criteria: [
      'Pass CFA Level 1 official exam',
      'Maintain 80%+ FSRS retention on core concepts',
    ],
    agent_read_scopes: [
      'pair://contract',
      'pair://learner/profile',
      'pair://courses',
      'pair://flashcards/*',
      'pair://reviews/due',
      'pair://learning-sessions',
    ],
    agent_write_scopes: ['create_course', 'add_lesson', 'add_flashcard', 'record_review'],
    feedback_tone: {
      reminders: 'gentle',
      questioning: 'persistent',
      correction: 'direct',
      encouragement: 'sparing',
    },
    human_approval_required: ['hypothesis.proposed'],
    forbidden_observations: ['general_personality_traits'],
    // 迁移 0030: teaching_contracts.active 列拆除 — 不再有这个字段可写.
    intensity: 'standard',
    interaction_mode: 'hybrid',
    content_modality: 'mixed',
    weekly_capacity_hours: 8,
    preferred_time_of_day: ['evening'],
    accepts_reminders: true,
    reminder_channels: ['in_app', 'ical'],
    reminder_types: ['lesson_due', 'review_due', 'feedback_invitation'],
    do_not_disturb: { start: '22:00', end: '07:00' },
    ical_subscription_url: 'http://localhost:3000/api/u/cfa-demo-token.ics',
    setup_status: 'ready',
    setup_started_at: new Date('2026-06-25T08:30:00.000Z'),
    setup_completed_at: new Date('2026-06-25T08:32:34.000Z'),
    setup_steps: [
      { name: 'parse_goal', status: 'done', duration_ms: 8000 },
      { name: 'read_materials', status: 'done', duration_ms: 23000 },
      { name: 'select_skill', status: 'done', duration_ms: 2000 },
      { name: 'draft_lesson_1', status: 'done', duration_ms: 42000 },
      { name: 'gen_flashcards', status: 'done', duration_ms: 31000 },
      { name: 'write_exercises', status: 'done', duration_ms: 28000 },
      { name: 'sketch_mindmap', status: 'done', duration_ms: 15000 },
      { name: 'verify', status: 'done', duration_ms: 5000 },
    ],
    created_at: new Date('2026-05-18T00:00:00.000Z'),
    updated_at: new Date(T_BASE),
  })
  .onConflictDoNothing();

// -- course + 2 lessons ------------------------------------------------------
await db
  .insert(s.courses)
  .values({
    id: 'crs_cfa_tvm',
    pair_id: 'pair_demo_cfa',
    topic: 'CFA L1 — Time Value of Money',
    description:
      'The single move that sits under every valuation in Level I: carrying money across time, forward and back, and knowing which direction a question is asking for.',
    structure: { lesson_ids: ['lsn_tvm_clock', 'lsn_tvm_annuities'] },
    generated_by_agent_id: 'agt_demo_claude_code',
    generated_from: [
      { type: 'web', url: 'https://www.cfainstitute.org/programs/cfa/curriculum', confidence: 1 },
    ],
    syllabus_version: '2027',
    // 迁移 0030: courses.review_status 列拆除 — 不再有这个字段可写.
    created_at: new Date('2026-06-25T09:00:00.000Z'),
    updated_at: new Date(T_BASE),
  })
  .onConflictDoNothing();

await db
  .insert(s.lessons)
  .values([
    {
      id: 'lsn_tvm_clock',
      course_id: 'crs_cfa_tvm',
      order: 1,
      title: 'Time Value of Money — The Clock Inside Every Dollar',
      content_markdown: LESSON_1_MARKDOWN,
      concept_ids: [
        'cpt_time_value',
        'cpt_pv_fv',
        'cpt_compounding',
        'cpt_discounting',
        'cpt_rate_three_hats',
      ],
      source_refs: [],
      estimated_minutes: 18,
      skill_used: 'lesson-prep',
      // seed 的课必须对学习者可见: publish_lesson 发布路径只写这一列
      // (mcp/server.ts publish_lesson case — 无 publish_status 等旁列), seed
      // 照同一语义补上, 否则 published_at 留空 = 草稿态, 学习者书架
      // (routes/read.ts 的 isNotNull(lessons.published_at) 过滤) 永远看不见
      // 演示课, self-host 装完首屏空书架。
      published_at: new Date('2026-06-25T09:05:00.000Z'),
    },
    {
      id: 'lsn_tvm_annuities',
      course_id: 'crs_cfa_tvm',
      order: 2,
      title: 'Annuities — One Move, Repeated',
      content_markdown: LESSON_2_MARKDOWN,
      concept_ids: ['cpt_ordinary_annuity', 'cpt_annuity_due', 'cpt_annuity_factor'],
      source_refs: [],
      estimated_minutes: 17,
      skill_used: 'lesson-prep',
      published_at: new Date('2026-06-25T09:10:00.000Z'),
    },
  ])
  .onConflictDoNothing();

// -- concepts (8) -------------------------------------------------------------
await db
  .insert(s.concepts)
  .values([
    {
      id: 'cpt_time_value',
      lesson_id: 'lsn_tvm_clock',
      course_id: 'crs_cfa_tvm',
      name: 'Time value of money',
      short_definition:
        "A dollar available today is worth more than the same dollar promised later, because today's dollar can be put to work while the promise waits.",
      source_refs: [],
      flashcard_ids: ['fc_fair_swap'],
    },
    {
      id: 'cpt_pv_fv',
      lesson_id: 'lsn_tvm_clock',
      course_id: 'crs_cfa_tvm',
      name: 'Present value and future value',
      short_definition:
        'PV is what a future amount is worth today; FV is what an amount today grows into by a later date. The bridge between them is the rate r and the number of periods n.',
      source_refs: [],
      flashcard_ids: ['fc_denominator'],
    },
    {
      id: 'cpt_compounding',
      lesson_id: 'lsn_tvm_clock',
      course_id: 'crs_cfa_tvm',
      name: 'Compounding',
      short_definition:
        'Carrying an amount forward in time by multiplying it by (1 + r) once for every period it waits, so that earned interest starts earning too.',
      source_refs: [],
      flashcard_ids: ['fc_compounding'],
    },
    {
      id: 'cpt_discounting',
      lesson_id: 'lsn_tvm_clock',
      course_id: 'crs_cfa_tvm',
      name: 'Discounting',
      short_definition:
        'Carrying a future amount back to today by dividing out the growth it would have earned while waiting.',
      source_refs: [],
      flashcard_ids: ['fc_direction', 'fc_say_it_first'],
    },
    {
      id: 'cpt_rate_three_hats',
      lesson_id: 'lsn_tvm_clock',
      course_id: 'crs_cfa_tvm',
      name: 'Required return, discount rate, opportunity cost',
      short_definition:
        'Three names the same interest rate wears, depending on what the sentence around it is doing.',
      source_refs: [],
      flashcard_ids: ['fc_three_hats'],
    },
    {
      id: 'cpt_ordinary_annuity',
      lesson_id: 'lsn_tvm_annuities',
      course_id: 'crs_cfa_tvm',
      name: 'Ordinary annuity',
      short_definition:
        'A stream of equal payments made at equal intervals, each one landing at the end of its period.',
      source_refs: [],
      flashcard_ids: ['fc_annuity_factor'],
    },
    {
      id: 'cpt_annuity_due',
      lesson_id: 'lsn_tvm_annuities',
      course_id: 'crs_cfa_tvm',
      name: 'Annuity due',
      short_definition:
        'The same stream shifted one period earlier, worth exactly (1 + r) times the otherwise identical ordinary annuity.',
      source_refs: [],
      flashcard_ids: ['fc_annuity_due'],
    },
    {
      id: 'cpt_annuity_factor',
      lesson_id: 'lsn_tvm_annuities',
      course_id: 'crs_cfa_tvm',
      name: 'Present value annuity factor',
      short_definition:
        'The bracket [1 - (1 + r)^-n] / r: how many payments-worth of value n discounted payments add up to.',
      source_refs: [],
      flashcard_ids: ['fc_periods_not_years'],
    },
  ])
  .onConflictDoNothing();

// -- flashcards (9: L1 六张 / L2 三张) ---------------------------------------
// 九张全部是"从未复习过的新卡" —— 与 lib/fsrs.ts 的 newCardState() 同形
// (review_count 0 / last_review_at null / state 0)。其中六张 due 落在 seed
// 固定时钟 T_BASE 上, 另三张 due 落在 T_BASE ±(2h/1h/6h) 上, 只为错开到期
// 时间点 (让 Review 页开箱就有到期卡, 且到期顺序有先后), 不代表已有复习史。
// 发布包是"备好但还没上过的课": 不写 submission、不写批改、不写闭环回执,
// 卡的复习史也不无中生有。
const NEW_CARD_STATE = {
  due_at: T_BASE,
  stability: 0,
  difficulty: 0,
  last_review_at: null,
  review_count: 0,
  retrievability: 1,
  state: 0,
  lapses: 0,
  scheduled_days: 0,
};

await db
  .insert(s.flashcards)
  .values([
    {
      id: 'fc_fair_swap',
      pair_id: 'pair_demo_cfa',
      concept_id: 'cpt_time_value',
      deck_id: 'deck_tvm_core',
      front: 'A friend offers you $500 now or $500 on this date next year. Why is that not a fair swap?',
      back: "Today's $500 can be put to work for a year; the promise cannot. The gap between them is the interest the money could have earned while waiting.",
      tags: ['tvm', 'time-value'],
      source_refs: [],
      fsrs_state: NEW_CARD_STATE,
      created_at: new Date('2026-06-25T09:30:00.000Z'),
      updated_at: tPlus(0),
    },
    {
      id: 'fc_denominator',
      pair_id: 'pair_demo_cfa',
      concept_id: 'cpt_pv_fv',
      deck_id: 'deck_tvm_core',
      front:
        'A payment lands four years from today and you need its value now. Where does the growth factor go?',
      back: 'In the denominator: PV = FV / (1 + r)^4. Dividing strips out growth the money never got to earn.',
      tags: ['tvm', 'discounting'],
      source_refs: [],
      fsrs_state: NEW_CARD_STATE,
      created_at: new Date('2026-06-25T09:30:00.000Z'),
      updated_at: tPlus(0),
    },
    {
      id: 'fc_say_it_first',
      pair_id: 'pair_demo_cfa',
      concept_id: 'cpt_discounting',
      deck_id: 'deck_tvm_core',
      front:
        'Before you compute anything in a time-value question, what one sentence do you say out loud?',
      back: 'Which moment does the money live in, and which moment am I being asked for? Answer that, and multiply-or-divide picks itself.',
      tags: ['tvm', 'direction'],
      source_refs: [],
      fsrs_state: NEW_CARD_STATE,
      created_at: new Date('2026-06-25T09:30:00.000Z'),
      updated_at: tPlus(0),
    },
    {
      id: 'fc_three_hats',
      pair_id: 'pair_demo_cfa',
      concept_id: 'cpt_rate_three_hats',
      deck_id: 'deck_tvm_core',
      front: 'The same 6% shows up three times in one vignette. Name the three hats it wears.',
      back: 'Required return (the price of your patience), discount rate (what values a promise today), opportunity cost (what you gave up by waiting).',
      tags: ['tvm', 'rates'],
      source_refs: [],
      fsrs_state: NEW_CARD_STATE,
      created_at: new Date('2026-06-25T09:30:00.000Z'),
      updated_at: tPlus(0),
    },
    {
      id: 'fc_annuity_factor',
      pair_id: 'pair_demo_cfa',
      concept_id: 'cpt_ordinary_annuity',
      deck_id: 'deck_tvm_core',
      front:
        'A tenant pays $9,000 at the end of each year for five years, and you want its value today at 8%. Which factor do you build first?',
      back: 'The annuity factor: [1 - (1.08)^-5] / 0.08 = 3.9927. Then multiply by the payment: 9,000 x 3.9927 = $35,934.',
      tags: ['tvm', 'annuity'],
      source_refs: [],
      fsrs_state: NEW_CARD_STATE,
      created_at: new Date('2026-06-25T09:30:00.000Z'),
      updated_at: tPlus(0),
    },
    {
      id: 'fc_periods_not_years',
      pair_id: 'pair_demo_cfa',
      concept_id: 'cpt_annuity_factor',
      deck_id: 'deck_tvm_core',
      front: 'Monthly payments for four years at a 6% annual rate. What are n and r?',
      back: 'n = 48 payments and r = 0.5% per month. The factor counts payments and periods, never years.',
      tags: ['tvm', 'annuity'],
      source_refs: [],
      fsrs_state: NEW_CARD_STATE,
      created_at: new Date('2026-06-25T09:30:00.000Z'),
      updated_at: tPlus(0),
    },
    {
      id: 'fc_compounding',
      pair_id: 'pair_demo_cfa',
      concept_id: 'cpt_compounding',
      deck_id: 'deck_tvm_core',
      front: '$1,000 at 6% a year, untouched for three years — in one line, no year-by-year table.',
      back: '1,000 x 1.06^3 = 1,191.02. Multiply by (1 + r) once for every period the money waits.',
      tags: ['tvm', 'compounding'],
      source_refs: [],
      fsrs_state: {
        due_at: tOffsetHours(-2).toISOString(),
        stability: 0,
        difficulty: 0,
        last_review_at: null,
        review_count: 0,
        retrievability: 1,
        state: 0,
        lapses: 0,
        scheduled_days: 0,
      },
      created_at: new Date('2026-06-25T09:30:00.000Z'),
      updated_at: tPlus(0),
    },
    {
      id: 'fc_annuity_due',
      pair_id: 'pair_demo_cfa',
      concept_id: 'cpt_annuity_due',
      deck_id: 'deck_tvm_core',
      front: 'A vignette says rent is payable in advance. What does that cost you if you miss it?',
      back: 'One period of growth on the whole stream. Payments at the beginning mean an annuity due: value the ordinary annuity first, then multiply once by (1 + r).',
      tags: ['tvm', 'annuity-due'],
      source_refs: [],
      fsrs_state: {
        due_at: tOffsetHours(1).toISOString(),
        stability: 0,
        difficulty: 0,
        last_review_at: null,
        review_count: 0,
        retrievability: 1,
        state: 0,
        lapses: 0,
        scheduled_days: 0,
      },
      created_at: new Date('2026-06-25T09:30:00.000Z'),
      updated_at: tPlus(0),
    },
    {
      id: 'fc_direction',
      pair_id: 'pair_demo_cfa',
      concept_id: 'cpt_discounting',
      deck_id: 'deck_tvm_core',
      front:
        'You were asked for value today and your answer came out larger than the future payment. What happened?',
      back: 'You multiplied where you should have divided — the road was walked forward instead of back. Value today is always smaller when the rate is positive.',
      tags: ['tvm', 'direction'],
      source_refs: [],
      fsrs_state: {
        due_at: tOffsetHours(6).toISOString(),
        stability: 0,
        difficulty: 0,
        last_review_at: null,
        review_count: 0,
        retrievability: 1,
        state: 0,
        lapses: 0,
        scheduled_days: 0,
      },
      created_at: new Date('2026-06-25T09:30:00.000Z'),
      updated_at: tPlus(0),
    },
  ])
  .onConflictDoNothing();

// -- exercises (4: Lesson 1 三道 / Lesson 2 一道, standard intensity) --------
await db
  .insert(s.exercises)
  .values([
    {
      id: 'ex_l1_1',
      lesson_id: 'lsn_tvm_clock',
      order: 1,
      prompt:
        'You deposit $2,500 today into an account paying 4% compounded annually and touch nothing for five years. What is the balance at the end of year five? Name the operator you used before you compute.',
      reference_answer:
        'Forward move, so multiply: FV = 2,500 x (1.04)^5 = 2,500 x 1.2166529 = $3,041.63.',
      expected_concepts: ['cpt_compounding'],
      agent_skill_used: 'lesson-prep',
      created_at: new Date('2026-06-25T09:30:00.000Z'),
      updated_at: new Date('2026-06-25T09:30:00.000Z'),
    },
    {
      id: 'ex_l1_2',
      lesson_id: 'lsn_tvm_clock',
      order: 2,
      prompt:
        'A lease obliges you to pay $12,000 in a single payment five years from today. Your discount rate is 7% per year. What is that obligation worth today? Say which moment the $12,000 lives in and which moment the question asks about, then compute.',
      reference_answer:
        'The $12,000 lives at year five; the question asks for today. Backward move, so divide: PV = 12,000 / (1.07)^5 = 12,000 / 1.4025517 = $8,555.83. The answer must be smaller than $12,000 whenever the rate is positive.',
      expected_concepts: ['cpt_discounting', 'cpt_time_value'],
      agent_skill_used: 'lesson-prep',
      created_at: new Date('2026-06-25T09:30:00.000Z'),
      updated_at: new Date('2026-06-25T09:30:00.000Z'),
    },
    {
      id: 'ex_l1_3',
      lesson_id: 'lsn_tvm_clock',
      order: 3,
      prompt:
        'One vignette quotes a single rate of 6%. In one sentence each, describe that 6% as a required return, as a discount rate, and as an opportunity cost. No arithmetic.',
      reference_answer:
        'As a required return it is the minimum an investor demands for parting with money for a year. As a discount rate it is the divisor that converts a promised future amount into value today. As an opportunity cost it is what the money would have earned in the next best use that was given up.',
      expected_concepts: ['cpt_rate_three_hats'],
      agent_skill_used: 'lesson-prep',
      created_at: new Date('2026-06-25T09:30:00.000Z'),
      updated_at: new Date('2026-06-25T09:30:00.000Z'),
    },
    {
      id: 'ex_l2_1',
      lesson_id: 'lsn_tvm_annuities',
      order: 1,
      prompt:
        'An office lease requires $15,000 at the beginning of each year for four years. Your required return is 6%. What is the lease worth today? State which flavour of annuity this is before you compute, and say what your answer would have been if the payments landed at the end of each year instead.',
      reference_answer:
        'Payments at the beginning make this an annuity due. Ordinary first: 15,000 x [1 - (1.06)^-4] / 0.06 = 15,000 x 3.465106 = $51,976.59. Then shift the whole stream one period earlier: 51,976.59 x 1.06 = $55,095.18. Had the payments landed at the end of each year, the answer would have stayed at $51,976.59 - the difference of $3,118.59 is one year of interest on the stream.',
      expected_concepts: ['cpt_annuity_due', 'cpt_ordinary_annuity'],
      agent_skill_used: 'lesson-prep',
      created_at: new Date('2026-06-25T09:30:00.000Z'),
      updated_at: new Date('2026-06-25T09:30:00.000Z'),
    },
  ])
  .onConflictDoNothing();

// -- mindmap (Lesson 2 agent seed) -------------------------------------------
const mindmapSeed = {
  nodes: [
    {
      id: 'n_root',
      title: 'Lesson 2 · Annuities — One Move, Repeated',
      level: 'root' as const,
      pos_x: 50,
      pos_y: 10,
      is_expanded: true,
      sort_order: 0,
    },
    {
      id: 'n_ordinary',
      parent_id: 'n_root',
      title: 'Ordinary annuity',
      level: 'branch' as const,
      pos_x: 25,
      pos_y: 35,
      is_expanded: true,
      sort_order: 1,
    },
    {
      id: 'n_ordinary_factor',
      parent_id: 'n_ordinary',
      title: 'PV factor [1 - (1 + r)^-n] / r',
      content: 'n counts payments, not years — a monthly stream over four years has n = 48.',
      level: 'detail' as const,
      pos_x: 12,
      pos_y: 55,
      is_expanded: false,
      sort_order: 2,
    },
    {
      id: 'n_due',
      parent_id: 'n_root',
      title: 'Annuity due',
      level: 'branch' as const,
      pos_x: 75,
      pos_y: 35,
      is_expanded: true,
      sort_order: 3,
    },
    {
      id: 'n_due_shift',
      parent_id: 'n_due',
      title: 'x (1 + r) once, at the end',
      content: 'Every payment arrives one period earlier — one period of growth on the whole stream.',
      level: 'detail' as const,
      pos_x: 65,
      pos_y: 60,
      is_expanded: false,
      sort_order: 4,
    },
    {
      id: 'n_due_words',
      parent_id: 'n_due',
      title: 'Rent · premium · "in advance"',
      content: 'The timing words are load-bearing: they are how a vignette says "annuity due".',
      level: 'detail' as const,
      pos_x: 85,
      pos_y: 60,
      is_expanded: false,
      sort_order: 5,
    },
  ],
  links: [],
};

await db
  .insert(s.mindmaps)
  .values({
    id: 'mm_l2',
    owner_pair_id: 'pair_demo_cfa',
    scope: 'lesson',
    title: 'Lesson 2 · Annuities — One Move, Repeated',
    folder: null,
    source: 'agent',
    agent_skill_used: 'lesson-prep',
    agent_seed_snapshot: mindmapSeed,
    content: mindmapSeed,
    has_been_reset: false,
    created_at: new Date('2026-06-25T09:30:00.000Z'),
    updated_at: new Date('2026-06-25T09:30:00.000Z'),
  })
  .onConflictDoNothing();

// -- pending cards -----------------------------------------------------------
await db
  .insert(s.pending_mindmap_cards)
  .values([
    {
      id: 'pc_1',
      owner_pair_id: 'pair_demo_cfa',
      title: 'Direction check before computing',
      content: 'Value today at a positive rate must come out smaller than the future amount.',
      source_type: 'flashcard',
      source_id: 'fc_direction',
      source_title:
        'You were asked for value today and your answer came out larger than the future payment. What happened?',
      reason: 'fsrs_difficulty > 7',
      created_at: tPlus(11),
    },
    {
      id: 'pc_2',
      owner_pair_id: 'pair_demo_cfa',
      title: 'Obligations discount too',
      content: 'Money owed later is still money that lives in the future — divide, do not multiply.',
      source_type: 'exercise',
      source_id: 'ex_l1_2',
      source_title: 'Exercise L1-2',
      reason: 'exercise_repeated_miss',
      created_at: tPlus(20),
    },
  ])
  .onConflictDoNothing();

// -- question bank + 3 questions --------------------------------------------
await db
  .insert(s.question_banks)
  .values({
    id: 'qb_cfa_l1_2025',
    exam: 'CFA Level 1',
    year: 2025,
    source: 'distribution',
    language: 'en',
    version: '2025.1',
    questions_count: 3,
    description: 'Quantitative Methods · Time Value of Money official exam-style sample.',
  })
  .onConflictDoNothing();

await db
  .insert(s.quiz_questions)
  .values([
    {
      id: 'qq_cfa_1',
      bank_id: 'qb_cfa_l1_2025',
      stem: 'An investor will receive $10,000 five years from today. At a discount rate of 6% per year, the present value of that payment is closest to:',
      question_type: 'single_choice',
      choices: ['$7,473', '$9,434', '$10,000', '$13,382'],
      reference_answer: 'A',
      explanation:
        'PV = 10,000 / (1.06)^5 = 10,000 / 1.338226 = $7,473. Choice D walks the road forward instead of back.',
      concept_tags: ['time-value', 'discounting'],
      difficulty: 2,
    },
    {
      id: 'qq_cfa_2',
      bank_id: 'qb_cfa_l1_2025',
      stem: 'A deposit of $4,000 earns 5% compounded annually. Its value at the end of eight years is closest to:',
      question_type: 'single_choice',
      choices: ['$2,707', '$5,600', '$5,910', '$6,000'],
      reference_answer: 'C',
      explanation:
        'FV = 4,000 x (1.05)^8 = 4,000 x 1.477455 = $5,910. Choice B charges simple interest and misses interest earning interest; choice A divides instead of multiplying.',
      concept_tags: ['time-value', 'compounding'],
      difficulty: 1,
    },
    {
      id: 'qq_cfa_3',
      bank_id: 'qb_cfa_l1_2025',
      stem: 'A five-year lease pays $9,000 at the end of each year. At a required return of 8%, the present value of the lease is closest to:',
      question_type: 'single_choice',
      choices: ['$29,809', '$35,934', '$38,809', '$45,000'],
      reference_answer: 'B',
      explanation:
        'PV = 9,000 x [1 - (1.08)^-5] / 0.08 = 9,000 x 3.99271 = $35,934. Choice C prices an annuity due; choice D forgets to discount at all.',
      concept_tags: ['time-value', 'annuity'],
      difficulty: 3,
    },
  ])
  .onConflictDoNothing();

// -- feedback (last week) ----------------------------------------------------
await db
  .insert(s.learner_feedback)
  .values({
    id: 'fb_week_2026-06-22',
    pair_id: 'pair_demo_cfa',
    contract_id: 'tc_demo_cfa_v1',
    week_of: new Date('2026-06-22T00:00:00.000Z'),
    pace: 4,
    difficulty: 3,
    helpfulness: 5,
    tone_fit: 4,
    free_text:
      'The starter jar and the orchard did more for me than the formulas did. Where I still slip is the direction — when the money is something I owe, I want to multiply.',
    suggested_changes:
      'Could the direction check come earlier in the page order, before the worked examples rather than after?',
    submitted_at: new Date('2026-06-26T20:00:00.000Z'),
  })
  .onConflictDoNothing();

// -- reminders (4: setup_complete fired + 3 pending) ------------------------
await db
  .insert(s.reminders)
  .values([
    {
      id: 'rmd_setup_done',
      pair_id: 'pair_demo_cfa',
      type: 'setup_complete',
      scheduled_for: new Date('2026-06-25T08:32:34.000Z'),
      channel: 'in_app',
      fired_at: new Date('2026-06-25T08:32:34.000Z'),
      dismissed_at: new Date('2026-06-25T08:33:10.000Z'),
      payload: { contract_id: 'tc_demo_cfa_v1', total_setup_seconds: 154 },
      created_at: new Date('2026-06-25T08:32:34.000Z'),
    },
    {
      id: 'rmd_lesson_due',
      pair_id: 'pair_demo_cfa',
      type: 'lesson_due',
      scheduled_for: new Date(new Date(T_BASE).getTime() + 24 * 3_600_000),
      channel: 'in_app',
      payload: { lesson_id: 'lsn_tvm_annuities' },
      created_at: tPlus(0),
    },
    {
      id: 'rmd_review_due',
      pair_id: 'pair_demo_cfa',
      type: 'review_due',
      scheduled_for: new Date(new Date(T_BASE).getTime() + 24 * 3_600_000),
      channel: 'ical',
      // 9 = 全卡数: 六张新卡 due 落在 T_BASE, 三张有复习史的卡 due 在 T_BASE
      // ±6h 内, 到这条提醒的 scheduled_for (T_BASE+24h) 时全部到期。
      payload: { due_count: 9 },
      created_at: tPlus(0),
    },
    {
      id: 'rmd_feedback_invite',
      pair_id: 'pair_demo_cfa',
      type: 'feedback_invitation',
      scheduled_for: new Date('2026-06-29T18:00:00.000Z'),
      channel: 'in_app',
      payload: { week_of: '2026-06-29' },
      created_at: tPlus(0),
    },
  ])
  .onConflictDoNothing();

console.log('[seed] done. Time Value of Money demo data inserted.');

await closeDb();
