import * as Cesium from "cesium";
import { fetchByBbox } from "../api/relics";
import type { PointRenderer } from "./PointRenderer";
import type { BackendFilters, BboxRelic } from "../types";

const MAX_CACHE = 32;
const DEBOUNCE_MS = 300;
const COORD_DECIMALS = 5;

function debounce<F extends (...args: unknown[]) => void>(fn: F, ms: number) {
  let t: ReturnType<typeof setTimeout> | null = null;
  return function (this: unknown, ...args: Parameters<F>) {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

export class ViewportManager {
  private viewer: Cesium.Viewer;
  private renderer: PointRenderer;
  private filters: BackendFilters = {};
  private cache = new Map<string, BboxRelic[]>();
  private lastURL: string | null = null;
  private moveEndCallback?: () => void;
  private onUpdated?: (count: number, truncated: boolean) => void;

  constructor(viewer: Cesium.Viewer, renderer: PointRenderer) {
    this.viewer = viewer;
    this.renderer = renderer;
  }

  start(onUpdated?: (count: number, truncated: boolean) => void) {
    this.onUpdated = onUpdated;
    const debounced = debounce(() => this.refresh(), DEBOUNCE_MS);
    this.moveEndCallback = debounced as unknown as () => void;
    this.viewer.camera.moveEnd.addEventListener(this.moveEndCallback);
    this.refresh();
  }

  stop() {
    // viewer 可能已被父级 hook 的 cleanup 提前销毁,这里要静默兜底,
    // 否则会抛 "Cannot read properties of undefined (reading 'scene')"。
    if (this.moveEndCallback) {
      try {
        if (!this.viewer.isDestroyed()) {
          this.viewer.camera.moveEnd.removeEventListener(this.moveEndCallback);
        }
      } catch {
        /* viewer 已销毁,忽略 */
      }
      this.moveEndCallback = undefined;
    }
  }

  setFilters(filters: BackendFilters) {
    this.filters = { ...filters };
    this.cache.clear();
    this.refresh();
  }

  clearFilters() {
    this.setFilters({});
  }

  private currentBBox() {
    const rect = this.viewer.camera.computeViewRectangle();
    if (!rect) return null;
    const west = Cesium.Math.toDegrees(rect.west);
    const south = Cesium.Math.toDegrees(rect.south);
    const east = Cesium.Math.toDegrees(rect.east);
    const north = Cesium.Math.toDegrees(rect.north);
    if (!isFinite(west) || !isFinite(east)) return null;
    return {
      min_lng: parseFloat(west.toFixed(COORD_DECIMALS)),
      min_lat: parseFloat(south.toFixed(COORD_DECIMALS)),
      max_lng: parseFloat(east.toFixed(COORD_DECIMALS)),
      max_lat: parseFloat(north.toFixed(COORD_DECIMALS)),
    };
  }

  async refresh() {
    const bbox = this.currentBBox();
    if (!bbox) return;
    const params = { ...bbox, ...this.filters };
    const qs = new URLSearchParams(
      Object.entries(params)
        .filter(([, v]) => v != null && v !== "")
        .map(([k, v]) => [k, String(v)]),
    ).toString();
    const url = `/api/relics/by-bbox?${qs}`;

    if (url === this.lastURL && this.cache.has(url)) {
      this.renderer.diffUpdate(this.cache.get(url) || []);
      return;
    }
    this.lastURL = url;

    const cached = this.cache.get(url);
    if (cached) {
      this.renderer.diffUpdate(cached);
      this.cache.delete(url);
      this.cache.set(url, cached);
      return;
    }

    try {
      const body = await fetchByBbox(params);
      const data = body.data || [];
      this.cache.set(url, data);
      if (this.cache.size > MAX_CACHE) {
        const firstKey = this.cache.keys().next().value;
        if (firstKey !== undefined) this.cache.delete(firstKey);
      }
      if (this.lastURL === url) {
        this.renderer.diffUpdate(data);
        this.onUpdated?.(data.length, !!body.truncated);
      }
    } catch (e) {
      console.warn("[Viewport] 查询失败:", e);
    }
  }
}
