import { useEffect, useMemo, useState } from "react";
import { useUIStore } from "../stores/uiStore";
import { useMouseCoordStore } from "../stores/mouseCoordStore";
import {
  CRS_LIST,
  CRS_MAP,
  formatCoord,
  gkCentralMeridian,
  gkZoneForLng,
  toDms,
  transformPoint,
  type CrsId,
} from "../utils/crs";

/** 浮动 CRS 检视面板:
 *  顶部输入框选 CRS + 填两个数 → 在所有 CRS 下显示结果, 一键复制。
 *  默认绑定到鼠标位置 (跟随), 也可以"冻结"成手动模式。 */
export function CrsInspectorPanel() {
  const open = useUIStore((s) => s.crsInspectorOpen);
  const setUI = useUIStore((s) => s.set);
  const cm = useUIStore((s) => s.gkCentralMeridian);
  const zw = useUIStore((s) => s.gkZoneWidth);
  const showToast = useUIStore((s) => s.showToast);

  const mouseLng = useMouseCoordStore((s) => s.lng);
  const mouseLat = useMouseCoordStore((s) => s.lat);

  const [followMouse, setFollowMouse] = useState(true);
  const [srcCrs, setSrcCrs] = useState<CrsId>("wgs84");
  const [aStr, setAStr] = useState("");
  const [bStr, setBStr] = useState("");

  // 跟随鼠标:每次鼠标更新时同步刷新输入框 (保持源 CRS 不变, 内部转换一次).
  useEffect(() => {
    if (!followMouse || mouseLng == null || mouseLat == null) return;
    try {
      const cmEffective = cm === "auto"
        ? gkCentralMeridian(gkZoneForLng(mouseLng, zw), zw)
        : cm;
      const [a, b] = transformPoint("wgs84", srcCrs, mouseLng, mouseLat, {
        centralMeridian: cmEffective,
        zoneWidth: zw,
        zonePrefix: true,
      });
      const meta = CRS_MAP[srcCrs];
      const fix = meta.unit === "degree" ? 7 : 4;
      setAStr(a.toFixed(fix));
      setBStr(b.toFixed(fix));
    } catch {
      /* ignore */
    }
  }, [followMouse, mouseLng, mouseLat, srcCrs, cm, zw]);

  const a = Number(aStr);
  const b = Number(bStr);
  const valid = Number.isFinite(a) && Number.isFinite(b);

  // 计算源点到所有 CRS 的转换结果。auto 时让 transformPoint 根据 wgs84 经度自动选带。
  const rows = useMemo(() => {
    if (!valid) return [];
    return CRS_LIST.map((meta) => {
      try {
        const [x, y] = transformPoint(srcCrs, meta.id, a, b, {
          centralMeridian: cm === "auto" ? undefined : cm,
          zoneWidth: zw,
          zonePrefix: true,
        });
        return { id: meta.id, name: meta.name, value: formatCoord(meta.id, x, y), raw: `${x}, ${y}` };
      } catch (e) {
        return { id: meta.id, name: meta.name, value: `! ${e}`, raw: "" };
      }
    });
  }, [valid, a, b, srcCrs, cm, zw]);

  // WGS84 经纬度的 DMS 表示 (额外便利).
  const dms = useMemo(() => {
    if (!valid) return null;
    try {
      const [lng, lat] = transformPoint(srcCrs, "wgs84", a, b, {
        centralMeridian: cm === "auto" ? undefined : cm,
        zoneWidth: zw,
        zonePrefix: true,
      });
      return toDms(lng, lat);
    } catch {
      return null;
    }
  }, [valid, a, b, srcCrs, cm, zw]);

  const copy = (txt: string) => {
    if (!txt) return;
    navigator.clipboard.writeText(txt).then(
      () => showToast("已复制"),
      () => showToast("复制失败,请手选"),
    );
  };

  if (!open) return null;
  const meta = CRS_MAP[srcCrs];

  return (
    <div className="crs-inspector">
      <div className="crs-inspector-hdr">
        <span>坐标检视器</span>
        <button onClick={() => setUI({ crsInspectorOpen: false })}>×</button>
      </div>
      <div className="crs-inspector-body">
        <div className="crs-inspector-tip">
          {followMouse ? "🖱️ 跟随鼠标:在地图上移动光标实时刷新" : "✋ 手动模式:输入下方坐标查询"}
          <label style={{ float: "right", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={followMouse}
              onChange={(e) => setFollowMouse(e.target.checked)}
            />
            跟随鼠标
          </label>
        </div>

        <div className="crs-input-row">
          <select
            value={srcCrs}
            onChange={(e) => setSrcCrs(e.target.value as CrsId)}
            title="输入坐标系"
          >
            {CRS_LIST.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <input
            placeholder={meta.axes[0]}
            value={aStr}
            onChange={(e) => { setFollowMouse(false); setAStr(e.target.value); }}
          />
          <input
            placeholder={meta.axes[1]}
            value={bStr}
            onChange={(e) => { setFollowMouse(false); setBStr(e.target.value); }}
          />
        </div>

        {valid ? (
          <>
            {rows.map((r) => (
              <div key={r.id} className="crs-output-row">
                <span className="crs-name">{r.name}</span>
                <span className="crs-val">{r.value}</span>
                <button title="复制原始数值" onClick={() => copy(r.raw)}>
                  复制
                </button>
              </div>
            ))}
            {dms && (
              <div className="crs-output-row">
                <span className="crs-name">WGS84 (DMS)</span>
                <span className="crs-val">{dms.lat} {dms.lng}</span>
                <button onClick={() => copy(`${dms.lat} ${dms.lng}`)}>复制</button>
              </div>
            )}
          </>
        ) : (
          <div className="crs-inspector-tip" style={{ color: "#ff8899" }}>
            请输入合法的两个数值
          </div>
        )}

        <div className="crs-inspector-tip">
          <b>GK 配置</b>: {cm === "auto" ? "自动选带" : `中央子午线 ${cm}°`} ·
          {" "}{zw}°带 (在设置面板里改)
        </div>
      </div>
    </div>
  );
}
