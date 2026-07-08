import { useEffect, useState } from "react";
import { useUIStore } from "../stores/uiStore";
import { fetchPhotos, fetchDrawings, fetchRelicDetail } from "../api/relics";
import { fetchRelicArchives } from "../api/stats";
import type { Drawing, Photo, RelicSummary, RelicArchives } from "../types";
import { COND_CLS } from "../utils/dict";
import { Lightbox } from "./Lightbox";
import { useDraggableResizable } from "../hooks/useDraggableResizable";

type TabKey = "info" | "photo" | "draw" | "intro";

export function InfoPanel() {
  const selected = useUIStore((s) => s.selectedRelic);
  const setUI = useUIStore((s) => s.set);
  const [tab, setTab] = useState<TabKey>("info");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [intro, setIntro] = useState<string>("");
  const [archives, setArchives] = useState<RelicArchives | null>(null);
  const [loadingPhotos, setLoadingPhotos] = useState(false);
  const [loadingDrawings, setLoadingDrawings] = useState(false);
  const [loadingIntro, setLoadingIntro] = useState(false);
  const [lightbox, setLightbox] = useState<{ urls: string[]; captions: string[]; index: number } | null>(
    null,
  );
  const { panelStyle, onDragStart, onResizeStart } = useDraggableResizable(!!selected);

  useEffect(() => {
    if (!selected?.archive_code) return;
    setTab("info");
    setPhotos([]);
    setDrawings([]);
    setIntro("");
    setArchives(null);
    const code = selected.archive_code;
    setLoadingPhotos(true);
    fetchPhotos(code)
      .then(setPhotos)
      .catch(() => setPhotos([]))
      .finally(() => setLoadingPhotos(false));
    setLoadingDrawings(true);
    fetchDrawings(code)
      .then(setDrawings)
      .catch(() => setDrawings([]))
      .finally(() => setLoadingDrawings(false));
    setLoadingIntro(true);
    fetchRelicDetail(code)
      .then((full) => setIntro(full.intro || ""))
      .catch(() => setIntro(""))
      .finally(() => setLoadingIntro(false));
    if (selected.has_archive_spu || selected.has_archive_fpu) {
      fetchRelicArchives(code)
        .then(setArchives)
        .catch(() => setArchives(null));
    }
  }, [selected?.archive_code, selected?.has_archive_spu, selected?.has_archive_fpu]);

  if (!selected) return null;

  const r: RelicSummary = selected;
  const ccls = r.condition_level ? COND_CLS[r.condition_level] || "" : "";

  const open3D = () => {
    if (!r.has_3d) return;
    const folder = (r.model_3d_path || "").replace(/^Get3D\//, "");
    const params = new URLSearchParams({
      folder,
      name: r.name,
      lat: String(r.center_lat ?? 0),
      lng: String(r.center_lng ?? 0),
      alt: String(r.center_alt ?? 0),
    });
    window.open(`#/model-viewer?${params.toString()}`, "_blank");
  };

  const openArchive = (url: string, label: string) => {
    const params = new URLSearchParams({ url, name: `${r.name} · ${label}` });
    window.open(`#/pdf-viewer?${params.toString()}`, "_blank");
  };

  return (
    <>
      <div className="info-panel" style={panelStyle}>
        <div className="pi-hdr" onMouseDown={onDragStart} title="拖动标题栏移动面板">
          <h2>{r.name || "-"}</h2>
          <button className="pi-close" onClick={() => setUI({ selectedRelic: null })}>
            ×
          </button>
        </div>
        <div className="pi-tabs">
          {(
            [
              ["info", "基本信息"],
              ["photo", "照片"],
              ["draw", "图纸"],
              ["intro", "简介"],
            ] as [TabKey, string][]
          ).map(([k, label]) => (
            <button
              key={k}
              className={"pi-tab" + (tab === k ? " on" : "")}
              onClick={() => setTab(k)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="pi-body">
        {tab === "info" && (
          <div className="tc">
            <div className="info-tags">
              {r.era ? <span className="tag tag-era">{r.era}</span> : null}
              {r.category_main ? <span className="tag tag-cat">{r.category_main}</span> : null}
              {r.heritage_level && r.heritage_level.length < 20 ? (
                <span className="tag tag-lv">{r.heritage_level}</span>
              ) : null}
              {r.has_3d ? <span className="tag tag-3d">三维模型</span> : null}
              {r.has_boundary ? <span className="tag tag-bnd">两线范围</span> : null}
            </div>
            <Row label="编号" value={r.archive_code} />
            <Row label="年代" value={r.era} />
            <Row
              label="类别"
              value={
                (r.category_main || "") + (r.category_sub ? " / " + r.category_sub : "")
              }
            />
            <Row label="级别" value={r.heritage_level} />
            <Row label="县市区" value={r.county} />
            <Row label="乡镇" value={r.township} />
            <Row label="地址" value={r.address} />
            <Row
              label="保存状况"
              valueNode={<span className={ccls}>{r.condition_level || "-"}</span>}
            />
            <Row label="照片" value={`${r.photo_count || 0} 张`} />
            <Row label="图纸" value={`${r.drawing_count || 0} 张`} />
            {r.has_boundary ? (
              <div className="pi-bnd-tip">
                两线范围已叠加在地图上:<i className="bnd-p" />保护范围
                <i className="bnd-c" />建设控制地带
              </div>
            ) : null}

            {(r.has_3d || archives) && (
              <div className="pi-action-bar">
                {r.has_3d && (
                  <button className="pi-act-btn pi-btn-3d" onClick={open3D}>
                    <svg viewBox="0 0 24 24">
                      <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                    </svg>
                    3D
                  </button>
                )}
                {archives?.sanpu?.length ? (
                  <button
                    className="pi-act-btn pi-btn-pdf"
                    onClick={() => openArchive(archives.sanpu[0], "三普档案")}
                  >
                    <svg viewBox="0 0 24 24">
                      <path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zM6 20V4h7v5h5v11H6zm2-6h8v2H8v-2zm0-3h8v2H8v-2zm0 6h5v2H8v-2z" />
                    </svg>
                    三普档案
                  </button>
                ) : null}
                {archives?.sipu?.length ? (
                  <button
                    className="pi-act-btn pi-btn-pdf"
                    onClick={() => openArchive(archives.sipu[0], "四普档案")}
                  >
                    <svg viewBox="0 0 24 24">
                      <path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zM6 20V4h7v5h5v11H6zm2-6h8v2H8v-2zm0-3h8v2H8v-2zm0 6h5v2H8v-2z" />
                    </svg>
                    四普档案
                  </button>
                ) : null}
              </div>
            )}
          </div>
        )}
        {tab === "photo" && (
          <div className="tc">
            {loadingPhotos ? (
              <div className="empty-tip">加载中...</div>
            ) : photos.length === 0 ? (
              <div className="empty-tip">暂无照片</div>
            ) : (
              <div className="pg">
                {photos.map((p, i) => (
                  <div
                    key={i}
                    className="pt"
                    onClick={() =>
                      setLightbox({
                        urls: photos.map((x) => `/photos/${x.relative_path}`),
                        captions: photos.map((x) => x.description || x.photo_no || ""),
                        index: i,
                      })
                    }
                  >
                    <img src={`/photos/${p.relative_path}`} loading="lazy" alt="" />
                    <div className="pl">{p.description || p.photo_no || ""}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {tab === "draw" && (
          <div className="tc">
            {loadingDrawings ? (
              <div className="empty-tip">加载中...</div>
            ) : drawings.length === 0 ? (
              <div className="empty-tip">暂无图纸</div>
            ) : (
              <div className="pg">
                {drawings.map((d, i) => (
                  <div
                    key={i}
                    className="pt"
                    onClick={() =>
                      setLightbox({
                        urls: drawings.map((x) => `/drawings/${x.relative_path}`),
                        captions: drawings.map((x) => x.drawing_no || x.drawing_name || "图纸"),
                        index: i,
                      })
                    }
                  >
                    <img src={`/drawings/${d.relative_path}`} loading="lazy" alt="" />
                    <div className="pl">{d.drawing_no || d.drawing_name || "图纸"}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {tab === "intro" && (
          <div className="tc">
            {loadingIntro ? (
              <div className="empty-tip">加载中...</div>
            ) : intro ? (
              <div className="intro-text">{intro}</div>
            ) : (
              <div className="empty-tip">暂无简介</div>
            )}
          </div>
        )}
        </div>
        <div
          className="pi-resize"
          onMouseDown={onResizeStart}
          title="拖动调整大小"
          aria-hidden
        />
      </div>
      {lightbox ? (
        <Lightbox
          urls={lightbox.urls}
          captions={lightbox.captions}
          index={lightbox.index}
          onChangeIndex={(i) => setLightbox({ ...lightbox, index: i })}
          onClose={() => setLightbox(null)}
        />
      ) : null}
    </>
  );
}

function Row({
  label,
  value,
  valueNode,
}: {
  label: string;
  value?: string | number | null;
  valueNode?: React.ReactNode;
}) {
  return (
    <div className="ir">
      <div className="ir-l">{label}</div>
      <div className="ir-v">
        {valueNode != null ? valueNode : value != null && value !== "" ? value : "—"}
      </div>
    </div>
  );
}
