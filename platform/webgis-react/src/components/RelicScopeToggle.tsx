import { useMemo } from "react";
import { useCatalogScopeStore } from "../stores/catalogScopeStore";
import { useFilterStore } from "../stores/filterStore";
import { usePatrolStore } from "../stores/patrolStore";
import { useRelicsStore } from "../stores/relicsStore";
import { useParcelStore } from "../stores/parcelStore";
import { useUIStore } from "../stores/uiStore";
import { rankCode } from "../utils/dict";
import { isProtectedRelic, scopeLabel } from "../utils/relicScope";
import type { RelicScope } from "../types";

/** 切换业务口径的完整副作用(摘要卡片与顶栏切换共用)。 */
export function applyRelicScope(next: RelicScope): void {
  const { scope, setScope } = useCatalogScopeStore.getState();
  if (next === scope) return;

  // 切回文保单位时移除与该口径冲突的“未核定”级别筛选。
  if (next === "protected") {
    const fs = useFilterStore.getState();
    const statFilters = { ...fs.statFilters };
    if (rankCode(statFilters.heritage_level || "") === "5") {
      delete statFilters.heritage_level;
    }
    fs.setPartial({
      level: rankCode(fs.level || "") === "5" ? "" : fs.level,
    });
    fs.setStatFilters(statFilters);
  }

  setScope(next);
  useUIStore.getState().set({ selectedRelic: null });
  // 未保存路线必须随口径清空，避免隐藏的未定级点混入文保路线。
  usePatrolStore.getState().resetAll();
  useParcelStore.getState().resetAnalyses();
  useUIStore.getState().showToast("已切换为“" + scopeLabel(next) + "”数据口径");
}

export function RelicScopeToggle({ compact = false }: { compact?: boolean }) {
  const scope = useCatalogScopeStore((s) => s.scope);
  const allRelics = useRelicsStore((s) => s.all);
  const counts = useMemo(() => {
    const protectedTotal = allRelics.filter(isProtectedRelic).length;
    return { protected: protectedTotal, all: allRelics.length };
  }, [allRelics]);

  return (
    <div
      className={"relic-scope-toggle" + (compact ? " compact" : "")}
      role="group"
      aria-label="文物数据范围"
    >
      <button
        type="button"
        className={scope === "protected" ? "on" : ""}
        aria-pressed={scope === "protected"}
        onClick={() => applyRelicScope("protected")}
      >
        文保单位{compact ? "" : " " + counts.protected}
      </button>
      <button
        type="button"
        className={scope === "all" ? "on" : ""}
        aria-pressed={scope === "all"}
        onClick={() => applyRelicScope("all")}
      >
        全部文物{compact ? "" : " " + counts.all}
      </button>
    </div>
  );
}
