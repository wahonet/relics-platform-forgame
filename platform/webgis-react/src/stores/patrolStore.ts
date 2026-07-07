import { create } from "zustand";
import type { PatrolStop, PlanSuggestion } from "../types";

/**
 * 巡查规划状态。
 *
 * - picking=true 时地图点击文物点会加入 stops(而不是打开详情面板)。
 * - preview 是"待保存"的路线几何(AI 方案或手选点后端算出的线),
 *   由 RouteLayer 监听渲染;保存成功后转为正式路线。
 */
export interface PatrolStartPoint {
  lng: number;
  lat: number;
  name: string;
}

interface PatrolState {
  /** 地图选点模式(巡查面板打开时默认开启)。 */
  picking: boolean;
  /** 地图选起点模式:开启时点击地图任意位置设为出发点。 */
  pickingStart: boolean;
  /** 自定义出发点(可选,不设则从第一站出发)。 */
  startPoint: PatrolStartPoint | null;
  /** 手选/AI 生成的途经文物点(有序)。 */
  stops: PatrolStop[];
  /** 当前预览的路线折线([[lng,lat],...],高德或直线)。 */
  previewPolyline: [number, number][] | null;
  previewMeta: { distance_m: number; duration_s: number; source: string } | null;
  /** AI 方案列表(等待用户采纳)。 */
  suggestions: PlanSuggestion[];
  /** 采纳中的方案在 suggestions 中的下标,-1 表示手动组线。 */
  activeSuggestion: number;

  setPicking: (v: boolean) => void;
  setPickingStart: (v: boolean) => void;
  setStartPoint: (p: PatrolStartPoint | null) => void;
  addStop: (s: PatrolStop) => void;
  removeStop: (code: string) => void;
  moveStop: (code: string, dir: -1 | 1) => void;
  clearStops: () => void;
  setStops: (stops: PatrolStop[]) => void;
  setPreview: (
    polyline: [number, number][] | null,
    meta?: { distance_m: number; duration_s: number; source: string } | null,
  ) => void;
  setSuggestions: (s: PlanSuggestion[]) => void;
  adoptSuggestion: (idx: number) => void;
  resetAll: () => void;
}

export const usePatrolStore = create<PatrolState>((set, get) => ({
  picking: false,
  pickingStart: false,
  startPoint: null,
  stops: [],
  previewPolyline: null,
  previewMeta: null,
  suggestions: [],
  activeSuggestion: -1,

  setPicking(v) {
    set({ picking: v });
  },
  setPickingStart(v) {
    set({ pickingStart: v });
  },
  setStartPoint(p) {
    set({ startPoint: p, previewPolyline: null, previewMeta: null });
  },
  addStop(s) {
    const { stops } = get();
    if (stops.some((x) => x.code === s.code)) return;
    set({ stops: [...stops, s], previewPolyline: null, previewMeta: null, activeSuggestion: -1 });
  },
  removeStop(code) {
    set({
      stops: get().stops.filter((x) => x.code !== code),
      previewPolyline: null,
      previewMeta: null,
    });
  },
  moveStop(code, dir) {
    const stops = [...get().stops];
    const i = stops.findIndex((x) => x.code === code);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= stops.length) return;
    [stops[i], stops[j]] = [stops[j], stops[i]];
    set({ stops, previewPolyline: null, previewMeta: null });
  },
  clearStops() {
    set({ stops: [], previewPolyline: null, previewMeta: null, activeSuggestion: -1 });
  },
  setStops(stops) {
    set({ stops });
  },
  setPreview(polyline, meta = null) {
    set({ previewPolyline: polyline, previewMeta: meta });
  },
  setSuggestions(s) {
    set({ suggestions: s, activeSuggestion: -1 });
  },
  adoptSuggestion(idx) {
    const s = get().suggestions[idx];
    if (!s) return;
    set({
      activeSuggestion: idx,
      stops: s.stops,
      previewPolyline: s.polyline,
      previewMeta: { distance_m: s.distance_m, duration_s: s.duration_s, source: s.source },
    });
  },
  resetAll() {
    set({
      picking: false,
      pickingStart: false,
      startPoint: null,
      stops: [],
      previewPolyline: null,
      previewMeta: null,
      suggestions: [],
      activeSuggestion: -1,
    });
  },
}));
