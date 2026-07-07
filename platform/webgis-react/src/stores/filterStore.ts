import { create } from "zustand";
import { categoryCode, rankCode, DIMS, dimValue, TIER_MAP } from "../utils/dict";
import { useRelicsStore } from "./relicsStore";
import type { BackendFilters } from "../types";

interface FilterState {
  search: string;
  county: string;
  township: string;
  level: string;
  cond: string;
  tier: "" | "city" | "full";
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

/** 统计面板点选的 tier 展示名 → 后端 city/full。 */
function tierFromLabel(label: string): string {
  for (const [k, v] of Object.entries(TIER_MAP)) {
    if (v === label) return k;
  }
  return label;
}

export const useFilterStore = create<FilterState>((set, get) => ({
  search: "",
  county: "",
  township: "",
  level: "",
  cond: "",
  tier: "",
  threeD: "",
  activeCats: new Set(),
  statFilters: {},
  toBackend(allCatNames) {
    const f = get();
    const out: BackendFilters = {};
    const catCodes = new Set<string>();
    if (f.activeCats.size > 0 && f.activeCats.size < allCatNames.size) {
      f.activeCats.forEach((n) => catCodes.add(categoryCode(n)));
    }
    // 统计面板点击"文物类别"(值经过 transform,如 近现代史迹)
    if (f.statFilters.category_main) {
      catCodes.add(categoryCode(f.statFilters.category_main));
    }
    if (catCodes.size) out.category = [...catCodes].join(",");
    const ranks = new Set<string>();
    if (f.level) ranks.add(rankCode(f.level));
    if (f.statFilters.heritage_level) ranks.add(rankCode(f.statFilters.heritage_level));
    if (ranks.size) out.rank = [...ranks].join(",");
    if (f.county) out.county = f.county;
    else if (f.statFilters.county) out.county = f.statFilters.county;
    if (f.township) out.township = f.township;
    else if (f.statFilters.township) out.township = f.statFilters.township;
    if (f.tier) out.tier = f.tier;
    else if (f.statFilters.tier) out.tier = tierFromLabel(f.statFilters.tier);
    if (f.cond) out.condition = f.cond;
    else if (f.statFilters.condition_level) out.condition = f.statFilters.condition_level;
    // 统计面板点击"年代分布":显示值是 remap 后的(如 清),
    // 反查全量数据中 remap 结果等于该值的所有 era_stats 原始值传给后端
    if (f.statFilters.era) {
      const eraDim = DIMS.find((d) => d.id === "era");
      if (eraDim) {
        const all = useRelicsStore.getState().all;
        const raws = new Set<string>();
        for (const r of all) {
          if (dimValue(r as unknown as Record<string, unknown>, eraDim) === f.statFilters.era) {
            raws.add((r.era_stats as string) || "__empty__");
          }
        }
        if (raws.size) out.era = [...raws].join(",");
      }
    }
    if (f.threeD === "1") out.has_3d = true;
    else if (f.threeD === "0") out.has_3d = false;
    const kw = f.search.trim();
    if (kw) out.q = kw;
    return out;
  },
  reset(cats) {
    set({
      search: "",
      county: "",
      township: "",
      level: "",
      cond: "",
      tier: "",
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
