import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { parseChannelPairingCode } from '../src/channel-admission.js';

// ISSUE-05 §3（用户拍板：统一为严格语义）。QQ 与微信原先内联宽松正则
// /^\/pair\s+(\S+)/i（无尾部锚点，/pair abc extra 会取 abc），与共享函数
// parseChannelPairingCode 的严格语义分叉；统一改为调用共享函数。
// 渠道消息回调在 createXxConnection 内部长轮询闭包里，行为级驱动需 mock
// 整套渠道 API，成本过高；此处用共享函数行为断言（三渠道统一语义的真相源）
// + 源码一致性断言（QQ/微信不得再内联宽松正则）锁定。
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const qqSource = readFileSync(path.join(repoRoot, 'src/qq.ts'), 'utf-8');
const wechatSource = readFileSync(
  path.join(repoRoot, 'src/wechat.ts'),
  'utf-8',
);

describe('uniform /pair parsing across channels (ISSUE-05 §3)', () => {
  test('shared parser rejects trailing extra tokens (strict semantics)', () => {
    expect(parseChannelPairingCode('/pair abc123')).toBe('abc123');
    expect(parseChannelPairingCode(' /PAIR ABC123 ')).toBe('ABC123');
    expect(parseChannelPairingCode('/pair abc extra')).toBeNull();
    expect(parseChannelPairingCode('/pair')).toBeNull();
  });

  test('QQ no longer inlines the loose pairing regex', () => {
    expect(
      qqSource,
      'qq.ts 应改调 parseChannelPairingCode，不得内联无尾部锚点的宽松正则',
    ).not.toMatch(/\/\^\\\/pair\\s\+\(\\S\+\)\/i/);
    expect(qqSource).toContain("from './channel-admission.js'");
    expect(qqSource).toContain('parseChannelPairingCode(');
  });

  test('WeChat no longer inlines the loose pairing regex', () => {
    expect(
      wechatSource,
      'wechat.ts 应改调 parseChannelPairingCode，不得内联无尾部锚点的宽松正则',
    ).not.toMatch(/\/\^\\\/pair\\s\+\(\\S\+\)\/i/);
    expect(wechatSource).toContain("from './channel-admission.js'");
    expect(wechatSource).toContain('parseChannelPairingCode(');
  });

  test('every inline /pair match site in QQ and WeChat routes through the shared parser', () => {
    // 防回归：两文件中不再有任何 /pair 正则字面量（共享函数是唯一解析入口）。
    // 正则字面量的源码文本必含转义序列 "\/pair"（如 /...\/pair.../），普通
    // 注释里的 "/pair" 不受影响。
    for (const [name, source] of [
      ['qq.ts', qqSource],
      ['wechat.ts', wechatSource],
    ] as const) {
      expect(source, `${name} 不应再出现 /pair 正则字面量`).not.toContain(
        '\\/pair',
      );
    }
  });
});
