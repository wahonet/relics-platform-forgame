import { apiClient } from "./client";

export interface AdminTreeItem {
  adcode: number;
  name: string;
  level: string; // "country" | "province" | "city" | "district" | "street" | ...
  center?: [number, number];
  children_num?: number;
}

export interface BoundaryFileInfo {
  name: string;
  feature_count: number;
  size?: number;
  mtime?: number;
  missing?: boolean;
  error?: string;
}

export interface BoundaryDownloadResp {
  ok: boolean;
  files: { name: string; path: string; feature_count: number; source?: string }[];
  warnings: string[];
}

export type TownshipSource = "auto" | "osm" | "datav";

export async function fetchAdminTree(adcode: number) {
  const { data } = await apiClient.get<{ parent_adcode: number; items: AdminTreeItem[] }>(
    "/api/boundaries/admin-tree",
    { params: { adcode } },
  );
  return data;
}

export async function listBoundaries() {
  const { data } = await apiClient.get<{ dir: string; files: BoundaryFileInfo[] }>(
    "/api/boundaries/list",
  );
  return data;
}

export async function downloadBoundaries(payload: {
  city_adcode?: number | null;
  county_adcode?: number | null;
  include_county_outline?: boolean;
  include_city_counties?: boolean;
  include_townships?: boolean;
  township_source?: TownshipSource;
}) {
  const { data } = await apiClient.post<BoundaryDownloadResp>(
    "/api/boundaries/download",
    payload,
  );
  return data;
}

export async function clearBoundaries(targets: string[] = ["county", "townships"]) {
  const { data } = await apiClient.delete<{ removed: string[] }>(
    "/api/boundaries/clear",
    { params: { targets: targets.join(",") } },
  );
  return data;
}

/** 触发浏览器下载: 将指定 boundary 文件转换到目标 CRS 并下载。 */
export function exportBoundaryUrl(
  file: "county" | "townships" | "villages",
  crs: string,
  opts: { centralMeridian?: number; zoneWidth?: 3 | 6; zonePrefix?: boolean } = {},
): string {
  const params = new URLSearchParams({ file, crs });
  if (opts.centralMeridian !== undefined)
    params.set("central_meridian", String(opts.centralMeridian));
  if (opts.zoneWidth !== undefined) params.set("zone_width", String(opts.zoneWidth));
  if (opts.zonePrefix !== undefined)
    params.set("zone_prefix", opts.zonePrefix ? "true" : "false");
  return `/api/boundaries/export?${params.toString()}`;
}
