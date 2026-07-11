/**
 * 年代时间轴("文脉演变"演示模式)。
 *
 * 激活后按 ERA_ORDER 选择一个年代档,地图与统计只显示
 * "该年代及更早"的文物(累积点亮);拖到最后一档 = 全部(含未知年代)。
 */
import { create } from "zustand";
import { ERA_ORDER, DIMS, dimValue } from "../utils/dict";
import type { RelicSummary } from "../types";

interface TimelineState {
  active: boolean;
  /** 当前年代档(ERA_ORDER 下标),累积含 ≤ index 的所有年代。 */
  index: number;
  playing: boolean;
  toggle: () => void;
  close: () => void;
  setIndex: (index: number) => void;
  setPlaying: (playing: boolean) => void;
}

export const useTimelineStore = create<TimelineState>((set, get) => ({
  active: false,
  index: ERA_ORDER.length - 1,
  playing: false,
  toggle() {
    const next = !get().active;
    set({ active: next, playing: false, index: next ? 0 : ERA_ORDER.length - 1 });
  },
  close() {
    set({ active: false, playing: false, index: ERA_ORDER.length - 1 });
  },
  setIndex(index) {
    set({ index: Math.max(0, Math.min(ERA_ORDER.length - 1, index)) });
  },
  setPlaying(playing) {
    set({ playing });
  },
}));

const eraDim = DIMS.find((d) => d.id === "era");

/** 时间轴当前档是否为"全部"(最后一档含未知年代)。 */
export function timelineShowsAll(index: number): boolean {
  return index >= ERA_ORDER.length - 1;
}

/** 累积允许的展示年代集合(ERA_ORDER 前 index+1 个)。 */
export function timelineEras(index: number): string[] {
  return ERA_ORDER.slice(0, index + 1);
}

/** 一条文物是否落在时间轴当前档内(展示年代 ≤ 选中档)。 */
export function relicInTimeline(r: RelicSummary, index: number): boolean {
  if (timelineShowsAll(index) || !eraDim) return true;
  const era = dimValue(r as unknown as Record<string, unknown>, eraDim);
  return timelineEras(index).includes(era);
}
