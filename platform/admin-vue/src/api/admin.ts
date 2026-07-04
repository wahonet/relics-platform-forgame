import { del, get, post, put } from './http';

// ── 类型 ────────────────────────────────────────────────

export type TaskStatus = 'starting' | 'running' | 'done' | 'error';

export interface PipelineStep {
  id: string;
  name: string;
  icon: string;
  desc: string;
  flow: string;
  input: { total: number; label: string };
  output: { total: number; label: string; extra?: Record<string, number> };
  pending: number;
  progress: number;
  runnable: boolean;
  optional?: boolean;
  last_run?: { status: TaskStatus; started: string; finished?: string } | null;
  artifact_mtime?: string | null;
}

export interface TaskSummary {
  task_id: string;
  script: string;
  status: TaskStatus;
  started: string;
  finished?: string;
  returncode?: number | null;
  last_log?: string;
}

export interface TaskDetail {
  status: TaskStatus;
  script: string;
  started: string;
  finished?: string;
  returncode?: number | null;
  log: string[];
  single_file?: string;
}

export interface PipelineResp {
  steps: PipelineStep[];
  tasks: Record<string, Omit<TaskSummary, 'task_id' | 'last_log'>>;
}

export interface StepItem {
  id: string;
  name: string;
  status: 'done' | 'pending' | 'error';
  input_size_kb?: number;
  output_size_kb?: number;
  output?: string | null;
  output_mtime?: string | null;
  feature_count?: number;
  // step02 扩展
  category?: string;
  era_stats?: string;
  condition?: string;
  risk_score?: string;
  has_boundary?: boolean;
  source_file?: string;
}

export interface StepGroup {
  name: string;
  total: number;
  done: number;
  pending: number;
  items: StepItem[];
}

export interface StepItemsResp {
  step: string;
  groups: StepGroup[];
  index_covered?: number;
}

export interface AuditRow {
  id: number;
  actor: string;
  action: string;
  relic_code: string;
  before_json: string | null;
  after_json: string | null;
  ts: number;
}

export interface TownshipInfo {
  name: string;
  docx_count: number;
  md_count: number;
}

export interface CodesResp {
  categories: Array<{ code: string; label: string }>;
  ranks: Array<{ code: string; label: string }>;
  search_types: Array<{ code: string; label: string }>;
}

export interface RelicRow {
  id: number | string;
  code: string;
  name: string;
  category: string;
  rank: string;
  search_type: string;
  lng: number | null;
  lat: number | null;
  township: string;
  village: string;
  era: string;
  era_stats: string;
  has_3d: boolean;
  has_pdf: boolean;
  has_photo: boolean;
  has_boundary: boolean;
  photo_count: number;
  drawing_count: number;
  status: number;
  version: number;
  updated_at: string | null;
}

export interface RelicsListResp {
  data: RelicRow[];
  total: number;
  page: number;
  size: number;
}

export interface RelicsListQuery {
  page?: number;
  size?: number;
  search?: string;
  category?: string;  // 逗号分隔多选
  rank?: string;
  township?: string;
  search_type?: string;
  status?: number;
  bbox?: string;      // 'minLng,minLat,maxLng,maxLat'
  order_by?: 'updated_at_desc' | 'updated_at_asc' | 'code_asc' | 'code_desc' | 'name_asc';
}

export interface NeighborItem {
  code: string;
  name: string;
  category: string;
  rank: string;
  lng: number;
  lat: number;
  township: string;
  village: string;
  era_stats: string;
  distance_m: number;
}

export interface AuditQuery {
  code?: string;
  action?: string;   // 多值逗号分隔
  actor?: string;
  field?: string;
  start_ts?: number;
  end_ts?: number;
  limit?: number;
}

export interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: Array<{ line: number; code: string; error: string }>;
}

// 批量操作：updated/deleted 其一有值
export interface BulkResult {
  updated?: number;
  deleted?: number;
  not_found: string[];
  failed: Array<{ code: string; error: string }>;
}

export interface StatsOverview {
  totals: {
    total: number;
    drafts: number;
    deleted: number;
    has_3d: number;
    has_pdf: number;
    has_photo: number;
    has_boundary: number;
  };
  by_category: Array<{ code: string; label: string; count: number }>;
  by_rank: Array<{ code: string; label: string; count: number }>;
  by_search_type: Array<{ code: string; label: string; count: number }>;
  by_township_top: Array<{ name: string; count: number }>;
  by_era_stats_top: Array<{ name: string; count: number }>;
  audit_14days: {
    days: string[];
    create: number[];
    update: number[];
    delete: number[];
  };
  audit_recent: Array<{
    id: number;
    ts: number;
    actor: string;
    action: string;
    relic_code: string;
    relic_name: string;
  }>;
  last_updated: number;
}

// ── 瓦片缓存 / 下载历史 ────────────────────────────────
export interface TileDownloadEntry {
  id: string;
  status: 'done' | 'error' | 'running';
  label?: string | null;
  providers: string[];
  zooms: number[];
  bbox?: [number, number, number, number] | null;
  total: number;
  skipped: number;
  need: number;
  downloaded: number;
  failed: number;
  bytes: number;
  started_at: number;
  finished_at: number | null;
  error?: string | null;
}

export interface TilesSummary {
  cache_dir: string;
  providers: Record<string, { count: number; bytes: number }>;
  totals: { count: number; bytes: number };
  last_finished_at: number | null;
  recent: TileDownloadEntry[];
}

