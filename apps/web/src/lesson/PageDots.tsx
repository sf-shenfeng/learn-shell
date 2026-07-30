// PageDots — quick-jump strip for PagedLesson's nav footer (页点速跳案).
//
// Left/right arrow already covers "step one page"; this covers "jump
// straight to a specific page" (实机反馈: "想翻到特定页很麻烦"). Same
// setIndex path as the Prev/Next buttons — no parallel navigation state,
// no change to onProgress reporting (Pager's index effect fires exactly
// the same whether index changed via a button or a dot).
//
// Tooltip is custom & immediate (7/6 反馈: native `title` needs a ~1s
// still-hover before the browser shows it — for a strip you sweep across,
// that reads as "no tooltip at all"). One shared label positioned above
// the hovered dot; aria-label keeps the accessible name.

import { useState } from 'react';
import type { LessonPage } from './paging';
import { useT } from '../i18n';

/** First (and per docs/LESSON-BLOCKS-v1.md §1.2, only) h2 on the page.
 *  splitPages() doesn't extract this as a field, so pull it straight out
 *  of the page's markdown — light strip of inline emphasis markers so a
 *  `**bold**` heading doesn't show asterisks in the tooltip. */
function pageTitle(markdown: string): string | null {
  const m = /^##\s+(.+)$/m.exec(markdown);
  if (!m) return null;
  return m[1]!.trim().replace(/[*_`]+/g, '');
}

export default function PageDots({
  pages,
  index,
  onJump,
}: {
  pages: LessonPage[];
  index: number;
  onJump: (i: number) => void;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const { t } = useT();

  return (
    <div
      role="group"
      aria-label={t('lesson.pageDots.ariaLabel')}
      className="flex items-center justify-center flex-wrap"
      style={{ gap: '4px', padding: '2px 24px 10px', position: 'relative' }}
    >
      {pages.map((page, i) => {
        const title = pageTitle(page.markdown);
        const tooltip = page.kicker
          ? (title ? `${page.kicker} · ${title}` : page.kicker)
          : (title ?? `${t('lesson.pageDots.pagePrefix')}${i + 1}${t('lesson.pageDots.pageSuffix')}`);
        const isCurrent = i === index;
        const visited = i < index;
        return (
          <button
            key={i}
            type="button"
            aria-label={`${i + 1}. ${tooltip}`}
            aria-current={isCurrent ? 'page' : undefined}
            onClick={() => onJump(i)}
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered((h) => (h === i ? null : h))}
            onFocus={() => setHovered(i)}
            onBlur={() => setHovered((h) => (h === i ? null : h))}
            className="flex items-center justify-center rounded-full"
            style={{
              width: '18px',
              height: '18px',
              padding: 0,
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              position: 'relative',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: isCurrent ? 'var(--ls-structure)' : 'var(--ls-text-tertiary)',
                opacity: isCurrent ? 1 : visited ? 0.6 : 0.3,
                display: 'block',
                transition: 'opacity var(--ls-duration-fast) ease, background var(--ls-duration-fast) ease',
              }}
            />
            {hovered === i && (
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  bottom: '24px',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  whiteSpace: 'nowrap',
                  padding: '3px 9px',
                  borderRadius: '6px',
                  border: '1px solid var(--ls-border-strong)',
                  background: 'var(--ls-panel)',
                  color: 'var(--ls-text)',
                  fontSize: '11px',
                  lineHeight: '16px',
                  boxShadow: '0 3px 10px rgba(0, 0, 0, 0.3)',
                  pointerEvents: 'none',
                  zIndex: 20,
                }}
              >
                {tooltip}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
