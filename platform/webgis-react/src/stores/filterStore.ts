import { create } from "zustand";
import { categoryCode, rankCode } from "../utils/dict";
import type { BackendFilters } from "../types";

interface FilterState {
  search: string;
  township: string;
  level: string;
  cond: string;
  threeD: "" | "1" | "0";
  activeCats: Set<string>;
  statFilters: Record<string, string>;
  toBackend: (allCatNames: Set<string>) => BackendFilters;
  reset: (catNames: Set<string>) => void;
  setPartial: (patch: Partial<Omit<FilterState, "activeCats" | "statFilters">>) => void;
  setActiveCats: (cats: Set<string>) => void;
  toggleCat: (name: string) => void;
  toggleStatFilter: (dimId: string, value: string) => void;
  setStatFilters: (next: Record<string, string>) => void;
}

export const useFilterStore = create<FilterState>((set, get) => ({
  search: "",
  township: "",
  level: "",
  cond: "",
  threeD: "",
  activeCats: new Set(),
  statFilters: {},
  toBackend(allCatNames) {
    const f = get();
    const out: BackendFilters = {};
    if (f.activeCats.size > 0 && f.activeCats.size < allCatNames.size) {
      const codes = new Set<string>();
      f.activeCats.forEach((n) => codes.add(categoryCode(n)));
      out.category = [...codes].join(",");
    }
    const ranks = new Set<string>();
    if (f.level) ranks.add(rankCode(f.level));
    if (f.statFilters.heritage_level) ranks.add(rankCode(f.statFilters.heritage_level));
    if (ranks.size) out.rank = [...ranks].join(",");
    if (f.township) out.township = f.township;
    else if (f.statFilters.township) out.township = f.statFilters.township;
    return out;
  },
  reset(cats) {
    set({
      search: "",
      township: "",
      level: "",
      cond: "",
      threeD: "",
      activeCats: new Set(cats),
      statFilters: {},
    });
  },
  setPartial(patch) {
    set(patch as Partial<FilterState>);
  },
  setActiveCats(cats) {
    set({ activeCats: new Set(cats) });
  },
  toggleCat(name) {
    const { activeCats } = get();
    const next = new Set(activeCats);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    set({ activeCats: next });
  },
  toggleStatFilter(dimId, value) {
    const { statFilters } = get();
    const next = { ...statFilters };
    if (next[dimId] === value) delete next[dimId];
    else next[dimId] = value;
    set({ statFilters: next });
  },
  setStatFilters(next) {
    set({ statFilters: next });
  },
}));
