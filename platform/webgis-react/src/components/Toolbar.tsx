import { useEffect, useMemo, useRef, useState } from "react";
import { useUIStore } from "../stores/uiStore";
import { useFilterStore } from "../stores/filterStore";
import { useRelicsStore } from "../stores/relicsStore";
import { flyHomeFn } from "../map/MapView";
import { getViewer } from "../map/viewerRegistry";
import { passFilter } from "./FilterPanel";
import { DIMS } from "../utils/dict";
import type { BaseLayerType } from "../types";

const BASE_OPTIONS: { value: BaseLayerType; label: string }[] = [
  { value: "arcgis_sat", label: "离线影像" },
  { value: "osm", label: "离线矢量" },
  { value: "gaode_sat", label: "在线影像 (高德)" },
  { value: "gaode_vec", label: "在线矢量 (高德)" },
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
  const toastObj = useUIStore((s) => s.toast);
  const setUI = useUIStore((s) => s.set);
  const showToast = useUIStore((s) => s.showToast);

  const search = useFilterStore((s) => s.search);
  const county = useFilterStore((s) => s.county);
  const township = useFilterStore((s) => s.township);
  const level = useFilterStore((s) => s.level);
  const cond = useFilterStore((s) => s.cond);
  const tier = useFilterStore((s) => s.tier);
  const threeD = useFilterStore((s) => s.threeD);
  const activeCats = useFilterStore((s) => s.activeCats);
  const allRelics = useRelicsStore((s) => s.all);
  const allCount = allRelics.length;

  const lvDim = DIMS.find((d) => d.id === "heritage_level");
  // 真实通过筛选的文物数,用于"筛选"按钮徽章。
  const filteredCount = useMemo(() => {
    const catNames = new Set(
      allRelics.map((r) => r.category_main).filter(Boolean) as string[],
    );
    const catFilterOn = activeCats.size > 0 && activeCats.size < catNames.size;
    const anyFilter =
      catFilterOn || !!search.trim() || !!county || !!township || !!level ||
      !!cond || !!tier || !!threeD;
    if (!anyFilter) return allCount;
    const f = { search, county, township, level, cond, tier, threeD, activeCats };
    return allRelics.filter((r) => passFilter(r, f, lvDim)).length;
  }, [allRelics, allCount, activeCats, search, county, township, level, cond, tier, threeD, lvDim]);

  const [baseMenuOpen, setBaseMenuOpen] = useState(false);
  const [boundaryMenuOpen, setBoundaryMenuOpen] = useState(false);
  const baseMenuRef = useRef<HTMLDivElement>(null);
  const boundaryMenuRef = useRef<HTMLDivElement>(null);

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
    BASE_OPTIONS.find((o) => o.value === baseLayer)?.label || "底图影像";

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
            {baseLabel} ▾
          </button>
          {baseMenuOpen && (
            <div
              className="dropdown-menu open"
              style={{ left: 0, top: "calc(100% + 4px)" }}
            >
              {BASE_OPTIONS.map((opt) => (
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
            边界 ▾
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
            </div>
          )}
        </div>
      </div>

      <div className="status-summary">
        {toastObj?.text ||
          (filteredCount < allCount
            ? `筛选结果 ${filteredCount} / ${allCount} 处文物`
            : `全市在册文物 ${allCount} 处`)}
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
