import type { RelicScope, RelicSummary } from "../types";
import { rankCode } from "./dict";

const PROTECTED_RANKS = new Set(["1", "2", "3", "4"]);

export function isProtectedRelic(relic: RelicSummary): boolean {
  return PROTECTED_RANKS.has(rankCode(relic.heritage_level || ""));
}

export function relicInScope(relic: RelicSummary, scope: RelicScope): boolean {
  return scope === "all" || isProtectedRelic(relic);
}

export function filterRelicsByScope(
  relics: RelicSummary[],
  scope: RelicScope,
): RelicSummary[] {
  return scope === "all" ? relics : relics.filter(isProtectedRelic);
}

export function scopeLabel(scope: RelicScope): string {
  return scope === "all" ? "全部文物" : "文保单位";
}
