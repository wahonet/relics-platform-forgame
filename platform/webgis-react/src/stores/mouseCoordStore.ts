import { create } from "zustand";

interface MouseCoordState {
  /** WGS84 经纬度. null 表示鼠标不在地球面上 (空中 / 地图外)。 */
  lng: number | null;
  lat: number | null;
  /** 椭球高 (m), 仅当地形启用 + 命中时有意义。 */
  height: number | null;
  set: (lng: number | null, lat: number | null, height: number | null) => void;
}

export const useMouseCoordStore = create<MouseCoordState>((set) => ({
  lng: null,
  lat: null,
  height: null,
  set: (lng, lat, height) => set({ lng, lat, height }),
}));
