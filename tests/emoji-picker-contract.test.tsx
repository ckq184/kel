// @vitest-environment happy-dom

import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { EmojiPicker } from '../web/src/components/common/EmojiPicker';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * THESIS-27 W1：表情表由"每行一个表情"压缩为每类一个字符串。分类名、
 * 顺序、每类数量与重复项必须不变。hash 锁完整顺序（含 ZWJ 序列），
 * duplicates 锁类内重复，另断言 🎵 仍同时出现在"物品"和"符号"。
 */
const CATEGORIES = [
  {
    label: '动物',
    count: 119,
    first: '🐱',
    last: '🦠',
    hash: '2ad0d3c59300fa19',
    duplicates: [] as string[],
  },
  {
    label: '表情',
    count: 32,
    first: '😀',
    last: '😻',
    hash: '88951ce967c52f5d',
    duplicates: [] as string[],
  },
  {
    label: '自然',
    count: 43,
    first: '🌸',
    last: '🌈',
    hash: '078b5c475f83e3f0',
    duplicates: ['🌈'],
  },
  {
    label: '食物',
    count: 24,
    first: '🍎',
    last: '🍵',
    hash: 'a494c5f5d72d379d',
    duplicates: [] as string[],
  },
  {
    label: '物品',
    count: 48,
    first: '💎',
    last: '🪅',
    hash: 'db8a2442e503662f',
    duplicates: [] as string[],
  },
  {
    label: '符号',
    count: 41,
    first: '❤️',
    last: '🟣',
    hash: '981899b8a542a224',
    duplicates: [] as string[],
  },
];

const sequenceHash = (emojis: string[]) =>
  createHash('sha256').update(emojis.join('\u0000')).digest('hex').slice(0, 16);

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('EmojiPicker emoji table contract (THESIS-27 W1)', () => {
  test('keeps category names, order, emoji sequence and duplicates', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<EmojiPicker onChange={() => {}} />));

    const buttons = Array.from(container.querySelectorAll('button'));
    const categoryButtons = CATEGORIES.map((category) =>
      buttons.find((button) => button.textContent === category.label),
    );
    expect(categoryButtons.every(Boolean)).toBe(true);

    const tabBar = categoryButtons[0]!.parentElement!;
    expect(
      Array.from(tabBar.children).map((tab) => tab.textContent),
      '分类标签顺序',
    ).toEqual(CATEGORIES.map((category) => category.label));

    const rendered = new Map<string, string[]>();
    for (const [index, category] of CATEGORIES.entries()) {
      const button = categoryButtons[index]!;
      act(() => button.click());

      const grid = button.parentElement!.nextElementSibling!;
      const emojis = Array.from(grid.children).map(
        (cell) => cell.textContent ?? '',
      );
      rendered.set(category.label, emojis);
      expect(emojis, `分类 ${category.label} 的表情数`).toHaveLength(
        category.count,
      );
      expect(emojis[0]).toBe(category.first);
      expect(emojis[emojis.length - 1]).toBe(category.last);
      expect(sequenceHash(emojis), `分类 ${category.label} 的完整顺序`).toBe(
        category.hash,
      );
      expect(
        [...new Set(emojis.filter((emoji, i) => emojis.indexOf(emoji) !== i))],
        `分类 ${category.label} 的重复项`,
      ).toEqual(category.duplicates);
    }

    // 🎵 跨类重复（物品 + 符号）是既有数据，不得在压缩时去重。
    expect(rendered.get('物品')).toContain('🎵');
    expect(rendered.get('符号')).toContain('🎵');
  });
});
