import { create } from "zustand";
import type { HomeView } from "../types";

const KEY = "relics.homeView";

function readFromStorage(): HomeView | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (typeof obj?.lng === "number" && typeof obj?.lat === "number") {
      return {
        lng: obj.lng,
        lat: obj.lat,
        h: obj.h || 75000,
        city: obj.city,
        county: obj.county,
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

interface HomeViewState {
  view: HomeView | null;
  setView: (v: HomeView | null) => void;
  clear: () => void;
}

export const useHomeViewStore = create<HomeViewState>((set) => ({
  view: readFromStorage(),
  setView(v) {
    if (v) {
      localStorage.setItem(KEY, JSON.stringify(v));
    } else {
      localStorage.removeItem(KEY);
    }
    set({ view: v });
  },
  clear() {
    localStorage.removeItem(KEY);
    set({ view: null });
  },
}));
