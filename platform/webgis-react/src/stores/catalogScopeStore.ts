import { create } from "zustand";
import type { RelicScope } from "../types";

interface CatalogScopeState {
  /** 当前业务口径；与资料丰富度 tier=city/full 完全独立。 */
  scope: RelicScope;
  setScope: (scope: RelicScope) => void;
}

export const useCatalogScopeStore = create<CatalogScopeState>((set) => ({
  scope: "protected",
  setScope: (scope) => set({ scope }),
}));
