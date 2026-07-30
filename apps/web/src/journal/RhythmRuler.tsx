// Rhythm ruler — journal timeline's activity scale. 节律尺案 重设计:
// "小方格" 贡献图的旧版 → 一条水平细线, 56 根
// 每日刻度, 今天在最右, 像机床标尺的主刻度. 不加标题不加图例 ——
// hover 才是图例. 隐身术: 这是节律条不是图表, 克制.
//
// 数据源: useJournalTimeline 已经把 entries 按天摘要好 (day → "1 课 ·
// 复习 12 张", 复用 DayGroup.summarizeDay), 这里只消费现成的 Map, 不碰
// repository / usePair — 挂点待定保持不变 (Journal 顶部 或别处都能挂).
//
// Tooltip 是自绘 + 即时的 (参照 lesson/PageDots.tsx 刚落地的样式与理由:
// 原生 title 要按住不动约 1s 才出, 对着一条要用鼠标扫过去的尺子等于没有
// tooltip). 56 根刻度共用一套 hover 状态, 逻辑与 PageDots 的单值
// hovered/setHovered 一致.
//
// 活动刻度颜色取舍 (跑起来在浏览器里两版都看过, 不是拍脑袋): 试了
// var(--ls-corroborated) 绿——太像"打卡成功"的贡献图既视感, 跟 brief
// 明确要躲开的"贡献图崇拜"撞了车; var(--ls-structure) 蓝更冷、更中性,
// 在深色底上像仪表盘信号灯而不是奖励色, 跟"机床标尺"的克制气质更配,
// 定这版。

import { useMemo, useState } from 'react';
import { useT } from '../i18n';
import { formatMonthDay, formatMonthShort } from './format';

/** 月份边界主刻度的高度上限 (px) — 其余刻度都矮于它，同时也是刻度区
 *  的固定高度，让基线始终钉在同一个 y 坐标上，不随刻度高矮跳动。 */
const TICK_AREA_HEIGHT = 14;
/** 无活动日刻度高度 (px). */
const TICK_HEIGHT_IDLE = 4;
/** 活动日刻度高度 (px, 非月份边界). */
const TICK_HEIGHT_ACTIVE = 10;
/** tooltip 与刻度区顶部的间距 (px). */
const TOOLTIP_GAP = 8;

interface RulerDay {
  key: string;
  date: Date;
  isMonthStart: boolean;
}

export default function RhythmRuler({
  daySummaries,
  weeks = 8,
}: {
  /** 天 (YYYY-MM-DD, 本地时区) → 当日摘要；没有 key = 当天无记录. */
  daySummaries: Map<string, string>;
  weeks?: number;
}) {
  const { t, lang } = useT();
  const [hovered, setHovered] = useState<number | null>(null);

  const days = useMemo<RulerDay[]>(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const totalDays = weeks * 7;
    const list: RulerDay[] = [];
    for (let i = totalDays - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      list.push({
        key: d.toLocaleDateString('en-CA'),
        date: d,
        isMonthStart: d.getDate() === 1,
      });
    }
    return list;
  }, [weeks]);

  const activeCount = days.filter((d) => daySummaries.has(d.key)).length;

  return (
    <div
      role="img"
      aria-label={`${t('journal.ruler.pastPrefix')}${weeks}${t('journal.ruler.weeksSuffix')}${activeCount}${t('journal.ruler.daysSuffix')}`}
      style={{ position: 'relative', marginBottom: '18px' }}
    >
      {/* 基线 — 固定钉在刻度区底部，与刻度高矮无关. */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: `${TICK_AREA_HEIGHT}px`,
          height: '1px',
          background: 'var(--ls-border)',
        }}
      />

      <div aria-hidden style={{ display: 'grid', gridTemplateColumns: `repeat(${days.length}, 1fr)` }}>
        {days.map((d, i) => {
          const summary = daySummaries.get(d.key);
          const active = !!summary;
          const height = d.isMonthStart ? TICK_AREA_HEIGHT : active ? TICK_HEIGHT_ACTIVE : TICK_HEIGHT_IDLE;
          const tooltip = `${formatMonthDay(d.date, lang)} · ${summary ?? '—'}`;

          return (
            <div
              key={d.key}
              style={{
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
              }}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered((h) => (h === i ? null : h))}
            >
              {/* 刻度区 — 固定高度, flex-end 让刻度从基线往上长. */}
              <div
                style={{
                  height: `${TICK_AREA_HEIGHT}px`,
                  display: 'flex',
                  alignItems: 'flex-end',
                }}
              >
                <span
                  style={{
                    width: '1px',
                    height: `${height}px`,
                    background: active ? 'var(--ls-structure)' : 'var(--ls-text-tertiary)',
                    opacity: active ? 0.9 : 0.35,
                  }}
                />
              </div>

              {/* 月份边界的极小月份标 — 只在这一天渲染, 其余天不占位. */}
              {d.isMonthStart && (
                <span
                  style={{
                    marginTop: '2px',
                    fontSize: '10px',
                    lineHeight: '12px',
                    color: 'var(--ls-text-tertiary)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {formatMonthShort(d.date, lang)}
                </span>
              )}

              {hovered === i && (
                <span
                  style={{
                    position: 'absolute',
                    bottom: `${TICK_AREA_HEIGHT + TOOLTIP_GAP}px`,
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
            </div>
          );
        })}
      </div>
    </div>
  );
}
