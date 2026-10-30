import { describe, expect, test } from 'vitest';

import {
  isCkqclawBootstrapTurn,
  isCkqclawOwnerProfileRuntimeStructurallyEligible,
} from '../src/ckqclaw-bootstrap.js';

describe('CKQClaw first-wake eligibility', () => {
  test('allows only a real interactive Home turn of the built-in profile', () => {
    expect(
      isCkqclawBootstrapTurn({
        turnId: 'owner-turn',
        isHome: true,
        isDefaultProfile: true,
      }),
    ).toBe(true);
    expect(
      isCkqclawBootstrapTurn({
        isHome: true,
        isDefaultProfile: true,
      }),
    ).toBe(false);
    expect(
      isCkqclawBootstrapTurn({
        turnId: 'scheduled-turn',
        isHome: true,
        isDefaultProfile: true,
        isScheduledTask: true,
      }),
    ).toBe(false);
    expect(
      isCkqclawBootstrapTurn({
        turnId: 'custom-turn',
        isHome: true,
        isDefaultProfile: false,
      }),
    ).toBe(false);
    expect(
      isCkqclawBootstrapTurn({
        turnId: 'project-turn',
        isHome: false,
        isDefaultProfile: true,
      }),
    ).toBe(false);
  });
});

describe('CKQClaw Owner Profile structural runtime eligibility', () => {
  test('keeps capability across terminal warmup but denies unsafe runtime kinds', () => {
    const warmup = {
      isHome: true,
      isDefaultProfile: true,
    };
    expect(isCkqclawOwnerProfileRuntimeStructurallyEligible(warmup)).toBe(true);
    expect(
      isCkqclawOwnerProfileRuntimeStructurallyEligible({
        ...warmup,
        runtimeAgentId: 'conversation-1',
        runtimeAgentKind: 'conversation',
      }),
    ).toBe(true);
    expect(
      isCkqclawOwnerProfileRuntimeStructurallyEligible({
        ...warmup,
        isScheduledTask: true,
      }),
    ).toBe(false);
    for (const runtimeAgentKind of ['task', 'spawn'] as const) {
      expect(
        isCkqclawOwnerProfileRuntimeStructurallyEligible({
          ...warmup,
          runtimeAgentId: `${runtimeAgentKind}-1`,
          runtimeAgentKind,
        }),
      ).toBe(false);
    }
    expect(
      isCkqclawOwnerProfileRuntimeStructurallyEligible({
        ...warmup,
        isHome: false,
      }),
    ).toBe(false);
    expect(
      isCkqclawOwnerProfileRuntimeStructurallyEligible({
        ...warmup,
        isDefaultProfile: false,
      }),
    ).toBe(false);
  });
});
