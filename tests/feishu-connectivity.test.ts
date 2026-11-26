import { describe, it, expect } from 'vitest';
import { testFeishuCredentials } from '../src/feishu-connectivity.js';

describe('testFeishuCredentials', () => {
  it('returns ok when endpoint responds with code 0 and token', async () => {
    const fakeEndpoint = 'http://127.0.0.1:0/stub'; // never reached, mocked via fetch override
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          code: 0,
          msg: 'ok',
          tenant_access_token: 't-stub',
          expire: 7200,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    try {
      const res = await testFeishuCredentials(
        'cli_aa83c54c96b8dbd0',
        'secret',
        {
          endpoint: fakeEndpoint,
        },
      );
      expect(res.ok).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns error code+message when API rejects credentials', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          code: 99991663,
          msg: 'invalid app_id or app_secret',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    try {
      const res = await testFeishuCredentials('cli_aa83c54c96b8dbd0', 'wrong', {
        endpoint: 'http://127.0.0.1:0/stub',
      });
      expect(res.ok).toBe(false);
      expect(res.errorCode).toBe(99991663);
      expect(res.errorMessage).toContain('invalid');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns failure on HTTP non-2xx', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response('Internal Server Error', { status: 500 });
    try {
      const res = await testFeishuCredentials('cli_aa83c54c96b8dbd0', 'x', {
        endpoint: 'http://127.0.0.1:0/stub',
      });
      expect(res.ok).toBe(false);
      expect(res.errorMessage).toContain('500');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns failure with timeout message when aborted', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url: any, init: any) => {
      // 模拟一个不会 resolve 的请求,等待 controller.abort()
      return new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    };
    try {
      const res = await testFeishuCredentials('cli_aa83c54c96b8dbd0', 'x', {
        endpoint: 'http://127.0.0.1:0/stub',
        timeoutMs: 50,
      });
      expect(res.ok).toBe(false);
      expect(res.errorMessage).toContain('timed out');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
