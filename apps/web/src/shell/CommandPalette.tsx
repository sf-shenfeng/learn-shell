import { Command } from 'cmdk';
import { useNavigate } from 'react-router-dom';
import { applyTheme, setStoredTheme, type Theme } from '@learn-shell/ui';
import { setRepositoryMode } from '../repository';
import { useT } from '../i18n';
import type { Lang } from '../i18n/dict';
import Kbd from './Kbd';

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

// 证书化 (2026-07-08): 'nav.contract' 摘掉 — /contract 裸路由现在只是重定向
// 到 /settings (已经是下面自己的一个入口), 一个空指目标的 nav item 不该留在
// 跳转面板里。签好的合同在 Settings 的证书区块; 待签的合同走 RecentRail /
// 顶栏轻提示, 都不是"随时跳转"性质的目的地。
const NAV_ITEMS: {
  path: string;
  key:
    | 'nav.lesson'
    | 'nav.review'
    | 'nav.cards'
    | 'nav.sessions'
    | 'nav.quiz'
    | 'nav.mindmap'
    | 'nav.settings';
  kbd: string;
}[] = [
  { path: '/lesson', key: 'nav.lesson', kbd: 'G L' },
  { path: '/review', key: 'nav.review', kbd: 'G R' },
  { path: '/cards', key: 'nav.cards', kbd: 'G C' },
  { path: '/sessions', key: 'nav.sessions', kbd: 'G J' },
  { path: '/quiz', key: 'nav.quiz', kbd: 'G Q' },
  { path: '/mindmap', key: 'nav.mindmap', kbd: 'G M' },
  { path: '/settings', key: 'nav.settings', kbd: 'G ,' },
];

export default function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const navigate = useNavigate();
  const { t, setLang } = useT();

  if (!open) return null;

  const run = (action: () => void) => () => {
    action();
    onClose();
  };

  const setTheme = (next: Theme) => {
    setStoredTheme(next);
    applyTheme(next);
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-start justify-center pt-[14vh] bg-black/30 backdrop-blur-[2px]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[560px] rounded-[var(--ls-radius-panel)]
                   border border-[var(--ls-border)] bg-[var(--ls-bg)]
                   shadow-[0_24px_56px_-12px_rgba(0,0,0,0.25)]
                   overflow-hidden"
      >
        <Command label={t('cmdk.ariaLabel')}>
          <Command.Input
            placeholder={t('cmdk.placeholder')}
            autoFocus
            className="w-full border-0 outline-none bg-transparent
                       px-4 py-3 text-[15px]
                       text-[var(--ls-text)]
                       placeholder:text-[var(--ls-text-tertiary)]
                       border-b border-[var(--ls-border)]"
          />
          <Command.List className="max-h-[360px] overflow-y-auto p-1">
            <Command.Empty className="px-4 py-6 text-center text-sm text-[var(--ls-text-tertiary)]">
              {t('cmdk.empty')}
            </Command.Empty>

            <Command.Group
              heading={t('cmdk.group.nav')}
              className="px-2 py-1 text-[10px] uppercase tracking-wider text-[var(--ls-text-tertiary)]"
            >
              {NAV_ITEMS.map((item) => (
                <PaletteItem
                  key={item.path}
                  value={`nav ${item.path} ${t(item.key)}`}
                  kbd={item.kbd}
                  onSelect={run(() => navigate(item.path))}
                >
                  {t(item.key)}
                </PaletteItem>
              ))}
            </Command.Group>

            <Command.Group
              heading={t('cmdk.group.theme')}
              className="px-2 py-1 text-[10px] uppercase tracking-wider text-[var(--ls-text-tertiary)]"
            >
              {(['system', 'light', 'dark'] as const).map((th) => (
                <PaletteItem
                  key={th}
                  value={`theme ${th}`}
                  onSelect={run(() => setTheme(th))}
                >
                  {t(`settings.theme.${th}` as 'settings.theme.system')}
                </PaletteItem>
              ))}
            </Command.Group>

            <Command.Group
              heading={t('cmdk.group.mode')}
              className="px-2 py-1 text-[10px] uppercase tracking-wider text-[var(--ls-text-tertiary)]"
            >
              <PaletteItem value="mode empty" onSelect={run(() => setRepositoryMode('empty'))}>
                {t('mode.empty')}
              </PaletteItem>
              <PaletteItem value="mode seeded" onSelect={run(() => setRepositoryMode('seeded'))}>
                {t('mode.seeded')}
              </PaletteItem>
              <PaletteItem value="mode live" onSelect={run(() => setRepositoryMode('live'))}>
                {t('mode.live')} (HTTP)
              </PaletteItem>
            </Command.Group>

            <Command.Group
              heading={t('cmdk.group.lang')}
              className="px-2 py-1 text-[10px] uppercase tracking-wider text-[var(--ls-text-tertiary)]"
            >
              {(['zh', 'en'] as const).map((lng) => (
                <PaletteItem
                  key={lng}
                  value={`lang ${lng}`}
                  onSelect={run(() => setLang(lng as Lang))}
                >
                  {t(`settings.lang.${lng}` as 'settings.lang.zh')}
                </PaletteItem>
              ))}
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  );
}

function PaletteItem({
  value,
  kbd,
  onSelect,
  children,
}: {
  value: string;
  kbd?: string;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="flex items-center justify-between gap-3 px-3 py-2
                 rounded-[var(--ls-radius-control)]
                 text-sm text-[var(--ls-text)]
                 cursor-pointer
                 data-[selected=true]:bg-[var(--ls-panel)]
                 hover:bg-[var(--ls-panel)]"
    >
      <span>{children}</span>
      {kbd && <Kbd>{kbd}</Kbd>}
    </Command.Item>
  );
}
