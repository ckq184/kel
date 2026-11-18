import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();
// Normalize CRLF→LF: several needles embed newlines+indentation, and checkouts
// with core.autocrlf=true materialize CRLF on disk.
const readSource = (rel: string): string =>
  fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const hostRunner = readSource('src/container-runner.ts');
const main = readSource('src/index.ts');
const taskScheduler = readSource('src/task-scheduler.ts');

describe('provider fallback source contracts', () => {
  test('host consumes the hidden model retry marker without quarantining provider', () => {
    expect(
      hostRunner.match(/if \(output\.providerFailureRetrying\)/g),
    ).toHaveLength(2);
    expect(hostRunner).toContain('!providerFailureReported &&');
    expect(hostRunner).toContain('!hostProviderFailureReported &&');
    expect(hostRunner).not.toContain('ownerHomeFolder,\n    fallbackModel');
  });

  test('host quarantines before projection and chooses retry vs terminal', () => {
    expect(
      hostRunner.match(/applyProviderFailureDisposition\(/g)?.length,
    ).toBeGreaterThanOrEqual(5);
    expect(hostRunner).toMatch(
      /providerPool\.reportFailure\(selectedProfileId, true\);[\s\S]*?applyProviderFailureDisposition\([\s\S]*?await onOutput\(output\)/,
    );
    expect(hostRunner).toMatch(
      /providerPool\.reportFailure\(hostSelectedProfileId, true\);[\s\S]*?applyProviderFailureDisposition\([\s\S]*?await onOutput\(output\)/,
    );
    expect(hostRunner).toMatch(
      /providerPool\.refreshFromConfig\([\s\S]*?providerPool\.refreshRecoveryState\(\)/,
    );
  });

  test('maintenance provider failures cannot project or replay a completed input', () => {
    expect(
      hostRunner.match(/output\.providerFailureMaintenance &&/g),
    ).toHaveLength(2);
    expect(hostRunner).toContain('healthyInputTurnCompleted');
    expect(hostRunner).toContain('hostHealthyInputTurnCompleted');
    expect(hostRunner).toContain(
      'Provider failed after scheduled input completed; suppressing replay',
    );
  });

  test('provider failures are visible only at pool exhaustion across interaction modes', () => {
    expect(main).not.toContain(
      'Provider failure result suppressed from user (silent switch)',
    );
    expect(main.match(/Provider failure surfaced to user/g)).toHaveLength(2);
    expect(main).toContain('result.providerFailureTerminal !== true');
    expect(main).toContain('output.providerFailureTerminal !== true');
    expect(main).toContain('rollbackIdleMainCardReservation(');
    expect(main).toContain('rollbackIdleAgentCardReservation(');
    expect(main).toMatch(
      /!publishesFrameworkAnswer\(interactionMode\)\s*&&\s*!result\.providerFailure/,
    );
    expect(main).toMatch(
      /!publishesFrameworkAnswer\(interactionMode\)\s*&&\s*!output\.providerFailure/,
    );
  });

  test('scheduled tasks classify exhausted providers as failures', () => {
    expect(taskScheduler).toContain(
      'streamedOutput.providerFailureTerminal === true',
    );
    expect(taskScheduler).toContain('error = PROVIDER_FAILURE_USER_NOTICE');
    expect(hostRunner).toContain(
      'Scheduled task provider failed; retrying the same prompt on another provider',
    );
  });
});
