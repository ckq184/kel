import { describe, expect, test } from 'vitest';
import { canExecuteOnHost } from '../src/host-execution-policy.js';

describe('host execution live authorization', () => {
  test('allows only an active owner', () => {
    expect(canExecuteOnHost({ status: 'active' })).toBe(true);
    expect(canExecuteOnHost({ status: 'disabled' })).toBe(false);
    expect(canExecuteOnHost({ status: 'deleted' })).toBe(false);
    expect(canExecuteOnHost(undefined)).toBe(false);
  });
});
