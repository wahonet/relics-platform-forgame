import { useEffect, useRef, useState } from "react";
import { useUIStore } from "../stores/uiStore";
import { useRelicsStore } from "../stores/relicsStore";
import { fetchWorklogDates } from "../api/worklog";
import type { WorklogItem } from "../types";
import { flyTo } from "../map/viewerRegistry";
// pdf.js loaded lazily below to keep bundle size of the main chunk smaller

interface PdfLib {
  getDocument: (url: string) => { promise: Promise<PdfDoc> };
  GlobalWorkerOptions: { workerSrc: string };
}
interface PdfDoc {
  numPages: number;
  getPage: (n: number) => Promise<PdfPage>;
}
interface PdfPage {
  getViewport: (opts: { scale: number }) => { width: number; height: number };
  render: (opts: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
  }) => { promise: Promise<void> };
}

let pdfLib: PdfLib | null = null;
async function loadPdf(): Promise<PdfLib> {
  if (pdfLib) return pdfLib;
  const mod = (await import("pdfjs-dist")) as unknown as PdfLib & {
    GlobalWorkerOptions: { workerSrc: string };
  };
  // Vite-bundled worker.
  const workerMod = (await import(
    "pdfjs-dist/build/pdf.worker.min.mjs?url"
  )) as { default: string };
  mod.GlobalWorkerOptions.workerSrc = workerMod.default;
  pdfLib = mod;
  return mod;
}

export function WorklogPanel() {
  const open = useUIStore((s) => s.worklogOpen);
  const date = useUIStore((s) => s.worklogDate);
  const setUI = useUIStore((s) => s.set);
  const allRelics = useRelicsStore((s) => s.all);

  const [items, setItems] = useState<WorklogItem[]>([]);
  const [info, setInfo] = useState<WorklogItem | null>(null);
  const [pdfDoc, setPdfDoc] = useState<PdfDoc | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const renderingRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    if (items.length === 0) {
      fetchWorklogDates()
        .then((d) => setItems(d.items || []))
        .catch(() => setItems([]));
    }
  }, [open, items.length]);

  useEffect(() => {
    if (!date) return;
    const found = items.find((it) => it.date === date) || null;
    setInfo(found);
    setPage(1);
    setPdfDoc(null);
    setTotalPages(0);
    if (found?.has_pdf && found.pdf_file) {
      loadPdf().then((lib) => {
        lib
          .getDocument(`/worklog-pdfs/${encodeURIComponent(found.pdf_file!)}`)
          .promise.then((doc) => {
            setPdfDoc(doc);
            setTotalPages(doc.numPages);
          })
          .catch(() => setPdfDoc(null));
      });
    }
  }, [date, items]);

  useEffect(() => {
    if (!pdfDoc || !canvasRef.current || !viewportRef.current) return;
    if (renderingRef.current) return;
    renderingRef.current = true;
    pdfDoc
      .getPage(page)
      .then((p) => {
        const containerWidth = (viewportRef.current?.clientWidth || 480) - 16;
        const original = p.getViewport({ scale: 1 });
        const scale = containerWidth / original.width;
        const v = p.getViewport({ scale });
        const c = canvasRef.current!;
        c.width = v.width;
        c.height = v.height;
        const ctx = c.getContext("2d")!;
        ctx.clearRect(0, 0, c.width, c.height);
        return p.render({ canvasContext: ctx, viewport: v }).promise;
      })
      .catch(() => undefined)
      .finally(() => {
        renderingRef.current = false;
      });
  }, [pdfDoc, page]);

  const close = () => setUI({ worklogOpen: false, worklogDate: null });

  const navDay = (dir: number) => {
    if (!date || items.length === 0) return;
    const idx = items.findIndex((it) => it.date === date);
    if (idx < 0) return;
    const ni = idx + dir;
    if (ni >= 0 && ni < items.length) {
      setUI({ worklogDate: items[ni].date });
    }
  };

  const findRelic = (name: string) => {
    let r = allRelics.find((x) => x.name === name);
    if (!r) {
      r = allRelics.find(
        (x) => x.name && (x.name.includes(name) || name.includes(x.name)),
      );
    }
    return r && r.center_lat ? r : null;
  };

  const buildRelicLinks = (namesStr: string) => {
    const names = namesStr.split(/[、，,]/).map((s) => s.trim()).filter(Boolean);
    return names.map((name, i) => {
      const r = findRelic(name);
      return r ? (
        <span
          key={i}
          className="wl-relic-link"
          onClick={() => {
            flyTo(r.center_lng!, r.center_lat!, 800);
            setUI({ selectedRelic: r, worklogOpen: false });
          }}
        >
          {name}
        </span>
      ) : (
        <span key={i} className="wl-relic-nolink">
          {name}
        </span>
      );
    });
  };

  if (!open) return null;

  return (
    <div className={"worklog-panel open"}>
      <div className="wl-header">
        <div className="wl-title-group">
          <h3 className="wl-title">工作日志</h3>
          <span className="wl-date">{date || "—"}</span>
        </div>
        <div className="wl-nav">
          <button className="wl-nav-btn" title="前一天" onClick={() => navDay(-1)}>
            ◀
          </button>
          <button className="wl-nav-btn" title="后一天" onClick={() => navDay(1)}>
            ▶
          </button>
          <button className="wl-close-btn" onClick={close}>×</button>
        </div>
      </div>
      {info ? (
        <>
          <div className="wl-ledger">
            {info.township ? (
              <div className="wl-row">
                <span className="wl-label">普查镇街</span>
                <span className="wl-val">{info.township}</span>
              </div>
            ) : null}
            {info.villages ? (
              <div className="wl-row">
                <span className="wl-label">普查村庄</span>
                <span className="wl-val">{info.villages}</span>
              </div>
            ) : null}
            {info.participants ? (
              <div className="wl-row">
                <span className="wl-label">参加人员</span>
                <span className="wl-val">{info.participants}</span>
              </div>
            ) : null}
            {info.review_count ? (
              <div className="wl-relic-inline">
                <span className="wl-relic-tag">复核 <b>{info.review_count}</b></span>
                {info.review_names ? buildRelicLinks(info.review_names) : null}
              </div>
            ) : null}
            {info.new_count ? (
              <div className="wl-relic-inline">
                <span className="wl-relic-tag wl-stat-new">
                  新发现线索 <b>{info.new_count}</b>
                </span>
                {info.new_names ? buildRelicLinks(info.new_names) : null}
              </div>
            ) : null}
          </div>

          {info.has_pdf ? (
            <>
              <div className="wl-pdf-toolbar">
                <button
                  className="wl-page-btn"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  ‹ 上一页
                </button>
                <span className="wl-page-info">
                  {totalPages > 0 ? `${page} / ${totalPages}` : "加载中..."}
                </span>
                <button
                  className="wl-page-btn"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  下一页 ›
                </button>
              </div>
              <div className="wl-pdf-viewport" ref={viewportRef}>
                <canvas ref={canvasRef} />
              </div>
            </>
          ) : (
            <div className="wl-no-pdf">该日期无 PDF 工作日志</div>
          )}
        </>
      ) : (
        <div className="wl-no-pdf">未选择日期或加载中...</div>
      )}
    </div>
  );
}
