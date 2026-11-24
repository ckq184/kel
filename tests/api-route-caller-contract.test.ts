import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * 契约测试（ISSUE-13 §B.3）：Web 调用的每个 `/api/...` 路径都必须有后端路由；
 * 后端路由如果没有 Web 调用方，则必须在 `docs/API.md` 中声明（运维、兼容或
 * 外部调用用途）。已声明的路由族（如 `/api/config/user-im/*`）按通配前缀覆盖。
 *
 * 已知缺口进 `KNOWN_GAPS` 白名单，每条注明 issue 号与方向；对应 issue 完成后
 * 删除条目。失败处置指引：新增后端路由时必须同步 `docs/API.md`（与 ACL）；
 * 删除后端路由时必须同步处理 Web 调用方，或登记白名单挂 issue 号。
 *
 * 静态扫描的已知盲区（登记备查，不设断言）：
 * - 首参为变量拼接（如 `${endpoint}/...`）的 api 调用不在扫描范围内。
 *   历史案例：usePairedChats 的 rename 路径曾调用后端不存在的
 *   `PUT /api/channel-accounts/:id/paired-chats/:jid`——ISSUE-06 第 3 项经
 *   用户拍板 b（连消费端一起下线）已删除该路径，盲区缺口随之消失，对应
 *   KNOWN_GAPS 条目已按机制删除。
 */

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const HTTP_METHODS = 'get|post|put|patch|delete';

/** 已知缺口白名单：条目 = 方法 + 路径 + 挂靠 issue + 方向。 */
const KNOWN_GAPS: Array<{
  method: string;
  path: string;
  issue: string;
  gap: 'no-route' | 'no-caller-no-doc';
}> = [
  // THESIS-02 删除后端 OAuth/订阅用量路由；Web 调用方按计划留给 THESIS-03
  // （界面只剩第三方表单时一并删除）。THESIS-03 完成后删除这三条。
  {
    method: 'post',
    path: '/api/config/claude/oauth/start',
    issue: 'THESIS-03',
    gap: 'no-route',
  },
  {
    method: 'post',
    path: '/api/config/claude/oauth/callback',
    issue: 'THESIS-03',
    gap: 'no-route',
  },
  {
    method: 'get',
    path: '/api/config/claude/providers/${providerId}/usage',
    issue: 'THESIS-03',
    gap: 'no-route',
  },
];

interface RouteEntry {
  method: string;
  path: string;
  file: string;
}

// ---------------------------------------------------------------- 后端路由集
const webSource = readFileSync(path.join(repoRoot, 'src/web.ts'), 'utf-8');

/** 挂载表：路由变量名 → 挂载前缀（app.route('<prefix>', <var>)）。 */
const mountPrefix = new Map<string, string>();
for (const m of webSource.matchAll(/app\.route\('([^']+)',\s*(\w+)\)/g))
  mountPrefix.set(m[2], m[1]);

/** import 表：routes/<file> → 挂载变量名（支持 default、named-as、多行块）。 */
function resolveMountedVars(): Map<string, string> {
  const fileToVar = new Map<string, string>();
  for (const m of webSource.matchAll(
    /import\s+([^;]*?)\s+from\s+'\.\/routes\/([\w.-]+)\.js'/g,
  )) {
    const clause = m[1].replace(/\n/g, ' ');
    const file = m[2];
    const defaultImport = clause.match(/^(\w+)\s*(?:,|$)/);
    if (defaultImport && mountPrefix.has(defaultImport[1])) {
      fileToVar.set(file, defaultImport[1]);
      continue;
    }
    const namedBlock = clause.match(/\{([^}]*)\}/);
    if (namedBlock) {
      for (const nm of namedBlock[1].matchAll(/(\w+)(?:\s+as\s+(\w+))?/g)) {
        const name = nm[2] || nm[1];
        if (mountPrefix.has(name)) fileToVar.set(file, name);
      }
    }
  }
  return fileToVar;
}

interface RouteScanResult {
  routes: RouteEntry[];
  /** 没有挂载映射的路由文件（覆盖面缺口，锚点断言用）。 */
  unmappedFiles: string[];
  /** Hono 实例数 ≠ 1 的路由文件（扫描器归属锚点漂移）。 */
  multiInstanceFiles: string[];
}

