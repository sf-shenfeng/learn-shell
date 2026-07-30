// Trial auto-judge — docs/LESSON-BLOCKS-v1.md §2.3 `Expected` field.
//
// Pure functions, no React. Implements the judging algorithm exactly as
// spec'd — normalize the learner draft,
// extract every signed numeric token, compare the LAST N (N = Expected
// item count) against Expected in order.
//
// Three judging rules sit on top of that baseline, each one earned from a
// forensic scan of the live lesson corpus (2026-07-29/30) rather than
// invented here:
//
//   1. Precision-aware tolerance — Expected carries its own precision. An
//      integer Expected means "rounded to the unit", so any real within
//      ±0.5 of it is the same answer; an Expected written with k decimals
//      means "rounded to k places", so the band is ±0.5×10⁻ᵏ. That is the
//      half-ulp of Expected's own written precision, never a fixed epsilon:
//      `7.70` accepts 7.7004 but rejects 7.71, while `6582` accepts 6581.62
//      (the unrounded value) and still rejects 6581 (a different answer).
//   2. Accounting parentheses, expectation-guided — finance writes negatives
//      as `(300)`. A parenthesized token is read as negative ONLY when the
//      Expected item at that position is itself negative; otherwise it keeps
//      its plain positive value. Anchoring on Expected is what keeps step
//      numbering — `(1) … (2) … (3)` — from silently becoming −1, −2, −3.
//   3. Window fallback — the trailing-N window stays the primary read (and
//      is what the mismatch index reports, so the UI's "Item N" wording is
//      unchanged). When it misses, every contiguous N-token window in the
//      draft is tried in order; any full hit is correct. Answers that state
//      the result and then add one more sentence with a number in it
//      ("…= ¥10,000 — ¥2,000 higher than the certain ¥8,000") pushed the
//      right answer out of the trailing window; the corpus scan found this
//      to be the single largest cause of unwinnable trial blocks.

export interface JudgeResult {
  verdict: 'correct' | 'incorrect';
  /** 1-based index of the first mismatched Expected item; null when correct. */
  mismatchAt: number | null;
}

/** One parsed `Expected` entry: its value plus the precision it was WRITTEN
 *  with. The written precision has to survive parsing — `1.00` and `1` are
 *  the same number but not the same claim (±0.005 vs ±0.5), and `Number`
 *  alone cannot tell them apart. */
export interface ExpectedItem {
  value: number;
  /** Digits after the decimal point as authored: `7.70` → 2, `6582` → 0. */
  decimals: number;
}

/** One numeric token lifted out of a learner draft, with the one piece of
 *  surrounding syntax the judge cares about: whether the number sat inside
 *  parentheses (accounting negative notation). */
export interface DraftToken {
  value: number;
  /** True only when the token was wrapped on BOTH sides: `(300)`, `$(300)`. */
  parenthesized: boolean;
}

/** Separator set (2026-07-29 corpus scan): ASCII `,` plus the separators an
 *  author naturally reaches for when listing two answers in Chinese — ASCII
 *  `;`, fullwidth `；`/`，`, and 顿号 `、`. Before this, any of those four
 *  fell through to a single un-split segment that `Number(...)` turns into
 *  `NaN`; `NaN` never compares equal, so a block written with e.g.
 *  `Expected: 0.50; 5` judged *every* draft — empty, wrong, or the correct
 *  pair copied verbatim — as incorrect. 5 of 76 live trial blocks (4
 *  courses) hit exactly this. `.` (decimal point) and `+`/`-`/`−` (sign) are
 *  deliberately excluded from the class — they stay inside a number token,
 *  never a separator. */
const EXPECTED_SEPARATOR_RE = /[,;；，、]/;

/** Parse a `Expected` field into value + authored precision, e.g.
 *  "+120, -300, -40" → [{120,0}, {-300,0}, {-40,0}] and
 *  "7.70" → [{7.7, 2}]. */
export function parseExpectedItems(expected: string): ExpectedItem[] {
  return expected
    .replace(/−/g, '-') // unicode minus → ascii, same as draft normalization
    .split(EXPECTED_SEPARATOR_RE)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => ({ value: Number(s), decimals: decimalsOf(s) }));
}

/** Parse a `Expected` field into signed numbers, e.g.
 *  "+120, -300, -40, -90, +65" → [120, -300, -40, -90, 65].
 *  Precision-blind view of {@link parseExpectedItems}; kept because the
 *  values alone are what most callers (and the spec's own wording) mean by
 *  "Expected". */
export function parseExpected(expected: string): number[] {
  return parseExpectedItems(expected).map((item) => item.value);
}

/** Digits written after the decimal point, `0` when there is no decimal
 *  point. Reads the AUTHORED text, not the parsed number, so the trailing
 *  zero in `1.00` still counts. */
function decimalsOf(segment: string): number {
  return /\.(\d+)/.exec(segment)?.[1]?.length ?? 0;
}

/** A signed number, optionally wrapped in parentheses on both sides.
 *  Whitespace inside the parens is tolerated (`( 300 )`); every group but
 *  the number itself is optional, and the number requires at least one
 *  digit, so this can never match empty and never loops. Token *sequence*
 *  is identical to the bare number regex — the parens only annotate. */
const TOKEN_RE = /(\(\s*)?([+-]?\d+(?:\.\d+)?)(\s*\))?/g;

