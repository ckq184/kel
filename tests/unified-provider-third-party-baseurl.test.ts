import { describe, expect, test } from 'vitest';

import { UnifiedProviderCreateSchema } from '../src/schemas.js';

// ISSUE-07 项10：third_party 供应商使用 Auth Token 时必须配置 Base URL。
// official + token-only（官方 Bearer 场景）为现行有意语义，必须继续放行。
describe('unified provider third_party base URL rules', () => {
  test('official + auth-token-only stays allowed (official Bearer scenario)', () => {
    const result = UnifiedProviderCreateSchema.safeParse({
      name: 'official-bearer',
      type: 'official',
      anthropicAuthToken: 'sk-official-token',
    });
    expect(result.success).toBe(true);
  });

  test('third_party + auth-token-only is rejected on anthropicBaseUrl', () => {
    const result = UnifiedProviderCreateSchema.safeParse({
      name: 'third-party-token-only',
      type: 'third_party',
      anthropicAuthToken: 'sk-third-party-token',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['anthropicBaseUrl'],
          message: '第三方供应商使用 Auth Token 时必须配置 Base URL',
        }),
      ]),
    );
  });

  test('third_party + auth token + base URL is allowed', () => {
    const result = UnifiedProviderCreateSchema.safeParse({
      name: 'third-party-full',
      type: 'third_party',
      anthropicAuthToken: 'sk-third-party-token',
      anthropicBaseUrl: 'https://gateway.example.test',
    });
    expect(result.success).toBe(true);
  });

  test('third_party + base-URL-only is allowed (local gateway without auth)', () => {
    const result = UnifiedProviderCreateSchema.safeParse({
      name: 'third-party-gateway',
      type: 'third_party',
      anthropicBaseUrl: 'http://127.0.0.1:8082',
    });
    expect(result.success).toBe(true);
  });

  test('third_party with neither base URL nor auth token stays rejected', () => {
    const result = UnifiedProviderCreateSchema.safeParse({
      name: 'third-party-empty',
      type: 'third_party',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['anthropicBaseUrl'],
          message: '第三方供应商需要提供 Base URL 或 Auth Token',
        }),
      ]),
    );
  });
});
