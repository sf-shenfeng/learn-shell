import JournalPage from '../journal/JournalPage';

/**
 * Sessions route → Journal-α.
 *
 * "学习传记"：时间线 + 三类条目 (课/Live/复习日) + 成果行 + "{称谓} 说"。
 * 取代原来的原始 session/event 调试视图——没有任何在用 UI 链接到
 * /sessions/:sessionId (仅 repository 内部路径同名), 所以两个路由
 * (App.tsx 未改动) 都渲染同一个 Journal；旧的逐事件时间线视图不再需要。
 */
export default function Sessions() {
  return <JournalPage />;
}
