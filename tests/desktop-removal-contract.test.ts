import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = path.resolve(import.meta.dirname, '..');

function readText(relativePath: string): string {
  return fs.readFileSync(path.resolve(projectRoot, relativePath), 'utf8');
}

function exists(relativePath: string): boolean {
  return fs.existsSync(path.resolve(projectRoot, relativePath));
}

type DependencySection =
  | 'dependencies'
  | 'devDependencies'
  | 'optionalDependencies'
  | 'peerDependencies';

const packageJson = JSON.parse(readText('package.json')) as {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  keywords?: string[];
  allowScripts?: Record<string, boolean>;
};
const packageLock = JSON.parse(readText('package-lock.json')) as {
  packages?: Record<string, unknown>;
};

const DEPENDENCY_SECTIONS: DependencySection[] = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

describe('桌面端裁除契约（THESIS-01）', () => {
  it('package.json 不再有 desktop:* 脚本', () => {
    expect(
      Object.keys(packageJson.scripts ?? {}).filter((name) =>
        name.startsWith('desktop:'),
      ),
    ).toEqual([]);
  });

  it('package.json 四个依赖区段都不再声明 electron、electron-builder 与 esbuild', () => {
    for (const section of DEPENDENCY_SECTIONS) {
      const dependencies = packageJson[section] ?? {};
      expect(dependencies, section).not.toHaveProperty('electron');
      expect(dependencies, section).not.toHaveProperty('electron-builder');
      expect(dependencies, section).not.toHaveProperty('esbuild');
    }
  });

  it('package-lock.json 不再包含 electron 依赖闭包', () => {
    const packages = Object.keys(packageLock.packages ?? {});
    for (const name of [
      'electron',
      'electron-builder',
      'electron-winstaller',
    ]) {
      expect(packages, name).not.toContain(`node_modules/${name}`);
    }
  });

  it('package.json 关键字与 allowScripts 不再有桌面端条目', () => {
    expect(packageJson.keywords ?? []).not.toContain('electron');
    expect(packageJson.keywords ?? []).not.toContain('desktop');
    const allowScriptsKeys = Object.keys(packageJson.allowScripts ?? {});
    expect(
      allowScriptsKeys.filter((key) =>
        /^electron(?:@|$)|^electron-winstaller@/.test(key),
      ),
    ).toEqual([]);
    expect(
      allowScriptsKeys.filter((key) => /^esbuild@0\.25\./.test(key)),
    ).toEqual([]);
    // tsx 仍依赖 esbuild@0.28.x，安装脚本白名单保留
    expect(allowScriptsKeys.some((key) => /^esbuild@0\.28\./.test(key))).toBe(
      true,
    );
  });

  it('electron/ 目录、桌面端启动脚本与旧契约测试已删除', () => {
    expect(exists('electron')).toBe(false);
    expect(exists('start-desktop.command')).toBe(false);
    expect(exists('start-desktop.bat')).toBe(false);
    expect(exists('tests/electron-menu-contract.test.ts')).toBe(false);
    expect(exists('tests/electron-shell-contract.test.ts')).toBe(false);
  });

  it('restart-dev.command 只重启前后端', () => {
    const script = readText('restart-dev.command');
    expect(script).not.toMatch(/electron|desktop:|桌面端/i);
    expect(script).toContain('npm run dev:all');
    expect(script).toContain('http://127.0.0.1:3001/api/health');
  });

  it('.gitignore 与 web/vite.config.ts 不再有桌面端遗留', () => {
    expect(readText('.gitignore')).not.toContain('/electron/release/');
    const viteConfig = readText('web/vite.config.ts');
    // 注释保留 dual-desktop-port-isolation 文档名，只清理桌面端运行措辞
    expect(viteConfig).not.toMatch(/electron|桌面端/i);
  });

  it('README.md 与 AGENTS.md 不再有 Electron/桌面端入口', () => {
    for (const file of ['README.md', 'AGENTS.md']) {
      const text = readText(file);
      expect(text, file).not.toMatch(/electron|desktop:|desktop shell|桌面端/i);
    }
  });

  it('按 D-G1 删除身份拆分文档并保留端口隔离文档', () => {
    expect(exists('docs/desktop-identity-split-plan.md')).toBe(false);
    expect(exists('docs/dual-desktop-port-isolation-plan.md')).toBe(true);
  });
});
