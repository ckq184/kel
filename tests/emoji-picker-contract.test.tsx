// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { EmojiPicker } from '../web/src/components/common/EmojiPicker';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * THESIS-27 W1：表情表由"每行一个表情"压缩为每类一个字符串。分类名、
 * 顺序与每类数量必须不变（含自然类的重复 🌈 与符号类的重复 🎵）。
 * 数量与首尾项同时锁定，防止拆分方式把 ZWJ 序列拆坏后数量变化。
 */
const CATEGORIES = [
  { label: '动物', count: 119, first: '🐱', last: '🦠' },
  { label: '表情', count: 32, first: '😀', last: '😻' },
  { label: '自然', count: 43, first: '🌸', last: '🌈' },
  { label: '食物', count: 24, first: '🍎', last: '🍵' },
  { label: '物品', count: 48, first: '💎', last: '🪅' },
  { label: '符号', count: 41, first: '❤️', last: '🟣' },
];

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('EmojiPicker emoji table contract (THESIS-27 W1)', () => {
  test('keeps category names, order and per-category emoji counts', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<EmojiPicker onChange={() => {}} />));

    const buttons = Array.from(container.querySelectorAll('button'));
    const categoryButtons = CATEGORIES.map((category) =>
      buttons.find((button) => button.textContent === category.label),
    );
    for (const [index, category] of CATEGORIES.entries()) {
      const button = categoryButtons[index];
      expect(button, `分类 ${category.label} 应存在`).toBeDefined();

      act(() => button!.click());

      const tabBar = button!.parentElement!;
      const grid = tabBar.nextElementSibling!;
      const emojis = Array.from(grid.children).map(
        (cell) => cell.textContent ?? '',
      );
      expect(emojis, `分类 ${category.label} 的表情数`).toHaveLength(
        category.count,
      );
      expect(emojis[0]).toBe(category.first);
      expect(emojis[emojis.length - 1]).toBe(category.last);
    }

    expect(categoryButtons.map((button) => button?.textContent)).toEqual(
      CATEGORIES.map((category) => category.label),
    );
  });
});
