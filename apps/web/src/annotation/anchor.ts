// Annotation anchor spike — pure DOM Range <-> text-quote anchor conversion.
// No React import — keeps this testable
// in isolation from the render tree.
//
// Anchor shape:
//   { selected_text, prefix, suffix } + page_index. Resolution walks the
//   *current* DOM of the page container and searches for the best-matching
//   occurrence of selected_text, disambiguated by how well the surrounding
//   prefix/suffix match — the same "text quote + text position" technique
//   Hypothesis's dom-anchor-text-quote uses, hand-rolled here rather than
//   adding a dependency (see spike report §deviations — brief §"军规"
//   requires stopping to ask before introducing one, and this is small
//   enough not to need it).

export interface AnnotationAnchor {
  pageIndex: number;
  selectedText: string;
  prefix: string;
  suffix: string;
}

const DEFAULT_CONTEXT_LEN = 32;

/** Elements whose text is excluded from anchoring.
 *
 *  `[data-ls-block]` (batch B, brief 交付物 5) is the whole-block exclusion:
 *  ConceptFlip/FormulaPanel/TrialBlock/CfaNote's root containers all carry
 *  this marker now (apps/web/src/lesson/blocks.tsx), closing the gap the
 *  spike report flagged — CfaNote/FormulaPanel prose and TrialBlock's own
 *  question/hint/answer text sit *outside* those components' actual
 *  form controls, so the old tag-only heuristic below let selections
 *  through. `button, textarea, input, select` is kept alongside it rather
 *  than replaced — belt and suspenders for any interactive control that
 *  ends up in lesson prose without a `data-ls-block` wrapper — and `mark`
 *  stays excluded because `==mark==` is a *content-author* emphasis
 *  semantic, a different layer from the learner's own highlight. */
const EXCLUDED_SELECTOR = '[data-ls-block], button, textarea, input, select, mark';

/** True if `range` touches an excluded element anywhere along its path —
 *  not just at its two endpoints. A selection that starts and ends in prose
 *  but drags *through* an interactive block in between (boundary question a:
 *  cross-block selections) still needs to be declined, since Range.toString()
 *  would otherwise splice in the block's transient/conditional inner text
 *  (draft textarea value, "Check answer" label, …) into the anchor. Endpoint-
 *  only ancestor checks miss this; walking root's excluded elements and
 *  testing Range.intersectsNode catches it cheaply (root's excluded-element
 *  count is small — a handful of blocks per lesson page). */
function touchesExcluded(range: Range, root: Element): boolean {
  const excluded = root.querySelectorAll(EXCLUDED_SELECTOR);
  for (const el of excluded) {
    if (range.intersectsNode(el)) return true;
  }
  return false;
}

interface TextMapEntry {
  node: Text;
  start: number; // index into the flat string where this node's text begins
}

/** Flatten root's text nodes (document order) into one string plus a map
 *  back from flat-string offsets to (Text node, offset-within-node) — lets
 *  us convert plain-text indices back into a DOM Range. Traversal order
 *  matches Range.toString()'s concatenation order, so offsets computed via
 *  Range.toString().length line up with this map. */
function buildTextMap(root: Element): { text: string; map: TextMapEntry[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = '';
  const map: TextMapEntry[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const textNode = n as Text;
    const value = textNode.nodeValue ?? '';
    if (!value) continue;
    map.push({ node: textNode, start: text.length });
    text += value;
  }
  return { text, map };
}

function offsetToPoint(map: TextMapEntry[], offset: number): { node: Text; offset: number } | null {
  for (const entry of map) {
    const len = entry.node.nodeValue?.length ?? 0;
    if (offset <= entry.start + len && offset >= entry.start) {
      return { node: entry.node, offset: offset - entry.start };
    }
  }
  return null;
}

function commonPrefixLen(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a.charAt(i) === b.charAt(i)) i++;
  return i;
}

function commonSuffixLen(a: string, b: string): number {
  let i = 0;
  while (
    i < a.length &&
    i < b.length &&
    a.charAt(a.length - 1 - i) === b.charAt(b.length - 1 - i)
  ) {
    i++;
  }
  return i;
}

/** DOM Range → Anchor. Returns null when the range is empty/whitespace-only,
 *  touches an excluded region (boundary question c), or isn't inside root at
 *  all — callers treat null as "silently decline to anchor" (no annotation
 *  created), never a thrown error. */
export function serializeRange(
  range: Range,
  root: Element,
  pageIndex: number,
  contextLen: number = DEFAULT_CONTEXT_LEN
): AnnotationAnchor | null {
  const selectedText = range.toString();
  if (!selectedText.trim()) return null;
  if (!root.contains(range.commonAncestorContainer)) return null;
  if (touchesExcluded(range, root)) return null;

  // Absolute start offset within root's flat text: measure a probe range
  // from root's start to the selection's start boundary. Reuses the
  // browser's own Range.toString() concatenation instead of re-deriving
  // offsets by hand, so this stays consistent with buildTextMap's traversal.
  const preRange = document.createRange();
  preRange.selectNodeContents(root);
  preRange.setEnd(range.startContainer, range.startOffset);
  const startOffset = preRange.toString().length;
  const endOffset = startOffset + selectedText.length;

  const { text } = buildTextMap(root);
  const prefix = text.slice(Math.max(0, startOffset - contextLen), startOffset);
  const suffix = text.slice(endOffset, endOffset + contextLen);

  return { pageIndex, selectedText, prefix, suffix };
}

/** Anchor → DOM Range, searched fresh against root's *current* DOM (post
 *  refresh/re-render). Returns null on any failure to resolve — an orphan,
 *  per "永不丢行原则": never silently drop
 *  the record itself (that's the caller's job, keeping the stored anchor
 *  around for Journal's 待重新安放 list), but never guess wrong either. */
export function resolveAnchor(anchor: AnnotationAnchor, root: Element): Range | null {
  if (!anchor.selectedText) return null;
  const { text, map } = buildTextMap(root);

  const occurrences: number[] = [];
  let idx = text.indexOf(anchor.selectedText);
  while (idx !== -1) {
    occurrences.push(idx);
    idx = text.indexOf(anchor.selectedText, idx + 1);
  }
  if (occurrences.length === 0) return null; // quote text itself is gone — true orphan

  let best = occurrences[0]!;
  let bestScore = -1;
  for (const occ of occurrences) {
    const actualPrefix = text.slice(Math.max(0, occ - anchor.prefix.length), occ);
    const actualSuffix = text.slice(
      occ + anchor.selectedText.length,
      occ + anchor.selectedText.length + anchor.suffix.length
    );
    const score =
      commonSuffixLen(actualPrefix, anchor.prefix) + commonPrefixLen(actualSuffix, anchor.suffix);
    if (score > bestScore) {
      bestScore = score;
      best = occ;
    }
  }

  // Disambiguation confidence gate (boundary question b): with more than one
  // occurrence of the same quote, a zero-length context match means we
  // cannot tell them apart — better an explicit orphan (surfaced, fixable)
  // than a silent wrong-highlight guess.
  if (occurrences.length > 1 && bestScore === 0) return null;

  const startPoint = offsetToPoint(map, best);
  const endPoint = offsetToPoint(map, best + anchor.selectedText.length);
  if (!startPoint || !endPoint) return null;

  const range = document.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  return range;
}