// ── API 封装 ────────────────────────────────────────────
// FastAPI 的 admin.router 注册前缀为 /api + /admin,真实路径为 /api/admin/*。
// 本文件统一用 /api/admin 前缀,避免与前端 /admin-ui 路由混淆。
const P = '/api/admin';

export const adminApi = {
  // 管线
  pipeline: () => get<PipelineResp>(`${P}/pipeline`),
  stepItems: (stepId: string) => get<StepItemsResp>(`${P}/step/${stepId}/items`),

  // 任务
  runScript: (scriptName: string) =>
    post<{ task_id: string; script: string }>(`${P}/run/${scriptName}`),
  getTask: (taskId: string) => get<TaskDetail>(`${P}/task/${taskId}`),
  listTasks: (limit = 30) => get<TaskSummary[]>(`${P}/tasks?limit=${limit}`),

  // 上传 DOCX
  uploadSingle: (formData: FormData) =>
    post<{ message: string; township: string; filename: string; size_kb: number }>(
      `${P}/upload-single`,
      formData,
      { headers: { 'Content-Type': 'multipart/form-data' } },
    ),
  processSingle: (formData: FormData) =>
    post<{ task_id: string; message: string; township: string }>(
      `${P}/process-single`,
      formData,
      { headers: { 'Content-Type': 'multipart/form-data' } },
    ),

  // Dashboard
  statsOverview: () => get<StatsOverview>(`${P}/stats-overview`),
  tilesSummary: (limit = 10) =>
    get<TilesSummary>(`${P}/tiles/summary?limit=${limit}`),

  // 字典
  codes: () => get<CodesResp>(`${P}/codes`),
  relicsTownships: () => get<{ townships: string[] }>(`${P}/relics-townships`),

  // 文物列表 / 详情
  listRelics: (params: RelicsListQuery = {}) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
    });
    return get<RelicsListResp>(`${P}/relics?${q.toString()}`);
  },
  getRelic: (code: string) =>
    get<Record<string, unknown>>(`${P}/relics/${encodeURIComponent(code)}`),

  // 文物 CRUD (DB 模式下可用)
  createRelic: (payload: Record<string, unknown>, actor?: string) =>
    post<{ ok: true; relic: Record<string, unknown> }>(
      `${P}/relics`,
      payload,
      actor ? { headers: { 'X-Actor': actor } } : undefined,
    ),
  updateRelic: (code: string, payload: Record<string, unknown>, actor?: string) =>
    put<{ ok: true; relic: Record<string, unknown> }>(
      `${P}/relics/${code}`,
      payload,
      actor ? { headers: { 'X-Actor': actor } } : undefined,
    ),
  deleteRelic: (code: string, actor?: string) =>
    del<{ ok: true }>(
      `${P}/relics/${code}`,
      actor ? { headers: { 'X-Actor': actor } } : undefined,
    ),

  // 批量操作
  bulkUpdateRelics: (codes: string[], fields: Record<string, unknown>, actor?: string) =>
    post<BulkResult>(
      `${P}/relics/bulk-update`,
      { codes, fields },
      actor ? { headers: { 'X-Actor': actor } } : undefined,
    ),
  bulkSetStatus: (codes: string[], status: -1 | 0 | 1, actor?: string) =>
    post<BulkResult>(
      `${P}/relics/bulk-status`,
      { codes, status },
      actor ? { headers: { 'X-Actor': actor } } : undefined,
    ),
  // 邻近文物,radius 单位为米,默认 2 km。
  neighbors: (code: string, radius = 2000, limit = 20) =>
    get<{ code: string; radius: number; items: NeighborItem[] }>(
      `${P}/relics/${encodeURIComponent(code)}/neighbors?radius=${radius}&limit=${limit}`,
    ),

  // 导出 CSV:返回 URL 供 <a> 直接下载,避开 axios 拦截器并保留文件名。
  exportRelicsUrl(params: {
    search?: string; category?: string; rank?: string;
    township?: string; search_type?: string; status?: number;
    codes?: string; bbox?: string; order_by?: string;
  } = {}): string {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
    });
    return `${P}/relics-export?${q.toString()}`;
  },

  // 批量导入
  importRelics: (file: File, mode: 'upsert' | 'create_only' = 'upsert', actor?: string) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('mode', mode);
    return post<{
      created: number;
      updated: number;
      skipped: number;
      failed: number;
      errors: Array<{ line: number; code: string; error: string }>;
    }>(`${P}/relics/import`, fd, {
      headers: {
        'Content-Type': 'multipart/form-data',
        ...(actor ? { 'X-Actor': actor } : {}),
      },
    });
  },

  // 审计
  listAudit: (q: AuditQuery = {}) => {
    const sp = new URLSearchParams();
    Object.entries(q).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
    });
    return get<{ rows: AuditRow[] }>(`${P}/audit?${sp.toString()}`);
  },
  rollbackAudit: (id: number, actor?: string) =>
    post<{ ok: true; action_taken: 'update' | 'delete'; code: string }>(
      `${P}/audit/${id}/rollback`,
      {},
      actor ? { headers: { 'X-Actor': actor } } : undefined,
    ),

  // 概要 / 乡镇列表
  status: () => get<Record<string, unknown>>(`${P}/status`),
  townships: () => get<TownshipInfo[]>(`${P}/townships`),
};
