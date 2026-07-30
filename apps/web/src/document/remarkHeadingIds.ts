// remarkHeadingIds — assigns the same slugs extractHeadings() computed
// (headings.ts) onto the rendered H2/H3 nodes' `id` attribute, so the
// sidebar TOC's anchor links (`#slug`) land on the actual heading elements.
//
// Deliberately does NOT re-derive slugs itself — it just walks headings in
// document order and pops the next entry off the array the caller already
// built from the same raw markdown (headings.ts's extractHeadings), so the
// sidebar list and the rendered anchors can never disagree about what a
// heading's id is. Standard "set hProperties in a remark transformer" trick
// (the same mechanism packages like remark-slug use) — no new dependency,
// same call apps/web/src/lesson/remarkLsBlocks.ts's own hand-rolled plugins
// already make.

import { visit } from 'unist-util-visit';
import type { DocHeading } from './headings';

interface HeadingNode {
  type: 'heading';
  depth: number;
  data?: { hProperties?: Record<string, unknown> };
}

export function remarkHeadingIds(headings: DocHeading[]) {
  return (tree: unknown) => {
    let i = 0;
    visit(tree as never, 'heading', (node: HeadingNode) => {
      if (node.depth !== 2 && node.depth !== 3) return;
      const h = headings[i++];
      if (!h) return;
      node.data ??= {};
      node.data.hProperties = { ...(node.data.hProperties ?? {}), id: h.slug };
    });
  };
}
