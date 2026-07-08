import { create } from "zustand";
import {
  analyzeParcelLayer,
  deleteParcelLayer,
  importParcels,
  listParcelLayers,
  type ParcelAnalysis,
  type ParcelLayerMeta,
} from "../api/parcels";
import { useUIStore } from "./uiStore";

/**
 * 对比图斑状态:图层列表 / 显隐 / 分析结果。
 * 地图渲染由 ParcelLayer(Cesium)监听本 store 完成。
 */
interface ParcelState {
  panelOpen: boolean;
  layers: ParcelLayerMeta[];
  /** 图层显隐(默认导入即显示)。 */
  visible: Record<string, boolean>;
  loaded: boolean;
  importing: boolean;
  /** 正在分析的图层 id,空串表示无。 */
  analyzing: string;
  /** 各图层最近一次分析结果。 */
  analyses: Record<string, ParcelAnalysis>;
  /** 数据变化信号,ParcelLayer 监听后增量同步。 */
  reloadTick: number;

  setPanelOpen: (v: boolean) => void;
  refresh: () => Promise<void>;
  importFiles: (files: File[]) => Promise<void>;
  toggleVisible: (id: string) => void;
  analyze: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export const useParcelStore = create<ParcelState>((set, get) => ({
  panelOpen: false,
  layers: [],
  visible: {},
  loaded: false,
  importing: false,
  analyzing: "",
  analyses: {},
  reloadTick: 0,

  setPanelOpen(v) {
    set({ panelOpen: v });
    if (v && !get().loaded) void get().refresh();
  },

  async refresh() {
    try {
      const layers = await listParcelLayers();
      const visible = { ...get().visible };
      layers.forEach((l) => {
        if (visible[l.id] === undefined) visible[l.id] = true;
      });
      set({ layers, visible, loaded: true, reloadTick: get().reloadTick + 1 });
    } catch {
      useUIStore.getState().showToast("图斑图层列表加载失败", "error");
    }
  },

  async importFiles(files) {
    if (get().importing || !files.length) return;
    set({ importing: true });
    try {
      const res = await importParcels(files);
      const visible = { ...get().visible };
      res.layers.forEach((l) => (visible[l.id] = true));
      set({
        layers: [...get().layers, ...res.layers],
        visible,
        reloadTick: get().reloadTick + 1,
      });
      const n = res.layers.reduce((s, l) => s + l.feature_count, 0);
      useUIStore.getState().showToast(
        `已导入 ${res.layers.length} 个图层 / ${n} 个图斑`,
        "success",
      );
      if (res.warnings.length) {
        console.warn("[parcels] import warnings:", res.warnings);
      }
    } catch (e) {
      const detail =
        (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail || "";
      useUIStore.getState().showToast(detail || "SHP 导入失败", "error");
    } finally {
      set({ importing: false });
    }
  },

  toggleVisible(id) {
    const visible = { ...get().visible, [id]: !get().visible[id] };
    set({ visible });
  },

  async analyze(id) {
    if (get().analyzing) return;
    set({ analyzing: id });
    try {
      const result = await analyzeParcelLayer(id);
      set({ analyses: { ...get().analyses, [id]: result } });
      const s = result.summary;
      if (s.total === 0) {
        useUIStore.getState().showToast("未发现压占文物范围的图斑", "success");
      } else {
        useUIStore.getState().showToast(
          `发现 ${s.total} 处冲突,涉及 ${s.relics_hit} 处文物`,
          "warning",
        );
      }
    } catch {
      useUIStore.getState().showToast("冲突分析失败", "error");
    } finally {
      set({ analyzing: "" });
    }
  },

  async remove(id) {
    try {
      await deleteParcelLayer(id);
    } catch {
      useUIStore.getState().showToast("删除图层失败", "error");
      return;
    }
    const layers = get().layers.filter((l) => l.id !== id);
    const visible = { ...get().visible };
    delete visible[id];
    const analyses = { ...get().analyses };
    delete analyses[id];
    set({ layers, visible, analyses, reloadTick: get().reloadTick + 1 });
  },
}));
