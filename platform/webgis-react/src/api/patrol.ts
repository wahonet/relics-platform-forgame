import { apiClient } from "./client";
import type {
  PatrolDueItem,
  PatrolRoute,
  PatrolReport,
  PlanResponse,
  PatrolStats,
  RelicScope,
} from "../types";

export interface PatrolConfig {
  frequency_days: Record<string, number>;
  verify_radius_m: number;
  suspect_radius_m: number;
  amap_enabled: boolean;
  ai_enabled: boolean;
}

export async function fetchPatrolConfig(): Promise<PatrolConfig> {
  const { data } = await apiClient.get<PatrolConfig>("/api/patrol/config");
  return data;
}

export async function fetchPatrolDue(params?: {
  county?: string;
  only_overdue?: boolean;
  limit?: number;
  scope?: RelicScope;
}): Promise<{ data: PatrolDueItem[]; total: number }> {
  const qs = new URLSearchParams();
  if (params?.county) qs.set("county", params.county);
  if (params?.only_overdue) qs.set("only_overdue", "true");
  if (params?.limit) qs.set("limit", String(params.limit));
  qs.set("scope", params?.scope || "protected");
  const { data } = await apiClient.get(`/api/patrol/due?${qs}`);
  return data;
}

// 单日巡查上限 30 处:用户要求更多时按 30 截断
export async function planPatrol(
  text: string,
  maxStops = 30,
  scope: RelicScope = "protected",
): Promise<PlanResponse> {
  // LLM 解析 + 地理编码 + 驾车路径串行,全链路常超 1 分钟,
  // 默认 30s 超时会让规划必然失败,这里单独放宽。
  const { data } = await apiClient.post<PlanResponse>(
    "/api/patrol/plan",
    { text, max_stops: maxStops, scope },
    { timeout: 180000 },
  );
  return data;
}

export async function createRoute(body: {
  name: string;
  codes: string[];
  scope?: RelicScope;
  plan_date?: string;
  mode?: string;
  note?: string;
  optimize?: boolean;
  /** 自定义出发点(可选)。 */
  start?: { lng: number; lat: number; name?: string };
}): Promise<PatrolRoute> {
  const { data } = await apiClient.post<PatrolRoute>("/api/patrol/routes", body);
  return data;
}

export async function listRoutes(
  scope: RelicScope = "protected",
): Promise<PatrolRoute[]> {
  const { data } = await apiClient.get<{ data: PatrolRoute[] }>(
    "/api/patrol/routes",
    { params: { scope } },
  );
  return data.data || [];
}

export async function getRoute(id: number): Promise<PatrolRoute> {
  const { data } = await apiClient.get<PatrolRoute>(`/api/patrol/routes/${id}`);
  return data;
}

export async function updateRoute(
  id: number,
  patch: Partial<{ name: string; plan_date: string; note: string; status: string; codes: string[] }>,
): Promise<PatrolRoute> {
  const { data } = await apiClient.patch<PatrolRoute>(`/api/patrol/routes/${id}`, patch);
  return data;
}

export async function deleteRoute(id: number): Promise<void> {
  await apiClient.delete(`/api/patrol/routes/${id}`);
}

export async function fetchReport(id: number, withProse = false): Promise<PatrolReport> {
  const { data } = await apiClient.get<PatrolReport>(
    `/api/patrol/routes/${id}/report${withProse ? "?prose=true" : ""}`,
  );
  return data;
}

export async function assessRecord(recordId: number): Promise<{
  ok: boolean;
  assessment?: { condition?: string; summary?: string; _engine?: string };
  detail?: string;
}> {
  const { data } = await apiClient.post(`/api/patrol/records/${recordId}/assess`);
  return data;
}

export async function fetchPatrolStats(
  scope: RelicScope = "protected",
): Promise<PatrolStats> {
  const { data } = await apiClient.get<PatrolStats>(
    "/api/patrol/stats",
    { params: { scope } },
  );
  return data;
}

export function qrUrl(routeId: number): string {
  return `/api/patrol/routes/${routeId}/qr.png`;
}
