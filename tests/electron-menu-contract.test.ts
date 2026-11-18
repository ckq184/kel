import { describe, expect, it } from 'vitest';
import { buildMenuTemplate } from '../electron/src/main/menu-template';

type Template = ReturnType<typeof buildMenuTemplate>;
type MenuEntry = Template[number];

const DESKTOP_PLATFORMS = ['darwin', 'win32', 'linux'] as const;

function rolesOf(items: MenuEntry[]): string[] {
  return items
    .map((item) => (typeof item.role === 'string' ? item.role : null))
    .filter((role): role is string => role !== null);
}

function submenuItems(item: MenuEntry | undefined): MenuEntry[] {
  const submenu = item?.submenu;
  if (!Array.isArray(submenu)) return [];
  return submenu.filter(
    (entry): entry is MenuEntry => typeof entry === 'object',
  );
}

function submenuRoles(item: MenuEntry | undefined): string[] {
  return rolesOf(submenuItems(item));
}

function findByLabel(items: MenuEntry[], label: string): MenuEntry | undefined {
  return items.find((item) => item.label === label);
}

function invokeClick(item: MenuEntry | undefined): void {
  const click = item?.click;
  click?.(undefined as never, undefined as never, undefined as never);
}

function baseOptions(
  overrides: Partial<Parameters<typeof buildMenuTemplate>[0]> = {},
): Parameters<typeof buildMenuTemplate>[0] {
  return {
    platform: 'darwin',
    isPackaged: false,
    appName: 'CKQClaw Thesis',
    showAbout: () => {},
    openExternalUrl: () => {},
    ...overrides,
  };
}

describe('Electron Desktop menu template contract', () => {
  it('ships editMenu on every platform so macOS edit shortcuts are dispatched', () => {
    for (const platform of DESKTOP_PLATFORMS) {
      const template = buildMenuTemplate(baseOptions({ platform }));
      const roles = rolesOf(template);
      expect(roles, `platform=${platform}`).toContain('editMenu');
      // 任务P §4.1：editMenu 插在 View 之前
      const editIndex = template.findIndex((item) => item.role === 'editMenu');
      const viewIndex = template.findIndex((item) => item.label === 'View');
      expect(editIndex, `platform=${platform}`).toBeGreaterThanOrEqual(0);
      expect(
        editIndex < viewIndex,
        `platform=${platform}: editMenu(${editIndex}) 应在 View(${viewIndex}) 之前`,
      ).toBe(true);
    }
  });

  it('keeps appMenu darwin-only and removes the duplicate brand menu on darwin (§4.3)', () => {
    const darwin = buildMenuTemplate(baseOptions({ platform: 'darwin' }));
    expect(rolesOf(darwin)).toContain('appMenu');
    expect(findByLabel(darwin, 'CKQClaw Thesis')).toBeUndefined();

    for (const platform of ['win32', 'linux'] as const) {
      const template = buildMenuTemplate(baseOptions({ platform }));
      expect(rolesOf(template), `platform=${platform}`).not.toContain(
        'appMenu',
      );
      // 非 darwin 无 appMenu，品牌菜单保留 About/Quit 入口
      const brand = findByLabel(template, 'CKQClaw Thesis');
      expect(brand, `platform=${platform} keeps brand menu`).toBeDefined();
      expect(submenuRoles(brand), `platform=${platform}`).toContain('quit');
    }
  });

  it('keeps View menu reload/togglefullscreen and dev-only toggleDevTools', () => {
    for (const platform of DESKTOP_PLATFORMS) {
      for (const isPackaged of [false, true]) {
        const label = `platform=${platform} isPackaged=${isPackaged}`;
        const view = findByLabel(
          buildMenuTemplate(baseOptions({ platform, isPackaged })),
          'View',
        );
        const roles = submenuRoles(view);
        expect(roles, label).toContain('reload');
        expect(roles, label).toContain('togglefullscreen');
        expect(roles.includes('toggleDevTools'), label).toBe(!isPackaged);
      }
    }
  });

  it('wires brand About and Help GitHub link through injected callbacks', () => {
    let aboutCalls = 0;
    const externalUrls: string[] = [];
    const template = buildMenuTemplate(
      baseOptions({
        platform: 'win32',
        showAbout: () => {
          aboutCalls += 1;
        },
        openExternalUrl: (url) => {
          externalUrls.push(url);
        },
      }),
    );

    const about = submenuItems(findByLabel(template, 'CKQClaw Thesis')).find(
      (item) => item.label === 'About CKQClaw Thesis',
    );
    invokeClick(about);
    expect(aboutCalls).toBe(1);

    const github = submenuItems(findByLabel(template, 'Help')).find(
      (item) => item.label === 'CKQClaw on GitHub',
    );
    invokeClick(github);
    expect(externalUrls).toEqual(['https://github.com/ckq184/ckqclaw']);
  });
});
