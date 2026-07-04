import { create } from "zustand";
import { fetchPlatformConfig } from "../api/platform";

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
    } catch (e) {
      set({ loadError: e instanceof Error ? e.message : String(e) });
    }
  },
}));
