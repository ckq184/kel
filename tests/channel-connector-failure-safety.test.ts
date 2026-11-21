import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

// ISSUE-15：Windows（core.autocrlf=true）检出为 CRLF，indexOf 的 '\n…' 锚点
// 统一按 LF 匹配，读源先归一行尾（LF 环境零变化）。
const source = (file: string) =>
  fs
    .readFileSync(path.resolve(process.cwd(), file), 'utf8')
    .replace(/\r\n/g, '\n');

describe('provider connector initial failure safety contract', () => {
  test('manager cleans rejected connectors before releasing credential claims', () => {
    const manager = source('src/im-manager.ts');
    expect(manager).toContain('const cleanupRejectedChannel = async');
    expect(manager).toContain('conn.channels.set(channelKey, channel)');
    expect(manager).toContain('if (await cleanupRejectedChannel())');
  });

  test('QQ does not start background reconnect before manager acceptance', () => {
    const qq = source('src/qq.ts');
    const start = qq.indexOf(
      "logger.error({ err }, 'QQ initial connection failed')",
    );
    const end = qq.indexOf('\n      }\n    },', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(qq.slice(start, end)).not.toContain('scheduleReconnect(');
  });
});
