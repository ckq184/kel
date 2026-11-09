import type { MenuItemConstructorOptions } from 'electron';

// 应用菜单模板的纯函数构造（任务P：自 index.ts 提取，对 electron 仅
// type-only import，运行时零依赖，可在 vitest 直接单测）。

export type MenuTemplateOptions = {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  showAbout: () => void;
  openExternalUrl: (url: string) => void;
};

export function buildMenuTemplate(
  options: MenuTemplateOptions,
): MenuItemConstructorOptions[] {
  const { platform, isPackaged, showAbout, openExternalUrl } = options;

  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'togglefullscreen' },
      ...(isPackaged ? [] : [{ role: 'toggleDevTools' as const }]),
    ],
  };

  // darwin 由 appMenu 提供 About/Quit/Services/Hide，不再叠自定义品牌菜单
  //（任务P §4.3 清理）；非 darwin 无 appMenu，保留品牌菜单保住入口。
  const brandMenu: MenuItemConstructorOptions = {
    label: 'CKQClaw',
    submenu: [
      { label: 'About CKQClaw', click: () => showAbout() },
      { type: 'separator' },
      { role: 'quit' },
    ],
  };

  return [
    ...(platform === 'darwin' ? [{ role: 'appMenu' as const }] : [brandMenu]),
    // macOS 的 cut/copy/paste/selectAll 快捷键依赖应用菜单 role 派发，
    // 缺 editMenu 则这些快捷键失效（任务P 根因修复）。
    { role: 'editMenu' as const },
    viewMenu,
    {
      label: 'Help',
      submenu: [
        {
          label: 'CKQClaw on GitHub',
          click: () => openExternalUrl('https://github.com/ckq184/ckqclaw'),
        },
      ],
    },
  ];
}
