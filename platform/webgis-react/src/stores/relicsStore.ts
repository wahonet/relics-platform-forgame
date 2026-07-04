import { create } from "zustand";
import { fetchRelicsList } from "../api/relics";
import type { RelicSummary } from "../types";

interface RelicsState {
  all: RelicSummary[];
  byCode: Map<string, RelicSummary>;
  loaded: boolean;
  loading: boolean;
  loadError: string | null;
  load: () => Promise<void>;
  upsert: (r: RelicSummary) => void;
}

export const useRelicsStore = create<RelicsState>((set, get) => ({
  all: [],
  byCode: new Map(),
  loaded: false,
  loading: false,
  loadError: null,
  async load() {
    if (get().loaded || get().loading) return;
    set({ loading: true });
    try {
      const all = await fetchRelicsList();
      const byCode = new Map<string, RelicSummary>();
      all.forEach((r) => byCode.set(r.archive_code, r));
      set({ all, byCode, loaded: true, loadError: null, loading: false });
    } catch (e) {
      set({
        loadError: e instanceof Error ? e.message : String(e),
        loading: false,
      });
    }
  },
  upsert(r: RelicSummary) {
    const { byCode, all } = get();
    const next = new Map(byCode);
    next.set(r.archive_code, r);
    const idx = all.findIndex((x) => x.archive_code === r.archive_code);
    const arr = idx >= 0 ? [...all.slice(0, idx), r, ...all.slice(idx + 1)] : [...all, r];
    set({ byCode: next, all: arr });
  },
}));
