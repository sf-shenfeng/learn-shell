// StateDot — 圆点统一案 二次裁定 (实机截图复核, 2026-07-22): 全站有两个圆点
// 家族，之前被误当一个尺寸处理。
//
//   ROW 家族 — Cards.tsx CardRow / Courses.tsx LessonRow 这类"列表行"里的
//   状态点，其视觉参照物是 Cards 卡片行 (dotForCard 原来的 14px 字体字形
//   ◐/●/○/◉)。
//   TILE 家族 — Cards.tsx StatTile 的迷你点 (7px CSS 圆)，尺寸不变，不在
//   本组件管辖范围内，仍由 StatTile 自己内联画。
//
// 本组件只服务 ROW 家族，且只画真正的圆 (ring/half/solid 三态)，不接管
// 非圆形的图标字形 (比如 CardRow 的暂停 "⏸" 依旧是文本字形——它不是这次
// "字体画圆漂移" 要治的病，画圆的字符在不同字重/字体下光学直径不稳定，
// 暂停条不是圆，没有这个问题，不硬塞进这个组件)。
//
// 直径测量方法: 用 canvas.measureText 的 actualBoundingBox* 系列 API
// (Chrome, Geist 字体栈, 13px —— CardRow 里 dot.glyph 的真实 font-size)
// 量 ●/○/◐/◉ 四个字形的墨迹包围盒, 取其中 solid "●" 的墨迹直径作为
// "看着最像一个点" 的参照 (环形字形 ○ 的墨迹框略大, 因为描边撑开了
// 包围盒, 但视觉上环和实心点应该同一外径, 不该环形更大)。测出来落在
// 9–11px 区间, 取整 10px。
export const ROW_DOT_DIAMETER = 10;

export type StateDotShape = 'ring' | 'half' | 'solid';

/**
 * StateDot — CSS-geometry circle (no font glyphs). `size` defaults to the
 * ROW family diameter; pass it explicitly only if a future third dot
 * family needs a different size (don't repurpose this for the TILE family
 * — StatTile's 7px dots are a deliberately separate, smaller species and
 * stay inline in Cards.tsx per the 2026-07-22 ruling above).
 */
export function StateDot({
  shape,
  color,
  size = ROW_DOT_DIAMETER,
}: {
  shape: StateDotShape;
  color: string;
  size?: number;
}) {
  // 发丝线裁决 (2026-07-22): 圆环描边 0.5px——环是提示不是边框,
  // 与全站 hairline 语言一致;半圆的骨架同宽,存在感全靠填充不靠描边。
  const base: React.CSSProperties = {
    display: 'inline-block',
    width: `${size}px`,
    height: `${size}px`,
    borderRadius: '50%',
    boxSizing: 'border-box',
    flexShrink: 0,
  };
  if (shape === 'solid') {
    return <span style={{ ...base, background: color }} />;
  }
  if (shape === 'half') {
    return (
      <span
        style={{
          ...base,
          border: `0.5px solid ${color}`,
          background: `linear-gradient(90deg, ${color} 50%, transparent 50%)`,
        }}
      />
    );
  }
  // ring
  return <span style={{ ...base, border: `0.5px solid ${color}` }} />;
}
