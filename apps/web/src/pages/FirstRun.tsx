// FirstRun — 首跑入学页 (首跑入学设计单 §三.3).
//
// 挂载点: AppShell 的主栏 (OutletOrFirstRun) — live 模式且 /pair/current 明确
// 回答"没有 pair"时替掉 Outlet 整体渲染 (PairProvider.pairMissing)。没有
// pair 的 live 库里任何路由都只是空数据噪音, 与其每页各自演一遍空态, 不如
// 一页把"这里还没开始"说清楚。seeded/empty 模式永不出现 (demo 模式自带数
// 据, mock pair 就是样板间); 服务端不可达也不出现 (那是连接问题, 不是首跑)。
//
// 内容两件 (设计单原句):
//   ① "等你的 agent 来敲门" — MCP 接线指引一屏版, 贴 SETUP.md 已有命令。
//   ② 学习者名字输入位 — 主权仪式 (设计单裁定: 名字由学习者亲手敲, agent 代填
//     即越权)。POST /onboarding/learner, 成功态提示让 agent 调 create_pair。
//
// 建对本身发生在学习者与 agent 的第一场对话里 (对话是界面) — 这页只做等待
// 与见证: PairProvider 的 5s 轻轮询发现 pair 出生后, 这页自动让路。

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRepository } from '../repository';
import { useT } from '../i18n';
import type { OnboardingRepo, RegisteredLearner } from '../repository/onboardingExt';

// SETUP.md §4 "Wire your agent to the MCP server" 与 README "For agents" 第 1 条
// 的原句命令 — 首跑页贴现成的, 不新造措辞。三处必须语义同源。
//
// 两个部件都不是装饰 (回归 N1):
//   · `-e DATABASE_URL=…` — MCP 入口**不**加载 apps/server/.env, 它直连 Postgres,
//     变量不进 MCP 子进程的环境, 第一笔 DB 调用就拒。首跑页曾漏这一段, fresh
//     user 照着复制必翻车。连接串与 docker-compose.yml 的 POSTGRES_* 同源。
//   · `pnpm -C <绝对路径>` — MCP 子进程的 cwd 由客户端决定, 不是你敲 `claude mcp
//     add` 时所在的目录; 裸 `--filter` 会在别处解析不到 workspace。顺带也绕开
//     "tsx 不是全局命令"那一坑 (它只是 apps/server 的 devDependency)。
const MCP_ADD_COMMAND =
  'claude mcp add learn-shell ' +
  '-e DATABASE_URL="postgresql://learn_shell:learn_shell_dev@localhost:5432/learn_shell" ' +
  '-- pnpm -C /absolute/path/to/learn-shell --filter @learn-shell/server mcp';

