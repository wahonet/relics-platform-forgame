import { useEffect, useState } from "react";
import { useUIStore, type RenderQuality } from "../stores/uiStore";
import { useHomeViewStore } from "../stores/homeViewStore";
import { flyTo, getViewer } from "../map/viewerRegistry";
import { applyRenderQuality } from "../map/renderQuality";
import { CRS_LIST, type CrsId } from "../utils/crs";
import {
  DASH_MODULES,
  CHART_TYPE_LABEL,
  DOCK_LABEL,
  type DashChartType,
  type DashDock,
} from "./dashboardModules";
import * as Cesium from "cesium";

type Bbox4 = [number, number, number, number];
type CountyEntry = Bbox4 | { bbox?: Bbox4; center?: [number, number] };
interface CityEntry {
  bbox?: Bbox4;
  center?: [number, number];
  counties?: Record<string, CountyEntry>;
}
interface ShandongAdmin {
  province?: string;
  bbox?: Bbox4;
  cities: Record<string, CityEntry>;
}

function readCounty(co: CountyEntry | undefined): { bbox?: Bbox4; center?: [number, number] } {
  if (!co) return {};
  if (Array.isArray(co)) {
    if (co.length !== 4) return {};
    const [w, s, e, n] = co;
    return { bbox: [w, s, e, n], center: [(w + e) / 2, (s + n) / 2] };
  }
  return { bbox: co.bbox, center: co.center };
}

let _shandongAdminCache: ShandongAdmin | null = null;
async function loadShandongAdmin(): Promise<ShandongAdmin | null> {
  if (_shandongAdminCache) return _shandongAdminCache;
  try {
    const r = await fetch("/static/data/shandong_admin.json?_=" + Date.now());
    if (!r.ok) return null;
    _shandongAdminCache = (await r.json()) as ShandongAdmin;
    return _shandongAdminCache;
  } catch {
    return null;
  }
}

