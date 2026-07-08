/**
 * ECharts 主题工具:运行时读取 CSS 变量,让图表配色随五套主题联动。
 * 只读取纯色令牌(hex/rgba),透明度在 JS 侧合成,避免 canvas 不认 color-mix()。
 */
import { useMemo } from "react";
import { useUIStore } from "../stores/uiStore";

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** hex(#rgb/#rrggbb) 或 rgb()/rgba() → 带指定透明度的 rgba 字符串。 */
export function withAlpha(color: string, alpha: number): string {
  const c = color.trim();
  if (c.startsWith("#")) {
    const hex = c.length === 4 ? c.replace(/([0-9a-f])/gi, "$1$1") : c;
    const n = parseInt(hex.slice(1, 7), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g, b] = m[1].split(",").map((s) => parseFloat(s));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return c;
}

export interface ChartTheme {
  /** 数据标签/类目文字 */
  text: string;
  /** 轴刻度文字 */
  axis: string;
  /** 网格分隔线 */
  split: string;
  /** 轴线 */
  axisLine: string;
  /** 饼图引导线 */
  labelLine: string;
  tooltip: {
    backgroundColor: string;
    borderColor: string;
    textStyle: { color: string; fontSize: number };
  };
  /** 通用序列调色板(首位是主题主色) */
  palette: string[];
  accent: string;
  accent2: string;
  gold: string;
  green: string;
  yellow: string;
  red: string;
  purple: string;
}

export function computeChartTheme(): ChartTheme {
  const t1 = cssVar("--t1") || "#eaf0f9";
  const t2 = cssVar("--t2") || "#8b99ad";
  const t3 = cssVar("--t3") || "#c6d0de";
  const accent = cssVar("--accent") || "#5ea3f7";
  const accent2 = cssVar("--accent2") || "#8cc2ff";
  const gold = cssVar("--gold") || "#e3b95e";
  const green = cssVar("--green") || "#4cc38a";
  const yellow = cssVar("--yellow") || "#d9a62e";
  const red = cssVar("--red") || "#f16a5e";
  const purple = cssVar("--purple") || "#b79bf5";
  const panelSolid = cssVar("--panel-solid") || "#121a28";

  return {
    text: t3,
    axis: t2,
    split: withAlpha(t2, 0.16),
    axisLine: withAlpha(t2, 0.3),
    labelLine: withAlpha(t2, 0.38),
    tooltip: {
      backgroundColor: withAlpha(panelSolid, 0.96),
      borderColor: withAlpha(accent, 0.35),
      textStyle: { color: t1, fontSize: 11 },
    },
    palette: [accent, green, gold, red, purple, "#56d4dd", "#f0975c", "#f778ba"],
    accent,
    accent2,
    gold,
    green,
    yellow,
    red,
    purple,
  };
}

/** 订阅主题切换,返回当前图表主题。 */
export function useChartTheme(): ChartTheme {
  const theme = useUIStore((s) => s.theme);
  // theme 变化时 data-theme 已同步写入 documentElement,这里重算即可
  return useMemo(() => computeChartTheme(), [theme]);
}
