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

interface UIState {
  filterPanelOpen: boolean;
  chatPanelOpen: boolean;
  settingsPanelOpen: boolean;
  helpPanelOpen: boolean;
  tileDownloadOpen: boolean;
  boundaryDownloadOpen: boolean;
  /** 巡查规划面板。开启后地图点击进入"选点组线"模式。 */
  patrolPanelOpen: boolean;

  baseLayer: BaseLayerType;
  baseLayerAlpha: number;
  terrainEnabled: boolean;

  bndCounty: boolean;
  bndCountyName: boolean;
  bndTownship: boolean;
  bndTownshipName: boolean;
  bndVillage: boolean;
  bndVillageName: boolean;

  symbolMode: boolean;
  /** @deprecated 仅作向后兼容,真实状态以 renderQuality 为准。 */
  hdMode: boolean;
  /** standard | hd | ultra,持久化到 localStorage("renderQuality")。 */
  renderQuality: RenderQuality;
  hideRelicPoints: boolean;
  uiSize: "sm" | "md" | "lg";
  theme: "blue" | "purple" | "gold" | "pink";
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

  toast: { id: number; text: string } | null;

  /** 单调递增的"离线覆盖刷新"信号。下载完成后 +1,MapView 监听刷新红框。 */
  offlineCoverageTick: number;
  /** 单调递增的"边界数据刷新"信号。下载/清除边界后 +1,MapView 重载 BoundaryLayer。 */
  boundaryReloadTick: number;

  /** 综合统计面板每个模块的布局/图表类型,持久化到 localStorage("dashModules")。 */
  dashModules: Record<string, DashModuleCfg>;

  set: (patch: Partial<Omit<UIState, "set" | "showToast" | "bumpOfflineCoverage" | "bumpBoundary" | "setDashModule" | "resetDashModules">>) => void;
  showToast: (text: string) => void;
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
  tileDownloadOpen: false,
  boundaryDownloadOpen: false,
  patrolPanelOpen: false,

  baseLayer: "arcgis_sat",
  baseLayerAlpha: 90,
  terrainEnabled: false,

  bndCounty: true,
  bndCountyName: true,
  bndTownship: true,
  bndTownshipName: true,
  bndVillage: false,
  bndVillageName: false,

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
  theme: "blue",
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
  showToast(text) {
    if (toastT) clearTimeout(toastT);
    set({ toast: { id: ++toastSeq, text } });
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