/** Extract every signed numeric token from a learner draft — spec step 1-2:
 *  unicode minus → ascii, strip `$`; commas are stripped ONLY as thousand
 *  separators (directly followed by exactly 3 digits), so a list like
 *  "120, 300" never merges into 120300; whitespace is NOT stripped globally
 *  (it delimits unsigned numbers) — instead a detached sign is glued to the
 *  digits it precedes ("− 300" → "-300") so sign information survives.
 *  Parenthesization is recorded but NOT resolved here: whether `(300)` means
 *  −300 or the literal 300 depends on the Expected item it lands against,
 *  and that decision belongs to {@link judgeTrial}. */
export function extractDraftTokens(draft: string): DraftToken[] {
  const normalized = draft
    .replace(/−/g, '-')
    .replace(/\$/g, '')
    .replace(/,(?=\d{3}(?!\d))/g, '')
    .replace(/([+-])\s+(?=\d)/g, '$1');
  const tokens: DraftToken[] = [];
  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(normalized)) !== null) {
    tokens.push({
      value: Number(match[2]),
      parenthesized: Boolean(match[1] && match[3]),
    });
  }
  return tokens;
}

/** Values-only view of {@link extractDraftTokens} — the spec's "extract every
 *  signed numeric token" read, unchanged. */
export function extractTokens(draft: string): number[] {
  return extractDraftTokens(draft).map((token) => token.value);
}

/** Floating-point slack so a draft sitting exactly ON the tolerance boundary
 *  is not decided by binary representation error: |47.015 − 47.01| evaluates
 *  to 0.005000000000002558 in IEEE-754, which would fail a naive `<= 0.005`.
 *  Relative, tiny, and applied to both the band and the magnitude — it can
 *  never widen the band into the next answer. */
const FLOAT_SLACK = 1e-9;

/** Rule 1 + rule 2, per position: does this draft token satisfy this Expected
 *  item? Parenthesized positives flip sign only under a negative Expected
 *  (rule 2), then the difference has to fall inside the half-ulp band of
 *  Expected's own written precision (rule 1). A non-finite value on either
 *  side never matches — a malformed `Expected` stays unwinnable rather than
 *  quietly matching everything. */
function tokenSatisfies(token: DraftToken | undefined, item: ExpectedItem): boolean {
  if (token === undefined) return false;
  if (!Number.isFinite(token.value) || !Number.isFinite(item.value)) return false;
  const actual =
    token.parenthesized && item.value < 0 && token.value > 0 ? -token.value : token.value;
  const band = 0.5 * Math.pow(10, -item.decimals);
  const diff = Math.abs(actual - item.value);
  return diff <= band * (1 + FLOAT_SLACK) + Math.abs(item.value) * FLOAT_SLACK;
}

/** Compare one N-token window against Expected in order. Returns the 1-based
 *  index of the first item that fails, or null when the whole window hits. */
function windowMismatchAt(
  tokens: readonly DraftToken[],
  start: number,
  items: readonly ExpectedItem[]
): number | null {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item === undefined || !tokenSatisfies(tokens[start + i], item)) return i + 1;
  }
  return null;
}

/** Normalize the two accepted Expected shapes. Bare numbers keep working
 *  (they infer their precision from their own decimal representation), so no
 *  caller is forced to switch. */
function toExpectedItems(
  expected: readonly number[] | readonly ExpectedItem[]
): ExpectedItem[] {
  const entries: ReadonlyArray<number | ExpectedItem> = expected;
  return entries.map((entry) =>
    typeof entry === 'number'
      ? { value: entry, decimals: decimalsOf(String(entry)) }
      : entry
  );
}

/** Judge a draft against a parsed Expected sequence — spec step 3-4: take
 *  the trailing N tokens (N = expected.length, tolerating scratch-work
 *  numbers earlier in the draft) and compare positionally. Sign matters
 *  (`-300 != 300`) because it is baked into the parsed number, not
 *  string-compared.
 *
 *  The trailing window is still the primary read and still owns the reported
 *  mismatch index. Only when it misses does the judge sweep the remaining
 *  contiguous N-token windows (rule 3); order within a window is never
 *  relaxed, so "20, 10" can never satisfy Expected "10, 20". */
export function judgeTrial(
  draft: string,
  expected: readonly number[] | readonly ExpectedItem[]
): JudgeResult {
  const items = toExpectedItems(expected);
  const tokens = extractDraftTokens(draft);
  // `Math.max(0, …)` keeps the pre-existing short-draft alignment: when the
  // draft holds fewer tokens than Expected asks for, the trailing window IS
  // the whole draft, left-aligned — same positions, same mismatch index, as
  // the original `tokens.slice(-N)`.
  const tailStart = Math.max(0, tokens.length - items.length);

  const tailMismatch = windowMismatchAt(tokens, tailStart, items);
  if (tailMismatch === null) return { verdict: 'correct', mismatchAt: null };

  for (let start = tailStart - 1; start >= 0; start--) {
    if (windowMismatchAt(tokens, start, items) === null) {
      return { verdict: 'correct', mismatchAt: null };
    }
  }
  return { verdict: 'incorrect', mismatchAt: tailMismatch };
}

/** Judge a `Cloze` trial (docs/LESSON-BLOCKS-v1.md §2.3) — one blank filled
 *  per learner input, compared positionally against the (pipe-split)
 *  `Answer` field. Trim-exact per blank, same shape (verdict + 1-based
 *  mismatchAt) as judgeTrial so TrialBlock's mismatch UI is shared as-is. */
export function judgeCloze(blanks: string[], expected: string[]): JudgeResult {
  for (let i = 0; i < expected.length; i++) {
    if ((blanks[i] ?? '').trim() !== (expected[i] ?? '').trim()) {
      return { verdict: 'incorrect', mismatchAt: i + 1 };
    }
  }
  return { verdict: 'correct', mismatchAt: null };
}
