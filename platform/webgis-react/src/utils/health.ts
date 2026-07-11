/**
 * 文物健康度评估(纯前端聚合,评分规则透明可解释)。
 *
 * 健康分 = 100 - 保存状况扣分 - 巡查状态扣分 - 天气临时风险扣分。
 * 分级:≥80 良好(绿) / 55~79 需关注(黄) / <55 风险(红)。
 */
import type { RelicSummary } from "../types";
import type { WeatherDay } from "../api/weather";
import { rankCode } from "./dict";

export type HealthLevel = "good" | "watch" | "risk";
export type WeatherRisk = "normal" | "watch" | "alert";

export interface HealthInfo {
  score: number;
  level: HealthLevel;
  /** 扣分原因(风险清单展示用)。 */
  reasons: string[];
}

export const HEALTH_COLOR: Record<HealthLevel, string> = {
  good: "#4cc38a",
  watch: "#d9a62e",
  risk: "#f16a5e",
};

export const HEALTH_LABEL: Record<HealthLevel, string> = {
  good: "良好",
  watch: "需关注",
  risk: "风险",
};

const CONDITION_PENALTY: Record<string, number> = {
  好: 0,
  较好: 8,
  一般: 22,
  较差: 40,
  差: 55,
};

/** 巡查周期阈值(天),级别越高要求越勤。 */
function patrolThresholdDays(heritageLevel: string | undefined): number {
  const rank = rankCode(heritageLevel);
  if (rank === "1") return 90;
  if (rank === "2") return 120;
  return 180;
}

/** last_patrol_at 时间戳 → 距今天数(兼容秒/毫秒)。 */
function daysSince(timestamp: number, now: number): number {
  const ms = timestamp > 1e12 ? timestamp : timestamp * 1000;
  return Math.floor((now - ms) / 86_400_000);
}

export function computeHealth(
  r: RelicSummary,
  weatherRisk: WeatherRisk = "normal",
  now = Date.now(),
): HealthInfo {
  let score = 100;
  const reasons: string[] = [];

  const condition = r.condition_level || "";
  if (condition in CONDITION_PENALTY) {
    const penalty = CONDITION_PENALTY[condition];
    if (penalty > 0) {
      score -= penalty;
      reasons.push(`保存状况${condition}`);
    }
  } else {
    score -= 15;
    reasons.push("保存状况未评估");
  }

  const threshold = patrolThresholdDays(r.heritage_level);
  if (r.last_patrol_at == null) {
    score -= 18;
    reasons.push("从未巡查");
  } else {
    const days = daysSince(r.last_patrol_at, now);
    if (days > threshold) {
      score -= 15;
      reasons.push(`巡查超期 ${days - threshold} 天`);
    }
  }

  // 恶劣天气对本就脆弱的文物构成临时性风险
  const fragile = condition === "较差" || condition === "差";
  if (fragile && weatherRisk === "alert") {
    score -= 12;
    reasons.push("恶劣天气预警");
  } else if (fragile && weatherRisk === "watch") {
    score -= 6;
    reasons.push("天气风险关注");
  }

  score = Math.max(0, Math.min(100, score));
  const level: HealthLevel = score >= 80 ? "good" : score >= 55 ? "watch" : "risk";
  return { score, level, reasons };
}

/** 从天气预报里取"今天"的风险级别(找不到按 normal)。 */
export function todayWeatherRisk(
  days: WeatherDay[] | undefined,
  timezone: string | undefined,
): WeatherRisk {
  if (!days?.length) return "normal";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone || "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: string) => parts.find((p) => p.type === type)?.value || "";
  const today = `${value("year")}-${value("month")}-${value("day")}`;
  const day = days.find((d) => d.date === today);
  if (!day) return "normal";
  return day.risk_level === "alert" ? "alert" : day.risk_level === "watch" ? "watch" : "normal";
}
