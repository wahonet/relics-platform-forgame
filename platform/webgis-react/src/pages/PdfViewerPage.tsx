import { useEffect, useRef, useState } from "react";

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
  const workerMod = (await import(
    "pdfjs-dist/build/pdf.worker.min.mjs?url"
  )) as { default: string };
  mod.GlobalWorkerOptions.workerSrc = workerMod.default;
  pdfLib = mod;
  return mod;
}

function parseHashQuery(): URLSearchParams {
  const hash = window.location.hash || "";
  const idx = hash.indexOf("?");
  if (idx < 0) return new URLSearchParams();
  return new URLSearchParams(hash.slice(idx + 1));
}

export default function PdfViewerPage() {
  const params = parseHashQuery();
  const url = params.get("url") || "";
  const name = params.get("name") || "档案";
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [scale, setScale] = useState(1.2);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderingRef = useRef(false);

  useEffect(() => {
    document.title = `${name} — 档案查看器`;
  }, [name]);

  useEffect(() => {
    if (!url) return;
    setError(null);
    loadPdf()
      .then((lib) => lib.getDocument(url).promise)
      .then((d) => {
        setDoc(d);
        setTotal(d.numPages);
      })
      .catch((e) => setError(String(e)));
  }, [url]);

  useEffect(() => {
    if (!doc || !canvasRef.current) return;
    if (renderingRef.current) return;
    renderingRef.current = true;
    doc
      .getPage(page)
      .then((p) => {
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
  }, [doc, page, scale]);

  return (
    <div className="pdf-viewer-page">
      <div className="pdf-viewer-bar">
        <button onClick={() => window.close()}>← 关闭</button>
        <span style={{ marginRight: "auto", color: "var(--accent2)" }}>{name}</span>
        <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
          ‹ 上一页
        </button>
        <span>
          {page} / {total || "—"}
        </span>
        <button
          onClick={() => setPage((p) => Math.min(total, p + 1))}
          disabled={page >= total}
        >
          下一页 ›
        </button>
        <button onClick={() => setScale((s) => Math.max(0.4, s - 0.2))}>−</button>
        <span style={{ minWidth: 50, textAlign: "center" }}>
          {Math.round(scale * 100)}%
        </span>
        <button onClick={() => setScale((s) => Math.min(3, s + 0.2))}>+</button>
      </div>
      {error ? (
        <div className="center-loader" style={{ color: "var(--red)" }}>
          PDF 加载失败: {error}
        </div>
      ) : !doc ? (
        <div className="center-loader">
          <div className="spinner" /> 正在加载 PDF...
        </div>
      ) : (
        <div className="pdf-canvas-host">
          <canvas ref={canvasRef} />
        </div>
      )}
    </div>
  );
}
