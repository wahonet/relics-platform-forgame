import { useMemo } from "react";
import { useMouseCoordStore } from "../stores/mouseCoordStore";
import { useUIStore } from "../stores/uiStore";
import {
  CRS_LIST,
  CRS_MAP,
  formatCoord,
  gkCentralMeridian,
  gkZoneForLng,
  transformPoint,
  type CrsId,
} from "../utils/crs";

/** 屏幕底部状态条:鼠标坐标实时读数 + 主显示 CRS 切换。
 *  输入永远是 WGS84 经纬度 (来自 Cesium); 只在显示层做 CRS 转换。 */
export function CoordReadout() {
  const lng = useMouseCoordStore((s) => s.lng);
  const lat = useMouseCoordStore((s) => s.lat);
  const height = useMouseCoordStore((s) => s.height);

  const visible = useUIStore((s) => s.coordReadoutVisible);
  const displayCrs = useUIStore((s) => s.displayCrs);
  const setUI = useUIStore((s) => s.set);
  const cm = useUIStore((s) => s.gkCentralMeridian);
  const zw = useUIStore((s) => s.gkZoneWidth);
  const inspectorOpen = useUIStore((s) => s.crsInspectorOpen);

  const text = useMemo(() => {
    if (lng == null || lat == null) return "—";
    try {
      const cmEffective = cm === "auto"
        ? gkCentralMeridian(gkZoneForLng(lng, zw), zw)
        : cm;
      const [a, b] = transformPoint(
        "wgs84",
        displayCrs,
        lng,
        lat,
        { centralMeridian: cmEffective, zoneWidth: zw, zonePrefix: true },
      );
      return formatCoord(displayCrs, a, b);
    } catch (e) {
      return String(e);
    }
  }, [lng, lat, displayCrs, cm, zw]);

  if (!visible) return null;

  return (
    <div className="coord-readout" role="status" aria-live="polite">
      <select
        className="coord-readout-crs"
        value={displayCrs}
        title="切换显示坐标系"
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
      <span className="coord-readout-axes">
        {CRS_MAP[displayCrs].axes.join(", ")}
      </span>
      <span className="coord-readout-value">{text}</span>
      {height != null && lng != null && (
        <span className="coord-readout-h" title="椭球高 (米)">
          h={height.toFixed(1)}m
        </span>
      )}
      <button
        className="coord-readout-btn"
        title="打开坐标检视面板 (查看所有 CRS / 复制 / 手动输入)"
        onClick={() => setUI({ crsInspectorOpen: !inspectorOpen })}
      >
        {inspectorOpen ? "▼ 详细" : "▶ 详细"}
      </button>
      <button
        className="coord-readout-btn"
        title="隐藏坐标读数 (在设置面板里再打开)"
        onClick={() => {
          localStorage.setItem("coordReadoutVisible", "0");
          setUI({ coordReadoutVisible: false });
        }}
      >
        ×
      </button>
    </div>
  );
}
