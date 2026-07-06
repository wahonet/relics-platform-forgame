import { apiClient } from "./client";

export interface PipelineArtifact {
  label: string;
  path: string;
  kind: string;
  exists: boolean;
  count: number;
}

export interface PipelineStep {
  id: string;
  name: string;
  script: string;
  optional: boolean;
  missing_features: string[];
  inputs: PipelineArtifact[];
  outputs: PipelineArtifact[];
  missing_inputs: PipelineArtifact[];
  missing_outputs: PipelineArtifact[];
}

export interface PipelineManifestStep {
  id: string;
  name: string;
  status: string;
  duration_sec?: number;
  error?: string | null;
}

export interface PipelineStatus {
  features: Record<string, boolean>;
  steps: PipelineStep[];
  last_manifest: {
    status: string;
    generated_at: string;
    steps: PipelineManifestStep[];
  } | null;
}

export interface AdminTask {
  status: "idle" | "running" | "done" | "error" | "stopped";
  id?: number;
  label?: string;
  started?: number;
  finished?: number | null;
  returncode?: number | null;
  /** 本次运行启动时快照的模型与渠道(运行中换模型不影响本次)。 */
  model?: string;
  base_url?: string;
  log?: string[];
  /** 完整日志落盘路径(data/output/logs/admin_tasks/)。 */
  log_file?: string;
}

export interface ApiKeyEntry {
  configured: boolean;
  masked: string;
}

export interface ApiConfigStatus {
  siliconflow: ApiKeyEntry & {
    base_url: string;
    default_model: string;
    /** step00 档案提取并发数(1-8)。 */
    extract_concurrency?: number;
  };
  amap: ApiKeyEntry;
  cesium_ion: ApiKeyEntry;
  tianditu?: ApiKeyEntry;
  config_path: string;
  runtime: { ai_ready: boolean; amap_ready: boolean };
}

export async function fetchPipelineStatus(): Promise<PipelineStatus> {
  const { data } = await apiClient.get<PipelineStatus>("/api/admin/pipeline");
  return data;
}

export async function runPipeline(opts: { only?: string; demo?: boolean }) {
  const { data } = await apiClient.post("/api/admin/pipeline/run", opts);
  return data as { id: number; label: string; status: string };
}

export async function fetchTask(): Promise<AdminTask> {
  const { data } = await apiClient.get<AdminTask>("/api/admin/pipeline/task");
  return data;
}

export async function fetchApiConfig(): Promise<ApiConfigStatus> {
  const { data } = await apiClient.get<ApiConfigStatus>("/api/admin/config");
  return data;
}

export interface AiModelsResp {
  models: { id: string; name: string }[];
  current: string;
  source: "api" | "config";
  error?: string;
}

/** 从 SiliconFlow 拉取账号可用的对话模型列表(失败时回退 config 内置列表)。 */
export async function fetchAiModels(): Promise<AiModelsResp> {
  const { data } = await apiClient.get<AiModelsResp>("/api/admin/models");
  return data;
}

/** 档案提取总体进度(跨运行累计,按文件系统实况统计)。 */
export interface ExtractProgress {
  total: number;
  done: number;
  failed: number;
  remaining: number;
  stopping: boolean;
  /** 当前配置的并发数(=停止时最多还需完成的在途请求条数)。 */
  concurrency: number;
}

export async function fetchExtractProgress(): Promise<ExtractProgress> {
  const { data } = await apiClient.get<ExtractProgress>("/api/admin/pipeline/extract-progress");
  return data;
}

export async function stopPipeline() {
  const { data } = await apiClient.post("/api/admin/pipeline/stop");
  return data as { stopping: boolean; inflight_max: number };
}

/** 清除全部已生成数据。confirm 必须为「清除全部数据」。 */
export async function clearAllData(confirm: string, includeInput: boolean) {
  const { data } = await apiClient.post("/api/admin/data/clear", {
    confirm,
    include_input: includeInput,
  });
  return data as {
    ok: boolean;
    removed: string[];
    failed: { label: string; path: string; error: string }[];
    message: string;
  };
}

export async function saveApiConfig(body: {
  siliconflow_key?: string;
  siliconflow_base_url?: string;
  amap_web_key?: string;
  cesium_ion_token?: string;
  tianditu_key?: string;
  default_model?: string;
  extract_concurrency?: number;
}) {
  const { data } = await apiClient.put("/api/admin/config", body);
  return data as {
    ok: boolean;
    changed: boolean;
    message: string;
    runtime?: { ai_ready: boolean; amap_ready: boolean };
  };
}
