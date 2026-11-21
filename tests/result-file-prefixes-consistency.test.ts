import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

// src/index.ts 是主服务入口（import 即启动监听），一致性断言走源码文本提取，
// 先例见 tests/provider-auth-error.test.ts 的源码断言模式。
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const mainSource = readFileSync(path.join(repoRoot, 'src/index.ts'), 'utf-8');
// ISSUE-12 波 4 单元 4.2：RESULT_FILE_PREFIXES 数组随 startIpcWatcher 体迁入
// src/ipc/watcher.ts（原文搬运），前缀提取改读新模块；writeTaskResult 的
// 字面量/动态调用与 *_task case 标签仍留守 index.ts 的 processTaskIpc，
// 三处断言读入不变。
const watcherSource = readFileSync(
  path.join(repoRoot, 'src/ipc/watcher.ts'),
  'utf-8',
);
// ISSUE-12 波 4 单元 4.10：动态 writeTaskResult(tasksDir, data.type, …)
// 调用与其 case 标签（agent_profile_* 七 case）随段迁入
// src/ipc/builder-ops.ts，标签关联扫描改读该模块（标签与调用同体迁移，
// 关联逻辑不变）。
const builderOpsSource = readFileSync(
  path.join(repoRoot, 'src/ipc/builder-ops.ts'),
  'utf-8',
);

/** 从源码提取 RESULT_FILE_PREFIXES 数组的字面量成员。 */
function extractResultFilePrefixes(source: string): string[] {
  const match = source.match(/const RESULT_FILE_PREFIXES = \[([^\]]*)\]/);
  expect(
    match,
    'RESULT_FILE_PREFIXES 数组应存在于 src/ipc/watcher.ts',
  ).toBeTruthy();
  return [...match![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

/** 字面量 type 调用：writeTaskResult(tasksDir, '<type>', …)。 */
function extractLiteralWriteTypes(source: string): string[] {
  return [...source.matchAll(/writeTaskResult\(tasksDir, '([a-z_]+)'/g)].map(
    (m) => m[1],
  );
}

/**
 * 动态 type 调用：writeTaskResult(tasksDir, data.type, …)。写入文件名前缀由
 * 运行时 data.type 决定，其取值受限于所在 switch case 标签——逐行扫描，把每处
 * 动态调用关联到最近一个 case 标签。
 */
function extractCaseLabelledDynamicWriteTypes(source: string): string[] {
  const labels: string[] = [];
  let currentCase: string | null = null;
  for (const line of source.split('\n')) {
    const caseMatch = line.match(/^\s*case '([a-z_]+)':/);
    if (caseMatch) {
      currentCase = caseMatch[1];
      continue;
    }
    if (/writeTaskResult\(tasksDir, data\.type,/.test(line) && currentCase) {
      labels.push(currentCase);
    }
  }
  return labels;
}

describe('orphan result file cleanup prefix consistency (ISSUE-05 §1)', () => {
  const prefixes = extractResultFilePrefixes(watcherSource);

  test('feishu_capability result files are covered by the cleanup list', () => {
    // 回归锚点：writeTaskResult(tasksDir, 'feishu_capability', …) 生成的
    // feishu_capability_result_<requestId>.json 曾逃过孤儿清理，被当作任务
    // 请求处理并引发伪任务告警。
    expect(prefixes).toContain('feishu_capability_result_');
  });

  test('every literal writeTaskResult type has its prefix in the list', () => {
    const literalTypes = extractLiteralWriteTypes(mainSource);
    expect(literalTypes.length).toBeGreaterThan(0);
    const missing = literalTypes.filter(
      (type) => !prefixes.includes(`${type}_result_`),
    );
    expect(missing, `缺少结果文件前缀: ${missing.join(', ')}`).toEqual([]);
  });

  test('every case label with a dynamic data.type write is in the list', () => {
    const caseLabels = extractCaseLabelledDynamicWriteTypes(builderOpsSource);
    expect(caseLabels.length).toBeGreaterThan(0);
    const missing = [...new Set(caseLabels)].filter(
      (label) => !prefixes.includes(`${label}_result_`),
    );
    expect(missing, `缺少结果文件前缀: ${missing.join(', ')}`).toEqual([]);
  });

  test('parsedData fallback only writes _task types already covered by the list', () => {
    // 兜底路径 (src/index.ts ~:10936) 仅对 endsWith('_task') 的请求 type 写
    // 失败回执。请求 type 的全集是容器侧 IPC 任务协议；此处断言宿主侧 switch
    // 处理的所有 *_task case 标签都在名单内，保证已知的兜底写入不漏删。
    const taskCaseLabels = [
      ...new Set(
        [...mainSource.matchAll(/^\s*case '([a-z_]*task[a-z_]*)':/gm)].map(
          (m) => m[1],
        ),
      ),
    ].filter((label) => label.endsWith('_task'));
    const missing = taskCaseLabels.filter(
      (label) => !prefixes.includes(`${label}_result_`),
    );
    expect(missing, `缺少结果文件前缀: ${missing.join(', ')}`).toEqual([]);
  });
});
