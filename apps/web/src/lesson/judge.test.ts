// Trial auto-judge tests — docs/LESSON-BLOCKS-v1.md §2.3.
//
// Run: pnpm --filter @learn-shell/web test
//
// judge.ts is the whole graded-trial verdict in four pure functions, so it is
// testable end to end without a browser, a DB, or React. The matrix below is
// not invented: the "live corpus" cases are the trial blocks a read-only scan
// of the running lesson library (2026-07-29/30) proved unwinnable — blocks
// where a learner typing the block's OWN model answer was still told
// "Item 1 doesn't match". Each of those is pinned here so the judge can never
// silently regress into refusing correct answers again.
//
// Fixture policy: drafts reproduce the real blocks' numeric token sequence
// exactly — that sequence IS what the judge sees — while the surrounding
// prose is generic teaching text. Second-person and portfolio-specific
// sentences from the source library are neutralized or dropped; no case here
// depends on them, and several deliberately keep the awkward real-world
// formatting (step numbering in parens, unicode minus, currency glyphs
// wedged between sign and digits) because that formatting is precisely what
// the tokenizer has to survive.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractDraftTokens,
  extractTokens,
  judgeCloze,
  judgeTrial,
  parseExpected,
  parseExpectedItems,
} from './judge';

/** Judge exactly the way TrialBlock does: raw `Expected` field text in,
 *  learner draft in, verdict out. */
function judge(expectedRaw: string, draft: string) {
  return judgeTrial(draft, parseExpectedItems(expectedRaw));
}

function assertCorrect(expectedRaw: string, draft: string) {
  assert.deepEqual(judge(expectedRaw, draft), { verdict: 'correct', mismatchAt: null });
}

function assertIncorrect(expectedRaw: string, draft: string, mismatchAt?: number) {
  const result = judge(expectedRaw, draft);
  assert.equal(result.verdict, 'incorrect');
  if (mismatchAt !== undefined) assert.equal(result.mismatchAt, mismatchAt);
}

// ---------------------------------------------------------------------------
// Live corpus, class A — the separator trap (5 blocks / 4 courses).
//
// A two-part question invites a two-part Expected, and an author listing two
// answers reaches for a semicolon. Split on ASCII comma alone, the whole
// string became one segment, `Number` made it NaN, and NaN compares equal to
// nothing — every draft, including the correct pair typed verbatim, was
// judged wrong forever. All five real Expected strings are pinned below.
// ---------------------------------------------------------------------------

const SEPARATOR_CASES: Array<{ name: string; expected: string; values: number[]; draft: string }> = [
  { name: 'cross rates and forwards, first block', expected: '0.50; 5', values: [0.5, 5], draft: '0.50 and 5' },
  { name: 'cross rates and forwards, second block', expected: '6.8971; -2029', values: [6.8971, -2029], draft: '6.8971, then -2029' },
  { name: 'cash conversion cycle', expected: '1.00; 0.36', values: [1, 0.36], draft: '1.00 and 0.36' },
  { name: 'derivatives, the two families', expected: '-5; -4', values: [-5, -4], draft: '-5 and -4' },
  { name: 'option pricing and put-call parity', expected: '20; 15', values: [20, 15], draft: '20 and 15' },
];

for (const testCase of SEPARATOR_CASES) {
  test(`live corpus · separator · ${testCase.name}: parses instead of going NaN`, () => {
    assert.deepEqual(parseExpected(testCase.expected), testCase.values);
    assertCorrect(testCase.expected, testCase.draft);
  });
}

test('live corpus · separator · every author-reachable delimiter splits', () => {
  for (const raw of ['20, 15', '20; 15', '20；15', '20，15', '20、15']) {
    assert.deepEqual(parseExpected(raw), [20, 15], raw);
  }
});

test('live corpus · separator · decimal point and sign are never separators', () => {
  assert.deepEqual(parseExpected('6.8971, -2029'), [6.8971, -2029]);
  assert.deepEqual(parseExpected('+120, -300, -40, -90, +65'), [120, -300, -40, -90, 65]);
});

