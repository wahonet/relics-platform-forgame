import { create } from "zustand";
import { fetchPlatformConfig } from "../api/platform";
import { useUIStore } from "./uiStore";

interface PlatformState {
  config: PlatformConfig | null;
  loaded: boolean;
  loadError: string | null;
  load: () => Promise<void>;
}

export const usePlatformStore = create<PlatformState>((set, get) => ({
  config: null,
  loaded: false,
  loadError: null,
  async load() {
    if (get().loaded) return;
    try {
      const config = await fetchPlatformConfig();
      set({ config, loaded: true, loadError: null });
      // 默认底图是天地图;未配置天地图 key 时回退到高德在线影像
      const ui = useUIStore.getState();
      if (!config.features?.tianditu && ui.baseLayer.startsWith("tianditu")) {
        ui.set({ baseLayer: "gaode_sat" });
      }
    } catch (e) {
      set({ loadError: e instanceof Error ? e.message : String(e) });
    }
  },
}));
