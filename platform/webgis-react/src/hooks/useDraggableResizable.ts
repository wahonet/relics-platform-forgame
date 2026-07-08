import { useCallback, useEffect, useRef, useState } from "react";

export interface PanelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const STORAGE_KEY = "infoPanelRect";
const DEFAULT_W = 420;
const MIN_W = 300;
const MIN_H = 240;
const FLOAT_GAP = 10;

function hdrH(): number {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--hdr").trim();
  return parseInt(v, 10) || 52;
}

function tbarH(): number {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--tbar").trim();
  return parseInt(v, 10) || 42;
}

function topBound(): number {
  return hdrH() + tbarH() + FLOAT_GAP;
}

function loadRect(): PanelRect | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as PanelRect;
    if (typeof r.x === "number" && typeof r.y === "number"
      && typeof r.w === "number" && typeof r.h === "number") return r;
  } catch {
    /* ignore */
  }
  return null;
}

function saveRect(r: PanelRect): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(r));
  } catch {
    /* ignore */
  }
}

function defaultRect(): PanelRect {
  const w = DEFAULT_W;
  const top = topBound();
  return {
    x: Math.max(FLOAT_GAP, window.innerWidth - w - 14),
    y: top,
    w,
    h: Math.min(window.innerHeight - top - FLOAT_GAP, 560),
  };
}

function clampRect(r: PanelRect): PanelRect {
  const top = topBound();
  const maxH = window.innerHeight - top - FLOAT_GAP;
  const maxW = window.innerWidth - FLOAT_GAP * 2;
  const w = Math.max(MIN_W, Math.min(r.w, maxW));
  const h = Math.max(MIN_H, Math.min(r.h, maxH));
  return {
    w,
    h,
    x: Math.max(FLOAT_GAP, Math.min(r.x, window.innerWidth - w - FLOAT_GAP)),
    y: Math.max(top, Math.min(r.y, window.innerHeight - h - FLOAT_GAP)),
  };
}

/** 详情面板拖动 + 右下角缩放,位置/尺寸持久化到 localStorage。 */
export function useDraggableResizable(active: boolean) {
  const [rect, setRect] = useState<PanelRect>(() => clampRect(loadRect() ?? defaultRect()));
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const resizeRef = useRef<{ sx: number; sy: number; ow: number; oh: number } | null>(null);

  const clamp = useCallback((r: PanelRect) => clampRect(r), []);

  useEffect(() => {
    if (!active) return;
    const onMove = (e: MouseEvent) => {
      if (dragRef.current) {
        const d = dragRef.current;
        setRect((prev) => clamp({
          ...prev,
          x: d.ox + e.clientX - d.sx,
          y: d.oy + e.clientY - d.sy,
        }));
      } else if (resizeRef.current) {
        const rs = resizeRef.current;
        setRect((prev) => clamp({
          ...prev,
          w: rs.ow + e.clientX - rs.sx,
          h: rs.oh + e.clientY - rs.sy,
        }));
      }
    };
    const onUp = () => {
      if (!dragRef.current && !resizeRef.current) return;
      dragRef.current = null;
      resizeRef.current = null;
      setRect((prev) => {
        const next = clamp(prev);
        saveRect(next);
        return next;
      });
    };
    // 浏览器窗口缩小后,把面板拉回视口内
    const onWinResize = () => setRect((prev) => clamp(prev));
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("resize", onWinResize);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("resize", onWinResize);
    };
  }, [active, clamp]);

  const onDragStart = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: rect.x, oy: rect.y };
  };

  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { sx: e.clientX, sy: e.clientY, ow: rect.w, oh: rect.h };
  };

  const panelStyle: React.CSSProperties = {
    left: rect.x,
    top: rect.y,
    width: rect.w,
    height: rect.h,
    right: "auto",
    maxHeight: "none",
  };

  return { panelStyle, onDragStart, onResizeStart };
}
