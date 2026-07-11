/**
 * 共享数据类型 (前后端契约的 TS 表达).
 * 字段命名严格对齐 Python 端 data_serializers.py 的输出。
 */

/** protected=仅国/省/市/县级文保单位；all=再包含未定级不可移动文物。 */
export type RelicScope = "protected" | "all";

export interface RelicSummary {
  id?: number;
  archive_code: string;
  name: string;
  category_main?: string;
  category_sub?: string;
  era?: string;
  era_stats?: string;
  heritage_level?: string;
  county?: string;
  /** city = 市级基础层(简介/坐标/两线/照片/图纸), full = 嘉祥全量层(+档案+三维) */
  tier?: "city" | "full" | string;
  township?: string;
  village?: string;
  address?: string;
  area?: string;
  condition_level?: string;
  ownership_type?: string;
  center_lat?: number;
  center_lng?: number;
  center_alt?: number;
  has_3d?: boolean;
  model_3d_path?: string;
  has_archive_spu?: boolean;
  has_archive_fpu?: boolean;
  has_boundary?: boolean;
  photo_count?: number;
  drawing_count?: number;
  intro?: string;
  /** 附属文物(顿号分隔,如“重修桥记(碑刻)、石牌坊(建构筑物)”) */
  attachments?: string;
  last_patrol_at?: number | null;
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
  county?: string;
  township?: string;
  condition?: string;
  tier?: string;
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

/** /api/relics/{code}/archives 返回:普查档案 PDF 的 URL 列表 */
export interface RelicArchives {
  sanpu: string[];
  sipu: string[];
}

export interface BackendFilters {
  scope?: RelicScope;
  category?: string;
  rank?: string;
  county?: string;
  township?: string;
  tier?: string;
  condition?: string;
  /** era_stats 原始值集合(逗号分隔),"__empty__" 表示空值。 */
  era?: string;
  has_3d?: boolean;
  q?: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export type BaseLayerType =
  | "arcgis_sat"
  | "osm"
  | "offline_vector"
  | "gaode_anno"
  | "gaode_sat"
  | "gaode_vec"
  | "tianditu_img"
  | "tianditu_cia"
  | "tianditu_vec"
  | "tianditu_cva"
  | "none";

export interface HomeView {
  lng: number;
  lat: number;
  h: number;
  city?: string;
  county?: string;
}

// ── 巡查模块 ────────────────────────────────────────────────

export interface PatrolStop {
  code: string;
  name: string;
  lng: number;
  lat: number;
  county?: string;
  township?: string;
  condition?: string;
  rank?: string;
  checked?: boolean;
  verified?: boolean;
}

export interface PatrolRoute {
  id: number;
  token: string;
  name: string;
  plan_date: string;
  mode: string;
  data_scope?: RelicScope;
  status: string;
  note?: string;
  distance_m: number;
  duration_s: number;
  polyline: [number, number][];
  source?: string;
  stops: PatrolStop[];
  stop_count: number;
  checked_count: number;
  verified_count: number;
  mobile_url?: string;
  qr_url?: string;
  created_at?: number;
  /** 自定义出发点(可选)。 */
  start?: { lng: number; lat: number; name?: string } | null;
}

export interface PatrolDueItem {
  archive_code: string;
  name: string;
  county: string;
  condition: string;
  lng: number | null;
  lat: number | null;
  freq_days: number;
  last_patrol_at: number | null;
  due_in_days: number;
}

export interface PlanSuggestion {
  name: string;
  codes: string[];
  stops: PatrolStop[];
  distance_m: number;
  duration_s: number;
  polyline: [number, number][];
  source: string;
}

export interface PlanResponse {
  scope?: RelicScope;
  intent: Record<string, unknown>;
  explanation: string;
  routes: PlanSuggestion[];
  parser: string;
  /** 从「从XX出发」解析出的出发点(文物匹配或高德地理编码),可为 null。 */
  start?: { lng: number; lat: number; name: string } | null;
}

export interface PatrolRecord {
  id: number;
  route_id: number;
  relic_code: string;
  photo_path?: string;
  photo_lat?: number | null;
  photo_lng?: number | null;
  gps_source?: string;
  distance_m?: number | null;
  verified: boolean;
  ai_condition?: string;
  ai_summary?: string;
  note?: string;
  created_at: number;
}

export interface PatrolReportItem {
  code: string;
  name: string;
  lng: number;
  lat: number;
  county: string;
  township: string;
  address: string;
  condition: string;
  heritage_level: string;
  category: string;
  checked: boolean;
  verified: boolean;
  record_id: number | null;
  distance_m: number | null;
  photo: string;
  ai_condition: string;
  ai_summary: string;
  checked_at: number | null;
}

export interface PatrolReport {
  summary: {
    route_name: string;
    plan_date: string;
    stop_count: number;
    checked_count: number;
    verified_count: number;
    verify_rate: number;
    distance_km: number;
    condition_worse: string[];
  };
  items: PatrolReportItem[];
  /** LLM 生成的报告正文(prose=true 时返回;未配置 Key 时为模板文本)。 */
  prose?: string;
}

// ── 资源概览 ─────────────────────────────────────────────

export interface NameValue {
  name: string;
  value: number;
}

export interface DashboardStats {
  scope?: RelicScope;
  total: number;
  all_total?: number;
  protected_total?: number;
  ungraded_total?: number;
  designated_total: number;
  tier: { city: number; full: number };
  by_rank: NameValue[];
  by_county: NameValue[];
  by_category: NameValue[];
  by_condition: NameValue[];
  by_era: NameValue[];
  assets: {
    photos: number;
    drawings: number;
    models_3d: number;
    archive_spu: number;
    archive_fpu: number;
    boundaries: number;
  };
  /** 各字段完整度百分比: coords / intro / photo / boundary_of_designated / condition */
  completeness: Record<string, number>;
  quality_score: number;
}

export interface PatrolStats {
  route_total: number;
  route_done: number;
  record_total: number;
  record_this_month: number;
  verified_total: number;
  overdue_count: number;
  due_7days: number;
  month_days: number;
}