// ---------------------------------------------------------------------------
// Live corpus, class B — trailing-window displacement (16 blocks / 15 courses).
//
// The trailing-N window was designed to forgive scratch work BEFORE the
// answer. Teaching prose routinely puts a number AFTER it — one more sentence
// comparing, checking, or contextualizing the result — which shoves the real
// answer out of the window. Every draft below is the block's own model answer
// shape; every one of them was judged incorrect before the window fallback.
// ---------------------------------------------------------------------------

test('live corpus · window · goodwill: answer trails a positive restatement of a negative result', () => {
  const draft =
    '(1) Identifiable assets FV total = 40,000+55,000+95,000+70,000 = $260,000. ' +
    'Identifiable net assets FV = 260,000 − 45,000 = $215,000. ' +
    '(2) Goodwill = 350,000 − 215,000 = $135,000. ' +
    '(3) 190,000 − 215,000 = −$25,000. No goodwill is recorded; a $25,000 bargain ' +
    'purchase gain is recognized directly in the income statement.';
  // Trailing window is [25000] — the sign-flipped restatement, not the answer.
  assert.deepEqual(extractTokens(draft).slice(-1), [25000]);
  assertCorrect('-25000', draft);
});

test('live corpus · window · tariff: answer trails a comparison against the autarky price', () => {
  const draft =
    '5.80 + 1.90 = $7.70. Since $7.70 exceeds the $7.20 autarky cost, domestic ' +
    'producers can now produce profitably at the new price.';
  assertCorrect('7.70', draft);
});

test('live corpus · window · flipped FX quote: answer trails the cross-check identity', () => {
  const draft =
    'Old CNY/USD rate = R; new rate = 1.08R (USD appreciated 8%). Flipped quote USD/CNY ' +
    'goes from 1/R to 1/(1.08R): % change = 1 ÷ 1.08 − 1 ≈ −7.41%, matching ' +
    'x ÷ (1 + x) = 0.08 ÷ 1.08 ≈ 0.0741. The yuan depreciates about 7.41%, not 8%.';
  assertCorrect('-7.41', draft);
});

test('live corpus · window · duration: answer trails the size of the rate step', () => {
  const draft =
    'ΔP/P ≈ −6 × (−0.005) = +3%; ¥250,000 × 3% = ¥7,500 — though real policy moves ' +
    'rarely land as one clean 50bps step.';
  assertCorrect('7500', draft);
});

test('live corpus · window · expected value: answer trails the certainty-equivalent comparison', () => {
  const draft = 'EV = 0.5 × 20,000 + 0.5 × 0 = ¥10,000 — ¥2,000 higher than the certain ¥8,000.';
  assertCorrect('10000', draft);
});

test('live corpus · window · regression slope: answer trails a callback to an earlier unit', () => {
  const draft =
    'dx = −3, −1, 1, 3. dy = −0.5, −0.5, 0.5, 0.5. Σ(dx·dy) = 1.5+0.5+0.5+1.5 = 4.0. ' +
    'Σdx² = 9+1+1+9 = 20. b1 = 4.0 ÷ 20 = 0.2 — the same 0.2 an earlier unit handed ' +
    'over as one of 5 stated constants.';
  assertCorrect('0.2', draft);
});

test('live corpus · window · capitalize vs expense: answer trails the amortization schedule', () => {
  const draft =
    '(1) X: 400 − 250 − 80 = $70M. Y: 400 − 250 − 20 = $130M. ' +
    '(2) X: 400 − 250 − 0 = $150M. Y: 400 − 250 − 20 = $130M. ' +
    '(3) Both recognize exactly $80M in total over 4 years ($80M once for X, $20M × 4 ' +
    'for Y) — identical total cost.';
  assertCorrect('80', draft);
});

test('live corpus · window · lease: answer trails the operating-lease comparison', () => {
  const draft =
    'PV ≈ 150,000 × 5.0757 ≈ ¥761,355 — both the initial lease liability and the ROU ' +
    'asset. Year-1 interest ≈ 761,355 × 5% ≈ ¥38,068; ROU amortization ≈ 761,355 ÷ 6 ' +
    '≈ ¥126,893; combined ≈ ¥164,961. That is about ¥14,961 more than the flat ' +
    '¥150,000 an operating lease would show.';
  assertCorrect('14961', draft);
});

