import { apiClient } from "./client";

export interface TileDownloadJob {
  job_id: string;
  providers: string[];
  zooms: number[];
  total: number;
  skipped: number;
  need: number;
}

export interface TileDownloadProgress {
  id: string;
  status: "running" | "done" | "error";
  total: number;
  skipped: number;
  need: number;
  downloaded: number;
  failed: number;
  bytes: number;
  bbox?: number[];
  label?: string;
  started_at?: number;
  finished_at?: number;
  error?: string | null;
}

export interface TileCacheInfo {
  cache_dir: string;
  providers: Record<string, { count: number; bytes: number }>;
}

export interface TileHistoryItem {
  id: string;
  status: string;
  label?: string | null;
  providers: string[];
  zooms: number[];
  bbox?: number[];
  total: number;
  downloaded: number;
  failed: number;
  bytes: number;
  started_at?: number;
  finished_at?: number;
}

export interface TileEstimate {
  bbox?: { west: number; south: number; east: number; north: number };
  providers?: string[];
  zooms?: number[];
  total: number;
  cached: number;
  need: number;
  error?: string;
}

export async function estimateArea(
  west: number, south: number, east: number, north: number,
  providers: string, zooms: string,
) {
  const { data } = await apiClient.get<TileEstimate>("/api/tiles/area-estimate", {
    params: { west, south, east, north, providers, zooms },
  });
  return data;
}

export async function startDownload(
  west: number, south: number, east: number, north: number,
  providers: string, zooms: string, label?: string,
) {
  const { data } = await apiClient.post<TileDownloadJob>(
    "/api/tiles/download-area",
    null,
    { params: { west, south, east, north, providers, zooms, label: label || "" } },
  );
  return data;
}

export async function fetchProgress(jobId: string) {
  const { data } = await apiClient.get<TileDownloadProgress>(
    `/api/tiles/download-progress/${jobId}`,
  );
  return data;
}

export async function fetchHistory(limit = 30) {
  const { data } = await apiClient.get<{ items: TileHistoryItem[] }>(
    "/api/tiles/history",
    { params: { limit } },
  );
  return data;
}

export async function openCacheFolder() {
  const { data } = await apiClient.post("/api/tiles/open-cache-folder");
  return data;
}

export async function clearCache(providers: string[] = []) {
  const { data } = await apiClient.post("/api/tiles/clear-cache", null, {
    params: { providers: providers.join(",") },
  });
  return data;
}

export async function fetchCacheInfo() {
  const { data } = await apiClient.get<TileCacheInfo>("/api/tiles/cache-info");
  return data;
}
