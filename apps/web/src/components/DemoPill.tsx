// DemoPill — 首跑入学设计单 §五.1 设计单裁决.
//
// 视觉零新设计: LessonStatusBadge 同形制 (border + dot + uppercase pill,
// 同字号同 padding), 颜色中性灰 (--ls-text-tertiary) — 绿归 live/学习者完成
// 勋章, 琥珀归"需要你回头看", DEMO 两个都不冒充。
//
// 位置纪律 (两层两问): 不进页眉 — 页眉 pill 标"连接模式" (DEMO/LIVE/EMPTY
// = repo mode), 这个 pill 标"数据身份" (这条 pair 是 seed:demo 的样板间)。
// 只出现在 pair 身份露脸处 (Settings 档案区), 由宿主决定挂载, 本组件只管
// "查 + 画": pair 不带 is_demo 时安静不渲染 (LessonStatusBadge 的沉默哲学)。
//
// 本体是数据列 is_demo (迁移 0042, 服务端并行工单) — pill 只是它的可见形。

import { useQuery } from '@tanstack/react-query';
import { useRepository } from '../repository';
import { useT } from '../i18n';
import type { OnboardingRepo } from '../repository/onboardingExt';

/** Shared query for "is the current pair demo data?" — cached per repo mode. */
export function usePairIsDemo(): boolean {
  const repo = useRepository();
  const onboardingRepo = repo as (typeof repo & OnboardingRepo) | null;
  const q = useQuery({
    queryKey: ['pair-meta', repo?.mode ?? 'empty'],
    queryFn: () =>
      onboardingRepo ? onboardingRepo.getCurrentPairWithMeta() : Promise.resolve(null),
    enabled: !!onboardingRepo,
  });
  return q.data?.is_demo === true;
}

export function DemoPill() {
  const { t } = useT();
  const isDemo = usePairIsDemo();
  if (!isDemo) return null;
  const color = 'var(--ls-text-tertiary)';
  return (
    <span
      className="inline-flex items-center border tracking-[0.04em] uppercase font-medium"
      title={t('pill.demoTitle')}
      style={{
        padding: '2px 8px',
        borderRadius: '999px',
        fontSize: '10px',
        lineHeight: '14px',
        borderColor: color,
        color,
        gap: '6px',
      }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
      {t('pill.demo')}
    </span>
  );
}