test('live corpus · window · FCFE valuation: answer trails the terminal-value weight', () => {
  const draft =
    '(1) FCFE1=2.00×1.15=$2.30; FCFE2=2.30×1.15=$2.645; FCFE3=2.645×1.15=$3.04175. ' +
    '(2) FCFE4=3.04175×1.03=$3.1330, TV3=3.1330÷(0.09−0.03)=3.1330÷0.06=$52.2167. ' +
    '(3) Discounting (1.09¹=1.09, 1.09²=1.1881, 1.09³=1.295029): PV(FCFE1)=2.30÷1.09=$2.1101, ' +
    'PV(FCFE2)=2.645÷1.1881=$2.2262, PV(FCFE3)=3.04175÷1.295029=$2.3488, ' +
    'PV(TV3)=52.2167÷1.295029=$40.3209. Total: 2.1101+2.2262+2.3488+40.3209=$47.01. ' +
    'Notice that PV(TV3) alone accounts for 85.8% of total value — almost identical to ' +
    'the classroom example (86%).';
  assertCorrect('47.01', draft);
});

test('live corpus · window · dividend split: answer trails the counterfactual shift', () => {
  const draft =
    'Dividend yield = 0.4265/263.04 ≈ +0.16%. Total return = −9.97% + 0.16% ≈ −9.81%. ' +
    'The dividend yield only pulls total return from −9.97% up to −9.81% — a shift of ' +
    'about 0.16 of a percentage point.';
  assertCorrect('-9.81', draft);
});

test('live corpus · window · target WACC: answer trails the rate it warns against using', () => {
  const draft =
    'WACC(target) = 50% × 4.5% + 50% × 12% = 2.25% + 6.0% = 8.25%. Use 8.25%, not 9.0%, ' +
    'to discount a new multi-year project.';
  assertCorrect('8.25', draft);
});

test('live corpus · window · WACC with tax shield: answer trails the follow-up question', () => {
  const draft =
    '(1) After-tax r_d = 5.5% × 0.79 = 4.345%. WACC = 20% × 4.345% + 80% × 11% = ' +
    '0.869% + 8.8% = 9.669%, rounds to 9.67%. (2) Pushing to 60% debt is far more ' +
    'likely to overshoot the trough than to reach it.';
  assertCorrect('9.67', draft);
});

// The four remaining class-B blocks are multi-value, and their correct values
// never appear as one contiguous in-order run anywhere in the draft — the
// window fallback is a window scan, not a set membership test, and these stay
// incorrect by design. Pinned so the tradeoff stays visible and deliberate:
// loosening further would mean matching scattered numbers, which is how a
// judge starts calling wrong answers right.

test('live corpus · window · concentration ratios: scattered multi-value stays incorrect', () => {
  const draft =
    'West landing = 50% × 55% = 27.5%. East landing = 50% × 45% = 22.5%. Ranked by ' +
    'share: bridge 50% > west landing 27.5% > east landing 22.5%. CR2 = 50% + 27.5% = ' +
    '77.5% (up from 73% in the 40% scenario). HHI = 50² + 27.5² + 22.5² = 2500 + ' +
    '756.25 + 506.25 = 3762.5 (up from 3418 in the 40% scenario). Both numbers rose.';
  // 77.5 and 3762.5 are both present, but 73 sits between them.
  assert.ok(extractTokens(draft).includes(77.5) && extractTokens(draft).includes(3762.5));
  assertIncorrect('77.5, 3762.5', draft);
});

test('live corpus · window · terminal-growth sensitivity: scattered multi-value stays incorrect', () => {
  const draft =
    "TV₃' = 4.980592×1.05÷(0.10−0.05) = 5.230÷0.05 ≈ 104.6. PV(TV₃') = 104.6×0.7513 ≈ " +
    '78.58. New equity value = 2.35+3.07+3.74+78.58 ≈ 87.7. New value per share = ' +
    '87.7÷37.2 ≈ $2.36. That is roughly 18.5% higher than the base case of $1.99. An ' +
    'earlier day-09 unit reached a terminal-value share of 87.6% and an 18.3% jump; ' +
    'rebuilt through a full statement forecast you land at 87.6% and 18.5%.';
  assertIncorrect('104.6, 87.7, 2.36, 18.5', draft);
});

