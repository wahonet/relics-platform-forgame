import { create } from "zustand";
import type { BaseLayerType, RelicSummary } from "../types";
import type { CrsId } from "../utils/crs";
import {
  type DashModuleCfg,
  loadDashModules,
  persistDashModules,
  defaultDashModules,
} from "../components/dashboardModules";

export type RenderQuality = "standard" | "hd" | "ultra";

/** Toast 类型:默认 info(主题色点),success/error/warning 换语义色点。 */
export type ToastKind = "info" | "success" | "error" | "warning";

/** 主题配色。dark=深墨蓝(默认) light=经典亮白 navy=藏青政务 green=青碧 red=胭脂红 glass=琉璃玻璃拟态 */
export type ThemeId = "dark" | "light" | "navy" | "green" | "red" | "glass";

/** 浅色主题(地图域外遮罩用浅雾、文字深墨) */
export function isLightTheme(t: ThemeId): boolean {
  return t === "light" || t === "glass";
}

export function applyTheme(theme: ThemeId): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem("theme", theme);
  } catch {
    /* ignore */
  }
}

interface UIState {
  filterPanelOpen: boolean;
  chatPanelOpen: boolean;
  settingsPanelOpen: boolean;
  helpPanelOpen: boolean;
  /** 巡查规划面板。开启后地图点击进入"选点组线"模式。 */
  patrolPanelOpen: boolean;

  baseLayer: BaseLayerType;
  baseLayerAlpha: number;

  bndCounty: boolean;
  bndCountyName: boolean;
  bndTownship: boolean;
  bndTownshipName: boolean;
  bndVillage: boolean;
  bndVillageName: boolean;
  /** 两线范围(保护范围/建控地带)常驻图层开关。 */
  twoLineVisible: boolean;

  symbolMode: boolean;
  /** @deprecated 仅作向后兼容,真实状态以 renderQuality 为准。 */
  hdMode: boolean;
  /** standard | hd | ultra,持久化到 localStorage("renderQuality")。 */
  renderQuality: RenderQuality;
  hideRelicPoints: boolean;
  uiSize: "sm" | "md" | "lg";
  theme: ThemeId;
  activeGroup: string;

  selectedRelic: RelicSummary | null;

  // 坐标系显示设置
  /** 屏幕底部坐标读数主显示 CRS。其他系统在 inspector 面板里看。 */
  displayCrs: CrsId;
  /** 是否在底部状态条显示坐标读数。 */
  coordReadoutVisible: boolean;
  /** 高斯-克吕格中央子午线 (°)。auto 时按几何位置自动选带。 */
  gkCentralMeridian: number | "auto";
  /** GK 带宽: 3°带 / 6°带。 */
  gkZoneWidth: 3 | 6;
  /** CRS 检视面板开关。 */
  crsInspectorOpen: boolean;

  toast: { id: number; text: string; kind: ToastKind } | null;

  /** 单调递增的"离线覆盖刷新"信号。下载完成后 +1,MapView 监听刷新红框。 */
  offlineCoverageTick: number;
  /** 单调递增的"边界数据刷新"信号。下载/清除边界后 +1,MapView 重载 BoundaryLayer。 */
  boundaryReloadTick: number;

  /** 综合统计面板每个模块的布局/图表类型,持久化到 localStorage("dashModules")。 */
  dashModules: Record<string, DashModuleCfg>;

  // ── 系统管理 → 设置(本机偏好,localStorage) ──
  /** 地图天气氛围效果(雨/雪/阴)。 */
  weatherFxEnabled: boolean;
  /** 右侧栏天气预报面板。 */
  weatherPanelVisible: boolean;
  /** 地图双击逐级下钻(县→镇→村,右键返回)。 */
  drillEnabled: boolean;
  /** 点击统计图下钻时镜头同步飞行。 */
  chartFlyEnabled: boolean;
  /** 健康度一张图:点位按健康分红黄绿着色(不持久化,演示模式)。 */
  healthMode: boolean;
  /** 文物密度热力图(开启时隐藏点位,不持久化)。 */
  heatMode: boolean;

  // ── 语音讲解偏好(系统管理 → 设置,localStorage) ──
  /** 中文讲解音色(CosyVoice2 预置音色名)。 */
  ttsVoiceZh: string;
  /** 英文讲解音色。 */
  ttsVoiceEn: string;
  /** 语速(0.5~2.0)。 */
  ttsSpeed: number;
  /** 朗读范围:full=信息+简介 brief=仅基础信息 intro=名称+简介。 */
  ttsScope: "full" | "brief" | "intro";

  set: (patch: Partial<Omit<UIState, "set" | "showToast" | "bumpOfflineCoverage" | "bumpBoundary" | "setDashModule" | "resetDashModules">>) => void;
  showToast: (text: string, kind?: ToastKind) => void;
  bumpOfflineCoverage: () => void;
  bumpBoundary: () => void;
  setDashModule: (id: string, patch: Partial<DashModuleCfg>) => void;
  resetDashModules: () => void;
}

