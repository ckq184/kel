import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Source of truth for the MCP components and libraries that ship pre-installed
// with CKQClaw (container image + `install-host-tools.sh mcp`). Every entry
// pins an exact upstream version and the SHA256 of the primary artifact we
// verified at pin time; the install paths download the artifact, re-verify the
// hash, and only then install. Bump a version here and mirror the new ARG
// defaults in container/Dockerfile in the same commit.
//
// `mem0ai` is a library dependency (the official mem0 MCP wrapper is archived
// and only fronts the mem0 platform API), so it is recorded here for
// governance but is not itself an MCP server.

export const MCP_CATALOG_SCHEMA_VERSION = 1;

export const BUILTIN_MCP_COMPONENTS = [
  {
    id: 'playwright-mcp',
    kind: 'npm',
    npmPackage: '@playwright/mcp',
    version: '0.0.83',
    bin: 'playwright-mcp',
    tarballUrl: 'https://registry.npmjs.org/@playwright/mcp/-/mcp-0.0.83.tgz',
    tarballFilename: 'mcp-0.0.83.tgz',
    artifactSha256:
      'f0014a13361b1ee2d8607a4e187868ab9a6e8ac637dbcd66e4af43f738d0c8cb',
    summary: 'Playwright 官方浏览器自动化 MCP 服务器（结构化快照模式）',
    mcpConfig: {
      command: 'playwright-mcp',
      args: ['--browser', 'chromium', '--executable-path', '/usr/bin/chromium'],
    },
    notes:
      '容器内复用托管 Chromium（/usr/bin/chromium）。Host 模式需本机 Chrome/Chromium，executable-path 按平台调整。',
  },
  {
    id: 'mcp-searxng',
    kind: 'npm',
    npmPackage: 'mcp-searxng',
    version: '2.6.0',
    bin: 'mcp-searxng',
    tarballUrl:
      'https://registry.npmjs.org/mcp-searxng/-/mcp-searxng-2.6.0.tgz',
    tarballFilename: 'mcp-searxng-2.6.0.tgz',
    artifactSha256:
      'c98c5ceec8a5d7dc463748e5e2d24132ce933a9c658e14d2af1ee40bd3c70aa9',
    summary: 'SearXNG 自托管元搜索的 MCP 服务器',
    mcpConfig: {
      command: 'mcp-searxng',
      env: { SEARXNG_URL: 'http://127.0.0.1:8080' },
    },
    notes:
      '需要自托管 SearXNG 实例，且实例 settings.yml 必须开启 search.formats 的 json 输出，否则查询拿不到结构化结果。',
  },
  {
    id: 'mcp-server-fetch',
    kind: 'uv-tool',
    pypiPackage: 'mcp-server-fetch',
    version: '2026.10.10',
    bin: 'mcp-server-fetch',
    artifactFilename: 'mcp_server_fetch-2026.10.10-py3-none-any.whl',
    artifactSha256:
      'd722c48bdc1de3e2a81727853bc490cf55c6c935e2038cdcad3c111b1d85db77',
    summary: 'MCP 官方参考实现：抓取网页并转换为 LLM 友好内容',
    mcpConfig: { command: 'mcp-server-fetch' },
    notes: '以 uv tool 形式安装，依赖由官方 PyPI 索引解析。',
  },
  {
    id: 'mem0ai',
    kind: 'pip-library',
    pypiPackage: 'mem0ai',
    version: '2.2.1',
    bin: null,
    artifactFilename: 'mem0ai-2.2.1-py3-none-any.whl',
    artifactSha256:
      'fe91bb91ac8926231993a4aa58df00a60c6c74c709e6a338fe399500776eef4d',
    summary: '自托管自动记忆库（自动抽取/冲突消解/语义检索）',
    mcpConfig: null,
    notes:
      '不是 MCP 服务器：官方 mem0-mcp 已归档且仅对接 mem0 平台 API，不采用。该库由 Workspace 自动记忆侧车（后续版本落地）通过 Python 进程使用，向量存储用 Qdrant local 模式，无需外挂向量库容器。',
  },
];

