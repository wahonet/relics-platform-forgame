/**
 * 综合统计面板的模块字典与默认布局。
 *
 * - `summary` 是数字摘要卡片(总数 + 三维模型),不支持选图表类型。
 * - 其他模块对应 utils/dict.ts 里的 DimDef.id,可在饼/横条/竖条里切。
 *
 * 用户可以在「设置 → 统计面板」里调整每个模块的位置和图表类型,
 * 配置存到 uiStore.dashModules 并持久化到 localStorage("dashModules")。
 */

export type DashChartType = "pie" | "bar" | "vbar";
export type DashDock = "left" | "right" | "hidden";

export const CHART_TYPE_LABEL: Record<DashChartType, string> = {
  pie: "饼图",
  bar: "横条形",
  vbar: "竖条形",
};

export const DOCK_LABEL: Record<DashDock, string> = {
  left: "左侧",
  right: "右侧",
  hidden: "隐藏",
};

export interface DashModuleMeta {
  id: string;
  /** 显示标题(也是 dash-sec 的标题)。 */
  title: string;
  /** false 表示数字卡片之类、不需要图表类型选项。 */
  supportsType: boolean;
  /** 默认布局位置。 */
  defaultDock: DashDock;
  /** 默认图表类型(supportsType=true 时必填)。 */
  defaultType?: DashChartType;
}

export interface DashModuleCfg {
  dock: DashDock;
  type?: DashChartType;
}

/** 模块清单 + 默认布局。顺序就是渲染顺序。 */
export const DASH_MODULES: DashModuleMeta[] = [
  { id: "summary",         title: "数字摘要", supportsType: false,                              defaultDock: "left" },
  { id: "category_main",   title: "文物类别", supportsType: true, defaultType: "pie",  defaultDock: "left" },
  { id: "heritage_level",  title: "文物级别", supportsType: true, defaultType: "bar",  defaultDock: "left" },
  { id: "era",             title: "年代分布", supportsType: true, defaultType: "vbar", defaultDock: "left" },
  { id: "township",        title: "乡镇分布", supportsType: true, defaultType: "bar",  defaultDock: "right" },
  { id: "survey_type",     title: "普查类型", supportsType: true, defaultType: "pie",  defaultDock: "right" },
  { id: "condition_level", title: "保存状态", supportsType: true, defaultType: "pie",  defaultDock: "right" },
  { id: "ownership_type",  title: "所有权",   supportsType: true, defaultType: "pie",  defaultDock: "right" },
  { id: "industry",        title: "所属行业", supportsType: true, defaultType: "bar",  defaultDock: "right" },
  { id: "risk_factors",    title: "影响因素", supportsType: true, defaultType: "bar",  defaultDock: "right" },
];

/** 生成"开箱即用"的默认配置。 */
export function defaultDashModules(): Record<string, DashModuleCfg> {
  const out: Record<string, DashModuleCfg> = {};
  DASH_MODULES.forEach((m) => {
    out[m.id] = { dock: m.defaultDock, type: m.defaultType };
  });
  return out;
}

/**
 * 从 localStorage 读取并合并默认值。
 * 任何新加的模块都会自动用默认配置补齐;任何已被移除的模块会被丢弃。
 */
export function loadDashModules(): Record<string, DashModuleCfg> {
  const merged = defaultDashModules();
  try {
    const raw = localStorage.getItem("dashModules");
    if (!raw) return merged;
    const stored = JSON.parse(raw) as Record<string, Partial<DashModuleCfg>>;
    DASH_MODULES.forEach((m) => {
      const s = stored[m.id];
      if (!s) return;
      const dock: DashDock =
        s.dock === "left" || s.dock === "right" || s.dock === "hidden" ? s.dock : merged[m.id].dock;
      let type = merged[m.id].type;
      if (m.supportsType && (s.type === "pie" || s.type === "bar" || s.type === "vbar")) {
        type = s.type;
      }
      merged[m.id] = { dock, type };
    });
  } catch {
    /* ignore corrupted JSON, fall back to defaults */
  }
  return merged;
}

export function persistDashModules(cfg: Record<string, DashModuleCfg>): void {
  try {
    localStorage.setItem("dashModules", JSON.stringify(cfg));
  } catch {
    /* ignore quota errors */
  }
}
