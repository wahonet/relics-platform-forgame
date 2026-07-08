import { apiClient } from "./client";

/** 对比图斑(SHP 导入)相关 API。 */

export interface ParcelLayerMeta {
  id: string;
  name: string;
  feature_count: number;
  /** [minLng, minLat, maxLng, maxLat] WGS84 */
  bbox: [number, number, number, number];
  source_crs: string;
  created_at: number;
}

export interface ParcelConflict {
  feature_index: number;
  parcel_name: string;
  relic_code: string;
  relic_name: string;
  /** body=本体面 protection=保护范围 control=建控地带 point=本体点位 */
  kind: "body" | "protection" | "control" | "point";
  overlap_m2: number;
  center: [number, number];
}

export interface ParcelAnalysis {
  layer_id: string;
  layer_name: string;
  analyzed_at: number;
  checked_features: number;
  relic_polygons: number;
  conflicts: ParcelConflict[];
  truncated: boolean;
  summary: {
    body: number;
    protection: number;
    control: number;
    point: number;
    total: number;
    features_hit: number;
    relics_hit: number;
  };
}

export interface ImportResult {
  layers: ParcelLayerMeta[];
  warnings: string[];
}

export interface ParcelFeature {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: { type: "Polygon" | "MultiPolygon"; coordinates: unknown };
}

export interface ParcelFeatureCollection {
  type: "FeatureCollection";
  features: ParcelFeature[];
}

export async function importParcels(files: File[]): Promise<ImportResult> {
  const fd = new FormData();
  files.forEach((f) => fd.append("files", f, f.name));
  const { data } = await apiClient.post<ImportResult>("/api/parcels/import", fd, {
    // SHP 可能较大,放宽超时
    timeout: 120000,
  });
  return data;
}

export async function listParcelLayers(): Promise<ParcelLayerMeta[]> {
  const { data } = await apiClient.get<{ layers: ParcelLayerMeta[] }>("/api/parcels/layers");
  return data.layers || [];
}

export async function fetchParcelGeojson(layerId: string): Promise<ParcelFeatureCollection> {
  const { data } = await apiClient.get<ParcelFeatureCollection>(
    `/api/parcels/layers/${layerId}/geojson`,
  );
  return data;
}

export async function analyzeParcelLayer(layerId: string): Promise<ParcelAnalysis> {
  const { data } = await apiClient.post<ParcelAnalysis>(
    `/api/parcels/layers/${layerId}/analyze`,
    undefined,
    { timeout: 120000 },
  );
  return data;
}

export async function fetchParcelAnalysis(layerId: string): Promise<ParcelAnalysis | null> {
  try {
    const { data } = await apiClient.get<ParcelAnalysis>(`/api/parcels/layers/${layerId}/analysis`);
    return data;
  } catch {
    return null;
  }
}

export async function deleteParcelLayer(layerId: string): Promise<void> {
  await apiClient.delete(`/api/parcels/layers/${layerId}`);
}
