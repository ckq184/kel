import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

// Contract for plan §11.4 item 1: every non-test module under web/src must be
// reachable from the frontend entry along static imports, re-exports and
// literal dynamic imports. Test files, declaration files and the copy produced
// by `make sync-types` are not part of the reachable set by design.
//
// This is compile-time reachability, not runtime bundle reachability: type-only
// references (including `typeof import('x')`) count as edges.
const projectRoot = process.cwd();
const sourceRoot = path.join(projectRoot, 'web/src');
const entryFile = path.join(sourceRoot, 'main.tsx');
// Mirrors web/tsconfig.json (`@/*`), the entry, and the copies listed in
// scripts/sync-stream-event.sh; update here when those definitions move.
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
  // falsely reachable. Delimiters are only recognized at line start or after
  // whitespace/{ so literals like `image/*` and `${protocol}//` are left alone;
  // string contents are not parsed further because the contract only needs
  // module edges, not a full JavaScript AST.
  const withoutComments = source
    .replace(/(^|[\s{])\/\*[\s\S]*?\*\//gm, '$1')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
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
    // A missing entry would otherwise fail inside the traversal with a less
    // specific ENOENT.
    expect(fs.existsSync(entryFile)).toBe(true);

    const reached = collectReachableModules();
    const targetFiles = listModuleFiles(sourceRoot).filter(
      (file) => !isExcludedFromTargets(file),
    );

    // Guards against a moved source root or an entry excluded by accident.
    expect(targetFiles).toContain(entryFile);

    const unreachable = targetFiles
      .filter((file) => !reached.has(file))
      .map((file) => path.relative(projectRoot, file))
      .sort();

    expect(unreachable).toEqual([]);
  });
});
