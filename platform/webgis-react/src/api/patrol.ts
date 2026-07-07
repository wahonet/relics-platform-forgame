import { apiClient } from "./client";
import type {
  PatrolDueItem,
  PatrolRoute,
  PatrolReport,
  PlanResponse,
  PatrolStats,
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
}): Promise<{ data: PatrolDueItem[]; total: number }> {
  const qs = new URLSearchParams();
  if (params?.county) qs.set("county", params.county);
  if (params?.only_overdue) qs.set("only_overdue", "true");
  if (params?.limit) qs.set("limit", String(params.limit));
  const { data } = await apiClient.get(`/api/patrol/due?${qs}`);
  return data;
}

// 单日巡查上限 30 处:用户要求更多时按 30 截断
export async function planPatrol(text: string, maxStops = 30): Promise<PlanResponse> {
  const { data } = await apiClient.post<PlanResponse>("/api/patrol/plan", {
    text,
    max_stops: maxStops,
  });
  return data;
}

export async function createRoute(body: {
  name: string;
  codes: string[];
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

export async function listRoutes(): Promise<PatrolRoute[]> {
  const { data } = await apiClient.get<{ data: PatrolRoute[] }>("/api/patrol/routes");
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

export async function fetchPatrolStats(): Promise<PatrolStats> {
  const { data } = await apiClient.get<PatrolStats>("/api/patrol/stats");
  return data;
}

export function qrUrl(routeId: number): string {
  return `/api/patrol/routes/${routeId}/qr.png`;
}
