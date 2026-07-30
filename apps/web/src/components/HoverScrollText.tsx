// HoverScrollText — 悬停滚动读全案 (v1 发射前修批, 学习者当面点名:
// "所有分类的标签的 Pill 上, 如果标签内容展示不全, 在鼠标悬停的时候要进行
// 滚动呈现。这个也适用于左边栏里 Recents 那一部分, 下面的标题").
//
// 一份实现, 两族共用 (Journal 的课程 chip / 课程筛选 chip / 左栏 Recent 三行) ——
// 不在 Pill 和 RecentRail 各写一份。
//
// 纪律 (逐条对应验收判据):
//
// 1) 只在真溢出时才动。scrollWidth > clientWidth 是唯一判据, 而且只在
//    pointerenter 那一刻量一次 —— 没有 ResizeObserver, 没有常驻测量
//    (隐身术: 不为一个文本块引入测量机制, 见 journal/entries/shared.tsx
//    CollapsibleText 的同款克制)。短标签一辈子不进动画分支, 满屏 chip 不会
//    跟着鼠标挨个抖。
//
// 2) 尊重 prefers-reduced-motion。直接复用 shell/FlipCard.tsx 已有的
//    usePrefersReducedMotion (read once + subscribe), 开启时整条动画分支
//    短路, 退回原来的静态截断 + title。
//
// 3) 静止态就是今天的样子。host 保留调用方原本的 truncate / overflow+ellipsis,
//    尺寸完全由调用方的 flex / max-width 决定; 位移发生在容器内部的 inner
//    span 上, 永远不撑大 pill, 不推动邻居。
//
// 4) 往返, 不循环。400ms 延迟 → 匀速滚到尾 → 停 600ms → 平滑滚回起点 → 停住。
//    循环跑马灯有"接缝", 读起来累; 往返一趟读完就安静 (doneRef 上闩, 指针离开
//    才复位)。
//
// 5) 速度是恒定像素/秒, 不是恒定时长 —— 长标签不该滚得更快, 长短标签的阅读
//    速度必须一致, 所以 duration = distance / SPEED。
//
// 6) 全程 CSS transform + transition (GPU 合成), 没有 scrollLeft 逐帧 JS 驱动。
//
// display: inline ↔ inline-block 的那一手:
//   静止态 inner 是 display:inline —— 对布局和 text-overflow:ellipsis 完全
//   透明, host 的省略号照常渲染。transform 不作用于非替换的 inline 元素,
//   所以动画开始前一帧才切成 inline-block (顺带把 host 的 textOverflow 压成
//   clip —— 滚动中间挂个省略号是错的)。切 display 与起跑分两帧提交, 中间
//   forced reflow, 手法照抄 FlipCard 的 snap 那一段, 否则浏览器可能把
//   "display 变了 + transform 变了" 当成同一次样式变更而根本不跑 transition。

import { useEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from '../shell/FlipCard';

/** hover 后延迟多久起跑。鼠标扫过一列标签时不能让它们挨个抖起来。 */
const START_DELAY_MS = 400;
/** 前程速度 (px/s)。恒定速率, 长短标签阅读节奏一致。 */
const SCROLL_SPEED_PX_S = 45;
/** 滚到尾的停顿 —— 让最后几个字有被读完的时间。 */
const END_HOLD_MS = 600;
/** 回程速度 (px/s)。回程不用读, 走快一倍。 */
const RETURN_SPEED_PX_S = 90;
/**
 * 回程缓动。这里没有用 --ls-easing —— 实测过: 那条曲线 (0.16,1,0.3,1) 是
 * 重度前载的 ease-out, 铺在一趟 2s 的长回程上会变成"猛地窜一下 + 最后几十
 * px 慢慢爬 1.7 秒", 不是"平滑滚回起点"。改用对称的 sine-in-out: 两头轻、
 * 中段稳, 长短回程读起来都是一次干净的滑回。局部动画常量而非新 token, 判例
 * 同 shell/FlipCard.tsx 的 FLIP_EASE_IN。
 */
const RETURN_EASE = 'cubic-bezier(0.45, 0, 0.55, 1)';
/**
 * 鼠标移开的回程时长 (固定)。必须 < START_DELAY_MS: 指针离开又立刻回来时,
 * 这趟回程会在下一次起跑前自然跑完, 于是 arm 那一帧的 translateX(0) 不会
 * 从半路瞬移。
 */
const LEAVE_RETURN_MS = 240;
/** 溢出判定容差 —— scrollWidth/clientWidth 是整数, 亚像素不算溢出。 */
const OVERFLOW_EPSILON_PX = 1;
/** 多滚 2px, 抵消 scrollWidth 取整可能少报的那一点, 末字不贴着裁切边。 */
const TAIL_PX = 2;

type Phase =
  | { kind: 'rest' }
  /** 已切 inline-block、仍在起点、无 transition —— 起跑前的那一帧。 */
  | { kind: 'arm' }
  | { kind: 'out'; d: number; ms: number }
  /** 停在尾端, 无 transition。 */
  | { kind: 'hold'; d: number }
  | { kind: 'home'; ms: number };

export default function HoverScrollText({
  text,
  className,
  style,
  title,
}: {
  /** 纯文本 —— 需要被量宽度, 所以不收 ReactNode。 */
  text: string;
  /**
   * 挂在 host 上。**必须**自带裁切 (Tailwind `truncate`, 或 inline style 里的
   * overflow:hidden + white-space:nowrap) —— 本组件不替调用方决定截断策略,
   * 静止态长什么样完全由这里说了算。
   */
  className?: string;
  style?: React.CSSProperties;
  /** 原生 tooltip, 静止态/reduced-motion 下的兜底读法。 */
  title?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const hostRef = useRef<HTMLSpanElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'rest' });
  // 同步镜像 —— pointerleave 要在事件里立刻知道当前相位, 不能等 state。
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;
  const timersRef = useRef<number[]>([]);
  const rafRef = useRef<number | null>(null);
  /** 一次 hover 只往返一趟。指针离开才复位 —— 这就是"不循环"。 */
  const doneRef = useRef(false);

  const clearTimers = () => {
    for (const id of timersRef.current) window.clearTimeout(id);
    timersRef.current = [];
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };
  const after = (ms: number, fn: () => void) => {
    timersRef.current.push(window.setTimeout(fn, ms));
  };

  useEffect(() => clearTimers, []);

  // 文案换了 (计数变化、切换课程) —— 上一轮的"读完了"作废, 相位归零。
  useEffect(() => {
    doneRef.current = false;
    clearTimers();
    setPhase({ kind: 'rest' });
  }, [text]);

  // 偏好中途切到 reduce —— 立刻停手回静态。
  useEffect(() => {
    if (!reduced) return;
    clearTimers();
    doneRef.current = false;
    setPhase({ kind: 'rest' });
  }, [reduced]);

  const handleEnter = () => {
    if (reduced || doneRef.current) return;
    const host = hostRef.current;
    if (!host) return;
    // 唯一判据。未溢出 → 什么都不做, 元素完全静止。
    if (host.scrollWidth - host.clientWidth <= OVERFLOW_EPSILON_PX) return;
    clearTimers();
    after(START_DELAY_MS, () => {
      setPhase({ kind: 'arm' });
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const h = hostRef.current;
        if (!h) return;
        // 强制 layout, 让浏览器先提交 inline-block + translateX(0) 那一帧,
        // 下一次 state 才会真的跑出一段 transition (FlipCard 同款手法)。
        void h.offsetHeight;
        const d = h.scrollWidth - h.clientWidth + TAIL_PX;
        if (d <= TAIL_PX) {
          setPhase({ kind: 'rest' });
          return;
        }
        const outMs = Math.round((d / SCROLL_SPEED_PX_S) * 1000);
        setPhase({ kind: 'out', d, ms: outMs });
        after(outMs, () => {
          setPhase({ kind: 'hold', d });
          after(END_HOLD_MS, () => {
            const backMs = Math.round((d / RETURN_SPEED_PX_S) * 1000);
            setPhase({ kind: 'home', ms: backMs });
            after(backMs, () => {
              doneRef.current = true; // 往返一趟, 停住
              setPhase({ kind: 'rest' });
            });
          });
        });
      });
    });
  };

  const handleLeave = () => {
    clearTimers();
    doneRef.current = false;
    if (phaseRef.current.kind === 'rest') return; // 本来就没动, 别为它切 display
    // 立刻平滑回起点 —— transition 从当前 computed transform 起算, 既不停在
    // 半路也不瞬移。
    setPhase({ kind: 'home', ms: LEAVE_RETURN_MS });
    after(LEAVE_RETURN_MS, () => setPhase({ kind: 'rest' }));
  };

  const animating = phase.kind !== 'rest';
  const innerStyle: React.CSSProperties = animating
    ? {
        display: 'inline-block',
        willChange: 'transform',
        transform:
          phase.kind === 'out' || phase.kind === 'hold'
            ? `translateX(${-phase.d}px)`
            : 'translateX(0)',
        transition:
          phase.kind === 'out'
            ? `transform ${phase.ms}ms linear`
            : phase.kind === 'home'
              ? `transform ${phase.ms}ms ${RETURN_EASE}`
              : 'none',
      }
    : {};

  return (
    <span
      ref={hostRef}
      className={className}
      title={title}
      onPointerEnter={handleEnter}
      onPointerLeave={handleLeave}
      style={animating ? { ...style, textOverflow: 'clip' } : style}
    >
      <span style={innerStyle}>{text}</span>
    </span>
  );
}
