// DocRail — Reading 文章页的"其他文档"快速导航栏.
//
// 右栏细轨家族的第三名成员：Mind Map 的 Inspector → Review 的 DeckRail
// (apps/web/src/review/DeckRail.tsx, 该文件的文档注释里讲了这套语言的源头)
// → 这里。220px 展开面板 / 40px 竖排细轨收起态、border var(--ls-border)、
// borderRadius 10px、sticky top 12px、"›" 收起按钮、同款
// hover:bg-[var(--ls-panel)] transition-colors、行样式同 DeckRail 的
// DeckRow（13px 字、truncate、选中 bg-panel）——像素级同族，不重新发明。
//
// 比 DeckRail 简单的地方：这里没有 per-item 的展开/浏览（一篇文档要么是当前
// 打开的那篇，要么不是），也没有 due/count 徽标，只是该 pair 的文档平铺列
// 表，当前文档高亮，点击其他行由调用方 onSelect 处理导航（DocumentReader.tsx
// 接的是 useNavigate，跟 DocumentsPage.tsx 列表行用的路由模式一致）。
//
// 空态与 DeckRail 对齐：文档数 < 2 时没有"其他文档"可跳，栏不渲染（brief 的
// "只有 1 篇文档时导航栏不渲染"，对应 DeckRail 的 `decks.length === 0` 早退）。
import { useT } from '../i18n';
import type { DocumentId } from './types';

export function DocRail({
  documents,
  currentId,
  collapsed,
  onToggleCollapse,
  onSelect,
}: {
  documents: ReadonlyArray<{ id: DocumentId; title: string }>;
  currentId: DocumentId;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onSelect: (id: DocumentId) => void;
}) {
  const { t } = useT();
  if (documents.length < 2) return null;

  // Rail mode — click anywhere on the 40px column to expand. Same shape as
  // DeckRail's own collapsed rail (width/padding/vertical label/hover token).
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onToggleCollapse}
        className="flex-none flex items-center justify-center border border-[var(--ls-border)] bg-[var(--ls-bg)] hover:bg-[var(--ls-panel)] transition-colors"
        style={{
          width: 40,
          minHeight: 160,
          borderRadius: '10px',
          padding: '12px 0',
          writingMode: 'vertical-rl',
          textOrientation: 'mixed',
          fontSize: '11px',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--ls-text-secondary)',
          gap: '10px',
          position: 'sticky',
          top: '12px',
          alignSelf: 'flex-start',
        }}
        title={t('reading.docRail.expandTitle')}
      >
        <span>
          {t('reading.docRail.heading')}
          {documents.length ? ` · ${documents.length}` : ''}
        </span>
      </button>
    );
  }

  return (
    <aside
      className="flex-none border border-[var(--ls-border)]"
      style={{
        width: '220px',
        padding: '14px 12px',
        borderRadius: '10px',
        position: 'sticky',
        top: '12px',
        alignSelf: 'flex-start',
        maxHeight: 'calc(100vh - 24px)',
        overflowY: 'auto',
      }}
    >
      <div
        className="flex items-center justify-between"
        style={{ marginBottom: '10px', padding: '0 6px' }}
      >
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--ls-text-tertiary)]">
          {t('reading.docRail.heading')}
        </div>
        <button
          type="button"
          onClick={onToggleCollapse}
          className="text-[13px] text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text)] transition-colors"
          style={{ padding: '2px 6px', lineHeight: '1' }}
          title={t('reading.docRail.collapseTitle')}
        >
          ›
        </button>
      </div>
      <ul className="flex flex-col" style={{ gap: '2px' }}>
        {documents.map((d) => (
          <li key={d.id}>
            <button
              type="button"
              onClick={() => onSelect(d.id)}
              className={`w-full flex items-center rounded-[var(--ls-radius-control)] transition-colors duration-[var(--ls-duration-fast)] ${
                d.id === currentId
                  ? 'bg-[var(--ls-panel)] text-[var(--ls-text)]'
                  : 'text-[var(--ls-text-secondary)] hover:bg-[var(--ls-panel)]'
              }`}
              style={{ padding: '7px 10px', gap: '8px' }}
            >
              <span className="text-[13px] leading-5 font-medium truncate text-left flex-1 min-w-0">
                {d.title}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
