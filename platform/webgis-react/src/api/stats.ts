import { apiClient } from "./client";
import type { DashboardStats, RelicArchives } from "../types";

export async function fetchDashboardStats(): Promise<DashboardStats> {
  const { data } = await apiClient.get<DashboardStats>("/api/stats/dashboard");
  return data;
}

export async function fetchRelicArchives(code: string): Promise<RelicArchives> {
  const { data } = await apiClient.get<RelicArchives>(
    `/api/relics/${encodeURIComponent(code)}/archives`,
  );
  return data;
}
