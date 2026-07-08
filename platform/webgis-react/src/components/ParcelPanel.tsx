import { useRef, useState } from "react";
import { useParcelStore } from "../stores/parcelStore";
import { getParcelLayer } from "../map/ParcelLayer";
import { confirmDialog } from "./ConfirmModal";
import type { ParcelConflict } from "../api/parcels";
import { flyTo } from "../map/viewerRegistry";

const KIND_LABEL: Record<ParcelConflict["kind"], string> = {
  body: "本体范围",
  protection: "保护范围",
  control: "建控地带",
  point: "本体点位",
};

const ACCEPT = ".shp,.dbf,.shx,.prj,.cpg,.zip";

function fmtArea(m2: number): string {
  if (m2 <= 0) return "—";
  if (m2 >= 666.67) return `${(m2 / 666.67).toFixed(2)} 亩`;
  return `${m2.toFixed(1)} ㎡`;
}

export function ParcelPanel() {
  const open = useParcelStore((s) => s.panelOpen);
  const layers = useParcelStore((s) => s.layers);
  const visible = useParcelStore((s) => s.visible);
  const importing = useParcelStore((s) => s.importing);
  const analyzing = useParcelStore((s) => s.analyzing);
  const analyses = useParcelStore((s) => s.analyses);
  const importFiles = useParcelStore((s) => s.importFiles);
  const toggleVisible = useParcelStore((s) => s.toggleVisible);
  const analyze = useParcelStore((s) => s.analyze);
  const analyzeAll = useParcelStore((s) => s.analyzeAll);
  const remove = useParcelStore((s) => s.remove);

  const fileRef = useRef<HTMLInputElement>(null);
  const [activeId, setActiveId] = useState<string>("");
  const [dragOver, setDragOver] = useState(false);

  if (!open) return null;

  const activeAnalysis = activeId ? analyses[activeId] : undefined;

  // 顶部总览:导入图斑总数 / 占压冲突总数(需全部图层查询过才有定论)
  const totalFeatures = layers.reduce((s, l) => s + l.feature_count, 0);
  const analyzedCount = layers.filter((l) => analyses[l.id]).length;
  const totalConflicts = layers.reduce(
    (s, l) => s + (analyses[l.id]?.summary.total ?? 0),
    0,
  );
  const allAnalyzed = layers.length > 0 && analyzedCount === layers.length;

  const onPick = async (list: FileList | null) => {
    if (!list?.length) return;
    await importFiles(Array.from(list));
    if (fileRef.current) fileRef.current.value = "";
  };

  const onAnalyze = async (id: string) => {
    setActiveId(id);
    await analyze(id);
  };

  const onRemove = async (id: string, name: string) => {
    const ok = await confirmDialog({
      title: "删除图层",
      body: `确定删除图层「${name}」吗?\n对应的分析结果也会一并删除。`,
      danger: true,
      okText: "删除",
    });
    if (!ok) return;
    if (activeId === id) setActiveId("");
    await remove(id);
  };

  const onLocateLayer = (bbox: [number, number, number, number]) => {
    const [w, s, e, n] = bbox;
    const dx = (e - w) * 111000;
    const dy = (n - s) * 111000;
    const h = Math.max(3000, Math.min(300000, Math.max(dx, dy) * 1.5));
    flyTo((w + e) / 2, (s + n) / 2, h, 1.0);
  };

  const onConflictClick = (c: ParcelConflict) => {
    if (c.kind === "point") {
      // 本体点位:直接飞到文物点(用户可点击点位打开详情)
      flyTo(c.center[0], c.center[1], 2600, 1.0);
      return;
    }
    getParcelLayer()?.focusConflict(
      activeAnalysis?.layer_id || "",
      c.feature_index,
      c.center,
    );
  };

  return (
    <div className="parcel-panel">
      <div className="pp-hdr">
        <h3>图斑对比</h3>
        <span className="pp-hint">SHP · CGCS2000 自动转换</span>
      </div>

      <div className="pp-body">
        {/* 占压总览(常驻最上方) */}
        <div className="pp-sec">
          <div className="pcl-overview">
            <div className="pcl-sum-card">
              <b>{totalFeatures}</b>
              <span>导入图斑</span>
            </div>
            <div
              className={
                "pcl-sum-card" + (allAnalyzed ? (totalConflicts > 0 ? " warn" : " ok") : "")
              }
              title={allAnalyzed ? "" : "尚未查询全部图层"}
            >
              <b>{analyzedCount > 0 ? totalConflicts : "—"}</b>
              <span>占压本体/两线</span>
            </div>
          </div>
          <button
            className="pp-btn primary block"
            disabled={!!analyzing || !layers.length}
            onClick={() => void analyzeAll()}
            title="对所有已导入图层逐一做占压查询"
          >
            {analyzing === "__all__"
              ? `查询中... (${analyzedCount}/${layers.length})`
              : "一键查询全部图层"}
          </button>
          {analyzedCount > 0 && !allAnalyzed ? (
            <div className="pcl-tip">已查询 {analyzedCount}/{layers.length} 个图层,结果不完整</div>
          ) : null}
        </div>

        {/* 导入 */}
        <div className="pp-sec">
          <div className="pp-label">导入用地范围线</div>
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            multiple
            style={{ display: "none" }}
            onChange={(e) => void onPick(e.target.files)}
          />
          <div
            className={"pcl-drop" + (dragOver ? " over" : "") + (importing ? " busy" : "")}
            onClick={() => !importing && fileRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (!importing) void onPick(e.dataTransfer.files);
            }}
          >
            {importing ? "导入中..." : "点击选择或拖入 SHP / ZIP"}
          </div>
          <div className="pcl-tip">
            建议同名 .shp / .dbf / .prj 一起多选(或打包 zip);只拖 .shp 也能导入,
            但图斑将没有村名/地类等属性。坐标系 CGCS2000 自动转换。
          </div>
        </div>

        {/* 图层列表 */}
        <div className="pp-sec">
          <div className="pp-label">
            已导入图层
            {layers.length ? <span className="pcl-count">{layers.length}</span> : null}
          </div>
          {layers.length === 0 ? (
            <div className="pp-empty">暂无图层,请先导入 SHP</div>
          ) : (
            layers.map((l, i) => {
              const a = analyses[l.id];
              const color = getParcelLayer()?.colorOf(l.id) || ["#ffb020", "#22c8b7", "#a06bff", "#ff7d59", "#3fa9f5", "#8bc34a"][i % 6];
              return (
                <div className={"pcl-layer" + (activeId === l.id ? " active" : "")} key={l.id}>
                  <div className="pcl-layer-main">
                    <label className="pcl-eye" title="显示/隐藏">
                      <input
                        type="checkbox"
                        checked={visible[l.id] !== false}
                        onChange={() => toggleVisible(l.id)}
                      />
                      <i className="pcl-dot" style={{ background: color }} />
                    </label>
                    <div
                      className="pcl-layer-name"
                      title={`${l.name}\n${l.source_crs}`}
                      onClick={() => onLocateLayer(l.bbox)}
                    >
                      {l.name}
                      <span>{l.feature_count} 图斑 · {l.source_crs}</span>
                    </div>
                  </div>
                  <div className="pcl-layer-ops">
                    <button
                      className="pp-btn sm"
                      disabled={!!analyzing}
                      onClick={() => void onAnalyze(l.id)}
                      title="查询该图层是否压占文物本体/两线范围"
                    >
                      {analyzing === l.id ? "分析中..." : "一键查询"}
                    </button>
                    {a ? (
                      <button
                        className={"pp-btn sm" + (activeId === l.id ? "" : "")}
                        onClick={() => setActiveId(activeId === l.id ? "" : l.id)}
                        title="查看/收起分析结果"
                      >
                        {a.summary.total > 0 ? `${a.summary.total} 冲突` : "无冲突"}
                      </button>
                    ) : null}
                    <button
                      className="pp-btn sm danger"
                      onClick={() => void onRemove(l.id, l.name)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* 分析结果 */}
        {activeAnalysis ? (
          <div className="pp-sec">
            <div className="pp-label">
              冲突结果 · {activeAnalysis.layer_name}
            </div>
            <div className="pcl-summary">
              <div className={"pcl-sum-card" + (activeAnalysis.summary.total ? " warn" : " ok")}>
                <b>{activeAnalysis.summary.total}</b>
                <span>冲突总数</span>
              </div>
              <div className="pcl-sum-card">
                <b>{activeAnalysis.summary.features_hit}</b>
                <span>涉及图斑</span>
              </div>
              <div className="pcl-sum-card">
                <b>{activeAnalysis.summary.relics_hit}</b>
                <span>涉及文物</span>
              </div>
            </div>
            {activeAnalysis.summary.total === 0 ? (
              <div className="pp-empty">
                该图层未压占任何文物本体范围 / 保护范围 / 建控地带
              </div>
            ) : (
              <>
                <div className="pcl-tip">
                  按压占面积排序;点击条目定位到图斑(红色闪烁)。
                  {activeAnalysis.truncated ? " 结果过多已截断。" : ""}
                </div>
                <div className="pcl-conflicts">
                  {activeAnalysis.conflicts.map((c, i) => (
                    <div
                      className="pcl-conflict"
                      key={i}
                      onClick={() => onConflictClick(c)}
                    >
                      <span className={"pcl-kind k-" + c.kind}>{KIND_LABEL[c.kind]}</span>
                      <div className="pcl-conflict-main">
                        <b>{c.relic_name || c.relic_code || "未知文物"}</b>
                        <span>{c.parcel_name}</span>
                      </div>
                      <em className="pcl-area">{fmtArea(c.overlap_m2)}</em>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
