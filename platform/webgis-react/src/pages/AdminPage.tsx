import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearAllData,
  fetchPipelineStatus,
  fetchTask,
  fetchApiConfig,
  fetchAiModels,
  fetchExtractProgress,
  runPipeline,
  saveApiConfig,
  stopPipeline,
  type AdminTask,
  type ApiConfigStatus,
  type AiModelsResp,
  type ExtractProgress,
  type PipelineStatus,
} from "../api/admin";
import {
  clearCache,
  estimateArea,
  fetchCacheInfo,
  fetchHistory,
  fetchProgress,
  openCacheFolder,
  startDownload,
  type TileCacheInfo,
  type TileDownloadProgress,
  type TileHistoryItem,
} from "../api/tiles";
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
import { useUIStore } from "../stores/uiStore";
import { confirmDialog } from "../components/ConfirmModal";

const STEP_TITLE: Record<string, string> = {
  "00": "档案提取",
  "01": "数据导入",
  "02": "边界处理",
  "03": "数据库构建",
};

const STEP_DESC: Record<string, string> = {
  "00": "登记表 docx → Markdown 档案",
  "01": "Markdown 档案 / Excel 台账 → 数据集",
  "02": "行政边界 → WGS-84 GeoJSON",
  "03": "数据集 → relics.db",
};

const PROVIDER_LABEL: Record<string, string> = {
  arcgis_sat: "ArcGIS 影像",
  osm: "OSM 矢量",
  gaode_sat: "高德影像",
  gaode_anno: "高德标注",
  gaode_vec: "高德矢量",
  tianditu_img: "天地图影像",
  tianditu_cia: "天地图影像注记",
  tianditu_vec: "天地图矢量",
  tianditu_cva: "天地图矢量注记",
};

