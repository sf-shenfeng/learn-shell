// 课程筛选 chips — 视觉语言照搬 Cards.tsx 的 FilterChip (border pill,
// active = 文字色描边), 零新 token.

import type { CourseId } from '@learn-shell/contracts';
import { useT } from '../i18n';
import HoverScrollText from '../components/HoverScrollText';

export type CourseFilter = CourseId | 'all';

export default function CourseChips({
  courses,
  selected,
  onSelect,
}: {
  courses: { id: CourseId; topic: string }[];
  selected: CourseFilter;
  onSelect: (next: CourseFilter) => void;
}) {
  const { t } = useT();
  if (courses.length === 0) return null;

  return (
    <div className="flex flex-wrap" style={{ gap: '8px', marginBottom: '18px' }}>
      <Chip label={t('journal.allCourses')} active={selected === 'all'} onClick={() => onSelect('all')} />
      {courses.map((c) => (
        <Chip
          key={c.id}
          label={c.topic}
          active={selected === c.id}
          onClick={() => onSelect(c.id)}
        />
      ))}
    </div>
  );
}

// 悬停滚动读全案: 220px 上限装不下的课名，hover 400ms 后在 chip 内部往返滚
// 一趟读全（chip 宽度不变，不推动 flex-wrap 里的邻居）。装得下的 chip 完全
// 静止 —— 一排 chip 不会跟着鼠标挨个抖。
//
// 裁切从 button 本身下沉到内层 span：overflow:hidden 裁在 padding 边，挂在
// button 上会让滚动的文字爬进左右各 13px 的 padding；顺带修好一个既有小疵 ——
// text-overflow:ellipsis 对 flex 容器（这里是 inline-flex 的 button）里的匿名
// flex item 本来就不生效，长课名原先是硬切没有省略号的。
function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className="inline-flex items-center transition-colors duration-[var(--ls-duration-fast)]"
      style={{
        height: '30px',
        padding: '0 13px',
        maxWidth: '220px',
        border: `1px solid ${active ? 'var(--ls-text)' : 'var(--ls-border)'}`,
        borderRadius: 'var(--ls-radius-pill)',
        fontWeight: 500,
        fontSize: '12px',
        lineHeight: '1',
        color: active ? 'var(--ls-text)' : 'var(--ls-text-secondary)',
        background: active ? 'var(--ls-panel)' : 'transparent',
        cursor: 'pointer',
      }}
    >
      <HoverScrollText
        text={label}
        style={{
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      />
    </button>
  );
}
