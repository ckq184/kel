import { describe, expect, test } from 'vitest';
import { canExecuteOnHost } from '../src/host-execution-policy.js';

describe('host execution live authorization', () => {
  test('allows only an active administrator', () => {
    expect(canExecuteOnHost({ role: 'admin', status: 'active' })).toBe(true);
    expect(canExecuteOnHost({ role: 'member', status: 'active' })).toBe(false);
    expect(canExecuteOnHost({ role: 'admin', status: 'disabled' })).toBe(false);
    expect(canExecuteOnHost({ role: 'admin', status: 'deleted' })).toBe(false);
    expect(canExecuteOnHost(undefined)).toBe(false);
  });
});