function collectBackendRoutes(): RouteScanResult {
  const routes: RouteEntry[] = [];
  // web.ts 内联路由（messages / follow-ups）。
  for (const m of webSource.matchAll(
    new RegExp(`app\\.(${HTTP_METHODS})\\(\\s*'([^']+)'`, 'g'),
  ))
    routes.push({ method: m[1], path: m[2], file: 'src/web.ts' });

  const fileToVar = resolveMountedVars();
  const routesDir = path.join(repoRoot, 'src/routes');
  const unmappedFiles: string[] = [];
  const multiInstanceFiles: string[] = [];
  for (const entry of readdirSync(routesDir)) {
    if (!entry.endsWith('.ts')) continue;
    const base = entry.replace(/\.ts$/, '');
    const mountedVar = fileToVar.get(base);
    if (!mountedVar) {
      unmappedFiles.push(entry);
      continue;
    }
    const prefix = mountPrefix.get(mountedVar)!;
    const source = readFileSync(path.join(routesDir, entry), 'utf-8');
    // 每个路由文件恰好一个 Hono 实例（挂载名与文件内局部名可以不同）。
    const honoVars = [...source.matchAll(/const (\w+)\s*=\s*new Hono/g)].map(
      (m) => m[1],
    );
    if (honoVars.length !== 1) {
      multiInstanceFiles.push(entry);
      continue;
    }
    for (const m of source.matchAll(
      new RegExp(
        `${honoVars[0]}\\.(${HTTP_METHODS})\\(\\s*['\`]([^'\`]+)['\`]`,
        'g',
      ),
    )) {
      const fullPath = m[2] === '/' ? prefix : prefix + m[2];
      routes.push({ method: m[1], path: fullPath, file: entry });
    }
  }
  return { routes, unmappedFiles, multiInstanceFiles };
}

// ---------------------------------------------------------------- Web 调用方集
/** 查询串后缀（`${query}` / `${qs}` 等）截断到路径末尾；`${a ? \`?x\` : ''}` 归一为 `${a}`。 */
const QUERY_SUFFIX_RE = /\$\{\s*(?:query|qs|modelParams|searchParams)\b.*$/;
const TERNARY_QUERY_RE = /\{(\w+)\s*\?\s*`[^`]*`\s*:\s*''\s*\}/g;

function walkSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkSourceFiles(p));
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name))
      out.push(p);
  }
  return out;
}

interface CallerEntry {
  method: string;
  path: string;
  file: string;
}

function collectWebCallers(): CallerEntry[] {
  const callers: CallerEntry[] = [];
  for (const file of walkSourceFiles(path.join(repoRoot, 'web/src'))) {
    let source = readFileSync(file, 'utf-8');
    // 归一嵌套模板的字面量查询串惯用法（DirectoryBrowser 的 ${query ? `?${query}` : ''}）。
    source = source.replace(TERNARY_QUERY_RE, '{$1}');

    for (const m of source.matchAll(
      new RegExp(
        `api\\.(${HTTP_METHODS})\\s*(?:<[^()]*>)?\\(\\s*['\`]([^'\`]+)['\`]`,
        'g',
      ),
    )) {
      let raw = m[2];
      if (!raw.startsWith('/') || /^https?:/i.test(raw)) continue;
      raw = raw.split('?')[0].replace(QUERY_SUFFIX_RE, '');
      callers.push({
        method: m[1],
        path: raw,
        file: path.relative(repoRoot, file),
      });
    }
    // 绕过 api 门面的直连 apiFetch（首参为字面量时才可静态解析）。
    for (const m of source.matchAll(
      /apiFetch\s*(?:<[^()]*>)?\(\s*(['"`])([^'"`]+)\1\s*,?\s*([^;]{0,80})/gs,
    )) {
      let raw = m[2];
      if (!raw.startsWith('/') || /^https?:/i.test(raw)) continue;
      raw = raw.split('?')[0].replace(QUERY_SUFFIX_RE, '');
      const methodMatch = m[3].match(
        /method:\s*'(get|post|put|patch|delete)'/i,
      );
      callers.push({
        method: (methodMatch ? methodMatch[1] : 'get').toLowerCase(),
        path: raw,
        file: path.relative(repoRoot, file),
      });
    }
  }
  return callers;
}

// ---------------------------------------------------------------- 路径匹配
/** `:param` 与 `${...}` 归一为 `*`，按段比较；模式段尾部的 `*` 吸收余下全部段。 */
function normalizeSegments(p: string): string[] {
  return p
    .replace(/\$\{[^}]*\}/g, '*')
    .replace(/:[A-Za-z_]+/g, '*')
    .split('/')
    .filter((s) => s.length > 0);
}

function segmentsMatch(callerPath: string, patternPath: string): boolean {
  const cs = normalizeSegments(callerPath);
  const ps = normalizeSegments(patternPath);
  let i = 0;
  for (; i < ps.length; i++) {
    if (ps[i] === '*') {
      if (i === ps.length - 1) return true;
      if (i >= cs.length) return false;
      continue;
    }
    if (i >= cs.length) return false;
    if (cs[i] === '*') return false;
    if (ps[i] !== cs[i]) return false;
  }
  return cs.length === ps.length;
}

// ---------------------------------------------------------------- API.md 声明集
interface DocEntry {
  methods: Set<string> | 'any';
  path: string;
}

