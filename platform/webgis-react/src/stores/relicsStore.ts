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
  /** 失败后手动重试(load 在 loadError 存在时不会自动再发,避免重试风暴)。 */
  retry: () => void;
  upsert: (r: RelicSummary) => void;
}

export const useRelicsStore = create<RelicsState>((set, get) => ({
  all: [],
  byCode: new Map(),
  loaded: false,
  loading: false,
  loadError: null,
  async load() {
    // loadError 也拦截:失败后 loading 归 false,若不拦截 App 的 effect 会立刻
    // 再触发 load,形成对后端的无限重试风暴。重试必须走 retry()。
    if (get().loaded || get().loading || get().loadError) return;
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
  retry() {
    if (get().loading) return;
    set({ loadError: null });
    void get().load();
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
