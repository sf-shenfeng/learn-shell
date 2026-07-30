import { Suspense, lazy, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import AppShell from './shell/AppShell';
import Contract from './pages/Contract';
import Courses from './pages/Courses';
import Review from './pages/Review';
import Cards from './pages/Cards';
import Sessions from './pages/Sessions';
import Quiz from './pages/Quiz';
import Mindmap from './pages/Mindmap';
import Settings from './pages/Settings';
import AdHocPopupPage from './pages/AdHocPopupPage';
import { hasStoredRepositoryMode, setRepositoryMode } from './repository';
import { API_BASE_URL } from './lib/apiBase';

// Lazy-load Lesson: react-markdown + remark-gfm + their lodash deps add ~140 kB
// that we don't need until the user opens a lesson.
const Lesson = lazy(() => import('./pages/Lesson'));
// 批G: DocumentReader pulls in the same
// react-markdown + remark-gfm weight Lesson does — same lazy-load rationale.
const DocumentReader = lazy(() => import('./document/DocumentReader'));
const DocumentsPage = lazy(() => import('./document/DocumentsPage'));

function LessonFallback() {
  return (
    <p className="text-sm text-[var(--ls-text-tertiary)] p-6">Loading lesson runtime…</p>
  );
}

export default function App() {
  // 演示门案: 后端活着，门却默认演示数据 (seeded) — self-host 用户装完
  // 打开满屏假课，以为坏了。决策链：只在"从没存过 repo-mode"(真·首次访问)
  // 时探一次 /health；用户已经显式选过模式（哪怕就是 seeded）就永不探、永
  // 不覆盖——用户主权高于自动探活。挂在 App 根而不是某个页面，是为了让切换
  // 尽早发生，避免用户已经在 seeded 里点了半天才被切走；probe 完成时二次
  // 检查 hasStoredRepositoryMode()，如果探活期间用户自己用 ⌘K 切了模式，
  // 以用户的手动选择为准，绝不用探活结果覆盖。
  useEffect(() => {
    if (hasStoredRepositoryMode()) return;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500);
    const healthUrl = `${API_BASE_URL.replace(/\/api\/?$/, '')}/health`;
    fetch(healthUrl, { signal: controller.signal })
      .then(async (res) => {
        // degraded 不许伪装健康: 只看 res.ok 不够——db 不可达时服务端现在
        // 回 503 (res.ok 已经是 false), 但双保险不嫌多: body.status 也必须是
        // 'ok' 才切 live, 防止将来任何一侧的判定单独松动就被另一侧兜住。读 body
        // 失败 (非 JSON / 网络中途断) 一律按不健康处理, 留在 seeded 默认。
        let body: { status?: string } | null = null;
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        const healthy = res.ok && body?.status === 'ok';
        // Re-check: user may have picked a mode manually while this was in flight.
        if (healthy && !hasStoredRepositoryMode()) {
          setRepositoryMode('live');
          // 演示门连带修（2026-07-11 bench 现场抓获）：seeded 首屏已把 mock
          // 数据灌进 react-query 缓存与 pair 上下文，仅切仓储会造成新旧数据
          // 混血（假计数+错 pair 查空库）。切模式必须硬重载，从干净状态起。
          window.location.reload();
        }
      })
      .catch(() => {
        // No backend reachable (or timed out) — stay on the seeded default.
      })
      .finally(() => clearTimeout(timeoutId));
    return () => {
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, []);

  return (
    <Routes>
      {/* Stage 7e-detach: AdHoc popup window. Hoisted ABOVE AppShell so the
          popup renders without the sidebar / header / FAB chrome. */}
      <Route path="/adhoc-popup" element={<AdHocPopupPage />} />

      <Route element={<AppShell />}>
        {/* Dashboard 裁撤案: Dashboard 裁撤 — 根路由改落 Courses，与 /lesson 同一
            目标组件 (原先落 Contract，现在两个 nav 入口都不存在了，落到
            仍在导航里的 Courses 才是"进门第一眼"该看见的东西). */}
        <Route path="/" element={<Navigate to="/lesson" replace />} />

        {/* 证书化 (2026-07-08): 页面本体死了 — 签好的合同活在 Settings 的
            "证书" 区块。/contract 只剩一个签字台入口，且必须带 contractId
            (从 RecentRail 的"待签之约"行 / 顶栏轻提示 / Settings 档案的
            "继续设置" 链接进来)。裸路由没有目标合同可签，落回 Settings。 */}
        <Route path="/contract" element={<Navigate to="/settings" replace />} />
        <Route path="/contract/:contractId" element={<Contract />} />

        {/* Lesson nav (G L) — W1 shows course list; W2+ deep-links to active lesson */}
        <Route path="/lesson" element={<Courses />} />
        <Route
          path="/courses/:courseId/lessons/:lessonId"
          element={
            <Suspense fallback={<LessonFallback />}>
              <Lesson />
            </Suspense>
          }
        />

        <Route path="/review" element={<Review />} />
        <Route path="/cards" element={<Cards />} />
        <Route path="/sessions" element={<Sessions />} />
        <Route path="/sessions/:sessionId" element={<Sessions />} />

        <Route path="/quiz" element={<Quiz />} />
        <Route path="/mindmap" element={<Mindmap />} />

        {/* 批G Reading — /documents list +
            /documents/:documentId reader, same lazy-load pattern as Lesson
            above. */}
        <Route
          path="/documents"
          element={
            <Suspense fallback={<LessonFallback />}>
              <DocumentsPage />
            </Suspense>
          }
        />
        <Route
          path="/documents/:documentId"
          element={
            <Suspense fallback={<LessonFallback />}>
              <DocumentReader />
            </Suspense>
          }
        />

        <Route path="/settings" element={<Settings />} />

        <Route
          path="*"
          element={
            <div className="p-6 text-sm text-[var(--ls-text-tertiary)]">Not found.</div>
          }
        />
      </Route>
    </Routes>
  );
}
