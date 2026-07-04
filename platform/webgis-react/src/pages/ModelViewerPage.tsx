import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { ModelViewer, type MeasureInfo } from "../three/ModelViewer";

function parseHashQuery(): URLSearchParams {
  const hash = window.location.hash || "";
  const idx = hash.indexOf("?");
  if (idx < 0) return new URLSearchParams();
  return new URLSearchParams(hash.slice(idx + 1));
}

export default function ModelViewerPage() {
  const loc = useLocation();
  const [measureMode, setMeasureMode] = useState<"off" | "dist">("off");
  const [resetSignal, setResetSignal] = useState(0);
  const [measure, setMeasure] = useState<MeasureInfo | null>(null);

  const params = parseHashQuery();
  const folder = params.get("folder") || "";
  const name = params.get("name") || "三维模型";
  const lat = parseFloat(params.get("lat") || "0");
  const lng = parseFloat(params.get("lng") || "0");
  const alt = parseFloat(params.get("alt") || "0");

  useEffect(() => {
    document.title = `${name} — 三维模型查看器`;
  }, [name]);

  return (
    <div className="model-viewer-page">
      <div className="model-viewer-bar">
        <button onClick={() => window.close()}>← 关闭</button>
        <h3>{name}</h3>
        <button
          className={measureMode === "dist" ? "tb on" : "tb"}
          onClick={() => setMeasureMode((m) => (m === "dist" ? "off" : "dist"))}
        >
          测距
        </button>
        <button
          onClick={() => {
            setMeasure(null);
            setResetSignal((s) => s + 1);
          }}
        >
          清除
        </button>
        <button
          onClick={() => {
            window.location.reload();
          }}
        >
          重置视角
        </button>
      </div>
      {folder ? (
        <ModelViewer
          folder={folder}
          refLat={lat}
          refLng={lng}
          refAlt={alt}
          measureMode={measureMode}
          resetSignal={resetSignal}
          onMeasureChange={setMeasure}
        />
      ) : (
        <div className="center-loader">未指定模型 (folder=?)</div>
      )}
      {measure ? (
        <div
          style={{
            position: "fixed",
            bottom: 20,
            left: "50%",
            transform: "translateX(-50%)",
            background: "rgba(13,17,23,.94)",
            border: "1px solid rgba(88,166,255,.25)",
            borderRadius: 8,
            padding: "10px 16px",
            color: "#e6edf3",
            fontSize: 13,
          }}
        >
          直线距离: <b style={{ color: "#58a6ff" }}>{measure.dist.toFixed(2)}</b> m{" "}
          <span style={{ color: "#8b949e", marginLeft: 8 }}>
            (虚拟坐标系,实际尺度由 3D Tiles 数据集决定)
          </span>
        </div>
      ) : null}
      <div
        style={{
          position: "fixed",
          left: 16,
          bottom: 16,
          color: "#8b949e",
          fontSize: 11,
          background: "rgba(13,17,23,.85)",
          padding: "6px 12px",
          borderRadius: 6,
          pointerEvents: "none",
        }}
      >
        鼠标左键: 旋转 · 滚轮: 缩放 · 右键: 平移
      </div>
    </div>
  );
}