function collectDocEntries(): DocEntry[] {
  const apiMd = readFileSync(path.join(repoRoot, 'docs/API.md'), 'utf-8');
  const entries: DocEntry[] = [];
  for (const m of apiMd.matchAll(
    /`((?:GET|POST|PUT|PATCH|DELETE)(?:\|(?:GET|POST|PUT|PATCH|DELETE))*) (\/api\/[^`\s]+)`/g,
  ))
    entries.push({ methods: new Set(m[1].split('|')), path: m[2] });
  // 无方法前缀的反引号路径（路由族表、user-im/*、散文声明）视为任意方法。
  for (const m of apiMd.matchAll(/`(\/api\/[^`\s]+)`/g))
    entries.push({ methods: 'any', path: m[1] });
  return entries;
}

describe('API route ↔ caller bidirectional contract (ISSUE-13 §B.3)', () => {
  const routeScan = collectBackendRoutes();
  const routes = routeScan.routes;
  const callers = collectWebCallers();
  const docEntries = collectDocEntries();

  const gapRoutes = KNOWN_GAPS.filter((g) => g.gap === 'no-caller-no-doc');
  const gapCallers = KNOWN_GAPS.filter((g) => g.gap === 'no-route');

  const routeExists = (caller: CallerEntry) =>
    routes.some(
      (r) => r.method === caller.method && segmentsMatch(caller.path, r.path),
    ) ||
    gapCallers.some(
      (g) => g.method === caller.method && segmentsMatch(caller.path, g.path),
    );

  const docCovers = (route: RouteEntry) =>
    docEntries.some((d) => {
      if (d.methods !== 'any' && !d.methods.has(route.method.toUpperCase()))
        return false;
      return segmentsMatch(route.path, d.path);
    });

  const hasWebCaller = (route: RouteEntry) =>
    callers.some(
      (c) => c.method === route.method && segmentsMatch(c.path, route.path),
    ) ||
    gapRoutes.some(
      (g) => g.method === route.method && segmentsMatch(g.path, route.path),
    );

  test('scanner anchors hold (full mount coverage, plausible set sizes)', () => {
    // 结构锚点：任何 routes 文件脱离挂载表、或集合规模异常缩水，都说明扫描器
    // 漂移——先修扫描器再谈契约，不得放宽匹配规则来制造通过。
    expect(routeScan.unmappedFiles).toEqual([]);
    expect(routeScan.multiInstanceFiles).toEqual([]);
    expect(routes.length).toBeGreaterThan(180);
    expect(callers.length).toBeGreaterThan(120);
    expect(routes.some((r) => r.path === '/api/messages')).toBe(true);
    expect(callers.some((c) => c.path === '/api/messages')).toBe(true);
  });

  test('every web-called /api path has a backend route', () => {
    const missing = callers.filter((c) => !routeExists(c));
    const unique = [
      ...new Set(missing.map((c) => `${c.method.toUpperCase()} ${c.path}`)),
    ];
    expect(
      unique,
      `以下 Web 调用没有对应的后端路由：${unique.join(' | ')}（调用方文件见测试输出）。` +
        '删除后端路由时必须同步处理 Web 调用方；确实保留的缺口请登记 KNOWN_GAPS 并注明 issue 号。',
    ).toEqual([]);
  });

  test('every backend route has a web caller or a docs/API.md declaration', () => {
    const missing = routes.filter((r) => !hasWebCaller(r) && !docCovers(r));
    const unique = [
      ...new Set(missing.map((r) => `${r.method.toUpperCase()} ${r.path}`)),
    ];
    expect(
      unique,
      `以下后端路由既没有 Web 调用方，也没有在 docs/API.md 声明：${unique.join(' | ')}。` +
        '新增路由必须同步 docs/API.md（运维/兼容/外部用途也要写明）；确实保留的缺口请登记 KNOWN_GAPS 挂 issue 号。',
    ).toEqual([]);
  });

  test('every whitelisted gap still describes reality (whitelist anti-rot)', () => {
    const obsolete = KNOWN_GAPS.filter((g) => {
      if (g.gap === 'no-route') {
        const routeNowExists = routes.some(
          (r) => r.method === g.method && segmentsMatch(g.path, r.path),
        );
        return routeNowExists;
      }
      const callerOrDocNowExists =
        callers.some(
          (c) => c.method === g.method && segmentsMatch(c.path, g.path),
        ) || docCovers({ method: g.method, path: g.path, file: '' });
      return callerOrDocNowExists;
    });
    expect(
      obsolete.map((g) => `${g.method.toUpperCase()} ${g.path}`),
      '以下白名单条目已不再描述现实（对应 issue 可能已完成），请删除条目。',
    ).toEqual([]);
  });
});