test('live corpus · window · two-analyst DDM: scattered multi-value stays incorrect', () => {
  const draft =
    'Analyst A: D₁ = 4.00×1.035 = 4.14; V = 4.14/(0.085−0.035) = 4.14/0.05 = $82.80. ' +
    'Analyst B: D₁ = 4.00×1.045 = 4.18; V = 4.18/(0.08−0.045) = 4.18/0.035 = $119.43. ' +
    'Difference: (119.43−82.80)/82.80 ≈ 44.2% — same model, same D₀. An earlier day-09 ' +
    'example changed only g and value rose 21%; changing both amplifies it to 44%. ' +
    'One large-cap target-price history says the same: old targets of $340/$400 are ' +
    'dead, the new pair is $275 and $297.';
  assertIncorrect('82.80, 119.43, 44.2', draft);
});

test('live corpus · window · breakeven and shutdown loss: a currency glyph eats the sign', () => {
  const draft =
    'AFC = 54 ÷ 18 = ¥3, so ATC = 3 + 7 = ¥10 — the breakeven price. At the shutdown ' +
    'point P = AVC = ¥7: revenue = 7×18 = ¥126, cost = 54 + 7×18 = ¥180, loss = −¥54 ' +
    '— exactly equal to the fixed cost.';
  // `−¥54` tokenizes as +54: the detached-sign repair spans whitespace, not a
  // currency glyph, and only `$` is stripped. Out of scope for the three
  // judging rules — a tokenizer gap, recorded here rather than papered over.
  assert.ok(!extractTokens(draft).includes(-54));
  assertIncorrect('10, -54', draft);
});

// ---------------------------------------------------------------------------
// Live corpus, class C — accounting parentheses (9 blocks with a negative
// Expected). Every one of them rejected the notation the discipline actually
// uses to write negatives. Expectation-guided: the flip fires only where
// Expected is itself negative at that position.
// ---------------------------------------------------------------------------

const PAREN_CASES: Array<{ name: string; expected: string; draft: string }> = [
  { name: 'bargain purchase gain', expected: '-25000', draft: '(25,000)' },
  { name: 'flipped quote depreciation', expected: '-7.41', draft: '(7.41)%' },
  { name: 'cash flow statement, five lines', expected: '+120, -300, -40, -90, +65', draft: '120, (300), (40), (90), 65' },
  { name: 'working capital change', expected: '-73', draft: '(73)' },
  { name: 'inventory writedown', expected: '-2', draft: '(2)' },
  { name: 'currency translation loss', expected: '-3.26', draft: '(3.26)' },
  { name: 'price return', expected: '-9.97', draft: '(9.97)%' },
  { name: 'total return with dividend', expected: '-9.81', draft: 'total return = (9.81)%' },
  { name: 'shutdown loss', expected: '10, -54', draft: '10 and (54)' },
];

for (const testCase of PAREN_CASES) {
  test(`live corpus · parens · ${testCase.name}: accounting negatives are accepted`, () => {
    assertCorrect(testCase.expected, testCase.draft);
  });
}

test('live corpus · parens · a dollar sign outside the parens is still stripped', () => {
  assertCorrect('-25000', '$(25,000)');
  assertCorrect('-300', '($300)');
});

test('live corpus · parens · whitespace inside the parens is tolerated', () => {
  assertCorrect('-300', '( 300 )');
});

// ---------------------------------------------------------------------------
// Rule 1 boundaries — tolerance is the half-ulp of Expected's OWN precision.
// ---------------------------------------------------------------------------

test('rule 1 · integer Expected accepts the unrounded real that rounds to it', () => {
  assertCorrect('6582', '6581.62'); // 8000 / 1.05^4, typed without rounding
  assertCorrect('6582', '$6,582');
  assertCorrect('6582', '6,582.00');
});

test('rule 1 · integer Expected still rejects the neighbouring integer', () => {
  assertIncorrect('6582', '6581', 1);
  assertIncorrect('6582', '6583', 1);
});

test('rule 1 · integer Expected: band edges', () => {
  assertCorrect('6582', '6581.5');
  assertCorrect('6582', '6582.5');
  assertIncorrect('6582', '6581.49');
  assertIncorrect('6582', '6582.51');
});

