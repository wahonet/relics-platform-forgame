import { useEffect, useState } from "react";
import {
  ensureIconsLoaded,
  categorySilhouetteUrl,
  RANK_COLOR,
} from "../map/relicIcons";
import { useUIStore } from "../stores/uiStore";
import { HEALTH_COLOR, HEALTH_LABEL, type HealthLevel } from "../utils/health";

const RANK_ITEMS: { code: string; label: string }[] = [
  { code: "1", label: "国保" },
  { code: "2", label: "省保" },
  { code: "3", label: "市保" },
  { code: "4", label: "县保" },
  { code: "5", label: "未定级" },
];

const CATEGORY_ITEMS: { code: string; label: string }[] = [
  { code: "0100", label: "古遗址" },
  { code: "0200", label: "古墓葬" },
  { code: "0300", label: "古建筑" },
  { code: "0400", label: "石窟寺及石刻" },
  { code: "0500", label: "近现代史迹" },
];

const HEALTH_ITEMS: HealthLevel[] = ["good", "watch", "risk"];

/** 地图左下角图例:保护级别配色 + 类别图标形状;健康度模式下切换为健康分级。 */
export function MapLegend() {
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [collapsed, setCollapsed] = useState(false);
  const healthMode = useUIStore((s) => s.healthMode);

  useEffect(() => {
    let cancelled = false;
    ensureIconsLoaded()
      .then(() => {
        if (cancelled) return;
        const m: Record<string, string> = {};
        for (const c of CATEGORY_ITEMS) {
          const url = categorySilhouetteUrl(c.code, 28);
          if (url) m[c.code] = url;
        }
        setIcons(m);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className={"map-legend" + (collapsed ? " collapsed" : "")}>
      <div className="map-legend-hdr" onClick={() => setCollapsed(!collapsed)}>
        <span>图例</span>
        <i>{collapsed ? "+" : "−"}</i>
      </div>
      {!collapsed && healthMode && (
        <div className="map-legend-body">
          <div className="map-legend-sec">
            <div className="map-legend-title">健康度(综合评分)</div>
            {HEALTH_ITEMS.map((level) => (
              <div key={level} className="map-legend-row">
                <i className="map-legend-dot" style={{ background: HEALTH_COLOR[level] }} />
                <span>{HEALTH_LABEL[level]}</span>
              </div>
            ))}
            <div className="map-legend-note">保存状况 × 巡查时效 × 天气风险</div>
          </div>
        </div>
      )}
      {!collapsed && !healthMode && (
        <div className="map-legend-body">
          <div className="map-legend-sec">
            <div className="map-legend-title">保护级别(颜色)</div>
            {RANK_ITEMS.map((r) => (
              <div key={r.code} className="map-legend-row">
                <i
                  className="map-legend-dot"
                  style={{ background: RANK_COLOR[r.code] }}
                />
                <span>{r.label}</span>
              </div>
            ))}
          </div>
          <div className="map-legend-sec">
            <div className="map-legend-title">文物类别(图形)</div>
            {CATEGORY_ITEMS.map((c) => (
              <div key={c.code} className="map-legend-row">
                {icons[c.code] ? (
                  <i className="map-legend-icon">
                    <img src={icons[c.code]} alt={c.label} />
                  </i>
                ) : (
                  <i className="map-legend-icon" />
                )}
                <span>{c.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
