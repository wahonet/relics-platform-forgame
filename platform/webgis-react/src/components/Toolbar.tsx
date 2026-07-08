import { useEffect, useMemo, useRef, useState } from "react";
import { useUIStore } from "../stores/uiStore";
import { useFilterStore } from "../stores/filterStore";
import { useRelicsStore } from "../stores/relicsStore";
import { usePlatformStore } from "../stores/platformStore";
import { useParcelStore } from "../stores/parcelStore";
import { flyHomeFn } from "../map/MapView";
import { getViewer } from "../map/viewerRegistry";
import { passFilter } from "./FilterPanel";
import { DIMS, dimValues, rankCode, rankShort } from "../utils/dict";
import type { BaseLayerType } from "../types";

const BASE_OPTIONS: { value: BaseLayerType; label: string }[] = [
  { value: "tianditu_img", label: "在线影像 (天地图)" },
  { value: "tianditu_vec", label: "在线矢量 (天地图)" },
  { value: "gaode_sat", label: "在线影像 (高德)" },
  { value: "gaode_vec", label: "在线矢量 (高德)" },
  { value: "arcgis_sat", label: "离线影像" },
  { value: "osm", label: "离线矢量" },
  { value: "none", label: "无底图" },
];

export function Toolbar() {
  // 单独订阅以避免对整个 ui store 的全量订阅触发不必要的重渲染。
  const filterPanelOpen = useUIStore((s) => s.filterPanelOpen);
  const baseLayer = useUIStore((s) => s.baseLayer);
  const baseLayerAlpha = useUIStore((s) => s.baseLayerAlpha);
  const bndCounty = useUIStore((s) => s.bndCounty);
  const bndCountyName = useUIStore((s) => s.bndCountyName);
  const bndTownship = useUIStore((s) => s.bndTownship);
  const bndTownshipName = useUIStore((s) => s.bndTownshipName);
  const bndVillage = useUIStore((s) => s.bndVillage);
  const bndVillageName = useUIStore((s) => s.bndVillageName);
  const twoLineVisible = useUIStore((s) => s.twoLineVisible);
  const toastObj = useUIStore((s) => s.toast);
  const setUI = useUIStore((s) => s.set);
  const showToast = useUIStore((s) => s.showToast);

  const parcelPanelOpen = useParcelStore((s) => s.panelOpen);
  const setParcelPanelOpen = useParcelStore((s) => s.setPanelOpen);
  const parcelLayerCount = useParcelStore((s) => s.layers.length);

  const search = useFilterStore((s) => s.search);
  const county = useFilterStore((s) => s.county);
  const township = useFilterStore((s) => s.township);
  const level = useFilterStore((s) => s.level);
  const cond = useFilterStore((s) => s.cond);
  const tier = useFilterStore((s) => s.tier);
  const threeD = useFilterStore((s) => s.threeD);
  const activeCats = useFilterStore((s) => s.activeCats);
  const statFilters = useFilterStore((s) => s.statFilters);
  const allRelics = useRelicsStore((s) => s.all);
  const allCount = allRelics.length;
  const cityName = usePlatformStore(
    (s) => s.config?.project?.name || "全市",
  );

  const lvDim = DIMS.find((d) => d.id === "heritage_level");
  // 真实通过筛选的文物数(含统计面板点选),用于徽章与"当前视图"。
  const filteredCount = useMemo(() => {
    const catNames = new Set(
      allRelics.map((r) => r.category_main).filter(Boolean) as string[],
    );
    const catFilterOn = activeCats.size > 0 && activeCats.size < catNames.size;
    const anyFilter =
      catFilterOn || !!search.trim() || !!county || !!township || !!level ||
      !!cond || !!tier || !!threeD || Object.keys(statFilters).length > 0;
    if (!anyFilter) return allCount;
    const f = { search, county, township, level, cond, tier, threeD, activeCats };
    return allRelics.filter((r) => {
      if (!passFilter(r, f, lvDim)) return false;
      for (const [dimId, val] of Object.entries(statFilters)) {
        const dim = DIMS.find((d) => d.id === dimId);
        if (dim && !dimValues(r as unknown as Record<string, unknown>, dim).includes(val))
          return false;
      }
      return true;
    }).length;
  }, [allRelics, allCount, activeCats, search, county, township, level, cond, tier, threeD, statFilters, lvDim]);

  /** 「当前视图」层级:区域 → 级别 → 类别 → 年代 → 保存状况(→ 关键词)。 */
  const viewCrumbs = useMemo(() => {
    const parts: string[] = [];
    // 1. 区域(县区 + 乡镇)
    const rgCounty = county || statFilters.county || "";
    const rgTown = (township || statFilters.township || "").replace(/^\d+/, "");
    if (rgCounty || rgTown) parts.push([rgCounty, rgTown].filter(Boolean).join(" "));
    else parts.push(cityName);
    // 2. 文物级别(简称:国保/省保/市保/县保/未定级)
    const lv = level || statFilters.heritage_level || "";
    if (lv) parts.push(rankShort(rankCode(lv)));
    // 3. 文物类别
    const catNames = new Set(
      allRelics.map((r) => r.category_main).filter(Boolean) as string[],
    );
    if (statFilters.category_main) {
      parts.push(statFilters.category_main);
    } else if (activeCats.size > 0 && activeCats.size < catNames.size) {
      const names = [...activeCats].map(
        (n) => (n === "近现代重要史迹及代表性建筑" ? "近现代史迹" : n),
      );
      parts.push(names.length <= 2 ? names.join("/") : `${names[0]}等${names.length}类`);
    }
    // 4. 年代分布
    if (statFilters.era) parts.push(statFilters.era);
    // 5. 保存状况
    const cd = cond || statFilters.condition_level || "";
    if (cd) parts.push(`保存${cd}`);
    // 附加:关键词/3D
    if (search.trim()) parts.push(`“${search.trim()}”`);
    if (threeD === "1") parts.push("有三维模型");
    return parts;
  }, [county, township, level, cond, search, threeD, activeCats, statFilters, allRelics, cityName]);

  const hasFilter = filteredCount < allCount;

  const [baseMenuOpen, setBaseMenuOpen] = useState(false);
  const [boundaryMenuOpen, setBoundaryMenuOpen] = useState(false);
  const baseMenuRef = useRef<HTMLDivElement>(null);
  const boundaryMenuRef = useRef<HTMLDivElement>(null);

  const tiandituEnabled = usePlatformStore((s) => !!s.config?.features?.tianditu);
  const baseOptions = useMemo(
    () =>
      tiandituEnabled
        ? BASE_OPTIONS
        : BASE_OPTIONS.filter((o) => !o.value.startsWith("tianditu")),
    [tiandituEnabled],
  );

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (baseMenuRef.current && !baseMenuRef.current.contains(t)) {
        setBaseMenuOpen(false);
      }
      if (boundaryMenuRef.current && !boundaryMenuRef.current.contains(t)) {
        setBoundaryMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const baseLabel =
    baseOptions.find((o) => o.value === baseLayer)?.label || "底图影像";

  const onReset = () => {
    const cats = useRelicsStore.getState().all.map((r) => r.category_main || "");
    useFilterStore.getState().reset(new Set(cats.filter(Boolean)));
    setUI({
      filterPanelOpen: false,
      chatPanelOpen: false,
      patrolPanelOpen: false,
      selectedRelic: null,
    });
    flyHomeFn(getViewer());
    setTimeout(() => flyHomeFn(getViewer()), 50);
    showToast("已重置筛选并飞回主视角");
  };

  const onFullscreen = () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
  };

  return (
    <div className="toolbar">
      <div className="tb-group boxed">
        <button
          className={"tb" + (filterPanelOpen ? " on" : "")}
          onClick={() => setUI({ filterPanelOpen: !filterPanelOpen })}
          title="筛选面板"
        >
          <svg viewBox="0 0 24 24">
            <path d="M3 4h18v2L13 16v6h-2v-6L3 6V4z" />
          </svg>
          筛选
          {filteredCount > 0 && filteredCount < allCount ? <b>·{filteredCount}</b> : null}
        </button>
      </div>

      <div className="tb-group boxed">
        <div ref={baseMenuRef} style={{ position: "relative" }}>
          <button
            className={"tb" + (baseMenuOpen ? " on" : "")}
            onClick={() => setBaseMenuOpen((v) => !v)}
          >
            <svg viewBox="0 0 24 24">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
            {baseLabel}
            <span className="tb-caret">▾</span>
          </button>
          {baseMenuOpen && (
            <div
              className="dropdown-menu open"
              style={{ left: 0, top: "calc(100% + 4px)" }}
            >
              {baseOptions.map((opt) => (
                <div
                  key={opt.value}
                  className={
                    "dropdown-item" + (baseLayer === opt.value ? " on" : "")
                  }
                  onClick={() => {
                    setUI({ baseLayer: opt.value });
                    setBaseMenuOpen(false);
                  }}
                >
                  {opt.label}
                </div>
              ))}
              <div className="dropdown-divider" />
              <div className="dropdown-group">底图透明度: {baseLayerAlpha}%</div>
              <input
                type="range"
                min={20}
                max={100}
                value={baseLayerAlpha}
                onChange={(e) => setUI({ baseLayerAlpha: Number(e.target.value) })}
                style={{ width: "calc(100% - 16px)", margin: "4px 8px" }}
              />
            </div>
          )}
        </div>
      </div>

      <div className="tb-group boxed">
        <div ref={boundaryMenuRef} style={{ position: "relative" }}>
          <button
            className={"tb" + (boundaryMenuOpen ? " on" : "")}
            onClick={() => setBoundaryMenuOpen((v) => !v)}
          >
            <svg viewBox="0 0 24 24">
              <path d="M21 4H3v2h18V4zM3 20h18v-2H3v2zM4 12l4-4 4 4 4-4 4 4v6H4z" />
            </svg>
            边界
            <span className="tb-caret">▾</span>
          </button>
          {boundaryMenuOpen && (
            <div
              className="dropdown-menu open"
              style={{ left: 0, top: "calc(100% + 4px)" }}
            >
              <label className="dropdown-item">
                <input
                  type="checkbox"
                  checked={bndCounty}
                  onChange={(e) => setUI({ bndCounty: e.target.checked })}
                />{" "}
                县界
              </label>
              <label className="dropdown-item">
                <input
                  type="checkbox"
                  checked={bndCountyName}
                  onChange={(e) => setUI({ bndCountyName: e.target.checked })}
                />{" "}
                县名
              </label>
              <label className="dropdown-item">
                <input
                  type="checkbox"
                  checked={bndTownship}
                  onChange={(e) => setUI({ bndTownship: e.target.checked })}
                />{" "}
                镇界
              </label>
              <label className="dropdown-item">
                <input
                  type="checkbox"
                  checked={bndTownshipName}
                  onChange={(e) => setUI({ bndTownshipName: e.target.checked })}
                />{" "}
                镇名
              </label>
              <label className="dropdown-item">
                <input
                  type="checkbox"
                  checked={bndVillage}
                  onChange={(e) => setUI({ bndVillage: e.target.checked })}
                />{" "}
                村界
              </label>
              <label className="dropdown-item">
                <input
                  type="checkbox"
                  checked={bndVillageName}
                  onChange={(e) => setUI({ bndVillageName: e.target.checked })}
                />{" "}
                村名
              </label>
              <div className="dropdown-divider" />
              <label className="dropdown-item" title="保护范围(红)与建设控制地带(蓝)">
                <input
                  type="checkbox"
                  checked={twoLineVisible}
                  onChange={(e) => setUI({ twoLineVisible: e.target.checked })}
                />{" "}
                两线范围
              </label>
            </div>
          )}
        </div>
      </div>

      <div className="tb-group boxed">
        <button
          className={"tb" + (parcelPanelOpen ? " on" : "")}
          onClick={() => setParcelPanelOpen(!parcelPanelOpen)}
          title="导入 SHP 用地图斑,一键查询是否压占文物本体/两线范围"
        >
          <svg viewBox="0 0 24 24">
            <path d="M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm12.5 0L20 16.5 16.5 20 13 16.5 16.5 13z" />
          </svg>
          图斑对比
          {parcelLayerCount > 0 ? <b>·{parcelLayerCount}</b> : null}
        </button>
      </div>

      <div className="status-summary">
        {toastObj?.text ? (
          toastObj.text
        ) : (
          <>
            <em className="vw-label">当前视图</em>
            {viewCrumbs.map((c, i) => (
              <span key={i} className="vw-crumb">
                {i > 0 ? <i className="vw-sep">›</i> : null}
                {c}
              </span>
            ))}
            <b className="vw-count">
              {hasFilter ? `${filteredCount} / ${allCount} 处` : `${allCount} 处`}
            </b>
          </>
        )}
      </div>

      <div className="tb-group" style={{ marginLeft: "auto" }}>
        <button className="tb" onClick={onFullscreen} title="全屏">
          <svg viewBox="0 0 24 24">
            <path d="M5 5h6v2H7v4H5V5zm14 0v6h-2V7h-4V5h6zM5 19v-6h2v4h4v2H5zm14-6v6h-6v-2h4v-4h2z" />
          </svg>
        </button>
        <button className="tb" onClick={onReset} title="重置主视角">
          <svg viewBox="0 0 24 24">
            <path d="M12 2L4 7v6c0 5.55 3.84 10.74 8 12 4.16-1.26 8-6.45 8-12V7l-8-5z" />
          </svg>
          重置
        </button>
      </div>
    </div>
  );
}
