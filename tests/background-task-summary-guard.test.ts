import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('background task summary guard', () => {
  test('prompt forbids premature final or numbered completion language', () => {
    const prompt = fs.readFileSync(
      path.join(
        process.cwd(),
        'container/agent-runner/prompts/background-tasks.md',
      ),
      'utf8',
    );

    expect(prompt).toContain('只能称为“进展”或“阶段结果”');
    expect(prompt).toContain('不得使用“最终”“完整”“全部完成”“到此结束”');
    expect(prompt).toContain('不得使用 `1/N`、`N/N`');
    expect(prompt).toContain('等整批任务状态稳定后一次汇总最终结果');
    expect(prompt).toContain('不要再单独发送“已送达”“任务完成”');
  });
});