export default function FirstRun({
  demoAvailable,
  onEnterDemo,
}: {
  // 焊缝修复: 库里是否存在样板间 (is_demo pair) —— PairProvider 靠
  // /onboarding/status 的 demo_pair_count 顺带探得。旧后端(该端点不存在)
  // 回退路径下探不到, 保持 false 是安全默认: 不多秀一个进不去的入口。
  demoAvailable?: boolean;
  // 点击"先逛逛样板间"后的放行回调 —— 由 AppShell 的 OutletOrFirstRun
  // 持有 sessionStorage 旁路标记, 这里只管触发, 不管标记本身怎么存。
  onEnterDemo?: () => void;
}) {
  const { t, lang } = useT();
  const repo = useRepository();
  const onboardingRepo = repo as (typeof repo & OnboardingRepo) | null;

  const [name, setName] = useState('');
  const [registered, setRegistered] = useState<RegisteredLearner | null>(null);

  const trimmed = name.trim();
  const nameValid = trimmed.length >= 1 && trimmed.length <= 80;

  const registerMut = useMutation({
    mutationFn: async () => {
      if (!onboardingRepo) throw new Error('no repository');
      return onboardingRepo.registerLearner({ display_name: trimmed, locale: lang });
    },
    onSuccess: (learner) => setRegistered(learner),
  });
  const canSubmit = nameValid && !registerMut.isPending && !!onboardingRepo;

  return (
    <div style={{ maxWidth: '580px' }}>
      <h1
        className="font-bold text-[24px] leading-[32px] tracking-[-0.02em]"
        style={{ margin: 0, marginBottom: '4px' }}
      >
        {t('firstRun.title')}
      </h1>
      <p
        className="text-[13px] leading-5 text-[var(--ls-text-secondary)]"
        style={{ marginBottom: '28px' }}
      >
        {t('firstRun.subtitle')}
      </p>

      {/* ① MCP 接线指引 — 一屏版, 贴 SETUP 已有命令 */}
      <section style={{ marginBottom: '28px' }}>
        <h2 className="font-semibold text-[15px] leading-6" style={{ margin: 0, marginBottom: '6px' }}>
          {t('firstRun.wire.heading')}
        </h2>
        <p
          className="text-[13px] leading-5 text-[var(--ls-text-secondary)]"
          style={{ marginBottom: '10px' }}
        >
          {t('firstRun.wire.body')}
        </p>
        <pre
          className="font-mono text-[11px] leading-[17px] text-[var(--ls-text-secondary)] whitespace-pre-wrap select-all border border-[var(--ls-border)] bg-[var(--ls-bg-subtle)]"
          style={{ margin: 0, padding: '10px 12px', borderRadius: '8px' }}
        >
          {MCP_ADD_COMMAND}
        </pre>
        <p
          className="text-[11px] leading-4 text-[var(--ls-text-tertiary)]"
          style={{ marginTop: '8px' }}
        >
          {t('firstRun.wire.otherClients')}
        </p>
      </section>

      {/* ② 名字输入位 — 主权仪式 */}
      <section>
        <h2 className="font-semibold text-[15px] leading-6" style={{ margin: 0, marginBottom: '6px' }}>
          {t('firstRun.name.heading')}
        </h2>
        <p
          className="text-[13px] leading-5 text-[var(--ls-text-secondary)]"
          style={{ marginBottom: '12px' }}
        >
          {t('firstRun.name.body')}
        </p>

        {registered ? (
          <div
            className="border border-[var(--ls-border)] text-[13px] leading-5"
            style={{ padding: '14px 16px', borderRadius: '8px' }}
          >
            <div className="font-medium text-[var(--ls-text)]">
              {t('firstRun.name.registeredPrefix')}
              {registered.display_name}
              {t('firstRun.name.registeredSuffix')}
            </div>
            <div className="text-[var(--ls-text-secondary)]" style={{ marginTop: '6px' }}>
              {t('firstRun.name.registeredNext')}
            </div>
            <div
              className="text-[11px] leading-4 text-[var(--ls-text-tertiary)]"
              style={{ marginTop: '8px' }}
            >
              {t('firstRun.waitingNote')}
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center" style={{ gap: '10px' }}>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  if (e.key === 'Enter' && canSubmit) registerMut.mutate();
                }}
                maxLength={80}
                placeholder={t('firstRun.name.placeholder')}
                aria-label={t('firstRun.name.heading')}
                className="flex-1 border border-[var(--ls-border)] bg-[var(--ls-bg)] text-[var(--ls-text)] text-[13px] focus:outline-none focus:border-[var(--ls-border-strong)]"
                style={{ height: '32px', padding: '0 10px', borderRadius: '6px' }}
              />
              <button
                type="button"
                onClick={() => registerMut.mutate()}
                disabled={!canSubmit}
                className="inline-flex items-center border border-[var(--ls-border)] hover:bg-[var(--ls-panel)] disabled:opacity-50 transition-colors duration-[var(--ls-duration-fast)]"
                style={{ height: '32px', padding: '0 14px', borderRadius: '6px', fontSize: '12px', flexShrink: 0 }}
              >
                {registerMut.isPending ? t('firstRun.name.registering') : t('firstRun.name.registerButton')}
              </button>
            </div>
            <p
              className="text-[11px] leading-4 text-[var(--ls-text-tertiary)]"
              style={{ marginTop: '8px' }}
            >
              {t('firstRun.name.hint')}
            </p>
            {registerMut.isError && (
              <p className="text-[11px] leading-4" style={{ marginTop: '6px', color: 'var(--ls-risk)' }}>
                {t('firstRun.name.failed')}
              </p>
            )}
          </>
        )}
      </section>

      {/* 焊缝修复: 库里只有样板间时首跑页会一直挡着 (符合设计——样板间
          不算入学), 但学习者应该能先看看样板间长什么样再决定要不要接
          agent。隐身术美学: 次要文字色, 不抢①②两件正事的位置, 底部单行,
          点一下当场放行进入正常应用 (本会话内, OutletOrFirstRun 存
          sessionStorage 旁路标记)。 */}
      {demoAvailable && onEnterDemo && (
        <button
          type="button"
          onClick={onEnterDemo}
          className="text-[12px] leading-4 text-[var(--ls-text-tertiary)] hover:text-[var(--ls-text-secondary)] transition-colors duration-[var(--ls-duration-fast)]"
          style={{ marginTop: '28px', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
        >
          {t('firstRun.demoLink')}
        </button>
      )}
    </div>
  );
}