export function SettingsPanel() {
  const open = useUIStore((s) => s.settingsPanelOpen);
  const setUI = useUIStore((s) => s.set);
  const homeView = useHomeViewStore((s) => s.view);
  const setHomeView = useHomeViewStore((s) => s.setView);
  const clearHomeView = useHomeViewStore((s) => s.clear);
  const renderQuality = useUIStore((s) => s.renderQuality);

  const displayCrs = useUIStore((s) => s.displayCrs);
  const coordReadoutVisible = useUIStore((s) => s.coordReadoutVisible);
  const gkCentralMeridian = useUIStore((s) => s.gkCentralMeridian);
  const gkZoneWidth = useUIStore((s) => s.gkZoneWidth);
  const dashModules = useUIStore((s) => s.dashModules);
  const setDashModule = useUIStore((s) => s.setDashModule);
  const resetDashModules = useUIStore((s) => s.resetDashModules);

  const [admin, setAdmin] = useState<ShandongAdmin | null>(null);
  const [city, setCity] = useState<string>(homeView?.city || "");
  const [county, setCounty] = useState<string>(homeView?.county || "");

  useEffect(() => {
    if (!open) return;
    loadShandongAdmin().then((d) => setAdmin(d));
  }, [open]);

  const citiesObj = admin?.cities || {};
  const cityNames = Object.keys(citiesObj);
  const cityObj = city ? citiesObj[city] : undefined;
  const countyNames = cityObj?.counties ? Object.keys(cityObj.counties) : [];

  const applyHome = (cityName: string, countyName: string) => {
    if (!admin) return;
    const co = admin.cities[cityName];
    if (!co) return;
    let center: [number, number] | undefined = co.center;
    let bbox: [number, number, number, number] | undefined = co.bbox;
    if (countyName && co.counties) {
      const cn = readCounty(co.counties[countyName]);
      if (cn.center) center = cn.center;
      if (cn.bbox) bbox = cn.bbox;
    }
    if (!center && bbox) {
      center = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
    }
    if (!center) return;
    let h = 75000;
    if (bbox) {
      const dx = (bbox[2] - bbox[0]) * 111000;
      const dy = (bbox[3] - bbox[1]) * 111000;
      h = Math.max(20000, Math.min(300000, Math.max(dx, dy) * 1.4));
    }
    setHomeView({ lng: center[0], lat: center[1], h, city: cityName, county: countyName });
    flyTo(center[0], center[1], h, 1.2);
  };

  const onCityChange = (next: string) => {
    setCity(next);
    setCounty("");
    if (next) applyHome(next, "");
  };
  const onCountyChange = (next: string) => {
    setCounty(next);
    if (city && next) applyHome(city, next);
  };

  const setCurrentAsHome = () => {
    const v = getViewer();
    if (!v) return;
    const pos = v.camera.positionCartographic;
    const lng = Cesium.Math.toDegrees(pos.longitude);
    const lat = Cesium.Math.toDegrees(pos.latitude);
    setHomeView({ lng, lat, h: pos.height, city, county });
    useUIStore.getState().showToast("已设置当前视角为主视角");
  };
  const restoreDefault = () => {
    clearHomeView();
    setCity("");
    setCounty("");
    const cfg = window.__PLATFORM_CONFIG;
    if (cfg?.geo?.center) {
      flyTo(cfg.geo.center.lng, cfg.geo.center.lat, cfg.geo.center.alt ?? 75000, 1.2);
    }
    useUIStore.getState().showToast("已恢复默认主视角");
  };

  const setQuality = (q: RenderQuality) => {
    useUIStore.getState().set({ renderQuality: q, hdMode: q !== "standard" });
    try {
      localStorage.setItem("renderQuality", q);
      localStorage.setItem("hdMode", q === "standard" ? "0" : "1");
    } catch {
      /* ignore */
    }
    const v = getViewer();
    if (v) applyRenderQuality(v, q);
  };

  if (!open) return null;

  return (
    <>
      <div className="modal-mask" onClick={() => setUI({ settingsPanelOpen: false })} />
      <div className={"settings-panel" + (open ? " open" : "")}>
        <div
          className="modal-hdr"
          style={{ position: "sticky", top: 0, background: "rgba(13,17,23,.98)", zIndex: 2 }}
        >
          <h3>偏好设置</h3>
          <button onClick={() => setUI({ settingsPanelOpen: false })}>×</button>
        </div>
        <div className="sp-section">
          <h4>主视角 (Home View)</h4>
          <div className="sp-row">
            <span style={{ flex: "0 0 60px", color: "var(--t2)" }}>地市</span>
            <select
              style={{ flex: 1 }}
              value={city}
              onChange={(e) => onCityChange(e.target.value)}
            >
              <option value="">请选择...</option>
              {cityNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div className="sp-row">
            <span style={{ flex: "0 0 60px", color: "var(--t2)" }}>区县</span>
            <select
              style={{ flex: 1 }}
              value={county}
              disabled={!city}
              onChange={(e) => onCountyChange(e.target.value)}
            >
              <option value="">{city ? "请选择..." : "请先选地市"}</option>
              {countyNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div className="sp-row" style={{ gap: 8 }}>
            <button className="sp-button" onClick={setCurrentAsHome}>
              固化当前视角
            </button>
            <button className="sp-button" onClick={restoreDefault}>
              恢复默认
            </button>
          </div>
          {homeView ? (
            <div style={{ color: "var(--t2)", fontSize: 11, marginTop: 8 }}>
              当前主视角: {homeView.lng.toFixed(4)}, {homeView.lat.toFixed(4)} (h={Math.round(homeView.h)} m)
            </div>
          ) : null}
        </div>

        <div className="sp-section">
          <h4>渲染质量</h4>
          <div className="sp-row" style={{ gap: 6, flexWrap: "wrap" }}>
            {([
              { v: "standard", label: "标清", desc: "DPR=1, 无 MSAA, 性能最佳" },
              { v: "hd", label: "高清", desc: "DPR≤2, FXAA, 平衡画质/性能" },
              { v: "ultra", label: "超清", desc: "DPR×1.5(≤3), MSAA 4×, 加密瓦片(显存↑)" },
            ] as { v: RenderQuality; label: string; desc: string }[]).map((opt) => (
              <button
                key={opt.v}
                className={"sp-button" + (renderQuality === opt.v ? " primary" : "")}
                onClick={() => setQuality(opt.v)}
                title={opt.desc}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div style={{ color: "var(--t2)", fontSize: 11, marginTop: 6 }}>
            当前: <b style={{ color: "var(--accent)" }}>
              {renderQuality === "standard" ? "标清" : renderQuality === "hd" ? "高清" : "超清"}
            </b>
            {" · "}
            {renderQuality === "standard"
              ? "标准画质,适合低性能设备 / 集成显卡"
              : renderQuality === "hd"
              ? "全 DPR 渲染 + FXAA 抗锯齿"
              : "全 DPR×1.5 + MSAA 4× + 加密瓦片,需要独显才能流畅"}
          </div>
        </div>

        <div className="sp-section">
          <h4>坐标系 (CRS) 显示</h4>
          <div className="sp-row">
            <label
              style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer", flex: 1 }}
            >
              <input
                type="checkbox"
                checked={coordReadoutVisible}
                onChange={(e) => {
                  localStorage.setItem("coordReadoutVisible", e.target.checked ? "1" : "0");
                  setUI({ coordReadoutVisible: e.target.checked });
                }}
              />
              <span>底部状态条显示鼠标坐标读数</span>
            </label>
          </div>

          <div className="sp-row">
            <span style={{ flex: "0 0 90px", color: "var(--t2)" }}>主显示 CRS</span>
            <select
              style={{ flex: 1 }}
              value={displayCrs}
              onChange={(e) => {
                const v = e.target.value as CrsId;
                localStorage.setItem("displayCrs", v);
                setUI({ displayCrs: v });
              }}
            >
              {CRS_LIST.map((c) => (
                <option key={c.id} value={c.id} title={c.description}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div className="sp-row">
            <span style={{ flex: "0 0 90px", color: "var(--t2)" }}>GK 带宽</span>
            <select
              style={{ flex: 1 }}
              value={gkZoneWidth}
              onChange={(e) => {
                const v = (e.target.value === "6" ? 6 : 3) as 3 | 6;
                localStorage.setItem("gkZoneWidth", String(v));
                setUI({ gkZoneWidth: v });
              }}
            >
              <option value="3">3°带 (测绘行业主流)</option>
              <option value="6">6°带 (老规范)</option>
            </select>
          </div>

          <div className="sp-row">
            <span style={{ flex: "0 0 90px", color: "var(--t2)" }}>中央子午线</span>
            <select
              style={{ flex: 1 }}
              value={gkCentralMeridian === "auto" ? "auto" : String(gkCentralMeridian)}
              onChange={(e) => {
                const raw = e.target.value;
                const v: number | "auto" = raw === "auto" ? "auto" : Number(raw);
                localStorage.setItem("gkCentralMeridian", String(v));
                setUI({ gkCentralMeridian: v });
              }}
            >
              <option value="auto">自动 (按经度选带)</option>
              {gkZoneWidth === 3
                ? [108, 111, 114, 117, 120, 123].map((m) => (
                    <option key={m} value={m}>{m}°</option>
                  ))
                : [105, 111, 117, 123].map((m) => (
                    <option key={m} value={m}>{m}°</option>
                  ))}
            </select>
          </div>

          <div style={{ color: "var(--t2)", fontSize: 11, marginTop: 6, lineHeight: 1.5 }}>
            ▸ 鼠标坐标读数在屏幕<b>底部</b>;按读数旁的 <b>"详细"</b> 打开浮动面板看所有 CRS。
            <br />
            ▸ <b>CGCS2000 ≈ WGS84</b>(差异 &lt; 1 m),工程上互转用 identity 近似即可;
            如需 cm 级精度请在后端 <code>config.yaml</code> 注入 7 参 Helmert 变换。
          </div>
        </div>

        <div className="sp-section">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h4 style={{ margin: 0 }}>统计面板</h4>
            <button
              className="sp-button"
              onClick={resetDashModules}
              title="把所有模块的位置和图表类型恢复到默认"
            >
              恢复默认
            </button>
          </div>
          <div style={{ color: "var(--t2)", fontSize: 11, margin: "6px 0 8px", lineHeight: 1.5 }}>
            每个模块可独立选择停靠位置与图表样式。设为「隐藏」即不在面板里出现。
          </div>
          <div className="dash-cfg-table">
            <div className="dash-cfg-row dash-cfg-head">
              <div>模块</div>
              <div>位置</div>
              <div>图表类型</div>
            </div>
            {DASH_MODULES.map((m) => {
              const cfg = dashModules[m.id] || { dock: m.defaultDock, type: m.defaultType };
              return (
                <div className="dash-cfg-row" key={m.id}>
                  <div className="dash-cfg-name">{m.title}</div>
                  <div className="dash-cfg-segs">
                    {(["left", "right", "hidden"] as DashDock[]).map((d) => (
                      <button
                        key={d}
                        className={"sp-seg" + (cfg.dock === d ? " active" : "")}
                        onClick={() => setDashModule(m.id, { dock: d })}
                      >
                        {DOCK_LABEL[d]}
                      </button>
                    ))}
                  </div>
                  <div>
                    {m.supportsType ? (
                      <select
                        value={cfg.type || m.defaultType || "pie"}
                        onChange={(e) =>
                          setDashModule(m.id, { type: e.target.value as DashChartType })
                        }
                        style={{ width: "100%" }}
                      >
                        {(["pie", "bar", "vbar"] as DashChartType[]).map((t) => (
                          <option key={t} value={t}>
                            {CHART_TYPE_LABEL[t]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span style={{ color: "var(--t2)", fontSize: 11 }}>—</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