test('rule 1 · two-decimal Expected narrows the band to half a cent', () => {
  assertCorrect('7.70', '7.7');
  assertCorrect('7.70', '7.7049');
  assertCorrect('7.70', '7.705'); // exactly on the edge, not decided by float error
  assertIncorrect('7.70', '7.71', 1);
  assertIncorrect('7.70', '7.69');
});

test('rule 1 · the authored trailing zero is what sets the band, not the parsed number', () => {
  // `1.00` and `1` are the same number and NOT the same claim: half a
  // hundredth versus half a unit.
  assert.deepEqual(parseExpectedItems('1.00'), [{ value: 1, decimals: 2 }]);
  assert.deepEqual(parseExpectedItems('1'), [{ value: 1, decimals: 0 }]);
  assertIncorrect('1.00', '1.4');
  assertCorrect('1', '1.4');
});

test('rule 1 · four-decimal Expected keeps a four-decimal answer honest', () => {
  assertCorrect('6.8971', '6.89712');
  assertIncorrect('6.8971', '6.8976');
});

test('rule 1 · the band scales per item, not per draft', () => {
  // First item integer (±0.5), second item two decimals (±0.005).
  assertCorrect('20, 15.00', '20.4, 15.004');
  assertIncorrect('20, 15.00', '20.4, 15.04', 2);
});

test('rule 1 · a malformed Expected stays unwinnable rather than matching everything', () => {
  const items = parseExpectedItems('about twenty');
  assert.ok(Number.isNaN(items[0]?.value));
  assertIncorrect('about twenty', '20', 1);
  assertIncorrect('about twenty', '', 1);
});

// ---------------------------------------------------------------------------
// Rule 2 boundaries — the parenthesis reading must not spread.
// ---------------------------------------------------------------------------

test('rule 2 · step numbering in parens is never read as negative', () => {
  // The single most common parenthesized digits in real teaching prose.
  assertCorrect('1, 2, 3', '(1) first, (2) second, (3) third');
  assertIncorrect('-1, -2, -3', '1, 2, 3', 1);
});

test('rule 2 · a positive Expected never flips a parenthesized token', () => {
  assertCorrect('2024', 'the (2024) filing reports 2024');
  // Parens around a number keep meaning nothing at all under a positive
  // Expected — the pre-rule reading, unchanged.
  assertCorrect('300', '(300) is a credit balance');
});

test('rule 2 · the flip needs both parens, not a stray one', () => {
  assertIncorrect('-300', '(300', 1);
  assertIncorrect('-300', '300)', 1);
});

test('rule 2 · an explicit minus keeps working and is not double-negated', () => {
  assertCorrect('-300', '-300');
  assertCorrect('-300', '− 300'); // unicode minus, detached from its digits
  assertIncorrect('-300', '300', 1);
});

test('rule 2 · a parenthesized negative is not silently made positive', () => {
  assertIncorrect('300', '(-300)', 1);
});

test('rule 2 · parenthesization is recorded, never resolved, by the tokenizer', () => {
  assert.deepEqual(extractDraftTokens('(300) and 300'), [
    { value: 300, parenthesized: true },
    { value: 300, parenthesized: false },
  ]);
  // Values-only view is unchanged — the parens annotate, they do not rewrite.
  assert.deepEqual(extractTokens('(1) 190,000 − 215,000 = −25,000'), [1, 190000, -215000, -25000]);
});

// ---------------------------------------------------------------------------
// Rule 3 boundaries — the fallback scans windows; it never reorders, never
// skips, and never reports a different item number than the trailing read.
// ---------------------------------------------------------------------------

test('rule 3 · the trailing window is still tried first', () => {
  assertCorrect('10, 20', 'scratch 99, then 10, 20');
});

test('rule 3 · order inside a window is never relaxed', () => {
  assertIncorrect('10, 20', '20, 10');
});

test('rule 3 · the window must be contiguous', () => {
  assertIncorrect('10, 20', '10, 99, 20');
  assertCorrect('10, 20', '10, 20, 99');
});