let toastSeq = 0;
let toastT: ReturnType<typeof setTimeout> | null = null;

export const useUIStore = create<UIState>((set, get) => ({
  filterPanelOpen: false,
  chatPanelOpen: false,
  settingsPanelOpen: false,
  helpPanelOpen: false,
  patrolPanelOpen: false,

  // 默认在线影像(天地图);未配置天地图 key 时由 platformStore 回退到高德
  baseLayer: "tianditu_img",
  baseLayerAlpha: 90,

  bndCounty: true,
  bndCountyName: true,
  bndTownship: true,
  bndTownshipName: true,
  // 村界/村名默认开:数据按相机高度懒加载,只有放大到近景才请求与渲染
  bndVillage: true,
  bndVillageName: true,
  // 两线范围默认关,需要时在「边界」菜单里手动打开
  twoLineVisible: false,

  symbolMode: false,
  hdMode: localStorage.getItem("hdMode") === "1",
  renderQuality: ((): RenderQuality => {
    const v = localStorage.getItem("renderQuality");
    if (v === "standard" || v === "hd" || v === "ultra") return v;
    // 默认 hd:开 FXAA + 全 DPR,边线无锯齿。standard 留给极弱机器手动选。
    // 老版本只持久化 hdMode,这里也按高清走。
    return "hd";
  })(),
  hideRelicPoints: false,
  uiSize: "md",
  theme: ((): ThemeId => {
    const v = localStorage.getItem("theme");
    const t = (v === "light" || v === "navy" || v === "green" || v === "red" || v === "dark" || v === "glass")
      ? v : "dark";
    document.documentElement.dataset.theme = t;
    return t;
  })(),
  activeGroup: "category_main",

  selectedRelic: null,

  displayCrs: ((): CrsId => {
    const v = localStorage.getItem("displayCrs");
    if (v === "wgs84" || v === "cgcs2000" || v === "cgcs2000_gk_3"
      || v === "cgcs2000_gk_6" || v === "gcj02" || v === "bd09" || v === "web_mercator") return v;
    return "wgs84";
  })(),
  coordReadoutVisible: localStorage.getItem("coordReadoutVisible") !== "0",
  gkCentralMeridian: ((): number | "auto" => {
    const v = localStorage.getItem("gkCentralMeridian");
    if (v === "auto" || v === null) return "auto";
    const n = Number(v);
    return Number.isFinite(n) ? n : "auto";
  })(),
  gkZoneWidth: (localStorage.getItem("gkZoneWidth") === "6" ? 6 : 3) as 3 | 6,
  crsInspectorOpen: false,

  toast: null,

  offlineCoverageTick: 0,
  boundaryReloadTick: 0,

  dashModules: loadDashModules(),

  weatherFxEnabled: localStorage.getItem("weatherFx") !== "0",
  weatherPanelVisible: localStorage.getItem("weatherPanel") !== "0",
  drillEnabled: localStorage.getItem("adminDrill") !== "0",
  chartFlyEnabled: localStorage.getItem("chartFly") !== "0",
  healthMode: false,
  heatMode: false,

  ttsVoiceZh: localStorage.getItem("ttsVoiceZh") || "anna",
  ttsVoiceEn: localStorage.getItem("ttsVoiceEn") || "charles",
  ttsSpeed: ((): number => {
    const v = Number(localStorage.getItem("ttsSpeed"));
    return Number.isFinite(v) && v >= 0.5 && v <= 2 ? v : 1;
  })(),
  ttsScope: ((): "full" | "brief" | "intro" => {
    const v = localStorage.getItem("ttsScope");
    return v === "brief" || v === "intro" ? v : "full";
  })(),

  set(patch) {
    set(patch);
  },
  setDashModule(id, patch) {
    const next = { ...get().dashModules };
    const cur = next[id] || { dock: "left" as const };
    next[id] = { ...cur, ...patch };
    set({ dashModules: next });
    persistDashModules(next);
  },
  resetDashModules() {
    const def = defaultDashModules();
    set({ dashModules: def });
    persistDashModules(def);
  },
  showToast(text, kind = "info") {
    if (toastT) clearTimeout(toastT);
    set({ toast: { id: ++toastSeq, text, kind } });
    toastT = setTimeout(() => {
      const cur = get().toast;
      if (cur && cur.text === text) set({ toast: null });
    }, 2200);
  },
  bumpOfflineCoverage() {
    set({ offlineCoverageTick: get().offlineCoverageTick + 1 });
  },
  bumpBoundary() {
    set({ boundaryReloadTick: get().boundaryReloadTick + 1 });
  },
}));
