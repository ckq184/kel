import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

// Contract for plan §11.4 item 1: every non-test module under web/src must be
// reachable from the frontend entry along static imports, re-exports and
// literal dynamic imports. Test files, declaration files and the copy produced
// by `make sync-types` are not part of the reachable set by design.
const projectRoot = process.cwd();
const sourceRoot = path.join(projectRoot, 'web/src');
const entryFile = path.join(sourceRoot, 'main.tsx');
const syncedTypeCopies = new Set([
  path.join(sourceRoot, 'stream-event.types.ts'),
]);
const moduleExtensions = ['.ts', '.tsx'];

// Captures `import x from`, `import ... from`, side-effect `import 'x'`,
// `export ... from`, and literal `import('x')` / `typeof import('x')`.
const specifierPattern =
  /(?:import\s+(?:type\s+)?(?:[^'"]*?\sfrom\s*)?|export\s+(?:type\s+)?[^'"]*?\sfrom\s*)['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function isModuleFile(file: string): boolean {
  return moduleExtensions.includes(path.extname(file));
}

function isExcludedFromTargets(file: string): boolean {
  return (
    /\.test\.tsx?$/.test(file) ||
    file.endsWith('.d.ts') ||
    syncedTypeCopies.has(file)
  );
}

function listModuleFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listModuleFiles(absolute));
    } else if (isModuleFile(absolute)) {
      files.push(absolute);
    }
  }
  return files;
}

function importedSpecifiers(source: string): string[] {
  // Strip comments first so a commented-out import does not keep its module
  // falsely reachable. The `[^:]` guard keeps `https://` inside strings intact;
  // string contents are not parsed further because the contract only needs
  // module edges, not a full JavaScript AST.
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const specifiers: string[] = [];
  for (const match of withoutComments.matchAll(specifierPattern)) {
    specifiers.push(match[1] ?? match[2]);
  }
  return specifiers;
}

function resolveModule(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) {
    base = path.join(sourceRoot, specifier.slice(2));
  } else if (specifier.startsWith('.')) {
    base = path.resolve(path.dirname(fromFile), specifier);
  } else {
    return null;
  }

  const candidates = [
    base,
    ...moduleExtensions.map((extension) => base + extension),
    ...moduleExtensions.map((extension) =>
      path.join(base, `index${extension}`),
    ),
  ];
  const resolved = candidates.find(
    (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
  );
  return resolved && isModuleFile(resolved) ? resolved : null;
}

function collectReachableModules(): Set<string> {
  const reached = new Set<string>();
  const queue = [entryFile];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (reached.has(file)) continue;
    reached.add(file);
    for (const specifier of importedSpecifiers(fs.readFileSync(file, 'utf8'))) {
      const resolved = resolveModule(file, specifier);
      if (resolved && !reached.has(resolved)) queue.push(resolved);
    }
  }
  return reached;
}

describe('frontend reachability contract', () => {
  test('every non-test module under web/src is reachable from main.tsx', () => {
    const reached = collectReachableModules();
    const targetFiles = listModuleFiles(sourceRoot).filter(
      (file) => !isExcludedFromTargets(file),
    );

    // Guards against a moved entry or source root silently passing the test.
    expect(targetFiles.length).toBeGreaterThan(0);

    const unreachable = targetFiles
      .filter((file) => !reached.has(file))
      .map((file) => path.relative(projectRoot, file))
      .sort();

    expect(unreachable).toEqual([]);
  });
});