function hostOf(url: string | undefined): string {
  if (!url) return "api.siliconflow.cn";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function fmtBytes(n: number | undefined): string {
  if (!n) return "0";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

type Bbox4 = [number, number, number, number];
type CountyEntry = Bbox4 | { bbox?: Bbox4; center?: [number, number] };
interface ShandongAdmin {
  cities: Record<string, { bbox?: Bbox4; counties?: Record<string, CountyEntry> }>;
}

function normalizeCountyBbox(co: CountyEntry | undefined): Bbox4 | undefined {
  if (!co) return undefined;
  if (Array.isArray(co)) return co.length === 4 ? (co as Bbox4) : undefined;
  return co.bbox;
}

/** ── 离线地图下载 ─────────────────────────────────────────── */
function TileDownloadSection({ flash }: { flash: (t: string) => void }) {
  const [scope, setScope] = useState<"config" | "county" | "manual">("config");
  const [admin, setAdmin] = useState<ShandongAdmin | null>(null);
  const [city, setCity] = useState("");
  const [county, setCounty] = useState("");
  const [manual, setManual] = useState({ west: "", south: "", east: "", north: "" });
  const [providers, setProviders] = useState("arcgis_sat");
  const [zooms, setZooms] = useState("12,13,14,15");
  const [estimate, setEstimate] = useState<{ total: number; cached: number; need: number } | null>(null);
  const [progress, setProgress] = useState<TileDownloadProgress | null>(null);
  const [history, setHistory] = useState<TileHistoryItem[]>([]);

  useEffect(() => {
    fetch("/static/data/shandong_admin.json")
      .then((r) => (r.ok ? r.json() : null))
      .then(setAdmin)
      .catch(() => setAdmin(null));
    fetchHistory(10).then((d) => setHistory(d.items || [])).catch(() => undefined);
  }, []);

  const cfgBounds = window.__PLATFORM_CONFIG?.geo?.bounds;
  const cityObj = city ? admin?.cities?.[city] : undefined;

  const bbox: Bbox4 | null = (() => {
    if (scope === "config") {
      return cfgBounds ? [cfgBounds.west, cfgBounds.south, cfgBounds.east, cfgBounds.north] : null;
    }
    if (scope === "county") {
      if (county && cityObj?.counties) {
        const cb = normalizeCountyBbox(cityObj.counties[county]);
        if (cb) return cb;
      }
      return cityObj?.bbox || null;
    }
    const nums = [manual.west, manual.south, manual.east, manual.north].map(Number);
    if (nums.every((n) => Number.isFinite(n)) && nums[0] < nums[2] && nums[1] < nums[3]) {
      return nums as unknown as Bbox4;
    }
    return null;
  })();

  const requestZooms = Array.from(
    new Set(
      zooms.split(/[^0-9]+/).map((s) => parseInt(s, 10)).filter((z) => z >= 1 && z <= 17),
    ),
  ).sort((a, b) => a - b).join(",");

  const label =
    scope === "config"
      ? "全市范围"
      : scope === "county"
        ? `${city}${county ? "·" + county : ""}`
        : bbox ? `bbox (${bbox.map((x) => x.toFixed(3)).join(", ")})` : "";

  useEffect(() => {
    if (!bbox || !requestZooms) {
      setEstimate(null);
      return;
    }
    estimateArea(bbox[0], bbox[1], bbox[2], bbox[3], providers, requestZooms)
      .then((d) =>
        setEstimate("error" in d && d.error ? null : { total: d.total, cached: d.cached, need: d.need }),
      )
      .catch(() => setEstimate(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(bbox), providers, requestZooms]);

  const running = progress?.status === "running";

  const start = async () => {
    if (!bbox) {
      flash("请先确定下载范围");
      return;
    }
    if (!requestZooms) {
      flash("请输入 1-17 之间的瓦片层级");
      return;
    }
    try {
      const job = await startDownload(bbox[0], bbox[1], bbox[2], bbox[3], providers, requestZooms, label);
      setProgress({
        id: job.job_id, status: "running", total: job.total, skipped: job.skipped,
        need: job.need, downloaded: 0, failed: 0, bytes: 0,
      } as TileDownloadProgress);
      const poll = async () => {
        try {
          const p = await fetchProgress(job.job_id);
          setProgress(p);
          if (p.status === "running") {
            setTimeout(poll, 1500);
          } else {
            useUIStore.getState().bumpOfflineCoverage();
            const h = await fetchHistory(10);
            setHistory(h.items || []);
            flash(`地图下载完成: ${p.downloaded} 张, 失败 ${p.failed}`);
          }
        } catch {
          /* ignore */
        }
      };
      setTimeout(poll, 800);
    } catch (e) {
      flash("下载启动失败: " + String(e));
    }
  };

  const pct =
    progress && progress.need > 0
      ? Math.min(100, Math.round(((progress.downloaded + progress.failed) / progress.need) * 100))
      : 0;

  return (
    <div className="adm-sec">
      <div className="adm-sec-hdr">
        <h2>离线地图下载</h2>
        <span className="adm-hint">
          下载后选择「离线瓦片影像 / 离线 OSM 瓦片」；「离线专题矢量」已随程序内置
        </span>
      </div>

      <div className="adm-form-grid">
        <div className="tile-row">
          <label>范围</label>
          <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
            <option value="config">全市范围 (config.yaml bounds)</option>
            <option value="county">按县域选择</option>
            <option value="manual">手动输入经纬度</option>
          </select>
        </div>
        {scope === "county" ? (
          <>
            <div className="tile-row">
              <label>地市</label>
              <select value={city} onChange={(e) => { setCity(e.target.value); setCounty(""); }}>
                <option value="">请选择...</option>
                {Object.keys(admin?.cities || {}).map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </div>
            <div className="tile-row">
              <label>区县</label>
              <select value={county} disabled={!city} onChange={(e) => setCounty(e.target.value)}>
                <option value="">{city ? "整个地市" : "请先选地市"}</option>
                {Object.keys(cityObj?.counties || {}).map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </div>
          </>
        ) : null}
        {scope === "manual" ? (
          <div className="tile-row">
            <label>bbox</label>
            {(["west", "south", "east", "north"] as const).map((k) => (
              <input
                key={k}
                type="text"
                placeholder={k}
                value={manual[k]}
                onChange={(e) => setManual({ ...manual, [k]: e.target.value })}
                style={{ width: 0 }}
              />
            ))}
          </div>
        ) : null}
        <div className="tile-row">
          <label>影像源</label>
          <select value={providers} onChange={(e) => setProviders(e.target.value)}>
            <option value="arcgis_sat">ArcGIS 影像</option>
            <option value="osm">OSM 矢量</option>
            <option value="arcgis_sat,osm">影像 + 矢量</option>
            <option value="gaode_sat,gaode_anno">高德影像 + 标注</option>
            <option value="tianditu_img,tianditu_cia">天地图影像 + 注记 (需 Key)</option>
            <option value="tianditu_vec,tianditu_cva">天地图矢量 + 注记 (需 Key)</option>
          </select>
        </div>
        <div className="tile-row">
          <label>层级</label>
          <input
            type="text"
            value={zooms}
            onChange={(e) => setZooms(e.target.value)}
            placeholder="12,13,14,15"
          />
        </div>
      </div>

      {estimate ? (
        <div className="adm-hint" style={{ padding: "8px 0" }}>
          预估: 总 <b className="c-accent-text">{estimate.total}</b> 张 · 已缓存{" "}
          <b className="c-green-text">{estimate.cached}</b> · 待下载{" "}
          <b className="c-yellow-text">{estimate.need}</b>
        </div>
      ) : null}

      {progress ? (
        <div style={{ margin: "6px 0 10px" }}>
          <div className="tile-progress">
            <div className="tile-progress-bar" style={{ width: `${pct}%` }} />
          </div>
          <div className="adm-hint" style={{ marginTop: 4 }}>
            {running ? "下载中" : "已完成"}: 下载 {progress.downloaded} / {progress.need} · 失败{" "}
            {progress.failed} · 缓存命中 {progress.skipped} · {fmtBytes(progress.bytes)}
          </div>
        </div>
      ) : null}

      <div className="adm-actions start">
        <button className="pp-btn primary" onClick={start} disabled={!bbox || running}>
          {running ? "下载中..." : "开始下载"}
        </button>
        <button
          className="pp-btn"
          disabled={running}
          onClick={async () => {
            const ok = await confirmDialog({
              title: "清空离线瓦片",
              body: "确定清空所有离线瓦片缓存和下载历史?",
              danger: true,
              okText: "清空",
            });
            if (!ok) return;
            await clearCache();
            setHistory([]);
            setEstimate(null);
            useUIStore.getState().bumpOfflineCoverage();
            flash("离线瓦片缓存已清空");
          }}
        >
          清空缓存
        </button>
      </div>

      {history.length > 0 ? (
        <div className="adm-sub-list">
          <h4>最近下载</h4>
          <table className="adm-table">
            <thead>
              <tr>
                <th>范围</th>
                <th>影像源</th>
                <th style={{ width: 120 }}>层级</th>
                <th style={{ width: 120 }}>下载 / 失败</th>
                <th style={{ width: 100 }}>大小</th>
              </tr>
            </thead>
            <tbody>
              {history.slice(0, 5).map((h) => (
                <tr key={h.id}>
                  <td>{h.label || "(无标签)"}</td>
                  <td>{(h.providers || []).map((p) => PROVIDER_LABEL[p] || p).join("、")}</td>
                  <td>z{h.zooms?.join(",")}</td>
                  <td>{h.downloaded} / {h.failed}</td>
                  <td>{fmtBytes(h.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

/** ── 行政边界下载 ─────────────────────────────────────────── */
function BoundarySection({ flash }: { flash: (t: string) => void }) {
  const [provinces, setProvinces] = useState<AdminTreeItem[]>([]);
  const [provinceAdcode, setProvinceAdcode] = useState(370000);
  const [cities, setCities] = useState<AdminTreeItem[]>([]);
  const [cityAdcode, setCityAdcode] = useState<number | "">("");
  const [counties, setCounties] = useState<AdminTreeItem[]>([]);
  const [countyAdcode, setCountyAdcode] = useState<number | "">("");
  const [includeTownships, setIncludeTownships] = useState(true);
  const [townshipSource, setTownshipSource] = useState<TownshipSource>("auto");
  const [submitting, setSubmitting] = useState(false);
  const [files, setFiles] = useState<BoundaryFileInfo[]>([]);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [exportCrs, setExportCrs] = useState<CrsId>("cgcs2000_gk_3");
  const gkCm = useUIStore((s) => s.gkCentralMeridian);
  const gkZw = useUIStore((s) => s.gkZoneWidth);

  const log = (line: string) =>
    setLogLines((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${line}`]);

  const refreshFiles = useCallback(() => {
    listBoundaries().then((r) => setFiles(r.files || [])).catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshFiles();
    fetchAdminTree(100000)
      .then((r) => setProvinces(r.items.filter((it) => it.level === "province")))
      .catch(() => setProvinces([]));
  }, [refreshFiles]);

  useEffect(() => {
    if (!provinceAdcode) return;
    setCities([]);
    setCityAdcode("");
    setCounties([]);
    setCountyAdcode("");
    fetchAdminTree(provinceAdcode).then((r) => setCities(r.items)).catch(() => setCities([]));
  }, [provinceAdcode]);

  useEffect(() => {
    if (!cityAdcode) return;
    setCounties([]);
    setCountyAdcode("");
    fetchAdminTree(Number(cityAdcode)).then((r) => setCounties(r.items)).catch(() => setCounties([]));
  }, [cityAdcode]);

  const canSubmit = !!cityAdcode || !!countyAdcode;
  const includeTownshipsEffective = !!countyAdcode && includeTownships;

  const onDownload = async () => {
    if (!canSubmit) {
      flash("请先选择地市或区县");
      return;
    }
    setSubmitting(true);
    log("开始下载…");
    try {
      const r = await downloadBoundaries({
        city_adcode: cityAdcode ? Number(cityAdcode) : null,
        county_adcode: countyAdcode ? Number(countyAdcode) : null,
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
        flash("边界已下载,地图页将自动刷新");
        useUIStore.getState().bumpBoundary();
      } else {
        flash("下载失败,详见日志");
      }
      refreshFiles();
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg = (e as any)?.response?.data?.detail || String(e);
      log(`✗ ${msg}`);
      flash("下载失败: " + msg);
    } finally {
      setSubmitting(false);
    }
  };

  const onExport = (file: "county" | "townships" | "villages") => {
    const url = exportBoundaryUrl(file, exportCrs, {
      centralMeridian: gkCm === "auto" ? undefined : gkCm,
      zoneWidth: gkZw,
      zonePrefix: true,
    });
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    flash(`正在导出 ${file}.${exportCrs}.geojson`);
  };

  return (
    <div className="adm-sec">
      <div className="adm-sec-hdr">
        <h2>行政边界下载</h2>
        <span className="adm-hint">
          县/市界来自阿里云 DataV;镇街来自 OSM Overpass;统一转 WGS-84
        </span>
      </div>

      <div className="adm-form-grid">
        <div className="tile-row">
          <label>省份</label>
          <select
            value={provinceAdcode}
            onChange={(e) => setProvinceAdcode(Number(e.target.value))}
            disabled={submitting}
          >
            {provinces.length === 0 ? (
              <option value={370000}>山东省 (默认)</option>
            ) : (
              provinces.map((p) => (
                <option key={p.adcode} value={p.adcode}>{p.name}</option>
              ))
            )}
          </select>
        </div>
        <div className="tile-row">
          <label>地市</label>
          <select
            value={cityAdcode}
            onChange={(e) => setCityAdcode(e.target.value ? Number(e.target.value) : "")}
            disabled={submitting || cities.length === 0}
          >
            <option value="">{cities.length ? "请选择..." : "加载中..."}</option>
            {cities.map((c) => (
              <option key={c.adcode} value={c.adcode}>{c.name}</option>
            ))}
          </select>
        </div>
        <div className="tile-row">
          <label>区县</label>
          <select
            value={countyAdcode}
            onChange={(e) => setCountyAdcode(e.target.value ? Number(e.target.value) : "")}
            disabled={submitting || counties.length === 0}
          >
            <option value="">
              {counties.length ? "整个地市 (下属所有区县)" : cityAdcode ? "加载中..." : "请先选地市"}
            </option>
            {counties.map((c) => (
              <option key={c.adcode} value={c.adcode}>{c.name}</option>
            ))}
          </select>
        </div>
        {countyAdcode ? (
          <div className="tile-row">
            <label>乡镇</label>
            <label className="adm-inline-check">
              <input
                type="checkbox"
                checked={includeTownships}
                onChange={(e) => setIncludeTownships(e.target.checked)}
              />
              同时下载该县下属乡镇
            </label>
            {includeTownshipsEffective ? (
              <select
                value={townshipSource}
                onChange={(e) => setTownshipSource(e.target.value as TownshipSource)}
                disabled={submitting}
              >
                <option value="auto">自动 (OSM 优先)</option>
                <option value="osm">仅 OSM Overpass</option>
                <option value="datav">仅 DataV</option>
              </select>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="adm-actions start">
        <button className="pp-btn primary" onClick={onDownload} disabled={submitting || !canSubmit}>
          {submitting ? "下载中..." : "开始下载"}
        </button>
        <button
          className="pp-btn"
          disabled={submitting}
          onClick={async () => {
            const ok = await confirmDialog({
              title: "清除边界文件",
              body: "确定删除已下载的县界与镇界 GeoJSON?",
              danger: true,
              okText: "删除",
            });
            if (!ok) return;
            try {
              const r = await clearBoundaries(["county", "townships"]);
              log(`已删除: ${r.removed.join(", ") || "(无文件可删)"}`);
              useUIStore.getState().bumpBoundary();
              flash("已清除并刷新地图");
              refreshFiles();
            } catch {
              flash("清除失败");
            }
          }}
        >
          清除已下载
        </button>
      </div>

      <div className="adm-sub-list">
        <h4>
          当前边界文件
          <select
            value={exportCrs}
            onChange={(e) => setExportCrs(e.target.value as CrsId)}
            style={{ marginLeft: "auto", height: 24, fontSize: 12 }}
            title="导出坐标系"
          >
            {CRS_LIST.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </h4>
        <table className="adm-table">
          <thead>
            <tr>
              <th>文件</th>
              <th style={{ width: 120 }}>要素数</th>
              <th style={{ width: 110 }}>大小</th>
              <th style={{ width: 90 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => {
              const stem = f.name.replace(/\.geojson$/, "") as "county" | "townships" | "villages";
              return (
                <tr key={f.name}>
                  <td>{f.name}</td>
                  <td>{f.missing ? "未生成" : f.feature_count}</td>
                  <td>{f.missing ? "—" : fmtBytes(f.size)}</td>
                  <td>
                    {!f.missing && f.feature_count > 0 ? (
                      <button className="pp-btn sm" onClick={() => onExport(stem)}>导出</button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {logLines.length > 0 ? (
        <pre className="adm-log" style={{ marginTop: 10, maxHeight: 140 }}>{logLines.join("\n")}</pre>
      ) : null}
    </div>
  );
}

/** ── 已下载内容总览(瓦片缓存分源统计) ─────────────────────── */
function CacheOverviewSection({ flash }: { flash: (t: string) => void }) {
  const [info, setInfo] = useState<TileCacheInfo | null>(null);

  const refresh = useCallback(() => {
    fetchCacheInfo().then(setInfo).catch(() => setInfo(null));
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 8000);
    return () => clearInterval(t);
  }, [refresh]);

  const entries = Object.entries(info?.providers || {}).filter(([, v]) => v.count > 0);
  const totalCount = entries.reduce((s, [, v]) => s + v.count, 0);
  const totalBytes = entries.reduce((s, [, v]) => s + v.bytes, 0);

  return (
    <div className="adm-sec">
      <div className="adm-sec-hdr">
        <h2>已下载的离线瓦片</h2>
        <span className="adm-hint">
          共 {totalCount.toLocaleString()} 张 · {fmtBytes(totalBytes)}
        </span>
        <div className="adm-actions">
          <button
            className="pp-btn sm"
            onClick={async () => {
              const r = await openCacheFolder();
              if (!r.ok) flash("打开缓存目录失败");
            }}
          >
            打开缓存目录
          </button>
        </div>
      </div>
      {entries.length === 0 ? (
        <div className="pp-empty">还没有离线瓦片。在上方选好范围与影像源后点「开始下载」。</div>
      ) : (
        <table className="adm-table">
          <thead>
            <tr>
              <th>影像源</th>
              <th style={{ width: 140 }}>瓦片数量</th>
              <th style={{ width: 120 }}>占用空间</th>
              <th style={{ width: 90 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([prov, v]) => (
              <tr key={prov}>
                <td>{PROVIDER_LABEL[prov] || prov}</td>
                <td>{v.count.toLocaleString()} 张</td>
                <td>{fmtBytes(v.bytes)}</td>
                <td>
                  <button
                    className="pp-btn sm danger"
                    onClick={async () => {
                      const ok = await confirmDialog({
                        title: "删除离线瓦片",
                        body: `确定删除「${PROVIDER_LABEL[prov] || prov}」的全部离线瓦片?`,
                        danger: true,
                        okText: "删除",
                      });
                      if (!ok) return;
                      await clearCache([prov]);
                      refresh();
                      useUIStore.getState().bumpOfflineCoverage();
                      flash("已删除该影像源的缓存");
                    }}
                  >
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

type AdminTabId = "pipeline" | "api" | "map";

const ADMIN_TABS: { id: AdminTabId; label: string }[] = [
  { id: "pipeline", label: "数据管线" },
  { id: "api", label: "API 配置" },
  { id: "map", label: "离线地图下载" },
];

export default function AdminPage() {
  const [pipeline, setPipeline] = useState<PipelineStatus | null>(null);
  const [task, setTask] = useState<AdminTask>({ status: "idle" });
  const [config, setConfig] = useState<ApiConfigStatus | null>(null);
  const [form, setForm] = useState({
    sf: "",
    sfUrl: "",
    ds: "",
    dsUrl: "",
    amap: "",
    ion: "",
    tdt: "",
    weatherUrl: "",
    weatherKey: "",
  });
  const [dualExtract, setDualExtract] = useState(
    () => localStorage.getItem("dualExtract") === "1",
  );
  // DeepSeek 模型选择(与 SiliconFlow 平行的一套状态)
  const [dsModels, setDsModels] = useState<AiModelsResp | null>(null);
  const [dsModelSel, setDsModelSel] = useState("");
  const [dsModelSaving, setDsModelSaving] = useState(false);
  const [dsModelsLoading, setDsModelsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [aiModels, setAiModels] = useState<AiModelsResp | null>(null);
  const [modelSel, setModelSel] = useState("");
  const [modelSaving, setModelSaving] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<AdminTabId>("pipeline");
  const [concurrency, setConcurrency] = useState(2);
  const [concSaving, setConcSaving] = useState(false);
  const [extract, setExtract] = useState<ExtractProgress | null>(null);
  const [stopping, setStopping] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearText, setClearText] = useState("");
  const [clearInput, setClearInput] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [toast, setToast] = useState("");
  const logRef = useRef<HTMLPreElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const flash = (t: string) => {
    setToast(t);
    setTimeout(() => setToast(""), 3000);
  };

  const refreshPipeline = useCallback(() => {
    fetchPipelineStatus().then(setPipeline).catch(() => undefined);
  }, []);

  const refreshConfig = useCallback(() => {
    fetchApiConfig()
      .then((c) => {
        setConfig(c);
        if (c.siliconflow.extract_concurrency) {
          setConcurrency(c.siliconflow.extract_concurrency);
        }
      })
      .catch(() => undefined);
  }, []);

  const refreshExtract = useCallback(() => {
    fetchExtractProgress().then(setExtract).catch(() => undefined);
  }, []);

  const doStop = async () => {
    const ok = await confirmDialog({
      title: "停止档案提取",
      body: "将在跑完当前在途请求后优雅停止,已完成的进度全部保留。\n停止后可以更换模型,重新运行时自动从断点续传并采用新模型。",
      okText: "停止",
    });
    if (!ok) return;
    setStopping(true);
    try {
      const r = await stopPipeline();
      flash(`停止指令已发出,预计跑完当前 ${r.inflight_max} 条在途请求后停止`);
      refreshExtract();
    } catch {
      flash("操作失败");
    } finally {
      setStopping(false);
    }
  };

  const applyConcurrency = async (n: number) => {
    const prev = concurrency;
    setConcurrency(n);
    setConcSaving(true);
    try {
      await saveApiConfig({ extract_concurrency: n });
      flash(`档案提取并发已设为 ${n},下次运行生效`);
    } catch {
      setConcurrency(prev);
      flash("并发设置保存失败");
    } finally {
      setConcSaving(false);
    }
  };

  const refreshModels = useCallback(() => {
    fetchAiModels()
      .then((d) => {
        setAiModels(d);
        setModelSel(d.current || "");
      })
      .catch(() => undefined);
    fetchAiModels("deepseek")
      .then((d) => {
        setDsModels(d);
        setDsModelSel(d.current || "");
      })
      .catch(() => undefined);
  }, []);

  const reloadDsModels = async () => {
    setDsModelsLoading(true);
    try {
      const d = await fetchAiModels("deepseek");
      setDsModels(d);
      if (!dsModelSel || !d.models.some((m) => m.id === dsModelSel)) {
        setDsModelSel(d.current || "");
      }
      flash(d.source === "api"
        ? `已刷新,DeepSeek 可用模型 ${d.models.length} 个`
        : `刷新失败,使用内置列表(${d.error || "API 不可用"})`);
    } catch {
      flash("DeepSeek 模型列表刷新失败");
    } finally {
      setDsModelsLoading(false);
    }
  };

  const applyDsModel = async () => {
    if (!dsModelSel || dsModelSel === dsModels?.current) return;
    setDsModelSaving(true);
    try {
      await saveApiConfig({ deepseek_model: dsModelSel });
      flash(`DeepSeek 提取模型已切换为 ${dsModelSel}`);
      refreshModels();
      refreshConfig();
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      flash((e as any)?.response?.data?.detail || "模型保存失败");
    } finally {
      setDsModelSaving(false);
    }
  };

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const t = await fetchTask();
        setTask(t);
        if (t.status !== "running") {
          stopPolling();
          refreshPipeline();
        }
      } catch {
        /* ignore */
      }
    }, 1200);
  }, [stopPolling, refreshPipeline]);

  useEffect(() => {
    document.title = "系统管理 — 济宁市文物保护利用平台";
    refreshPipeline();
    refreshConfig();
    refreshModels();
    // 页面打开时若已有任务在跑,续上轮询
    fetchTask().then((t) => {
      setTask(t);
      if (t.status === "running") startPolling();
    }).catch(() => undefined);
    return stopPolling;
  }, [refreshPipeline, refreshConfig, refreshModels, startPolling, stopPolling]);

  // 提取进度:打开页面拉一次;任务运行中每 3 秒刷新
  useEffect(() => {
    refreshExtract();
  }, [refreshExtract]);
  useEffect(() => {
    if (task.status !== "running") return;
    const t = setInterval(refreshExtract, 3000);
    return () => clearInterval(t);
  }, [task.status, refreshExtract]);

  // 日志自动滚到底
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [task.log?.length]);

  const running = task.status === "running";

  const run = async (opts: { only?: string; demo?: boolean; dual?: boolean }) => {
    try {
      // 双通道开关只影响含 step00 的运行(全部管线 / 单跑 step00)
      const withDual =
        dualExtract && !opts.demo && (opts.only == null || opts.only === "00");
      await runPipeline(withDual ? { ...opts, dual: true } : opts);
      setTask({ status: "running", log: [] });
      startPolling();
    } catch (e) {
      const detail =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e as any)?.response?.data?.detail || "启动任务失败";
      flash(detail);
    }
  };

  const toggleDual = (on: boolean) => {
    if (on && !config?.deepseek?.configured) {
      flash("请先在「API 配置」里填写 DeepSeek API Key");
      return;
    }
    setDualExtract(on);
    localStorage.setItem("dualExtract", on ? "1" : "0");
  };

  const doClearAll = async () => {
    if (clearText.trim() !== "清除全部数据" || clearing) return;
    setClearing(true);
    try {
      const res = await clearAllData(clearText.trim(), clearInput);
      if (res.ok) {
        flash("已清除全部数据,页面即将刷新...");
        // 数据全空,前端各 store 里的旧数据一并作废,整页刷新最干净
        setTimeout(() => window.location.reload(), 1200);
      } else {
        flash(`部分清除失败: ${res.failed.map((f) => f.label).join("、")}`);
        setClearOpen(false);
        refreshPipeline();
      }
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      flash((e as any)?.response?.data?.detail || "清除失败");
    } finally {
      setClearing(false);
      setClearText("");
    }
  };

  const save = async () => {
    const anyFilled = [
      form.sf,
      form.sfUrl,
      form.ds,
      form.dsUrl,
      form.amap,
      form.ion,
      form.tdt,
      form.weatherUrl,
      form.weatherKey,
    ]
      .some((v) => v.trim());
    if (!anyFilled) {
      flash("请至少填写一项后再保存(留空表示不修改)");
      return;
    }
    setSaving(true);
    try {
      const res = await saveApiConfig({
        siliconflow_key: form.sf.trim() || undefined,
        siliconflow_base_url: form.sfUrl.trim() || undefined,
        deepseek_key: form.ds.trim() || undefined,
        deepseek_base_url: form.dsUrl.trim() || undefined,
        amap_web_key: form.amap.trim() || undefined,
        cesium_ion_token: form.ion.trim() || undefined,
        tianditu_key: form.tdt.trim() || undefined,
        weather_base_url: form.weatherUrl.trim() || undefined,
        weather_api_key: form.weatherKey.trim() || undefined,
      });
      flash(res.message || "已保存");
      setForm({
        sf: "",
        sfUrl: "",
        ds: "",
        dsUrl: "",
        amap: "",
        ion: "",
        tdt: "",
        weatherUrl: "",
        weatherKey: "",
      });
      refreshConfig();
      refreshModels(); // 新填了 Key 后模型列表可能变为可拉取
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      flash((e as any)?.response?.data?.detail || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const reloadModels = async () => {
    setModelsLoading(true);
    try {
      const d = await fetchAiModels();
      setAiModels(d);
      if (!modelSel || !d.models.some((m) => m.id === modelSel)) {
        setModelSel(d.current || "");
      }
      flash(d.source === "api"
        ? `已刷新,可用模型 ${d.models.length} 个`
        : `刷新失败,使用内置列表(${d.error || "API 不可用"})`);
    } catch {
      flash("模型列表刷新失败");
    } finally {
      setModelsLoading(false);
    }
  };

  const applyModel = async () => {
    if (!modelSel || modelSel === aiModels?.current) return;
    setModelSaving(true);
    try {
      await saveApiConfig({ default_model: modelSel });
      flash(`AI 模型已切换为 ${modelSel},即时生效`);
      refreshModels();
      refreshConfig();
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      flash((e as any)?.response?.data?.detail || "模型保存失败");
    } finally {
      setModelSaving(false);
    }
  };

  const manifestOf = (stepId: string) =>
    pipeline?.last_manifest?.steps?.find((s) => s.id === stepId);

  return (
    <div className="adm-page">
      <div className="adm-body">
        <nav className="adm-side">
          {ADMIN_TABS.map((t) => (
            <button
              key={t.id}
              className={"adm-side-item" + (activeTab === t.id ? " on" : "")}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="adm-content">
      {/* ── 数据管线 ─────────────────────────────── */}
      <div style={{ display: activeTab === "pipeline" ? "contents" : "none" }}>
      <div className="adm-sec">
        <div className="adm-sec-hdr">
          <h2>数据管线</h2>
          <div className="adm-actions">
            <button
              className="pp-btn sm"
              disabled={running}
              onClick={() => run({ demo: true })}
              title="没有真实数据时,先生成一批演示台账/照片/档案"
            >
              生成演示数据
            </button>
            <button
              className="pp-btn sm primary"
              disabled={running}
              onClick={() => run({})}
            >
              {running ? "运行中..." : "▶ 运行全部管线"}
            </button>
          </div>
        </div>

        <div className="adm-steps">
          {(pipeline?.steps || []).map((s) => {
            const m = manifestOf(s.id);
            const outputsOk = s.missing_outputs.length === 0 && s.outputs.length > 0;
            const inputsOk = s.missing_inputs.length === 0;
            return (
              <div key={s.id} className="adm-step">
                <div className="adm-step-top">
                  <span className={"adm-step-idx" + (outputsOk ? " ok" : "")}>{s.id}</span>
                  <div className="adm-step-name">
                    {STEP_TITLE[s.id] || s.name}
                    <em>{STEP_DESC[s.id] || s.script}{s.optional ? " · 可选" : ""}</em>
                  </div>
                  {s.id === "00" ? (
                    <>
                      <label className="adm-conc" title="同时向大模型发起的提取请求数;账号限流严可调低">
                        并发进程
                        <select
                          value={concurrency}
                          disabled={running || concSaving}
                          onChange={(e) => applyConcurrency(Number(e.target.value))}
                        >
                          {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                            <option key={n} value={n}>{n}</option>
                          ))}
                        </select>
                      </label>
                      <label
                        className="adm-conc"
                        title={"同时用 SiliconFlow(正序)与 DeepSeek 官方 API(倒序)双通道提取,\n两边各自断点续传,中间会合,速度约翻倍。需先配置 DeepSeek Key。"}
                      >
                        <input
                          type="checkbox"
                          checked={dualExtract}
                          disabled={running}
                          onChange={(e) => toggleDual(e.target.checked)}
                        />
                        双通道提取
                        {dualExtract ? <em className="c-green"> (A+B)</em> : null}
                      </label>
                    </>
                  ) : null}
                  <button
                    className="pp-btn sm"
                    disabled={running}
                    onClick={() => run({ only: s.id })}
                  >
                    单步运行
                  </button>
                </div>
                <div className="adm-step-io">
                  {s.inputs.map((a) => (
                    <span key={"i" + a.label} className={"adm-io" + (a.exists ? " ok" : " miss")}>
                      入 {a.label}{a.kind === "dir" ? ` ×${a.count}` : ""}
                    </span>
                  ))}
                  {s.outputs.map((a) => (
                    <span key={"o" + a.label} className={"adm-io" + (a.exists ? " ok" : " miss")}>
                      出 {a.label}{a.kind === "dir" ? ` ×${a.count}` : ""}
                    </span>
                  ))}
                  {m ? (
                    <span className={"adm-io last-" + m.status}>
                      上次 {m.status === "done" ? `成功 ${m.duration_sec ?? "?"}s` : m.status}
                    </span>
                  ) : null}
                </div>
                {!inputsOk && !running ? (
                  <div className="adm-step-warn">
                    缺少输入:{s.missing_inputs.map((a) => `${a.label} (${a.path})`).join("、")}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        {extract && extract.total > 0 ? (
          <div className="adm-progress">
            <div className="adm-progress-top">
              <b>档案提取进度</b>
              <span className="adm-model-badge" title="运行中显示本次任务启动时的模型;空闲时显示当前配置,换模型即时更新">
                {running
                  ? `运行模型: ${task.model || "未知"} · 渠道: ${hostOf(task.base_url)}`
                  : `当前模型: ${aiModels?.current || config?.siliconflow.default_model || "未设置"} · 渠道: ${hostOf(config?.siliconflow.base_url)}`}
              </span>
              <span className="adm-hint c-yellow-text">
                {running && extract.stopping
                  ? `正在停止 · 预计跑完当前 ${extract.concurrency} 条在途请求后停止`
                  : ""}
              </span>
              {running ? (
                <div className="adm-actions">
                  <button className="pp-btn sm danger" onClick={doStop} disabled={stopping || extract.stopping}>
                    {extract.stopping ? "停止中…" : "⏹ 停止"}
                  </button>
                </div>
              ) : null}
            </div>
            <div className="adm-progress-bar">
              <i style={{ width: `${extract.total ? Math.round((extract.done / extract.total) * 100) : 0}%` }} />
            </div>
            <div className="adm-progress-stats">
              <div><em>总数</em><b>{extract.total.toLocaleString()}</b></div>
              <div><em>已处理</em><b className="c-green">{extract.done.toLocaleString()}</b></div>
              <div><em>失败</em><b className={extract.failed ? "c-red" : ""}>{extract.failed.toLocaleString()}</b></div>
              <div><em>剩余</em><b className="c-yellow">{extract.remaining.toLocaleString()}</b></div>
              <div><em>完成率</em><b>{extract.total ? ((extract.done / extract.total) * 100).toFixed(1) : 0}%</b></div>
            </div>
          </div>
        ) : null}

        {task.status !== "idle" ? (
          <div className="adm-log-box">
            <div className="adm-log-hdr">
              <span className={"adm-task-st st-" + task.status}>
                {task.status === "running" ? "● 运行中"
                  : task.status === "done" ? "✓ 完成"
                    : task.status === "stopped" ? "⏹ 已停止(重跑即续传)"
                      : "✗ 失败"}
              </span>
              <span className="adm-task-label">{task.label}</span>
              {task.status !== "running" && task.returncode != null ? (
                <span className="adm-task-rc">exit {task.returncode}</span>
              ) : null}
              {task.log_file ? (
                <span className="adm-hint" style={{ marginLeft: "auto" }} title={task.log_file}>
                  完整日志: {task.log_file.split(/[\\/]/).slice(-2).join("/")}
                </span>
              ) : null}
            </div>
            <pre ref={logRef} className="adm-log">{(task.log || []).join("\n")}</pre>
          </div>
        ) : (
          <div className="pp-empty">
            尚未运行任务。首次使用可先点「生成演示数据」,再「运行全部管线」建库。
          </div>
        )}

        {/* ── 危险操作:清除全部数据 ─────────────── */}
        <div className="adm-danger-row">
          <div className="adm-danger-text">
            <b>清除所有数据</b>
            <em>
              删除全部管线产物:数据集库(relics.db)、照片图纸、行政边界、
              巡查库(patrol.db)与打卡照片、管线日志。不影响 config.yaml 与离线地图瓦片。
            </em>
          </div>
          <button
            className="pp-btn sm danger"
            disabled={running || clearing}
            onClick={() => {
              setClearText("");
              setClearInput(false);
              setClearOpen(true);
            }}
          >
            清除所有数据
          </button>
        </div>
      </div>
      </div>

      {clearOpen && (
        <div className="adm-modal-mask" onClick={() => !clearing && setClearOpen(false)}>
          <div className="adm-modal" onClick={(e) => e.stopPropagation()}>
            <h3>⚠ 清除所有数据</h3>
            <p>
              此操作将<b>永久删除</b>所有已生成的数据,且<b>无法恢复</b>:
            </p>
            <ul>
              <li>数据集库 relics.db、全量 JSON / GeoJSON、照片图纸索引</li>
              <li>照片、图纸文件与行政边界产物</li>
              <li>巡查库 patrol.db(全部路线与打卡记录)及打卡照片</li>
              <li>管线日志与档案提取进度账本</li>
            </ul>
            <label className="adm-modal-check">
              <input
                type="checkbox"
                checked={clearInput}
                onChange={(e) => setClearInput(e.target.checked)}
              />
              同时清除 data/input 原始资料(登记表 docx、Markdown 档案、台账、媒体、边界、档案 PDF)
            </label>
            <p className="adm-modal-tip">
              请输入 <b>清除全部数据</b> 以确认:
            </p>
            <input
              className="pp-input"
              value={clearText}
              placeholder="清除全部数据"
              onChange={(e) => setClearText(e.target.value)}
              autoFocus
            />
            <div className="adm-modal-actions">
              <button className="pp-btn sm" disabled={clearing} onClick={() => setClearOpen(false)}>
                取消
              </button>
              <button
                className="pp-btn sm danger"
                disabled={clearText.trim() !== "清除全部数据" || clearing}
                onClick={doClearAll}
              >
                {clearing ? "清除中..." : "确定清除"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── API 配置 ─────────────────────────────── */}
      <div style={{ display: activeTab === "api" ? "contents" : "none" }}>
      <div className="adm-sec">
        <div className="adm-sec-hdr">
          <h2>外部 API 配置</h2>
          <span className="adm-hint">
            保存写入 config.yaml，AI、高德与天气配置即时生效；留空的项不会被修改
          </span>
        </div>

        {/* ── 硅基流动 SiliconFlow ── */}
        <div className="adm-key-group">
          <div className="adm-key-group-title">
            硅基流动 SiliconFlow
            <em>AI 问答 / 巡查规划 / 报告生成 / 档案提取通道 A(正序)</em>
          </div>
          <div className="adm-keys">
            <div className="adm-key-row">
              <div className="adm-key-meta">
                <b>API Key</b>
                <span className={"adm-key-st" + (config?.runtime.ai_ready ? " on" : "")}>
                  {config?.runtime.ai_ready
                    ? `已启用 ${config?.siliconflow.masked}`
                    : config?.siliconflow.configured
                      ? `已配置(未就绪)`
                      : "未配置"}
                </span>
              </div>
              <input
                className="pp-input"
                type="password"
                placeholder="sk-... (留空不修改)"
                value={form.sf}
                onChange={(e) => setForm({ ...form, sf: e.target.value })}
              />
            </div>

            <div className="adm-key-row">
              <div className="adm-key-meta">
                <b>API 地址</b>
                <span className={"adm-key-st" + (config?.siliconflow.base_url ? " on" : "")}>
                  当前 {config?.siliconflow.base_url || "https://api.siliconflow.cn/v1"}
                </span>
              </div>
              <input
                className="pp-input"
                type="text"
                placeholder="https://api.siliconflow.cn/v1 (留空不修改)"
                value={form.sfUrl}
                onChange={(e) => setForm({ ...form, sfUrl: e.target.value })}
              />
            </div>

            <div className="adm-key-row">
              <div className="adm-key-meta">
                <b>AI 模型</b>
                <span className={"adm-key-st" + (aiModels?.current ? " on" : "")}>
                  {aiModels?.current || "未设置"}
                  {aiModels?.source === "api" ? ` · 可选 ${aiModels.models.length} 个` : ""}
                </span>
              </div>
              <div className="adm-flex-row">
                <select
                  className="pp-input adm-flex-fill"
                  value={modelSel}
                  onChange={(e) => setModelSel(e.target.value)}
                  disabled={modelSaving || !aiModels?.models?.length}
                >
                  {modelSel && !aiModels?.models?.some((m) => m.id === modelSel) ? (
                    <option value={modelSel}>{modelSel}</option>
                  ) : null}
                  {(aiModels?.models || []).map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
                <button
                  className="pp-btn"
                  title="重新从 SiliconFlow 拉取可用模型列表"
                  disabled={modelsLoading}
                  onClick={reloadModels}
                >
                  {modelsLoading ? "刷新中..." : "刷新"}
                </button>
                <button
                  className="pp-btn primary"
                  onClick={applyModel}
                  disabled={modelSaving || !modelSel || modelSel === aiModels?.current}
                >
                  {modelSaving ? "应用中..." : "应用"}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* ── DeepSeek 官方 ── */}
        <div className="adm-key-group">
          <div className="adm-key-group-title">
            DeepSeek 官方
            <em>档案提取通道 B(倒序,与通道 A 并行,速度约翻倍)</em>
          </div>
          <div className="adm-keys">
            <div className="adm-key-row">
              <div className="adm-key-meta">
                <b>API Key</b>
                <span className={"adm-key-st" + (config?.deepseek?.configured ? " on" : "")}>
                  {config?.deepseek?.configured
                    ? `已配置 ${config.deepseek.masked}`
                    : "未配置"}
                </span>
              </div>
              <input
                className="pp-input"
                type="password"
                placeholder="sk-... (留空不修改)"
                value={form.ds}
                onChange={(e) => setForm({ ...form, ds: e.target.value })}
              />
            </div>

            <div className="adm-key-row">
              <div className="adm-key-meta">
                <b>API 地址</b>
                <span className={"adm-key-st" + (config?.deepseek?.base_url ? " on" : "")}>
                  当前 {config?.deepseek?.base_url || "https://api.deepseek.com/v1"}
                </span>
              </div>
              <input
                className="pp-input"
                type="text"
                placeholder="https://api.deepseek.com/v1 (留空不修改)"
                value={form.dsUrl}
                onChange={(e) => setForm({ ...form, dsUrl: e.target.value })}
              />
            </div>

            <div className="adm-key-row">
              <div className="adm-key-meta">
                <b>AI 模型</b>
                <span className={"adm-key-st" + (dsModels?.current ? " on" : "")}>
                  {dsModels?.current || "未设置"}
                  {dsModels?.source === "api" ? ` · 可选 ${dsModels.models.length} 个` : ""}
                </span>
              </div>
              <div className="adm-flex-row">
                <select
                  className="pp-input adm-flex-fill"
                  value={dsModelSel}
                  onChange={(e) => setDsModelSel(e.target.value)}
                  disabled={dsModelSaving || !dsModels?.models?.length}
                >
                  {dsModelSel && !dsModels?.models?.some((m) => m.id === dsModelSel) ? (
                    <option value={dsModelSel}>{dsModelSel}</option>
                  ) : null}
                  {(dsModels?.models || []).map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
                <button
                  className="pp-btn"
                  title="重新从 DeepSeek 拉取可用模型列表"
                  disabled={dsModelsLoading}
                  onClick={reloadDsModels}
                >
                  {dsModelsLoading ? "刷新中..." : "刷新"}
                </button>
                <button
                  className="pp-btn primary"
                  onClick={applyDsModel}
                  disabled={dsModelSaving || !dsModelSel || dsModelSel === dsModels?.current}
                >
                  {dsModelSaving ? "应用中..." : "应用"}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* ── 其他服务 ── */}
        <div className="adm-key-group">
          <div className="adm-key-group-title">
            其他服务
            <em>地图与路线相关 Key</em>
          </div>
          <div className="adm-keys">
          <div className="adm-key-row">
            <div className="adm-key-meta">
              <b>高德 Web 服务 Key</b>
              <em>巡查驾车路线规划</em>
              <span className={"adm-key-st" + (config?.runtime.amap_ready ? " on" : "")}>
                {config?.runtime.amap_ready
                  ? `已启用 ${config?.amap.masked}`
                  : "未配置"}
              </span>
            </div>
            <input
              className="pp-input"
              type="password"
              placeholder="高德开放平台 Web服务 key (留空不修改)"
              value={form.amap}
              onChange={(e) => setForm({ ...form, amap: e.target.value })}
            />
          </div>

          <div className="adm-key-row">
            <div className="adm-key-meta">
              <b>Cesium Ion Token</b>
              <em>在线高精度地形(可选)</em>
              <span className={"adm-key-st" + (config?.cesium_ion.configured ? " on" : "")}>
                {config?.cesium_ion.configured ? `已配置 ${config?.cesium_ion.masked}` : "未配置"}
              </span>
            </div>
            <input
              className="pp-input"
              type="password"
              placeholder="Cesium Ion access token (留空不修改)"
              value={form.ion}
              onChange={(e) => setForm({ ...form, ion: e.target.value })}
            />
          </div>

          <div className="adm-key-row">
            <div className="adm-key-meta">
              <b>天地图 Key</b>
              <em>官方在线底图(服务端类型)</em>
              <span className={"adm-key-st" + (config?.tianditu?.configured ? " on" : "")}>
                {config?.tianditu?.configured ? `已配置 ${config?.tianditu?.masked}` : "未配置"}
              </span>
            </div>
            <input
              className="pp-input"
              type="password"
              placeholder="天地图控制台申请的服务端 key (留空不修改)"
              value={form.tdt}
              onChange={(e) => setForm({ ...form, tdt: e.target.value })}
            />
          </div>
          </div>
        </div>

        {/* ── 天气服务 ── */}
        <div className="adm-key-group">
          <div className="adm-key-group-title">
            天气服务
            <em>地图总览未来 7 日与逐小时预报</em>
          </div>
          <div className="adm-keys">
            <div className="adm-key-row">
              <div className="adm-key-meta">
                <b>Open-Meteo 兼容 API</b>
                <em>默认公共接口免 Key；商用订阅可替换专用地址并填写 Key</em>
                <span className={"adm-key-st" + (config?.weather?.configured ? " on" : "")}>
                  {config?.weather?.configured
                    ? `已配置 ${config.weather.provider}${config.weather.key_configured ? ` · ${config.weather.masked}` : " · 免 Key"}`
                    : "未配置"}
                </span>
              </div>
              <div className="adm-key-inputs">
                <input
                  className="pp-input"
                  type="url"
                  aria-label="天气 API 地址"
                  placeholder={config?.weather?.base_url || "https://api.open-meteo.com/v1/forecast"}
                  value={form.weatherUrl}
                  onChange={(e) => setForm({ ...form, weatherUrl: e.target.value })}
                />
                <input
                  className="pp-input"
                  type="password"
                  aria-label="天气 API Key"
                  placeholder="天气 API Key（公共接口可留空，不修改现有配置）"
                  value={form.weatherKey}
                  onChange={(e) => setForm({ ...form, weatherKey: e.target.value })}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="adm-save-row">
          <span className="adm-hint">配置文件: {config?.config_path || "config.yaml"}</span>
          <button className="pp-btn primary" disabled={saving} onClick={save}>
            {saving ? "保存中..." : "保存配置"}
          </button>
        </div>
      </div>
      </div>

      {/* ── 离线地图下载(瓦片 + 行政边界 + 已下载内容) ── */}
      <div style={{ display: activeTab === "map" ? "contents" : "none" }}>
        <TileDownloadSection flash={flash} />
        <CacheOverviewSection flash={flash} />
        <BoundarySection flash={flash} />
      </div>
        </div>
      </div>

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}
