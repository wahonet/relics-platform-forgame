import { apiClient } from "./client";
import type {
  BackendFilters,
  BboxRelic,
  Drawing,
  Photo,
  RelicSummary,
} from "../types";

interface BboxResp {
  data: BboxRelic[];
  total: number;
  truncated?: boolean;
}

export async function fetchRelicsList(): Promise<RelicSummary[]> {
  const { data } = await apiClient.get<RelicSummary[]>("/api/relics");
  return data;
}

export async function fetchStats() {
  const { data } = await apiClient.get("/api/stats");
  return data;
}

export interface BboxParams extends BackendFilters {
  min_lng: number;
  min_lat: number;
  max_lng: number;
  max_lat: number;
  limit?: number;
}

export async function fetchByBbox(params: BboxParams): Promise<BboxResp> {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== "") qs.set(k, String(v));
  });
  const { data } = await apiClient.get<BboxResp>(`/api/relics/by-bbox?${qs}`);
  return data;
}

export async function fetchRelicDetail(code: string): Promise<RelicSummary> {
  const { data } = await apiClient.get<RelicSummary>(
    `/api/relics/${encodeURIComponent(code)}`,
  );
  return data;
}

export async function fetchPhotos(code: string): Promise<Photo[]> {
  const { data } = await apiClient.get<Photo[]>(
    `/api/relics/${encodeURIComponent(code)}/photos`,
  );
  return data;
}

export async function fetchDrawings(code: string): Promise<Drawing[]> {
  const { data } = await apiClient.get<Drawing[]>(
    `/api/relics/${encodeURIComponent(code)}/drawings`,
  );
  return data;
}

export async function fetchPolygon(code: string): Promise<unknown> {
  const { data } = await apiClient.get(
    `/api/relics/${encodeURIComponent(code)}/polygon`,
  );
  return data;
}

export async function searchFulltext(q: string, limit = 30): Promise<BboxResp> {
  const { data } = await apiClient.get<BboxResp>(
    `/api/relics/search?q=${encodeURIComponent(q)}&limit=${limit}`,
  );
  return data;
}
