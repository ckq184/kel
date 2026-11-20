/**
 * 用量成本展示格式（ISSUE-11 B5）。
 *
 * 原 UsageTrendChart.tsx 与 UsagePage.tsx 各持一份逐字相同的实现，
 * 收敛为唯一导出；分档规则不变：≥1 两位小数、≥0.01 三位、>0 四位、
 * 其余（含 0 与负数）显示 $0.00。
 */
export function formatCost(value: number): string {
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  if (value > 0) return `$${value.toFixed(4)}`;
  return '$0.00';
}