test('rule 3 · the reported item number is the trailing window read', () => {
  // The mismatch a learner sees keeps pointing at the end of their own draft,
  // which is the position the UI wording ("Item N") has always described.
  assertIncorrect('10, 20', 'nowhere near: 1, 2, 3', 1);
  assertIncorrect('10, 20', 'close: 10, 21', 2);
});

test('rule 3 · a shorter draft than Expected keeps its original alignment', () => {
  assertIncorrect('10, 20', '10', 2);
  assertIncorrect('10, 20', '20', 1);
  assertIncorrect('6582', '', 1);
});

test('rule 3 · accepted cost: a right number anywhere in the draft now counts', () => {
  // Stated plainly because it is the price of the fix: a draft that contains
  // the answer as scratch work and then concludes with something else is now
  // graded correct. The alternative — 16 blocks in which no answer could win —
  // is worse, and the trailing window still decides the error message.
  assertCorrect('5', '5 apples at 3 each is 15');
});

test('rule 3 · rules compose: a parenthesized negative found mid-draft', () => {
  assertCorrect('-25000', 'goodwill is (25,000) and the gain is 25,000');
});

// ---------------------------------------------------------------------------
// Pre-existing behaviour that must not move.
// ---------------------------------------------------------------------------

test('regression · the canonical multi-value cash flow block', () => {
  assertCorrect('+120, -300, -40, -90, +65', '+120, -300, -40, -90, +65');
  assertCorrect('+120, -300, -40, -90, +65', 'answer: 120, -300, -40, -90, 65');
  assertIncorrect('+120, -300, -40, -90, +65', '120, 300, 40, 90, 65', 2);
});

test('regression · currency, thousands, and trailing zeros parse as before', () => {
  assert.deepEqual(extractTokens('$6,582'), [6582]);
  assert.deepEqual(extractTokens('6,582.00'), [6582]);
  assert.deepEqual(extractTokens('120, 300'), [120, 300]); // never merged into 120300
  assert.deepEqual(extractTokens('1,234,567'), [1234567]);
  assert.deepEqual(extractTokens(''), []);
});

test('regression · scratch work before the answer is still forgiven', () => {
  assertCorrect('6582', 'PV = 8,000 ÷ 1.21550625 = $6,582');
});

test('regression · a wrong answer is still wrong', () => {
  assertIncorrect('6582', '6581', 1);
  assertIncorrect('6582', 'I have no idea');
  assertIncorrect('20303', '20302', 1);
});

test('regression · an empty Expected judges nothing', () => {
  assert.deepEqual(parseExpectedItems('   '), []);
  assertCorrect('   ', 'anything at all');
});

test('regression · bare numbers are still an accepted Expected shape', () => {
  // Callers that never learned about authored precision keep working; the band
  // is then inferred from the number's own decimal representation.
  assert.deepEqual(judgeTrial('6582', [6582]), { verdict: 'correct', mismatchAt: null });
  assert.deepEqual(judgeTrial('6581.62', [6582]), { verdict: 'correct', mismatchAt: null });
  // 7.7 as a bare number can only claim one decimal, so its band is ±0.05 —
  // wider than the ±0.005 the same value authored as `7.70` would claim.
  assert.deepEqual(judgeTrial('7.71', [7.7]), { verdict: 'correct', mismatchAt: null });
  assert.deepEqual(judgeTrial('7.76', [7.7]), { verdict: 'incorrect', mismatchAt: 1 });
  assert.deepEqual(judge('7.70', '7.71'), { verdict: 'incorrect', mismatchAt: 1 });
});

test('regression · cloze judging is untouched', () => {
  assert.deepEqual(judgeCloze(['alpha', 'beta'], ['alpha', 'beta']), {
    verdict: 'correct',
    mismatchAt: null,
  });
  assert.deepEqual(judgeCloze([' alpha ', 'beta'], ['alpha', 'beta']), {
    verdict: 'correct',
    mismatchAt: null,
  });
  assert.deepEqual(judgeCloze(['alpha', 'gamma'], ['alpha', 'beta']), {
    verdict: 'incorrect',
    mismatchAt: 2,
  });
  assert.deepEqual(judgeCloze([], ['alpha']), { verdict: 'incorrect', mismatchAt: 1 });
});
