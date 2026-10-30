import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = process.cwd();

/**
 * 负载敏感家族护栏（任务 M）。
 *
 * 任务 K/L 累计 15+ 轮全量暴露出一族「边缘预算/时序」用例：Windows 满载
 * 并发下超 vitest 默认 5s 预算或撞墙钟余量而翻红，单跑均绿、冷却后单轮
 * 即过（翻红史与定性流程见 docs/task-k-windows-test-baseline-triage-plan.md
 * §8、docs/task-m-test-budget-consolidation-plan.md §2）。
 *
 * 家族成员的显式预算是一次次真实翻红换来的，手滑删除会让同一坑再踩一次。
 * 本护栏逐成员锁定「源码保留显式预算」——删预算即红。新增成员（下次翻红
 * 修复时）必须登记进下表，从此受保护。
 */
const LOAD_SENSITIVE_FAMILY: ReadonlyArray<{
  file: string;
  budget: RegExp;
  note: string;
}> = [
  {
    file: 'tests/channel-turn-runtime.test.ts',
    budget: /timeout:\s*30_000/,
    note: '1001 行 SQLite 对账（任务 K 批次 1 负载敏感扩展）',
  },
  {
    file: 'tests/builtin-skill-bootstrap-contract.test.ts',
    budget: /timeout:\s*30_000/,
    note: '7 次串行 node 子进程 spawn（任务 K 批次 1）',
  },
  {
    file: 'tests/mcp-send-message-ack.test.ts',
    budget: /timeout:\s*10_000/,
    note: 'vi.waitFor 1s→10s ×2（任务 K 批次 1）',
  },
  {
    file: 'tests/reproducible-build-contract.test.ts',
    budget: /timeout:\s*30_000/,
    note: 'prettier 异步 check（任务 K 批次 1）',
  },
  {
    file: 'tests/schema-v60-channel-reliability.test.ts',
    budget: /timeout:\s*30_000/,
    note: 'db.js 动态导入 + 迁移链（任务 K 批次 1）',
  },
  {
    file: 'tests/container-session-permissions.test.ts',
    budget: /timeout:\s*120_000/,
    note: 'docker run 集成 describe；含「10000-file session <10s」真实性能契约断言——该断言按任务 K §8 裁决不放宽（10069ms 惜败属负载现象，冷却即过）',
  },
  {
    file: 'tests/dingtalk-streaming-card.test.ts',
    budget: /timeout:\s*30_000/,
    note: 'await 刷新链（任务 K 批次 2）',
  },
  {
    file: 'tests/auto-memory-secret-filter.test.ts',
    budget: /timeout:\s*60_000/,
    note: 'secret-filter 契约（任务 K 时期）',
  },
  {
    file: 'tests/githooks-contract.test.ts',
    budget: /\},\s*30_000\)/,
    note: 'hooks 安装器：git init + 两次安装器子进程（任务 L 批次 2 收官轮翻红后修）',
  },
  {
    file: 'tests/scope-check-contract.test.ts',
    budget: /\},\s*30_000\)/,
    note: 'check-scope CLI 端到端：git init + 两次 CLI 子进程（任务 L 批次 3 收官轮翻红后修）',
  },
  {
    file: 'tests/auto-memory-sidecar-manager.test.ts',
    budget: /\},\s*15_000\)/,
    note: 'Python 侧车子进程家族，旧式字面量预算 ×14（15–40s）',
  },
  {
    file: 'tests/auto-memory-ipc.test.ts',
    budget: /\},\s*20_000\)/,
    note: '侧车 IPC 子进程（旧式字面量）',
  },
  {
    file: 'tests/backup-restore-safety.test.ts',
    budget: /\},\s*20_000\)/,
    note: '备份恢复（win32 整卷 skip，预算保留在源码）',
  },
  {
    file: 'tests/task-scheduler-contract.test.ts',
    budget: /250/,
    note: '非 timeout 预算：租约 60ms→250ms / 工作 400ms / 检查点 300ms 时序参数（保持「工作>租约」心跳 fence 契约，任务 K 批次 1）',
  },
];

describe('负载敏感家族预算护栏（任务 M）', () => {
  test('家族清单非空且文件路径唯一', () => {
    expect(LOAD_SENSITIVE_FAMILY.length).toBeGreaterThanOrEqual(14);
    const files = LOAD_SENSITIVE_FAMILY.map((member) => member.file);
    expect(new Set(files).size).toBe(files.length);
  });

  test.each(LOAD_SENSITIVE_FAMILY)(
    '$file 保留显式负载预算',
    ({ file, budget, note }) => {
      const absolute = path.join(repoRoot, file);
      expect(fs.existsSync(absolute), `${file} 应存在`).toBe(true);
      const source = fs.readFileSync(absolute, 'utf8');
      expect(
        source,
        `${file} 应保留显式预算（${note}）——删除它会在满载全量轮重新翻红，` +
          '修复前先读 docs/task-m-test-budget-consolidation-plan.md §0',
      ).toMatch(budget);
    },
  );
});
