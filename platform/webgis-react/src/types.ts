/**
 * 共享数据类型 (前后端契约的 TS 表达).
 * 字段命名严格对齐 Python 端 data_loader.py 的输出。
 */

export interface RelicSummary {
  id?: number;
  archive_code: string;
  name: string;
  category_main?: string;
  category_sub?: string;
  era?: string;
  era_stats?: string;
  heritage_level?: string;
  survey_type?: string;
  township?: string;
  address?: string;
  area?: string;
  condition_level?: string;
  risk_score?: number;
  risk_factors?: string;
  ownership_type?: string;
  industry?: string;
  center_lat?: number;
  center_lng?: number;
  center_alt?: number;
  has_3d?: boolean;
  model_3d_path?: string;
  has_pdf?: boolean;
  pdf_path?: string;
  photo_count?: number;
  drawing_count?: number;
  intro?: string;
  [key: string]: unknown;
}

export interface BboxRelic {
  id?: number;
  code: string;
  name: string;
  lng: number;
  lat: number;
  category: string;
  rank: string;
  has_3d?: boolean;
  township?: string;
}

export interface Photo {
  photo_no?: string;
  description?: string;
  relative_path: string;
}

export interface Drawing {
  drawing_no?: string;
  drawing_name?: string;
  relative_path: string;
}

export interface BackendFilters {
  category?: string;
  rank?: string;
  township?: string;
  search_type?: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface WorklogItem {
  date: string;
  township?: string;
  villages?: string;
  participants?: string;
  review_count?: number;
  review_names?: string;
  new_count?: number;
  new_names?: string;
  has_pdf?: boolean;
  pdf_file?: string;
}

export interface SurveyRoutePoint {
  lng: number;
  lat: number;
  ts?: number;
  photo?: string;
  desc?: string;
}

export interface SurveyRoutes {
  [date: string]: SurveyRoutePoint[];
}

export type BaseLayerType =
  | "arcgis_sat"
  | "osm"
  | "gaode_anno"
  | "gaode_sat"
  | "gaode_vec"
  | "none";

export interface HomeView {
  lng: number;
  lat: number;
  h: number;
  city?: string;
  county?: string;
}
