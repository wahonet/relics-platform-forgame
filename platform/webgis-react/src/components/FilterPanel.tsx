import { useEffect, useMemo } from "react";
import { useFilterStore } from "../stores/filterStore";
import { useRelicsStore } from "../stores/relicsStore";
import { useUIStore } from "../stores/uiStore";
import { useDrillStore } from "../stores/drillStore";
import { usePlatformStore } from "../stores/platformStore";
import { DIMS, dimValue, buildColorMap } from "../utils/dict";
import { fetchRelicDetail } from "../api/relics";
import type { RelicScope, RelicSummary } from "../types";
import { useCatalogScopeStore } from "../stores/catalogScopeStore";
import { filterRelicsByScope, relicInScope } from "../utils/relicScope";

/** 判断一条文物是否通过当前筛选(供计数和结果列表复用,Toolbar 徽章也使用)。 */
export function passFilter(
  r: RelicSummary,
  f: {
    search: string;
    county: string;
    township: string;
    level: string;
    cond: string;
    tier: string;
    threeD: string;
    scope: RelicScope;
    activeCats: Set<string>;
    /** 村级下钻时的村内 code 集合(可选)。 */
    villageCodes?: Set<string> | null;
  },
  lvDim?: (typeof DIMS)[number],
): boolean {
  if (!relicInScope(r, f.scope)) return false;
  if (f.activeCats.size && r.category_main && !f.activeCats.has(r.category_main)) return false;
  const kw = f.search.trim().toLowerCase();
  if (
    kw &&
    !(r.name || "").toLowerCase().includes(kw) &&
    !(r.archive_code || "").toLowerCase().includes(kw) &&
    !(r.address || "").toLowerCase().includes(kw)
  )
    return false;
  if (f.county && (r.county || "") !== f.county) return false;
  if (f.township && (r.township || "") !== f.township) return false;
  if (f.villageCodes && !f.villageCodes.has(r.archive_code)) return false;
  if (f.level && lvDim && dimValue(r as Record<string, unknown>, lvDim) !== f.level) return false;
  if (f.cond && r.condition_level !== f.cond) return false;
  if (f.tier && (r.tier || "") !== f.tier) return false;
  if (f.threeD === "1" && !r.has_3d) return false;
  if (f.threeD === "0" && r.has_3d) return false;
  return true;
}

