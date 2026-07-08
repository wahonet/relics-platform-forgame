import * as Cesium from "cesium";
import { fetchByBbox } from "../api/relics";
import type { PointRenderer } from "./PointRenderer";
import type { BackendFilters, BboxRelic } from "../types";

const MAX_CACHE = 32;
const DEBOUNCE_MS = 300;
const COORD_DECIMALS = 5;

export class ViewportManager {
  private viewer: Cesium.Viewer;
  private renderer: PointRenderer;
  private filters: BackendFilters = {};
  private cache = new Map<string, BboxRelic[]>();
  private lastURL: string | null = null;
  private moveEndCallback?: () => void;
  private onUpdated?: (count: number, truncated: boolean) => void;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(viewer: Cesium.Viewer, renderer: PointRenderer) {
    this.viewer = viewer;
    this.renderer = renderer;
  }

  start(onUpdated?: (count: number, truncated: boolean) => void) {
    this.onUpdated = onUpdated;
    this.stopped = false;
    this.moveEndCallback = () => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => this.refresh(), DEBOUNCE_MS);
    };
    this.viewer.camera.moveEnd.addEventListener(this.moveEndCallback);
    this.refresh();
  }

  stop() {
    this.stopped = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
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

  private currentBBox() {
    let west: number, south: number, east: number, north: number;
    const rect = this.viewer.camera.computeViewRectangle();
    if (rect) {
      west = Cesium.Math.toDegrees(rect.west);
      south = Cesium.Math.toDegrees(rect.south);
      east = Cesium.Math.toDegrees(rect.east);
      north = Cesium.Math.toDegrees(rect.north);
    } else {
      // SCENE2D + WebMercatorProjection 下 computeViewRectangle() 会返回
      // undefined,退回画布四角 pickEllipsoid 求视口范围。
      const corners = this.pickCornersBBox();
      if (!corners) return null;
      ({ west, south, east, north } = corners);
    }
    if (![west, south, east, north].every(isFinite)) return null;
    if (west >= east || south >= north) return null;
    return {
      min_lng: parseFloat(Math.max(west, -180).toFixed(COORD_DECIMALS)),
      min_lat: parseFloat(Math.max(south, -90).toFixed(COORD_DECIMALS)),
      max_lng: parseFloat(Math.min(east, 180).toFixed(COORD_DECIMALS)),
      max_lat: parseFloat(Math.min(north, 90).toFixed(COORD_DECIMALS)),
    };
  }

  /** 画布四角 pickEllipsoid 兜底求视口 bbox(2D 场景专用)。 */
  private pickCornersBBox() {
    const canvas = this.viewer.scene.canvas;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return null;
    const ellipsoid = this.viewer.scene.globe.ellipsoid;
    const lngs: number[] = [];
    const lats: number[] = [];
    for (const [x, y] of [[0, 0], [w, 0], [0, h], [w, h]]) {
      const cart = this.viewer.camera.pickEllipsoid(
        new Cesium.Cartesian2(x, y),
        ellipsoid,
      );
      if (!cart) return null;
      const c = Cesium.Cartographic.fromCartesian(cart, ellipsoid);
      lngs.push(Cesium.Math.toDegrees(c.longitude));
      lats.push(Cesium.Math.toDegrees(c.latitude));
    }
    return {
      west: Math.min(...lngs),
      south: Math.min(...lats),
      east: Math.max(...lngs),
      north: Math.max(...lats),
    };
  }

  async refresh() {
    if (this.stopped || this.viewer.isDestroyed()) return;
    const bbox = this.currentBBox();
    if (!bbox) return;
    // 后端默认 limit=2000,整市视角会截断一半点位;显式提到上限 5000,
    // PointPrimitive 渲染几千个点毫无压力。
    const params = { ...bbox, limit: 5000, ...this.filters };
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
      // await 期间组件可能已卸载,渲染前再查一次
      if (this.stopped) return;
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
