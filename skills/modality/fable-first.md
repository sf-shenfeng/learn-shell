# Modality: fable-first

When this skill is in the stack, the lesson opens with a **fable** — a
short story, scene, or extended analogy that lets the learner *feel*
the concept before any term, formula, or rule is named.

Picked when the learner's content_modality leans narrative / when the
domain admits abstraction (e.g. finance, probability, philosophy,
language grammar). Compatible with subjects where a concrete worked
example *also* makes sense; layered on top of example-first when both
are appropriate.

## The three-layer authoring pattern

Every concept in the lesson cycles through:

```
1. Fable     — sense it, no name attached
2. Name it   — bilingual term + one-sentence definition + the rule
3. Use it    — apply against something real (numbers, sentences, situations)
```

Order is **load-bearing**. Don't name the concept until the learner has
felt it through the fable. Don't apply it until the name is in place.
A reader who sees a formula before they've felt the underlying motion
locks into rote.

## When you author the lesson body

### Fable layer (the opener)

- **1-2 `FABLE` pages, ≤ 400 字 total** per fable; tighter is better.
  (Paged-lesson budget per `docs/LESSON-BLOCKS-v1.md` — each page carries
  ≤ 200 字. The old ≤1000 字 budget predates paging and is retired.)
- **No terminology, no formulas, no jargon.** If you find yourself
  about to write the concept's name in the fable, rewrite.
- **≤ 3 characters** in the scene. Keep cognitive load low.
- **Concrete sensory anchors** — what something feels like, looks
  like, tastes like, costs. Not abstractions about abstractions.
- **Map cleanly** to the concept. The fable's structure must mirror
  the concept's logic; don't decorate with content that doesn't
  carry semantic weight.
- **No moral, no preachy beat.** Trust the story.

### Name layer (the bridge)

- Term + its translation if your stack is bilingual.
- One-sentence working definition.
- For subjects with formulas / rules: state the rule next, then
  immediately give the **intuition** before the math.
  - Bad: "S(t) = S(0) × e^(rt). It models continuous compounding."
  - Good: "The rule: continuous compounding. Intuition: imagine
    interest paid not yearly, not monthly, but *every infinitesimal
    moment*. The math: S(t) = S(0) × e^(rt) — where r is the rate
    and t is time."

### Use layer (the proof)

- At least one immediate application — preferably anchored to data
  from `contract.materials` or a domain-realistic situation the
  learner can relate to.
- This is where `:::trial` blocks earn their seat — the learner tries
  the application before reading your worked answer.

## Interactive blocks you should lean on

The canonical block catalogue, exact field syntax, and paging rules
live in **`docs/LESSON-BLOCKS-v1.md`** — that file is the single
source of truth; don't restate it here. v1 catalogue at a glance:

| Block             | Use when                                                 |
|-------------------|----------------------------------------------------------|
| `:::concept-flip` | Bilingual term + definition reveal (front/back)          |
| `:::formula`      | Math expression with notation key + intuition prose      |
| `:::trial`        | Mid-lesson "you try" — box starts empty; `Answer` field required, hidden until attempt |
| `:::callout`      | `{kind=trap|warn|info}` — warning, exam-flag, common-mistake |
| `:::cfa-note`     | Exam-domain LOS annotation (domain-specific)             |

Concept comparisons use native GFM tables; `:::poll` / `:::aside`
are v1.1 candidates — don't author them yet.

**Minimum**: 3 distinct block types per lesson body; at most one
block per page; block-carrying pages ≤ 50% of the lesson (verify
gate enforces these per LESSON-BLOCKS-v1 §3/§5).

`==highlight==` markup for key terms (renders as a colored mark).
Use sparingly — 3-5 highlights per lesson, not every other phrase.

## When you grade exercises (under this modality)

- Reward learners who can *retell the fable* in their own words even
  if they can't reproduce the formula — they've grasped the shape.
- Press learners who can recite the formula but can't sketch the
  underlying motion. The math is the surface; the intuition is what
  survives a year of forgetting.
- When correcting, anchor back to the fable: "remember the scene
  where X happened — that's the moment the formula's r term spikes."

## Not for

- **Subject content selection** — domain skill owns "what concepts
  this lesson covers" and "in what order across the curriculum".
- **Number of exercises** — intensity skill owns quantity.
- **Wording register** — tone skill (or your relationship with the
  user) owns whether you're playful, strict, 直接, 暧昧.
- **Drilling speed / FSRS cadence** — pace skill / FSRS engine owns
  rhythm of review.

## Anti-patterns

- Don't write the fable, then immediately *explain the fable*. The
  story has to carry the meaning. If you feel the urge to gloss it,
  rewrite the story.
- Don't use a "fable" that's just a relabeled textbook example with
  cute names. The structural mapping must be real.
- Don't skip the use layer because the fable was strong. Sensing
  isn't using; you need both.
- Don't pile up `:::concept-flip` blocks back-to-back as a substitute
  for prose — they're punctuation, not the bulk of the lesson.
