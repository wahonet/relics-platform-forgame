import { useEffect, useState } from "react";
import { useUIStore } from "../stores/uiStore";
import {
  clearBoundaries,
  downloadBoundaries,
  exportBoundaryUrl,
  fetchAdminTree,
  listBoundaries,
  type AdminTreeItem,
  type BoundaryFileInfo,
  type TownshipSource,
} from "../api/boundaries";
import { CRS_LIST, type CrsId } from "../utils/crs";

const SHANDONG_ADCODE = 370000;

function fmtBytes(n: number | undefined): string {
  if (!n) return "0";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function BoundaryDownloadPanel() {
  const open = useUIStore((s) => s.boundaryDownloadOpen);
  const setUI = useUIStore((s) => s.set);
  const showToast = useUIStore((s) => s.showToast);
  const bumpBoundary = useUIStore((s) => s.bumpBoundary);

  const [provinces, setProvinces] = useState<AdminTreeItem[]>([]);
  const [provinceAdcode, setProvinceAdcode] = useState<number>(SHANDONG_ADCODE);
  const [cities, setCities] = useState<AdminTreeItem[]>([]);
  const [cityAdcode, setCityAdcode] = useState<number | "">("");
  const [counties, setCounties] = useState<AdminTreeItem[]>([]);
  const [countyAdcode, setCountyAdcode] = useState<number | "">("");

  // 唯一保留的复选框:是否同时下载当前县下属乡镇 (默认勾选)。
  // 县/市边界由级联选择自动决定,无需用户再勾。
  const [includeTownships, setIncludeTownships] = useState(true);
  // 镇街数据源。auto: 优先 OSM,失败回退 DataV。绝大多数县 DataV 没数据,
  // 所以默认走 auto/osm 才能拿到内容。
  const [townshipSource, setTownshipSource] = useState<TownshipSource>("auto");

  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [files, setFiles] = useState<BoundaryFileInfo[]>([]);
  const [logLines, setLogLines] = useState<string[]>([]);

  // 导出 (按目标 CRS 触发浏览器下载)
  const gkCm = useUIStore((s) => s.gkCentralMeridian);
  const gkZw = useUIStore((s) => s.gkZoneWidth);
  const [exportCrs, setExportCrs] = useState<CrsId>("cgcs2000_gk_3");

  const onExport = (file: "county" | "townships" | "villages") => {
    const url = exportBoundaryUrl(file, exportCrs, {
      centralMeridian: gkCm === "auto" ? undefined : gkCm,
      zoneWidth: gkZw,
      zonePrefix: true,
    });
    // 直接走浏览器下载,a.click() + 默认 cookie/auth
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast(`正在导出 ${file}.${exportCrs}.geojson`);
  };

  const refreshFiles = async () => {
    try {
      const r = await listBoundaries();
      setFiles(r.files || []);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    if (!open) return;
    setLogLines([]);
    refreshFiles();
    // 初始化省级 (国家级 100000 → 省)。这一层用得少,可以一次性载入。
    setLoading(true);
    fetchAdminTree(100000)
      .then((r) => {
        setProvinces(r.items.filter((it) => it.level === "province"));
      })
      .catch(() => setProvinces([]))
      .finally(() => setLoading(false));
  }, [open]);

  // 省 → 市 联动
  useEffect(() => {
    if (!open || !provinceAdcode) return;
    setLoading(true);
    setCities([]);
    setCityAdcode("");
    setCounties([]);
    setCountyAdcode("");
    fetchAdminTree(provinceAdcode)
      .then((r) => setCities(r.items))
      .catch(() => setCities([]))
      .finally(() => setLoading(false));
  }, [open, provinceAdcode]);

  // 市 → 县 联动
  useEffect(() => {
    if (!open || !cityAdcode) return;
    setLoading(true);
    setCounties([]);
    setCountyAdcode("");
    fetchAdminTree(Number(cityAdcode))
      .then((r) => setCounties(r.items))
      .catch(() => setCounties([]))
      .finally(() => setLoading(false));
  }, [open, cityAdcode]);

  const log = (line: string) =>
    setLogLines((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${line}`]);

  // 根据级联深度自动决定下载内容:
  //   - 选到县级 → 下载该县轮廓 (county.geojson),并按勾选下载该县下属乡镇
  //   - 仅选到市级 → 下载该市下属所有区县 (county.geojson)
  //   - 都没选 → 不允许提交
  const downloadHint = (() => {
    if (countyAdcode) {
      const co = counties.find((c) => c.adcode === Number(countyAdcode));
      return `县界 = ${co?.name || "当前县"}` + (includeTownships ? "（同时下载该县下属乡镇）" : "");
    }
    if (cityAdcode) {
      const ci = cities.find((c) => c.adcode === Number(cityAdcode));
      return `县界 = ${ci?.name || "当前市"} 下属所有区县`;
    }
    return "请先在上方选择地市或区县";
  })();

  const canSubmit = !!cityAdcode || !!countyAdcode;
  const includeTownshipsEffective = !!countyAdcode && includeTownships;

  const onDownload = async () => {
    if (!canSubmit) {
      showToast("请先选择地市或区县");
      return;
    }
    setSubmitting(true);
    log("开始下载…");
    try {
      const r = await downloadBoundaries({
        city_adcode: cityAdcode ? Number(cityAdcode) : null,
        county_adcode: countyAdcode ? Number(countyAdcode) : null,
        // 选到县就下载县轮廓,否则下载市下属所有县区
        include_city_counties: !countyAdcode && !!cityAdcode,
        include_county_outline: !!countyAdcode,
        include_townships: includeTownshipsEffective,
        township_source: townshipSource,
      });
      r.files.forEach((f) =>
        log(`✓ ${f.name}: ${f.feature_count} 个要素${f.source ? ` (来源: ${f.source})` : ""}`),
      );
      r.warnings.forEach((w) => log(`⚠ ${w}`));
      if (r.ok) {
        showToast("边界已下载,正在刷新地图…");
        bumpBoundary();
      } else {
        showToast("下载失败,详情见面板日志");
      }
      await refreshFiles();
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg = (e as any)?.response?.data?.detail || String(e);
      log(`✗ ${msg}`);
      showToast("下载失败: " + msg);
    } finally {
      setSubmitting(false);
    }
  };

  const onClear = async () => {
    if (!confirm("确定删除已下载的县界与镇界 GeoJSON?\n(村界文件 villages.geojson 会保留)")) return;
    try {
      const r = await clearBoundaries(["county", "townships"]);
      log(`已删除: ${r.removed.join(", ") || "(无文件可删)"}`);
      bumpBoundary();
      showToast("已清除并刷新地图");
      await refreshFiles();
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg = (e as any)?.response?.data?.detail || String(e);
      showToast("清除失败: " + msg);
    }
  };

  if (!open) return null;

  return (
    <>
      <div className="modal-mask" onClick={() => setUI({ boundaryDownloadOpen: false })} />
      <div className="tile-panel">
        <div className="tile-hdr">
          <h3>下载行政边界</h3>
          <button
            className="modal-hdr-x"
            onClick={() => setUI({ boundaryDownloadOpen: false })}
          >
            ×
          </button>
        </div>
        <div className="tile-body">
          <div style={{ color: "var(--t2)", fontSize: 11, padding: "4px 0 8px", lineHeight: 1.5 }}>
            <div>
              <b>县/市界</b>:阿里云 DataV.GeoAtlas（基于高德 2021.5），坐标统一转 WGS-84。
            </div>
            <div>
              <b>镇/街道</b>:DataV 不公开下钻数据（绝大多数县返回 404），改用 OpenStreetMap
              (Overpass API) 作为镇街数据源；OSM 数据本身就是 WGS-84。
            </div>
            <div>
              <b>村界（五级）</b>:DataV / OSM 都未开放，请走 step06 离线 SHP 流程导入。
            </div>
          </div>

          <div className="tile-row">
            <label>省份</label>
            <select
              value={provinceAdcode}
              onChange={(e) => setProvinceAdcode(Number(e.target.value))}
              disabled={loading || submitting}
            >
              {provinces.length === 0 ? (
                <option value={SHANDONG_ADCODE}>山东省 (默认)</option>
              ) : (
                provinces.map((p) => (
                  <option key={p.adcode} value={p.adcode}>
                    {p.name}
                  </option>
                ))
              )}
            </select>
          </div>

          <div className="tile-row">
            <label>地市</label>
            <select
              value={cityAdcode}
              onChange={(e) => setCityAdcode(e.target.value ? Number(e.target.value) : "")}
              disabled={loading || submitting || cities.length === 0}
            >
              <option value="">{cities.length ? "请选择..." : "加载中..."}</option>
              {cities.map((c) => (
                <option key={c.adcode} value={c.adcode}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div className="tile-row">
            <label>区县</label>
            <select
              value={countyAdcode}
              onChange={(e) => setCountyAdcode(e.target.value ? Number(e.target.value) : "")}
              disabled={loading || submitting || counties.length === 0}
            >
              <option value="">{counties.length ? "请选择..." : cityAdcode ? "加载中..." : "请先选地市"}</option>
              {counties.map((c) => (
                <option key={c.adcode} value={c.adcode}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div
            style={{
              borderTop: "1px solid var(--bd)",
              margin: "10px 0",
              paddingTop: 8,
            }}
          >
            <label
              className="tile-row"
              style={{
                cursor: countyAdcode ? "pointer" : "not-allowed",
                opacity: countyAdcode ? 1 : 0.5,
              }}
              title={countyAdcode ? "" : "需先选区县"}
            >
              <input
                type="checkbox"
                checked={includeTownships}
                disabled={!countyAdcode}
                onChange={(e) => setIncludeTownships(e.target.checked)}
              />
              <span style={{ marginLeft: 6 }}>
                同时下载当前县下属乡镇{" "}
                <span style={{ color: "var(--yellow, #ffd700)", fontSize: 11 }}>
                  (OSM 覆盖率不一,缺失需走 step06 SHP 补齐)
                </span>
              </span>
            </label>

            {includeTownshipsEffective && (
              <div className="tile-row" style={{ marginTop: 6, paddingLeft: 24 }}>
                <label style={{ minWidth: 60, fontSize: 12 }}>数据源</label>
                <select
                  value={townshipSource}
                  onChange={(e) => setTownshipSource(e.target.value as TownshipSource)}
                  disabled={submitting}
                  style={{ flex: 1 }}
                >
                  <option value="auto">自动 (OSM 优先,失败回退 DataV)</option>
                  <option value="osm">仅 OSM Overpass (推荐,覆盖较全)</option>
                  <option value="datav">仅 DataV (基本会 404,仅作回归)</option>
                </select>
              </div>
            )}
            <div
              style={{
                color: "var(--accent)",
                fontSize: 12,
                padding: "6px 0 0 24px",
                lineHeight: 1.5,
              }}
            >
              ▸ {downloadHint}
            </div>
          </div>

          <div className="tile-row" style={{ marginTop: 8, gap: 8 }}>
            <button
              className="sp-button primary"
              onClick={onDownload}
              disabled={submitting || loading || !canSubmit}
            >
              {submitting ? "下载中..." : "开始下载"}
            </button>
            <button className="sp-button" onClick={onClear} disabled={submitting}>
              清除已下载
            </button>
            <button className="sp-button" onClick={refreshFiles} disabled={submitting}>
              刷新状态
            </button>
          </div>
        </div>

        <div className="tile-history">
          <h4>当前边界文件</h4>
          {files.map((f) => {
            const stem = f.name.replace(/\.geojson$/, "") as
              | "county" | "townships" | "villages";
            const exportable = !f.missing && f.feature_count > 0;
            return (
              <div
                key={f.name}
                className="tile-hist-item"
                style={{ display: "flex", alignItems: "center", gap: 8 }}
              >
                <span style={{ flex: 1 }}>
                  {f.name} ·{" "}
                  {f.missing
                    ? "未生成"
                    : `${f.feature_count} 要素 · ${fmtBytes(f.size)} · ${
                        f.mtime ? new Date(f.mtime * 1000).toLocaleString() : ""
                      }`}
                </span>
                {exportable && (
                  <button
                    className="sp-button"
                    style={{ height: 22, padding: "0 8px", fontSize: 11 }}
                    title={`将 ${stem}.geojson 转为 ${exportCrs} 下载`}
                    onClick={() => onExport(stem)}
                  >
                    导出 {exportCrs}
                  </button>
                )}
              </div>
            );
          })}

          <div
            style={{
              marginTop: 8,
              padding: "6px 8px",
              background: "rgba(88,166,255,.06)",
              borderRadius: 4,
              fontSize: 11,
              color: "var(--t2)",
              lineHeight: 1.6,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span>导出 CRS:</span>
              <select
                value={exportCrs}
                onChange={(e) => setExportCrs(e.target.value as CrsId)}
                style={{ flex: 1, height: 22, fontSize: 11 }}
              >
                {CRS_LIST.map((c) => (
                  <option key={c.id} value={c.id} title={c.description}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            盘上文件始终是 WGS84(给 Cesium 渲染用),导出按钮按当前选择的 CRS 现转一份给你。
            <br />
            GK 投影: {gkCm === "auto" ? "自动选带" : `中央子午线 ${gkCm}°`} · {gkZw}°带
            (在设置里改)
          </div>

          {logLines.length > 0 ? (
            <>
              <h4 style={{ marginTop: 10 }}>下载日志</h4>
              <div
                style={{
                  background: "rgba(0,0,0,.25)",
                  borderRadius: 4,
                  padding: 6,
                  fontSize: 11,
                  fontFamily: "monospace",
                  maxHeight: 140,
                  overflowY: "auto",
                  color: "var(--t2)",
                  whiteSpace: "pre-wrap",
                }}
              >
                {logLines.join("\n")}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}
