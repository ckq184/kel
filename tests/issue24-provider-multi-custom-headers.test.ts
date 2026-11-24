/**
 * ISSUE-24：供应商表单配置多个自定义请求头。
 *
 * 用户拍板（见 docs/issue24-provider-multi-custom-headers-plan.md）：
 * 第三方供应商表单新增「自定义请求头」行编辑器，保存时拼成每行一个
 * `Name: Value` 的 customEnv.ANTHROPIC_CUSTOM_HEADERS；旧值迁入请求头行、
 * 环境变量里拦截该键；校验与 runner 同规则，重名拒绝；坏行放进一行让用户修。
 * 测试只使用无意义的占位值。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

import { parseCustomHeaders } from '../container/agent-runner/src/runtime/pi/pi-provider.js';
import { buildCustomEnv } from '../web/src/utils/custom-env';
import {
  CUSTOM_HEADERS_ENV_KEY,
  applyCustomHeaders,
  buildCustomHeadersValue,
  extractCustomHeaders,
  parseCustomHeaderRows,
} from '../web/src/utils/custom-headers';

const root = path.resolve(import.meta.dirname, '..');

describe('parseCustomHeaderRows: 旧数据兼容读取', () => {
  test('无头：undefined 与空串都得到空行列表', () => {
    expect(parseCustomHeaderRows(undefined)).toEqual([]);
    expect(parseCustomHeaderRows('')).toEqual([]);
    expect(parseCustomHeaderRows('  \n \n')).toEqual([]);
  });

  test('单个头（ISSUE-18 以来唯一能配的形态）读成一行', () => {
    expect(parseCustomHeaderRows('x-one: v1')).toEqual([
      { name: 'x-one', value: 'v1' },
    ]);
  });

  test('多个头按行拆分，兼容 CRLF，值里的冒号保留', () => {
    expect(
      parseCustomHeaderRows('x-one: v1\r\nx-two:a:b\n\nx-three:v3'),
    ).toEqual([
      { name: 'x-one', value: 'v1' },
      { name: 'x-two', value: 'a:b' },
      { name: 'x-three', value: 'v3' },
    ]);
  });

  test('解析不了的行（无冒号）整行放进头名格、值留空', () => {
    expect(parseCustomHeaderRows('broken line\nx-one: v1')).toEqual([
      { name: 'broken line', value: '' },
      { name: 'x-one', value: 'v1' },
    ]);
  });
});

describe('buildCustomHeadersValue: 序列化与校验', () => {
  test('多行拼成每行一个 Name: Value，空占位行忽略', () => {
    expect(
      buildCustomHeadersValue([
        { name: ' x-one ', value: ' v1 ' },
        { name: '', value: '' },
        { name: 'x-two', value: 'v2' },
      ]),
    ).toEqual({ value: 'x-one: v1\nx-two: v2', error: null });
  });

  test('没有请求头时得到空串', () => {
    expect(buildCustomHeadersValue([])).toEqual({ value: '', error: null });
    expect(buildCustomHeadersValue([{ name: ' ', value: '' }])).toEqual({
      value: '',
      error: null,
    });
  });

  test('头名不是 RFC 9110 token 时拒绝并指出第几个', () => {
    for (const name of ['bad name', 'x:y', 'x-é', 'broken line']) {
      const result = buildCustomHeadersValue([
        { name: 'x-ok', value: 'v' },
        { name, value: 'v' },
      ]);
      expect(result.value).toBe('');
      expect(result.error).toContain('第 2 个请求头');
    }
  });

  test('只填一格时拒绝', () => {
    expect(
      buildCustomHeadersValue([{ name: 'x-one', value: '' }]).error,
    ).toContain('第 1 个请求头');
    expect(buildCustomHeadersValue([{ name: '', value: 'v' }]).error).toContain(
      '第 1 个请求头',
    );
  });

  test('值含控制字符时拒绝，Tab 允许', () => {
    expect(
      buildCustomHeadersValue([{ name: 'x-one', value: 'a\u0001b' }]).error,
    ).toContain('第 1 个请求头');
    expect(buildCustomHeadersValue([{ name: 'x-one', value: 'a\tb' }])).toEqual(
      { value: 'x-one: a\tb', error: null },
    );
  });

  test('错误提示不回显值', () => {
    const result = buildCustomHeadersValue([
      { name: 'x-one', value: 'placeholder\u0001' },
    ]);
    expect(result.error).not.toContain('placeholder');
  });

  test('重名（大小写不敏感）拒绝并提示重复', () => {
    const result = buildCustomHeadersValue([
      { name: 'X-One', value: 'v1' },
      { name: 'x-one', value: 'v2' },
    ]);
    expect(result.value).toBe('');
    expect(result.error).toContain('重复');
  });

  test('与 runner parseCustomHeaders 往返：两个头都生效、无告警', () => {
    const { value } = buildCustomHeadersValue([
      { name: 'x-one', value: 'v1' },
      { name: 'x-two', value: 'v:2' },
    ]);
    expect(parseCustomHeaders(value)).toEqual({
      headers: { 'x-one': 'v1', 'x-two': 'v:2' },
      warnings: [],
    });
  });
});

describe('extractCustomHeaders / applyCustomHeaders: 与 customEnv 的迁入与写回', () => {
  test('加载：请求头键从环境变量里剔除并拆成行，其余键原样保留', () => {
    expect(
      extractCustomHeaders({
        FOO: 'bar',
        [CUSTOM_HEADERS_ENV_KEY]: 'x-one: v1\nx-two: v2',
      }),
    ).toEqual({
      customEnv: { FOO: 'bar' },
      headerRows: [
        { name: 'x-one', value: 'v1' },
        { name: 'x-two', value: 'v2' },
      ],
    });
  });

  test('加载：没有请求头键时不变', () => {
    expect(extractCustomHeaders({ FOO: 'bar' })).toEqual({
      customEnv: { FOO: 'bar' },
      headerRows: [],
    });
  });

  test('保存：有请求头时写入键；没有时不写该键（编辑时即删除）', () => {
    expect(
      applyCustomHeaders({ FOO: 'bar' }, [
        { name: 'x-one', value: 'v1' },
        { name: 'x-two', value: 'v2' },
      ]),
    ).toEqual({
      customEnv: {
        FOO: 'bar',
        [CUSTOM_HEADERS_ENV_KEY]: 'x-one: v1\nx-two: v2',
      },
      error: null,
    });
    expect(applyCustomHeaders({ FOO: 'bar' }, [])).toEqual({
      customEnv: { FOO: 'bar' },
      error: null,
    });
  });

  test('保存：校验失败时整包作废并返回错误', () => {
    const result = applyCustomHeaders({ FOO: 'bar' }, [
      { name: 'broken line', value: '' },
    ]);
    expect(result.customEnv).toEqual({});
    expect(result.error).toContain('第 1 个请求头');
  });

  test('旧单头数据加载后原样保存，值不变', () => {
    const stored = { [CUSTOM_HEADERS_ENV_KEY]: 'x-one: v1' };
    const { customEnv, headerRows } = extractCustomHeaders(stored);
    expect(applyCustomHeaders(customEnv, headerRows)).toEqual({
      customEnv: stored,
      error: null,
    });
  });
});

describe('buildCustomEnv: manageCustomHeaders 拦截', () => {
  test('开启时拦截 ANTHROPIC_CUSTOM_HEADERS 并提示改用「自定义请求头」', () => {
    const result = buildCustomEnv(`${CUSTOM_HEADERS_ENV_KEY}=x-one: v1`, {
      manageCustomHeaders: true,
    });
    expect(result.customEnv).toEqual({});
    expect(result.error).toContain('自定义请求头');
  });

  test('未开启时保持原行为（引导页、官方供应商）', () => {
    expect(buildCustomEnv(`${CUSTOM_HEADERS_ENV_KEY}=x-one: v1`)).toEqual({
      customEnv: { [CUSTOM_HEADERS_ENV_KEY]: 'x-one: v1' },
      error: null,
    });
  });
});

describe('ProviderEditor 接线（源码契约）', () => {
  const src = fs.readFileSync(
    path.join(root, 'web/src/components/settings/ProviderEditor.tsx'),
    'utf8',
  );

  test('第三方供应商加载时迁入请求头、保存时写回', () => {
    expect(src).toMatch(/extractCustomHeaders\(/);
    expect(src).toMatch(/applyCustomHeaders\(/);
  });

  test('第三方供应商的环境变量开启请求头键拦截', () => {
    expect(src).toMatch(
      /manageCustomHeaders:\s*providerType === 'third_party'/,
    );
  });

  test('请求头编辑器只在第三方供应商显示，值框默认打码', () => {
    expect(src).toMatch(/自定义请求头/);
    expect(src).toMatch(
      /type=\{showCustomHeaderValues\[idx\] \? 'text' : 'password'\}/,
    );
  });

  test('引导页不改（拍板 5）', () => {
    const setup = fs.readFileSync(
      path.join(root, 'web/src/pages/SetupProvidersPage.tsx'),
      'utf8',
    );
    expect(setup).not.toMatch(/custom-headers/);
  });
});
