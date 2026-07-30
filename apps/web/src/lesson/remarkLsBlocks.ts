// remark plugins for LS lesson blocks — docs/LESSON-BLOCKS-v1.md §2.
//
// remarkLsBlocks: runs AFTER remark-directive. Maps `:::` container
// directives onto custom hast element names that PagedLesson's component
// table renders:
//
//   field blocks  (concept-flip / formula / trial / cfa-note)
//     → fields are extracted from `**Label**: value` lines (+ trailing
//       list for e.g. Notation) and passed as a JSON prop; children are
//       consumed so nothing double-renders.
//   prose blocks  (callout)
//     → children render as markdown inside the component; `kind`
//       attribute passes through.
//   anything else (containerDirective/leafDirective) → <ls-unknown>
//     fallback container (never raw text).
//   textDirective → always reverted to literal text, never ls-unknown.
//     No block in the v1 directory is a textDirective (the five registered
//     blocks are all `:::` containerDirective; `::kicker` is pulled out by
//     paging.ts's own regex before remark ever sees it), so textDirective
//     has no legal use in this product. But remark-directive's bare
//     textDirective grammar is just "`:` + a run of non-punctuation chars"
//     — no `[label]` or `{attrs}` required, and CJK counts as
//     non-punctuation — so ordinary prose like "**重点**:说明文字" (a bold
//     label followed directly by a half-width colon and CJK text, no space)
//     parses as a directive and used to get eaten as an ls-unknown block.
//     See 真机案 自动分页兜底案 族(2026-07-11): legally paged lesson content still
//     runs the full remarkDirective pipeline (only the auto-pagination
//     fallback uses plainMarkdown mode), so this rewrite is what keeps that
//     prose intact instead of silently swallowing it.
//
// remarkMark: turns ==text== into <mark> elements.

import { visit } from 'unist-util-visit';
import { toString as mdToString } from 'mdast-util-to-string';

export interface LsBlockField {
  label: string;
  value: string;
  items?: string[];
}

const FIELD_BLOCKS = new Set(['concept-flip', 'formula', 'trial', 'cfa-note']);
const PROSE_BLOCKS = new Set(['callout']);

interface MdNode {
  type: string;
  name?: string;
  value?: string;
  attributes?: Record<string, string | null | undefined>;
  children?: MdNode[];
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
  };
}

function extractFields(node: MdNode): LsBlockField[] {
  const fields: LsBlockField[] = [];
  for (const child of node.children ?? []) {
    if (child.type === 'paragraph') {
      // A paragraph may hold several `**Label**: value` runs separated by
      // hard breaks; split on strong nodes.
      let currentField: LsBlockField | null = null;
      for (const inline of child.children ?? []) {
        if (inline.type === 'strong') {
          if (currentField) fields.push(currentField);
          currentField = { label: mdToString(inline).trim(), value: '' };
        } else if (currentField) {
          currentField.value += mdToString(inline);
        }
      }
      if (currentField) {
        currentField.value = currentField.value.replace(/^\s*[:：]\s*/, '').trim();
        fields.push(currentField);
      }
      // Normalize values for any fields captured before the last
      for (const f of fields) {
        f.value = f.value.replace(/^\s*[:：]\s*/, '').trim();
      }
    } else if (child.type === 'list' && fields.length > 0) {
      const last = fields[fields.length - 1]!;
      last.items = (child.children ?? []).map((li) => mdToString(li).trim());
    }
  }
  return fields;
}

/**
 * @param trialIndexStart 0-based offset for the first `:::trial` block this
 *   plugin instance encounters — lets each page's independent ReactMarkdown
 *   pass (PagedLesson renders one page's markdown at a time) still produce a
 *   whole-lesson-order `trialIndex` (docs/LESSON-BLOCKS-v1.md §2.3). Callers
 *   without paging (legacy single-scroll lessons) leave this at its default;
 *   the whole document is one AST pass there, so 0-based-from-start is
 *   already whole-lesson order.
 */
export function remarkLsBlocks(trialIndexStart = 0) {
  let trialCounter = trialIndexStart;
  return (tree: MdNode) => {
    visit(tree as never, (node: MdNode) => {
      if (
        node.type !== 'containerDirective' &&
        node.type !== 'leafDirective' &&
        node.type !== 'textDirective'
      ) {
        return;
      }
      const name = node.name ?? 'unknown';

      // textDirective has no legal use in v1 (see file-header comment) —
      // revert it to the literal text the author typed instead of eating it
      // as an ls-unknown block. Best-effort reconstruction of `[label]`/
      // `{attrs}` for the rare case those are present; the common bug case
      // (bare `:name`, no brackets/braces) round-trips exactly.
      if (node.type === 'textDirective') {
        let text = `:${name}`;
        if (node.children && node.children.length > 0) {
          text += `[${mdToString(node.children as never)}]`;
        }
        const attrs = node.attributes ?? {};
        const attrKeys = Object.keys(attrs);
        if (attrKeys.length > 0) {
          text +=
            '{' +
            attrKeys
              .map((key) => {
                const value = attrs[key];
                return value == null ? key : `${key}="${value}"`;
              })
              .join(' ') +
            '}';
        }
        node.type = 'text';
        node.value = text;
        delete node.name;
        delete node.attributes;
        delete node.children;
        delete node.data;
        return;
      }

      const data = node.data ?? (node.data = {});

      if (node.type === 'containerDirective' && FIELD_BLOCKS.has(name)) {
        const fields = extractFields(node);
        data.hName = `ls-${name}`;
        // NB: property-information normalizes this key to the `data-fields`
        // prop on the React side — components read props['data-fields'].
        const hProperties: Record<string, unknown> = { dataFields: JSON.stringify(fields) };
        if (name === 'trial') {
          // Same dataX→data-x normalization as dataFields above.
          hProperties.dataTrialIndex = trialCounter++;
        }
        data.hProperties = hProperties;
        node.children = []; // consumed — component renders from fields
        return;
      }
      if (node.type === 'containerDirective' && PROSE_BLOCKS.has(name)) {
        data.hName = `ls-${name}`;
        data.hProperties = { kind: node.attributes?.kind ?? 'info' };
        return;
      }
      // Unregistered directive — neutral labeled container, never raw text.
      data.hName = 'ls-unknown';
      data.hProperties = { name };
    });
  };
}

export function remarkMark() {
  return (tree: MdNode) => {
    visit(
      tree as never,
      'text',
      (node: MdNode, index: number | undefined, parent: MdNode | undefined) => {
        if (!parent || index === undefined || !node.value?.includes('==')) return;
        const parts = node.value.split(/==([^=\n]+)==/g);
        if (parts.length === 1) return;
        const replacement: MdNode[] = [];
        parts.forEach((part, i) => {
          if (i % 2 === 0) {
            if (part) replacement.push({ type: 'text', value: part });
          } else {
            replacement.push({
              type: 'strong',
              data: { hName: 'mark' },
              children: [{ type: 'text', value: part }],
            });
          }
        });
        parent.children!.splice(index, 1, ...replacement);
        return index + replacement.length;
      }
    );
  };
}