export function FilterPanel() {
  const open = useUIStore((s) => s.filterPanelOpen);
  const setUI = useUIStore((s) => s.set);
  const config = usePlatformStore((s) => s.config);
  const search = useFilterStore((s) => s.search);
  const county = useFilterStore((s) => s.county);
  const township = useFilterStore((s) => s.township);
  const level = useFilterStore((s) => s.level);
  const cond = useFilterStore((s) => s.cond);
  const tier = useFilterStore((s) => s.tier);
  const threeD = useFilterStore((s) => s.threeD);
  const scope = useCatalogScopeStore((s) => s.scope);
  const activeCats = useFilterStore((s) => s.activeCats);
  const setPartial = useFilterStore((s) => s.setPartial);
  const setActiveCats = useFilterStore((s) => s.setActiveCats);
  const toggleCat = useFilterStore((s) => s.toggleCat);
  const resetFilter = useFilterStore((s) => s.reset);
  const villageCodes = useDrillStore((s) => s.villageCodes);
  const allRelics = useRelicsStore((s) => s.all);
  const scopedRelics = useMemo(
    () => filterRelicsByScope(allRelics, scope),
    [allRelics, scope],
  );

  const lvDim = DIMS.find((d) => d.id === "heritage_level");
  const catDim = DIMS.find((d) => d.id === "category_main")!;

  const counties = useMemo(() => {
    const fromCfg = config?.administrative?.counties || [];
    if (fromCfg.length) return fromCfg;
    return [...new Set(scopedRelics.map((r) => r.county).filter(Boolean) as string[])].sort();
  }, [scopedRelics, config]);

  // 乡镇仅在选定县区后展示(全市乡镇太多)。
  const towns = useMemo(() => {
    if (!county) return [];
    const set = new Set<string>();
    scopedRelics.forEach((r) => {
      if (r.county === county && r.township) set.add(r.township);
    });
    return [...set].sort();
  }, [scopedRelics, county]);

  const levels = useMemo(() => {
    const set = new Set<string>();
    scopedRelics.forEach((r) => {
      if (r.heritage_level)
        set.add(lvDim ? dimValue(r as Record<string, unknown>, lvDim) : r.heritage_level);
    });
    // 按保护级别从高到低排列(与 DIMS.heritage_level.order 一致)
    const order = lvDim?.order || [];
    return [...set].sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  }, [scopedRelics, lvDim]);

  const conds = useMemo(() => {
    const order = ["好", "较好", "一般", "较差", "差"];
    const set = new Set<string>();
    scopedRelics.forEach((r) => {
      if (r.condition_level) set.add(r.condition_level);
    });
    return order.filter((c) => set.has(c));
  }, [scopedRelics]);

  const catNames = useMemo(
    () =>
      [...new Set(scopedRelics.map((r) => r.category_main).filter(Boolean) as string[])].sort(),
    [scopedRelics],
  );

  const colorMap = useMemo(
    () => buildColorMap(scopedRelics as unknown as Record<string, unknown>[], catDim),
    [scopedRelics, catDim],
  );

  useEffect(() => {
    if (catNames.length > 0 && activeCats.size === 0) {
      setActiveCats(new Set(catNames));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catNames.length]);

  const fstate = {
    search,
    county,
    township,
    level,
    cond,
    tier,
    threeD,
    scope,
    activeCats,
    villageCodes,
  };

  const filteredCount = useMemo(
    () => scopedRelics.filter((r) => passFilter(r, fstate, lvDim)).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scopedRelics, activeCats, search, county, township, level, cond, tier, threeD, scope, villageCodes, lvDim],
  );

  const has3dCount = useMemo(
    () => scopedRelics.filter((r) => r.has_3d).length,
    [scopedRelics],
  );

  return (
    <div className={"filter-panel" + (open ? " open" : "")}>
      <div className="fp-title">
        筛选与搜索
        <button onClick={() => setUI({ filterPanelOpen: false })}>×</button>
      </div>
      <div className="fp-stat">
        当前 <b>{filteredCount}</b> 处文物，其中 <small>{has3dCount}</small> 处有三维模型
      </div>
      <div className="fp-section">
        <div className="fp-label">关键字搜索</div>
        <input
          className="fp-search"
          placeholder="按名称 / 编号 / 地址搜索..."
          value={search}
          onChange={(e) => setPartial({ search: e.target.value })}
        />
      </div>
      <div className="fp-section">
        <div className="fp-label">文物类别</div>
        <div className="fp-checks">
          {catNames.map((name) => {
            const displayName = name === "近现代重要史迹及代表性建筑" ? "近现代史迹" : name;
            const active = activeCats.has(name);
            return (
              <div
                key={name}
                className={"fp-chk" + (active ? " active" : "")}
                onClick={() => toggleCat(name)}
              >
                <div
                  className="dot"
                  style={{ background: colorMap[displayName] || "#8b99ad" }}
                />
                {displayName}
              </div>
            );
          })}
        </div>
      </div>
      <div className="fp-section">
        <div className="fp-label">县市区</div>
        <select
          className="fp-select"
          value={county}
          onChange={(e) => {
            setPartial({ county: e.target.value, township: "" });
            useDrillStore.getState().syncFromFilter(e.target.value, "");
          }}
        >
          <option value="">全部县市区</option>
          {counties.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      {towns.length > 0 && (
        <div className="fp-section">
          <div className="fp-label">乡镇</div>
          <select
            className="fp-select"
            value={township}
            onChange={(e) => {
              setPartial({ township: e.target.value });
              useDrillStore.getState().syncFromFilter(county, e.target.value);
            }}
          >
            <option value="">全部乡镇</option>
            {towns.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="fp-section">
        <div className="fp-label">保护级别</div>
        <select
          className="fp-select"
          value={level}
          onChange={(e) => setPartial({ level: e.target.value })}
        >
          <option value="">全部级别</option>
          {levels.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <div className="fp-section">
        <div className="fp-label">保存状况</div>
        <select
          className="fp-select"
          value={cond}
          onChange={(e) => setPartial({ cond: e.target.value })}
        >
          <option value="">全部状况</option>
          {conds.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <div className="fp-section">
        <div className="fp-label">三维模型</div>
        <select
          className="fp-select"
          value={threeD}
          onChange={(e) => setPartial({ threeD: e.target.value as "" | "1" | "0" })}
        >
          <option value="">全部</option>
          <option value="1">仅有三维</option>
          <option value="0">仅无三维</option>
        </select>
      </div>
      <div className="fp-actions">
        {/* 筛选条件即改即生效,此按钮仅收起面板。 */}
        <button
          className="fp-btn primary"
          onClick={() => setUI({ filterPanelOpen: false })}
        >
          完成
        </button>
        <button
          className="fp-btn secondary"
          onClick={() => {
            resetFilter(new Set(catNames));
            useDrillStore.getState().syncFromFilter("", "");
          }}
        >
          重置
        </button>
      </div>
      <div className="fp-section" style={{ borderTop: "1px solid var(--bd)", flex: 1 }}>
        <div className="fp-label">搜索结果（前 50）</div>
        <div>
          {allRelics
            .filter((r) => passFilter(r, fstate, lvDim))
            .slice(0, 50)
            .map((r) => (
              <div
                key={r.archive_code}
                className="list-item"
                onClick={async () => {
                  try {
                    const full = await fetchRelicDetail(r.archive_code);
                    setUI({ selectedRelic: full });
                  } catch {
                    setUI({ selectedRelic: r });
                  }
                }}
              >
                <div className="li-name">{r.name}</div>
                <div className="li-meta">
                  <span className="li-cat">{r.category_main || ""}</span>
                  <span className="li-era">{r.era || ""}</span>
                  <span>{r.county || ""}{r.township ? " · " + r.township : ""}</span>
                </div>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
