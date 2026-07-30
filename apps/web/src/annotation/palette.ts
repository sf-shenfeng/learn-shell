// Annotation color palette — reused, not reinvented
// ("颜色即分类学", 2026-07-05 定版 —
// annotation colors are the SAME color-key set as Mindmap's node-fill
// swatch (apps/web/src/pages/Mindmap.tsx `NODE_COLORS`, ~line 398). Copied
// here rather than imported: Mindmap.tsx is out of this batch's file domain
// (read-only reference per brief §先读 3) and `NODE_COLORS` isn't exported
// there today. Keep these two arrays in sync by hand — flagged in the
// batch B report as a duplication risk worth lifting to a shared token
// module in a later batch.
//
// Mindmap's 'default' swatch (hex: '', meaning "no fill") has no annotation
// equivalent — a highlight always needs a visible color, there's no
// "colorless" annotation, so that entry is dropped here.

export interface AnnotationColorSwatch {
  key: string;
  hex: string;
}

export const ANNOTATION_COLORS: AnnotationColorSwatch[] = [
  { key: 'blue', hex: '#5b8def' },
  { key: 'green', hex: '#3ba55c' },
  { key: 'amber', hex: '#d99b3e' },
  { key: 'red', hex: '#d95757' },
  { key: 'purple', hex: '#8a6fd6' },
];

/** brief 交付物 1: 默认色仍 amber — 按 H 落笔时不必先选色. */
export const DEFAULT_ANNOTATION_COLOR = 'amber';

const FALLBACK_HEX = ANNOTATION_COLORS.find((c) => c.key === DEFAULT_ANNOTATION_COLOR)!.hex;

/** Color key → hex, falling back to the default color's hex for any
 *  legacy/unknown key (batch A's 'amber' string always resolves; this also
 *  guards against future drift if the palette ever changes shape). */
export function annotationColorHex(key: string): string {
  return ANNOTATION_COLORS.find((c) => c.key === key)?.hex ?? FALLBACK_HEX;
}

/** CSS Custom Highlight API names must be valid <custom-ident>s — color
 *  keys are already lowercase ascii, so this is an identity map today, just
 *  centralizing the naming convention shared between useAnnotations'
 *  per-color registration and its cleanup pass. */
export function annotationHighlightName(key: string): string {
  return `ls-annotation-${key}`;
}