export function componentById(id) {
  return BUILTIN_MCP_COMPONENTS.find((component) => component.id === id);
}

const MARKER_NAME = '.catalog.json';

function markerPath(root) {
  return path.join(root, MARKER_NAME);
}

export function writeCatalog(root) {
  fs.mkdirSync(root, { recursive: true });
  const components = {};
  for (const component of BUILTIN_MCP_COMPONENTS) {
    components[component.id] = {
      kind: component.kind,
      version: component.version,
      artifactSha256: component.artifactSha256,
    };
  }
  const marker = {
    schemaVersion: MCP_CATALOG_SCHEMA_VERSION,
    components,
  };
  fs.writeFileSync(markerPath(root), `${JSON.stringify(marker, null, 2)}\n`);
  return marker;
}

export function validateCatalog(root) {
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath(root), 'utf8'));
    if (marker.schemaVersion !== MCP_CATALOG_SCHEMA_VERSION) return false;
    const expected = {};
    for (const component of BUILTIN_MCP_COMPONENTS) {
      expected[component.id] = {
        kind: component.kind,
        version: component.version,
        artifactSha256: component.artifactSha256,
      };
    }
    return JSON.stringify(marker.components) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

export function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Exit-code style helpers for shell consumption. */
function verifyArtifact(id, file) {
  const component = componentById(id);
  if (!component) {
    console.error(`Unknown builtin MCP component: ${id}`);
    return 1;
  }
  if (!fs.existsSync(file)) {
    console.error(`Artifact not found: ${file}`);
    return 1;
  }
  const filename = path.basename(file);
  if (
    component.tarballFilename !== undefined &&
    filename !== component.tarballFilename &&
    filename !== component.artifactFilename
  ) {
    console.error(
      `Unexpected artifact filename for ${id}: got ${filename}, want ${component.tarballFilename ?? component.artifactFilename}`,
    );
    return 1;
  }
  const actual = sha256File(file);
  if (actual !== component.artifactSha256) {
    console.error(
      `SHA256 mismatch for ${id}: expected ${component.artifactSha256}, got ${actual}`,
    );
    return 1;
  }
  console.log(`${id} artifact verified (${filename})`);
  return 0;
}

const [action, firstArg, secondArg] = process.argv.slice(2);
const defaultRoot = 'data/builtin-mcp';

if (action === 'show') {
  console.log(JSON.stringify(BUILTIN_MCP_COMPONENTS, null, 2));
} else if (action === 'component') {
  const component = componentById(firstArg);
  if (!component) {
    console.error(`Unknown builtin MCP component: ${firstArg}`);
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(component, null, 2));
  }
} else if (action === 'artifact-url') {
  const component = componentById(firstArg);
  if (!component) {
    console.error(`Unknown builtin MCP component: ${firstArg}`);
    process.exitCode = 1;
  } else if (component.kind === 'npm') {
    console.log(component.tarballUrl);
  } else {
    // PyPI artifacts are resolved through pip download; the pinned version
    // plus the marker hash is the contract, no direct URL needed.
    console.log(`pypi:${component.pypiPackage}==${component.version}`);
  }
} else if (action === 'verify') {
  process.exitCode = verifyArtifact(firstArg, secondArg);
} else if (action === 'write' || action === 'validate') {
  const root = path.resolve(firstArg || defaultRoot);
  if (action === 'write') {
    writeCatalog(root);
  } else if (!validateCatalog(root)) {
    console.error(
      `builtin MCP catalog marker invalid or missing under ${root}`,
    );
    process.exitCode = 1;
  }
} else {
  console.error(
    'Usage: builtin-mcp-catalog.mjs show | component <id> | artifact-url <id> | verify <id> <file> | write [root] | validate [root]',
  );
  process.exitCode = 1;
}
